import { describe, expect, it } from 'vitest';
import { addPartialUsage, stripPartialTag, tagPartialFrames, takePartialFrames } from '../partial-billing';

describe('partial-billing(伪流式 partial 帧计费标记)', () => {
    it('tag / strip:追加在 user 尾部,重复标记全部剥掉,frames ≤ 0 只剥不打', () => {
        expect(tagPartialFrames('', 2)).toBe(';sr-partial=2');
        expect(tagPartialFrames('u1', 3)).toBe('u1;sr-partial=3');
        expect(tagPartialFrames('u1;sr-partial=3;sr-partial=3', 1)).toBe('u1;sr-partial=1');
        expect(tagPartialFrames('u1;sr-partial=3', 0)).toBe('u1');
        expect(stripPartialTag('a;sr-partial=2;b')).toBe('a;sr-partial=2;b'); // 只认尾部
    });

    it('take:取帧数并还原 user;空 user 删字段;无标记 / 越界 → 0', () => {
        const a = { user: 'u1;sr-partial=2' };
        expect(takePartialFrames(a)).toBe(2);
        expect(a.user).toBe('u1');
        const b: Record<string, string> = { user: ';sr-partial=3' };
        expect(takePartialFrames(b)).toBe(3);
        expect('user' in b).toBe(false);
        expect(takePartialFrames({ user: 'u1' })).toBe(0);
        expect(takePartialFrames({})).toBe(0);
        const c: Record<string, string> = { user: 'u;sr-partial=9' };
        expect(takePartialFrames(c)).toBe(0);
        expect(c.user).toBe('u'); // 越界标记也不发上游
    });

    it('addPartialUsage:每帧 +100 到 output / output.image_tokens / total', () => {
        const u: Record<string, unknown> = {
            input_tokens: 8,
            output_tokens: 196,
            output_tokens_details: { image_tokens: 196, text_tokens: 0 },
            total_tokens: 204,
        };
        addPartialUsage(u, 2);
        expect(u).toEqual({
            input_tokens: 8,
            output_tokens: 396,
            output_tokens_details: { image_tokens: 396, text_tokens: 0 },
            total_tokens: 404,
        });
        addPartialUsage(u, 0);
        expect(u.output_tokens).toBe(396);
    });
});
