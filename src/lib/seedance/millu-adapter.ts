/**
 * millu(agent.millu.tv)视频线 —— 「火山」渠道的第三家 provider(2026-11-25 接入)。
 *
 * 上游对齐【火山方舟官方 contents/generations/tasks】契约,与筷子线同构,所以提交 / 轮询直接复用
 * kuaizi-adapter.ts 的 client(只换 base / 路径 / 日志名),本文件只放 millu 自己的常量与差异:
 *   提交 POST {BASE}/api/v3/contents/generations/tasks        → { id: "cgt-…" }
 *   轮询 GET  {BASE}/api/v3/contents/generations/tasks/{id}   → 方舟原生任务体
 *   鉴权 Authorization: Bearer <sk-{64hex}>
 *
 * 实测(2026-11-24/25,四档各一条 480p/5s 真金任务 + 一条 asset:// 参考图任务,全部 succeeded):
 *  - 【四档全落真火山方舟(cn-beijing)】受理号直接就是方舟号 `cgt-YYYYMMDDHHMMSS-xxxxx`;查询体 `model`
 *    回显方舟原名(doubao-seedance-2-0-260128 等),成片是 ark-acg-maas-cn-beijing.tos-cn-beijing.volces.com
 *    签名直链(24h);token 数与方舟一致(2.0 系 480p 5s = 50638,2.5 = 48437)。
 *  - 【模型名是 millu 自己的别名】`millu-sd-…-260801`,传方舟原名 → 404 ModelNotFound。别名可能按 key /
 *    套餐变化 → env 可覆盖(ENTERPRISE_MILLU_MODEL_*)。
 *  - 【对客任务号 = 方舟真号】别家线对客号是我们自造的 cgt-;这家受理号本身就是真号,直接给客户。
 *    映射表仍记一行(对客号 → `millu:` + 同号)—— 线标是轮询分流的依据(裸 cgt- 在老逻辑里会被当成
 *    「远古筷子任务」兜底还原成 kz-cgt-),也让 rememberVolcId 的「两号相同不落行」不吞掉它。
 *  - 【错误信封】`{error:{code,message}}`(401 INVALID_API_KEY / 404 NotFound / 404 ModelNotFound),
 *    passthroughUpstreamError 已能解。
 *  - 无取消端点(DELETE …/tasks/{id} 实测 404 page not found;与另两家一致按不支持处理)。
 *  - 直传公网图片 URL(first_frame / reference_image)+ seed / watermark / return_last_frame 实测可用
 *    (480p 4s = 40594 token,与筷子 / svcinf 时代逐字一致)。
 *  - 素材库(api.millu.tv /v1/materials/aigc/*,真·方舟虚拟人像库)本期【不接】:volc 客户维持平台素材库,
 *    `asset://` 由 proxy 解析成 R2 直链发上游。
 *
 * env(lazy 读):
 *   ENTERPRISE_MILLU_BASE_URL   缺省 https://agent.millu.tv
 *   ENTERPRISE_MILLU_KEY        平台 key(sk-{64hex})
 *   ENTERPRISE_MILLU_MODEL_{PRO,FAST,MINI,25}  上游模型别名覆盖
 */
import 'server-only';
import type { KuaiziConfig } from './kuaizi-adapter';
import type { SeedanceVariant } from './cn-adapter';

export const MILLU_DEFAULT_BASE = 'https://agent.millu.tv';
const MILLU_TASKS_PATH = '/api/v3/contents/generations/tasks';

/** 映射表里 millu 任务上游号的线标(对客号 cgt-X ↔ `millu:cgt-X`)。 */
export const MILLU_MAP_PREFIX = 'millu:';

/** millu key 形态:`sk-` + 64 位 hex(与 svcinf 的 `sk-inf-…` 不相撞)。 */
const MILLU_KEY_RE = /^sk-[0-9a-f]{64}$/;

export function isMilluKey(v: unknown): v is string {
    return typeof v === 'string' && MILLU_KEY_RE.test(v);
}

export function isMilluMappedId(v: unknown): v is string {
    return typeof v === 'string' && v.startsWith(MILLU_MAP_PREFIX);
}

export function toMilluMappedId(arkId: string): string {
    return MILLU_MAP_PREFIX + arkId;
}

export function fromMilluMappedId(mapped: string): string {
    return mapped.slice(MILLU_MAP_PREFIX.length);
}

/** millu 线配置 —— 形状即 kuaizi client 的 config(同一套 submit / poll)。 */
export function getMilluConfig(overrideKey?: string): KuaiziConfig | null {
    const key = overrideKey || process.env.ENTERPRISE_MILLU_KEY;
    if (!key) return null;
    return {
        base: (process.env.ENTERPRISE_MILLU_BASE_URL || MILLU_DEFAULT_BASE).replace(/\/$/, ''),
        key,
        tasksPath: MILLU_TASKS_PATH,
        name: 'millu',
        arkNativeId: true,
    };
}

const MILLU_MODEL_DEFAULTS: Partial<Record<SeedanceVariant, { env: string; model: string }>> = {
    pro: { env: 'ENTERPRISE_MILLU_MODEL_PRO', model: 'millu-sd-x-2-0-260801' },
    fast: { env: 'ENTERPRISE_MILLU_MODEL_FAST', model: 'millu-sd-2-0-fast-260801' },
    mini: { env: 'ENTERPRISE_MILLU_MODEL_MINI', model: 'millu-sd-2-0-mini-260801' },
    '2.5': { env: 'ENTERPRISE_MILLU_MODEL_25', model: 'millu-sd-x-2-5-260801' },
};

/** 档位 → 发给 millu 的模型别名(env 覆盖优先)。 */
export function milluModelName(variant: SeedanceVariant): string | null {
    const d = MILLU_MODEL_DEFAULTS[variant];
    if (!d) return null;
    return process.env[d.env]?.trim() || d.model;
}
