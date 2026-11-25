import * as Sentry from '@sentry/nextjs';
import { syncCustomerRatioMatrix, type MatrixSyncResult } from '@/lib/newapi/customer-ratio-matrix-sync';

/**
 * 客户专属倍率矩阵两键同步(2026-11-25)。每分钟把后台 UI 写的 `GroupGroupRatio` 复制到
 * `group_ratio_setting.group_group_ratio`。规则与保险见 lib/newapi/customer-ratio-matrix-sync.ts。
 */
const INTERVAL_MS = 60 * 1_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runCustomerRatioMatrixSync(): Promise<MatrixSyncResult | null> {
    if (running) return null;
    running = true;
    try {
        const result = await syncCustomerRatioMatrix();
        switch (result.status) {
            case 'in_sync':
                break; // 每分钟一次,一致时不刷日志
            case 'deferred':
                console.log(`[customer-ratio-matrix-sync] deferred to next tick: ${result.reason}`);
                break;
            case 'synced':
                console.warn('[customer-ratio-matrix-sync] synced from GroupGroupRatio', JSON.stringify(result));
                if (result.heldRemovals.length > 0) {
                    Sentry.captureMessage('customer ratio matrix removals held', {
                        level: 'error',
                        extra: { result },
                    });
                } else {
                    Sentry.captureMessage('customer ratio matrix synced', { level: 'info', extra: { result } });
                }
                break;
            default:
                console.error('[customer-ratio-matrix-sync] needs attention', JSON.stringify(result));
                Sentry.captureMessage(`customer ratio matrix ${result.status}`, {
                    level: 'error',
                    extra: { result },
                });
        }
        return result;
    } finally {
        running = false;
    }
}

export function startCustomerRatioMatrixSyncScheduler(): void {
    if (timer) return;
    const tick = () =>
        runCustomerRatioMatrixSync().catch((err) => {
            console.error('[customer-ratio-matrix-sync] pass failed:', err);
            Sentry.captureException(err, { tags: { area: 'customer-ratio-matrix-sync' } });
        });
    // 启动后 1 分钟首跑,之后每分钟
    timer = setInterval(tick, INTERVAL_MS);
}

export function stopCustomerRatioMatrixSyncScheduler(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
