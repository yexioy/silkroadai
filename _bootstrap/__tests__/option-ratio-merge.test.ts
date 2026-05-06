/**
 * Unit tests for the W7 D2 option-ratio merge helper. The helper is the
 * regression guard for gotcha #18 (channel PUT silently drops
 * model_ratio/completion_ratio fields; ratios must go through
 * /api/option/ JSON globals instead).
 */
import { describe, expect, it } from 'vitest';
import {
    mergeRatioMap,
    findPricingMismatches,
} from '../lib/option-ratio-merge';

describe('mergeRatioMap', () => {
    it('preserves keys not in the update set', () => {
        const current = { 'gpt-4': 5, 'claude-3': 3 };
        const updates = { 'gpt-5.5': 2.5 };
        const r = mergeRatioMap(current, updates);
        expect(r.merged).toEqual({ 'gpt-4': 5, 'claude-3': 3, 'gpt-5.5': 2.5 });
        expect(r.preserved.sort()).toEqual(['claude-3', 'gpt-4']);
        expect(r.added).toEqual([{ model: 'gpt-5.5', newValue: 2.5 }]);
    });

    it('overwrites same-key entries with new values', () => {
        const current = { 'claude-haiku-4-5': 37.5, 'claude-opus-4-7': 2.5 };
        const updates = { 'claude-haiku-4-5': 0.5, 'claude-opus-4-7': 2.5 };
        const r = mergeRatioMap(current, updates);
        expect(r.merged['claude-haiku-4-5']).toBe(0.5);
        expect(r.merged['claude-opus-4-7']).toBe(2.5);
        expect(r.overwritten).toEqual([
            { model: 'claude-haiku-4-5', oldValue: 37.5, newValue: 0.5 },
        ]);
        // claude-opus-4-7 already at 2.5 → unchanged, not overwritten
        expect(r.unchanged).toEqual(['claude-opus-4-7']);
    });

    it('adds new entries when keys are absent from current', () => {
        const r = mergeRatioMap({}, { 'gpt-5.5': 2.5, 'gpt-image-1.5': 4 });
        expect(r.added.map((x) => x.model).sort()).toEqual([
            'gpt-5.5',
            'gpt-image-1.5',
        ]);
        expect(r.merged['gpt-5.5']).toBe(2.5);
        expect(r.merged['gpt-image-1.5']).toBe(4);
    });

    it('accepts JSON string for `current` and parses it', () => {
        const json = JSON.stringify({ 'gpt-4': 5 });
        const r = mergeRatioMap(json, { 'gpt-5': 2 });
        expect(r.merged).toEqual({ 'gpt-4': 5, 'gpt-5': 2 });
    });

    it('does not mutate the input map', () => {
        const current = { 'gpt-4': 5 };
        const snap = JSON.stringify(current);
        mergeRatioMap(current, { 'gpt-5': 2 });
        expect(JSON.stringify(current)).toBe(snap);
    });

    it('throws on malformed JSON string', () => {
        expect(() => mergeRatioMap('{not json}', {})).toThrow();
    });

    it('throws when current parses to a non-object', () => {
        expect(() => mergeRatioMap('[1, 2]', {})).toThrow(/JSON object map/);
        expect(() => mergeRatioMap('null', {})).toThrow(/JSON object map/);
    });

    it('preserves float precision (no rounding)', () => {
        const r = mergeRatioMap({}, {
            'deepseek-ai/DeepSeek-V4-Flash': 0.024,
            'tencent/Hunyuan-A13B-Instruct': 0.024,
            'Qwen/Qwen3-VL-32B-Instruct': 0.0343,
            'Pro/zai-org/GLM-4.7': 0.072,
        });
        expect(r.merged['deepseek-ai/DeepSeek-V4-Flash']).toBe(0.024);
        expect(r.merged['Qwen/Qwen3-VL-32B-Instruct']).toBe(0.0343);
    });
});

describe('findPricingMismatches', () => {
    const liveSnapshot = [
        { model_name: 'claude-haiku-4-5', model_ratio: 0.5, completion_ratio: 5 },
        { model_name: 'gpt-5.5', model_ratio: 2.5, completion_ratio: 6 },
        { model_name: 'BAAI/bge-m3', model_ratio: 0, completion_ratio: 1 },
    ];

    it('returns [] when expected matches live', () => {
        const r = findPricingMismatches(
            liveSnapshot,
            { 'claude-haiku-4-5': 0.5, 'gpt-5.5': 2.5, 'BAAI/bge-m3': 0 },
            { 'claude-haiku-4-5': 5, 'gpt-5.5': 6, 'BAAI/bge-m3': 1 },
        );
        expect(r).toEqual([]);
    });

    it('flags mr mismatch', () => {
        const r = findPricingMismatches(
            liveSnapshot,
            { 'claude-haiku-4-5': 1.0 }, // expected 1.0, live 0.5
            {},
        );
        expect(r).toEqual([
            {
                model: 'claude-haiku-4-5',
                field: 'model_ratio',
                expected: 1.0,
                actual: 0.5,
            },
        ]);
    });

    it('flags missing model (live snapshot does not contain it)', () => {
        const r = findPricingMismatches(
            liveSnapshot,
            { 'gpt-99-nonexistent': 5 },
            {},
        );
        expect(r[0].field).toBe('model_ratio');
        expect(r[0].model).toBe('gpt-99-nonexistent');
        expect(Number.isNaN(r[0].actual)).toBe(true);
    });

    it('tolerates float noise within 1e-6', () => {
        const r = findPricingMismatches(
            [{ model_name: 'foo', model_ratio: 0.0463, completion_ratio: 3.7037 }],
            { foo: 0.0463 },
            { foo: 3.7037000001 }, // 1e-7 off — within tolerance
        );
        expect(r).toEqual([]);
    });

    it('catches > 1e-6 drift', () => {
        // Sub-tolerance drift — passes. Use 5e-7 to stay below the 1e-6
        // threshold even after IEEE 754 representation noise.
        const r = findPricingMismatches(
            [{ model_name: 'foo', model_ratio: 0.5, completion_ratio: 5 }],
            { foo: 0.5 + 5e-7 },
            {},
        );
        expect(r).toEqual([]);

        // Macroscopic drift — caught.
        const r2 = findPricingMismatches(
            [{ model_name: 'foo', model_ratio: 0.5, completion_ratio: 5 }],
            { foo: 0.5001 },
            {},
        );
        expect(r2).toHaveLength(1);
    });
});
