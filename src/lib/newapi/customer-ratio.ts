import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getOption, getPricingGroupRatiosForCustomer, getUser, putOption, updateUser } from './client';
import { getGroupRatios } from '@/lib/channel-group';
import { invalidateEffectiveRatioCache } from './effective-group-ratios';

/**
 * 客户专属倍率 —— 写路径(2026-10-25,PR-2)。
 *
 * new-api 机制:计费先查 `GroupGroupRatio[用户分组][令牌分组]`,命中用它,否则全局 GroupRatio。
 * portal 的做法:每个有专属价的客户独占一个用户分组 `vip-<newapi_username>`(一对一定制),
 * 矩阵里 `[该分组] = { 令牌分组: 倍率 }`;取消全部专属价时用户分组回 `default`。
 *
 * 三条硬规则(都是这个仓库踩过的坑):
 *  1. 矩阵两个存储键 `GroupGroupRatio` 与 `group_ratio_setting.group_group_ratio` 同写同值 ——
 *     它们灌进同一个内存 map,SyncOptions 周期性按库顺序重灌,值不同就"谁后读谁赢"(07-24 事故)。
 *  2. 改用户分组走 `PUT /api/user/`:new-api 只更新 username/display_name/group/remark 四列,
 *     quota 不受影响;但 display_name/remark 不传会被清空 → 先 GET 再带原值 PUT。
 *     分组变更会 bump auth_version 并吊销该用户 new-api 网页登录会话;PAT 不受影响(实测 + 源码)。
 *  3. 写完以客户身份读 `/api/pricing` 回读有效倍率做验证,结果连同 DB 留痕一起返回。
 */

export const USER_GROUP_DEFAULT = 'default';
export const MATRIX_KEYS = ['GroupGroupRatio', 'group_ratio_setting.group_group_ratio'] as const;

export type RatioMatrix = Record<string, Record<string, number>>;

export interface RatioOverrideInput {
    newapi_group: string;
    ratio: number;
    note?: string | null;
}

export interface CustomerRatioState {
    userId: string;
    newapiUserId: number | null;
    newapiUsername: string | null;
    /** portal 镜像的用户分组(null = 未管理过)。 */
    mirroredGroup: string | null;
    /** new-api 用户当前分组(读不到 → null)。 */
    liveGroup: string | null;
    /** portal 留痕。 */
    overrides: Array<{ newapi_group: string; ratio: number; note: string | null; updated_at: string }>;
    /** 矩阵里该用户当前分组名下的实际项。 */
    liveMatrix: Record<string, number>;
    /** 留痕 vs 矩阵 / 分组 不一致。 */
    drift: boolean;
    driftDetail: string[];
    /** 可选的令牌分组(启用的档次)+ 全局挂牌倍率。 */
    availableGroups: Array<{ newapi_group: string; display_name: string; listRatio: number | null }>;
}

export class CustomerRatioError extends Error {
    constructor(
        public readonly code:
            | 'user_not_found'
            | 'account_not_provisioned'
            | 'unknown_group'
            | 'invalid_ratio'
            | 'newapi_user_unreadable',
        message: string,
    ) {
        super(message);
        this.name = 'CustomerRatioError';
    }
}

export function vipGroupName(newapiUsername: string): string {
    // new-api users.group 是 varchar(64);username ≤ 20。
    return `vip-${newapiUsername}`.slice(0, 64);
}

function parseMatrix(raw: string | null): RatioMatrix {
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: RatioMatrix = {};
    for (const [ug, inner] of Object.entries(parsed as Record<string, unknown>)) {
        if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
        const row: Record<string, number> = {};
        for (const [g, r] of Object.entries(inner as Record<string, unknown>)) {
            if (typeof r === 'number' && Number.isFinite(r)) row[g] = r;
        }
        out[ug] = row;
    }
    return out;
}

export async function readMatrix(): Promise<RatioMatrix> {
    return parseMatrix(await getOption('GroupGroupRatio'));
}

/** 两键同写同值(规则 1)。 */
export async function writeMatrix(matrix: RatioMatrix): Promise<void> {
    const json = JSON.stringify(matrix);
    for (const key of MATRIX_KEYS) {
        await putOption(key, json);
    }
}

interface RawNewApiUser {
    id: number;
    username: string;
    display_name?: string;
    remark?: string;
    group?: string;
}

async function readNewApiUser(newapiUserId: number): Promise<RawNewApiUser | null> {
    try {
        const u = (await getUser(newapiUserId)) as unknown as RawNewApiUser;
        if (!u || typeof u.id !== 'number' || typeof u.username !== 'string') return null;
        return u;
    } catch (err) {
        console.warn(`[customer-ratio] getUser(${newapiUserId}) failed:`, err);
        return null;
    }
}

/** 规则 2:带原 display_name / remark 的部分 PUT,只改 group。 */
async function setNewApiUserGroup(u: RawNewApiUser, group: string): Promise<void> {
    if ((u.group ?? USER_GROUP_DEFAULT) === group) return;
    await updateUser({
        id: u.id,
        username: u.username,
        display_name: u.display_name ?? u.username,
        group,
        // remark 不在 NewApiUser zod 类型里,但 new-api 的 PUT 会把缺省 remark 清空 → 透传原值
        ...({ remark: u.remark ?? '' } as object),
    } as Parameters<typeof updateUser>[0]);
}

async function listAvailableGroups(): Promise<CustomerRatioState['availableGroups']> {
    const [groups, ratios] = await Promise.all([
        prisma.channelGroup.findMany({
            where: { enabled: true },
            select: { newapi_group: true, display_name: true },
            orderBy: [{ tier_level: 'asc' }, { key: 'asc' }],
        }),
        getGroupRatios(),
    ]);
    const seen = new Set<string>();
    const out: CustomerRatioState['availableGroups'] = [];
    for (const g of groups) {
        if (seen.has(g.newapi_group)) continue;
        seen.add(g.newapi_group);
        out.push({
            newapi_group: g.newapi_group,
            display_name: g.display_name,
            listRatio: ratios[g.newapi_group] ?? null,
        });
    }
    return out;
}

export async function getCustomerRatioState(userId: string): Promise<CustomerRatioState> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            newapi_user_id: true,
            newapi_username: true,
            newapi_user_group: true,
            ratio_overrides: { orderBy: { newapi_group: 'asc' } },
        },
    });
    if (!user) throw new CustomerRatioError('user_not_found', `portal user ${userId} not found`);

    const [matrix, live, availableGroups] = await Promise.all([
        readMatrix(),
        user.newapi_user_id != null ? readNewApiUser(user.newapi_user_id) : Promise.resolve(null),
        listAvailableGroups(),
    ]);
    const liveGroup = live?.group ?? null;
    const liveMatrix = liveGroup ? (matrix[liveGroup] ?? {}) : {};
    const overrides = user.ratio_overrides.map((o) => ({
        newapi_group: o.newapi_group,
        ratio: Number(o.ratio),
        note: o.note,
        updated_at: o.updated_at.toISOString(),
    }));

    const driftDetail: string[] = [];
    const expectedGroup = overrides.length > 0 ? vipGroupName(user.newapi_username ?? '') : USER_GROUP_DEFAULT;
    if (
        liveGroup !== null &&
        (overrides.length > 0 || user.newapi_user_group !== null) &&
        liveGroup !== expectedGroup
    ) {
        driftDetail.push(`new-api 用户分组是 "${liveGroup}",portal 期望 "${expectedGroup}"`);
    }
    for (const o of overrides) {
        const actual = liveMatrix[o.newapi_group];
        if (actual === undefined) driftDetail.push(`矩阵缺 ${o.newapi_group}(期望 ${o.ratio})`);
        else if (Math.abs(actual - o.ratio) > 1e-9)
            driftDetail.push(`矩阵 ${o.newapi_group}=${actual},期望 ${o.ratio}`);
    }
    for (const [g, r] of Object.entries(liveMatrix)) {
        if (!overrides.some((o) => o.newapi_group === g)) driftDetail.push(`矩阵多出 ${g}=${r}(portal 无记录)`);
    }

    return {
        userId: user.id,
        newapiUserId: user.newapi_user_id,
        newapiUsername: user.newapi_username,
        mirroredGroup: user.newapi_user_group,
        liveGroup,
        overrides,
        liveMatrix,
        drift: driftDetail.length > 0,
        driftDetail,
        availableGroups,
    };
}

export interface SetCustomerRatiosResult {
    userGroup: string;
    previousGroup: string | null;
    matrixRow: Record<string, number>;
    /** 以客户身份回读 /api/pricing 的有效倍率(仅覆盖的组);读不到 → null。 */
    verified: Record<string, number> | null;
    verifiedOk: boolean | null;
}

export async function setCustomerRatios(
    userId: string,
    inputs: RatioOverrideInput[],
    updatedBy: string | null,
): Promise<SetCustomerRatiosResult> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            newapi_user_id: true,
            newapi_username: true,
            newapi_access_token: true,
            newapi_user_group: true,
        },
    });
    if (!user) throw new CustomerRatioError('user_not_found', `portal user ${userId} not found`);
    if (user.newapi_user_id == null || !user.newapi_username) {
        throw new CustomerRatioError('account_not_provisioned', 'customer has no new-api account');
    }

    // 校验:令牌分组必须是全局 GroupRatio 里存在的组;倍率 (0, 100]
    const globalRatios = await getGroupRatios();
    const seen = new Set<string>();
    for (const i of inputs) {
        if (!(i.newapi_group in globalRatios)) {
            throw new CustomerRatioError('unknown_group', `unknown new-api group: ${i.newapi_group}`);
        }
        if (!Number.isFinite(i.ratio) || i.ratio <= 0 || i.ratio > 100) {
            throw new CustomerRatioError('invalid_ratio', `invalid ratio for ${i.newapi_group}: ${i.ratio}`);
        }
        if (seen.has(i.newapi_group))
            throw new CustomerRatioError('unknown_group', `duplicate group: ${i.newapi_group}`);
        seen.add(i.newapi_group);
    }

    const live = await readNewApiUser(user.newapi_user_id);
    if (!live) throw new CustomerRatioError('newapi_user_unreadable', 'cannot read new-api user');
    const previousGroup = live.group ?? USER_GROUP_DEFAULT;
    const targetGroup = inputs.length > 0 ? vipGroupName(user.newapi_username) : USER_GROUP_DEFAULT;
    const matrixRow: Record<string, number> = {};
    for (const i of inputs) matrixRow[i.newapi_group] = Math.round(i.ratio * 10000) / 10000;

    // 1) 矩阵(两键同写)。只收拾 vip-<username> 这类一对一分组的旧行;其它用户分组一律不碰。
    const matrix = await readMatrix();
    if (previousGroup !== targetGroup && previousGroup.startsWith('vip-')) delete matrix[previousGroup];
    if (inputs.length > 0) matrix[targetGroup] = matrixRow;
    else delete matrix[targetGroup];
    await writeMatrix(matrix);

    // 2) 用户分组
    await setNewApiUserGroup(live, targetGroup);

    // 3) portal 留痕(事务)
    await prisma.$transaction(async (tx) => {
        await tx.customerRatioOverride.deleteMany({ where: { user_id: user.id } });
        if (inputs.length > 0) {
            await tx.customerRatioOverride.createMany({
                data: inputs.map((i) => ({
                    user_id: user.id,
                    newapi_group: i.newapi_group,
                    ratio: new Prisma.Decimal(matrixRow[i.newapi_group]),
                    note: i.note?.trim() ? i.note.trim() : null,
                    updated_by: updatedBy,
                })),
            });
        }
        await tx.user.update({ where: { id: user.id }, data: { newapi_user_group: targetGroup } });
        await tx.analyticsEvent.create({
            data: {
                user_id: user.id,
                event_type: 'admin_special_ratio_changed',
                properties: {
                    user_group: targetGroup,
                    previous_group: previousGroup,
                    overrides: matrixRow,
                    changed_by: updatedBy,
                },
            },
        });
    });
    invalidateEffectiveRatioCache(user.newapi_user_id);

    // 4) 回读验证(规则 3)
    let verified: Record<string, number> | null = null;
    let verifiedOk: boolean | null = null;
    if (user.newapi_access_token) {
        try {
            const eff = await getPricingGroupRatiosForCustomer({
                accessToken: user.newapi_access_token,
                userId: user.newapi_user_id,
            });
            verified = {};
            verifiedOk = true;
            for (const [g, r] of Object.entries(matrixRow)) {
                verified[g] = eff[g];
                if (eff[g] === undefined || Math.abs(eff[g] - r) > 1e-9) verifiedOk = false;
            }
            if (inputs.length === 0) {
                // 取消后应回到全局挂牌
                for (const g of Object.keys(globalRatios)) {
                    if (eff[g] !== undefined && Math.abs(eff[g] - globalRatios[g]) > 1e-9) verifiedOk = false;
                }
            }
        } catch (err) {
            console.warn(`[customer-ratio] post-write verification failed for ${user.newapi_username}:`, err);
        }
    }
    return { userGroup: targetGroup, previousGroup, matrixRow, verified, verifiedOk };
}

export interface RatioDrift {
    userId: string;
    newapiUsername: string | null;
    detail: string[];
}

/** 对账:所有有留痕(或管理过)的客户,比对矩阵与用户分组。 */
export async function reconcileCustomerRatios(): Promise<{ checked: number; drifts: RatioDrift[] }> {
    const users = await prisma.user.findMany({
        where: { OR: [{ ratio_overrides: { some: {} } }, { newapi_user_group: { not: null } }] },
        select: { id: true },
        take: 500,
    });
    const drifts: RatioDrift[] = [];
    for (const u of users) {
        try {
            const st = await getCustomerRatioState(u.id);
            if (st.drift) drifts.push({ userId: u.id, newapiUsername: st.newapiUsername, detail: st.driftDetail });
        } catch (err) {
            drifts.push({ userId: u.id, newapiUsername: null, detail: [`对账读取失败: ${String(err)}`] });
        }
    }
    return { checked: users.length, drifts };
}
