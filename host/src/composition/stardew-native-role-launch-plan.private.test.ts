import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeStardewNativeRoleLaunchPlan,
  mintStardewNativeRoleLaunchPlanId,
  modelStardewNativeRoleLaunchPlan,
  STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS,
  type StardewNativeRoleLaunchPlanInput,
} from "./stardew-native-role-launch-plan.private.js";

const makeEnvironment = (): Record<string, string> => ({
  PATH: "C:\\Windows\\System32",
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
  TEMP: "C:\\Users\\tester\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\tester\\AppData\\Local\\Temp",
  USERPROFILE: "C:\\Users\\tester",
  GAMEBUDDY_STARDEW_LAUNCH_GENERATION: "gen_player_host_1",
});

const makePlanInput = (overrides: Partial<StardewNativeRoleLaunchPlanInput> = {}): StardewNativeRoleLaunchPlanInput => ({
  guardianInstanceId: "11111111-1111-4111-8111-111111111111",
  guardianEpoch: 1,
  attemptId: "attempt-player-host",
  role: "player_host",
  deadlineUnixMs: Date.now() + 60_000,
  executable: "C:\\Stardew\\StardewModdingAPI.exe",
  cwd: "C:\\Stardew",
  arguments: ["--mods-path", "C:\\tmp\\transaction\\player-host\\Mods"],
  environment: makeEnvironment(),
  ...overrides,
});

test("minted planId is a canonical GUID D, unique and of the exact 36-char length", () => {
  const first = mintStardewNativeRoleLaunchPlanId();
  const second = mintStardewNativeRoleLaunchPlanId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(first.length, 36);
  assert.notEqual(first, second);
});

test("model freezes an exact plan with exactly one fresh planId bound to the invocation", () => {
  const plan = modelStardewNativeRoleLaunchPlan(makePlanInput());
  assert.deepEqual(Object.keys(plan).sort(), [
    "arguments",
    "attemptId",
    "cwd",
    "deadlineUnixMs",
    "environment",
    "executable",
    "guardianEpoch",
    "guardianInstanceId",
    "planId",
    "role",
  ].sort());
  assert.deepEqual(Object.keys(plan.environment).sort(), [...STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS].sort());
  assert.equal(Object.keys(plan).filter((key) => key === "planId").length, 1);
  assert.match(plan.planId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test("encode produces a JSON frame with exactly the native ParseLaunch keys", () => {
  const plan = modelStardewNativeRoleLaunchPlan(makePlanInput());
  const bytes = encodeStardewNativeRoleLaunchPlan(plan);
  const decoded = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(decoded).sort(), [
    "arguments",
    "attemptId",
    "cwd",
    "deadlineUnixMs",
    "environment",
    "executable",
    "guardianEpoch",
    "guardianInstanceId",
    "planId",
    "role",
  ].sort());
  assert.equal(decoded.role, "player_host");
  assert.equal(decoded.planId, plan.planId);
  assert.equal(decoded.executable, "C:\\Stardew\\StardewModdingAPI.exe");
  assert.equal(decoded.cwd, "C:\\Stardew");
  assert.deepEqual(decoded.arguments, ["--mods-path", "C:\\tmp\\transaction\\player-host\\Mods"]);
  assert.deepEqual(decoded.environment, makeEnvironment());
});

test("model rejects the same non-canonical input native ParseLaunch rejects", () => {
  assert.throws(() => modelStardewNativeRoleLaunchPlan(makePlanInput({ executable: "relative.exe" })), /executable_invalid/);
  assert.throws(() => modelStardewNativeRoleLaunchPlan(makePlanInput({ cwd: "/unix/path" })), /cwd_invalid/);
  assert.throws(() => modelStardewNativeRoleLaunchPlan(makePlanInput({ deadlineUnixMs: Date.now() - 1 })), /deadline_invalid/);
  assert.throws(() => modelStardewNativeRoleLaunchPlan(makePlanInput({ role: "npc" as never })), /role_invalid/);
  assert.throws(() => modelStardewNativeRoleLaunchPlan(makePlanInput({ executable: "C:\\Stardew\\a\u0000b.exe" })), /executable_invalid/);
  assert.throws(() => modelStardewNativeRoleLaunchPlan(makePlanInput({ arguments: ["", "--mods"] })), /arguments_invalid/);
  assert.throws(() => modelStardewNativeRoleLaunchPlan(makePlanInput({ arguments: Array.from({ length: 129 }, (_, index) => `arg-${index}`) })), /arguments_invalid/);
  assert.throws(() => modelStardewNativeRoleLaunchPlan(makePlanInput({ arguments: ["ok", "bad\u0000arg"] })), /arguments_invalid/);
});

test("an empty arguments array is legal exactly as in ParseLaunch", () => {
  const plan = modelStardewNativeRoleLaunchPlan(makePlanInput({ arguments: [] }));
  assert.deepEqual(plan.arguments, []);
});

test("rejects undeclared or missing environment keys fail-closed like ParseLaunch", () => {
  assert.throws(
    () => modelStardewNativeRoleLaunchPlan(makePlanInput({ environment: { ...makeEnvironment(), COMSPEC: "C:\\Windows\\System32\\cmd.exe" } })),
    /environment_key_disallowed/,
  );
  const withoutGeneration = makeEnvironment();
  delete withoutGeneration["GAMEBUDDY_STARDEW_LAUNCH_GENERATION"];
  assert.throws(() => modelStardewNativeRoleLaunchPlan(makePlanInput({ environment: withoutGeneration })), /environment_required_missing/);
  assert.throws(() => modelStardewNativeRoleLaunchPlan(makePlanInput({ environment: { ...makeEnvironment(), PATH: "bad\u0000value" } })), /environment_value_invalid/);
});

test("mints a fresh planId on every model call so replay cannot reuse a plan", () => {
  const first = modelStardewNativeRoleLaunchPlan(makePlanInput());
  const second = modelStardewNativeRoleLaunchPlan(makePlanInput());
  assert.notEqual(first.planId, second.planId);
  assert.match(first.planId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});