/**
 * Seedance 海外满血 适配端点 — 装成 new-api 的 OpenAI-video 上游。
 *
 * 架构(见 seedance-overseas-adaptor-brief.md):
 *   客户 → portal /v1/video/generations → new-api(按 duration×ModelPrice 计费)
 *        → 本渠道(type=1, base_url=本适配器) → 本端点(翻译)
 *        → service-inference.ai 自定义 API → 回 OpenAI-video 形
 *
 * 计费完全由 new-api 按「请求 duration × ModelPrice × GroupRatio」算,与本适配器无关;
 * 本适配器只负责把 OpenAI-video 提交翻成 service-inference.ai 的 /v1/video/generate。
 *
 * 模型名编码分辨率(计费权威):dreamina-seedance-2-0-{480p,720p,1080p} / -fast-{480p,720p}。
 * Phase 1 仅文生(无参考图);参考图/首尾帧/音频(asset 上传流)留 Phase 2。
 *
 * Auth:Authorization(= new-api 渠道 key = sk-inf-...)原样转发给上游,key 不入代码/环境。
 * service-inference.ai 在 Cloudflare 后,默认 fetch UA 可能被 403 → 显式带浏览器 UA。
 */
import { NextRequest, NextResponse } from 'next/server';

const SVC_BASE = process.env.SEEDANCE_INFERENCE_BASE_URL || 'https://model.service-inference.ai';
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 客户/new-api 模型名 → service-inference.ai 真实 model + resolution 档(分辨率决定计费名)。 */
const MODEL_MAP: Record<string, { svc: string; resolution: string }> = {
    'dreamina-seedance-2-0-480p': { svc: 'dreamina-seedance-2-0-260128', resolution: '480p' },
    'dreamina-seedance-2-0-720p': { svc: 'dreamina-seedance-2-0-260128', resolution: '720p' },
    'dreamina-seedance-2-0-1080p': { svc: 'dreamina-seedance-2-0-260128', resolution: '1080p' },
    'dreamina-seedance-2-0-fast-480p': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '480p' },
    'dreamina-seedance-2-0-fast-720p': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '720p' },
};

const ALLOWED_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);

function err(status: number, code: string, message: string) {
    return NextResponse.json({ error: { code, message, type: 'seedance_adapter_error' } }, { status });
}

/** 从 OpenAI-video 请求里抽 prompt(兼容 prompt 字符串 / content 数组 / messages)。 */
function extractPrompt(body: Record<string, unknown>): string {
    if (typeof body.prompt === 'string') return body.prompt;
    const content = body.content;
    if (Array.isArray(content)) {
        return content
            .filter((c): c is { type: string; text: string } => {
                const o = c as { type?: unknown; text?: unknown };
                return o?.type === 'text' && typeof o?.text === 'string';
            })
            .map((c) => c.text)
            .join('\n');
    }
    const messages = body.messages;
    if (Array.isArray(messages)) {
        const lastUser = [...messages].reverse().find((m) => (m as { role?: string })?.role === 'user') as
            | { content?: unknown }
            | undefined;
        const mc = lastUser?.content;
        if (typeof mc === 'string') return mc;
        if (Array.isArray(mc)) {
            return mc
                .filter((c): c is { text: string } => (c as { type?: string })?.type === 'text')
                .map((c) => c.text)
                .join('\n');
        }
    }
    return '';
}

export async function POST(req: NextRequest) {
    const auth = req.headers.get('authorization') || '';
    // 轻量守门:本端点仅供 new-api 内部调用,key 必须是 service-inference.ai 的 sk-inf
    if (!/sk-inf-/.test(auth)) return err(401, 'unauthorized', 'invalid credentials for seedance adapter');

    let body: Record<string, unknown>;
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        return err(400, 'invalid_json', 'request body must be JSON');
    }

    const model = String(body.model || '');
    const map = MODEL_MAP[model];
    if (!map) return err(400, 'model_not_found', `unknown seedance model: ${model}`);

    const prompt = extractPrompt(body);
    if (!prompt) return err(400, 'invalid_request', 'prompt (text) is required');

    const durRaw = Number(body.duration);
    const duration = Number.isFinite(durRaw) && durRaw >= 1 ? Math.floor(durRaw) : 4;
    let ratio = String(body.ratio || body.aspect_ratio || '16:9');
    if (!ALLOWED_RATIOS.has(ratio)) ratio = '16:9';

    const svcBody = {
        model: map.svc,
        content: [{ type: 'text', text: prompt }],
        duration,
        resolution: map.resolution,
        ratio,
        generate_audio: body.generate_audio === true, // Phase 1 默认 false
        watermark: false,
    };

    console.log('[seedance-adapter] submit', { model, svc: map.svc, resolution: map.resolution, duration, ratio });

    let upstream: Response;
    try {
        upstream = await fetch(`${SVC_BASE}/v1/video/generate`, {
            method: 'POST',
            headers: {
                Authorization: auth,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': UA,
            },
            body: JSON.stringify(svcBody),
        });
    } catch (e) {
        return err(502, 'upstream_unreachable', `service-inference.ai unreachable: ${String(e)}`);
    }

    const text = await upstream.text();
    let j: { task?: { id?: string }; error?: unknown } | null;
    try {
        j = JSON.parse(text) as { task?: { id?: string } };
    } catch {
        j = null;
    }
    const taskId = j?.task?.id;
    if (!upstream.ok || !taskId) {
        console.warn('[seedance-adapter] submit failed', upstream.status, text.slice(0, 300));
        return err(
            upstream.status >= 400 ? upstream.status : 502,
            'upstream_error',
            String((j?.error as string) || text || 'submit failed').slice(0, 300),
        );
    }

    // OpenAI-video 提交响应形(new-api 据此存任务、后续轮询)
    return NextResponse.json(
        {
            id: taskId,
            task_id: taskId,
            object: 'video',
            model,
            status: 'queued',
            progress: 0,
            created_at: Math.floor(Date.now() / 1000),
        },
        { status: 200 },
    );
}
