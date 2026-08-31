import { estimateTokens } from "./read-session-formatting";
import { byteSize } from "./tag-content-primitives";
import {
    stripChannel1ReminderSpans,
    type TailHygieneBaseline,
    type TailHygienePartMeasurement,
} from "./tail-hygiene-walk";

export type Channel1Level = "gentle" | "firm" | "urgent";

export interface ToolReclaimHint {
    tagNumber: number;
    toolName: string | null;
}

export interface Channel1State extends TailHygieneBaseline {
    usableWindow: number;
    /** Monotonic count of real (not Magic Context-injected) user turns in this pass. */
    realUserTurnCount: number;
    reducedSinceRefresh: boolean;
    /** Do not trigger a reduction nudge on the pass that applied queued agent drops. */
    agentDropsAppliedThisPass?: boolean;
    oldestReclaimableToolTags: ToolReclaimHint[];
}

export const CHANNEL1_SENTINEL = "<system-reminder>";
export const TOKENS_PER_BYTE = 0.25;
export const CHANNEL1_MIN_TOKENS = 60_000;
export const CHANNEL1_FLOOR_TOKENS = 25_000;
export const CHANNEL1_REFIRE_FLOOR_TOKENS = 25_000;
const S_GENTLE = 0.2;
const S_FIRM = 0.4;
const S_URGENT = 0.6;
const LEVEL_RANK: Record<Channel1Level, number> = { gentle: 1, firm: 2, urgent: 3 };
const DROP_SENTINELS = ["[dropped", "[truncated"];

export function channel1RefireTokens(tailTokens: number): number {
    const scaled = Math.round(0.08 * Math.max(0, tailTokens));
    return Math.max(CHANNEL1_REFIRE_FLOOR_TOKENS, scaled);
}

export function isDroppedToolOutput(output: string): boolean {
    const head = output
        .trimStart()
        .replace(/^§\d+§\s*/, "")
        .slice(0, 16)
        .toLowerCase();
    return DROP_SENTINELS.some((sentinel) => head.startsWith(sentinel));
}

export function tailToolTokensFromStrings(outputs: readonly string[]): number {
    let bytes = 0;
    for (const output of outputs) {
        if (isDroppedToolOutput(output)) continue;
        bytes += byteSize(stripChannel1ReminderSpans(output));
    }
    return Math.round(bytes * TOKENS_PER_BYTE);
}

export function toolOutputTokens(output: string): number {
    return estimateTokens(stripChannel1ReminderSpans(output));
}

export interface TailTokenEstimate {
    tailToolTokens: number;
    liveTailTokens: number;
}

export interface Channel1Decision {
    fire: boolean;
    /** Re-fires inside an already-observed band always use the calm one-line copy. */
    sticky: boolean;
    level: Channel1Level;
    undroppedTokens: number;
    tailTokens: number;
    severity: number;
    nextLastNudge: number;
    /** The currently observed band, not merely the last band that emitted copy. */
    nextLastNudgeLevel: Channel1Level | "";
    /** True once post-reduce grace has ended and its durable fields should be cleared. */
    clearPostReduceGrace: boolean;
}

export function decideChannel1(input: {
    baselineU: number;
    baselineT: number;
    turnDeltaU: number;
    turnDeltaT: number;
    lastNudgeUndropped: number;
    lastNudgeLevel: Channel1Level | "";
    lastFireOrdinal?: number;
    currentRealUserTurnCount?: number;
    hasRecentReduce: boolean;
    postReduceGracePending?: boolean;
    postReduceGraceBaselineU?: number;
    postReduceGracePreLevel?: Channel1Level | "";
    evaluable?: boolean;
    generationInvalidated?: boolean;
}): Channel1Decision {
    const tailTokens = Math.max(0, input.baselineT + input.turnDeltaT);
    const undroppedTokens = Math.min(tailTokens, Math.max(0, input.baselineU + input.turnDeltaU));
    const severity = Math.min(1, Math.max(0, undroppedTokens / Math.max(tailTokens, 1)));
    const previousLevel = input.lastNudgeLevel;
    let lastNudge = Math.max(0, input.lastNudgeUndropped);
    let nextLevel = previousLevel;
    let clearPostReduceGrace = false;
    const quiet = (level: Channel1Level = "gentle"): Channel1Decision => ({
        fire: false,
        sticky: false,
        level,
        undroppedTokens,
        tailTokens,
        severity,
        nextLastNudge: lastNudge,
        nextLastNudgeLevel: nextLevel,
        clearPostReduceGrace,
    });

    if (input.evaluable === false || input.generationInvalidated === true) return quiet();
    // The dirty in-memory baseline and a grace-pending durable blob both lack the
    // post-drop U needed to start the grace interval safely.
    if (input.hasRecentReduce || input.postReduceGracePending) return quiet();

    let level: Channel1Level | "" = "";
    if (
        tailTokens >= CHANNEL1_MIN_TOKENS &&
        undroppedTokens >= CHANNEL1_FLOOR_TOKENS &&
        severity >= S_GENTLE
    ) {
        if (severity >= S_URGENT) level = "urgent";
        else if (severity >= S_FIRM) level = "firm";
        else level = "gentle";
    }

    const previousRank = previousLevel === "" ? 0 : LEVEL_RANK[previousLevel];
    const currentRank = level === "" ? 0 : LEVEL_RANK[level];
    const graceBaseline = input.postReduceGraceBaselineU;
    if (graceBaseline !== undefined) {
        const preReduceLevel = input.postReduceGracePreLevel ?? previousLevel;
        const preReduceRank = preReduceLevel === "" ? 0 : LEVEL_RANK[preReduceLevel];
        const regrowthReached =
            undroppedTokens - Math.max(0, graceBaseline) >= channel1RefireTokens(tailTokens);
        const escalatedAbovePreReduceBand = currentRank > preReduceRank;
        if (!regrowthReached && !escalatedAbovePreReduceBand) {
            return quiet(level === "" ? "gentle" : level);
        }
        clearPostReduceGrace = true;
    }

    if (level === "") {
        nextLevel = "";
        lastNudge = 0;
        return quiet();
    }

    // A drop into a lower band is an observation, not a fresh crossing. Recording
    // it quietly lets a later upward transition render one full reminder again.
    if (currentRank < previousRank) {
        nextLevel = level;
        lastNudge = undroppedTokens;
        return quiet(level);
    }

    const crossedFromBelow = currentRank > previousRank;
    const cadenceReached =
        currentRank === previousRank &&
        undroppedTokens - lastNudge >= channel1RefireTokens(tailTokens);
    const currentTurn = input.currentRealUserTurnCount;
    const lastFireTurn = input.lastFireOrdinal;
    const stickyTurnGapReached =
        currentTurn === undefined ||
        lastFireTurn === undefined ||
        lastFireTurn > currentTurn ||
        currentTurn - lastFireTurn >= CHANNEL1_STICKY_REAL_USER_TURN_GAP;
    if (!crossedFromBelow && (!cadenceReached || !stickyTurnGapReached)) return quiet(level);

    return {
        fire: true,
        sticky: !crossedFromBelow,
        level,
        undroppedTokens,
        tailTokens,
        severity,
        nextLastNudge: undroppedTokens,
        nextLastNudgeLevel: level,
        clearPostReduceGrace,
    };
}

export const CHANNEL2_SEVERITY_THRESHOLD = 0.75;
export const CHANNEL2_FLOOR_TOKENS = 50_000;

export type Channel2PredicateBaseline = Pick<
    TailHygieneBaseline,
    "baselineU" | "baselineT" | "turnDeltaU" | "turnDeltaT" | "evaluable" | "generationInvalidated"
>;

export interface Channel2PredicateEvaluation {
    evaluable: boolean;
    shouldTrigger: boolean;
    reclaimableTokens: number;
    tailTokens: number;
    severity: number;
}

export function evaluateChannel2(
    input: Channel2PredicateBaseline | undefined,
): Channel2PredicateEvaluation {
    const values = input
        ? [input.baselineU, input.baselineT, input.turnDeltaU, input.turnDeltaT]
        : [];
    if (
        input?.evaluable !== true ||
        input.generationInvalidated === true ||
        values.some((value) => !Number.isFinite(value))
    ) {
        return {
            evaluable: false,
            shouldTrigger: false,
            reclaimableTokens: 0,
            tailTokens: 0,
            severity: 0,
        };
    }

    const tailTokens = Math.max(0, input.baselineT + input.turnDeltaT);
    const reclaimableTokens = Math.min(tailTokens, Math.max(0, input.baselineU + input.turnDeltaU));
    const severity = Math.min(1, Math.max(0, reclaimableTokens / Math.max(tailTokens, 1)));
    return {
        evaluable: true,
        shouldTrigger:
            tailTokens >= CHANNEL1_MIN_TOKENS &&
            reclaimableTokens >= CHANNEL2_FLOOR_TOKENS &&
            severity >= CHANNEL2_SEVERITY_THRESHOLD,
        reclaimableTokens,
        tailTokens,
        severity,
    };
}

function approxThousands(tokens: number): string {
    return `${Math.round(tokens / 1000)}k`;
}

function formatOldestReclaimableHint(hint?: readonly ToolReclaimHint[]): string {
    if (!hint || hint.length === 0) return "";
    const rendered = hint
        .slice(0, 4)
        .map((tag) => `§${tag.tagNumber}§ ${tag.toolName ?? "tool"}`)
        .join(" · ");
    return rendered.length > 0 ? `\noldest reclaimable: ${rendered}.` : "";
}

export function reclaimableToolOutputCount(parts: readonly TailHygienePartMeasurement[]): number {
    return parts.filter((part) => part.kind === "toolOutput" && part.uTokens > 0).length;
}

function formatReclaimableOutputSummary(count: number, tokens: number): string {
    const outputCount = Math.max(0, Math.floor(count));
    const outputs =
        outputCount === 0
            ? "spent tool outputs"
            : `${outputCount} spent tool output${outputCount === 1 ? "" : "s"}`;
    return `${outputs} (~${approxThousands(tokens)} tokens)`;
}

export function buildChannel2Reminder(
    undroppedTokens: number,
    reclaimableToolOutputs: number,
    hint?: readonly ToolReclaimHint[],
): string {
    const summary = formatReclaimableOutputSummary(reclaimableToolOutputs, undroppedTokens);
    const hintText = formatOldestReclaimableHint(hint);
    return (
        `<system-reminder>\n` +
        `Routine housekeeping: ${summary} are reclaimable — make a ctx_reduce pass at a natural stopping point.${hintText}\n` +
        `</system-reminder>`
    );
}

export const CHANNEL1_STICKY_REAL_USER_TURN_GAP = 5;

export function shouldUseStickyChannel1Reminder(input: {
    lastLevel: Channel1Level | "";
    lastOrdinal: number;
    level: Channel1Level;
    currentRealUserTurnCount: number;
}): boolean {
    // The ordinal controls whether a same-band reminder may fire; it never
    // promotes a re-fire back to imperative copy after the crossing was shown.
    return input.lastLevel === input.level;
}

export function buildChannel1Reminder(
    level: Channel1Level,
    undroppedTokens: number,
    reclaimableToolOutputs: number,
    hint?: readonly ToolReclaimHint[],
    sticky = false,
): string {
    const summary = formatReclaimableOutputSummary(reclaimableToolOutputs, undroppedTokens);
    const hintText = formatOldestReclaimableHint(hint);
    if (sticky) {
        return `\n\n<system-reminder>\nReminder: ${summary} are still reclaimable — ctx_reduce them at a natural stopping point.${hintText}\n</system-reminder>`;
    }

    let body: string;
    switch (level) {
        case "gentle":
            body = `Housekeeping: ${summary} are reclaimable — drop the ones you have already processed with ctx_reduce at a natural stopping point.`;
            break;
        case "firm":
            body = `Housekeeping: ${summary} are reclaimable — make a ctx_reduce pass at a natural stopping point.`;
            break;
        case "urgent":
            body = `Housekeeping backlog: ${summary} are reclaimable — a ctx_reduce pass is due.`;
            break;
    }
    return `\n\n<system-reminder>\n${body}${hintText}\n</system-reminder>`;
}
