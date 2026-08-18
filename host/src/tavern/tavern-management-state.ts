import { assertProfileMatchesBinding, readIdentityProfile, readIdentityProfileBinding } from "../identity-profile.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import {
  TavernBrowserValidatorsV1,
  type BrowserTurnV1,
  type ComposedTavernProfile,
  type TavernBrowserOperationV1,
} from "./browser-contract/index.js";
import { createChatThreadStore, type ChatThreadState, type ChatTurnLedger } from "./chat-thread-store.js";
import type { P3ExactChatMessage } from "./p3-exact-chat-state.js";

const MAX_TRANSCRIPT_MESSAGES = 500;
type TavernManagementBinding = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  companionId: string;
  continuityId: string;
}>;

/**
 * Browser-safe exact mounted state for the tavern_management profile. It
 * mirrors the reference projection and adds the mounted profile's operation
 * projection (`chat.rename`). It never contains a storage ID, raw durable
 * identifier, prompt, provider, session or CSRF fact.
 */
export type TavernManagementState = Readonly<{
  selection: Readonly<{
    chatHandle: string;
    generation: number;
    stateRevision: string;
  }>;
  companionDisplayName: string;
  title: string | null;
  transcript: readonly P3ExactChatMessage[];
  draft: Readonly<{ revision: number; text: string | null }>;
  turn: BrowserTurnV1 | null;
  operations: readonly TavernBrowserOperationV1[];
}>;

/** Read-only management capability: no roots, stores, selector, lease, or mutation authority escapes. */
export type TavernManagementStateFacade = Readonly<{
  read(): Promise<TavernManagementState>;
}>;

/**
 * Builds the exact mounted state facade only from the production coordinator's
 * current mounted lease and a composed tavern profile. It proves the lease
 * current before any disk I/O and again after every durable `resumeThread`
 * await; forged, inactive or revoked-after-await leases fail closed with no
 * partial state.
 */
export async function createTavernManagementStateFacade(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  profile: ComposedTavernProfile,
): Promise<TavernManagementStateFacade> {
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
  assertTavernManagementLeaseAfterDurableRead(lease);
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
    async read(): Promise<TavernManagementState> {
      if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
      try {
        const state = await threads.resumeThread(binding.chatThreadId, binding.chatSurfaceSessionId);
        validateStateBinding(state, binding);
        // Durable reads do not hold the mount capability. A concurrent close
        // revokes the lease before projection, so never project stale data.
        assertTavernManagementLeaseAfterDurableRead(lease);
        return project(lease, companionDisplayName, profile, state);
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
export function assertTavernManagementLeaseAfterDurableRead(
  lease: MountedChatRuntimeLease,
  current: (value: unknown) => boolean = isCurrentMountedChatRuntimeLease,
): void {
  if (!current(lease)) throw unavailable();
}

function bindingFrom(manifest: HostDeploymentManifest, lease: MountedChatRuntimeLease): TavernManagementBinding {
  if (!identifier(lease.chatThreadId) || !identifier(lease.chatSurfaceSessionId)) throw unavailable();
  return Object.freeze({
    chatThreadId: lease.chatThreadId,
    chatSurfaceSessionId: lease.chatSurfaceSessionId,
    companionId: manifest.principal.companionId,
    continuityId: manifest.principal.continuityId,
  });
}

function validateStateBinding(state: ChatThreadState, binding: TavernManagementBinding): void {
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
): TavernManagementState {
  if (state.messages.length > MAX_TRANSCRIPT_MESSAGES) throw unavailable();
  const projection = lease.browserProjection;
  const transcript = Object.freeze(state.messages.map((message, order) => projectMessage(lease, message, order)));
  const turn = projectTurn(lease, state.turnLedger);
  const operations = projectOperations(profile);
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
): P3ExactChatMessage {
  if (message.role !== "player" && message.role !== "companion") throw unavailable();
  if (!safeBrowserRevision(order) || !safeBrowserRevision(1)) throw unavailable();
  return Object.freeze({
    handle: lease.browserProjection.projectMessageHandle(message.messageId),
    role: message.role,
    text: message.text,
    // ChatThreadStore persists no language metadata; the facade must not infer one.
    locale: "und",
    // ChatThreadStore transcript order is append-only; the facade exposes its index.
    order,
    // The management profile has no message mutation, so durable records are immutable.
    revision: 1,
  });
}

/** Frozen durable TurnLedger → BrowserTurnV1 projection (design/72 §7). */
function projectTurn(lease: MountedChatRuntimeLease, ledger: ChatTurnLedger | null): BrowserTurnV1 | null {
  if (ledger === null) return null;
  const state =
    ledger.status === "accepted_queued" || ledger.status === "attempt_starting"
      ? "queued"
      : ledger.status === "running"
        ? "running"
        : ledger.status === "presentation_committed" || ledger.status === "completion_claimed"
          ? "response_visible"
          : ledger.status === "cancel_claimed"
            ? "stopping"
            : ledger.status;
  return Object.freeze({
    handle: lease.browserProjection.projectTurnHandle(ledger.turnId),
    state,
    projectionRevision: 1,
    canCancel: false,
    ...(ledger.status === "failed" ? { problemCode: ledger.reasonCode } : {}),
  });
}

/**
 * Frozen operations projection for the management profile: draft save/discard
 * and `chat.rename` appear only when the mounted profile declares them. The
 * mounted Chat always exists, so durable CAS owns every rejection.
 */
function projectOperations(profile: ComposedTavernProfile): readonly TavernBrowserOperationV1[] {
  const operations: TavernBrowserOperationV1[] = [];
  if (profile.operationIds.includes("draft.save"))
    operations.push(Object.freeze({ operationId: "draft.save", labelKey: "tavern.operation.draft.save", availability: "available", routeId: "draft.save" }));
  if (profile.operationIds.includes("draft.discard"))
    operations.push(Object.freeze({ operationId: "draft.discard", labelKey: "tavern.operation.draft.discard", availability: "available", routeId: "draft.discard" }));
  if (profile.operationIds.includes("chat.rename"))
    operations.push(Object.freeze({ operationId: "chat.rename", labelKey: "tavern.operation.rename", availability: "available", routeId: "chat.rename" }));
  return Object.freeze(operations);
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

function safeBrowserRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
function unavailable(): Error {
  return new Error("tavern_management_state_unavailable");
}
