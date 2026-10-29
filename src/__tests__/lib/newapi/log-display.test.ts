/**
 * log-display 计费口径判断 —— 决定「调用日志」Tokens 列显不显示。
 *
 * 核心:gpt-image-2 / az-gpt-image-2 是【按 token 计费】(ModelRatio,model_price=-1),token 就是
 * 计费依据,必须显示;Gemini 生图是【按张计费】(ModelPrice≥0),token 是噪声,显示 "—"。
 * 判据优先用每条请求真实计费口径 other.model_price,缺失才回退模型名(gpt-image 族恒按 token)。
 */
import { describe, expect, it } from 'vitest';
import {
    parseModelPrice,
    isPerImageBilled,
    isImageModel,
    parseCacheTokens,
    parseTaskUsage,
    mergeTaskSettlements,
} from '@/lib/newapi/log-display';

// 线上实测样本(见诊断):gpt-image-2 model_price=-1 / model_ratio=0.9286;gemini 生图 model_price 设值 / ratio=0
const GPT_IMAGE_OTHER = '{"model_price":-1,"model_ratio":0.9285714285714286,"completion_ratio":6}';
const GEMINI_IMAGE_OTHER = '{"model_price":0.014286,"model_ratio":0}';
const LLM_OTHER = '{"model_price":-1,"model_ratio":2,"completion_ratio":4}';

describe('parseModelPrice', () => {
    it('从 other JSON 取 model_price(含 -1)', () => {
        expect(parseModelPrice(GPT_IMAGE_OTHER)).toBe(-1);
        expect(parseModelPrice(GEMINI_IMAGE_OTHER)).toBeCloseTo(0.014286);
    });
    it('缺字段 / 空 / 非法 JSON → null', () => {
        expect(parseModelPrice('{"model_ratio":2}')).toBeNull();
        expect(parseModelPrice('')).toBeNull();
        expect(parseModelPrice(null)).toBeNull();
        expect(parseModelPrice(undefined)).toBeNull();
        expect(parseModelPrice('not json')).toBeNull();
    });
});

describe('isPerImageBilled', () => {
    it('优先用 other.model_price:≥0 = 按张(藏 token);-1 = 按 token(显示)', () => {
        expect(isPerImageBilled(GEMINI_IMAGE_OTHER, 'gemini-3-pro-image-preview')).toBe(true); // 按张
        expect(isPerImageBilled(GPT_IMAGE_OTHER, 'gpt-image-2')).toBe(false); // 按 token → 显示
        expect(isPerImageBilled(LLM_OTHER, 'gpt-5.4')).toBe(false); // LLM 按 token
    });

    it('other.model_price 优先级高于模型名(名字含 image 但 model_price=-1 → 显示)', () => {
        // gpt-image-2 名字含 "image",老逻辑会误藏;真实计费口径 model_price=-1 → 显示
        expect(isPerImageBilled(GPT_IMAGE_OTHER, 'gpt-image-2')).toBe(false);
    });

    it('other 缺失 → 回退模型名;gpt-image 族恒按 token(即使缺 other 也显示)', () => {
        expect(isPerImageBilled(null, 'gpt-image-2')).toBe(false); // gpt-image 族 → 显示
        expect(isPerImageBilled('', 'az-gpt-image-2')).toBe(false); // gpt-image 族 → 显示
        expect(isPerImageBilled(undefined, 'gemini-3-pro-image-preview')).toBe(true); // 名字生图 → 藏
        expect(isPerImageBilled(null, 'dall-e-3')).toBe(true); // 名字生图 → 藏
        expect(isPerImageBilled(null, 'gpt-5.4')).toBe(false); // LLM → 显示
    });
});

describe('parseCacheTokens', () => {
    // 线上实测样本(claude prompt-cache 行):prompt_tokens=2 而缓存读 127,885 —— 缓存单列才说得清费用
    const CLAUDE_CACHE_OTHER =
        '{"cache_ratio":0.1,"cache_tokens":127885,"cache_creation_ratio":1.25,"cache_creation_tokens":178,"claude":true}';

    it('从 other JSON 取 cache_tokens(读)/ cache_creation_tokens(写)', () => {
        expect(parseCacheTokens(CLAUDE_CACHE_OTHER)).toEqual({ read: 127_885, write: 178 });
    });

    it('无缓存字段 / 空串 / null / 解析失败 → 0/0', () => {
        expect(parseCacheTokens('{"model_price":-1}')).toEqual({ read: 0, write: 0 });
        expect(parseCacheTokens('')).toEqual({ read: 0, write: 0 });
        expect(parseCacheTokens(null)).toEqual({ read: 0, write: 0 });
        expect(parseCacheTokens('not-json')).toEqual({ read: 0, write: 0 });
    });

    it('非数值 / 负数 → 按 0(防御上游脏数据)', () => {
        expect(parseCacheTokens('{"cache_tokens":"127885","cache_creation_tokens":-3}')).toEqual({
            read: 0,
            write: 0,
        });
    });
});

describe('isImageModel', () => {
    it('名字含 image/dall-e/imagen 命中', () => {
        for (const m of ['gpt-image-2', 'gemini-3-pro-image-preview', 'dall-e-3', 'imagen-4']) {
            expect(isImageModel(m), m).toBe(true);
        }
    });
    it('非生图名(含 LLM / 视频 / 空)不命中', () => {
        for (const m of ['gpt-5.4', 'claude-opus-4-8', 'seedance-2.0-720', '']) {
            expect(isImageModel(m), m).toBe(false);
        }
    });
});

// ───────── 任务插件行(rc.44 doubao / hailuo)—— 线上 ch315 / ch318 实测样本(2026-10-29)─────────
// 预扣行:tokens 是提交时估算;结算行:actual_quota / pre_consumed_quota + 真实 tokens;两行 task_id 相同。
const TASK_SUBMIT_OTHER =
    '{"billing_mode":"tiered_expr","group_ratio":0.75,"is_task":true,"matched_tier":"720p","model_price":0,"task_id":"task_meSV","usage_facts":{"resolution":"720p","tokens":86400,"video_input":"none"}}';
const TASK_SETTLE_OTHER =
    '{"actual_quota":752764,"billing_mode":"tiered_expr","group_ratio":0.75,"is_task":true,"matched_tier":"720p","model_price":0,"pre_consumed_quota":745200,"task_id":"task_meSV","usage_facts":{"resolution":"720p","tokens":87277,"video_input":"none"}}';
// 退差额结算行(type=6):真实 < 估算
const TASK_SETTLE_REFUND_OTHER =
    '{"actual_quota":1878042,"is_task":true,"model_price":0,"pre_consumed_quota":4647375,"task_id":"task_Eqvf","usage_facts":{"resolution":"720p","tokens":108872,"video_input":"none"}}';
// 失败任务全额退款行(type=6):无 actual_quota
const TASK_FAILED_REFUND_OTHER =
    '{"is_task":true,"model_price":0,"task_id":"task_bJxe","usage_facts":{"resolution":"720p","tokens":324000,"video_input":"none"}}';
// 按秒计费(hailuo MiniMax-H3):没有 tokens
const TASK_SECONDS_OTHER =
    '{"group_ratio":1.3,"is_task":true,"matched_tier":"768P","model_price":0,"task_id":"task_Ahhv","usage_facts":{"input_images":1,"input_video_seconds":0,"resolution":"768P","seconds":12}}';

describe('parseTaskUsage', () => {
    it('预扣行:isTask + task_id + 估算 tokens,不是结算行', () => {
        expect(parseTaskUsage(TASK_SUBMIT_OTHER)).toEqual({
            isTask: true,
            taskId: 'task_meSV',
            tokens: 86400,
            seconds: 0,
            isSettlement: false,
            actualQuota: null,
        });
    });
    it('结算行:actual_quota + 真实 tokens', () => {
        expect(parseTaskUsage(TASK_SETTLE_OTHER)).toMatchObject({
            isTask: true,
            taskId: 'task_meSV',
            tokens: 87277,
            isSettlement: true,
            actualQuota: 752764,
        });
    });
    it('按秒计费:seconds 有、tokens 0', () => {
        expect(parseTaskUsage(TASK_SECONDS_OTHER)).toMatchObject({ isTask: true, tokens: 0, seconds: 12 });
    });
    it('非任务行 / 空 / 非法 JSON / is_task 非 true → NOT_TASK', () => {
        const none = { isTask: false, taskId: null, tokens: 0, seconds: 0, isSettlement: false, actualQuota: null };
        expect(parseTaskUsage(LLM_OTHER)).toEqual(none);
        expect(parseTaskUsage('')).toEqual(none);
        expect(parseTaskUsage(null)).toEqual(none);
        expect(parseTaskUsage('{"is_task":true')).toEqual(none);
        expect(parseTaskUsage('{"is_task":"true"}')).toEqual(none);
    });
});

describe('isPerImageBilled — 任务插件行', () => {
    it('视频按 token(usage_facts.tokens 有值)→ false(显示 token),尽管 model_price=0', () => {
        expect(isPerImageBilled(TASK_SUBMIT_OTHER, 'doubao-seedance-2-0-mini-260615')).toBe(false);
        expect(isPerImageBilled(TASK_SETTLE_OTHER, 'doubao-seedance-2-0-mini-260615')).toBe(false);
    });
    it('按秒计费(无 tokens)→ true(token 列 "—")', () => {
        expect(isPerImageBilled(TASK_SECONDS_OTHER, 'MiniMax-H3')).toBe(true);
    });
});

describe('mergeTaskSettlements', () => {
    const submit = { id: 1, quota: 745200, other: TASK_SUBMIT_OTHER, type: 2 };
    const settle = { id: 2, quota: 7564, other: TASK_SETTLE_OTHER, type: 2 };
    const llm = { id: 3, quota: 100, other: LLM_OTHER, type: 2 };

    it('预扣 + 补扣结算(都 type=2)→ 一行:quota = actual_quota、other = 结算行(真实 tokens);顺序不变', () => {
        const out = mergeTaskSettlements([settle, llm, submit]);
        expect(out.map((r) => r.id)).toEqual([3, 1]);
        expect(out[1]).toMatchObject({ id: 1, quota: 752764, other: TASK_SETTLE_OTHER });
        expect(parseTaskUsage(out[1].other).tokens).toBe(87277);
    });
    it('退差额结算行在 type=6(refunds 参数)→ 预扣行 quota 降到 actual_quota', () => {
        const submitBig = {
            id: 10,
            quota: 4647375,
            other: TASK_SUBMIT_OTHER.replace('task_meSV', 'task_Eqvf'),
            type: 2,
        };
        const out = mergeTaskSettlements([submitBig], [{ other: TASK_SETTLE_REFUND_OTHER }]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ id: 10, quota: 1878042 });
        expect(parseTaskUsage(out[0].other).tokens).toBe(108872);
    });
    it('失败任务的全额退款行(无 actual_quota)不参与合并;预扣行原样(由 failed-video-match 标失败)', () => {
        const submitFailed = {
            id: 11,
            quota: 2794500,
            other: TASK_SUBMIT_OTHER.replace('task_meSV', 'task_bJxe'),
            type: 2,
        };
        const out = mergeTaskSettlements([submitFailed], [{ other: TASK_FAILED_REFUND_OTHER }]);
        expect(out).toEqual([submitFailed]);
    });
    it('结算行的预扣行不在本页 → 结算行原样保留(不丢行)', () => {
        expect(mergeTaskSettlements([settle, llm])).toEqual([settle, llm]);
    });
    it('没有任何结算行 → 原样复制;不改入参', () => {
        const rows = [submit, llm];
        const out = mergeTaskSettlements(rows);
        expect(out).toEqual(rows);
        expect(out).not.toBe(rows);
        expect(submit.quota).toBe(745200);
    });
});
