/**
 * Stardew Guardian platform adapter (composition-owned).
 *
 * ADR-0007 Shape B: the game-facing contract exposes only a typed game-facts
 * producer and must never expose `Uint8Array` or any other platform-frame
 * representation. Host composition privately binds the selected game producer
 * to the platform encoder and the authenticated session. This module is that
 * binding for the Stardew game adapter, which is why it lives under
 * `host/src/composition` and not under `games/stardew`.
 *
 * Nothing here is generic: the plan schema, the executable/environment rules
 * and the frame bytes mirror exactly what the native Guardian
 * `GuardianPrivateLaunchIngress` parses, and the platform transport is the
 * authenticated `DesktopGuardianSession`.
 */
import { randomUUID } from "node:crypto";

import type { DesktopGuardianSession } from "../../containment/auth/desktop-guardian-session.internal.js";
import type { ContainedGameRuntimePlatform } from "../../containment/runtime/core/contained-game-runtime.js";
import type { TypedPrivateGameFacts } from "../../containment/runtime/contract/game-runtime.js";
import {
  consumeStardewBootstrapGuardianOwnerBinding,
  createStardewBootstrapGuardianOwnerBinding,
  settleOwnedPlayerHostContainedRuntimeAttempt,
  type StardewPlayerHostRuntimeLaunchCollaborator,
} from "../../games/stardew/lifecycle/stardew-private-bootstrap-composer.core.js";
import type { StardewOwnedPlayerHostBootstrap } from "../../games/stardew/lifecycle/stardew-private-bootstrap-composer.js";
import { STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS } from "./stardew-native-role-launch-plan.private.js";
import { createContainedGameRuntime } from "../../containment/runtime/core/contained-game-runtime.js";

/**
 * One bounded arm/contain wait budget for the Desktop product composition.
 * This transport/operation horizon is deliberately separate from the
 * lifecycle-created RoleLaunchOperation deadline (the launch decision owns
 * that; the deadline is never derived from a bootstrap/browser/owner timeout).
 */
export const DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS = 60_000;

type NativeRole = "player_host" | "ai_client";

const STARDEW_NATIVE_ENVIRONMENT_ALLOWLIST = new Set<string>(STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS);
const PLAN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type NativeRoleLaunchPlan = Readonly<{
  readonly guardianInstanceId: string;
  readonly guardianEpoch: number;
  readonly attemptId: string;
  readonly planId: string;
  readonly role: NativeRole;
  readonly deadlineUnixMs: number;
  readonly executable: string;
  readonly cwd: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}>;

type NativeRoleLaunchPlanInput = Readonly<{
  readonly guardianInstanceId: string;
  readonly guardianEpoch: number;
  readonly attemptId: string;
  readonly role: NativeRole;
  readonly deadlineUnixMs: number;
  readonly executable: string;
  readonly cwd: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}>;

/** Fully qualified Windows drive path exactly as `Path.IsPathFullyQualified` plus size/NUL constraints. */
export function isFullyQualifiedWindowsPath(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 32_767 || value.includes("\0")) return false;
  return /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Validates and freezes one exact native role launch plan. Every rule mirrors
 * `GuardianPrivateLaunchIngress.ParseLaunch`; any violation means the frame
 * would be rejected by the native Guardian, so the plan fails closed here.
 */
function modelNativeRoleLaunchPlan(input: NativeRoleLaunchPlanInput): NativeRoleLaunchPlan {
  if (typeof input.guardianInstanceId !== "string" || input.guardianInstanceId.length === 0 || input.guardianInstanceId.length > 1024) throw new Error("stardew_native_launch_plan_guardian_instance_invalid");
  if (!Number.isSafeInteger(input.guardianEpoch) || input.guardianEpoch < 1) throw new Error("stardew_native_launch_plan_guardian_epoch_invalid");
  if (typeof input.attemptId !== "string" || input.attemptId.length === 0 || input.attemptId.length > 1024) throw new Error("stardew_native_launch_plan_attempt_invalid");
  if (!Number.isSafeInteger(input.deadlineUnixMs) || input.deadlineUnixMs <= Date.now() || input.deadlineUnixMs - Date.now() > 2_147_483_647) throw new Error("stardew_native_launch_plan_deadline_invalid");
  if (input.role !== "player_host" && input.role !== "ai_client") throw new Error("stardew_native_launch_plan_role_invalid");
  if (!isFullyQualifiedWindowsPath(input.executable)) throw new Error("stardew_native_launch_plan_executable_invalid");
  if (!isFullyQualifiedWindowsPath(input.cwd)) throw new Error("stardew_native_launch_plan_cwd_invalid");
  const args = Array.isArray(input.arguments) ? input.arguments : [...input.arguments];
  if (args.length > 128 || args.some((argument) => typeof argument !== "string" || argument.length === 0 || argument.length > 4096 || argument.includes("\0"))) throw new Error("stardew_native_launch_plan_arguments_invalid");
  if (typeof input.environment !== "object" || input.environment === null || Array.isArray(input.environment)) throw new Error("stardew_native_launch_plan_environment_invalid");
  const environment: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(input.environment)) {
    if (!STARDEW_NATIVE_ENVIRONMENT_ALLOWLIST.has(name)) throw new Error("stardew_native_launch_plan_environment_key_disallowed");
    if (seen.has(name.toLowerCase())) throw new Error("stardew_native_launch_plan_environment_duplicate");
    seen.add(name.toLowerCase());
    if (typeof value !== "string" || value.includes("\0")) throw new Error("stardew_native_launch_plan_environment_value_invalid");
    environment[name] = value;
  }
  for (const key of STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS) {
    if (!Object.hasOwn(environment, key)) throw new Error("stardew_native_launch_plan_environment_required_missing");
  }
  const planId = randomUUID();
  if (!(typeof planId === "string" && planId.length === 36 && PLAN_ID_PATTERN.test(planId))) throw new Error("stardew_native_launch_plan_id_invalid");
  return Object.freeze({
    guardianInstanceId: input.guardianInstanceId,
    guardianEpoch: input.guardianEpoch,
    attemptId: input.attemptId,
    planId,
    role: input.role,
    deadlineUnixMs: input.deadlineUnixMs,
    executable: input.executable,
    cwd: input.cwd,
    arguments: Object.freeze([...args]),
    environment: Object.freeze({ ...environment }),
  });
}

/** Encodes one modeled native plan as the exact Guardian JSON frame bytes. */
function encodeNativeRoleLaunchPlan(plan: NativeRoleLaunchPlan): Uint8Array {
  const encoded = JSON.stringify({
    guardianInstanceId: plan.guardianInstanceId,
    guardianEpoch: plan.guardianEpoch,
    attemptId: plan.attemptId,
    planId: plan.planId,
    role: plan.role,
    deadlineUnixMs: plan.deadlineUnixMs,
    executable: plan.executable,
    cwd: plan.cwd,
    arguments: plan.arguments,
    environment: plan.environment,
  });
  if (encoded === undefined) throw new Error("stardew_native_launch_plan_encoding_failed");
  return new TextEncoder().encode(encoded);
}

/**
 * Builds the composition-owned contained launch seam for both roles. The
 * runtime binding uses the Stardew owner's Guardian correlation
 * (guardianInstanceId/guardianEpoch/attemptId) plus the composition's fixed
 * arm/contain operation wait budget; the launch deadline arrives per
 * invocation from the lifecycle's RoleLaunchOperation and is never owned
 * here. One `ContainedGameRuntime` is bound per owner and retained: the
 * Player Host and AI-client roles share the exact arm/launch/contain/close
 * sequence on that runtime, so no owner ever reuses another owner's state
 * and the platform session closes exactly once.
 */
export function createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
  platform: ContainedGameRuntimePlatform,
): StardewPlayerHostRuntimeLaunchCollaborator {
  // The Guardian owner binding is one-shot per owner; the contained runtime
  // for that owner is therefore bound once and retained here. A launch retry
  // after a pre-claim failure reuses the exact bound runtime, while a post-
  // claim failure is terminal in the coordinator and never calls back here.
  const runtimesByOwner = new WeakMap<StardewOwnedPlayerHostBootstrap, ReturnType<typeof createContainedGameRuntime>>();
  // Roles this attempt actually launched. Settlement must catch the durable
  // record up from `armed` through exactly these roles, never an invented one.
  const launchedRolesByOwner = new WeakMap<StardewOwnedPlayerHostBootstrap, Set<"playerHost" | "aiClient">>();
  const launchedRolesFor = (owner: StardewOwnedPlayerHostBootstrap): Set<"playerHost" | "aiClient"> => {
    let roles = launchedRolesByOwner.get(owner);
    if (roles === undefined) {
      roles = new Set<"playerHost" | "aiClient">();
      launchedRolesByOwner.set(owner, roles);
    }
    return roles;
  };
  const runtimeFor = (owner: StardewOwnedPlayerHostBootstrap) => {
    let runtime = runtimesByOwner.get(owner);
    if (runtime === undefined) {
      const binding = createStardewBootstrapGuardianOwnerBinding(owner);
      // Consume the binding here so this composition seam — the only layer that
      // holds the exact owner — owns both the native correlation and the durable
      // owner-record transitions. The retired game-layer Guardian owner seam did
      // the same work from the wrong layer and had no production consumer.
      const arm = consumeStardewBootstrapGuardianOwnerBinding(binding).armFrame;
      runtime = createContainedGameRuntime(platform, Object.freeze({
        guardianInstanceId: arm.guardianInstanceId,
        guardianEpoch: arm.guardianEpoch,
        attemptId: arm.attemptId,
        operationWaitBudgetMs: DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS,
      }));
      runtimesByOwner.set(owner, runtime);
    }
    return runtime;
  };
  const requireRuntime = (owner: StardewOwnedPlayerHostBootstrap) => {
    const runtime = runtimesByOwner.get(owner);
    if (runtime === undefined) throw new Error("stardew_contained_runtime_for_owner_missing");
    return runtime;
  };
  return Object.freeze({
    launchPlayerHost(owner: StardewOwnedPlayerHostBootstrap, operation, launch) {
      return runtimeFor(owner).launchRole("player_host", operation, launch.provideAuthorization).then((result) => {
        if (result.status === "succeeded") launchedRolesFor(owner).add("playerHost");
        return result;
      });
    },
    launchAiClient(owner: StardewOwnedPlayerHostBootstrap, operation, launch) {
      return runtimeFor(owner).launchRole("ai_client", operation, launch.provideAuthorization).then((result) => {
        if (result.status === "succeeded") launchedRolesFor(owner).add("aiClient");
        return result;
      });
    },
    containPlayerHost(owner: StardewOwnedPlayerHostBootstrap) {
      return requireRuntime(owner).containRole("player_host");
    },
    containAiClient(owner: StardewOwnedPlayerHostBootstrap) {
      return requireRuntime(owner).containRole("ai_client");
    },
    /**
     * Protected terminal settlement for the exact owner. The platform session is
     * released exactly once, then the durable Stardew owner attempt is advanced
     * to `contained` and the matching Guardian settlement proof releases the
     * bound registration pointer. Only the coordinator's explicit endgame
     * reaches this; ordinary close, AI crash and controller EOF never do.
     */
    async settle(owner: StardewOwnedPlayerHostBootstrap) {
      const settled = await requireRuntime(owner).settle();
      if (settled.status !== "settled") throw new Error("stardew_contained_runtime_settlement_unavailable");
      await settleOwnedPlayerHostContainedRuntimeAttempt(owner, [...launchedRolesFor(owner)]);
    },
    close(owner: StardewOwnedPlayerHostBootstrap) {
      return requireRuntime(owner).close();
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
  // The platform session terminates exactly once. Settlement is the deliberate
  // terminal operation and the coordinator's ordinary close may still run
  // afterwards on the same attempt, so both go through this single latch rather
  // than racing two `close()` calls onto one authenticated session.
  //
  // The latch is set only AFTER the close succeeds: `session.close()` can reject,
  // and the coordinator retries close (`close()` clears `closePromise` when the
  // attempt rejected and the lifecycle is not yet `closed`). Latching before the
  // await would make that retry report success while the authenticated Guardian
  // session was still open, which the survival task forbids.
  let sessionClosed = false;
  let closeInFlight: Promise<void> | undefined;
  const closeSessionOnce = async (): Promise<void> => {
    if (sessionClosed) return;
    // A close already in flight is joined rather than duplicated, so concurrent
    // callers cannot race two closes onto one session.
    if (closeInFlight !== undefined) return await closeInFlight;
    closeInFlight = (async () => {
      await session.close();
      sessionClosed = true;
    })();
    try {
      await closeInFlight;
    } finally {
      // A rejected close stays retryable; a resolved one is latched above.
      if (!sessionClosed) closeInFlight = undefined;
    }
  };
  const encodeArmAuthorization = (facts: TypedPrivateGameFacts): Uint8Array => {
    // The attested installation executable is fixed at arm time and is later
    // enforced by the native Guardian's ParseLaunch. The Host wire mirrors the
    // native ParseArm/ParseLaunch executable constraints here (existence,
    // NUL, fully-qualified drive path, size bound) and fails closed before the
    // authenticated session sees a frame the native Guardian would reject;
    // the ordinal-ignore-case equality gate itself remains native-only.
    const approvedExecutable = facts.executable;
    if (typeof approvedExecutable !== "string" || !isFullyQualifiedWindowsPath(approvedExecutable)) throw new Error("contained game runtime: arm authorization missing approved executable");
    const encoded = JSON.stringify({ ...facts, approvedExecutable });
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
  ): NativeRoleLaunchPlanInput => {
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
      const plan = modelNativeRoleLaunchPlan(planInput);
      const privateFrame = encodeNativeRoleLaunchPlan(plan);
      await session.launch({ guardianInstanceId, guardianEpoch, attemptId, deadlineUnixMs, role, privateFrame });
    },
    async contain(input) {
      await session.contain(input);
    },
    /**
     * Terminal settlement. The durable Stardew meaning of a settlement (owner
     * record advancement, Guardian proof, registration pointer release) is
     * composition-owned and runs in the launch collaborator, which is the only
     * layer that holds the exact owner. Here the platform only performs its own
     * terminal transport step: releasing the authenticated session exactly once.
     */
    async settle() {
      await closeSessionOnce();
    },
    async close() {
      await closeSessionOnce();
    },
  });
}
