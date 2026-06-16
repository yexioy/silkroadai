/**
 * Seedance 海外满血 适配端点 — 轮询(GET /seedance-adapter/v1/video/generations/{id})。
 * new-api 用提交时拿到的 task_id 轮询本端点;本端点查 service-inference.ai
 * /v1/video/tasks/{id},把状态/产物映射回 OpenAI-video 形。
 * 见 generations/route.ts 头部说明。
 */
import { NextRequest, NextResponse } from 'next/server';

const SVC_BASE = process.env.SEEDANCE_INFERENCE_BASE_URL || 'https://model.service-inference.ai';
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** service-inference.ai 状态 → OpenAI-video 状态。 */
function mapStatus(s: unknown): 'queued' | 'in_progress' | 'completed' | 'failed' {
    const x = String(s || '').toLowerCase();
    if (['completed', 'success', 'succeeded'].includes(x)) return 'completed';
    if (['failed', 'error', 'cancelled', 'canceled'].includes(x)) return 'failed';
    if (x === 'queued') return 'queued';
    return 'in_progress'; // pending / processing / in_progress / 未知 → 继续轮询
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const auth = req.headers.get('authorization') || '';

    let upstream: Response;
    try {
        upstream = await fetch(`${SVC_BASE}/v1/video/tasks/${encodeURIComponent(id)}`, {
            headers: { Authorization: auth, Accept: 'application/json', 'User-Agent': UA },
        });
    } catch (e) {
        return NextResponse.json(
            { error: { code: 'upstream_unreachable', message: String(e), type: 'seedance_adapter_error' } },
            { status: 502 },
        );
    }

    const text = await upstream.text();
    let j: { task?: Record<string, unknown> } | null;
    try {
        j = JSON.parse(text) as { task?: Record<string, unknown> };
    } catch {
        j = null;
    }
    const task = j?.task;
    if (!upstream.ok || !task) {
        return NextResponse.json(
            {
                error: {
                    code: 'upstream_error',
                    message: String(text || 'poll failed').slice(0, 300),
                    type: 'seedance_adapter_error',
                },
            },
            { status: upstream.status >= 400 ? upstream.status : 502 },
        );
    }

    const status = mapStatus(task.status);
    const outputs = Array.isArray(task.outputs) ? (task.outputs as unknown[]) : [];
    const videoUrl = typeof outputs[0] === 'string' ? (outputs[0] as string) : null;
    const failReason = task.error ? (typeof task.error === 'string' ? task.error : JSON.stringify(task.error)) : '';

    // OpenAI-video 轮询响应形:video_url 顶层 + data 兜底(new-api 不同版本取位置不一)
    return NextResponse.json(
        {
            id,
            task_id: id,
            object: 'video',
            model: task.model,
            status,
            progress: status === 'completed' || status === 'failed' ? 100 : 50,
            created_at: task.created_at ?? null,
            completed_at: task.completed_at ?? null,
            seconds: task.duration_seconds ?? null,
            video_url: videoUrl,
            data: videoUrl ? { video_url: videoUrl } : undefined,
            fail_reason: failReason || undefined,
        },
        { status: 200 },
    );
}
