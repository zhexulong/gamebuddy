import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";

import {
  createComposedReferenceGameBrowserRequestHandler,
  issueComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserReadContext,
} from "./composed-reference-game-browser.js";
import { composeReferenceGameBrowserProfile } from "./composed-browser-contract/index.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import { composeTavernProfile, TavernBrowserFixtureV1 } from "./tavern/browser-contract/index.js";
import {
  createStardewProductionLifecycleCoordinatorForTesting,
  type StardewLifecycleCoordinatorTestingOverrides,
} from "./stardew-production-lifecycle-coordinator.test-support-internal.js";
import { createStardewProductionLifecycleCoordinator } from "./stardew-production-lifecycle-coordinator.internal.js";
import type { StardewPrivateBootstrapCoreDependencies } from "./stardew-private-bootstrap-composer.test-support-internal.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";

const bootstrapToken = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
const packageEntries = [
  "GameBuddy.Stardew.Core.dll",
  "GameBuddy.Stardew.deps.json",
  "GameBuddy.Stardew.dll",
  "Raffinert.FuzzySharp.dll",
  "manifest.json",
] as const;
const tavernProfile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.reference-pipeline",
  releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
  operationIds: ["chat.submit", "chat.cancel"],
  navigationItemIds: ["chat"],
});

const temporaryRoots: string[] = [];
type LockHelperRequest = Readonly<{
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
    const request = JSON.parse(chunk.toString("utf8")) as LockHelperRequest;
    void (async () => {
      let result = "indeterminate";
      if (request.operation === "release_owned_lock") {
        const path = resolve(request.root, ...request.segments);
        try {
          const parsed = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
          if (parsed.token === request.token) {
            await rm(path, { force: true });
            result = "released";
          } else {
            result = "kept_token_mismatch";
          }
        } catch (error) {
          result = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "kept_not_regular";
        }
      }
      child.stdout.end(`${JSON.stringify({ schemaVersion: 1, result })}\n`);
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    })();
  });
  return child as unknown as ChildProcess;
}
test.beforeEach(() => bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedLockHelper)));
test.after(() => bindWindowsStaleLockReclaimer(undefined));
test.after(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function stateForChat(context: ComposedReferenceGameBrowserReadContext) {
  const base = TavernBrowserFixtureV1.snapshot();
  return {
    ...base,
    build: { ...base.build, profileId: tavernProfile.profileId },
    csrfToken: context.csrfToken,
    browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function createAdmissionBroker() {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) { return stateForChat(context); },
  });
  const server = createServer((request, response) =>
    handler.handle(request, response, `http://127.0.0.1:${(server.address() as { port: number }).port}`),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bootstrap = await fetch(`${origin}/api/composed-reference-game/v1/bootstrap`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken }),
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  const root = await bootstrap.json() as { chat: { csrfToken: string } };
  const request = (): IncomingMessage => {
    const originUrl = new URL(origin);
    return {
      method: "POST",
      url: "/internal/lifecycle-activation",
      headers: {
        host: originUrl.host,
        origin,
        "content-type": "application/json",
        cookie,
        "x-csrf-token": root.chat.csrfToken,
      },
    } as unknown as IncomingMessage;
  };
  const issue = (): ComposedReferenceGameBrowserLifecycleActivationAdmission => {
    const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(
      handler.lifecycleActivationIssuer,
      request(),
      origin,
    );
    assert.notEqual(admission, null);
    return admission!;
  };
  return {
    handler,
    issue,
    async close() { await handler.close(); await closeServer(server); },
  };
}

async function createFixture(input: Readonly<{
  stagingGate?: Promise<void>;
  failStaging?: boolean;
  overrides?: StardewLifecycleCoordinatorTestingOverrides;
}> = {}) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "gamebuddy-lifecycle-coordinator-"));
  const packageRoot = join(runtimeRoot, "package");
  temporaryRoots.push(runtimeRoot);
  await mkdir(packageRoot);
  for (const entry of packageEntries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  const spawnCalls: string[] = [];
  const playerSpawnCalls: string[] = [];
  let packageReadCount = 0;
  const dependencies: StardewPrivateBootstrapCoreDependencies = {
    rawSpawn(executable) {
      spawnCalls.push(executable);
      return Object.freeze({ pid: 4101, kill: () => true });
    },
    rawProbe: (pid) => ({ pid, creationDate: "20260101010101.000000+000" }),
    rawPlayerHostSpawn(executable) {
      playerSpawnCalls.push(executable);
      return Object.freeze({ pid: 4102, kill: () => true });
    },
    rawPlayerHostProbe: (pid) => ({ pid, creationDate: "20260101010101.000000+000" }),
    createBootstrapIdentity: () => "bootstrap-coordinator-1",
    createLaunchGeneration: () => "ai-generation-1",
    createPlayerHostLaunchGeneration: () => "player-generation-1",
    nowMs: () => Date.now(),
    staging: {
      async readPackage() {
        packageReadCount += 1;
        if (input.stagingGate !== undefined) await input.stagingGate;
        if (input.failStaging) throw new Error("controlled-stage-b-failure");
        return { root: packageRoot, entries: packageEntries };
      },
      createSecret: () => "session-secret-coordinator-012345",
      nowMs: () => Date.now(),
    },
  };
  const manifest: HostDeploymentManifest = Object.freeze({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot,
    principal: Object.freeze({ continuityId: "continuity-1", playerId: "player-1", companionId: "companion-1" }),
    bootstrapOperationId: "request-1",
    authorityGeneration: 1,
  });
  const coordinator = createStardewProductionLifecycleCoordinatorForTesting(
    manifest,
    dependencies,
    input.overrides,
  );
  const broker = await createAdmissionBroker();
  coordinator.activationOwner.bindBrowserAdmissionIssuer(broker.handler.lifecycleActivationIssuer);
  return { runtimeRoot, coordinator, broker, spawnCalls, playerSpawnCalls, packageReadCount: () => packageReadCount };
}

async function ownerRecord(runtimeRoot: string) {
  return JSON.parse(await readFile(
    join(runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "owner.json"),
    "utf8",
  )) as { state: string; cleanupDisposition: string; managedPaths: string[] };
}

test("activation stages the durable Player Host profile without spawning and returns a frozen redacted revision-3 snapshot", async () => {
  const fixture = await createFixture();
  try {
    const admission = fixture.broker.issue();
    const activation = fixture.coordinator.activationOwner.activate(admission);
    const result = await activation.catch((error: unknown) => {
      throw error instanceof Error && error.cause instanceof Error ? error.cause : error;
    });
    assert.deepEqual(result, {
      schemaVersion: 1,
      requestId: "request-1",
      authorityGeneration: 1,
      revision: 3,
      state: "staged",
    });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(Object.keys(result).sort(), ["authorityGeneration", "requestId", "revision", "schemaVersion", "state"]);
    assert.equal(JSON.stringify(result).includes("bootstrap-coordinator-1"), false);
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerSpawnCalls, []);
    const owner = await ownerRecord(fixture.runtimeRoot);
    assert.equal(owner.state, "reserved");
    assert.equal(owner.managedPaths.includes("player-host/Mods/GameBuddy/config.json"), true);
    assert.equal(await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "player-host", "Mods", "GameBuddy", "GameBuddy.Stardew.dll"),
      "utf8",
    ), "fixed-GameBuddy.Stardew.dll");
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("same admission joins the exact activation Promise while a conflicting admission remains consumable", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = await createFixture({ stagingGate: gate });
  try {
    const accepted = fixture.broker.issue();
    const conflicting = fixture.broker.issue();
    const first = fixture.coordinator.activationOwner.activate(accepted);
    const joined = fixture.coordinator.activationOwner.activate(accepted);
    assert.equal(joined, first);
    await assert.rejects(fixture.coordinator.activationOwner.activate(conflicting), /stardew_lifecycle_activation_conflict/);
    release();
    await first;
    assert.equal(fixture.packageReadCount(), 2);
    const secondRuntimeRoot = await mkdtemp(join(tmpdir(), "gamebuddy-lifecycle-conflict-"));
    temporaryRoots.push(secondRuntimeRoot);
    const second = createStardewProductionLifecycleCoordinatorForTesting(
      Object.freeze({
        schemaVersion: 2,
        topology: "independent_chat_and_game_surfaces",
        runtimeRoot: secondRuntimeRoot,
        principal: Object.freeze({ continuityId: "continuity-2", playerId: "player-2", companionId: "companion-2" }),
        bootstrapOperationId: "request-2",
        authorityGeneration: 1,
      }),
      {
        rawSpawn: () => Object.freeze({ pid: 1, kill: () => true }), rawProbe: () => null,
        rawPlayerHostSpawn: () => Object.freeze({ pid: 2, kill: () => true }), rawPlayerHostProbe: () => null,
        createBootstrapIdentity: () => "bootstrap-conflict-2", createLaunchGeneration: () => "ai-2",
        createPlayerHostLaunchGeneration: () => "player-2", nowMs: () => Date.now(),
        staging: { readPackage: async () => { throw new Error("proof-consumed"); }, createSecret: () => "secret-conflict-012345", nowMs: () => Date.now() },
      },
    );
    second.activationOwner.bindBrowserAdmissionIssuer(fixture.broker.handler.lifecycleActivationIssuer);
    await assert.rejects(second.activationOwner.activate(conflicting), /stardew_lifecycle_activation_failed/);
    assert.equal(second.activationOwner.readPrivateActivationSnapshot().state, "failed");
    await second.close();
  } finally {
    release();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("Stage B failure transitions to failed, durably quarantines, and never spawns", async () => {
  const fixture = await createFixture({ failStaging: true });
  try {
    await assert.rejects(
      fixture.coordinator.activationOwner.activate(fixture.broker.issue()),
      /stardew_lifecycle_activation_failed/,
    );
    assert.deepEqual(fixture.coordinator.activationOwner.readPrivateActivationSnapshot(), {
      schemaVersion: 1, requestId: "request-1", authorityGeneration: 1, revision: 3, state: "failed",
    });
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerSpawnCalls, []);
    const owner = await ownerRecord(fixture.runtimeRoot);
    assert.equal(owner.state, "quarantined");
    assert.equal(owner.cleanupDisposition, "retry_required");
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("close during controlled staging drains, quarantines, terminalizes, and closes without spawning", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = await createFixture({ stagingGate: gate });
  try {
    const activation = fixture.coordinator.activationOwner.activate(fixture.broker.issue());
    while (fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state !== "staging") {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const close = fixture.coordinator.close();
    assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "closing");
    release();
    await assert.rejects(activation, /stardew_lifecycle_activation_failed/);
    await close;
    assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "closed");
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerSpawnCalls, []);
  } finally {
    release();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("aggregate close attempts every role and retry skips successful cleanup proofs", async () => {
  let brokerAttempts = 0;
  let aiAttempts = 0;
  let playerAttempts = 0;
  const fixture = await createFixture({
    overrides: {
      closeBroker(underlying) {
        brokerAttempts += 1;
        if (brokerAttempts === 1) throw new Error("controlled-broker-close-failure");
        underlying();
      },
      stopAiClient(underlying) {
        aiAttempts += 1;
        if (aiAttempts === 1) throw new Error("controlled-ai-stop-failure");
        return underlying();
      },
      stopPlayerHost(underlying) {
        playerAttempts += 1;
        return underlying();
      },
    },
  });
  try {
    await assert.rejects(fixture.coordinator.close(), /stardew_lifecycle_close_incomplete/);
    assert.deepEqual({ brokerAttempts, aiAttempts, playerAttempts }, { brokerAttempts: 1, aiAttempts: 1, playerAttempts: 1 });
    await fixture.coordinator.close();
    assert.deepEqual({ brokerAttempts, aiAttempts, playerAttempts }, { brokerAttempts: 2, aiAttempts: 2, playerAttempts: 1 });
    assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "closed");
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("production lifecycle construction is fail-closed off Windows", async () => {
  const manifest: HostDeploymentManifest = Object.freeze({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot: process.cwd(),
    principal: Object.freeze({ continuityId: "continuity-1", playerId: "player-1", companionId: "companion-1" }),
    bootstrapOperationId: "request-1",
    authorityGeneration: 1,
  });
  if (process.platform !== "win32") {
    await assert.rejects(
      () => Promise.resolve(createStardewProductionLifecycleCoordinator(manifest)),
      /stardew_private_bootstrap_composition_requires_windows/,
    );
  }
});
