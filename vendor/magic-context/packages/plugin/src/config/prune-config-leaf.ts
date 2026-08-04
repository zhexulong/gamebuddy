/**
 * Immutable nested-config-leaf pruning for config recovery.
 *
 * When Zod validation flags an invalid nested field, recovery prunes just that
 * field and keeps valid siblings (so one bad value doesn't reset a whole block
 * and silently restore disabled behavior via schema defaults). The naive version
 * deleted the FIRST child under the top-level key (`path[1]`), which is wrong for
 * paths deeper than two levels: an invalid `memory.git_commit_indexing.since_days`
 * has `path = ["memory","git_commit_indexing","since_days"]`, and deleting
 * `path[1]` ("git_commit_indexing") drops the entire sub-block — losing a
 * user's `enabled: false` so the default `enabled: true` is restored.
 *
 * `pruneNestedConfigLeaf` walks the full path and removes only the deepest leaf,
 * deep-cloning each object along the way so sibling values (and the caller's
 * original object) are never mutated.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove a single nested leaf from `block`, given a path RELATIVE to it
 * (i.e. the Zod issue path with its top-level key sliced off). Returns the new
 * block plus the dotted label of the removed leaf, or null when the path can't
 * be fully navigated to an object that contains the leaf.
 */
export function pruneNestedConfigLeaf(
    block: Record<string, unknown>,
    relativePath: readonly PropertyKey[],
): { block: Record<string, unknown>; removed: string } | null {
    if (relativePath.length === 0) return null;

    const result: Record<string, unknown> = { ...block };
    let cursor = result;

    // Navigate to the parent of the leaf, cloning each intermediate object so
    // the original (and untouched siblings) are preserved.
    for (let i = 0; i < relativePath.length - 1; i++) {
        const seg = String(relativePath[i]);
        const child = cursor[seg];
        if (!isPlainObject(child)) {
            // The path descends into a non-object (e.g. an ARRAY element, like an
            // invalid `system_prompt_injection.skip_signatures[0]`). We can't reach
            // the deeper leaf — but we CAN prune the nearest OWNING field (the
            // array/primitive at `seg`) so it falls back to its schema default,
            // preserving valid siblings. Without this we'd return null → the whole
            // config collapses to all-defaults, dropping unrelated user settings.
            if (!(seg in cursor)) return null;
            delete cursor[seg];
            return {
                block: result,
                removed: relativePath
                    .slice(0, i + 1)
                    .map(String)
                    .join("."),
            };
        }
        const clonedChild: Record<string, unknown> = { ...child };
        cursor[seg] = clonedChild;
        cursor = clonedChild;
    }

    const leaf = String(relativePath[relativePath.length - 1]);
    if (!(leaf in cursor)) return null;
    delete cursor[leaf];
    return { block: result, removed: relativePath.map(String).join(".") };
}
