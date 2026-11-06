import 'server-only';
import { prisma } from '@/lib/db';
import { getOption, putOption } from './client';

/**
 * 分组倍率三键对账(2026-11-06)。
 *
 * new-api 有三个 option 行都灌进同一个内存 groupRatioMap,且是整体替换,SyncOptions 每 60s 按库
 * 顺序重灌,谁后读谁赢。所以三键必须是完整相同的整份 map,否则"只在某一键里的组"会时有时无:
 *  - 建 token 下拉不列这个组(GetUserGroups 遍历 ratio map)
 *  - 已有 token 被 auth 层 403「分组 X 已被弃用」,这种 403 不进 logs 表
 * 后台 UI 新建分组只写 legacy `GroupRatio`,07-24 → 11-06 同类问题出过五次。
 * 机理与事故明细见 memory reference_group_ratio_dotted_key。
 *
 * 写错会让活跃组全部 403,所以只修一种情况:某键缺组、且同一组在各键的值完全相同 → 取并集三键同写。
 * 同组值不同 / 键缺失 / JSON 坏 / map 为空 都不写,只告警,由人判断哪份是真值。
 *
 * 已知副作用:在 UI 删除一个组也表现为"某键缺组",会被并集补回来(附 warning 告警)。
 * 组被误补回只是多一个可选组,组被误删是活跃 token 全 403,所以选前者;要真删请三键同删。
 */

const KEY_LEGACY = 'GroupRatio';
const KEY_NESTED = 'group_ratio_setting';
const KEY_FLAT = 'group_ratio_setting.group_ratio';

/** 写入顺序沿用 vps2 /root/align-group-ratio.py,线上验证过的顺序。 */
export const GROUP_RATIO_KEYS = [KEY_NESTED, KEY_FLAT, KEY_LEGACY] as const;
export type GroupRatioKey = (typeof GROUP_RATIO_KEYS)[number];

type RawOptions = Record<GroupRatioKey, string | null>;
type RatioMap = Record<string, number>;

/** pg_try_advisory_xact_lock 的键;全仓唯一,取值无含义。 */
const ADVISORY_LOCK_KEY = 7_203_114_501n;
/** 事务内要走 2 次读 + 3 次写 + 1 次回读的 HTTP,放宽 Prisma 默认 5s。 */
const WRITE_TX_TIMEOUT_MS = 60_000;

export interface GroupRatioConflict {
    group: string;
    values: Partial<Record<GroupRatioKey, number>>;
}

export type GroupRatioPlan =
    | { kind: 'invalid'; problems: string[] }
    | { kind: 'conflict'; conflicts: GroupRatioConflict[] }
    | { kind: 'in_sync'; groups: number }
    | {
          kind: 'repair';
          union: RatioMap;
          missing: Partial<Record<GroupRatioKey, string[]>>;
          /** 嵌套键除 group_ratio 外的字段,写回时原样保留。 */
          nestedRest: Record<string, unknown>;
      };

export type GroupRatioReconcileResult =
    | { status: 'in_sync'; groups: number }
    | { status: 'invalid'; problems: string[] }
    | { status: 'conflict'; conflicts: GroupRatioConflict[] }
    | { status: 'deferred'; reason: 'lock_held' | 'changed_since_read' }
    | { status: 'repaired'; groups: number; missing: Partial<Record<GroupRatioKey, string[]>> }
    | { status: 'write_failed'; written: GroupRatioKey[]; error: string }
    | { status: 'verify_failed'; detail: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** 解析单键的 ratio map;不可用时返问题描述(string)。 */
function parseRatioMap(key: GroupRatioKey, raw: string | null): { map: RatioMap; root: unknown } | string {
    if (raw == null) return `${key} 缺失`;
    let root: unknown;
    try {
        root = JSON.parse(raw);
    } catch {
        return `${key} 不是合法 JSON`;
    }
    const obj = key === KEY_NESTED && isPlainObject(root) ? root.group_ratio : root;
    if (!isPlainObject(obj)) return `${key} 不是 map`;
    const entries = Object.entries(obj);
    if (entries.length === 0) return `${key} 是空 map`; // 疑似误清,补全前要人看一眼
    const map: RatioMap = {};
    for (const [group, ratio] of entries) {
        if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0) {
            return `${key} 里 ${group} 的倍率不是非负数字`;
        }
        map[group] = ratio;
    }
    return { map, root };
}

/** 纯函数:由三键原文决定该做什么。invalid 优先于 conflict,解析不全时不判值。 */
export function planGroupRatioReconcile(raw: RawOptions): GroupRatioPlan {
    const maps = {} as Record<GroupRatioKey, RatioMap>;
    const problems: string[] = [];
    let nestedRest: Record<string, unknown> = {};
    for (const key of GROUP_RATIO_KEYS) {
        const parsed = parseRatioMap(key, raw[key]);
        if (typeof parsed === 'string') {
            problems.push(parsed);
            continue;
        }
        maps[key] = parsed.map;
        if (key === KEY_NESTED) {
            nestedRest = { ...(parsed.root as Record<string, unknown>) };
            delete nestedRest.group_ratio;
        }
    }
    if (problems.length > 0) return { kind: 'invalid', problems };

    const union: RatioMap = {};
    const conflicts: GroupRatioConflict[] = [];
    // legacy 排最前,让写回的 JSON 组序贴近运营在 UI 里看到的顺序
    for (const key of [KEY_LEGACY, KEY_NESTED, KEY_FLAT] as const) {
        for (const [group, ratio] of Object.entries(maps[key])) union[group] ??= ratio;
    }
    for (const [group, ratio] of Object.entries(union)) {
        const values: GroupRatioConflict['values'] = {};
        for (const key of GROUP_RATIO_KEYS) {
            if (group in maps[key]) values[key] = maps[key][group];
        }
        if (Object.values(values).some((v) => v !== ratio)) conflicts.push({ group, values });
    }
    if (conflicts.length > 0) return { kind: 'conflict', conflicts };

    const missing: Partial<Record<GroupRatioKey, string[]>> = {};
    for (const key of GROUP_RATIO_KEYS) {
        const absent = Object.keys(union).filter((g) => !(g in maps[key]));
        if (absent.length > 0) missing[key] = absent;
    }
    if (Object.keys(missing).length === 0) return { kind: 'in_sync', groups: Object.keys(union).length };
    return { kind: 'repair', union, missing, nestedRest };
}

async function readRawOptions(): Promise<RawOptions> {
    const [nested, flat, legacy] = await Promise.all(GROUP_RATIO_KEYS.map((k) => getOption(k)));
    return { [KEY_NESTED]: nested, [KEY_FLAT]: flat, [KEY_LEGACY]: legacy };
}

function sameRaw(a: RawOptions, b: RawOptions): boolean {
    return GROUP_RATIO_KEYS.every((k) => a[k] === b[k]);
}

async function applyRepair(
    seen: RawOptions,
    plan: Extract<GroupRatioPlan, { kind: 'repair' }>,
): Promise<GroupRatioReconcileResult> {
    // 写前再读:第一次读之后任何一键变过(运营刚保存)就放弃,下一轮拿新值重新判
    const fresh = await readRawOptions();
    if (!sameRaw(seen, fresh)) return { status: 'deferred', reason: 'changed_since_read' };

    const flatJson = JSON.stringify(plan.union);
    const values: Record<GroupRatioKey, string> = {
        [KEY_NESTED]: JSON.stringify({ ...plan.nestedRest, group_ratio: plan.union }),
        [KEY_FLAT]: flatJson,
        [KEY_LEGACY]: flatJson,
    };
    const written: GroupRatioKey[] = [];
    try {
        for (const key of GROUP_RATIO_KEYS) {
            await putOption(key, values[key]);
            written.push(key);
        }
    } catch (err) {
        // 已写的键是并集(超集),不会丢组;下一轮再补齐
        return { status: 'write_failed', written, error: err instanceof Error ? err.message : String(err) };
    }

    const after = planGroupRatioReconcile(await readRawOptions());
    const groups = Object.keys(plan.union).length;
    if (after.kind !== 'in_sync' || after.groups !== groups) {
        return { status: 'verify_failed', detail: `写后回读 ${JSON.stringify(after)},期望 ${groups} 组全一致` };
    }
    return { status: 'repaired', groups, missing: plan.missing };
}

/**
 * 一轮对账。调度器只在主站单实例跑(instrumentation 门),这里再加一把 pg advisory 锁:
 * 这条路径写错的代价比其它对账高,滚动部署新旧容器短暂并存时也不能两边同写。
 * 只读路径不拿锁,事务仅在确实要修时才开。
 */
export async function reconcileGroupRatioKeys(): Promise<GroupRatioReconcileResult> {
    const seen = await readRawOptions();
    const plan = planGroupRatioReconcile(seen);
    if (plan.kind === 'invalid') return { status: 'invalid', problems: plan.problems };
    if (plan.kind === 'conflict') return { status: 'conflict', conflicts: plan.conflicts };
    if (plan.kind === 'in_sync') return { status: 'in_sync', groups: plan.groups };

    return prisma.$transaction(
        async (tx) => {
            const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>`
                SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}::bigint) AS locked`;
            if (!row?.locked) return { status: 'deferred', reason: 'lock_held' } as const;
            return applyRepair(seen, plan);
        },
        { timeout: WRITE_TX_TIMEOUT_MS },
    );
}
