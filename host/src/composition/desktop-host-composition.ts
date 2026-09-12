import type { DesktopGuardianSession } from "../containment/auth/desktop-guardian-session.internal.js";
import type { StardewOwnedPlayerHostBootstrap } from "../games/stardew/lifecycle/stardew-private-bootstrap-composer.js";
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

/**
 * Retains the verified root/layout capability and authenticated desktop session
 * until the host lifecycle closes. Neither value is exposed to product or
 * browser consumers.
 */
export function createDesktopPrivateHostComposition(
  rootLayoutCapability: DesktopRootLayoutCapability,
  session: DesktopGuardianSession,
): DesktopPrivateHostComposition {
  let retainedRootLayoutCapability: DesktopRootLayoutCapability | undefined = rootLayoutCapability;
  let sessionCloseStarted = false;
  let sessionClosePromise: Promise<void> | undefined;
  let compositionClosePromise: Promise<void> | undefined;
  // Keep the Stardew adapter in this composition-private closure. The generic
  // facade below intentionally projects lifecycle only; no game-specific
  // factory crosses this boundary.
  const stardewBootstrapGuardianOwnerFactory: StardewBootstrapGuardianOwnerFactory = Object.freeze({
    create: (owner, deadlineUnixMs, operationWaitBudgetMs) =>
      createStardewBootstrapGuardianOwnerFromDesktopSession(owner, session, deadlineUnixMs, operationWaitBudgetMs),
  });
  return Object.freeze({
    close: () => compositionClosePromise ??= (async () => {
      // Keep the capabilities and private adapter captured until the session
      // has fully closed; neither is projected through this facade.
      void retainedRootLayoutCapability;
      void stardewBootstrapGuardianOwnerFactory;
      try {
        await closeSessionOnce();
      } finally {
        retainedRootLayoutCapability = undefined;
      }
    })(),
  });

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
