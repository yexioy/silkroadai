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

import { MAX_ROW_REMOVALS_PER_PASS, planMatrixSync, syncCustomerRatioMatrix } from '../customer-ratio-matrix-sync';

const TRUTH = 'GroupGroupRatio';
const MIRROR = 'group_ratio_setting.group_group_ratio';

type Store = Record<string, string | null>;
let store: Store;

/** truth = 后台 UI 写的那份;mirror = 被同步的另一键。 */
function raw(truth: unknown, mirror: unknown): Store {
    const enc = (v: unknown) => (typeof v === 'string' || v === null ? (v as string | null) : JSON.stringify(v));
    return { [TRUTH]: enc(truth), [MIRROR]: enc(mirror) };
}
const asRaw = (s: Store) => s as Parameters<typeof planMatrixSync>[0];

const A = { 'vip-a': { g1: 1.8, g2: 1.7 } };

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

describe('planMatrixSync', () => {
    it('两键相同 → in_sync(键序不同不算差异)', () => {
        const p = planMatrixSync(asRaw(raw(A, { 'vip-a': { g2: 1.7, g1: 1.8 } })));
        expect(p).toEqual({ kind: 'in_sync', rows: 1 });
    });

    it('两键都是空矩阵 → in_sync', () => {
        expect(planMatrixSync(asRaw(raw({}, {})))).toEqual({ kind: 'in_sync', rows: 0 });
    });

    it('UI 改了某客户的倍率 → 镜像键跟着改', () => {
        const p = planMatrixSync(asRaw(raw({ 'vip-a': { g1: 3 } }, { 'vip-a': { g1: 1.8 } })));
        expect(p).toEqual({
            kind: 'sync',
            target: { 'vip-a': { g1: 3 } },
            diff: { added: [], removed: [], changed: ['vip-a'] },
            heldRemovals: [],
        });
    });

    it('行内增删令牌分组也算改动', () => {
        const p = planMatrixSync(asRaw(raw({ 'vip-a': { g1: 1.8 } }, A)));
        expect(p).toMatchObject({ kind: 'sync', diff: { changed: ['vip-a'] } });
    });

    it('UI 新增 / 删除用户分组行 → 同步增删', () => {
        const p = planMatrixSync(asRaw(raw({ 'vip-b': { g1: 2 } }, A)));
        expect(p).toEqual({
            kind: 'sync',
            target: { 'vip-b': { g1: 2 } },
            diff: { added: ['vip-b'], removed: ['vip-a'], changed: [] },
            heldRemovals: [],
        });
    });

    it(`后台旧页面把矩阵冲成 {}(10-26 事故)→ 超过 ${MAX_ROW_REMOVALS_PER_PASS} 行的删除挂起`, () => {
        const mirror = { a: { g: 1 }, b: { g: 1 }, c: { g: 1 }, d: { g: 1 } };
        const p = planMatrixSync(asRaw(raw({}, mirror)));
        expect(p).toEqual({
            kind: 'sync',
            target: mirror,
            diff: { added: [], removed: [], changed: [] },
            heldRemovals: ['a', 'b', 'c', 'd'],
        });
    });

    it('恰好等于上限的删除 → 直接执行', () => {
        const p = planMatrixSync(asRaw(raw({}, { a: { g: 1 }, b: { g: 1 }, c: { g: 1 } })));
        expect(p).toMatchObject({ kind: 'sync', target: {}, heldRemovals: [] });
    });

    it.each([
        ['缺失', null],
        ['JSON 坏', '{oops'],
        ['不是 map', '[1]'],
    ])('镜像键%s → 用真值覆盖', (_n, mirror) => {
        expect(planMatrixSync(asRaw(raw(A, mirror)))).toMatchObject({ kind: 'sync', target: A });
        // 真值为空时也要把坏掉的镜像键写成 {}
        expect(planMatrixSync(asRaw(raw({}, mirror)))).toMatchObject({ kind: 'sync', target: {} });
    });

    it.each([
        ['缺失', null],
        ['JSON 坏', '{oops'],
        ['不是 map', '[1]'],
        ['行不是 map', { 'vip-a': 1 }],
        ['倍率不是数字', { 'vip-a': { g1: '1' } }],
        ['倍率为负', { 'vip-a': { g1: -1 } }],
    ])('真值 GroupGroupRatio %s → invalid,不动镜像键', (_n, truth) => {
        expect(planMatrixSync(asRaw(raw(truth, A))).kind).toBe('invalid');
    });
});

describe('syncCustomerRatioMatrix', () => {
    it('in_sync → 不开事务、不写', async () => {
        store = raw(A, A);
        await expect(syncCustomerRatioMatrix()).resolves.toEqual({ status: 'in_sync', rows: 1 });
        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('有差异 → 只写镜像键,从不写 GroupGroupRatio;下一轮即一致', async () => {
        const truth = { 'vip-a': { g1: 3 }, 'vip-b': { g1: 2 } };
        store = raw(truth, A);
        await expect(syncCustomerRatioMatrix()).resolves.toEqual({
            status: 'synced',
            rows: 2,
            diff: { added: ['vip-b'], removed: [], changed: ['vip-a'] },
            heldRemovals: [],
        });
        expect(mockPutOption.mock.calls.map((c) => c[0])).toEqual([MIRROR]);
        expect(JSON.parse(store[MIRROR]!)).toEqual(truth);
        mockPutOption.mockClear();
        await expect(syncCustomerRatioMatrix()).resolves.toEqual({ status: 'in_sync', rows: 2 });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('真值不可用 → 不写', async () => {
        store = raw('{oops', A);
        await expect(syncCustomerRatioMatrix()).resolves.toMatchObject({ status: 'invalid' });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('批量删除挂起:其余改动先同步,之后每轮只报 removals_held 不再写', async () => {
        const gone = { a: { g: 1 }, b: { g: 1 }, c: { g: 1 }, d: { g: 1 } };
        store = raw({ 'vip-a': { g1: 3 } }, { 'vip-a': { g1: 1.8 }, ...gone });
        await expect(syncCustomerRatioMatrix()).resolves.toMatchObject({
            status: 'synced',
            heldRemovals: ['a', 'b', 'c', 'd'],
        });
        expect(JSON.parse(store[MIRROR]!)).toEqual({ 'vip-a': { g1: 3 }, ...gone });
        mockPutOption.mockClear();
        await expect(syncCustomerRatioMatrix()).resolves.toEqual({
            status: 'removals_held',
            heldRemovals: ['a', 'b', 'c', 'd'],
        });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('拿不到 advisory 锁 → deferred,不写', async () => {
        store = raw({ 'vip-a': { g1: 3 } }, A);
        mockQueryRaw.mockResolvedValue([{ locked: false }]);
        await expect(syncCustomerRatioMatrix()).resolves.toEqual({ status: 'deferred', reason: 'lock_held' });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('写前再读发现刚有人保存 → deferred', async () => {
        store = raw({ 'vip-a': { g1: 3 } }, A);
        mockQueryRaw.mockImplementation(async () => {
            store[TRUTH] = JSON.stringify({ 'vip-a': { g1: 9 } });
            return [{ locked: true }];
        });
        await expect(syncCustomerRatioMatrix()).resolves.toEqual({
            status: 'deferred',
            reason: 'changed_since_read',
        });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('写失败 → write_failed', async () => {
        store = raw({ 'vip-a': { g1: 3 } }, A);
        mockPutOption.mockRejectedValue(new Error('boom'));
        await expect(syncCustomerRatioMatrix()).resolves.toEqual({ status: 'write_failed', error: 'boom' });
    });

    it('写后回读不一致 → verify_failed', async () => {
        store = raw({ 'vip-a': { g1: 3 } }, A);
        mockPutOption.mockResolvedValue(undefined); // PUT 成功但没落下
        await expect(syncCustomerRatioMatrix()).resolves.toMatchObject({ status: 'verify_failed' });
    });
});
