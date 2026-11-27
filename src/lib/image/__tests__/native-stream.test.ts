import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockQuery = vi.fn();
let poolEnabled = true;
vi.mock('@/lib/newapi/logs-db', () => ({
    getNewapiLogsPool: () => (poolEnabled ? { query: (...a: unknown[]) => mockQuery(...a) } : null),
}));
const mockTokenFindUnique = vi.fn();
const mockGroupFindFirst = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        newApiToken: { findUnique: (...a: unknown[]) => mockTokenFindUnique(...a) },
        channelGroup: { findFirst: (...a: unknown[]) => mockGroupFindFirst(...a) },
    },
}));

import {
    _resetNativeStreamCacheForTest,
    collapseImageSse,
    createNativePartialSink,
    isNativeStreamKey,
    nativeStreamGroups,
    resolveKeyGroup,
} from '../native-stream';

const GROUP = 'oai高价官k渠道';

function sseResponse(chunks: string[], status = 200): Response {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(c) {
            for (const ch of chunks) c.enqueue(enc.encode(ch));
            c.close();
        },
    });
    return new Response(body, {
        status,
        headers: { 'content-type': 'text/event-stream', 'x-oneapi-request-id': 'r1' },
    });
}
const ev = (type: string, data: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

beforeEach(() => {
    vi.clearAllMocks();
    poolEnabled = true;
    delete process.env.IMAGE_NATIVE_STREAM_GROUPS;
    _resetNativeStreamCacheForTest();
});

describe('nativeStreamGroups', () => {
    it('缺省 = oai高价官k渠道;env 逗号分隔;空串 = 关闭', () => {
        expect([...nativeStreamGroups()]).toEqual([GROUP]);
        process.env.IMAGE_NATIVE_STREAM_GROUPS = ' a , b ,';
        expect([...nativeStreamGroups()]).toEqual(['a', 'b']);
        process.env.IMAGE_NATIVE_STREAM_GROUPS = '';
        expect(nativeStreamGroups().size).toBe(0);
    });
});

describe('resolveKeyGroup / isNativeStreamKey', () => {
    it('优先读 new-api tokens.group(sk- 前缀剥掉),结果缓存', async () => {
        mockQuery.mockResolvedValue({ rows: [{ group: GROUP }] });
        expect(await isNativeStreamKey('Bearer sk-abc')).toBe(true);
        expect(mockQuery.mock.calls[0][1]).toEqual(['abc']);
        expect(await resolveKeyGroup('Bearer abc')).toBe(GROUP);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockTokenFindUnique).not.toHaveBeenCalled();
    });

    it('new-api 里是别的分组 → false,不再问 portal', async () => {
        mockQuery.mockResolvedValue({ rows: [{ group: 'oai image 2' }] });
        expect(await isNativeStreamKey('Bearer sk-k1')).toBe(false);
        expect(mockTokenFindUnique).not.toHaveBeenCalled();
    });

    it('new-api 库读不了(无权限)→ 回退 portal tier → ChannelGroup.newapi_group;退避期内不再试 new-api', async () => {
        mockQuery.mockRejectedValue(new Error('permission denied for table tokens'));
        mockTokenFindUnique.mockResolvedValue({ tier: 'oai高价官k渠道', user: { tenant_id: 't1' } });
        mockGroupFindFirst.mockResolvedValue({ newapi_group: GROUP });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(await isNativeStreamKey('Bearer sk-k2')).toBe(true);
        expect(await isNativeStreamKey('Bearer sk-k3')).toBe(true);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockTokenFindUnique).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });

    it('未配 new-api 库 + portal 也没这把 key → false;没 Authorization → false 且不查库', async () => {
        poolEnabled = false;
        mockTokenFindUnique.mockResolvedValue(null);
        expect(await isNativeStreamKey('Bearer sk-nope')).toBe(false);
        expect(await isNativeStreamKey(null)).toBe(false);
        expect(mockTokenFindUnique).toHaveBeenCalledTimes(1);
    });

    it('portal 查询抛错 → 当作非原生分组(不影响出图)', async () => {
        poolEnabled = false;
        mockTokenFindUnique.mockRejectedValue(new Error('db down'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(await isNativeStreamKey('Bearer sk-x')).toBe(false);
        warn.mockRestore();
    });

    it('功能关闭(env 空)→ 不查任何库', async () => {
        process.env.IMAGE_NATIVE_STREAM_GROUPS = '';
        expect(await isNativeStreamKey('Bearer sk-abc')).toBe(false);
        expect(mockQuery).not.toHaveBeenCalled();
    });
});

describe('collapseImageSse', () => {
    it('partial 帧实时交给 sink,completed 折成非流式 JSON(事件被切在任意字节边界也能拼回)', async () => {
        const full =
            ev('image_generation.partial_image', { b64_json: 'P0', partial_image_index: 0, sequence_number: 0 }) +
            ev('image_generation.partial_image', { b64_json: 'P1', partial_image_index: 1, sequence_number: 1 }) +
            ev('image_generation.completed', {
                b64_json: 'FINAL',
                created_at: 123,
                size: '1024x1024',
                quality: 'medium',
                background: 'opaque',
                output_format: 'png',
                usage: { input_tokens: 13, output_tokens: 639, total_tokens: 652 },
                sequence_number: 2,
            });
        const chunks = [full.slice(0, 17), full.slice(17, 140), full.slice(140)];
        const sink = createNativePartialSink();
        const out = await collapseImageSse(sseResponse(chunks), sink);
        expect(out.status).toBe(200);
        expect(out.headers.get('content-type')).toBe('application/json');
        expect(out.headers.get('x-oneapi-request-id')).toBe('r1');
        expect(await out.json()).toEqual({
            created: 123,
            data: [{ b64_json: 'FINAL' }],
            usage: { input_tokens: 13, output_tokens: 639, total_tokens: 652 },
            size: '1024x1024',
            quality: 'medium',
            background: 'opaque',
            output_format: 'png',
        });
        expect(sink.buffered.map((f) => f.b64_json)).toEqual(['P0', 'P1']);
    });

    it('sink 已接上 emit → 直接发,不进缓冲', async () => {
        const sink = createNativePartialSink();
        const got: unknown[] = [];
        sink.emit = (f) => got.push(f.partial_image_index);
        await collapseImageSse(
            sseResponse([
                ev('image_edit.partial_image', { b64_json: 'P', partial_image_index: 0 }),
                ev('image_edit.completed', { b64_json: 'F' }),
            ]),
            sink,
        );
        expect(got).toEqual([0]);
        expect(sink.buffered).toEqual([]);
    });

    it('new-api 给适配器渠道包的 SSE(只有 completed + [DONE],CRLF 行尾)→ 正常折回', async () => {
        const body =
            `event: image_generation.completed\r\ndata: ${JSON.stringify({ type: 'image_generation.completed', created_at: 9, b64_json: 'F', usage: { output_tokens: 824 } })}\r\n\r\n` +
            'data: [DONE]\r\n\r\n';
        const sink = createNativePartialSink();
        const out = await collapseImageSse(sseResponse([body]), sink);
        expect(await out.json()).toEqual({ created: 9, data: [{ b64_json: 'F' }], usage: { output_tokens: 824 } });
        expect(sink.buffered).toEqual([]);
    });

    it('流内 error 事件 → 500 + error 体;没有 completed 就结束 → 502', async () => {
        const errOut = await collapseImageSse(
            sseResponse([ev('error', { error: { message: 'moderation_blocked', code: 'moderation_blocked' } })]),
            createNativePartialSink(),
        );
        expect(errOut.status).toBe(500);
        expect(((await errOut.json()) as { error: { code: string } }).error.code).toBe('moderation_blocked');

        const empty = await collapseImageSse(sseResponse([': keep-alive\n\n']), createNativePartialSink());
        expect(empty.status).toBe(502);
        expect(((await empty.json()) as { error: { type: string } }).error.type).toBe('server_error');
    });

    it('非 SSE(JSON 成功体 / 非 2xx)原样返回同一个 Response', async () => {
        const jsonResp = new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
        expect(await collapseImageSse(jsonResp, createNativePartialSink())).toBe(jsonResp);
        const bad = sseResponse(['x'], 503);
        expect(await collapseImageSse(bad, createNativePartialSink())).toBe(bad);
    });
});
