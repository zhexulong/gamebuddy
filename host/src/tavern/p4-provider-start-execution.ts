import {
  attachNativeCompanionContent,
  CHAT_TRANSCRIPT_SCAFFOLDING,
  CHAT_TRANSCRIPT_STAGE_DIRECTION,
} from "../native-companion-content.js";
import type { ProviderInvocationScope } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type { PiVariantBranch } from "../pi-session-variant-branch.internal.js";
import { bindSettledPromptEntries, sessionEntryIds } from "../pi-session-variant-branch.internal.js";
import type {
  AttemptStartingTurn,
  CancelledTurn,
  ChatTurnLedger,
  CompletedTurn,
  FailedTurn,
  RunningTurn,
} from "./chat-thread-store.js";

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

/**
 * Host-owned voice degradation boundary shared with Chat presentations.
 * Absent publisher => no voice surface (same as absent preview publisher); a
 * publisher that throws is caught locally and never poisons the observer.
 */
export type NativeChatSpeechSink = Readonly<{
  begin(turnId: string): void | Promise<void>;
  append(delta: string): void | Promise<void>;
  finalize(): void | Promise<void>;
  cancel(): void | Promise<void>;
}>;

/**
 * The Chat turn's pacing, chosen before the prompt is sent.
 *
 * Resolved by the caller rather than read here, so this module never opens the
 * player-preference record on a path that also owns durable turn transitions: a
 * settings read failing must not be able to strand a claimed attempt.
 */
export type NativeChatDeliveryPacing = import("../companion-delivery-pacing.js").CompanionDeliveryPacing;

export async function runMountedProviderStartLedger(
  scope: ProviderInvocationScope,
  previewPublisher?: NativeChatPreviewPublisher,
  speechSink?: NativeChatSpeechSink,
  pacing?: NativeChatDeliveryPacing,
): Promise<ProviderStartLedger> {
  return (await runMountedProviderStart(scope, previewPublisher, speechSink, pacing)).ledger;
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

/**
 * The one settlement authority for a published cancel claim, and the only
 * consumer of `record.cancellation`. The mounted cancel seam
 * (`stopMountedChatPresentationEpoch`) publishes the durable winner before it
 * aborts the prompt, and for a turn that already crossed its provider boundary
 * that winner is `cancel_claimed` - deliberately non-terminal, because the
 * mount's transition authority is revoked when the mount is released and this
 * runner is the writer that owns the prompt drain. So the runner asks this
 * before every terminal write: the stop's own abort must never resurface as
 * this turn's failure. `undefined` means no stop raced this invocation, and
 * every other winner is already a durable representation to preserve.
 */
export async function settlePublishedCancellation(
  scope: ProviderInvocationScope,
): Promise<ProviderStartResult | undefined> {
  const winner = await scope.finalizeCancellation();
  if (winner === undefined) return undefined;
  switch (winner.status) {
    case "cancelled":
      return { outcome: "cancelled", ledger: winner };
    case "failed":
      return { outcome: "failed", ledger: winner };
    case "completed":
      return { outcome: "completed", ledger: winner };
    case "cancel_claimed": {
      const cancelled = await scope.transitionPresentation({
        operation: "cancel",
        cancelledAtMs: Date.now(),
      });
      if (cancelled.status !== "cancelled") throw new Error("p5_presentation_cancelled_required");
      return { outcome: "cancelled", ledger: cancelled };
    }
    case "completion_claimed": {
      const completed = await scope.transitionPresentation({
        operation: "complete",
        completedAtMs: Date.now(),
      });
      if (completed.status !== "completed") throw new Error("p5_presentation_completed_required");
      return { outcome: "completed", ledger: completed };
    }
  }
}

/**
 * The durable terminal winner for this exact turn: the published cancel claim
 * if one raced this invocation, otherwise the fresh ledger. A non-terminal
 * `cancel_claimed` is a winner this runner must terminalize, not an
 * absence of a winner.
 */
async function currentTerminalResult(scope: ProviderInvocationScope): Promise<ProviderStartResult | undefined> {
  const settled = await settlePublishedCancellation(scope);
  if (settled !== undefined) return settled;
  const ledger = await scope.readCurrentTurnLedger();
  if (ledger.status === "cancelled") return { outcome: "cancelled", ledger };
  if (ledger.status === "completed") return { outcome: "completed", ledger };
  if (ledger.status === "failed") return { outcome: "failed", ledger };
  return undefined;
}

/**
 * The durable failure one pre-commit refusal settles as: a proven no-write
 * refusal (a refused variant branch, a rejected prompt) leaves no visible
 * presentation, and an ordinary Stop that terminalized the attempt first is
 * preserved rather than overwritten.
 */
async function failRuntimeUnavailable(scope: ProviderInvocationScope): Promise<ProviderStartResult> {
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
  speechSink?: NativeChatSpeechSink,
  pacing?: NativeChatDeliveryPacing,
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
  let variantBranch: PiVariantBranch | undefined;
  let variantBranchRetained = false;
  let responseMessageId: string | undefined;
  /** The exact text this turn's visible reply was committed with, or `undefined` when none was. */
  let committedReplyText: string | undefined;
  /** Every session entry that existed before this prompt, so what it appended is an identity fact. */
  let entriesBefore: ReadonlySet<string> | undefined;
  /** The exact accepted player text this prompt was invoked with. */
  let promptText: string | undefined;
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
  /**
   * Records which Pi session entries this prompt appended for the durable rows this turn wrote - the
   * `(thread_id, message_id, entry_id)` binding a single-row delete reads back. Nothing else names
   * that correspondence, which is why a delete could not exist before it: a rewind proves a dropped
   * suffix positionally, but a hole in the middle has to name the exact entry the player pointed at.
   *
   * The two rows are the ones this turn actually wrote: normally the accepted player row and the
   * reply row this attempt committed, and for a same-position variant turn the anchor player row its
   * prompt re-asked and the reply position it regenerated. A row the prompt produced a candidate for
   * that is not exactly one entry records nothing (see `bindSettledPromptEntries`), and the write can
   * never fail the turn it describes - the reply is already durable by the time this runs, and a row
   * with no binding is the honest state a delete refuses on.
   */
  const recordSettledPromptEntries = async (): Promise<void> => {
    if (entriesBefore === undefined || promptText === undefined) return;
    const variant = scope.facts.variant;
    const playerMessageId = variant?.anchorMessageId ?? scope.facts.messageId;
    const replyMessageId = variant === null ? responseMessageId : variant.targetMessageId;
    const bindings = bindSettledPromptEntries(runtimeSession.sessionManager, entriesBefore, {
      playerText: promptText,
      replyText: committedReplyText ?? null,
    });
    const rows: Readonly<{ messageId: string; entryId: string }>[] = [];
    for (const binding of bindings) {
      const messageId = binding.role === "player" ? playerMessageId : replyMessageId;
      if (messageId === undefined) continue;
      rows.push(Object.freeze({ messageId, entryId: binding.entryId }));
    }
    if (rows.length === 0) return;
    try {
      await scope.recordTranscriptEntryBinding(rows);
    } catch {
      process.stderr.write("[binding] transcript entry binding not recorded\n");
    }
  };
  try {
    if (installObserver === undefined || promptFn === undefined) {
      // Arm linearization: the exact session surface is unavailable before a
      // Host invocation, so the durable record may safely classify not_started.
      scope.assertAdmission();
      requireAttemptStarting(await scope.transitionStore({ operation: "arm", observedAtMs: Date.now() }), "arm");
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
    nativeObserver = attachNativeCompanionContent(
      runtimeSession.session,
      {
        onPreviewDelta: async (delta) => {
          if (!scope.canPreviewNativeContent()) return;
          // Each browser event carries an incremental, non-durable fragment.
          // It is scoped to the Host-owned turn, never a Pi message identity.
          // The browser contract accepts only NFC text. Pi may split a composed
          // character across chunks, so normalize each isolated preview fragment
          // before its volatile projection; final durable content is normalized
          // independently by the observer.
          const safeDelta = delta.normalize("NFC");
          // Same delta stream feeds the Host-owned voice sink when one is
          // attached; a voice failure is Voice-local and never poisons the
          // observer's browser preview or the durable P5 commit.
          if (speechSink !== undefined) {
            try {
              await speechSink.append(safeDelta);
            } catch {
              // Voice degradation: the surface reader will project unavailable.
            }
          }
          if (Buffer.byteLength(safeDelta, "utf8") > 16_384 || previewPublisher === undefined) return;
          try {
            await previewPublisher.publish(Object.freeze({ turnId: scope.facts.turnId, delta: safeDelta }));
          } catch {
            // Preview publication is explicitly non-durable. A stream/client
            // schema failure must not poison observer drain or strand P5 running.
            return;
          }
          previewPublished = true;
        },
        onFinalText: async (text, stopReason) => {
          // Also finalize the voice sink so the speech job is settled.
          if (speechSink !== undefined) {
            try {
              await speechSink.finalize();
            } catch {
              // Voice degradation is always graceful.
            }
          }
          // Pi may emit its final assistant message before the asynchronous P4
          // observer continuation writes durable `running`. The content callback
          // therefore waits for that exact barrier; it never commits early.
          if (!(await runningBarrier)) return;
          const reservation = scope.reserveNativeContentCommit();
          if (reservation === undefined) return;
          try {
            const committedAtMs = Date.now();
            // The one generation this turn records ended either at its own last
            // token or at the model's length ceiling, and Pi said which. That
            // fact belongs to THIS generation's durable presentation record, so a
            // later Regenerate - a turn of its own, with a record of its own -
            // neither inherits it nor lends it back.
            const truncated = stopReason === "length" ? { truncated: true as const } : {};
            // A same-position variant turn re-generates an existing reply: it
            // appends a swipe to that exact message instead of inserting a new
            // companion row. The target comes only from the coordinator-bound
            // facts, never from provider content. The model's context already
            // carries this reply, because the branch that makes it one player
            // line and one reply ran before the prompt.
            const variant = scope.facts.variant;
            const committed = await scope.transitionPresentation(
              variant === null
                ? {
                    operation: "commit_presentation",
                    cancelEpoch: reservation.cancelEpoch,
                    message: {
                      messageId: (responseMessageId ??= nativeResponseMessageId(scope.facts.attemptId)),
                      text,
                      occurredAtMs: committedAtMs,
                    },
                    committedAtMs,
                    ...truncated,
                  }
                : {
                    operation: "commit_variant",
                    cancelEpoch: reservation.cancelEpoch,
                    variant: {
                      targetMessageId: variant.targetMessageId,
                      text,
                      occurredAtMs: committedAtMs,
                    },
                    committedAtMs,
                    ...truncated,
                  },
            );
            if (committed.status !== "presentation_committed")
              throw new Error("native_content_presentation_commit_rejected");
            committedReplyText = text;
            if (variant !== null) variantBranchRetained = true;
          } catch (error) {
            // Observer callback failure is not a terminal authority. Preserve a
            // Stop winner when one exists; otherwise let the ordinary P5 failure
            // transition below terminalize the already-durable running attempt.
            //
            // A branch that did not reach a visible commit must not stay in the
            // model's history. Only a refusal the store raises before it writes
            // anything proves the variant is not visible; an ambiguous failure - a
            // write whose read-back failed - may have committed it, and reverting
            // there would produce the same divergence mirrored, so the branch stays
            // and this turn's finally does not put the leaf back.
            if (variantBranch !== undefined && !isPresentationRefusedWithoutWrite(error)) variantBranchRetained = true;
            finalPresentationFailure = error;
          } finally {
            reservation.release();
          }
        },
        onRejected: async (reason) => {
          // A rejected/error turn must not leave a speech job half-open.
          if (speechSink !== undefined) {
            try {
              await speechSink.cancel();
            } catch {
              // Voice degradation is always graceful.
            }
          }
          if (reason === "error") finalPresentationFailure = new Error("native_content_provider_error");
          if (reason !== "error") finalPresentationFailure = new Error(`native_content_${reason}`);
        },
        // Paced delivery needs a sink that can receive a piece BEFORE the turn's
        // final message. Without this key the observer's `incrementalActive` is
        // false and every pacing mechanism is skipped - the switch would write a
        // preference that nothing reads. It is declared only when the caller
        // chose a paced policy, so the unpaced path keeps its exact old shape.
        ...(pacing === undefined
          ? {}
          : {
              onIncrementalText: async (piece: string) => {
                if (!(await runningBarrier)) return;
                // A piece reaches the reader through the same non-durable preview
                // channel an in-flight delta uses. It is volatile only in ORDER,
                // never in content or authority: the durable commit still happens
                // once, at message_end, from the whole reply, so a piece can never
                // become the record.
                if (previewPublisher === undefined) return;
                if (Buffer.byteLength(piece, "utf8") > 16_384) return;
                try {
                  await previewPublisher.publish(Object.freeze({ turnId: scope.facts.turnId, delta: piece }));
                } catch {
                  // Preview publication is explicitly non-durable.
                }
              },
            }),
      },
      {
        stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION,
        scaffolding: CHAT_TRANSCRIPT_SCAFFOLDING,
        // Absent pacing is the Chat default: every mechanism off, delivery
        // byte-identical to what it was before pacing existed. The caller
        // passes a policy only when the player turned the switch on.
        ...(pacing === undefined ? {} : { pacing }),
      },
    );
    nativeObserver.open();
    // Open one exact speech job for this turn when a voice sink is attached.
    if (speechSink !== undefined) {
      try {
        await speechSink.begin(scope.facts.turnId);
      } catch {
        // Voice degradation is always graceful.
      }
    }
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
    const plan = await scope.readAcceptedAuthoredContextPlan();
    const refs = plan.stableSources.map((source) => Object.freeze({ ...source }));
    const volatileRefs = plan.volatileSources.map((source) => Object.freeze({ ...source }));
    if (typeof scope.authoredContextCapability.assertInstall !== "function")
      throw new Error("semantic_chat_runtime_authored_context_unavailable");
    scope.authoredContextCapability.assertInstall(scope.facts.turnId, refs, volatileRefs);
    const text = await scope.readAcceptedMessageText();
    promptText = text;
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
    // A same-position variant turn re-asks the anchor player line, so the leaf
    // must move to the entry before that line BEFORE the provider request is
    // built: the request then carries the line once and unanswered, instead of
    // the line twice with the reply it replaced. A refused branch prompts nothing.
    if (scope.facts.variant !== null) {
      const branched = await scope.branchVariantAnchor(text);
      if (branched.status !== "branched") {
        process.stderr.write(`[variant] branch refused: ${branched.reason}\n`);
        return await failRuntimeUnavailable(scope);
      }
      variantBranch = branched;
    }
    // Exactly one Host session.prompt invocation per exact attempt. Pi-owned
    // transport retries and agent-loop continuations are never counted or
    // re-invoked by Host. Preserve its settlement class so provider rejection
    // becomes the ordinary durable failure outcome rather than an uncertain
    // queued turn; a synchronous throw is equivalent to rejection.
    //
    // The rejection itself is kept and reported before it is collapsed into the
    // settlement class. Without that, every cause of a refused prompt - a
    // provider that refused the request, an extension aborting the turn in a
    // protected hook, a transport that never reached the network - becomes the
    // same durable `runtime_unavailable`, and a reader cannot tell a broken
    // product from a broken environment without re-running the case by hand.
    const settlePrompt = (): Promise<"fulfilled" | "rejected"> => {
      const reportRejection = (error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        // Bounded: a provider body can be large, and this is a diagnostic line.
        process.stderr.write(`[provider-start] prompt rejected: ${message.slice(0, 512)}\n`);
      };
      try {
        return promptFn
          .call(runtimeSession.session, text, {
            expandPromptTemplates: false,
            source: "rpc",
          })
          .then(
            () => "fulfilled" as const,
            (error: unknown) => {
              reportRejection(error);
              return "rejected" as const;
            },
          );
      } catch (error) {
        reportRejection(error);
        return Promise.resolve("rejected");
      }
    };
    // Every session entry that exists at this instant is, by append-only construction, NOT one this
    // prompt produced: the difference after it settles names exactly the entries it did.
    entriesBefore = sessionEntryIds(runtimeSession.sessionManager);
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
    if (first.settlement === "rejected") return await failRuntimeUnavailable(scope);
    return { outcome: "armed", ledger: armed };
  } finally {
    try {
      scope.authoredContextCapability.clearVolatileForTurn(scope.facts.turnId);
    } catch {
      // Terminal cleanup is best-effort after the durable ledger has settled;
      // stale/cross-turn bindings fail closed inside the bridge.
    }
    // A branch whose variant never became durable must not stay in the model's
    // history: the player still reads the reply it replaced, so the leaf goes back.
    if (variantBranch !== undefined && !variantBranchRetained) variantBranch.revert();
    if (!providerRunning) resolveRunningBarrier(false);
    unregister?.();
    unsubscribeNativeAssistantStart?.();
    unsubscribeNativeAssistantEnd?.();
    nativeObserver?.revoke();
    if (previewPublished) await previewPublisher?.clear();
    if (promptPromise !== undefined) await promptPromise;
    await nativeObserver?.close();
    // The prompt has settled and its final assistant snapshot has been drained, so this is the one
    // moment where both what the prompt appended and which row it was committed as are known. It runs
    // here, before the scope closes and after every terminal transition, and it can never change this
    // turn's outcome: a row left with no recorded binding is the honest state a delete refuses on.
    await recordSettledPromptEntries();
    releaseActivePrompt?.();
  }
}

/**
 * The refusal codes the store raises before it writes anything, so a variant
 * commit that threw one of them provably never became visible and the branch
 * this turn moved can be put back. Every other failure is ambiguous - a write
 * whose read-back failed may have committed - and is deliberately left alone,
 * because a visible variant with a reverted branch is the same divergence
 * mirrored.
 */
function isPresentationRefusedWithoutWrite(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "p5_presentation_source_running_required" ||
      error.message === "chat_variant_target_mismatch" ||
      error.message === "chat_variant_target_not_found" ||
      error.message === "chat_variant_commit_conflict" ||
      error.message === "semantic_chat_runtime_p4_attempt_invocation_rejected")
  );
}
