import 'server-only';
import { listTokensForCustomer } from './client';

/**
 * 读客户全部 token 的额度 / 到期元数据(2026-10-22,/keys 额度与到期功能)。
 *
 * 数据源只有 new-api(单一事实源,portal 不落库):一次 act-as 列表调用拿回
 * `remain_quota / unlimited_quota / expired_time / used_quota / accessed_time`。
 * 2026-11-11 起 /keys 的「累计用量 · 最近调用」也取这里(token 行自带累计值),
 * 不再每 key 调一次 `/api/log/`(那条会在 2.8 亿行 logs 上全表 count,见 token-usage.ts)。失败返回 null,页面降级显示
 * "暂不可用",不影响 key 列表本身。portal 每用户最多 10 把 key,一页 100 够用。
 */
export interface TokenMeta {
    unlimited_quota: boolean;
    remain_quota: number;
    /** unix 秒,-1 = 永不过期。 */
    expired_time: number;
    used_quota: number;
    /** unix 秒,new-api 每次用这把 key 时更新;0 = 从未使用。 */
    accessed_time: number;
}

export async function getTokenMetaForCustomer(customerAuth: {
    accessToken: string;
    userId: number;
}): Promise<Map<number, TokenMeta> | null> {
    try {
        const { items } = await listTokensForCustomer(customerAuth, 1, 100);
        return new Map(
            items.map((t) => [
                t.id,
                {
                    unlimited_quota: t.unlimited_quota,
                    remain_quota: t.remain_quota,
                    expired_time: t.expired_time,
                    used_quota: t.used_quota,
                    accessed_time: t.accessed_time,
                },
            ]),
        );
    } catch (err) {
        console.warn(`[token-meta] listTokens failed for newapi user ${customerAuth.userId}:`, err);
        return null;
    }
}

export function expiredTimeToIso(expiredTime: number): string | null {
    return expiredTime > 0 ? new Date(expiredTime * 1000).toISOString() : null;
}

export function isoToExpiredTime(iso: string | null): number {
    return iso ? Math.floor(Date.parse(iso) / 1000) : -1;
}
