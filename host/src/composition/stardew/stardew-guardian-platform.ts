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
import type {
  RecoverableContainedGameRuntime,
  RecoveryOperation,
  RedactedRecoveryOutcome,
  TypedPrivateGameFact,
  TypedPrivateGameFacts,
} from "../../containment/runtime/contract/game-runtime.js";
import {
  consumeStardewBootstrapGuardianOwnerBinding,
  createStardewBootstrapGuardianOwnerBinding,
  settleOwnedPlayerHostContainedRuntimeAttempt,
  type StardewBootstrapOwnerRecoveryDrive,
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

/** Native `GuardianRecoveryIngress` opaque-correlation shape (GUID "D"). */
const RECOVERY_OPAQUE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Native `GuardianRecoveryIngress` lease/Job name shape (`Local\` + opaque leaf). */
const RECOVERY_GUARDIAN_NAME = /^Local\\[A-Za-z0-9_-]{1,128}$/;
/** Native `GuardianRecoveryIngress` role-state vocabulary. */
const RECOVERY_ROLE_STATES = new Set(["reserved", "armed", "active", "closing", "contained"]);

/**
 * Reads one typed recovery fact. The recovery bodies are exact key sets rather
 * than arbitrary bags, so a missing fact fails closed here instead of reaching
 * the authenticated session as a frame the native parser would reject.
 */
function requireRecoveryFact(facts: TypedPrivateGameFacts, key: string): TypedPrivateGameFact {
  const value = facts[key];
  if (value === undefined) throw new Error(`contained game runtime: recovery facts are missing ${key}`);
  return value;
}

function requireRecoveryOpaqueGuid(facts: TypedPrivateGameFacts, key: string): string {
  const value = requireRecoveryFact(facts, key);
  if (typeof value !== "string" || !RECOVERY_OPAQUE_GUID.test(value)) throw new Error(`contained game runtime: recovery fact ${key} is not an opaque guid`);
  return value;
}

function requireRecoveryPositiveInteger(facts: TypedPrivateGameFacts, key: string): number {
  const value = requireRecoveryFact(facts, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`contained game runtime: recovery fact ${key} is not a positive integer`);
  return value;
}

function requireRecoveryGuardianName(facts: TypedPrivateGameFacts, key: string): string {
  const value = requireRecoveryFact(facts, key);
  if (typeof value !== "string" || !RECOVERY_GUARDIAN_NAME.test(value)) throw new Error(`contained game runtime: recovery fact ${key} is not a guardian name`);
  return value;
}

function requireRecoveryRoleState(facts: TypedPrivateGameFacts, key: string): string {
  const value = requireRecoveryFact(facts, key);
  if (typeof value !== "string" || !RECOVERY_ROLE_STATES.has(value)) throw new Error(`contained game runtime: recovery fact ${key} is not a role state`);
  return value;
}

/**
 * Encodes one recovery body with the key order both bodies are documented in.
 *
 * That order is a convention rather than a gate: the only place it is checked is
 * the Desktop broker's tokenless pre-CAS check (which compares the five body keys
 * as an ordinal sequence), while the native parser is key-set based
 * (`GuardianProtocol.RequireExactKeys` compares the key count and the membership)
 * and nothing checks the order of the post-CAS body that
 * `GuardianRecoveryIngress.ParsePostCas` reads. Emitting it in this order keeps
 * both bodies readable and matches what the one order-checking consumer expects.
 */
function encodeRecoveryBody(body: Readonly<Record<string, string | number>>, name: string): Uint8Array {
  const encoded = JSON.stringify(body);
  if (encoded === undefined) throw new Error(`contained game runtime: ${name} encoding failed`);
  return new TextEncoder().encode(encoded);
}

/**
 * Tokenless pre-CAS gate body. The Desktop supervisor injects the recovery token
 * into this one frame (`InjectRecoveryToken`) and the broker accepts only these
 * five keys, so a token of the Host's own can never appear here.
 */
function encodeRecoveryPreCasFrame(
  correlation: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string }>,
  gateFacts: TypedPrivateGameFacts,
): Uint8Array {
  return encodeRecoveryBody({
    guardianInstanceId: correlation.guardianInstanceId,
    guardianEpoch: correlation.guardianEpoch,
    attemptId: correlation.attemptId,
    bindingRevision: requireRecoveryOpaqueGuid(gateFacts, "bindingRevision"),
    leaseName: requireRecoveryGuardianName(gateFacts, "leaseName"),
  }, "recovery gate frame");
}

/**
 * Post-CAS binding body of the durable recovering successor. It is written to
 * the native pipe unchanged, so it carries exactly the keys `ParsePostCas`
 * reads; the native parser remains the authority on the gate correlation it must
 * still match.
 */
function encodeRecoveryPostCasFrame(
  correlation: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; recoveryInstanceId: string }>,
  successorFacts: TypedPrivateGameFacts,
): Uint8Array {
  return encodeRecoveryBody({
    guardianInstanceId: correlation.guardianInstanceId,
    guardianEpoch: correlation.guardianEpoch,
    attemptId: correlation.attemptId,
    recoveryInstanceId: correlation.recoveryInstanceId,
    bindingRevision: requireRecoveryOpaqueGuid(successorFacts, "bindingRevision"),
    ownerRecordRevision: requireRecoveryPositiveInteger(successorFacts, "ownerRecordRevision"),
    leaseName: requireRecoveryGuardianName(successorFacts, "leaseName"),
    playerJobName: requireRecoveryGuardianName(successorFacts, "playerJobName"),
    aiJobName: requireRecoveryGuardianName(successorFacts, "aiJobName"),
    playerHostState: requireRecoveryRoleState(successorFacts, "playerHostState"),
    aiClientState: requireRecoveryRoleState(successorFacts, "aiClientState"),
  }, "recovery post-CAS frame");
}

/**
 * The part of a recovery only the calling layer can supply.
 *
 * The gate binding and both durable steps deliberately are NOT part of it: they
 * come from the exact owner's consumed one-shot Guardian binding, so a caller can
 * neither substitute the gate correlation the native gate must acquire nor
 * invent a durable transition it does not own.
 */
export type StardewOwnerRecoveryRequest = Readonly<{
  /**
   * Opaque recovery actor for this attempt. An interrupted recovery resumes its
   * exact recorded actor instead of minting a new identity.
   */
  readonly recoveryInstanceId: string;
  /**
   * Durable post-CAS binding facts of the successor record, read after the
   * `recovering` CAS ran. They are typed game facts only: the composition encodes
   * them into the post-CAS native body, and the native ingress remains the
   * authority on the gate correlation they must still match.
   */
  readonly readRecoveryBinding: () => Promise<TypedPrivateGameFacts>;
}>;

/**
 * The owner-held recovery half of the launch collaborator seam.
 *
 * It is declared here and not on the game layer's
 * `StardewPlayerHostRuntimeLaunchCollaborator`, because a recovery is driven for
 * the exact owner whose durable attempt is non-terminal, and only this
 * composition holds that owner's consumed Guardian binding and the authenticated
 * session. The factory below returns it on the same one-shot collaborator object
 * it already returns, so a recovery is never a second collaborator, a second
 * owner path, or a second durable read/write seam.
 */
export type StardewOwnerRecoveryDriver = Readonly<{
  recover(
    owner: StardewOwnedPlayerHostBootstrap,
    request: StardewOwnerRecoveryRequest,
  ): Promise<RedactedRecoveryOutcome>;
}>;

/**
 * Reads the recovery half off a collaborator value.
 *
 * The collaborator a consumer receives is declared by the game layer, which
 * cannot name this half, so exactly one reader exists — next to the factory that
 * installs the member — instead of every consumer casting a shape it cannot
 * check. A collaborator that does not carry the member reads as `undefined`, and
 * its consumer must turn that into a refusal: a recovery that cannot be driven
 * must never be reported as one that ran.
 */
export function readStardewOwnerRecoveryDriver(
  collaborator: StardewPlayerHostRuntimeLaunchCollaborator,
): StardewOwnerRecoveryDriver | undefined {
  const candidate = collaborator as Partial<StardewOwnerRecoveryDriver>;
  return typeof candidate.recover === "function" ? candidate as StardewOwnerRecoveryDriver : undefined;
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
 *
 * Every member of the returned collaborator that the contract declares to
 * resolve a `Promise` is `async`, so its guards (an unknown owner, a consumed
 * owner binding, a malformed recovery actor) refuse as a rejection. The
 * collaborator is forwarded by non-async adapters that only attach `.then()`,
 * so a synchronous throw here would escape as an unhandled exception in the
 * consumer's frame instead of an awaited failure. The one member that is not a
 * promise is the synchronous `recovery(owner)` accessor, whose own refusal
 * shape is unchanged.
 */
export function createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
  platform: ContainedGameRuntimePlatform,
): StardewPlayerHostRuntimeLaunchCollaborator & StardewOwnerRecoveryDriver {
  // The Guardian owner binding is one-shot per owner; the contained runtime
  // for that owner is therefore bound once and retained here. A launch retry
  // after a pre-claim failure reuses the exact bound runtime, while a post-
  // claim failure is terminal in the coordinator and never calls back here.
  const runtimesByOwner = new WeakMap<StardewOwnedPlayerHostBootstrap, RecoverableContainedGameRuntime>();
  // The arm frame the contained runtime needs and the durable transition port a
  // recovery drive needs are two halves of the same one-shot binding, so it is
  // consumed exactly once here and both halves are read from that single
  // consumption. That keeps one owner path, one durable read/write seam, and
  // makes the recovery drive reachable before any launch.
  const ownerBindings = new WeakMap<StardewOwnedPlayerHostBootstrap, ReturnType<typeof consumeStardewBootstrapGuardianOwnerBinding>>();
  const ownerBindingFor = (owner: StardewOwnedPlayerHostBootstrap): ReturnType<typeof consumeStardewBootstrapGuardianOwnerBinding> => {
    let binding = ownerBindings.get(owner);
    if (binding === undefined) {
      binding = consumeStardewBootstrapGuardianOwnerBinding(createStardewBootstrapGuardianOwnerBinding(owner));
      ownerBindings.set(owner, binding);
    }
    return binding;
  };
  const recoveryDrives = new WeakMap<StardewOwnedPlayerHostBootstrap, StardewBootstrapOwnerRecoveryDrive>();
  // One drive per owner, read from the same consumption the contained runtime
  // uses. Both the drive reader and the recovery drive go through this, so a
  // recovery and a later launch can never open two owner paths or two durable
  // seams for one attempt.
  const recoveryDriveFor = (owner: StardewOwnedPlayerHostBootstrap): StardewBootstrapOwnerRecoveryDrive => {
    let drive = recoveryDrives.get(owner);
    if (drive === undefined) {
      const { recoveryGateBinding, transitions } = ownerBindingFor(owner);
      drive = Object.freeze({ recoveryGateBinding, transitions });
      recoveryDrives.set(owner, drive);
    }
    return drive;
  };
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
  const runtimeFor = (owner: StardewOwnedPlayerHostBootstrap): RecoverableContainedGameRuntime => {
    let runtime = runtimesByOwner.get(owner);
    if (runtime === undefined) {
      // The consumed binding is this composition seam's, and this seam is the
      // only layer that holds the exact owner, so it owns both the native
      // correlation and the durable owner-record transitions. The retired
      // game-layer Guardian owner seam did the same work from the wrong layer
      // and had no production consumer.
      const { armFrame } = ownerBindingFor(owner);
      const binding = Object.freeze({
        guardianInstanceId: armFrame.guardianInstanceId,
        guardianEpoch: armFrame.guardianEpoch,
        attemptId: armFrame.attemptId,
        operationWaitBudgetMs: DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS,
      });
      const core = createContainedGameRuntime(platform, binding);
      runtime = Object.freeze({
        ...core,
        /**
         * The owner-held recovery half of this runtime: the generic contract's
         * `recover` member bound to the exact owner this runtime was created
         * for. The platform owns the frame order and the bounded waits, the
         * operation carries the typed gate facts and the two durable steps, and
         * only the platform's terminal containment is reported as `recovered`.
         * Every other position and every failure is `unavailable` and is never
         * retried here: an uncertain native recovery may already have mutated
         * the attempt, so a retry would repeat a native effect this layer cannot
         * prove. The generic core cannot supply this member itself, because it
         * holds no owner binding and no durable transition port.
         *
         * A recovery drives an attempt that already crashed, so it runs before
         * any role launch on this runtime rather than interleaving with the
         * arm/launch/contain sequence the generic runtime serializes.
         */
        async recover(operation: RecoveryOperation): Promise<RedactedRecoveryOutcome> {
          try {
            const acknowledgement = await platform.recover({
              ...binding,
              recoveryInstanceId: operation.recoveryInstanceId,
              gateFacts: operation.gateFacts,
              beginRecovery: operation.beginRecovery,
              roleContained: operation.roleContained,
            });
            return Object.freeze({
              status: acknowledgement.outcome === "contained" ? "recovered" as const : "unavailable" as const,
            });
          } catch {
            return Object.freeze({ status: "unavailable" as const });
          }
        },
      });
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
    async launchPlayerHost(owner: StardewOwnedPlayerHostBootstrap, operation, launch) {
      return runtimeFor(owner).launchRole("player_host", operation, launch.provideAuthorization).then((result) => {
        if (result.status === "succeeded") launchedRolesFor(owner).add("playerHost");
        return result;
      });
    },
    async launchAiClient(owner: StardewOwnedPlayerHostBootstrap, operation, launch) {
      return runtimeFor(owner).launchRole("ai_client", operation, launch.provideAuthorization).then((result) => {
        if (result.status === "succeeded") launchedRolesFor(owner).add("aiClient");
        return result;
      });
    },
    async containPlayerHost(owner: StardewOwnedPlayerHostBootstrap) {
      return requireRuntime(owner).containRole("player_host");
    },
    async containAiClient(owner: StardewOwnedPlayerHostBootstrap) {
      return requireRuntime(owner).containRole("ai_client");
    },
    /**
     * The exact owner's durable recovery drive, projected from the same one-shot
     * Guardian owner binding the contained runtime consumes. Reaching it needs
     * no launch, and a later launch on the same owner reuses the exact same
     * binding, so recovery and launch never open two owner paths or two durable
     * seams. The native recovery attempt itself stays with whoever holds the
     * Guardian recovery gate; this drive only owns the durable transitions.
     */
    recovery(owner: StardewOwnedPlayerHostBootstrap): StardewBootstrapOwnerRecoveryDrive {
      return recoveryDriveFor(owner);
    },
    /**
     * Drives one bounded recovery of the exact owner's non-terminal attempt.
     *
     * This is the product-reachable half of the recovery path: the gate binding
     * and both durable steps come from the same consumed one-shot Guardian owner
     * binding the contained runtime uses, the typed conversation goes through the
     * authenticated platform session (which owns the frame order, the bounded
     * waits and the durable CAS ordering), and the caller supplies only what it
     * alone holds — the recorded recovery actor and the post-CAS binding facts of
     * its own durable record. A request the durable engine cannot accept is
     * refused with a bounded error and nothing is driven; a recovery that the
     * platform cannot take to terminal containment reports `unavailable` and is
     * never retried here.
     */
    async recover(owner: StardewOwnedPlayerHostBootstrap, request: StardewOwnerRecoveryRequest): Promise<RedactedRecoveryOutcome> {
      // The actor reaches a durable CAS and one native field the platform encodes
      // into a frame, so it is validated at this boundary: a malformed actor must
      // refuse here rather than turn into an uncertain native attempt. This
      // member is async for the same reason every member declared to resolve a
      // `Promise` is: a `.catch()`-only consumer must observe a rejection, and a
      // synchronous throw out of this seam would escape as an unhandled
      // exception instead (the adapter that forwards this member is not async).
      if (typeof request.recoveryInstanceId !== "string" || !RECOVERY_OPAQUE_GUID.test(request.recoveryInstanceId)) {
        throw new Error("stardew_owner_recovery_actor_invalid");
      }
      const { recoveryGateBinding, transitions } = recoveryDriveFor(owner);
      return runtimeFor(owner).recover({
        recoveryInstanceId: request.recoveryInstanceId,
        gateFacts: Object.freeze({ ...recoveryGateBinding }),
        beginRecovery: async () => {
          await transitions.beginRecovery(request.recoveryInstanceId);
          // The successor facts are read back after the CAS wrote them, never
          // before: they are the post-CAS binding the native ingress validates
          // against the exact gate this conversation already holds.
          return await request.readRecoveryBinding();
        },
        roleContained: async (role) => {
          // The durable engine speaks the two Guardian role tokens; the generic
          // contract only knows an opaque role, so an unknown one is refused
          // instead of being recorded as containment.
          if (role !== "playerHost" && role !== "aiClient") throw new Error("stardew_owner_recovery_role_invalid");
          await transitions.recoveryRoleContained(role, request.recoveryInstanceId);
        },
      });
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
    async close(owner: StardewOwnedPlayerHostBootstrap) {
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
 * native Guardian receives the exact 10-key plan it expects. Recovery frames use
 * the two exact bodies `GuardianRecoveryIngress` parses: a tokenless pre-CAS gate
 * body (the Desktop supervisor injects the recovery token) and the post-CAS
 * binding body of the durable recovering successor.
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
     * One bounded recovery conversation. The Host owns only the two native
     * bodies; the Desktop supervisor injects the recovery token into the gate
     * frame and the session/broker keep every frame order, correlation check and
     * durable CAS acknowledgement, so no recovery ordering decision is made here.
     */
    async recover(input) {
      const { gateFacts, beginRecovery, roleContained, ...correlation } = input;
      const preCasFrame = encodeRecoveryPreCasFrame(correlation, gateFacts);
      return await session.recover({
        ...correlation,
        preCasFrame,
        // The durable recovering CAS may only run while the gate is held, so the
        // post-CAS body is produced inside the conversation, never supplied to it.
        beginRecovery: async () => encodeRecoveryPostCasFrame(correlation, await beginRecovery()),
        roleContained,
      });
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
