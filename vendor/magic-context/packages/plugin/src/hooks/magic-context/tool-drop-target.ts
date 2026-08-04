import { isRecord } from "../../shared/record-type-guard";
import { applyEditMarkerToInput } from "./edit-marker";
import { stripTagPrefix } from "./tag-content-primitives";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";

export type ToolDropResult = "removed" | "truncated" | "absent" | "incomplete";

interface ToolCallObservation {
    callId: string;
    kind: "invocation" | "result";
}

export interface IndexedOccurrence {
    message: MessageLike;
    part: unknown;
    kind: "invocation" | "result";
}

export interface ToolCallIndexEntry {
    occurrences: IndexedOccurrence[];
    hasResult: boolean;
}

export type ToolCallIndex = Map<string, ToolCallIndexEntry>;

const DROP_PREFIX = "[dropped";
const IGNORE_PART_TYPES = new Set([
    "thinking",
    "reasoning",
    "redacted_thinking",
    "meta",
    "step-start",
    "step-finish",
]);

function isToolCallId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function getToolContent(part: unknown): string | undefined {
    if (!isRecord(part)) return undefined;
    if (part.type === "tool" && isRecord(part.state)) {
        return typeof part.state.output === "string" ? part.state.output : undefined;
    }
    if (part.type === "tool_result") {
        return typeof part.content === "string" ? part.content : undefined;
    }
    return undefined;
}

function setToolContent(part: unknown, content: string): void {
    if (!isRecord(part)) return;
    if (part.type === "tool" && isRecord(part.state)) {
        part.state.output = content;
        return;
    }
    if (part.type === "tool_result") {
        part.content = content;
    }
}

function truncateToolPart(part: unknown, tagId: number): void {
    if (!isRecord(part)) return;

    // The skeleton keeps the tool_use call but replaces its OUTPUT with the
    // one canonical drop placeholder `[dropped §N§]` (byte-identical to a
    // full message/tool drop). Long input ARG values are separately clamped
    // with `...[truncated]` — that's value-shortening, not a drop, so it keeps
    // its own marker. Frozen by the dropMode column, so it replays identically.
    const sentinel = `[dropped \u00a7${tagId}\u00a7]`;

    // OpenCode format: { type: "tool", state: { input: {...}, output: "..." } }
    if (part.type === "tool" && isRecord(part.state)) {
        const state = part.state;
        state.output = sentinel;

        if (isRecord(state.input)) {
            const inputSize = estimateInputSize(state.input);
            if (inputSize > 500) {
                truncateInputValues(state.input);
            }
        }

        return;
    }

    // Anthropic format: { type: "tool_result", content: "..." }
    if (part.type === "tool_result") {
        part.content = sentinel;
        return;
    }

    // OpenCode invocation format: { type: "tool-invocation", args: {...} }
    if (part.type === "tool-invocation" && isRecord(part.args)) {
        const inputSize = estimateInputSize(part.args as Record<string, unknown>);
        if (inputSize > 500) {
            truncateInputValues(part.args as Record<string, unknown>);
        }
        return;
    }

    // Anthropic invocation format: { type: "tool_use", input: {...} }
    if (part.type === "tool_use" && isRecord(part.input)) {
        const inputSize = estimateInputSize(part.input as Record<string, unknown>);
        if (inputSize > 500) {
            truncateInputValues(part.input as Record<string, unknown>);
        }
    }
}

function estimateInputSize(input: Record<string, unknown>): number {
    try {
        return JSON.stringify(input).length;
    } catch {
        return 0;
    }
}

/**
 * Edit-marker variant of `truncateToolPart` for a superseded edit/write: keep
 * the tool_use call, output → `[dropped §N§]`, but preserve `filePath` verbatim
 * and clamp the diff to a region hint (instead of the 5-char generic clamp).
 * A SEPARATE path from `truncateToolPart`: it must never alter the existing
 * skeleton bytes. Deterministic + idempotent (see edit-marker.ts).
 */
function editMarkerToolPart(part: unknown, tagId: number): void {
    if (!isRecord(part)) return;
    const sentinel = `[dropped \u00a7${tagId}\u00a7]`;

    if (part.type === "tool" && isRecord(part.state)) {
        part.state.output = sentinel;
        if (isRecord(part.state.input)) applyEditMarkerToInput(part.state.input);
        return;
    }
    if (part.type === "tool_result") {
        part.content = sentinel;
        return;
    }
    if (part.type === "tool-invocation" && isRecord(part.args)) {
        applyEditMarkerToInput(part.args as Record<string, unknown>);
        return;
    }
    if (part.type === "tool_use" && isRecord(part.input)) {
        applyEditMarkerToInput(part.input as Record<string, unknown>);
    }
}

/**
 * Non-mutating read of a tool part's input object across the formats
 * `truncateToolPart` handles. Returns null when the part carries no input.
 * Used by supersession selection (read `ctx_note` action / edit `filePath`)
 * without touching the wire.
 */
function readToolPartInput(part: unknown): Record<string, unknown> | null {
    if (!isRecord(part)) return null;
    if (part.type === "tool" && isRecord(part.state) && isRecord(part.state.input)) {
        return part.state.input;
    }
    if (part.type === "tool-invocation" && isRecord(part.args)) return part.args;
    if (part.type === "tool_use" && isRecord(part.input)) return part.input;
    return null;
}

const TRUNCATION_SENTINEL = "...[truncated]";

/**
 * Slice a string without splitting a surrogate pair.
 * If the character at `maxLen - 1` is a high surrogate, back off by one
 * to avoid producing an orphaned surrogate that breaks JSON serialization.
 */
function safeSlice(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    // Check if we'd split a surrogate pair
    const lastCharCode = str.charCodeAt(maxLen - 1);
    // High surrogate range: 0xD800–0xDBFF
    if (lastCharCode >= 0xd800 && lastCharCode <= 0xdbff) {
        return str.slice(0, maxLen - 1);
    }
    return str.slice(0, maxLen);
}

function truncateInputValues(input: Record<string, unknown>): void {
    for (const key of Object.keys(input)) {
        const value = input[key];
        if (typeof value === "string") {
            // Already truncated — skip to preserve idempotency
            if (
                value.endsWith(TRUNCATION_SENTINEL) ||
                value === "[object]" ||
                /^\[\d+ items\]$/.test(value)
            )
                continue;
            input[key] = value.length > 5 ? `${safeSlice(value, 5)}${TRUNCATION_SENTINEL}` : value;
        } else if (Array.isArray(value)) {
            input[key] = `[${value.length} items]`;
        } else if (value !== null && typeof value === "object") {
            input[key] = "[object]";
        }
    }
}

export function hasMeaningfulPart(part: unknown): boolean {
    if (!isRecord(part)) return false;
    const type = part.type;
    if (type === "text") {
        if (typeof part.text !== "string") return false;
        return stripTagPrefix(part.text).trim().length > 0;
    }
    if (typeof type !== "string") return false;
    if (IGNORE_PART_TYPES.has(type)) return false;
    return true;
}

function clearThinkingParts(thinkingParts: ThinkingLikePart[]): void {
    for (const part of thinkingParts) {
        if (part.thinking !== undefined) part.thinking = "[cleared]";
        if (part.text !== undefined) part.text = "[cleared]";
    }
}

export function extractToolCallObservation(part: unknown): ToolCallObservation | null {
    if (!isRecord(part)) return null;
    if (part.type === "tool" && isToolCallId(part.callID)) {
        return { callId: part.callID, kind: "result" };
    }
    if (part.type === "tool-invocation" && isToolCallId(part.callID)) {
        return { callId: part.callID, kind: "invocation" };
    }
    if (part.type === "tool_use" && isToolCallId(part.id)) {
        return { callId: part.id, kind: "invocation" };
    }
    if (part.type === "tool_result" && isToolCallId(part.tool_use_id)) {
        return { callId: part.tool_use_id, kind: "result" };
    }
    return null;
}

function isDropContent(content: string): boolean {
    return content.startsWith(DROP_PREFIX);
}

export class ToolMutationBatch {
    private partsToRemove = new Set<unknown>();
    private affectedMessages = new Set<MessageLike>();
    private messages: MessageLike[];

    constructor(messages: MessageLike[]) {
        this.messages = messages;
    }

    markForRemoval(occurrence: IndexedOccurrence): void {
        this.partsToRemove.add(occurrence.part);
        this.affectedMessages.add(occurrence.message);
    }

    finalize(): void {
        if (this.partsToRemove.size === 0) return;

        for (const message of this.affectedMessages) {
            message.parts = message.parts.filter((p) => !this.partsToRemove.has(p));
        }

        for (let i = this.messages.length - 1; i >= 0; i -= 1) {
            if (!this.messages[i].parts.some(hasMeaningfulPart)) {
                this.messages.splice(i, 1);
            }
        }

        this.partsToRemove.clear();
        this.affectedMessages.clear();
    }
}

/**
 * Build a TagTarget for a single tool composite key
 * (`<ownerMsgId>\x00<callId>`).
 *
 * v3.3.1 Layer C: pre-fix this took a bare `callId`. Two assistant turns
 * reusing the same callId produced two TagTargets that both pointed at
 * the same `index.get(callId)` entry — last-write-wins on `targets.set`
 * silently merged them into one drop target, and a queued drop on the
 * older tag would mutate the newer turn's content. Composite keys
 * guarantee one TagTarget per (owner, callId) pair, so each turn's tag
 * gets its own independent drop scope.
 *
 * The `index` map is keyed by composite key as well — see
 * `tag-messages.ts` for the matching producer.
 */
export function createToolDropTarget(
    compositeKey: string,
    thinkingParts: ThinkingLikePart[],
    index: ToolCallIndex,
    batch: ToolMutationBatch,
    tagId: number,
): {
    setContent: (content: string) => boolean;
    drop: () => ToolDropResult;
    truncate: () => ToolDropResult;
    editMarker: () => ToolDropResult;
    /**
     * Non-mutating predicate: would drop()/truncate() actually remove bytes?
     * False for an absent (compacted-away) or incomplete (invocation present,
     * no result part) entry — both return early without reclaiming anything.
     * The tiered emergency planner must filter on this, not on the mere
     * presence of a drop() function: counting a no-reclaim tag as droppable
     * makes the plan stop early and under-evict below the ceiling.
     */
    canDrop: () => boolean;
    readInput: () => Record<string, unknown> | null;
} {
    const drop = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            batch.markForRemoval(occurrence);
        }
        clearThinkingParts(thinkingParts);
        index.delete(compositeKey);
        return "removed";
    };

    const truncate = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            // Truncate both result parts (output) and invocation parts (args/input)
            truncateToolPart(occurrence.part, tagId);
        }
        clearThinkingParts(thinkingParts);
        return "truncated";
    };

    const editMarker = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            editMarkerToolPart(occurrence.part, tagId);
        }
        clearThinkingParts(thinkingParts);
        return "truncated";
    };

    return {
        setContent: (content: string): boolean => {
            if (isDropContent(content)) {
                drop();
                return true;
            }

            const entry = index.get(compositeKey);
            if (!entry) return false;

            let changed = false;
            for (const occurrence of entry.occurrences) {
                if (occurrence.kind !== "result") continue;
                const prevContent = getToolContent(occurrence.part);
                if (prevContent !== content) {
                    setToolContent(occurrence.part, content);
                    changed = true;
                }
            }
            return changed;
        },
        drop,
        truncate,
        editMarker,
        canDrop: (): boolean => {
            const entry = index.get(compositeKey);
            return !!entry && entry.occurrences.length > 0 && entry.hasResult;
        },
        readInput: (): Record<string, unknown> | null => {
            const entry = index.get(compositeKey);
            if (!entry) return null;
            // Prefer an invocation occurrence's input, but fall back to ANY
            // occurrence carrying readable input: a COMPLETED OpenCode tool part
            // is `{ type:"tool", state:{ input, output } }`, classified as a
            // "result" occurrence, yet it still holds the call's input, which is
            // where an edit/write's filePath lives once the call finished.
            for (const occurrence of entry.occurrences) {
                if (occurrence.kind !== "invocation") continue;
                const input = readToolPartInput(occurrence.part);
                if (input) return input;
            }
            for (const occurrence of entry.occurrences) {
                const input = readToolPartInput(occurrence.part);
                if (input) return input;
            }
            return null;
        },
    };
}
