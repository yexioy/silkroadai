import 'server-only';
import { prisma } from '@/lib/db';
import { getOption, putOption } from './client';

/**
 * 分组倍率三键同步 —— 以后台 UI 为准(2026-11-25,取代 11-06 未上线的「并集对账」方案)。
 *
 * new-api 有三个 option 行都灌进同一个内存 groupRatioMap,且是整体替换,SyncOptions 每 60s 按库
 * 顺序重灌。后台「分组倍率」页面只读写 legacy `GroupRatio`,另外两键只有脚本 / API 会写,三份一旦
 * 不一致,生效的是哪份不确定,表现为:
 *  - UI 改了倍率不生效(11-25:UI 写 3,实际按另外两键里的 2 计费)
 *  - UI 删掉的组还能用,之后又"刷"回来
 *  - 只在某一键里的组时有时无,已有 token 被 auth 层 403「分组 X 已被弃用」(不进 logs 表)
 * 07-24 起同类事故六次,明细见 memory reference_group_ratio_dotted_key。
 *
 * 规则:`GroupRatio` 是唯一真值,每分钟把它整份复制到 `group_ratio_setting` 与
 * `group_ratio_setting.group_ratio`。本模块从不写 `GroupRatio`。portal 自己读组倍率也只读
 * `GroupRatio`(channel-group / pricing-sync / chat model-groups),口径一致。
 *
 * ⚠️ 由此带来的约束:脚本 / API 建组、改倍率必须写 `GroupRatio`(或三键同写),只写另外两键的
 * 改动会在一分钟内被本同步抹掉。
 *
 * 两道保险:
 *  - 真值不可用(缺失 / JSON 坏 / 空 map / 非法倍率)→ 不写,只告警。
 *  - 一轮要从镜像键里删掉的组超过 MAX_REMOVALS_PER_PASS → 这些删除先不执行(新增与改值照常同步),
 *    error 告警等人确认。防的是 UI 用旧页面保存把一批组冲掉:删错的代价是这些组的 token 全部 403。
 */

const KEY_LEGACY = 'GroupRatio';
const KEY_NESTED = 'group_ratio_setting';
const KEY_FLAT = 'group_ratio_setting.group_ratio';

/** 被同步的两个镜像键;写入顺序沿用线上手工对齐验证过的顺序(先嵌套后平铺)。 */
export const MIRROR_KEYS = [KEY_NESTED, KEY_FLAT] as const;
export type MirrorKey = (typeof MIRROR_KEYS)[number];
const ALL_KEYS = [KEY_LEGACY, ...MIRROR_KEYS] as const;
type AnyKey = (typeof ALL_KEYS)[number];

/** 单轮最多自动执行几个组的删除;超过则整批删除挂起等人确认。 */
export const MAX_REMOVALS_PER_PASS = 3;

type RawOptions = Record<AnyKey, string | null>;
type RatioMap = Record<string, number>;

/** pg_try_advisory_xact_lock 的键;全仓唯一,取值无含义。 */
const ADVISORY_LOCK_KEY = 7_203_114_501n;
/** 事务内要走读 + 2 次写 + 回读的 HTTP,放宽 Prisma 默认 5s。 */
const WRITE_TX_TIMEOUT_MS = 60_000;

export interface GroupRatioChange {
    group: string;
    from: number;
    to: number;
}

export interface GroupRatioDiff {
    /** 真值里有、镜像键里缺的组 → 补上。 */
    added: string[];
    /** 镜像键里有、真值里没有的组 → 删掉(UI 里删了组)。 */
    removed: string[];
    /** 两边都有但值不同 → 改成真值。 */
    changed: GroupRatioChange[];
}

export type GroupRatioPlan =
    | { kind: 'invalid'; problems: string[] }
    | { kind: 'in_sync'; groups: number }
    | {
          kind: 'sync';
          /** 要写进两个镜像键的 map。 */
          target: RatioMap;
          diff: GroupRatioDiff;
          /** 超过单轮上限、本轮没有执行的删除(这些组仍留在 target 里)。 */
          heldRemovals: string[];
          /** 嵌套键除 group_ratio 外的字段,写回时原样保留。 */
          nestedRest: Record<string, unknown>;
      };

export type GroupRatioReconcileResult =
    | { status: 'in_sync'; groups: number }
    | { status: 'invalid'; problems: string[] }
    | { status: 'deferred'; reason: 'lock_held' | 'changed_since_read' }
    | { status: 'synced'; groups: number; diff: GroupRatioDiff; heldRemovals: string[] }
    | { status: 'removals_held'; heldRemovals: string[] }
    | { status: 'write_failed'; written: MirrorKey[]; error: string }
    | { status: 'verify_failed'; detail: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** 解析真值键;不可用时返问题描述(string)。 */
function parseTruth(raw: string | null): RatioMap | string {
    if (raw == null) return `${KEY_LEGACY} 缺失`;
    let root: unknown;
    try {
        root = JSON.parse(raw);
    } catch {
        return `${KEY_LEGACY} 不是合法 JSON`;
    }
    if (!isPlainObject(root)) return `${KEY_LEGACY} 不是 map`;
    const entries = Object.entries(root);
    if (entries.length === 0) return `${KEY_LEGACY} 是空 map`; // 疑似误清,照抄会让全部组 403
    const map: RatioMap = {};
    for (const [group, ratio] of entries) {
        if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0) {
            return `${KEY_LEGACY} 里 ${group} 的倍率不是非负数字`;
        }
        map[group] = ratio;
    }
    return map;
}

/**
 * 解析镜像键。镜像键坏了(缺失 / JSON 坏 / 形状不对)不算错误 —— 反正要被真值覆盖,
 * 按空 map 处理即可;只把还能认出来的数字项拿来算 diff。
 */
function parseMirror(key: MirrorKey, raw: string | null): { map: RatioMap; rest: Record<string, unknown> } {
    let root: unknown = null;
    if (raw != null) {
        try {
            root = JSON.parse(raw);
        } catch {
            root = null;
        }
    }
    let obj: unknown = root;
    let rest: Record<string, unknown> = {};
    if (key === KEY_NESTED) {
        if (isPlainObject(root)) {
            rest = { ...root };
            delete rest.group_ratio;
            obj = root.group_ratio;
        } else {
            obj = null;
        }
    }
    const map: RatioMap = {};
    if (isPlainObject(obj)) {
        for (const [group, ratio] of Object.entries(obj)) {
            if (typeof ratio === 'number' && Number.isFinite(ratio)) map[group] = ratio;
        }
    }
    return { map, rest };
}

function sameMap(a: RatioMap, b: RatioMap): boolean {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && a[k] === b[k]);
}

/** 纯函数:由三键原文决定该做什么。 */
export function planGroupRatioReconcile(raw: RawOptions): GroupRatioPlan {
    const truth = parseTruth(raw[KEY_LEGACY]);
    if (typeof truth === 'string') return { kind: 'invalid', problems: [truth] };

    const nested = parseMirror(KEY_NESTED, raw[KEY_NESTED]);
    const flat = parseMirror(KEY_FLAT, raw[KEY_FLAT]);
    const mirrors = [nested.map, flat.map];

    // 镜像键里出现过、真值里没有的组 = 待删除
    const removed = [...new Set(mirrors.flatMap((m) => Object.keys(m)))].filter((g) => !(g in truth));
    const heldRemovals = removed.length > MAX_REMOVALS_PER_PASS ? removed : [];

    // 挂起的删除:沿用镜像键里的现值(平铺键优先),让这些组暂时照旧可用
    const target: RatioMap = { ...truth };
    for (const g of heldRemovals) target[g] = flat.map[g] ?? nested.map[g];

    if (mirrors.every((m) => sameMap(m, target))) {
        // 只剩挂起的删除没处理时不算 in_sync,由调用方每轮告警
        if (heldRemovals.length > 0) {
            return {
                kind: 'sync',
                target,
                diff: { added: [], removed: [], changed: [] },
                heldRemovals,
                nestedRest: nested.rest,
            };
        }
        return { kind: 'in_sync', groups: Object.keys(truth).length };
    }

    const added = Object.keys(truth).filter((g) => mirrors.some((m) => !(g in m)));
    const changed: GroupRatioChange[] = [];
    for (const [group, to] of Object.entries(truth)) {
        const from = mirrors.map((m) => m[group]).find((v) => v !== undefined && v !== to);
        if (from !== undefined) changed.push({ group, from, to });
    }
    return {
        kind: 'sync',
        target,
        diff: { added, removed: heldRemovals.length > 0 ? [] : removed, changed },
        heldRemovals,
        nestedRest: nested.rest,
    };
}

async function readRawOptions(): Promise<RawOptions> {
    const [legacy, nested, flat] = await Promise.all(ALL_KEYS.map((k) => getOption(k)));
    return { [KEY_LEGACY]: legacy, [KEY_NESTED]: nested, [KEY_FLAT]: flat };
}

function sameRaw(a: RawOptions, b: RawOptions): boolean {
    return ALL_KEYS.every((k) => a[k] === b[k]);
}

function hasWork(diff: GroupRatioDiff): boolean {
    return diff.added.length + diff.removed.length + diff.changed.length > 0;
}

async function applySync(
    seen: RawOptions,
    plan: Extract<GroupRatioPlan, { kind: 'sync' }>,
): Promise<GroupRatioReconcileResult> {
    // 写前再读:第一次读之后任何一键变过(运营刚保存)就放弃,下一轮拿新值重新判
    const fresh = await readRawOptions();
    if (!sameRaw(seen, fresh)) return { status: 'deferred', reason: 'changed_since_read' };

    const values: Record<MirrorKey, string> = {
        [KEY_NESTED]: JSON.stringify({ ...plan.nestedRest, group_ratio: plan.target }),
        [KEY_FLAT]: JSON.stringify(plan.target),
    };
    const written: MirrorKey[] = [];
    try {
        for (const key of MIRROR_KEYS) {
            await putOption(key, values[key]);
            written.push(key);
        }
    } catch (err) {
        return { status: 'write_failed', written, error: err instanceof Error ? err.message : String(err) };
    }

    const after = await readRawOptions();
    const ok = MIRROR_KEYS.every((k) => sameMap(parseMirror(k, after[k]).map, plan.target));
    if (!ok) return { status: 'verify_failed', detail: '写后回读,镜像键与目标不一致' };
    return {
        status: 'synced',
        groups: Object.keys(plan.target).length,
        diff: plan.diff,
        heldRemovals: plan.heldRemovals,
    };
}

/**
 * 一轮同步。调度器只在主站单实例跑(instrumentation 门),这里再加一把 pg advisory 锁:
 * 滚动部署新旧容器短暂并存时也不能两边同写。只读路径不拿锁,事务仅在确实要写时才开。
 */
export async function reconcileGroupRatioKeys(): Promise<GroupRatioReconcileResult> {
    const seen = await readRawOptions();
    const plan = planGroupRatioReconcile(seen);
    if (plan.kind === 'invalid') return { status: 'invalid', problems: plan.problems };
    if (plan.kind === 'in_sync') return { status: 'in_sync', groups: plan.groups };
    // 新增 / 改值都已同步,只剩挂起的删除:不写,只报
    if (!hasWork(plan.diff)) return { status: 'removals_held', heldRemovals: plan.heldRemovals };

    return prisma.$transaction(
        async (tx) => {
            const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>`
                SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}::bigint) AS locked`;
            if (!row?.locked) return { status: 'deferred', reason: 'lock_held' } as const;
            return applySync(seen, plan);
        },
        { timeout: WRITE_TX_TIMEOUT_MS },
    );
}
