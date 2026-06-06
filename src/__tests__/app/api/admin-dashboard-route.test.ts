import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockVerifyAdminToken = vi.fn();
const mockOrderAggregate = vi.fn();
const mockOrderCount = vi.fn();
const mockOrderGroupBy = vi.fn();
const mockQueryRaw = vi.fn();
const mockRechargeAggregate = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
    verifyAdminToken: (...a: unknown[]) => mockVerifyAdminToken(...a),
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        order: {
            aggregate: (...a: unknown[]) => mockOrderAggregate(...a),
            count: (...a: unknown[]) => mockOrderCount(...a),
            groupBy: (...a: unknown[]) => mockOrderGroupBy(...a),
        },
        rechargeLog: {
            aggregate: (...a: unknown[]) => mockRechargeAggregate(...a),
        },
        $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
    },
}));

import { GET } from '@/app/api/admin/dashboard/route';

function req() {
    return new NextRequest('https://x/api/admin/dashboard?days=30');
}

beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyAdminToken.mockResolvedValue(true);
    // Every order.aggregate (today/total/sub*) → ¥100 / 1 order.
    mockOrderAggregate.mockResolvedValue({ _sum: { amount: 100 }, _count: { _all: 1 } });
    mockOrderCount.mockResolvedValue(1);
    mockOrderGroupBy.mockResolvedValue([]);
    mockQueryRaw.mockResolvedValue([]);
    // Default: no non-payment recharges.
    mockRechargeAggregate.mockResolvedValue({ _sum: { amount: 0 } });
});

describe('GET /api/admin/dashboard — manual (order-less) recharges (P2 Part 0)', () => {
    it('returns 401 when unauthenticated', async () => {
        mockVerifyAdminToken.mockResolvedValue(false);
        expect((await GET(req())).status).toBe(401);
    });

    it('folds a non-payment RechargeLog (no Order) into 今日/累计充值 amount', async () => {
        mockRechargeAggregate.mockResolvedValue({ _sum: { amount: 1000 } });
        const data = await (await GET(req())).json();
        // order paid (¥100) + manual recharge (¥1000)
        expect(data.summary.total.amount).toBe(1100);
        expect(data.summary.today.amount).toBe(1100);
        // successRate / avgAmount stay order-only (manual recharge has no Order).
        expect(data.summary.avgAmount).toBe(100);
    });

    it('without non-payment recharges, amount is order-only (no double count)', async () => {
        mockRechargeAggregate.mockResolvedValue({ _sum: { amount: 0 } });
        const data = await (await GET(req())).json();
        expect(data.summary.total.amount).toBe(100);
    });

    it('queries RechargeLog with source≠payment AND amount>0 (no double-count, excludes refunds)', async () => {
        await GET(req());
        const wheres = mockRechargeAggregate.mock.calls.map((c) => c[0].where);
        expect(wheres.length).toBe(2); // today + total
        for (const w of wheres) {
            expect(w.source).toEqual({ not: 'payment' });
            expect(w.amount).toEqual({ gt: 0 });
        }
        // "today" has a created_at lower bound; "total" (all-time) does not.
        expect(wheres.some((w) => w.created_at?.gte)).toBe(true);
        expect(wheres.some((w) => !w.created_at)).toBe(true);
    });
});
