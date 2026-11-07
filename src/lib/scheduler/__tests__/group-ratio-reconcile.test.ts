import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReconcile = vi.fn();
vi.mock('@/lib/newapi/group-ratio-reconcile', () => ({
    reconcileGroupRatioKeys: (...a: unknown[]) => mockReconcile(...a),
}));
const mockCapture = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCapture(...a) }));

import { runGroupRatioReconcile } from '../group-ratio-reconcile';

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('runGroupRatioReconcile', () => {
    it.each([[{ status: 'in_sync', groups: 28 }], [{ status: 'deferred', reason: 'lock_held' }]])(
        '%j → 不告警',
        async (result) => {
            mockReconcile.mockResolvedValue(result);
            await expect(runGroupRatioReconcile()).resolves.toEqual(result);
            expect(mockCapture).not.toHaveBeenCalled();
        },
    );

    it('repaired → warning 告警带明细', async () => {
        const result = { status: 'repaired', groups: 28, missing: { GroupRatio: ['x'] } };
        mockReconcile.mockResolvedValue(result);
        await runGroupRatioReconcile();
        expect(mockCapture).toHaveBeenCalledWith('group ratio keys repaired', {
            level: 'warning',
            extra: { result },
        });
    });

    it.each([
        [{ status: 'conflict', conflicts: [{ group: 'a', values: {} }] }],
        [{ status: 'invalid', problems: ['GroupRatio 缺失'] }],
        [{ status: 'write_failed', written: [], error: 'x' }],
        [{ status: 'verify_failed', detail: 'x' }],
    ])('%j → error 告警', async (result) => {
        mockReconcile.mockResolvedValue(result);
        await runGroupRatioReconcile();
        expect(mockCapture).toHaveBeenCalledWith(`group ratio keys ${result.status}`, {
            level: 'error',
            extra: { result },
        });
    });

    it('上一轮未结束 → 不重入', async () => {
        let release: (v: unknown) => void = () => {};
        mockReconcile.mockReturnValue(new Promise((r) => (release = r)));
        const first = runGroupRatioReconcile();
        await expect(runGroupRatioReconcile()).resolves.toBeNull();
        release({ status: 'in_sync', groups: 1 });
        await first;
        expect(mockReconcile).toHaveBeenCalledTimes(1);
    });
});
