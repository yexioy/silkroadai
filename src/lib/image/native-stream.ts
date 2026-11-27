/**
 * gpt-image 原生流式分组(2026-11-27,operator:「oai高价官k渠道」上游是官 key,不要代理层的假预览图)。
 *
 * 命中分组的 key 发 `stream:true` 时,代理把 stream / partial_images 原样带给 new-api(其余分组照旧剥掉、
 * 走占位帧伪流式)。new-api 对两类渠道都回 SSE(2026-11-27 实测 rc.44):
 *   - 直连渠道:上游的 SSE 逐帧透传(有真 partial_image 就有,ch340 fairdo 实测只回 completed);
 *   - 适配器渠道:适配器回 JSON,new-api 自己包成一个 completed 事件 + `data: [DONE]`。
 * 两种都 is_stream=true、按 completed 帧的 usage 计费。
 *
 * 所以代理统一这样处理(collapseImageSse):partial_image 事件原样转给客户(真渐进图),completed 事件折回
 * 非流式 JSON 形,继续走原有后处理链(转码 / C2PA / 图床 / 回显 / 错误归一)后再由 gptImageSseResponse 发出。
 * 这样同组的流式与非流式最终图完全一致,不会因为走了流式就绕过后处理。
 *
 * 分组解析:优先直读 new-api `tokens.group`(路由真正依据;需要只读账号对 tokens(key, "group") 有 SELECT),
 * 读不了 / 查不到再用 portal 的 NewApiToken.tier → ChannelGroup.newapi_group(只覆盖 portal 建的 key)。
 * 任何失败都当「不是原生分组」,退回占位帧伪流式 —— 绝不因解析失败影响出图。
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { getNewapiLogsPool } from '@/lib/newapi/logs-db';

type JsonRecord = Record<string, unknown>;

const DEFAULT_GROUPS = 'oai高价官k渠道';
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 2_000;
/** new-api 库读不了(无权限 / 连不上)后,这段时间内不再试,直接走 portal 回退。 */
const NEWAPI_DB_BACKOFF_MS = 5 * 60_000;

/** env IMAGE_NATIVE_STREAM_GROUPS:逗号分隔的 new-api 分组名;设成空串 = 整个功能关闭。 */
export function nativeStreamGroups(): Set<string> {
    const raw = process.env.IMAGE_NATIVE_STREAM_GROUPS ?? DEFAULT_GROUPS;
    return new Set(
        raw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );
}

const cache = new Map<string, { group: string | null; at: number }>();
let newapiDbBlockedUntil = 0;

function storedKeyFromAuth(authorization: string | null): string | null {
    const m = (authorization ?? '').match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const raw = m[1].trim();
    const stored = raw.startsWith('sk-') ? raw.slice(3) : raw; // 两边库都存无 sk- 前缀
    return stored || null;
}

async function groupFromNewapiDb(stored: string): Promise<string | null | undefined> {
    if (Date.now() < newapiDbBlockedUntil) return undefined;
    const pool = getNewapiLogsPool();
    if (!pool) return undefined;
    try {
        const r = await pool.query<{ group: string | null }>('select "group" from tokens where key = $1 limit 1', [
            stored,
        ]);
        if (r.rows.length === 0) return undefined; // 库里没这把 key → 让 portal 回退再看一眼
        // token 没单独设分组时 new-api 用 user 的分组;该功能只认 token 级分组(现网此组 0 个 user 级成员)。
        return (r.rows[0].group ?? '').trim() || null;
    } catch (err) {
        newapiDbBlockedUntil = Date.now() + NEWAPI_DB_BACKOFF_MS;
        console.warn('[image-native-stream] new-api tokens lookup unavailable, falling back to portal tier', {
            err: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}

async function groupFromPortal(stored: string): Promise<string | null> {
    const token = await prisma.newApiToken.findUnique({
        where: { newapi_token_value: stored },
        select: { tier: true, user: { select: { tenant_id: true } } },
    });
    if (!token) return null;
    const cg = await prisma.channelGroup.findFirst({
        where: { key: token.tier, ...(token.user.tenant_id ? { tenant_id: token.user.tenant_id } : {}) },
        select: { newapi_group: true },
    });
    return cg?.newapi_group ?? null;
}

/** 这把 key 的 new-api 分组(解析不到 → null)。结果缓存 60s(含 null)。 */
export async function resolveKeyGroup(authorization: string | null): Promise<string | null> {
    const stored = storedKeyFromAuth(authorization);
    if (!stored) return null;
    const hit = cache.get(stored);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.group;
    let group: string | null = null;
    try {
        const fromNewapi = await groupFromNewapiDb(stored);
        group = fromNewapi !== undefined ? fromNewapi : await groupFromPortal(stored);
    } catch (err) {
        console.warn('[image-native-stream] key group lookup failed', {
            err: err instanceof Error ? err.message : String(err),
        });
        group = null;
    }
    cache.delete(stored);
    cache.set(stored, { group, at: Date.now() });
    while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return group;
}

/** 这个请求的 key 是否属于原生流式分组。 */
export async function isNativeStreamKey(authorization: string | null): Promise<boolean> {
    const groups = nativeStreamGroups();
    if (groups.size === 0) return false;
    const g = await resolveKeyGroup(authorization);
    return g !== null && groups.has(g);
}

export function _resetNativeStreamCacheForTest(): void {
    cache.clear();
    newapiDbBlockedUntil = 0;
}

/** partial 帧的去向:SSE 还没开(报错缓冲窗口内)先攒着,开了以后直接发。 */
export interface NativePartialSink {
    buffered: JsonRecord[];
    emit: ((frame: JsonRecord) => void) | null;
}
export function createNativePartialSink(): NativePartialSink {
    return { buffered: [], emit: null };
}
function pushPartial(sink: NativePartialSink, frame: JsonRecord): void {
    if (sink.emit) sink.emit(frame);
    else sink.buffered.push(frame);
}

function parseSseBlock(block: string): JsonRecord | null {
    const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
    if (!data || data === '[DONE]') return null;
    try {
        const j = JSON.parse(data) as unknown;
        return j && typeof j === 'object' ? (j as JsonRecord) : null;
    } catch {
        return null;
    }
}

/**
 * 上游(new-api)对 stream:true 回的 SSE → 折回非流式 JSON Response。
 * 读流期间每遇到 `*.partial_image` 就交给 sink(实时转给客户);`*.completed` 折成
 * `{ created, data:[{b64_json|url}], usage, size, quality, background, output_format }`;流内 `error` → 500 + error 体
 * (交给下游的错误归一)。流正常结束却没有 completed → 502。
 * 不是 2xx 的 SSE(非 2xx 或 content-type 不是 event-stream)原样返回,调用方按非流式处理。
 */
export async function collapseImageSse(upstream: Response, sink: NativePartialSink): Promise<Response> {
    const ct = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok || !ct.includes('text/event-stream') || !upstream.body) return upstream;

    const headers = new Headers(upstream.headers);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
    headers.delete('content-encoding');
    const json = (body: JsonRecord, status: number): Response =>
        new Response(JSON.stringify(body), { status, headers });

    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let completed: JsonRecord | null = null;
    let error: unknown = null;
    const handle = (block: string): void => {
        const d = parseSseBlock(block);
        if (!d) return;
        const type = typeof d.type === 'string' ? d.type : '';
        if (type.endsWith('.partial_image')) pushPartial(sink, d);
        else if (type.endsWith('.completed')) completed = d;
        else if (type === 'error' || d.error) error = d.error ?? d;
    };
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
            handle(buf.slice(0, i));
            buf = buf.slice(i + 2);
        }
    }
    if (buf.trim()) handle(buf);

    const c = completed as JsonRecord | null;
    if (c) {
        const item: JsonRecord = {};
        if (typeof c.b64_json === 'string' && c.b64_json) item.b64_json = c.b64_json;
        if (typeof c.url === 'string' && c.url) item.url = c.url;
        const out: JsonRecord = { created: c.created_at ?? Math.floor(Date.now() / 1000), data: [item] };
        for (const k of ['usage', 'size', 'quality', 'background', 'output_format']) {
            if (c[k] !== undefined && c[k] !== null) out[k] = c[k];
        }
        return json(out, 200);
    }
    if (error) return json({ error: error as JsonRecord }, 500);
    return json(
        {
            error: {
                message: 'upstream stream ended without a completed image',
                type: 'server_error',
                param: null,
                code: null,
            },
        },
        502,
    );
}
