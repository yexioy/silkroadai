import 'server-only';
import { prisma } from '@/lib/db';
import { getOption, putOption } from './client';

/**
 * 客户专属倍率矩阵两键同步 —— 以后台 UI 为准(2026-11-25,与 group-ratio-reconcile.ts 同一套做法)。
 *
 * 矩阵 `{用户分组: {令牌分组: 倍率}}` 存在两个 option 键里:`GroupGroupRatio`(new-api 后台
 * 「分组倍率」页面读写的那份)与 `group_ratio_setting.group_group_ratio`。两键灌进同一个内存 map,
 * 整体替换,SyncOptions 每 60s 按库顺序重灌 → 两键不一致时生效哪份不确定。
 * 10-26 事故:后台页面保存只写了 `GroupGroupRatio`,两键分叉,客户按错的倍率计费。
 *
 * 规则:`GroupGroupRatio` 是唯一真值,每分钟整份复制到另一键;本模块从不写 `GroupGroupRatio`。
 * portal 自己(customer-ratio.ts)读矩阵也只读这一键、写时两键同写,口径一致。
 *
 * 两道保险:
 *  - 真值不可用(缺失 / JSON 坏 / 不是 map / 行不是 map / 倍率非法)→ 不写,只告警。
 *  - 一轮要删掉的用户分组行超过 MAX_ROW_REMOVALS_PER_PASS → 这些删除先不执行(新增与改值照常),
 *    error 告警等人确认。防的是后台用旧页面保存把矩阵冲成 `{}`(10-26 就是这样):
 *    删错的代价是一批专属价客户被按挂牌价多收。
 *
 * 不管 portal 留痕表:`customer_ratio_overrides` 与矩阵的差异仍由每小时的 ratio-reconcile 报漂移。
 */

const KEY_TRUTH = 'GroupGroupRatio';
const KEY_MIRROR = 'group_ratio_setting.group_group_ratio';
const KEYS = [KEY_TRUTH, KEY_MIRROR] as const;
type Key = (typeof KEYS)[number];

/** 单轮最多自动执行几行(用户分组)的删除;超过则整批删除挂起等人确认。 */
export const MAX_ROW_REMOVALS_PER_PASS = 3;

type RawOptions = Record<Key, string | null>;
type Row = Record<string, number>;
type Matrix = Record<string, Row>;

/** pg_try_advisory_xact_lock 的键;全仓唯一,取值无含义(分组倍率同步用的是 …501)。 */
const ADVISORY_LOCK_KEY = 7_203_114_502n;
const WRITE_TX_TIMEOUT_MS = 60_000;

export interface MatrixDiff {
    /** 真值里有、镜像键里缺的用户分组行。 */
    added: string[];
    /** 镜像键里有、真值里没有的用户分组行 → 删掉。 */
    removed: string[];
    /** 两边都有但行内容不同 → 改成真值。 */
    changed: string[];
}

export type MatrixSyncPlan =
    | { kind: 'invalid'; problems: string[] }
    | { kind: 'in_sync'; rows: number }
    | { kind: 'sync'; target: Matrix; diff: MatrixDiff; heldRemovals: string[] };

export type MatrixSyncResult =
    | { status: 'in_sync'; rows: number }
    | { status: 'invalid'; problems: string[] }
    | { status: 'deferred'; reason: 'lock_held' | 'changed_since_read' }
    | { status: 'synced'; rows: number; diff: MatrixDiff; heldRemovals: string[] }
    | { status: 'removals_held'; heldRemovals: string[] }
    | { status: 'write_failed'; error: string }
    | { status: 'verify_failed'; detail: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** 解析真值键;不可用时返问题描述(string)。空矩阵 `{}` 合法(没有任何专属价)。 */
function parseTruth(raw: string | null): Matrix | string {
    if (raw == null) return `${KEY_TRUTH} 缺失`;
    let root: unknown;
    try {
        root = JSON.parse(raw);
    } catch {
        return `${KEY_TRUTH} 不是合法 JSON`;
    }
    if (!isPlainObject(root)) return `${KEY_TRUTH} 不是 map`;
    const out: Matrix = {};
    for (const [userGroup, inner] of Object.entries(root)) {
        if (!isPlainObject(inner)) return `${KEY_TRUTH} 里 ${userGroup} 这一行不是 map`;
        const row: Row = {};
        for (const [group, ratio] of Object.entries(inner)) {
            if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0) {
                return `${KEY_TRUTH} 里 ${userGroup} → ${group} 的倍率不是非负数字`;
            }
            row[group] = ratio;
        }
        out[userGroup] = row;
    }
    return out;
}

/** 镜像键坏了不算错误 —— 反正要被真值覆盖;只把还能认出来的行拿来算 diff。 */
function parseMirror(raw: string | null): Matrix {
    let root: unknown = null;
    if (raw != null) {
        try {
            root = JSON.parse(raw);
        } catch {
            root = null;
        }
    }
    const out: Matrix = {};
    if (!isPlainObject(root)) return out;
    for (const [userGroup, inner] of Object.entries(root)) {
        if (!isPlainObject(inner)) continue;
        const row: Row = {};
        for (const [group, ratio] of Object.entries(inner)) {
            if (typeof ratio === 'number' && Number.isFinite(ratio)) row[group] = ratio;
        }
        out[userGroup] = row;
    }
    return out;
}

function sameRow(a: Row, b: Row): boolean {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && a[k] === b[k]);
}

function sameMatrix(a: Matrix, b: Matrix): boolean {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameRow(a[k], b[k]));
}

/** 纯函数:由两键原文决定该做什么。 */
export function planMatrixSync(raw: RawOptions): MatrixSyncPlan {
    const truth = parseTruth(raw[KEY_TRUTH]);
    if (typeof truth === 'string') return { kind: 'invalid', problems: [truth] };
    const mirror = parseMirror(raw[KEY_MIRROR]);

    const removed = Object.keys(mirror).filter((ug) => !(ug in truth));
    const heldRemovals = removed.length > MAX_ROW_REMOVALS_PER_PASS ? removed : [];

    // 挂起的删除:沿用镜像键里的现行,让这些客户暂时照旧按专属价计费
    const target: Matrix = { ...truth };
    for (const ug of heldRemovals) target[ug] = mirror[ug];

    const added = Object.keys(truth).filter((ug) => !(ug in mirror));
    const changed = Object.keys(truth).filter((ug) => ug in mirror && !sameRow(truth[ug], mirror[ug]));
    const diff: MatrixDiff = { added, removed: heldRemovals.length > 0 ? [] : removed, changed };

    // 镜像键原文不是合法 map 时,即使真值为空也要把它写成 `{}`
    if (sameMatrix(mirror, target) && isJson(raw[KEY_MIRROR])) {
        if (heldRemovals.length > 0) return { kind: 'sync', target, diff, heldRemovals };
        return { kind: 'in_sync', rows: Object.keys(truth).length };
    }
    return { kind: 'sync', target, diff, heldRemovals };
}

function isJson(raw: string | null): boolean {
    if (raw == null) return false;
    try {
        return isPlainObject(JSON.parse(raw));
    } catch {
        return false;
    }
}

async function readRawOptions(): Promise<RawOptions> {
    const [truth, mirror] = await Promise.all(KEYS.map((k) => getOption(k)));
    return { [KEY_TRUTH]: truth, [KEY_MIRROR]: mirror };
}

function needsWrite(seen: RawOptions, plan: Extract<MatrixSyncPlan, { kind: 'sync' }>): boolean {
    return !isJson(seen[KEY_MIRROR]) || !sameMatrix(parseMirror(seen[KEY_MIRROR]), plan.target);
}

async function applySync(seen: RawOptions, plan: Extract<MatrixSyncPlan, { kind: 'sync' }>): Promise<MatrixSyncResult> {
    // 写前再读:第一次读之后任何一键变过(运营或 portal 面板刚保存)就放弃,下一轮拿新值重新判
    const fresh = await readRawOptions();
    if (KEYS.some((k) => seen[k] !== fresh[k])) return { status: 'deferred', reason: 'changed_since_read' };

    try {
        await putOption(KEY_MIRROR, JSON.stringify(plan.target));
    } catch (err) {
        return { status: 'write_failed', error: err instanceof Error ? err.message : String(err) };
    }

    const after = await readRawOptions();
    if (!sameMatrix(parseMirror(after[KEY_MIRROR]), plan.target)) {
        return { status: 'verify_failed', detail: '写后回读,镜像键与目标不一致' };
    }
    return {
        status: 'synced',
        rows: Object.keys(plan.target).length,
        diff: plan.diff,
        heldRemovals: plan.heldRemovals,
    };
}

/**
 * 一轮同步。调度器只在主站单实例跑(instrumentation 门),这里再加一把 pg advisory 锁,
 * 滚动部署新旧容器短暂并存时也不会两边同写。只读路径不拿锁。
 */
export async function syncCustomerRatioMatrix(): Promise<MatrixSyncResult> {
    const seen = await readRawOptions();
    const plan = planMatrixSync(seen);
    if (plan.kind === 'invalid') return { status: 'invalid', problems: plan.problems };
    if (plan.kind === 'in_sync') return { status: 'in_sync', rows: plan.rows };
    // 其余都已同步,只剩挂起的删除:不写,只报
    if (!needsWrite(seen, plan)) return { status: 'removals_held', heldRemovals: plan.heldRemovals };

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
