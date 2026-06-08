import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockGroupBy = vi.fn();
const mockUserFindMany = vi.fn();
const mockTenantFindMany = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        usageRecord: { groupBy: (...a: unknown[]) => mockGroupBy(...a) },
        user: { findMany: (...a: unknown[]) => mockUserFindMany(...a) },
        tenant: { findMany: (...a: unknown[]) => mockTenantFindMany(...a) },
    },
}));
// 1 USD = 500k quota × ¥7.2/USD.
vi.mock('@/lib/newapi/client', () => ({ quotaToCny: (q: number) => (q / 500_000) * 7.2 }));

import { GET } from '@/app/api/admin/billing-shadow/route';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER = { role: 'admin', tenant_id: 'tenant-7', user: { id: 'admin-1' }, viaBreakGlass: false };

function req(url = 'https://x/api/admin/billing-shadow') {
    return new NextRequest(url, { method: 'GET' });
}

// route calls groupBy 3× in order, all with `matched` in the `by` (so matched-only
// diff bases can be computed per group): (model,tier,matched) → (user,matched) → (tenant,matched).
//
// Sample: one fully-matched model (gpt-5.4: 2 calls, ¥12.5, 900k matched quota) and one
// fully-unmatched model (claude-x: 1 call, ¥0, 50k quota — priced by new-api, not by us).
// new-api actual TOTAL = 950k (¥13.68); but the matched-vs-matched base is 900k (¥12.96).
function wireGroupBy() {
    mockGroupBy.mockImplementation((args: { by: string[] }) => {
        const by = args.by.join(',');
        if (by === 'model_slug,tier,matched')
            return Promise.resolve([
                {
                    model_slug: 'gpt-5.4',
                    tier: 'pool',
                    matched: true,
                    _count: { _all: 2 },
                    _sum: { cost_cny: '12.5', newapi_quota: 900_000 },
                },
                {
                    model_slug: 'claude-x',
                    tier: 'pool',
                    matched: false,
                    _count: { _all: 1 },
                    _sum: { cost_cny: '0', newapi_quota: 50_000 },
                },
            ]);
        if (by === 'user_id,matched')
            return Promise.resolve([
                {
                    user_id: 'u1',
                    matched: true,
                    _count: { _all: 2 },
                    _sum: { cost_cny: '12.5', newapi_quota: 900_000 },
                },
                { user_id: 'u1', matched: false, _count: { _all: 1 }, _sum: { cost_cny: '0', newapi_quota: 50_000 } },
            ]);
        if (by === 'tenant_id,matched')
            return Promise.resolve([
                {
                    tenant_id: 'tenant-1',
                    matched: true,
                    _count: { _all: 2 },
                    _sum: { cost_cny: '12.5', newapi_quota: 900_000 },
                },
                {
                    tenant_id: 'tenant-2',
                    matched: false,
                    _count: { _all: 1 },
                    _sum: { cost_cny: '0', newapi_quota: 50_000 },
                },
            ]);
        return Promise.resolve([]);
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    wireGroupBy();
    mockUserFindMany.mockResolvedValue([{ id: 'u1', email: 'a@b.com' }]);
    mockTenantFindMany.mockResolvedValue([
        { id: 'tenant-1', slug: 'silkroadai', brand_name: 'Silk Road AI' },
        { id: 'tenant-2', slug: 'partner', brand_name: 'Partner Co' },
    ]);
});

describe('GET /api/admin/billing-shadow', () => {
    it('401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
        expect(mockGroupBy).not.toHaveBeenCalled();
    });

    it('headline diff is matched-vs-matched (unpriced quota does NOT pollute it)', async () => {
        const res = await GET(req());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.summary).toMatchObject({
            records: 3,
            matched: 2,
            unmatched: 1,
            costCny: 12.5, // matched-only portal cost
            newapiQuota: 950_000, // TOTAL actual quota (reference)
        });
        // matched base = 900k → ¥12.96; headline diff = 12.5 − 12.96 = −0.46 (NOT −1.18)
        expect(body.summary.matchedNewapiCny).toBeCloseTo(12.96, 6);
        expect(body.summary.diffCny).toBeCloseTo(-0.46, 6);
        expect(body.summary.diffRate).toBeCloseTo(-0.46 / 12.96, 6);
        // the old all-quota diff (−1.18) must NOT be what we report
        expect(body.summary.diffCny).not.toBeCloseTo(-1.18, 2);
    });

    it('coverage / total actual / unpriced-actual stay independent of the diff', async () => {
        const body = await (await GET(req())).json();
        expect(body.summary.coverage).toBeCloseTo(2 / 3, 6); // matched/records
        expect(body.summary.newapiCny).toBeCloseTo(13.68, 6); // 950k total → ¥13.68
        expect(body.summary.unmatchedNewapiCny).toBeCloseTo(0.72, 6); // 50k unpriced → ¥0.72
        expect(body.bigDiffThreshold).toBe(0.1);
    });

    it('byModel: per-row diff is matched-only; fully-unpriced row diffs to 0/null', async () => {
        const body = await (await GET(req())).json();
        // sorted by call volume desc
        expect(body.byModel.map((m: { model_slug: string }) => m.model_slug)).toEqual(['gpt-5.4', 'claude-x']);
        const gpt = body.byModel[0];
        expect(gpt).toMatchObject({ model_slug: 'gpt-5.4', tier: 'pool', records: 2, costCny: 12.5 });
        expect(gpt.matchedRate).toBeCloseTo(1, 6);
        expect(gpt.newapiCny).toBeCloseTo(12.96, 6); // total = matched here (fully matched)
        expect(gpt.matchedNewapiCny).toBeCloseTo(12.96, 6);
        expect(gpt.diffCny).toBeCloseTo(12.5 - 12.96, 6);
        // claude-x: 0% matched → no priced calls → diff 0, diffRate null (NOT −100%)
        const claude = body.byModel[1];
        expect(claude.matchedRate).toBeCloseTo(0, 6);
        expect(claude.costCny).toBe(0);
        expect(claude.matchedNewapiCny).toBe(0);
        expect(claude.diffCny).toBe(0);
        expect(claude.diffRate).toBeNull();
        // its total-actual column still surfaces what new-api took
        expect(claude.newapiCny).toBeCloseTo(0.72, 6);
    });

    it('unmatched list carries new-api ¥ each unpriced model×tier costs', async () => {
        const body = await (await GET(req())).json();
        expect(body.unmatched).toHaveLength(1);
        expect(body.unmatched[0]).toMatchObject({
            model_slug: 'claude-x',
            tier: 'pool',
            records: 1,
            newapiQuota: 50_000,
        });
        expect(body.unmatched[0].newapiCny).toBeCloseTo(0.72, 6);
    });

    it('byCustomer joins email + diff is matched-only', async () => {
        const body = await (await GET(req())).json();
        expect(body.byCustomer[0]).toMatchObject({ user_id: 'u1', email: 'a@b.com', records: 3, costCny: 12.5 });
        expect(body.byCustomer[0].newapiCny).toBeCloseTo(13.68, 6); // total actual
        expect(body.byCustomer[0].matchedNewapiCny).toBeCloseTo(12.96, 6); // matched base
        expect(body.byCustomer[0].diffCny).toBeCloseTo(-0.46, 6); // matched-vs-matched
    });

    it('byTenant joins brand_name, diff matched-only, sorts by total actual desc', async () => {
        const body = await (await GET(req())).json();
        expect(body.byTenant).toHaveLength(2);
        expect(body.byTenant[0]).toMatchObject({ tenant_id: 'tenant-1', name: 'Silk Road AI', records: 2 });
        expect(body.byTenant[0].diffCny).toBeCloseTo(12.5 - 12.96, 6);
        // tenant-2 fully unpriced → diff 0/null
        expect(body.byTenant[1]).toMatchObject({ tenant_id: 'tenant-2', name: 'Partner Co', records: 1 });
        expect(body.byTenant[1].diffCny).toBe(0);
        expect(body.byTenant[1].diffRate).toBeNull();
    });

    it('byTenant: null tenant_id maps to PLATFORM_TENANT_ID with no name', async () => {
        mockGroupBy.mockImplementation((args: { by: string[] }) => {
            const by = args.by.join(',');
            if (by === 'tenant_id,matched')
                return Promise.resolve([
                    {
                        tenant_id: null,
                        matched: true,
                        _count: { _all: 1 },
                        _sum: { cost_cny: '1', newapi_quota: 10_000 },
                    },
                ]);
            if (by === 'model_slug,tier,matched')
                return Promise.resolve([
                    {
                        model_slug: 'm',
                        tier: 'pool',
                        matched: true,
                        _count: { _all: 1 },
                        _sum: { cost_cny: '1', newapi_quota: 10_000 },
                    },
                ]);
            return Promise.resolve([]);
        });
        mockTenantFindMany.mockResolvedValue([]);
        const body = await (await GET(req())).json();
        expect(body.byTenant[0]).toMatchObject({ tenant_id: PLATFORM_TENANT_ID, name: null });
    });

    it('superadmin → no tenant filter; partner → every aggregate tenant-scoped', async () => {
        await GET(req());
        expect(mockGroupBy.mock.calls[0][0].where).not.toHaveProperty('tenant_id');

        vi.clearAllMocks();
        wireGroupBy();
        mockUserFindMany.mockResolvedValue([]);
        mockTenantFindMany.mockResolvedValue([]);
        mockResolveAdmin.mockResolvedValue(PARTNER);
        await GET(req());
        for (const call of mockGroupBy.mock.calls) {
            expect(call[0].where.tenant_id).toBe('tenant-7');
        }
    });

    it('period: default 30d has a log_created_at window; all → no time filter', async () => {
        const d30 = await (await GET(req())).json();
        expect(d30.period).toBe('30d');
        expect(d30.rangeStart).not.toBeNull();
        expect(mockGroupBy.mock.calls[0][0].where.log_created_at?.gte).toBeInstanceOf(Date);

        vi.clearAllMocks();
        wireGroupBy();
        mockUserFindMany.mockResolvedValue([]);
        mockTenantFindMany.mockResolvedValue([]);
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const dall = await (await GET(req('https://x/api/admin/billing-shadow?period=all'))).json();
        expect(dall.period).toBe('all');
        expect(dall.rangeStart).toBeNull();
        expect(mockGroupBy.mock.calls[0][0].where).not.toHaveProperty('log_created_at');
    });

    it('period: junk value falls back to 30d (whitelist)', async () => {
        const body = await (await GET(req("https://x/api/admin/billing-shadow?period=99d';DROP"))).json();
        expect(body.period).toBe('30d');
    });
});
