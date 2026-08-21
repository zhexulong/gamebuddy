import type { P4ProviderStartExecutionScope } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
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

async function currentTerminalResult(scope: P4ProviderStartExecutionScope): Promise<P4ProviderStartResult | undefined> {
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
export async function runMountedP4ProviderStart(scope: P4ProviderStartExecutionScope): Promise<P4ProviderStartResult> {
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
  let presentationActivation: Awaited<ReturnType<P4ProviderStartExecutionScope["activatePresentation"]>> | undefined;
  let releaseActivePrompt: (() => void) | undefined;
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
      promptSettled.then((settlement) => ({ phase: "prompt" as const, settlement })),
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
      const settlement = await promptSettled;
      // Settlement closes new tool admissions and drains callbacks that have
      // already won their presentation reservation. Terminalization below is
      // based solely on the durable ledger CAS, never on gate-local state.
      await presentationActivation?.deactivate();
      presentationActivation = undefined;
      const terminal = await currentTerminalResult(scope);
      if (terminal !== undefined) return terminal;
      if (settlement === "rejected") {
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
    unregister?.();
    if (promptPromise !== undefined) await promptPromise;
    releaseActivePrompt?.();
    if (presentationActivation !== undefined) await presentationActivation.deactivate();
  }
}
