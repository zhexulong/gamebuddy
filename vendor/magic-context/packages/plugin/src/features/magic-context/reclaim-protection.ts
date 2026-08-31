/** Number of recent ctx_reduce arcs retained as visible housekeeping exemplars. */
export const CTX_REDUCE_KEEP = 3;

/**
 * Return the tag numbers of the newest visible ctx_reduce arcs.
 *
 * Callers supply their active tool population so every reclaim lane protects the
 * same exemplars even when its other eligibility rules differ.
 */
export function newestCtxReduceTagNumbers(
    tags: readonly { tagNumber: number; toolName: string | null }[],
): Set<number> {
    return new Set(
        tags
            .filter((tag) => tag.toolName === "ctx_reduce")
            .sort((left, right) => right.tagNumber - left.tagNumber)
            .slice(0, CTX_REDUCE_KEEP)
            .map((tag) => tag.tagNumber),
    );
}
