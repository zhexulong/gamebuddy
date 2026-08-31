import type { Static } from "typebox";
import {
  isCurrentMountedChatRuntimeLease,
  stopMountedChatPresentationEpoch,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { identityKey } from "../runtime.js";
import {
  type BrowserMessageV1,
  type BrowserTurnV1,
  type CancelTurnCommandV1,
  type ComposedTavernProfile,
  type MessageSubmissionStatusQueryV1Schema,
  type MessageSubmissionStatusV1Schema,
  type SubmitMessageCommandV1,
  type SubmitResultV1Schema,
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserValidatorsV1,
} from "./browser-contract/index.js";
import type { ChatEventStream } from "./chat-event-stream.js";

/**
 * Frozen contract static types, derived from the single browser-contract
 * schema authority (design/75 Task 2: retain the contract names without
 * duplicating DTOs). They will move to `browser-contract` when its exports are
 * completed by Task 3 composition.
 */
export type SubmitResultV1 = Static<typeof SubmitResultV1Schema>;
export type MessageSubmissionStatusQueryV1 = Static<typeof MessageSubmissionStatusQueryV1Schema>;
export type MessageSubmissionStatusV1 = Static<typeof MessageSubmissionStatusV1Schema>;

import {
  type AcceptedQueuedTurn,
  type AttemptStartingTurn,
  type CancelledTurn,
  type ChatThreadState,
  type ChatTurnLedger,
  type CompletedTurn,
  createChatThreadStore,
  type FailedTurn,
} from "./chat-thread-store.js";
import { createPlayerTurnAcceptor } from "./player-turn-acceptance.js";
import { createProviderAttemptClaimer } from "./provider-attempt-claim.js";
import { startMountedChatProvider } from "./chat-provider-start.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

/** Non-terminal durable ledger states (design/40 §6.7). */
function isTerminalLedger(ledger: ChatTurnLedger): boolean {
  return ledger.status === "completed" || ledger.status === "cancelled" || ledger.status === "failed";
}

function isNonTerminalLedger(ledger: ChatTurnLedger): boolean {
  return !isTerminalLedger(ledger);
}

/** Stop is actionable only after the exact prompt has reached durable arm. */
function isCancellableLedger(ledger: ChatTurnLedger): boolean {
  return (
    (ledger.status === "attempt_starting" && ledger.observation?.phase === "armed") || ledger.status === "running"
  );
}

/**
 * The narrow injected test-only seam for the sole connected P4c/P5 path.
 * Production always uses `startMountedChatProvider`; the dependency is
 * injectable only because the live provider path cannot be scripted
 * deterministically in a focused service test. It carries no admission,
 * binding, store, or provider capability of its own.
 */
export type ChatPipelineStartDependency = Readonly<{
  /**
   * Starts the already-claimed exact turn through the connected P4c/P5 path
   * (arm → one provider prompt → observation → presentation → terminalize).
   */
  start(): Promise<AttemptStartingTurn | CompletedTurn | CancelledTurn | FailedTurn>;
}>;

/**
 * Narrow injected facade dependencies, allowed only where the existing public
 * P4 facades cannot be scripted (the live provider start). Durable acceptance
 * (`createPlayerTurnAcceptor`) and the P4b attempt claim
 * (`createProviderAttemptClaimer`) are always the real scripted facades.
 */
export type ChatPipelineServiceDependencies = Readonly<{
  start: ChatPipelineStartDependency;
}>;

/**
 * Owns the connected durable acceptance/status and the post-HTTP-202
 * continuation for one exact mounted Chat (design/75 Task 2, design/40 §5.1
 * reference-pipeline slice). It exposes only browser-safe opaque handles; no
 * store, root, thread, turn, attempt, session or raw durable identifier
 * escapes. All start/claim capability stays private to this service; there are
 * no response/HTTP imports.
 */
export type ChatPipelineService = Readonly<{
  /**
   * Durable acceptance (with store read-back) happens first, the caller's
   * `commit202` is invoked with the browser-safe committed representation, and
   * only after it resolves does the service internally claim/start the exact
   * turn exactly once through the existing P4b claim + P4c/P5 path. A rejected
   * `commit202` leaves the durable `accepted_queued` record in place and never
   * starts; recovery is exclusively through `readSubmissionStatus`. Ordering
   * is proven by the caller's callback boundary, never by a timer/microtask.
   */
  submitAfterResponseCommit(
    command: SubmitMessageCommandV1,
    idempotencyKey: string,
    commit202: (result: SubmitResultV1) => Promise<void>,
  ): Promise<SubmitResultV1>;
  /**
   * Exact-binding durable idempotency/ledger read-back keyed by the browser
   * key. Foreign key, wrong mounted generation and missing key all produce the
   * identical non-disclosing `{apiVersion:1, disposition:"unknown"}`; a known
   * key projects the committed accepted representation (`accepted`) or the
   * terminal one (`terminal`). `pending`/`expired` are never emitted: no
   * durable pending or retention owner exists. Status reads never accept,
   * claim, start, or mutate anything.
   */
  readSubmissionStatus(query: MessageSubmissionStatusQueryV1): Promise<MessageSubmissionStatusV1>;
  /** Stops the exact active turn and returns its fresh browser-safe projection. */
  cancel(turnHandle: string, command: CancelTurnCommandV1): Promise<BrowserTurnV1>;
  /**
   * Rejects new admission and drains admitted acceptance, commit callbacks and
   * background start work before resolving. The mounted lease itself stays
   * coordinator-owned and is closed by its owner after this service's drain.
   */
  close(): Promise<void>;
}>;

export type ChatPipelineServiceOptions = Readonly<{
  manifest: HostDeploymentManifest;
  lease: MountedChatRuntimeLease;
  /** The composed capability slice that gates the submit operation. */
  profile: ComposedTavernProfile;
  deps?: Partial<ChatPipelineServiceDependencies>;
  eventStream?: ChatEventStream;
}>;

/**
 * Shared post-await guard for this service. It never brands or mints leases;
 * the only production lease authority remains the coordinator's private
 * WeakMap. The optional predicate is a test seam only: it can validate
 * revocation timing but cannot add a coordinator brand or mint a usable lease.
 */
export function assertChatPipelineServiceLeaseAfterDurableRead(
  lease: MountedChatRuntimeLease,
  current: (value: unknown) => boolean = isCurrentMountedChatRuntimeLease,
): void {
  if (!current(lease)) throw unavailable();
}

/**
 * Builds the service from the deployment principal, the coordinator-branded
 * current mounted lease and the composed reference profile. No repository,
 * path, runtime or raw identity field appears in the public API.
 */
export function createChatPipelineService(options: ChatPipelineServiceOptions): ChatPipelineService {
  const { manifest, lease, profile } = options;
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  assertComposedProfile(profile);
  if (!profile.operationIds.includes("chat.submit")) throw unavailable();
  if (!identifier(lease.chatThreadId) || !identifier(lease.chatSurfaceSessionId)) throw unavailable();
  if (
    options.deps !== undefined &&
    (options.deps === null ||
      typeof options.deps !== "object" ||
      options.deps.start === undefined ||
      typeof options.deps.start.start !== "function")
  )
    throw unavailable();

  const eventStream = options.eventStream;
  const start: ChatPipelineStartDependency = options.deps?.start ?? Object.freeze({
    start: async () =>
      await startMountedChatProvider(
        manifest,
        lease,
        eventStream === undefined || !profile.routeIds.includes("events")
          ? undefined
          : Object.freeze({
              publish: async (preview) => {
                eventStream.publish({
                  eventType: "companion.delta",
                  selectionGeneration: lease.browserProjection.selectionGeneration,
                  payload: Object.freeze({
                    // The browser has no access to Pi/provider message identity;
                    // scope the volatile preview to the Host-owned turn instead.
                    turnHandle: lease.browserProjection.projectTurnHandle(preview.turnId),
                    delta: preview.delta,
                  }),
                });
              },
              clear: async () => {
                // A terminal state event immediately follows the provider run.
                // The browser treats that state as the volatile-preview clear.
              },
            }),
      ),
  });
  const accept = createPlayerTurnAcceptor(manifest, lease);
  const claim = createProviderAttemptClaimer(manifest, lease);

  let closing = false;
  let closed = false;
  let pending = 0;
  const backgroundStarts = new Set<Promise<void>>();
  const drainWaiters = new Set<() => void>();
  let closePromise: Promise<void> | undefined;

  const waitForIdle = (): Promise<void> =>
    pending === 0 && backgroundStarts.size === 0
      ? Promise.resolve()
      : new Promise((resolve) => drainWaiters.add(resolve));
  const notifyDrain = (): void => {
    if (pending === 0 && backgroundStarts.size === 0) {
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    }
  };
  const assertOpen = (): void => {
    if (closing || closed) throw closedError();
  };

  /** Method-local read-only exact-binding store read with pre/post lease checks. */
  const resumeState = async (): Promise<ChatThreadState> => {
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
    try {
      const state = await store.resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
      validateStateBinding(state);
      // Durable reads do not hold the mount capability; a concurrent close
      // revokes the lease before projection, so never project stale data.
      assertChatPipelineServiceLeaseAfterDurableRead(lease);
      return state;
    } catch {
      throw unavailable();
    }
  };

  const validateStateBinding = (state: ChatThreadState): void => {
    const thread = state.thread;
    if (
      thread.chatThreadId !== lease.chatThreadId ||
      thread.chatSurfaceSessionId !== lease.chatSurfaceSessionId ||
      thread.companionId !== manifest.principal.companionId ||
      thread.continuityId !== manifest.principal.continuityId
    )
      throw unavailable();
  };

  const service: ChatPipelineService = Object.freeze({
    async submitAfterResponseCommit(command, idempotencyKey, commit202): Promise<SubmitResultV1> {
      assertOpen();
      assertComposedProfile(profile);
      if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
      validateSubmitCommand(command, lease);
      if (!validIdempotencyKey(idempotencyKey)) throw unavailable();
      if (typeof commit202 !== "function") throw unavailable();
      pending += 1;
      try {
        const before = await resumeState();
        const duplicate = before.idempotency.some((record) => record.key === idempotencyKey);
        const accepted = await accept.accept(
          Object.freeze({
            text: command.text,
            locale: command.locale,
            idempotencyKey,
            expectedDraftRevision: command.expectedDraftRevision ?? before.draft.revision,
          }),
        );
        const acceptedState = await resumeState();
        const result = await projectCommittedResult(
          accepted,
          // The committed player message comes only from this post-accept
          // durable read-back, never from the caller's command echo.
          acceptedState,
          duplicate ? "duplicate" : "accepted",
        );
        if (eventStream !== undefined && profile.routeIds.includes("events")) {
          eventStream.publish({
            eventType: "message.committed",
            selectionGeneration: lease.browserProjection.selectionGeneration,
            payload: result.message,
          });
        }
        try {
          await commit202(result);
        } catch {
          // The durable accepted_queued record stands; the attempt must not
          // start when the 202 commit rejected.
          throw commitRejected();
        }
        const attempt = startOnce();
        backgroundStarts.add(attempt);
        void attempt
          .finally(() => {
            backgroundStarts.delete(attempt);
            notifyDrain();
          })
          .catch(() => undefined);
        return result;
      } catch (error) {
        throw rethrowAcceptanceError(error);
      } finally {
        pending -= 1;
        notifyDrain();
      }
    },

    async readSubmissionStatus(query: MessageSubmissionStatusQueryV1): Promise<MessageSubmissionStatusV1> {
      assertOpen();
      if (query === null || typeof query !== "object" || Array.isArray(query)) throw unavailable();
      if (query.apiVersion !== TAVERN_BROWSER_API_VERSION) throw unavailable();
      if (!Number.isSafeInteger(query.selectionGeneration) || query.selectionGeneration < 1) throw unavailable();
      // Foreign/wrong-generation/malformed keys are all the identical
      // non-disclosing unknown; never an error and never a mutation.
      if (query.selectionGeneration !== lease.browserProjection.selectionGeneration) return unknownStatus();
      if (!validIdempotencyKey(query.idempotencyKey)) return unknownStatus();
      const state = await resumeState();
      const record = state.idempotency.find((entry) => entry.key === query.idempotencyKey);
      if (record === undefined) return unknownStatus();
      const ledger = state.turnLedger;
      // A surviving record must reference the live ledger exactly; any other
      // durable state is corruption and fails closed with no partial status.
      if (ledger === null || ledger.turnId !== record.result.turnId) throw unavailable();
      const committedResult = await projectCommittedResult(record.result, state, "accepted");
      const status = Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        disposition: isNonTerminalLedger(ledger) ? ("accepted" as const) : ("terminal" as const),
        committedResult,
      });
      if (!TavernBrowserValidatorsV1.MessageSubmissionStatusV1Schema.Check(status)) throw unavailable();
      return status;
    },

    async cancel(turnHandle: string, command: CancelTurnCommandV1): Promise<BrowserTurnV1> {
      assertOpen();
      if (!profile.operationIds.includes("chat.cancel")) throw unavailable();
      if (typeof turnHandle !== "string" || !TavernBrowserValidatorsV1.CancelTurnCommandV1Schema.Check(command))
        throw unavailable();
      if (command.selectionGeneration !== lease.browserProjection.selectionGeneration) throw selectionConflict();
      const state = await resumeState();
      const ledger = state.turnLedger;
      if (ledger === null || lease.browserProjection.projectTurnHandle(ledger.turnId) !== turnHandle) throw unavailable();
      if (!isNonTerminalLedger(ledger)) return projectTurn(lease, ledger);
      if (!isCancellableLedger(ledger) || !("attempt" in ledger)) return projectTurn(lease, ledger);
      const expected = Object.freeze({ turnId: ledger.turnId, attemptId: ledger.attempt.attemptId });
      // The coordinator owns the active Pi prompt and the P5 presentation
      // admission. Stop through its one mounted authority so revocation, the
      // durable cancel CAS, and `session.abort()` retain their existing race
      // ordering; browser code never reaches a raw store mutation or Pi handle.
      let winner: ChatTurnLedger;
      try {
        winner = await stopMountedChatPresentationEpoch(manifest, lease, {
          stopId: `browser_stop_${randomId()}`,
          sourceEventId: `browser_stop_source_${randomId()}`,
          reasonCode: "browser_chat_cancel",
        });
      } catch (error) {
        // Completion/failure can win the terminal race. Reread exactly once
        // and project that durable winner; any still-active or mismatched turn
        // remains a request failure rather than a synthetic cancellation.
        const reread = await resumeState();
        if (
          reread.turnLedger === null ||
          reread.turnLedger.turnId !== expected.turnId ||
          !isTerminalLedger(reread.turnLedger)
        )
          throw error;
        winner = reread.turnLedger;
      }
      assertChatPipelineServiceLeaseAfterDurableRead(lease);
      const result = projectTurn(lease, winner);
      if (eventStream !== undefined && profile.routeIds.includes("events"))
        eventStream.publish({
          eventType: "turn.state_changed",
          selectionGeneration: lease.browserProjection.selectionGeneration,
          payload: result,
        });
      return result;
    },

    async close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = (async () => {
        await waitForIdle();
        closed = true;
      })();
      return closePromise;
    },
  });
  return service;

  async function projectCommittedResult(
    accepted: AcceptedQueuedTurn,
    state: ChatThreadState,
    disposition: "accepted" | "duplicate",
  ): Promise<SubmitResultV1> {
    const order = state.messages.findIndex((message) => message.messageId === accepted.messageId);
    const message = order < 0 ? undefined : state.messages[order];
    if (
      message === undefined ||
      message.role !== "player" ||
      message.kind !== "player" ||
      !Number.isSafeInteger(order) ||
      order < 0 ||
      state.turnLedger === null ||
      state.turnLedger.turnId !== accepted.turnId
    )
      throw unavailable();
    const result = Object.freeze({
      apiVersion: TAVERN_BROWSER_API_VERSION,
      disposition,
      message: projectMessage(lease, message, order),
      turn: projectTurn(lease, state.turnLedger),
    });
    // Fail closed unless the committed representation satisfies its frozen
    // contract schema; a partial or invalid projection never escapes.
    if (!TavernBrowserValidatorsV1.SubmitResultV1Schema.Check(result)) throw unavailable();
    return result;
  }

  /**
   * The one service-owned continuation: durable P4b claim (exactly-once gate,
   * including crash recovery for an accepted-but-never-claimed turn), then the
   * sole connected P4c/P5 start. Errors never reach the submit caller; the
   * durable ledger and status read-back are the authority.
   */
  async function startOnce(): Promise<void> {
    await claim.claim();
    await start.start();
    if (eventStream !== undefined && profile.routeIds.includes("events")) {
      const state = await resumeState();
      if (state.turnLedger !== null) {
        eventStream.publish({
          eventType: "turn.state_changed",
          selectionGeneration: lease.browserProjection.selectionGeneration,
          payload: projectTurn(lease, state.turnLedger),
        });
      }
    }
  }
}

function projectMessage(
  lease: MountedChatRuntimeLease,
  message: ChatThreadState["messages"][number],
  order: number,
): BrowserMessageV1 {
  if (message.role !== "player" && message.role !== "companion") throw unavailable();
  return Object.freeze({
    handle: lease.browserProjection.projectMessageHandle(message.messageId),
    role: message.role,
    text: message.text,
    // ChatThreadStore persists no language metadata; the service must not infer one.
    locale: "und",
    // ChatThreadStore transcript order is append-only; project its index.
    order,
    revision: 1,
  });
}

/**
 * Frozen durable TurnLedger → BrowserTurnV1 projection (design/72 §7),
 * identical to the reference-pipeline state projection. `projectionRevision`
 * is the literal 1; older internal intermediate states map to the five MVP
 * browser states and never create separate UI lifecycle outcomes.
 */
function projectTurn(lease: MountedChatRuntimeLease, ledger: ChatTurnLedger): BrowserTurnV1 {
  const state =
    ledger.status === "accepted_queued" || ledger.status === "attempt_starting"
      ? "queued"
      : ledger.status === "running" || ledger.status === "presentation_committed" || ledger.status === "completion_claimed" || ledger.status === "cancel_claimed"
        ? "running"
        : ledger.status;
  return Object.freeze({
    handle: lease.browserProjection.projectTurnHandle(ledger.turnId),
    state,
    projectionRevision: 1,
    canCancel: isCancellableLedger(ledger),
    ...(ledger.status === "failed" ? { problemCode: ledger.reasonCode } : {}),
  });
}

function unknownStatus(): MessageSubmissionStatusV1 {
  return Object.freeze({ apiVersion: TAVERN_BROWSER_API_VERSION, disposition: "unknown" });
}

function validateSubmitCommand(command: SubmitMessageCommandV1, lease: MountedChatRuntimeLease): void {
  if (
    command === null ||
    typeof command !== "object" ||
    Array.isArray(command) ||
    command.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    !Number.isSafeInteger(command.selectionGeneration) ||
    command.selectionGeneration < 1 ||
    typeof command.text !== "string" ||
    command.text.length === 0 ||
    typeof command.locale !== "string"
  )
    throw unavailable();
  // Exact-binding selection: browser input can never select another generation.
  if (command.selectionGeneration !== lease.browserProjection.selectionGeneration) throw selectionConflict();
}

function randomId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

/**
 * Acceptance errors become fixed opaque codes only. Known store CAS outcomes
 * keep their canonical codes for transport mapping; every other failure
 * (scope, lifecycle, capacity, read-back, admission, unknown) collapses to
 * the service's fail-closed code so no raw path/ID/content can escape.
 */
function rethrowAcceptanceError(error: unknown): Error {
  if (
    error instanceof Error &&
    (error.message === "turn_busy" ||
      error.message === "idempotency_conflict" ||
      error.message === "chat_draft_revision_conflict" ||
      error.message === "chat_pipeline_service_selection_conflict" ||
      error.message === "chat_pipeline_service_commit_rejected")
  )
    return error;
  return unavailable();
}

/**
 * Accepts only a composed tavern capability slice (the frozen shape produced
 * by `composeTavernProfile`); plain or partial forgeries fail closed before
 * any I/O.
 */
function assertComposedProfile(profile: ComposedTavernProfile): void {
  if (
    typeof profile !== "object" ||
    profile === null ||
    Array.isArray(profile) ||
    Object.getPrototypeOf(profile) !== Object.prototype ||
    !Object.isFrozen(profile)
  )
    throw unavailable();
  const expectedKeys = ["profileId", "releaseTier", "routeIds", "operationIds", "navigationItemIds"] as const;
  const keys = Reflect.ownKeys(profile);
  if (
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => keys.includes(key)) ||
    !Object.isFrozen(profile.operationIds) ||
    profile.operationIds.some((operationId) => typeof operationId !== "string")
  )
    throw unavailable();
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
function unavailable(): Error {
  return new Error("chat_pipeline_service_unavailable");
}
function closedError(): Error {
  return new Error("chat_pipeline_service_closed");
}
function selectionConflict(): Error {
  return new Error("chat_pipeline_service_selection_conflict");
}
function commitRejected(): Error {
  return new Error("chat_pipeline_service_commit_rejected");
}
