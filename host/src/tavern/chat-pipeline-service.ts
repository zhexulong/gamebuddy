import type { Static } from "typebox";
import { join } from "node:path";
import {
  editMountedChatMessage,
  isCurrentMountedChatRuntimeLease,
  rewindMountedChatTranscript,
  selectMountedSwipeVariant,
  stopMountedChatPresentationEpoch,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import {
  type BrowserMessageV1,
  type BrowserTurnV1,
  type CancelTurnCommandV1,
  type ComposedTavernProfile,
  type EditMessageCommandV1,
  type EditMessageResultV1,
  type MessageSubmissionStatusQueryV1Schema,
  type MessageSubmissionStatusV1Schema,
  type RegenerateMessageCommandV1,
  type RewindChatCommandV1,
  type RewindChatResultV1,
  type SubmitMessageCommandV1,
  type SubmitResultV1Schema,
  type SwipeSelectCommandV1,
  type SwipeSelectResultV1,
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserValidatorsV1,
} from "./browser-contract/index.js";
import type { ChatEventStream } from "./chat-event-stream.js";
import type { ChatVoiceSpeechPublisher } from "../voice.js";

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
  boundedVisibleTail,
  createChatThreadStore,
  DEFAULT_WORLDBOOK_SCAN_DEPTH,
  type FailedTurn,
  type TavernStableWorldBookBinding,
} from "./chat-thread-store.js";
import { readWorldBook, worldBookMetadata } from "../worldbook.js";
import { createPlayerTurnAcceptor } from "./player-turn-acceptance.js";
import { createProviderAttemptClaimer } from "./provider-attempt-claim.js";
import { startMountedChatProvider } from "./chat-provider-start.js";
import { formatSwipeLabel } from "./message-tree.js";

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
  return (ledger.status === "attempt_starting" && ledger.observation?.phase === "armed") || ledger.status === "running";
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
  selectSwipe?(command: SwipeSelectCommandV1): Promise<SwipeSelectResultV1>;
  regenerate?(command: RegenerateMessageCommandV1, idempotencyKey: string): Promise<SubmitResultV1>;
  /**
   * Drops the named message and every message after it from the mounted conversation - the
   * transcript the player reads and the session the model sees, together. The named row is resolved
   * through the lease's own handle projection, and the position the browser read it at is part of
   * the command, so a transcript that moved under the click is refused instead of rewound past a
   * turn the player never saw.
   */
  rewind?(command: RewindChatCommandV1): Promise<RewindChatResultV1>;
  /**
   * Replaces the text of one of the player's own messages - in the transcript the player reads and in
   * the session the model sees, together. The named row is resolved through the lease's own handle
   * projection and the position the browser read it at is part of the command, so a transcript that
   * moved under the editor is refused instead of edited where the player never saw it.
   */
  edit?(command: EditMessageCommandV1): Promise<EditMessageResultV1>;
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
  /**
   * Optional Host-owned streaming speech sink. When supplied (and the profile
   * declares the `speech` route), the mounted Chat presentation reads each
   * companion delta aloud over the Voice Gateway v2 lane while the turn
   * streams. Absent => text-only; a throwing sink degrades to text-only.
   */
  speechSink?: ChatVoiceSpeechPublisher;
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
  const speechSink = options.speechSink;
  const start: ChatPipelineStartDependency =
    options.deps?.start ??
    Object.freeze({
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
          speechSink === undefined ? undefined : speechSink,
        ),
    });
  const accept = createPlayerTurnAcceptor(manifest, lease);
  const claim = createProviderAttemptClaimer(manifest, lease);
  // One store per service instance: the store owns exactly one lazily opened
  // connection, reused by every request and terminated by this service's close.
  const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
  const runtimeCwd = resolveRuntimePaths(manifest.principal, manifest.runtimeRoot).runtimeCwd;
  /**
   * The bound world book's declared per-turn scan depth, read from the exact
   * artifact once per revision. A book that declares none (or an unreadable or
   * mismatched artifact) applies the documented default; the window never falls
   * back to scanning the whole transcript. The bound metadata is re-verified
   * here so a rebound or replaced book can never widen this mount's window.
   */
  const scanDepthByBinding = new Map<string, number>();
  const worldBookScanDepth = async (binding: TavernStableWorldBookBinding | undefined): Promise<number> => {
    if (binding === undefined) return DEFAULT_WORLDBOOK_SCAN_DEPTH;
    const key = `${binding.worldBookId}\u001f${binding.revision}\u001f${binding.canonicalHash}`;
    const cached = scanDepthByBinding.get(key);
    if (cached !== undefined) return cached;
    let depth = DEFAULT_WORLDBOOK_SCAN_DEPTH;
    try {
      const book = await readWorldBook(join(runtimeCwd, "worldbook.json"));
      const metadata = worldBookMetadata(book);
      if (
        book.worldBookId === binding.worldBookId &&
        metadata.revision === binding.revision &&
        metadata.canonicalHash === binding.canonicalHash
      )
        depth = book.scanDepth ?? DEFAULT_WORLDBOOK_SCAN_DEPTH;
    } catch {
      // A missing or unreadable book is not this submit's failure: the
      // selection simply runs with the documented default depth.
    }
    scanDepthByBinding.set(key, depth);
    return depth;
  };

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

  /** Exact-binding store read with pre/post lease checks. */
  const resumeState = async (): Promise<ChatThreadState> => {
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
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
        // The per-turn selection scans the accepted player line plus a BOUNDED
        // visible tail: the newest messages the bound world book declares. With
        // no tail the retrieval could only ever see the current line, so a
        // keyword planted a turn earlier never reached its entry.
        const boundedTail = boundedVisibleTail(
          before.messages,
          await worldBookScanDepth(before.thread.companionWorldBookBinding),
        );
        const duplicate = before.idempotency.some((record) => record.key === idempotencyKey);
        const accepted = await accept.accept(
          Object.freeze({
            text: command.text,
            locale: command.locale,
            idempotencyKey,
            expectedDraftRevision: command.expectedDraftRevision ?? before.draft.revision,
            boundedVisibleTail: boundedTail,
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
      if (ledger === null || lease.browserProjection.projectTurnHandle(ledger.turnId) !== turnHandle)
        throw unavailable();
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

    async selectSwipe(command: SwipeSelectCommandV1): Promise<SwipeSelectResultV1> {
      assertOpen();
      if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
      if (!TavernBrowserValidatorsV1.SwipeSelectCommandV1Schema.Check(command)) throw unavailable();
      if (command.selectionGeneration !== lease.browserProjection.selectionGeneration) throw selectionConflict();
      const stateBefore = await resumeState();
      const targetMessage = stateBefore.messages.find(
        (m: ChatThreadState["messages"][number]) =>
          lease.browserProjection.projectMessageHandle(m.messageId) === command.messageHandle,
      );
      if (!targetMessage) throw unavailable();
      const state = await selectMountedSwipeVariant(manifest, lease, {
        messageId: targetMessage.messageId,
        ...(command.direction === undefined ? {} : { direction: command.direction }),
        ...(command.targetIndex === undefined ? {} : { targetIndex: command.targetIndex }),
      });
      const updatedMessage = state.messages.find(
        (m: ChatThreadState["messages"][number]) => m.messageId === targetMessage.messageId,
      );
      if (!updatedMessage) throw unavailable();
      const messageIndex = state.messages.indexOf(updatedMessage);
      const totalSwipes = updatedMessage.swipes && updatedMessage.swipes.length > 0 ? updatedMessage.swipes.length : 1;
      const currentIndex = updatedMessage.activeSwipeIndex ?? 0;
      const swipeInfo =
        updatedMessage.role === "companion" && totalSwipes > 1
          ? Object.freeze({
              currentIndex,
              totalSwipes,
              label: formatSwipeLabel(currentIndex, totalSwipes),
              hasPrevious: currentIndex > 0,
              hasNext: currentIndex < totalSwipes - 1,
            })
          : undefined;
      const projected: BrowserMessageV1 = Object.freeze({
        handle: lease.browserProjection.projectMessageHandle(updatedMessage.messageId),
        role: updatedMessage.role,
        text: updatedMessage.text,
        locale: "und",
        order: messageIndex,
        revision: 1,
        ...(swipeInfo !== undefined ? { swipeInfo } : {}),
      });
      return Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        message: projected,
      });
    },

    async regenerate(command: RegenerateMessageCommandV1, idempotencyKey: string): Promise<SubmitResultV1> {
      assertOpen();
      assertComposedProfile(profile);
      if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
      if (!TavernBrowserValidatorsV1.RegenerateMessageCommandV1Schema.Check(command)) throw unavailable();
      if (!validIdempotencyKey(idempotencyKey)) throw unavailable();
      if (command.selectionGeneration !== lease.browserProjection.selectionGeneration) throw selectionConflict();
      const state = await resumeState();
      // Regeneration re-asks the last thing the player said, so exactly one target
      // can honour it: the transcript's own last message, when that message is a
      // companion reply. A middle reply has no turn of its own to re-run, and the
      // opening - the only companion message a transcript can begin with - has no
      // player turn before it at all. Both were previously accepted: the middle
      // one appended an unrelated pair at the tail, and the opening appended the
      // literal "请继续". They are refused here as well as hidden by the surface,
      // because the browser is not the authority on what this Chat can do.
      //
      // The turn this accepts is a same-position variant: it names that reply and
      // mints no player row, so its prompt is the anchor player message the reply
      // answered - the store resolves both from the transcript and refuses a target
      // with no anchor. The reply the player reads changes only when the provider's
      // commit appends the new variant at this exact position, and only after the
      // model's context already carries it; a turn that cannot do both leaves the
      // position exactly as it was.
      const targetMessage = state.messages[state.messages.length - 1];
      if (
        targetMessage === undefined ||
        targetMessage.role !== "companion" ||
        lease.browserProjection.projectMessageHandle(targetMessage.messageId) !== command.messageHandle
      )
        throw unavailable();
      const parentPlayerMessage = [...state.messages.slice(0, state.messages.length - 1)]
        .reverse()
        .find((m: ChatThreadState["messages"][number]) => m.role === "player");
      if (parentPlayerMessage === undefined) throw unavailable();
      const promptText = parentPlayerMessage.text;
      // A replayed key answers `duplicate` with the same durable turn, exactly as
      // an ordinary submit does: acceptance alone is idempotent here too.
      const duplicate = state.idempotency.some((record) => record.key === idempotencyKey);

      pending += 1;
      try {
        const accepted = await accept.accept(
          Object.freeze({
            text: promptText,
            locale: "und",
            idempotencyKey,
            expectedDraftRevision: state.draft.revision,
            variantTargetMessageId: targetMessage.messageId,
          }),
        );
        const acceptedState = await resumeState();
        const result = await projectVariantAcceptedResult(
          accepted,
          acceptedState,
          targetMessage.messageId,
          duplicate ? "duplicate" : "accepted",
        );
        // Deliberately no `message.committed`: this acceptance commits nothing the
        // player can see. The variant reaches the surface when the provider's commit
        // appends it to this position and that read-back is projected.
        const attempt = startOnce();
        backgroundStarts.add(attempt);
        void attempt
          .finally(() => {
            backgroundStarts.delete(attempt);
            notifyDrain();
          })
          .catch(() => undefined);
        return result;
      } finally {
        pending -= 1;
        notifyDrain();
      }
    },

    async rewind(command: RewindChatCommandV1): Promise<RewindChatResultV1> {
      assertOpen();
      if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
      if (!TavernBrowserValidatorsV1.RewindChatCommandV1Schema.Check(command)) throw unavailable();
      if (command.selectionGeneration !== lease.browserProjection.selectionGeneration) throw selectionConflict();
      const state = await resumeState();
      const target = state.messages.find(
        (message: ChatThreadState["messages"][number]) =>
          lease.browserProjection.projectMessageHandle(message.messageId) === command.messageHandle,
      );
      if (target === undefined) throw mutationRefusal("chat_message_not_found");
      const order = state.messages.indexOf(target);
      // The transcript is what a position means: a row that is no longer at the order the browser
      // rendered it is a stale view, and rewinding from it would drop messages the player never saw.
      if (order !== command.expectedOrder) throw mutationRefusal("chat_message_revision_conflict");
      // The greeting is the conversation's own first message, not part of the exchange above it:
      // dropping it would leave a thread whose recorded opening no longer exists.
      if (target.kind === "opening") throw mutationRefusal("chat_rewind_opening_retained");
      // A turn that is not terminal is a reply still being written. Rewinding through it would
      // truncate a mounted turn, so it is refused rather than silently drained.
      const ledger = state.turnLedger;
      if (ledger !== null && !isTerminalLedger(ledger)) throw mutationRefusal("chat_rewind_turn_active");
      try {
        const next = await rewindMountedChatTranscript(manifest, lease, {
          messageId: target.messageId,
          expectedOrder: order,
        });
        const tail = next.messages[next.messages.length - 1];
        const result = Object.freeze({
          apiVersion: TAVERN_BROWSER_API_VERSION,
          lastMessage: tail === undefined ? null : projectMessage(lease, tail, next.messages.length - 1),
        });
        // Fail closed unless the committed representation satisfies its frozen contract schema; a
        // partial or invalid projection never escapes.
        if (!TavernBrowserValidatorsV1.RewindChatResultV1Schema.Check(result)) throw unavailable();
        return result;
      } catch (error) {
        throw rethrowMutationRefusal(error);
      }
    },

    async edit(command: EditMessageCommandV1): Promise<EditMessageResultV1> {
      assertOpen();
      if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
      if (!TavernBrowserValidatorsV1.EditMessageCommandV1Schema.Check(command)) throw unavailable();
      if (command.selectionGeneration !== lease.browserProjection.selectionGeneration) throw selectionConflict();
      const state = await resumeState();
      const target = state.messages.find(
        (message: ChatThreadState["messages"][number]) =>
          lease.browserProjection.projectMessageHandle(message.messageId) === command.messageHandle,
      );
      if (target === undefined) throw mutationRefusal("chat_message_not_found");
      const order = state.messages.indexOf(target);
      // The transcript is what a position means: a row that is no longer where the browser read it is
      // a stale view, and editing from it would rewrite a message the player is not looking at.
      if (order !== command.expectedOrder) throw mutationRefusal("chat_message_revision_conflict");
      // Only the player's own words. Her reply carries swipe state and the ledger's own presentation
      // row, so its text has its own semantics; the greeting the Chat opened on has its own route.
      if (target.role !== "player" || target.kind !== "player") throw mutationRefusal("chat_edit_not_player_message");
      // A turn that is not terminal is a reply being written from the very text this edit replaces,
      // so the transcript is not allowed to change under it.
      const ledger = state.turnLedger;
      if (ledger !== null && !isTerminalLedger(ledger)) throw mutationRefusal("chat_edit_turn_active");
      try {
        const next = await editMountedChatMessage(manifest, lease, {
          messageId: target.messageId,
          expectedOrder: order,
          text: command.text,
        });
        const edited = next.messages[order];
        // The projection reads the durable read-back, never the command's echo: a row that is not the
        // one the edit just wrote is a disagreement the surface must not see.
        if (edited === undefined || edited.text !== command.text) throw unavailable();
        const result = Object.freeze({
          apiVersion: TAVERN_BROWSER_API_VERSION,
          message: projectMessage(lease, edited, order),
        });
        // Fail closed unless the committed representation satisfies its frozen contract schema; a
        // partial or invalid projection never escapes.
        if (!TavernBrowserValidatorsV1.EditMessageResultV1Schema.Check(result)) throw unavailable();
        return result;
      } catch (error) {
        throw rethrowMutationRefusal(error);
      }
    },

    async close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = (async () => {
        await waitForIdle();
        closed = true;
        store.close?.();
      })();
      return closePromise;
    },
  });
  return service;

  /**
   * The browser-safe result of a same-position variant acceptance. There is no
   * minted player row to project: the committed representation is the reply
   * position the turn re-generates - read back from durable state, never from the
   * caller's command echo - plus the ledger the acceptance just created.
   */
  async function projectVariantAcceptedResult(
    accepted: AcceptedQueuedTurn,
    state: ChatThreadState,
    targetMessageId: string,
    disposition: "accepted" | "duplicate",
  ): Promise<SubmitResultV1> {
    const variant = accepted.variant;
    if (variant === undefined || variant.targetMessageId !== targetMessageId) throw unavailable();
    if (state.turnLedger === null || state.turnLedger.turnId !== accepted.turnId) throw unavailable();
    const order = state.messages.findIndex((message) => message.messageId === targetMessageId);
    const message = order < 0 ? undefined : state.messages[order];
    if (message === undefined || message.role !== "companion" || message.kind !== "response") throw unavailable();
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
    try {
      await claim.claim();
      await start.start();
    } catch (error) {
      // The submit caller must not learn the cause - the durable ledger and the status read-back
      // are the authority for what happened. An OPERATOR must, though: without this line a failed
      // turn leaves no trace but the generic "chat_pipeline_continuation_failed", which is how a
      // keyword-matching message looked like a runtime outage. Bounded: message only, sliced to
      // 200 characters, no stack and no content.
      process.stderr.write(
        `[continuation] failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}\n`,
      );
      throw new Error("chat_pipeline_continuation_failed");
    }
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
      : ledger.status === "running" ||
          ledger.status === "presentation_committed" ||
          ledger.status === "completion_claimed" ||
          ledger.status === "cancel_claimed"
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

/**
 * The message-mutation refusals that name the point the player chose: the rewind's four and the
 * edit's two. They keep their own code all the way to the surface; every other failure (store shape,
 * session path, read-back, admission, unknown) collapses to the service's fail-closed code so no raw
 * path, identifier or content can escape. One list for both operations, because each forwards the
 * durable store's own refusals unchanged - and only codes a store or ingress can really produce
 * belong on it.
 */
const CHAT_MESSAGE_MUTATION_REFUSALS: readonly string[] = [
  "chat_message_not_found",
  "chat_message_revision_conflict",
  "chat_rewind_opening_retained",
  "chat_rewind_turn_active",
  "chat_edit_not_player_message",
  "chat_edit_turn_active",
];

function mutationRefusal(code: string): Error {
  return new Error(code);
}

function rethrowMutationRefusal(error: unknown): Error {
  if (error instanceof Error && CHAT_MESSAGE_MUTATION_REFUSALS.includes(error.message)) return error;
  return unavailable();
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
