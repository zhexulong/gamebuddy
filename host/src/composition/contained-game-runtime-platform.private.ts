import type { TypedPrivateGameFacts } from "../containment/runtime/contract/game-runtime.js";
import type { ContainedGameRuntimePlatform } from "../containment/runtime/core/contained-game-runtime.js";
import type { DesktopGuardianSession } from "../containment/auth/desktop-guardian-session.internal.js";
import {
  modelStardewNativeRoleLaunchPlan,
  encodeStardewNativeRoleLaunchPlan,
  type StardewNativeRoleLaunchPlanInput,
} from "./stardew-native-role-launch-plan.private.js";

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