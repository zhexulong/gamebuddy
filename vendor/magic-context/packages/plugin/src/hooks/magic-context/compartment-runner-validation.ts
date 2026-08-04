import { withContentLanguageDirective } from "../../agents/language-directive";
import { factCategoriesForDomain, type MemoryDomain } from "../../features/magic-context/memory/domain";
import { parseCompartmentOutput } from "./compartment-parser";
import { mapParsedCompartmentsToChunk } from "./compartment-runner-mapping";
import type {
    StoredCompartmentRange,
    ValidatedHistorianPassResult,
} from "./compartment-runner-types";

const MIN_RECOMP_CHUNK_TOKEN_BUDGET = 20;

/**
 * Heal gaps between adjacent compartments by expanding the previous compartment's
 * endMessage forward to meet the next compartment's startMessage.
 *
 * Historian frequently skips tool-only blocks — blocks whose visible chunk content
 * is TC: lines with no narrative text. That's a safe skip: no durable signal is lost.
 * When the chunk's `toolOnlyRanges` proves that the whole gap is tool-only, heal it
 * regardless of size.
 *
 * Never absorb an unclassified gap. Production replay with the lowest-calibration
 * historian showed contiguous narrative coverage, so there is no model-quality need
 * for a size-based escape hatch. Rejecting instead preserves the prior boundary; the
 * runner then re-reads the same raw messages on its repair attempt or next run.
 *
 * Mutates the compartments array in place.
 */
function healCompartmentGaps(
    compartments: Array<{ startMessage: number; endMessage: number }>,
    toolOnlyRanges: ReadonlyArray<{ start: number; end: number }> = [],
): void {
    for (let i = 1; i < compartments.length; i++) {
        const prev = compartments[i - 1];
        const curr = compartments[i];
        const gapStart = prev.endMessage + 1;
        const gapEnd = curr.startMessage - 1;
        const gapSize = gapEnd - gapStart + 1;

        if (gapSize <= 0) continue;

        // Tool-only noise is the only gap class that is safe to absorb.
        const fullyInsideToolOnly = toolOnlyRanges.some(
            (range) => range.start <= gapStart && range.end >= gapEnd,
        );

        if (fullyInsideToolOnly) {
            prev.endMessage = gapEnd;
        }
    }
}

export function validateHistorianOutput(
    text: string,
    _sessionId: string,
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
        /** Optional — when provided, gaps inside these ranges heal at any size. */
        toolOnlyRanges?: ReadonlyArray<{ start: number; end: number }>;
    },
    _priorCompartments: StoredCompartmentRange[],
    sequenceOffset: number,
    domain: MemoryDomain = "coding-project",
): ValidatedHistorianPassResult {
    const parsed = parseCompartmentOutput(text, factCategoriesForDomain(domain));
    if (parsed.compartments.length === 0) {
        return {
            ok: false,
            error: "Historian returned no usable compartments.",
        };
    }

    // Heal only proven tool-only gaps. Narrative gaps reject before publication, so
    // the runner keeps its prior boundary and re-reads those raw messages.
    healCompartmentGaps(parsed.compartments, chunk.toolOnlyRanges);

    const mapped = mapParsedCompartmentsToChunk(parsed.compartments, chunk, sequenceOffset);
    if (!mapped.ok) {
        return {
            ok: false,
            error: `Historian returned invalid compartment output: ${mapped.error}`,
        };
    }

    const parsedValidationError = validateParsedCompartments(
        parsed.compartments,
        chunk.startIndex,
        chunk.endIndex,
        parsed.unprocessedFrom,
    );
    if (parsedValidationError) {
        return {
            ok: false,
            error: `Historian returned invalid compartment output: ${parsedValidationError}`,
        };
    }

    return {
        ok: true,
        compartments: mapped.compartments,
        facts: parsed.facts,
        userObservations: parsed.userObservations.length > 0 ? parsed.userObservations : undefined,
        primerCandidates:
            parsed.primerCandidates.length > 0 ? parsed.primerCandidates.slice(0, 1) : undefined,
        // v2: surface events so the runner can persist them (stored, not rendered).
        events: parsed.events.length > 0 ? parsed.events : undefined,
    };
}

/**
 * Number of CONSECUTIVE historian failures before a failure notice escalates
 * from "transient, will retry" reassurance to an actionable "your historian
 * model needs attention" alert. The historian retries on every turn and silently
 * iterates its whole fallback chain, so a single failure is almost always a
 * transient blip (a model hiccup, a provider timeout) that the next turn fixes on
 * its own. Only a sustained run of failures indicates a real misconfiguration
 * worth alarming the user about. 3 mirrors the dreamer circuit-breaker threshold.
 */
export const HISTORIAN_PERSISTENT_FAILURE_THRESHOLD = 3;

/**
 * User-facing notice for a historian (history-comparting) failure. The framing is
 * chosen by `failureCount` so users aren't alarmed by harmless transient blips:
 *
 *   - Below the threshold → calm reassurance: Magic Context retries automatically
 *     on the next turn, nothing is lost, and the conversation continues normally.
 *     We explicitly promise we'll only speak up again if it keeps failing.
 *   - At/above the threshold → escalation: the failures are persistent, so it's
 *     likely the configured historian model is misconfigured or unreachable, with
 *     the last error and the actionable next step (check magic-context.jsonc).
 *
 * Shared by both harnesses so the wording (and the transient/persistent contract)
 * never drifts between OpenCode and Pi.
 */
export function buildHistorianFailureNotice(failureCount: number, lastError: string): string {
    if (failureCount >= HISTORIAN_PERSISTENT_FAILURE_THRESHOLD) {
        return [
            "## Magic Context — history comparting needs attention",
            "",
            `Magic Context has been unable to compart this session's history ${failureCount} times in a row. This usually means the configured historian model is misconfigured or unreachable (Magic Context already retried every fallback model automatically).`,
            "",
            `Last error: ${lastError}`,
            "",
            "Check your historian model in magic-context.jsonc, then restart. Your conversation keeps working normally in the meantime — this only affects how older history is summarized.",
        ].join("\n");
    }
    return [
        "## Magic Context",
        "",
        "Hit a transient issue comparting history this turn — Magic Context will retry automatically on the next turn. Nothing is lost and your conversation continues normally. You'll only be alerted again if this keeps happening.",
    ].join("\n");
}

export function buildHistorianRepairPrompt(
    originalPrompt: string,
    previousOutput: string,
    validationError: string,
    language?: string,
): string {
    const prompt = [
        originalPrompt,
        "",
        "Your previous XML response was invalid and cannot be persisted.",
        `Validation error: ${validationError}`,
        "Return a corrected full XML response for the same existing state and new messages.",
        "Do not skip any displayed raw ordinal or displayed raw range, even if the message looks trivial.",
        "Every displayed message range must belong to exactly one compartment unless it is intentionally left in one trailing suffix marked by <unprocessed_from>.",
        "",
        "Previous invalid XML:",
        previousOutput,
    ].join("\n");
    return withContentLanguageDirective(prompt, language, { preserveUserQuotes: true });
}

export function validateStoredCompartments(
    compartments: Array<{ startMessage: number; endMessage: number }>,
): string | null {
    if (compartments.length === 0) {
        return null;
    }

    let expectedStart = 1;
    for (const compartment of compartments) {
        if (compartment.startMessage !== expectedStart) {
            if (compartment.startMessage < expectedStart) {
                return `overlap before message ${expectedStart} (saw ${compartment.startMessage}-${compartment.endMessage})`;
            }
            return `gap before message ${compartment.startMessage} (expected ${expectedStart})`;
        }
        if (compartment.endMessage < compartment.startMessage) {
            return `invalid range ${compartment.startMessage}-${compartment.endMessage}`;
        }
        expectedStart = compartment.endMessage + 1;
    }

    return null;
}

function validateParsedCompartments(
    compartments: Array<{ startMessage: number; endMessage: number; p1?: string }>,
    chunkStart: number,
    chunkEnd: number,
    unprocessedFrom: number | null,
): string | null {
    let expectedStart = chunkStart;

    for (const [index, compartment] of compartments.entries()) {
        // P1 is the required v2 boundary. Missing P2-P4 deliberately retain the
        // parser's denser-tier fallbacks; only the flat v1 shape must retry.
        if (!compartment.p1?.trim()) {
            return `compartment ${index + 1} is missing the tiered paraphrase structure (p1..p4); re-emit with all four tiers`;
        }
        if (compartment.endMessage < compartment.startMessage) {
            return `invalid range ${compartment.startMessage}-${compartment.endMessage}`;
        }
        if (compartment.startMessage < chunkStart || compartment.endMessage > chunkEnd) {
            return `range ${compartment.startMessage}-${compartment.endMessage} is outside chunk ${chunkStart}-${chunkEnd}`;
        }
        if (compartment.startMessage !== expectedStart) {
            if (compartment.startMessage < expectedStart) {
                return `overlap before message ${expectedStart} (saw ${compartment.startMessage}-${compartment.endMessage})`;
            }
            return `gap before message ${compartment.startMessage} (expected ${expectedStart})`;
        }
        expectedStart = compartment.endMessage + 1;
    }

    if (unprocessedFrom !== null) {
        // Treat unprocessed_from === chunkEnd + 1 as "fully processed" —
        // historian consumed all messages and reported the next ordinal.
        if (unprocessedFrom === chunkEnd + 1) {
            return null;
        }
        if (unprocessedFrom < chunkStart || unprocessedFrom > chunkEnd) {
            return `<unprocessed_from> ${unprocessedFrom} is outside chunk ${chunkStart}-${chunkEnd}`;
        }
        if (unprocessedFrom !== expectedStart) {
            return `<unprocessed_from> ${unprocessedFrom} does not match next uncovered message ${expectedStart}`;
        }
        return null;
    }

    if (expectedStart <= chunkEnd) {
        return `output left uncovered messages ${expectedStart}-${chunkEnd} without <unprocessed_from>`;
    }

    return null;
}

export function validateChunkCoverage(chunk: {
    startIndex: number;
    endIndex: number;
    lines: Array<{ ordinal: number }>;
}): string | null {
    if (chunk.lines.length === 0) {
        return null;
    }

    let expectedOrdinal = chunk.startIndex;
    for (const line of chunk.lines) {
        if (line.ordinal !== expectedOrdinal) {
            return `chunk omits raw message ${expectedOrdinal} while still claiming coverage through ${chunk.endIndex}`;
        }
        expectedOrdinal += 1;
    }

    if (expectedOrdinal - 1 !== chunk.endIndex) {
        return `chunk coverage ends at ${expectedOrdinal - 1} but chunk end is ${chunk.endIndex}`;
    }

    return null;
}

export function getReducedRecompTokenBudget(currentBudget: number): number | null {
    const reducedBudget = Math.max(MIN_RECOMP_CHUNK_TOKEN_BUDGET, Math.floor(currentBudget / 2));
    return reducedBudget < currentBudget ? reducedBudget : null;
}
