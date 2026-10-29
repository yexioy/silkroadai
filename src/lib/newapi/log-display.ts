/**
 * 客户日志【展示层】纯helpers —— 折叠重试中间失败 + 错误文案脱敏。
 *
 * 客户看到的调用日志会被三类"中间失败"噪音污染:
 *   1. new-api 内部 failover:同一请求多次尝试用【同一 request_id】记多行(失败渠道 + 成功渠道);
 *   2. proxy 尺寸重试(#224):是【新 request_id】;
 *   3. image-adapter 守门拒(#317 起):按张计费渠道只接盈利档,其余一律 503 让 new-api 换渠道。
 * 折叠后只保留最终结果;并把错误文案脱敏(隐藏 adobe / we-token 等上游来源)成友好中文。
 * 纯函数、client-safe、无副作用 —— dashboard 页 + /logs 页 + /api/portal/logs 都复用。
 */
import { pickMessages, type Locale } from '@/lib/i18n';
import { logsMessages } from '@/lib/i18n/messages/logs';

/**
 * 该失败行是不是 image-adapter 的内部 failover 信号(客户不该看见)。
 *
 * 适配器(ch154 ominiapi 按张计费)priority 最高 → **全站 97% 的 gpt-image 请求先打它**,
 * 非盈利档(1k / 2k-低质)当场 503 让 new-api 换 azure 渠道 —— 客户照常拿到图,但 new-api
 * 会为这次尝试记一条 type=5。08-04 单日 **42.6 万条**,把客户日志页刷屏。
 *
 * 只认适配器独有的 `other.error_code === 'upstream_unavailable'`,不会误伤别的 5xx。
 * 规则 1(request_id 配对)理论上能吃掉它们,但**依赖失败行与成功行落在同一取数窗口**:
 * dashboard 分开取 type=2 / type=5(150 / 50 条),这类噪音把 50 条错误位全占满、对应成功
 * 却在窗口外 → 折叠不掉。所以这里改成不依赖分页的无条件规则。
 *
 * 安全性:实测抽样 500 条中 94% 有同 request_id 的成功行(本就该藏);剩余 6%(全渠道都失败)
 * **100% 在别的渠道另有同 request_id 的错误行** —— 那条带真实原因(内容安全 / 坏图)且已被
 * sanitizeLogContent 友好化,所以藏掉本行不会让客户失去唯一解释。
 */
function isAdapterFailoverNoise(other: string | null | undefined): boolean {
    if (!other || !other.includes('upstream_unavailable')) return false; // 快路径:绝大多数行直接跳过 JSON.parse
    try {
        return (JSON.parse(other) as { error_code?: unknown }).error_code === 'upstream_unavailable';
    } catch {
        return false;
    }
}

/**
 * 折叠"失败了但重试 / failover 成功"的中间失败行。规则:
 *   1. 失败行的 request_id 出现在成功集合里 = 该请求最终成功 → 藏掉失败行(new-api failover);
 *   2. 失败行是 "size must use"(proxy 尺寸重试)且同期(180s 内)有成功 → 藏掉;
 *   3. 失败行是 image-adapter 守门拒(见 isAdapterFailoverNoise)→ 无条件藏掉。
 * 真失败(内容拒绝等,独立 request_id、无对应成功)照常返回。仅影响展示,不改计费 / 结果判定。
 */
export function collapseRetriedFailures<
    S extends { request_id: string; created_at: number },
    E extends { request_id: string; created_at: number; content: string; other?: string | null },
>(consume: readonly S[], errors: readonly E[]): E[] {
    const succeededRids = new Set(consume.map((l) => l.request_id).filter(Boolean));
    const successTimes = consume.map((l) => l.created_at).sort((a, b) => a - b);
    const hasSuccessWithin = (t: number, sec: number) => successTimes.some((st) => st >= t && st <= t + sec);
    return errors.filter((e) => {
        if (e.request_id && succeededRids.has(e.request_id)) return false; // failover 中间失败
        if (/size must use/i.test(e.content) && hasSuccessWithin(e.created_at, 180)) return false; // proxy 尺寸重试
        if (isAdapterFailoverNoise(e.other)) return false; // image-adapter 守门拒
        return true;
    });
}

/** 客户日志错误文案脱敏 + 友好化:隐藏上游来源(adobe / we-token / zhiyunai 等),把常见错误映射成
 *  客户能看懂、能行动的文案(`locale` 决定中 / 英,默认中文)。仅作用于【展示】,不改计费 / 真实结果判定。
 *  服务端调用,原文不进浏览器。 */
export function sanitizeLogContent(content: string, locale: Locale = 'zh'): string {
    if (!content) return content;
    const t = pickMessages(logsMessages, locale).sanitized;
    const c = content.toLowerCase();
    if (/image_unsafe|content rejected|appear to be unsafe|safety system|content_policy|\badobe\b/.test(c)) {
        return t.unsafe;
    }
    if (/size must use|invalid size|must be multiples of 16|edges must be multiples/.test(c)) {
        return t.badSize;
    }
    if (/负载已饱和|overloaded|do request failed|temporarily unavailable|no available channel|\b429\b/.test(c)) {
        return t.busy;
    }
    return content.replace(/\b(adobe|we-token|zhiyunai|nexaxis|amutes|vakv|midou|czeq)\b/gi, t.upstream);
}

/** 名字看着像不像生图模型(粗粒度启发式)。仅当日志行缺 `other`/model_price 时,`isPerImageBilled`
 *  拿它兜底。client-safe 纯字符串匹配(不引 server-only 的 import-catalog)。 */
export function isImageModel(model: string): boolean {
    const m = (model || '').toLowerCase();
    return m.includes('image') || m.includes('dall-e') || m.includes('imagen');
}

/** 从日志行 `other`(new-api 回的 JSON 串)取 `model_price`;取不到 → null。
 *  `model_price >= 0` = 按张(ModelPrice 定价);`-1` = 未设 ModelPrice,走 ModelRatio 按 token 计费。 */
export function parseModelPrice(other: string | null | undefined): number | null {
    if (!other) return null;
    try {
        const o = JSON.parse(other) as { model_price?: unknown };
        return typeof o.model_price === 'number' ? o.model_price : null;
    } catch {
        return null;
    }
}

/** 从日志行 `other` 取缓存 token 数:`cache_tokens` = 缓存读(命中),`cache_creation_tokens` =
 *  缓存写(创建)。取不到 / 解析失败 → 0/0。注意语义随上游而异:Anthropic 面(usage_semantic=
 *  anthropic)`prompt_tokens` 不含缓存部分(读写单列),OpenAI 面 cached 含在 prompt 里 ——
 *  展示层只如实分列显示,不做加总推断。 */
export function parseCacheTokens(other: string | null | undefined): { read: number; write: number } {
    if (!other) return { read: 0, write: 0 };
    try {
        const o = JSON.parse(other) as { cache_tokens?: unknown; cache_creation_tokens?: unknown };
        return {
            read: typeof o.cache_tokens === 'number' && o.cache_tokens > 0 ? o.cache_tokens : 0,
            write:
                typeof o.cache_creation_tokens === 'number' && o.cache_creation_tokens > 0
                    ? o.cache_creation_tokens
                    : 0,
        };
    } catch {
        return { read: 0, write: 0 };
    }
}

/**
 * new-api rc.44 任务插件(doubao / hailuo / sora …)日志行的用量元信息。
 *
 * 插件线(2026-10-26 seedance 国内切 doubao 插件 ch315 起)**不写 `prompt_tokens / completion_tokens`
 * 列**(恒 0),真实用量只放在 `other.usage_facts`:视频按 token 计费的 `tokens`(预扣行 = 提交时估算,
 * 结算行 = 出片后真实值)、按秒计费的 `seconds`。老的 ch95 适配器线会把 usage 回填进 completion_tokens,
 * 所以切插件后客户在 portal 看到「seedance 没有 token 消耗」—— 这组 helper 就是把 usage_facts 读出来
 * 还原成展示层认识的 token 数。
 *
 * 一个任务通常两行(都 type=2、request_id 不同、**`other.task_id` 相同**):
 *   - 预扣行:`content` "Action … Billing parameters: tokens: 86400",quota = 预扣;
 *   - 结算行:`content` "Settled by the task usage expression",带 `actual_quota` + `pre_consumed_quota`,
 *     quota = 补扣差额(真实 > 估算);真实 < 估算时结算行是 **type=6**(退差额,quota = 退款额)。
 *   估算恰好等于真实 → 没有结算行(按秒计费的 hailuo 常见)。任务失败 → type=6 全额退款行(无 actual_quota)。
 */
export interface TaskUsage {
    /** `other.is_task === true`(任务插件 / 异步任务行)。 */
    isTask: boolean;
    /** `other.task_id`,预扣行与结算行靠它配对;缺省 null。 */
    taskId: string | null;
    /** `usage_facts.tokens`(视频 token 计费);非 token 计费 / 缺省 → 0。 */
    tokens: number;
    /** `usage_facts.seconds`(按秒计费);缺省 → 0。 */
    seconds: number;
    /** 结算行(带 `actual_quota`)。 */
    isSettlement: boolean;
    /** 结算行:该任务最终实扣 quota(预扣 ± 差额)。 */
    actualQuota: number | null;
}

const NOT_TASK: TaskUsage = {
    isTask: false,
    taskId: null,
    tokens: 0,
    seconds: 0,
    isSettlement: false,
    actualQuota: null,
};

export function parseTaskUsage(other: string | null | undefined): TaskUsage {
    if (!other || !other.includes('"is_task":true')) return NOT_TASK; // 快路径:非任务行不 JSON.parse
    try {
        const o = JSON.parse(other) as {
            is_task?: unknown;
            task_id?: unknown;
            actual_quota?: unknown;
            usage_facts?: { tokens?: unknown; seconds?: unknown } | null;
        };
        if (o.is_task !== true) return NOT_TASK;
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
        return {
            isTask: true,
            taskId: typeof o.task_id === 'string' && o.task_id ? o.task_id : null,
            tokens: num(o.usage_facts?.tokens),
            seconds: num(o.usage_facts?.seconds),
            isSettlement: typeof o.actual_quota === 'number',
            actualQuota: typeof o.actual_quota === 'number' ? o.actual_quota : null,
        };
    } catch {
        return NOT_TASK;
    }
}

/**
 * 把任务插件的【结算行】并进同 `task_id` 的【预扣行】,客户看到的是"一个任务一行、金额 = 最终实扣、
 * token = 真实值"(而不是 "¥1.49 / 86,400" + "¥0.02 / 87,277" 两行,token 看起来重复计)。
 *
 *   - `rows`:type=2 消费行(含预扣行与补扣结算行);
 *   - `refunds`:type=6 行(退差额结算行会在这里;全额退款行无 actual_quota,忽略 —— 那是失败任务,
 *     由 failed-video-match 标成「失败·已退款」)。
 *   合并:预扣行 `quota ← actual_quota`、`other ← 结算行 other`(usage_facts.tokens 变成真实值);
 *   结算行从结果里移除。预扣行不在本页(跨页 / 跨窗口)→ 结算行原样保留(金额是差额,但不丢行)。
 * 纯函数,不改入参;非任务行原样透传、顺序不变。
 */
export function mergeTaskSettlements<L extends { quota: number; other?: string | null }>(
    rows: readonly L[],
    refunds: readonly { other?: string | null }[] = [],
): L[] {
    const settlementByTask = new Map<string, { actualQuota: number; other: string }>();
    const collect = (r: { other?: string | null }) => {
        const t = parseTaskUsage(r.other);
        if (t.isSettlement && t.taskId && t.actualQuota != null && r.other) {
            settlementByTask.set(t.taskId, { actualQuota: t.actualQuota, other: r.other });
        }
    };
    rows.forEach(collect);
    refunds.forEach(collect);
    if (settlementByTask.size === 0) return [...rows];

    const submitTaskIds = new Set<string>();
    for (const r of rows) {
        const t = parseTaskUsage(r.other);
        if (t.isTask && !t.isSettlement && t.taskId) submitTaskIds.add(t.taskId);
    }
    const out: L[] = [];
    for (const r of rows) {
        const t = parseTaskUsage(r.other);
        if (!t.isTask || !t.taskId) {
            out.push(r);
            continue;
        }
        if (t.isSettlement) {
            if (!submitTaskIds.has(t.taskId)) out.push(r); // 预扣行不在本页 → 结算行自己站着
            continue;
        }
        const s = settlementByTask.get(t.taskId);
        out.push(s ? { ...r, quota: s.actualQuota, other: s.other } : r);
    }
    return out;
}

/** 这次调用是否「按张计费」(生图 ModelPrice 定价)。
 *   - `true`  → token 数是噪声(上游回报极不一致)→ 展示层显示 "—"(如 Gemini 生图)。
 *   - `false` → 按 token 计费(ModelRatio,含 gpt-image-2 / az-gpt-image-2 / 所有 LLM)→ token 就是
 *     计费依据,要如实显示。
 *  任务插件行(`other.is_task`):`usage_facts.tokens` 有值(视频 token 计费)→ false(调用方用
 *  `parseTaskUsage` 把它填进 token 列);没有(按秒 / 按次)→ true(token 列 "—")。它们的 `model_price`
 *  恒 0,不走下面的 ≥0 判据 —— 否则 seedance 这类按 token 的视频会被当成"按张"把 token 藏掉。
 *  其余判据优先用【每条请求真实计费口径】`other.model_price`(≥0 按张、-1/缺省按 token);`other` 解析不出
 *  才回退模型名 —— 名字像生图【且不是 gpt-image 族】才算按张(gpt-image 族确定按 token,不能凭名字藏)。 */
export function isPerImageBilled(other: string | null | undefined, model: string): boolean {
    const task = parseTaskUsage(other);
    if (task.isTask) return task.tokens <= 0;
    const mp = parseModelPrice(other);
    if (mp != null) return mp >= 0;
    const m = (model || '').toLowerCase();
    if (m.includes('gpt-image')) return false; // gpt-image 族按 token 计费,即使缺 other 也要显示 token
    return isImageModel(m);
}
