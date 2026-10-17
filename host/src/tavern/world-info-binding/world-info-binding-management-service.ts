import { randomBytes } from "node:crypto";
import type { MountedChatRuntimeLease } from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import { isCurrentMountedChatRuntimeLease } from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import { identityKey } from "../../runtime.js";
import type { ComposedTavernProfile } from "../browser-contract/index.js";
import {
  isComposedTavernProfile,
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserValidatorsV1,
} from "../browser-contract/index.js";
import {
  type ChatThreadState,
  type TavernStableManagedWorldInfoBinding,
  createChatThreadStore,
  ExactThreadSurfaceMismatchError,
} from "../chat-thread-store.js";
import type {
  CreateWorldInfoRequest,
  PublicWorldInfoProjection,
  UpdateWorldInfoRequest,
  WorldInfoManagementRepository,
} from "../world-info-management/world-info-management.js";
import { createManagedWorldInfoBindingResolver } from "./managed-world-info-binding.js";

/**
 * Safe World Info binding projection for the exact mounted Chat. `revision`
 * and every item `handle` are opaque values minted by this service; the
 * browser can never decode them into a durable fact.
 */
export type WorldInfoStateV1 = Readonly<{
  state: "none" | "selected" | "pending" | "unavailable";
  revision: string;
  items: readonly Readonly<{
    handle: string;
    title: string;
    summary: string | null;
    selected: boolean;
    pending: boolean;
  }>[];
}>;
/**
 * Exact bind/unbind command. `expectedRevision` and `sourceHandle` are the
 * opaque handles from the last validated state projection; a raw title,
 * timestamp, storage handle or canonical hash is never expressible here.
 */
export type SetWorldInfoBindingCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: string;
  sourceHandle: string | null;
}>;
/**
 * Library item addressing inside the exact current opaque projection. Both
 * `expectedRevision` and `itemHandle` are the opaque values minted by the last
 * validated state projection; a raw title, storage revision number, handle or
 * canonical hash is never expressible here, and a handle from any other
 * projection always conflicts.
 */
export type WorldInfoItemCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: string;
  itemHandle: string;
}>;
/** New-item authoring command. `item` is the validated content; `expectedRevision` is the opaque projection handle the browser read. */
export type WorldInfoCreateCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: string;
  item: CreateWorldInfoRequest;
}>;
/**
 * Content update of one exact library item. The top-level `expectedRevision` is
 * the opaque projection handle; `item.expectedRevision` is the library's own
 * optimistic revision number.
 */
export type WorldInfoUpdateCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: string;
  itemHandle: string;
  item: UpdateWorldInfoRequest;
}>;
/**
 * Host-owned management service for the mounted tavern_management World Info
 * lane. The read/bind half exposes only browser-safe opaque facts: no store,
 * resolver, mapping, root, lease, source title lookup, timestamp or canonical
 * hash escapes. The library half addresses items by the same opaque handles and
 * serves detail/create/update/delete over the managed repository.
 */
export type WorldInfoBindingManagementService = Readonly<{
  read(): Promise<WorldInfoStateV1>;
  setBinding(command: SetWorldInfoBindingCommandV1): Promise<WorldInfoStateV1>;
  detail(command: WorldInfoItemCommandV1): Promise<PublicWorldInfoProjection | null>;
  create(command: WorldInfoCreateCommandV1): Promise<WorldInfoStateV1>;
  update(command: WorldInfoUpdateCommandV1): Promise<WorldInfoStateV1>;
  delete(command: WorldInfoItemCommandV1): Promise<WorldInfoStateV1>;
  close(): Promise<void>;
}>;

export type WorldInfoBindingManagementServiceOptions = Readonly<{
  manifest: HostDeploymentManifest;
  lease: MountedChatRuntimeLease;
  /** The composed tavern_management capability slice that gates both World Info routes. */
  profile: ComposedTavernProfile;
  repository: WorldInfoManagementRepository;
  /**
   * Optional immediate convergence for pristine (message-less) threads. When
   * present, a successful bind on an idle chat asks the coordinator to mint
   * the applied state right away instead of stranding the chat in pending
   * until the next player turn. Absent, the desired-state model is unchanged
   * and bindings stay pending exactly as before.
   */
  settleAuthoredContext?: () => Promise<void>;
}>;

type SourceMapping = Readonly<{ publicTitle: string; revision: number }>;
/**
 * Exact current opaque revision projection. `revisionHandle` and every item
 * source handle are valid only as a member of this exact projection; every
 * `projectFrom` atomically replaces it, so a handle from an older or later
 * projection always conflicts. There are no unbounded handle registries.
 */
type ProjectionMapping = Readonly<{
  revisionHandle: string;
  updatedAtMs: number;
  fingerprint: string;
  sources: ReadonlyMap<string, SourceMapping>;
}>;

/**
 * Builds the lease-bound World Info binding service from the deployment
 * principal, the coordinator-branded current mounted lease, the composed
 * management profile and the durable managed repository. Forged, revoked or
 * structurally-copied leases and profiles missing either World Info route or
 * the bind operation fail closed before any durable I/O.
 */
export function createWorldInfoBindingManagementService(
  options: WorldInfoBindingManagementServiceOptions,
): WorldInfoBindingManagementService {
  const { manifest, lease, profile, repository, settleAuthoredContext } = options;
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  assertComposedProfile(profile);
  if (
    !profile.routeIds.includes("world-info.read") ||
    !profile.routeIds.includes("world-info.bind") ||
    !profile.operationIds.includes("world-info.bind")
  )
    throw unavailable();
  if (!identifier(lease.chatThreadId) || !identifier(lease.chatSurfaceSessionId)) throw unavailable();

  const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
  const setManagedWorldInfoBinding = store.setManagedWorldInfoBinding;
  if (setManagedWorldInfoBinding === undefined) throw unavailable();
  const resolver = createManagedWorldInfoBindingResolver(repository);
  let currentProjection: ProjectionMapping | null = null;

  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new Error("world_info_binding_service_closed");
  };

  const assertLeaseAfterDurableRead = (): void => {
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  };

  /**
   * The captured projection object must still be the exact current one at
   * every point where the mutation resumes after a yielding await or is about
   * to commit durably. A concurrent read can publish a superseding projection
   * (same durable thread, new opaque handles); once that happens the captured
   * handles are no longer valid and the mutation must fail closed with a
   * conflict before any worldbook I/O.
   */
  const assertProjectionCurrent = (projection: ProjectionMapping): void => {
    if (currentProjection !== projection) throw conflict();
  };

  const read = async (): Promise<WorldInfoStateV1> => {
    assertOpen();
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    try {
      const state = await store.resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
      assertLeaseAfterDurableRead();
      return await projectFrom(state);
    } catch (error) {
      throw rethrowReadError(error);
    }
  };

  const setBinding = async (command: SetWorldInfoBindingCommandV1): Promise<WorldInfoStateV1> => {
    assertOpen();
    validateCommand(command);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    const projection = currentProjection;
    if (projection === null || projection.revisionHandle !== command.expectedRevision) throw conflict();
    try {
      const state = await store.resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
      assertLeaseAfterDurableRead();
      assertProjectionCurrent(projection);
      validateThread(state);
      // Desired binding may change while a turn runs; the coordinator applies it only after settlement.
      // The opaque revision handle is unexpired only while both the durable
      // updatedAtMs and the current binding fingerprint equal the mapped
      // values; otherwise the browser acts on a superseded projection.
      if (state.thread.updatedAtMs !== projection.updatedAtMs) throw conflict();
      if (fingerprintFor(state.thread.managedWorldInfoBinding) !== projection.fingerprint) throw conflict();

      let binding: TavernStableManagedWorldInfoBinding | undefined;
      if (command.sourceHandle !== null) {
        // The source handle is valid only as a member of the exact current
        // opaque revision projection captured above; a handle carried from any
        // other projection (older or later) is never resolvable here.
        const source = projection.sources.get(command.sourceHandle);
        if (source === undefined) throw conflict();
        // Exact-revision resolution immediately before store mutation: the
        // browser can never name a latest artifact or a raw source title.
        binding = await resolver.bindExact(source.publicTitle, source.revision);
        // Recheck the coordinator lease right after the awaited resolver
        // round-trip: the mounted runtime may have been torn down meanwhile.
        assertLeaseAfterDurableRead();
        // Recheck the captured projection is still the current one: a
        // concurrent read may have published a superseding projection while
        // the resolver awaited.
        assertProjectionCurrent(projection);
      }
      // Recheck the lease immediately before the durable store mutation so a
      // teardown observed at the mutation boundary fails closed before any
      // worldbook I/O.
      assertLeaseAfterDurableRead();
      assertProjectionCurrent(projection);
      const updated = await setManagedWorldInfoBinding({
        chatThreadId: lease.chatThreadId,
        chatSurfaceSessionId: lease.chatSurfaceSessionId,
        companionId: manifest.principal.companionId,
        continuityId: manifest.principal.continuityId,
        expectedUpdatedAtMs: projection.updatedAtMs,
        ...(binding === undefined ? {} : { binding }),
      });
      assertLeaseAfterDurableRead();
      // Pristine chat: apply the desired binding immediately through the
      // coordinator's settle path so the management browser sees the bound
      // state right away instead of a pending shadow. The settle entry itself
      // refuses when a turn is live or the lease changed, and throws
      // context_unavailable; on an idle mounted runtime it refreshes the
      // authored context and mints applied. A chat that already carries
      // messages keeps the desired-state model: applied only after the next
      // turn's settlement, never mid-conversation.
      if (settleAuthoredContext !== undefined && updated.messages.length === 0) {
        try {
          await settleAuthoredContext();
        } catch {
          // The desired binding is already durable; immediate convergence is
          // best-effort. A live turn, a torn-down lease or a provider hiccup
          // on the settle path must not turn a succeeded bind into an error:
          // the chat simply stays pending and converges on the next turn, the
          // same outcome as if settle had never been wired.
        }
        assertLeaseAfterDurableRead();
        // The settle path may have minted applied behind the scenes; re-read so
        // the projection shows the converged state rather than the pre-settle
        // pending snapshot. A failed settle re-reads the same pending state.
        const converged = await store.resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
        assertLeaseAfterDurableRead();
        return await projectFrom(converged);
      }
      return await projectFrom(updated);
    } catch (error) {
      throw rethrowMutationError(error);
    }
  };

  /** Reopens the exact mounted thread and revalidates its companion/continuity tuple before any library mutation. */
  const currentThreadState = async (): Promise<ChatThreadState> => {
    const state = await store.resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    assertLeaseAfterDurableRead();
    validateThread(state);
    return state;
  };

  /**
   * Reads one exact library item's full projection. The item is named by an
   * opaque handle from the exact current projection, never by a raw title, so a
   * handle carried from any other projection conflicts before the read.
   */
  const detail = async (command: WorldInfoItemCommandV1): Promise<PublicWorldInfoProjection | null> => {
    assertOpen();
    validateItemCommand(command);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    const projection = currentProjection;
    if (projection === null || projection.revisionHandle !== command.expectedRevision) throw conflict();
    const source = projection.sources.get(command.itemHandle);
    if (source === undefined) throw conflict();
    try {
      const artifact = await repository.detail(source.publicTitle);
      assertLeaseAfterDurableRead();
      return artifact;
    } catch (error) {
      throw rethrowLibraryError(error);
    }
  };

  /**
   * Creates a new library item from the caller's content. The repository
   * revalidates it and refuses a duplicate title; the freshly listed library is
   * then re-projected so the caller receives handles for the new item.
   */
  const create = async (command: WorldInfoCreateCommandV1): Promise<WorldInfoStateV1> => {
    assertOpen();
    validateProjectionCommand(command);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    const projection = currentProjection;
    if (projection === null || projection.revisionHandle !== command.expectedRevision) throw conflict();
    try {
      const state = await currentThreadState();
      await repository.create(command.item);
      assertLeaseAfterDurableRead();
      return await projectFrom(state);
    } catch (error) {
      throw rethrowLibraryError(error);
    }
  };

  /**
   * Replaces one exact library item's content. `item.expectedRevision` is the
   * library's own CAS revision. Renaming an item the mounted Chat is bound to is
   * refused, because a managed binding resolves the item by its public title.
   */
  const update = async (command: WorldInfoUpdateCommandV1): Promise<WorldInfoStateV1> => {
    assertOpen();
    validateItemCommand(command);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    const projection = currentProjection;
    if (projection === null || projection.revisionHandle !== command.expectedRevision) throw conflict();
    const source = projection.sources.get(command.itemHandle);
    if (source === undefined) throw conflict();
    try {
      const state = await currentThreadState();
      if (command.item.publicTitle !== source.publicTitle) assertItemNotInUse(state, source.publicTitle);
      await repository.update(source.publicTitle, command.item);
      assertLeaseAfterDurableRead();
      return await projectFrom(state);
    } catch (error) {
      throw rethrowLibraryError(error);
    }
  };

  /**
   * Removes one exact library item from the catalog. The immutable revision
   * files stay on disk: they are the item's history and a Chat bound to an exact
   * revision reads that revision, so this is a library removal, never an artifact
   * erase. An item the mounted Chat is bound to is refused.
   */
  const remove = async (command: WorldInfoItemCommandV1): Promise<WorldInfoStateV1> => {
    assertOpen();
    validateItemCommand(command);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    const projection = currentProjection;
    if (projection === null || projection.revisionHandle !== command.expectedRevision) throw conflict();
    const source = projection.sources.get(command.itemHandle);
    if (source === undefined) throw conflict();
    try {
      const state = await currentThreadState();
      assertItemNotInUse(state, source.publicTitle);
      await repository.delete(source.publicTitle);
      assertLeaseAfterDurableRead();
      return await projectFrom(state);
    } catch (error) {
      throw rethrowLibraryError(error);
    }
  };

  return Object.freeze({
    read,
    setBinding,
    detail,
    create,
    update,
    delete: remove,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      currentProjection = null;
      store.close?.();
    },
  });

  /**
   * Reopens exactly `lease.chatThreadId` + `lease.chatSurfaceSessionId`,
   * verifies the companion/continuity tuple, lists the public repository
   * catalog, and mints fresh opaque handles for one state projection.
   *
   * This projection, and the Attach/Detach commands it drives, govern LAYER 2
   * ONLY: the Chat's attached managed World Info item. Layer 1 - the companion's
   * own Card book - is her identity, is always applied, and is deliberately not
   * attachable or detachable from this panel; it has no items and no handles here.
   */
  async function projectFrom(state: ChatThreadState): Promise<WorldInfoStateV1> {
    validateThread(state);
    let projections: readonly PublicWorldInfoProjection[] | null = null;
    try {
      projections = await repository.list();
      assertLeaseAfterDurableRead();
    } catch (error) {
      // A lease teardown observed across the catalog round-trip is a
      // fail-closed authority condition: the read must reject instead of
      // publishing a projection. Only a genuine catalog operational failure
      // may produce the resolved "unavailable" projection below.
      if (isLeaseUnavailable(error)) throw error;
      projections = null;
    }
    const pending = !sameBinding(state.thread.managedWorldInfoBinding, state.thread.appliedManagedWorldInfoBinding);
    const selectedBinding = state.thread.appliedManagedWorldInfoBinding ?? null;
    const fingerprint = fingerprintFor(state.thread.managedWorldInfoBinding);
    const revision = mintHandle(new Set());
    const seen = new Set<string>([revision]);
    const sources = new Map<string, SourceMapping>();
    const items: WorldInfoStateV1["items"][number][] = [];
    let selectedCount = 0;
    if (projections !== null) {
      for (const projection of projections) {
        const source: SourceMapping = Object.freeze({
          publicTitle: projection.publicTitle,
          revision: projection.revision,
        });
        const handle = mintHandle(seen);
        seen.add(handle);
        sources.set(handle, source);
        const selected = await isExactlySelected(selectedBinding, source);
        if (selected) selectedCount += 1;
        items.push(
          Object.freeze({
            handle,
            title: projection.publicTitle,
            summary: summarize(projection.summary),
            selected,
            pending: pending,
          }),
        );
      }
    }
    const stateValue: WorldInfoStateV1 =
      projections === null
        ? Object.freeze({
            state: "unavailable" as const,
            revision,
            items: Object.freeze([]),
          })
        : Object.freeze({
            state: pending ? ("pending" as const) : selectedCount > 0 ? ("selected" as const) : ("none" as const),
            revision,
            items: Object.freeze(items),
          });
    if (!TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check(stateValue)) throw unavailable();
    // Publish the exact current projection only once it is fully validated:
    // this atomically replaces the previous projection, so handles from an
    // older or later projection can never be reused for a mutation.
    currentProjection = Object.freeze({
      revisionHandle: revision,
      updatedAtMs: state.thread.updatedAtMs,
      fingerprint,
      sources,
    });
    return stateValue;
  }

  async function isExactlySelected(
    selected: TavernStableManagedWorldInfoBinding | null,
    source: SourceMapping,
  ): Promise<boolean> {
    if (selected === null) return false;
    if (selected.publicTitle !== source.publicTitle || selected.revision !== source.revision) return false;
    try {
      const exact = await resolver.bindExact(source.publicTitle, source.revision);
      assertLeaseAfterDurableRead();
      return exact.canonicalHash === selected.canonicalHash;
    } catch (error) {
      // Only a catalog operational failure demotes this item to unselected. A
      // lease teardown observed during exact-resolution is a fail-closed
      // authority condition and must abort the read, not become selected=false.
      if (isLeaseUnavailable(error)) throw error;
      return false;
    }
  }

  function validateThread(state: ChatThreadState): void {
    const thread = state.thread;
    if (
      thread.chatSurfaceSessionId !== lease.chatSurfaceSessionId ||
      thread.companionId !== manifest.principal.companionId ||
      thread.continuityId !== manifest.principal.continuityId
    )
      throw unavailable();
  }

  function validateCommand(command: SetWorldInfoBindingCommandV1): void {
    validateProjectionCommand(command);
    if (
      command.sourceHandle !== null &&
      (typeof command.sourceHandle !== "string" || !isOpaqueHandle(command.sourceHandle))
    )
      throw conflict();
  }

  /**
   * Every library command carries the opaque projection handle and the exact
   * selection generation it was read at. This shape/format check is the
   * service's own boundary, independent of the browser contract's schema.
   */
  function validateProjectionCommand(command: {
    apiVersion: 1;
    selectionGeneration: number;
    expectedRevision: string;
  }): void {
    if (command === null || typeof command !== "object" || Array.isArray(command)) throw conflict();
    if (command.apiVersion !== TAVERN_BROWSER_API_VERSION) throw conflict();
    if (
      !Number.isSafeInteger(command.selectionGeneration) ||
      command.selectionGeneration < 1 ||
      command.selectionGeneration !== lease.browserProjection.selectionGeneration
    )
      throw conflict();
    if (typeof command.expectedRevision !== "string") throw conflict();
  }

  function validateItemCommand(command: WorldInfoItemCommandV1): void {
    validateProjectionCommand(command);
    if (typeof command.itemHandle !== "string" || !isOpaqueHandle(command.itemHandle)) throw conflict();
  }

  /**
   * Refuses a removal or rename that would strand a binding the mounted Chat
   * still reads. Only the mounted Chat's own managed binding is knowable on this
   * surface: bindings are per-thread rows in the Chat store and this service
   * holds exactly one mounted lease, so a different Chat bound to the same title
   * cannot be answered without a durable binding index. The exactly knowable
   * case - the conversation this service serves - is refused with
   * `world_info_in_use`.
   */
  function assertItemNotInUse(state: ChatThreadState, publicTitle: string): void {
    if (
      bindsManagedTitle(state.thread.managedWorldInfoBinding, publicTitle) ||
      bindsManagedTitle(state.thread.appliedManagedWorldInfoBinding, publicTitle)
    )
      throw new Error("world_info_in_use");
  }
}

function sameBinding(
  a: TavernStableManagedWorldInfoBinding | undefined,
  b: TavernStableManagedWorldInfoBinding | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.publicTitle === b.publicTitle && a.revision === b.revision && a.canonicalHash === b.canonicalHash;
}

function fingerprintFor(binding: TavernStableManagedWorldInfoBinding | undefined): string {
  if (binding === undefined) return "none";
  return `managed:${binding.publicTitle}:${binding.revision}:${binding.canonicalHash}`;
}

function summarize(value: string): string | null {
  return value.length > 512 ? value.slice(0, 512) : value;
}

function mintHandle(seen: ReadonlySet<string>): string {
  let handle = randomBytes(32).toString("base64url");
  while (seen.has(handle)) handle = randomBytes(32).toString("base64url");
  return handle;
}

function isOpaqueHandle(value: string): boolean {
  return /^[A-Za-z0-9_-]{22,128}$/.test(value);
}

function rethrowReadError(error: unknown): Error {
  if (!(error instanceof Error)) return unavailable();
  if (isLeaseUnavailable(error)) return error;
  if (error instanceof ExactThreadSurfaceMismatchError) return conflict();
  if (isStorageError(error)) return storageUnavailable();
  if (/lease|mount|closed/i.test(error.message)) return unavailable();
  return unavailable();
}

function rethrowMutationError(error: unknown): Error {
  if (!(error instanceof Error)) return unavailable();
  if (isLeaseUnavailable(error)) return error;
  if (error.message === "world_info_binding_conflict") return conflict();
  if (error.message === "world_info_binding_locked") return locked();
  if (error.message === "context_unavailable") return unavailable();
  if (error.message === "world_info_binding_service_unavailable") return unavailable();
  if (error.message === "chat_thread_revision_conflict" || error.message === "chat_thread_scope_mismatch")
    return conflict();
  if (error.message === "chat_thread_worldbook_locked") return locked();
  if (error.message === "managed_world_info_revision_missing" || error.message === "managed_world_info_not_found")
    return conflict();
  if (isStorageError(error)) return storageUnavailable();
  if (/lease|mount|closed/i.test(error.message)) return unavailable();
  return conflict();
}

function isStorageError(error: Error): boolean {
  return /storage|sqlite|eio|enoent/i.test(error.message);
}

/**
 * Library-mutation error mapping. The repository's own named refusals pass
 * through so the served surface can name exactly what happened; an invalid
 * content shape is a plain request error, lease and storage failures keep the
 * binding mutations' fail-closed shape, and anything else is a reconciliation
 * conflict rather than a silent success.
 */
function rethrowLibraryError(error: unknown): Error {
  if (!(error instanceof Error)) return unavailable();
  if (isLeaseUnavailable(error)) return error;
  if (error.message === "invalid_world_info_request") return new Error("invalid_request");
  if (
    error.message === "world_info_in_use" ||
    error.message === "world_info_not_found" ||
    error.message === "world_info_already_exists" ||
    error.message === "world_info_revision_conflict"
  )
    return error;
  if (isStorageError(error)) return storageUnavailable();
  if (/lease|mount|closed/i.test(error.message)) return unavailable();
  return conflict();
}

/** The managed variant is the only binding variant that resolves against the managed library. */
function bindsManagedTitle(binding: TavernStableManagedWorldInfoBinding | undefined, publicTitle: string): boolean {
  return binding !== undefined && binding.publicTitle === publicTitle;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function assertComposedProfile(profile: ComposedTavernProfile): void {
  // Identity brand from the contract: an Object.freeze structural clone of a
  // composed profile is not a composed capability slice and fails before I/O.
  if (!isComposedTavernProfile(profile)) throw unavailable();
}

function unavailable(): Error {
  return new LeaseUnavailableError();
}
function conflict(): Error {
  return new Error("world_info_binding_conflict");
}
function locked(): Error {
  return new Error("world_info_binding_locked");
}
function storageUnavailable(): Error {
  return new Error("world_info_binding_storage_unavailable");
}

/**
 * Fail-closed sentinel for a forged, revoked or torn-down mounted runtime
 * lease. It is typed so that lease authority failures are never swallowed by
 * the broad catalog catches: only a genuine catalog operational failure may
 * demote a projection to "unavailable" or an item to selected=false.
 */
class LeaseUnavailableError extends Error {
  override readonly name = "LeaseUnavailableError";
  constructor() {
    super("world_info_binding_service_unavailable");
  }
}
function isLeaseUnavailable(error: unknown): error is LeaseUnavailableError {
  return error instanceof LeaseUnavailableError;
}
