import type { DesktopGuardianSession } from "../containment/auth/desktop-guardian-session.internal.js";
import {
  createChatSemanticFacadeFromSharedAuthority,
  type ConstructedUnmountedChatSemanticFacade,
} from "../continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.js";
import { createSharedSemanticProductionAuthorityFromDeploymentManifest } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { PRODUCT_INTEGRATION_CATALOG } from "../integration-catalog-product.js";

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

/** Explicit product input supplied by the Host-owned formal entry seam. */
export type DesktopHostAssemblyInput = Readonly<{
  manifest: HostDeploymentManifest;
  gameSessionMode: "fresh" | "known";
}>;

/**
 * Builds the one long-lived Desktop Host product composition. The returned
 * facade deliberately exposes only lifecycle; all semantic, Chat, and Stardew
 * owners remain in this closure and close before the authenticated Desktop
 * session. Chat and Game are independent composition children sharing one
 * semantic authority; neither surface owns, pauses, or closes the other.
 */
export async function createDesktopProductComposition(
  rootLayoutCapability: DesktopRootLayoutCapability,
  session: DesktopGuardianSession,
  input: DesktopHostAssemblyInput,
): Promise<DesktopPrivateHostComposition> {
  let shared: Awaited<ReturnType<typeof createSharedSemanticProductionAuthorityFromDeploymentManifest>> | undefined;
  let chatFacade: ConstructedUnmountedChatSemanticFacade | undefined;
  let chatRuntime: { close(): Promise<void> } | undefined;
  let lifecycleCoordinator: { close(): Promise<void> } | undefined;
  try {
    shared = await createSharedSemanticProductionAuthorityFromDeploymentManifest(input.manifest, input.gameSessionMode);
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
    const provider = PRODUCT_INTEGRATION_CATALOG.getProvider("stardew");
    if (provider === undefined) throw new Error("stardew_game_integration_provider_unavailable");
    lifecycleCoordinator = await provider.createLifecycleCoordinator({
      manifest: input.manifest,
      game: shared.game,
      session,
    });
    // Children close in reverse registration order: the Chat runtime first,
    // then the Stardew lifecycle owner, then the shared semantic authority,
    // matching the reference entry's facade -> coordinator -> shared order.
    return createDesktopPrivateHostComposition(rootLayoutCapability, session, [shared, lifecycleCoordinator, chatRuntime]);
  } catch (error) {
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
