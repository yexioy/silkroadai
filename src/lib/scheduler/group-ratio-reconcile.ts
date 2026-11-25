import * as Sentry from '@sentry/nextjs';
import { reconcileGroupRatioKeys, type GroupRatioReconcileResult } from '@/lib/newapi/group-ratio-reconcile';

/**
 * 分组倍率三键同步(2026-11-25)。每分钟把后台 UI 写的 `GroupRatio` 复制到另外两个 option 键,
 * 让 UI 上的改 / 删 / 建在一分钟内真正生效。规则与保险见 lib/newapi/group-ratio-reconcile.ts。
 */
const INTERVAL_MS = 60 * 1_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runGroupRatioReconcile(): Promise<GroupRatioReconcileResult | null> {
    if (running) return null;
    running = true;
    try {
        const result = await reconcileGroupRatioKeys();
        switch (result.status) {
            case 'in_sync':
                break; // 每分钟一次,一致时不刷日志
            case 'deferred':
                console.log(`[group-ratio-sync] deferred to next tick: ${result.reason}`);
                break;
            case 'synced':
                console.warn('[group-ratio-sync] synced from GroupRatio', JSON.stringify(result));
                if (result.heldRemovals.length > 0) {
                    Sentry.captureMessage('group ratio removals held', { level: 'error', extra: { result } });
                } else {
                    Sentry.captureMessage('group ratio keys synced', { level: 'info', extra: { result } });
                }
                break;
            default:
                console.error('[group-ratio-sync] needs attention', JSON.stringify(result));
                Sentry.captureMessage(`group ratio keys ${result.status}`, { level: 'error', extra: { result } });
        }
        return result;
    } finally {
        running = false;
    }
}

export function startGroupRatioReconcileScheduler(): void {
    if (timer) return;
    const tick = () =>
        runGroupRatioReconcile().catch((err) => {
            console.error('[group-ratio-sync] pass failed:', err);
            Sentry.captureException(err, { tags: { area: 'group-ratio-sync' } });
        });
    // 启动后 1 分钟首跑(让 new-api 连通稳定),之后每分钟
    timer = setInterval(tick, INTERVAL_MS);
}

export function stopGroupRatioReconcileScheduler(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
