#!/usr/bin/env tsx
/**
 * W7 D2 Phase 3 — apply post-launch pricing across the 3 channels.
 *
 * Two distinct write paths (do NOT confuse them — gotcha #18 was
 * triggered by collapsing them into one PUT):
 *
 *   1. `writeChannelModels(id, models[])` — PUT /api/channel/<id> with
 *      ONLY the `models` field changed (cold-SKU delete). Channel
 *      record never carries per-model ratios.
 *
 *   2. `writeOptionRatios({ ModelRatio, CompletionRatio })` — GET +
 *      merge + PUT /api/option/. Per-model ratios live HERE, in
 *      global JSON-encoded options entries. Channel-level PUT silently
 *      drops `model_ratio` / `completion_ratio` fields (no such columns
 *      on channels table).
 *
 * After every --apply the script ALWAYS re-fetches /api/pricing and
 * verifies all 36 SKUs match expected mr / cr (`findPricingMismatches`).
 * Exits non-zero on any mismatch — never trusts the PUT envelope's
 * `success: true`. (Adding this check is what closed the W7 D2 wound.)
 *
 * Conventions
 * -----------
 * After Phase 2 (QuotaPerUnit 500K → 1M, fixed FX ¥7/USD):
 *   USD/1M_input   = model_ratio
 *   USD/1M_output  = model_ratio × completion_ratio
 *
 * Promo (overseas only): mr = retail × 0.5. SF: mr = wholesale_¥/5.83.
 *
 * Usage
 * -----
 *   tsx _bootstrap/apply-w7-pricing.ts             # dry-run (default)
 *   tsx _bootstrap/apply-w7-pricing.ts --apply     # PUT to admin API
 *
 * Pre-reqs: SSH tunnel + env (NEWAPI_BASE_URL + ADMIN_TOKEN + ADMIN_USER_ID).
 * Phase 2 (db QPU + balance migration) must already be applied — these
 * ratios are written under post-Phase-2 unit conventions.
 */
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();
import {
    mergeRatioMap,
    findPricingMismatches,
    type RatioMap,
} from './lib/option-ratio-merge';

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';
const NEWAPI_ADMIN_TOKEN = process.env.NEWAPI_ADMIN_TOKEN;
const NEWAPI_ADMIN_USER_ID = process.env.NEWAPI_ADMIN_USER_ID;

if (!NEWAPI_ADMIN_TOKEN || !NEWAPI_ADMIN_USER_ID) {
    console.error('Missing NEWAPI_ADMIN_TOKEN or NEWAPI_ADMIN_USER_ID. Aborting.');
    process.exit(1);
}

// =============================================================================
// OPERATOR INPUT — REVIEW THESE CAREFULLY BEFORE --apply
// =============================================================================

/**
 * Channel IDs as they exist on prod today (verified 2026-05-06):
 *   1 = siliconflow (type=1 OpenAI-compat, 190 models)
 *   2 = sub2api (type=14 Anthropic Claude, 32 models)
 *   3 = sub2api-openai (type=1 OpenAI, 157 models)
 */
const CHANNEL_IDS = {
    siliconflow: 1,
    sub2apiClaude: 2,
    sub2apiOpenAI: 3,
} as const;

/**
 * Promo discount applied to overseas (sub2api) channels' retail ratios.
 * 0.5 = "promo price = half of retail". Phase 7 exit script multiplies
 * back by 2 to restore retail.
 */
const PROMO_DISCOUNT = 0.5;

/**
 * sub2api Anthropic Claude — keep these 6, delete all other claude-*.
 *
 * Retail prices from anthropic.com/api/pricing (assumed stable for the
 * 4.x family — claude-opus uses the Opus tier price, etc.). cr is
 * output/input retail ratio (Anthropic's family-wide convention is 5x).
 */
const SUB2API_CLAUDE_WHITELIST: Record<string, { retailIn: number; retailOut: number; note?: string }> = {
    // Opus tier — Path A alignment with project_silkroadai_pricing_strategy.md:
    // Opus retail in this strategy = $5/$25 (not the public Anthropic
    // page's $15/$75; this is the strategy-level "reference price" used
    // for promo derivation). Promo mr=2.5, cr=5 (cr stable: 25/5 = 5).
    // Phase 7 exit (mr × 2) lands at retail mr=5.0, cr=5.
    'claude-opus-4-7':    { retailIn: 5,  retailOut: 25, note: 'Opus tier — strategy retail $5/$25' },
    'claude-opus-4-6':    { retailIn: 5,  retailOut: 25, note: 'Opus tier — strategy retail $5/$25' },
    'claude-opus-4-5':    { retailIn: 5,  retailOut: 25, note: 'Opus tier — strategy retail $5/$25' },
    'claude-sonnet-4-6':  { retailIn: 3,  retailOut: 15, note: 'Sonnet 4.x tier' },
    'claude-sonnet-4-5':  { retailIn: 3,  retailOut: 15, note: 'Sonnet 4.x tier' },
    'claude-haiku-4-5':   { retailIn: 1,  retailOut: 5,  note: 'Haiku 4.x tier' },
};

/**
 * sub2api-openai — keep these 8, delete all other gpt-* / gpt-image-*.
 *
 * Operator-confirmed via project_silkroadai_pricing_strategy.md.
 * Two pricing modes coexist:
 *
 *   - `text` SKUs: priced from retail USD/1M tokens. Promo path is
 *     `mr = retailIn × 0.5`, `cr = retailOut / retailIn`. Phase 7
 *     exit multiplies mr by 2 → restores retail.
 *
 *   - `multimodal` SKUs (audio / realtime / image): priced as
 *     engineering values (`promoMr` / `promoCr` direct), not derived
 *     from per-token retail. Phase 7 exit multiplies mr by 2 → matches
 *     `retailMr`. cr stays unchanged across promo / retail.
 *     Strategy doc §multimodal accepts the "1× text token = 4× pricing
 *     if customer chats with image-1.5" trade-off; we keep gpt-image-1.5
 *     on the per-token ratio path (no `skipPerTokenRatio`) to avoid
 *     introducing a `model_price` schema branch in this maintenance
 *     window.
 */
type SubApiOpenAIEntry =
    | { kind: 'text'; retailIn: number; retailOut: number; note?: string }
    | { kind: 'multimodal'; promoMr: number; promoCr: number; retailMr: number; retailCr: number; note?: string };

const SUB2API_OPENAI_WHITELIST: Record<string, SubApiOpenAIEntry> = {
    // Text SKUs — retail-derived
    'gpt-5.2':       { kind: 'text', retailIn: 1.75, retailOut: 14.00 },  // promo mr=0.875, cr=8
    'gpt-5.3-codex': { kind: 'text', retailIn: 1.75, retailOut: 14.00 },  // promo mr=0.875, cr=8
    'gpt-5.4':       { kind: 'text', retailIn: 2.50, retailOut: 15.00 },  // promo mr=1.25,  cr=6
    'gpt-5.4-mini':  { kind: 'text', retailIn: 0.75, retailOut:  4.50 },  // promo mr=0.375, cr=6
    'gpt-5.5':       { kind: 'text', retailIn: 5.00, retailOut: 30.00 },  // promo mr=2.5,   cr=6  (NOTE: $30 output, not $25)

    // Multimodal SKUs — engineering values, not retail-derived
    'gpt-4o-audio-preview':    { kind: 'multimodal', promoMr: 20, promoCr: 2, retailMr: 40,  retailCr: 2 },
    'gpt-4o-realtime-preview': { kind: 'multimodal', promoMr: 50, promoCr: 2, retailMr: 100, retailCr: 2 },
    'gpt-image-1.5':           { kind: 'multimodal', promoMr:  4, promoCr: 4, retailMr:  8,  retailCr: 4 },
};

/**
 * SiliconFlow wholesale — used to derive mr = wholesale_¥/5.83.
 * Mirror of _bootstrap/build-pricing-audit.py SF_WHOLESALE table.
 * Models NOT in this table are subject to the "delete-or-followup"
 * decision based on whether they had any traffic in the last 30 days.
 */
const SF_WHOLESALE_CNY: Record<string, { in_cny_per_1m: number; out_cny_per_1m: number; note?: string }> = {
    'deepseek-ai/DeepSeek-V4-Flash':           { in_cny_per_1m: 0.14, out_cny_per_1m: 0.28 },
    'Pro/deepseek-ai/DeepSeek-V3.2':           { in_cny_per_1m: 0.27, out_cny_per_1m: 0.42 },
    'deepseek-ai/DeepSeek-V3.2':               { in_cny_per_1m: 0.27, out_cny_per_1m: 0.42 },
    'Pro/deepseek-ai/DeepSeek-V3.1-Terminus':  { in_cny_per_1m: 0.27, out_cny_per_1m: 1.0 },
    'deepseek-ai/DeepSeek-V3.1-Terminus':      { in_cny_per_1m: 0.27, out_cny_per_1m: 1.0 },
    'Pro/deepseek-ai/DeepSeek-V3':             { in_cny_per_1m: 2.0,  out_cny_per_1m: 8.0,  note: 'web-search early-2025 SF Pro' },
    'deepseek-ai/DeepSeek-V3':                 { in_cny_per_1m: 1.0,  out_cny_per_1m: 2.0,  note: 'web-search early-2025 SF standard' },
    'Pro/deepseek-ai/DeepSeek-R1':             { in_cny_per_1m: 4.0,  out_cny_per_1m: 16.0, note: 'web-search early-2025 SF Pro' },
    'deepseek-ai/DeepSeek-R1':                 { in_cny_per_1m: 4.0,  out_cny_per_1m: 16.0 },
    'Pro/zai-org/GLM-4.7':                     { in_cny_per_1m: 0.42, out_cny_per_1m: 2.2 },
    'zai-org/GLM-4.6':                         { in_cny_per_1m: 0.39, out_cny_per_1m: 1.9 },
    'Pro/moonshotai/Kimi-K2-Instruct-0905':    { in_cny_per_1m: 0.4,  out_cny_per_1m: 2.0 },
    'moonshotai/Kimi-K2-Instruct-0905':        { in_cny_per_1m: 0.4,  out_cny_per_1m: 2.0 },
    'Pro/moonshotai/Kimi-K2-Thinking':         { in_cny_per_1m: 4.0,  out_cny_per_1m: 16.0, note: '2026 estimate' },
    'moonshotai/Kimi-K2-Thinking':             { in_cny_per_1m: 4.0,  out_cny_per_1m: 16.0, note: '2026 estimate' },
    'tencent/Hunyuan-A13B-Instruct':           { in_cny_per_1m: 0.14, out_cny_per_1m: 0.57 },
    'MiniMaxAI/MiniMax-M2.5':                  { in_cny_per_1m: 0.3,  out_cny_per_1m: 1.2 },
    'Pro/MiniMaxAI/MiniMax-M2.5':              { in_cny_per_1m: 0.3,  out_cny_per_1m: 1.2 },
    'Qwen/Qwen3-VL-32B-Instruct':              { in_cny_per_1m: 0.2,  out_cny_per_1m: 0.6 },
    'Qwen/Qwen3-VL-8B-Instruct':               { in_cny_per_1m: 0.18, out_cny_per_1m: 0.68 },
    'BAAI/bge-m3':                             { in_cny_per_1m: 0,    out_cny_per_1m: 0,    note: 'SF promo: free' },
    'Pro/BAAI/bge-m3':                         { in_cny_per_1m: 0,    out_cny_per_1m: 0,    note: 'SF promo: free' },
};

/** mr = wholesale_¥_in / SF_DIVISOR. Gives ~20% markup at ¥7/USD. */
const SF_DIVISOR = 5.83;

/** SF fallback for models lacking wholesale data but having recent calls. */
const SF_FALLBACK_MR = 1.5;
const SF_FALLBACK_CR = 1;

/** Dry-run by default — only writes when --apply is passed. */
const APPLY = process.argv.includes('--apply');

// =============================================================================
// UTILITIES
// =============================================================================

interface Channel {
    id: number;
    name: string;
    type: number;
    models: string;
    model_ratio: string | null;
    completion_ratio: string | null;
    model_mapping?: string | null;
    [k: string]: unknown;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(NEWAPI_BASE_URL + path, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': NEWAPI_ADMIN_TOKEN!,
            'New-Api-User': NEWAPI_ADMIN_USER_ID!,
            ...(init.headers || {}),
        },
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} ${r.status}: ${txt.slice(0, 200)}`);
    const env = txt ? JSON.parse(txt) : {};
    if (env.success === false) throw new Error(`${init.method || 'GET'} ${path} envelope failure: ${env.message}`);
    return (env.data ?? env) as T;
}

async function fetchChannel(id: number): Promise<Channel> {
    return api<Channel>(`/api/channel/${id}`);
}

function parseModels(csv: string | null): string[] {
    if (!csv) return [];
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Round to 4 decimals — kills IEEE 754 representation drift so the
 *  global ratio JSON is byte-stable across script runs (lets the
 *  post-write verify + future dry-runs compare cleanly without
 *  spurious "overwrite" entries). */
function roundTo4(n: number): number {
    return Math.round(n * 10000) / 10000;
}

function parseJsonOrEmpty(s: string | null | undefined): Record<string, number> {
    if (!s) return {};
    try {
        const v = JSON.parse(s);
        return typeof v === 'object' && v !== null ? (v as Record<string, number>) : {};
    } catch {
        return {};
    }
}

/** Models with at least 1 type=2 (consume) log row in the last 30 days,
 *  by `model_name`. We use this to decide which SF models without
 *  wholesale data to delete vs keep + tag follow-up. */
async function fetchActiveModelsLast30d(): Promise<Set<string>> {
    // queryLogs admin endpoint with 30-day window. Page through up to 50
    // pages of 1000 = 50k log rows — enough for the post-Phase-1.5 state
    // (which has ~0 logs left in the 30-day window after dev cleanup).
    const cutoffSec = Math.floor(Date.now() / 1000) - 30 * 86400;
    const seen = new Set<string>();
    for (let page = 1; page <= 50; page++) {
        const r = await api<{ items: Array<{ model_name?: string; type: number }>; total: number }>(
            `/api/log/?p=${page}&page_size=1000&type=2&start_timestamp=${cutoffSec}`,
        );
        const items = r.items ?? [];
        for (const log of items) {
            if (log.type === 2 && log.model_name) seen.add(log.model_name);
        }
        if (items.length < 1000) break;
        if (page * 1000 >= (r.total ?? 0)) break;
    }
    return seen;
}

// =============================================================================
// PER-CHANNEL PLANNERS — return the new {models, model_ratio, completion_ratio}
// =============================================================================

interface ChannelPlan {
    /** Comma-separated models string for the channel. */
    models: string;
    /** JSON-encoded model_ratio dict. */
    model_ratio: string;
    /** JSON-encoded completion_ratio dict. */
    completion_ratio: string;
    /** Diff metadata for the dry-run report. */
    diff: {
        kept: string[];
        added: string[];
        removed: string[];
        followUp: string[]; // SF models without wholesale but with traffic
    };
}

function planSub2apiClaude(current: Channel): ChannelPlan {
    const currentModels = new Set(parseModels(current.models));
    const whitelist = Object.keys(SUB2API_CLAUDE_WHITELIST);
    const kept: string[] = [];
    const removed: string[] = [];
    for (const m of currentModels) {
        if ((whitelist as string[]).includes(m)) kept.push(m);
        else removed.push(m);
    }
    const added = whitelist.filter((m) => !currentModels.has(m));

    const mr: Record<string, number> = {};
    const cr: Record<string, number> = {};
    for (const m of whitelist) {
        const wl = SUB2API_CLAUDE_WHITELIST[m];
        // promo input USD = retailIn × 0.5; output cr stays as retail-ratio
        mr[m] = wl.retailIn * PROMO_DISCOUNT;
        cr[m] = wl.retailIn > 0 ? wl.retailOut / wl.retailIn : 1;
    }

    return {
        models: whitelist.join(','),
        model_ratio: JSON.stringify(mr),
        completion_ratio: JSON.stringify(cr),
        diff: { kept, added, removed, followUp: [] },
    };
}

function planSub2apiOpenAI(current: Channel): ChannelPlan {
    const currentModels = new Set(parseModels(current.models));
    const whitelist = Object.keys(SUB2API_OPENAI_WHITELIST);
    const kept: string[] = [];
    const removed: string[] = [];
    for (const m of currentModels) {
        if ((whitelist as string[]).includes(m)) kept.push(m);
        else removed.push(m);
    }
    const added = whitelist.filter((m) => !currentModels.has(m));

    const mr: Record<string, number> = {};
    const cr: Record<string, number> = {};
    for (const m of whitelist) {
        const wl = SUB2API_OPENAI_WHITELIST[m];
        if (wl.kind === 'text') {
            // Promo: mr = retail × 0.5; cr = retail_out / retail_in.
            // Exit multiplies mr by 2 → restores retail.
            mr[m] = wl.retailIn * PROMO_DISCOUNT;
            cr[m] = wl.retailIn > 0 ? wl.retailOut / wl.retailIn : 1;
        } else {
            // multimodal — direct values; cr stays the same across
            // promo and retail. Exit multiplies promoMr by 2 = retailMr.
            mr[m] = wl.promoMr;
            cr[m] = wl.promoCr;
            // Defensive sanity: confirm retailMr === promoMr × 2 so the
            // exit script's mr×2 logic produces the operator-specified
            // retail value. Errors at apply-time, not silently.
            const expected = wl.promoMr * 2;
            if (Math.abs(wl.retailMr - expected) > 1e-6) {
                throw new Error(
                    `multimodal pricing inconsistency for ${m}: ` +
                    `promoMr=${wl.promoMr}, promoMr×2=${expected}, retailMr=${wl.retailMr} ` +
                    `(exit-w7-promo.ts uses mr×2 — fix one of the two)`,
                );
            }
        }
    }

    return {
        models: whitelist.join(','),
        model_ratio: JSON.stringify(mr),
        completion_ratio: JSON.stringify(cr),
        diff: { kept, added, removed, followUp: [] },
    };
}

function planSiliconflow(current: Channel, activeModels: Set<string>): ChannelPlan {
    const currentModels = parseModels(current.models);
    const kept: string[] = [];
    const removed: string[] = [];
    const followUp: string[] = [];
    const mr: Record<string, number> = {};
    const cr: Record<string, number> = {};

    for (const m of currentModels) {
        const ws = SF_WHOLESALE_CNY[m];
        if (ws) {
            // Has wholesale → priced via formula. Round to 4 decimal
            // places so values stay byte-stable across runs (rationale:
            // /api/pricing returns the JSON value as-is, and we want the
            // post-apply verify + idempotent dry-run to compare cleanly
            // without IEEE 754 representation drift).
            kept.push(m);
            // Free models (e.g. bge-m3 promo) still get mr=0 — new-api treats
            // 0 as "free" (no quota consumed).
            mr[m] = roundTo4(ws.in_cny_per_1m / SF_DIVISOR);
            cr[m] = ws.in_cny_per_1m > 0
                ? roundTo4(ws.out_cny_per_1m / ws.in_cny_per_1m)
                : 1;
        } else if (activeModels.has(m)) {
            // No wholesale, but customers used it → keep + ceiling + flag
            kept.push(m);
            followUp.push(m);
            mr[m] = SF_FALLBACK_MR;
            cr[m] = SF_FALLBACK_CR;
        } else {
            // No wholesale, no traffic → drop
            removed.push(m);
        }
    }

    return {
        models: kept.join(','),
        model_ratio: JSON.stringify(mr),
        completion_ratio: JSON.stringify(cr),
        diff: { kept, added: [], removed, followUp },
    };
}

// =============================================================================
// REPORT
// =============================================================================

function fmt(n: number): string {
    return n.toFixed(4).replace(/\.?0+$/, '');
}

function reportPlan(channelLabel: string, current: Channel, plan: ChannelPlan): void {
    const oldModels = parseModels(current.models);
    const oldMr = parseJsonOrEmpty(current.model_ratio);
    const oldCr = parseJsonOrEmpty(current.completion_ratio);

    console.log(`\n────────────────────────────────────────────────────────────────────`);
    console.log(`Channel: ${channelLabel} (id=${current.id}, type=${current.type})`);
    console.log(`────────────────────────────────────────────────────────────────────`);
    console.log(`  models: ${oldModels.length} → ${plan.diff.kept.length + plan.diff.added.length} (kept ${plan.diff.kept.length} / added ${plan.diff.added.length} / removed ${plan.diff.removed.length})`);

    if (plan.diff.added.length > 0) {
        console.log(`  ADDED (in whitelist but not currently in channel):`);
        for (const m of plan.diff.added) console.log(`    + ${m}`);
    }
    if (plan.diff.removed.length > 0 && plan.diff.removed.length <= 30) {
        console.log(`  REMOVED:`);
        for (const m of plan.diff.removed) console.log(`    - ${m}`);
    } else if (plan.diff.removed.length > 30) {
        console.log(`  REMOVED ${plan.diff.removed.length} models (sample first 10):`);
        for (const m of plan.diff.removed.slice(0, 10)) console.log(`    - ${m}`);
        console.log(`    … and ${plan.diff.removed.length - 10} more`);
    }
    if (plan.diff.followUp.length > 0) {
        console.log(`  FOLLOW-UP (kept at fallback ratio, needs wholesale data):`);
        for (const m of plan.diff.followUp) console.log(`    ! ${m}`);
    }

    const newMr = parseJsonOrEmpty(plan.model_ratio);
    const newCr = parseJsonOrEmpty(plan.completion_ratio);
    console.log(`\n  RATIO TABLE (mr / cr in new-api units; with QPU=1M: mr ≈ USD/1M_input):`);
    const ratioModels = Array.from(new Set([...Object.keys(newMr), ...Object.keys(oldMr)])).sort();
    for (const m of ratioModels) {
        const oldM = oldMr[m] ?? '—';
        const newM = newMr[m] ?? '—';
        const oldC = oldCr[m] ?? '—';
        const newC = newCr[m] ?? '—';
        if (oldM === newM && oldC === newC) continue;
        console.log(`    ${m.padEnd(50)} mr ${String(oldM).padStart(8)} → ${String(typeof newM === 'number' ? fmt(newM) : newM).padStart(8)}    cr ${String(oldC).padStart(6)} → ${String(typeof newC === 'number' ? fmt(newC) : newC).padStart(6)}`);
    }
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
    console.log(`W7 D2 Phase 3 — pricing apply ${APPLY ? '(LIVE — will PUT to admin API)' : '(DRY-RUN — pass --apply to write)'}`);
    console.log(`new-api URL: ${NEWAPI_BASE_URL}`);

    const sf  = await fetchChannel(CHANNEL_IDS.siliconflow);
    const cl  = await fetchChannel(CHANNEL_IDS.sub2apiClaude);
    const ai  = await fetchChannel(CHANNEL_IDS.sub2apiOpenAI);

    console.log(`\nFetching active model usage (last 30 days, type=2 logs) for SF triage...`);
    const active = await fetchActiveModelsLast30d();
    console.log(`  active models in window: ${active.size}`);

    const planClaude = planSub2apiClaude(cl);
    const planOpenAI = planSub2apiOpenAI(ai);
    const planSF     = planSiliconflow(sf, active);

    reportPlan('sub2api Claude (Anthropic)', cl, planClaude);
    reportPlan('sub2api-openai',             ai, planOpenAI);
    reportPlan('siliconflow',                sf, planSF);

    // Aggregate the 36-SKU expected mr / cr across all channels — used
    // by both the dry-run option-merge preview and the post-write verify.
    const expectedMr: RatioMap = {};
    const expectedCr: RatioMap = {};
    for (const plan of [planClaude, planOpenAI, planSF]) {
        const mr = JSON.parse(plan.model_ratio) as RatioMap;
        const cr = JSON.parse(plan.completion_ratio) as RatioMap;
        for (const [k, v] of Object.entries(mr)) expectedMr[k] = v;
        for (const [k, v] of Object.entries(cr)) expectedCr[k] = v;
    }

    // Pre-fetch current option JSON so dry-run can preview the merge.
    const optionsBefore = await api<Array<{ key: string; value: string }>>('/api/option/');
    const currentMrJson =
        optionsBefore.find((o) => o.key === 'ModelRatio')?.value ?? '{}';
    const currentCrJson =
        optionsBefore.find((o) => o.key === 'CompletionRatio')?.value ?? '{}';

    const mrPlan = mergeRatioMap(currentMrJson, expectedMr);
    const crPlan = mergeRatioMap(currentCrJson, expectedCr);

    console.log(`\n────────────────────────────────────────────────────────────────────`);
    console.log(`Will PUT /api/option/ ModelRatio  (${Object.keys(mrPlan.merged).length} keys total)`);
    console.log(`────────────────────────────────────────────────────────────────────`);
    console.log(`  ${mrPlan.added.length} added · ${mrPlan.overwritten.length} overwritten · ${mrPlan.unchanged.length} unchanged · ${mrPlan.preserved.length} preserved (untouched)`);
    if (mrPlan.overwritten.length > 0) {
        console.log(`  OVERWRITES (existing global ratio → new):`);
        for (const o of mrPlan.overwritten) {
            console.log(`    ${o.model.padEnd(50)} ${String(o.oldValue).padStart(8)} → ${String(o.newValue).padStart(8)}`);
        }
    }

    console.log(`\n────────────────────────────────────────────────────────────────────`);
    console.log(`Will PUT /api/option/ CompletionRatio  (${Object.keys(crPlan.merged).length} keys total)`);
    console.log(`────────────────────────────────────────────────────────────────────`);
    console.log(`  ${crPlan.added.length} added · ${crPlan.overwritten.length} overwritten · ${crPlan.unchanged.length} unchanged · ${crPlan.preserved.length} preserved (untouched)`);

    if (!APPLY) {
        console.log(`\n────────────────────────────────────────────────────────────────────`);
        console.log(`Dry-run complete. Pass --apply to write to new-api admin API.`);
        console.log(`────────────────────────────────────────────────────────────────────`);
        return;
    }

    // ── APPLY phase 1 of 2: channel.models (cold-SKU delete) ────────────
    // Channel PUT: ONLY change `models`. Do NOT include model_ratio /
    // completion_ratio in the body — channels table has no such columns,
    // PUT would silently drop them (gotcha #18, found 2026-05-06).
    for (const [label, current, plan] of [
        ['sub2api Claude',     cl, planClaude],
        ['sub2api-openai',     ai, planOpenAI],
        ['siliconflow',        sf, planSF],
    ] as const) {
        await writeChannelModels(current, plan.models, label);
    }

    // ── APPLY phase 2 of 2: ratios via /api/option/ JSON merge ──────────
    await writeOptionRatio('ModelRatio', mrPlan.merged);
    await writeOptionRatio('CompletionRatio', crPlan.merged);

    // ── POST-WRITE VERIFICATION ────────────────────────────────────────
    // Re-fetch /api/pricing and confirm the live state matches `expected`
    // for all 36 SKUs. Catches any silent-drop regression — never trusts
    // the PUT envelope's `success:true` marker.
    console.log(`\n────────────────────────────────────────────────────────────────────`);
    console.log(`Post-write verification: GET /api/pricing → diff against expected`);
    console.log(`────────────────────────────────────────────────────────────────────`);
    const live = await api<Array<{ model_name: string; model_ratio: number; completion_ratio: number }>>(
        '/api/pricing',
    );
    const mismatches = findPricingMismatches(live, expectedMr, expectedCr);
    if (mismatches.length > 0) {
        console.error(`\x1b[31m✗ ${mismatches.length} pricing mismatch(es):\x1b[0m`);
        for (const m of mismatches) {
            console.error(
                `\x1b[31m  ${m.model.padEnd(50)} ${m.field.padEnd(18)} expected=${m.expected} actual=${Number.isNaN(m.actual) ? 'MISSING' : m.actual}\x1b[0m`,
            );
        }
        console.error(`\x1b[31mAborting non-zero so the maintenance window operator notices.\x1b[0m`);
        process.exit(1);
    }
    console.log(`✓ all ${Object.keys(expectedMr).length} SKU mr + ${Object.keys(expectedCr).length} SKU cr match live /api/pricing`);

    console.log(`\nAll changes applied successfully. Next:`);
    console.log(`  1. Run scripts/rebuild-channel-model-mapping.ts 1 --apply   (gotcha #15)`);
    console.log(`  2. Phase 5 verification: real call to ai.silkroadai.io + audit xlsx regen`);
}

/**
 * PUT /api/channel/ updating ONLY the `models` field (cold-SKU delete).
 * Pulls the full channel JSON to preserve other fields (model_mapping —
 * gotcha #15 — and any per-channel config we don't manage).
 *
 * Crucially does NOT include model_ratio / completion_ratio in the body
 * — those columns don't exist on the channels table; including them
 * would be silently dropped (gotcha #18) but more importantly would
 * suggest to future maintainers that channel-level ratio storage is a
 * thing.
 */
async function writeChannelModels(current: Channel, newModels: string, label: string): Promise<void> {
    // Strip the silently-dropped fields via destructuring rather than
    // sending them and trusting the server to ignore. Two reasons:
    // (a) defense in depth against any new-api version that DOES start
    //     honoring these fields (would drift from option-table source
    //     of truth);
    // (b) the rest-pattern visibly documents that we're NOT writing
    //     ratios via this path — future maintainers shouldn't add
    //     `model_ratio: ...` here without reading gotcha #18 first.
    const { model_ratio: _droppedMr, completion_ratio: _droppedCr, ...rest } = current;
    void _droppedMr;
    void _droppedCr;
    const body = { ...rest, models: newModels };
    console.log(`\n→ PUT /api/channel/  (${label}, id=${current.id}, models=${newModels.split(',').length} entries)`);
    await api('/api/channel/', { method: 'PUT', body: JSON.stringify(body) });
    console.log(`  ✓ channel.models updated`);
}

/** PUT /api/option/ writing the merged ModelRatio or CompletionRatio JSON. */
async function writeOptionRatio(key: 'ModelRatio' | 'CompletionRatio', merged: RatioMap): Promise<void> {
    const json = JSON.stringify(merged);
    console.log(`\n→ PUT /api/option/  ${key}  (${Object.keys(merged).length} keys, ${json.length} bytes)`);
    await api('/api/option/', { method: 'PUT', body: JSON.stringify({ key, value: json }) });
    console.log(`  ✓ ${key} written`);
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
