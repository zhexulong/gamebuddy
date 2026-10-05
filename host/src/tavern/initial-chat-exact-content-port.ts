import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { identityProfileMetadata, readOrCreateIdentityProfile } from "../identity-profile.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import { readWorldBook, worldBookMetadata } from "../worldbook.js";
import {
  type ChatThreadState,
  type CreateChatThreadRequest,
  type TavernStableWorldBookBinding,
  classifyInitialChatExactContentFailure,
  createChatThreadStore,
  createInitialChatExactContentCapability,
  type IdentityProfileMetadataReader,
  type InitialChatExactContentCapability,
  isInitialChatExactContentCapability,
} from "./chat-thread-store.js";

/** The exact four-way Tavern content binding required by the initial-Chat saga. */
export type InitialChatExactContentBinding = Readonly<{
  chatThreadId: string;
  companionId: string;
  continuityId: string;
  chatSurfaceSessionId: string;
}>;

/** Opaque, module-branded evidence of a genuine durable exact content readback. */
export type TavernExactContentReceipt = Readonly<InitialChatExactContentBinding & { digest: string }>;

export type TavernInitialChatExactContentPortErrorCode =
  | "chat_thread_not_found"
  | "chat_thread_already_exists"
  | "chat_thread_binding_mismatch"
  | "invalid_create_chat_thread_request";

export class TavernInitialChatExactContentPortError extends Error {
  readonly code: TavernInitialChatExactContentPortErrorCode;
  constructor(code: TavernInitialChatExactContentPortErrorCode) {
    super(code);
    this.name = "TavernInitialChatExactContentPortError";
    this.code = code;
  }
}

/** Unmounted content facade. It has no selector, lifecycle, or semantic authority operations. */
export type InitialChatExactContentPort = Readonly<{
  /** Opens only an existing exact durable binding; missing content fails closed. */
  resumeExact(
    chatThreadId: string,
    companionId: string,
    continuityId: string,
    chatSurfaceSessionId: string,
  ): Promise<TavernExactContentReceipt>;
  /** Explicit initial-thread creation, distinct from exact resume. */
  createExplicit(request: CreateChatThreadRequest): Promise<TavernExactContentReceipt>;
}>;

/**
 * A manifest-derived port plus the release for the store the factory opened.
 *
 * The port itself never carries a lifecycle operation (its surface is pinned to
 * exact resume plus explicit creation), so the release travels beside it. The
 * caller that keeps the port must call `close()`; an unclosed store keeps its
 * SQLite handle and holds the continuity root against removal on Windows.
 */
export type ManifestDerivedInitialChatExactContent = Readonly<{
  port: InitialChatExactContentPort;
  close(): void;
}>;

const trustedReceipts = new WeakSet<object>();

/**
 * The companion's own reviewed world book, for a thread creation that names none.
 *
 * The reviewed ST-card import writes `<runtimeCwd>/worldbook.json`, and the Game
 * surface compiles that file into its Tier 2 m[0] unconditionally. The Chat
 * surface materializes only what the thread binds, so a companion provisioned
 * from a card carried its backdrop in Game and silently lost it in Chat.
 *
 * The binding is PERSISTED on the thread rather than injected when the catalog is
 * materialized: acceptance re-materializes against the stored thread and refuses
 * a world-info source whose thread carries no binding
 * (`tavern_stable_context_worldbook_binding_mismatch`), so a transient override
 * makes the two disagree and every turn fail closed. Defaulting it here keeps the
 * stored thread, the materialized catalog and the acceptance check in agreement.
 *
 * A missing book is ordinary - a companion need not have one - and yields nothing
 * to bind. A present but unreadable book fails closed rather than silently
 * emptying the backdrop.
 */
async function companionOwnWorldBookBinding(
  manifest: HostDeploymentManifest,
): Promise<TavernStableWorldBookBinding | undefined> {
  const worldBookPath = join(
    resolveRuntimePaths(manifest.principal, manifest.runtimeRoot).runtimeCwd,
    "worldbook.json",
  );
  if (!existsSync(worldBookPath)) return undefined;
  const book = await readWorldBook(worldBookPath);
  const metadata = worldBookMetadata(book);
  return Object.freeze({
    worldBookId: metadata.worldBookId,
    revision: metadata.revision,
    canonicalHash: metadata.canonicalHash,
    provenance: "reviewed-import" as const,
  });
}

/** Matching data, cloning, serialization, and proxies never become trusted receipts. */
export function isTrustedTavernExactContentReceipt(value: unknown): value is TavernExactContentReceipt {
  return !!value && typeof value === "object" && trustedReceipts.has(value);
}

/** Accepts only an identity-branded capability minted by ChatThreadStore. */
/**
 * Constructs the unmounted Tavern content port from the canonical deployment
 * manifest. Runtime callers cannot choose a different root or continuity key.
 */
export function createManifestDerivedInitialChatExactContentPort(
  manifest: HostDeploymentManifest,
): ManifestDerivedInitialChatExactContent {
  const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
  const profileMetadataReader: IdentityProfileMetadataReader = Object.freeze({
    async readExact() {
      const profile = await readOrCreateIdentityProfile(resolveRuntimePaths(manifest.principal, manifest.runtimeRoot).identityProfilePath);
      return identityProfileMetadata(profile);
    },
  });
  let closed = false;
  const inner = createInitialChatExactContentPort(
    createInitialChatExactContentCapability(store, profileMetadataReader),
  );
  return Object.freeze({
    port: Object.freeze({
      resumeExact: inner.resumeExact,
      createExplicit: async (request: CreateChatThreadRequest) => {
        if (request.worldBookBinding !== undefined) return inner.createExplicit(request);
        const binding = await companionOwnWorldBookBinding(manifest);
        return inner.createExplicit(binding === undefined ? request : { ...request, worldBookBinding: binding });
      },
    }),
    close: () => {
      if (closed) return;
      closed = true;
      store.close?.();
    },
  });
}

export function createInitialChatExactContentPort(
  capability: InitialChatExactContentCapability,
): InitialChatExactContentPort {
  if (!isInitialChatExactContentCapability(capability))
    throw new Error("untrusted_initial_chat_exact_content_capability");
  return Object.freeze({
    resumeExact: async (chatThreadId, companionId, continuityId, chatSurfaceSessionId) => {
      const binding = { chatThreadId, companionId, continuityId, chatSurfaceSessionId };
      try {
        return receiptFromState(await capability.resumeExact(chatThreadId, chatSurfaceSessionId), binding);
      } catch (error) {
        throw mapStoreFailure(error);
      }
    },
    createExplicit: async (request) => {
      validateExplicitRequest(request);
      const binding = exactBindingFromRequest(request);
      try {
        return receiptFromState(await capability.createExplicit(request), binding);
      } catch (error) {
        throw mapStoreFailure(error);
      }
    },
  });
}

function mapStoreFailure(error: unknown): unknown {
  const kind = classifyInitialChatExactContentFailure(error);
  if (kind === "not_found") return new TavernInitialChatExactContentPortError("chat_thread_not_found");
  if (kind === "already_exists") return new TavernInitialChatExactContentPortError("chat_thread_already_exists");
  return error;
}

function receiptFromState(state: ChatThreadState, binding: InitialChatExactContentBinding): TavernExactContentReceipt {
  const thread = state.thread;
  if (
    thread.chatThreadId !== binding.chatThreadId ||
    thread.companionId !== binding.companionId ||
    thread.continuityId !== binding.continuityId ||
    thread.chatSurfaceSessionId !== binding.chatSurfaceSessionId
  )
    throw new TavernInitialChatExactContentPortError("chat_thread_binding_mismatch");
  // The receipt is evidence of this complete, validated durable state—not of
  // the caller's binding alone. Keep the binding in the payload so identity
  // remains typed and explicit, while hashing every thread metadata field and
  // the ordered message records (including opening text/source).
  const canonicalState = canonicalJson({
    binding: {
      chatThreadId: thread.chatThreadId,
      companionId: thread.companionId,
      continuityId: thread.continuityId,
      chatSurfaceSessionId: thread.chatSurfaceSessionId,
    },
    state,
  });
  const receipt = Object.freeze({
    chatThreadId: thread.chatThreadId,
    companionId: thread.companionId,
    continuityId: thread.continuityId,
    chatSurfaceSessionId: thread.chatSurfaceSessionId,
    digest: createHash("sha256").update(canonicalState, "utf8").digest("hex"),
  });
  trustedReceipts.add(receipt);
  return receipt;
}

/** Canonical JSON with sorted object keys and preserved array order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function validateExplicitRequest(request: CreateChatThreadRequest): void {
  if (
    !request ||
    typeof request !== "object" ||
    !isExactId(request.chatThreadId) ||
    !isExactId(request.companionId) ||
    !isExactId(request.continuityId) ||
    !isExactId(request.chatSurfaceSessionId) ||
    (request.opening !== "blank" && (!request.opening || typeof request.opening !== "object"))
  )
    throw new TavernInitialChatExactContentPortError("invalid_create_chat_thread_request");
}
function exactBindingFromRequest(request: CreateChatThreadRequest): InitialChatExactContentBinding {
  return Object.freeze({
    chatThreadId: request.chatThreadId,
    companionId: request.companionId,
    continuityId: request.continuityId,
    chatSurfaceSessionId: request.chatSurfaceSessionId,
  });
}
function isExactId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
