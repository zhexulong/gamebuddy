import type { P4ProviderStartExecutionScope } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type {
  AttemptStartingTurn,
  ChatTurnLedger,
  CancelledTurn,
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

export type P4ProviderStartResult =
  | Readonly<{ outcome: "completed"; ledger: CompletedTurn }>
  | Readonly<{ outcome: "cancelled"; ledger: CancelledTurn }>
  | Readonly<{ outcome: "failed"; ledger: FailedTurn }>
  | Readonly<{ outcome: "armed"; ledger: AttemptStartingTurn }>
  | Readonly<{ outcome: "not_started"; ledger: AttemptStartingTurn }>;
export type P4ProviderStartLedger = AttemptStartingTurn | CompletedTurn | CancelledTurn | FailedTurn;

/** Bridge-friendly projection: returns only the final durable ledger. */
export async function runMountedP4ProviderStartLedger(
  scope: P4ProviderStartExecutionScope,
): Promise<P4ProviderStartLedger> {
  return (await runMountedP4ProviderStart(scope)).ledger;
}

function isDeadlineExpired(error: unknown): boolean {
  return (
    error instanceof Error &&
    /semantic_chat_runtime_p4_provider_start_deadline_expired/.test(error.message)
  );
}

function requireAttemptStarting(
  ledger: AttemptStartingTurn | RunningTurn,
  operation: string,
): AttemptStartingTurn {
  if (ledger.status !== "attempt_starting") throw new Error(`p4_provider_start_unexpected_${operation}`);
  return ledger;
}

function requireRunning(ledger: AttemptStartingTurn | RunningTurn, operation: string): RunningTurn {
  if (ledger.status !== "running") throw new Error(`p4_provider_start_unexpected_${operation}`);
  return ledger;
}

function requireCompleted(ledger: ChatTurnLedger, operation: string): CompletedTurn {
  if (ledger.status !== "completed") throw new Error(`p5_presentation_unexpected_${operation}`);
  return ledger;
}

function requireCancelled(ledger: ChatTurnLedger): CancelledTurn {
  if (ledger.status !== "cancelled") throw new Error("p5_presentation_unexpected_cancelled");
  return ledger;
}

function requireFailedNoVisiblePresentation(ledger: ChatTurnLedger): FailedTurn {
  if (ledger.status !== "failed" || ledger.reasonCode !== "no_visible_presentation")
    throw new Error("p5_presentation_unexpected_no_visible_presentation");
  return ledger;
}

function isPresentationMissing(error: unknown): boolean {
  return error instanceof Error && /p5_presentation_completion_source_required/.test(error.message);
}

async function settleP5Winner(
  scope: P4ProviderStartExecutionScope,
  winner: ChatTurnLedger,
): Promise<P4ProviderStartResult> {
  switch (winner.status) {
    case "cancel_claimed": {
      const cancelled = requireCancelled(
        await scope.transitionPresentation({
          operation: "cancel",
          cancelledAtMs: Date.now(),
        }),
      );
      return { outcome: "cancelled", ledger: cancelled };
    }
    case "cancelled":
      return { outcome: "cancelled", ledger: winner };
    case "completion_claimed": {
      const completed = requireCompleted(
        await scope.transitionPresentation({
          operation: "complete",
          completedAtMs: Date.now(),
        }),
        "complete",
      );
      return { outcome: "completed", ledger: completed };
    }
    case "completed":
      return { outcome: "completed", ledger: winner };
    case "failed":
      return { outcome: "failed", ledger: winner };
    default:
      throw new Error("p5_presentation_unexpected_cancellation_winner");
  }
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
 * A prompt settlement without an `after_provider_response` never creates a
 * `not_started`; the durable `armed` record remains and reopens uncertain.
 * There is no second Host invocation and no generation 2 on any path.
 */
export async function runMountedP4ProviderStart(
  scope: P4ProviderStartExecutionScope,
): Promise<P4ProviderStartResult> {
  // Pre-arm linearization: an expired or revoked admission rejects with zero
  // store mutation and no Host prompt invocation.
  scope.assertAdmission();
  const runtimeSession = scope.runtimeSession;
  const installObserver =
    typeof runtimeSession.installTavernProviderStartObserver === "function"
      ? runtimeSession.installTavernProviderStartObserver
      : undefined;
  const promptFn =
    typeof runtimeSession.session?.prompt === "function" ? runtimeSession.session.prompt : undefined;
  let unregister: (() => void) | undefined;
  let presentationActivation:
    | Awaited<ReturnType<P4ProviderStartExecutionScope["activatePresentation"]>>
    | undefined;
  let promptPromise: Promise<void> | undefined;
  let observationSettled = false;
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
      const armed = requireAttemptStarting(
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
    // Activation is a mandatory pre-prompt dependency. It happens before the
    // durable arm record so an absent construction gate cannot leave an armed
    // attempt that has no possible companion_text presentation path.
    scope.assertAdmission();
    presentationActivation = scope.activatePresentation();
    // Arm linearization: the exact gate is now bound, but no provider call has
    // begun and the callback cannot commit until the running barrier opens.
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
    // The construction-time Chat gate is now already bound to this exact
    // invocation. Its companion_text callback remains behind the running
    // barrier until the observer transition below succeeds.
    // Exactly one Host session.prompt invocation per exact attempt. Pi-owned
    // transport retries and agent-loop continuations are never counted or
    // re-invoked by Host.
    promptPromise = promptFn.call(runtimeSession.session, envelope, {
      expandPromptTemplates: false,
      source: "rpc",
    }).then(
      () => undefined,
      () => {
        // Settlement is never negative provider evidence; it must not create
        // a not_started or an unhandled rejection.
      },
    );
    const first = await Promise.race([
      observationReady.then((statusClass) => ({ phase: "observation" as const, statusClass })),
      promptPromise.then(() => ({ phase: "prompt" as const })),
    ]);
    if (first.phase === "observation") {
      // Running linearization: a late/expired observer authorizes no running
      // write; the durable armed record remains and reopens uncertain.
      try {
        scope.assertAdmission();
      } catch {
        // A presentation callback may already be waiting on the running
        // barrier. Revoke it before awaiting prompt settlement so a late
        // callback cannot deadlock the prompt or commit after the lease lost
        // its linearization point.
        await presentationActivation?.deactivate();
        return { outcome: "armed", ledger: armed };
      }
      try {
        requireRunning(
          await scope.transitionStore({
            operation: "running",
            statusClass: first.statusClass,
            observedAtMs: Date.now(),
          }),
          "running",
        );
      } catch (error) {
        await presentationActivation?.deactivate();
        throw error;
      }
      presentationActivation?.resolveRunning();
      await promptPromise;
      // Settlement closes new tool admissions and drains callbacks that have
      // already won their presentation reservation. Terminalization below is
      // based solely on the durable ledger CAS, never on gate-local state.
      await presentationActivation?.deactivate();
      presentationActivation = undefined;
      const winner = await scope.finalizeCancellation();
      if (winner !== undefined) return await settleP5Winner(scope, winner);
      try {
        await scope.transitionPresentation({
          operation: "claim_completion",
          claimedAtMs: Date.now(),
        });
      } catch (error) {
        // STOP can win between the first winner read and this completion CAS.
        // Re-read its durable result before treating the absence of a committed
        // bubble as the terminal no-visible-presentation case.
        const racedWinner = await scope.finalizeCancellation();
        if (racedWinner !== undefined) return await settleP5Winner(scope, racedWinner);
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
    // Prompt settlement without after_provider_response: no new durable write.
    return { outcome: "armed", ledger: armed };
  } finally {
    unregister?.();
    if (promptPromise !== undefined) await promptPromise;
    if (presentationActivation !== undefined) await presentationActivation.deactivate();
  }
}