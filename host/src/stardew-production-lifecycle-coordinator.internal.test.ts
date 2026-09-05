import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { publishStardewInstallationRegistration } from "./stardew-installation-registration.internal.js";

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
import { createTestWindowsReparseInspector } from "./windows-reparse-inspector/index.test-support.js";
import type { WindowsPathObjectIdentity } from "./windows-reparse-inspector/index.js";

const bootstrapToken = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
const gameDirectoryCandidate = "C:\\Games\\Stardew Valley";
const installationChain: readonly WindowsPathObjectIdentity[] = Object.freeze([
  Object.freeze({ objectKind: "directory", isReparsePoint: false, volumeIdentity: "0123456789abcdef", fileId: "00000000000000000000000000000001" }),
  Object.freeze({ objectKind: "directory", isReparsePoint: false, volumeIdentity: "0123456789abcdef", fileId: "00000000000000000000000000000002" }),
  Object.freeze({ objectKind: "directory", isReparsePoint: false, volumeIdentity: "0123456789abcdef", fileId: "00000000000000000000000000000003" }),
  Object.freeze({ objectKind: "regular_file", isReparsePoint: false, volumeIdentity: "0123456789abcdef", fileId: "00000000000000000000000000000004" }),
]);
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
function deferredVoid(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return Object.freeze({ promise, resolve });
}
type RecordedGameStop = Readonly<{ stopId: string; sourceEventId: string; reasonCode: string; locale?: string }>;
function connectedSemanticGameLeaseFixture(input: Readonly<{
  onAttachVoiceStopper?(): void;
  onActivate?(): void;
  onStop?(stop: RecordedGameStop): void;
  onCancelTask?(): void;
  stopSettled?: Promise<void>;
}> = {}) {
  let voiceStopperBound = false;
  return Object.freeze({
    piSessionId: "pi-session-stardew-test",
    gameSessionId: "game-session-stardew-test",
    host: Object.freeze({
      attachVoiceStopper(stopper: () => Promise<void>) {
        assert.equal(typeof stopper, "function");
        assert.equal(voiceStopperBound, false);
        voiceStopperBound = true;
        input.onAttachVoiceStopper?.();
      },
      stopAll(stop: RecordedGameStop) {
        assert.equal(voiceStopperBound, true);
        input.onStop?.(stop);
        return Object.freeze({
          admission: Object.freeze({}) as never,
          outcome: "no_active_turn" as const,
          settled: input.stopSettled ?? Promise.resolve(),
        });
      },
    }) as never,
    lifecycleSnapshot: () => Object.freeze({}) as never,
    activateCommittedIngress: () => input.onActivate?.(),
    dispatchPromptDefinedTask: async () => undefined,
    cancelPromptDefinedTask: () => input.onCancelTask?.(),
  }) as never;
}
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
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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

function installationInspector(
  chains: readonly (readonly WindowsPathObjectIdentity[])[],
  beforeResponse?: (readIndex: number) => Promise<void>,
) {
  let index = 0;
  return createTestWindowsReparseInspector(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    });
    child.stdin.on("data", () => void (async () => {
      const readIndex = index + 1;
      if (beforeResponse !== undefined) await beforeResponse(readIndex);
      const chain = chains[index++] ?? chains.at(-1) ?? installationChain;
      child.stdout.end(`${JSON.stringify({
        schemaVersion: 2,
        operation: "inspect_path_chain_v2",
        status: "ok",
        components: chain,
      })}\n`);
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    })());
    return child as unknown as ChildProcess;
  });
}

async function withWindowsPlatform<T>(operation: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try { return await operation(); }
  finally { Object.defineProperty(process, "platform", descriptor); }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
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
  const request = (operation: "lifecycle_activation" | "cabin_read" | "cabin_confirm" | "game_setup" | "game_launch" | "game_stop" | "game_disconnect"): IncomingMessage => {
    const originUrl = new URL(origin);
    const method = operation === "cabin_read" ? "GET" : "POST";
    const url = operation === "lifecycle_activation"
      ? "/api/composed-reference-game/v1/lifecycle/activate"
      : operation === "cabin_read"
        ? "/api/composed-reference-game/v1/game/stardew/cabins"
        : operation === "cabin_confirm"
          ? "/api/composed-reference-game/v1/game/stardew/cabins/confirm"
           : operation === "game_setup"
             ? "/api/composed-reference-game/v1/game/prerequisites/setup"
             : operation === "game_launch"
               ? "/api/composed-reference-game/v1/game/launch"
               : operation === "game_stop"
                 ? "/api/composed-reference-game/v1/game/stop"
                 : "/api/composed-reference-game/v1/game/disconnect";
    return {
      method,
      url,
      headers: {
        host: originUrl.host,
        origin,
        "content-type": "application/json",
        cookie,
        "x-csrf-token": root.chat.csrfToken,
      },
    } as unknown as IncomingMessage;
  };
  const issue = (
    operation: "lifecycle_activation" | "cabin_read" | "cabin_confirm" | "game_setup" | "game_launch" | "game_stop" | "game_disconnect" = "lifecycle_activation",
  ): ComposedReferenceGameBrowserLifecycleActivationAdmission => {
    const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(
      handler.lifecycleActivationIssuer,
      request(operation),
      origin,
    );
    assert.notEqual(admission, null);
    return admission!;
  };
  return {
    handler,
    issue,
    async close() {
      const handlerDrain = handler.close();
      server.closeAllConnections();
      await closeServer(server);
      await handlerDrain;
    },
  };
}

async function canonicalTemporaryRoot(prefix: string): Promise<string> {
  const parent = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof parent !== "string" || parent.length === 0) throw new Error("test_local_app_data_unavailable");
  return await mkdtemp(join(await realpath(parent), prefix));
}

async function createFixture(input: Readonly<{
  stagingGate?: Promise<void>;
  failStaging?: boolean;
  packageReadGateAt?: Readonly<{ count: number; promise: Promise<void> }>;
  failPackageReadAt?: number;
  overrides?: StardewLifecycleCoordinatorTestingOverrides;
  inspectorChains?: readonly (readonly WindowsPathObjectIdentity[])[];
  inspectorGate?: Promise<void>;
  playerSpawnFailure?: boolean;
  playerProbeFailure?: boolean;
  aiSpawnFailure?: boolean;
  aiProbeFailure?: boolean;
  playerKillResults?: readonly boolean[];
  gameRuntimeBindingCloseResults?: readonly boolean[];
  gameStopSettled?: Promise<void>;
  gameRuntimeTaskCancelError?: Error;
  afterIngressActivation?(): void;
  nowMs?: () => number;
  afterPlayerSpawn?(): void;
}> = {}) {
  const runtimeRoot = await canonicalTemporaryRoot("gamebuddy-lifecycle-coordinator-");
  const packageRoot = join(runtimeRoot, "package");
  temporaryRoots.push(runtimeRoot);
  await publishStardewInstallationRegistration(runtimeRoot, null, {
    schema: "gamebuddy-stardew-installation-registration/v1",
    binding: { rootLayoutVersion: 1, productInstallationId: "desktop-installation-1" },
    revision: 1,
    state: "ready",
    locator: gameDirectoryCandidate,
    activeAttempt: null,
  });
  await mkdir(packageRoot);
  for (const entry of packageEntries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  const spawnCalls: Array<Readonly<{
    executable: string;
    args: readonly string[];
    options: Readonly<{
      cwd?: string;
      shell: boolean;
      windowsHide: boolean;
      env: Readonly<NodeJS.ProcessEnv>;
    }>;
  }>> = [];
  const aiKillCalls: number[] = [];
  const playerSpawnCalls: Array<Readonly<{
    executable: string;
    args: readonly string[];
    options: Readonly<{
      cwd?: string;
      shell: boolean;
      windowsHide: boolean;
      env: Readonly<NodeJS.ProcessEnv>;
    }>;
  }>> = [];
  const playerKillCalls: number[] = [];
  const lifecycleOrder: string[] = [];
  const playerKillResults = [...(input.playerKillResults ?? [true])];
  const gameRuntimeBindingCloseResults = [...(input.gameRuntimeBindingCloseResults ?? [true])];
  const bridgeConnectCalls: Array<Readonly<{
    scope: Readonly<Record<string, string>>;
    pipeName: string;
    token: string;
    launchGeneration: string;
    deadlineMs: number;
  }>> = [];
  const bridgeCloseCalls: string[] = [];
  let gameRuntimeFacadeEnterCalls = 0;
  let gameRuntimeVoiceStopperAttachCalls = 0;
  let gameRuntimeIngressActivationCalls = 0;
  let gameRuntimeTaskCancelCalls = 0;
  const gameStopCalls: RecordedGameStop[] = [];
  let packageReadCount = 0;
  const dependencies: StardewPrivateBootstrapCoreDependencies = {
    rawSpawn(executable, args, options) {
      spawnCalls.push(Object.freeze({ executable, args: Object.freeze([...args]), options }));
      if (input.aiSpawnFailure) throw new Error("controlled-ai-spawn-failure");
      return Object.freeze({ pid: 4101, kill: () => {
        lifecycleOrder.push("ai");
        aiKillCalls.push(4101);
        return true;
      } });
    },
    rawProbe: (pid) => input.aiProbeFailure ? null : ({ pid, creationDate: "20260101010101.000000+000" }),
    rawPlayerHostSpawn(executable, args, options) {
      playerSpawnCalls.push(Object.freeze({ executable, args: Object.freeze([...args]), options }));
      input.afterPlayerSpawn?.();
      if (input.playerSpawnFailure) throw new Error("controlled-player-spawn-failure");
      return Object.freeze({
        pid: 4102,
        kill: () => {
          lifecycleOrder.push("player");
          playerKillCalls.push(4102);
          return playerKillResults.shift() ?? true;
        },
      });
    },
    rawPlayerHostProbe: (pid) => input.playerProbeFailure ? null : ({ pid, creationDate: "20260101010101.000000+000" }),
    createBootstrapIdentity: () => "bootstrap-coordinator-1",
    createGuardianRevision: () => "guardian-revision-coordinator-1",
    createGuardianInstanceId: () => "guardian-instance-coordinator-1",
    createGuardianEpoch: () => 1,
    createGuardianLeaseName: () => "Local\\GameBuddy-Coordinator-Lease-1",
    createGuardianPlayerJobName: () => "Local\\GameBuddy-Coordinator-Player-1",
    createGuardianAiJobName: () => "Local\\GameBuddy-Coordinator-Ai-1",
    createLaunchGeneration: () => "ai-generation-1",
    createPlayerHostLaunchGeneration: () => "player-generation-1",
    createBridgePipeName: () => "gamebuddy-stardew-coordinator-bridge",
    createBridgeToken: () => "coordinator-bridge-token-0123456789",
    nowMs: input.nowMs ?? (() => Date.now()),
    staging: {
      async readPackage() {
        packageReadCount += 1;
        if (input.packageReadGateAt?.count === packageReadCount) await input.packageReadGateAt.promise;
        if (input.failPackageReadAt === packageReadCount) throw new Error("controlled-package-read-failure");
        if (input.stagingGate !== undefined) await input.stagingGate;
        if (input.failStaging) throw new Error("controlled-stage-b-failure");
        return { root: packageRoot, entries: packageEntries };
      },
      createSecret: () => "session-secret-coordinator-012345",
      nowMs: input.nowMs ?? (() => Date.now()),
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
    {
      ...input.overrides,
      createInstallationInspector: input.overrides?.createInstallationInspector ?? (async () =>
        installationInspector(input.inspectorChains ?? [
          installationChain, installationChain, installationChain,
          installationChain, installationChain, installationChain,
        ],
          input.inspectorGate === undefined ? undefined : () => input.inspectorGate!)),
      connectFarmhandGameRuntimeFacade: input.overrides?.connectFarmhandGameRuntimeFacade ?? (async (connection, deadlineMs) => {
        bridgeConnectCalls.push(Object.freeze({
          scope: connection.scope,
          pipeName: connection.pipeName,
          token: connection.token,
          launchGeneration: connection.launchGeneration,
          deadlineMs,
        }));
        return Object.freeze({
          authority: "SEMANTIC" as const,
          runEnter: async () => {
            gameRuntimeFacadeEnterCalls += 1;
            return connectedSemanticGameLeaseFixture({
              onAttachVoiceStopper: () => { gameRuntimeVoiceStopperAttachCalls += 1; },
              onActivate: () => {
                gameRuntimeIngressActivationCalls += 1;
                input.afterIngressActivation?.();
              },
              onStop: (stop) => { gameStopCalls.push(stop); },
              onCancelTask: () => {
                gameRuntimeTaskCancelCalls += 1;
                if (input.gameRuntimeTaskCancelError !== undefined) throw input.gameRuntimeTaskCancelError;
              },
              stopSettled: input.gameStopSettled,
            });
          },
          recoverDeadOwner: async () => undefined,
          close: async () => {
            if (!(gameRuntimeBindingCloseResults.shift() ?? true))
              throw new Error("controlled_game_runtime_binding_close_failure");
            lifecycleOrder.push("bridge");
            bridgeCloseCalls.push("bridge");
          },
        });
      }),
    },
  );
  const broker = await createAdmissionBroker();
  coordinator.activationOwner.bindBrowserAdmissionIssuer(broker.handler.lifecycleActivationIssuer);
  return {
    runtimeRoot,
    coordinator,
    broker,
    spawnCalls,
    aiKillCalls,
    playerSpawnCalls,
    playerKillCalls,
    bridgeConnectCalls,
    bridgeCloseCalls,
    lifecycleOrder,
    gameRuntimeFacadeEnterCalls: () => gameRuntimeFacadeEnterCalls,
    gameRuntimeVoiceStopperAttachCalls: () => gameRuntimeVoiceStopperAttachCalls,
    gameRuntimeIngressActivationCalls: () => gameRuntimeIngressActivationCalls,
    gameRuntimeTaskCancelCalls: () => gameRuntimeTaskCancelCalls,
    gameStopCalls,
    packageReadCount: () => packageReadCount,
  };
}

type PublishedCabin = Readonly<{
  cabinId: string;
  ownerFarmhandId: string;
  boundCompanionId: string;
  isBusy: boolean;
}>;

async function publishSignedPlayerHostSession(
  runtimeRoot: string,
  launchGeneration = "player-generation-1",
  cabins: readonly PublishedCabin[] = [],
  expiresAtUnixMs = Date.now() + 60_000,
): Promise<void> {
  const sessionDirectory = join(
    runtimeRoot,
    "stardew-private-bootstrap",
    "bootstrap-coordinator-1",
    "session",
  );
  await mkdir(sessionDirectory, { recursive: true });
  const session = {
    schemaVersion: 1,
    integrationId: "stardew",
    integrationVersion: "0.1.0",
    gameVersion: "1.6.15",
    gameBuildNumber: 24356,
    smapiVersion: "4.5.2",
    multiplayerProtocol: "1.6.15",
    endpoint: "127.0.0.1:24642",
    saveId: "save-coordinator",
    worldId: "world-coordinator",
    publishedAtUnixMs: Date.now(),
    expiresAtUnixMs,
    nonce: "nonce-coordinator",
    state: "ready",
    hostPlayerId: "player-1",
    runtimeRole: "player_host",
    launchGeneration,
    cabins,
    signature: "",
  };
  const unsigned = { ...session };
  delete (unsigned as Partial<typeof session>).signature;
  const signature = createHmac("sha256", "session-secret-coordinator-012345")
    .update(JSON.stringify(unsigned), "utf8")
    .digest("base64url");
  await writeFile(join(sessionDirectory, "stardew-session.json"), JSON.stringify({ ...session, signature }));
}

function signAttachmentValue<T extends { signature: string }>(value: T): T {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signature;
  return {
    ...value,
    signature: createHmac("sha256", "session-secret-coordinator-012345")
      .update(JSON.stringify(unsigned), "utf8")
      .digest("base64url"),
  };
}

async function waitForAttachmentRequest(runtimeRoot: string): Promise<Record<string, unknown>> {
  const path = join(runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "session", "stardew-attachment-request.json");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
  throw new Error("wait_for_attachment_request_timeout");
}

async function publishAttachmentAdmission(runtimeRoot: string, request: Record<string, unknown>, cabin: PublishedCabin): Promise<void> {
  const directory = join(runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "session");
  const requestId = request.requestId as string;
  const now = Date.now();
  await writeFile(join(directory, "stardew-attachment-response.json"), JSON.stringify(signAttachmentValue({
    schemaVersion: 1,
    requestId,
    state: "ready",
    reasonCode: "manifest_issued",
    updatedAtUnixMs: now,
    manifestPath: "stardew-farmhand-manifest.json",
    signature: "",
  })));
  await writeFile(join(directory, "stardew-farmhand-manifest.json"), JSON.stringify(signAttachmentValue({
    schemaVersion: 1,
    requestId,
    integrationId: "stardew",
    integrationVersion: "0.1.0",
    gameVersion: "1.6.15",
    gameBuildNumber: 24356,
    smapiVersion: "4.5.2",
    multiplayerProtocol: "1.6.15",
    endpoint: "127.0.0.1:24642",
    saveId: "save-coordinator",
    worldId: "world-coordinator",
    companionId: "companion-1",
    farmhandId: cabin.ownerFarmhandId,
    cabinId: cabin.cabinId,
    sessionNonce: "nonce-coordinator",
    issuedAtUnixMs: now,
    expiresAtUnixMs: now + 30_000,
    signature: "",
  })));
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
    const secondRuntimeRoot = await canonicalTemporaryRoot("gamebuddy-lifecycle-conflict-");
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
        createBootstrapIdentity: () => "bootstrap-conflict-2",
        createGuardianRevision: () => "guardian-revision-conflict-2",
        createGuardianInstanceId: () => "guardian-instance-conflict-2",
        createGuardianEpoch: () => 1,
        createGuardianLeaseName: () => "Local\\GameBuddy-Conflict-Lease-2",
        createGuardianPlayerJobName: () => "Local\\GameBuddy-Conflict-Player-2",
        createGuardianAiJobName: () => "Local\\GameBuddy-Conflict-Ai-2",
        createLaunchGeneration: () => "ai-2",
        createPlayerHostLaunchGeneration: () => "player-2",
        createBridgePipeName: () => "gamebuddy-stardew-conflict-bridge",
        createBridgeToken: () => "conflict-bridge-token-0123456789",
        nowMs: () => Date.now(),
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

test("Stage-C admits internally, direct-spawns once, and projects only awaiting attestation", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const first = fixture.coordinator.activationOwner.setupPlayerHost(
        fixture.broker.issue("game_setup"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" },
      );
      const joined = fixture.coordinator.activationOwner.setupPlayerHost(
        fixture.broker.issue("game_setup"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" },
      );
      assert.equal(joined, first);
      await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(
          fixture.broker.issue("game_setup"),
          { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w" },
        ),
        /stardew_game_setup_in_progress/,
      );
       await first;
       await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 });
       const result = fixture.coordinator.activationOwner.readPrivateActivationSnapshot();
       assert.equal(result.state, "awaiting_player_host_attestation");
       assert.equal(Object.isFrozen(result), true);
       assert.deepEqual(Object.keys(result).sort(), ["authorityGeneration", "requestId", "revision", "schemaVersion", "state"]);
       const serialized = JSON.stringify(result);
      for (const forbidden of [
        gameDirectoryCandidate,
        "StardewModdingAPI.exe",
        "bootstrap-coordinator-1",
        "player-generation-1",
        "4102",
        "owner",
        "installation",
        "executable",
        "generation",
        "pid",
      ]) assert.equal(serialized.includes(forbidden), false, forbidden);
      assert.equal(fixture.playerSpawnCalls.length, 1);
      const playerSpawn = fixture.playerSpawnCalls[0]!;
      assert.equal(playerSpawn.executable, `${gameDirectoryCandidate}\\StardewModdingAPI.exe`);
      assert.deepEqual(playerSpawn.args, [
        "--mods-path",
        join(
          fixture.runtimeRoot,
          "stardew-private-bootstrap",
          "bootstrap-coordinator-1",
          "player-host",
          "Mods",
        ),
      ]);
      assert.equal(playerSpawn.options.cwd, gameDirectoryCandidate);
      assert.equal(playerSpawn.options.shell, false);
      assert.equal(playerSpawn.options.windowsHide, true);
      assert.equal(playerSpawn.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "player-generation-1");
      assert.deepEqual(fixture.spawnCalls, []);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn",
      });
       assert.equal(fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }), first);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup stages an admitted installation without launching Player Host", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" });
      assert.deepEqual(fixture.playerSpawnCalls, []);
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.equal(JSON.stringify(fixture.coordinator.activationOwner.readPrivateActivationSnapshot()).includes(gameDirectoryCandidate), false);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("launch-readiness generation is 0 until staged, then 1, and resets once launch starts", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      assert.equal(fixture.coordinator.launchReadinessReader.readLaunchReadinessView().generation, 0);
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      assert.equal(fixture.coordinator.launchReadinessReader.readLaunchReadinessView().generation, 0);
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" });
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.equal(fixture.coordinator.launchReadinessReader.readLaunchReadinessView().generation, 1);
      assert.deepEqual(fixture.playerSpawnCalls, []);
      await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 });
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "awaiting_player_host_attestation");
      assert.equal(fixture.coordinator.launchReadinessReader.readLaunchReadinessView().generation, 0);
      assert.equal(
        JSON.stringify(fixture.coordinator.launchReadinessReader.readLaunchReadinessView()).includes("player-generation-1"),
        false,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game launch rejects an incorrect first instance generation before spawning", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" });
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(
          fixture.broker.issue("game_launch"),
          { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 2 },
        ),
        /stardew_game_instance_generation_conflict/,
      );
      assert.deepEqual(fixture.playerSpawnCalls, []);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game launch consumes setup once and replays exact command", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" });
      const command = { apiVersion: 1 as const, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 };
      const first = fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), command);
      const replay = fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), command);
      assert.equal(replay, first);
      await first;
      assert.equal(fixture.playerSpawnCalls.length, 1);
      await assert.rejects(fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { ...command, expectedInstanceGeneration: 2 }), /stardew_game_launch_idempotency_conflict/);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game launch rejects a different key while the first launch is pending", async () => {
  await withWindowsPlatform(async () => {
    let fixture!: Awaited<ReturnType<typeof createFixture>>;
    let competingLaunch!: Promise<unknown>;
    fixture = await createFixture({
      afterPlayerSpawn: () => {
        competingLaunch = fixture.coordinator.activationOwner.launchPlayerHost(
          fixture.broker.issue("game_launch"),
          { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 },
        );
        competingLaunch.catch(() => undefined);
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(
        fixture.broker.issue("game_setup"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" },
      );
      await fixture.coordinator.activationOwner.launchPlayerHost(
        fixture.broker.issue("game_launch"),
        { apiVersion: 1, idempotencyKey: "CDEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 },
      );
      assert.notEqual(competingLaunch, undefined);
      await assert.rejects(competingLaunch, /stardew_game_launch_in_progress/);
      assert.equal(fixture.playerSpawnCalls.length, 1);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup cancellation is redacted, replayable, and never launches Player Host", async () => {
  await withWindowsPlatform(async () => {
    let pickerCalls = 0;
    const fixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => {
          pickerCalls += 1;
          return { status: "cancelled" };
        },
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const command = { apiVersion: 1 as const, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" };
      const first = fixture.coordinator.activationOwner.setupPlayerHost(
        fixture.broker.issue("game_setup"),
        command,
      );
      const replay = fixture.coordinator.activationOwner.setupPlayerHost(
        fixture.broker.issue("game_setup"),
        command,
      );
      assert.equal(replay, first);
      await first;
      assert.equal(pickerCalls, 1);
      assert.deepEqual(fixture.playerSpawnCalls, []);
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.equal(JSON.stringify(fixture.coordinator.activationOwner.readPrivateActivationSnapshot()).includes(gameDirectoryCandidate), false);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup admits only one pending idempotency lineage", async () => {
  await withWindowsPlatform(async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => {
          await gate;
          return { status: "cancelled" };
        },
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const pending = fixture.coordinator.activationOwner.setupPlayerHost(
        fixture.broker.issue("game_setup"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" },
      );
      await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(
          fixture.broker.issue("game_setup"),
          { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w" },
        ),
        /stardew_game_setup_in_progress/,
      );
      assert.deepEqual(fixture.playerSpawnCalls, []);
      release();
      await pending;
    } finally {
      release();
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup picker failure replays exactly and permits a fresh-key retry", async () => {
  await withWindowsPlatform(async () => {
    let pickerCalls = 0;
    const fixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => {
          pickerCalls += 1;
          if (pickerCalls === 1) throw new Error("controlled_picker_failure");
          return { status: "selected", path: gameDirectoryCandidate };
        },
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const first = fixture.coordinator.activationOwner.setupPlayerHost(
        fixture.broker.issue("game_setup"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" },
      );
      await assert.rejects(first, /stardew_game_setup_failed/);
      const replay = fixture.coordinator.activationOwner.setupPlayerHost(
        fixture.broker.issue("game_setup"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" },
      );
      assert.equal(replay, first);
      await assert.rejects(replay, /stardew_game_setup_failed/);
       await fixture.coordinator.activationOwner.setupPlayerHost(
         fixture.broker.issue("game_setup"),
         { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w" },
       );
       assert.equal(pickerCalls, 2);
       assert.deepEqual(fixture.playerSpawnCalls, []);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("close drains a pending Game setup picker and prevents a later launch", async () => {
  await withWindowsPlatform(async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => {
          await gate;
          return { status: "selected", path: gameDirectoryCandidate };
        },
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const setup = fixture.coordinator.activationOwner.setupPlayerHost(
        fixture.broker.issue("game_setup"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" },
      );
      const close = fixture.coordinator.close();
      let closeSettled = false;
      void close.finally(() => { closeSettled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closeSettled, false);
      release();
      await assert.rejects(setup, /stardew_lifecycle_closing/);
      await close;
      assert.deepEqual(fixture.playerSpawnCalls, []);
    } finally {
      release();
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("signed Player Host advertisement is consumed privately with exact generation correlation", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await publishSignedPlayerHostSession(fixture.runtimeRoot);
       await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 }));
       const result = fixture.coordinator.activationOwner.readPrivateActivationSnapshot();
       assert.equal(result.state, "awaiting_player_host_attestation");
      assert.deepEqual(Object.keys(result).sort(), ["authorityGeneration", "requestId", "revision", "schemaVersion", "state"]);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn",
      });
      const serialized = JSON.stringify(result);
      for (const forbidden of ["player-generation-1", "session", "advertisement", "pid", "owner"])
        assert.equal(serialized.includes(forbidden), false, forbidden);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("missing Player Host advertisement remains privately retryable before owner deadline", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
       await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 }));
       const result = fixture.coordinator.activationOwner.readPrivateActivationSnapshot();
       assert.equal(result.state, "awaiting_player_host_attestation");
      await publishSignedPlayerHostSession(fixture.runtimeRoot);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn",
      });
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "awaiting_player_host_attestation");
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("missing Player Host advertisement becomes terminal after the retained owner deadline", async () => {
  await withWindowsPlatform(async () => {
    let now = Date.now() + 1_000;
    const fixture = await createFixture({
      nowMs: () => now,
      afterPlayerSpawn: () => { now += 11 * 60_000; },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 })),
         /stardew_player_host_launch_failed/,
       );
       assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "failed");
      assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Player Host advertisement generation mismatch fails closed and quarantines", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await publishSignedPlayerHostSession(fixture.runtimeRoot, "wrong-player-generation");
      await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 })),
         /stardew_player_host_launch_failed/,
       );
       assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "failed");
       assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
       await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(
          fixture.broker.issue("game_setup"),
          { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w" },
        ),
        /stardew_player_host_launch_not_staged/,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Stage-C admission failure restores staged and permits a later valid retry", async () => {
  await withWindowsPlatform(async () => {
    const changed = installationChain.map((entry, index) => index === 2
      ? Object.freeze({ ...entry, fileId: "ffffffffffffffffffffffffffffffff" })
      : entry);
    const inspectors = [
      installationInspector([installationChain, changed]),
      installationInspector([installationChain, installationChain, installationChain]),
    ];
    const fixture = await createFixture({ overrides: { createInstallationInspector: async () => inspectors.shift()! } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 })),
        /stardew_game_setup_failed/,
      );
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.deepEqual(fixture.playerSpawnCalls, []);
       await fixture.coordinator.activationOwner.setupPlayerHost(
         fixture.broker.issue("game_setup"),
         { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w" },
       );
        await fixture.coordinator.activationOwner.launchPlayerHost(
          fixture.broker.issue("game_launch"),
          { apiVersion: 1, idempotencyKey: "CDEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 },
        );
       assert.equal(fixture.playerSpawnCalls.length, 1);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Stage-C reparse admission failure is pre-launch, restores staged, and permits retry", async () => {
  await withWindowsPlatform(async () => {
    const reparse = installationChain.map((entry, index) => index === 1
      ? Object.freeze({ ...entry, isReparsePoint: true })
      : entry);
    const inspectors = [
      installationInspector([reparse, reparse]),
      installationInspector([installationChain, installationChain, installationChain]),
    ];
    const fixture = await createFixture({ overrides: { createInstallationInspector: async () => inspectors.shift()! } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 })),
        /stardew_game_setup_failed/,
      );
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.deepEqual(fixture.playerSpawnCalls, []);
      await fixture.coordinator.activationOwner.setupPlayerHost(
        fixture.broker.issue("game_setup"),
        { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w" },
       );
        await fixture.coordinator.activationOwner.launchPlayerHost(
          fixture.broker.issue("game_launch"),
          { apiVersion: 1, idempotencyKey: "CDEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 },
        );
       assert.equal(fixture.playerSpawnCalls.length, 1);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

for (const failure of ["spawn", "probe"] as const) {
  test(`Stage-C ${failure} failure quarantines and permanently rejects retry`, async () => {
    await withWindowsPlatform(async () => {
      const fixture = await createFixture({
        playerSpawnFailure: failure === "spawn",
        playerProbeFailure: failure === "probe",
      });
      try {
        await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
        await assert.rejects(
          fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 })),
         /stardew_player_host_launch_failed/,
         );
         assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
        await assert.rejects(
          fixture.coordinator.activationOwner.setupPlayerHost(
            fixture.broker.issue("game_setup"),
            { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w" },
          ),
          /stardew_player_host_launch_not_staged/,
       );
        assert.equal(fixture.playerSpawnCalls.length, 1);
       } finally {
         await fixture.coordinator.close();
         await fixture.broker.close();
       }
     });
   });
 }

test("close during Stage-C admission drains and prevents a later spawn", async () => {
  await withWindowsPlatform(async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await createFixture({ inspectorGate: gate });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const launch = fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 }));
      const close = fixture.coordinator.close();
      release();
      await assert.rejects(launch, /stardew_lifecycle_closing/);
      await close;
      assert.deepEqual(fixture.playerSpawnCalls, []);
    } finally {
      release();
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("close after successful spawn stops only the exact Player Host and projects stopped", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 }));
      await fixture.coordinator.close();
      assert.deepEqual(fixture.playerKillCalls, [4102]);
      assert.deepEqual(fixture.aiKillCalls, []);
      assert.equal(fixture.playerSpawnCalls.length, 1);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "stopped", ownership: "gamebuddy_direct_spawn",
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("close after spawn preserves exact-child retry and never respawns", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture({ playerKillResults: [false, true] });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 }));
      await assert.rejects(fixture.coordinator.close(), /stardew_lifecycle_close_incomplete/);
      assert.deepEqual(fixture.playerKillCalls, [4102]);
      assert.equal(fixture.playerSpawnCalls.length, 1);
      await fixture.coordinator.close();
      assert.deepEqual(fixture.playerKillCalls, [4102, 4102]);
      assert.deepEqual(fixture.aiKillCalls, []);
      assert.equal(fixture.playerSpawnCalls.length, 1);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "stopped", ownership: "gamebuddy_direct_spawn",
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
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
      () => Promise.resolve(createStardewProductionLifecycleCoordinator(manifest, () => null)),
      /stardew_private_bootstrap_composition_requires_windows/,
    );
  }
});

const availableCabins: readonly PublishedCabin[] = Object.freeze([
  Object.freeze({ cabinId: "cabin-alpha", ownerFarmhandId: "101", boundCompanionId: "", isBusy: false }),
  Object.freeze({ cabinId: "cabin-beta", ownerFarmhandId: "202", boundCompanionId: "companion-1", isBusy: false }),
  Object.freeze({ cabinId: "cabin-busy", ownerFarmhandId: "303", boundCompanionId: "", isBusy: true }),
  Object.freeze({ cabinId: "cabin-foreign", ownerFarmhandId: "404", boundCompanionId: "other-companion", isBusy: false }),
]);

async function prepareCabinCoordinator(
  expiresAtUnixMs = Date.now() + 5 * 60_000,
  input: Parameters<typeof createFixture>[0] = {},
) {
  const fixture = await createFixture(input);
  await withWindowsPlatform(async () => {
    await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
    await publishSignedPlayerHostSession(fixture.runtimeRoot, "player-generation-1", availableCabins, expiresAtUnixMs);
    await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 }));
  });
  return fixture;
}

test("dynamic cabin handoff admits one manifest and launches the exact owned AI client", async () => {
  const startedAt = Date.now();
  const fixture = await prepareCabinCoordinator(startedAt + 5 * 60_000, {
    gameRuntimeBindingCloseResults: [false, true],
  });
  try {
    const readStartedAt = Date.now();
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const readCompletedAt = Date.now();
    assert.equal(choices.apiVersion, 1);
    assert.deepEqual(choices.choices.map((choice) => choice.displayLabel), ["Cabin 1", "Cabin 2"]);
    assert.equal(new Set(choices.choices.map((choice) => choice.choiceHandle)).size, 2);
    for (const choice of choices.choices) {
      assert.match(choice.choiceHandle, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(choice.availability, "available");
      assert.ok(choice.expiresAtMs <= readCompletedAt + 60_000);
      assert.ok(choice.expiresAtMs >= readStartedAt + 59_000);
      assert.deepEqual(Object.keys(choice).sort(), ["availability", "choiceHandle", "displayLabel", "expiresAtMs"]);
    }
    const serialized = JSON.stringify(choices);
    for (const forbidden of ["cabin-alpha", "cabin-beta", "101", "202", "companion-1", "ownerFarmhandId"])
      assert.equal(serialized.includes(forbidden), false, forbidden);

    const command = { apiVersion: 1 as const, choiceHandle: choices.choices[0]!.choiceHandle, idempotencyKey: "confirm-key-alpha", confirmed: true as const };
    const first = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command);
    const joined = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command);
    assert.equal(joined, first);
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    assert.equal(request.cabinId, "cabin-alpha");
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    assert.deepEqual(await first, { apiVersion: 1, status: "manifest_admitted" });
    assert.deepEqual(await fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command), {
      apiVersion: 1, status: "manifest_admitted",
    });
    assert.equal(fixture.spawnCalls.length, 1);
    const aiSpawn = fixture.spawnCalls[0]!;
    assert.equal(aiSpawn.executable, `${gameDirectoryCandidate}\\StardewModdingAPI.exe`);
    assert.deepEqual(aiSpawn.args, [
      "--mods-path",
      join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "ai-client", "Mods"),
    ]);
    assert.equal(aiSpawn.options.cwd, gameDirectoryCandidate);
    assert.equal(aiSpawn.options.shell, false);
    assert.equal(aiSpawn.options.windowsHide, true);
    assert.equal(aiSpawn.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-1");
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.equal(fixture.packageReadCount(), 4);
    assert.equal(fixture.bridgeConnectCalls.length, 1);
    const bridgeConnection = fixture.bridgeConnectCalls[0]!;
    assert.deepEqual(bridgeConnection.scope, {
      integrationId: "stardew",
      saveId: "save-coordinator",
      worldId: "world-coordinator",
      playerId: "101",
      companionId: "companion-1",
    });
    assert.equal(bridgeConnection.pipeName, "gamebuddy-stardew-coordinator-bridge");
    assert.equal(bridgeConnection.token, "coordinator-bridge-token-0123456789");
    assert.equal(bridgeConnection.launchGeneration, "ai-generation-1");
    assert.equal(bridgeConnection.deadlineMs, choices.choices[0]!.expiresAtMs);
    assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).aiClient, {
      state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn", lastStopOutcome: "none",
    });
    assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "awaiting_player_host_attestation");
    const transaction = join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1");
    const aiConfig = JSON.parse(await readFile(join(transaction, "ai-client", "Mods", "GameBuddy", "config.json"), "utf8"));
    assert.equal(aiConfig.FarmhandProvisioner.Enable, true);
    assert.equal(aiConfig.FarmhandProvisioner.ManifestPath, join(transaction, "session", "stardew-farmhand-manifest.json"));
    assert.equal("Pid" in aiConfig.FarmhandProvisioner, false);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 1);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 1);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "connected_idle",
    });
    await assert.rejects(fixture.coordinator.close(), /stardew_lifecycle_close_incomplete/);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "failed",
    });
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 1);
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.aiKillCalls, []);
    assert.deepEqual(fixture.playerKillCalls, []);
    await fixture.coordinator.close();
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    assert.deepEqual(fixture.aiKillCalls, [4101]);
    assert.deepEqual(fixture.playerKillCalls, [4102]);
    assert.deepEqual(fixture.lifecycleOrder, ["bridge", "ai", "player"]);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

async function confirmFirstCabin(fixture: Awaited<ReturnType<typeof prepareCabinCoordinator>>) {
  const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
  const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
    fixture.broker.issue("cabin_confirm"),
    {
      apiVersion: 1,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "confirm-first-cabin-key",
      confirmed: true,
    },
  );
  const request = await waitForAttachmentRequest(fixture.runtimeRoot);
  await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
  return confirmation;
}

test("attached semantic Game STOP is generation-bound, idempotent, settled, and does not detach", async () => {
  const stopGate = deferredVoid();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { gameStopSettled: stopGate.promise });
  let gateReleased = false;
  try {
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    await confirmFirstCabin(fixture);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "connected_idle",
    });

    assert.throws(
      () => fixture.coordinator.activationOwner.stopGame(
        fixture.broker.issue("game_stop"),
        { apiVersion: 1, idempotencyKey: "wrong-generation-stop", expectedAttachmentGeneration: 2 },
      ),
      /stardew_game_attachment_generation_conflict/,
    );
    assert.equal(fixture.gameStopCalls.length, 0);

    const command = { apiVersion: 1 as const, idempotencyKey: "game-stop-key", expectedAttachmentGeneration: 1 };
    const first = fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), command);
    const replay = fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), command);
    assert.equal(replay, first);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "stopping",
    });
    assert.equal(fixture.gameStopCalls.length, 1);
    assert.equal(fixture.gameStopCalls[0]!.stopId, command.idempotencyKey);
    assert.equal(fixture.gameStopCalls[0]!.reasonCode, "player_stop_all");
    assert.notEqual(fixture.gameStopCalls[0]!.sourceEventId, command.idempotencyKey);
    assert.match(fixture.gameStopCalls[0]!.sourceEventId, /^[0-9a-f-]{36}$/);
    assert.throws(
      () => fixture.coordinator.activationOwner.stopGame(
        fixture.broker.issue("game_stop"),
        { ...command, expectedAttachmentGeneration: 2 },
      ),
      /stardew_game_stop_idempotency_conflict/,
    );
    stopGate.resolve();
    gateReleased = true;
    await first;
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "stopped",
    });
    await fixture.coordinator.activationOwner.stopGame(
      fixture.broker.issue("game_stop"),
      { apiVersion: 1, idempotencyKey: "game-stop-key-2", expectedAttachmentGeneration: 1 },
    );
    assert.equal(fixture.gameStopCalls.length, 2);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "stopped",
    });
  } finally {
    if (!gateReleased) stopGate.resolve();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("failed semantic Game STOP is terminal for its attachment and replay remains exact", async () => {
  const failure = Promise.reject(new Error("controlled-stop-settlement-failure"));
  void failure.catch(() => undefined);
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { gameStopSettled: failure });
  try {
    await confirmFirstCabin(fixture);
    const command = { apiVersion: 1 as const, idempotencyKey: "failed-game-stop-key", expectedAttachmentGeneration: 1 };
    const first = fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), command);
    const replay = fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), command);
    assert.equal(replay, first);
    await assert.rejects(first, /controlled-stop-settlement-failure/);
    assert.equal(fixture.gameStopCalls.length, 1);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "failed",
    });
    assert.throws(
      () => fixture.coordinator.activationOwner.stopGame(
        fixture.broker.issue("game_stop"),
        { apiVersion: 1, idempotencyKey: "fresh-after-failed-stop", expectedAttachmentGeneration: 1 },
      ),
      /stardew_game_runtime_unavailable/,
    );
    assert.equal(fixture.gameStopCalls.length, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("reentrant close during initial ingress activation never publishes an attachment", async () => {
  let closePromise: Promise<void> | undefined;
  let fixtureForClose: Awaited<ReturnType<typeof prepareCabinCoordinator>> | undefined;
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    afterIngressActivation() {
      assert.ok(fixtureForClose);
      closePromise = fixtureForClose.coordinator.close();
    },
  });
  fixtureForClose = fixture;
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(
      fixture.broker.issue("cabin_read"),
    );
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "reentrant-ingress-close-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 1);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    assert.ok(closePromise);
    await closePromise;
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("manifest-admitted Farmhand Bridge retries only pipe-not-ready before authenticated connection", async () => {
  let attempts = 0;
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      connectFarmhandGameRuntimeFacade: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("controlled_pipe_not_ready") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return Object.freeze({
          authority: "SEMANTIC" as const,
          runEnter: async () => connectedSemanticGameLeaseFixture(),
          recoverDeadOwner: async () => undefined,
          close: async () => undefined,
        });
      },
    },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      {
        apiVersion: 1,
        choiceHandle: choices.choices[0]!.choiceHandle,
        idempotencyKey: "bridge-transient-retry-key",
        confirmed: true,
      },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    assert.deepEqual(await confirmation, { apiVersion: 1, status: "manifest_admitted" });
    assert.equal(attempts, 2);
    assert.equal(fixture.spawnCalls.length, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("manifest-admitted Farmhand Bridge attestation mismatch is permanently uncertain and quarantined", async () => {
  let attempts = 0;
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      connectFarmhandGameRuntimeFacade: async () => {
        attempts += 1;
        throw new Error("bridge_runtime_attestation_mismatch");
      },
    },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "bridge-attestation-mismatch-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.equal(attempts, 1);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /stardew_cabin_publication_uncertain/,
    );
    assert.equal(attempts, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("manifest-admitted semantic Game enter failure is one-shot uncertain and closes its facade", async () => {
  let connectorCalls = 0;
  let enterCalls = 0;
  let closeCalls = 0;
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      connectFarmhandGameRuntimeFacade: async () => {
        connectorCalls += 1;
        return Object.freeze({
          authority: "SEMANTIC" as const,
          runEnter: async () => {
            enterCalls += 1;
            const error = new Error("controlled_semantic_game_enter_failure") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          },
          recoverDeadOwner: async () => undefined,
          close: async () => { closeCalls += 1; },
        });
      },
    },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "semantic-enter-failure-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.equal(connectorCalls, 1);
    assert.equal(enterCalls, 1);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /stardew_cabin_publication_uncertain/,
    );
    assert.equal(connectorCalls, 1);
    assert.equal(enterCalls, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
  assert.equal(closeCalls, 1);
});

test("dynamic cabin confirmation rejects cross-session, expiry, stale revision, conflicts, and closes fail-closed", async () => {
  const fixture = await prepareCabinCoordinator();
  const foreignBroker = await createAdmissionBroker();
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const firstChoice = choices.choices[0]!;
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(foreignBroker.issue("cabin_confirm"), {
        apiVersion: 1, choiceHandle: firstChoice.choiceHandle, idempotencyKey: "foreign-key", confirmed: true,
      }),
      /stardew_cabin_browser_admission_invalid/,
    );

    const pendingCommand = { apiVersion: 1 as const, choiceHandle: firstChoice.choiceHandle, idempotencyKey: "single-confirmation-key", confirmed: true as const };
    const pending = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), pendingCommand);
    await waitForAttachmentRequest(fixture.runtimeRoot);
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), {
        ...pendingCommand, choiceHandle: choices.choices[1]!.choiceHandle,
      }),
      /stardew_cabin_idempotency_conflict/,
    );
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), {
        apiVersion: 1, choiceHandle: choices.choices[1]!.choiceHandle, idempotencyKey: "second-confirmation-key", confirmed: true,
      }),
      /stardew_cabin_confirmation_conflict/,
    );

    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    const directory = join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "session");
    await writeFile(join(directory, "stardew-attachment-response.json"), JSON.stringify(signAttachmentValue({
      schemaVersion: 1, requestId: request.requestId as string, state: "rejected",
      reasonCode: "binding_readback_mismatch", updatedAtUnixMs: Date.now(), signature: "",
    })));
    await assert.rejects(pending, /stardew_cabin_publication_uncertain/);
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), pendingCommand),
      /stardew_cabin_publication_uncertain/,
    );

    await fixture.coordinator.close();
    await assert.rejects(
      fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read")),
      /stardew_cabin_handoff_unavailable|stardew_cabin_handoff_revision_changed/,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
    await foreignBroker.close();
  }
});

test("dynamic cabin handles distinguish expired and revision-stale failures", async () => {
  const expiring = await prepareCabinCoordinator(Date.now() + 1_500);
  try {
    const choices = await expiring.coordinator.activationOwner.readCabinChoices(expiring.broker.issue("cabin_read"));
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_600));
    assert.throws(
      () => expiring.coordinator.activationOwner.confirmCabinChoice(expiring.broker.issue("cabin_confirm"), {
        apiVersion: 1, choiceHandle: choices.choices[0]!.choiceHandle, idempotencyKey: "expired-key", confirmed: true,
      }),
      /stardew_cabin_choice_expired/,
    );
  } finally {
    await expiring.coordinator.close();
    await expiring.broker.close();
  }

  const stale = await prepareCabinCoordinator();
  try {
    const choices = await stale.coordinator.activationOwner.readCabinChoices(stale.broker.issue("cabin_read"));
    const confirmationAdmission = stale.broker.issue("cabin_confirm");
    await stale.coordinator.close();
    assert.throws(
      () => stale.coordinator.activationOwner.confirmCabinChoice(confirmationAdmission, {
        apiVersion: 1, choiceHandle: choices.choices[0]!.choiceHandle, idempotencyKey: "stale-key", confirmed: true,
      }),
      /stardew_cabin_choice_revision_stale/,
    );
  } finally {
    await stale.coordinator.close();
    await stale.broker.close();
  }
});

test("manifest-admitted AI materialization failure is permanently uncertain and never republishes attachment", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { failPackageReadAt: 3 });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "materialization-failure-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /stardew_cabin_publication_uncertain/,
    );
    assert.equal(fixture.packageReadCount(), 3);
    assert.deepEqual(fixture.spawnCalls, []);
    const repeatedRequest = await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "session", "stardew-attachment-request.json"),
      "utf8",
    );
    assert.equal(JSON.parse(repeatedRequest).requestId, request.requestId);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("manifest-admitted private Bridge config replacement is permanently uncertain and quarantines without AI spawn", async () => {
  let runtimeRoot = "";
  let tampered = false;
  const inspector = installationInspector(
    [installationChain, installationChain, installationChain, installationChain],
    async (readIndex) => {
      if (readIndex !== 4 || tampered) return;
      tampered = true;
      await writeFile(
        join(runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "ai-client", "Mods", "GameBuddy", "config.json"),
        JSON.stringify({ EnableLocalBridge: false }),
      );
    },
  );
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: { createInstallationInspector: async () => inspector },
  });
  runtimeRoot = fixture.runtimeRoot;
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "ai-bridge-config-replacement-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command);
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /stardew_cabin_publication_uncertain/,
    );
    assert.equal(tampered, true);
    assert.deepEqual(fixture.spawnCalls, []);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("manifest-admitted AI installation replacement is permanently uncertain and quarantines without AI spawn", async () => {
  const changed = installationChain.map((entry, index) => index === 2
    ? Object.freeze({ ...entry, fileId: "ffffffffffffffffffffffffffffffff" })
    : entry);
  const inspector = installationInspector([
    installationChain,
    installationChain,
    installationChain,
    changed,
  ]);
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: { createInstallationInspector: async () => inspector },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "ai-installation-replacement-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command);
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /stardew_cabin_publication_uncertain/,
    );
    assert.deepEqual(fixture.spawnCalls, []);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

for (const failure of ["spawn", "probe"] as const) {
  test(`manifest-admitted AI ${failure} failure is permanently uncertain and consumes launch authority`, async () => {
    const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
      aiSpawnFailure: failure === "spawn",
      aiProbeFailure: failure === "probe",
    });
    try {
      const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
      const command = {
        apiVersion: 1 as const,
        choiceHandle: choices.choices[0]!.choiceHandle,
        idempotencyKey: `ai-${failure}-failure-key`,
        confirmed: true as const,
      };
      const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command);
      const request = await waitForAttachmentRequest(fixture.runtimeRoot);
      await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
      await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
      assert.throws(
        () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
        /stardew_cabin_publication_uncertain/,
      );
      assert.equal(fixture.spawnCalls.length, 1);
      assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
}

test("close drains manifest-admitted AI materialization before quarantine and process teardown", async () => {
  let releasePackageRead!: () => void;
  const packageReadGate = new Promise<void>((resolve) => { releasePackageRead = resolve; });
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    packageReadGateAt: { count: 3, promise: packageReadGate },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      {
        apiVersion: 1,
        choiceHandle: choices.choices[0]!.choiceHandle,
        idempotencyKey: "close-during-materialization-key",
        confirmed: true,
      },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    while (fixture.packageReadCount() < 3) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    let closeSettled = false;
    const close = fixture.coordinator.close().finally(() => { closeSettled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(closeSettled, false);
    assert.deepEqual(fixture.playerKillCalls, []);
    releasePackageRead();
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    await close;
    assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "closed");
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerKillCalls, [4102]);
  } finally {
    releasePackageRead();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});


test("Game disconnect joins same-generation STOP, closes only the semantic facade, and rereads none", async () => {
  const stopGate = deferredVoid();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { gameStopSettled: stopGate.promise });
  try {
    await confirmFirstCabin(fixture);
    const stop = fixture.coordinator.activationOwner.stopGame(
      fixture.broker.issue("game_stop"),
      { apiVersion: 1, idempotencyKey: "disconnect-joined-stop", expectedAttachmentGeneration: 1 },
    );
    const command = { apiVersion: 1 as const, idempotencyKey: "disconnect-key-00000001", expectedAttachmentGeneration: 1 };
    const disconnect = fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), command);
    const replay = fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), command);
    assert.equal(replay, disconnect);
    assert.throws(
      () => fixture.coordinator.activationOwner.disconnectGame(
        fixture.broker.issue("game_disconnect"),
        { apiVersion: 1, idempotencyKey: "disconnect-second-key-01", expectedAttachmentGeneration: 1 },
      ),
      /stardew_game_disconnect_in_progress/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "stopping",
    });
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 1);
    assert.throws(
      () => fixture.coordinator.activationOwner.stopGame(
        fixture.broker.issue("game_stop"),
        { apiVersion: 1, idempotencyKey: "stop-after-disconnect", expectedAttachmentGeneration: 1 },
      ),
      /stardew_game_runtime_unavailable/,
    );
    assert.equal(fixture.gameStopCalls.length, 1);
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.aiKillCalls, []);
    assert.deepEqual(fixture.playerKillCalls, []);
    stopGate.resolve();
    await Promise.all([stop, disconnect]);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    assert.deepEqual(fixture.aiKillCalls, []);
    assert.deepEqual(fixture.playerKillCalls, []);
    assert.throws(
      () => fixture.coordinator.activationOwner.disconnectGame(
        fixture.broker.issue("game_disconnect"),
        { ...command, expectedAttachmentGeneration: 2 },
      ),
      /stardew_game_disconnect_idempotency_conflict/,
    );
  } finally {
    stopGate.resolve();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("Game disconnect and outer close share one pending attachment teardown", async () => {
  const stopGate = deferredVoid();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { gameStopSettled: stopGate.promise });
  try {
    await confirmFirstCabin(fixture);
    const stop = fixture.coordinator.activationOwner.stopGame(
      fixture.broker.issue("game_stop"),
      { apiVersion: 1, idempotencyKey: "disconnect-close-stop", expectedAttachmentGeneration: 1 },
    );
    const disconnect = fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "disconnect-close-shared", expectedAttachmentGeneration: 1 },
    );
    const close = fixture.coordinator.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.aiKillCalls, []);
    assert.deepEqual(fixture.playerKillCalls, []);
    stopGate.resolve();
    await Promise.all([stop, disconnect, close]);
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    assert.deepEqual(fixture.aiKillCalls, [4101]);
    assert.deepEqual(fixture.playerKillCalls, [4102]);
  } finally {
    stopGate.resolve();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("Game disconnect waits for a rejected STOP settlement before containing the attachment", async () => {
  let rejectStop!: (error: Error) => void;
  const stopSettled = new Promise<void>((_resolve, reject) => { rejectStop = reject; });
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { gameStopSettled: stopSettled });
  try {
    await confirmFirstCabin(fixture);
    const stop = fixture.coordinator.activationOwner.stopGame(
      fixture.broker.issue("game_stop"),
      { apiVersion: 1, idempotencyKey: "disconnect-stop-rejected", expectedAttachmentGeneration: 1 },
    );
    const disconnect = fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "disconnect-after-stop-failure", expectedAttachmentGeneration: 1 },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    rejectStop(new Error("controlled-stop-settlement-failure"));
    await assert.rejects(stop, /controlled-stop-settlement-failure/);
    await disconnect;
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
  } finally {
    rejectStop(new Error("cleanup-stop-settlement"));
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("synchronous Game task cancellation failure is shared, replayable, and retryable", async () => {
  const cancelError = new Error("controlled-game-task-cancel-failure");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    gameRuntimeTaskCancelError: cancelError,
  });
  try {
    await confirmFirstCabin(fixture);
    const command = { apiVersion: 1 as const, idempotencyKey: "disconnect-cancel-failed", expectedAttachmentGeneration: 1 };
    const failed = fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), command);
    await assert.rejects(failed, /controlled-game-task-cancel-failure/);
    assert.equal(
      fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), command),
      failed,
    );
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 1);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "failed",
    });
    await assert.rejects(
      fixture.coordinator.activationOwner.disconnectGame(
        fixture.broker.issue("game_disconnect"),
        { apiVersion: 1, idempotencyKey: "disconnect-cancel-retry", expectedAttachmentGeneration: 1 },
      ),
      /controlled-game-task-cancel-failure/,
    );
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 2);
    assert.deepEqual(fixture.bridgeCloseCalls, []);
  } finally {
    await fixture.coordinator.close().catch(() => undefined);
    await fixture.broker.close();
  }
});

test("failed Game disconnect retains generation and permits only a fresh-key retry", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    gameRuntimeBindingCloseResults: [false, true],
  });
  try {
    await confirmFirstCabin(fixture);
    const failedCommand = { apiVersion: 1 as const, idempotencyKey: "disconnect-failed-key-01", expectedAttachmentGeneration: 1 };
    const failed = fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), failedCommand);
    await assert.rejects(failed, /controlled_game_runtime_binding_close_failure/);
    assert.equal(
      fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), failedCommand),
      failed,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "failed",
    });
    await fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "disconnect-retry-key-002", expectedAttachmentGeneration: 1 },
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
