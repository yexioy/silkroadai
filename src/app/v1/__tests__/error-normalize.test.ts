/**
 * image2 错误统一分类器(第 2 步终态:错误体 + 状态码全对齐官方)。
 * fixture 全部取自 2026-08-11 ~ 08-17 生产日志真实文案(见 image2-error-code-unification-brief.md)。
 */
import { describe, it, expect } from 'vitest';
import { normalizeImageError, IMAGE_SAFETY_RE, IMAGE_SAFETY_BODY } from '../[...path]/error-normalize';
import { FAILOVER_MESSAGES, matchFailoverKind } from '@/lib/image-adapter/failover-kind';

interface OfficialError {
    error: { message: string; type: string; param: string | null; code: string | null };
}

function parse(body: string): OfficialError['error'] {
    return (JSON.parse(body) as OfficialError).error;
}

/** 所有改写后的体都不许携带内部信息。 */
function expectNoLeak(body: string) {
    const low = body.toLowerCase();
    for (const leak of ['adobe', 'westus3', 'eastus2', 'distributor', 'read tcp', 'we-token', '分组', '渠道']) {
        expect(low).not.toContain(leak);
    }
}

describe('normalizeImageError — 内容审核(恒 400 统一体)', () => {
    const cases: Array<[string, number]> = [
        [
            'adobe content rejected: status 451 {"error_code":"image_unsafe","message":"The generated images appear to be unsafe. Try modifying the prompts or the seeds."}',
            400,
        ],
        ['adobe content rejected: status 451 {"error_code":"legal_error","message":"{}"}', 400],
        ['content rejected: the image was flagged as unsafe by the content safety system', 400],
        // azure 审核原文线上以 500 出现过 —— 也必须归审核 + 恒 400
        ['Your request was rejected by the safety system. If you believe this is an error, contact us', 500],
        ['Your request was rejected as a result of our safety system.', 400],
    ];
    it.each(cases)('%s → 400 moderation_blocked', (text, status) => {
        const r = normalizeImageError(text, status);
        expect(r.status).toBe(400);
        expect(r.body).toBe(IMAGE_SAFETY_BODY);
        const e = parse(r.body);
        expect(e.code).toBe('moderation_blocked');
        expect(e.type).toBe('user_error');
        expectNoLeak(r.body);
    });

    it('仅提到 adobe 的错误(如超时)不冒充审核', () => {
        expect(IMAGE_SAFETY_RE.test('adobe upstream timeout after 300s')).toBe(false);
    });
});

describe('normalizeImageError — 余额/鉴权', () => {
    it('quota is not enough → 429 insufficient_quota(官方计费语义,new-api 原生 403)', () => {
        const r = normalizeImageError('quota is not enough', 403);
        expect(r.status).toBe(429);
        const e = parse(r.body);
        expect(e.code).toBe('insufficient_quota');
        expect(e.type).toBe('insufficient_quota');
    });

    it.each([['Invalid token (request id: X)'], ['无效的令牌']])('%s → 401 invalid_api_key', (text) => {
        const r = normalizeImageError(text, 401);
        expect(r.status).toBe(401);
        const e = parse(r.body);
        expect(e.code).toBe('invalid_api_key');
        expect(e.type).toBe('invalid_request_error');
    });
});

describe('normalizeImageError — 限流(rate_limit_exceeded + Retry-After)', () => {
    it('we-token throttled retry-after=3s → 429 + 提取退避秒数(此前对客 408)', () => {
        const r = normalizeImageError('adobe throttled: status 429 retry-after=3s envoy=true', 408);
        expect(r.status).toBe(429);
        expect(r.retryAfter).toBe(3);
        const e = parse(r.body);
        expect(e.code).toBe('rate_limit_exceeded');
        expect(e.type).toBe('rate_limit_error');
        expect(e.message).toContain('3s');
        expectNoLeak(r.body);
    });

    const plain: Array<[string, number]> = [
        [
            'adobe throttled: status 408 retry-after=none envoy=false {"error_code":"timeout_error","message":"system under load"}',
            408,
        ],
        ['bad response status code 408', 408],
        ['Image generation concurrency limit exceeded, please retry later', 429],
        ['Your requests to gpt-image-2 for gpt-image-2 in westus3 have exceeded rate limit.', 429],
    ];
    it.each(plain)('%s → 429 rate_limit_exceeded,缺省退避 30', (text, status) => {
        const r = normalizeImageError(text, status);
        expect(r.status).toBe(429);
        expect(r.retryAfter).toBe(30);
        expect(parse(r.body).code).toBe('rate_limit_exceeded');
        expectNoLeak(r.body);
    });
});

describe('normalizeImageError — 请求本身错(不再透传嵌套 JSON)', () => {
    it('Invalid image file for image 2 → invalid_image + 保留第几张', () => {
        const r = normalizeImageError(
            'adobe bad request: status 400 {"error_code":"bad_request","message":"Bad request to openai: Invalid image file or mode for image 2, please check your request"}',
            400,
        );
        expect(r.status).toBe(400);
        const e = parse(r.body);
        expect(e.code).toBe('invalid_image');
        expect(e.param).toBe('image');
        expect(e.message).toContain('image 2');
        expect(r.body).not.toContain('error_code'); // 嵌套 JSON 不出门
        expectNoLeak(r.body);
    });

    it('prompt is required → param=prompt', () => {
        const e = parse(normalizeImageError('prompt is required', 400).body);
        expect(e.param).toBe('prompt');
        expect(e.type).toBe('invalid_request_error');
    });

    it('validation_error(undefined mention)→ invalid_request 兜底', () => {
        const r = normalizeImageError(
            'adobe bad request: status 422 {"error_code":"validation_error","message":"Undefined mention(s) in prompt: screenshot-2026-08-10."}',
            400,
        );
        expect(parse(r.body).code).toBe('invalid_request');
        expectNoLeak(r.body);
    });
});

describe('normalizeImageError — 断供(503 upstream_unavailable,不再冒充 overloaded)', () => {
    const cases: Array<[string, number]> = [
        // new-api 自己报分组里该 model 无可用渠道
        ['分组 default 下模型 gpt-image-2 无可用渠道（distributor） (request id: X)', 429],
        // 旧版适配器的恒定 failover 文案(滚动发布期间新旧副本并存)
        ['The server is temporarily unable to process this request, please retry later.', 503],
        // 新版适配器 failover:unavailable
        [FAILOVER_MESSAGES.unavailable, 503],
        ['Service temporarily unavailable', 503],
    ];
    it.each(cases)('%s → 503 server_error upstream_unavailable', (text, status) => {
        const r = normalizeImageError(text, status);
        expect(r.status).toBe(503);
        expect(r.retryAfter).toBeUndefined();
        const e = parse(r.body);
        expect(e.type).toBe('server_error');
        expect(e.code).toBe('upstream_unavailable');
        expect(e.message).toContain('temporarily unavailable');
        expect(e.message).not.toContain('overloaded');
        expectNoLeak(r.body);
    });
});

describe('normalizeImageError — 适配器 failover 原因细分(2026-11-26 拆 503 overloaded)', () => {
    /** new-api 把渠道(适配器)的 503 体转给我们的真实形态。 */
    const viaNewApi = (kind: keyof typeof FAILOVER_MESSAGES) =>
        JSON.stringify({
            error: {
                message: `${FAILOVER_MESSAGES[kind]} (request id: 20261126201159140157940eVmADpSV)`,
                type: 'server_error',
                param: '',
                code: 'upstream_unavailable',
            },
        });

    it('overloaded → 503 engine_overloaded + Retry-After(唯一保留 overloaded 文案的一类)', () => {
        const r = normalizeImageError(viaNewApi('overloaded'), 503);
        expect(r.status).toBe(503);
        expect(r.retryAfter).toBe(30);
        const e = parse(r.body);
        expect(e.type).toBe('server_error');
        expect(e.code).toBe('engine_overloaded');
        expect(e.message).toBe('The engine is currently overloaded, please try again later.');
    });

    it('error → 500 upstream_error(官方 500 文案)', () => {
        const r = normalizeImageError(viaNewApi('error'), 503);
        expect(r.status).toBe(500);
        const e = parse(r.body);
        expect(e.type).toBe('server_error');
        expect(e.code).toBe('upstream_error');
        expect(e.message).toContain('The server had an error while processing your request');
    });

    it('timeout → 500 upstream_timeout', () => {
        const r = normalizeImageError(viaNewApi('timeout'), 503);
        expect(r.status).toBe(500);
        const e = parse(r.body);
        expect(e.type).toBe('server_error');
        expect(e.code).toBe('upstream_timeout');
        expect(e.message).toContain('timed out');
    });

    it('no_image → 400 no_image_generated param=prompt(改 prompt 才有用,不让客户空重试)', () => {
        const r = normalizeImageError(viaNewApi('no_image'), 503);
        expect(r.status).toBe(400);
        const e = parse(r.body);
        expect(e.type).toBe('invalid_request_error');
        expect(e.code).toBe('no_image_generated');
        expect(e.param).toBe('prompt');
    });

    it('unsupported → 503 parameter_combination_unavailable(只看得到最后一跳,不敢终态化成 400)', () => {
        const r = normalizeImageError(viaNewApi('unsupported'), 503);
        expect(r.status).toBe(503);
        expect(r.retryAfter).toBeUndefined();
        const e = parse(r.body);
        expect(e.type).toBe('server_error');
        expect(e.code).toBe('parameter_combination_unavailable');
        expect(e.message).not.toContain('overloaded');
    });

    it('unavailable → 503 upstream_unavailable', () => {
        const r = normalizeImageError(viaNewApi('unavailable'), 503);
        expect(r.status).toBe(503);
        expect(parse(r.body).code).toBe('upstream_unavailable');
    });

    it('六类 failover 文案各自只命中自己(互不串桶),且都不落进 default / 限流 / model_not_found 桶', () => {
        const seen = new Set<string>();
        for (const kind of Object.keys(FAILOVER_MESSAGES) as Array<keyof typeof FAILOVER_MESSAGES>) {
            expect(matchFailoverKind(FAILOVER_MESSAGES[kind])).toBe(kind);
            const r = normalizeImageError(viaNewApi(kind), 503);
            const code = parse(r.body).code;
            expect(code).not.toBeNull();
            expect(code).not.toBe('rate_limit_exceeded');
            expect(code).not.toBe('model_not_found');
            seen.add(code as string);
            expect(r.body).not.toContain('request id');
        }
        expect(seen.size).toBe(6);
    });

    it('直连渠道上游自己说 overloaded(非适配器)也归 engine_overloaded', () => {
        const r = normalizeImageError('{"error":{"message":"The engine is currently overloaded"}}', 503);
        expect(r.status).toBe(503);
        expect(parse(r.body).code).toBe('engine_overloaded');
    });
});

describe('normalizeImageError — 适配器已归一的输入图错误保留细节', () => {
    const adapterBody = (message: string, param = 'image') =>
        JSON.stringify({ error: { message, type: 'invalid_request_error', param, code: 'invalid_image' } });

    it('保留具体原因(哪张图 / 为什么),去掉 new-api 追加的 request id', () => {
        const r = normalizeImageError(
            adapterBody(
                'Invalid input image: images[0] format avif is not supported (png/jpeg/webp/gif) (request id: 2026X)',
            ),
            400,
        );
        expect(r.status).toBe(400);
        const e = parse(r.body);
        expect(e.code).toBe('invalid_image');
        expect(e.param).toBe('image');
        expect(e.message).toBe('Invalid input image: images[0] format avif is not supported (png/jpeg/webp/gif)');
    });

    it('蒙版解不开 → param=mask', () => {
        const r = normalizeImageError(
            adapterBody('Invalid input image: mask could not be decoded as an image', 'mask'),
            400,
        );
        const e = parse(r.body);
        expect(e.code).toBe('invalid_image');
        expect(e.param).toBe('mask');
    });

    it('适配器没给细节(笼统文案)→ 走原有的统一文案', () => {
        const r = normalizeImageError(
            adapterBody(
                'Invalid input image. Please check that the image file is valid and in a supported format (png, jpeg or webp).',
            ),
            400,
        );
        const e = parse(r.body);
        expect(e.code).toBe('invalid_image');
        expect(e.message).toContain('Invalid input image');
    });

    it('细节里混进 JSON / HTML 片段 → 不透出,退回统一文案', () => {
        const r = normalizeImageError(adapterBody('Invalid input image: {"upstream":"adobe"} <html>'), 400);
        const e = parse(r.body);
        expect(e.code).toBe('invalid_image');
        expect(e.message).not.toMatch(/[{}<>]/);
        expectNoLeak(r.body);
    });
});

describe('normalizeImageError — 上游临时错(server_error,raw 原文不出门)', () => {
    const cases: Array<[string, number]> = [
        ['adobe temporary error: Post "https://x.we-token.cc/v1/images/edits": unexpected EOF', 400],
        ['adobe temporary error: Post "https://x.we-token.cc/v1/images/edits": context deadline exceeded', 400],
        ['bad response status code 404', 404],
        ['bad response status code 504', 504],
        ['upstream error: do request failed', 500],
        ['read tcp 10.0.0.1:35870->1.2.3.4:443: read: connection reset by peer', 500],
        ['some never-seen-before upstream failure', 502], // 未识别 5xx 也进 server_error 桶
    ];
    it.each(cases)('%s → 500 server_error', (text, status) => {
        const r = normalizeImageError(text, status);
        expect(r.status).toBe(500);
        const e = parse(r.body);
        expect(e.type).toBe('server_error');
        // code 细分(我方扩展;官方为 null):超时 → upstream_timeout,其余 → upstream_error
        const timedOut = /deadline exceeded|504/.test(text);
        expect(e.code).toBe(timedOut ? 'upstream_timeout' : 'upstream_error');
        expectNoLeak(r.body);
    });
});

describe('normalizeImageError — default 桶(未识别 4xx 原样透传,仅抹品牌)', () => {
    it('未识别 400 文案不改写,只做品牌脱敏', () => {
        const r = normalizeImageError('adobe said something novel', 400);
        expect(r.status).toBe(400);
        expect(r.body).toBe('the provider said something novel');
        expect(r.retryAfter).toBeUndefined();
    });

    it('去掉 Provider API error 前缀,还原被打码的 svg.model', () => {
        const body = JSON.stringify({
            error: {
                message: "Provider API error: SVG generation requires '***.model'. (request id: 1)",
                param: 'svg.model',
                code: 'missing_required_parameter',
            },
        });
        const r = normalizeImageError(body, 400);
        expect(r.status).toBe(400);
        expect(JSON.parse(r.body).error.message).toBe("SVG generation requires 'svg.model'. (request id: 1)");
    });

    it('已是官方形的上游错误体原样透传', () => {
        const body = JSON.stringify({ error: { message: 'blocked', type: 'invalid_request_error', code: 'x_custom' } });
        expect(normalizeImageError(body, 400).body).toBe(body);
    });
});

describe('normalizeImageError — model_not_found(#18 未知 model 客户反馈)', () => {
    it('上游显式 model_not_found → 400 invalid_request_error + code model_not_found + param model', () => {
        const r = normalizeImageError('{"error":{"code":"model_not_found","message":"..."}}', 404);
        expect(r.status).toBe(400);
        const e = parse(r.body);
        expect(e.type).toBe('invalid_request_error');
        expect(e.code).toBe('model_not_found');
        expect(e.param).toBe('model');
    });

    it.each(['the model `dall-e-3` does not exist', '模型不存在', 'model is not supported by this endpoint'])(
        '显式 model 未知措辞 → 400 model_not_found: %s',
        (text) => {
            const r = normalizeImageError(text, 400);
            expect(r.status).toBe(400);
            expect(parse(r.body).code).toBe('model_not_found');
        },
    );

    it('歧义的 `no available channel for model X`:默认(已知 model 渠道耗尽)→ 503 容量', () => {
        const r = normalizeImageError('no available channel for model gpt-image-2 under group default', 503);
        expect(r.status).toBe(503);
        expect(parse(r.body).type).toBe('server_error');
    });

    it('歧义的 `no available channel for model X` + unrecognizedModel → 400 model_not_found', () => {
        const r = normalizeImageError('no available channel for model dall-e-3 under group default', 503, {
            unrecognizedModel: true,
        });
        expect(r.status).toBe(400);
        expect(parse(r.body).code).toBe('model_not_found');
        expectNoLeak(r.body);
    });
});

describe('normalizeImageError — too_many_images(#7 超 16 图)', () => {
    it.each([
        'too many images provided',
        'a maximum of 16 images is allowed',
        'the number of images exceeds the limit',
    ])('%s → 400 too_many_images param image', (text) => {
        const r = normalizeImageError(text, 400);
        expect(r.status).toBe(400);
        const e = parse(r.body);
        expect(e.type).toBe('invalid_request_error');
        expect(e.code).toBe('too_many_images');
        expect(e.param).toBe('image');
    });
});
