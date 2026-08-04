import { cueBudgetFor } from "./compress-cues-prompt";

/**
 * Per-cue validation, applied ON WRITE (not at parse time). The compress-cues
 * host validates each cue independently and SKIPS the invalid ones — the memory
 * keeps a NULL cue and is retried next run — rather than rejecting the whole
 * chunk for one bad cue. This is the per-cue half of the retired
 * validateMuralManifest; the manifest-level arms (duplicate ids, room/merge
 * targets, source-membership) are gone with the author flow.
 */

export interface CueValidationFailure {
    reason: string;
}

function hasBalancedParentheses(cue: string): boolean {
    let depth = 0;
    for (const character of cue) {
        if (character === "(") depth++;
        if (character === ")") depth--;
        if (depth < 0) return false;
    }
    return depth === 0;
}

/**
 * Validate a single compressed cue against the grammar the renderer and the
 * prompt agree on. Returns null when the cue is acceptable, or a failure with a
 * short machine-loggable reason. The `importance` selects the budget.
 *
 * Rules enforced (all independent of other cues):
 *  - non-empty after trim
 *  - within the per-importance character budget
 *  - no leaked source id (#123)
 *  - balanced parentheses (prohibition mechanisms use them)
 *  - a prohibition trigger word requires a ⊘ polarity marker
 *  - every ⊘ marker needs a parenthesized mechanism
 */
export function validateCue(cue: string, importance: number): CueValidationFailure | null {
    const trimmed = cue.trim();
    if (trimmed.length === 0) return { reason: "empty" };

    const budget = cueBudgetFor(importance);
    const length = [...trimmed].length;
    if (length > budget) return { reason: `over-budget ${length}>${budget}` };

    if (/#\d+/.test(trimmed)) return { reason: "leaked-id" };

    if (!hasBalancedParentheses(trimmed)) return { reason: "unbalanced-parens" };

    const markers = trimmed.split("⊘").length - 1;
    const mechanisms = trimmed.match(/\([^()]+\)/g)?.length ?? 0;
    const trigger = /\b(?:must not|never|without|instead of|exclude|excludes)\b/i.test(trimmed);
    if (trigger && markers === 0) return { reason: "prohibition-missing-marker" };
    if (markers > mechanisms) return { reason: "polarity-missing-mechanism" };

    return null;
}
