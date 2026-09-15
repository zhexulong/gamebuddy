import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopGuardianSession } from "../containment/auth/desktop-guardian-session.internal.js";
import { createSharedSemanticProductionAuthorityFromDeploymentManifest } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { StardewOwnedPlayerHostBootstrap } from "../games/stardew/lifecycle/stardew-private-bootstrap-composer.js";
import { createStardewProductionLifecycleCoordinator, type StardewProductionLifecycleCoordinator } from "../stardew-production-lifecycle-coordinator.internal.js";
import { createPublishedWindowsStardewFolderPicker } from "../windows-stardew-folder-picker/index.js";
import { createStardewBootstrapGuardianOwnerBinding } from "../games/stardew/lifecycle/stardew-private-bootstrap-composer.core.js";
import {
  createStardewBootstrapGuardianNativePortsFromDesktopSession,
  createStardewBootstrapGuardianOwner,
  type StardewBootstrapGuardianOwner,
} from "../games/stardew/lifecycle/stardew-bootstrap-guardian.private.js";
type StardewBootstrapGuardianOwnerFactory = Readonly<{
  create(
    owner: StardewOwnedPlayerHostBootstrap,
    deadlineUnixMs: number,
    operationWaitBudgetMs: number,
  ): StardewBootstrapGuardianOwner;
}>;

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

/** Constructs one Guardian owner for the exact lifecycle invocation while retaining session transport privately. */
function createStardewBootstrapGuardianOwnerFromDesktopSession(
  owner: StardewOwnedPlayerHostBootstrap,
  session: DesktopGuardianSession,
  deadlineUnixMs: number,
  operationWaitBudgetMs: number,
): StardewBootstrapGuardianOwner {
  const binding = createStardewBootstrapGuardianOwnerBinding(owner);
  return createStardewBootstrapGuardianOwner(
    binding,
    createStardewBootstrapGuardianNativePortsFromDesktopSession(binding, session, deadlineUnixMs, operationWaitBudgetMs),
  );
}

/** Generic desktop composition surface; game-specific Guardian seams stay closure-private. */
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
 * facade deliberately exposes only lifecycle; all semantic and Stardew owners
 * remain in this closure and close before the authenticated Desktop session.
 */
export async function createDesktopProductComposition(
  rootLayoutCapability: DesktopRootLayoutCapability,
  session: DesktopGuardianSession,
  input: DesktopHostAssemblyInput,
): Promise<DesktopPrivateHostComposition> {
  let shared: Awaited<ReturnType<typeof createSharedSemanticProductionAuthorityFromDeploymentManifest>> | undefined;
  let lifecycleCoordinator: StardewProductionLifecycleCoordinator | undefined;
  try {
    shared = await createSharedSemanticProductionAuthorityFromDeploymentManifest(input.manifest, input.gameSessionMode);
    const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const folderPicker = await createPublishedWindowsStardewFolderPicker(artifactRoot);
    lifecycleCoordinator = createStardewProductionLifecycleCoordinator(input.manifest, folderPicker, shared.game);
    return createDesktopPrivateHostComposition(rootLayoutCapability, session, [shared, lifecycleCoordinator]);
  } catch (error) {
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
  // Keep the Stardew adapter in this composition-private closure. The generic
  // facade below intentionally projects lifecycle only; no game-specific
  // factory crosses this boundary.
  const stardewBootstrapGuardianOwnerFactory: StardewBootstrapGuardianOwnerFactory = Object.freeze({
    create: (owner, deadlineUnixMs, operationWaitBudgetMs) =>
      createStardewBootstrapGuardianOwnerFromDesktopSession(owner, session, deadlineUnixMs, operationWaitBudgetMs),
  });
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
    // Keep the capabilities and private adapter captured until every child and
    // the authenticated session have fully closed; neither is projected.
    retainedRootLayoutCapability = undefined;
    void stardewBootstrapGuardianOwnerFactory;
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
