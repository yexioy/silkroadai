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

import { planGroupRatioReconcile, reconcileGroupRatioKeys } from '../group-ratio-reconcile';

const LEGACY = 'GroupRatio';
const NESTED = 'group_ratio_setting';
const FLAT = 'group_ratio_setting.group_ratio';

type Store = Record<string, string | null>;
let store: Store;

function raw(legacy: unknown, flat: unknown, nested: unknown): Store {
    const enc = (v: unknown) => (typeof v === 'string' || v === null ? (v as string | null) : JSON.stringify(v));
    return { [LEGACY]: enc(legacy), [FLAT]: enc(flat), [NESTED]: enc(nested) };
}

const asRaw = (s: Store) => s as Parameters<typeof planGroupRatioReconcile>[0];

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

    it('某键缺组 → repair,并集含各键独有的组,保留嵌套键其它字段', () => {
        const p = planGroupRatioReconcile(
            asRaw(raw({ a: 1, ui: 3 }, { a: 1, tok: 2 }, { group_ratio: { a: 1, tok: 2 }, other: 'x' })),
        );
        expect(p).toEqual({
            kind: 'repair',
            union: { a: 1, ui: 3, tok: 2 },
            missing: { [NESTED]: ['ui'], [FLAT]: ['ui'], [LEGACY]: ['tok'] },
            nestedRest: { other: 'x' },
        });
    });

    it('同组值不同 → conflict,列出各键的值', () => {
        const p = planGroupRatioReconcile(asRaw(raw({ a: 2.4 }, { a: 1.2 }, { group_ratio: { a: 1.2 } })));
        expect(p).toEqual({
            kind: 'conflict',
            conflicts: [{ group: 'a', values: { [NESTED]: 1.2, [FLAT]: 1.2, [LEGACY]: 2.4 } }],
        });
    });

    it('冲突只出现在缺组的一侧也算冲突', () => {
        const p = planGroupRatioReconcile(asRaw(raw({ a: 1, b: 3 }, { a: 1 }, { group_ratio: { a: 1, b: 2 } })));
        expect(p.kind).toBe('conflict');
    });

    it.each([
        ['键缺失', raw({ a: 1 }, null, { group_ratio: { a: 1 } })],
        ['JSON 坏', raw({ a: 1 }, '{oops', { group_ratio: { a: 1 } })],
        ['不是 map', raw({ a: 1 }, [1], { group_ratio: { a: 1 } })],
        ['空 map', raw({}, { a: 1 }, { group_ratio: { a: 1 } })],
        ['嵌套键无 group_ratio', raw({ a: 1 }, { a: 1 }, { other: 1 })],
        ['倍率不是数字', raw({ a: '1' }, { a: 1 }, { group_ratio: { a: 1 } })],
        ['倍率为负', raw({ a: -1 }, { a: 1 }, { group_ratio: { a: 1 } })],
    ])('%s → invalid', (_name, r) => {
        expect(planGroupRatioReconcile(asRaw(r)).kind).toBe('invalid');
    });

    it('invalid 优先于 conflict', () => {
        const p = planGroupRatioReconcile(asRaw(raw({ a: 2 }, null, { group_ratio: { a: 1 } })));
        expect(p.kind).toBe('invalid');
    });
});

describe('reconcileGroupRatioKeys', () => {
    it('in_sync → 不开事务、不写', async () => {
        store = raw({ a: 1 }, { a: 1 }, { group_ratio: { a: 1 } });
        await expect(reconcileGroupRatioKeys()).resolves.toEqual({ status: 'in_sync', groups: 1 });
        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('缺组 → 三键写成同一份并集,嵌套键其它字段保留', async () => {
        store = raw({ a: 1, ui: 3 }, { a: 1 }, { group_ratio: { a: 1 }, other: 'x' });
        const r = await reconcileGroupRatioKeys();
        expect(r).toEqual({
            status: 'repaired',
            groups: 2,
            missing: { [NESTED]: ['ui'], [FLAT]: ['ui'] },
        });
        expect(mockPutOption.mock.calls.map((c) => c[0])).toEqual([NESTED, FLAT, LEGACY]);
        const union = { a: 1, ui: 3 };
        expect(JSON.parse(store[LEGACY]!)).toEqual(union);
        expect(JSON.parse(store[FLAT]!)).toEqual(union);
        expect(JSON.parse(store[NESTED]!)).toEqual({ group_ratio: union, other: 'x' });
    });

    it('值冲突 → 不写', async () => {
        store = raw({ a: 2 }, { a: 1 }, { group_ratio: { a: 1 } });
        const r = await reconcileGroupRatioKeys();
        expect(r.status).toBe('conflict');
        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it.each([
        ['键缺失', raw({ a: 1 }, null, { group_ratio: { a: 1 } })],
        ['JSON 坏', raw({ a: 1 }, 'nope', { group_ratio: { a: 1 } })],
    ])('%s → 跳过不写', async (_name, r) => {
        store = r;
        await expect(reconcileGroupRatioKeys()).resolves.toMatchObject({ status: 'invalid' });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('拿不到 advisory 锁 → deferred,不再读不写', async () => {
        store = raw({ a: 1, ui: 3 }, { a: 1 }, { group_ratio: { a: 1 } });
        mockQueryRaw.mockResolvedValue([{ locked: false }]);
        await expect(reconcileGroupRatioKeys()).resolves.toEqual({ status: 'deferred', reason: 'lock_held' });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('写前再读发现运营刚保存 → deferred,不覆盖', async () => {
        store = raw({ a: 1, ui: 3 }, { a: 1 }, { group_ratio: { a: 1 } });
        mockQueryRaw.mockImplementation(async () => {
            store[LEGACY] = JSON.stringify({ a: 9, ui: 3 }); // 第一次读之后、写之前的保存
            return [{ locked: true }];
        });
        await expect(reconcileGroupRatioKeys()).resolves.toEqual({
            status: 'deferred',
            reason: 'changed_since_read',
        });
        expect(mockPutOption).not.toHaveBeenCalled();
        expect(JSON.parse(store[LEGACY]!)).toEqual({ a: 9, ui: 3 });
    });

    it('中途写失败 → write_failed 并报告已写的键', async () => {
        store = raw({ a: 1, ui: 3 }, { a: 1 }, { group_ratio: { a: 1 } });
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
        store = raw({ a: 1, ui: 3 }, { a: 1 }, { group_ratio: { a: 1 } });
        mockPutOption.mockImplementation(async (k: string, v: string) => {
            if (k !== FLAT) store[k] = v; // PUT 成功但平铺键没落下
        });
        await expect(reconcileGroupRatioKeys()).resolves.toMatchObject({ status: 'verify_failed' });
    });
});
