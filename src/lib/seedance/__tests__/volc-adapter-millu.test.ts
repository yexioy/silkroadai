/** 「火山」渠道 millu 线单测(2026-11-25 接入):方舟官方契约直通 —— 提交 / 轮询 / 映射线标 / 样片出正片 / key 形态。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerVolcUpstreamKey, pollVolcVideo, submitVolcVideo, volcProvider } from '../volc-adapter';
import { rememberVolcId, toUpstreamTask } from '@/lib/enterprise/volc-id-map';

vi.mock('@/lib/enterprise/volc-id-map', () => ({
    rememberVolcId: vi.fn(async () => {}),
    toUpstreamTask: vi.fn(async (id: string) => ({ upstreamId: `millu:${id}`, apiVersion: null })),
}));

const BASE = 'http://millu.test';
const KEY = `sk-${'a'.repeat(64)}`;
const CUST_KEY = `sk-${'b'.repeat(64)}`;
const TASKS = `${BASE}/api/v3/contents/generations/tasks`;
const ARK_ID = 'cgt-20261124161906-sniok';

/** 真实上游完成态原文(2026-11-24 实测,签名串截短)。 */
const DONE = {
    content: {
        video_url:
            'https://ark-acg-maas-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0-mini/0217.mp4?X-Tos-Expires=86400',
    },
    created_at: 1795508346,
    draft: false,
    duration: 5,
    execution_expires_after: 172800,
    framespersecond: 24,
    generate_audio: true,
    id: ARK_ID,
    model: 'doubao-seedance-2-0-mini-260615',
    output_format: 'mp4',
    priority: 0,
    ratio: '16:9',
    resolution: '480p',
    seed: 74109,
    service_tier: 'default',
    status: 'succeeded',
    updated_at: 1795508421,
    usage: { completion_tokens: 50638, total_tokens: 50638 },
};

beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(rememberVolcId).mockClear();
    vi.stubEnv('ENTERPRISE_VOLC_PROVIDER', 'millu');
    vi.stubEnv('ENTERPRISE_MILLU_BASE_URL', BASE);
    vi.stubEnv('ENTERPRISE_MILLU_KEY', KEY);
});
afterEach(() => vi.unstubAllEnvs());

const opts = (over: Partial<Parameters<typeof submitVolcVideo>[1]> = {}) => ({
    clientModel: 'doubao-seedance-2.0',
    resolution: '720p' as const,
    duration: 5,
    ...over,
});

const mockSubmit = () =>
    vi
        .spyOn(global, 'fetch')
        .mockImplementation(async () => new Response(JSON.stringify({ id: ARK_ID }), { status: 200 }));

describe('volcProvider', () => {
    it('millu / svcinf 显式选;其余(含缺省、乱填)= kuaizi', () => {
        expect(volcProvider()).toBe('millu');
        vi.stubEnv('ENTERPRISE_VOLC_PROVIDER', ' MILLU ');
        expect(volcProvider()).toBe('millu');
        vi.stubEnv('ENTERPRISE_VOLC_PROVIDER', 'svcinf');
        expect(volcProvider()).toBe('svcinf');
        vi.stubEnv('ENTERPRISE_VOLC_PROVIDER', 'whatever');
        expect(volcProvider()).toBe('kuaizi');
    });
});

describe('submitVolcVideo(millu)', () => {
    it('打方舟官方路径 + Bearer key,model 换成 millu 别名;对客号 = 上游方舟真号,映射行带 millu: 线标', async () => {
        const fetchMock = mockSubmit();
        const res = await submitVolcVideo({ prompt: '一只猫', ratio: '16:9' }, opts());
        expect(res.status).toBe(200);
        const j = (await res.json()) as { id: string; task_id: string; model: string; status: string };
        expect(j.id).toBe(ARK_ID);
        expect(j.task_id).toBe(ARK_ID);
        expect(j.model).toBe('doubao-seedance-2.0'); // 不泄露上游别名
        expect(j.status).toBe('queued');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(TASKS);
        expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
        const sent = JSON.parse((init as RequestInit).body as string);
        expect(sent.model).toBe('millu-sd-x-2-0-260801');
        expect(sent.resolution).toBe('720p');
        expect(sent.content).toEqual([{ type: 'text', text: '一只猫' }]);
        expect(rememberVolcId).toHaveBeenCalledWith(ARK_ID, `millu:${ARK_ID}`, 'task', undefined, undefined);
    });

    it('四档各自的 millu 别名;env 可按档位覆盖', async () => {
        const cases: Array<[string, string]> = [
            ['doubao-seedance-2.0', 'millu-sd-x-2-0-260801'],
            ['doubao-seedance-2.0-fast', 'millu-sd-2-0-fast-260801'],
            ['doubao-seedance-2.0-mini', 'millu-sd-2-0-mini-260801'],
            ['doubao-seedance-2.5', 'millu-sd-x-2-5-260801'],
        ];
        for (const [client, upstream] of cases) {
            const fetchMock = mockSubmit();
            await submitVolcVideo({ prompt: 'x' }, opts({ clientModel: client, resolution: '480p' }));
            expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).model).toBe(upstream);
            fetchMock.mockRestore();
        }
        vi.stubEnv('ENTERPRISE_MILLU_MODEL_25', 'millu-sd-x-2-5-270101');
        const fetchMock = mockSubmit();
        await submitVolcVideo({ prompt: 'x' }, opts({ clientModel: 'doubao-seedance-2.5' }));
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).model).toBe(
            'millu-sd-x-2-5-270101',
        );
    });

    it('客户自带 millu key 优先;kz- / sk-inf- key 在 millu 线回落平台 key', async () => {
        let fetchMock = mockSubmit();
        await submitVolcVideo({ prompt: 'x' }, opts({ upstreamKey: CUST_KEY }));
        expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
            Authorization: `Bearer ${CUST_KEY}`,
        });
        fetchMock.mockRestore();
        for (const foreign of ['kz-abc', 'sk-inf-v1-abc']) {
            fetchMock = mockSubmit();
            await submitVolcVideo({ prompt: 'x' }, opts({ upstreamKey: foreign }));
            expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
                Authorization: `Bearer ${KEY}`,
            });
            fetchMock.mockRestore();
        }
    });

    it('customerVolcUpstreamKey:认 sk-{64hex};普通占位符 / 形态不对的 sk- 一律 undefined', () => {
        expect(customerVolcUpstreamKey(CUST_KEY)).toBe(CUST_KEY);
        expect(customerVolcUpstreamKey('sk-placeholder')).toBeUndefined();
        expect(customerVolcUpstreamKey(`sk-${'A'.repeat(64)}`)).toBeUndefined();
    });

    it('未配 ENTERPRISE_MILLU_KEY → 503,不打上游(即使筷子 key 在)', async () => {
        vi.stubEnv('ENTERPRISE_MILLU_KEY', '');
        vi.stubEnv('ENTERPRISE_KUAIZI_KEY', 'kz-x');
        const fetchMock = vi.spyOn(global, 'fetch');
        const res = await submitVolcVideo({ prompt: 'x' }, opts());
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('上游报错(模型无权 404)→ 透传状态码与原文,不带上游身份', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    error: { code: 'ModelNotFound', message: '请求的模型 ID 不存在、未启用或当前账号无权使用' },
                }),
                { status: 404 },
            ),
        );
        const res = await submitVolcVideo({ prompt: 'x' }, opts());
        expect(res.status).toBe(404);
        const text = JSON.stringify(await res.json());
        expect(text).toContain('模型 ID 不存在');
        expect(text).not.toMatch(/millu/i);
    });

    it('draft_task:millu 线样片 → 剥线标得方舟真号,不额外打上游查询', async () => {
        const fetchMock = mockSubmit();
        const res = await submitVolcVideo(
            { content: [{ type: 'draft_task', draft_task: { id: 'cgt-20261124000000-draft' } }] },
            opts({ clientModel: 'doubao-seedance-2.5' }),
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.content).toEqual([{ type: 'draft_task', draft_task: { id: 'cgt-20261124000000-draft' } }]);
        expect(sent.duration).toBeUndefined();
    });

    it('draft_task:样片建在别家线(kz-cgt-)→ 400 指引重出样片,不提交', async () => {
        vi.mocked(toUpstreamTask).mockResolvedValueOnce({ upstreamId: 'kz-cgt-old', apiVersion: null });
        const fetchMock = vi.spyOn(global, 'fetch');
        const res = await submitVolcVideo(
            { content: [{ type: 'draft_task', draft_task: { id: 'cgt-old' } }] },
            opts({ clientModel: 'doubao-seedance-2.5' }),
        );
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toContain('重新生成样片');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('pollVolcVideo(millu)', () => {
    it('映射带 millu: 线标 → 打 millu(与当前提交 provider 无关),归一形透出方舟字段', async () => {
        vi.stubEnv('ENTERPRISE_VOLC_PROVIDER', 'kuaizi');
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(DONE)));
        const res = await pollVolcVideo(ARK_ID);
        expect(fetchMock.mock.calls[0][0]).toBe(`${TASKS}/${ARK_ID}`);
        const j = (await res.json()) as Record<string, unknown>;
        expect(j.id).toBe(ARK_ID);
        expect(j.status).toBe('completed');
        expect(j.video_url).toBe(DONE.content.video_url);
        expect(j.usage).toEqual(DONE.usage);
        expect(j.last_frame_url).toBe('');
        expect(j).toMatchObject({
            duration: 5,
            ratio: '16:9',
            resolution: '480p',
            framespersecond: 24,
            generate_audio: true,
            execution_expires_after: 172800,
            seed: 74109,
            output_format: 'mp4',
            service_tier: 'default',
            upstream_created_at: 1795508346,
            upstream_updated_at: 1795508421,
        });
        // 上游回显的方舟模型原名不进归一形(对客模型名由上层按库行回显)
        expect(j.model).toBeUndefined();
    });

    it('映射行缺失 + 当前线是 millu → 对客号即方舟真号,直接查 millu(不走 kz-cgt- 兜底)', async () => {
        vi.mocked(toUpstreamTask).mockResolvedValueOnce({ upstreamId: ARK_ID, apiVersion: null });
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(DONE)));
        await pollVolcVideo(ARK_ID);
        expect(fetchMock.mock.calls[0][0]).toBe(`${TASKS}/${ARK_ID}`);
    });

    it('映射行缺失 + 当前线是筷子 → 仍按远古筷子任务兜底成 kz-cgt-', async () => {
        vi.stubEnv('ENTERPRISE_VOLC_PROVIDER', 'kuaizi');
        vi.stubEnv('ENTERPRISE_KUAIZI_KEY', 'kz-x');
        vi.stubEnv('ENTERPRISE_KUAIZI_BASE_URL', 'http://kz.test');
        vi.mocked(toUpstreamTask).mockResolvedValueOnce({ upstreamId: 'cgt-old', apiVersion: null });
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ status: 'running' })));
        await pollVolcVideo('cgt-old');
        expect(String(fetchMock.mock.calls[0][0])).toContain('http://kz.test');
        expect(String(fetchMock.mock.calls[0][0])).toContain('kz-cgt-old');
    });

    it('running → in_progress;failed → fail_reason 取方舟 error.message', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify({ id: ARK_ID, status: 'running', created_at: 1, updated_at: 1 })),
        );
        expect(((await (await pollVolcVideo(ARK_ID)).json()) as { status: string }).status).toBe('in_progress');
        vi.spyOn(global, 'fetch').mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    id: ARK_ID,
                    status: 'failed',
                    error: { code: 'InputTextSensitiveContentDetected', message: 'The request failed because …' },
                }),
            ),
        );
        const j = (await (await pollVolcVideo(ARK_ID)).json()) as { status: string; fail_reason: string };
        expect(j.status).toBe('failed');
        expect(j.fail_reason).toContain('The request failed');
    });

    it('任务不存在 404 → 透传状态码(纯错误体,不终态化)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ error: { code: 'NotFound', message: 'generation job not found' } }), {
                status: 404,
            }),
        );
        expect((await pollVolcVideo(ARK_ID)).status).toBe(404);
    });

    it('millu 线未配置 → 503', async () => {
        vi.stubEnv('ENTERPRISE_MILLU_KEY', '');
        expect((await pollVolcVideo(ARK_ID)).status).toBe(503);
    });
});
