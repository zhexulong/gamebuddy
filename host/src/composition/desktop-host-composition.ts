import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DesktopGuardianSession } from "../containment/auth/desktop-guardian-session.internal.js";
import {
  createChatSemanticFacadeFromSharedAuthority,
  type ConstructedUnmountedChatSemanticFacade,
} from "../continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.js";
import { createSharedSemanticProductionAuthorityFromDeploymentManifest } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { GameLifecycleProviderCapability } from "../integration-catalog.js";
import { PRODUCT_INTEGRATION_CATALOG } from "../integration-catalog-product.js";
import { createChatEventStream } from "../tavern/chat-event-stream.js";
import type { VoiceSurfaceReader } from "../tavern/reference-pipeline-state.js";
import {
  startChatOnlyPresentationAdmission,
  startDesktopPresentationAdmission,
  startTavernManagementPresentationAdmission,
  type DesktopPresentationAdmission,
} from "./desktop-presentation-admission-owner.js";
import type { ChatVoiceSpeechPublisher } from "../voice.js";

/**
 * Narrow lifecycle contract shared by composition-owned children. The child
 * object itself never crosses the composition facade; only its close outcome
 * is observed by the owner.
 */
export type HostChildLifecycle = Readonly<{
  close(): Promise<void>;
}>;

export type HostChildLifecycleAggregation = HostChildLifecycle;

/**
 * Aggregates composition children in registration order and closes them in
 * reverse order. The returned promise is stable, so concurrent or repeated
 * close requests invoke every child at most once. All children are attempted
 * after a failure; the first reverse-order failure is propagated unchanged.
 */
export function createHostChildLifecycleAggregation(
  children: readonly HostChildLifecycle[],
): HostChildLifecycleAggregation {
  const uniqueChildren = [...new Set(children)];
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    close: () => closePromise ??= closeChildren(uniqueChildren),
  });
}

async function closeChildren(children: readonly HostChildLifecycle[]): Promise<void> {
  let firstFailure: { readonly error: unknown } | undefined;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    try {
      await children[index]!.close();
    } catch (error) {
      firstFailure ??= { error };
    }
  }
  if (firstFailure !== undefined) throw firstFailure.error;
}

declare const desktopRootLayoutCapabilityBrand: unique symbol;
/** Opaque capability minted only after bootstrap root/layout validation. */
export type DesktopRootLayoutCapability = object & {
  readonly [desktopRootLayoutCapabilityBrand]: true;
};

/**
 * Generic desktop composition surface; game-specific Guardian seams stay closure-private.
 */
export type DesktopPrivateHostComposition = Readonly<{
  close(): Promise<void>;
}>;

/**
 * The composed product surface the Host-owned formal entry seam selects. The
 * chat-only and management variants assemble the Chat surface alone and never
 * construct a Stardew coordinator; the composed-reference-game variant adds
 * the Game child. The default keeps the Game surface for the existing desktop
 * entry, which supplies no explicit selection.
 */
export type DesktopHostSurface = "composed-reference-game" | "chat-only" | "management";

/** Explicit product input supplied by the Host-owned formal entry seam. */
export type DesktopHostAssemblyInput = Readonly<{
  manifest: HostDeploymentManifest;
  gameSessionMode: "fresh" | "known";
  /** Composed surface selection; defaults to the composed reference-game surface. */
  surface?: DesktopHostSurface;
  /**
   * Chat-gate marker nonce digest (never a secret) for the narrative-gate
   * provider-boundary contract; supplied only when the bootstrap caller runs that gate.
   */
  tavernNarrativeGateNonceSha256?: string;
  /**
   * Host-owned one-shot publication of the composed surface launch URL after
   * the presentation admission started. The Desktop launcher consumes it as the
   * gate readiness fact; the URL never enters the composition facade.
   */
  publishLaunchUrl?: (launchUrl: string) => void;
  /**
   * Optional Voice surface reader (from a healthy local Voice client). When
   * supplied, the reference Chat facade projects the additive v1 snapshot
   * `voice` field so the browser mic icon lights up; absent => no mic icon.
   */
  voiceSurface?: VoiceSurfaceReader;
  /**
   * Host-owned streaming speech sink (same Voice client). When supplied, the
   * Chat presentation feeds LLM deltas to the Voice Gateway v2 lane so the
   * companion reads aloud while it generates. Absent => text-only.
   */
  speechSink?: ChatVoiceSpeechPublisher;
}>;

/**
 * Builds the one long-lived Desktop Host product composition. The returned
 * facade deliberately exposes only lifecycle; all semantic, Chat, Stardew, and
 * presentation owners remain in this closure and close before the authenticated
 * Desktop session. Chat and Game are independent composition children sharing
 * one semantic authority; neither surface owns, pauses, or closes the other,
 * and the presentation admission owner serves the composed browser surface
 * over both without becoming a third authority.
 */
export async function createDesktopProductComposition(
  rootLayoutCapability: DesktopRootLayoutCapability,
  session: DesktopGuardianSession,
  input: DesktopHostAssemblyInput,
): Promise<DesktopPrivateHostComposition> {
  let shared: Awaited<ReturnType<typeof createSharedSemanticProductionAuthorityFromDeploymentManifest>> | undefined;
  let chatFacade: ConstructedUnmountedChatSemanticFacade | undefined;
  let chatRuntime: { close(): Promise<void> } | undefined;
  let lifecycleCoordinator: GameLifecycleProviderCapability | undefined;
  let presentationAdmission: DesktopPresentationAdmission | undefined;
  try {
    const mountOptions =
      input.tavernNarrativeGateNonceSha256 === undefined
        ? undefined
        : Object.freeze({ tavernNarrativeGateNonceSha256: input.tavernNarrativeGateNonceSha256 });
    shared = await createSharedSemanticProductionAuthorityFromDeploymentManifest(
      input.manifest,
      input.gameSessionMode,
      ...(mountOptions === undefined ? [] : [mountOptions]),
    );
    // The mounted Chat runtime is a sibling composition child of the Stardew
    // lifecycle owner over the same shared semantic authority. The reference
    // facade entry keeps the lease after the coordinator; here it starts before
    // the coordinator so a coordinator construction failure still drains the
    // Chat child alongside the shared owner.
    const mountedFacade = await createChatSemanticFacadeFromSharedAuthority(shared.chat);
    chatFacade = mountedFacade;
    const mountedLease = await mountedFacade.startMountedChatRuntime();
    chatRuntime = Object.freeze({
      close: async () => {
        // Mirrors the reference entry's Chat lane: the mounted runtime authority
        // closes first, then the facade drains its Chat runtime projection.
        await mountedLease.close();
        await mountedFacade.close();
      },
    });
    // E1: the chat-only and management surfaces are Chat-owned composition
    // variants. They assemble their Chat pipeline / management services over
    // the mounted Chat lane and the shared semantic authority, and never
    // construct the Stardew coordinator, guardian, or folder picker; the
    // composed-reference-game surface below keeps the Game child.
    const surface = input.surface ?? "composed-reference-game";
    if (surface === "chat-only" || surface === "management") {
      const hostArtifactRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      const variantInput = Object.freeze({
        manifest: input.manifest,
        hostArtifactRoot,
        bootstrapToken: randomBytes(32).toString("base64url"),
        eventStream: createChatEventStream(),
        lease: mountedLease,
      });
      presentationAdmission = surface === "chat-only"
        ? await startChatOnlyPresentationAdmission({
          ...variantInput,
          ...(input.voiceSurface === undefined ? {} : { voiceSurface: input.voiceSurface }),
          ...(input.speechSink === undefined ? {} : { speechSink: input.speechSink }),
        })
        : await startTavernManagementPresentationAdmission(variantInput);
      // The composed surface is ready at the Host-owned seam: the launch URL is
      // published exactly once and never projects through the composition facade.
      input.publishLaunchUrl?.(presentationAdmission.launchUrl);
      // Children close in reverse registration order: the presentation
      // admission first, then the Chat runtime, then the shared semantic
      // authority; no Game owner participates in this surface.
      return createDesktopPrivateHostComposition(rootLayoutCapability, session, [
        shared,
        chatRuntime,
        presentationAdmission,
      ]);
    }
    const provider = PRODUCT_INTEGRATION_CATALOG.getProvider("stardew");
    if (provider === undefined) throw new Error("stardew_game_integration_provider_unavailable");
    lifecycleCoordinator = await provider.createLifecycleCoordinator({
      manifest: input.manifest,
      game: shared.game,
      session,
    });
    const presentation = lifecycleCoordinator.presentation;
    if (presentation === undefined) throw new Error("game_integration_presentation_projection_unavailable");
    // The presentation admission child is the last sibling: it serves the
    // composed reference-game surface over the mounted Chat lane and the Game
    // projection, so it must drain before both of them close.
    presentationAdmission = await startDesktopPresentationAdmission({
      ...(input.voiceSurface === undefined ? {} : { voiceSurface: input.voiceSurface }),
      ...(input.speechSink === undefined ? {} : { speechSink: input.speechSink }),
      manifest: input.manifest,
      hostArtifactRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      bootstrapToken: randomBytes(32).toString("base64url"),
      eventStream: createChatEventStream(),
      lease: mountedLease,
      presentation,
    });
    // The composed reference-game surface is ready at the Host-owned seam; the
    // launch URL is published exactly once and never projects through the
    // composition facade.
    input.publishLaunchUrl?.(presentationAdmission.launchUrl);
    // Children close in reverse registration order: the presentation admission
    // first, then the Chat runtime, then the Stardew lifecycle owner, then the
    // shared semantic authority, matching the reference entry's server ->
    // facade -> coordinator -> shared order.
    return createDesktopPrivateHostComposition(rootLayoutCapability, session, [
      shared,
      lifecycleCoordinator,
      chatRuntime,
      presentationAdmission,
    ]);
  } catch (error) {
    try {
      await presentationAdmission?.close();
    } catch {
      // Preserve the product construction failure.
    }
    try {
      if (chatRuntime !== undefined) await chatRuntime.close();
      else await chatFacade?.close();
    } catch {
      // Preserve the product construction failure.
    }
    try {
      await lifecycleCoordinator?.close();
    } catch {
      // Preserve the product construction failure.
    }
    try {
      await shared?.close();
    } catch {
      // Preserve the product construction failure.
    }
    try {
      await session.close();
    } catch {
      // Preserve the product construction failure.
    }
    throw error;
  }
}

/**
 * Retains the verified root/layout capability and authenticated desktop session
 * until the host lifecycle closes. Neither value is exposed to product or
 * browser consumers.
 */
export function createDesktopPrivateHostComposition(
  rootLayoutCapability: DesktopRootLayoutCapability,
  session: DesktopGuardianSession,
  children: readonly HostChildLifecycle[] = [],
): DesktopPrivateHostComposition {
  let retainedRootLayoutCapability: DesktopRootLayoutCapability | undefined = rootLayoutCapability;
  let sessionCloseStarted = false;
  let sessionClosePromise: Promise<void> | undefined;
  let compositionClosePromise: Promise<void> | undefined;
  const childLifecycle = createHostChildLifecycleAggregation(children);
  return Object.freeze({
    close: () => compositionClosePromise ??= closeComposition(),
  });

  async function closeComposition(): Promise<void> {
    let failure: unknown;
    try {
      await childLifecycle.close();
    } catch (error) {
      failure = error;
    }
    try {
      await closeSessionOnce();
    } catch (error) {
      failure ??= error;
    }
    // Keep the capability captured until every child and the authenticated
    // session have fully closed; it is not projected.
    void retainedRootLayoutCapability;
    retainedRootLayoutCapability = undefined;
    if (failure !== undefined) throw failure;
  }

  function closeSessionOnce(): Promise<void> {
    if (!sessionCloseStarted) {
      sessionCloseStarted = true;
      try {
        sessionClosePromise = Promise.resolve(session.close());
      } catch (error) {
        sessionClosePromise = Promise.reject(error);
      }
    }
    return sessionClosePromise!;
  }
}
