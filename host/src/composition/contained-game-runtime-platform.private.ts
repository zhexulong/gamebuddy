import type { TypedPrivateGameFacts } from "../containment/runtime/contract/game-runtime.js";
import type { ContainedGameRuntimePlatform } from "../containment/runtime/core/contained-game-runtime.js";
import { createContainedGameRuntime } from "../containment/runtime/core/contained-game-runtime.js";
import type { DesktopGuardianSession } from "../containment/auth/desktop-guardian-session.internal.js";
import type { StardewOwnedPlayerHostBootstrap } from "../games/stardew/lifecycle/stardew-private-bootstrap-composer.js";
import {
  createStardewBootstrapGuardianOwnerBinding,
  readStardewBootstrapGuardianNativeArmFrame,
  type StardewPlayerHostRuntimeLaunchCollaborator,
} from "../games/stardew/lifecycle/stardew-private-bootstrap-composer.core.js";
import {
  modelStardewNativeRoleLaunchPlan,
  encodeStardewNativeRoleLaunchPlan,
  type StardewNativeRoleLaunchPlanInput,
} from "./stardew-native-role-launch-plan.private.js";

/**
 * One bounded arm/contain wait budget for the Desktop product composition.
 * This transport/operation horizon is deliberately separate from the
 * lifecycle-created RoleLaunchOperation deadline (the launch decision owns
 * that; the deadline is never derived from a bootstrap/browser/owner timeout).
 */
export const DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS = 60_000;

/**
 * Builds the composition-owned contained Player Host launch seam. The runtime
 * binding uses the Stardew owner's Guardian correlation
 * (guardianInstanceId/guardianEpoch/attemptId) plus the composition's fixed
 * arm/contain operation wait budget; the launch deadline arrives per
 * invocation from the lifecycle's RoleLaunchOperation and is never owned
 * here. Each call constructs a fresh `ContainedGameRuntime` over the closure
 * platform so one owner never reuses another owner's arm/launch state.
 */
export function createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
  platform: ContainedGameRuntimePlatform,
): StardewPlayerHostRuntimeLaunchCollaborator {
  // The Guardian owner binding is one-shot per owner; the contained runtime
  // for that owner is therefore bound once and retained here. A launch retry
  // after a pre-claim failure reuses the exact bound runtime, while a post-
  // claim failure is terminal in the coordinator and never calls back here.
  const runtimesByOwner = new WeakMap<StardewOwnedPlayerHostBootstrap, ReturnType<typeof createContainedGameRuntime>>();
  return Object.freeze({
    launchPlayerHost(owner: StardewOwnedPlayerHostBootstrap, operation, launch) {
      let runtime = runtimesByOwner.get(owner);
      if (runtime === undefined) {
        const binding = createStardewBootstrapGuardianOwnerBinding(owner);
        const arm = readStardewBootstrapGuardianNativeArmFrame(binding);
        runtime = createContainedGameRuntime(platform, Object.freeze({
          guardianInstanceId: arm.guardianInstanceId,
          guardianEpoch: arm.guardianEpoch,
          attemptId: arm.attemptId,
          operationWaitBudgetMs: DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS,
        }));
        runtimesByOwner.set(owner, runtime);
      }
      return runtime.launchRole("player_host", operation, launch.provideAuthorization);
    },
  });
}

/**
 * Composition-private bridge from typed game facts to the authenticated
 * platform session. Native frame bytes are created and consumed only here;
 * the generic runtime core never sees this transport representation.
 *
 * Arm frames use simple JSON encoding for the arm schema; launch frames use
 * the native Stardew role-launch-plan encoder ("ParseLaunch" schema) so the
 * native Guardian receives the exact 10-key plan it expects.
 */
export function createDesktopGuardianGameRuntimePlatform(
  session: DesktopGuardianSession,
): ContainedGameRuntimePlatform {
  const encodeArmAuthorization = (facts: TypedPrivateGameFacts): Uint8Array => {
    const encoded = JSON.stringify(facts);
    if (encoded === undefined) throw new Error("contained game runtime: authorization encoding failed");
    return new TextEncoder().encode(encoded);
  };

  const makeLaunchPlanInput = (
    facts: TypedPrivateGameFacts,
    guardianInstanceId: string,
    guardianEpoch: number,
    attemptId: string,
    deadlineUnixMs: number,
    role: string,
  ): StardewNativeRoleLaunchPlanInput => {
    if (typeof facts.executable !== "string") throw new Error("contained game runtime: launch authorization missing executable");
    if (typeof facts.cwd !== "string") throw new Error("contained game runtime: launch authorization missing cwd");
    if (!Array.isArray(facts.arguments) || !facts.arguments.every((a) => typeof a === "string")) throw new Error("contained game runtime: launch authorization invalid arguments");
    if (typeof facts.environment !== "object" || facts.environment === null || Array.isArray(facts.environment)) throw new Error("contained game runtime: launch authorization invalid environment");
    if (role !== "player_host" && role !== "ai_client") throw new Error("contained game runtime: launch authorization invalid role");
    return Object.freeze({
      guardianInstanceId,
      guardianEpoch,
      attemptId,
      role,
      deadlineUnixMs,
      executable: facts.executable as string,
      cwd: facts.cwd as string,
      arguments: facts.arguments as readonly string[],
      environment: facts.environment as Readonly<Record<string, string>>,
    });
  };

  return Object.freeze({
    async arm(input) {
      const { authorization, ...transportInput } = input;
      await session.arm({ ...transportInput, privateFrame: encodeArmAuthorization(authorization) });
    },
    async launch(input) {
      const { authorization, guardianInstanceId, guardianEpoch, attemptId, deadlineUnixMs, role } = input;
      const planInput = makeLaunchPlanInput(authorization, guardianInstanceId, guardianEpoch, attemptId, deadlineUnixMs, role);
      const plan = modelStardewNativeRoleLaunchPlan(planInput);
      const privateFrame = encodeStardewNativeRoleLaunchPlan(plan);
      await session.launch({ guardianInstanceId, guardianEpoch, attemptId, deadlineUnixMs, role, privateFrame });
    },
    async contain(input) {
      await session.contain(input);
    },
    async close() {
      await session.close();
    },
  });
}