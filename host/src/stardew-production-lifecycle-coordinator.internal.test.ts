import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import {
  publishStardewInstallationRegistration,
  readStardewInstallationRegistration,
} from "./stardew-installation-registration.internal.js";

import {
  createComposedReferenceGameBrowserRequestHandler,
  issueComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserReadContext,
} from "./composed-reference-game-browser.js";
import { composeGameProfile, GameBrowserFixtureV1, GameBrowserValidatorsV1 } from "./game-browser-contract/index.js";
import { composeReferenceGameBrowserProfile } from "./composed-browser-contract/index.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import { composeTavernProfile, TavernBrowserFixtureV1 } from "./tavern/browser-contract/index.js";
import {
  createStardewProductionLifecycleCoordinatorForTesting,
  type StardewLifecycleCoordinatorTestingOverrides,
} from "./stardew-production-lifecycle-coordinator.test-support-internal.js";
import {
  containedAiClientLaunchDecision,
  containedPlayerHostLaunchDecision,
  containedRuntimeTeardownFromCollaborator,
  createStardewProductionLifecycleCoordinator,
  driveStardewOwnedPlayerHostRecovery,
  isFirstFarmhandAiClientActivationIntact,
  isResumeAttachDeferredError,
  type StardewContainedRuntimeTeardown,
  type StardewGameSessionCreationAuthority,
} from "./stardew-production-lifecycle-coordinator.internal.js";
import { STARDEW_GAME_WORLD_CREATION_SLOT_MISSING } from "./stardew-owned-farmhand-game-world-creation-seam.internal.js";
import type { SemanticGameProductionAuthority } from "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import {
  productionGameSessionWorldBindingSlotRelease,
  type ProductionGameSessionMetadata,
  type ProductionGameSessionWorldBinding,
} from "./continuity-semantic-store/continuity-semantic-production-store.js";
import type { StardewPrivateBootstrapCoreDependencies } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.test-support-internal.js";
import type { StardewOwnedPlayerHostBootstrap } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.js";
import type {
  StardewContainedAiClientLaunchSeam,
  StardewContainedPlayerHostLaunchSeam,
  StardewPlayerHostRuntimeLaunchCollaborator,
} from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.core.js";
import { prepareMaterializedAiClientFixture } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.test-fixtures.js";
import { FarmhandBridgeConnectionNotAvailableError } from "./containment/runtime/contract/game-runtime.js";
import type { RedactedRecoveryOutcome } from "./containment/runtime/contract/game-runtime.js";
import type { DesktopGuardianSession, GuardianAck } from "./containment/auth/desktop-guardian-session.internal.js";
import {
  createDesktopGuardianGameRuntimePlatform,
  createStardewPlayerHostRuntimeLaunchCollaboratorFactory,
  type StardewOwnerRecoveryRequest,
} from "./composition/stardew/stardew-guardian-platform.js";
import { STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS } from "./composition/stardew/stardew-native-role-launch-plan.private.js";
import {
  STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS,
} from "./stardew-production-lifecycle-coordinator.internal.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";
import { createTestWindowsReparseInspector } from "./windows-reparse-inspector/index.test-support.js";
import type { WindowsPathObjectIdentity, WindowsReparseInspectorCapability } from "./windows-reparse-inspector/index.js";
import { createStardewInstallationDiscoveryProvider, type StardewInstallationDiscoveryProvider } from "./windows-stardew-installation-discovery/index.js";

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
  "manifest.json",
] as const;
const tavernProfile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.reference-pipeline",
  releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
  operationIds: ["chat.submit", "chat.cancel"],
  navigationItemIds: ["chat"],
});

const gameProfileWithDiscovery = composeGameProfile({
  profileId: "gamebuddy.game.preview",
  releaseTier: "game_preview",
  operationIds: [
    "game.state.read",
    "game.installation.discovery.read",
    "game.installation.discovery.confirm",
    "game.installation.discovery.retry",
    "game.installation.discovery.cancel",
    "game.installation.discovery.manual_picker",
    "game.endgame",
  ],
  navigationItemIds: ["game"],
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

function stateForGame(context: ComposedReferenceGameBrowserReadContext) {
  const base = GameBrowserFixtureV1.state();
  return {
    ...base,
    build: { ...base.build, profileId: gameProfileWithDiscovery.profileId },
    csrfToken: context.csrfToken,
    browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
  };
}

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

function sequencedInstallationInspector(
  sequences: readonly (readonly (readonly WindowsPathObjectIdentity[])[])[],
  beforeResponse?: (sequenceIndex: number, readIndex: number) => Promise<void>,
) {
  let sequenceIndex = 0;
  let readIndex = 0;
  let current: readonly (readonly WindowsPathObjectIdentity[])[] | undefined;
  return createTestWindowsReparseInspector(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    });
    child.stdin.on("data", () => void (async () => {
      current ??= sequences[sequenceIndex++] ?? [];
      const currentSequenceIndex = sequenceIndex;
      const currentReadIndex = readIndex + 1;
      if (beforeResponse !== undefined) await beforeResponse(currentSequenceIndex, currentReadIndex);
      const chain = current[readIndex++] ?? current.at(-1) ?? installationChain;
      child.stdout.end(`${JSON.stringify({
        schemaVersion: 2,
        operation: "inspect_path_chain_v2",
        status: "ok",
        components: chain,
      })}\n`);
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
      if (readIndex >= current.length) {
        current = undefined;
        readIndex = 0;
      }
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

/** Shape the authenticated session expects back for every relayed command. */
function containedSessionAck(operation: string, role?: string): GuardianAck {
  return Object.freeze({
    operation,
    status: "ok",
    bootstrapId: "bootstrap-coordinator-1",
    generation: "generation-1",
    inventoryDigest: "inventory-1",
    runtimeAdmissionSha256: "admission-1",
    guardianInstanceId: "guardian-instance-coordinator-1",
    guardianEpoch: 1,
    attemptId: "bootstrap-coordinator-1",
    ...(role === undefined ? {} : { role }),
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

type DiscoveryBrowserHandler = NonNullable<Parameters<typeof createComposedReferenceGameBrowserRequestHandler>[0]["gameDiscovery"]>;

async function createAdmissionBroker(
  gameDiscovery?: DiscoveryBrowserHandler,
  activate?: (admission: ComposedReferenceGameBrowserLifecycleActivationAdmission) => Promise<unknown>,
) {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithDiscovery }),
    bootstrapToken,
    async readChat(context) { return stateForChat(context); },
    async readGame(context) { return stateForGame(context); },
    ...(activate === undefined
      ? {}
      : {
          // The composed wire's activation seam, mounted onto the coordinator's own
          // activation owner exactly as the production provider mounts it. The owner's
          // private snapshot is discarded, as the browser callback requires.
          gameActivate: async (admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<void> => {
            await activate(admission);
          },
        }),
    gameDiscovery: gameDiscovery ?? {
      read: async () => ({ apiVersion: 1, candidates: [], diagnostics: [] }),
      confirm: async () => ({ apiVersion: 1, status: "registered" }),
      retry: async () => ({ apiVersion: 1, candidates: [], diagnostics: [] }),
      cancel: async () => ({ apiVersion: 1, status: "cancelled" }),
      manualPicker: async () => ({ apiVersion: 1, status: "cancelled" }),
    },
    // The profile declares game.endgame, so the handler options must mount it or
    // the mismount guard rejects the composition. The coordinator-level endgame
    // behaviour is exercised through the activation owner, not through here.
    gameEndgame: async () => ({ apiVersion: 1, status: "unavailable" }),
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
  const request = (operation: "lifecycle_activation" | "cabin_read" | "cabin_confirm" | "discovery_read" | "discovery_confirm" | "discovery_retry" | "discovery_cancel" | "discovery_picker" | "game_setup" | "game_launch" | "game_stop" | "game_resume" | "game_resume_cancel" | "game_reopen" | "game_disconnect" | "game_endgame" | "game_create"): IncomingMessage => {
    const originUrl = new URL(origin);
    const method = operation === "cabin_read" || operation === "discovery_read" ? "GET" : "POST";
    const url = operation === "lifecycle_activation"
      ? "/api/composed-reference-game/v1/lifecycle/activate"
      : operation === "discovery_read"
        ? "/api/composed-reference-game/v1/game/installation/discovery"
        : operation === "discovery_confirm"
          ? "/api/composed-reference-game/v1/game/installation/discovery/confirm"
          : operation === "discovery_retry"
            ? "/api/composed-reference-game/v1/game/installation/discovery/retry"
            : operation === "discovery_cancel"
              ? "/api/composed-reference-game/v1/game/installation/discovery/cancel"
              : operation === "discovery_picker"
                ? "/api/composed-reference-game/v1/game/installation/discovery/manual-picker"
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
                          : operation === "game_resume"
                            ? "/api/composed-reference-game/v1/game/resume"
                            : operation === "game_resume_cancel"
                              ? "/api/composed-reference-game/v1/game/resume/cancel"
                              : operation === "game_reopen"
                                ? "/api/composed-reference-game/v1/game/reopen"
                                : operation === "game_disconnect"
                                  ? "/api/composed-reference-game/v1/game/disconnect"
                                  : operation === "game_endgame"
                                    ? "/api/composed-reference-game/v1/game/endgame"
                                    : "/api/composed-reference-game/v1/game/create";
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
    operation: "lifecycle_activation" | "cabin_read" | "cabin_confirm" | "discovery_read" | "discovery_confirm" | "discovery_retry" | "discovery_cancel" | "discovery_picker" | "game_setup" | "game_launch" | "game_stop" | "game_resume" | "game_resume_cancel" | "game_reopen" | "game_disconnect" | "game_endgame" | "game_create" = "lifecycle_activation",
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
    origin,
    cookie,
    csrfToken: root.chat.csrfToken,
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
  /** 1-based AI-client spawn call index that fails (fresh-resume launch failure). */
  aiSpawnFailureAt?: number;
  aiProbeFailure?: boolean;
  playerKillResults?: readonly boolean[];
  gameRuntimeBindingCloseResults?: readonly boolean[];
  gameStopSettled?: Promise<void>;
  gameRuntimeTaskCancelError?: Error;
  afterIngressActivation?(): void;
  nowMs?: () => number;
  afterPlayerSpawn?(): void;
  discoveryBrowserHandlers?: DiscoveryBrowserHandler;
}> = {}) {
  const runtimeRoot = await canonicalTemporaryRoot("gamebuddy-lifecycle-coordinator-");
  const packageRoot = join(runtimeRoot, "package");
  temporaryRoots.push(runtimeRoot);
  await publishStardewInstallationRegistration(runtimeRoot, null, {
    schema: "gamebuddy-stardew-installation-registration/v1",
    binding: { rootLayoutVersion: 1 },
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
  // Per-reservation AI-client launch generations: the first activation claims
  // `ai-generation-1`; each fresh resume activation claims the next one, so a
  // second resume's spawn/connect generation is observably distinct.
  let aiClientLaunchGenerationIndex = 0;
  const dependencies: StardewPrivateBootstrapCoreDependencies = {
    rawSpawn(executable, args, options) {
      spawnCalls.push(Object.freeze({ executable, args: Object.freeze([...args]), options }));
      if (input.aiSpawnFailure) throw new Error("controlled-ai-spawn-failure");
      if (input.aiSpawnFailureAt !== undefined && spawnCalls.length === input.aiSpawnFailureAt)
        throw new Error("controlled-ai-spawn-failure");
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
    createLaunchGeneration: () => `ai-generation-${++aiClientLaunchGenerationIndex}`,
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
  let freshRegistrationAdmissionCount = 0;
  const coordinator = createStardewProductionLifecycleCoordinatorForTesting(
    manifest,
    dependencies,
    {
      ...input.overrides,
      createInstallationInspector: (async () => {
        freshRegistrationAdmissionCount += 1;
        return (input.overrides?.createInstallationInspector ?? (async () =>
          installationInspector(input.inspectorChains ?? [
            installationChain, installationChain, installationChain,
            installationChain, installationChain, installationChain,
          ],
            input.inspectorGate === undefined ? undefined : () => input.inspectorGate!)))();
      }) as () => Promise<WindowsReparseInspectorCapability>,
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
              ...(input.gameStopSettled === undefined ? {} : { stopSettled: input.gameStopSettled }),
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
  const broker = await createAdmissionBroker(
    input.discoveryBrowserHandlers,
    (admission) => coordinator.activationOwner.activate(admission),
  );
  coordinator.activationOwner.bindBrowserAdmissionIssuer(broker.handler.lifecycleActivationIssuer);
  return {
    runtimeRoot,
    manifest,
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
    freshRegistrationAdmissionCount: () => freshRegistrationAdmissionCount,
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

/** Synchronous variant for the fixture `afterPlayerSpawn` hook, which is not awaited. */
function publishSignedPlayerHostSessionSync(
  runtimeRoot: string,
  launchGeneration = "player-generation-1",
  cabins: readonly PublishedCabin[] = [],
  expiresAtUnixMs = Date.now() + 60_000,
): void {
  const sessionDirectory = join(
    runtimeRoot,
    "stardew-private-bootstrap",
    "bootstrap-coordinator-1",
    "session",
  );
  mkdirSync(sessionDirectory, { recursive: true });
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
  writeFileSync(join(sessionDirectory, "stardew-session.json"), JSON.stringify({ ...session, signature }));
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

/** The join request identity currently on disk, or null when none was issued yet. */
async function attachmentRequestId(runtimeRoot: string): Promise<string | null> {
  const path = join(runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "session", "stardew-attachment-request.json");
  try {
    const request = JSON.parse(await readFile(path, "utf8")) as { requestId?: unknown };
    return typeof request.requestId === "string" ? request.requestId : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Publishes the join manifest for the NEXT attachment request the coordinator
 * issues. Every admitted handoff (a cabin confirmation and the create path's own
 * manifest re-admission) mints a fresh request identity, and a manifest is bound
 * to exactly the request it was issued for, so a re-issued handoff needs its own
 * publication instead of the previous request's manifest.
 */
async function publishNextAttachmentAdmission(
  runtimeRoot: string,
  previousRequestId: string | null,
  cabin: PublishedCabin,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const current = await attachmentRequestId(runtimeRoot);
    if (current !== null && current !== previousRequestId) {
      await publishAttachmentAdmission(runtimeRoot, { requestId: current }, cabin);
      return;
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error("publish_next_attachment_admission_timeout");
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

test("staged Player Host admits internally, direct-spawns once, and projects only awaiting attestation", async () => {
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

test("the activation route stages the owned player host through the coordinator's own activation path", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture({ overrides: {} });
    try {
      // Failure caught: the composed shell issuing the `lifecycle_activation` admission for
      // `POST /lifecycle/activate` while dispatch has no branch for the path, so the browser's
      // first activation step answers 404 and the state can never leave `inactive` - which is
      // exactly why `setup` and `launch` refuse afterwards with
      // `stardew_player_host_launch_not_staged`.
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "inactive");
      const path = `${fixture.broker.origin}/api/composed-reference-game/v1/lifecycle/activate`;
      const response = await fetch(path, {
        method: "POST",
        headers: {
          origin: fixture.broker.origin,
          cookie: fixture.broker.cookie,
          "x-csrf-token": fixture.broker.csrfToken,
          "content-type": "application/json",
        },
      });
      assert.equal(response.status, 204);
      assert.equal(await response.text(), "");
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      // The route is a producer, not an opening: an unauthenticated caller is still refused and
      // the state it produced is not advanced by the refusal.
      const unauthenticated = await fetch(path, {
        method: "POST",
        headers: { origin: fixture.broker.origin, "content-type": "application/json" },
      });
      assert.equal(unauthenticated.status, 401);
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup inspection failure preserves registration and does not spawn Player Host", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture({
      overrides: { createInstallationInspector: async () => { throw new Error("controlled_inspector_unavailable"); } },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const registrationBeforeSetup = await readStardewInstallationRegistration(fixture.runtimeRoot);
      await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(
          fixture.broker.issue("game_setup"),
          { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" },
        ),
        /stardew_game_setup_failed/,
      );
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), registrationBeforeSetup);
      assert.equal(fixture.playerSpawnCalls.length, 0);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup registers only the selected installation and Player Host fresh-admits it immediately before spawning", async () => {
  await withWindowsPlatform(async () => {
    const setupChain = installationChain.map((entry, index) => index === 2
      ? Object.freeze({ ...entry, fileId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
      : entry);
    const launchChain = installationChain.map((entry, index) => index === 2
      ? Object.freeze({ ...entry, fileId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })
      : entry);
    const inspector = sequencedInstallationInspector([
      [setupChain, setupChain],
      [launchChain, launchChain, launchChain],
    ]);
    const fixture = await createFixture({
      overrides: { createInstallationInspector: async () => inspector },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" });
      assert.deepEqual(fixture.playerSpawnCalls, []);
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), {
        schema: "gamebuddy-stardew-installation-registration/v1",
        binding: { rootLayoutVersion: 1 },
        revision: 3,
        state: "ready",
        locator: gameDirectoryCandidate,
        activeAttempt: { bootstrapCorrelation: "bootstrap-coordinator-1" },
      });
      await fixture.coordinator.activationOwner.launchPlayerHost(
        fixture.broker.issue("game_launch"),
        { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 },
      );
      assert.equal(fixture.playerSpawnCalls.length, 1);
      assert.equal(JSON.stringify(fixture.coordinator.activationOwner.readPrivateActivationSnapshot()).includes(gameDirectoryCandidate), false);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup projects activeAttempt without spawning Player Host", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const registration = await readStardewInstallationRegistration(fixture.runtimeRoot);
      assert.equal(registration?.state, "ready");
      assert.deepEqual(registration?.activeAttempt, { bootstrapCorrelation: "bootstrap-coordinator-1" });
      await fixture.coordinator.activationOwner.setupPlayerHost(
        fixture.broker.issue("game_setup"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" },
      );
      const staged = await readStardewInstallationRegistration(fixture.runtimeRoot);
      assert.equal(staged?.state, "ready");
      assert.deepEqual(staged?.activeAttempt, { bootstrapCorrelation: "bootstrap-coordinator-1" });
      assert.equal(fixture.playerSpawnCalls.length, 0);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("launch-readiness generation is 0 before activation, then 1 while staged, and resets once launch starts", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      assert.equal(fixture.coordinator.launchReadinessReader.readLaunchReadinessView().generation, 0);
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      assert.equal(fixture.coordinator.launchReadinessReader.readLaunchReadinessView().generation, 1);
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

test("contained Player Host success constructs the real contained runtime and session launch with exact typed-facts plan and 60s deadline", async () => {
  await withWindowsPlatform(async () => {
    const sessionCalls: Array<Readonly<{ operation: string; input: Record<string, unknown> }>> = [];
    const firstDeadlineUnixMs: number[] = [];
    const session: DesktopGuardianSession = Object.freeze({
      async arm(input) {
        sessionCalls.push({ operation: "arm", input: { ...input, privateFrame: "<bytes>" } });
        return containedSessionAck("arm_attempt");
      },
      async launch(input) {
        sessionCalls.push({ operation: "launch", input: { ...input, privateFrame: [...input.privateFrame] } });
        firstDeadlineUnixMs.push(input.deadlineUnixMs);
        return containedSessionAck("launch_role", input.role);
      },
      async contain(input) {
        sessionCalls.push({ operation: "contain", input: { ...input } });
        return containedSessionAck("contain_role", input.role);
      },
      // These launches never drive a recovery, but the session contract carries
      // it and an honest literal fake answers it explicitly.
      async recover() {
        sessionCalls.push({ operation: "recover", input: {} });
        return Object.freeze({ outcome: "contained" as const });
      },
      async close() { sessionCalls.push({ operation: "close", input: {} }); },
    });
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(createDesktopGuardianGameRuntimePlatform(session));
    // Deterministic lifecycle clock: the RoleLaunchOperation deadline must be
    // exactly this fixed instant plus the budget, never a rubric of uncertainty.
    const fixedNow = Date.now();
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator, containedLaunchNowMs: () => fixedNow } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" });
      await fixture.coordinator.activationOwner.launchPlayerHost(
        fixture.broker.issue("game_launch"),
        { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 },
      );
      // Neither the Player Host nor the AI-client process-owner raw-spawn path
      // may run when the contained runtime owns the launch.
      assert.equal(fixture.playerSpawnCalls.length, 0);
      assert.equal(fixture.spawnCalls.length, 0);
      assert.deepEqual(sessionCalls.map((call) => call.operation), ["arm", "launch"]);
      const launchCall = sessionCalls[1]!;
      assert.equal(launchCall.input.role, "player_host");
      assert.equal(launchCall.input.guardianEpoch, 1);
      assert.equal(launchCall.input.attemptId, "bootstrap-coordinator-1");
      const decode = (frame: Uint8Array) => JSON.parse(new TextDecoder().decode(frame)) as Record<string, unknown>;
      const plan = decode(new Uint8Array(launchCall.input.privateFrame as readonly number[]));
      // ParseLaunch schema: exactly the ten keys, fully qualified executable/cwd,
      // and the seven-key environment allowlist with the generation var.
      assert.deepEqual(Object.keys(plan).sort(), ["arguments", "attemptId", "cwd", "deadlineUnixMs", "environment", "executable", "guardianEpoch", "guardianInstanceId", "planId", "role"].sort());
      assert.equal(plan.role, "player_host");
      assert.equal(plan.planId === undefined || (typeof plan.planId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(plan.planId)), true, "planId");
      assert.equal(plan.executable, `${gameDirectoryCandidate}\\StardewModdingAPI.exe`);
      assert.equal(plan.cwd, gameDirectoryCandidate);
      assert.deepEqual(plan.arguments, ["--mods-path", join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "player-host", "Mods")]);
      const environment = plan.environment as Record<string, string>;
      assert.deepEqual(Object.keys(environment).sort(), [...STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS].sort());
      assert.equal(environment.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "player-generation-1");
      const deadlineUnixMs = firstDeadlineUnixMs[0]!;
      assert.equal(plan.deadlineUnixMs, deadlineUnixMs);
      // Exact lifecycle-created deadline: fixed clock + budget, equal in both
      // the session launch input and the encoded plan.
      assert.equal(deadlineUnixMs, fixedNow + STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS);
      assert.equal(plan.deadlineUnixMs, fixedNow + STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS);
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "awaiting_player_host_attestation");
      // The coordinated launch decision rejects a concurrent launch while the
      // first invocation's launchPromise remains authoritative.
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(
          fixture.broker.issue("game_launch"),
          { apiVersion: 1, idempotencyKey: "CCEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 },
        ),
        /stardew_game_launch_in_progress/,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("explicit endgame settles the contained attempt, releases the registration pointer, and projects gameended", async () => {
  await withWindowsPlatform(async () => {
    const sessionCalls: Array<Readonly<{ operation: string; input: Record<string, unknown> }>> = [];
    const session: DesktopGuardianSession = Object.freeze({
      async arm(input) {
        sessionCalls.push({ operation: "arm", input: { ...input, privateFrame: "<bytes>" } });
        return containedSessionAck("arm_attempt");
      },
      async launch(input) {
        sessionCalls.push({ operation: "launch", input: { ...input, privateFrame: [...input.privateFrame] } });
        return containedSessionAck("launch_role", input.role);
      },
      async contain(input) {
        sessionCalls.push({ operation: "contain", input: { ...input } });
        return containedSessionAck("contain_role", input.role);
      },
      // These launches never drive a recovery, but the session contract carries
      // it and an honest literal fake answers it explicitly.
      async recover() {
        sessionCalls.push({ operation: "recover", input: {} });
        return Object.freeze({ outcome: "contained" as const });
      },
      async close() { sessionCalls.push({ operation: "close", input: {} }); },
    });
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(createDesktopGuardianGameRuntimePlatform(session));
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await publishSignedPlayerHostSession(fixture.runtimeRoot, "player-generation-1", availableCabins, Date.now() + 5 * 60_000);
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 }));
      // Bind the attachment: launch alone leaves the registration pointer held
      // but no attachment generation, exactly like the product cabin flow.
      await confirmFirstCabin(fixture);
      // The launch bound the registration's active attempt: the pointer is held.
      assert.deepEqual(
        (await readStardewInstallationRegistration(fixture.runtimeRoot))?.activeAttempt,
        { bootstrapCorrelation: "bootstrap-coordinator-1" },
      );
      const command = { apiVersion: 1 as const, idempotencyKey: "endgame-key-1", expectedAttachmentGeneration: 1, confirm: true as const };
      const result = await fixture.coordinator.activationOwner.endgameGame(fixture.broker.issue("game_endgame"), command);
      assert.deepEqual(result, { apiVersion: 1, status: "gameended" });
      // The explicit endgame is what releases the pointer: an ordinary close
      // deliberately never contains the Player, so nothing else could.
      assert.equal((await readStardewInstallationRegistration(fixture.runtimeRoot))?.activeAttempt, null);
      // Both roles were contained through the Guardian, and the durable owner
      // attempt reached its terminal contained state.
      const containCalls = sessionCalls.filter((call) => call.operation === "contain");
      assert.deepEqual(containCalls.map((call) => call.input.role), ["player_host", "ai_client"]);
      const ownerPath = join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "owner.json");
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
      assert.equal(owner.state, "contained");
      assert.equal(owner.guardianState, "contained");
      assert.equal(owner.playerHostState, "contained");
      assert.equal(owner.aiClientState, "contained");
      // Replay is idempotent and never re-settles the attempt.
      const containCountAfterFirst = containCalls.length;
      assert.deepEqual(
        await fixture.coordinator.activationOwner.endgameGame(fixture.broker.issue("game_endgame"), command),
        { apiVersion: 1, status: "gameended" },
      );
      assert.equal(sessionCalls.filter((call) => call.operation === "contain").length, containCountAfterFirst);
      // Idempotency is per ATTEMPT, not merely per idempotency key: the same
      // terminal outcome must come back under a fresh key too, instead of
      // re-driving the runtime into its settled latch and surfacing an opaque
      // `stardew_contained_runtime_settlement_unavailable` for an ended game.
      const settleCountAfterFirst = sessionCalls.filter((call) => call.operation === "close").length;
      assert.deepEqual(
        await fixture.coordinator.activationOwner.endgameGame(fixture.broker.issue("game_endgame"), {
          ...command,
          idempotencyKey: "endgame-key-2",
        }),
        { apiVersion: 1, status: "gameended" },
      );
      assert.equal(sessionCalls.filter((call) => call.operation === "contain").length, containCountAfterFirst);
      assert.equal(sessionCalls.filter((call) => call.operation === "close").length, settleCountAfterFirst);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("contained Player Host launch failure after the claim durably quarantines the exact owner record", async () => {
  await withWindowsPlatform(async () => {
    const sessionCalls: Array<Readonly<{ operation: string; input: Record<string, unknown> }>> = [];
    const session: DesktopGuardianSession = Object.freeze({
      async arm(input) {
        sessionCalls.push({ operation: "arm", input: { ...input, privateFrame: "<bytes>" } });
        return containedSessionAck("arm_attempt");
      },
      async launch(input) {
        sessionCalls.push({ operation: "launch", input: { ...input, privateFrame: [...input.privateFrame] } });
        throw new Error("controlled_contained_native_launch_failure");
      },
      async contain(input) {
        sessionCalls.push({ operation: "contain", input: { ...input } });
        return containedSessionAck("contain_role", input.role);
      },
      // These launches never drive a recovery, but the session contract carries
      // it and an honest literal fake answers it explicitly.
      async recover() {
        sessionCalls.push({ operation: "recover", input: {} });
        return Object.freeze({ outcome: "contained" as const });
      },
      async close() { sessionCalls.push({ operation: "close", input: {} }); },
    });
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(createDesktopGuardianGameRuntimePlatform(session));
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" });
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(
          fixture.broker.issue("game_launch"),
          { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 },
        ),
        /stardew_player_host_launch_failed/,
      );
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "failed");
      // Durable authority, not just the lifecycle snapshot: the exact owner record
      // must be quarantined (termination of the launchMayHaveRun path).
      assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
      assert.equal(fixture.playerSpawnCalls.length, 0);
      // The claim was attempted exactly once: no blind native retry.
      assert.deepEqual(sessionCalls.map((call) => call.operation), ["arm", "launch"]);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("contained Player Host decision failing before the claim restores staged with zero session calls and a retry succeeds", async () => {
  await withWindowsPlatform(async () => {
    const sessionCalls: Array<Readonly<{ operation: string; input: Record<string, unknown> }>> = [];
    const session: DesktopGuardianSession = Object.freeze({
      async arm(input) {
        sessionCalls.push({ operation: "arm", input: { ...input, privateFrame: "<bytes>" } });
        return containedSessionAck("arm_attempt");
      },
      async launch(input) {
        sessionCalls.push({ operation: "launch", input: { ...input, privateFrame: [...input.privateFrame] } });
        return containedSessionAck("launch_role", input.role);
      },
      async contain(input) {
        sessionCalls.push({ operation: "contain", input: { ...input } });
        return containedSessionAck("contain_role", input.role);
      },
      // These launches never drive a recovery, but the session contract carries
      // it and an honest literal fake answers it explicitly.
      async recover() {
        sessionCalls.push({ operation: "recover", input: {} });
        return Object.freeze({ outcome: "contained" as const });
      },
      async close() { sessionCalls.push({ operation: "close", input: {} }); },
    });
    // Stale lifecycle clock: the RoleLaunchOperation deadline is invalid before
    // any native/session call, so the launch decision fails pre-claim.
    let nowMs: () => number = () => Date.now() - 1_000_000;
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(createDesktopGuardianGameRuntimePlatform(session));
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator, containedLaunchNowMs: () => nowMs() } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" });
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(
          fixture.broker.issue("game_launch"),
          { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 },
        ),
        /stardew_player_host_launch_failed/,
      );
      // Pre-claim failure: staged marker restored and no native/session call ran.
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.deepEqual(sessionCalls.length, 0);
      assert.equal(fixture.playerSpawnCalls.length, 0);
      // A fresh launch invocation with a valid lifecycle clock succeeds through
      // the same real runtime/executor path.
      nowMs = () => Date.now();
      await fixture.coordinator.activationOwner.launchPlayerHost(
        fixture.broker.issue("game_launch"),
        { apiVersion: 1, idempotencyKey: "CCEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 },
      );
      assert.deepEqual(sessionCalls.map((call) => call.operation), ["arm", "launch"]);
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "awaiting_player_host_attestation");
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("contained AI and Player roles share one per-owner runtime, close drains AI and preserves the Player", async () => {
  await withWindowsPlatform(async () => {
    const sessionCalls: Array<Readonly<{ operation: string; input: Record<string, unknown> }>> = [];
    const session: DesktopGuardianSession = Object.freeze({
      async arm(input) {
        sessionCalls.push({ operation: "arm", input: { ...input, privateFrame: "<bytes>" } });
        return containedSessionAck("arm_attempt");
      },
      async launch(input) {
        sessionCalls.push({ operation: "launch", input: { ...input, privateFrame: [...input.privateFrame] } });
        return containedSessionAck("launch_role", input.role);
      },
      async contain(input) {
        sessionCalls.push({ operation: "contain", input: { ...input } });
        return containedSessionAck("contain_role", input.role);
      },
      // These launches never drive a recovery, but the session contract carries
      // it and an honest literal fake answers it explicitly.
      async recover() {
        sessionCalls.push({ operation: "recover", input: {} });
        return Object.freeze({ outcome: "contained" as const });
      },
      async close() { sessionCalls.push({ operation: "close", input: {} }); },
    });
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(createDesktopGuardianGameRuntimePlatform(session));
    const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
      overrides: { runtimeLaunchContained: collaborator },
    });
    try {
      // Player Host launched first through the runtime; the shared per-owner
      // runtime arms exactly once.
      assert.deepEqual(sessionCalls.map((call) => call.operation), ["arm", "launch"]);
      assert.equal(sessionCalls[1]!.input.role, "player_host");
      assert.equal(fixture.playerSpawnCalls.length, 0);
      assert.equal(fixture.spawnCalls.length, 0);
      // Cabin confirm launches the AI client through the SAME runtime: no second
      // arm, so the per-owner runtime binding is proven shared.
      await confirmFirstCabin(fixture);
      assert.deepEqual(sessionCalls.map((call) => call.operation), ["arm", "launch", "launch"]);
      assert.equal(sessionCalls[1]!.input.role, "player_host");
      assert.equal(sessionCalls[2]!.input.role, "ai_client");
      assert.equal(fixture.playerSpawnCalls.length, 0);
      assert.equal(fixture.spawnCalls.length, 0);
      // The contained launch marks the AI process owner awaiting attestation
      // without a pid, so the bridge correlation succeeds and both lifecycle
      // view slots stay authoritative.
      assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn",
      });
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).aiClient, {
        state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn", lastStopOutcome: "none",
      });
      // Close: the no-pid stop is a success no-op, then the AI role is drained
      // and the platform session closes. The Player Host is NOT contained here:
      // its Job is non-kill-on-close and an ordinary close must not end the
      // player's world. ADR-0007's superseding clarification forbids turning
      // last-handle close into an implicit endgame, and the survival task removes
      // "default close/crash player kill" outright, so a `contain_role` for
      // player_host on this path would be the defect.
      await fixture.coordinator.close();
      assert.deepEqual(fixture.aiKillCalls, []);
      assert.deepEqual(fixture.playerKillCalls, []);
      assert.deepEqual(sessionCalls.map((call) => call.operation), ["arm", "launch", "launch", "contain", "close"]);
      assert.equal(sessionCalls[3]!.input.role, "ai_client");
      assert.equal(
        sessionCalls.some((call) => call.operation === "contain" && call.input.role === "player_host"),
        false,
        "ordinary close must not contain the Player Host role",
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("production lifecycle coordinator has no direct-spawn fallback and both role launches fail closed without a runtime collaborator", async () => {
  // The compiled test runs from dist-test; the source probe reads the tracked
  // module from the Host source tree.
  const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "stardew-production-lifecycle-coordinator.internal.ts"), "utf8");
  const productionFactoryStart = source.indexOf("export function createStardewProductionLifecycleCoordinator(");
  assert.notEqual(productionFactoryStart, -1);
  const productionFactory = source.slice(productionFactoryStart);
  // The production factory region never invokes the direct-spawn Stage C/D
  // consumers; the test reference lives only in the testing adapter. The
  // contained variants use the distinct `…Contained(` call shapes.
  assert.equal(/internal\.launchStagedPlayerHost\s*\(/.test(productionFactory), false);
  assert.equal(/internal\.launchMaterializedAiClient\s*\(/.test(productionFactory), false);
  // Without the runtime collaborator both role launches fail closed.
  assert.match(productionFactory, /stardew_player_host_launch_runtime_unavailable/);
  assert.match(productionFactory, /stardew_ai_client_launch_runtime_unavailable/);
  assert.match(productionFactory, /containedRuntimeTeardownFromCollaborator/);
  assert.doesNotMatch(productionFactory, /installationDiscoveryOverlay/);
  // Loop 4 composition seams: the production factory forwards the one semantic
  // Game authority and mounts the Loop 4 path B' world-creation seam built from
  // that same authority, so the create path no longer carries an unmounted seam
  // argument. What is pinned here is that the ONE owner-bound seam reaches
  // createCoordinator.
  assert.match(productionFactory, /createStardewWorldBindingResolverFromGameAuthority\(game\)/);
  assert.match(productionFactory, /\n\s*game,\n\s*createWorldBindingSeam,\n\s*containedRuntimeTeardown/);
  assert.equal(/\n\s*game,\n\s*undefined,\n\s*containedRuntimeTeardown/.test(productionFactory), false);
  // The mounted seam is the integration-private production one: it is built per
  // create from the owner-bound attachment flow (whose staged session material
  // signs and scopes the manifest read) and the join request identity this
  // create's own admission minted.
  assert.match(productionFactory, /createStardewWorldCreationBindingSeam\(/);
  assert.match(productionFactory, /createStardewIssuedJoinManifestSource\(/);
  assert.match(productionFactory, /internal\.createOwnedPlayerHostAttachmentFlow\(owner\)/);
  assert.match(productionFactory, /StardewWorldCreationSeamFactory/);
  // The create path itself builds that seam per create, only after its own
  // manifest handoff admission and before any durable registration.
  const createPathStart = source.indexOf("const createGameSession: StardewProductionLifecycleActivationOwner[\"createGameSession\"]");
  assert.notEqual(createPathStart, -1);
  const createPath = source.slice(createPathStart, source.indexOf("const cancelResume: StardewProductionLifecycleActivationOwner"));
  const admissionIndex = createPath.indexOf("handoffCoordinator.confirmAndAdmit(choice.selection");
  const joinRequestIndex = createPath.indexOf("joinRequestId: handoffCoordinator.readAdmittedJoinRequestId(handoffOwner, manifestAdmission)");
  const seamIndex = createPath.indexOf("createWorldBindingSeamFactory({");
  const seamCallIndex = createPath.indexOf("worldCreationSeam.createWorldBinding({");
  const registerIndex = createPath.indexOf("creationAuthority.registerGameSessionWorldBinding({");
  const completeIndex = createPath.indexOf("creationAuthority.completeGameSessionBinding({");
  const materializeIndex = createPath.indexOf("materializeAiClientProfileAfterManifestAdmission(handoffOwner, manifestAdmission)");
  for (const [name, index] of [
    ["manifest handoff admission", admissionIndex],
    ["admitted join request identity", joinRequestIndex],
    ["per-create seam construction", seamIndex],
    ["world binding creation", seamCallIndex],
    ["binding registration", registerIndex],
    ["session completion", completeIndex],
    ["AI-client profile materialization", materializeIndex],
  ] as const) assert.notEqual(index, -1, `${name} missing from the create path`);
  assert.ok(seamIndex < joinRequestIndex && joinRequestIndex < seamCallIndex, "the per-create seam is built from the admitted join request identity");
  assert.ok(admissionIndex < seamIndex, "the manifest handoff admission precedes the world-binding seam");
  assert.ok(admissionIndex < seamCallIndex && seamCallIndex < registerIndex, "the seam runs after the admission and before registration");
  assert.ok(registerIndex < completeIndex, "the durable create protocol order is preserved");
  assert.ok(completeIndex < materializeIndex, "the AI-client profile is materialized only after the session completed");
});

/**
 * The contained runtime seam this coordinator consumes is a promise-returning
 * one: its consumers await the returned value (or attach only a rejection
 * handler) and hold no try/catch around the call, because a failure it reports
 * IS the failure they handle. That makes `async` part of the adapters' contract
 * rather than a formatting choice: an adapter that only chains `.then()` onto an
 * already-`async` collaborator member cannot reject, so the day a refusal is
 * added under such a member -- a guard in the composition, a deadline check, a
 * failed outcome -- it leaves the adapter's frame as a synchronous throw and
 * reaches the product seam as an unhandled exception instead of the awaited
 * failure the caller handles.
 *
 * Every call below is made OUTSIDE `await` and OUTSIDE `try` on purpose: a
 * wrapper that throws synchronously fails this test at the call itself, while a
 * wrapper that rejects is observed by the catch-only handlers.
 */
test("contained runtime adapters surface every refusal as a rejection rather than a synchronous throw", async () => {
  const beneathRefusal = "controlled_refusal_below_the_adapter";
  const deadlineRefusal = "stardew_player_host_role_launch_operation_deadline_invalid";
  // A synchronously refusing member is the shape a promise-returning guard takes
  // when it forgets its `async`; the platform factory declares every
  // promise-returning member `async` for exactly this reason.
  const refuseSynchronously = (): never => { throw new Error(beneathRefusal); };
  const refusingCollaborator = (ownersRecoveryHalf: Readonly<Record<string, unknown>>): StardewPlayerHostRuntimeLaunchCollaborator =>
    Object.freeze({
      launchPlayerHost: refuseSynchronously,
      launchAiClient: refuseSynchronously,
      containPlayerHost: refuseSynchronously,
      containAiClient: refuseSynchronously,
      recovery: refuseSynchronously,
      settle: refuseSynchronously,
      close: refuseSynchronously,
      ...ownersRecoveryHalf,
    }) as unknown as StardewPlayerHostRuntimeLaunchCollaborator;
  // The adapter forwards a recovery only to a collaborator that carries the
  // owner-held recovery half; without that half, the adapter's own refusal is
  // the one at stake. The half is both members: a drive that can recover but not
  // finalize cannot close an attempt out, so it is not read as a drive at all.
  const withRecoveryHalf = refusingCollaborator({ recover: refuseSynchronously, finalizeRecovered: refuseSynchronously });
  const withoutRecoveryHalf = refusingCollaborator({});
  const withRecovery = containedRuntimeTeardownFromCollaborator(withRecoveryHalf);
  const withoutRecovery = containedRuntimeTeardownFromCollaborator(withoutRecoveryHalf);
  // Nothing below reads these arguments: every refusal is produced first.
  const owner = Object.freeze({}) as unknown as StardewOwnedPlayerHostBootstrap;
  const playerLaunch: StardewContainedPlayerHostLaunchSeam = Object.freeze({
    role: "player_host",
    launchGeneration: "generation-1",
    provideAuthorization: () => undefined,
  });
  const aiClientLaunch: StardewContainedAiClientLaunchSeam = Object.freeze({
    role: "ai_client",
    launchGeneration: "generation-1",
    provideAuthorization: () => undefined,
  });
  const recoveryRequest: StardewOwnerRecoveryRequest = Object.freeze({
    recoveryInstanceId: "0a5c1e7b-2f3d-4a90-8c11-6d2b7e4f9a02",
    readRecoveryBinding: async () => Object.freeze({}),
  });
  // The launch decision's own deadline check is the adapter's own synchronous
  // throw, before any collaborator member runs.
  const invalidDeadline = (): number => Number.NaN;

  const calls: readonly Readonly<{ member: string; refusal: string; pending: Promise<unknown> }>[] = [
    { member: "player host launch decision", refusal: beneathRefusal,
      pending: containedPlayerHostLaunchDecision(withRecoveryHalf, owner, playerLaunch) },
    { member: "AI client launch decision", refusal: beneathRefusal,
      pending: containedAiClientLaunchDecision(withRecoveryHalf, owner, aiClientLaunch) },
    { member: "player host launch decision with an invalid deadline", refusal: deadlineRefusal,
      pending: containedPlayerHostLaunchDecision(withRecoveryHalf, owner, playerLaunch, invalidDeadline) },
    { member: "AI client launch decision with an invalid deadline", refusal: deadlineRefusal,
      pending: containedAiClientLaunchDecision(withRecoveryHalf, owner, aiClientLaunch, invalidDeadline) },
    { member: "contain player host", refusal: beneathRefusal, pending: withRecovery.containPlayerHost(owner) },
    { member: "contain AI client", refusal: beneathRefusal, pending: withRecovery.containAiClient(owner) },
    { member: "recovery drive", refusal: beneathRefusal, pending: withRecovery.recover(owner, recoveryRequest) },
    { member: "recovery finalization", refusal: beneathRefusal, pending: withRecovery.finalizeRecovered(owner, recoveryRequest) },
    { member: "close", refusal: beneathRefusal, pending: withRecovery.close(owner) },
    { member: "settle", refusal: beneathRefusal, pending: withRecovery.settle(owner) },
    { member: "recovery drive without the owner-held recovery half", refusal: "stardew_contained_recovery_drive_unavailable",
      pending: withoutRecovery.recover(owner, recoveryRequest) },
    { member: "recovery finalization without the owner-held recovery half", refusal: "stardew_contained_recovery_drive_unavailable",
      pending: withoutRecovery.finalizeRecovered(owner, recoveryRequest) },
  ];
  assert.equal(calls.length, 12);

  for (const call of calls) {
    // A catch-only consumer: no fulfillment branch and no surrounding try/catch,
    // exactly the shape the product seam uses.
    const refusal = await call.pending.catch((error: unknown) => error);
    assert.ok(refusal instanceof Error, `${call.member} must reject, got ${String(refusal)}`);
    assert.equal(refusal.message, call.refusal, `${call.member} must reject with its own refusal`);
  }
});

/**
 * The recovery drive the admission judge uses: one bounded recovery, closed out
 * in the same step. The seams below are scripted, so the ordering, the
 * exactly-once attempt count and every refusal path are observed rather than
 * assumed.
 *
 * A recovery that did not reach a terminal the drive accepts is never finalized:
 * an uncertain native recovery must be neither closed out as if it had succeeded
 * nor re-driven. Its two failing answers are pinned separately, because they do not
 * mean the same thing: `unavailable` reports a recovery that did not reach
 * containment, while a held native gate reports the LEASE verdict - the holder
 * was not proven gone - under its own bounded code. The two terminals the drive
 * DOES accept each go through their own closure, and the order is pinned: the
 * closure runs before the terminal's code is reported, and a closure that refuses
 * replaces that code rather than being swallowed.
 */
test("the owner recovery drive finalizes every terminal it accepts, exactly once, and never fabricates one", async () => {
  const request: StardewOwnerRecoveryRequest = Object.freeze({
    recoveryInstanceId: "0a5c1e7b-2f3d-4a90-8c11-6d2b7e4f9a02",
    readRecoveryBinding: async () => Object.freeze({}),
  });
  const owner = Object.freeze({}) as unknown as StardewOwnedPlayerHostBootstrap;
  const scripted = (
    events: string[],
    recover: (received: StardewOwnerRecoveryRequest) => Promise<RedactedRecoveryOutcome>,
    finalize: (received: StardewOwnerRecoveryRequest) => Promise<void>,
    finalizeAiSettled: (received: StardewOwnerRecoveryRequest) => Promise<void> = finalize,
  ): StardewContainedRuntimeTeardown => Object.freeze({
    containPlayerHost: async () => { events.push("containPlayerHost"); },
    containAiClient: async () => { events.push("containAiClient"); },
    settle: async () => { events.push("settle"); },
    recover: async (_owner, received) => {
      events.push("recover");
      return recover(received);
    },
    finalizeRecovered: async (_owner, received) => {
      events.push("finalizeRecovered");
      await finalize(received);
    },
    finalizeRecoveredAiSettled: async (_owner, received) => {
      events.push("finalizeRecoveredAiSettled");
      await finalizeAiSettled(received);
    },
    close: async () => { events.push("close"); },
  });

  // (a) A recovery that reached containment is finalized, with the SAME request
  // object the recovery took: the actor the durable CASes recorded and the actor
  // the finalization must match cannot drift apart.
  const successEvents: string[] = [];
  const receivedRequests: StardewOwnerRecoveryRequest[] = [];
  await driveStardewOwnedPlayerHostRecovery(
    scripted(
      successEvents,
      async (received) => { receivedRequests.push(received); return Object.freeze({ status: "recovered" as const }); },
      async (received) => { receivedRequests.push(received); },
    ),
    owner,
    request,
  );
  assert.deepEqual(successEvents, ["recover", "finalizeRecovered"]);
  assert.deepEqual(receivedRequests, [request, request]);

  // (b) An outcome short of containment is never finalized, and the recovery is
  // attempted exactly once.
  const unavailableEvents: string[] = [];
  const unavailableTeardown = scripted(
    unavailableEvents,
    async () => Object.freeze({ status: "unavailable" as const }),
    async () => { throw new Error("finalization_must_not_run"); },
  );
  await assert.rejects(
    () => driveStardewOwnedPlayerHostRecovery(unavailableTeardown, owner, request),
    /stardew_owner_recovery_unavailable/,
  );
  assert.deepEqual(unavailableEvents, ["recover"]);

  // (c) A recovery the seam refuses outright propagates that bounded refusal and
  // still never finalizes anything.
  const refusedEvents: string[] = [];
  await assert.rejects(
    () => driveStardewOwnedPlayerHostRecovery(
      scripted(
        refusedEvents,
        async () => { throw new Error("stardew_contained_recovery_drive_unavailable"); },
        async () => { throw new Error("finalization_must_not_run"); },
      ),
      owner,
      request,
    ),
    /stardew_contained_recovery_drive_unavailable/,
  );
  assert.deepEqual(refusedEvents, ["recover"]);

  // (d) A finalization that refuses reports its own bounded error and does not
  // re-drive the recovery.
  const finalizeRefusedEvents: string[] = [];
  await assert.rejects(
    () => driveStardewOwnedPlayerHostRecovery(
      scripted(
        finalizeRefusedEvents,
        async () => Object.freeze({ status: "recovered" as const }),
        async () => { throw new Error("stardew_bootstrap_owner_recovery_finalize_failed"); },
      ),
      owner,
      request,
    ),
    /stardew_bootstrap_owner_recovery_finalize_failed/,
  );
  assert.deepEqual(finalizeRefusedEvents, ["recover", "finalizeRecovered"]);

  // (e) Without the seam there is nothing to drive, and the refusal is bounded.
  await assert.rejects(
    () => driveStardewOwnedPlayerHostRecovery(undefined, owner, request),
    /stardew_owner_recovery_seam_unavailable/,
  );

  // (f) A HELD native gate carries its own bounded code instead of the generic
  // unavailable one. The two are not interchangeable: this answer is about the
  // holder's lease - a live handle exists at the lease name, so the holder was
  // NOT proven gone - and a caller that has to decide whether that holder's world
  // slot may be released reads exactly this code to refuse. It finalizes nothing,
  // drives the recovery once, and is never retried.
  const gateHeldEvents: string[] = [];
  await assert.rejects(
    () => driveStardewOwnedPlayerHostRecovery(
      scripted(
        gateHeldEvents,
        async () => Object.freeze({ status: "gate_held" as const }),
        async () => { throw new Error("finalization_must_not_run"); },
      ),
      owner,
      request,
    ),
    (error: unknown) => error instanceof Error && error.message === "stardew_owner_recovery_gate_held",
  );
  assert.deepEqual(gateHeldEvents, ["recover"]);

  // (g) The AI-side terminal is closed out through the seam's OWN terminal member
  // and only then reported under its own bounded code, checked BEFORE the generic
  // non-recovered refusal so it is never reported as an uncertainty or as a held
  // gate: the gate DID open, the AI side is settled and the player's world was
  // deliberately preserved. The close-out runs FIRST, so no attempt is ever
  // reported as closed out while it still occupies its registration.
  const aiSettledEvents: string[] = [];
  await assert.rejects(
    () => driveStardewOwnedPlayerHostRecovery(
      scripted(
        aiSettledEvents,
        async () => Object.freeze({ status: "ai_settled_player_preserved" as const }),
        async () => { throw new Error("finalization_must_not_run"); },
        async () => undefined,
      ),
      owner,
      request,
    ),
    (error: unknown) => error instanceof Error && error.message === "stardew_owner_recovery_ai_settled_player_preserved",
  );
  assert.deepEqual(aiSettledEvents, ["recover", "finalizeRecoveredAiSettled"]);

  // (h) A close-out that refuses is never swallowed, and the terminal code is NOT
  // reported for an attempt that was not closed out: the attempt would still
  // occupy its registration, so reporting the terminal would be exactly the
  // fabricated success this seam must never produce.
  const aiSettledRefusedEvents: string[] = [];
  await assert.rejects(
    () => driveStardewOwnedPlayerHostRecovery(
      scripted(
        aiSettledRefusedEvents,
        async () => Object.freeze({ status: "ai_settled_player_preserved" as const }),
        async () => { throw new Error("finalization_must_not_run"); },
        async () => { throw new Error("stardew_bootstrap_owner_recovery_finalize_failed"); },
      ),
      owner,
      request,
    ),
    (error: unknown) => error instanceof Error && error.message === "stardew_bootstrap_owner_recovery_finalize_failed",
  );
  assert.deepEqual(aiSettledRefusedEvents, ["recover", "finalizeRecoveredAiSettled"]);
});

/**
 * The coordinator reads two different states off the SAME composition probe:
 * "the owner's first one-shot activation is still intact" (a create launches
 * through the untouched reservations) and "this attach cannot be built here"
 * (the attach defers to the next layer's fresh authority). The composition is
 * the only side that can see its refusal's text, so a message comparison on this
 * side is a silent coupling: renaming that text would reclassify an intact
 * activation as a hard failure with no test on either side going red.
 *
 * This test drives the real composition to its real refusal and asks the real
 * classifiers about that exact value, then asks the same classifier about the
 * refusal's text rebuilt as a plain Error -- the value a message comparison
 * accepted. It fails in both directions: if the composition stops refusing with
 * the port's exported identity, and if this side starts classifying by text
 * again.
 */
test("the intact first Farmhand activation classification is bound to the composition's typed refusal", async () => {
  // A materialized AI-client profile whose first activation was never consumed:
  // exactly the owner shape a create launches through.
  const fixture = await prepareMaterializedAiClientFixture();
  try {
    let refusal: unknown;
    try {
      await fixture.testCore.prepareFreshFarmhandAiClientActivation(fixture.owner);
    } catch (error) {
      refusal = error;
    }
    assert.ok(
      refusal instanceof FarmhandBridgeConnectionNotAvailableError,
      `the composition must refuse with the platform contract's identity, got ${String(refusal)}`,
    );
    // The composition's real refusal IS the intact-first-activation state...
    assert.equal(isFirstFarmhandAiClientActivationIntact(refusal), true);
    // ...and only that identity: the same text as a plain Error is not.
    assert.equal(isFirstFarmhandAiClientActivationIntact(new Error(refusal.message)), false);
    // The other consumer of the same probe still reads the refusal by its text,
    // and this lane deliberately left it that way: converting this one side must
    // not change what a resume attach defers on.
    assert.equal(isResumeAttachDeferredError(refusal), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
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

test("installation discovery reports unavailable sources and no candidates without invoking registration", async () => {
  await withWindowsPlatform(async () => {
    const provider = createStardewInstallationDiscoveryProvider({});
    const fixture = await createFixture({ overrides: { installationDiscoveryOverlay: provider } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const result = await fixture.coordinator.activationOwner.readInstallationDiscovery(fixture.broker.issue("discovery_read"));
      assert.deepEqual(result, { candidates: [], diagnostics: ["source-unavailable", "no-candidates"] });
      assert.equal(fixture.playerSpawnCalls.length, 0);
    } finally { await fixture.coordinator.close(); await fixture.broker.close(); }
  });
});

test("installation discovery routes admit each coordinator operation without operation mismatch", async () => {
  await withWindowsPlatform(async () => {
    const events: string[] = [];
    const provider: StardewInstallationDiscoveryProvider = Object.freeze({
      discover: async () => {
        events.push("discover");
        return {
          candidates: [{ candidateId: "candidate-01", source: "known-location" as const, label: "Stardew Valley", displayPath: "Detected installation (path hidden)", status: "admission_required" as const }],
          diagnostics: [],
        };
      },
      confirm: (candidateId: string) => {
        assert.equal(candidateId, "candidate-01");
        events.push("confirm");
        return gameDirectoryCandidate;
      },
      reset: () => { events.push("reset"); },
    });
    const fixture = await createFixture({
      overrides: {
        installationDiscoveryOverlay: provider,
        selectStardewFolder: async () => ({ status: "cancelled" as const }),
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const initial = await fixture.coordinator.activationOwner.readInstallationDiscovery(fixture.broker.issue("discovery_read"));
      assert.equal(initial.candidates.length, 1);
      assert.deepEqual(await fixture.coordinator.activationOwner.confirmInstallation(fixture.broker.issue("discovery_confirm"), "candidate-01"), { status: "registered" });
      const retried = await fixture.coordinator.activationOwner.retryInstallationDiscovery(fixture.broker.issue("discovery_retry"));
      assert.equal(retried.candidates.length, 1);
      assert.deepEqual(await fixture.coordinator.activationOwner.cancelInstallationSelection(fixture.broker.issue("discovery_cancel")), { status: "cancelled" });
      assert.deepEqual(await fixture.coordinator.activationOwner.openInstallationPicker(fixture.broker.issue("discovery_picker")), { status: "cancelled" });
      assert.deepEqual(events, ["discover", "confirm", "reset", "discover", "reset"]);
    } finally { await fixture.coordinator.close(); await fixture.broker.close(); }
  });
});

test("installation discovery retry resets the provider before rediscovery and cancellation", async () => {
  await withWindowsPlatform(async () => {
    const events: string[] = [];
    const provider: StardewInstallationDiscoveryProvider = Object.freeze({
      discover: async () => { events.push("discover"); return { candidates: [], diagnostics: ["no-candidates"] as const }; },
      confirm: () => { throw new Error("confirm_not_expected"); },
      reset: () => { events.push("reset"); },
    });
    const fixture = await createFixture({ overrides: { installationDiscoveryOverlay: provider } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.readInstallationDiscovery(fixture.broker.issue("discovery_read"));
      await fixture.coordinator.activationOwner.retryInstallationDiscovery(fixture.broker.issue("discovery_retry"));
      assert.deepEqual(
        await fixture.coordinator.activationOwner.cancelInstallationSelection(fixture.broker.issue("discovery_cancel")),
        { status: "cancelled" },
      );
      assert.deepEqual(events, ["discover", "reset", "discover", "reset"]);
    } finally { await fixture.coordinator.close(); await fixture.broker.close(); }
  });
});

test("manual installation picker cancellation and failure preserve registration without creating an active attempt", async () => {
  await withWindowsPlatform(async () => {
    for (const pickerResult of [{ status: "cancelled" as const }, new Error("picker_failure")]) {
      const fixture = await createFixture({ overrides: { selectStardewFolder: async () => { if (pickerResult instanceof Error) throw pickerResult; return pickerResult; } } });
      try {
        const registrationBefore = await readStardewInstallationRegistration(fixture.runtimeRoot);
        const activationBefore = fixture.coordinator.activationOwner.readPrivateActivationSnapshot();
        const readinessBefore = fixture.coordinator.launchReadinessReader.readLaunchReadinessView();
        const result = await fixture.coordinator.activationOwner.openInstallationPicker(fixture.broker.issue("discovery_picker"));
        assert.deepEqual(result, { status: pickerResult instanceof Error ? "unavailable" : "cancelled" });
        const registrationAfter = await readStardewInstallationRegistration(fixture.runtimeRoot);
        assert.deepEqual(registrationAfter, registrationBefore);
        assert.equal(registrationAfter?.locator, registrationBefore?.locator);
        assert.equal(registrationAfter?.revision, registrationBefore?.revision);
        assert.equal(registrationAfter?.state, registrationBefore?.state);
        assert.equal(registrationBefore?.activeAttempt, null);
        assert.equal(registrationAfter?.activeAttempt, null);
        assert.deepEqual(fixture.coordinator.activationOwner.readPrivateActivationSnapshot(), activationBefore);
        assert.deepEqual(fixture.coordinator.launchReadinessReader.readLaunchReadinessView(), readinessBefore);
        assert.deepEqual(fixture.playerSpawnCalls, []);
      } finally { await fixture.coordinator.close(); await fixture.broker.close(); }
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

test("staged Player Host admission failure restores staged and permits a later valid retry", async () => {
  await withWindowsPlatform(async () => {
    const changed = installationChain.map((entry, index) => index === 2
      ? Object.freeze({ ...entry, fileId: "ffffffffffffffffffffffffffffffff" })
      : entry);
    const inspector = sequencedInstallationInspector([
      [installationChain, changed],
      [installationChain, installationChain, installationChain],
    ]);
    const fixture = await createFixture({ overrides: { createInstallationInspector: async () => inspector } });
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

test("staged Player Host reparse admission failure is pre-launch, restores staged, and permits retry", async () => {
  await withWindowsPlatform(async () => {
    const reparse = installationChain.map((entry, index) => index === 1
      ? Object.freeze({ ...entry, isReparsePoint: true })
      : entry);
    const inspector = sequencedInstallationInspector([
      [reparse, reparse],
      [installationChain, installationChain, installationChain],
    ]);
    const fixture = await createFixture({ overrides: { createInstallationInspector: async () => inspector } });
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
  test(`staged Player Host ${failure} failure quarantines and permanently rejects retry`, async () => {
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

test("close during staged Player Host admission drains and prevents a later spawn", async () => {
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

test("ordinary close preserves the Player Host and never invokes its explicit stop", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 }));
      await fixture.coordinator.close();
      assert.deepEqual(fixture.playerKillCalls, []);
      assert.deepEqual(fixture.aiKillCalls, []);
      assert.equal(fixture.playerSpawnCalls.length, 1);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn",
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("ordinary close does not retry or terminate the Player Host", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture({ playerKillResults: [false, true] });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }).then(() => fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 }));
      await fixture.coordinator.close();
      assert.deepEqual(fixture.playerKillCalls, []);
      assert.equal(fixture.playerSpawnCalls.length, 1);
      await fixture.coordinator.close();
      assert.deepEqual(fixture.playerKillCalls, []);
      assert.deepEqual(fixture.aiKillCalls, []);
      assert.equal(fixture.playerSpawnCalls.length, 1);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn",
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
    assert.deepEqual({ brokerAttempts, aiAttempts, playerAttempts }, { brokerAttempts: 1, aiAttempts: 1, playerAttempts: 0 });
    await fixture.coordinator.close();
    assert.deepEqual({ brokerAttempts, aiAttempts, playerAttempts }, { brokerAttempts: 2, aiAttempts: 2, playerAttempts: 0 });
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
      () => Promise.resolve(createStardewProductionLifecycleCoordinator(manifest, () => null, undefined as unknown as SemanticGameProductionAuthority)),
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
    assert.deepEqual(fixture.playerKillCalls, []);
    assert.deepEqual(fixture.lifecycleOrder, ["bridge", "ai"]);
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

/**
 * Deterministic Slice-0 store stand-in for create tests: it enforces the same
 * pending→resumable / pending→failed / binding-terminal state machine as the
 * fresh-root production store, records every exact input (so the store-minted
 * gameSessionId can be verified across all durable steps), and exposes the
 * session rows for assertions.
 */
function fakeGameSessionCreationAuthority() {
  const bySession = new Map<string, ProductionGameSessionMetadata>();
  const byRequest = new Map<string, Readonly<{ metadata: ProductionGameSessionMetadata }>>();
  const bindings = new Map<string, ProductionGameSessionWorldBinding>();
  const operationBySession = new Map<string, string>();
  const holderBySession = new Map<string, string>();
  const inputs: unknown[] = [];
  const slotReads: unknown[] = [];
  const slotReleases: unknown[] = [];
  /**
   * The store's own slot locator: a registered row is always the holder, and the
   * settled rows a slot can carry are only reached when nothing is registered
   * (nothing is ever deleted, so the choice is ordered rather than row luck).
   */
  const locateSlotHolder = (
    integrationId: string,
    bindingRef: string,
  ): ProductionGameSessionWorldBinding | undefined => {
    const rows = [...bindings.values()].filter(
      (binding) => binding.integrationId === integrationId && binding.bindingRef === bindingRef,
    );
    return rows.find((binding) => binding.status === "registered") ??
      [...rows].sort((left, right) => (left.gameSessionId < right.gameSessionId ? -1 : 1))[0];
  };
  const authority: StardewGameSessionCreationAuthority = {
    async createGameSessionMetadata(input) {
      inputs.push("create");
      const existing = byRequest.get(input.creationRequestId);
      if (existing !== undefined) {
        const row = existing.metadata;
        if (row.integrationId !== input.integrationId || row.continuityIdentityId !== input.continuityIdentityId)
          throw new Error("game_session_creation_conflict");
        return row;
      }
      const metadata: ProductionGameSessionMetadata = Object.freeze({
        gameSessionId: randomUUID().replaceAll("-", ""),
        integrationId: input.integrationId,
        continuityIdentityId: input.continuityIdentityId,
        status: "pending",
        revision: 1,
      });
      bySession.set(metadata.gameSessionId, metadata);
      byRequest.set(input.creationRequestId, Object.freeze({ metadata }));
      return metadata;
    },
    async registerGameSessionWorldBinding(input) {
      inputs.push("register");
      const row = bySession.get(input.gameSessionId);
      if (row === undefined) throw new Error("game_session_world_binding_session_missing");
      if (row.status !== "pending" || row.integrationId !== input.integrationId || bindings.has(input.gameSessionId))
        throw new Error("game_session_world_binding_conflict");
      // Mirrors the store's cross-session slot rule (registerGameSessionWorldBinding):
      // one world slot is held by at most one live session, and the rejection
      // writes NO binding row, so the rejected session can only settle through
      // the pre-registration shape. A `terminal` binding belongs to an already
      // settled session whose residual save the native game owns and never
      // blocks a later create, and the same ref under another integration is
      // another world.
      const duplicate = [...bindings.values()].find(
        (binding) =>
          binding.gameSessionId !== input.gameSessionId &&
          binding.integrationId === input.integrationId &&
          binding.bindingRef === input.bindingRef &&
          binding.status === "registered",
      );
      if (duplicate !== undefined) throw new Error("game_session_world_binding_duplicate");
      const binding: ProductionGameSessionWorldBinding = Object.freeze({
        gameSessionId: input.gameSessionId,
        integrationId: input.integrationId,
        bindingRef: input.bindingRef,
        status: "registered",
        revision: 1,
      });
      bindings.set(input.gameSessionId, binding);
      operationBySession.set(input.gameSessionId, input.operationId);
      holderBySession.set(input.gameSessionId, input.holderHandle);
      return binding;
    },
    async completeGameSessionBinding(input) {
      inputs.push("complete");
      const row = bySession.get(input.gameSessionId);
      const binding = bindings.get(input.gameSessionId);
      if (row === undefined || byRequest.get(input.creationRequestId)?.metadata.gameSessionId !== input.gameSessionId || row.revision !== input.expectedRevision)
        throw new Error("game_session_metadata_conflict");
      if (binding === undefined || binding.integrationId !== row.integrationId || binding.status !== "registered")
        throw new Error("game_session_world_binding_missing");
      const updated = Object.freeze({ ...row, status: "resumable" as const, revision: row.revision + 1 });
      bySession.set(input.gameSessionId, updated);
      return updated;
    },
    async failGameSessionCreation(input) {
      inputs.push("fail");
      const row = bySession.get(input.gameSessionId);
      if (row === undefined || byRequest.get(input.creationRequestId)?.metadata.gameSessionId !== input.gameSessionId || row.revision !== input.expectedRevision)
        throw new Error("game_session_metadata_conflict");
      if (bindings.has(input.gameSessionId)) throw new Error("game_session_metadata_conflict");
      const updated = Object.freeze({ ...row, status: "failed" as const, revision: row.revision + 1 });
      bySession.set(input.gameSessionId, updated);
      return updated;
    },
    async markGameSessionWorldBindingTerminal(input) {
      inputs.push("terminal");
      const binding = bindings.get(input.gameSessionId);
      const row = bySession.get(input.gameSessionId);
      if (binding === undefined) throw new Error("game_session_world_binding_missing");
      if (binding.integrationId !== input.integrationId || operationBySession.get(input.gameSessionId) !== input.operationId)
        throw new Error("game_session_world_binding_conflict");
      // Terminal is sticky in the store: the same settle reads the terminal row
      // back instead of writing again.
      if (binding.status === "terminal") {
        if (input.expectedRevision !== 1) throw new Error("game_session_world_binding_conflict");
        return binding;
      }
      if (binding.revision !== input.expectedRevision)
        throw new Error("game_session_world_binding_conflict");
      // The store settles BOTH live pre-settle shapes onto the one canonical
      // terminal pair (terminal binding rev2 + failed metadata rev3), inside its
      // own single transaction: a completed session that failed after
      // registration (`resumable` rev2) and the shape a create leaves when its
      // completion never landed (`pending` rev1 with the binding already
      // registered). Any other row pair fails closed, and nothing is written
      // before both preconditions hold - the store applies them atomically.
      if (
        row === undefined ||
        !((row.status === "pending" && row.revision === 1) || (row.status === "resumable" && row.revision === 2))
      )
        throw new Error("game_session_world_binding_conflict");
      const terminal: ProductionGameSessionWorldBinding = Object.freeze({ ...binding, status: "terminal", revision: binding.revision + 1 });
      bindings.set(input.gameSessionId, terminal);
      bySession.set(input.gameSessionId, Object.freeze({ ...row, status: "failed", revision: 3 }));
      return terminal;
    },
    async readGameSessionWorldBindingSlotHolder(input) {
      slotReads.push(input);
      const row = locateSlotHolder(input.integrationId, input.bindingRef);
      if (row === undefined) return null;
      return Object.freeze({
        gameSessionId: row.gameSessionId,
        integrationId: row.integrationId,
        bindingRef: row.bindingRef,
        status: row.status,
        revision: row.revision,
        holderHandle: holderBySession.get(row.gameSessionId)!,
      });
    },
    async releaseGameSessionWorldBindingSlot(input) {
      slotReleases.push(input);
      const row = locateSlotHolder(input.integrationId, input.bindingRef);
      if (row === undefined) throw new Error(productionGameSessionWorldBindingSlotRelease.slotMissing);
      if (holderBySession.get(row.gameSessionId) !== input.holderHandle)
        throw new Error(productionGameSessionWorldBindingSlotRelease.handleMismatch);
      if (row.status !== "registered") throw new Error(productionGameSessionWorldBindingSlotRelease.holderTerminal);
      // The holder's own handle is checked before anything else is revealed, and
      // the readback deliberately carries no handle, so a caller can only ever
      // present the handle it read back from the slot.
      if (
        input.proof === null || typeof input.proof !== "object" ||
        input.proof.holderHandle !== input.holderHandle ||
        input.proof.verdict === null || typeof input.proof.verdict !== "object"
      ) throw new Error(productionGameSessionWorldBindingSlotRelease.proofInvalid);
      // This stand-in cannot read a verdict token's provenance or its value: the
      // store's reader for both is module-private, and the minted token is an
      // opaque object. So it checks the proof's shape and correlation only, and
      // the store refuses the look-alike the way its own tests pin. The release
      // tests therefore present the verdict the store's own mint function
      // produced, and the code paths that must never release are asserted by the
      // absence of a release call rather than by a refusal here.
      const metadata = bySession.get(row.gameSessionId);
      if (
        metadata === undefined ||
        !((metadata.status === "pending" && metadata.revision === 1) || (metadata.status === "resumable" && metadata.revision === 2))
      ) throw new Error("game_session_world_binding_conflict");
      // The one canonical terminal pair the store lands a released slot on, in
      // its own single transaction: terminal binding rev2 + failed metadata rev3.
      const terminal: ProductionGameSessionWorldBinding = Object.freeze({ ...row, status: "terminal", revision: row.revision + 1 });
      bindings.set(row.gameSessionId, terminal);
      bySession.set(row.gameSessionId, Object.freeze({ ...metadata, status: "failed", revision: 3 }));
      return terminal;
    },
  };
  return Object.freeze({
    authority,
    readMetadata: (gameSessionId: string): ProductionGameSessionMetadata | null => bySession.get(gameSessionId) ?? null,
    readBinding: (gameSessionId: string): ProductionGameSessionWorldBinding | null => bindings.get(gameSessionId) ?? null,
    listResumable: (): readonly ProductionGameSessionMetadata[] =>
      Object.freeze([...bySession.values()].filter((row) => row.status === "resumable" && bindings.get(row.gameSessionId)?.status === "registered")),
    inputs: (): readonly unknown[] => Object.freeze([...inputs]),
    sessions: (): readonly ProductionGameSessionMetadata[] => Object.freeze([...bySession.values()]),
    /** Slot reads are observations, not durable steps, so they stay out of `inputs`. */
    slotReads: (): readonly unknown[] => Object.freeze([...slotReads]),
    slotReleases: (): readonly unknown[] => Object.freeze([...slotReleases]),
  });
}

async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error("wait_for_condition_timeout");
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
  const inspector = sequencedInstallationInspector(
    [
      [installationChain, installationChain],
      [installationChain, installationChain, installationChain],
      [installationChain, installationChain, installationChain],
    ],
    async (sequenceIndex, readIndex) => {
      if (sequenceIndex !== 3 || readIndex !== 3 || tampered) return;
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

test("every admission point acquires its own fresh request-scoped installation capability", async () => {
  // Gate 5: the phases must admit independently rather than share one admission.
  // The coordinator's exchange point is the inspector FACTORY, re-invoked once
  // per admission; the fresh identity reread behind each call is what the phase
  // actually trusts. Counting factory invocations therefore shows the phases did
  // not share an admission.
  //
  // A full setup -> Stage C -> Stage D flow has THREE admission points, not two:
  //   1. picker-time registration (registerInstallationLocator) -- admits the
  //      selected locator before it is ever durable;
  //   2. Stage C (runPlayerHostLaunch) -- immediately before spawning the
  //      Player Host;
  //   3. Stage D (confirmCabinChoice) -- immediately before the AI-client launch.
  // Asserting the exact count is the point: a shared or skipped admission would
  // move this number, and the picker-time one is the easiest to lose because it
  // is the only admission that runs before any durable registration exists.
  let inspectorAcquisitions = 0;
  const inspector = sequencedInstallationInspector([
    [installationChain, installationChain],
    [installationChain, installationChain],
    [installationChain, installationChain, installationChain],
  ]);
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      createInstallationInspector: async () => {
        inspectorAcquisitions += 1;
        return inspector;
      },
    },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "fresh-capability-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command);
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    assert.deepEqual(await confirmation, { apiVersion: 1, status: "manifest_admitted" });

    assert.equal(inspectorAcquisitions, 3, "picker-time, Stage C and Stage D each admit anew");
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.equal(fixture.spawnCalls.length, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("manifest-admitted AI installation replacement is permanently uncertain and quarantines without AI spawn", async () => {
  const changed = installationChain.map((entry, index) => index === 2
    ? Object.freeze({ ...entry, fileId: "ffffffffffffffffffffffffffffffff" })
    : entry);
  const inspector = sequencedInstallationInspector([
    [installationChain, installationChain],
    [installationChain, installationChain, installationChain],
    [installationChain, installationChain, changed],
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
    assert.deepEqual(fixture.playerKillCalls, []);
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
    assert.deepEqual(fixture.playerKillCalls, []);
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
// ─── Slice 1B: coordinator fresh-generation resume seam ─────────────────────

test("resume admits a registered binding, bumps attachment generation to >= 2, pauses actions, and runs no old task", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    const result = await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(result, { apiVersion: 1, status: "accepted" });
    assert.equal(GameBrowserValidatorsV1.GameResumeResultV1Schema.Check(result), true);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "reconnecting",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    // No fresh native/attachment work and no old task in this slice.
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerSpawnCalls, []);
    assert.deepEqual(fixture.bridgeConnectCalls, []);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 0);
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 0);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("resume returns unavailable without creating an activation for a missing or terminal binding", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => null,
    },
  });
  try {
    const result = await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-absent", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(result, { apiVersion: 1, status: "unavailable" });
    assert.equal(GameBrowserValidatorsV1.GameResumeResultV1Schema.Check(result), true);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "unavailable" });
    assert.deepEqual(fixture.spawnCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("resume replays a duplicate idempotency key with the same accepted result and rejects a changed tuple", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    const command = { apiVersion: 1 as const, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 };
    const first = fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), command);
    const replay = fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), command);
    assert.equal(replay, first);
    assert.deepEqual(await first, { apiVersion: 1, status: "accepted" });
    assert.throws(
      () => fixture.coordinator.activationOwner.resume(
        fixture.broker.issue("game_resume"),
        { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 3 },
      ),
      /stardew_game_resume_idempotency_conflict/,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("resume fails closed when expectedAttachmentGeneration does not match the fresh generation", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.throws(
      () => fixture.coordinator.activationOwner.resume(
        fixture.broker.issue("game_resume"),
        { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
      ),
      /stardew_game_attachment_generation_conflict/,
    );
    // A mismatch must never mint a fresh activation.
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "reconnecting",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("resume rejects a second resume while the first is still in progress", async () => {
  let releaseSet: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseSet = resolve; });
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => {
        await gate;
        return { gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 };
      },
    },
  });
  try {
    const pending = fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.throws(
      () => fixture.coordinator.activationOwner.resume(
        fixture.broker.issue("game_resume"),
        { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
      ),
      /stardew_game_resume_in_progress/,
    );
    releaseSet!();
    assert.deepEqual(await pending, { apiVersion: 1, status: "accepted" });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("resume fails closed when a different resumed session is presented after one world binding", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async (input) =>
        input.gameSessionId === "session-abc"
          ? { gameSessionId: input.gameSessionId, integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }
          : { gameSessionId: input.gameSessionId, integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 2 },
    },
  });
  try {
    await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    // The same coordinator never attaches a second world binding.
    assert.throws(
      () => fixture.coordinator.activationOwner.resume(
        fixture.broker.issue("game_resume"),
        { apiVersion: 1, gameSessionId: "session-other", idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 3 },
      ),
      /stardew_game_resume_idempotency_conflict/,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});// ─── Slice 2: resume fresh attachment chain, stale teardown, and projection ──

test("slice 2: resume rejects while a live healthy attachment is attached without disturbing it", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "connected_idle",
    });
    // A live, healthy attachment is still a single-activation authority: the
    // fresh resume generation is refused without touching the live world.
    assert.throws(
      () => fixture.coordinator.activationOwner.resume(
        fixture.broker.issue("game_resume"),
        { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
      ),
      /stardew_game_runtime_unavailable/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.bridgeCloseCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("slice 2: resume closes a stale failed attachment through the shared teardown and truly re-attaches the fresh generation", async () => {
  // The gen-1 facade close fails once (stale failed attachment), then succeeds
  // when the resume reuses the exact teardown machinery.
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    gameRuntimeBindingCloseResults: [false, true],
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await assert.rejects(
      fixture.coordinator.activationOwner.disconnectGame(
        fixture.broker.issue("game_disconnect"),
        { apiVersion: 1, idempotencyKey: "slice2-stale-disconnect", expectedAttachmentGeneration: 1 },
      ),
      /controlled_game_runtime_binding_close_failure/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "failed",
    });
    assert.deepEqual(fixture.bridgeCloseCalls, []);

    const result = await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(result, { apiVersion: 1, status: "attached" });
    assert.equal(GameBrowserValidatorsV1.GameResumeResultV1Schema.Check(result), true);
    // The stale gen-1 activation was torn down through the shared teardown
    // timing (prompt-task cancel + exact facade close), so no old-activation
    // in-memory objects outlive the fresh claim.
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 2);
    // Producer: fresh per-activation prepare stopped the ended AI and armed a
    // fresh generation. Consumer: fresh AI launch + bridge consume + enter ran
    // end-to-end. Verifier: second spawn/connect used ai-generation-2 while
    // the scope stayed the registered world binding.
    assert.equal(fixture.aiKillCalls.length, 1);
    assert.equal(fixture.spawnCalls.length, 2);
    assert.equal(fixture.spawnCalls[1]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-2");
    assert.equal(fixture.bridgeConnectCalls.length, 2);
    assert.equal(fixture.bridgeConnectCalls[1]!.launchGeneration, "ai-generation-2");
    assert.deepEqual(fixture.bridgeConnectCalls[1]!.scope, fixture.bridgeConnectCalls[0]!.scope);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 2);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 2);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 2);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("slice 2: resume fails closed when the stale attachment teardown itself fails and claims no fresh generation", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    gameRuntimeBindingCloseResults: [false, false],
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await assert.rejects(
      fixture.coordinator.activationOwner.disconnectGame(
        fixture.broker.issue("game_disconnect"),
        { apiVersion: 1, idempotencyKey: "slice2-teardown-fail-disconnect", expectedAttachmentGeneration: 1 },
      ),
      /controlled_game_runtime_binding_close_failure/,
    );
    await assert.rejects(
      fixture.coordinator.activationOwner.resume(
        fixture.broker.issue("game_resume"),
        { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
      ),
      /controlled_game_runtime_binding_close_failure/,
    );
    // No stale object was torn down and no fresh activation was claimed: the
    // coordinator retains exactly the failed-disconnect state for retry.
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "failed",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("slice 2: resume after a clean disconnect truly re-attaches the fresh generation with a new AI launch and connection", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "slice2-clean-disconnect", expectedAttachmentGeneration: 1 },
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);

    const result = await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(result, { apiVersion: 1, status: "attached" });
    assert.equal(GameBrowserValidatorsV1.GameResumeResultV1Schema.Check(result), true);
    // Producer: fresh per-activation prepare ends the previous AI and arms a
    // fresh generation. Consumer: fresh AI launch + bridge consume + enter
    // ran end-to-end. Verifier: second spawn/connect used ai-generation-2
    // while the scope stayed the registered world binding, no old task or
    // stale objects survived (enter #2, ingress #2, ready-actions-paused).
    assert.deepEqual(fixture.aiKillCalls, [4101]);
    assert.equal(fixture.spawnCalls.length, 2);
    assert.equal(fixture.spawnCalls[1]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-2");
    assert.equal(fixture.bridgeConnectCalls.length, 2);
    assert.equal(fixture.bridgeConnectCalls[1]!.launchGeneration, "ai-generation-2");
    assert.deepEqual(fixture.bridgeConnectCalls[1]!.scope, fixture.bridgeConnectCalls[0]!.scope);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 2);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 2);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 2);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("slice 2: every resume mints a fresh generation — consecutive resume cycles each truly attach", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "connected_idle",
    });
    // Cycle 1: disconnect, then resume -> genuinely attached at generation 2.
    await fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "cycle1-disconnect", expectedAttachmentGeneration: 1 },
    );
    const firstResume = await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "cycle1-resume", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(firstResume, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "connected_idle",
    });
    // Cycle 2: the per-activation machine arms a THIRD launch generation; the
    // second resume never reuses the first resume's connection/callback/lease.
    // The coordinator attachment generation is per-attachment (restarts at >= 2
    // after a full teardown), while the underlying AI launch/bridge generations
    // strictly increase and prove the fresh mint.
    await fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "cycle2-disconnect", expectedAttachmentGeneration: 2 },
    );
    const secondResume = await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "cycle2-resume", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(secondResume, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    // Producer -> consumer -> verifier across both cycles: exactly three
    // native AI spawns and three bridge connects, each with its own generation
    // (never reused), and every ended AI was stopped before the next
    // activation; the old task was never replayed.
    assert.deepEqual(fixture.aiKillCalls, [4101, 4101]);
    assert.deepEqual(
      fixture.spawnCalls.map((call) => call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION),
      ["ai-generation-1", "ai-generation-2", "ai-generation-3"],
    );
    assert.deepEqual(
      fixture.bridgeConnectCalls.map((call) => call.launchGeneration),
      ["ai-generation-1", "ai-generation-2", "ai-generation-3"],
    );
    assert.equal(new Set(fixture.bridgeConnectCalls.map((call) => call.launchGeneration)).size, 3);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 3);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 3);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 3);
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge", "bridge"]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("slice 2: a failed fresh resume launch is abandoned and the next resume truly attaches with a newer generation", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    aiSpawnFailureAt: 2,
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "retry-disconnect", expectedAttachmentGeneration: 1 },
    );
    // The fresh resume launch itself fails (second spawn attempt): the attempt
    // fails closed and abandons the armed activation so a later resume can
    // prepare a new generation again.
    await assert.rejects(
      fixture.coordinator.activationOwner.resume(
        fixture.broker.issue("game_resume"),
        { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "retry-resume-1", expectedAttachmentGeneration: 2 },
      ),
      /controlled-ai-spawn-failure/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "failed",
    });
    assert.equal(fixture.bridgeConnectCalls.length, 1);
    // The retry arms yet another generation and genuinely attaches.
    const retried = await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "retry-resume-2", expectedAttachmentGeneration: 3 },
    );
    assert.deepEqual(retried, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 3, connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    // Producer -> consumer -> verifier: spawns #1 (initial) and #3 (retry)
    // are the only live AI launches; the failed #2 never connected, and the
    // retry consumed a fresh generation (ai-generation-3), never the failed
    // attempt's generation 2.
    assert.equal(fixture.spawnCalls.length, 3);
    assert.equal(fixture.spawnCalls[2]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-3");
    assert.deepEqual(
      fixture.bridgeConnectCalls.map((call) => call.launchGeneration),
      ["ai-generation-1", "ai-generation-3"],
    );
    assert.deepEqual(fixture.aiKillCalls, [4101]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});// ─── Slice 2C: coordinator action-authority reopen seam ─────────────────────

test("reopenActionAuthority reopens a paused authority to active over the same attachment without touching old task/facade/lease", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    // Producer: a fresh resume admits the paused authority (generation 2).
    const resumed = await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(resumed, { apiVersion: 1, status: "accepted" });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "reconnecting",
    });
    // Consumer: the new explicit Game instruction reopens the authority to
    // active on the SAME attachment; no old task, facade, lease, or
    // attachment work happens and no generation is minted.
    const result = await fixture.coordinator.activationOwner.reopenActionAuthority(
      fixture.broker.issue("game_reopen"),
      { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(result, { apiVersion: 1, status: "reopened" });
    assert.equal(GameBrowserValidatorsV1.GameReopenActionAuthorityResultV1Schema.Check(result), true);
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
    // Verifier: attachment stays on the resumed generation, and no native,
    // facade, or task machinery was invoked by the reopen.
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "reconnecting",
    });
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerSpawnCalls, []);
    assert.deepEqual(fixture.bridgeConnectCalls, []);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 0);
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 0);
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.aiKillCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("reopenActionAuthority fails closed while the authority is already active", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
    assert.throws(
      () => fixture.coordinator.activationOwner.reopenActionAuthority(
        fixture.broker.issue("game_reopen"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 1 },
      ),
      /stardew_game_action_authority_not_paused/,
    );
    // State unchanged: still active, same attachment generation, no native work.
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.bridgeCloseCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("reopenActionAuthority fails closed while the authority is unavailable", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "unavailable" });
    assert.throws(
      () => fixture.coordinator.activationOwner.reopenActionAuthority(
        fixture.broker.issue("game_reopen"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 1 },
      ),
      /stardew_game_action_authority_not_paused/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    assert.deepEqual(fixture.spawnCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("reopenActionAuthority replays a duplicate idempotency key with the same result and rejects a changed tuple", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    const command = { apiVersion: 1 as const, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 };
    const first = fixture.coordinator.activationOwner.reopenActionAuthority(fixture.broker.issue("game_reopen"), command);
    const replay = fixture.coordinator.activationOwner.reopenActionAuthority(fixture.broker.issue("game_reopen"), command);
    assert.equal(replay, first);
    assert.deepEqual(await first, { apiVersion: 1, status: "reopened" });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
    // A changed tuple under the same idempotency key fails closed.
    assert.throws(
      () => fixture.coordinator.activationOwner.reopenActionAuthority(
        fixture.broker.issue("game_reopen"),
        { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 3 },
      ),
      /stardew_game_reopen_idempotency_conflict/,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("reopenActionAuthority fails closed on a stale attachment generation without changing the authority", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    assert.throws(
      () => fixture.coordinator.activationOwner.reopenActionAuthority(
        fixture.broker.issue("game_reopen"),
        { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 1 },
      ),
      /stardew_game_attachment_generation_conflict/,
    );
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "reconnecting",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("reopenActionAuthority stays paused after teardown, then reopens the fresh resumed authority", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "slice2c-teardown", expectedAttachmentGeneration: 1 },
    );
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "unavailable" });
    const resumed = await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "slice2c-resume", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(resumed, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    const result = await fixture.coordinator.activationOwner.reopenActionAuthority(
      fixture.broker.issue("game_reopen"),
      { apiVersion: 1, idempotencyKey: "slice2c-reopen", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(result, { apiVersion: 1, status: "reopened" });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "connected_idle",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});// ─── Slice 3: game.create two-phase flow and failure/terminal discipline ────

test("game.create fails explicitly without a launched and attested Player Host and writes nothing durable", async () => {
  // Owner ruling (a)/(b): create is admitted only over the exact Player Host
  // this lifecycle already launched and attested. Neither a never-activated
  // lifecycle nor an activated-but-unlaunched one may persist a binding intent
  // and sit at `accepted` forever.
  for (const stage of ["never_activated", "activated_not_launched"] as const) {
    const fake = fakeGameSessionCreationAuthority();
    const fixture = await createFixture({
      overrides: {
        gameSessionCreationAuthority: fake.authority,
        createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
      },
    });
    try {
      if (stage === "activated_not_launched") {
        await withWindowsPlatform(async () => { await fixture.coordinator.activationOwner.activate(fixture.broker.issue()); });
      }
      assert.throws(
        () => fixture.coordinator.activationOwner.createGameSession(
          fixture.broker.issue("game_create"),
          { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
        ),
        /stardew_game_create_player_host_unavailable/,
      );
      // Fail-closed before any durable write, and no native or attachment work.
      assert.deepEqual(fake.sessions(), []);
      assert.deepEqual(fake.inputs(), []);
      assert.deepEqual(fixture.spawnCalls, []);
      assert.deepEqual(fixture.playerSpawnCalls, []);
      assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
        status: "none", generation: 0, connectionStatus: "none",
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  }
});

test("game.create over the launched exact owner re-admits the manifest handoff and attaches the first activation", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      // Integration-private seam stand-in: the Stardew implementation drives the
      // game's own native new-game entry and returns the physical slot basename
      // it observed. The coordinator never names a slot and persists the opaque
      // ref verbatim.
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    // Launch-before-create only launched the Player Host: no cabin was admitted
    // yet, so the AI-client profile is not materialized and the first
    // activation still needs the manifest handoff re-admission.
    assert.equal(fixture.spawnCalls.length, 0);
    const created = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    const result = await created;
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    assert.equal(result.status, "attached");
    assert.match(result.gameSessionId ?? "", /^[A-Za-z0-9_-]{32}$/);
    const sessionId = result.gameSessionId!;
    // Phase 2a-2c persisted the store-minted id and the seam's opaque bindingRef.
    assert.deepEqual(fake.inputs(), ["create", "register", "complete"]);
    assert.deepEqual(fake.readMetadata(sessionId), {
      gameSessionId: sessionId, integrationId: "stardew", continuityIdentityId: null, status: "resumable", revision: 2,
    });
    assert.deepEqual(fake.readBinding(sessionId), {
      gameSessionId: sessionId, integrationId: "stardew", bindingRef: "Farm_389124477", status: "registered", revision: 1,
    });
    assert.deepEqual(fake.listResumable(), [fake.readMetadata(sessionId)]);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    // The first activation launches the AI client through the reservations the
    // owner already holds; only an owner whose previous activation ended is
    // re-armed onto a fresh launch generation.
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.spawnCalls[0]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-1");
    assert.equal(fixture.bridgeConnectCalls.length, 1);
    assert.equal(fixture.bridgeConnectCalls[0]!.launchGeneration, "ai-generation-1");
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 1);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create fails closed as unavailable with a failed pending row when world creation is unavailable or fails", async () => {
  for (const seamMode of ["absent", "authority-only", "throwing"] as const) {
    const fake = fakeGameSessionCreationAuthority();
    // Launch-before-create: the create is admitted over a launched and attested
    // Player Host, so these cases exercise the seam contract itself rather than
    // the launch precondition.
    const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
      overrides: seamMode === "absent"
        ? {}
        : seamMode === "authority-only"
          ? { gameSessionCreationAuthority: fake.authority }
          : {
              gameSessionCreationAuthority: fake.authority,
              createWorldBinding: async () => { throw new Error("controlled-world-creation-failure"); },
            },
    });
    try {
      const creating = fixture.coordinator.activationOwner.createGameSession(
        fixture.broker.issue("game_create"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
      );
      if (seamMode === "throwing") {
        // The manifest handoff admission now precedes the seam (Loop 4 path
        // B'), so a mounted-seam create publishes and waits for its own
        // attachment request before the seam runs.
        const request = await waitForAttachmentRequest(fixture.runtimeRoot);
        await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
      }
      const result = await creating;
      assert.deepEqual(result, { apiVersion: 1, status: "unavailable", gameSessionId: null });
      assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
      if (seamMode === "absent" || seamMode === "authority-only") {
        // A sealed/unmounted seam fails before any durable write: no rows at all,
        // regardless of whether the authority alone was already connected.
        assert.deepEqual(fake.sessions(), []);
        assert.deepEqual(fake.inputs(), []);
      } else {
        // An attempted world creation failure follows the D2 failure table:
        // pending → failed rev2, no binding row, never resumable.
        const legacy = fake.sessions();
        assert.equal(legacy.length, 1);
        assert.deepEqual(legacy[0], {
          gameSessionId: legacy[0]!.gameSessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 2,
        });
        assert.equal(fake.readBinding(legacy[0]!.gameSessionId), null);
        assert.deepEqual(fake.listResumable(), []);
        assert.deepEqual(fake.inputs(), ["create", "fail"]);
        // The failure path re-verifies the store-minted id for the CAS.
        assert.ok(fake.inputs().includes("fail"));
      }
      // The failed create launched no role itself: the only Player Host spawn
      // is the launch that preceded the create.
      assert.deepEqual(fixture.spawnCalls, []);
      assert.equal(fixture.playerSpawnCalls.length, 1);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  }
});

test("game.create rejects a foreign integrationId before any durable write (published-registry guard)", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await createFixture({
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async () => Object.freeze({ bindingRef: "opaque-world-ref" }),
    },
  });
  try {
    assert.throws(
      () => fixture.coordinator.activationOwner.createGameSession(
        fixture.broker.issue("game_create"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "another-game", continuityIdentityId: null },
      ),
      /stardew_game_create_integration_conflict/,
    );
    assert.deepEqual(fake.sessions(), []);
    assert.deepEqual(fake.inputs(), []);
    // No attachment or launch projection changed.
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create replays the same idempotency key with the same session and rejects a changed tuple", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    const command = { apiVersion: 1 as const, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null };
    const first = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), command);
    const replay = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), command);
    assert.equal(replay, first);
    // The create is admitted over the launched Player Host and re-admits the
    // manifest handoff; the external admission publication releases it.
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    const result = await first;
    assert.equal(result.status, "attached");
    // Exactly one durable lineage was created for both requests.
    assert.equal(fake.sessions().length, 1);
    assert.deepEqual(fake.inputs(), ["create", "register", "complete"]);
    // A changed tuple under the same key fails closed.
    assert.throws(
      () => fixture.coordinator.activationOwner.createGameSession(
        fixture.broker.issue("game_create"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: "continuity-1" },
      ),
      /stardew_game_create_idempotency_conflict/,
    );
    assert.throws(
      () => fixture.coordinator.activationOwner.createGameSession(
        fixture.broker.issue("game_create"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "another-game", continuityIdentityId: null },
      ),
      /stardew_game_create_idempotency_conflict/,
    );
    // No second durable lineage appeared after the rejected tuples.
    assert.equal(fake.sessions().length, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create enforces the single-activation mutual exclusion for live attachments and in-flight operations", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "connected_idle",
    });
    // A live healthy attachment is a live world: create is refused without
    // disturbing it (card D4).
    assert.throws(
      () => fixture.coordinator.activationOwner.createGameSession(
        fixture.broker.issue("game_create"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
      ),
      /stardew_game_runtime_unavailable/,
    );
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "connected_idle",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }

  // In-flight resume blocks create; the create admission rejects synchronously
  // without touching the store or the attempt.
  const resumeBlocked = fakeGameSessionCreationAuthority();
  const resumeFixture = await createFixture({
    overrides: {
      gameSessionCreationAuthority: resumeBlocked.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    const resuming = resumeFixture.coordinator.activationOwner.resume(
      resumeFixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-absent", idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.throws(
      () => resumeFixture.coordinator.activationOwner.createGameSession(
        resumeFixture.broker.issue("game_create"),
        { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
      ),
      /stardew_game_create_in_progress/,
    );
    assert.deepEqual(resumeBlocked.sessions(), []);
    assert.deepEqual(await resuming, { apiVersion: 1, status: "unavailable" });
  } finally {
    await resumeFixture.coordinator.close();
    await resumeFixture.broker.close();
  }

  // In-flight create blocks resume; the resume admission rejects synchronously
  // while the create is still pending on its own handoff re-admission.
  const createBlocked = fakeGameSessionCreationAuthority();
  const createFixtureGate = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: createBlocked.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    const creating = createFixtureGate.coordinator.activationOwner.createGameSession(
      createFixtureGate.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    assert.throws(
      () => createFixtureGate.coordinator.activationOwner.resume(
        createFixtureGate.broker.issue("game_resume"),
        { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
      ),
      /stardew_game_resume_in_progress/,
    );
    const request = await waitForAttachmentRequest(createFixtureGate.runtimeRoot);
    await publishAttachmentAdmission(createFixtureGate.runtimeRoot, request, availableCabins[0]!);
    // The create completes its first activation over the launched exact owner
    // and never blocks the resume guard again after settling.
    const createOutcome = await creating;
    assert.equal(createOutcome.status, "attached");
    assert.match(createOutcome.gameSessionId ?? "", /^[A-Za-z0-9_-]{32}$/);
    const blockedSessions = createBlocked.sessions();
    assert.equal(blockedSessions.length, 1);
    assert.equal(blockedSessions[0]!.status, "resumable");
    assert.equal(createBlocked.readBinding(blockedSessions[0]!.gameSessionId)?.status, "registered");
  } finally {
    await createFixtureGate.coordinator.close();
    await createFixtureGate.broker.close();
  }
});

test("game.create after a clean disconnect attaches the first activation at generation 1 with actions paused", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "create-clean-disconnect", expectedAttachmentGeneration: 1 },
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    // Producer: the full two-phase create, then the first activation reuses
    // the fresh-attach machinery (arm AI → launch → bridge → materialize →
    // runEnter → committed ingress). Consumer: register/complete settle the
    // durable rows before the attach. Verifier: result attached, generation 1,
    // actions paused, fresh per-activation launch generation, rows resumable.
    // The create re-admits its own manifest handoff before its seam, so it
    // mints a fresh attachment request identity that needs its own publication.
    const previousRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    await publishNextAttachmentAdmission(fixture.runtimeRoot, previousRequestId, availableCabins[0]!);
    const result = await creating;
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    assert.equal(result.status, "attached");
    assert.match(result.gameSessionId ?? "", /^[A-Za-z0-9_-]{32}$/);
    const sessionId = result.gameSessionId!;
    assert.deepEqual(fake.readMetadata(sessionId), {
      gameSessionId: sessionId, integrationId: "stardew", continuityIdentityId: null, status: "resumable", revision: 2,
    });
    assert.deepEqual(fake.readBinding(sessionId)?.status, "registered");
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 1, connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    assert.equal(fixture.spawnCalls.length, 2);
    assert.equal(fixture.spawnCalls[1]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-2");
    assert.equal(fixture.bridgeConnectCalls.length, 2);
    assert.equal(fixture.bridgeConnectCalls[1]!.launchGeneration, "ai-generation-2");
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 2);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 2);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 2);
    assert.deepEqual(fixture.aiKillCalls, [4101]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create attach failure after registration goes terminal binding + failed metadata in one durable outcome", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    aiSpawnFailureAt: 2,
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "create-terminal-disconnect", expectedAttachmentGeneration: 1 },
    );
    // The first activation's AI launch fails after the binding was registered
    // and the session completed: the D2 post-registration failure path applies
    // (binding terminal rev2 + metadata failed rev3), never a resumable
    // half-record, and the wire reports unavailable with no session handle.
    const previousRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    await publishNextAttachmentAdmission(fixture.runtimeRoot, previousRequestId, availableCabins[0]!);
    const result = await creating;
    assert.deepEqual(result, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    const sessionId = sessions[0]!.gameSessionId;
    assert.deepEqual(fake.readBinding(sessionId), {
      gameSessionId: sessionId, integrationId: "stardew", bindingRef: `world-${sessionId.slice(0, 8)}`, status: "terminal", revision: 2,
    });
    assert.deepEqual(fake.readMetadata(sessionId), {
      gameSessionId: sessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 3,
    });
    assert.deepEqual(fake.listResumable(), []);
    // Verifier: the attachment never completed; generation was not left armed
    // beyond the failed epoch and no player-world process was touched.
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 1);
    assert.deepEqual(fixture.playerKillCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create whose first AI activation bridge retry expires settles durably and the next create re-arms through the core", async () => {
  // N2: the retry wait could expire and escape the activation without rolling
  // the core back, leaving the owner's AI launch claimed while its bridge
  // connection stayed armed. The next create then asked the core for a fresh
  // generation, was refused as "not available", and reported a permanent
  // `accepted` that never progresses.
  const fake = fakeGameSessionCreationAuthority();
  const realDateNow = Date.now;
  let allowAttach = false;
  let facadeEnterCalls = 0;
  let ingressActivationCalls = 0;
  const connectGenerations: string[] = [];
  const transientPipeNotReady = Object.assign(new Error("controlled_pipe_not_ready"), { code: "ENOENT" });
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
      connectFarmhandGameRuntimeFacade: async (connection) => {
        connectGenerations.push(connection.launchGeneration);
        // The AI client is launched and running; only its bridge pipe never
        // becomes connectable, so every attempt is the transient retry case.
        if (!allowAttach) throw transientPipeNotReady;
        return Object.freeze({
          authority: "SEMANTIC" as const,
          runEnter: async () => {
            facadeEnterCalls += 1;
            return connectedSemanticGameLeaseFixture({ onActivate: () => { ingressActivationCalls += 1; } });
          },
          recoverDeadOwner: async () => undefined,
          close: async () => undefined,
        });
      },
    },
  });
  try {
    // Producer: launch-before-create already attested the Player Host, so this
    // create re-admits its own manifest handoff and then runs the owner's FIRST
    // activation: the AI client is launched through the untouched reservation
    // (ai-generation-1) and the bridge is retried until the create's own
    // activation deadline expires.
    const firstRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    await publishNextAttachmentAdmission(fixture.runtimeRoot, firstRequestId, availableCabins[0]!);
    // Waiting for the launch itself (the connect attempt always follows it) keeps
    // this bounded well under the create's own activation deadline.
    await waitFor(() => fixture.spawnCalls.length >= 1, 2_000);
    // The create's own activation deadline is `min(browser session expiry,
    // now + 60s)`, so skewing the process clock past it expires the retry wait
    // immediately instead of letting this test sleep for a minute. Restored
    // before the second create, which must run on the real clock.
    Date.now = () => realDateNow() + 60_000;
    const first = await creating;
    Date.now = realDateNow;
    // Consumer/verifier: an expired activation is a real failure of this
    // create and settles through the ONE durable closure (the post-registration
    // shape), never a silent `accepted` that leaves a resumable half-record.
    assert.deepEqual(first, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(first), true);
    const failed = fake.sessions();
    assert.equal(failed.length, 1);
    const failedSessionId = failed[0]!.gameSessionId;
    assert.deepEqual(fake.readBinding(failedSessionId), {
      gameSessionId: failedSessionId, integrationId: "stardew",
      bindingRef: `world-${failedSessionId.slice(0, 8)}`, status: "terminal", revision: 2,
    });
    assert.deepEqual(fake.readMetadata(failedSessionId), {
      gameSessionId: failedSessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 3,
    });
    assert.deepEqual(fake.listResumable(), []);
    assert.equal(connectGenerations.filter((generation) => generation === "ai-generation-1").length >= 1, true);
    assert.equal(facadeEnterCalls, 0);
    assert.equal(ingressActivationCalls, 0);
    // Consumer: the next create in the SAME lifecycle must still work. It asks
    // the core again, and the expired activation was rolled back to the fully
    // consumed base, so the core admits a genuinely new generation
    // (ai-generation-2) instead of refusing the re-arm.
    allowAttach = true;
    const secondRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const creatingAgain = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    await publishNextAttachmentAdmission(fixture.runtimeRoot, secondRequestId, availableCabins[0]!);
    const second = await creatingAgain;
    assert.equal(second.status, "attached");
    assert.match(second.gameSessionId ?? "", /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(second.gameSessionId, failedSessionId);
    assert.equal(fake.listResumable().length, 1);
    // Verifier: the re-arm ended the expired activation's AI client and the
    // fresh generation reached the launch and the bridge, and the new session
    // attached with actions paused.
    assert.deepEqual(
      fixture.spawnCalls.map((call) => call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION),
      ["ai-generation-1", "ai-generation-2"],
    );
    assert.equal(connectGenerations.at(-1), "ai-generation-2");
    assert.deepEqual(fixture.aiKillCalls, [4101]);
    assert.equal(facadeEnterCalls, 1);
    assert.equal(ingressActivationCalls, 1);
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "connected_idle",
    });
  } finally {
    Date.now = realDateNow;
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

// N3: a launch callback entered before its launch promise failed still consumes
// the owner's one-shot AI launch in the core, while both paths settle on a
// quarantined exact owner. No coordinator-side latch survives either attempt --
// the activation shape is asked of the core at every activation -- so a later
// create can only fail closed on the terminal owner instead of being admitted
// on a stale "untouched" decision.

test("a cabin AI launch that claimed its reservation before failing leaves no stale activation for a later create", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    aiSpawnFailureAt: 1,
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      {
        apiVersion: 1,
        choiceHandle: choices.choices[0]!.choiceHandle,
        idempotencyKey: "n3-cabin-launch-key",
        confirmed: true,
      },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // The launch was entered (the core consumed the reservation) and its spawn
    // then failed: the cabin path settles uncertain and quarantines the owner.
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    // Verifier: a create over that exact owner is admitted by the lifecycle
    // guards and must fail closed on the terminal owner before taking either
    // activation shape, so no durable row and no second AI launch can appear.
    const created = await fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    assert.deepEqual(created, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.deepEqual(fake.inputs(), []);
    assert.deepEqual(fake.sessions(), []);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    // The create really reached the owner re-attestation and terminated the
    // exact owner there, rather than being refused earlier by a lifecycle guard.
    assert.deepEqual(fixture.coordinator.launchReadinessReader.readLaunchReadinessView(), {
      generation: 0, status: "failed",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("a headless AI launch that claimed its reservation before failing leaves no stale activation for a later create", async () => {
  const fake = fakeGameSessionCreationAuthority();
  let runtimeRootForSession = "";
  const fixture = await createFixture({
    aiSpawnFailureAt: 1,
    afterPlayerSpawn: () => {
      publishSignedPlayerHostSessionSync(runtimeRootForSession, "player-generation-1", availableCabins);
    },
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  runtimeRootForSession = fixture.runtimeRoot;
  try {
    const responder = setInterval(() => {
      void (async () => {
        try {
          const request = await waitForAttachmentRequest(runtimeRootForSession);
          await publishAttachmentAdmission(runtimeRootForSession, request, availableCabins[0]!);
          clearInterval(responder);
        } catch { /* transient: the request file appears once the handoff is issued */ }
      })();
    }, 10);
    // The one-shot headless admission launched the Player Host, admitted its
    // cabin, materialized the profile and then entered the AI launch callback,
    // which is where the spawn failed.
    await assert.rejects(
      () => fixture.coordinator.headlessOperationalGame.activateHeadlessOperationalGame(fixture.manifest),
      /controlled-ai-spawn-failure/,
    );
    clearInterval(responder);
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    // Verifier: the later create fails closed on the terminal owner rather than
    // reporting a permanent `accepted` on the consumed-but-unfinished
    // activation.
    const created = await fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    assert.deepEqual(created, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.deepEqual(fake.inputs(), []);
    assert.deepEqual(fake.sessions(), []);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
    // The create really reached the owner re-attestation and terminated the
    // exact owner there, rather than being refused earlier by a lifecycle guard.
    assert.deepEqual(fixture.coordinator.launchReadinessReader.readLaunchReadinessView(), {
      generation: 0, status: "failed",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create clears the previous resume lineage so the new session can be resumed without cross-session conflicts", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    aiSpawnFailureAt: 2,
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "create-lineage-disconnect", expectedAttachmentGeneration: 1 },
    );
    // A failed resume of the old lineage leaves its resumed-session guard set
    // with the armed generation retained (same as the failed-resume retry test).
    await assert.rejects(
      fixture.coordinator.activationOwner.resume(
        fixture.broker.issue("game_resume"),
        { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "lineage-resume-fail", expectedAttachmentGeneration: 2 },
      ),
      /controlled-ai-spawn-failure/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "failed",
    });
    // Start new game creates a NEW session; the old lineage's in-memory guard
    // must not shadow the fresh session's retry/resume admission. The create
    // re-admits its own manifest handoff, so it publishes its own request.
    const previousRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "lineage-create", integrationId: "stardew", continuityIdentityId: null },
    );
    await publishNextAttachmentAdmission(fixture.runtimeRoot, previousRequestId, availableCabins[0]!);
    const created = await creating;
    assert.equal(created.status, "attached");
    const newSessionId = created.gameSessionId!;
    assert.equal(newSessionId === "session-abc", false);
    assert.deepEqual(fake.readMetadata(newSessionId)?.status, "resumable");
    // The new session's world is live, so its resume is admitted after a
    // clean disconnect: the previous lineage guard was cleared, otherwise the
    // resume would fail with a cross-session conflict.
    await fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "lineage-disconnect-new", expectedAttachmentGeneration: 3 },
    );
    const resumed = await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: newSessionId, idempotencyKey: "lineage-resume-new", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(resumed, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "connected_idle",
    });
    assert.deepEqual(
      fixture.spawnCalls.map((call) => call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION),
      ["ai-generation-1", "ai-generation-2", "ai-generation-3", "ai-generation-4"],
    );
    assert.deepEqual(fixture.playerKillCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

// ─── Slice 3: game.resume.cancel epoch termination ──────────────────────────

test("game.resume.cancel fails closed without an in-flight resume or on a stale generation", async () => {
  const fixture = await createFixture();
  try {
    assert.throws(
      () => fixture.coordinator.activationOwner.cancelResume(
        fixture.broker.issue("game_resume_cancel"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
      ),
      /stardew_game_resume_cancel_unavailable/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "unavailable" });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.resume.cancel terminates the reconnect epoch, keeps the armed generation, and the retry mints a new attempt identity", async () => {
  let allowAttach = false;
  let connectChainCalls = 0;
  let resumeConnectCalls = 0;
  let enterCalls = 0;
  let ingressCalls = 0;
  let voiceStopperCalls = 0;
  const recordedConnectGenerations: string[] = [];
  const recordConnect = (connection: Parameters<NonNullable<StardewLifecycleCoordinatorTestingOverrides["connectFarmhandGameRuntimeFacade"]>>[0]) => {
    recordedConnectGenerations.push(connection.launchGeneration);
  };
  const semanticFacadeFixture = () => Object.freeze({
    authority: "SEMANTIC" as const,
    runEnter: async () => {
      enterCalls += 1;
      return connectedSemanticGameLeaseFixture({
        onAttachVoiceStopper: () => { voiceStopperCalls += 1; },
        onActivate: () => { ingressCalls += 1; },
      });
    },
    recoverDeadOwner: async () => undefined,
    close: async () => undefined,
  });
  const transientError = Object.assign(new Error("bridge-not-ready"), { code: "ECONNREFUSED" });
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      worldBindingResolver: async () => ({ gameSessionId: "session-abc", integrationId: "stardew", bindingRef: "opaque-world-ref", status: "registered" as const, revision: 1 }),
      connectFarmhandGameRuntimeFacade: async (connection) => {
        connectChainCalls += 1;
        recordConnect(connection);
        if (connectChainCalls > 1) {
          resumeConnectCalls += 1;
          if (!allowAttach) throw transientError;
        }
        return semanticFacadeFixture();
      },
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      { apiVersion: 1, idempotencyKey: "cancel-disconnect", expectedAttachmentGeneration: 1 },
    );
    // Producer: an in-flight resume attempt is parked in the bridge retry loop
    // (generation 2 armed, AI freshly launched).
    const resuming = fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "cancel-resume-attempt", expectedAttachmentGeneration: 2 },
    );
    resuming.catch(() => undefined);
    await waitFor(() => resumeConnectCalls >= 1);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "syncing",
    });
    // A stale cancel epoch for the wrong generation fails closed without
    // disturbing the attempt.
    assert.throws(
      () => fixture.coordinator.activationOwner.cancelResume(
        fixture.broker.issue("game_resume_cancel"),
        { apiVersion: 1, idempotencyKey: "cancel-stale-gen", expectedAttachmentGeneration: 3 },
      ),
      /stardew_game_attachment_generation_conflict/,
    );
    // Consumer: the exact in-flight epoch is cancelled; the retry loop stops,
    // the armed activation is abandoned, the partial facade (none here) is
    // closed, and the projection becomes disconnected/unavailable while the
    // generation keeps its armed value.
    const cancelled = await fixture.coordinator.activationOwner.cancelResume(
      fixture.broker.issue("game_resume_cancel"),
      { apiVersion: 1, idempotencyKey: "cancel-attempt-2", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(cancelled, { apiVersion: 1, status: "cancelled" });
    assert.equal(GameBrowserValidatorsV1.GameResumeCancelResultV1Schema.Check(cancelled), true);
    await assert.rejects(resuming, /stardew_game_resume_cancelled/);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "disconnected",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "unavailable" });
    // Replay of the same cancel key returns the same cancelled result; a
    // changed tuple fails closed.
    const replay = await fixture.coordinator.activationOwner.cancelResume(
      fixture.broker.issue("game_resume_cancel"),
      { apiVersion: 1, idempotencyKey: "cancel-attempt-2", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(replay, { apiVersion: 1, status: "cancelled" });
    assert.throws(
      () => fixture.coordinator.activationOwner.cancelResume(
        fixture.broker.issue("game_resume_cancel"),
        { apiVersion: 1, idempotencyKey: "cancel-attempt-2", expectedAttachmentGeneration: 3 },
      ),
      /stardew_game_resume_cancel_idempotency_conflict/,
    );
    // No stale reconnect completes after the cancel: even with the attach
    // gate open, no further cancelled-epoch connect attempt runs and nothing
    // attaches until a fresh resume attempt starts.
    const cancelledEpochAttempts = recordedConnectGenerations.filter((generation) => generation === "ai-generation-2").length;
    assert.ok(cancelledEpochAttempts >= 1);
    allowAttach = true;
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 80));
    assert.equal(recordedConnectGenerations.filter((generation) => generation === "ai-generation-2").length, cancelledEpochAttempts);
    assert.equal(enterCalls, 1);
    assert.equal(ingressCalls, 1);
    assert.equal(voiceStopperCalls, 1);
    // Verifier: Player world untouched; only the armed AI activation was
    // abandoned (the retry below stops it via the per-activation prepare).
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.deepEqual(fixture.playerKillCalls, []);
    assert.deepEqual(fixture.aiKillCalls, [4101]);
    // Retry: a fresh attempt identity (generation G+1) re-attaches through the
    // resume pipeline without reusing the cancelled attempt's launch identity.
    const retried = await fixture.coordinator.activationOwner.resume(
      fixture.broker.issue("game_resume"),
      { apiVersion: 1, gameSessionId: "session-abc", idempotencyKey: "cancel-retry-attempt", expectedAttachmentGeneration: 3 },
    );
    assert.deepEqual(retried, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 3, connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.spawnCalls.map((call) => call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION), [
      "ai-generation-1", "ai-generation-2", "ai-generation-3",
    ]);
    // The initial cabin attach and the retry consumed fresh launch identities;
    // the cancelled epoch consumed only its own generation and the retry
    // minted a strictly newer one — the cancelled identity is never reused.
    assert.deepEqual(new Set(recordedConnectGenerations), new Set([
      "ai-generation-1", "ai-generation-2", "ai-generation-3",
    ]));
    assert.equal(recordedConnectGenerations.at(-1), "ai-generation-3");
    assert.equal(enterCalls, 2);
    assert.equal(ingressCalls, 2);
    assert.equal(voiceStopperCalls, 2);
    // The retry is the next attempt identity; the old cancelled one is terminal.
    assert.deepEqual(fixture.aiKillCalls, [4101, 4101]);
    assert.deepEqual(fixture.playerKillCalls, []);
    assert.equal(fixture.playerSpawnCalls.length, 1);
    // A cancel after the resume settled is stale and fails closed.
    assert.throws(
      () => fixture.coordinator.activationOwner.cancelResume(
        fixture.broker.issue("game_resume_cancel"),
        { apiVersion: 1, idempotencyKey: "cancel-stale-after-settle", expectedAttachmentGeneration: 3 },
      ),
      /stardew_game_resume_cancel_unavailable/,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("headless operational admission consumes one fresh registered installation through the existing lifecycle core", async () => {
  let runtimeRootForSession = "";
  const fixture = await createFixture({
    afterPlayerSpawn: () => {
      // The Player Host game thread publishes its signed session advertisement
      // immediately after spawning; the attestation correlation reads it back.
      // cabin-alpha is free for this companion; cabin-foreign is bound to
      // another companion and cabin-busy is occupied, so headless auto-select
      // deterministically picks the single free Farmhand cabin.
      publishSignedPlayerHostSessionSync(runtimeRootForSession, "player-generation-1", availableCabins);
    },
  });
  runtimeRootForSession = fixture.runtimeRoot;
  try {
    // When the headless flow writes its attachment request, the fixture Host
    // (standing in for the game thread) answers with a signed ready response
    // and the issued Farmhand join manifest exactly like the browser path.
    const responder = setInterval(() => {
      void (async () => {
        try {
          const request = await waitForAttachmentRequest(runtimeRootForSession);
          const cabin = availableCabins[0]!;
          await publishAttachmentAdmission(runtimeRootForSession, request, cabin);
          clearInterval(responder);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && !((error as Error).message ?? "").includes("wait_for_attachment_request_timeout")) {
            // ignore transient missing-file; only stop on real failure
          }
        }
      })();
    }, 10);
    const lease = await fixture.coordinator.headlessOperationalGame.activateHeadlessOperationalGame(fixture.manifest);
    clearInterval(responder);
    assert.equal(lease.activateCommittedIngress.length, 0);
    assert.equal(typeof lease.close, "function");
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
    // Design 100 Step 1 asserts exact-once fresh registration admission. The
    // Player Host launch and the AI-client launch each fresh-admit the private
    // locator exactly once, so the count is exactly 2.
    assert.equal(fixture.freshRegistrationAdmissionCount(), 2);
    // The committed ingress is deferred to the lease owner: it is armed but not
    // yet released, then one-shot activated and double-activation rejected.
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 0);
    // Phase A: the lease exposes exactly the task-ingress composition surface
    // (piSessionId/gameSessionId/dispatch/cancel/evidence) on top of ingress
    // activation and close — no facade, snapshot, installation, or bridge facts.
    assert.equal(lease.piSessionId, "pi-session-stardew-test");
    assert.equal(lease.gameSessionId, "game-session-stardew-test");
    assert.equal(typeof lease.dispatchPromptDefinedTask, "function");
    assert.equal(typeof lease.cancelPromptDefinedTask, "function");
    // The evidence face is optional at the lease level: it is armed only when
    // the production composition supplies a game-operational-gate nonce (the
    // headless fixture runs without one, so it stays undefined here). The type
    // surface is what Phase A pins; the armed path is exercised in Phase B/3.
    assert.ok(
      lease.nextOperationalGateEvidence === undefined || typeof lease.nextOperationalGateEvidence === "function",
      "evidence face must be absent or a function",
    );
    assert.equal(Object.isFrozen(lease), true);
    lease.activateCommittedIngress();
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 1);
    assert.throws(() => lease.activateCommittedIngress(), /stardew_headless_ingress_already_activated/);
    await lease.close();
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("duplicate or payload-drift headless admission cannot rematerialize or launch", async () => {
  let runtimeRootForSession = "";
  const fixture = await createFixture({
    afterPlayerSpawn: () => {
      publishSignedPlayerHostSessionSync(runtimeRootForSession, "player-generation-1", availableCabins);
    },
  });
  runtimeRootForSession = fixture.runtimeRoot;
  try {
    const responder = setInterval(() => {
      void (async () => {
        try {
          const request = await waitForAttachmentRequest(runtimeRootForSession);
          await publishAttachmentAdmission(runtimeRootForSession, request, availableCabins[0]!);
          clearInterval(responder);
        } catch { /* transient */ }
      })();
    }, 10);
    const drifted = { ...fixture.manifest, authorityGeneration: 999 };
    // A payload-drift manifest is rejected before any lifecycle core call.
    await assert.rejects(
      () => fixture.coordinator.headlessOperationalGame.activateHeadlessOperationalGame(drifted),
      /stardew_headless_manifest_identity_mismatch/,
    );
    assert.equal(fixture.playerSpawnCalls.length, 0);
    assert.equal(fixture.spawnCalls.length, 0);
    // Once the first headless admission is in flight, a second (even identical)
    // attempt fails closed with activation_conflict and never re-launches.
    const first = fixture.coordinator.headlessOperationalGame.activateHeadlessOperationalGame(fixture.manifest);
    await assert.rejects(
      () => fixture.coordinator.headlessOperationalGame.activateHeadlessOperationalGame(fixture.manifest),
      /stardew_lifecycle_activation_conflict/,
    );
    const lease = await first;
    clearInterval(responder);
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
    await lease.close();
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

// ─── Loop 4 path B': the mounted create seam and the unified failure closure ──

test("game.create runs the owner-bound world-creation seam only after its own manifest handoff admission", async () => {
  const fake = fakeGameSessionCreationAuthority();
  let pathFixture!: Awaited<ReturnType<typeof prepareCabinCoordinator>>;
  const seamObservations: Array<Readonly<{ joinedRequestId: string | null; admittedManifest: boolean }>> = [];
  pathFixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      // The production seam reports the observed slot from the join manifest and
      // fails closed with bounded codes; this stand-in fails with the seam's own
      // absent-slot code, so what is proven here is the wiring: the seam runs
      // after this create's admission, and its failure settles durably.
      createWorldBinding: async () => {
        const joinedRequestId = await attachmentRequestId(pathFixture.runtimeRoot);
        const manifest = JSON.parse(await readFile(join(
          pathFixture.runtimeRoot,
          "stardew-private-bootstrap",
          "bootstrap-coordinator-1",
          "session",
          "stardew-farmhand-manifest.json",
        ), "utf8")) as { requestId?: unknown };
        seamObservations.push(Object.freeze({
          joinedRequestId,
          admittedManifest: joinedRequestId !== null && manifest.requestId === joinedRequestId,
        }));
        throw new Error(STARDEW_GAME_WORLD_CREATION_SLOT_MISSING);
      },
    },
  });
  try {
    const creating = pathFixture.coordinator.activationOwner.createGameSession(
      pathFixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(pathFixture.runtimeRoot);
    await publishAttachmentAdmission(pathFixture.runtimeRoot, request, availableCabins[0]!);
    const result = await creating;
    assert.deepEqual(result, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    // The seam saw this create's OWN admitted manifest: the request identity on
    // disk is the one the issued manifest is signed for. A seam that ran before
    // the admission would have seen no manifest for that request at all.
    assert.equal(seamObservations.length, 1);
    assert.equal(seamObservations[0]!.admittedManifest, true);
    // A bounded seam failure never fabricates a binding: pending intent settled
    // as failed with no binding row and nothing resumable.
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0], {
      gameSessionId: sessions[0]!.gameSessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 2,
    });
    assert.equal(fake.readBinding(sessions[0]!.gameSessionId), null);
    assert.deepEqual(fake.listResumable(), []);
    assert.deepEqual(fake.inputs(), ["create", "fail"]);
    assert.deepEqual(pathFixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
  } finally {
    await pathFixture.coordinator.close();
    await pathFixture.broker.close();
  }
});

test("game.create drives the ONE durable failure closure when registration fails after an admitted manifest", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: Object.freeze({
        ...fake.authority,
        registerGameSessionWorldBinding: async () => { throw new Error("controlled-registration-failure"); },
      }),
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    const result = await creating;
    // The world was observed and admitted, but registration never landed: the
    // closure fails the pending intent and leaves no binding row, never a
    // resumable half-record and never a bare accepted.
    assert.deepEqual(result, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0], {
      gameSessionId: sessions[0]!.gameSessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 2,
    });
    assert.equal(fake.readBinding(sessions[0]!.gameSessionId), null);
    assert.deepEqual(fake.listResumable(), []);
    assert.deepEqual(fake.inputs(), ["create", "fail"]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create whose completion step fails after registration settles terminally through the ONE durable closure", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: Object.freeze({
        ...fake.authority,
        completeGameSessionBinding: async () => { throw new Error("controlled-completion-failure"); },
      }),
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // The world was created and its binding registered (rev1), but completion
    // never landed, so the session is still `pending` revision 1. That is one of
    // the two live shapes `markGameSessionWorldBindingTerminal` settles, and it
    // settles onto the same canonical terminal pair as a completed session that
    // failed later: terminal binding rev2 + failed metadata rev3 in the store's
    // own single transaction. `failGameSessionCreation` cannot settle it - it
    // refuses a session that already has a binding row - so this create drives
    // the terminal path, and only that path.
    const result = await creating;
    assert.deepEqual(result, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    const sessionId = sessions[0]!.gameSessionId;
    assert.deepEqual(fake.readBinding(sessionId), {
      gameSessionId: sessionId, integrationId: "stardew", bindingRef: "Farm_389124477", status: "terminal", revision: 2,
    });
    assert.deepEqual(fake.readMetadata(sessionId), {
      gameSessionId: sessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 3,
    });
    // Nothing resumable: the settled session can never be resumed, and the
    // registration-without-completion row pair is gone rather than left visible.
    assert.deepEqual(fake.listResumable(), []);
    // Exact durable steps: the closure took the terminal path, never `fail`.
    assert.deepEqual(fake.inputs(), ["create", "register", "terminal"]);
    // The failure preceded the first activation, so nothing was ever attached.
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    assert.deepEqual(fixture.spawnCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create reports the terminal create failure when its durable settle cannot be applied", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: Object.freeze({
        ...fake.authority,
        completeGameSessionBinding: async () => { throw new Error("controlled-completion-failure"); },
        // The store itself refuses to apply the settle (quarantine, a lost row,
        // or any other unavailable durable surface).
        markGameSessionWorldBindingTerminal: async () => { throw new Error("controlled-store-failure"); },
      }),
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // Design card 114: a create whose durable failure closure cannot be applied
    // is never reported as a clean `unavailable` - the wire reports the terminal
    // `stardew_game_create_failed` - and the unsettled rows stay visible (binding
    // registered rev1 with pending rev1 metadata) instead of being faked.
    await assert.rejects(creating, /stardew_game_create_failed/);
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    const sessionId = sessions[0]!.gameSessionId;
    assert.deepEqual(fake.readMetadata(sessionId), {
      gameSessionId: sessionId, integrationId: "stardew", continuityIdentityId: null, status: "pending", revision: 1,
    });
    assert.equal(fake.readBinding(sessionId)?.status, "registered");
    assert.deepEqual(fake.listResumable(), []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * Scripted contained-runtime teardown for the create path's slot-recovery
 * trigger.
 *
 * The drive's two halves are recorded, and the request's `readRecoveryBinding`
 * is exercised exactly as the real drive exercises it - after the recover step,
 * because it is the post-CAS successor frame - so a trigger that built its
 * request from a stale read, or from anything other than the opened attempt's
 * own record, projects something else here instead of passing by default. The
 * outcome is the caller's to script, in the drive's own vocabulary: `recovered`
 * (containment reached, so the drive finalizes), `ai_settled_player_preserved`
 * (the broker's player-role early return, closed out through that terminal's own
 * seam member), `gate_held` (the lease verdict) and `unavailable` (the recovery
 * did not reach containment); `never` installs outright refusals, so a trigger
 * that drove a recovery it should not have driven fails loudly instead of
 * silently succeeding.
 */
function scriptedRecoveryTeardown(outcome: "recovered" | "ai_settled_player_preserved" | "gate_held" | "unavailable" | "never") {
  const events: string[] = [];
  const requests: StardewOwnerRecoveryRequest[] = [];
  const recoveryBindings: unknown[] = [];
  const teardown: StardewContainedRuntimeTeardown = Object.freeze({
    containPlayerHost: async () => { events.push("containPlayerHost"); },
    containAiClient: async () => { events.push("containAiClient"); },
    settle: async () => { events.push("settle"); },
    recover: async (_owner, request) => {
      events.push("recover");
      if (outcome === "never") throw new Error("recovery_must_not_run");
      requests.push(request);
      recoveryBindings.push(await request.readRecoveryBinding());
      if (outcome === "recovered") return Object.freeze({ status: "recovered" as const });
      if (outcome === "ai_settled_player_preserved") return Object.freeze({ status: "ai_settled_player_preserved" as const });
      if (outcome === "gate_held") return Object.freeze({ status: "gate_held" as const });
      return Object.freeze({ status: "unavailable" as const });
    },
    finalizeRecovered: async (_owner, request) => {
      events.push("finalizeRecovered");
      if (outcome === "never") throw new Error("finalization_must_not_run");
      requests.push(request);
    },
    finalizeRecoveredAiSettled: async (_owner, request) => {
      events.push("finalizeRecoveredAiSettled");
      if (outcome === "never") throw new Error("finalization_must_not_run");
      requests.push(request);
    },
    close: async () => { events.push("close"); },
  });
  return Object.freeze({ teardown, events, requests, recoveryBindings });
}

/**
 * Writes a real attempt record under `bootstrapId` by re-identifying the
 * lifecycle's own persisted record, so the opener's principal check and the
 * composer's strict v4 validator both run for real against real bytes instead of
 * against a hand-built shape. `patch` carries only the fields the modelled
 * durable position actually differs in.
 */
async function writeAttemptRecord(
  runtimeRoot: string,
  bootstrapId: string,
  patch: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const live = JSON.parse(await readFile(
    join(runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "owner.json"),
    "utf8",
  )) as Record<string, unknown>;
  const record: Record<string, unknown> = { ...live, ...patch, bootstrapId };
  const directory = join(runtimeRoot, "stardew-private-bootstrap", bootstrapId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "owner.json"), JSON.stringify(record));
  return record;
}

/**
 * Seeds the slot row a crashed create leaves behind: a binding whose session
 * metadata never left `pending`, held by an opaque handle. `settle` drives it to
 * the canonical terminal pair instead, which is the shape a slot carries after
 * every one of its sessions has already settled.
 */
async function seedWorldSlotRow(
  fake: ReturnType<typeof fakeGameSessionCreationAuthority>,
  input: Readonly<{ bindingRef: string; holderHandle: string; settle: boolean }>,
) {
  const metadata = await fake.authority.createGameSessionMetadata({
    creationRequestId: `leftover-creation-request-${input.holderHandle}`,
    integrationId: "stardew",
    continuityIdentityId: null,
  });
  await fake.authority.registerGameSessionWorldBinding({
    gameSessionId: metadata.gameSessionId,
    integrationId: "stardew",
    bindingRef: input.bindingRef,
    operationId: `leftover-operation-${input.holderHandle}`,
    holderHandle: input.holderHandle,
  });
  if (input.settle)
    await fake.authority.markGameSessionWorldBindingTerminal({
      gameSessionId: metadata.gameSessionId,
      integrationId: "stardew",
      operationId: `leftover-operation-${input.holderHandle}`,
      expectedRevision: 1,
    });
  return metadata;
}

/**
 * A crashed create's leftover world slot is the PLAYER'S to keep.
 *
 * The trigger still opens the leftover attempt and drives its one recovery - so
 * the crashed attempt's own registration pointer is released and its transaction
 * consumed - and then REFUSES this create under its own bounded code, because the
 * world slot is the player's and a second create on that world is not the product
 * answer: the next stop after a crash is `resumeGameSession`. The store's slot
 * release is deliberately not called here any more, so the leftover row stays
 * registered exactly as the crashed process left it.
 *
 * The leftover attempt's record has no recorded recovery actor, so the trigger
 * mints one - that is the fallback branch, and the actor is asserted as a fresh
 * opaque guid rather than as a value this test supplied.
 */
test("game.create over a leftover world slot finalizes the crashed recovery and refuses itself with the resume-instead code", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const crashedBootstrapId = "bootstrap-crashed-attempt-1";
  const scripted = scriptedRecoveryTeardown("recovered");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    await writeAttemptRecord(fixture.runtimeRoot, crashedBootstrapId);
    const recordBefore = await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"), "utf8",
    );
    const leftover = await seedWorldSlotRow(fake, {
      bindingRef: "Farm_389124477", holderHandle: crashedBootstrapId, settle: false,
    });
    assert.equal(fake.readBinding(leftover.gameSessionId)?.status, "registered");
    assert.equal(fake.readMetadata(leftover.gameSessionId)?.status, "pending");

    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);

    // The create refused itself under its OWN bounded code: the world slot is
    // still the previous session's, so this is a known product state ("resume the
    // session instead of creating one") rather than an arbitrary internal failure.
    await assert.rejects(
      creating,
      (error: unknown) => error instanceof Error && error.message === "stardew_game_create_world_held_by_player_resume_required",
    );
    // The world slot was NOT released: the leftover holder's own registered row
    // and its pending metadata are exactly what the crashed process left, so the
    // session's world is intact and waiting for its resume.
    assert.deepEqual(fake.readBinding(leftover.gameSessionId), {
      gameSessionId: leftover.gameSessionId, integrationId: "stardew", bindingRef: "Farm_389124477",
      status: "registered", revision: 1,
    });
    assert.deepEqual(fake.readMetadata(leftover.gameSessionId), leftover);
    assert.deepEqual(fake.slotReleases(), []);
    // The drive ran once, recovered and then finalized, and never reached a
    // role-containment or a settlement path.
    assert.deepEqual(scripted.events, ["recover", "finalizeRecovered"]);
    // ONE request for both halves, so the actor the durable CASes recorded and
    // the actor the finalization must match cannot drift apart.
    assert.equal(scripted.requests.length, 2);
    assert.equal(scripted.requests[0], scripted.requests[1]);
    // The request carried the opened attempt's own projection - the seven fields
    // of the CURRENT durable record, asserted against the bytes on disk so
    // neither side can drift into agreeing on a wrong record.
    const persisted = JSON.parse(await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"), "utf8",
    )) as Record<string, unknown>;
    const guardian = persisted.guardian as Record<string, unknown>;
    assert.deepEqual(scripted.recoveryBindings, [{
      bindingRevision: guardian.bindingRevision,
      ownerRecordRevision: persisted.ownerRecordRevision,
      leaseName: guardian.leaseName,
      playerJobName: guardian.playerJobName,
      aiJobName: guardian.aiJobName,
      playerHostState: persisted.playerHostState,
      aiClientState: persisted.aiClientState,
    }]);
    assert.deepEqual(Object.keys(scripted.recoveryBindings[0] as object).sort(), [
      "aiClientState", "aiJobName", "bindingRevision", "leaseName", "ownerRecordRevision", "playerHostState", "playerJobName",
    ]);
    // The crashed attempt's own record was not touched by this refuse: nothing
    // was fabricated into it.
    assert.equal(await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"), "utf8",
    ), recordBefore);
    // The slot was read once, for this create's own world ref.
    assert.deepEqual(fake.slotReads(), [{ integrationId: "stardew", bindingRef: "Farm_389124477" }]);
    // Durable steps: the seeding pair, then this create's own create and its own
    // single failure settle. The leftover session's rows were not touched at all.
    assert.deepEqual(fake.inputs(), ["create", "register", "create", "fail"]);
    // This create's own attempt settled through the SAME single durable closure:
    // the pre-registration shape (pending rev1 -> failed rev2, no binding row),
    // never a resumable half-record.
    const sessions = fake.sessions();
    assert.equal(sessions.length, 2);
    const own = sessions.find((row) => row.gameSessionId !== leftover.gameSessionId)!;
    assert.deepEqual(own, {
      gameSessionId: own.gameSessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 2,
    });
    assert.equal(fake.readBinding(own.gameSessionId), null);
    assert.deepEqual(fake.listResumable(), []);
    // Never attached and never ready: no AI client was launched and the wire
    // reports no session handle.
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    assert.deepEqual(fixture.spawnCalls, []);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * The leftover record's own recorded recovery actor is adopted, never replaced,
 * and the world slot is never released on this path either.
 *
 * An interrupted recovery must resume its exact recorded actor: the actor the
 * durable CASes wrote is the one the finalization has to match, so this trigger's
 * own fallback cannot substitute an actor of its own. And because the world slot
 * is the player's to keep, the holder's own handle is read but never presented
 * for a release.
 */
test("game.create's leftover trigger adopts the record's recorded recovery actor and never releases the world slot", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const crashedBootstrapId = "bootstrap-crashed-attempt-2";
  const recordedActor = "5c8e1f2b-0a4d-4e7c-9b31-6d2f8a3c7e50";
  const scripted = scriptedRecoveryTeardown("recovered");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    // An interrupted recovery: the durable `recovering` CAS already ran and wrote
    // its actor, and one role is already classified contained.
    await writeAttemptRecord(fixture.runtimeRoot, crashedBootstrapId, {
      state: "recovering", guardianState: "recovering", recoveryInstanceId: recordedActor,
      playerHostState: "contained", aiClientState: "active",
    });
    const recordBefore = await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"), "utf8",
    );
    const leftover = await seedWorldSlotRow(fake, {
      bindingRef: "Farm_389124477", holderHandle: crashedBootstrapId, settle: false,
    });

    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(
      creating,
      (error: unknown) => error instanceof Error && error.message === "stardew_game_create_world_held_by_player_resume_required",
    );

    // The record's own actor was adopted, not replaced.
    assert.equal(scripted.requests[0]!.recoveryInstanceId, recordedActor);
    // The world slot was never released, so its holder's own handle was never
    // presented for one; the leftover session still holds the slot with the shape
    // the crashed process left.
    assert.deepEqual(fake.slotReleases(), []);
    assert.deepEqual(fake.readBinding(leftover.gameSessionId), {
      gameSessionId: leftover.gameSessionId, integrationId: "stardew", bindingRef: "Farm_389124477",
      status: "registered", revision: 1,
    });
    assert.deepEqual(fake.readMetadata(leftover.gameSessionId), leftover);
    // The interrupted recovery's own record was left exactly as it was found: its
    // adopted actor and its `recovering` position are intact.
    assert.equal(await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"), "utf8",
    ), recordBefore);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * The AI-side terminal on the create path: the broker settled and cleaned up the
 * AI side and deliberately preserved the player's world, and this create refuses
 * itself under its OWN bounded code, whose meaning is that the world is still the
 * player's and the session must be RESUMED rather than created again.
 *
 * The attempt is closed out on the same step, through that terminal's own seam
 * member: the drive closes the attempt out FIRST and only then reports the
 * terminal, so an attempt is never reported as closed while it still occupies its
 * registration. What the durable closure itself does - the record's own terminal,
 * the registration pointer release and the consumed transaction - is asserted in
 * the composer test and in the cross-layer recovery integration test, where a real
 * owner binding exists; this level scripts the seam, so here it is the ORDER that
 * is pinned together with everything the trigger must never do: no world-slot
 * release, no fabricated record, no invented role containment.
 *
 * The residual this test used to record is closed: the registration pointer is no
 * longer left bound to the crashed attempt, so the resume this refusal points at
 * is no longer refused with `stardew_bootstrap_registration_unavailable`. The
 * cross-layer lane asserts that end to end.
 */
test("game.create over a slot whose recovery settled the AI side refuses itself and leaves the player's world to resume", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const crashedBootstrapId = "bootstrap-crashed-attempt-3";
  const recordedActor = "6d2a9f4b-1c37-4e80-9b52-7f0e4a8d3c61";
  const scripted = scriptedRecoveryTeardown("ai_settled_player_preserved");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    // The shape the deliberate terminal leaves the attempt in: the durable
    // `recovering` CAS ran (the gate opened and a recorded actor exists), NO role
    // was recorded contained, and nothing claims a pending cleanup retry.
    await writeAttemptRecord(fixture.runtimeRoot, crashedBootstrapId, {
      state: "recovering", guardianState: "recovering", recoveryInstanceId: recordedActor,
      playerHostState: "reserved", aiClientState: "reserved",
    });
    const recordBefore = await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"), "utf8",
    );
    const leftover = await seedWorldSlotRow(fake, {
      bindingRef: "Farm_389124477", holderHandle: crashedBootstrapId, settle: false,
    });

    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // The refusal is this create's own resume-instead code, never the held-gate
    // verdict: a held gate would claim the holder was not proven gone, which is
    // not what happened - the gate opened and the AI side was settled.
    await assert.rejects(
      creating,
      (error: unknown) => error instanceof Error && error.message === "stardew_game_create_world_held_by_player_resume_required",
    );

    // The drive ran its recover step exactly once and then closed the attempt out
    // through that terminal's OWN seam member - never through the containment one,
    // which would close it out as a containment the recovery never observed. The
    // closure itself is the composer's real one in production (asserted in the
    // composer and cross-layer tests); the scripted seam here records the order.
    assert.deepEqual(scripted.events, ["recover", "finalizeRecoveredAiSettled"]);
    // The world slot is still held by the crashed session, with its own handle,
    // and its row is untouched. This is the evidence for the ruling's third goal:
    // the player's world is preserved, waiting for its resume.
    assert.deepEqual(fake.readBinding(leftover.gameSessionId), {
      gameSessionId: leftover.gameSessionId, integrationId: "stardew", bindingRef: "Farm_389124477",
      status: "registered", revision: 1,
    });
    assert.deepEqual(fake.readMetadata(leftover.gameSessionId), leftover);
    assert.deepEqual(fake.slotReleases(), []);
    // The slot-addressed read still names the crashed attempt as the holder, so a
    // later lifecycle can still open that exact attempt.
    assert.deepEqual(await fake.authority.readGameSessionWorldBindingSlotHolder({ integrationId: "stardew", bindingRef: "Farm_389124477" }), {
      gameSessionId: leftover.gameSessionId, integrationId: "stardew", bindingRef: "Farm_389124477",
      status: "registered", revision: 1, holderHandle: crashedBootstrapId,
    });
    // Nothing was fabricated into the attempt record: what this create's drive did
    // to it is exactly what the closure this level scripted did - nothing. It is
    // still the record the deliberate terminal left, read back field by field, so a
    // silent rewrite into a terminal or quarantined shape cannot pass as "unchanged
    // bytes". The durable closure's own effect on that record (its terminal
    // successor, the released pointer, the consumed transaction) is asserted where
    // a real owner binding exists: the composer test and the cross-layer test.
    assert.equal(await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"), "utf8",
    ), recordBefore);
    const persisted = JSON.parse(recordBefore) as Record<string, unknown>;
    assert.equal(persisted.state, "recovering");
    assert.equal(persisted.recoveryInstanceId, recordedActor);
    assert.notEqual(persisted.playerHostState, "contained");
    assert.notEqual(persisted.aiClientState, "contained");
    assert.equal(persisted.cleanupDisposition, "pending");
    // This create's own attempt still settles through the SAME single durable
    // closure, and its own durable steps are unchanged.
    assert.deepEqual(fake.inputs(), ["create", "register", "create", "fail"]);
    const sessions = fake.sessions();
    assert.equal(sessions.length, 2);
    const own = sessions.find((row) => row.gameSessionId !== leftover.gameSessionId)!;
    assert.deepEqual(own, {
      gameSessionId: own.gameSessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 2,
    });
    assert.equal(fake.readBinding(own.gameSessionId), null);
    assert.deepEqual(fake.listResumable(), []);
    assert.deepEqual(fixture.spawnCalls, []);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * No leftover holder is the untouched path: the create consults the slot, finds
 * nothing to recover, drives no recovery at all, and takes exactly the durable
 * steps it took before the trigger existed.
 */
test("game.create over a slot with no leftover holder drives no recovery and keeps its previous durable steps", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const scripted = scriptedRecoveryTeardown("never");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    const result = await creating;
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    assert.equal(result.status, "attached");
    // The slot was consulted - the read is never skipped - and nothing was
    // driven or released off it.
    assert.deepEqual(fake.slotReads(), [{ integrationId: "stardew", bindingRef: "Farm_389124477" }]);
    assert.deepEqual(fake.slotReleases(), []);
    assert.deepEqual(scripted.events, []);
    // Exactly the pre-trigger durable steps, in the same order.
    assert.deepEqual(fake.inputs(), ["create", "register", "complete"]);
    assert.equal(fake.readBinding(result.gameSessionId!)?.status, "registered");
    assert.equal(fake.readMetadata(result.gameSessionId!)?.status, "resumable");
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * A SETTLED row on the slot is not an occupant. The readback deliberately
 * returns such a row when nothing is registered - so a release against it is
 * refused as `holderTerminal` instead of being mistaken for an unknown slot -
 * and reading it as an occupant here would refuse every later create on a slot
 * that has ever been settled.
 *
 * That is not a theoretical shape: the binding ref is the physical save slot the
 * Player Host observed, whose basename is derived from the farm name, so a create
 * that failed once leaves a terminal row under exactly the ref the next create
 * observes. The record below is a real terminal one, so a judge that decided on
 * the record instead of on the row would hit the opener's terminal refusal here
 * and the create would fail closed.
 */
test("game.create is not blocked by a settled row on the slot, only by a registered holder", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const settledBootstrapId = "bootstrap-settled-attempt-1";
  const scripted = scriptedRecoveryTeardown("never");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    // The attempt behind the settled row terminated: both roles drained, no
    // recorded actor, nothing left to recover.
    await writeAttemptRecord(fixture.runtimeRoot, settledBootstrapId, {
      state: "contained", guardianState: "contained", recoveryInstanceId: null,
      playerHostState: "contained", aiClientState: "contained",
    });
    const settled = await seedWorldSlotRow(fake, {
      bindingRef: "Farm_389124477", holderHandle: settledBootstrapId, settle: true,
    });
    assert.equal(fake.readBinding(settled.gameSessionId)?.status, "terminal");

    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    const result = await creating;
    assert.equal(result.status, "attached");
    assert.deepEqual(fake.slotReads(), [{ integrationId: "stardew", bindingRef: "Farm_389124477" }]);
    assert.deepEqual(scripted.events, []);
    assert.deepEqual(fake.slotReleases(), []);
    // The settled row is untouched, and this create's own world is registered on
    // the same slot.
    assert.deepEqual(fake.readBinding(settled.gameSessionId), {
      gameSessionId: settled.gameSessionId, integrationId: "stardew", bindingRef: "Farm_389124477",
      status: "terminal", revision: 2,
    });
    assert.deepEqual(fake.inputs(), ["create", "register", "terminal", "create", "register", "complete"]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * A slot whose holder is a LIVE attempt is refused at the slot judge, not at the
 * store's duplicate rule.
 *
 * This test used to pin the store's own `game_session_world_binding_duplicate`
 * refusal as reached from the create path: the create registered, the store
 * rejected the second live session on the world slot, and the create settled
 * through the one durable closure. The judge now decides that case first - a
 * `registered` holder is driven through the existing recovery seam, and a held
 * native gate means the holder was NOT proven gone - so the store's duplicate
 * rule is never reached from here at all. What the scenario must still prove is
 * unchanged: a live holder is refused, nothing is stolen from it, nothing is
 * released or finalized, and the create settles through the SAME single durable
 * closure. The store's duplicate rule keeps its own test in the store suite.
 */
test("game.create is refused at the slot judge when another live holder still owns the world slot", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const foreignBootstrapId = "bootstrap-live-holder-1";
  const scripted = scriptedRecoveryTeardown("gate_held");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    // Another session (pending metadata + registered binding) already holds the
    // world slot this create's own world-creation seam observes, and the attempt
    // behind its handle is still non-terminal - so its native gate is held.
    await writeAttemptRecord(fixture.runtimeRoot, foreignBootstrapId);
    const foreign = await seedWorldSlotRow(fake, {
      bindingRef: "Farm_389124477", holderHandle: foreignBootstrapId, settle: false,
    });
    const foreignRecordBefore = await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", foreignBootstrapId, "owner.json"), "utf8",
    );

    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // The refusal carries the judge's OWN bounded code: a held gate is the lease
    // verdict - the holder was not proven gone, since the handle at that lease
    // name may be a gate this Host itself opened - and it is reported as itself
    // rather than folded into the generic unavailable outcome.
    await assert.rejects(
      creating,
      (error: unknown) => error instanceof Error && error.message === "stardew_game_create_slot_holder_not_proven_gone",
    );
    // The refusal happened at the judge: this create never asked the store to
    // register, so the store's own duplicate rule is not the thing refusing here.
    assert.deepEqual(fake.inputs(), ["create", "register", "create", "fail"]);
    // Nothing was released and nothing was finalized; the drive ran its recover
    // step exactly once and stopped there.
    assert.deepEqual(scripted.events, ["recover"]);
    assert.deepEqual(fake.slotReleases(), []);
    // The live holder's slot and its durable record are exactly what they were:
    // it keeps the one registered row on that world, and its attempt was neither
    // recovered nor rewritten.
    assert.deepEqual(fake.readBinding(foreign.gameSessionId), {
      gameSessionId: foreign.gameSessionId, integrationId: "stardew", bindingRef: "Farm_389124477", status: "registered", revision: 1,
    });
    assert.deepEqual(fake.readMetadata(foreign.gameSessionId), foreign);
    assert.equal(await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", foreignBootstrapId, "owner.json"), "utf8",
    ), foreignRecordBefore);
    // This create's own attempt still settles through the SAME single closure:
    // the pre-registration shape (pending rev1 -> failed rev2, no binding row),
    // never a resumable half-record.
    const sessions = fake.sessions();
    assert.equal(sessions.length, 2);
    const own = sessions.find((row) => row.gameSessionId !== foreign.gameSessionId)!;
    assert.deepEqual(own, {
      gameSessionId: own.gameSessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 2,
    });
    assert.equal(fake.readBinding(own.gameSessionId), null);
    assert.deepEqual(fake.listResumable(), []);
    // Never attached and never ready: no world of this session's own exists, no
    // AI client was launched and the wire reports no session handle.
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
    assert.deepEqual(fixture.spawnCalls, []);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("close during create settles the interrupted create through the same durable closure", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const completionEntered = deferredVoid();
  const completionGate = deferredVoid();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: Object.freeze({
        ...fake.authority,
        completeGameSessionBinding: async (
          input: Parameters<StardewGameSessionCreationAuthority["completeGameSessionBinding"]>[0],
        ) => {
          completionEntered.resolve();
          await completionGate.promise;
          return fake.authority.completeGameSessionBinding(input);
        },
      }),
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    const creating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // Parked inside the completion step: the binding is registered and the
    // session is one step short of `resumable`.
    await completionEntered.promise;
    assert.equal(fake.sessions()[0]!.status, "pending");
    assert.equal(fake.readBinding(fake.sessions()[0]!.gameSessionId)?.status, "registered");
    // Design card 114: an unfinished create stops before close and is settled by
    // the durable failure rules. close() joins this attempt, so the closure runs
    // before any teardown and the post-close state is terminal + failed, never a
    // registered binding with resumable metadata behind.
    const closing = fixture.coordinator.close();
    completionGate.resolve();
    await assert.rejects(creating, /stardew_lifecycle_closing/);
    await closing;
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    const sessionId = sessions[0]!.gameSessionId;
    assert.deepEqual(fake.readBinding(sessionId), {
      gameSessionId: sessionId, integrationId: "stardew", bindingRef: "Farm_389124477", status: "terminal", revision: 2,
    });
    assert.deepEqual(fake.readMetadata(sessionId), {
      gameSessionId: sessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 3,
    });
    assert.deepEqual(fake.listResumable(), []);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none", generation: 0, connectionStatus: "none",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * Explicit-endgame lifecycle setup for the close/create interaction tests below:
 * activate, launch and attest the Player Host, bind the semantic attachment
 * through the cabin confirmation, then drive the successful explicit endgame.
 * The endgame terminates the world but leaves `activationState` at
 * `awaiting_player_host_attestation` and the exact owner in place, which is why
 * a create is still admissible afterwards.
 */
async function startEndgameLifecycle(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
  await publishSignedPlayerHostSession(fixture.runtimeRoot, "player-generation-1", availableCabins, Date.now() + 5 * 60_000);
  await fixture.coordinator.activationOwner.setupPlayerHost(
    fixture.broker.issue("game_setup"),
    { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" },
  ).then(() => fixture.coordinator.activationOwner.launchPlayerHost(
    fixture.broker.issue("game_launch"),
    { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedInstanceGeneration: 1 },
  ));
  await confirmFirstCabin(fixture);
  assert.deepEqual(
    await fixture.coordinator.activationOwner.endgameGame(fixture.broker.issue("game_endgame"), {
      apiVersion: 1, idempotencyKey: "endgame-key-1", expectedAttachmentGeneration: 1, confirm: true,
    }),
    { apiVersion: 1, status: "gameended" },
  );
}

function containedGuardianSessionRecorder(sessionCalls: string[]): DesktopGuardianSession {
  return Object.freeze({
    async arm() { sessionCalls.push("arm"); return containedSessionAck("arm_attempt"); },
    async launch(input) { sessionCalls.push("launch"); return containedSessionAck("launch_role", input.role); },
    async contain(input) { sessionCalls.push("contain"); return containedSessionAck("contain_role", input.role); },
    // These launches never drive a recovery, but the session contract carries
    // it and an honest literal fake answers it explicitly.
    async recover() { sessionCalls.push("recover"); return Object.freeze({ outcome: "contained" as const }); },
    async close() { sessionCalls.push("close"); },
  });
}

test("close after an explicit endgame joins an in-flight create so its durable rows settle before close resolves", async () => {
  await withWindowsPlatform(async () => {
    const fake = fakeGameSessionCreationAuthority();
    const completionEntered = deferredVoid();
    const completionGate = deferredVoid();
    const sessionCalls: string[] = [];
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(containedGuardianSessionRecorder(sessionCalls)),
    );
    const fixture = await createFixture({
      overrides: {
        runtimeLaunchContained: collaborator,
        gameSessionCreationAuthority: Object.freeze({
          ...fake.authority,
          completeGameSessionBinding: async (
            input: Parameters<StardewGameSessionCreationAuthority["completeGameSessionBinding"]>[0],
          ) => {
            completionEntered.resolve();
            await completionGate.promise;
            return fake.authority.completeGameSessionBinding(input);
          },
        }),
        createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
      },
    });
    try {
      await startEndgameLifecycle(fixture);
      const previousRequestId = await attachmentRequestId(fixture.runtimeRoot);
      const creating = fixture.coordinator.activationOwner.createGameSession(
        fixture.broker.issue("game_create"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
      );
      let createSettled = false;
      void creating.then(() => { createSettled = true; }, () => { createSettled = true; });
      await publishNextAttachmentAdmission(fixture.runtimeRoot, previousRequestId, availableCabins[0]!);
      // Parked inside the completion step: the binding is registered and the
      // session is one step short of `resumable`.
      await completionEntered.promise;
      const sessionId = fake.sessions()[0]!.gameSessionId;
      assert.equal(fake.readMetadata(sessionId)?.status, "pending");
      assert.equal(fake.readBinding(sessionId)?.status, "registered");
      const closing = fixture.coordinator.close();
      completionGate.resolve();
      await closing;
      // Nothing was awaited between `close()` and these assertions, so they run
      // at the exact instant close resolved -- that ordering is the point: the
      // endgame branch of close used to return without joining the create, so it
      // could resolve while the create's durable settle was still pending.
      // close() joins the in-flight create on EVERY path, so the create's own
      // failure closure has already run here.
      assert.equal(createSettled, true);
      assert.deepEqual(fake.readBinding(sessionId), {
        gameSessionId: sessionId, integrationId: "stardew", bindingRef: "Farm_389124477", status: "terminal", revision: 2,
      });
      assert.deepEqual(fake.readMetadata(sessionId), {
        gameSessionId: sessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 3,
      });
      assert.deepEqual(fake.listResumable(), []);
      await assert.rejects(creating, /stardew_lifecycle_closing/);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("close after an explicit endgame leaves no facade or lease open for the create it drained", async () => {
  await withWindowsPlatform(async () => {
    const fake = fakeGameSessionCreationAuthority();
    const seamEntered = deferredVoid();
    const seamGate = deferredVoid();
    const sessionCalls: string[] = [];
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(containedGuardianSessionRecorder(sessionCalls)),
    );
    const fixture = await createFixture({
      overrides: {
        runtimeLaunchContained: collaborator,
        gameSessionCreationAuthority: fake.authority,
        // Parked in the world-creation seam, i.e. BEFORE registration: the other
        // mutually exclusive durable create failure shape.
        createWorldBinding: async () => {
          seamEntered.resolve();
          await seamGate.promise;
          return Object.freeze({ bindingRef: "Farm_389124477" });
        },
      },
    });
    try {
      await startEndgameLifecycle(fixture);
      const previousRequestId = await attachmentRequestId(fixture.runtimeRoot);
      const creating = fixture.coordinator.activationOwner.createGameSession(
        fixture.broker.issue("game_create"),
        { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
      );
      let createSettled = false;
      void creating.then(() => { createSettled = true; }, () => { createSettled = true; });
      await publishNextAttachmentAdmission(fixture.runtimeRoot, previousRequestId, availableCabins[0]!);
      await seamEntered.promise;
      const sessionId = fake.sessions()[0]!.gameSessionId;
      assert.equal(fake.readBinding(sessionId), null);
      const closing = fixture.coordinator.close();
      seamGate.resolve();
      await closing;
      // Immediately after close resolved, without awaiting the create first.
      assert.equal(createSettled, true);
      assert.deepEqual(fake.readMetadata(sessionId), {
        gameSessionId: sessionId, integrationId: "stardew", continuityIdentityId: null, status: "failed", revision: 2,
      });
      assert.equal(fake.readBinding(sessionId), null);
      assert.deepEqual(fake.listResumable(), []);
      // No facade/lease is left open. On this path the drained create cannot mint
      // one at all: the endgame already drove the durable owner record to
      // `contained`, so the AI-client launch and the bridge consumption it would
      // need both fail closed before `attachResumedWorld` can reach :1449/:1485.
      // The assertions below show the whole path is drained: the only facade and
      // lease this lifecycle built came from the cabin confirmation, the
      // endgame's own teardown closed the facade exactly once, and the drained
      // create left no second, unclosed one behind.
      assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
        status: "none", generation: 0, connectionStatus: "none",
      });
      assert.equal(fixture.bridgeConnectCalls.length, 1);
      assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
      assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("game.create after a failed FIRST AI launch re-arms a fresh activation instead of retrying consumed reservations", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    // The very first AI-client spawn of this lifecycle fails.
    aiSpawnFailureAt: 1,
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    const firstCreating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const firstRequest = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, firstRequest, availableCabins[0]!);
    const first = await firstCreating;
    // The first create settled post-registration as unavailable: terminal
    // binding + failed metadata (the D2 shape, driven by the ONE closure).
    assert.deepEqual(first, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.spawnCalls[0]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-1");
    const firstSessionId = fake.sessions()[0]!.gameSessionId;
    assert.equal(fake.readBinding(firstSessionId)?.status, "terminal");
    assert.equal(fake.readMetadata(firstSessionId)?.status, "failed");
    // The failed launch still consumed the owner's one-shot AI-client launch and
    // bridge connection reservations. A later create in the same lifecycle must
    // therefore re-arm a fresh activation generation instead of retrying them
    // (which would fail closed with stardew_ai_client_launch_not_available).
    const secondRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const secondCreating = fixture.coordinator.activationOwner.createGameSession(
      fixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    await publishNextAttachmentAdmission(fixture.runtimeRoot, secondRequestId, availableCabins[0]!);
    const second = await secondCreating;
    assert.equal(second.status, "attached");
    assert.notEqual(second.gameSessionId, firstSessionId);
    assert.match(second.gameSessionId ?? "", /^[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(
      fixture.spawnCalls.map((call) => call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION),
      ["ai-generation-1", "ai-generation-2"],
    );
    assert.equal(fake.readMetadata(second.gameSessionId!)?.status, "resumable");
    assert.equal(fake.readBinding(second.gameSessionId!)?.status, "registered");
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached", generation: 2, connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    // The Player world is untouched by either create or by the failed launch.
    assert.deepEqual(fixture.playerKillCalls, []);
    assert.equal(fixture.playerSpawnCalls.length, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
