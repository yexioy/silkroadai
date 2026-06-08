/**
 * P4b — <ShadowReport /> reconciliation report SSR smoke.
 *
 * Same shallow renderToString pattern as models-page / balance-alert-form tests.
 * ShadowReport is a pure (hook-free) presentational component, so we feed it
 * deterministic sample data and assert the report surfaces: interpretation copy
 * (incl. the matched-only diff note), the 4 summary cards (portal ¥ / new-api ¥ /
 * diff "(priced only)" / coverage), per-row matched% + matched-vs-matched diff,
 * the big-diff red highlight (driven by a matched-but-mispriced row), unmatched
 * chips with new-api cost, and the by-tenant table (only when >1 tenant).
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import { ShadowReport, getTexts, type ShadowData } from '@/app/admin/(console)/billing-shadow/page';

// gpt-5.4: fully matched, tiny diff (not red). glm-z: fully matched but MISPRICED
// (portal ¥10 vs matched actual ¥5.04 → +98% → red). claude-x: fully unpriced
// (0% matched → diff 0/null, amber matched%). Coverage 5/6 = 83.3% (< 90% → amber).
const TWO_TENANTS: ShadowData = {
    period: '30d',
    rangeStart: '2026-05-09T00:00:00.000Z',
    bigDiffThreshold: 0.1,
    summary: {
        records: 6,
        matched: 5,
        unmatched: 1,
        coverage: 5 / 6,
        costCny: 22.5,
        newapiQuota: 1_300_000,
        newapiCny: 18.72, // total actual
        matchedNewapiCny: 18.0, // matched base (diff vs this)
        unmatchedNewapiCny: 0.72,
        diffCny: 4.5, // 22.5 − 18.0 (matched-vs-matched)
        diffRate: 4.5 / 18.0, // +25% → red
    },
    byModel: [
        {
            model_slug: 'glm-z',
            tier: 'pool',
            records: 3,
            matchedRecords: 3,
            matchedRate: 1,
            costCny: 10,
            newapiQuota: 350_000,
            newapiCny: 5.04,
            diffCny: 4.96,
            diffRate: 4.96 / 5.04, // +98% → red
        },
        {
            model_slug: 'gpt-5.4',
            tier: 'pool',
            records: 2,
            matchedRecords: 2,
            matchedRate: 1,
            costCny: 12.5,
            newapiQuota: 900_000,
            newapiCny: 12.96,
            diffCny: -0.46,
            diffRate: -0.46 / 12.96, // −3.5% (not red)
        },
        {
            model_slug: 'claude-x',
            tier: 'pool',
            records: 1,
            matchedRecords: 0,
            matchedRate: 0, // amber
            costCny: 0,
            newapiQuota: 50_000,
            newapiCny: 0.72,
            diffCny: 0,
            diffRate: null, // no priced calls → no diff
        },
    ],
    byCustomer: [
        {
            user_id: 'u1',
            email: 'a@b.com',
            records: 6,
            costCny: 22.5,
            newapiQuota: 1_300_000,
            newapiCny: 18.72,
            diffCny: 4.5,
            diffRate: 4.5 / 18.0,
        },
    ],
    byTenant: [
        {
            tenant_id: 'tenant-1',
            slug: 'silkroadai',
            name: 'Silk Road AI',
            records: 5,
            costCny: 22.5,
            newapiQuota: 1_250_000,
            newapiCny: 18.0,
            diffCny: 4.5,
            diffRate: 4.5 / 18.0,
        },
        {
            tenant_id: 'tenant-2',
            slug: 'partner',
            name: 'Partner Co',
            records: 1,
            costCny: 0,
            newapiQuota: 50_000,
            newapiCny: 0.72,
            diffCny: 0,
            diffRate: null,
        },
    ],
    unmatched: [{ model_slug: 'claude-x', tier: 'pool', records: 1, newapiQuota: 50_000, newapiCny: 0.72 }],
};

const ONE_TENANT: ShadowData = { ...TWO_TENANTS, byTenant: [TWO_TENANTS.byTenant[0]] };

function render(data: ShadowData, locale: 'zh' | 'en' = 'zh') {
    return renderToString(<ShadowReport data={data} t={getTexts(locale)} isDark={false} />);
}

describe('<ShadowReport /> SSR (P4b)', () => {
    it('renders the how-to-read interpretation incl. the matched-only diff note', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('怎么读这份报表');
        expect(html).toContain('未生效、不影响客户');
        expect(html).toContain('计量管道可信'); // readiness-ready guidance
        expect(html).toContain('先给未定价模型配价'); // readiness-not-ready guidance
        expect(html).toContain('衡量计量/定价准不准'); // matched-only diff explanation
    });

    it('diff card is labelled matched-only and shows the comparison basis', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('仅已配价'); // diff card "(priced only)" note
        expect(html).toContain('+¥4.5'); // signed matched-vs-matched diff
        expect(html).toContain('对比已配价实扣'); // basis label
        expect(html).toContain('¥18'); // matchedNewapiCny basis value
    });

    it('renders coverage % and unmatched share independently of the diff', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('portal 计量');
        expect(html).toContain('new-api 实扣');
        expect(html).toContain('覆盖率');
        expect(html).toContain('83.3%'); // coverage 5/6
        expect(html).toContain('其中未配价占实扣'); // unmatched-share line
        expect(html).toContain('¥0.72');
    });

    it('byModel rows carry matched% and trigger red only for a mispriced matched row', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('glm-z');
        expect(html).toContain('gpt-5.4');
        expect(html).toContain('claude-x');
        expect(html).toContain('100.0%'); // fully matched
        expect(html).toContain('0.0%'); // claude-x 0% matched
        // glm-z (+98%) and the summary (+25%) exceed 10% → red present
        expect(html).toContain('text-red-500');
        // zero/partial match flagged amber (claude-x matched%, coverage 83.3%)
        expect(html).toContain('text-amber-500');
    });

    it('unmatched chips show the new-api ¥ each unpriced model costs', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('未配价');
        expect(html).toContain('claude-x');
        expect(html).toContain('¥0.72');
    });

    it('renders the by-tenant table when there is more than one tenant', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('按租户');
        expect(html).toContain('Silk Road AI');
        expect(html).toContain('Partner Co');
    });

    it('omits the by-tenant table when there is only one tenant', () => {
        const html = render(ONE_TENANT);
        expect(html).not.toContain('按租户');
    });

    it('renders the by-customer table', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('按客户');
        expect(html).toContain('a@b.com');
    });

    it('renders English copy under locale=en (incl. priced-only diff note)', () => {
        const html = render(TWO_TENANTS, 'en');
        expect(html).toContain('How to read this');
        expect(html).toContain('Coverage');
        expect(html).toContain('By tenant');
        expect(html).toContain('priced only');
        expect(html).toContain('vs priced actual');
    });
});
