import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { dehydrateCompanionSpeech, isEmptyAfterDehydration } from "./companion-speech-dehydration.js";
import { IncrementalSpeechAccumulator } from "./companion-speech-incremental.js";

const MAX_NATIVE_COMPANION_TEXT_UTF8_BYTES = 16_384;

type AssistantMessage = Readonly<{
  id?: string;
  responseId?: string;
  role: "assistant";
  content: readonly unknown[];
  stopReason?: string;
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
  /**
   * Optional complete-sentence projection: when this sink is provided the
   * observer treats the delta lane as the presentation lane and emits each
   * dehydrated sentence the moment its boundary arrives, in arrival order.
   * When it is absent the observer keeps its preview/final semantics exactly;
   * Chat consumers never provide it.
   */
  onIncrementalText?(text: string): void | Promise<void>;
  /** The one final safe native assistant text value, emitted at most once. */
  onFinalText(text: string): void | Promise<void>;
  /** No content is supplied to this sink. */
  onRejected(reason: "aborted" | "error" | "empty" | "empty_text" | "tool_only" | "unsupported_content" | "identity_mismatch"): void | Promise<void>;
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
 * from the matching assistant message. When the caller supplies
 * `onIncrementalText`, completed sentences are emitted from the delta lane as
 * they arrive and `onFinalText` then commits only the never-completed
 * residual; without that sink the preview/final semantics are unchanged.
 * Callers own surface-specific durable commit and cancellation admission.
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
  // Sentence accumulator per tracked assistant message. The accumulator starts
  // empty; only the delta lane feeds it, and every completed sentence leaves it
  // permanently, so consecutive conjunctions cannot double-emit.
  let incrementalAccumulator = new IncrementalSpeechAccumulator();
  const incrementalActive = sinks.onIncrementalText !== undefined;
  // Completed sentences held until message_end decides whether this assistant
  // message is the player-visible response. A Pi turn's intermediate tool-use
  // messages also carry text (the model's running commentary between actions),
  // and the non-incremental lane deliberately withholds those. Emitting at delta
  // time presented that commentary as companion speech — a real live run showed
  // the game saying "我在屋子里，先出门去农场。" and "先摘一颗。" to the player.
  //
  // Tradeoff: holding until message_end forfeits progressive emission of the
  // FINAL reply too, so a slowly-streamed reply reaches the surface later. That
  // is accepted because (a) presenting planning text is a hard product breach and
  // (b) `stopReason` is unavailable during the stream, so no deterministic rule
  // can separate reply from preamble earlier. Sentence chunking — the actual
  // goal here — is unaffected.
  let pendingSentences: string[] = [];
  // One working remark per Pi turn, released from the FIRST intermediate
  // tool-use message that carries one. A step report is emitted step by step,
  // so it appears in EVERY tool-use message; allowing exactly one piece per
  // turn therefore lets company through while making a running narration
  // structurally unable to reach the surface. This is a shape rule (how many
  // pieces, from where), not a semantic filter over the wording.
  let workingRemarkReleased = false;
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
      if (tracked === undefined && !finalizing && isAssistantLifecycleMessage(event.message)) {
        tracked = event.message;
        trackedIdentity = identityOf(event.message);
        trackedTextContentIndexes = new Set<number>();
        // A new tracked message must not inherit a previous message's buffered
        // stream: each assistant message owns its own sentence accumulator.
        incrementalAccumulator = new IncrementalSpeechAccumulator();
        pendingSentences = [];
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
        const delta = assistantMessageEvent.delta as string;
        // Preview semantics stay unchanged. Under incremental activation every
        // delta additionally feeds this message's accumulator; each sentence
        // completed in arrival order is dehydrated and emitted immediately, so
        // the surface can present finished dialogue before message_end.
        dispatch(async () => await sinks.onPreviewDelta(delta));
        if (incrementalActive) {
          // Hold completed sentences; message_end is the first point at which we
          // know whether this message is the player-visible response or an
          // intermediate tool-use step, so emission cannot happen here.
          for (const sentence of incrementalAccumulator.push(delta)) pendingSentences.push(sentence);
        }
      }
      return;
    }
    if (event.type !== "message_end") return;
    const finalMessage = event.message;
    if (!isAssistantLifecycleMessage(finalMessage)) return;
    // Pi delivers `message_end` serially after the matching assistant
    // lifecycle. Provider metadata may be absent entirely, but when one was
    // observed it must still match; a contradictory ID is foreign output.
    if (tracked !== undefined && trackedIdentity !== undefined && !matchesIdentity(finalMessage, trackedIdentity)) {
      finalizing = true;
      tracked = undefined;
      trackedIdentity = undefined;
      trackedTextContentIndexes = new Set<number>();
      incrementalAccumulator = new IncrementalSpeechAccumulator();
      pendingSentences = [];
      dispatch(async () => await sinks.onRejected("identity_mismatch"));
      return;
    }
    if (tracked !== undefined) {
      // Capture the exact accumulator before resetting the binding: message_end
      // must be able to flush the residual stream it never emitted as sentences.
      const messageAccumulator = incrementalAccumulator;
      const messageSentences = pendingSentences;
      tracked = undefined;
      trackedIdentity = undefined;
      trackedTextContentIndexes = new Set<number>();
      incrementalAccumulator = new IncrementalSpeechAccumulator();
      pendingSentences = [];
      // A tool-use assistant message is an intermediate agent-loop result, not
      // the player-visible final response. It may be followed by a typed Game
      // action and another assistant message, so it must never terminalize this
      // observer. Its text is the model's running commentary between actions:
      // the non-incremental lane withholds it entirely, because that lane's
      // single-shot contract has nowhere to put it.
      //
      // Under incremental activation (Game only) the surface is a sequence of
      // short native expressions instead of one message, so a bounded remark
      // from such a message is legitimate company while working -- and its
      // absence is what left the player in silence for the whole task.
      //
      // This stays a structural rule: one piece, from the first sentence, under
      // a byte bound. It deliberately does NOT try to judge whether a short
      // remark reads as company or as narration, because that is the conduct's
      // job and a semantic filter here would be a detector whose recall we would
      // have to trust. What the rule guarantees is that a multi-step checklist
      // and a long report cannot reach the surface. Whether the surviving short
      // pieces feel like company is measured by the live run, not asserted here.
      if (finalMessage.stopReason === "toolUse") {
        if (!incrementalActive || workingRemarkReleased) return;
        // Text of this intermediate message, already dehydrated at emission
        // time below; the first piece of the stream is where a genuine
        // "here I am / look at this" lands, so that is the one we take.
        const remark = messageSentences[0] ?? messageAccumulator.flush();
        if (isEmptyAfterDehydration(remark)) return;
        const dehydrated = dehydrateCompanionSpeech(remark);
        if (dehydrated.length === 0) return;
        workingRemarkReleased = true;
        dispatch(async () => await sinks.onIncrementalText!(dehydrated));
        return;
      }
      finalizing = true;
      const stopReason = typeof finalMessage.stopReason === "string" ? finalMessage.stopReason : "stop";
      if (stopReason === "aborted") {
        dispatch(async () => await sinks.onRejected("aborted"));
        return;
      }
      if (stopReason === "error") {
        dispatch(async () => await sinks.onRejected("error"));
        return;
      }
      if (incrementalActive) {
        // This message is the player-visible reply, so release its completed
        // sentences in arrival order, then the residual that never finished a
        // sentence. Sentences are held until here because `stopReason` is the
        // first point that separates the reply from an intermediate tool-use
        // preamble; see the accumulator comment above.
        for (const sentence of messageSentences) {
          if (isEmptyAfterDehydration(sentence)) continue;
          dispatch(async () => await sinks.onIncrementalText!(dehydrateCompanionSpeech(sentence)));
        }
        const residual = messageAccumulator.flush();
        if (!isEmptyAfterDehydration(residual))
          dispatch(async () => await sinks.onFinalText(dehydrateCompanionSpeech(residual)));
        return;
      }
      const text = readSafeAssistantText(finalMessage);
      if (text === null) {
        const hasText = finalMessage.content.some(isTextContent);
        const hasTool = finalMessage.content.some(
          (entry) => typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "toolCall",
        );
        const reason = hasTool ? "tool_only" : hasText ? "unsupported_content" : "empty_text";
        dispatch(async () => await sinks.onRejected(reason));
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
  const joined = message.content
    .filter(isTextContent)
    .map((entry) => entry.text)
    .join("")
    .trim()
    .normalize("NFC");
  // Dehydrate stage direction first (roleplay beats, asides, reasoning blocks)
  // so the native chat box never shows the model's scaffolding. Pure-beat
  // replies dehydrate to empty and are rejected below.
  const value = dehydrateCompanionSpeech(joined);
  if (
    value.length === 0 ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_NATIVE_COMPANION_TEXT_UTF8_BYTES
  )
    return null;
  return value;
}

function isAssistantLifecycleMessage(value: unknown): value is AssistantMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { role?: unknown }).role === "assistant" &&
    Array.isArray((value as { content?: unknown }).content) &&
    ((value as { id?: unknown }).id === undefined || typeof (value as { id?: unknown }).id === "string") &&
    ((value as { responseId?: unknown }).responseId === undefined ||
      typeof (value as { responseId?: unknown }).responseId === "string")
  );
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
    ((value as { stopReason?: unknown }).stopReason === undefined || typeof (value as { stopReason?: unknown }).stopReason === "string")
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
