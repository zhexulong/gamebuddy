import { randomUUID } from "node:crypto";

/**
 * Composition-private native Stardew role-launch plan encoder.
 *
 * The game-facing lifecycle produces typed private launch facts; this module is
 * the only Host composition boundary that turns them into the exact opaque JSON
 * frame consumed by the native Guardian `GuardianPrivateLaunchIngress.ParseLaunch`.
 * `planId` is minted here once per invocation and is not a product identity.
 */

export type StardewNativeRole = "player_host" | "ai_client";

/** Exact allowlisted role-process environment; no ambient inheritance. */
export const STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "GAMEBUDDY_STARDEW_LAUNCH_GENERATION",
] as const;

const STARDEW_NATIVE_ENVIRONMENT_ALLOWLIST = new Set<string>(STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS);

const PLAN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StardewNativeRoleLaunchPlan = Readonly<{
  readonly guardianInstanceId: string;
  readonly guardianEpoch: number;
  readonly attemptId: string;
  readonly planId: string;
  readonly role: StardewNativeRole;
  readonly deadlineUnixMs: number;
  readonly executable: string;
  readonly cwd: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}>;

export type StardewNativeRoleLaunchPlanInput = Readonly<{
  readonly guardianInstanceId: string;
  readonly guardianEpoch: number;
  readonly attemptId: string;
  readonly role: StardewNativeRole;
  readonly deadlineUnixMs: number;
  readonly executable: string;
  readonly cwd: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}>;

/** One-shot GUID D plan identity for this exact role invocation. */
export function mintStardewNativeRoleLaunchPlanId(): string {
  return randomUUID();
}

function matchesPlanIdFormat(value: string): boolean {
  return typeof value === "string" && value.length === 36 && PLAN_ID_PATTERN.test(value);
}

/** Fully qualified Windows drive path exactly as `Path.IsPathFullyQualified` plus size/NUL constraints. */
function fullyQualifiedWindowsPath(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 32_767 || value.includes("\0")) return false;
  return /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Validates and freezes one exact native role launch plan. Every rule mirrors
 * `GuardianPrivateLaunchIngress.ParseLaunch`; any violation means the frame
 * would be rejected by the native Guardian, so the plan fails closed here.
 */
export function modelStardewNativeRoleLaunchPlan(input: StardewNativeRoleLaunchPlanInput): StardewNativeRoleLaunchPlan {
  if (typeof input.guardianInstanceId !== "string" || input.guardianInstanceId.length === 0 || input.guardianInstanceId.length > 1024) throw new Error("stardew_native_launch_plan_guardian_instance_invalid");
  if (!Number.isSafeInteger(input.guardianEpoch) || input.guardianEpoch < 1) throw new Error("stardew_native_launch_plan_guardian_epoch_invalid");
  if (typeof input.attemptId !== "string" || input.attemptId.length === 0 || input.attemptId.length > 1024) throw new Error("stardew_native_launch_plan_attempt_invalid");
  if (!Number.isSafeInteger(input.deadlineUnixMs) || input.deadlineUnixMs <= Date.now() || input.deadlineUnixMs - Date.now() > 2_147_483_647) throw new Error("stardew_native_launch_plan_deadline_invalid");
  if (input.role !== "player_host" && input.role !== "ai_client") throw new Error("stardew_native_launch_plan_role_invalid");
  if (!fullyQualifiedWindowsPath(input.executable)) throw new Error("stardew_native_launch_plan_executable_invalid");
  if (!fullyQualifiedWindowsPath(input.cwd)) throw new Error("stardew_native_launch_plan_cwd_invalid");
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
    if (!Object.prototype.hasOwnProperty.call(environment, key)) throw new Error("stardew_native_launch_plan_environment_required_missing");
  }
  const planId = mintStardewNativeRoleLaunchPlanId();
  if (!matchesPlanIdFormat(planId)) throw new Error("stardew_native_launch_plan_id_invalid");
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
export function encodeStardewNativeRoleLaunchPlan(plan: StardewNativeRoleLaunchPlan): Uint8Array {
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