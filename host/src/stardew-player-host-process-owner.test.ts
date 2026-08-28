import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type {
  StardewAiClientProcessProbe,
  StardewAiClientProcessSpawn,
} from "./stardew-ai-client-process-owner.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import type {
  StardewPlayerHostLaunchReservation,
  StardewPlayerHostProcessProbe,
  StardewPlayerHostProcessSpawn,
} from "./stardew-player-host-process-owner.js";
import {
  bindStardewPrivateBootstrapOwnerTestSupport,
  createStardewPrivateBootstrapComposerTestSupport,
} from "./stardew-private-bootstrap-composer.test-support.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";

type AssertFalse<T extends false> = T;
type ReservationCannotBeStructurallyMinted = AssertFalse<
  {} extends StardewPlayerHostLaunchReservation ? true : false
>;
void (0 as unknown as ReservationCannotBeStructurallyMinted);

const PLAYER_EXE = process.platform === "win32"
  ? "C:\\GameBuddy\\player-host\\StardewModdingAPI.exe"
  : "/gamebuddy/player-host/StardewModdingAPI";
const PLAYER_CWD = process.platform === "win32"
  ? "C:\\GameBuddy\\player-host"
  : "/gamebuddy/player-host";
const PLAYER_CREATION = "20250203040506.000000+000";
const AI_CREATION = "20250102030405.000000+000";

type PlayerProbeResult = ReturnType<StardewPlayerHostProcessProbe>;
type PlayerSpawnCall = Readonly<{
  executable: string;
  args: readonly string[];
  options: Parameters<StardewPlayerHostProcessSpawn>[2];
}>;

function createHarness(input: Readonly<{
  playerProbe?: (pid: number, call: number) => PlayerProbeResult;
  playerProbeThrows?: (call: number) => boolean;
  playerKill?: (call: number) => boolean;
  playerKillThrows?: (call: number) => boolean;
  playerPid?: number;
}> = {}) {
  const playerSpawnCalls: PlayerSpawnCall[] = [];
  const playerProbeCalls: number[] = [];
  const playerKillCalls: number[] = [];
  let playerProbeCall = 0;
  let playerKillCall = 0;
  let bootstrapIdentity = 0;
  let aiGeneration = 0;
  let playerGeneration = 0;
  const playerPid = input.playerPid ?? 5432;

  const rawPlayerHostSpawn: StardewPlayerHostProcessSpawn = (executable, args, options) => {
    playerSpawnCalls.push({ executable, args: [...args], options });
    return Object.freeze({
      pid: playerPid,
      kill() {
        const call = ++playerKillCall;
        playerKillCalls.push(call);
        if (input.playerKillThrows?.(call) === true) throw new Error("kill_threw");
        return input.playerKill?.(call) ?? true;
      },
    });
  };
  const rawPlayerHostProbe: StardewPlayerHostProcessProbe = (pid) => {
    playerProbeCalls.push(pid);
    const call = ++playerProbeCall;
    if (input.playerProbeThrows?.(call) === true) throw new Error("probe_threw");
    return input.playerProbe === undefined
      ? { pid, creationDate: PLAYER_CREATION }
      : input.playerProbe(pid, call);
  };
  const rawSpawn: StardewAiClientProcessSpawn = () => Object.freeze({
    pid: 4321,
    kill: () => true,
  });
  const rawProbe: StardewAiClientProcessProbe = (pid) => ({ pid, creationDate: AI_CREATION });
  const composition = createStardewPrivateBootstrapComposerTestSupport({
    rawSpawn,
    rawProbe,
    rawPlayerHostSpawn,
    rawPlayerHostProbe,
    createBootstrapIdentity: () => `bootstrap-player-owner-${++bootstrapIdentity}`,
    createLaunchGeneration: () => `ai-generation-${++aiGeneration}`,
    createPlayerHostLaunchGeneration: () => `player-generation-${++playerGeneration}`,
    nowMs: () => 1_000,
  });
  return {
    composition,
    owner: composition.playerHostProcessOwner,
    playerSpawnCalls,
    playerProbeCalls,
    playerKillCalls,
  };
}

test("Player Host owner exposes only a distinct redacted reserve/read/stop API", () => {
  const { composition, owner } = createHarness();

  assert.deepEqual(Object.keys(owner).sort(), [
    "readStatus",
    "reservePlayerHostLaunch",
    "stopOwnedPlayerHost",
  ]);
  assert.equal(Object.isFrozen(owner), true);
  assert.equal("launch" in owner, false);
  assert.equal("register" in owner, false);
  assert.equal("generation" in owner, false);
  assert.equal(owner === (composition.aiClientProcessOwner as unknown), false);
  assert.deepEqual(owner.readStatus(), { kind: "idle" });
});

test("Player Host reservation is frozen, empty, nominal, and singular", () => {
  const { owner } = createHarness();
  const reservation = owner.reservePlayerHostLaunch();

  assert.equal(Object.isFrozen(reservation), true);
  assert.deepEqual(Reflect.ownKeys(reservation), []);
  assert.deepEqual(owner.readStatus(), { kind: "player_host_launch_pending" });
  assert.throws(
    () => owner.reservePlayerHostLaunch(),
    /owned_player_host_launch_already_active/,
  );
});

test("structural Player Host reservation lookalike is rejected by the closed join", async () => {
  const harness = createHarness();
  const claim = mintClaim(harness.composition);
  const aiReservation = harness.composition.aiClientProcessOwner.reserveAiClientLaunch();
  harness.owner.reservePlayerHostLaunch();

  await assert.rejects(
    harness.composition.reserveOwnedPlayerHostPhaseA(
      await createRoot(),
      claim,
      Object.freeze({}) as StardewPlayerHostLaunchReservation,
      aiReservation,
    ),
    /stardew_player_host_reservation_not_registered/,
  );
});

test("launch injects only manager generation with exact input and hardened direct spawn", async () => {
  const harness = createHarness();
  const phaseOwner = await reserveOwned(harness);

  const result = bindStardewPrivateBootstrapOwnerTestSupport(phaseOwner, harness.composition).consumePlayerHostLaunch((launch) => launch({
    executable: PLAYER_EXE,
    args: ["--mods-path", "private-mods"],
    cwd: PLAYER_CWD,
  }));

  assert.deepEqual(result, { status: { kind: "awaiting_player_host_attestation" } });
  assert.equal(harness.playerSpawnCalls.length, 1);
  const call = harness.playerSpawnCalls[0]!;
  assert.equal(call.executable, PLAYER_EXE);
  assert.deepEqual(call.args, ["--mods-path", "private-mods"]);
  assert.equal(call.options.cwd, PLAYER_CWD);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(
    call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION,
    "player-generation-1",
  );
  assert.deepEqual(harness.playerProbeCalls, [5432]);
  assert.deepEqual(harness.owner.readStatus(), { kind: "awaiting_player_host_attestation" });
  assert.equal(JSON.stringify(harness.owner.readStatus()).includes("5432"), false);
  assert.equal(JSON.stringify(harness.owner.readStatus()).includes(PLAYER_CREATION), false);
});

test("caller cannot supply Player Host environment or generation fields", async () => {
  const harness = createHarness();
  const phaseOwner = await reserveOwned(harness);

  assert.throws(
    () => bindStardewPrivateBootstrapOwnerTestSupport(phaseOwner, harness.composition).consumePlayerHostLaunch((launch) => launch({
      executable: PLAYER_EXE,
      args: ["start"],
      env: { GAMEBUDDY_STARDEW_LAUNCH_GENERATION: "caller-generation" },
    } as never)),
    /invalid_player_host_launch_input_keys/,
  );
  assert.deepEqual(harness.playerSpawnCalls, []);
  assert.deepEqual(harness.owner.readStatus(), { kind: "idle" });
});

test("immediate identity failures kill only the exact spawned handle and accept no ownership", async () => {
  for (const scenario of [
    { name: "missing", probe: () => null, error: /player_host_probe_failed_no_process/ },
    {
      name: "pid-mismatch",
      probe: () => ({ pid: 9999, creationDate: PLAYER_CREATION }),
      error: /player_host_probe_pid_mismatch/,
    },
    {
      name: "missing-creation",
      probe: (pid: number) => ({ pid, creationDate: "" }),
      error: /player_host_probe_invalid_creation_identity/,
    },
  ] as const) {
    const harness = createHarness({ playerProbe: scenario.probe });
    const phaseOwner = await reserveOwned(harness);
    assert.throws(
      () => bindStardewPrivateBootstrapOwnerTestSupport(phaseOwner, harness.composition).consumePlayerHostLaunch((launch) => launch({
        executable: PLAYER_EXE,
        args: [scenario.name],
      })),
      scenario.error,
    );
    assert.deepEqual(harness.playerKillCalls, [1]);
    assert.deepEqual(harness.owner.readStatus(), { kind: "idle" });
  }
});

test("throwing immediate Player Host probe kills the exact spawned handle", async () => {
  const harness = createHarness({ playerProbeThrows: (call) => call === 1 });
  const phaseOwner = await reserveOwned(harness);

  assert.throws(
    () => bindStardewPrivateBootstrapOwnerTestSupport(phaseOwner, harness.composition).consumePlayerHostLaunch((launch) => launch({
      executable: PLAYER_EXE,
      args: ["probe-throws"],
    })),
    /player_host_probe_failed_no_process/,
  );
  assert.deepEqual(harness.playerKillCalls, [1]);
  assert.deepEqual(harness.owner.readStatus(), { kind: "idle" });
});

test("invalid spawned Player Host pid is killed before ownership is accepted", async () => {
  const harness = createHarness({ playerPid: 0 });
  const phaseOwner = await reserveOwned(harness);

  assert.throws(
    () => bindStardewPrivateBootstrapOwnerTestSupport(phaseOwner, harness.composition).consumePlayerHostLaunch((launch) => launch({
      executable: PLAYER_EXE,
      args: ["bad-pid"],
    })),
    /spawned_player_host_child_missing_valid_pid/,
  );
  assert.deepEqual(harness.playerKillCalls, [1]);
  assert.deepEqual(harness.owner.readStatus(), { kind: "idle" });
});

test("stop fresh-reprobes exact PID and CreationDate before exact-handle kill", async () => {
  const harness = createHarness();
  const phaseOwner = await reserveOwned(harness);
  bindStardewPrivateBootstrapOwnerTestSupport(phaseOwner, harness.composition).consumePlayerHostLaunch((launch) => launch({
    executable: PLAYER_EXE,
    args: ["start"],
  }));

  assert.deepEqual(harness.owner.stopOwnedPlayerHost(), { kind: "terminated", killed: true });
  assert.deepEqual(harness.playerProbeCalls, [5432, 5432]);
  assert.deepEqual(harness.playerKillCalls, [1]);
  assert.deepEqual(harness.owner.readStatus(), { kind: "player_host_stopped" });
  assert.deepEqual(harness.owner.stopOwnedPlayerHost(), { kind: "already_stopped", killed: false });
});

test("stop probe mismatch or absence never kills and preserves ownership for retry", async () => {
  let stopProbe: "mismatch" | "absent" | "exact" = "mismatch";
  const harness = createHarness({
    playerProbe: (pid, call) => {
      if (call === 1 || stopProbe === "exact") return { pid, creationDate: PLAYER_CREATION };
      if (stopProbe === "absent") return null;
      return { pid, creationDate: "different-creation" };
    },
  });
  const phaseOwner = await reserveOwned(harness);
  bindStardewPrivateBootstrapOwnerTestSupport(phaseOwner, harness.composition).consumePlayerHostLaunch((launch) => launch({ executable: PLAYER_EXE, args: ["start"] }));

  assert.deepEqual(harness.owner.stopOwnedPlayerHost(), { kind: "identity_mismatch", killed: false });
  assert.deepEqual(harness.playerKillCalls, []);
  stopProbe = "absent";
  assert.deepEqual(harness.owner.stopOwnedPlayerHost(), { kind: "identity_probe_failed", killed: false });
  assert.deepEqual(harness.playerKillCalls, []);
  assert.throws(
    () => harness.owner.reservePlayerHostLaunch(),
    /owned_player_host_launch_already_active/,
  );
  stopProbe = "exact";
  assert.deepEqual(harness.owner.stopOwnedPlayerHost(), { kind: "terminated", killed: true });
});

test("throwing stop probe never kills and preserves Player Host ownership", async () => {
  let throwOnStop = true;
  const harness = createHarness({ playerProbeThrows: (call) => call > 1 && throwOnStop });
  const phaseOwner = await reserveOwned(harness);
  bindStardewPrivateBootstrapOwnerTestSupport(phaseOwner, harness.composition).consumePlayerHostLaunch((launch) => launch({ executable: PLAYER_EXE, args: ["start"] }));

  assert.deepEqual(harness.owner.stopOwnedPlayerHost(), { kind: "identity_probe_failed", killed: false });
  assert.deepEqual(harness.playerKillCalls, []);
  assert.deepEqual(harness.owner.readStatus(), { kind: "awaiting_player_host_attestation" });
  throwOnStop = false;
  assert.deepEqual(harness.owner.stopOwnedPlayerHost(), { kind: "terminated", killed: true });
});

test("kill false and throw both preserve exact Player Host ownership for safe retry", async () => {
  let outcome: "false" | "throw" | "true" = "false";
  const harness = createHarness({
    playerKill: () => outcome === "true",
    playerKillThrows: () => outcome === "throw",
  });
  const phaseOwner = await reserveOwned(harness);
  bindStardewPrivateBootstrapOwnerTestSupport(phaseOwner, harness.composition).consumePlayerHostLaunch((launch) => launch({ executable: PLAYER_EXE, args: ["start"] }));

  assert.deepEqual(harness.owner.stopOwnedPlayerHost(), { kind: "termination_failed", killed: false });
  outcome = "throw";
  assert.deepEqual(harness.owner.stopOwnedPlayerHost(), { kind: "termination_failed", killed: false });
  assert.deepEqual(harness.owner.readStatus(), { kind: "awaiting_player_host_attestation" });
  outcome = "true";
  assert.deepEqual(harness.owner.stopOwnedPlayerHost(), { kind: "terminated", killed: true });
  assert.deepEqual(harness.playerKillCalls, [1, 2, 3]);
});

function mintClaim(composition: ReturnType<typeof createHarness>["composition"]) {
  return composition.broker.confirm({
    playerId: "player-1",
    companionId: "companion-1",
    browserSessionId: "browser-1",
    expiresAtMs: 5_000,
  }).consume("browser-1");
}

async function reserveOwned(harness: ReturnType<typeof createHarness>) {
  const claim = mintClaim(harness.composition);
  const playerReservation = harness.owner.reservePlayerHostLaunch();
  const aiReservation = harness.composition.aiClientProcessOwner.reserveAiClientLaunch();
  return harness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(),
    claim,
    playerReservation,
    aiReservation,
  );
}

const temporaryRoots: string[] = [];
test.beforeEach(() => bindWindowsStaleLockReclaimer(
  createTestWindowsStaleLockReclaimer(simulatedLockHelper),
));
test.after(() => bindWindowsStaleLockReclaimer(undefined));
test.after(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-player-host-owner-test-"));
  temporaryRoots.push(root);
  return root;
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
