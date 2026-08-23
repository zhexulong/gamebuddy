import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const MAX_NATIVE_COMPANION_TEXT_UTF8_BYTES = 16_384;

type AssistantMessage = Readonly<{
  id?: string;
  responseId?: string;
  role: "assistant";
  content: readonly unknown[];
  stopReason: string;
}>;

/** Pi event subset consumed by the native-content projection seam. */
export type NativeCompanionContentEvent =
  | Readonly<{ type: "message_start"; message: unknown }>
  | Readonly<{ type: "message_end"; message: unknown }>
  | Readonly<{
      type: "message_update";
      message: unknown;
      assistantMessageEvent: Readonly<{ type: string; contentIndex?: unknown; delta?: unknown; partial?: unknown }>;
    }>;

export type NativeCompanionContentSinks = Readonly<{
  /**
   * Ephemeral player-visible streaming hint; it is never durable authority.
   * The observer opens this only after its caller's explicit durable barrier.
   */
  onPreviewDelta(delta: string): void | Promise<void>;
  /** The one final safe native assistant text value, emitted at most once. */
  onFinalText(text: string): void | Promise<void>;
  /** No content is supplied to this sink. */
  onRejected(reason: "aborted" | "error" | "empty" | "identity_mismatch"): void | Promise<void>;
}>;

export type NativeCompanionContentObserver = Readonly<{
  /** Enables ephemeral text deltas after the surface's durable running barrier. */
  openPreviews(): void;
  /**
   * Begins accepting final content. Previews remain closed until the owning
   * surface opens them after its own durable running barrier.
   */
  open(): void;
  /** Permanently suppresses all later callbacks, including the final commit. */
  revoke(): void;
  /** Detaches the subscription and waits for already-admitted callbacks. */
  close(): Promise<void>;
}>;

/**
 * Projects one exact Pi assistant message's ordinary native text without
 * exposing any presentation, game, store, or provider authority to Pi. It
 * filters reasoning and tool calls structurally and accepts only final text
 * from the matching assistant message. Callers own surface-specific durable
 * commit and cancellation admission.
 */
export function attachNativeCompanionContent(
  session: Pick<AgentSession, "subscribe"> | Readonly<{ subscribe(listener: (event: NativeCompanionContentEvent) => void): () => void }>,
  sinks: NativeCompanionContentSinks,
): NativeCompanionContentObserver {
  let opened = false;
  let revoked = false;
  let closed = false;
  // Pi's agent loop emits shallow snapshots for `message_start`/`message_update`
  // but retains the exact final AssistantMessage object until `message_end`.
  // Provider response IDs are optional API metadata, not a Host correlation
  // capability: OpenAI-compatible streams may omit them. The lifecycle start
  // binds this observer to the one Pi-owned assistant response; an optional
  // provider ID may only corroborate that binding, never be required for it.
  let tracked: AssistantMessage | undefined;
  let trackedIdentity: Readonly<{ kind: "id" | "responseId"; value: string }> | undefined;
  let finalizing = false;
  let previewsEnabled = false;
  let allowTextDeltas = false;
  let trackedTextContentIndexes = new Set<number>();
  let callbackTail = Promise.resolve();
  let unsubscribe: (() => void) | undefined;

  const dispatch = (callback: () => void | Promise<void>): void => {
    if (revoked || closed) return;
    callbackTail = callbackTail.then(callback);
  };

  const onEvent = (event: NativeCompanionContentEvent | AgentSessionEvent): void => {
    if (!opened || revoked || closed) return;
    if (event.type === "message_start") {
      // A Pi turn may contain one or more tool-use assistant messages before
      // its terminal natural-language response. Bind to exactly one active
      // assistant message at a time; a second start while one is unresolved is
      // foreign/malformed and cannot replace the tracked identity.
      if (tracked === undefined && !finalizing && isAssistantMessage(event.message)) {
        tracked = event.message;
        trackedIdentity = identityOf(event.message);
        trackedTextContentIndexes = new Set<number>();
      }
      return;
    }
    if (event.type === "message_update") {
      if (tracked === undefined || finalizing) return;
      const assistantMessageEvent = event.assistantMessageEvent as Readonly<{
        type: string;
        contentIndex?: unknown;
        delta?: unknown;
        partial?: unknown;
      }>;
      // Pi emits shallow snapshots. A provider response ID, when available,
      // must remain consistent; its absence does not invalidate the exact
      // assistant lifecycle already started by Pi for this prompt.
      const partial = isAssistantMessage(assistantMessageEvent.partial)
        ? assistantMessageEvent.partial
        : undefined;
      if (partial === undefined) return;
      const partialIdentity = identityOf(partial);
      if (trackedIdentity === undefined) {
        trackedIdentity = partialIdentity;
      } else if (partialIdentity !== undefined && !matchesIdentity(partial, trackedIdentity)) {
        return;
      }
      if (
        assistantMessageEvent.type === "text_start" &&
        Number.isSafeInteger(assistantMessageEvent.contentIndex) &&
        (assistantMessageEvent.contentIndex as number) >= 0
      ) {
        trackedTextContentIndexes.add(assistantMessageEvent.contentIndex as number);
      }
      if (
        allowTextDeltas &&
        assistantMessageEvent.type === "text_delta" &&
        Number.isSafeInteger(assistantMessageEvent.contentIndex) &&
        trackedTextContentIndexes.has(assistantMessageEvent.contentIndex as number) &&
        typeof assistantMessageEvent.delta === "string" &&
        assistantMessageEvent.delta.length > 0
      ) {
        dispatch(async () => await sinks.onPreviewDelta(assistantMessageEvent.delta as string));
      }
      return;
    }
    if (event.type !== "message_end") return;
    const finalMessage = event.message;
    if (!isAssistantMessage(finalMessage)) return;
    // Pi delivers `message_end` serially after the matching assistant
    // lifecycle. Provider metadata may be absent entirely, but when one was
    // observed it must still match; a contradictory ID is foreign output.
    if (tracked !== undefined && trackedIdentity !== undefined && !matchesIdentity(finalMessage, trackedIdentity)) {
      finalizing = true;
      tracked = undefined;
      trackedIdentity = undefined;
      trackedTextContentIndexes = new Set<number>();
      dispatch(async () => await sinks.onRejected("identity_mismatch"));
      return;
    }
    if (tracked !== undefined) {
      tracked = undefined;
      trackedIdentity = undefined;
      trackedTextContentIndexes = new Set<number>();
      // A tool-use assistant message is an intermediate agent-loop result, not
      // the player-visible final response. It may be followed by a typed Game
      // action and another assistant message, so it must neither preview nor
      // terminalize this observer.
      if (finalMessage.stopReason === "toolUse") return;
      finalizing = true;
      if (finalMessage.stopReason === "aborted") {
        dispatch(async () => await sinks.onRejected("aborted"));
        return;
      }
      if (finalMessage.stopReason === "error") {
        dispatch(async () => await sinks.onRejected("error"));
        return;
      }
      const text = readSafeAssistantText(finalMessage);
      if (text === null) {
        dispatch(async () => await sinks.onRejected("empty"));
        return;
      }
      dispatch(async () => await sinks.onFinalText(text));
    }
  };

  return Object.freeze({
    openPreviews(): void {
      if (!opened || revoked || closed) return;
      previewsEnabled = true;
      allowTextDeltas = true;
    },
    open(): void {
      if (opened || revoked || closed) throw new Error("native_companion_content_observer_unavailable");
      opened = true;
      // Previews may have been requested just before this observer was opened
      // by an already-durable surface barrier; preserve that bounded intent.
      allowTextDeltas = previewsEnabled;
      unsubscribe = session.subscribe(onEvent as never);
    },
    revoke(): void {
      revoked = true;
      unsubscribe?.();
      unsubscribe = undefined;
    },
    async close(): Promise<void> {
      if (closed) return await callbackTail;
      unsubscribe?.();
      unsubscribe = undefined;
      await callbackTail;
      closed = true;
    },
  });
}

function readSafeAssistantText(message: AssistantMessage): string | null {
  const value = message.content
    .filter(isTextContent)
    .map((entry) => entry.text)
    .join("")
    .trim()
    .normalize("NFC");
  if (
    value.length === 0 ||
    /[\u0000-\u001F\u007F-\u009F]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_NATIVE_COMPANION_TEXT_UTF8_BYTES
  )
    return null;
  return value;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { role?: unknown }).role === "assistant" &&
    ((value as { id?: unknown }).id === undefined || typeof (value as { id?: unknown }).id === "string") &&
    ((value as { responseId?: unknown }).responseId === undefined ||
      typeof (value as { responseId?: unknown }).responseId === "string") &&
    Array.isArray((value as { content?: unknown }).content) &&
    typeof (value as { stopReason?: unknown }).stopReason === "string"
  );
}

function identityOf(message: AssistantMessage): Readonly<{ kind: "id" | "responseId"; value: string }> | undefined {
  if (typeof message.id === "string" && message.id.length > 0)
    return Object.freeze({ kind: "id", value: message.id });
  if (typeof message.responseId === "string" && message.responseId.length > 0)
    return Object.freeze({ kind: "responseId", value: message.responseId });
  return undefined;
}

function matchesIdentity(
  message: AssistantMessage,
  identity: Readonly<{ kind: "id" | "responseId"; value: string }>,
): boolean {
  return identity.kind === "id" ? message.id === identity.value : message.responseId === identity.value;
}

function isTextContent(value: unknown): value is Readonly<{ type: "text"; text: string }> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}
