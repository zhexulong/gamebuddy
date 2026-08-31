import { attachNativeCompanionContent } from "../native-companion-content.js";
import type { ProviderInvocationScope } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type {
  AttemptStartingTurn,
  CancelledTurn,
  ChatTurnLedger,
  CompletedTurn,
  FailedTurn,
  RunningTurn,
} from "./chat-thread-store.js";

/**
 * P4c's frozen canonical player envelope. It is rendered strictly from the
 * durable accepted message facts (the persisted player message text and the
 * idempotency-backed turn correlation) and never from a provider, model,
 * Memory, or any in-flight prompt fact.
 */
export const P4C_CANONICAL_DIALOGUE_INPUT_KIND = "gamebuddy_dialogue_input_v1" as const;

export type P4CCanonicalDialogueEnvelope = Readonly<{
  kind: typeof P4C_CANONICAL_DIALOGUE_INPUT_KIND;
  turnId: string;
  messageId: string;
  attemptId: string;
  idempotencyKey: string;
  acceptedAtMs: number;
  text: string;
  /** ChatThreadStore persists no language metadata; P4c must not infer one. */
  locale: "und";
}>;

/**
 * Serializes the canonical envelope in a fixed key order. `session.prompt`
 * receives exactly this string; no system prompting or memory materialization
 * is performed by P4c.
 */
export function renderCanonicalDialogueEnvelope(
  facts: Readonly<{
    turnId: string;
    messageId: string;
    attemptId: string;
    idempotencyKey: string;
    acceptedAtMs: number;
  }>,
  text: string,
): string {
  const envelope: P4CCanonicalDialogueEnvelope = Object.freeze({
    kind: P4C_CANONICAL_DIALOGUE_INPUT_KIND,
    turnId: facts.turnId,
    messageId: facts.messageId,
    attemptId: facts.attemptId,
    idempotencyKey: facts.idempotencyKey,
    acceptedAtMs: facts.acceptedAtMs,
    text,
    locale: "und",
  });
  return JSON.stringify(envelope);
}

export type ProviderStartResult =
  | Readonly<{ outcome: "completed"; ledger: CompletedTurn }>
  | Readonly<{ outcome: "cancelled"; ledger: CancelledTurn }>
  | Readonly<{ outcome: "failed"; ledger: FailedTurn }>
  | Readonly<{ outcome: "armed"; ledger: AttemptStartingTurn }>
  | Readonly<{ outcome: "not_started"; ledger: AttemptStartingTurn }>;
export type ProviderStartLedger = AttemptStartingTurn | CompletedTurn | CancelledTurn | FailedTurn;

/** Ephemeral delta projection; it has no message ID or durable authority. */
export type NativeChatPreview = Readonly<{
  turnId: string;
  delta: string;
}>;

export type NativeChatPreviewPublisher = Readonly<{
  publish(preview: NativeChatPreview): void | Promise<void>;
  clear(): void | Promise<void>;
}>;

export async function runMountedProviderStartLedger(
  scope: ProviderInvocationScope,
  previewPublisher?: NativeChatPreviewPublisher,
): Promise<ProviderStartLedger> {
  return (await runMountedProviderStart(scope, previewPublisher)).ledger;
}

function isDeadlineExpired(error: unknown): boolean {
  return error instanceof Error && /semantic_chat_runtime_p4_provider_start_deadline_expired/.test(error.message);
}

function requireAttemptStarting(
  ledger: AttemptStartingTurn | RunningTurn | FailedTurn | CancelledTurn,
  operation: string,
): AttemptStartingTurn {
  if (ledger.status !== "attempt_starting") throw new Error(`p4_provider_start_unexpected_${operation}`);
  return ledger;
}

function requireRunning(
  ledger: AttemptStartingTurn | RunningTurn | FailedTurn | CancelledTurn,
  operation: string,
): RunningTurn {
  if (ledger.status !== "running") throw new Error(`p4_provider_start_unexpected_${operation}`);
  return ledger;
}

function requireCompleted(ledger: ChatTurnLedger, operation: string): CompletedTurn {
  if (ledger.status !== "completed") throw new Error(`p5_presentation_unexpected_${operation}`);
  return ledger;
}

function requireFailed(ledger: ChatTurnLedger, reasonCode: FailedTurn["reasonCode"]): FailedTurn {
  if (ledger.status !== "failed" || ledger.reasonCode !== reasonCode)
    throw new Error(`p4_p5_unexpected_failed_${reasonCode}`);
  return ledger;
}

function requireFailedNoVisiblePresentation(ledger: ChatTurnLedger): FailedTurn {
  return requireFailed(ledger, "no_visible_presentation");
}

function isPresentationMissing(error: unknown): boolean {
  return error instanceof Error && /p5_presentation_completion_source_required/.test(error.message);
}

function nativeResponseMessageId(attemptId: string): string {
  // Internal durable message identity only. It is derived from the exact
  // Host-owned attempt, not from a Pi/provider response or tool call.
  return `chat_native_${attemptId}`;
}

async function currentTerminalResult(scope: ProviderInvocationScope): Promise<ProviderStartResult | undefined> {
  const ledger = await scope.readCurrentTurnLedger();
  if (ledger.status === "cancelled") return { outcome: "cancelled", ledger };
  if (ledger.status === "completed") return { outcome: "completed", ledger };
  if (ledger.status === "failed") return { outcome: "failed", ledger };
  return undefined;
}

/**
 * The exclusive P4c consumer. It runs inside the coordinator's close-drained
 * admission scope and performs, in frozen order:
 *
 *   pre-arm linearization -> session-bound observer arm -> arm linearization
 *   -> durable armed write/read-back -> invocation linearization (expired or
 *   revoked only while prompt has not begun -> durable not_started) ->
 *   exactly one `session.prompt()` (expandPromptTemplates:false, source:rpc)
 *   -> first after_provider_response observation -> running linearization ->
 *   durable running write/read-back.
 *
 * A fulfilled prompt settlement without an `after_provider_response` never
 * creates a `not_started`; the durable `armed` record remains and reopens
 * uncertain. A rejected or synchronously thrown prompt persists `failed`, so
 * the browser can reread the normal failure state and submit again. There is
 * no second Host invocation and no generation 2 on any path.
 */
export async function runMountedProviderStart(
  scope: ProviderInvocationScope,
  previewPublisher?: NativeChatPreviewPublisher,
): Promise<ProviderStartResult> {
  // Pre-arm linearization: an expired or revoked admission rejects with zero
  // store mutation and no Host prompt invocation.
  scope.assertAdmission();
  const runtimeSession = scope.runtimeSession;
  const installObserver =
    typeof runtimeSession.installTavernProviderStartObserver === "function"
      ? runtimeSession.installTavernProviderStartObserver
      : undefined;
  const promptFn = typeof runtimeSession.session?.prompt === "function" ? runtimeSession.session.prompt : undefined;
  let unregister: (() => void) | undefined;
  let releaseActivePrompt: (() => void) | undefined;
  let promptPromise: Promise<void> | undefined;
  let nativeObserver: ReturnType<typeof attachNativeCompanionContent> | undefined;
  let unsubscribeNativeAssistantStart: (() => void) | undefined;
  let unsubscribeNativeAssistantEnd: (() => void) | undefined;
  let resolveRunningBarrier!: (allowed: boolean) => void;
  const runningBarrier = new Promise<boolean>((resolve) => {
    resolveRunningBarrier = resolve;
  });
  let finalPresentationFailure: unknown | undefined;
  let responseMessageId: string | undefined;
  let previewPublished = false;
  let observationSettled = false;
  let providerRunning = false;
  let resolveNativeAssistantStart!: () => void;
  const nativeAssistantStarted = new Promise<void>((resolve) => {
    resolveNativeAssistantStart = resolve;
  });
  const observationReady = new Promise<"success" | "error">((resolve) => {
    if (installObserver === undefined) return;
    unregister = installObserver((fact) => {
      if (observationSettled) return;
      observationSettled = true;
      resolve(fact.statusClass);
    });
  });
  try {
    if (installObserver === undefined || promptFn === undefined) {
      // Arm linearization: the exact session surface is unavailable before a
      // Host invocation, so the durable record may safely classify not_started.
      scope.assertAdmission();
      const _armed = requireAttemptStarting(
        await scope.transitionStore({ operation: "arm", observedAtMs: Date.now() }),
        "arm",
      );
      // Exact session surface unavailable before the Host invocation. The
      // surviving process records its local pre-invocation proof durably.
      const ledger = requireAttemptStarting(
        await scope.transitionStore({
          operation: "not_started",
          reasonCode: "session_unavailable",
          observedAtMs: Date.now(),
        }),
        "not_started",
      );
      return { outcome: "not_started", ledger };
    }
    nativeObserver = attachNativeCompanionContent(runtimeSession.session, {
      onPreviewDelta: async (delta) => {
        if (!scope.canPreviewNativeContent()) return;
        // Each browser event carries an incremental, non-durable fragment.
        // It is scoped to the Host-owned turn, never a Pi message identity.
        // The browser contract accepts only NFC text. Pi may split a composed
        // character across chunks, so normalize each isolated preview fragment
        // before its volatile projection; final durable content is normalized
        // independently by the observer.
        const safeDelta = delta.normalize("NFC");
        if (Buffer.byteLength(safeDelta, "utf8") > 16_384 || previewPublisher === undefined) return;
        try {
          await previewPublisher.publish(
            Object.freeze({ turnId: scope.facts.turnId, delta: safeDelta }),
          );
        } catch {
          // Preview publication is explicitly non-durable. A stream/client
          // schema failure must not poison observer drain or strand P5 running.
          return;
        }
        previewPublished = true;
      },
      onFinalText: async (text) => {
        // Pi may emit its final assistant message before the asynchronous P4
        // observer continuation writes durable `running`. The content callback
        // therefore waits for that exact barrier; it never commits early.
        if (!(await runningBarrier)) return;
        const reservation = scope.reserveNativeContentCommit();
        if (reservation === undefined) return;
        try {
          const committedAtMs = Date.now();
          const committed = await scope.transitionPresentation({
            operation: "commit_presentation",
            cancelEpoch: reservation.cancelEpoch,
            message: {
              messageId: responseMessageId ??= nativeResponseMessageId(scope.facts.attemptId),
              text,
              occurredAtMs: committedAtMs,
            },
            committedAtMs,
          });
          if (committed.status !== "presentation_committed")
            throw new Error("native_content_presentation_commit_rejected");
        } catch (error) {
          // Observer callback failure is not a terminal authority. Preserve a
          // Stop winner when one exists; otherwise let the ordinary P5 failure
          // transition below terminalize the already-durable running attempt.
          finalPresentationFailure = error;
        } finally {
          reservation.release();
        }
      },
      onRejected: async (reason) => {
        if (reason === "error") finalPresentationFailure = new Error("native_content_provider_error");
      },
    });
    nativeObserver.open();
    // The observer is registered first so its final message_end callback is
    // queued before this boundary subscriber resolves P4 running.
    unsubscribeNativeAssistantStart = runtimeSession.session.subscribe((event: unknown) => {
      if (event === null || typeof event !== "object") return;
      const value = event as Readonly<{ type?: unknown; message?: unknown }>;
      if (
        value.type === "message_start" &&
        value.message !== null &&
        typeof value.message === "object" &&
        (value.message as { role?: unknown }).role === "assistant"
      )
        resolveNativeAssistantStart();
    });
    // Pi extension hooks complete before `AgentSession` listeners. Its native
    // assistant lifecycle can therefore settle before Magic Context emits the
    // provider-start observation. Record that lifecycle locally so the post-
    // prompt branch can still perform the exact durable running transition.
    unsubscribeNativeAssistantEnd = runtimeSession.session.subscribe((event: unknown) => {
      if (event === null || typeof event !== "object") return;
      const value = event as Readonly<{ type?: unknown; message?: unknown }>;
      if (
        value.type === "message_end" &&
        value.message !== null &&
        typeof value.message === "object" &&
        (value.message as { role?: unknown }).role === "assistant"
      )
        resolveNativeAssistantStart();
    });
    // Arm linearization: native assistant output is subscribed but cannot
    // commit before the durable running transition below succeeds.
    scope.assertAdmission();
    const armed = requireAttemptStarting(
      await scope.transitionStore({ operation: "arm", observedAtMs: Date.now() }),
      "arm",
    );
    // Invocation linearization: only while prompt has not begun may a failed
    // revalidation become a durable not_started.
    try {
      scope.assertAdmission();
    } catch (error) {
      const ledger = requireAttemptStarting(
        await scope.transitionStore({
          operation: "not_started",
          reasonCode: isDeadlineExpired(error) ? "invocation_deadline_expired" : "admission_revoked",
          observedAtMs: Date.now(),
        }),
        "not_started",
      );
      return { outcome: "not_started", ledger };
    }
    const text = await scope.readAcceptedMessageText();
    const envelope = renderCanonicalDialogueEnvelope(scope.facts, text);
    // The message read is asynchronous, so it cannot share the previous
    // linearization point. Revalidate immediately before the Host invocation.
    try {
      scope.assertAdmission();
    } catch (error) {
      const ledger = requireAttemptStarting(
        await scope.transitionStore({
          operation: "not_started",
          reasonCode: isDeadlineExpired(error) ? "invocation_deadline_expired" : "admission_revoked",
          observedAtMs: Date.now(),
        }),
        "not_started",
      );
      return { outcome: "not_started", ledger };
    }
    // Record the exact active prompt immediately before its one invocation so
    // an authenticated Stop cannot abort a successor turn.
    releaseActivePrompt = scope.beginActivePrompt();
    // Exactly one Host session.prompt invocation per exact attempt. Pi-owned
    // transport retries and agent-loop continuations are never counted or
    // re-invoked by Host. Preserve its settlement class so provider rejection
    // becomes the ordinary durable failure outcome rather than an uncertain
    // queued turn; a synchronous throw is equivalent to rejection.
    const settlePrompt = (): Promise<"fulfilled" | "rejected"> => {
      try {
        return promptFn.call(runtimeSession.session, envelope, {
          expandPromptTemplates: false,
          source: "rpc",
        }).then(
          () => "fulfilled" as const,
          () => "rejected" as const,
        );
      } catch {
        return Promise.resolve("rejected");
      }
    };
    const promptSettled = settlePrompt();
    promptPromise = promptSettled.then(() => undefined);
    const first = await Promise.race([
      observationReady.then((statusClass) => ({ phase: "observation" as const, statusClass })),
      nativeAssistantStarted.then(() => ({ phase: "native_assistant" as const })),
      promptSettled.then((settlement) => ({ phase: "prompt" as const, settlement })),
    ]);
    if (first.phase === "observation" || first.phase === "native_assistant") {
      // Pi may emit its native assistant lifecycle ahead of Magic Context's
      // provider observer. Both are source-owned proof that this exact prompt
      // has crossed Pi's provider boundary; the callback marker remains the
      // narrower provider audit evidence, not a presentation prerequisite.
      // Running linearization: a late/expired observer authorizes no running
      // write; the durable armed record remains and reopens uncertain.
      try {
        scope.assertAdmission();
      } catch {
        nativeObserver?.revoke();
        return { outcome: "armed", ledger: armed };
      }
      try {
        requireRunning(
          await scope.transitionStore({
            operation: "running",
            statusClass: first.phase === "observation" ? first.statusClass : "success",
            observedAtMs: Date.now(),
          }),
          "running",
        );
      } catch (error) {
        nativeObserver?.revoke();
        throw error;
      }
      providerRunning = true;
      resolveRunningBarrier(true);
      nativeObserver?.openPreviews();
      unsubscribeNativeAssistantStart?.();
      unsubscribeNativeAssistantStart = undefined;
      unsubscribeNativeAssistantEnd?.();
      unsubscribeNativeAssistantEnd = undefined;
      const settlement = await promptSettled;
      // Pi's message_end listeners run serially. `close()` converts the final
      // native snapshot into the sole P5 commit after prompt settlement.
      await nativeObserver?.close();
      nativeObserver = undefined;
      const terminal = await currentTerminalResult(scope);
      if (terminal !== undefined) return terminal;
      if (settlement === "rejected" || finalPresentationFailure !== undefined) {
        const failed = requireFailed(
          await scope.transitionPresentation({
            operation: "fail",
            reasonCode: "runtime_unavailable",
            failedAtMs: Date.now(),
          }),
          "runtime_unavailable",
        );
        return { outcome: "failed", ledger: failed };
      }
      try {
        await scope.transitionPresentation({
          operation: "claim_completion",
          claimedAtMs: Date.now(),
        });
      } catch (error) {
        // Ordinary SQLite Stop may win between the terminal read and this
        // completion transition. Reread it before classifying no presentation.
        const terminal = await currentTerminalResult(scope);
        if (terminal !== undefined) return terminal;
        if (!isPresentationMissing(error)) throw error;
        const failed = requireFailedNoVisiblePresentation(
          await scope.transitionPresentation({
            operation: "fail",
            reasonCode: "no_visible_presentation",
            failedAtMs: Date.now(),
          }),
        );
        return { outcome: "failed", ledger: failed };
      }
      const completed = requireCompleted(
        await scope.transitionPresentation({
          operation: "complete",
          completedAtMs: Date.now(),
        }),
        "complete",
      );
      return { outcome: "completed", ledger: completed };
    }
    // A provider rejection without observer is an ordinary terminal failure;
    // a fulfilled settlement without observer remains uncertain because Pi may
    // have run without producing a visible response observation.
    unsubscribeNativeAssistantStart?.();
    unsubscribeNativeAssistantStart = undefined;
    unsubscribeNativeAssistantEnd?.();
    unsubscribeNativeAssistantEnd = undefined;
    resolveRunningBarrier(false);
    if (first.settlement === "rejected") {
      // An ordinary Stop may have committed the durable terminal winner while
      // aborting the prompt. Never overwrite it with transport failure.
      const terminal = await currentTerminalResult(scope);
      if (terminal !== undefined) return terminal;
      const observedAtMs = Date.now();
      const failed = requireFailed(
        await scope.transitionStore({
          operation: "fail",
          reasonCode: "runtime_unavailable",
          observedAtMs,
          failedAtMs: observedAtMs,
        }),
        "runtime_unavailable",
      );
      return { outcome: "failed", ledger: failed };
    }
    return { outcome: "armed", ledger: armed };
  } finally {
    if (!providerRunning) resolveRunningBarrier(false);
    unregister?.();
    unsubscribeNativeAssistantStart?.();
    unsubscribeNativeAssistantEnd?.();
    nativeObserver?.revoke();
    if (previewPublished) await previewPublisher?.clear();
    if (promptPromise !== undefined) await promptPromise;
    await nativeObserver?.close();
    releaseActivePrompt?.();
  }
}
