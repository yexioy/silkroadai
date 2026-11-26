/**
 * image2(gpt-image-2)客户可见错误统一分类器 — 第 2 步(终态):错误体 + HTTP 状态码
 * 全部对齐 OpenAI 官方契约。方案见 image2-error-code-unification-brief.md;
 * 第 1 步(只统一体,status 透传)= PR #389,本步(#390+)把 status 也切到官方语义:
 * 限流/余额 → 429、容量 → 503、临时错 → 500、审核 → 400 `moderation_blocked`。
 *
 * 对客契约对齐 OpenAI 官方错误形 `{"error":{message,type,param,code}}`:客户 SDK 按
 * status + error.code/error.type 分类异常(429→RateLimitError、5xx→APIError/重试),
 * message 只给人读。这里把链路上五花八门的上游原文(we-token 嵌套 JSON、azure region 文案、
 * new-api 中文、raw Go 网络错)归一成稳定 code 枚举 + 官方状态码,同时消灭内部信息泄漏
 * (品牌名 / region 名 / 内部分组名 / tcp 地址)。对客错误码对照表:/docs#errors。
 *
 * 分桶原则(呼应 failover 错误分类硬约束):归类只发生在 new-api 重试/failover 全部打完之后的
 * 展示层,不改变重试语义;不确定的 4xx 走 default 桶原样透传(仅抹品牌名),宁可保留原文也不误改写。
 *
 * 第 5 步(2026-11-26):拆开 503「engine overloaded」。此前适配器把一切非终态失败压成同一句,这里再统一
 * 成 overloaded —— 24h 抽样 33 万条里真过载只占 ~3.5%,其余是上游断供,客户却读成"资源饱和"。现在适配器
 * 的 failover 文案带原因(@/lib/image-adapter/failover-kind 固定枚举),这里按原因给不同 status + code:
 *   上游断供 → 503 upstream_unavailable        上游限流/过载 → 503 engine_overloaded (+Retry-After)
 *   上游 5xx/网络/空响应 → 500 upstream_error  超时 → 500 upstream_timeout
 *   模型没出图 → 400 no_image_generated        参数组合无渠道承接 → 503 parameter_combination_unavailable
 * 限制:new-api 只把【最后一次尝试】的错误回给我们,多渠道链路里前几跳的原因仍只在内部日志。
 */
import { BAD_IMAGE_PREFIX, matchFailoverKind, type FailKind } from '@/lib/image-adapter/failover-kind';

const OFFICIAL_TYPES = {
    invalidRequest: 'invalid_request_error',
    rateLimit: 'rate_limit_error',
    insufficientQuota: 'insufficient_quota',
    serverError: 'server_error',
    /** gpt-image 系审核拒绝的官方 type(社区多个原样样本;DALL·E 3 时代才是 invalid_request_error)。 */
    userError: 'user_error',
} as const;

function officialBody(message: string, type: string, code: string | null, param: string | null = null): string {
    return JSON.stringify({ error: { message, type, param, code } });
}

/** 真·内容审核拒绝的标记(上游确定性输入拒)。⚠️ 不含 `adobe` —— 仅提到品牌名的错误
 *  (如 adobe 线路超时)不是审核拒绝,冒充审核文案会误导客户排查方向(2026-08-05 错误
 *  报告 F 项)。`rejected ... safety system` 覆盖 azure 审核原文(线上实测以 500 出现过)。 */
export const IMAGE_SAFETY_RE =
    /image_unsafe|content rejected|appear to be unsafe|rejected (?:as a result of|by) (?:our|the) safety system/i;

/** 审核拒绝统一体 = 官方 gpt-image 系原文:400 `moderation_blocked` / type `user_error`
 *  (第 2 步切换;`content_policy_violation` 是 DALL·E 3 旧码,已随公告下线)。 */
export const IMAGE_SAFETY_BODY = officialBody(
    'Your request was rejected as a result of our safety system. Your request may contain content that is not allowed by our safety system.',
    OFFICIAL_TYPES.userError,
    'moderation_blocked',
);

// ── 分桶正则(顺序即优先级,safety 最先) ──
const QUOTA_RE = /insufficient[_ ]quota|quota is not enough|余额不足|额度不足/i;
const AUTH_RE = /invalid token|invalid api key|incorrect api key|无效的令牌|令牌.{0,6}(无效|过期|已禁用)/i;
const THROTTLE_RE =
    /throttled|rate.?limit|retry-after|system under load|concurrency limit exceeded|too many pending requests|bad response status code 408/i;
const UPSTREAM_BADREQ_RE =
    /invalid image file|invalid input image|unable to process input image|bad request to openai|validation_error|undefined mention|prompt is required|too many images|maximum of \d+ images|number of images/i;
/** 未知/不支持的 model → 官方 400 invalid_request_error + code model_not_found + param model。
 *  ⚠️ 只匹配【显式】的 model-not-found 措辞,【不】含 `no available channel for model X`——
 *  后者在「已知 model 但渠道全挂」时字面相同(应 503 可重试容量),无法从文本区分。未知 model
 *  的确定性拦截放在 proxy 入口(已知 model 白名单),不靠解析歧义上游文本。此正则只兜住上游
 *  自己就明确报 model_not_found 的形态(部分 new-api 型网关会)。 */
const MODEL_NOT_FOUND_RE =
    /model_not_found|(?:model|模型).{0,40}(?:not found|not supported|does not exist|is not available|不存在|不支持|未找到)/i;
/** new-api 自己报无渠道(分组里该 model 没有启用的渠道)/ 直连渠道报服务不可用 → 断供。
 *  适配器 failover 文案(含旧版 `temporarily unable to process`)由 matchFailoverKind 先一步认走。 */
const CAPACITY_RE = /no available channel|无可用渠道|service temporarily unavailable/i;
/** 临时错里的超时子类(直连渠道 / new-api 自己的网络错原文)。 */
const TIMEOUT_RE = /context deadline exceeded|connection timed out|bad response status code (?:504|524)/i;
const TRANSIENT_RE =
    /temporary error|unexpected eof|context deadline exceeded|tls handshake|connection reset|connection timed out|read tcp|do request failed|upstream request failed|bad response status code \d+|http: server gave/i;

export interface NormalizedImageError {
    body: string;
    status: number;
    /** 限流类:建议退避秒数,调用方写 `Retry-After` 响应头。 */
    retryAfter?: number;
}

/** 上游限流/过载的建议退避秒数(适配器文案里不带上游的 retry-after,给个保守常数)。 */
const OVERLOADED_RETRY_AFTER = 30;

/** 适配器 failover 原因 → 对客错误。status 只在这里才切到官方语义(适配器对 new-api 恒 503)。 */
function failoverKindError(kind: FailKind): NormalizedImageError {
    switch (kind) {
        case 'unavailable':
            return {
                body: officialBody(
                    'The service for this model is temporarily unavailable. This is not caused by your request — please try again later.',
                    OFFICIAL_TYPES.serverError,
                    'upstream_unavailable',
                ),
                status: 503,
            };
        case 'overloaded':
            return {
                body: officialBody(
                    'The engine is currently overloaded, please try again later.',
                    OFFICIAL_TYPES.serverError,
                    'engine_overloaded',
                ),
                status: 503,
                retryAfter: OVERLOADED_RETRY_AFTER,
            };
        case 'timeout':
            return serverError('upstream_timeout');
        case 'no_image':
            // 模型把 prompt 读成要文字 / 要参考图,回了文字。同一 prompt 重试结果相同 → 400 让客户改 prompt。
            return {
                body: officialBody(
                    'The model did not generate an image for this prompt. Describe the picture you want directly; if the prompt refers to a source image, attach it via /v1/images/edits.',
                    OFFICIAL_TYPES.invalidRequest,
                    'no_image_generated',
                    'prompt',
                ),
                status: 400,
            };
        case 'unsupported':
            // 仍给可重试的 503:我们只看得到最后一跳,无法确认【所有】渠道都不承接这个组合 ——
            // 误判成终态 400 会让本可重试成功的请求被客户放弃(failover 分类硬约束:不确定就别终态化)。
            return {
                body: officialBody(
                    'The requested parameter combination (size, quality, background or mask) is not currently available for this model. Try different parameters, or retry later.',
                    OFFICIAL_TYPES.serverError,
                    'parameter_combination_unavailable',
                ),
                status: 503,
            };
        case 'error':
            return serverError('upstream_error');
    }
}

/** 官方 500 server_error 体 + 细分 code。 */
function serverError(code: 'upstream_error' | 'upstream_timeout'): NormalizedImageError {
    return {
        body: officialBody(
            code === 'upstream_timeout'
                ? 'The request timed out while generating the image. Please retry your request.'
                : 'The server had an error while processing your request. Sorry about that! Please retry your request.',
            OFFICIAL_TYPES.serverError,
            code,
        ),
        status: 500,
    };
}

/** 适配器已归一的输入图终态错(`Invalid input image: images[0] format avif is not supported…`)→ 取出细节。
 *  不是这个形态(上游原文 / we-token 嵌套 JSON)→ ''。 */
function adapterBadImageDetail(text: string): string {
    let msg = '';
    try {
        const j = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof j.error?.message === 'string') msg = j.error.message;
    } catch {
        return '';
    }
    if (!msg.startsWith(BAD_IMAGE_PREFIX)) return '';
    const detail = msg
        .slice(BAD_IMAGE_PREFIX.length)
        .replace(/\s*\(request id: [^)]*\)\s*$/i, '')
        .replace(/\badobe\b/gi, 'the provider')
        .trim();
    return /[{}<>]/.test(detail) ? '' : detail.slice(0, 200);
}

/** 从上游限流文案提取退避秒数(`retry-after=3s` / `try again in 3s`),提不到给 30。 */
function parseRetryAfter(text: string): number {
    const m = /(?:retry-after=|try again in )(\d+)/i.exec(text);
    const n = m ? Number(m[1]) : 0;
    return n > 0 && n <= 600 ? n : 30;
}

export interface NormalizeImageOpts {
    /** 客户请求的 model 不是我们特殊处理的图片模型(非 gpt-image / 非 gemini 图片模型)。
     *  为 true 时,歧义的 `no available channel for model X`(已知 model 渠道耗尽 vs 未知 model
     *  字面相同)判为【未知 model】→ 400 model_not_found;缺省 false 时仍按容量 503。 */
    unrecognizedModel?: boolean;
}

/** 转发上游图片错误给客户前统一归类 + 脱敏。内部 reqlog 仍记原文(调用方先 capture 再 normalize)。 */
export function normalizeImageError(
    text: string,
    upstreamStatus: number,
    opts: NormalizeImageOpts = {},
): NormalizedImageError {
    // 1. 内容审核 → 恒 400 moderation_blocked(号池个别成员把拒绝包在 HTTP 200 体里,透传 status
    //    会被客户网关按成功入账 —— 2026-08-08 客户反馈实例;azure 审核原文也出现过 500 形态)
    if (IMAGE_SAFETY_RE.test(text)) return { body: IMAGE_SAFETY_BODY, status: 400 };

    // 2. 余额不足(new-api 原生 403)→ 官方计费语义 429 insufficient_quota
    if (QUOTA_RE.test(text)) {
        return {
            body: officialBody(
                'You exceeded your current quota, please check your plan and billing details.',
                OFFICIAL_TYPES.insufficientQuota,
                'insufficient_quota',
            ),
            status: 429,
        };
    }

    // 3. key 无效/禁用 → 401(官方语义)
    if (AUTH_RE.test(text)) {
        return {
            body: officialBody('Incorrect API key provided.', OFFICIAL_TYPES.invalidRequest, 'invalid_api_key'),
            status: 401,
        };
    }

    // 3b. 适配器 failover 文案(固定枚举,带原因)→ 按原因细分 status + code。排在限流 / 入参桶之前:
    //     这几句是我方适配器自己写的,不能被后面针对上游原文的正则误吞。
    const failoverKind = matchFailoverKind(text);
    if (failoverKind) return failoverKindError(failoverKind);

    // 4. 限流/并发(合并 we-token 408/429 系、并发守门、azure region 文案、`bad response status code 408`)
    //    → 429 + Retry-After(此前对客是 408,2026-08-18 公告切换)
    if (THROTTLE_RE.test(text)) {
        const retryAfter = parseRetryAfter(text);
        return {
            body: officialBody(
                `Rate limit reached for gpt-image-2. Please try again in ${retryAfter}s.`,
                OFFICIAL_TYPES.rateLimit,
                'rate_limit_exceeded',
            ),
            status: 429,
            retryAfter,
        };
    }

    // 5. 请求本身错(上游确定性输入拒,不再透传 we-token 嵌套 JSON)→ 恒 400
    //    (上游曾以 422/401/403 形态压平出现,统一 400 invalid_request_error)
    if (UPSTREAM_BADREQ_RE.test(text)) {
        if (/prompt is required/i.test(text)) {
            return {
                body: officialBody(
                    "Missing required parameter: 'prompt'.",
                    OFFICIAL_TYPES.invalidRequest,
                    'invalid_request',
                    'prompt',
                ),
                status: 400,
            };
        }
        if (/invalid image file|invalid input image|unable to process input image/i.test(text)) {
            // 适配器已给出具体原因(哪张图、截断 / 格式不支持)→ 原样保留,客户能直接定位
            const detail = adapterBadImageDetail(text);
            if (detail) {
                return {
                    body: officialBody(
                        `${BAD_IMAGE_PREFIX}${detail}`,
                        OFFICIAL_TYPES.invalidRequest,
                        'invalid_image',
                        /\bmask\b/i.test(detail) ? 'mask' : 'image',
                    ),
                    status: 400,
                };
            }
            // 多图 edits 保留出错的是第几张(`image 2`),客户能定位到具体素材
            const idx = /image (\d+)/i.exec(text)?.[1];
            return {
                body: officialBody(
                    `Invalid input image${idx ? ` (image ${idx})` : ''}. Please check that the image file is valid and in a supported format.`,
                    OFFICIAL_TYPES.invalidRequest,
                    'invalid_image',
                    'image',
                ),
                status: 400,
            };
        }
        if (/too many images|maximum of \d+ images|number of images/i.test(text)) {
            return {
                body: officialBody(
                    'Too many images provided. gpt-image-2 accepts at most 16 input images.',
                    OFFICIAL_TYPES.invalidRequest,
                    'too_many_images',
                    'image',
                ),
                status: 400,
            };
        }
        return {
            body: officialBody(
                'Invalid request: the prompt, image, or parameters were rejected — please check your request.',
                OFFICIAL_TYPES.invalidRequest,
                'invalid_request',
            ),
            status: 400,
        };
    }

    // 5b. 上游【显式】报 model 未知/不支持,或【调用方标注 model 未识别】且上游报无渠道 →
    //     400 model_not_found(排在容量桶之前)。后者消解 `no available channel for model X` 的歧义:
    //     已知 model 渠道耗尽仍走容量 503,只有我们本就不认的 model 才归此类。
    if (MODEL_NOT_FOUND_RE.test(text) || (opts.unrecognizedModel && /no available channel for model/i.test(text))) {
        return {
            body: officialBody(
                'The model requested is not supported by this endpoint.',
                OFFICIAL_TYPES.invalidRequest,
                'model_not_found',
                'model',
            ),
            status: 400,
        };
    }

    // 6. 断供(new-api 报分组里该 model 无可用渠道 / 直连渠道报服务不可用)→ 503 upstream_unavailable。
    //    此前这里统一成「engine overloaded」,客户误以为资源饱和;真过载走 3b 的 overloaded。
    if (CAPACITY_RE.test(text)) return failoverKindError('unavailable');

    // 7. 上游临时错:显式特征(EOF / deadline / raw tcp / `bad response status code N`)或任何
    //    未识别的 5xx —— 一律 500 官方 server_error 体(此前对客散落 400/404/413/500/502/504;
    //    raw 网络错原文只留内部日志,不出门)
    //    code 细分:超时 → upstream_timeout,其余 → upstream_error(官方 code 为 null,这里是我方扩展)。
    if (TRANSIENT_RE.test(text) || upstreamStatus >= 500) {
        const timedOut = TIMEOUT_RE.test(text) || upstreamStatus === 504 || upstreamStatus === 524;
        return serverError(timedOut ? 'upstream_timeout' : 'upstream_error');
    }

    // 8. default:未识别的 4xx 原样透传(status 不动),仅抹上游品牌名(宁可保留原文也不误改写;
    //    分类 miss 靠内部日志按周 review 补正则)
    //    new-api 型上游会加 `Provider API error:` 前缀,并把 svg.model 这类点号字段打码成 `***.model`。
    const cleaned = text
        .replace(/\badobe\b/gi, 'the provider')
        .replace(/Provider API error:\s*/g, '')
        .replace(/\*\*\*\.model/g, 'svg.model');
    return { body: cleaned, status: upstreamStatus };
}
