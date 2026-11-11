/**
 * W6 D4 — per-token usage cache.
 *
 * Mirrors the W4-2 D6 `quota-cache` 4-path pattern (hit / miss + write-back
 * / stale-fallback / hard-fail) but at the NewApiToken row level instead
 * of User. Per-key usage = new-api token 行自带的累计 `used_quota` /
 * `accessed_time`(act-as `GET /api/token/{id}`,按主键查,O(1))。
 *
 * 2026-11-11 改:此前是 `GET /api/log/?user_id=&token_id=&type=2&page_size=1000`
 * 求和。new-api 的 admin `/api/log/` 两个过滤参数都忽略,结果在 2.8 亿行 logs 上
 * 全表 `SELECT count(*) WHERE type=2`(单次 3–37s,高峰十几个并发,加重了当天
 * new-api 卡顿);而且 page_size 被钳 100、拿回的是全平台最新 100 行,post-filter
 * 之后数字基本是 0,本来就不准。别改回日志求和。
 *
 * 60s 行缓存:key-inspect 可能被客户监控脚本高频轮询,窗口内命中零上游请求。
 *
 * 不是批量的:每个 token 各有各的 `cached_used_at`,冷缓存时一次 /keys 渲染最坏
 * N 发 `GET /api/token/{id}`(主键查,便宜)。/keys 页现在直接用 token-meta 的列表
 * 结果,不走这里;这里只剩 key-inspect 端点单点调用。
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { getTokenForCustomer } from './client';

/** TTL for the row cache. Mirrors W4-2 D6 `quota-cache`. */
const TTL_MS = 60_000;

export interface TokenUsageSnapshot {
    /** new-api token 行的累计 `used_quota`(毛消费,raw quota units;展示用
     *  `quotaToCny`)。 */
    used_quota: bigint;
    /** new-api token 行的 `accessed_time`;0 → null(从未使用)。 */
    last_used_at: Date | null;
    /** Source of the numbers — drives UI "data may be stale" hints. */
    source: 'cache' | 'live' | 'fallback';
}

/**
 * Fetch a token's recent consumption snapshot, going through the row cache.
 *
 * @param prismaTokenId  NewApiToken.id (UUID, portal-side primary key)
 * @param newapiUserId       User.newapi_user_id(act-as 的 New-Api-User 头)
 * @param newapiAccessToken User.newapi_access_token(act-as 凭据;null → 只能走缓存)
 * @param newapiTokenId     NewApiToken.newapi_token_id
 *
 * @throws if both cache miss AND new-api fetch fails (hard-fail). The
 *         caller's `try/catch` should render an error state.
 */
export async function getTokenUsageWithCache(args: {
    prismaTokenId: string;
    newapiUserId: number;
    newapiAccessToken: string | null;
    newapiTokenId: number;
    now?: Date;
    /** 调用方【已经】读到的缓存两列(如 /keys 的列表查询)。给了就跳过这里
     *  的 findUnique —— 否则 N 个 token 会重复 N 次刚查过的单行读。
     *  不给则维持原行为(自己读),proxy 热路径等单点调用方不受影响。 */
    cachedRow?: { cached_used_quota: bigint; cached_used_at: Date | null };
}): Promise<TokenUsageSnapshot> {
    const now = args.now ?? new Date();

    const row =
        args.cachedRow ??
        (await prisma.newApiToken.findUnique({
            where: { id: args.prismaTokenId },
            select: {
                cached_used_quota: true,
                cached_used_at: true,
            },
        }));
    if (!row) {
        throw new Error(`token ${args.prismaTokenId} not found`);
    }

    const cacheAge = row.cached_used_at !== null ? now.getTime() - row.cached_used_at.getTime() : Infinity;
    const hasCache = row.cached_used_at !== null;
    const cacheFresh = hasCache && cacheAge < TTL_MS;

    if (cacheFresh) {
        return {
            used_quota: row.cached_used_quota,
            // The cache doesn't store last_used_at — rendering it from the
            // cache row would require a third column. For now, we surface
            // `cached_used_at` as a coarse proxy ("we saw activity around
            // here") which is honest for a 60s-fresh cache.
            last_used_at: row.cached_used_at,
            source: 'cache',
        };
    }

    // Miss / stale — fetch live. Try, fall back to stale on failure.
    try {
        const live = await fetchLiveUsage(args.newapiUserId, args.newapiAccessToken, args.newapiTokenId);
        // Write back; failures here aren't fatal (we still return live).
        await prisma.newApiToken
            .update({
                where: { id: args.prismaTokenId },
                data: {
                    cached_used_quota: live.used_quota,
                    cached_used_at: now,
                },
            })
            .catch((err) => {
                console.warn(`[token-usage] failed to write-back cache for token ${args.prismaTokenId}:`, err);
            });
        return { ...live, source: 'live' };
    } catch (err) {
        if (hasCache) {
            console.warn(
                `[token-usage] new-api unreachable, returning stale cache for token ${args.prismaTokenId} (age=${Math.round(cacheAge / 1000)}s):`,
                err,
            );
            return {
                used_quota: row.cached_used_quota,
                last_used_at: row.cached_used_at,
                source: 'fallback',
            };
        }
        throw new Error(
            `token usage fetch failed for ${args.prismaTokenId}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

/** Live new-api fetch — extracted so tests can target it independently
 *  of the cache pre/post logic. */
async function fetchLiveUsage(
    newapiUserId: number,
    newapiAccessToken: string | null,
    newapiTokenId: number,
): Promise<{ used_quota: bigint; last_used_at: Date | null }> {
    if (!newapiAccessToken) {
        throw new Error(`newapi user ${newapiUserId} has no access token`);
    }
    const raw = await getTokenForCustomer({ accessToken: newapiAccessToken, userId: newapiUserId }, newapiTokenId);
    const usedQuota = raw.used_quota;
    const accessedTime = raw.accessed_time;
    if (typeof usedQuota !== 'number' || typeof accessedTime !== 'number') {
        throw new Error(`new-api token ${newapiTokenId} missing used_quota/accessed_time`);
    }
    return {
        used_quota: BigInt(Math.trunc(usedQuota)),
        last_used_at: accessedTime > 0 ? new Date(accessedTime * 1000) : null,
    };
}
