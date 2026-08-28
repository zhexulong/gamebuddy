import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { assertProfileMatchesBinding, readIdentityProfile, readIdentityProfileBinding } from "../identity-profile.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import { type ChatThreadMessage, type ChatThreadState, createChatThreadStore } from "./chat-thread-store.js";

const MAX_TRANSCRIPT_MESSAGES = 500;
type MountedChatBinding = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  companionId: string;
  continuityId: string;
}>;

/**
 * Browser-only, BrowserMessageV1-compatible projection; it never contains
 * a storage ID. `locale`, `order`, and
 * `revision` are local projection facts, not claims about durable source
 * language or mutable message revisions.
 */
export type BrowserChatMessage = Readonly<{
  handle: string;
  role: "player" | "companion";
  text: string;
  locale: "und";
  order: number;
  revision: number;
}>;

/** Browser-safe exact mounted state. No returned fact attests to mount authority. */
export type MountedChatSnapshot = Readonly<{
  selection: Readonly<{
    chatHandle: string;
    generation: number;
    stateRevision: string;
  }>;
  companionDisplayName: string;
  title: string | null;
  transcript: readonly BrowserChatMessage[];
  draft: Readonly<{ revision: number; text: string | null }>;
}>;

/** Read-only capability: no roots, stores, selector, lease, or mutation authority escapes. */
export type MountedChatReader = Readonly<{
  read(): Promise<MountedChatSnapshot>;
}>;

/**
 * Builds a read facade only from the production coordinator's current mounted
 * lease. The WeakMap-backed guard rejects structural copies before any disk I/O.
 */
export async function createMountedChatReader(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
): Promise<MountedChatReader> {
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  const binding = bindingFrom(manifest, lease);
  const paths = resolveRuntimePaths(manifest.principal, manifest.runtimeRoot, lease.chatSurfaceSessionId);
  const expectedIdentityKey = identityKey(manifest.principal);
  const [profile, profileBinding] = await Promise.all([
    readIdentityProfile(paths.identityProfilePath),
    readIdentityProfileBinding(paths.identityProfileBindingPath),
  ]);
  if (profileBinding === null) throw unavailable();
  try {
    assertProfileMatchesBinding(expectedIdentityKey, profile, profileBinding);
  } catch {
    throw unavailable();
  }

  const threads = createChatThreadStore(manifest.runtimeRoot, expectedIdentityKey);
  const companionDisplayName = profile.identity.name;
  if (companionDisplayName.length === 0) throw unavailable();

  return Object.freeze({
    async read(): Promise<MountedChatSnapshot> {
      if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
      try {
        const state = await threads.resumeThread(binding.chatThreadId, binding.chatSurfaceSessionId);
        validateStateBinding(state, binding);
        // Durable reads do not hold the mount capability. A concurrent close
        // revokes the lease before projection, so never project stale data.
        assertCurrentMountedLeaseAfterDurableRead(lease);
        return project(lease, companionDisplayName, state, state.draft);
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
export function assertCurrentMountedLeaseAfterDurableRead(
  lease: MountedChatRuntimeLease,
  current: (value: unknown) => boolean = isCurrentMountedChatRuntimeLease,
): void {
  if (!current(lease)) throw unavailable();
}

function bindingFrom(manifest: HostDeploymentManifest, lease: MountedChatRuntimeLease): MountedChatBinding {
  if (!identifier(lease.chatThreadId) || !identifier(lease.chatSurfaceSessionId)) throw unavailable();
  return Object.freeze({
    chatThreadId: lease.chatThreadId,
    chatSurfaceSessionId: lease.chatSurfaceSessionId,
    companionId: manifest.principal.companionId,
    continuityId: manifest.principal.continuityId,
  });
}

function validateStateBinding(state: ChatThreadState, binding: MountedChatBinding): void {
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
  state: ChatThreadState,
  draft: Readonly<{ revision: number; text: string | null }>,
): MountedChatSnapshot {
  if (state.messages.length > MAX_TRANSCRIPT_MESSAGES) throw unavailable();
  const transcript = state.messages.map((message, order) => projectMessage(lease, message, order));
  const projection = lease.browserProjection;
  return Object.freeze({
    selection: Object.freeze({
      chatHandle: projection.chatHandle,
      generation: projection.selectionGeneration,
      stateRevision: projection.selectionStateRevision,
    }),
    companionDisplayName,
    title: state.thread.title ?? null,
    transcript: Object.freeze(transcript),
    draft: Object.freeze({ revision: draft.revision, text: draft.text }),
  });
}

function projectMessage(lease: MountedChatRuntimeLease, message: ChatThreadMessage, order: number): BrowserChatMessage {
  if (message.role !== "player" && message.role !== "companion") throw unavailable();
  if (!safeBrowserRevision(order) || !safeBrowserRevision(1)) throw unavailable();
  return Object.freeze({
    handle: lease.browserProjection.projectMessageHandle(message.messageId),
    role: message.role,
    text: message.text,
    // ChatThreadStore persists no language metadata; the projection must not infer one.
    locale: "und",
    // ChatThreadStore transcript order is append-only; the projection exposes its index.
    order,
    // The projection has no edit/swipe/message mutation, so durable records are immutable.
    revision: 1,
  });
}

function safeBrowserRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
function unavailable(): Error {
  return new Error("p3_exact_chat_state_unavailable");
}
