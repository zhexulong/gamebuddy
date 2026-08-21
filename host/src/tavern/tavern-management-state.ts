import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { assertProfileMatchesBinding, readIdentityProfile, readIdentityProfileBinding } from "../identity-profile.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import {
  type BrowserTurnV1,
  type ComposedTavernProfile,
  isComposedTavernProfile,
  type TavernBrowserOperationV1,
  TavernBrowserValidatorsV1,
  type WorldInfoStateV1,
} from "./browser-contract/index.js";
import { type ChatThreadState, type ChatTurnLedger, createChatThreadStore } from "./chat-thread-store.js";
import type { P3ExactChatMessage } from "./p3-exact-chat-state.js";
import type { WorldInfoBindingManagementService } from "./world-info-binding/world-info-binding-management-service.js";

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
  worldInfo: WorldInfoStateV1 | null;
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
  worldInfoService?: WorldInfoBindingManagementService,
): Promise<TavernManagementStateFacade> {
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  // Canonical WeakSet identity-brand gate (same authority as the binding
  // service): a structural clone of a composed profile is never accepted,
  // and the rejection precedes every durable read below.
  if (!isComposedTavernProfile(profile)) throw unavailable();
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

  // A profile that declares either World Info route without a bound service
  // must fail closed before any durable I/O: the capability cannot be
  // advertised without the exact service backing it.
  if (
    profile.routeIds.includes("world-info.read") ||
    profile.routeIds.includes("world-info.bind")
  ) {
    if (worldInfoService === undefined)
      throw new Error("tavern_management_composition_unavailable");
  }
  const resolvedWorldInfoService = worldInfoService;

  return Object.freeze({
    async read(): Promise<TavernManagementState> {
      if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
      try {
        const state = await threads.resumeThread(binding.chatThreadId, binding.chatSurfaceSessionId);
        validateStateBinding(state, binding);
        // Durable reads do not hold the mount capability. A concurrent close
        // revokes the lease before projection, so never project stale data.
        assertTavernManagementLeaseAfterDurableRead(lease);
        return await project(lease, companionDisplayName, profile, state, resolvedWorldInfoService);
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

async function project(
  lease: MountedChatRuntimeLease,
  companionDisplayName: string,
  profile: ComposedTavernProfile,
  state: ChatThreadState,
  worldInfoService?: WorldInfoBindingManagementService,
): Promise<TavernManagementState> {
  if (state.messages.length > MAX_TRANSCRIPT_MESSAGES) throw unavailable();
  const projection = lease.browserProjection;
  const transcript = Object.freeze(state.messages.map((message, order) => projectMessage(lease, message, order)));
  const turn = projectTurn(lease, state.turnLedger);
  const operations = projectOperations(profile);
  const worldInfoState = worldInfoService === undefined ? null : await v1WorldInfo(worldInfoService);
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
    worldInfo: worldInfoState,
  });
  // Fail closed unless every projected browser fact satisfies its frozen
  // contract schema; a partial or invalid projection never escapes.
  if (
    transcript.some((message) => !TavernBrowserValidatorsV1.BrowserMessageV1Schema.Check(message)) ||
    (turn !== null && !TavernBrowserValidatorsV1.BrowserTurnV1Schema.Check(turn)) ||
    operations.some((operation) => !TavernBrowserValidatorsV1.TavernBrowserOperationV1Schema.Check(operation)) ||
    (worldInfoState !== null && !TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check(worldInfoState))
  )
    throw unavailable();
  return value;
}

/**
 * Safe World Info projection from the bound service. The full-state read is
 * validated against the frozen schema before it may enter the browser
 * snapshot; a malformed or failed projection fails closed so no partial World
 * Info state ever escapes the facade.
 */
async function v1WorldInfo(worldInfoService: WorldInfoBindingManagementService): Promise<WorldInfoStateV1> {
  try {
    const value = await worldInfoService.read();
    if (!TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check(value)) throw unavailable();
    // Fresh contract-shaped copies of the service's readonly projection; the
    // caller's schema gate then revalidates the exact snapshot facts.
    return {
      state: value.state,
      revision: value.revision,
      items: value.items.map((item) => ({
        handle: item.handle,
        title: item.title,
        summary: item.summary,
        selected: item.selected,
      })),
    };
  } catch {
    throw unavailable();
  }
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
 * Frozen operations projection for the management profile: draft save/discard,
 * `chat.rename` and `world-info.bind` appear only when the mounted profile
 * declares them. The mounted Chat always exists, so durable CAS owns every
 * rejection.
 */
function projectOperations(profile: ComposedTavernProfile): readonly TavernBrowserOperationV1[] {
  const operations: TavernBrowserOperationV1[] = [];
  if (profile.operationIds.includes("draft.save"))
    operations.push(
      Object.freeze({
        operationId: "draft.save",
        labelKey: "tavern.operation.draft.save",
        availability: "available",
        routeId: "draft.save",
      }),
    );
  if (profile.operationIds.includes("draft.discard"))
    operations.push(
      Object.freeze({
        operationId: "draft.discard",
        labelKey: "tavern.operation.draft.discard",
        availability: "available",
        routeId: "draft.discard",
      }),
    );
  if (profile.operationIds.includes("chat.rename"))
    operations.push(
      Object.freeze({
        operationId: "chat.rename",
        labelKey: "tavern.operation.rename",
        availability: "available",
        routeId: "chat.rename",
      }),
    );
  if (profile.operationIds.includes("world-info.bind"))
    operations.push(
      Object.freeze({
        operationId: "world-info.bind",
        labelKey: "tavern.operation.world-info.bind",
        availability: "available",
        routeId: "world-info.bind",
      }),
    );
  return Object.freeze(operations);
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
