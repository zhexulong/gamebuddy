import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopGuardianGameRuntimePlatform } from "./contained-game-runtime-platform.private.js";
import type { DesktopGuardianSession, GuardianAck } from "../containment/auth/desktop-guardian-session.internal.js";
import { STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS } from "./stardew-native-role-launch-plan.private.js";
import type { TypedPrivateGameFacts } from "../containment/runtime/contract/game-runtime.js";

const ack = (operation: string, role?: string): GuardianAck => ({
  operation,
  status: "ok",
  bootstrapId: "bootstrap",
  generation: "generation",
  inventoryDigest: "inventory",
  runtimeAdmissionSha256: "admission",
  guardianInstanceId: "guardian",
  guardianEpoch: 1,
  attemptId: "attempt",
  ...(role === undefined ? {} : { role }),
});

const launchEnvironment = (): Record<string, string> => ({
  PATH: "C:\\Windows\\System32",
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
  TEMP: "C:\\Users\\tester\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\tester\\AppData\\Local\\Temp",
  USERPROFILE: "C:\\Users\\tester",
  GAMEBUDDY_STARDEW_LAUNCH_GENERATION: "gen_player_host_1",
});

/** Extra game facts (revision) prove the frame is the encoder output, not a raw facts JSON dump. */
const launchFacts = (): TypedPrivateGameFacts => Object.freeze({
  executable: "C:\\Stardew\\StardewModdingAPI.exe",
  cwd: "C:\\Stardew",
  arguments: Object.freeze(["--mods-path", "C:\\tmp\\transaction\\player-host\\Mods"]),
  environment: launchEnvironment(),
  revision: 7,
});

const GUID_D = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARSE_LAUNCH_KEYS = [
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
].sort();

type RecordedCall = Readonly<{ operation: string; frame?: Uint8Array; deadlineUnixMs?: number; role?: string }>;

function recordingSession(calls: RecordedCall[]): DesktopGuardianSession {
  return Object.freeze({
    arm: async (input) => {
      calls.push({ operation: "arm", frame: input.privateFrame });
      return ack("arm");
    },
    launch: async (input) => {
      calls.push({ operation: "launch", role: input.role, deadlineUnixMs: input.deadlineUnixMs, frame: input.privateFrame });
      return ack("launch", input.role);
    },
    contain: async (input) => {
      calls.push({ operation: "contain" });
      return ack("contain", input.role);
    },
    close: async () => {},
  });
}

test("composition-private platform relays arm facts and encodes launch exactly as ParseLaunch accepts", async () => {
  const calls: RecordedCall[] = [];
  const platform = createDesktopGuardianGameRuntimePlatform(recordingSession(calls));
  await platform.arm({
    guardianInstanceId: "guardian",
    guardianEpoch: 1,
    attemptId: "attempt",
    operationWaitBudgetMs: 1000,
    authorization: Object.freeze({ role: "player_host", revision: 7 }),
  });
  const deadlineUnixMs = Date.now() + 60_000;
  await platform.launch({
    guardianInstanceId: "guardian",
    guardianEpoch: 1,
    attemptId: "attempt",
    deadlineUnixMs,
    role: "player_host",
    authorization: launchFacts(),
  });
  await platform.contain({
    guardianInstanceId: "guardian",
    guardianEpoch: 1,
    attemptId: "attempt",
    operationWaitBudgetMs: 1000,
    role: "player_host",
  });

  // Arm stays a simple relay of the typed game facts (arm schema is game-owned).
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[0]!.frame)), { role: "player_host", revision: 7 });

  // Launch is the encoder output: exactly the ten ParseLaunch keys, GUID D
  // planId, fully qualified executable/cwd, and the exact seven-key allowlist.
  const decoded = JSON.parse(new TextDecoder().decode(calls[1]!.frame)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(decoded).sort(), PARSE_LAUNCH_KEYS);
  assert.match(String(decoded.planId), GUID_D);
  assert.equal(decoded.role, "player_host");
  assert.equal(decoded.deadlineUnixMs, deadlineUnixMs);
  assert.equal(decoded.executable, "C:\\Stardew\\StardewModdingAPI.exe");
  assert.equal(decoded.cwd, "C:\\Stardew");
  assert.deepEqual(decoded.arguments, ["--mods-path", "C:\\tmp\\transaction\\player-host\\Mods"]);
  assert.deepEqual(Object.keys(decoded.environment as Record<string, unknown>).sort(), [...STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS].sort());
  assert.deepEqual(decoded.environment, launchEnvironment());
  assert.equal(calls[1]!.role, "player_host");
  assert.deepEqual(calls.map(({ operation }) => operation), ["arm", "launch", "contain"]);
});

test("every launch invocation mints a fresh GUID D planId so frames are never replayed", async () => {
  const calls: RecordedCall[] = [];
  const platform = createDesktopGuardianGameRuntimePlatform(recordingSession(calls));
  const base = {
    guardianInstanceId: "guardian",
    guardianEpoch: 1,
    attemptId: "attempt",
    deadlineUnixMs: Date.now() + 60_000,
    role: "player_host" as const,
  };
  await platform.launch({ ...base, authorization: launchFacts() });
  await platform.launch({ ...base, authorization: launchFacts() });
  const first = (JSON.parse(new TextDecoder().decode(calls[0]!.frame)) as Record<string, unknown>).planId;
  const second = (JSON.parse(new TextDecoder().decode(calls[1]!.frame)) as Record<string, unknown>).planId;
  assert.match(String(first), GUID_D);
  assert.match(String(second), GUID_D);
  assert.notEqual(first, second);
  assert.deepEqual(Object.keys(JSON.parse(new TextDecoder().decode(calls[0]!.frame)) as Record<string, unknown>).sort(), PARSE_LAUNCH_KEYS);
});

test("launch fails closed before the native session when facts violate the ParseLaunch schema", async () => {
  const attempted: number[] = [];
  const platform = createDesktopGuardianGameRuntimePlatform(Object.freeze({
    arm: async (input) => { return ack("arm"); },
    launch: async (input) => {
      attempted.push(1);
      return ack("launch", input.role);
    },
    contain: async (input) => { return ack("contain", input.role); },
    close: async () => {},
  }));
  const base = {
    guardianInstanceId: "guardian",
    guardianEpoch: 1,
    attemptId: "attempt",
    deadlineUnixMs: Date.now() + 60_000,
  };

  await assert.rejects(
    () => platform.launch({ ...base, role: "player_host", authorization: Object.freeze({ revision: 7 }) }),
    /missing executable/,
  );
  await assert.rejects(
    () => platform.launch({ ...base, role: "player_host", authorization: Object.freeze({ executable: "relative.exe", cwd: "C:\\Stardew", arguments: [], environment: launchEnvironment() }) }),
    /executable_invalid/,
  );
  const withoutGeneration = launchEnvironment();
  delete withoutGeneration["GAMEBUDDY_STARDEW_LAUNCH_GENERATION"];
  await assert.rejects(
    () => platform.launch({ ...base, role: "player_host", authorization: Object.freeze({ executable: "C:\\Stardew\\StardewModdingAPI.exe", cwd: "C:\\Stardew", arguments: [], environment: withoutGeneration }) }),
    /environment_required_missing/,
  );
  await assert.rejects(
    () => platform.launch({ ...base, role: "player_host", authorization: Object.freeze({ executable: "C:\\Stardew\\StardewModdingAPI.exe", cwd: "C:\\Stardew", arguments: [], environment: { ...launchEnvironment(), COMSPEC: "C:\\Windows\\System32\\cmd.exe" } }) }),
    /environment_key_disallowed/,
  );
  await assert.rejects(
    () => platform.launch({ ...base, role: "npc", authorization: launchFacts() }),
    /invalid role/,
  );
  assert.equal(attempted.length, 0);
});