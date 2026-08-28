import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StardewAiClientProcessOwner } from "./stardew-ai-client-process-owner.js";
import type { StardewPlayerHostProcessOwner, StardewPlayerHostProcessStatus } from "./stardew-player-host-process-owner.js";
import { StardewAttachmentFlow } from "./stardew-attachment.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import type { StardewExternalPlayerHostPhaseAOwner } from "./stardew-private-bootstrap-composer.js";
import { createStardewPrivateBootstrapComposerTestSupport } from "./stardew-private-bootstrap-composer.test-support.js";
import {
  createStardewRoleLifecycleFacade,
  type StardewRoleLifecycleView,
} from "./stardew-role-lifecycle-facade.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";

const SESSION_TOKEN = "test-session-token-012345";
const EXE = process.platform === "win32" ? "C:\\GameBuddy\\ai-client.exe" : "/gamebuddy/ai-client";
const CREATION = "20250102030405.000000+000";

const baseSession = {
  schemaVersion: 1,
  integrationId: "stardew",
  integrationVersion: "0.1.0",
  gameVersion: "1.6.15",
  gameBuildNumber: 24356,
  smapiVersion: "4.5.2",
  multiplayerProtocol: "1.6.15",
  endpoint: "127.0.0.1:24642",
  saveId: "save_01",
  worldId: "world_01",
  hostPlayerId: "world_01",
  runtimeRole: "player_host",
  launchGeneration: "player-host-generation-01",
  publishedAtUnixMs: 1_000,
  expiresAtUnixMs: 20_000,
  nonce: "nonce_01",
  state: "ready",
  cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "", boundCompanionId: "", isBusy: false }],
  signature: "",
};

function signed<T extends { signature: string }>(value: T): T {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signature;
  return {
    ...value,
    signature: createHmac("sha256", SESSION_TOKEN)
      .update(JSON.stringify(unsigned), "utf8")
      .digest("base64url"),
  };
}

async function withFixture(
  run: (fixture: {
    directory: string;
    owner: StardewAiClientProcessOwner;
    phaseOwner: StardewExternalPlayerHostPhaseAOwner;
    facade: ReturnType<typeof createStardewRoleLifecycleFacade>;
    probes: Map<number, { pid: number; creationDate: string } | null>;
    kills: number[];
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-lifecycle-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "gamebuddy-lifecycle-owner-"));
  const probes = new Map<number, { pid: number; creationDate: string } | null>();
  const kills: number[] = [];
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedLockHelper));
  try {
    const composition = createStardewPrivateBootstrapComposerTestSupport({
      rawSpawn: () => Object.freeze({
        pid: 4321,
        kill() {
          kills.push(4321);
          return true;
        },
      }),
      rawProbe: (pid) => probes.get(pid) ?? null,
      rawPlayerHostSpawn: () => { throw new Error("unexpected_player_host_spawn"); },
      rawPlayerHostProbe: () => null,
      createBootstrapIdentity: () => "lifecycle-bootstrap",
      createLaunchGeneration: () => "lifecycle-generation",
      createPlayerHostLaunchGeneration: () => "unused-player-host-generation",
      nowMs: () => 1_000,
    });
    const claim = composition.broker.confirm({
      playerId: "player-1",
      companionId: "companion-1",
      browserSessionId: "browser-1",
      expiresAtMs: 5_000,
    }).consume("browser-1");
    const reservation = composition.aiClientProcessOwner.reserveAiClientLaunch();
    const phaseOwner = await composition.reserveExternalPlayerHostPhaseA(
      runtimeRoot,
      claim,
      reservation,
    );
    const facade = createStardewRoleLifecycleFacade(
      new StardewAttachmentFlow({
        sessionDirectory: directory,
        sessionToken: SESSION_TOKEN,
        companionId: "companion_01",
        nowMs: () => 2_000,
      }),
      composition.aiClientProcessOwner,
    );
    await run({
      directory,
      owner: composition.aiClientProcessOwner,
      phaseOwner,
      facade,
      probes,
      kills,
    });
  } finally {
    bindWindowsStaleLockReclaimer(undefined);
    await rm(directory, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

function assertView(
  view: StardewRoleLifecycleView,
  playerHost: unknown,
  aiClient: unknown,
): void {
  assert.deepEqual(view, { schemaVersion: 1, playerHost, aiClient });
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.playerHost), true);
  assert.equal(Object.isFrozen(view.aiClient), true);
}

test("direct-owned Player Host pending, awaiting, and stopped states remain truthful", async () => {
  await withFixture(async ({ owner }) => {
    let status: StardewPlayerHostProcessStatus = { kind: "player_host_launch_pending" };
    const playerOwner: StardewPlayerHostProcessOwner = Object.freeze({
      readStatus: () => status,
      reservePlayerHostLaunch: () => { throw new Error("not_exposed_by_facade"); },
      stopOwnedPlayerHost: () => ({ kind: "no_owned_player_host" as const, killed: false as const }),
    });
    const facade = createStardewRoleLifecycleFacade(null, owner, playerOwner);
    assert.deepEqual((await facade.readRoleLifecycleView()).playerHost, {
      state: "pending", ownership: "gamebuddy_direct_spawn",
    });
    status = { kind: "awaiting_player_host_attestation" };
    assert.deepEqual((await facade.readRoleLifecycleView()).playerHost, {
      state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn",
    });
    status = { kind: "player_host_stopped" };
    assert.deepEqual((await facade.readRoleLifecycleView()).playerHost, {
      state: "stopped", ownership: "gamebuddy_direct_spawn",
    });
  });
});

test("null attachment truthfully reports an unauthenticated idle lifecycle", async () => {
  await withFixture(async ({ owner }) => {
    const idle = createStardewRoleLifecycleFacade(null, owner);
    assertView(
      await idle.readRoleLifecycleView(),
      { state: "not_started", ownership: "none" },
      { state: "not_started", ownership: "none" },
    );
  });
});

test("facade delegates lifecycle projection and exposes no direct launch route", async () => {
  await withFixture(async ({ facade, owner }) => {
    assert.deepEqual(Object.keys(facade).sort(), []);
    assert.equal("launch" in facade, false);
    assert.equal("reserveAiClientLaunch" in facade, false);
    assert.deepEqual(Object.keys(owner).sort(), [
      "readStatus",
      "reserveAiClientLaunch",
      "stopOwnedAiClient",
    ]);

    assertView(
      await facade.readRoleLifecycleView(),
      { state: "unavailable", ownership: "player_external" },
      { state: "not_started", ownership: "none" },
    );
  });
});

test("facade observes launch performed only through closed-composition reservation owner", async () => {
  await withFixture(async ({ directory, phaseOwner, facade, probes }) => {
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(signed(baseSession)));
    probes.set(4321, { pid: 4321, creationDate: CREATION });

    phaseOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["farmhand"] }));
    assertView(
      await facade.readRoleLifecycleView(),
      {
        state: "authenticated",
        ownership: "player_external",
        compatibility: "compatible_unverified",
        attachmentAllowed: true,
      },
      {
        state: "awaiting_attestation",
        ownership: "gamebuddy_direct_spawn",
        lastStopOutcome: "none",
      },
    );
  });
});

test("stop delegates to exact process owner and only terminated projects stopped", async () => {
  await withFixture(async ({ phaseOwner, facade, probes, kills }) => {
    probes.set(4321, { pid: 4321, creationDate: CREATION });
    phaseOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["farmhand"] }));

    assert.deepEqual(facade.stopOwnedAiClient(), { kind: "terminated", killed: true });
    assert.deepEqual(kills, [4321]);
    assertView(
      await facade.readRoleLifecycleView(),
      { state: "unavailable", ownership: "player_external" },
      { state: "stopped", ownership: "gamebuddy_direct_spawn" },
    );
    assert.deepEqual(facade.stopOwnedAiClient(), { kind: "already_stopped", killed: false });
  });
});

test("identity failure remains awaiting and preserves ownership for retry", async () => {
  await withFixture(async ({ phaseOwner, facade, probes, kills }) => {
    probes.set(4321, { pid: 4321, creationDate: CREATION });
    phaseOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["farmhand"] }));
    probes.set(4321, { pid: 4321, creationDate: "different-creation" });

    assert.deepEqual(facade.stopOwnedAiClient(), { kind: "identity_mismatch", killed: false });
    assert.deepEqual(kills, []);
    assertView(
      await facade.readRoleLifecycleView(),
      { state: "unavailable", ownership: "player_external" },
      {
        state: "awaiting_attestation",
        ownership: "gamebuddy_direct_spawn",
        lastStopOutcome: "identity_unverified",
      },
    );

    probes.set(4321, { pid: 4321, creationDate: CREATION });
    assert.deepEqual(facade.stopOwnedAiClient(), { kind: "terminated", killed: true });
  });
});

test("player refresh failure never alters independently owned AI client", async () => {
  await withFixture(async ({ directory, phaseOwner, facade, probes }) => {
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(signed(baseSession)));
    probes.set(4321, { pid: 4321, creationDate: CREATION });
    phaseOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["farmhand"] }));

    const before = await facade.readRoleLifecycleView();
    assert.equal(before.playerHost.state, "authenticated");
    await rm(join(directory, "stardew-session.json"));
    assertView(
      await facade.readRoleLifecycleView(),
      { state: "unavailable", ownership: "player_external" },
      {
        state: "awaiting_attestation",
        ownership: "gamebuddy_direct_spawn",
        lastStopOutcome: "none",
      },
    );
  });
});

test("facade view stays categorical, immutable, and redacted", async () => {
  await withFixture(async ({ directory, phaseOwner, facade, probes }) => {
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(signed(baseSession)));
    probes.set(4321, { pid: 4321, creationDate: CREATION });
    phaseOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["secret-arg"] }));

    const view = await facade.readRoleLifecycleView();
    const serialized = JSON.stringify(view);
    for (const forbidden of [
      "4321",
      CREATION,
      "secret-arg",
      EXE,
      "endpoint",
      "nonce",
      "signature",
      "saveId",
      "worldId",
      "connected",
      "connecting",
      "attached",
      "ready",
      "active",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `must redact ${forbidden}`);
    }
  });
});

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
