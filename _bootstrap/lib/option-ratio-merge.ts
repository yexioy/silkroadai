/**
 * Pure helpers for merging per-model ratios into new-api's global
 * `ModelRatio` / `CompletionRatio` JSON in the `options` table.
 *
 * Background (gotcha #18, found 2026-05-06 W7 D2 maintenance window):
 * `channels` table has NO `model_ratio` / `completion_ratio` columns.
 * `PUT /api/channel/<id>` accepts those fields in the JSON body and
 * returns `success:true`, but silently DROPS them. Per-model ratios
 * actually live in the `options` table as JSON globals:
 *
 *   options.key='ModelRatio'       → JSON: { "<model_name>": <mr>, ... }
 *   options.key='CompletionRatio'  → JSON: { "<model_name>": <cr>, ... }
 *   options.key='ModelPrice'       → JSON for per-request fixed prices (unused here)
 *
 * To set per-model pricing, callers must:
 *   1. GET /api/option/  → find ModelRatio + CompletionRatio entries
 *   2. JSON.parse + merge in updates (overwriting same-key entries,
 *      preserving keys NOT in the update set)
 *   3. PUT /api/option/  with body { key: "ModelRatio", value: "<json>" }
 *
 * This module provides the pure step (2) + helpers around (1) and (3).
 * Splitting these out makes the merge logic unit-testable without
 * mocking fetch or the new-api server.
 */

/** A flat mapping of model name → number value (mr or cr). */
export type RatioMap = Record<string, number>;

/** Result of a merge — used for dry-run preview + post-write verification. */
export interface MergePlan {
    /** Final JSON to write back, dictionary form. */
    merged: RatioMap;
    /** Models whose value already matches the update (no-op rows). */
    unchanged: string[];
    /** Models whose existing value is being overwritten by the update. */
    overwritten: Array<{ model: string; oldValue: number; newValue: number }>;
    /** Models added (not previously in the global JSON). */
    added: Array<{ model: string; newValue: number }>;
    /** Models in the existing JSON but NOT in the update set; preserved
     *  unchanged. Surfaced for transparency; the merger never deletes. */
    preserved: string[];
}

/**
 * Merge `updates` into `current`, overwriting same-key entries and
 * preserving any current keys NOT in updates. Pure: no mutation of
 * `current` or `updates`; returns a new map.
 *
 * Rounding: values pass through unchanged. If the caller provided
 * `0.0463`, the merged JSON will contain `0.0463` (not e.g. `0.046`).
 * This means tiny floating-point representation noise is the caller's
 * concern.
 *
 * Throws if `currentJsonOrMap` is a string and isn't valid JSON.
 */
export function mergeRatioMap(
    currentJsonOrMap: string | RatioMap,
    updates: RatioMap,
): MergePlan {
    const current: RatioMap =
        typeof currentJsonOrMap === 'string'
            ? (JSON.parse(currentJsonOrMap) as RatioMap)
            : { ...currentJsonOrMap };

    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        throw new Error('mergeRatioMap: current must be a JSON object map');
    }

    const merged: RatioMap = { ...current };
    const unchanged: string[] = [];
    const overwritten: Array<{ model: string; oldValue: number; newValue: number }> = [];
    const added: Array<{ model: string; newValue: number }> = [];

    for (const [model, newValue] of Object.entries(updates)) {
        const existing = current[model];
        if (existing === undefined) {
            added.push({ model, newValue });
        } else if (existing === newValue) {
            unchanged.push(model);
            // skip the write to keep merged identical
            continue;
        } else {
            overwritten.push({ model, oldValue: existing, newValue });
        }
        merged[model] = newValue;
    }

    const updateKeys = new Set(Object.keys(updates));
    const preserved = Object.keys(current).filter((k) => !updateKeys.has(k));

    return { merged, unchanged, overwritten, added, preserved };
}

/**
 * Compare a freshly-fetched `/api/pricing` snapshot against the expected
 * per-model values; return any mismatches for caller to error/warn on.
 *
 * Tolerance is fixed at 1e-6 — covers float<->JSON round-trip noise but
 * catches any actual semantic mismatch.
 */
export interface PricingMismatch {
    model: string;
    field: 'model_ratio' | 'completion_ratio';
    expected: number;
    actual: number;
}

export function findPricingMismatches(
    pricingItems: Array<{ model_name: string; model_ratio: number; completion_ratio: number }>,
    expectedMr: RatioMap,
    expectedCr: RatioMap,
): PricingMismatch[] {
    const mismatches: PricingMismatch[] = [];
    const byModel = new Map(pricingItems.map((m) => [m.model_name, m]));

    for (const [model, expected] of Object.entries(expectedMr)) {
        const live = byModel.get(model);
        if (!live) {
            mismatches.push({ model, field: 'model_ratio', expected, actual: NaN });
            continue;
        }
        if (Math.abs(live.model_ratio - expected) > 1e-6) {
            mismatches.push({
                model,
                field: 'model_ratio',
                expected,
                actual: live.model_ratio,
            });
        }
    }
    for (const [model, expected] of Object.entries(expectedCr)) {
        const live = byModel.get(model);
        if (!live) {
            mismatches.push({ model, field: 'completion_ratio', expected, actual: NaN });
            continue;
        }
        if (Math.abs(live.completion_ratio - expected) > 1e-6) {
            mismatches.push({
                model,
                field: 'completion_ratio',
                expected,
                actual: live.completion_ratio,
            });
        }
    }
    return mismatches;
}
