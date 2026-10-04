import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { createDesktopGuardianGameRuntimePlatform, createStardewPlayerHostRuntimeLaunchCollaboratorFactory } from "./stardew-guardian-platform.js";
import type { DesktopGuardianSession, GuardianAck } from "../../containment/auth/desktop-guardian-session.internal.js";
import { STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS } from "./stardew-native-role-launch-plan.private.js";
import type { TypedPrivateGameFacts } from "../../containment/runtime/contract/game-runtime.js";
import { bindWindowsStaleLockReclaimer } from "../../path-lock.js";
import { createTestWindowsStaleLockReclaimer } from "../../windows-stale-lock-reclaimer/index.test-support.js";
import {
  createHarness,
  createRoot,
  expectedGuardianBinding,
  mintOwnedTriple,
  ownerPath,
  simulatedLockHelper,
  temporaryRoots,
} from "../../games/stardew/lifecycle/stardew-private-bootstrap-composer.test-fixtures.js";

test.beforeEach(() => bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedLockHelper)));
test.after(() => bindWindowsStaleLockReclaimer(undefined));
test.after(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

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
    recover: async () => {
      calls.push({ operation: "recover" });
      return Object.freeze({ outcome: "contained" as const });
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
    authorization: Object.freeze({ role: "player_host", revision: 7, executable: "C:\\Stardew\\StardewModdingAPI.exe" }),
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

  // Arm stays a simple relay of the typed game facts (arm schema is game-owned)
  // plus the fixed approved executable the native ParseArm must enforce at
  // launch: the launch executable must equal the armed approved executable.
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[0]!.frame)), { role: "player_host", revision: 7, executable: "C:\\Stardew\\StardewModdingAPI.exe", approvedExecutable: "C:\\Stardew\\StardewModdingAPI.exe" });

  // Launch is the encoder output: exactly the ten ParseLaunch keys, GUID D
  // planId, fully qualified executable/cwd, and the exact seven-key allowlist.
  const decoded = JSON.parse(new TextDecoder().decode(calls[1]!.frame)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(decoded).sort(), PARSE_LAUNCH_KEYS);
  assert.match(String(decoded.planId), GUID_D);
  assert.equal(decoded.role, "player_host");
  assert.equal(decoded.deadlineUnixMs, deadlineUnixMs);
  assert.equal(decoded.executable, "C:\\Stardew\\StardewModdingAPI.exe");
  assert.equal(decoded.executable, JSON.parse(new TextDecoder().decode(calls[0]!.frame)).approvedExecutable);
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

test("launch and arm fail closed before the native session when facts violate the ParseLaunch/ParseArm schema", async () => {
  const attempted: number[] = [];
  const arms: number[] = [];
  const platform = createDesktopGuardianGameRuntimePlatform(Object.freeze({
    arm: async () => { arms.push(1); return ack("arm"); },
    launch: async (input) => {
      attempted.push(1);
      return ack("launch", input.role);
    },
    contain: async (input) => { return ack("contain", input.role); },
    recover: async () => Object.freeze({ outcome: "contained" as const }),
    close: async () => {},
  }));
  const base = {
    guardianInstanceId: "guardian",
    guardianEpoch: 1,
    attemptId: "attempt",
    deadlineUnixMs: Date.now() + 60_000,
  };

  // The Host wire mirrors the native ParseArm executable constraints and fails
  // closed before the authenticated session sees a frame the native Guardian
  // would reject: missing, NUL, non-fully-qualified, and overlong executables
  // never produce an arm_attempt frame. The ordinal-ignore-case equality gate
  // itself remains native-only (ParseLaunch).
  await assert.rejects(
    () => platform.arm({ ...base, operationWaitBudgetMs: 1000, authorization: Object.freeze({ role: "player_host", revision: 7 }) }),
    /arm authorization missing approved executable/,
  );
  await assert.rejects(
    () => platform.arm({ ...base, operationWaitBudgetMs: 1000, authorization: Object.freeze({ role: "player_host", executable: "C:\\Stardew\\StardewModdingAPI.exe\0" }) }),
    /arm authorization missing approved executable/,
  );
  await assert.rejects(
    () => platform.arm({ ...base, operationWaitBudgetMs: 1000, authorization: Object.freeze({ role: "player_host", executable: "relative\\StardewModdingAPI.exe" }) }),
    /arm authorization missing approved executable/,
  );
  await assert.rejects(
    () => platform.arm({ ...base, operationWaitBudgetMs: 1000, authorization: Object.freeze({ role: "player_host", executable: `C:\\${`a`.repeat(32_768)}.exe` }) }),
    /arm authorization missing approved executable/,
  );
  assert.equal(arms.length, 0);
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

// A close that FAILED must stay retryable, and a successful close must be latched
// so a later caller cannot race a second close onto the same authenticated session.
// The previous latch set `sessionClosed = true` BEFORE awaiting `session.close()`,
// so a rejected close was permanently latched and the coordinator's close retry
// (which clears `closePromise` when the attempt rejected) reported full success
// while the Guardian session was still open. The survival task forbids that.
test("a failed platform close stays retryable and only a successful close latches", async () => {
  let closeCalls = 0;
  let failNext = true;
  const session: DesktopGuardianSession = Object.freeze({
    arm: async () => ack("arm"),
    launch: async (input) => ack("launch", input.role),
    contain: async (input) => ack("contain", input.role),
    recover: async () => Object.freeze({ outcome: "contained" as const }),
    close: async () => {
      closeCalls += 1;
      if (failNext) throw new Error("controlled_session_close_failure");
    },
  });
  const platform = createDesktopGuardianGameRuntimePlatform(session);

  await assert.rejects(() => platform.close(), /controlled_session_close_failure/);
  assert.equal(closeCalls, 1);

  // The retry must actually reach the session again rather than being swallowed.
  failNext = false;
  await platform.close();
  assert.equal(closeCalls, 2, "the retry re-drove the session close");

  // Only now is it latched, so a further close is a no-op.
  await platform.close();
  assert.equal(closeCalls, 2, "a successful close latches and is not repeated");
});

// Concurrent closes must be joined, not raced onto one session: two in-flight
// closes would otherwise both see the unset latch and both call the session.
test("concurrent platform closes are joined onto a single session close", async () => {
  let closeCalls = 0;
  let release: (() => void) | undefined;
  const session: DesktopGuardianSession = Object.freeze({
    arm: async () => ack("arm"),
    launch: async (input) => ack("launch", input.role),
    contain: async (input) => ack("contain", input.role),
    recover: async () => Object.freeze({ outcome: "contained" as const }),
    close: async () => {
      closeCalls += 1;
      await new Promise<void>((resolveClose) => { release = resolveClose; });
    },
  });
  const platform = createDesktopGuardianGameRuntimePlatform(session);

  const first = platform.close();
  const second = platform.close();
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(closeCalls, 1, "a concurrent close joined the in-flight one");
  release?.();
  await Promise.all([first, second]);
  assert.equal(closeCalls, 1);
});

/**
 * The recovery drive is only useful if the layer that actually holds the exact
 * owner can reach it. The launch collaborator is that layer, so this drives a
 * durable recovery through the collaborator's own `recovery(owner)` instead of
 * through a core-level opener test, and proves the drive is the same one-shot
 * binding the contained runtime consumes.
 */
test("the owner-holding collaborator exposes a recovery drive that advances the durable owner record", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostBootstrap(
    root,
    triple.claim,
    triple.playerHostReservation,
    triple.aiClientReservation,
  );
  const calls: RecordedCall[] = [];
  const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
    createDesktopGuardianGameRuntimePlatform(recordingSession(calls)),
  );

  const drive = collaborator.recovery(owner);
  // The drive is the consumed one-shot Guardian owner binding projected onto its
  // recovery half: the exact gate correlation plus the durable transition port.
  assert.deepEqual(Object.keys(drive).sort(), ["recoveryGateBinding", "transitions"]);
  assert.equal(Object.isFrozen(drive), true);
  assert.deepEqual({ ...drive.recoveryGateBinding }, {
    bindingRevision: expectedGuardianBinding().bindingRevision,
    leaseName: expectedGuardianBinding().leaseName,
  });

  // Driving the durable transition engine through that drive really advances
  // owner.json: this is the production authority, not a stub.
  await drive.transitions.beginRecovery("recovery-platform-1");
  const persisted = JSON.parse(await readFile(ownerPath(root), "utf8")) as Record<string, unknown>;
  assert.deepEqual(
    {
      state: persisted.state,
      guardian: persisted.guardianState,
      recovery: persisted.recoveryInstanceId,
      revision: persisted.ownerRecordRevision,
    },
    { state: "recovering", guardian: "recovering", recovery: "recovery-platform-1", revision: 2 },
  );

  // One owner, one binding, one drive: reading it twice is the exact same
  // authority, and reaching it required no launch at all.
  assert.equal(collaborator.recovery(owner), drive);
  assert.deepEqual(calls, []);
});

/**
 * The Host half of a recovery conversation is exactly two native bodies. This
 * checks the relay hands the session those bodies with the documented key sets
 * and values, and that the gate body is tokenless (the Desktop supervisor
 * injects the recovery token into that one frame).
 *
 * It deliberately does NOT claim native acceptance: the native contract itself
 * (`GuardianRecoveryIngress.ParsePreCas`/`ParsePostCas`, C#) is not importable
 * into a Node test program, so the parser round trip remains unverified here.
 */
test("the platform recovery relay sends the exact tokenless pre-CAS and post-CAS native bodies", async () => {
  const frames: Array<Readonly<{ operation: string; frame: Uint8Array }>> = [];
  const roleContainedCalls: string[] = [];
  const bindingRevision = "0d3b8f4d-6b7c-4e21-9d5a-2f1c8a4e6b70";
  const leaseName = "Local\\GameBuddy-Test-Lease-1";
  const playerJobName = "Local\\GameBuddy-Test-PlayerJob-1";
  const aiJobName = "Local\\GameBuddy-Test-AiJob-1";
  const recoveryInstanceId = "53ee44a2-d70b-4a49-a857-1ca4883e5d2e";
  const platform = createDesktopGuardianGameRuntimePlatform(Object.freeze({
    arm: async () => ack("arm"),
    launch: async (input) => ack("launch", input.role),
    contain: async (input) => ack("contain", input.role),
    recover: async (input) => {
      // The session owns the conversation: it validates its own input, and the
      // post-CAS body may only be requested once the gate is held.
      assert.deepEqual(Object.keys(input).sort(), [
        "attemptId", "beginRecovery", "guardianEpoch", "guardianInstanceId",
        "operationWaitBudgetMs", "preCasFrame", "recoveryInstanceId", "roleContained",
      ].sort());
      frames.push({ operation: "preCas", frame: input.preCasFrame });
      frames.push({ operation: "postCas", frame: await input.beginRecovery() });
      await input.roleContained("playerHost");
      return Object.freeze({ outcome: "contained" as const });
    },
    close: async () => {},
  }));

  const acknowledgement = await platform.recover({
    guardianInstanceId: "guardian",
    guardianEpoch: 1,
    attemptId: "attempt",
    operationWaitBudgetMs: 1000,
    recoveryInstanceId,
    gateFacts: Object.freeze({ bindingRevision, leaseName }),
    beginRecovery: async () => Object.freeze({
      bindingRevision,
      ownerRecordRevision: 4,
      leaseName,
      playerJobName,
      aiJobName,
      playerHostState: "active",
      aiClientState: "armed",
    }),
    roleContained: async (role) => { roleContainedCalls.push(role); },
  });
  assert.deepEqual(acknowledgement, { outcome: "contained" });
  assert.deepEqual(roleContainedCalls, ["playerHost"]);

  const decode = (frame: Uint8Array): Record<string, unknown> => JSON.parse(new TextDecoder().decode(frame)) as Record<string, unknown>;
  // Exactly the five tokenless keys the broker accepts and the native parser
  // reads once the supervisor injected the recovery token.
  assert.deepEqual(decode(frames[0]!.frame), {
    guardianInstanceId: "guardian",
    guardianEpoch: 1,
    attemptId: "attempt",
    bindingRevision,
    leaseName,
  });
  assert.equal("token" in decode(frames[0]!.frame), false);
  // Exactly the eleven keys the native post-CAS parser reads.
  assert.deepEqual(decode(frames[1]!.frame), {
    guardianInstanceId: "guardian",
    guardianEpoch: 1,
    attemptId: "attempt",
    recoveryInstanceId,
    bindingRevision,
    ownerRecordRevision: 4,
    leaseName,
    playerJobName,
    aiJobName,
    playerHostState: "active",
    aiClientState: "armed",
  });
});
