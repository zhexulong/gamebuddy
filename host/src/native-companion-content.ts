import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import {
  budgetedSpeechPieces,
  CHAT_DELIVERY_PACING,
  selectReactionSound,
  typingDurationMs,
  type CompanionDeliveryPacing,
} from "./companion-delivery-pacing.js";
import { removeModelScaffolding } from "./companion-scaffolding.js";
import { dehydrateCompanionSpeech, isEmptyAfterDehydration } from "./companion-speech-dehydration.js";
import { IncrementalSpeechAccumulator } from "./companion-speech-incremental.js";

const MAX_NATIVE_COMPANION_TEXT_UTF8_BYTES = 16_384;

/**
 * How long a completed sentence may stay unspoken before the player has had
 * time to notice the silence. It is the point where the companion says one
 * thing while it works instead of leaving the game silent; anything it says
 * about its own actions after that is what the shape rule below forbids.
 *
 * It is the fallback, not the rule: a surface with typing pacing on measures
 * the sentence instead (`typingDurationMs`), so a short remark lands sooner and
 * a long one later instead of everything arriving on one flat beat.
 */
const WORKING_REMARK_SILENCE_MS = 3_000;

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

/**
 * The explicit presentation choice, named once per surface.
 *
 * `"strip"` removes stage direction (`*...*` beats, reasoning frames) before the
 * sinks; the in-game bubble and the voice cannot render it. `"keep"` passes the
 * model's exact text to the sinks; the Chat transcript renderer draws the
 * asterisk beat (`.message-action`) and its durable row must hold what the model
 * wrote.
 *
 * Stage direction is `*...*`, never a bracket. An inline bracket group such as
 * `（轻声）` is a prosody direction the voice channel performs instead of
 * speaking, and `dehydrateCompanionSpeech` deliberately preserves it for that
 * lane - so `"strip"` passes it through to the bubble as well. That is the
 * accepted cost, not an oversight: the same text feeds `onPreviewDelta` into
 * `voiceSink.append`, and a projection here that removed the tag to tidy the
 * bubble would delete the emotion channel that consumer reads. Both surfaces
 * therefore keep it, and the Chat renderer is the one that dresses it (a leading
 * run as a badge, `MOOD_TAG_CLASS`); the bubble prints it as her words.
 */
export type StageDirectionPresentation = "strip" | "keep";

/** The in-game bubble and the voice: neither can draw a `*...*` beat. */
export const NATIVE_BUBBLE_STAGE_DIRECTION = "strip" as const;

/**
 * The Chat transcript: its renderer draws the beat, so its durable row is the
 * model's own output rather than a display projection. A Chat persistence lane
 * that strips here writes a quote-only row the renderer can no longer style, and
 * the deletion is irreversible for every message already generated.
 */
export const CHAT_TRANSCRIPT_STAGE_DIRECTION = "keep" as const;

/**
 * The model-scaffolding rule, named once per surface beside the stage-direction
 * pair above.
 *
 * Scaffolding (`<thinking>...</thinking>`, `（思考：...）`, `【内心：...】`,
 * `**emphasis**`, `---` rules) is leakage and goes; action beats are performance
 * and stay. `"drop"` removes scaffolding from the text the surface receives.
 * `"unchanged"` adds nothing of its own: the in-game bubble and the voice
 * already run `dehydrateCompanionSpeech`, whose frozen behaviour this axis must
 * not change.
 */
export type ScaffoldingPresentation = "drop" | "unchanged";

/** The Chat transcript: the row the player reads back is never the model's scratchpad. */
export const CHAT_TRANSCRIPT_SCAFFOLDING = "drop" as const;

/** The in-game bubble and the voice: their projection already removes scaffolding. */
export const NATIVE_BUBBLE_SCAFFOLDING = "unchanged" as const;

export type NativeCompanionContentOptions = Readonly<{
  stageDirection: StageDirectionPresentation;
  scaffolding: ScaffoldingPresentation;
  /**
   * The humanised delivery policy, chosen per surface (`GAME_DELIVERY_PACING` in
   * `companion-loop.ts`, `CHAT_DELIVERY_PACING` here as the default). Absent
   * means the Chat default: every mechanism off, so the delivery is exactly
   * what it was before pacing existed.
   */
  pacing?: CompanionDeliveryPacing | null;
  /**
   * The turn's own identity and language, which the reaction mechanism seeds its
   * choice from and picks its vocabulary by. Absent means no reaction: a sound in
   * a language the surface never named is worse than the silence it replaced.
   */
  turn?: Readonly<{ id: string; locale?: string }>;
}>;

/**
 * Pi's assistant-message `stopReason`, as its own `message-types.md` declares it.
 * The one member these sinks act on is `"length"`: the provider stopped at the
 * model's output ceiling, so what the player can read is a prefix of what was
 * being written. Every other member means "not that", and a message that reports
 * no reason at all is read as `"stop"` - saying nothing is the honest answer
 * there, because the text itself never tells a cut-off reply from a finished one.
 */
export type NativeAssistantStopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type NativeCompanionContentSinks = Readonly<{
  /**
   * Ephemeral player-visible streaming hint; it is never durable authority.
   * The observer opens this only after its caller's explicit durable barrier.
   */
  onPreviewDelta(delta: string): void | Promise<void>;
  /**
   * Optional mid-message piece: when this sink is provided the observer may
   * release ONE working remark per assistant turn - the first completed sentence
   * of an open message, and only after the player has been silent for a real
   * pause. Everything else leaves through `onFinalText`. When it is absent the
   * observer keeps its preview/final semantics exactly; Chat consumers never
   * provide it.
   */
  onIncrementalText?(text: string): void | Promise<void>;
  /**
   * The one final safe native assistant text value, emitted at most once, with
   * the stop reason Pi recorded for the message it came from. The reason is the
   * only source of `"length"`, which is what makes a reply the player can read a
   * prefix rather than a whole; a surface with no durable place for the fact
   * ignores it, and one whose provider reported none receives `"stop"` and
   * therefore says nothing rather than guessing from the text.
   */
  onFinalText(text: string, stopReason: NativeAssistantStopReason): void | Promise<void>;
  /** No content is supplied to this sink. */
  onRejected(
    reason: "aborted" | "error" | "empty" | "empty_text" | "tool_only" | "unsupported_content" | "identity_mismatch",
  ): void | Promise<void>;
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
 * `onIncrementalText`, one working remark may leave mid-message after a real
 * silence; the message's own text then commits once, as a single paragraph, at
 * `message_end`. Without that sink the preview/final semantics are unchanged.
 * Callers own surface-specific durable commit and cancellation admission.
 *
 * `options.stageDirection` is the explicit presentation choice. `"strip"` is
 * for a surface that cannot draw a `*...*` beat (the in-game bubble, the voice);
 * `"keep"` is for the Chat transcript, whose renderer draws the beat
 * (`.message-action`). It is a parameter, not a regex exception, so the two
 * pipes cannot silently share one behaviour again.
 *
 * `options.scaffolding` is the second, independent choice. `"drop"` removes
 * model-internal scaffolding (`<thinking>`, `（思考：...）`, `【内心：...】`,
 * `**emphasis**`, `---` rules) while leaving every `*...*` beat byte-identical;
 * `"unchanged"` adds nothing, which is what a surface whose projection already
 * removes scaffolding must say. The two axes are separate because they answer
 * separate questions: whether the surface can *draw* a beat, and whether the
 * text it receives is the player's or the model's.
 */
export function attachNativeCompanionContent(
  session:
    | Pick<AgentSession, "subscribe">
    | Readonly<{ subscribe(listener: (event: NativeCompanionContentEvent) => void): () => void }>,
  sinks: NativeCompanionContentSinks,
  options: NativeCompanionContentOptions,
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
  // Explicit presentation choice, never inferred from the sink shape: the Game
  // bubble and the voice strip stage direction; the Chat transcript keeps it.
  const stripStageDirection = options.stageDirection === "strip";
  const dropScaffolding = options.scaffolding === "drop";
  const present = (text: string): string => {
    if (stripStageDirection) return dehydrateCompanionSpeech(text);
    const normalized = text.normalize("NFC");
    return dropScaffolding ? removeModelScaffolding(normalized) : normalized;
  };
  const presentIsEmpty = (text: string): boolean =>
    stripStageDirection ? isEmptyAfterDehydration(text) : text.trim().length === 0;
  // Completed sentences held until this message's fate is known. A Pi turn's
  // intermediate tool-use messages also carry text (the model's running
  // commentary between actions), and presenting that commentary as companion
  // speech is a hard product breach a real live run produced ("我在屋子里，先出门去农场。").
  // A real Pi session probe proved `toolcall_start` arrives AFTER the preamble's
  // `text_delta`, and a presented bubble cannot be retracted, so a message's
  // fate is only settled at `message_end`.
  //
  // That cannot mean "silent until message_end" either: a reply the model streams
  // over several seconds left the player in silence and then put the whole answer
  // on screen in one instant. The two rules that replace it are named below: one
  // working remark per turn after a real silence, and everything still held at
  // `message_end` as one paragraph.
  let pendingSentences: string[] = [];
  // The pacing policy this surface chose. Absent means the Chat default, where
  // all three mechanisms are off and delivery is byte-identical to what it was
  // before pacing existed.
  const pacing = options.pacing ?? CHAT_DELIVERY_PACING;
  const typing = pacing.typing;
  const reaction = pacing.reaction;
  const lengthBudget = pacing.lengthBudget;
  const turnIdentity = options.turn;
  let reactionReleased = false;
  // One working remark per Pi turn. A step report is emitted step by step, so it
  // appears in EVERY tool-use message; allowing exactly one piece per turn
  // therefore lets company through while making a running narration structurally
  // unable to reach the surface. This is a shape rule (how many pieces, from
  // where), not a semantic filter over the wording. The one piece is released
  // either while a message is still streaming (the silence timer below) or, when
  // a tool-use message ends sooner than that, from its first sentence.
  let workingRemarkReleased = false;
  let callbackTail = Promise.resolve();
  let remarkTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;

  const dispatch = (callback: () => void | Promise<void>): void => {
    if (revoked || closed) return;
    callbackTail = callbackTail.then(callback);
  };

  /**
   * Emits this turn's one reaction sound, if the surface asked for one and the
   * turn's language has vocabulary for it. It runs at the head of the first
   * dispatched piece, and `dispatch` serializes that queue, so the sound is
   * always heard before the words it introduces. The sound is a closed-set
   * interjection chosen from the turn's own identity: it asserts nothing about
   * the world, so a reply that never happened cannot be implied by it.
   */
  const emitReaction = async (): Promise<void> => {
    if (reactionReleased) return;
    reactionReleased = true;
    if (reaction === null || !incrementalActive || turnIdentity === undefined) return;
    const sound = selectReactionSound(turnIdentity.id, turnIdentity.locale ?? "", reaction);
    if (sound === null) return;
    await sinks.onIncrementalText!(sound);
  };

  /**
   * The pieces one presented paragraph becomes. Without a budget, or without the
   * incremental lane to carry the earlier pieces, the paragraph stays whole: the
   * length mechanism only ever splits at sentence boundaries the accumulator
   * already recognizes, and the caller hands the LAST piece to `onFinalText` so a
   * budgeted reply still commits exactly once.
   */
  const splitForBudget = (text: string): readonly string[] => {
    if (lengthBudget === null || !incrementalActive) return [text];
    return budgetedSpeechPieces(text, lengthBudget);
  };

  /**
   * How long the held first sentence may stay unspoken.
   *
   * A short remark lands sooner than the flat beat and a long one lands on it - it
   * never lands LATER. That asymmetry is the whole point of the mechanism: the
   * first piece exists to end the silence, so content-proportional typing time may
   * pull it forward but may not push it back. Measured on a six-second turn, an
   * unbounded version spoke at 5401 ms against the flat beat's 3011 ms, which made
   * pacing cost more silence than it removed.
   */
  const workingRemarkDelayMs = (sentence: string): number =>
    typing === null
      ? WORKING_REMARK_SILENCE_MS
      : Math.min(WORKING_REMARK_SILENCE_MS, typingDurationMs(present(sentence), typing));

  /**
   * Arms this turn's one working remark: holds the first completed sentence of
   * whatever message is streaming and releases it once its own typing time has
   * passed. A message that finishes sooner never arms anything, so an ordinary
   * reply is not cut in half by this.
   */
  const scheduleWorkingRemark = (): void => {
    if (!incrementalActive || workingRemarkReleased || remarkTimer !== undefined) return;
    if (pendingSentences.length === 0) return;
    remarkTimer = setTimeout(() => {
      remarkTimer = undefined;
      dispatch(async () => {
        if (revoked || closed || finalizing || workingRemarkReleased || tracked === undefined) return;
        const first = pendingSentences.shift();
        if (first === undefined) return;
        if (presentIsEmpty(first)) {
          // Text the player cannot hear is not a remark, so it must not spend the
          // turn's one piece: wait for the next sentence instead.
          scheduleWorkingRemark();
          return;
        }
        workingRemarkReleased = true;
        const piece = present(first);
        await emitReaction();
        for (const part of splitForBudget(piece)) await sinks.onIncrementalText!(part);
      });
    }, workingRemarkDelayMs(pendingSentences[0]!));
  };

  const clearRemarkTimer = (): void => {
    if (remarkTimer === undefined) return;
    clearTimeout(remarkTimer);
    remarkTimer = undefined;
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
        clearRemarkTimer();
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
      const partial = isAssistantMessage(assistantMessageEvent.partial) ? assistantMessageEvent.partial : undefined;
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
          // Each sentence that completes inside this delta joins the message's
          // held paragraph; the silence timer decides whether the first one has
          // been held long enough to be spoken as the turn's working remark.
          for (const sentence of incrementalAccumulator.push(delta)) pendingSentences.push(sentence);
          if (pendingSentences.length > 0) scheduleWorkingRemark();
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
      clearRemarkTimer();
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
      clearRemarkTimer();
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
      // absence is what left the player in silence for the whole task. The
      // silence timer has already spent the turn's piece when the message
      // outlived it, so this only covers a message that ended sooner.
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
        if (presentIsEmpty(remark)) return;
        const piece = present(remark);
        if (piece.length === 0) return;
        workingRemarkReleased = true;
        dispatch(async () => {
          await emitReaction();
          for (const part of splitForBudget(piece)) await sinks.onIncrementalText!(part);
        });
        return;
      }
      finalizing = true;
      const stopReason = readStopReason(finalMessage.stopReason);
      if (stopReason === "aborted") {
        dispatch(async () => await sinks.onRejected("aborted"));
        return;
      }
      if (stopReason === "error") {
        dispatch(async () => await sinks.onRejected("error"));
        return;
      }
      if (incrementalActive) {
        // One finished reply is one paragraph. Emitting each held sentence
        // separately put four bubbles in front of the player inside the same
        // instant, which reads as a stutter rather than as speech; the only
        // piece allowed to leave early is the working remark above. Joining the
        // raw units before dehydrating keeps the space between two English
        // sentences, which per-unit dehydration would trim off.
        const paragraph = present([...messageSentences, messageAccumulator.flush()].join(""));
        if (!presentIsEmpty(paragraph)) {
          const pieces = splitForBudget(paragraph);
          dispatch(async () => {
            await emitReaction();
            for (const piece of pieces.slice(0, -1)) await sinks.onIncrementalText!(piece);
            await sinks.onFinalText(pieces[pieces.length - 1]!, stopReason);
          });
        }
        return;
      }
      const text = readSafeAssistantText(finalMessage, stripStageDirection, dropScaffolding);
      if (text === null) {
        const hasText = finalMessage.content.some(isTextContent);
        const hasTool = finalMessage.content.some(
          (entry) => typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "toolCall",
        );
        const reason = hasTool ? "tool_only" : hasText ? "unsupported_content" : "empty_text";
        dispatch(async () => await sinks.onRejected(reason));
        return;
      }
      dispatch(async () => await sinks.onFinalText(text, stopReason));
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
      clearRemarkTimer();
      unsubscribe?.();
      unsubscribe = undefined;
    },
    async close(): Promise<void> {
      if (closed) return await callbackTail;
      clearRemarkTimer();
      unsubscribe?.();
      unsubscribe = undefined;
      await callbackTail;
      closed = true;
    },
  });
}

/**
 * The exact text the durable Chat transcript holds for one Pi user message, or
 * `null` when the message is not the player's own line. Pi persists the prompt
 * the Host passed (`agent-session.js` `_prepareRun`), which is the store's own
 * player row text, so the comparison is exact.
 *
 * The pair of projections lives here, beside the row each one writes: a Pi
 * entry is compared against the transcript row it produced (`pi-session-variant-branch.internal.ts`)
 * and against the line a mount anchors the session with (`pi-session-greeting-anchor.internal.ts`),
 * and each comparison is exact only while every reader runs the one projection the row was written
 * from.
 */
export function chatTranscriptPlayerText(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const value = message as { role?: unknown; content?: unknown };
  if (value.role !== "user") return null;
  if (typeof value.content === "string") return value.content.length === 0 ? null : value.content;
  if (!Array.isArray(value.content)) return null;
  const parts: string[] = [];
  for (const part of value.content) {
    if (typeof part !== "object" || part === null) continue;
    const entry = part as { type?: unknown; text?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") parts.push(entry.text);
  }
  return parts.length === 0 ? null : parts.join("");
}

/**
 * The exact text the durable Chat transcript holds for one Pi assistant message,
 * or `null` when that message carries none this surface can persist.
 *
 * Exported because a same-position variant compares a Pi entry against the row
 * that entry produced (`pi-session-variant-branch.internal.ts`), and that
 * comparison is exact only while both sides run this one projection: the row's
 * text is the value this function returned when the entry was committed.
 */
export function chatTranscriptAssistantText(message: unknown): string | null {
  if (!isAssistantLifecycleMessage(message)) return null;
  const flags = presentationFlags(CHAT_TRANSCRIPT_STAGE_DIRECTION, CHAT_TRANSCRIPT_SCAFFOLDING);
  return readSafeAssistantText(message, flags.stripStageDirection, flags.dropScaffolding);
}

/** The two named presentation choices as the booleans `readSafeAssistantText` takes. */
function presentationFlags(
  stageDirection: StageDirectionPresentation,
  scaffolding: ScaffoldingPresentation,
): Readonly<{ stripStageDirection: boolean; dropScaffolding: boolean }> {
  return { stripStageDirection: stageDirection === "strip", dropScaffolding: scaffolding === "drop" };
}

function readSafeAssistantText(
  message: AssistantMessage,
  stripStageDirection: boolean,
  dropScaffolding: boolean,
): string | null {
  const joined = message.content
    .filter(isTextContent)
    .map((entry) => entry.text)
    .join("")
    .trim()
    .normalize("NFC");
  // A `strip` surface cannot draw a `*...*` beat, so its scaffolding is
  // removed here and a pure-beat reply is rejected below. A `keep` surface (the
  // Chat transcript) receives the model's exact text: its renderer draws the
  // beat, and the only thing the row drops is model scaffolding, never a beat
  // and never ordinary prose.
  const value = stripStageDirection
    ? dehydrateCompanionSpeech(joined)
    : dropScaffolding
      ? removeModelScaffolding(joined)
      : joined;
  if (
    value.length === 0 ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_NATIVE_COMPANION_TEXT_UTF8_BYTES
  )
    return null;
  return value;
}

function readStopReason(value: unknown): NativeAssistantStopReason {
  switch (value) {
    case "pending":
    case "stop":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
    case "deferred":
      return value;
    default:
      return "stop";
  }
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
    ((value as { stopReason?: unknown }).stopReason === undefined ||
      typeof (value as { stopReason?: unknown }).stopReason === "string")
  );
}

function identityOf(message: AssistantMessage): Readonly<{ kind: "id" | "responseId"; value: string }> | undefined {
  if (typeof message.id === "string" && message.id.length > 0) return Object.freeze({ kind: "id", value: message.id });
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
