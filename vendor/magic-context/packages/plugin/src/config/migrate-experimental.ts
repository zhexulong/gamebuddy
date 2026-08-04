/**
 * Startup-time shim for graduated experimental features (shared OpenCode + Pi).
 *
 * Features have graduated out of the `experimental.*` namespace across releases:
 *  - v0.14: `experimental.user_memories` / `experimental.pin_key_files` →
 *    `dreamer.user_memories` / `dreamer.pin_key_files`.
 *  - this release: `experimental.temporal_awareness` / `caveman_text_compression`
 *    → top-level keys; `experimental.auto_search` / `git_commit_indexing` →
 *    `memory.auto_search` / `memory.git_commit_indexing`.
 *
 * Doctor runs an on-disk migration, but users who never run doctor would
 * otherwise lose their opt-in/opt-out because the graduated keys are no longer
 * in the schema — Zod silently strips unknown keys. This shim runs in-memory on
 * every load: if the user has legacy `experimental.<graduated-key>` blocks, it
 * reshapes the raw config so the new schema sees them at their graduated path.
 * The on-disk file stays untouched (doctor is the tool that cleans it up), and
 * the user's explicit intent is preserved for this session's runtime behavior.
 *
 * Primitive values (e.g., `experimental.user_memories: true`) are coerced to
 * `{ enabled: <bool> }` object form so Zod accepts them. Without this coercion,
 * the primitive would fail schema validation and fall back to the graduated
 * default — silently flipping a user's explicit `false` to the new `true`
 * default, or vice versa.
 *
 * Idempotent: if the destination path already has a value, the destination wins
 * (the user has started graduating), merging sub-fields so nothing is lost.
 */
export function migrateLegacyExperimental(
    rawConfig: Record<string, unknown>,
    warnings: string[],
): Record<string, unknown> {
    const experimental = rawConfig.experimental;
    if (typeof experimental !== "object" || experimental === null) {
        return rawConfig;
    }
    const exp = experimental as Record<string, unknown>;
    const hasUM = "user_memories" in exp;
    const hasPKF = "pin_key_files" in exp;
    // Graduated out of the (now retired) `experimental.*` namespace.
    //  - temporal_awareness / caveman_text_compression → top-level config keys.
    //  - auto_search / git_commit_indexing → under `memory.*` (recall features).
    const TOP_LEVEL_GRADUATED = ["temporal_awareness", "caveman_text_compression"] as const;
    const MEMORY_GRADUATED = ["auto_search", "git_commit_indexing"] as const;
    const hasGraduated =
        TOP_LEVEL_GRADUATED.some((k) => k in exp) || MEMORY_GRADUATED.some((k) => k in exp);
    if (!hasUM && !hasPKF && !hasGraduated) {
        return rawConfig;
    }

    // Clone shallowly — we only mutate the experimental + dreamer + memory branches.
    const patched: Record<string, unknown> = { ...rawConfig };
    const dreamer =
        typeof patched.dreamer === "object" && patched.dreamer !== null
            ? { ...(patched.dreamer as Record<string, unknown>) }
            : ({} as Record<string, unknown>);
    const memory =
        typeof patched.memory === "object" && patched.memory !== null
            ? { ...(patched.memory as Record<string, unknown>) }
            : ({} as Record<string, unknown>);
    const newExperimental = { ...exp };

    // Relocate a graduated flag from experimental.* to its new home. The
    // destination value wins when both exist (the user already graduated); for
    // object-shaped flags we merge sub-fields so partial destination settings
    // (e.g. only score_threshold) don't drop the old enabled state. A primitive
    // destination value (e.g. temporal_awareness, or a shorthand like
    // `auto_search: true`) wins as-is.
    const relocate = (key: string, dest: Record<string, unknown>, destLabel: string): void => {
        if (!(key in exp)) return;
        const oldValue = exp[key];
        const existing = dest[key];
        if (existing === undefined) {
            dest[key] = oldValue;
            warnings.push(
                `Migrated "experimental.${key}" → "${destLabel}${key}" in-memory (run \`doctor\` to persist).`,
            );
        } else if (
            typeof oldValue === "object" &&
            oldValue !== null &&
            typeof existing === "object" &&
            existing !== null
        ) {
            dest[key] = {
                ...(oldValue as Record<string, unknown>),
                ...(existing as Record<string, unknown>),
            };
        }
        delete newExperimental[key];
    };
    for (const key of TOP_LEVEL_GRADUATED) relocate(key, patched, "");
    for (const key of MEMORY_GRADUATED) relocate(key, memory, "memory.");

    const coerceToObject = (value: unknown): Record<string, unknown> | undefined => {
        if (typeof value === "boolean") {
            return { enabled: value };
        }
        if (typeof value === "object" && value !== null) {
            return { ...(value as Record<string, unknown>) };
        }
        return undefined;
    };

    if (hasUM) {
        const oldUM = coerceToObject(exp.user_memories);
        if (oldUM !== undefined) {
            if (dreamer.user_memories === undefined) {
                dreamer.user_memories = oldUM;
                warnings.push(
                    'Migrated "experimental.user_memories" → "dreamer.user_memories" in-memory (run `doctor` to persist).',
                );
            } else if (
                typeof dreamer.user_memories === "object" &&
                dreamer.user_memories !== null
            ) {
                // Both exist: dreamer.* wins (user has graduated), but fill
                // in any sub-fields that only exist on the old block so
                // explicit settings like promotion_threshold aren't lost.
                dreamer.user_memories = {
                    ...oldUM,
                    ...(dreamer.user_memories as Record<string, unknown>),
                };
            }
        }
        delete newExperimental.user_memories;
    }

    if (hasPKF) {
        const oldPKF = coerceToObject(exp.pin_key_files);
        if (oldPKF !== undefined) {
            if (dreamer.pin_key_files === undefined) {
                dreamer.pin_key_files = oldPKF;
                warnings.push(
                    'Migrated "experimental.pin_key_files" → "dreamer.pin_key_files" in-memory (run `doctor` to persist).',
                );
            } else if (
                typeof dreamer.pin_key_files === "object" &&
                dreamer.pin_key_files !== null
            ) {
                dreamer.pin_key_files = {
                    ...oldPKF,
                    ...(dreamer.pin_key_files as Record<string, unknown>),
                };
            } else if (typeof dreamer.pin_key_files === "boolean") {
                dreamer.pin_key_files = { ...oldPKF, enabled: dreamer.pin_key_files };
            }
        }
        delete newExperimental.pin_key_files;
    }

    patched.experimental = newExperimental;
    patched.dreamer = dreamer;
    // Only attach `memory` if the relocation actually populated it (or it already
    // existed) so we don't synthesize an empty memory block for configs that only
    // migrated top-level/dreamer keys.
    if (Object.keys(memory).length > 0) {
        patched.memory = memory;
    }
    return patched;
}
