import { createHash } from "node:crypto";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { identityProfileMetadata, readOrCreateIdentityProfile, DEFAULT_IDENTITY_PROFILE } from "../identity-profile.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import { TavernArtifactStore } from "./artifact-store.js";
import {
  resolveCompanionOwnOpening,
  resolveCompanionOwnScenario,
  resolveCompanionOwnWorldBookBinding,
  resolvePlayerOwnPersona,
} from "./library-service.js";
import { resolveTavernPaths } from "./tavern-paths.js";
import {
  type ChatThreadState,
  type CreateChatThreadRequest,
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
  createExplicit(request: InitialChatCreateRequest): Promise<TavernExactContentReceipt>;
}>;

/**
 * A create request whose `opening` may be left to the port.
 *
 * The companion's opening is a fact about the companion - the default variant of
 * the greeting set its reviewed card was provisioned with - not about whichever
 * caller happens to create the thread: both the initial-chat saga and the
 * player-created-Chat settlement go through this port, and both used to hardcode
 * `opening: "blank"`. A caller that genuinely means an empty opening still says
 * `"blank"`; a caller with nothing to say about the opening says nothing.
 */
export type InitialChatCreateRequest = Omit<CreateChatThreadRequest, "opening"> &
  Readonly<{ opening?: CreateChatThreadRequest["opening"] }>;

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
  const runtimePaths = resolveRuntimePaths(manifest.principal, manifest.runtimeRoot);
  const tavernPaths = resolveTavernPaths(runtimePaths, manifest.principal);
  const artifacts = new TavernArtifactStore(runtimePaths.root);
  const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
  const profileMetadataReader: IdentityProfileMetadataReader = Object.freeze({
    async readExact() {
      const profile = await readOrCreateIdentityProfile(
        resolveRuntimePaths(manifest.principal, manifest.runtimeRoot).identityProfilePath,
        DEFAULT_IDENTITY_PROFILE,
      );
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
      createExplicit: async (request: InitialChatCreateRequest) => {
        // The companion's own authored context is resolved by the ONE authority
        // (`library-service.ts`), the same one the management surface's New Chat
        // reaches: this port used to bind only the book and the opening, so the card's
        // scenario reached no Chat at all, and the management surface's own Chat lost
        // the book as well.
        const profile = await profileMetadataReader.readExact();
        const scenario =
          request.scenarioId === undefined
            ? await resolveCompanionOwnScenario(artifacts, tavernPaths.companionRoot)
            : undefined;
        // The player's own persona is the fourth authored class this Chat carries. It is
        // resolved on the SAME seam the scenario and the book are, so the first Chat of a
        // continuity is not the one Chat that never learned how she knows the player.
        const persona =
          request.personaId === undefined
            ? await resolvePlayerOwnPersona(artifacts, tavernPaths.playerRoot)
            : undefined;
        const companionWorldBookBinding =
          request.companionWorldBookBinding ?? (await resolveCompanionOwnWorldBookBinding(runtimePaths.runtimeCwd));
        const opening =
          request.opening ??
          (await resolveCompanionOwnOpening(
            artifacts,
            tavernPaths.companionRoot,
            profile.revision,
            scenario?.artifact,
          ));
        return inner.createExplicit({
          ...request,
          ...(scenario === undefined ? {} : { scenarioId: scenario.artifact.scenarioId }),
          ...(persona === undefined ? {} : { personaId: persona.artifact.personaId }),
          ...(scenario === undefined && persona === undefined
            ? {}
            : {
                stableArtifactBindings: Object.freeze([
                  ...(request.stableArtifactBindings ?? []),
                  ...(scenario === undefined ? [] : [scenario.binding]),
                  ...(persona === undefined ? [] : [persona.binding]),
                ]),
              }),
          ...(companionWorldBookBinding === undefined ? {} : { companionWorldBookBinding }),
          opening: opening ?? "blank",
        });
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
      // This port is pinned to one already-resolved request: it has no runtime
      // root, reviewed card or greeting record of its own, so an omitted opening
      // can only mean the genuinely empty one. `createManifestDerivedInitialChatExactContentPort`
      // is the port that can resolve the companion's own opening, and it does so
      // before delegating here.
      const exact: CreateChatThreadRequest = { ...request, opening: request.opening ?? "blank" };
      validateExplicitRequest(exact);
      const binding = exactBindingFromRequest(exact);
      try {
        return receiptFromState(await capability.createExplicit(exact), binding);
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
