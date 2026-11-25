import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetOption = vi.fn();
const mockPutOption = vi.fn();
vi.mock('../client', () => ({
    getOption: (...a: unknown[]) => mockGetOption(...a),
    putOption: (...a: unknown[]) => mockPutOption(...a),
}));

const mockQueryRaw = vi.fn();
const mockTransaction = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: { $transaction: (...a: unknown[]) => mockTransaction(...a) },
}));

import { MAX_REMOVALS_PER_PASS, planGroupRatioReconcile, reconcileGroupRatioKeys } from '../group-ratio-reconcile';

const LEGACY = 'GroupRatio';
const NESTED = 'group_ratio_setting';
const FLAT = 'group_ratio_setting.group_ratio';

type Store = Record<string, string | null>;
let store: Store;

/** legacy = 后台 UI 写的真值;flat / nested = 被同步的镜像键。 */
function raw(legacy: unknown, flat: unknown, nested: unknown): Store {
    const enc = (v: unknown) => (typeof v === 'string' || v === null ? (v as string | null) : JSON.stringify(v));
    return { [LEGACY]: enc(legacy), [FLAT]: enc(flat), [NESTED]: enc(nested) };
}

const asRaw = (s: Store) => s as Parameters<typeof planGroupRatioReconcile>[0];
const mirrored = (m: Record<string, number>) => raw(m, m, { group_ratio: m });

beforeEach(() => {
    vi.clearAllMocks();
    store = {};
    mockGetOption.mockImplementation(async (k: string) => store[k] ?? null);
    mockPutOption.mockImplementation(async (k: string, v: string) => {
        store[k] = v;
    });
    mockQueryRaw.mockResolvedValue([{ locked: true }]);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: mockQueryRaw }));
});

describe('planGroupRatioReconcile', () => {
    it('三键相同 → in_sync(组序不同不算差异)', () => {
        const p = planGroupRatioReconcile(asRaw(raw({ a: 1, b: 2 }, { b: 2, a: 1 }, { group_ratio: { a: 1, b: 2 } })));
        expect(p).toEqual({ kind: 'in_sync', groups: 2 });
    });

    it('UI 改了倍率 → 镜像键跟着改(11-25:UI 写 3,另外两键还是 2)', () => {
        const p = planGroupRatioReconcile(asRaw(raw({ a: 3 }, { a: 2 }, { group_ratio: { a: 2 } })));
        expect(p).toMatchObject({
            kind: 'sync',
            target: { a: 3 },
            diff: { added: [], removed: [], changed: [{ group: 'a', from: 2, to: 3 }] },
            heldRemovals: [],
        });
    });

    it('UI 新建组 → 补进镜像键', () => {
        const p = planGroupRatioReconcile(asRaw(raw({ a: 1, ui: 3 }, { a: 1 }, { group_ratio: { a: 1 } })));
        expect(p).toMatchObject({ kind: 'sync', target: { a: 1, ui: 3 }, diff: { added: ['ui'], removed: [] } });
    });

    it('UI 删了组 → 从镜像键删掉,不再补回', () => {
        const p = planGroupRatioReconcile(asRaw(raw({ a: 1 }, { a: 1, gone: 2 }, { group_ratio: { a: 1, gone: 2 } })));
        expect(p).toMatchObject({
            kind: 'sync',
            target: { a: 1 },
            diff: { added: [], removed: ['gone'], changed: [] },
            heldRemovals: [],
        });
    });

    it('嵌套键的其它字段保留', () => {
        const p = planGroupRatioReconcile(asRaw(raw({ a: 2 }, { a: 1 }, { group_ratio: { a: 1 }, other: 'x' })));
        expect(p).toMatchObject({ kind: 'sync', nestedRest: { other: 'x' } });
    });

    it(`一轮删除超过 ${MAX_REMOVALS_PER_PASS} 个组 → 删除挂起,新增与改值照常`, () => {
        const extra = { g1: 1, g2: 1, g3: 1, g4: 1 };
        const p = planGroupRatioReconcile(
            asRaw(raw({ a: 3, ui: 1 }, { a: 2, ...extra }, { group_ratio: { a: 2, ...extra } })),
        );
        expect(p).toMatchObject({
            kind: 'sync',
            target: { a: 3, ui: 1, ...extra },
            diff: { added: ['ui'], removed: [], changed: [{ group: 'a', from: 2, to: 3 }] },
            heldRemovals: ['g1', 'g2', 'g3', 'g4'],
        });
    });

    it('恰好等于上限的删除 → 直接执行', () => {
        const extra = { g1: 1, g2: 1, g3: 1 };
        const p = planGroupRatioReconcile(
            asRaw(raw({ a: 1 }, { a: 1, ...extra }, { group_ratio: { a: 1, ...extra } })),
        );
        expect(p).toMatchObject({ kind: 'sync', target: { a: 1 }, heldRemovals: [] });
    });

    it.each([
        ['镜像键缺失', raw({ a: 1 }, null, { group_ratio: { a: 1 } })],
        ['镜像键 JSON 坏', raw({ a: 1 }, '{oops', { group_ratio: { a: 1 } })],
        ['镜像键不是 map', raw({ a: 1 }, [1], { group_ratio: { a: 1 } })],
        ['嵌套键无 group_ratio', raw({ a: 1 }, { a: 1 }, { other: 1 })],
    ])('%s → 用真值覆盖(sync)', (_name, r) => {
        expect(planGroupRatioReconcile(asRaw(r))).toMatchObject({ kind: 'sync', target: { a: 1 } });
    });

    it.each([
        ['缺失', raw(null, { a: 1 }, { group_ratio: { a: 1 } })],
        ['JSON 坏', raw('{oops', { a: 1 }, { group_ratio: { a: 1 } })],
        ['不是 map', raw([1], { a: 1 }, { group_ratio: { a: 1 } })],
        ['空 map', raw({}, { a: 1 }, { group_ratio: { a: 1 } })],
        ['倍率不是数字', raw({ a: '1' }, { a: 1 }, { group_ratio: { a: 1 } })],
        ['倍率为负', raw({ a: -1 }, { a: 1 }, { group_ratio: { a: 1 } })],
    ])('真值 GroupRatio %s → invalid,不动镜像键', (_name, r) => {
        expect(planGroupRatioReconcile(asRaw(r)).kind).toBe('invalid');
    });
});

describe('reconcileGroupRatioKeys', () => {
    it('in_sync → 不开事务、不写', async () => {
        store = mirrored({ a: 1 });
        await expect(reconcileGroupRatioKeys()).resolves.toEqual({ status: 'in_sync', groups: 1 });
        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('UI 改值 + 建组 + 删组 → 只写两个镜像键,从不写 GroupRatio', async () => {
        store = raw({ a: 3, ui: 1 }, { a: 2, gone: 5 }, { group_ratio: { a: 2, gone: 5 }, other: 'x' });
        const r = await reconcileGroupRatioKeys();
        expect(r).toEqual({
            status: 'synced',
            groups: 2,
            diff: { added: ['ui'], removed: ['gone'], changed: [{ group: 'a', from: 2, to: 3 }] },
            heldRemovals: [],
        });
        expect(mockPutOption.mock.calls.map((c) => c[0])).toEqual([NESTED, FLAT]);
        const truth = { a: 3, ui: 1 };
        expect(JSON.parse(store[LEGACY]!)).toEqual(truth);
        expect(JSON.parse(store[FLAT]!)).toEqual(truth);
        expect(JSON.parse(store[NESTED]!)).toEqual({ group_ratio: truth, other: 'x' });
        // 再跑一轮即一致
        mockPutOption.mockClear();
        await expect(reconcileGroupRatioKeys()).resolves.toEqual({ status: 'in_sync', groups: 2 });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('真值不可用 → 不写', async () => {
        store = raw({}, { a: 1 }, { group_ratio: { a: 1 } });
        await expect(reconcileGroupRatioKeys()).resolves.toMatchObject({ status: 'invalid' });
        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('批量删除挂起:其余改动先同步,之后每轮只报 removals_held 不再写', async () => {
        const extra = { g1: 1, g2: 1, g3: 1, g4: 1 };
        store = raw({ a: 3 }, { a: 2, ...extra }, { group_ratio: { a: 2, ...extra } });
        const first = await reconcileGroupRatioKeys();
        expect(first).toMatchObject({ status: 'synced', heldRemovals: ['g1', 'g2', 'g3', 'g4'] });
        expect(JSON.parse(store[FLAT]!)).toEqual({ a: 3, ...extra });
        mockPutOption.mockClear();
        await expect(reconcileGroupRatioKeys()).resolves.toEqual({
            status: 'removals_held',
            heldRemovals: ['g1', 'g2', 'g3', 'g4'],
        });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('拿不到 advisory 锁 → deferred,不写', async () => {
        store = raw({ a: 3 }, { a: 2 }, { group_ratio: { a: 2 } });
        mockQueryRaw.mockResolvedValue([{ locked: false }]);
        await expect(reconcileGroupRatioKeys()).resolves.toEqual({ status: 'deferred', reason: 'lock_held' });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('写前再读发现运营刚保存 → deferred,下一轮拿新值', async () => {
        store = raw({ a: 3 }, { a: 2 }, { group_ratio: { a: 2 } });
        mockQueryRaw.mockImplementation(async () => {
            store[LEGACY] = JSON.stringify({ a: 9 }); // 第一次读之后、写之前的保存
            return [{ locked: true }];
        });
        await expect(reconcileGroupRatioKeys()).resolves.toEqual({
            status: 'deferred',
            reason: 'changed_since_read',
        });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('中途写失败 → write_failed 并报告已写的键', async () => {
        store = raw({ a: 3 }, { a: 2 }, { group_ratio: { a: 2 } });
        mockPutOption.mockImplementation(async (k: string, v: string) => {
            if (k === FLAT) throw new Error('boom');
            store[k] = v;
        });
        await expect(reconcileGroupRatioKeys()).resolves.toEqual({
            status: 'write_failed',
            written: [NESTED],
            error: 'boom',
        });
    });

    it('写后回读不一致 → verify_failed', async () => {
        store = raw({ a: 3 }, { a: 2 }, { group_ratio: { a: 2 } });
        mockPutOption.mockImplementation(async (k: string, v: string) => {
            if (k !== FLAT) store[k] = v; // PUT 成功但平铺键没落下
        });
        await expect(reconcileGroupRatioKeys()).resolves.toMatchObject({ status: 'verify_failed' });
    });
});
