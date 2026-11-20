/**
 * 伪流式 partial_image 帧计费(2026-11-20,operator 决定按官方口径收)。
 *
 * 官方:每个 partial 帧额外计 100 个 image output token。我们的伪流式在 /v1 代理层合成(上游恒走非流),
 * 而计费由适配器合成的 usage 决定 —— 代理层要把「实际发了几帧」告诉适配器。
 *
 * 通道选 `user` 字段尾部的内部标记,不用独立 body 字段:请求经 new-api 也可能落到直连官 key 渠道,
 * 2026-11-20 实测 ch325 对不带 stream 的 `partial_images` 回 400「Partial images are only supported with
 * streaming.」,未知字段同理有被拒风险;`user` 是官方自由字符串,所有上游都收。适配器读到标记后剥掉再发上游;
 * 直连渠道原样收到带标记的 user(无害),那些渠道按上游真实 usage 计费、不加 partial。
 */

/** 官方:每个 partial 帧 +100 image output token。 */
export const PARTIAL_IMAGE_OUTPUT_TOKENS = 100;

const TAG_RE = /;sr-partial=(\d+)$/;

/** 去掉 user 尾部的标记(客户自己塞的也剥,防伪造计费标记)。 */
export function stripPartialTag(user: string): string {
    let u = user;
    while (TAG_RE.test(u)) u = u.replace(TAG_RE, '');
    return u;
}

/** 代理层:给 user 打上帧数标记(frames ≤ 0 → 只剥不打)。 */
export function tagPartialFrames(user: string, frames: number): string {
    const base = stripPartialTag(user);
    return frames > 0 ? `${base};sr-partial=${Math.min(3, Math.floor(frames))}` : base;
}

/** 适配器层:取出帧数并把 extras.user 还原(还原后为空 → 删掉该字段,不发上游)。无标记 → 0。 */
export function takePartialFrames(extras: Record<string, string>): number {
    const user = extras.user;
    if (typeof user !== 'string') return 0;
    const m = TAG_RE.exec(user);
    if (!m) return 0;
    const rest = stripPartialTag(user);
    if (rest) extras.user = rest;
    else delete extras.user;
    const n = Number(m[1]);
    return n >= 1 && n <= 3 ? n : 0;
}

/** 把 partial 帧的 token 加进官方形 usage(output / output.image_tokens / total 各加 100×帧数)。 */
export function addPartialUsage(usage: Record<string, unknown>, frames: number): void {
    if (frames <= 0) return;
    const add = frames * PARTIAL_IMAGE_OUTPUT_TOKENS;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    usage.output_tokens = num(usage.output_tokens) + add;
    usage.total_tokens = num(usage.total_tokens) + add;
    const details = usage.output_tokens_details;
    if (details && typeof details === 'object') {
        const d = details as Record<string, unknown>;
        d.image_tokens = num(d.image_tokens) + add;
    }
}
