import type { Static } from "typebox";
import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { assertProfileMatchesBinding, readIdentityProfile, readIdentityProfileBinding } from "../identity-profile.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import {
  type BrowserDraftV1Schema,
  type BrowserMessageV1,
  type BrowserTurnV1,
  type ComposedTavernProfile,
  TAVERN_BROWSER_API_VERSION,
  type TavernBrowserOperationV1,
  TavernBrowserValidatorsV1,
} from "./browser-contract/index.js";
import type { ChatEventStream } from "./chat-event-stream.js";
import { type ChatThreadState, type ChatTurnLedger, createChatThreadStore } from "./chat-thread-store.js";

const MAX_TRANSCRIPT_MESSAGES = 500;
type BrowserDraftV1 = Static<typeof BrowserDraftV1Schema>;
type ReferencePipelineBinding = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  companionId: string;
  continuityId: string;
}>;

/**
 * Browser-safe exact mounted reference state. It mirrors the P3 projection and
 * adds the durable TurnLedger projection and the mounted profile's operation
 * projection. It never contains a storage ID, raw durable identifier, prompt,
 * provider, session or CSRF fact; it is not a TavernStateSnapshotV1.
 */
export type ReferencePipelineState = Readonly<{
  selection: Readonly<{
    chatHandle: string;
    generation: number;
    stateRevision: string;
  }>;
  companionDisplayName: string;
  title: string | null;
  transcript: readonly BrowserMessageV1[];
  draft: Readonly<{ revision: number; text: string | null }>;
  turn: BrowserTurnV1 | null;
  operations: readonly TavernBrowserOperationV1[];
  eventStream: Readonly<{ epoch: string; cursor: string }> | null;
}>;

/** Read-only reference-pipeline capability: no roots, stores, selector, lease, or mutation authority escapes. */
export type ReferencePipelineStateFacade = Readonly<{
  read(): Promise<ReferencePipelineState>;
  readDraft(): Promise<BrowserDraftV1>;
}>;

/**
 * Builds the exact mounted state facade only from the production coordinator's
 * current mounted lease and a composed tavern profile. It proves the lease
 * current before any disk I/O and again after every durable `resumeThread`
 * await; forged, inactive or revoked-after-await leases fail closed with no
 * partial state.
 */
export async function createReferencePipelineStateFacade(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  profile: ComposedTavernProfile,
  eventStream?: ChatEventStream,
): Promise<ReferencePipelineStateFacade> {
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  assertComposedProfile(profile);
  const binding = bindingFrom(manifest, lease);
  const paths = resolveRuntimePaths(manifest.principal, manifest.runtimeRoot, lease.chatSurfaceSessionId);
  const expectedIdentityKey = identityKey(manifest.principal);
  const [identityProfile, profileBinding] = await Promise.all([
    readIdentityProfile(paths.identityProfilePath),
    readIdentityProfileBinding(paths.identityProfileBindingPath),
  ]);
  // Construction also crosses durable I/O. Never retain identity facts read
  // after a concurrent mounted-lease revocation for a future facade call.
  assertReferencePipelineLeaseAfterDurableRead(lease);
  if (profileBinding === null) throw unavailable();
  try {
    assertProfileMatchesBinding(expectedIdentityKey, identityProfile, profileBinding);
  } catch {
    throw unavailable();
  }

  const threads = createChatThreadStore(manifest.runtimeRoot, expectedIdentityKey);
  const companionDisplayName = identityProfile.identity.name;
  if (companionDisplayName.length === 0) throw unavailable();

  return Object.freeze({
    async read(): Promise<ReferencePipelineState> {
      if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
      try {
        const state = await threads.resumeThread(binding.chatThreadId, binding.chatSurfaceSessionId);
        validateStateBinding(state, binding);
        // Durable reads do not hold the mount capability. A concurrent close
        // revokes the lease before projection, so never project stale data.
        assertReferencePipelineLeaseAfterDurableRead(lease);
        return project(lease, companionDisplayName, profile, state, eventStream);
      } catch {
        throw unavailable();
      }
    },
    async readDraft(): Promise<BrowserDraftV1> {
      if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
      try {
        const state = await threads.resumeThread(binding.chatThreadId, binding.chatSurfaceSessionId);
        validateStateBinding(state, binding);
        assertReferencePipelineLeaseAfterDurableRead(lease);
        const draft = Object.freeze({
          apiVersion: TAVERN_BROWSER_API_VERSION,
          revision: state.draft.revision,
          text: state.draft.text,
        });
        if (!TavernBrowserValidatorsV1.BrowserDraftV1Schema.Check(draft)) throw unavailable();
        return draft;
      } catch {
        throw unavailable();
      }
    },
  });
}

/**
 * Shared post-await guard. It neither creates nor brands leases; the only
 * production lease authority remains the coordinator's private WeakMap.
 * The optional predicate is a test seam only: it can validate revocation
 * timing but cannot add a coordinator WeakMap brand or mint a usable lease.
 */
export function assertReferencePipelineLeaseAfterDurableRead(
  lease: MountedChatRuntimeLease,
  current: (value: unknown) => boolean = isCurrentMountedChatRuntimeLease,
): void {
  if (!current(lease)) throw unavailable();
}

function bindingFrom(manifest: HostDeploymentManifest, lease: MountedChatRuntimeLease): ReferencePipelineBinding {
  if (!identifier(lease.chatThreadId) || !identifier(lease.chatSurfaceSessionId)) throw unavailable();
  return Object.freeze({
    chatThreadId: lease.chatThreadId,
    chatSurfaceSessionId: lease.chatSurfaceSessionId,
    companionId: manifest.principal.companionId,
    continuityId: manifest.principal.continuityId,
  });
}

function validateStateBinding(state: ChatThreadState, binding: ReferencePipelineBinding): void {
  const thread = state.thread;
  if (
    thread.chatThreadId !== binding.chatThreadId ||
    thread.chatSurfaceSessionId !== binding.chatSurfaceSessionId ||
    thread.companionId !== binding.companionId ||
    thread.continuityId !== binding.continuityId
  )
    throw unavailable();
}

function project(
  lease: MountedChatRuntimeLease,
  companionDisplayName: string,
  profile: ComposedTavernProfile,
  state: ChatThreadState,
  eventStream?: ChatEventStream,
): ReferencePipelineState {
  if (state.messages.length > MAX_TRANSCRIPT_MESSAGES) throw unavailable();
  const projection = lease.browserProjection;
  const transcript = Object.freeze(state.messages.map((message, order) => projectMessage(lease, message, order)));
  const turn = projectTurn(lease, profile, state.turnLedger);
  const operations = projectOperations(profile, state.turnLedger);
  const value = Object.freeze({
    selection: Object.freeze({
      chatHandle: projection.chatHandle,
      generation: projection.selectionGeneration,
      stateRevision: projection.selectionStateRevision,
    }),
    companionDisplayName,
    title: state.thread.title ?? null,
    transcript,
    draft: Object.freeze({ revision: state.draft.revision, text: state.draft.text }),
    turn,
    operations,
    eventStream:
      profile.routeIds.includes("events") && eventStream !== undefined
        ? Object.freeze({ epoch: eventStream.epoch, cursor: eventStream.cursor })
        : null,
  });
  // Fail closed unless every projected browser fact satisfies its frozen
  // contract schema; a partial or invalid projection never escapes.
  if (
    transcript.some((message) => !TavernBrowserValidatorsV1.BrowserMessageV1Schema.Check(message)) ||
    (turn !== null && !TavernBrowserValidatorsV1.BrowserTurnV1Schema.Check(turn)) ||
    operations.some((operation) => !TavernBrowserValidatorsV1.TavernBrowserOperationV1Schema.Check(operation))
  )
    throw unavailable();
  return value;
}

function projectMessage(
  lease: MountedChatRuntimeLease,
  message: ChatThreadState["messages"][number],
  order: number,
): BrowserMessageV1 {
  if (message.role !== "player" && message.role !== "companion") throw unavailable();
  if (!safeBrowserRevision(order) || !safeBrowserRevision(1)) throw unavailable();
  return Object.freeze({
    handle: lease.browserProjection.projectMessageHandle(message.messageId),
    role: message.role,
    text: message.text,
    // ChatThreadStore persists no language metadata; the reference facade must not infer one.
    locale: "und",
    // ChatThreadStore transcript order is append-only; the facade exposes its index.
    order,
    // The reference pipeline has no message mutation, so durable records are immutable.
    revision: 1,
  });
}

/**
 * Frozen durable TurnLedger → BrowserTurnV1 projection (design/72 §7).
 * `projectionRevision` is the literal 1 (a browser-projection fact, not a
 * durable claim); `canCancel` is always false (no cancel operation mounted);
 * `problemCode` appears only for the durable `failed` terminal classification,
 * whose reason codes exactly match the TypeBox contract union.
 */
function projectTurn(
  lease: MountedChatRuntimeLease,
  profile: ComposedTavernProfile,
  ledger: ChatTurnLedger | null,
): BrowserTurnV1 | null {
  if (ledger === null) return null;
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
    // A Stop is available once the exact prompt reaches durable arm.
    canCancel: profile.operationIds.includes("chat.cancel") && isCancellableLedger(ledger),
    ...(ledger.status === "failed" ? { problemCode: ledger.reasonCode } : {}),
  });
}

/**
 * Frozen operations projection (design/72 §8): `chat.submit` appears only when
 * the mounted profile declares it, is `available` exactly when no turn exists,
 * and `busy` otherwise. No other operation is projected.
 */
function projectOperations(
  profile: ComposedTavernProfile,
  turnLedger: ChatTurnLedger | null,
): readonly TavernBrowserOperationV1[] {
  const terminal =
    turnLedger === null ||
    turnLedger.status === "completed" ||
    turnLedger.status === "cancelled" ||
    turnLedger.status === "failed";
  const operations: TavernBrowserOperationV1[] = [];
  if (profile.operationIds.includes("chat.submit"))
    operations.push(
      Object.freeze({
        operationId: "chat.submit",
        labelKey: "tavern.operation.submit",
        availability: terminal ? "available" : "busy",
        routeId: "chat.submit",
      }),
    );
  if (profile.operationIds.includes("chat.cancel"))
    operations.push(
      Object.freeze({
        operationId: "chat.cancel",
        labelKey: "tavern.operation.cancel",
        availability: isCancellableLedger(turnLedger) ? "available" : "unavailable",
        routeId: "chat.cancel",
      }),
    );
  return Object.freeze(operations);
}

function isCancellableLedger(ledger: ChatTurnLedger | null): boolean {
  return (
    ledger !== null &&
    ((ledger.status === "attempt_starting" && ledger.observation?.phase === "armed") || ledger.status === "running")
  );
}

/**
 * Accepts only a composed tavern capability slice (the frozen shape produced
 * by `composeTavernProfile`); plain or partial forgeries fail closed before
 * any I/O. The facade projects only `chat.submit`, so a profile can only ever
 * include or exclude that one operation.
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

function safeBrowserRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
function unavailable(): Error {
  return new Error("reference_pipeline_state_unavailable");
}
