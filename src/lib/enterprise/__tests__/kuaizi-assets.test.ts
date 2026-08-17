/** 筷子开放平台素材库适配单测:Action 转发 + ApiKey 头 + 信封拆装 + 错误映射 + 开关。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleKuaiziAssetAction, kuaiziAssetsEnabled, KUAIZI_ASSET_ACTIONS } from '../kuaizi-assets';
import { RealPersonError } from '../real-person';

const BASE = 'http://kuaizi.test';
const KEY = 'kz-test-key';
const ENDPOINT = `${BASE}/ai-open-platform-api/api/support/v1/asset`;

const envelope = (result: unknown) => JSON.stringify({ ResponseMetadata: { RequestId: 'r1' }, Result: result });

beforeEach(() => {
    process.env.ENTERPRISE_KUAIZI_BASE_URL = BASE;
    process.env.ENTERPRISE_KUAIZI_KEY = KEY;
    vi.restoreAllMocks();
});
afterEach(() => {
    delete process.env.ENTERPRISE_KUAIZI_BASE_URL;
    delete process.env.ENTERPRISE_KUAIZI_KEY;
    delete process.env.ENTERPRISE_KUAIZI_ASSETS;
});

describe('kuaiziAssetsEnabled', () => {
    it('缺省关(平台库仍是唯一生效实现);置 1 才开', () => {
        expect(kuaiziAssetsEnabled()).toBe(false);
        process.env.ENTERPRISE_KUAIZI_ASSETS = '1';
        expect(kuaiziAssetsEnabled()).toBe(true);
    });
    it('接管 10 个火山素材 Action', () => {
        expect(KUAIZI_ASSET_ACTIONS.size).toBe(10);
        expect(KUAIZI_ASSET_ACTIONS.has('CreateAsset')).toBe(true);
        expect(KUAIZI_ASSET_ACTIONS.has('ListAssetGroups')).toBe(true);
        // 真人认证不归素材库接管
        expect(KUAIZI_ASSET_ACTIONS.has('CreateVisualValidateSession')).toBe(false);
    });
});

describe('handleKuaiziAssetAction', () => {
    it('CreateAsset:打 Action 单入口 + ApiKey 头(非 Bearer),AssetType 归一 Title-case,只返 Id', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(envelope({ Id: '1800657071180349888' }), { status: 200 }));
        const r = await handleKuaiziAssetAction('CreateAsset', {
            GroupId: '1800657071180349525',
            URL: 'https://cdn.test/a.jpg',
            AssetType: 'image',
            Name: '封面图',
        });
        expect(r).toEqual({ Id: '1800657071180349888' });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${ENDPOINT}?Action=CreateAsset&Version=2024-01-01`);
        expect((init as RequestInit).headers).toMatchObject({ ApiKey: KEY });
        expect((init as RequestInit).headers).not.toHaveProperty('Authorization');
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({
            GroupId: '1800657071180349525',
            URL: 'https://cdn.test/a.jpg',
            AssetType: 'Image',
            Name: '封面图',
        });
    });

    it('ListAssets:平铺 GroupId 归一成 Filter.GroupIds;TotalCount → Total', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(envelope({ Items: [{ Id: '1' }], TotalCount: 1, PageNumber: 1, PageSize: 20 }), {
                status: 200,
            }),
        );
        const r = await handleKuaiziAssetAction('ListAssets', { GroupId: '1800657071180349525' });
        expect(r).toEqual({ Items: [{ Id: '1' }], Total: 1, PageNumber: 1, PageSize: 20 });
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.Filter).toEqual({ GroupIds: ['1800657071180349525'] });
        expect(sent.PageNumber).toBe(1);
    });

    it('UpdateAsset / DeleteAsset:回 {Id} / {},转发对应 Action', async () => {
        // 每次调用给一个全新 Response(body 只能消费一次)
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockImplementation(() => Promise.resolve(new Response(envelope({}), { status: 200 })));
        expect(await handleKuaiziAssetAction('UpdateAsset', { Id: '9', Name: '新名' })).toEqual({ Id: '9' });
        expect(await handleKuaiziAssetAction('DeleteAsset', { Id: '9' })).toEqual({});
        expect(fetchMock.mock.calls[0][0]).toContain('Action=UpdateAsset');
        expect(fetchMock.mock.calls[1][0]).toContain('Action=DeleteAsset');
    });

    it('上游 Error 信封 → RealPersonError(code/message 透传给客户)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    ResponseMetadata: { Error: { Code: 'ResourceNotFound', Message: '素材不存在' } },
                }),
                { status: 404 },
            ),
        );
        await expect(handleKuaiziAssetAction('GetAsset', { Id: '9' })).rejects.toMatchObject({
            status: 404,
            code: 'ResourceNotFound',
            message: '素材不存在',
        });
    });

    it('上游 401 = 平台凭证问题 → 502 且不把上游文案抛给客户', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({ ResponseMetadata: { Error: { Code: 'Unauthorized', Message: 'invalid ApiKey' } } }),
                {
                    status: 401,
                },
            ),
        );
        const e = await handleKuaiziAssetAction('ListAssets', {}).catch((x: RealPersonError) => x);
        expect((e as RealPersonError).status).toBe(502);
        expect((e as RealPersonError).message).not.toContain('ApiKey');
    });

    it('未配置 key → 503;上游不可达 → 503;非 JSON → 502', async () => {
        delete process.env.ENTERPRISE_KUAIZI_KEY;
        await expect(handleKuaiziAssetAction('ListAssets', {})).rejects.toMatchObject({ status: 503 });

        process.env.ENTERPRISE_KUAIZI_KEY = KEY;
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(handleKuaiziAssetAction('ListAssets', {})).rejects.toMatchObject({ status: 503 });

        vi.restoreAllMocks();
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
        await expect(handleKuaiziAssetAction('ListAssets', {})).rejects.toMatchObject({ status: 502 });
    });

    it('参数非法 → 400 InvalidParameter,不打上游', async () => {
        const fetchMock = vi.spyOn(global, 'fetch');
        await expect(handleKuaiziAssetAction('CreateAsset', { URL: 'https://x/a.jpg' })).rejects.toMatchObject({
            status: 400,
            code: 'InvalidParameter',
        });
        // 上游仅支持 AIGC 组类型
        await expect(
            handleKuaiziAssetAction('CreateAssetGroup', { Name: 'g', GroupType: 'LivenessFace' }),
        ).rejects.toMatchObject({ status: 400 });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('未知 Action → 400 InvalidAction', async () => {
        await expect(handleKuaiziAssetAction('Nope', {})).rejects.toMatchObject({
            status: 400,
            code: 'InvalidAction',
        });
    });
});
