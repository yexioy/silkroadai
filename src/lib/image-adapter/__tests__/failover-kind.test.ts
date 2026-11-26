/**
 * gpt-image 适配器 failover 原因细分(2026-11-26)。
 * fixture 全部取自当日 server2 十个 api 副本 24h 的 `[image-adapter*] upstream error` 原文(48.9 万条抽样)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
    FAILOVER_MARKERS,
    FAILOVER_MESSAGES,
    UPSTREAM_BAD_IMAGE_RE,
    badImageMessage,
    badImageParam,
    classifyFailKind,
    dominantFailKind,
    extractBadImageDetail,
    failKindOfFetchError,
    isUpstreamFail,
    matchFailoverKind,
    upstreamFail,
    type FailKind,
} from '@/lib/image-adapter/failover-kind';
import { handleAdapterImage } from '@/lib/image-adapter/adapter';
import { handleAdapter25Image } from '@/lib/image-adapter25/adapter';

const err = (message: string, extra: Record<string, unknown> = {}) => JSON.stringify({ error: { message, ...extra } });

describe('classifyFailKind(上游原文 → failover 原因)', () => {
    const cases: Array<[FailKind, number, string]> = [
        // ── 断供:24h 里占 failover 的 93% ──
        [
            'unavailable',
            503,
            err('No available channel for model "gpt-image-2.5-sunburst" in group "image2.5-006".', {
                type: 'yoboxai_error',
            }),
        ],
        ['unavailable', 503, err('ztyunjuan upstream unavailable', { type: 'pool_upstream_unavailable' })],
        [
            'unavailable',
            503,
            err('No available channel for model gpt-image-2.5-flare under group default (distributor)', {
                code: 'model_not_found',
            }),
        ],
        ['unavailable', 503, err('global concurrency backend unavailable', { type: 'server_error' })],
        ['unavailable', 500, err('Service temporarily unavailable, please retry later', { type: 'server_error' })],
        ['unavailable', 408, err('Upstream temporarily unavailable, please retry', { type: 'server_error' })],
        ['unavailable', 400, err('unsupported 10k image model: gpt-image-2.6-sunburst')],
        // 我们在上游的 key / 余额 / 权限问题 = 供给侧断供,绝不能读成客户自己的鉴权或余额错
        ['unavailable', 401, err('Oauth token is not valid')],
        ['unavailable', 403, err('Unauthorized to perform request.')],
        ['unavailable', 403, err('insufficient_user_quota')],
        // ── 真过载 / 限流 ──
        ['overloaded', 429, err('Upstream rate limit reached. Please retry later.', { type: 'rate_limited' })],
        ['overloaded', 408, err('Model is overloaded, please retry later', { type: 'rate_limit_error' })],
        ['overloaded', 503, err('system under load', { type: 'upstream_temporary' })],
        ['overloaded', 429, err('Your API request rate limit has been reached. Please try again later.')],
        ['overloaded', 429, err('account selection is busy; retry shortly', { type: 'rate_limited' })],
        ['overloaded', 408, err('adobe throttled: status 429 retry-after=none envoy=true')],
        // we-token 的 timeout_error 实为 system under load —— 归过载,不归超时
        [
            'overloaded',
            408,
            err(
                'adobe throttled: status 408 retry-after=none envoy=false {"error_code":"timeout_error","message":"system under load"}',
            ),
        ],
        // ── 超时(monkeycoding 用 429 表示)──
        [
            'timeout',
            429,
            err('Image generation did not complete within the time budget, please retry later', {
                type: 'rate_limit_error',
            }),
        ],
        ['timeout', 504, '<html>504 Gateway Time-out</html>'],
        // ── 模型没出图 ──
        [
            'no_image',
            400,
            err(
                'The model answered this request with text instead of generating an image (it read the prompt as a request for a plan, a prompt list, or a file conversion). Retrying will not help.',
            ),
        ],
        [
            'no_image',
            400,
            err(
                'The image model returned text instead of a generated image. Submit a direct image-generation or editing brief.',
            ),
        ],
        [
            'no_image',
            400,
            err(
                'This request contains no input image, but the prompt asks the model to edit or modify one, so the model replied asking for the source image instead of generating.',
            ),
        ],
        ['no_image', 400, err('The prompt refers to a reference image, but the request did not include one.')],
        // ── 本渠道交付不了这个尺寸 ──
        [
            'unsupported',
            400,
            err(
                'The requested image size 768x1360 cannot be delivered at usable quality by this model. Please request a smaller size.',
            ),
        ],
        // ── 其余临时错 ──
        ['error', 502, '<html>\r\n<head><title>502 Bad Gateway</title></head>'],
        ['error', 503, err('Service connection interrupted. Please retry.', { type: 'upstream_temporary' })],
        ['error', 500, err('failed to connect to `user=newapi database=newapi`: FATAL: sorry, too many clients')],
        ['error', 502, err('MISCONF Errors writing to the AOF file: No space left on device')],
        ['error', 400, err('OK', { type: 'invalid_request_error' })],
        ['error', 400, err('Invalid request', { type: 'invalid_request_error' })],
        ['error', 400, err('The image generation tool encountered an error. Please try again.')],
        // 蒙版 / 透明这次没生效:上游用 429 表示可重试,不是限流
        [
            'error',
            429,
            err(
                'The edit was not applied to the masked area this time, so no image was delivered and nothing was charged. Please retry.',
            ),
        ],
        [
            'error',
            429,
            err('The requested transparent background was not produced this time, so no image was delivered.'),
        ],
    ];
    it.each(cases)('%s ← %i %s', (kind, status, text) => {
        expect(classifyFailKind(status, text)).toBe(kind);
    });
});

describe('FAILOVER_MESSAGES / FAILOVER_MARKERS', () => {
    const kinds = Object.keys(FAILOVER_MESSAGES) as FailKind[];

    it('每句只命中自己的 marker', () => {
        for (const kind of kinds) {
            expect(matchFailoverKind(FAILOVER_MESSAGES[kind])).toBe(kind);
            for (const other of kinds) {
                if (other !== kind) expect(FAILOVER_MARKERS[other].test(FAILOVER_MESSAGES[kind])).toBe(false);
            }
        }
    });

    it('旧版适配器的恒定文案(滚动发布期间并存)→ unavailable', () => {
        expect(matchFailoverKind('The server is temporarily unable to process this request, please retry later.')).toBe(
            'unavailable',
        );
    });

    it('不相干的文本不命中', () => {
        expect(matchFailoverKind('Invalid token')).toBeNull();
        expect(matchFailoverKind('bad response status code 404')).toBeNull();
    });

    it('文案不含内部结构字眼(new-api 会把渠道响应原文透给客户)', () => {
        for (const kind of kinds) {
            const low = FAILOVER_MESSAGES[kind].toLowerCase();
            for (const leak of ['gate', 'size', 'quality', 'channel', 'adapter', 'provider', 'upstream', 'pool']) {
                expect(low).not.toContain(leak);
            }
        }
    });
});

describe('dominantFailKind / failKindOfFetchError / isUpstreamFail', () => {
    it('取出现最多的原因,并列取先出现的', () => {
        expect(
            dominantFailKind([upstreamFail('overloaded'), upstreamFail('unavailable'), upstreamFail('unavailable')]),
        ).toBe('unavailable');
        expect(dominantFailKind([upstreamFail('timeout'), upstreamFail('error')])).toBe('timeout');
    });
    it('没有失败记录 → error;图片数组 / 终态对象不计入', () => {
        expect(dominantFailKind([])).toBe('error');
        expect(dominantFailKind([['b64'], { terminal: 'safety' }, upstreamFail('overloaded')])).toBe('overloaded');
    });
    it('isUpstreamFail 只认 { fail }', () => {
        expect(isUpstreamFail(upstreamFail('error'))).toBe(true);
        expect(isUpstreamFail(['b64'])).toBe(false);
        expect(isUpstreamFail({ terminal: 'safety' })).toBe(false);
        expect(isUpstreamFail(null)).toBe(false);
    });
    it('我方超时钟 abort / AbortSignal.timeout → timeout,其余网络错 → error', () => {
        expect(failKindOfFetchError(new DOMException('aborted', 'AbortError'))).toBe('timeout');
        expect(failKindOfFetchError(new DOMException('timed out', 'TimeoutError'))).toBe('timeout');
        expect(failKindOfFetchError(new TypeError('fetch failed'))).toBe('error');
        expect(failKindOfFetchError('boom')).toBe('error');
    });
});

describe('输入图终态错(UPSTREAM_BAD_IMAGE_RE / extractBadImageDetail)', () => {
    // ztyunjuan 把品牌直接拼在原文前("ztyunjuanInvalid input image file"),所以品牌正则尾部不带 \b
    const brand = /\bmonkey\s?-?coding\b|\bztyunjuan|\badobe\b/gi;
    const sanitize = (s: string) => s.replace(brand, 'the provider');

    it.each([
        ['images[0] is not a decodable image (truncated or corrupt)'],
        ['images[1] format avif is not supported (png/jpeg/webp/gif)'],
        ['mask could not be decoded as an image'],
        ['input reference is not a decodable image'],
    ])('保留具体原因:%s', (message) => {
        const text = err(message, { type: 'invalid_request_error' });
        expect(UPSTREAM_BAD_IMAGE_RE.test(text)).toBe(true);
        expect(extractBadImageDetail(text, sanitize)).toBe(message);
        expect(badImageMessage(message)).toBe(`Invalid input image: ${message}`);
    });

    it('上游只给笼统一句 / 只给错误码 → 无细节,走统一文案', () => {
        for (const text of [
            err('Invalid input image file. Please check the uploaded image.'),
            err('ztyunjuanInvalid input image file. Please check the uploaded image.'),
            err("We couldn't process this image. Error code: image_parse_error."),
            err(
                'adobe bad request: status 400 {"error_code":"bad_request","message":"Bad request to openai: Invalid input image file. Please check the uploaded image."}',
            ),
            err(
                'adobe bad request: status 400 {"error_code":"bad_request","message":"Bad request to openai: Invalid image data."}',
            ),
        ]) {
            expect(UPSTREAM_BAD_IMAGE_RE.test(text)).toBe(true);
            expect(extractBadImageDetail(text, sanitize)).toBe('');
        }
        expect(badImageMessage('')).toMatch(/^Invalid input image\. Please check/);
    });

    it('细节脱敏;非 JSON 体不透出', () => {
        // 句首的品牌前缀整段去掉,句中的抹成 the provider
        expect(extractBadImageDetail(err('adobe: images[0] is not a decodable image'), sanitize)).toBe(
            'images[0] is not a decodable image',
        );
        expect(extractBadImageDetail(err('images[0] from adobe is not a decodable image'), sanitize)).toBe(
            'images[0] from the provider is not a decodable image',
        );
        expect(extractBadImageDetail('<html>images[0] is not a decodable image</html>', sanitize)).toBe('');
    });

    it('参数类报错不误判成坏图(response_format / output_format 不支持)', () => {
        expect(UPSTREAM_BAD_IMAGE_RE.test(err('response_format url is not supported'))).toBe(false);
        expect(UPSTREAM_BAD_IMAGE_RE.test(err('output_format tiff is not supported'))).toBe(false);
        expect(UPSTREAM_BAD_IMAGE_RE.test(err('Invalid image file or mode'))).toBe(true);
    });

    it('param:蒙版 → mask,其余 → image', () => {
        expect(badImageParam('mask could not be decoded as an image')).toBe('mask');
        expect(badImageParam('images[0] is not a decodable image')).toBe('image');
        expect(badImageParam('')).toBe('image');
    });
});

// ───────────────────── 适配器端到端(2.0 + 2.5 两套)─────────────────────

const fetchMock = vi.fn();
beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonReq(body: unknown): NextRequest {
    return new NextRequest('http://portal.test/image-adapter/x/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-upstream-test' },
        body: JSON.stringify(body),
    });
}

/** 每次造新 Response(body 只能读一次)。 */
function upstreamReplies(status: number, body: string) {
    fetchMock.mockImplementation(async () => new Response(body, { status }));
}

interface ErrBody {
    error: { message: string; type: string; code: string; param?: string | null };
}

/** 两套适配器同一组断言:[名字, 发起一次 generations 请求]。 */
const ADAPTERS: Array<[string, () => Promise<Response>]> = [
    [
        'image-adapter(gpt-image-2)',
        () => handleAdapterImage(jsonReq({ prompt: 'a cat', size: '1024x1024' }), 'generations', 'monkeycoding'),
    ],
    [
        'image-adapter25(gpt-image-2.5)',
        () =>
            handleAdapter25Image(
                jsonReq({ model: 'gpt-image-2.5-flare', prompt: 'a cat', size: '1024x1024', quality: 'low' }),
                'generations',
                'monkeycoding25',
            ),
    ],
];

describe.each(ADAPTERS)('%s — failover 响应带原因(恒 503 + code upstream_unavailable)', (_name, call) => {
    const failoverCases: Array<[FailKind, number, string]> = [
        ['unavailable', 503, err('No available channel for model "gpt-image-2.5-flare" in group "image2.5-006".')],
        ['unavailable', 503, err('pool upstream unavailable', { type: 'pool_upstream_unavailable' })],
        ['overloaded', 429, err('Upstream rate limit reached. Please retry later.')],
        ['overloaded', 408, err('Model is overloaded, please retry later')],
        ['timeout', 429, err('Image generation did not complete within the time budget, please retry later')],
        ['no_image', 400, err('The model answered this request with text instead of generating an image.')],
        ['error', 502, '<html>502 Bad Gateway</html>'],
        ['error', 400, err('OK', { type: 'invalid_request_error' })],
    ];
    it.each(failoverCases)('%s ← 上游 %i', async (kind, status, body) => {
        upstreamReplies(status, body);
        const res = await call();
        // new-api 的重试语义不变:仍是 5xx
        expect(res.status).toBe(503);
        const j = (await res.json()) as ErrBody;
        expect(j.error.message).toBe(FAILOVER_MESSAGES[kind]);
        expect(j.error.type).toBe('server_error');
        // 客户日志页靠这个 code 折叠内部重试行(log-display isAdapterFailoverNoise),不能随原因变
        expect(j.error.code).toBe('upstream_unavailable');
    });

    it('上游没连上(网络错)→ error;我方超时钟 abort → timeout', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'));
        expect(((await (await call()).json()) as ErrBody).error.message).toBe(FAILOVER_MESSAGES.error);
        fetchMock.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));
        expect(((await (await call()).json()) as ErrBody).error.message).toBe(FAILOVER_MESSAGES.timeout);
    });

    it('上游 200 但没给图 → error', async () => {
        upstreamReplies(200, JSON.stringify({ created: 1, data: [] }));
        const res = await call();
        expect(res.status).toBe(503);
        expect(((await res.json()) as ErrBody).error.message).toBe(FAILOVER_MESSAGES.error);
    });

    it('failover 体不带上游原文 / 品牌', async () => {
        upstreamReplies(503, err('monkeycoding pool image2.5-006 upstream unavailable, contact ops@monkey.example'));
        const text = (await (await call()).text()).toLowerCase();
        for (const leak of ['monkey', 'image2.5-006', 'ops@', 'pool']) expect(text).not.toContain(leak);
    });
});

describe.each(ADAPTERS)('%s — 确定性拒绝终态化(400,不 failover)', (_name, call) => {
    it.each([
        [400, 'images[0] is not a decodable image (truncated or corrupt)'],
        [400, 'images[0] format avif is not supported (png/jpeg/webp/gif)'],
        // 号池上游对坏图回 5xx —— 仍是终态,不能因为是 5xx 就 failover
        [502, 'input reference is not a decodable image'],
    ])('输入图坏(上游 %i:%s)→ 400 invalid_image + 具体原因', async (status, message) => {
        upstreamReplies(status, err(message, { type: 'invalid_request_error' }));
        const res = await call();
        expect(res.status).toBe(400);
        const j = (await res.json()) as ErrBody;
        expect(j.error.type).toBe('invalid_request_error');
        expect(j.error.code).toBe('invalid_image');
        expect(j.error.param).toBe('image');
        expect(j.error.message).toBe(`Invalid input image: ${message}`);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('蒙版解不开 → 400 invalid_image param=mask', async () => {
        upstreamReplies(400, err('mask could not be decoded as an image'));
        const j = (await (await call()).json()) as ErrBody;
        expect(j.error.code).toBe('invalid_image');
        expect(j.error.param).toBe('mask');
    });

    it('guardrails 措辞的审核拒 → 400 moderation_blocked(此前漏网成 503)', async () => {
        upstreamReplies(
            400,
            err(
                'We’re so sorry, but the image we created may violate our guardrails around potential fraudulent or scam activity.',
            ),
        );
        const res = await call();
        expect(res.status).toBe(400);
        expect(((await res.json()) as ErrBody).error.code).toBe('moderation_blocked');
    });
});

describe('守门让路 → unsupported(不点名是哪个参数)', () => {
    it('image-adapter:线下档被守门拒(不打上游)', async () => {
        const res = await handleAdapterImage(jsonReq({ prompt: 'x', size: '1024x1024' }), 'generations', 'ominiapi');
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
        const j = (await res.json()) as ErrBody;
        expect(j.error.message).toBe(FAILOVER_MESSAGES.unsupported);
        expect(j.error.code).toBe('upstream_unavailable');
    });

    it('image-adapter25:provider 不承接该档位(不打上游)', async () => {
        const res = await handleAdapter25Image(
            jsonReq({ model: 'gpt-image-2.5-sunburst', prompt: 'x', size: '1024x1024', quality: 'max' }),
            'generations',
            'llmway25',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(((await res.json()) as ErrBody).error.message).toBe(FAILOVER_MESSAGES.unsupported);
    });
});
