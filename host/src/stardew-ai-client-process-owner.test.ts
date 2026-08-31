import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type {
  StardewAiClientLaunchReservation,
  StardewAiClientProcessProbe,
  StardewAiClientProcessSpawn,
} from "./stardew-ai-client-process-owner.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createStardewPrivateBootstrapComposerTestSupport } from "./stardew-private-bootstrap-composer.test-support.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";

type AssertFalse<T extends false> = T;
type ReservationCannotBeStructurallyMinted = AssertFalse<
  {} extends StardewAiClientLaunchReservation ? true : false
>;
void (0 as unknown as ReservationCannotBeStructurallyMinted);

const EXE = process.platform === "win32" ? "C:\\GameBuddy\\ai-client.exe" : "/gamebuddy/ai-client";
const CWD = process.platform === "win32" ? "C:\\GameBuddy" : "/gamebuddy";
const CREATION = "20250102030405.000000+000";

type ProbeResult = ReturnType<StardewAiClientProcessProbe>;

type SpawnCall = Readonly<{
  executable: string;
  args: readonly string[];
  options: Parameters<StardewAiClientProcessSpawn>[2];
}>;

function createHarness(input: Readonly<{
  probe?: (pid: number, call: number) => ProbeResult;
  kill?: (call: number) => boolean;
  pid?: number;
}> = {}) {
  const spawnCalls: SpawnCall[] = [];
  const probeCalls: number[] = [];
  const killCalls: number[] = [];
  let probeCall = 0;
  let killCall = 0;
  let generation = 0;
  const pid = input.pid ?? 4321;

  const rawSpawn: StardewAiClientProcessSpawn = (executable, args, options) => {
    spawnCalls.push({ executable, args: [...args], options });
    return Object.freeze({
      pid,
      kill() {
        killCalls.push(++killCall);
        return input.kill?.(killCall) ?? true;
      },
    });
  };
  const rawProbe: StardewAiClientProcessProbe = (probedPid) => {
    probeCalls.push(probedPid);
    const call = ++probeCall;
    return input.probe === undefined
      ? { pid: probedPid, creationDate: CREATION }
      : input.probe(probedPid, call);
  };
  const composition = createStardewPrivateBootstrapComposerTestSupport({
    rawSpawn,
    rawProbe,
    rawPlayerHostSpawn: rawSpawn,
    rawPlayerHostProbe: rawProbe,
    createBootstrapIdentity: () => "bootstrap-owner-test",
    createGuardianRevision: () => "guardian-revision-owner-test",
    createGuardianLeaseName: () => "Local\\GameBuddy-OwnerTest-Lease",
    createGuardianPlayerJobName: () => "Local\\GameBuddy-OwnerTest-Player",
    createGuardianAiJobName: () => "Local\\GameBuddy-OwnerTest-Ai",
    createLaunchGeneration: () => `generation-${++generation}`,
    createPlayerHostLaunchGeneration: () => `player-generation-${++generation}`,
    nowMs: () => 1_000,
  });
  return {
    composition,
    owner: composition.aiClientProcessOwner,
    spawnCalls,
    probeCalls,
    killCalls,
  };
}

test("AI process owner exposes only the redacted reserve/read/stop API", () => {
  const { owner } = createHarness();

  assert.deepEqual(Object.keys(owner).sort(), [
    "readStatus",
    "reserveAiClientLaunch",
    "stopOwnedAiClient",
  ]);
  assert.equal(Object.isFrozen(owner), true);
  assert.equal("launch" in owner, false);
  assert.equal("register" in owner, false);
  assert.equal("persist" in owner, false);
  assert.deepEqual(owner.readStatus(), { kind: "idle" });
});

test("reservation is a frozen empty nominal object and only one may be pending", () => {
  const { owner } = createHarness();
  const reservation = owner.reserveAiClientLaunch();

  assert.equal(Object.isFrozen(reservation), true);
  assert.deepEqual(Object.keys(reservation), []);
  assert.deepEqual(Reflect.ownKeys(reservation), []);
  assert.deepEqual(owner.readStatus(), { kind: "ai_client_launch_pending" });
  assert.throws(() => owner.reserveAiClientLaunch(), /owned_ai_client_launch_already_active/);
});

test("structural empty reservation lookalike is rejected by closed composition", async () => {
  const { composition, owner } = createHarness();
  const capability = composition.broker.confirm({
    playerId: "player-1",
    companionId: "companion-1",
    browserSessionId: "browser-1",
    expiresAtMs: 5_000,
  });
  const claim = capability.consume("browser-1");
  owner.reserveAiClientLaunch();

  await assert.rejects(
    composition.reserveExternalPlayerHostPhaseA(
      ".",
      claim,
      Object.freeze({}) as StardewAiClientLaunchReservation,
    ),
    /stardew_ai_client_reservation_not_registered/,
  );
});

test("launch uses exact executable/args/cwd, hardened spawn options, and manager generation env", async () => {
  const harness = createHarness();
  const claim = harness.composition.broker.confirm({
    playerId: "player-1",
    companionId: "companion-1",
    browserSessionId: "browser-1",
    expiresAtMs: 5_000,
  }).consume("browser-1");
  const reservation = harness.owner.reserveAiClientLaunch();
  const owner = await reserve(harness.composition, claim, reservation);

  const result = owner.consumeAiClientLaunch((launch) => launch({
    executable: EXE,
    args: ["--mode", "farmhand"],
    cwd: CWD,
  }));

  assert.deepEqual(result, { status: { kind: "awaiting_ai_client_attestation" } });
  assert.equal(harness.spawnCalls.length, 1);
  const call = harness.spawnCalls[0]!;
  assert.equal(call.executable, EXE);
  assert.deepEqual(call.args, ["--mode", "farmhand"]);
  assert.equal(call.options.cwd, CWD);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "generation-1");
  assert.deepEqual(harness.probeCalls, [4321]);
  assert.deepEqual(harness.owner.readStatus(), { kind: "awaiting_ai_client_attestation" });
});

test("spawn identity probe failures kill the exact spawned handle and expose no identity", async () => {
  for (const scenario of [
    { name: "missing", probe: () => null, error: /probe_failed_no_process/ },
    { name: "pid mismatch", probe: () => ({ pid: 9999, creationDate: CREATION }), error: /probe_pid_mismatch/ },
    { name: "missing creation", probe: (pid: number) => ({ pid, creationDate: "" }), error: /probe_invalid_creation_identity/ },
  ] as const) {
    const harness = createHarness({ probe: scenario.probe });
    const phaseOwner = await reserveFresh(harness);
    assert.throws(
      () => phaseOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: [scenario.name] })),
      scenario.error,
    );
    assert.deepEqual(harness.killCalls, [1]);
    const status = harness.owner.readStatus();
    assert.deepEqual(status, { kind: "idle" });
    assert.equal(JSON.stringify(status).includes("4321"), false);
    assert.equal(JSON.stringify(status).includes(CREATION), false);
  }
});

test("invalid spawned pid is killed before ownership is accepted", async () => {
  const harness = createHarness({ pid: 0 });
  const phaseOwner = await reserveFresh(harness);

  assert.throws(
    () => phaseOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["bad-pid"] })),
    /spawned_child_missing_valid_pid/,
  );
  assert.deepEqual(harness.killCalls, [1]);
  assert.deepEqual(harness.owner.readStatus(), { kind: "idle" });
});

test("stop re-probes exact PID and creation identity before killing", async () => {
  const harness = createHarness({
    probe: (pid, call) => call === 1
      ? { pid, creationDate: CREATION }
      : { pid, creationDate: CREATION },
  });
  const phaseOwner = await reserveFresh(harness);
  phaseOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["start"] }));

  assert.deepEqual(harness.owner.stopOwnedAiClient(), { kind: "terminated", killed: true });
  assert.deepEqual(harness.probeCalls, [4321, 4321]);
  assert.deepEqual(harness.killCalls, [1]);
  assert.deepEqual(harness.owner.readStatus(), { kind: "ai_client_stopped" });
  assert.deepEqual(harness.owner.stopOwnedAiClient(), { kind: "already_stopped", killed: false });
});

test("probe mismatch never kills and preserves ownership for a later safe retry", async () => {
  let exact = false;
  const harness = createHarness({
    probe: (pid, call) => {
      if (call === 1 || exact) return { pid, creationDate: CREATION };
      return { pid, creationDate: "different-creation" };
    },
  });
  const phaseOwner = await reserveFresh(harness);
  phaseOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["start"] }));

  assert.deepEqual(harness.owner.stopOwnedAiClient(), { kind: "identity_mismatch", killed: false });
  assert.deepEqual(harness.killCalls, []);
  assert.deepEqual(harness.owner.readStatus(), { kind: "awaiting_ai_client_attestation" });
  assert.throws(() => harness.owner.reserveAiClientLaunch(), /owned_ai_client_launch_already_active/);

  exact = true;
  assert.deepEqual(harness.owner.stopOwnedAiClient(), { kind: "terminated", killed: true });
  assert.deepEqual(harness.killCalls, [1]);
});

test("probe absence and termination failure preserve ownership for retry", async () => {
  let probeAvailable = false;
  let killSucceeds = false;
  const harness = createHarness({
    probe: (pid, call) => call === 1 || probeAvailable ? { pid, creationDate: CREATION } : null,
    kill: () => killSucceeds,
  });
  const phaseOwner = await reserveFresh(harness);
  phaseOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["start"] }));

  assert.deepEqual(harness.owner.stopOwnedAiClient(), { kind: "identity_probe_failed", killed: false });
  assert.deepEqual(harness.killCalls, []);
  probeAvailable = true;
  assert.deepEqual(harness.owner.stopOwnedAiClient(), { kind: "termination_failed", killed: false });
  assert.deepEqual(harness.killCalls, [1]);
  killSucceeds = true;
  assert.deepEqual(harness.owner.stopOwnedAiClient(), { kind: "terminated", killed: true });
  assert.deepEqual(harness.killCalls, [1, 2]);
});

async function reserveFresh(harness: ReturnType<typeof createHarness>) {
  const claim = harness.composition.broker.confirm({
    playerId: "player-1",
    companionId: "companion-1",
    browserSessionId: "browser-1",
    expiresAtMs: 5_000,
  }).consume("browser-1");
  const reservation = harness.owner.reserveAiClientLaunch();
  return reserve(harness.composition, claim, reservation);
}

const temporaryRoots: string[] = [];
test.beforeEach(() => bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedLockHelper)));
test.after(() => bindWindowsStaleLockReclaimer(undefined));
test.after(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function reserve(
  composition: ReturnType<typeof createHarness>["composition"],
  claim: Parameters<typeof composition.reserveExternalPlayerHostPhaseA>[1],
  reservation: Parameters<typeof composition.reserveExternalPlayerHostPhaseA>[2],
) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-owner-test-"));
  temporaryRoots.push(root);
  return composition.reserveExternalPlayerHostPhaseA(root, claim, reservation);
}

type HelperRequest = Readonly<{
  operation: "reclaim_stale_lock" | "release_owned_lock";
  token?: string;
  root: string;
  segments: readonly string[];
}>;

function simulatedLockHelper(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  child.stdin.on("data", (chunk: Buffer) => {
    void (async () => {
      const request = JSON.parse(chunk.toString("utf8")) as HelperRequest;
      let result = "indeterminate";
      if (request.operation === "release_owned_lock") {
        const path = resolve(request.root, ...request.segments);
        try {
          const value = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
          if (value.token === request.token) {
            await rm(path, { force: true });
            result = "released";
          } else {
            result = "kept_token_mismatch";
          }
        } catch {
          result = "missing";
        }
      }
      child.stdout.end(`${JSON.stringify({ schemaVersion: 1, result })}\n`);
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    })();
  });
  return child as unknown as ChildProcess;
}
