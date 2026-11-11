// Shared fixtures for the stardew-production-lifecycle-coordinator test files. Every group below imports from here:
//   stardew-production-lifecycle-coordinator-activation.internal.test.ts
//   stardew-production-lifecycle-coordinator-owner-recovery.internal.test.ts
//   stardew-production-lifecycle-coordinator-installation-discovery.internal.test.ts
//   stardew-production-lifecycle-coordinator-installation-registration.internal.test.ts
//   stardew-production-lifecycle-coordinator-player-host-admission.internal.test.ts
//   stardew-production-lifecycle-coordinator-close-and-teardown.internal.test.ts
//   stardew-production-lifecycle-coordinator-cabin-handoff.internal.test.ts
//   stardew-production-lifecycle-coordinator-attachment-stop.internal.test.ts
//   stardew-production-lifecycle-coordinator-resume.internal.test.ts
//   stardew-production-lifecycle-coordinator-action-authority-reopen.internal.test.ts
//   stardew-production-lifecycle-coordinator-game-create.internal.test.ts
//   stardew-production-lifecycle-coordinator-resume-cancel-and-headless-admission.internal.test.ts
//   stardew-production-lifecycle-coordinator-game-create-recovery.internal.test.ts
//   stardew-production-lifecycle-coordinator-close-during-create.internal.test.ts
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { composeGameProfile, type GameLaunchCommandV1 } from "./game-browser-contract/index.js";
import { createGameBrowserStateProvider } from "./game-browser/game-browser-state-provider.js";
import { composeReferenceGameBrowserProfile } from "./composed-browser-contract/index.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import { composeTavernProfile, TavernBrowserFixtureV1 } from "./tavern/browser-contract/index.js";
import {
  createStardewProductionLifecycleCoordinatorForTesting,
  type StardewLifecycleCoordinatorTestingOverrides,
} from "./stardew-production-lifecycle-coordinator.test-support-internal.js";
import type {
  StardewContainedRuntimeTeardown,
  StardewGameSessionCreationAuthority,
  StardewProductionLifecycleCoordinator,
} from "./stardew-production-lifecycle-coordinator.internal.js";
import {
  productionGameSessionWorldBindingSlotRelease,
  type ProductionGameSessionMetadata,
  type ProductionGameSessionWorldBinding,
} from "./continuity-semantic-store/continuity-semantic-production-store.js";
import type { StardewPrivateBootstrapCoreDependencies } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.test-support-internal.js";
import type { DesktopGuardianSession, GuardianAck } from "./containment/auth/desktop-guardian-session.internal.js";
import type { StardewOwnerRecoveryRequest } from "./composition/stardew/stardew-guardian-platform.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";
import { createTestWindowsReparseInspector } from "./windows-reparse-inspector/index.test-support.js";
import type {
  WindowsPathObjectIdentity,
  WindowsReparseInspectorCapability,
} from "./windows-reparse-inspector/index.js";

export const bootstrapToken = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
export const gameDirectoryCandidate = "C:\\Games\\Stardew Valley";
export const installationChain: readonly WindowsPathObjectIdentity[] = Object.freeze([
  Object.freeze({
    objectKind: "directory",
    isReparsePoint: false,
    volumeIdentity: "0123456789abcdef",
    fileId: "00000000000000000000000000000001",
  }),
  Object.freeze({
    objectKind: "directory",
    isReparsePoint: false,
    volumeIdentity: "0123456789abcdef",
    fileId: "00000000000000000000000000000002",
  }),
  Object.freeze({
    objectKind: "directory",
    isReparsePoint: false,
    volumeIdentity: "0123456789abcdef",
    fileId: "00000000000000000000000000000003",
  }),
  Object.freeze({
    objectKind: "regular_file",
    isReparsePoint: false,
    volumeIdentity: "0123456789abcdef",
    fileId: "00000000000000000000000000000004",
  }),
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
export /**
 * The game surface this file's fixtures serve, declaring every operation the
 * composed wire mounts onto the coordinator's own seams. The profile is the
 * mount contract: the composed handler refuses a composition that declares an
 * operation with no callback behind it, and a callback behind no declaration,
 * so a route this file drives over real HTTP has to be named here first.
 */
const gameProfile = composeGameProfile({
  profileId: "gamebuddy.game.preview",
  releaseTier: "game_preview",
  operationIds: [
    "game.state.read",
    "game.prerequisites.setup",
    "game.launch",
    "game.stop",
    "game.resume",
    "game.resume.cancel",
    "game.reopen",
    "game.disconnect",
    "game.endgame",
    "game.installation.discovery.read",
    "game.installation.discovery.confirm",
    "game.installation.discovery.retry",
    "game.installation.discovery.cancel",
    "game.installation.discovery.manual_picker",
    "game.stardew.cabins.read",
    "game.stardew.cabins.confirm",
  ],
  navigationItemIds: ["game"],
});
export const temporaryRoots: string[] = [];
export function deferredVoid(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return Object.freeze({ promise, resolve });
}
export /**
 * Bounds a test's wait for a parked product hand-off. If a later product change
 * makes the parked step unreachable, the fixture fails by name instead of
 * leaving the runner waiting on an event that can never arrive, which Node
 * reports as `--test-timeout` and then waits on the body for anyway.
 */
async function awaitParkedPhase(
  entered: Readonly<{ promise: Promise<void> }>,
  phase: string,
  budgetMs = 20_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`stardew_create_close_fixture_phase_unreachable:${phase} after ${budgetMs}ms`)),
          budgetMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
type RecordedGameStop = Readonly<{ stopId: string; sourceEventId: string; reasonCode: string; locale?: string }>;
export function connectedSemanticGameLeaseFixture(
  input: Readonly<{
    onAttachVoiceStopper?(): void;
    onActivate?(): void;
    onStop?(stop: RecordedGameStop): void;
    onCancelTask?(): void;
    stopSettled?: Promise<void>;
  }> = {},
) {
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
function stateForChat(context: ComposedReferenceGameBrowserReadContext) {
  const base = TavernBrowserFixtureV1.snapshot();
  return {
    ...base,
    build: { ...base.build, profileId: tavernProfile.profileId },
    csrfToken: context.csrfToken,
    browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
  };
}
export /**
 * The identity chain admission expects for one Windows folder: a drive root, one directory
 * per path component, then the executable leaf. `admitStardewInstallation` requires exactly
 * that length and that shape, so a fixture that picks a real temporary folder has to size its
 * chain to the folder it picked.
 */
function identityChainFor(folder: string): readonly WindowsPathObjectIdentity[] {
  const componentCount = folder.slice(3).split("\\").length;
  return [...Array.from({ length: componentCount + 1 }, () => installationChain[0]!), installationChain.at(-1)!];
}
export function installationInspector(
  chains: readonly (readonly WindowsPathObjectIdentity[])[],
  beforeResponse?: (readIndex: number) => Promise<void>,
) {
  let index = 0;
  return createTestWindowsReparseInspector(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    child.stdin.on(
      "data",
      () =>
        void (async () => {
          const readIndex = index + 1;
          if (beforeResponse !== undefined) await beforeResponse(readIndex);
          const chain = chains[index++] ?? chains.at(-1) ?? installationChain;
          child.stdout.end(
            `${JSON.stringify({
              schemaVersion: 2,
              operation: "inspect_path_chain_v2",
              status: "ok",
              components: chain,
            })}\n`,
          );
          child.stderr.end();
          queueMicrotask(() => child.emit("close", 0, null));
        })(),
    );
    return child as unknown as ChildProcess;
  });
}
export function sequencedInstallationInspector(
  sequences: readonly (readonly (readonly WindowsPathObjectIdentity[])[])[],
  beforeResponse?: (sequenceIndex: number, readIndex: number) => Promise<void>,
) {
  let sequenceIndex = 0;
  let readIndex = 0;
  let current: readonly (readonly WindowsPathObjectIdentity[])[] | undefined;
  return createTestWindowsReparseInspector(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    child.stdin.on(
      "data",
      () =>
        void (async () => {
          current ??= sequences[sequenceIndex++] ?? [];
          const currentSequenceIndex = sequenceIndex;
          const currentReadIndex = readIndex + 1;
          if (beforeResponse !== undefined) await beforeResponse(currentSequenceIndex, currentReadIndex);
          const chain = current[readIndex++] ?? current.at(-1) ?? installationChain;
          child.stdout.end(
            `${JSON.stringify({
              schemaVersion: 2,
              operation: "inspect_path_chain_v2",
              status: "ok",
              components: chain,
            })}\n`,
          );
          child.stderr.end();
          queueMicrotask(() => child.emit("close", 0, null));
          if (readIndex >= current.length) {
            current = undefined;
            readIndex = 0;
          }
        })(),
    );
    return child as unknown as ChildProcess;
  });
}
export async function withWindowsPlatform<T>(operation: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}
export /** Shape the authenticated session expects back for every relayed command. */
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
type DiscoveryBrowserHandler = NonNullable<
  Parameters<typeof createComposedReferenceGameBrowserRequestHandler>[0]["gameDiscovery"]
>;
export /**
 * The composed wire with the Host's own lifecycle mounted on it.
 *
 * Every game route this file drives is wired to `coordinator.activationOwner`, and
 * `game.state.read` to the product's own state provider over the coordinator's
 * readers - so a request either reaches the real coordinator or is refused by the
 * composed handler before it. Called without a coordinator it serves a Tavern-only
 * profile: that broker exists to mint an admission from a DIFFERENT browser session,
 * and a second game surface on the same fixture would advertise a lifecycle it does
 * not own.
 */
async function createAdmissionBroker(
  coordinator?: StardewProductionLifecycleCoordinator,
  gameDiscovery?: DiscoveryBrowserHandler,
) {
  // Bound together so the mount below narrows on ONE value: a broker has either the whole
  // host-owned game surface or none of it, which is exactly what the composed handler's
  // mismount guard refuses to see half of.
  const gameSurface =
    coordinator === undefined
      ? undefined
      : Object.freeze({
          coordinator,
          stateProvider: createGameBrowserStateProvider(
            gameProfile,
            coordinator.lifecycleReader,
            coordinator.attachmentReader,
            coordinator.launchReadinessReader,
            coordinator.actionAuthorityReader,
            coordinator.installationReader,
            coordinator.worldBindingReader,
          ),
        });
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile:
      gameSurface === undefined
        ? composeReferenceGameBrowserProfile({ tavernProfile })
        : composeReferenceGameBrowserProfile({ tavernProfile, gameProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
    ...(gameSurface === undefined
      ? {}
      : {
          readGame: (context: ComposedReferenceGameBrowserReadContext) => gameSurface.stateProvider.readState(context),
          // The composed wire's own seams, mounted onto the coordinator's activation
          // owner exactly as the production provider mounts them. The owner's private
          // snapshot is discarded, as the browser callback requires.
          gameActivate: async (admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<void> => {
            await gameSurface.coordinator.activationOwner.activate(admission);
          },
          gameSetup: gameSurface.coordinator.activationOwner.setupPlayerHost,
          gameLaunch: async (
            admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
            command: GameLaunchCommandV1,
          ): Promise<void> => {
            await gameSurface.coordinator.activationOwner.launchPlayerHost(admission, command);
          },
          gameStop: gameSurface.coordinator.activationOwner.stopGame,
          gameResume: gameSurface.coordinator.activationOwner.resume,
          gameResumeCancel: gameSurface.coordinator.activationOwner.cancelResume,
          gameReopen: gameSurface.coordinator.activationOwner.reopenActionAuthority,
          gameDisconnect: gameSurface.coordinator.activationOwner.disconnectGame,
          gameEndgame: gameSurface.coordinator.activationOwner.endgameGame,
          stardewCabins: Object.freeze({
            read: gameSurface.coordinator.activationOwner.readCabinChoices,
            confirm: gameSurface.coordinator.activationOwner.confirmCabinChoice,
          }),
          gameDiscovery: gameDiscovery ?? {
            read: async () => ({ apiVersion: 1, candidates: [], diagnostics: [] }),
            confirm: async () => ({ apiVersion: 1, status: "registered" }),
            retry: async () => ({ apiVersion: 1, candidates: [], diagnostics: [] }),
            cancel: async () => ({ apiVersion: 1, status: "cancelled" }),
            manualPicker: async () => ({ apiVersion: 1, status: "cancelled" }),
          },
        }),
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
  const root = (await bootstrap.json()) as { chat: { csrfToken: string } };
  const request = (
    operation:
      | "lifecycle_activation"
      | "cabin_read"
      | "cabin_confirm"
      | "discovery_read"
      | "discovery_confirm"
      | "discovery_retry"
      | "discovery_cancel"
      | "discovery_picker"
      | "game_setup"
      | "game_launch"
      | "game_stop"
      | "game_resume"
      | "game_resume_cancel"
      | "game_reopen"
      | "game_disconnect"
      | "game_endgame"
      | "game_create",
  ): IncomingMessage => {
    const originUrl = new URL(origin);
    const method = operation === "cabin_read" || operation === "discovery_read" ? "GET" : "POST";
    const url =
      operation === "lifecycle_activation"
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
    operation:
      | "lifecycle_activation"
      | "cabin_read"
      | "cabin_confirm"
      | "discovery_read"
      | "discovery_confirm"
      | "discovery_retry"
      | "discovery_cancel"
      | "discovery_picker"
      | "game_setup"
      | "game_launch"
      | "game_stop"
      | "game_resume"
      | "game_resume_cancel"
      | "game_reopen"
      | "game_disconnect"
      | "game_endgame"
      | "game_create" = "lifecycle_activation",
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
export async function canonicalTemporaryRoot(prefix: string): Promise<string> {
  const parent = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof parent !== "string" || parent.length === 0) throw new Error("test_local_app_data_unavailable");
  return await mkdtemp(join(await realpath(parent), prefix));
}
export async function createFixture(
  input: Readonly<{
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
    /**
     * Leaves the Host with no installation registration record at all - the fresh-root
     * shape a first-run player has. The default seeds a ready revision-1 record, which is
     * what every later test's activation depends on.
     */
    withoutSeededRegistration?: boolean;
    /**
     * A real bound game folder whose registration points at it, and whose contents this
     * test controls. It is the only way to exercise an operation that reads the folder the
     * registration names rather than a candidate the scan proposed.
     */
    boundInstallation?: Readonly<{ installRoot: string; smapi: boolean }>;
    /** Generation root whose `native/smapi/` payload the mod-loader install reads. */
    hostArtifactRoot?: string;
  }> = {},
) {
  const runtimeRoot = await canonicalTemporaryRoot("gamebuddy-lifecycle-coordinator-");
  const packageRoot = join(runtimeRoot, "package");
  temporaryRoots.push(runtimeRoot);
  if (input.boundInstallation !== undefined) {
    await publishStardewInstallationRegistration(runtimeRoot, null, {
      schema: "gamebuddy-stardew-installation-registration/v1",
      binding: { rootLayoutVersion: 1 },
      revision: 1,
      state: "ready",
      locator: input.boundInstallation.installRoot,
      activeAttempt: null,
    });
  } else if (input.withoutSeededRegistration !== true) {
    await publishStardewInstallationRegistration(runtimeRoot, null, {
      schema: "gamebuddy-stardew-installation-registration/v1",
      binding: { rootLayoutVersion: 1 },
      revision: 1,
      state: "ready",
      locator: gameDirectoryCandidate,
      activeAttempt: null,
    });
  }
  await mkdir(packageRoot);
  for (const entry of packageEntries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  const spawnCalls: Array<
    Readonly<{
      executable: string;
      args: readonly string[];
      options: Readonly<{
        cwd?: string;
        shell: boolean;
        windowsHide: boolean;
        env: Readonly<NodeJS.ProcessEnv>;
      }>;
    }>
  > = [];
  const aiKillCalls: number[] = [];
  const playerSpawnCalls: Array<
    Readonly<{
      executable: string;
      args: readonly string[];
      options: Readonly<{
        cwd?: string;
        shell: boolean;
        windowsHide: boolean;
        env: Readonly<NodeJS.ProcessEnv>;
      }>;
    }>
  > = [];
  const playerKillCalls: number[] = [];
  const lifecycleOrder: string[] = [];
  const playerKillResults = [...(input.playerKillResults ?? [true])];
  const gameRuntimeBindingCloseResults = [...(input.gameRuntimeBindingCloseResults ?? [true])];
  const bridgeConnectCalls: Array<
    Readonly<{
      scope: Readonly<Record<string, string>>;
      pipeName: string;
      token: string;
      launchGeneration: string;
      deadlineMs: number;
    }>
  > = [];
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
      return Object.freeze({
        pid: 4101,
        kill: () => {
          lifecycleOrder.push("ai");
          aiKillCalls.push(4101);
          return true;
        },
      });
    },
    rawProbe: (pid) => (input.aiProbeFailure ? null : { pid, creationDate: "20260101010101.000000+000" }),
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
    rawPlayerHostProbe: (pid) => (input.playerProbeFailure ? null : { pid, creationDate: "20260101010101.000000+000" }),
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
  const coordinator = createStardewProductionLifecycleCoordinatorForTesting(manifest, dependencies, {
    ...input.overrides,
    ...(input.hostArtifactRoot === undefined ? {} : { hostArtifactRoot: input.hostArtifactRoot }),
    createInstallationInspector: (async () => {
      freshRegistrationAdmissionCount += 1;
      return (
        input.overrides?.createInstallationInspector ??
        (async () =>
          installationInspector(
            input.inspectorChains ?? [
              installationChain,
              installationChain,
              installationChain,
              installationChain,
              installationChain,
              installationChain,
            ],
            input.inspectorGate === undefined ? undefined : () => input.inspectorGate!,
          ))
      )();
    }) as () => Promise<WindowsReparseInspectorCapability>,
    connectFarmhandGameRuntimeFacade:
      input.overrides?.connectFarmhandGameRuntimeFacade ??
      (async (connection, deadlineMs) => {
        bridgeConnectCalls.push(
          Object.freeze({
            scope: connection.scope,
            pipeName: connection.pipeName,
            token: connection.token,
            launchGeneration: connection.launchGeneration,
            deadlineMs,
          }),
        );
        return Object.freeze({
          authority: "SEMANTIC" as const,
          runEnter: async () => {
            gameRuntimeFacadeEnterCalls += 1;
            return connectedSemanticGameLeaseFixture({
              onAttachVoiceStopper: () => {
                gameRuntimeVoiceStopperAttachCalls += 1;
              },
              onActivate: () => {
                gameRuntimeIngressActivationCalls += 1;
                input.afterIngressActivation?.();
              },
              onStop: (stop) => {
                gameStopCalls.push(stop);
              },
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
  });
  const broker = await createAdmissionBroker(coordinator, input.discoveryBrowserHandlers);
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
export async function publishSignedPlayerHostSession(
  runtimeRoot: string,
  launchGeneration = "player-generation-1",
  cabins: readonly PublishedCabin[] = [],
  expiresAtUnixMs = Date.now() + 60_000,
): Promise<void> {
  const sessionDirectory = join(runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "session");
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
export /** Synchronous variant for the fixture `afterPlayerSpawn` hook, which is not awaited. */
function publishSignedPlayerHostSessionSync(
  runtimeRoot: string,
  launchGeneration = "player-generation-1",
  cabins: readonly PublishedCabin[] = [],
  expiresAtUnixMs = Date.now() + 60_000,
): void {
  const sessionDirectory = join(runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "session");
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
export function signAttachmentValue<T extends { signature: string }>(value: T): T {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signature;
  return {
    ...value,
    signature: createHmac("sha256", "session-secret-coordinator-012345")
      .update(JSON.stringify(unsigned), "utf8")
      .digest("base64url"),
  };
}
export async function waitForAttachmentRequest(runtimeRoot: string): Promise<Record<string, unknown>> {
  const path = join(
    runtimeRoot,
    "stardew-private-bootstrap",
    "bootstrap-coordinator-1",
    "session",
    "stardew-attachment-request.json",
  );
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
  throw new Error("wait_for_attachment_request_timeout");
}
export async function publishAttachmentAdmission(
  runtimeRoot: string,
  request: Record<string, unknown>,
  cabin: PublishedCabin,
): Promise<void> {
  const directory = join(runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "session");
  const requestId = request.requestId as string;
  const now = Date.now();
  await writeFile(
    join(directory, "stardew-attachment-response.json"),
    JSON.stringify(
      signAttachmentValue({
        schemaVersion: 1,
        requestId,
        state: "ready",
        reasonCode: "manifest_issued",
        updatedAtUnixMs: now,
        manifestPath: "stardew-farmhand-manifest.json",
        signature: "",
      }),
    ),
  );
  await writeFile(
    join(directory, "stardew-farmhand-manifest.json"),
    JSON.stringify(
      signAttachmentValue({
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
      }),
    ),
  );
}
export async function ownerRecord(runtimeRoot: string) {
  return JSON.parse(
    await readFile(join(runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "owner.json"), "utf8"),
  ) as { state: string; cleanupDisposition: string; managedPaths: string[] };
}
export /** The join request identity currently on disk, or null when none was issued yet. */
async function attachmentRequestId(runtimeRoot: string): Promise<string | null> {
  const path = join(
    runtimeRoot,
    "stardew-private-bootstrap",
    "bootstrap-coordinator-1",
    "session",
    "stardew-attachment-request.json",
  );
  try {
    const request = JSON.parse(await readFile(path, "utf8")) as { requestId?: unknown };
    return typeof request.requestId === "string" ? request.requestId : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export /**
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
export const availableCabins: readonly PublishedCabin[] = Object.freeze([
  Object.freeze({ cabinId: "cabin-alpha", ownerFarmhandId: "101", boundCompanionId: "", isBusy: false }),
  Object.freeze({ cabinId: "cabin-beta", ownerFarmhandId: "202", boundCompanionId: "companion-1", isBusy: false }),
  Object.freeze({ cabinId: "cabin-busy", ownerFarmhandId: "303", boundCompanionId: "", isBusy: true }),
  Object.freeze({
    cabinId: "cabin-foreign",
    ownerFarmhandId: "404",
    boundCompanionId: "other-companion",
    isBusy: false,
  }),
]);
export async function prepareCabinCoordinator(
  expiresAtUnixMs = Date.now() + 5 * 60_000,
  input: Parameters<typeof createFixture>[0] = {},
) {
  const fixture = await createFixture(input);
  await withWindowsPlatform(async () => {
    await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
    await publishSignedPlayerHostSession(fixture.runtimeRoot, "player-generation-1", availableCabins, expiresAtUnixMs);
    await fixture.coordinator.activationOwner
      .setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" })
      .then(() =>
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          expectedInstanceGeneration: 1,
        }),
      );
  });
  return fixture;
}
export async function confirmFirstCabin(fixture: Awaited<ReturnType<typeof prepareCabinCoordinator>>) {
  const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
  const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), {
    apiVersion: 1,
    choiceHandle: choices.choices[0]!.choiceHandle,
    idempotencyKey: "confirm-first-cabin-key",
    confirmed: true,
  });
  const request = await waitForAttachmentRequest(fixture.runtimeRoot);
  await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
  return confirmation;
}
export /**
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
    return (
      rows.find((binding) => binding.status === "registered") ??
      [...rows].sort((left, right) => (left.gameSessionId < right.gameSessionId ? -1 : 1))[0]
    );
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
      if (
        row === undefined ||
        byRequest.get(input.creationRequestId)?.metadata.gameSessionId !== input.gameSessionId ||
        row.revision !== input.expectedRevision
      )
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
      if (
        row === undefined ||
        byRequest.get(input.creationRequestId)?.metadata.gameSessionId !== input.gameSessionId ||
        row.revision !== input.expectedRevision
      )
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
      if (
        binding.integrationId !== input.integrationId ||
        operationBySession.get(input.gameSessionId) !== input.operationId
      )
        throw new Error("game_session_world_binding_conflict");
      // Terminal is sticky in the store: the same settle reads the terminal row
      // back instead of writing again.
      if (binding.status === "terminal") {
        if (input.expectedRevision !== 1) throw new Error("game_session_world_binding_conflict");
        return binding;
      }
      if (binding.revision !== input.expectedRevision) throw new Error("game_session_world_binding_conflict");
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
      const terminal: ProductionGameSessionWorldBinding = Object.freeze({
        ...binding,
        status: "terminal",
        revision: binding.revision + 1,
      });
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
        input.proof === null ||
        typeof input.proof !== "object" ||
        input.proof.holderHandle !== input.holderHandle ||
        input.proof.verdict === null ||
        typeof input.proof.verdict !== "object"
      )
        throw new Error(productionGameSessionWorldBindingSlotRelease.proofInvalid);
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
        !(
          (metadata.status === "pending" && metadata.revision === 1) ||
          (metadata.status === "resumable" && metadata.revision === 2)
        )
      )
        throw new Error("game_session_world_binding_conflict");
      // The one canonical terminal pair the store lands a released slot on, in
      // its own single transaction: terminal binding rev2 + failed metadata rev3.
      const terminal: ProductionGameSessionWorldBinding = Object.freeze({
        ...row,
        status: "terminal",
        revision: row.revision + 1,
      });
      bindings.set(row.gameSessionId, terminal);
      bySession.set(row.gameSessionId, Object.freeze({ ...metadata, status: "failed", revision: 3 }));
      return terminal;
    },
  };
  return Object.freeze({
    authority,
    readMetadata: (gameSessionId: string): ProductionGameSessionMetadata | null => bySession.get(gameSessionId) ?? null,
    readBinding: (gameSessionId: string): ProductionGameSessionWorldBinding | null =>
      bindings.get(gameSessionId) ?? null,
    listResumable: (): readonly ProductionGameSessionMetadata[] =>
      Object.freeze(
        [...bySession.values()].filter(
          (row) => row.status === "resumable" && bindings.get(row.gameSessionId)?.status === "registered",
        ),
      ),
    inputs: (): readonly unknown[] => Object.freeze([...inputs]),
    sessions: (): readonly ProductionGameSessionMetadata[] => Object.freeze([...bySession.values()]),
    /** Slot reads are observations, not durable steps, so they stay out of `inputs`. */
    slotReads: (): readonly unknown[] => Object.freeze([...slotReads]),
    slotReleases: (): readonly unknown[] => Object.freeze([...slotReleases]),
  });
}
export async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error("wait_for_condition_timeout");
}
export /**
 * The attachment epoch is the controller's identity: every mutating command names
 * the generation it was issued against, and the coordinator answers it against the
 * generation that is live now. This returns the refusal's own name, so a test can
 * assert WHICH identity a stale controller was refused by instead of only that
 * "something" rejected it.
 */
async function staleEpochRefusal(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "accepted";
}
export /**
 * A command key that `game_browser_api/v1` accepts: exactly 22 canonical base64url
 * characters. A key that is not canonical is refused by the command schema before any
 * seam runs, so a boundary test holding one would be reading the validator instead of
 * the lifecycle.
 */
function wireIdempotencyKey(prefix: string): string {
  return `${prefix}${"A".repeat(22 - prefix.length)}`;
}
export /**
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
function scriptedRecoveryTeardown(
  outcome: "recovered" | "ai_settled_player_preserved" | "gate_held" | "unavailable" | "never",
) {
  const events: string[] = [];
  const requests: StardewOwnerRecoveryRequest[] = [];
  const recoveryBindings: unknown[] = [];
  const teardown: StardewContainedRuntimeTeardown = Object.freeze({
    containPlayerHost: async () => {
      events.push("containPlayerHost");
    },
    containAiClient: async () => {
      events.push("containAiClient");
    },
    settle: async () => {
      events.push("settle");
    },
    recover: async (_owner, request) => {
      events.push("recover");
      if (outcome === "never") throw new Error("recovery_must_not_run");
      requests.push(request);
      recoveryBindings.push(await request.readRecoveryBinding());
      if (outcome === "recovered") return Object.freeze({ status: "recovered" as const });
      if (outcome === "ai_settled_player_preserved")
        return Object.freeze({ status: "ai_settled_player_preserved" as const });
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
    close: async () => {
      events.push("close");
    },
  });
  return Object.freeze({ teardown, events, requests, recoveryBindings });
}
export /**
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
  const live = JSON.parse(
    await readFile(join(runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "owner.json"), "utf8"),
  ) as Record<string, unknown>;
  const record: Record<string, unknown> = { ...live, ...patch, bootstrapId };
  const directory = join(runtimeRoot, "stardew-private-bootstrap", bootstrapId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "owner.json"), JSON.stringify(record));
  return record;
}
export /**
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
export /**
 * Explicit-endgame lifecycle setup for the close/create interaction tests below:
 * activate, launch and attest the Player Host, bind the semantic attachment
 * through the cabin confirmation, then drive the successful explicit endgame.
 * The endgame terminates the world but leaves `activationState` at
 * `awaiting_player_host_attestation` and the exact owner in place, which is why
 * a create is still admissible afterwards.
 */
async function startEndgameLifecycle(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
  await publishSignedPlayerHostSession(
    fixture.runtimeRoot,
    "player-generation-1",
    availableCabins,
    Date.now() + 5 * 60_000,
  );
  await fixture.coordinator.activationOwner
    .setupPlayerHost(fixture.broker.issue("game_setup"), { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" })
    .then(() =>
      fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        expectedInstanceGeneration: 1,
      }),
    );
  await confirmFirstCabin(fixture);
  assert.deepEqual(
    await fixture.coordinator.activationOwner.endgameGame(fixture.broker.issue("game_endgame"), {
      apiVersion: 1,
      idempotencyKey: "endgame-key-1",
      expectedAttachmentGeneration: 1,
      confirm: true,
    }),
    { apiVersion: 1, status: "gameended" },
  );
}
export function containedGuardianSessionRecorder(sessionCalls: string[]): DesktopGuardianSession {
  return Object.freeze({
    async arm() {
      sessionCalls.push("arm");
      return containedSessionAck("arm_attempt");
    },
    async launch(input) {
      sessionCalls.push("launch");
      return containedSessionAck("launch_role", input.role);
    },
    async contain(input) {
      sessionCalls.push("contain");
      return containedSessionAck("contain_role", input.role);
    },
    // These launches never drive a recovery, but the session contract carries
    // it and an honest literal fake answers it explicitly.
    async recover() {
      sessionCalls.push("recover");
      return Object.freeze({ outcome: "contained" as const });
    },
    async close() {
      sessionCalls.push("close");
    },
  });
}

/** Installs the per-file hooks every group depends on: lock reclaimer, temporary roots. */
export function installLifecycleTestHooks(): void {
  test.beforeEach(() => bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedLockHelper)));

  test.after(() => bindWindowsStaleLockReclaimer(undefined));

  test.after(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
