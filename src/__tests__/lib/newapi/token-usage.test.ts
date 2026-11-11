/**
 * getTokenUsageWithCache unit tests.
 *
 * 4 paths(hit / miss + write-back / stale-fallback / hard-fail)沿用 W6 D4。
 * 2026-11-11:live 数据源从「/api/log/ 求和」改为 new-api token 行自带的
 * used_quota / accessed_time(act-as GET /api/token/{id})—— 旧路径在 2.8 亿行
 * logs 上全表 count。这里守护「绝不再调 queryLogs」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTokenFindUnique = vi.fn();
const mockTokenUpdate = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        newApiToken: {
            findUnique: (...args: unknown[]) => mockTokenFindUnique(...args),
            update: (...args: unknown[]) => mockTokenUpdate(...args),
        },
    },
}));

const mockGetToken = vi.fn();
const mockQueryLogs = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    getTokenForCustomer: (...args: unknown[]) => mockGetToken(...args),
    queryLogs: (...args: unknown[]) => mockQueryLogs(...args),
}));

import { getTokenUsageWithCache } from '@/lib/newapi/token-usage';

const PRISMA_TOKEN_ID = 'tok-uuid-1111';
const NEWAPI_USER_ID = 7;
const ACCESS_TOKEN = 'at-xyz';
const NEWAPI_TOKEN_ID = 42;
const TTL_MS = 60_000;
const NOW = new Date('2026-05-05T12:00:00Z');

const base = {
    prismaTokenId: PRISMA_TOKEN_ID,
    newapiUserId: NEWAPI_USER_ID,
    newapiAccessToken: ACCESS_TOKEN as string | null,
    newapiTokenId: NEWAPI_TOKEN_ID,
    now: NOW,
};

beforeEach(() => {
    vi.clearAllMocks();
    mockTokenUpdate.mockResolvedValue({});
});

describe('getTokenUsageWithCache — happy paths', () => {
    it('cache HIT (fresh < 60s) → cached value, no upstream call', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(1234),
            cached_used_at: new Date(NOW.getTime() - 30_000),
        });

        const r = await getTokenUsageWithCache(base);

        expect(r.source).toBe('cache');
        expect(r.used_quota).toBe(BigInt(1234));
        expect(mockGetToken).not.toHaveBeenCalled();
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('cache MISS → reads token row (act-as, by id) + writes back + source=live', async () => {
        mockTokenFindUnique.mockResolvedValue({ cached_used_quota: BigInt(0), cached_used_at: null });
        mockGetToken.mockResolvedValue({ id: NEWAPI_TOKEN_ID, used_quota: 350, accessed_time: 1715100000 });

        const r = await getTokenUsageWithCache(base);

        expect(r.source).toBe('live');
        expect(r.used_quota).toBe(BigInt(350));
        expect(r.last_used_at?.getTime()).toBe(1715100000 * 1000);
        expect(mockGetToken).toHaveBeenCalledWith(
            { accessToken: ACCESS_TOKEN, userId: NEWAPI_USER_ID },
            NEWAPI_TOKEN_ID,
        );
        expect(mockTokenUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: PRISMA_TOKEN_ID },
                data: expect.objectContaining({ cached_used_quota: BigInt(350), cached_used_at: NOW }),
            }),
        );
    });

    it('never touches /api/log/ (full-table count regression guard)', async () => {
        mockTokenFindUnique.mockResolvedValue({ cached_used_quota: BigInt(0), cached_used_at: null });
        mockGetToken.mockResolvedValue({ used_quota: 1, accessed_time: 1 });

        await getTokenUsageWithCache(base);

        expect(mockQueryLogs).not.toHaveBeenCalled();
    });

    it('accessed_time=0 → last_used_at null (never used)', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(500),
            cached_used_at: new Date(NOW.getTime() - (TTL_MS + 5_000)),
        });
        mockGetToken.mockResolvedValue({ used_quota: 0, accessed_time: 0 });

        const r = await getTokenUsageWithCache(base);

        expect(r.source).toBe('live');
        expect(r.used_quota).toBe(BigInt(0));
        expect(r.last_used_at).toBeNull();
    });

    it('write-back failure does NOT propagate', async () => {
        mockTokenFindUnique.mockResolvedValue({ cached_used_quota: BigInt(0), cached_used_at: null });
        mockGetToken.mockResolvedValue({ used_quota: 50, accessed_time: 1715000000 });
        mockTokenUpdate.mockRejectedValue(new Error('DB write-back transient'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const r = await getTokenUsageWithCache(base);

        expect(r.source).toBe('live');
        expect(r.used_quota).toBe(BigInt(50));
        warnSpy.mockRestore();
    });
});

describe('getTokenUsageWithCache — failure modes', () => {
    it('new-api fail WITH stale cache → fallback', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(2000),
            cached_used_at: new Date(NOW.getTime() - 5 * 60_000),
        });
        mockGetToken.mockRejectedValue(new Error('ECONNREFUSED'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const r = await getTokenUsageWithCache(base);

        expect(r.source).toBe('fallback');
        expect(r.used_quota).toBe(BigInt(2000));
        expect(mockTokenUpdate).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('hard fail (no cache + new-api dead) → throws', async () => {
        mockTokenFindUnique.mockResolvedValue({ cached_used_quota: BigInt(0), cached_used_at: null });
        mockGetToken.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(getTokenUsageWithCache(base)).rejects.toThrow(/token usage fetch failed/);
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('no access token + no cache → throws without calling upstream', async () => {
        mockTokenFindUnique.mockResolvedValue({ cached_used_quota: BigInt(0), cached_used_at: null });

        await expect(getTokenUsageWithCache({ ...base, newapiAccessToken: null })).rejects.toThrow(
            /token usage fetch failed/,
        );
        expect(mockGetToken).not.toHaveBeenCalled();
    });

    it('malformed upstream row (missing used_quota) → treated as failure', async () => {
        mockTokenFindUnique.mockResolvedValue({ cached_used_quota: BigInt(0), cached_used_at: null });
        mockGetToken.mockResolvedValue({ id: NEWAPI_TOKEN_ID });

        await expect(getTokenUsageWithCache(base)).rejects.toThrow(/missing used_quota/);
    });

    it('throws when prisma row not found', async () => {
        mockTokenFindUnique.mockResolvedValue(null);

        await expect(getTokenUsageWithCache({ ...base, prismaTokenId: 'does-not-exist' })).rejects.toThrow(/not found/);
        expect(mockGetToken).not.toHaveBeenCalled();
    });
});

describe('getTokenUsageWithCache — cachedRow', () => {
    it('cachedRow fresh → no DB read, no upstream', async () => {
        const r = await getTokenUsageWithCache({
            ...base,
            cachedRow: { cached_used_quota: BigInt(555), cached_used_at: new Date(NOW.getTime() - 30_000) },
        });

        expect(r).toEqual({
            used_quota: BigInt(555),
            last_used_at: new Date(NOW.getTime() - 30_000),
            source: 'cache',
        });
        expect(mockTokenFindUnique).not.toHaveBeenCalled();
        expect(mockGetToken).not.toHaveBeenCalled();
    });

    it('cachedRow stale → no DB read, upstream + write-back', async () => {
        mockGetToken.mockResolvedValue({ used_quota: 90, accessed_time: 1767225600 });

        const r = await getTokenUsageWithCache({
            ...base,
            cachedRow: { cached_used_quota: BigInt(1), cached_used_at: new Date(NOW.getTime() - TTL_MS - 1) },
        });

        expect(r.source).toBe('live');
        expect(r.used_quota).toBe(BigInt(90));
        expect(mockTokenFindUnique).not.toHaveBeenCalled();
        expect(mockTokenUpdate).toHaveBeenCalled();
    });
});
