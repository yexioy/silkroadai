/**
 * gpt-image 适配器 failover 原因细分(2026-11-26)。
 *
 * 背景:适配器(@/lib/image-adapter、@/lib/image-adapter25)把一切【非终态】失败都压成同一句
 * `The server is temporarily unable to process this request` 503,/v1 展示层(error-normalize.ts)
 * 再统一改写成 503「The engine is currently overloaded」。结果客户把「上游号池断供」「模型回了文字」
 * 「输入图坏」全读成"资源饱和" —— 2026-11-26 抽样 24h:落到这条 503 的 33 万请求里,真·过载/限流
 * 只占 ~3.5%,93% 是上游无渠道 / 号池不可用。
 *
 * 做法:failover 响应【仍恒 503】(new-api 的重试 / 换渠道语义一个字不变),只是 message 从一句变成
 * 下面这张【固定枚举】里的一句。展示层按这几句话(MARKERS)映射成对客的 status + error.code。
 *
 * 两条硬约束(呼应 adapter.ts failover() 头注释):
 *  1. message 只能是这里的常量 —— 不带上游原文、品牌名、分档路由结构(new-api 会把渠道响应体原文
 *     嵌进自己的错误里,全渠道挂时客户读得到);
 *  2. 响应体的 `error.code` 仍恒为 `upstream_unavailable`:客户日志页靠 new-api `other.error_code`
 *     等于它来折叠适配器的内部 failover 行(@/lib/newapi/log-display isAdapterFailoverNoise +
 *     /api/portal/logs/export 的 SQL),改了会把每天几十万条内部重试行刷到客户日志里。
 *     对客的细分 code 由展示层按 message 生成。
 */

export type FailKind =
    /** 上游断供:上游自己无可用渠道 / 号池不可用 / 上游凭证或余额问题。不是客户请求的问题。 */
    | 'unavailable'
    /** 上游限流 / 过载(429 / 408 / system under load)—— 唯一真正的"overloaded"。 */
    | 'overloaded'
    /** 我方等上游超时,或上游自己报超时。 */
    | 'timeout'
    /** 模型没出图(把 prompt 当成要文字 / 要参考图而回了文字)。换 prompt 才有用。 */
    | 'no_image'
    /** 本渠道不承接该参数组合(尺寸 / 档位 / 透明 / 蒙版 / GIF 帧数)。 */
    | 'unsupported'
    /** 其余:上游 5xx、网络错、空响应、无法识别的 4xx。 */
    | 'error';

/** 一次上游调用的非终态失败(调用方据此 failover,并带上原因)。 */
export interface UpstreamFail {
    fail: FailKind;
}

export function upstreamFail(fail: FailKind): UpstreamFail {
    return { fail };
}

export function isUpstreamFail(x: unknown): x is UpstreamFail {
    return typeof x === 'object' && x !== null && !Array.isArray(x) && 'fail' in x;
}

/** failover 响应的 message(恒 503)。改动任何一句都必须同步 FAILOVER_MARKERS。
 *  措辞刻意避开 size / quality / channel / provider / gate 等字眼(适配器测试的防泄漏清单):
 *  `unsupported` 只说"参数组合",不点名哪个参数 —— 点名等于暴露按尺寸 / 档位分渠道的内部结构。 */
export const FAILOVER_MESSAGES: Record<FailKind, string> = {
    unavailable: 'The service for this model is currently unavailable, please try again later.',
    // 官方 503 原文
    overloaded: 'The engine is currently overloaded, please try again later.',
    timeout: 'The request timed out while generating the image, please retry your request.',
    no_image:
        'The model did not generate an image for this prompt. Describe the picture you want directly, and attach the source image via /v1/images/edits if the prompt refers to one.',
    unsupported: 'The requested combination of parameters is not currently available for this model.',
    // 官方 500 原文
    error: 'The server had an error while processing your request. Sorry about that! Please retry your request.',
};

/** 展示层认 failover 文案用(每句取一段不会出现在别处的片段)。`unavailable` 额外兜住旧版适配器
 *  的那句 `temporarily unable to process`(滚动发布期间新旧副本并存)。 */
export const FAILOVER_MARKERS: Record<FailKind, RegExp> = {
    unavailable: /service for this model is currently unavailable|temporarily unable to process this request/i,
    overloaded: /engine is currently overloaded/i,
    timeout: /timed out while generating the image/i,
    no_image: /did not generate an image for this prompt/i,
    unsupported: /combination of parameters is not currently available/i,
    error: /had an error while processing your request/i,
};

/** 文本是不是适配器的 failover 文案;是 → 哪一类。 */
export function matchFailoverKind(text: string): FailKind | null {
    for (const kind of Object.keys(FAILOVER_MARKERS) as FailKind[]) {
        if (FAILOVER_MARKERS[kind].test(text)) return kind;
    }
    return null;
}

// ── 上游错误 → FailKind ──
// 只在【已判定非终态】(要 failover)之后调用:终态类(审核 / 确定性入参错)由各适配器的
// classifyUpstreamError 先拦走。正则对着 2026-11-26 抽样的 48.9 万条上游原文写,见各分支注释。

/** monkeycoding(ChatGPT 网页池):模型把 prompt 读成要文字 / 要参考图,回了文字而没出图。 */
const NO_IMAGE_RE =
    /text instead of (?:generating )?an? (?:generated )?image|replied asking for the source image|refers to a reference image/i;
/** 上游明说这个尺寸它交付不了(别的渠道可能可以)。 */
const UNSUPPORTED_RE = /cannot be delivered at usable quality/i;
/** 这次没按要求生成(蒙版没生效 / 透明没出),上游用 429 表示"可重试" —— 不是限流。 */
const RETRYABLE_GENERATION_RE =
    /not applied to the masked area|was not produced this time|no image was delivered|generation tool encountered an error/i;
/** 超时类。注意【不】收裸 `timeout`:we-token 的 `error_code: timeout_error` 实为 system under load(过载)。 */
const TIMEOUT_RE = /time budget|timed out|deadline exceeded|gateway time-?out/i;
/** 上游断供:无渠道 / 号池不可用 / 熔断 / 上游账号没钱或没权限 / 上游不认这个模型。 */
const UNAVAILABLE_RE =
    /no available channel|model_not_found|channel_circuit_open|no active tokens|unavailable|unsupported (?:\w+ ){0,3}model|insufficient[_ ](?:user[_ ])?quota|quota is not enough|credit balance|余额不足|额度不足/i;
/** 上游限流 / 过载。 */
const OVERLOADED_RE = /rate.?limit|overloaded|under load|throttl|busy|concurrency|too many requests|capacity/i;

/** 上游 HTTP 错误(status + 原文)→ failover 原因。 */
export function classifyFailKind(status: number, text: string): FailKind {
    if (NO_IMAGE_RE.test(text)) return 'no_image';
    if (UNSUPPORTED_RE.test(text)) return 'unsupported';
    if (RETRYABLE_GENERATION_RE.test(text)) return 'error';
    if (status === 504 || status === 524 || TIMEOUT_RE.test(text)) return 'timeout';
    // 401 / 402 / 403 = 我们在上游的 key / 余额 / 权限出问题 —— 是供给侧断供,绝不能让客户读成自己的鉴权或余额错
    if (status === 401 || status === 402 || status === 403 || UNAVAILABLE_RE.test(text)) return 'unavailable';
    if (status === 429 || status === 408 || OVERLOADED_RE.test(text)) return 'overloaded';
    return 'error';
}

/** fetch 抛错 → 原因:我方超时钟 abort / AbortSignal.timeout → timeout,其余网络错 → error。 */
export function failKindOfFetchError(e: unknown): FailKind {
    const name = e instanceof Error ? e.name : '';
    return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'error';
}

/** 一轮扇出全军覆没 → 取出现最多的原因(并列取先出现的);没有任何失败记录 → error。 */
export function dominantFailKind(results: readonly unknown[]): FailKind {
    const counts = new Map<FailKind, number>();
    for (const r of results) {
        if (isUpstreamFail(r)) counts.set(r.fail, (counts.get(r.fail) ?? 0) + 1);
    }
    let best: FailKind = 'error';
    let bestCount = 0;
    for (const [kind, count] of counts) {
        if (count > bestCount) {
            best = kind;
            bestCount = count;
        }
    }
    return best;
}

// ── 确定性的输入图拒绝(终态 400,不 failover)──
// 输入图本身坏 / 格式不支持:同样的字节换任何渠道都拒(官方 gpt-image 只收 png / jpeg / webp)。此前这些
// 落到「其余 4xx 保守 failover」→ 空跑重试 + 客户拿 503「overloaded」。号池上游(ztyunjuan)对此回 502,
// 所以各适配器把这条判定放在 5xx 之前。
// `format X is not supported` 必须带 `images[N]` 前缀:裸匹配会把 `response_format url is not supported` 这类
// 【参数】报错误判成坏图。
export const UPSTREAM_BAD_IMAGE_RE =
    /is not a decodable image|could not be decoded as an image|image_parse_error|images?\[\d+\] format \w+ is not supported|invalid input image|invalid image (?:file|data)/i;

/** 从上游原文取可展示的输入图错误细节(`images[0] format avif is not supported (png/jpeg/webp/gif)`)。
 *  只在 UPSTREAM_BAD_IMAGE_RE 命中后用;取不出干净的一句 → ''(调用方退回笼统文案)。 */
export function extractBadImageDetail(text: string, sanitize: (s: string) => string): string {
    let msg = '';
    try {
        const j = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof j.error?.message === 'string') msg = j.error.message;
    } catch {
        msg = '';
    }
    // we-token 把上游原文包成 `… bad request: status 400 {"error_code":…,"message":"Bad request to openai: …"}`
    const nested = /"message":\s*"((?:[^"\\]|\\.)*)"\s*\}?\s*$/.exec(msg);
    if (nested) msg = nested[1].replace(/\\"/g, '"');
    // 先抹品牌再去前缀:ztyunjuan 把品牌直接拼在原文前(抹完是 "the providerInvalid input image file…")
    msg = sanitize(msg)
        .replace(/^.*?bad request to \w+:?\s*/i, '')
        .replace(/^the provider:?\s*/i, '')
        .replace(/\s*Error code: \w+\.?/i, '')
        .trim();
    if (!msg || !UPSTREAM_BAD_IMAGE_RE.test(msg) || /[{}<>]/.test(msg)) return '';
    // 上游只给了笼统的一句("Invalid input image file. Please check the uploaded image.")→ 没有可补充的细节
    if (/^invalid (?:input )?image\b/i.test(msg)) return '';
    return msg.slice(0, 200);
}

/** 输入图终态错的 message 前缀 —— 展示层(error-normalize.ts)认这个前缀原样保留细节。 */
export const BAD_IMAGE_PREFIX = 'Invalid input image: ';

/** 输入图终态错的对客 message(适配器直接发)。 */
export function badImageMessage(detail: string): string {
    return detail
        ? `${BAD_IMAGE_PREFIX}${detail}`
        : 'Invalid input image. Please check that the image file is valid and in a supported format (png, jpeg or webp).';
}

/** 出错的是蒙版还是输入图(官方 `error.param`)。 */
export function badImageParam(detail: string): 'mask' | 'image' {
    return /\bmask\b/i.test(detail) ? 'mask' : 'image';
}
