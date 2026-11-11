/**
 * /keys — API Keys list + create + revoke + reveal.
 *
 * Layout has already auth-gated; we just need the user.id to scope the
 * Prisma list query. Revoked keys (status != 'active') are filtered out
 * server-side so they never reach the UI.
 *
 * The full token_value is intentionally NOT shipped here — only an
 * obfuscated mask. The UI fetches the real sk- on demand via
 * /api/portal/keys/[id]/key, which performs its own auth + ownership check.
 */
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { expiredTimeToIso, getTokenMetaForCustomer } from '@/lib/newapi/token-meta';
import { quotaToCny } from '@/lib/newapi/quota-units';
import { formatTokenForDisplay } from '@/lib/newapi/token-format';
import { listEnabledChannelGroups, restrictGroupsForUser } from '@/lib/channel-group';
import { getEffectiveGroupRatios } from '@/lib/newapi/effective-group-ratios';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { keysMessages } from '@/lib/i18n/messages/keys';
import { KeysList, type KeyRow } from './keys-list';
import { KeysSnippetsPanel } from './keys-snippets-panel';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    return { title: pickMessages(keysMessages, await getLocale()).pageTitle };
}

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/keys', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

/** Mask a sk-xxxx-looking string as `sk-xxxx****yyyy`. Defensive: if the
 *  value is shorter than the prefix+suffix we'd reveal, fully mask it. */
function maskKey(value: string): string {
    if (value.length <= 12) return '*'.repeat(Math.max(8, value.length));
    return `${value.slice(0, 7)}****${value.slice(-4)}`;
}

export default async function KeysPage() {
    const [user, locale] = await Promise.all([getSessionUser(), getLocale()]);
    // Layout already gated; null branch only to satisfy TS narrowing.
    if (!user) return null;
    const t = pickMessages(keysMessages, locale);

    const tokens = await prisma.newApiToken.findMany({
        where: { user_id: user.id, status: 'active' },
        orderBy: { created_at: 'asc' },
        select: {
            id: true,
            key_alias: true,
            newapi_token_value: true,
            newapi_token_id: true,
            tier: true,
            created_at: true,
        },
    });

    // 每 key 的「累计用量 · 最近调用」直接取 new-api token 行自带的 used_quota /
    // accessed_time(与额度/到期同一次 act-as 列表调用,零额外上游请求)。
    // 2026-11-11 之前这里是每 key 一发 `GET /api/log/?user_id=&token_id=`:new-api
    // 两个参数都忽略 → 在 2.8 亿行 logs 上全表 `count(*)`,单次 3–37s,高峰十几个
    // 并发,是当天 new-api 卡顿的加重因素之一;且 page_size 被钳 100、取回的是全平台
    // 最新 100 行,post-filter 后数字基本是 0,本来就不准。
    const customerAuth =
        user.newapi_user_id != null && user.newapi_access_token
            ? { accessToken: user.newapi_access_token, userId: user.newapi_user_id }
            : null;
    const [tierGroupsRaw, effective, meta] = await Promise.all([
        listEnabledChannelGroups(user.tenant_id),
        // 2026-10-23:倍率以客户身份读(GroupGroupRatio 专属覆盖生效),失败回落全局
        getEffectiveGroupRatios(user),
        customerAuth ? getTokenMetaForCustomer(customerAuth) : Promise.resolve(null),
    ]);

    const rows: KeyRow[] = tokens.map((t) => {
        const m = meta?.get(t.newapi_token_id) ?? null;
        return {
            id: t.id,
            key_alias: t.key_alias,
            // W7 D4 PR-H Tier A: stored value is the bare 48-char id;
            // wire format requires `sk-` prefix. Apply at the display
            // boundary so the masked output reads `sk-XXXX****YYYY`
            // matching the customer's expectation when they paste into
            // their `Authorization: Bearer …` header.
            masked_key: maskKey(formatTokenForDisplay(t.newapi_token_value)),
            created_at: t.created_at.toISOString(),
            // BigInt → number is safe here: even a power user burning
            // 10^15 quota a year is well within Number.MAX_SAFE_INTEGER.
            // Pass null for failed lookups so UI can hide the row's
            // usage line gracefully.
            used_quota: m ? m.used_quota : null,
            // ¥ computed server-side; keys-list is a client island (server-only FX env).
            usedCny: m ? quotaToCny(m.used_quota) : null,
            last_used_at: m && m.accessed_time > 0 ? new Date(m.accessed_time * 1000).toISOString() : null,
            tier: t.tier,
            meta_available: m != null,
            quota_unlimited: m ? m.unlimited_quota : null,
            remainCny: m && !m.unlimited_quota ? quotaToCny(m.remain_quota) : null,
            expires_at: m ? expiredTimeToIso(m.expired_time) : null,
        };
    });

    // P3: enabled 档次(低价号池 / 官方稳定)供建 key 时单选。数据驱动 —
    // 客户 tenant 下 enabled 的 ChannelGroup,再按 per-customer 白名单收窄
    // (allowed_tier_keys 非空 → 只显示这些档;空 → 全部)。
    // 倍率与 new-api 自家分组下拉的「Nx 倍率」徽章同源(GroupRatio,60s 缓存);
    // new-api 不可达时降级为 null(下拉不显示徽章,不阻塞建 key)。
    // 两者的 fetch 已并进上面的 Promise.all,这里只做纯内存的收窄/拼装。
    const tierGroups = restrictGroupsForUser(tierGroupsRaw, user.allowed_tier_keys);
    const tiers = tierGroups.map((g) => ({
        key: g.key,
        display_name: g.display_name,
        description: g.description,
        is_default: g.is_default,
        newapi_group: g.newapi_group,
        ratio: effective.ratios[g.newapi_group] ?? null,
        listRatio: effective.listRatios[g.newapi_group] ?? null,
        special: effective.special.has(g.newapi_group),
    }));

    return (
        <section>
            <h1 className="m-0 mb-2 text-2xl font-semibold text-navy">{t.heading}</h1>
            <p className="m-0 mb-6 text-sm text-muted-ink">{t.subtitle}</p>
            <KeysList initialRows={rows} tiers={tiers} />
            {/* W7 D4 PR-R Item C — unified 调用示例 panel below the
             *  keys table replaces the per-row KeyHowtoPanel that PR-G
             *  used to stitch into each row. Static `YOUR_API_KEY`
             *  placeholder + curl / Python / Node tabs. */}
            <KeysSnippetsPanel />
        </section>
    );
}
