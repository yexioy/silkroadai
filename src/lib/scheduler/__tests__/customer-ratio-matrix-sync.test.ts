import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSync = vi.fn();
vi.mock('@/lib/newapi/customer-ratio-matrix-sync', () => ({
    syncCustomerRatioMatrix: (...a: unknown[]) => mockSync(...a),
}));
const mockCapture = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCapture(...a) }));

import { runCustomerRatioMatrixSync } from '../customer-ratio-matrix-sync';

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

const DIFF = { added: [], removed: [], changed: ['vip-a'] };

describe('runCustomerRatioMatrixSync', () => {
    it.each([[{ status: 'in_sync', rows: 11 }], [{ status: 'deferred', reason: 'lock_held' }]])(
        '%j → 不告警',
        async (result) => {
            mockSync.mockResolvedValue(result);
            await expect(runCustomerRatioMatrixSync()).resolves.toEqual(result);
            expect(mockCapture).not.toHaveBeenCalled();
        },
    );

    it('synced → info 留痕带明细', async () => {
        const result = { status: 'synced', rows: 11, diff: DIFF, heldRemovals: [] };
        mockSync.mockResolvedValue(result);
        await runCustomerRatioMatrixSync();
        expect(mockCapture).toHaveBeenCalledWith('customer ratio matrix synced', {
            level: 'info',
            extra: { result },
        });
    });

    it('synced 但有挂起的批量删除 → error 告警', async () => {
        const result = { status: 'synced', rows: 11, diff: DIFF, heldRemovals: ['a', 'b', 'c', 'd'] };
        mockSync.mockResolvedValue(result);
        await runCustomerRatioMatrixSync();
        expect(mockCapture).toHaveBeenCalledWith('customer ratio matrix removals held', {
            level: 'error',
            extra: { result },
        });
    });

    it.each([
        [{ status: 'removals_held', heldRemovals: ['a', 'b', 'c', 'd'] }],
        [{ status: 'invalid', problems: ['GroupGroupRatio 缺失'] }],
        [{ status: 'write_failed', error: 'x' }],
        [{ status: 'verify_failed', detail: 'x' }],
    ])('%j → error 告警', async (result) => {
        mockSync.mockResolvedValue(result);
        await runCustomerRatioMatrixSync();
        expect(mockCapture).toHaveBeenCalledWith(`customer ratio matrix ${result.status}`, {
            level: 'error',
            extra: { result },
        });
    });

    it('上一轮未结束 → 不重入', async () => {
        let release: (v: unknown) => void = () => {};
        mockSync.mockReturnValue(new Promise((r) => (release = r)));
        const first = runCustomerRatioMatrixSync();
        await expect(runCustomerRatioMatrixSync()).resolves.toBeNull();
        release({ status: 'in_sync', rows: 1 });
        await first;
        expect(mockSync).toHaveBeenCalledTimes(1);
    });
});
