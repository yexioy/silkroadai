#!/usr/bin/env tsx
/**
 * W7 promo exit — restore sub2api retail pricing on 2026-06-09.
 *
 * Multiplies the global ModelRatio of sub2api SKUs by 2 (promo → retail).
 * `CompletionRatio` stays unchanged (output/input ratio is invariant
 * across promo and retail). The siliconflow channel never had a promo,
 * so its SKUs are NOT touched.
 *
 * Storage path (gotcha #18, found 2026-05-06): per-model ratios live
 * in the `options` table as `ModelRatio` JSON globals — NOT on the
 * channels table. PUT /api/channel/ silently drops model_ratio fields.
 * This script writes via PUT /api/option/ with merged JSON.
 *
 * Pre-req: `apply-w7-pricing.ts --apply` was run in the W7 D2 window.
 * If a sub2api SKU is absent from the global ModelRatio, the script
 * skips it with a warning (means apply was never run, or the SKU was
 * removed from the whitelist).
 *
 * Usage
 * -----
 *   tsx _bootstrap/exit-w7-promo.ts             # dry-run (default)
 *   tsx _bootstrap/exit-w7-promo.ts --apply     # actually PUT
 *
 * See docs/W7-PROMO-EXIT-RUNBOOK.md for the operator playbook.
 */
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();
import { mergeRatioMap, findPricingMismatches, type RatioMap } from './lib/option-ratio-merge';

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';
const NEWAPI_ADMIN_TOKEN = process.env.NEWAPI_ADMIN_TOKEN;
const NEWAPI_ADMIN_USER_ID = process.env.NEWAPI_ADMIN_USER_ID;
if (!NEWAPI_ADMIN_TOKEN || !NEWAPI_ADMIN_USER_ID) {
    console.error('Missing NEWAPI_ADMIN_TOKEN or NEWAPI_ADMIN_USER_ID. Aborting.');
    process.exit(1);
}

const APPLY = process.argv.includes('--apply');

/**
 * SKUs that were on the W7 launch promo. Their `apply-w7-pricing.ts`
 * planner set mr = retail × 0.5; this script reverses that with mr × 2.
 *
 * MUST stay in sync with apply-w7-pricing.ts SUB2API_*_WHITELIST. If a
 * SKU is removed from the whitelist before exit, also remove it here
 * (or leave it — the script tolerates missing entries gracefully).
 *
 * SiliconFlow SKUs are NOT in this list (SF was never on promo).
 */
const PROMO_SKUS = [
    // sub2api Anthropic
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    // sub2api-openai text
    'gpt-5.2',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.5',
    // sub2api-openai multimodal
    'gpt-4o-audio-preview',
    'gpt-4o-realtime-preview',
    'gpt-image-1.5',
] as const;

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

async function main(): Promise<void> {
    console.log(`W7 promo exit ${APPLY ? '(LIVE — will PUT to /api/option/)' : '(DRY-RUN)'}`);
    console.log(`new-api URL: ${NEWAPI_BASE_URL}`);
    console.log();

    // 1. Fetch current global ModelRatio JSON.
    const opts = await api<Array<{ key: string; value: string }>>('/api/option/');
    const mrEntry = opts.find((o) => o.key === 'ModelRatio');
    if (!mrEntry) {
        console.error('ModelRatio option not found. apply-w7-pricing.ts has not been run yet?');
        process.exit(1);
    }
    const currentMr: RatioMap = JSON.parse(mrEntry.value);

    // 2. Compute the doubled values for promo SKUs only. Skip + warn on
    //    any SKU not currently in ModelRatio.
    const updates: RatioMap = {};
    const skipped: string[] = [];
    for (const sku of PROMO_SKUS) {
        const cur = currentMr[sku];
        if (cur === undefined) {
            skipped.push(sku);
            continue;
        }
        updates[sku] = cur * 2;
    }
    if (skipped.length > 0) {
        console.warn(
            `WARN — ${skipped.length} promo SKU(s) absent from global ModelRatio (skipping):`,
        );
        for (const s of skipped) console.warn(`  · ${s}`);
        console.warn('');
    }

    if (Object.keys(updates).length === 0) {
        console.log('Nothing to do — all promo SKUs missing from global ModelRatio.');
        console.log('See docs/W7-PROMO-EXIT-RUNBOOK.md for context.');
        return;
    }

    // 3. Merge into a new ModelRatio object — preserve all unrelated SKUs.
    const plan = mergeRatioMap(currentMr, updates);

    // 4. Print the diff: which SKUs go from promo to retail.
    console.log('Promo → retail (mr × 2):');
    for (const sku of PROMO_SKUS) {
        if (!(sku in updates)) continue;
        console.log(`  ${sku.padEnd(35)} ${currentMr[sku].toFixed(4)} → ${updates[sku].toFixed(4)}  (×2)`);
    }
    console.log();
    console.log(
        `ModelRatio merge: ${plan.added.length} added · ${plan.overwritten.length} overwritten · ${plan.unchanged.length} unchanged · ${plan.preserved.length} preserved (untouched)`,
    );

    if (!APPLY) {
        console.log('\nDry-run complete. Pass --apply to PUT.');
        console.log('See docs/W7-PROMO-EXIT-RUNBOOK.md for the full playbook.');
        return;
    }

    // 5. Apply: PUT merged JSON back.
    console.log('\n→ PUT /api/option/  ModelRatio');
    await api('/api/option/', {
        method: 'PUT',
        body: JSON.stringify({
            key: 'ModelRatio',
            value: JSON.stringify(plan.merged),
        }),
    });
    console.log('  ✓ ModelRatio written');

    // 6. Post-write verification — confirm /api/pricing reflects the
    //    doubled values for every promo SKU. Catches any silent-drop
    //    or merge-bug regression.
    console.log('\nPost-write verification: GET /api/pricing → diff against expected');
    const live = await api<Array<{ model_name: string; model_ratio: number; completion_ratio: number }>>(
        '/api/pricing',
    );
    const mismatches = findPricingMismatches(live, updates, {});
    if (mismatches.length > 0) {
        console.error(`\x1b[31m✗ ${mismatches.length} pricing mismatch(es) post-exit:\x1b[0m`);
        for (const m of mismatches) {
            console.error(
                `\x1b[31m  ${m.model.padEnd(40)} ${m.field.padEnd(18)} expected=${m.expected} actual=${Number.isNaN(m.actual) ? 'MISSING' : m.actual}\x1b[0m`,
            );
        }
        process.exit(1);
    }
    console.log(`✓ all ${Object.keys(updates).length} promo SKUs now at retail mr.`);

    console.log('\nPromo exit complete. Verify next:');
    console.log('  - portal /pricing rebuild (remove promo banner / strikethrough)');
    console.log('  - notify Frankqy via WeChat that promo is over');
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
