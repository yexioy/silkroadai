import * as Sentry from '@sentry/nextjs';
import { reconcileGroupRatioKeys, type GroupRatioReconcileResult } from '@/lib/newapi/group-ratio-reconcile';

/**
 * 分组倍率三键对账(2026-11-06)。每小时比对 new-api 三个 GroupRatio option,兜住后台 UI 新建分组
 * 只写 legacy 键导致的"新组不生效"。何时写、何时只告警见 lib/newapi/group-ratio-reconcile.ts。
 */
const INTERVAL_MS = 60 * 60 * 1_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runGroupRatioReconcile(): Promise<GroupRatioReconcileResult | null> {
    if (running) return null;
    running = true;
    try {
        const result = await reconcileGroupRatioKeys();
        switch (result.status) {
            case 'in_sync':
                console.log(`[group-ratio-reconcile] ok: ${result.groups} groups in sync`);
                break;
            case 'deferred':
                console.log(`[group-ratio-reconcile] deferred to next tick: ${result.reason}`);
                break;
            case 'repaired':
                console.warn('[group-ratio-reconcile] repaired', JSON.stringify(result));
                Sentry.captureMessage('group ratio keys repaired', { level: 'warning', extra: { result } });
                break;
            default:
                console.error('[group-ratio-reconcile] needs attention', JSON.stringify(result));
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
            console.error('[group-ratio-reconcile] pass failed:', err);
            Sentry.captureException(err, { tags: { area: 'group-ratio-reconcile' } });
        });
    // 启动后 2 分钟首跑(让 new-api 连通稳定),之后每小时
    setTimeout(tick, 2 * 60 * 1_000);
    timer = setInterval(tick, INTERVAL_MS);
}

export function stopGroupRatioReconcileScheduler(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
