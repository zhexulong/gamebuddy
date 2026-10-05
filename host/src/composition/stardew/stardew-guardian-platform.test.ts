import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { createDesktopGuardianGameRuntimePlatform, createStardewPlayerHostRuntimeLaunchCollaboratorFactory } from "./stardew-guardian-platform.js";
import type { DesktopGuardianRecovery, DesktopGuardianSession, GuardianAck, GuardianRecoveryAck } from "../../containment/auth/desktop-guardian-session.internal.js";
import { STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS } from "./stardew-native-role-launch-plan.private.js";
import type { TypedPrivateGameFacts } from "../../containment/runtime/contract/game-runtime.js";
import { containedRuntimeTeardownFromCollaborator } from "../../stardew-production-lifecycle-coordinator.internal.js";
import {
  consumeStardewBootstrapGuardianOwnerBinding,
  createStardewBootstrapGuardianOwnerBinding,
  type StardewPlayerHostRuntimeLaunchCollaborator,
} from "../../games/stardew/lifecycle/stardew-private-bootstrap-composer.core.js";
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

/** The typed post-CAS binding facts, projected out of the strict durable record. */
function recoveryBindingFacts(record: Readonly<Record<string, unknown>>): TypedPrivateGameFacts {
  const guardian = record.guardian as Readonly<Record<string, unknown>>;
  return Object.freeze({
    bindingRevision: guardian.bindingRevision as string,
    ownerRecordRevision: record.ownerRecordRevision as number,
    leaseName: guardian.leaseName as string,
    playerJobName: guardian.playerJobName as string,
    aiJobName: guardian.aiJobName as string,
    playerHostState: record.playerHostState as string,
    aiClientState: record.aiClientState as string,
  });
}

/** One recovery conversation, recorded exactly as the Desktop half drives it. */
type RecordedRecovery = Readonly<{
  actor: string;
  preCas: Readonly<Record<string, unknown>>;
  postCas: Readonly<Record<string, unknown>>;
  stateBeforeCas: unknown;
  revisionBeforeCas: unknown;
  stateAfterCas: unknown;
  revisionAfterCas: unknown;
  roleCasOrder: readonly string[];
}>;

/**
 * The lifecycle never sees the composition collaborator directly: it sees the
 * coordinator adapter's teardown seam. So the only test that proves the recovery
 * drive is reachable from the product path must enter through that adapter, and
 * that is what this does — the drive is otherwise reachable only from the
 * collaborator's own unit test, which is exactly the gap it is here to close.
 *
 * The session stand-in is the Desktop half's real shape (tokenless gate frame,
 * then the durable CAS and its post-CAS body, then one classification per role)
 * and reads the durable record around the CAS, so the ordering asserted below is
 * observed rather than assumed.
 */
test("the owner-held recovery is reachable through the coordinator adapter and drives the durable recovery CASes", async () => {
  // The durable record carries the immutable binding revision the native arm
  // binding was created with, which is a GUID in production and in the records
  // the platform encoder validates; the fixture default is a readable token.
  const guardianRevision = "0d3b8f4d-6b7c-4e21-9d5a-2f1c8a4e6b70";
  const harness = createHarness({ guardianRevisions: [guardianRevision] });
  const root = await createRoot();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostBootstrap(
    root,
    triple.claim,
    triple.playerHostReservation,
    triple.aiClientReservation,
  );
  const readRecord = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(ownerPath(root), "utf8")) as Record<string, unknown>;
  const decode = (frame: Uint8Array): Record<string, unknown> => JSON.parse(new TextDecoder().decode(frame)) as Record<string, unknown>;
  const actor = "7b1f0c0e-1e6a-4d5a-9f2b-2a6d5e0c9a11";
  const conversations: RecordedRecovery[] = [];
  const session: DesktopGuardianSession = Object.freeze({
    arm: async () => ack("arm"),
    launch: async (input) => ack("launch", input.role),
    contain: async (input) => ack("contain", input.role),
    recover: async (input) => {
      const preCas = decode(input.preCasFrame);
      const beforeCas = await readRecord();
      // The durable recovering CAS may only run while the gate is held, and the
      // successor facts the caller reads back are the post-CAS binding.
      const postCas = decode(await input.beginRecovery());
      const afterCas = await readRecord();
      const roleCasOrder: string[] = [];
      await input.roleContained("playerHost");
      roleCasOrder.push("playerHost");
      await input.roleContained("aiClient");
      roleCasOrder.push("aiClient");
      conversations.push({
        actor: input.recoveryInstanceId,
        preCas,
        postCas,
        stateBeforeCas: beforeCas.state,
        revisionBeforeCas: beforeCas.ownerRecordRevision,
        stateAfterCas: afterCas.state,
        revisionAfterCas: afterCas.ownerRecordRevision,
        roleCasOrder,
      });
      return Object.freeze({ outcome: "contained" as const });
    },
    close: async () => {},
  });
  const teardown = containedRuntimeTeardownFromCollaborator(
    createStardewPlayerHostRuntimeLaunchCollaboratorFactory(createDesktopGuardianGameRuntimePlatform(session)),
  );

  const outcome = await teardown.recover(owner, {
    recoveryInstanceId: actor,
    readRecoveryBinding: async () => recoveryBindingFacts(await readRecord()),
  });
  assert.deepEqual(outcome, { status: "recovered" });

  assert.equal(conversations.length, 1);
  const conversation = conversations[0]!;
  assert.equal(conversation.actor, actor);
  // The gate body is the exact owner's consumed Guardian binding. The request
  // carries no gate facts at all, so a caller cannot substitute the correlation
  // the native gate must acquire.
  assert.deepEqual(conversation.preCas, {
    guardianInstanceId: expectedGuardianBinding().guardianInstanceId,
    guardianEpoch: expectedGuardianBinding().guardianEpoch,
    attemptId: "bootstrap-1",
    bindingRevision: guardianRevision,
    leaseName: expectedGuardianBinding().leaseName,
  });
  assert.equal("token" in conversation.preCas, false);
  // The durable `recovering` CAS ran after the gate opened and before the
  // post-CAS body was produced.
  assert.deepEqual(
    { state: conversation.stateBeforeCas, revision: conversation.revisionBeforeCas },
    { state: "reserved", revision: 1 },
  );
  assert.deepEqual(
    { state: conversation.stateAfterCas, revision: conversation.revisionAfterCas },
    { state: "recovering", revision: 2 },
  );
  // The post-CAS body is the successor record the caller read back after the
  // CAS, encoded by the composition — never a caller-supplied frame.
  assert.deepEqual(conversation.postCas, {
    guardianInstanceId: expectedGuardianBinding().guardianInstanceId,
    guardianEpoch: expectedGuardianBinding().guardianEpoch,
    attemptId: "bootstrap-1",
    recoveryInstanceId: actor,
    bindingRevision: guardianRevision,
    ownerRecordRevision: 2,
    leaseName: expectedGuardianBinding().leaseName,
    playerJobName: expectedGuardianBinding().playerJobName,
    aiJobName: expectedGuardianBinding().aiJobName,
    playerHostState: "reserved",
    aiClientState: "reserved",
  });
  // One durable containment CAS per role the recovery classified, in order.
  assert.deepEqual(conversation.roleCasOrder, ["playerHost", "aiClient"]);
  // The drive is durable, not a projection: the attempt records the actor and
  // both roles (two role CASes after the begin CAS).
  const persisted = await readRecord();
  assert.deepEqual(
    {
      state: persisted.state,
      guardianState: persisted.guardianState,
      recovery: persisted.recoveryInstanceId,
      playerHost: persisted.playerHostState,
      aiClient: persisted.aiClientState,
      revision: persisted.ownerRecordRevision,
    },
    {
      state: "recovering",
      guardianState: "recovering",
      recovery: actor,
      playerHost: "contained",
      aiClient: "contained",
      revision: 4,
    },
  );
});

/**
 * A recovery that cannot be driven must refuse with a bounded machine-readable
 * error. Two ways it cannot be driven are covered here: a collaborator that does
 * not carry the owner-held recovery half at all (the direct-spawn test
 * reference, or any adapter without an exact owner binding), and an owner whose
 * one-shot Guardian binding another consumer already took. Neither may reach the
 * native session, and neither may mutate the durable record.
 *
 * A malformed recovery actor is the third refusal: it reaches a durable CAS and
 * one native frame field, so it must be rejected at this boundary instead of
 * becoming an uncertain native attempt.
 */
test("a recovery refuses with a bounded error when the collaborator cannot drive one or the owner binding is already consumed", async () => {
  const sessionCalls: string[] = [];
  const session: DesktopGuardianSession = Object.freeze({
    arm: async () => ack("arm"),
    launch: async (input) => ack("launch", input.role),
    contain: async (input) => ack("contain", input.role),
    recover: async () => {
      sessionCalls.push("recover");
      return Object.freeze({ outcome: "contained" as const });
    },
    close: async () => {},
  });
  const actor = "0a5c1e7b-2f3d-4a90-8c11-6d2b7e4f9a02";
  const readRecoveryBinding = async () => Object.freeze({});
  const harness = createHarness();
  const root = await createRoot();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostBootstrap(
    root,
    triple.claim,
    triple.playerHostReservation,
    triple.aiClientReservation,
  );
  const recordBefore = await readFile(ownerPath(root), "utf8");

  // (a) A collaborator without the owner-held recovery half: the test reference
  // shape. It keeps the contain/close/settle behavior it always had and only the
  // recovery member refuses.
  const plainCollaborator: StardewPlayerHostRuntimeLaunchCollaborator = Object.freeze({
    launchPlayerHost: async () => { throw new Error("test_reference_launch_unbound"); },
    launchAiClient: async () => { throw new Error("test_reference_launch_unbound"); },
    containPlayerHost: async () => { throw new Error("test_reference_contain_unbound"); },
    containAiClient: async () => { throw new Error("test_reference_contain_unbound"); },
    recovery: () => { throw new Error("test_reference_recovery_unbound"); },
    settle: async () => { throw new Error("test_reference_settle_unbound"); },
    close: async () => { throw new Error("test_reference_close_unbound"); },
  });
  const plainTeardown = containedRuntimeTeardownFromCollaborator(plainCollaborator);
  assert.equal(typeof plainTeardown.containAiClient, "function");
  assert.equal(typeof plainTeardown.settle, "function");
  await assert.rejects(
    async () => plainTeardown.recover(owner, { recoveryInstanceId: actor, readRecoveryBinding }),
    /stardew_contained_recovery_drive_unavailable/,
  );

  const realTeardown = containedRuntimeTeardownFromCollaborator(
    createStardewPlayerHostRuntimeLaunchCollaboratorFactory(createDesktopGuardianGameRuntimePlatform(session)),
  );

  // (b) A malformed actor is refused before any owner binding is consumed and
  // before any native frame is produced.
  await assert.rejects(
    async () => realTeardown.recover(owner, { recoveryInstanceId: "not-an-actor", readRecoveryBinding }),
    /stardew_owner_recovery_actor_invalid/,
  );

  // (c) The exact owner's one-shot Guardian binding was already consumed, so this
  // collaborator has no binding to project a gate correlation or a durable CAS
  // from. It refuses rather than driving a recovery against an invented binding.
  consumeStardewBootstrapGuardianOwnerBinding(createStardewBootstrapGuardianOwnerBinding(owner));
  await assert.rejects(
    async () => realTeardown.recover(owner, { recoveryInstanceId: actor, readRecoveryBinding }),
    /stardew_bootstrap_guardian_owner_binding_unavailable/,
  );

  assert.deepEqual(sessionCalls, []);
  assert.equal(await readFile(ownerPath(root), "utf8"), recordBefore, "a refused recovery writes nothing durable");
});

/**
 * A refused recovery must arrive as a REJECTION on the value the collaborator
 * returns, never as a synchronous throw out of the call itself.
 *
 * The reason this is a separate guarantee from the bounded error code: the
 * product forwards this member through `containedRuntimeTeardownFromCollaborator`,
 * which returns `recoveryDriver.recover(owner, request)` unchanged from a
 * non-async arrow and attaches no try/catch of its own. A consumer of that seam
 * either awaits it or attaches a rejection handler and no catch block, so a
 * synchronous throw from the composition guard would not be the rejection those
 * consumers observe — it would escape their frame as an unhandled exception.
 * The defect this pins: `recover` was declared to return
 * `Promise<RedactedRecoveryOutcome>` (as `StardewOwnerRecoveryDriver` requires)
 * but was not `async`, so its actor validation threw before a promise existed.
 */
test("a refused recovery rejects the returned promise instead of throwing synchronously at the caller", async () => {
  const sessionCalls: string[] = [];
  const session: DesktopGuardianSession = Object.freeze({
    arm: async () => ack("arm"),
    launch: async (input) => ack("launch", input.role),
    contain: async (input) => ack("contain", input.role),
    recover: async () => {
      sessionCalls.push("recover");
      return Object.freeze({ outcome: "contained" as const });
    },
    close: async () => {},
  });
  const harness = createHarness();
  const root = await createRoot();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostBootstrap(
    root,
    triple.claim,
    triple.playerHostReservation,
    triple.aiClientReservation,
  );
  const recordBefore = await readFile(ownerPath(root), "utf8");
  const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
    createDesktopGuardianGameRuntimePlatform(session),
  );

  // The call is deliberately made outside any `await` and any `try`, so a
  // synchronous throw on the next line fails this test as an out-of-band
  // exception rather than as a rejected promise.
  const returned = collaborator.recover(owner, {
    recoveryInstanceId: "not-an-actor",
    readRecoveryBinding: async () => Object.freeze({}),
  });
  // `.catch()`-only, exactly like the consumers above: no await, no try/catch.
  // A resolved promise would hand the unknown here instead of the refusal.
  const observed: unknown = await returned.catch((error: unknown) => error);
  assert.ok(observed instanceof Error, "the refusal arrives as an Error rejection");
  // The refusal is still the same bounded code; only the shape it travels in
  // changed from a synchronous throw to a rejection.
  assert.equal(observed.message, "stardew_owner_recovery_actor_invalid");

  // The same member has a second guard that used to throw synchronously: the
  // one-shot owner binding another consumer already took. It must arrive as a
  // rejection on the returned value for the same reason.
  consumeStardewBootstrapGuardianOwnerBinding(createStardewBootstrapGuardianOwnerBinding(owner));
  const consumedBindingReturned = collaborator.recover(owner, {
    recoveryInstanceId: "7b1f0c0e-1e6a-4d5a-9f2b-2a6d5e0c9a11",
    readRecoveryBinding: async () => Object.freeze({}),
  });
  const consumedBindingObserved: unknown = await consumedBindingReturned.catch((error: unknown) => error);
  assert.ok(consumedBindingObserved instanceof Error, "the consumed owner binding refuses as a rejection too");
  assert.equal(consumedBindingObserved.message, "stardew_bootstrap_guardian_owner_binding_unavailable");

  assert.deepEqual(sessionCalls, []);
  assert.equal(await readFile(ownerPath(root), "utf8"), recordBefore, "a refused recovery writes nothing durable");
});

/**
 * The native recovery conversation can fail after it already ran: the gate can
 * stay held by the previous lease, a role can be classified not contained, or
 * the transport can reject the conversation outright. None of those is
 * containment, so each must report `unavailable` and must not be re-driven —
 * an uncertain native recovery may already have mutated the attempt.
 */
test("a recovery that does not reach terminal containment fails closed and is never retried", async () => {
  const actor = "c4d9a3f1-58b2-4c67-9e0a-1b7f3d6c8e24";
  // The gate frame carries the record's immutable binding revision, which the
  // platform encodes only when it is the opaque GUID shape production uses.
  const guardianRevision = "b17f4d6a-9c02-4e51-8a3d-5f0c1e2b7a44";
  const scenarios: readonly Readonly<{
    name: string;
    recover: (input: DesktopGuardianRecovery) => Promise<GuardianRecoveryAck>;
    expectedRecord: Readonly<Record<string, unknown>>;
  }>[] = [
    {
      name: "the session rejects the recovery",
      recover: async () => { throw new Error("test_session_recovery_rejected"); },
      expectedRecord: { state: "reserved", revision: 1, recovery: null, playerHost: "reserved", aiClient: "reserved" },
    },
    {
      name: "the recovery gate is still held by the previous lease",
      recover: async () => Object.freeze({ outcome: "gate_held" as const }),
      expectedRecord: { state: "reserved", revision: 1, recovery: null, playerHost: "reserved", aiClient: "reserved" },
    },
    {
      name: "a classified role is not contained",
      recover: async (input) => {
        // The recovery ran, so the durable `recovering` CAS legitimately ran too;
        // only the role classification failed.
        await input.beginRecovery();
        return Object.freeze({ outcome: "role_classified" as const, role: "playerHost" as const, classification: "unavailable" as const });
      },
      expectedRecord: { state: "recovering", revision: 2, recovery: actor, playerHost: "reserved", aiClient: "reserved" },
    },
  ];

  for (const scenario of scenarios) {
    const harness = createHarness({ guardianRevisions: [guardianRevision] });
    const root = await createRoot();
    const triple = mintOwnedTriple(harness.composition);
    const owner = await harness.composition.reserveOwnedPlayerHostBootstrap(
      root,
      triple.claim,
      triple.playerHostReservation,
      triple.aiClientReservation,
    );
    const calls: string[] = [];
    const session: DesktopGuardianSession = Object.freeze({
      arm: async () => ack("arm"),
      launch: async (input) => ack("launch", input.role),
      contain: async (input) => ack("contain", input.role),
      recover: (input) => {
        calls.push("recover");
        return scenario.recover(input);
      },
      close: async () => {},
    });
    const teardown = containedRuntimeTeardownFromCollaborator(
      createStardewPlayerHostRuntimeLaunchCollaboratorFactory(createDesktopGuardianGameRuntimePlatform(session)),
    );

    const outcome = await teardown.recover(owner, {
      recoveryInstanceId: actor,
      readRecoveryBinding: async () =>
        recoveryBindingFacts(JSON.parse(await readFile(ownerPath(root), "utf8")) as Record<string, unknown>),
    });
    assert.deepEqual(outcome, { status: "unavailable" }, scenario.name);
    assert.equal(calls.length, 1, `${scenario.name}: the failure is not retried`);
    const record = JSON.parse(await readFile(ownerPath(root), "utf8")) as Record<string, unknown>;
    assert.deepEqual(
      {
        state: record.state,
        revision: record.ownerRecordRevision,
        recovery: record.recoveryInstanceId,
        playerHost: record.playerHostState,
        aiClient: record.aiClientState,
      },
      scenario.expectedRecord,
      scenario.name,
    );
  }
});
