import { isRecord } from "../../shared/record-type-guard";

/**
 * Whole-message sentinel placeholder for providers that must not receive empty
 * assistant content on the wire.
 *
 * Background: when `stripDroppedPlaceholderMessages` /
 * `stripSystemInjectedMessages` / `replaySentinelByMessageIds` reduce a whole
 * assistant message to one sentinel part, the resulting AI-SDK `ModelMessage`
 * can become `{ role: "assistant", content: "" }`. OpenCode's canonical
 * Anthropic adapter filters that empty message before the wire; most other
 * providers can forward it and stricter backends reject it (e.g. Moonshot/Kimi:
 * "must not be empty").
 *
 * Using a non-empty placeholder text whose value won't be filtered keeps the
 * wire valid while still telling the model honestly that something was dropped.
 */
export const WHOLE_MESSAGE_PLACEHOLDER_TEXT = "[dropped]";

/**
 * Decide whether empty-text sentinels are safe for the provider's wire path.
 *
 * The gate is deliberately canonical-Anthropic only. OpenCode filters empty
 * text/reasoning parts only in the `@ai-sdk/anthropic` branch before sending
 * to the provider; github-copilot and other non-Anthropic adapters forward
 * `{type:"text", text:""}` parts as real content blocks. Bedrock also filters
 * empty text later, but native `step-start` boundaries and empty sentinels are
 * not byte-equivalent before that filter runs. Google Vertex Anthropic maps to
 * an Anthropic SDK key but does not enter OpenCode's `@ai-sdk/anthropic`
 * empty-part filter.
 *
 * Unknown or non-canonical providers therefore must keep native parts (or use
 * non-empty whole-message placeholders) rather than producing empty sentinels.
 */
export function modelAcceptsEmptyContent(providerID?: string): boolean {
    return providerID === "anthropic";
}

/**
 * Create an empty-text sentinel to replace a stripped message PART (not a
 * whole message) while preserving the array's length and index positions
 * across passes.
 *
 * Why sentinels exist: Anthropic prompt caching is sensitive to serialized
 * message-array shape. Replacing removed parts with inert `{type:"text",
 * text:""}` placeholders keeps indices stable across passes, and OpenCode's
 * canonical Anthropic adapter filters those empty text parts before the wire.
 *
 * Call sites must gate this helper with `modelAcceptsEmptyContent()`. For
 * non-Anthropic providers the empty text part can survive onto the wire and
 * break provider-specific adjacency or non-empty-content invariants.
 *
 * `cache_control` inheritance: if the original part carried provider-side
 * cache-breakpoint metadata (`cache_control` / `cacheControl`), the
 * sentinel inherits it. OpenCode currently only sets cache markers on the
 * last two system+non-system messages (never on mid-history parts we
 * strip), so this is defensive, but cheap.
 */
export function makeSentinel(originalPart: unknown): {
    type: "text";
    text: string;
} & Record<string, unknown> {
    const sentinel: { type: "text"; text: string } & Record<string, unknown> = {
        type: "text",
        text: "",
    };
    if (isRecord(originalPart)) {
        if (originalPart.cache_control !== undefined) {
            sentinel.cache_control = originalPart.cache_control;
        }
        if (originalPart.cacheControl !== undefined) {
            sentinel.cacheControl = originalPart.cacheControl;
        }
    }
    return sentinel;
}

/**
 * Create a sentinel for replacing a WHOLE assistant message's parts list.
 *
 * Picks `""` when the live provider is the canonical Anthropic provider
 * (whose AI-SDK normalization filters empty content from the wire),
 * `[dropped]` otherwise. See `modelAcceptsEmptyContent` for the rule.
 *
 * The chosen placeholder text is kept in `WHOLE_MESSAGE_PLACEHOLDER_TEXT`
 * so `isSentinel` recognizes both shapes (idempotency on replay).
 */
export function makeWholeMessageSentinel(
    providerID?: string,
): { type: "text"; text: string } & Record<string, unknown> {
    return {
        type: "text",
        text: modelAcceptsEmptyContent(providerID) ? "" : WHOLE_MESSAGE_PLACEHOLDER_TEXT,
    };
}

/**
 * Detect whether a part is already a sentinel produced by `makeSentinel`
 * or `makeWholeMessageSentinel`. Used by strip functions to stay
 * idempotent — don't re-count or re-mutate a sentinel we already
 * installed.
 *
 * Recognizes both empty (`""`) and whole-message-placeholder
 * (`[dropped]`) sentinel text values.
 */
export function isSentinel(part: unknown): boolean {
    if (!isRecord(part)) return false;
    if (part.type !== "text") return false;
    if (typeof part.text !== "string") return false;
    return part.text === "" || part.text === WHOLE_MESSAGE_PLACEHOLDER_TEXT;
}

/**
 * Replay a previously-persisted set of message IDs by replacing each
 * matching message's parts with a single whole-message sentinel. Used to
 * keep the wire shape stable across defer passes when OpenCode rebuilds
 * messages from its DB — any message whose ID is in `ids` was
 * neutralized on a prior bust pass and should be neutralized again now.
 *
 * `providerID` controls which sentinel shape is installed (see
 * `makeWholeMessageSentinel`). Pass the live session's provider so the
 * replayed wire shape matches the fresh sentinelization on the current
 * pass — providers that don't filter empties get `[dropped]`, Anthropic
 * gets `""`.
 *
 * Returns the number of messages replayed + the set of IDs that were NOT
 * found in the current message array (caller can prune them from the
 * persisted set so we stop carrying stale IDs forever).
 */
export function replaySentinelByMessageIds(
    messages: Array<{ info: { id?: string }; parts: unknown[] }>,
    ids: Set<string>,
    providerID?: string,
): { replayed: number; missingIds: string[] } {
    if (ids.size === 0) return { replayed: 0, missingIds: [] };
    const seen = new Set<string>();
    let replayed = 0;
    for (const msg of messages) {
        const id = msg.info.id;
        if (!id || !ids.has(id)) continue;
        seen.add(id);
        // Idempotent skip — already neutralized on an earlier pass in this turn
        if (msg.parts.length === 1 && isSentinel(msg.parts[0])) continue;
        msg.parts.length = 0;
        msg.parts.push(makeWholeMessageSentinel(providerID));
        replayed++;
    }
    const missingIds: string[] = [];
    for (const id of ids) if (!seen.has(id)) missingIds.push(id);
    return { replayed, missingIds };
}
