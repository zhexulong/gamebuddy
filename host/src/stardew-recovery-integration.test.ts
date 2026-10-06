/**
 * Cross-layer integration: the leftover a crashed `game.create` leaves behind
 * meets the real coordinator recovery logic.
 *
 * WHAT THIS FILE IS FOR
 *
 * Every link of the chain was landed and individually proven against a stand-in:
 * the world-slot release against the real store with a synthetic verdict, the
 * recovery credential/cleanup inside the composer, the create-side trigger
 * against a fake creation authority and a scripted recovery teardown. This file
 * is the first place where a REAL leftover (real store rows written through the
 * real store's own create/register APIs, a real composer `owner.json`, a real
 * registration pointer bound by the real activation) is fed to the real
 * coordinator/composer recovery logic, and where the durable state afterwards is
 * read back out of the real store.
 *
 * WHAT IT COVERS
 *
 * - The leftover is produced by a real `game.create` running over a real
 *   activation/launch, whose own completion + settle steps were unavailable
 *   ("the settle closure could not be applied"): every durable row is written by
 *   the real store, and the attempt record / registration pointer are the real
 *   ones the real composition persisted. Nothing is inserted or hand-written.
 * - The recovery, the finalization and the registration release are the real
 *   production components: `openRecoverableStardewBootstrapOwner`,
 *   `driveStardewOwnedPlayerHostRecovery`, the composed recovery drive
 *   (`createStardewPlayerHostRuntimeLaunchCollaboratorFactory` +
 *   `containedRuntimeTeardownFromCollaborator`), the real durable v4 CAS engine,
 *   `mintGameSessionWorldBindingSlotLeaseVerdict` and the real store's release.
 *   The store's slot release is NOT a create-side step any more - the ruling makes
 *   the world slot the player's to keep - so the tests here present it themselves,
 *   exactly as an explicit product operation would have to.
 * - Every terminal of the create-side trigger is driven and read back: a held
 *   native gate, the broker's AI-side terminal, and a recovery that reached
 *   containment over an already-settled slot. Their shared consequence is recorded
 *   too: the trigger never releases the world slot, so a create over a leftover
 *   never registers on it, and it is refused under its own bounded code.
 *
 * WHAT IT DOES NOT COVER (and must not be read as covered)
 *
 * - The real native gate / lease probe and the real Desktop Guardian half: the
 *   `DesktopGuardianSession` here is a deterministic stand-in for the Desktop
 *   supervisor. The native `held`/`contained` answer and the recovery token never
 *   come from a real named mutex probe, and no `windows-named-mutex-broker` mutex
 *   ownership is established by this file. The one place a store lease verdict is
 *   minted in this file is marked, and no real probe ran for it.
 * - Any live run: no real Stardew process, no real SMAPI, no real save slot, no
 *   real Player Host, no real broker relay, no real bridge. The `spawn`/`probe`
 *   seams and the game-runtime facade are the coordinator suite's deterministic
 *   stand-ins.
 * - The window between the crashed process and the next lifecycle is simulated by
 *   an unavailable completion/settle closure and by abandoning the crashed
 *   lifecycle outright (no close at all - an ordinary coordinator close
 *   quarantines the exact owner, which is exactly the state a crash does NOT
 *   leave), not by killing a process.
 * - The placement of the recovery drive: this file proves the durable chain and
 *   both create-side failure paths, and it asserts per test where the landed
 *   create-side trigger can and cannot reach its own `game.create`. Repairing
 *   that placement is a production change this file does not make and does not
 *   cover.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

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
import { createStardewProductionLifecycleCoordinatorForTesting } from "./stardew-production-lifecycle-coordinator.test-support-internal.js";
import {
  containedRuntimeTeardownFromCollaborator,
  driveStardewOwnedPlayerHostRecovery,
  STARDEW_GAME_CREATE_SLOT_HOLDER_NOT_PROVEN_GONE,
  STARDEW_GAME_CREATE_WORLD_HELD_BY_PLAYER_RESUME_REQUIRED,
  type StardewGameSessionCreationAuthority,
  type StardewProductionLifecycleCoordinator,
} from "./stardew-production-lifecycle-coordinator.internal.js";
import {
  mintGameSessionWorldBindingSlotLeaseVerdict,
  openProductionContinuityStore,
  productionGameSessionWorldBindingSlotLeaseVerdict,
  productionGameSessionWorldBindingSlotRelease,
  type ProductionBootstrapInput,
  type ProductionGameSessionMetadata,
  type ProductionGameSessionWorldBinding,
  type ProductionGameSessionWorldBindingSlotHolder,
} from "./continuity-semantic-store/continuity-semantic-production-store.js";
import {
  openRecoverableStardewBootstrapOwner,
  readRecoverableStardewBootstrapOwnerRecoveryBinding,
} from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.core.js";
import type { StardewPrivateBootstrapCoreDependencies } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.test-support-internal.js";
import { simulatedLockHelper } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.test-fixtures.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";
import { createTestWindowsReparseInspector } from "./windows-reparse-inspector/index.test-support.js";
import type { WindowsPathObjectIdentity } from "./windows-reparse-inspector/index.js";
import type { DesktopGuardianSession, GuardianAck } from "./containment/auth/desktop-guardian-session.internal.js";
import {
  createDesktopGuardianGameRuntimePlatform,
  createStardewPlayerHostRuntimeLaunchCollaboratorFactory,
  type StardewOwnerRecoveryRequest,
} from "./composition/stardew/stardew-guardian-platform.js";

/**
 * The coordinator suite's deterministic stale-lock helper: the real path-lock
 * code shells out to PowerShell, and a test-run reclaimer keeps that out of
 * process without weakening the lock's own checks.
 */
test.beforeEach(() => bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedLockHelper)));
test.after(() => bindWindowsStaleLockReclaimer(undefined));

const temporaryRoots: string[] = [];
test.after(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ─── browser admissions (the coordinator suite's broker, trimmed to the
// operations this file drives) ──────────────────────────────────────────────

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
const sessionSecret = "session-secret-integration-0123456";
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
type IntegrationBrowserOperation = "lifecycle_activation" | "game_setup" | "game_launch" | "game_create";

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

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** The authenticated browser admissions this file's commands are admitted through. */
async function createAdmissionBroker() {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithDiscovery }),
    bootstrapToken,
    async readChat(context) { return stateForChat(context); },
    async readGame(context) { return stateForGame(context); },
    gameDiscovery: {
      read: async () => ({ apiVersion: 1, candidates: [], diagnostics: [] }),
      confirm: async () => ({ apiVersion: 1, status: "registered" }),
      retry: async () => ({ apiVersion: 1, candidates: [], diagnostics: [] }),
      cancel: async () => ({ apiVersion: 1, status: "cancelled" }),
      manualPicker: async () => ({ apiVersion: 1, status: "cancelled" }),
    },
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
  const request = (operation: IntegrationBrowserOperation): IncomingMessage => {
    const originUrl = new URL(origin);
    const url = operation === "lifecycle_activation"
      ? "/api/composed-reference-game/v1/lifecycle/activate"
      : operation === "game_setup"
        ? "/api/composed-reference-game/v1/game/prerequisites/setup"
        : operation === "game_launch"
          ? "/api/composed-reference-game/v1/game/launch"
          : "/api/composed-reference-game/v1/game/create";
    return {
      method: "POST",
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
    operation: IntegrationBrowserOperation = "lifecycle_activation",
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
type IntegrationBroker = Awaited<ReturnType<typeof createAdmissionBroker>>;

// ─── installation admission / signed Player Host session / cabin admission ───

function withWindowsPlatform<T>(operation: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  return operation().finally(() => { Object.defineProperty(process, "platform", descriptor); });
}

function installationInspector() {
  let index = 0;
  return createTestWindowsReparseInspector(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    });
    child.stdin.on("data", () => void (async () => {
      const chain = installationChain;
      index += 1;
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

function containedSessionAck(bootstrapId: string, operation: string, role?: string): GuardianAck {
  return Object.freeze({
    operation,
    status: "ok",
    bootstrapId,
    generation: "generation-1",
    inventoryDigest: "inventory-1",
    runtimeAdmissionSha256: "admission-1",
    guardianInstanceId: "guardian-instance-1",
    guardianEpoch: 1,
    attemptId: bootstrapId,
    ...(role === undefined ? {} : { role }),
  });
}

type PublishedCabin = Readonly<{
  cabinId: string;
  ownerFarmhandId: string;
  boundCompanionId: string;
  isBusy: boolean;
}>;

const availableCabins: readonly PublishedCabin[] = Object.freeze([
  Object.freeze({ cabinId: "cabin-alpha", ownerFarmhandId: "101", boundCompanionId: "", isBusy: false }),
]);

function signAttachmentValue<T extends { signature: string }>(value: T): T {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signature;
  return {
    ...value,
    signature: createHmac("sha256", sessionSecret).update(JSON.stringify(unsigned), "utf8").digest("base64url"),
  };
}

/** The signed Player Host session advertisement the exact owner must read back. */
async function publishSignedPlayerHostSession(
  runtimeRoot: string,
  bootstrapId: string,
  expiresAtUnixMs: number,
): Promise<void> {
  const sessionDirectory = join(runtimeRoot, "stardew-private-bootstrap", bootstrapId, "session");
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
    saveId: "save-integration",
    worldId: "world-integration",
    publishedAtUnixMs: Date.now(),
    expiresAtUnixMs,
    nonce: "nonce-integration",
    state: "ready",
    hostPlayerId: "player-1",
    runtimeRole: "player_host",
    launchGeneration: "player-generation-1",
    cabins: availableCabins,
    signature: "",
  };
  const unsigned = { ...session };
  delete (unsigned as Partial<typeof session>).signature;
  const signature = createHmac("sha256", sessionSecret).update(JSON.stringify(unsigned), "utf8").digest("base64url");
  await writeFile(join(sessionDirectory, "stardew-session.json"), JSON.stringify({ ...session, signature }));
}

function attachmentRequestPath(runtimeRoot: string, bootstrapId: string): string {
  return join(runtimeRoot, "stardew-private-bootstrap", bootstrapId, "session", "stardew-attachment-request.json");
}

async function attachmentRequestId(runtimeRoot: string, bootstrapId: string): Promise<string | null> {
  try {
    const request = JSON.parse(await readFile(attachmentRequestPath(runtimeRoot, bootstrapId), "utf8")) as { requestId?: unknown };
    return typeof request.requestId === "string" ? request.requestId : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function publishAttachmentAdmission(
  runtimeRoot: string,
  bootstrapId: string,
  request: Record<string, unknown>,
  cabin: PublishedCabin,
): Promise<void> {
  const directory = join(runtimeRoot, "stardew-private-bootstrap", bootstrapId, "session");
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
    saveId: "save-integration",
    worldId: "world-integration",
    companionId: "companion-1",
    farmhandId: cabin.ownerFarmhandId,
    cabinId: cabin.cabinId,
    sessionNonce: "nonce-integration",
    issuedAtUnixMs: now,
    expiresAtUnixMs: now + 30_000,
    signature: "",
  })));
}

/**
 * Publishes the manifest for the NEXT attachment request. Every admitted handoff
 * (including each create's own manifest re-admission) mints a fresh request
 * identity, and a manifest is bound to exactly the request it was issued for.
 */
async function publishNextAttachmentAdmission(
  runtimeRoot: string,
  bootstrapId: string,
  previousRequestId: string | null,
  cabin: PublishedCabin,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await attachmentRequestId(runtimeRoot, bootstrapId);
    if (current !== null && current !== previousRequestId) {
      await publishAttachmentAdmission(runtimeRoot, bootstrapId, { requestId: current }, cabin);
      return;
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error("publish_next_attachment_admission_timeout");
}

// ─── the real store these rows come from ────────────────────────────────────

type BoundRealStore = ReturnType<ReturnType<typeof openProductionContinuityStore>["bindBootstrapContext"]>;

const principal = { continuityId: "continuity-1", companionId: "companion-1", playerId: "player-1" } as const;
const bootstrapInput: ProductionBootstrapInput = {
  principal,
  bootstrapOperationId: "integration-bootstrap-1",
  authorityGeneration: 1,
  authorityRootIdentity: "a".repeat(64),
};

/** A fresh production store under this test's runtime root, bound to one bootstrap context. */
function openRealCreationAuthority(runtimeRoot: string): Readonly<{
  control: ReturnType<typeof openProductionContinuityStore>;
  store: BoundRealStore;
}> {
  const control = openProductionContinuityStore({ runtimeRoot });
  const metadata = control.bootstrapFresh(bootstrapInput);
  const store = control.bindBootstrapContext({ bootstrap: bootstrapInput, metadata });
  return { control, store };
}

/**
 * The runtime root every fixture in one test shares: the installation
 * registration the lifecycle reads, and the staged package it installs from.
 */
async function prepareIntegrationRoot(): Promise<string> {
  const parent = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof parent !== "string" || parent.length === 0) throw new Error("test_local_app_data_unavailable");
  const runtimeRoot = await mkdtemp(join(await realpath(parent), "gamebuddy-recovery-integration-"));
  temporaryRoots.push(runtimeRoot);
  await publishStardewInstallationRegistration(runtimeRoot, null, {
    schema: "gamebuddy-stardew-installation-registration/v1",
    binding: { rootLayoutVersion: 1 },
    revision: 1,
    state: "ready",
    locator: gameDirectoryCandidate,
    activeAttempt: null,
  });
  const packageRoot = join(runtimeRoot, "package");
  await mkdir(packageRoot);
  for (const entry of packageEntries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  return runtimeRoot;
}

/**
 * The crashing-command profile of the create's own completion. Every durable
 * write still goes to the real store through the real store's own APIs: this
 * wrapper only models the two live-command steps a create that dies between
 * `register` and `complete` can no longer perform for itself, and it records
 * every member call so a test can observe which durable steps a command took.
 *
 * `unappliableSettleClosure` is the crash: the create registers its world
 * binding (a real row), and then neither its completion nor its own failure
 * closure can be applied - which is exactly the `pending rev1 + registered rev1`
 * and non-terminal attempt record a crashed create leaves behind.
 */
function recordingCreationAuthority(
  store: BoundRealStore,
  crashPolicy: { unappliableSettleClosure: boolean },
) {
  type RecordedCall = { member: string; input: unknown; result?: unknown; error?: string };
  const calls: RecordedCall[] = [];
  const record = <T>(member: string, input: unknown, work: () => Promise<T> | T): Promise<T> => {
    const entry: RecordedCall = { member, input };
    calls.push(entry);
    return Promise.resolve().then(work).then(
      (value) => { entry.result = value; return value; },
      (error: unknown) => {
        entry.error = error instanceof Error ? error.message : String(error);
        throw error;
      },
    );
  };
  const authority: StardewGameSessionCreationAuthority = Object.freeze({
    createGameSessionMetadata: (input) => record("createGameSessionMetadata", input, () => store.createGameSessionMetadata(input)),
    registerGameSessionWorldBinding: (input) => record("registerGameSessionWorldBinding", input, () => store.registerGameSessionWorldBinding(input)),
    completeGameSessionBinding: (input) => record("completeGameSessionBinding", input, () => {
      if (crashPolicy.unappliableSettleClosure) throw new Error("controlled_create_completion_unavailable");
      return store.completeGameSessionBinding(input);
    }),
    failGameSessionCreation: (input) => record("failGameSessionCreation", input, () => store.failGameSessionCreation(input)),
    markGameSessionWorldBindingTerminal: (input) => record("markGameSessionWorldBindingTerminal", input, () => {
      if (crashPolicy.unappliableSettleClosure) throw new Error("controlled_create_settle_closure_unavailable");
      return store.markGameSessionWorldBindingTerminal(input);
    }),
    readGameSessionWorldBindingSlotHolder: async (input) => await store.readGameSessionWorldBindingSlotHolder(input),
    releaseGameSessionWorldBindingSlot: (input) => record("releaseGameSessionWorldBindingSlot", input, () => store.releaseGameSessionWorldBindingSlot(input)),
  });
  return Object.freeze({
    authority,
    members: (): readonly string[] => Object.freeze(calls.map((call) => call.member)),
    inputsOf: (member: string): readonly unknown[] =>
      Object.freeze(calls.filter((call) => call.member === member).map((call) => call.input)),
    errorsOf: (member: string): readonly (string | undefined)[] =>
      Object.freeze(calls.filter((call) => call.member === member).map((call) => call.error)),
    resultsOf: (member: string): readonly unknown[] =>
      Object.freeze(calls.filter((call) => call.member === member).map((call) => call.result)),
  });
}

// ─── the coordinator fixture ────────────────────────────────────────────────

function connectedSemanticGameLeaseFixture(onIngressActivated?: () => void) {
  return Object.freeze({
    piSessionId: "pi-session-integration",
    gameSessionId: "game-session-integration",
    host: Object.freeze({
      attachVoiceStopper() {},
      stopAll() {
        return Object.freeze({
          admission: Object.freeze({}) as never,
          outcome: "no_active_turn" as const,
          settled: Promise.resolve(),
        });
      },
    }) as never,
    lifecycleSnapshot: () => Object.freeze({}) as never,
    activateCommittedIngress: () => onIngressActivated?.(),
    dispatchPromptDefinedTask: async () => undefined,
    cancelPromptDefinedTask: () => undefined,
  }) as never;
}

/**
 * The scripted Desktop stand-in. `arm`/`launch`/`contain` acknowledge the exact
 * correlation they were handed; `recover` answers the one native position this
 * file needs, and - for both durable answers - drives the REAL durable steps the
 * platform conversation drives (`beginRecovery` while the gate is held, and then
 * either one containment CAS per role for `contained`, or none at all for the
 * broker's player-role early return, `ai_settled_player_preserved`). It is NOT a
 * named-mutex probe and establishes no mutex ownership: see this file's header.
 */
function createScriptedGuardianSession(input: Readonly<{
  bootstrapId: string;
  recoveryAnswer: "contained" | "ai_settled_player_preserved" | "gate_held";
  steps: { hook?: () => Promise<void> };
  operations: string[];
}>): DesktopGuardianSession {
  return Object.freeze({
    async arm() {
      input.operations.push("arm");
      return containedSessionAck(input.bootstrapId, "arm_attempt");
    },
    async launch(launch) {
      input.operations.push(`launch:${launch.role}`);
      return containedSessionAck(input.bootstrapId, "launch_role", launch.role);
    },
    async contain(contain) {
      input.operations.push(`contain:${contain.role}`);
      return containedSessionAck(input.bootstrapId, "contain_role", contain.role);
    },
    async recover(recovery) {
      input.operations.push(`recover:${recovery.recoveryInstanceId}`);
      await input.steps.hook?.();
      if (input.recoveryAnswer === "gate_held") return Object.freeze({ outcome: "gate_held" as const });
      await recovery.beginRecovery();
      if (input.recoveryAnswer === "ai_settled_player_preserved") {
        // The broker's player-role early return: the gate opened and the durable
        // `recovering` CAS ran, but the native never adopts the player's world, so
        // NO role is recorded contained and the conversation stops at the player
        // position. The AI side is settled and cleaned up by the broker itself.
        return Object.freeze({ outcome: "role_classified" as const, role: "playerHost" as const, classification: "unavailable" as const });
      }
      await recovery.roleContained("playerHost");
      await recovery.roleContained("aiClient");
      return Object.freeze({ outcome: "contained" as const });
    },
    async close() {
      input.operations.push("close");
    },
  });
}

type IntegrationFixture = Readonly<{
  runtimeRoot: string;
  bootstrapId: string;
  slotRef: string;
  coordinator: StardewProductionLifecycleCoordinator;
  broker: IntegrationBroker;
  store: BoundRealStore;
  crashPolicy: { unappliableSettleClosure: boolean };
  authorityMembers: () => readonly string[];
  authorityInputsOf: (member: string) => readonly unknown[];
  authorityErrorsOf: (member: string) => readonly (string | undefined)[];
  authorityResultsOf: (member: string) => readonly unknown[];
  /** The exact owner-held recovery half of the SAME collaborator the launches use. */
  recoveryTeardown: ReturnType<typeof containedRuntimeTeardownFromCollaborator>;
  sessionOperations: () => readonly string[];
  setRecoveryHook: (hook: () => Promise<void>) => void;
  close: () => Promise<void>;
}>;

/**
 * One coordinator lifecycle over a shared runtime root. The creation authority
 * is the REAL store (through the crash-observing wrapper above), the world
 * creation seam is a fixed physical slot ref (the seam's own observed slot in
 * production), and both role launches plus the recovery drive go through the
 * REAL composition collaborator over the scripted Desktop stand-in.
 */
async function createIntegrationFixture(input: Readonly<{
  runtimeRoot: string;
  bootstrapId: string;
  slotRef: string;
  store: BoundRealStore;
  crashPolicy: { unappliableSettleClosure: boolean };
  recoveryAnswer: "contained" | "ai_settled_player_preserved" | "gate_held";
}>): Promise<IntegrationFixture> {
  const { runtimeRoot, bootstrapId } = input;
  const stagingRoot = join(runtimeRoot, "package");
  const packageReadEntries = packageEntries;
  // The native recovery frame body requires an opaque GUID for the binding
  // revision (the lease name has its own `Local\` + leaf shape below), so the
  // fixture mints real GUIDs exactly like the production composition does.
  const guardianRevision = randomUUID();
  const dependencies: StardewPrivateBootstrapCoreDependencies = {
    rawSpawn: () => Object.freeze({ pid: 4101, kill: () => true }),
    rawProbe: (pid) => ({ pid, creationDate: "20260101010101.000000+000" }),
    rawPlayerHostSpawn: () => Object.freeze({ pid: 4102, kill: () => true }),
    rawPlayerHostProbe: (pid) => ({ pid, creationDate: "20260101010101.000000+000" }),
    createBootstrapIdentity: () => bootstrapId,
    createGuardianRevision: () => guardianRevision,
    createGuardianInstanceId: () => "guardian-instance-1",
    createGuardianEpoch: () => 1,
    createGuardianLeaseName: () => `Local\\GameBuddy-${bootstrapId}-Lease`,
    createGuardianPlayerJobName: () => `Local\\GameBuddy-${bootstrapId}-Player`,
    createGuardianAiJobName: () => `Local\\GameBuddy-${bootstrapId}-Ai`,
    createLaunchGeneration: () => "ai-generation-1",
    createPlayerHostLaunchGeneration: () => "player-generation-1",
    createBridgePipeName: () => "gamebuddy-stardew-integration-bridge",
    createBridgeToken: () => "integration-bridge-token-0123456789",
    nowMs: () => Date.now(),
    staging: {
      readPackage: async () => ({ root: stagingRoot, entries: packageReadEntries }),
      createSecret: () => sessionSecret,
      nowMs: () => Date.now(),
    },
  };
  const manifest: HostDeploymentManifest = Object.freeze({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot,
    principal: Object.freeze({ ...principal }),
    bootstrapOperationId: "integration-bootstrap-1",
    authorityGeneration: 1,
  });
  const sessionOperations: string[] = [];
  const steps: { hook?: () => Promise<void> } = {};
  const session = createScriptedGuardianSession({
    bootstrapId,
    recoveryAnswer: input.recoveryAnswer,
    steps,
    operations: sessionOperations,
  });
  const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
    createDesktopGuardianGameRuntimePlatform(session),
  );
  const creation = recordingCreationAuthority(input.store, input.crashPolicy);
  const coordinator = createStardewProductionLifecycleCoordinatorForTesting(manifest, dependencies, {
    gameSessionCreationAuthority: creation.authority,
    createWorldBinding: async () => Object.freeze({ bindingRef: input.slotRef }),
    runtimeLaunchContained: collaborator,
    createInstallationInspector: async () => installationInspector(),
    connectFarmhandGameRuntimeFacade: async () => Object.freeze({
      authority: "SEMANTIC" as const,
      runEnter: async () => connectedSemanticGameLeaseFixture(),
      recoverDeadOwner: async () => undefined,
      close: async () => undefined,
    }),
  });
  const broker = await createAdmissionBroker();
  coordinator.activationOwner.bindBrowserAdmissionIssuer(broker.handler.lifecycleActivationIssuer);
  return Object.freeze({
    runtimeRoot,
    bootstrapId,
    slotRef: input.slotRef,
    coordinator,
    broker,
    store: input.store,
    crashPolicy: input.crashPolicy,
    authorityMembers: creation.members,
    authorityInputsOf: creation.inputsOf,
    authorityErrorsOf: creation.errorsOf,
    authorityResultsOf: creation.resultsOf,
    recoveryTeardown: containedRuntimeTeardownFromCollaborator(collaborator),
    sessionOperations: () => Object.freeze([...sessionOperations]),
    setRecoveryHook: (hook: () => Promise<void>) => { steps.hook = hook; },
    close: async () => {
      await coordinator.close();
      await broker.close();
    },
  });
}

// ─── driving one lifecycle ──────────────────────────────────────────────────

/** Activation, staged setup and the Player Host launch - the create's preconditions. */
async function prepareLaunchedPlayerHost(fixture: IntegrationFixture): Promise<void> {
  await withWindowsPlatform(async () => {
    await fixture.coordinator.activationOwner.activate(fixture.broker.issue("lifecycle_activation"));
    await publishSignedPlayerHostSession(fixture.runtimeRoot, fixture.bootstrapId, Date.now() + 5 * 60_000);
    await fixture.coordinator.activationOwner.setupPlayerHost(
      fixture.broker.issue("game_setup"),
      { apiVersion: 1, idempotencyKey: "integration-setup-key-1" },
    );
    await fixture.coordinator.activationOwner.launchPlayerHost(
      fixture.broker.issue("game_launch"),
      { apiVersion: 1, idempotencyKey: "integration-launch-key-1", expectedInstanceGeneration: 1 },
    );
  });
}

type CreateCommandOutcome =
  | Readonly<{ kind: "result"; result: unknown }>
  | Readonly<{ kind: "refusal"; message: string }>;

/**
 * Drives one admitted `game.create` and publishes the manifest handoff its own
 * re-admission waits for. The result is never swallowed: both terminal shapes
 * (`unavailable` and the bounded refusal) come back to the caller.
 */
async function driveAdmittedCreate(
  fixture: IntegrationFixture,
  idempotencyKey: string,
): Promise<CreateCommandOutcome> {
  const previousRequestId = await attachmentRequestId(fixture.runtimeRoot, fixture.bootstrapId);
  let refusal: string | null = null;
  const creating = fixture.coordinator.activationOwner.createGameSession(
    fixture.broker.issue("game_create"),
    { apiVersion: 1, idempotencyKey, integrationId: "stardew", continuityIdentityId: null },
  ).catch((error: unknown) => {
    refusal = error instanceof Error ? error.message : String(error);
    return undefined;
  });
  await publishNextAttachmentAdmission(fixture.runtimeRoot, fixture.bootstrapId, previousRequestId, availableCabins[0]!);
  const result = await creating;
  return refusal === null
    ? Object.freeze({ kind: "result" as const, result })
    : Object.freeze({ kind: "refusal" as const, message: refusal });
}

function ownerRecordPath(runtimeRoot: string, bootstrapId: string): string {
  return join(runtimeRoot, "stardew-private-bootstrap", bootstrapId, "owner.json");
}

async function readOwnerRecord(
  runtimeRoot: string,
  bootstrapId: string,
): Promise<Readonly<{
  bootstrapId: string;
  state: string;
  guardianState: string;
  playerHostState: string;
  aiClientState: string;
  cleanupDisposition: string;
  ownerRecordRevision: number;
  recoveryInstanceId: string | null;
}> | null> {
  try {
    return JSON.parse(await readFile(ownerRecordPath(runtimeRoot, bootstrapId), "utf8")) as never;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function slotReleaseProof(holderHandle: string, verdict: "holder_gone" | "lease_not_proven_free") {
  return Object.freeze({
    // The store's own mint is the only thing that can produce a usable verdict
    // token. No named-mutex probe ran for this literal: the native lease check
    // has no production producer yet, and this file must not pretend one ran.
    verdict: mintGameSessionWorldBindingSlotLeaseVerdict(verdict),
    holderHandle,
  });
}

type LiveLeftover = Readonly<{
  holder: ProductionGameSessionWorldBindingSlotHolder;
  metadata: ProductionGameSessionMetadata | null;
  binding: ProductionGameSessionWorldBinding | null;
}>;

/** The slot's own holder readback, plus the two rows that holder owns. */
async function readSlotLeftover(fixture: IntegrationFixture): Promise<LiveLeftover | null> {
  const holder = await fixture.store.readGameSessionWorldBindingSlotHolder({
    integrationId: "stardew",
    bindingRef: fixture.slotRef,
  });
  if (holder === null) return null;
  return Object.freeze({
    holder,
    metadata: await fixture.store.readGameSessionMetadata({ gameSessionId: holder.gameSessionId }),
    binding: await fixture.store.readGameSessionWorldBinding({
      gameSessionId: holder.gameSessionId,
      integrationId: "stardew",
    }),
  });
}

/**
 * A crashed `game.create`: the real store mints the session, the real
 * coordinator registers the world binding on the slot, and the create's own
 * completion and settle closure are unavailable - the attempt is abandoned with
 * both of its residues in place. Returns the refusal it ends on.
 */
async function crashCreate(fixture: IntegrationFixture, idempotencyKey: string): Promise<string> {
  fixture.crashPolicy.unappliableSettleClosure = true;
  const outcome = await driveAdmittedCreate(fixture, idempotencyKey);
  fixture.crashPolicy.unappliableSettleClosure = false;
  assert.equal(outcome.kind, "refusal");
  assert.match((outcome as Readonly<{ message: string }>).message, /stardew_game_create_failed/);
  return (outcome as Readonly<{ message: string }>).message;
}

/** The crashed attempt's own durable record facts, read off disk. */
async function readCrashedAttemptRecord(fixture: IntegrationFixture) {
  const record = await readOwnerRecord(fixture.runtimeRoot, fixture.bootstrapId);
  assert.notEqual(record, null, "the crashed attempt's owner record must exist on disk");
  return record!;
}

/** The registration pointer's own correlation, read back through the real reader. */
async function readRegistrationPointer(runtimeRoot: string): Promise<string | null> {
  return (await readStardewInstallationRegistration(runtimeRoot))?.activeAttempt?.bootstrapCorrelation ?? null;
}

/** The metadata the LAST admitted create of this fixture had minted for itself. */
function lastCreatedMetadata(fixture: IntegrationFixture): ProductionGameSessionMetadata {
  const results = fixture.authorityResultsOf("createGameSessionMetadata");
  return results[results.length - 1] as ProductionGameSessionMetadata;
}

async function expectActivationRefused(fixture: IntegrationFixture, causeCode: string): Promise<void> {
  await withWindowsPlatform(async () => {
    await assert.rejects(
      async () => await fixture.coordinator.activationOwner.activate(fixture.broker.issue("lifecycle_activation")),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "stardew_lifecycle_activation_failed" &&
        (error.cause as Error | undefined)?.message === causeCode,
    );
  });
}

const runtimeSlotRef = "Farm_389124477";
const crashedAttemptId = "bootstrap-integration-attempt-a";
const successorAttemptId = "bootstrap-integration-attempt-b";
const laterAttemptId = "bootstrap-integration-attempt-c";

/** One shared root + one shared real store + one fixture, in that order. */
async function integrationHarness(input: Readonly<{
  bootstrapId: string;
  recoveryAnswer: "contained" | "ai_settled_player_preserved" | "gate_held";
}>): Promise<Readonly<{
  runtimeRoot: string;
  store: BoundRealStore;
  fixture: IntegrationFixture;
  control: ReturnType<typeof openProductionContinuityStore>;
}>> {
  const runtimeRoot = await prepareIntegrationRoot();
  const { control, store } = openRealCreationAuthority(runtimeRoot);
  const fixture = await createIntegrationFixture({
    runtimeRoot,
    bootstrapId: input.bootstrapId,
    slotRef: runtimeSlotRef,
    store,
    crashPolicy: { unappliableSettleClosure: false },
    recoveryAnswer: input.recoveryAnswer,
  });
  return { runtimeRoot, store, fixture, control };
}

/**
 * Property 1 - the leftover is real.
 *
 * A real `game.create` over a real activation/launch registers its world binding
 * through the real store and then cannot complete or settle itself: the slot
 * holds a session whose metadata never left `pending`, the holder handle is the
 * crashed attempt's own bootstrap id, that attempt's `owner.json` is on disk and
 * non-terminal, and the registration pointer still names it. Everything here is
 * read back out of the real store and the real registration record.
 */
test("a real crashed create leaves a registered world-slot holder, a real attempt record and a real bound registration pointer", async () => {
  const harness = await integrationHarness({ bootstrapId: crashedAttemptId, recoveryAnswer: "gate_held" });
  const { runtimeRoot, store, fixture, control } = harness;
  try {
    await prepareLaunchedPlayerHost(fixture);

    // The real activation bound the registration pointer to this exact attempt.
    assert.equal(await readRegistrationPointer(runtimeRoot), crashedAttemptId);

    // The attempt's own durable record exists and is NOT terminal. It is still
    // at its reservation revision because the arm/activate transitions only run
    // at settlement, which is exactly why a crash here leaves it recoverable.
    const record = await readCrashedAttemptRecord(fixture);
    assert.equal(record.bootstrapId, crashedAttemptId);
    assert.equal(record.state, "reserved");
    assert.equal(record.guardianState, "reserved");
    assert.equal(record.playerHostState, "reserved");
    assert.equal(record.aiClientState, "reserved");
    assert.equal(record.ownerRecordRevision, 1);
    assert.equal(record.recoveryInstanceId, null);

    // The crashed create: the real store minted the session, the real
    // coordinator registered the world binding on the slot, and the attempt can
    // no longer complete itself or apply its own failure closure.
    assert.match(await crashCreate(fixture, "integration-crash-create-1"), /stardew_game_create_failed/);

    const leftover = await readSlotLeftover(fixture);
    assert.notEqual(leftover, null);
    assert.equal(leftover!.holder.status, "registered");
    assert.equal(leftover!.holder.bindingRef, runtimeSlotRef);
    // The holder handle the slot readback hands out is the crashed attempt's own
    // bootstrap id - the same identity the registration pointer names, not a
    // derived or invented value.
    assert.equal(leftover!.holder.holderHandle, crashedAttemptId);
    assert.equal(await readRegistrationPointer(runtimeRoot), leftover!.holder.holderHandle);
    // The holder's own two rows: registered rev1 paired with metadata that never
    // left `pending` rev1 - the shape the store's own rules allow and the shape a
    // create that died between `register` and `complete` leaves.
    assert.deepEqual(leftover!.binding, {
      gameSessionId: leftover!.holder.gameSessionId,
      integrationId: "stardew",
      bindingRef: runtimeSlotRef,
      status: "registered",
      revision: 1,
    });
    assert.deepEqual(leftover!.metadata, {
      gameSessionId: leftover!.holder.gameSessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "pending",
      revision: 1,
    });
    // Nothing about this leftover is resumable.
    assert.deepEqual(store.listResumableGameSessions(), []);

    // The point that used to refuse every later create on this slot: a second
    // session cannot register the same slot, and the refusal writes no row.
    const probe = await store.createGameSessionMetadata({
      creationRequestId: "integration-slot-probe-1",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    await assert.rejects(
      async () => await store.registerGameSessionWorldBinding({
        gameSessionId: probe.gameSessionId,
        integrationId: "stardew",
        bindingRef: runtimeSlotRef,
        operationId: "integration-slot-probe-operation-1",
        holderHandle: "integration-slot-probe-holder-1",
      }),
      { message: "game_session_world_binding_duplicate" },
    );
    assert.equal(
      await store.readGameSessionWorldBinding({ gameSessionId: probe.gameSessionId, integrationId: "stardew" }),
      null,
    );
  } finally {
    await fixture.close();
    control.close();
  }
});

/**
 * Property 2, first failure path - a HELD native gate.
 *
 * The drive reports the lease VERDICT (a handle exists at the holder's lease
 * name, so the holder was NOT proven gone). The create refuses under its own
 * bounded code, nothing is finalized, nothing is released, and the leftover's
 * rows, its attempt record and the registration pointer are byte-for-byte what
 * they were.
 *
 * The scripted Desktop stand-in answers `gate_held` without running any durable
 * step: its verdict is a scripted position, not the result of a named-mutex
 * probe (see this file's header). The store's own half of the same fact is
 * asserted separately below with a verdict minted through the store's own mint
 * function - again with no probe behind it.
 */
test("the create-side trigger refuses a held native gate as its own bounded outcome and leaves the leftover exactly as it found it", async () => {
  const harness = await integrationHarness({ bootstrapId: crashedAttemptId, recoveryAnswer: "gate_held" });
  const { runtimeRoot, store, fixture, control } = harness;
  try {
    await prepareLaunchedPlayerHost(fixture);
    await crashCreate(fixture, "integration-held-gate-crash");

    const leftover = await readSlotLeftover(fixture);
    assert.notEqual(leftover, null);
    const recordBytes = await readFile(ownerRecordPath(runtimeRoot, crashedAttemptId), "utf8");
    const registrationBytes = JSON.stringify(await readStardewInstallationRegistration(runtimeRoot));
    const membersBefore = fixture.authorityMembers().length;

    const outcome = await driveAdmittedCreate(fixture, "integration-held-gate-create");
    assert.equal(outcome.kind, "refusal");
    assert.equal((outcome as Readonly<{ message: string }>).message, STARDEW_GAME_CREATE_SLOT_HOLDER_NOT_PROVEN_GONE);
    // The drive ran ONCE, and it ran for this create's own world ref.
    const recoveries = fixture.sessionOperations().filter((operation) => operation.startsWith("recover:"));
    assert.equal(recoveries.length, 1);
    assert.match(recoveries[0]!, /^recover:[0-9a-f-]{36}$/);

    // Nothing durable changed: the leftover's rows and its attempt record are
    // exactly what the crash left, and the pointer still names the crashed
    // attempt.
    assert.deepEqual(await readSlotLeftover(fixture), leftover);
    assert.equal(await readFile(ownerRecordPath(runtimeRoot, crashedAttemptId), "utf8"), recordBytes);
    assert.equal(JSON.stringify(await readStardewInstallationRegistration(runtimeRoot)), registrationBytes);
    assert.equal(await readRegistrationPointer(runtimeRoot), crashedAttemptId);
    // The slot is still occupied, so the same create that would have written a
    // binding row never got there.
    await assert.rejects(
      async () => await store.registerGameSessionWorldBinding({
        gameSessionId: (await store.createGameSessionMetadata({
          creationRequestId: "integration-held-gate-probe-1",
          integrationId: "stardew",
          continuityIdentityId: null,
        })).gameSessionId,
        integrationId: "stardew",
        bindingRef: runtimeSlotRef,
        operationId: "integration-held-gate-probe-operation-1",
        holderHandle: "integration-held-gate-probe-holder-1",
      }),
      { message: "game_session_world_binding_duplicate" },
    );
    // This create's own durable steps: the intent it persisted, then its failure
    // closure. It never registered a world binding of its own.
    assert.deepEqual(fixture.authorityMembers().slice(membersBefore), [
      "createGameSessionMetadata",
      "failGameSessionCreation",
    ]);
    const own = lastCreatedMetadata(fixture);
    assert.deepEqual(await store.readGameSessionMetadata({ gameSessionId: own.gameSessionId }), {
      gameSessionId: own.gameSessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 2,
    });
    assert.equal(
      await store.readGameSessionWorldBinding({ gameSessionId: own.gameSessionId, integrationId: "stardew" }),
      null,
    );

    // The store's own half of the same verdict, and its own bounded refusal:
    // `lease_not_proven_free` cannot release a slot, and a refusal is not a
    // half-write. The verdict is minted through the store's own mint function -
    // no named-mutex probe ran for it, because the native lease check has no
    // production producer yet.
    await assert.rejects(
      async () => await store.releaseGameSessionWorldBindingSlot({
        integrationId: "stardew",
        bindingRef: runtimeSlotRef,
        holderHandle: leftover!.holder.holderHandle,
        proof: slotReleaseProof(
          leftover!.holder.holderHandle,
          productionGameSessionWorldBindingSlotLeaseVerdict.leaseNotProvenFree,
        ),
      }),
      { message: productionGameSessionWorldBindingSlotRelease.holderNotProvenGone },
    );
    assert.deepEqual(await readSlotLeftover(fixture), leftover);
    assert.equal(await readFile(ownerRecordPath(runtimeRoot, crashedAttemptId), "utf8"), recordBytes);
  } finally {
    await fixture.close();
    control.close();
  }
});

/**
 * A create over an already-settled leftover never touches the store's release at
 * all.
 *
 * This test used to pin the trigger's own release being refused as
 * `holderTerminal` after a concurrent settle. The ruling removed that release from
 * the create path - the world slot binds the PLAYER'S world and a create must not
 * free it - so no production create can produce that refusal any more. Keeping the
 * test (rather than deleting it) preserves the real-store evidence that survives:
 * this create refuses under its own resume-instead code, presents NO release at
 * all, and its own durable intent still lands on the store's one legal failure
 * shape with nothing half-written. The store's own bounded `holderTerminal`
 * refusal keeps its evidence here too, now asserted from a SECOND explicit release
 * performed by the test - which is where that half lives once no production create
 * path calls it.
 *
 * The concurrent settle is performed through the real store with a verdict minted
 * by the store's own mint function: no named-mutex probe ran for it, and no
 * production create performs one either.
 */
test("a create over an already-settled leftover refuses without presenting any release, and nothing is half-written", async () => {
  const harness = await integrationHarness({ bootstrapId: crashedAttemptId, recoveryAnswer: "contained" });
  const { runtimeRoot, store, fixture, control } = harness;
  try {
    await prepareLaunchedPlayerHost(fixture);
    await crashCreate(fixture, "integration-refused-release-crash");

    const leftover = await readSlotLeftover(fixture);
    assert.notEqual(leftover, null);
    assert.equal(leftover!.holder.status, "registered");
    // The concurrent settle: the same store release, for the same slot and the
    // same holder, landing the canonical terminal pair before the trigger runs.
    fixture.setRecoveryHook(async () => {
      await store.releaseGameSessionWorldBindingSlot({
        integrationId: "stardew",
        bindingRef: runtimeSlotRef,
        holderHandle: leftover!.holder.holderHandle,
        proof: slotReleaseProof(leftover!.holder.holderHandle, productionGameSessionWorldBindingSlotLeaseVerdict.holderGone),
      });
    });
    const membersBefore = fixture.authorityMembers().length;

    const outcome = await driveAdmittedCreate(fixture, "integration-refused-release-create");
    // The create's own bounded refusal, never the generic unavailable outcome: the
    // attempt was recovered and finalized, the world slot is still the previous
    // session's, and the product answer is to resume rather than to create.
    assert.equal(outcome.kind, "refusal");
    assert.equal(
      (outcome as Readonly<{ message: string }>).message,
      STARDEW_GAME_CREATE_WORLD_HELD_BY_PLAYER_RESUME_REQUIRED,
    );
    // The coordinator presented NO release at all: the only members this create
    // reached are its own intent and its own failure closure.
    assert.deepEqual(fixture.authorityMembers().slice(membersBefore), [
      "createGameSessionMetadata",
      "failGameSessionCreation",
    ]);
    assert.equal(fixture.sessionOperations().filter((operation) => operation.startsWith("recover:")).length, 1);
    // The leftover's two rows are the canonical terminal pair the store's own
    // settle produces: a legal state for this moment, and no longer an occupant.
    const after = await readSlotLeftover(fixture);
    assert.notEqual(after, null);
    assert.deepEqual(after!.binding, {
      gameSessionId: leftover!.holder.gameSessionId,
      integrationId: "stardew",
      bindingRef: runtimeSlotRef,
      status: "terminal",
      revision: 2,
    });
    assert.deepEqual(after!.metadata, {
      gameSessionId: leftover!.holder.gameSessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 3,
    });
    // The store's OWN bounded refusal for a release whose holder is already
    // terminal: a refusal, never a silent no-op, and no half-write. No production
    // create path presents one any more, so the test presents it itself.
    await assert.rejects(
      async () => await store.releaseGameSessionWorldBindingSlot({
        integrationId: "stardew",
        bindingRef: runtimeSlotRef,
        holderHandle: leftover!.holder.holderHandle,
        proof: slotReleaseProof(leftover!.holder.holderHandle, productionGameSessionWorldBindingSlotLeaseVerdict.holderGone),
      }),
      { message: productionGameSessionWorldBindingSlotRelease.holderTerminal },
    );
    // The attempt record reached the terminal `contained` successor (which the
    // release's own settle re-reads and validates) and the cleanup then consumed
    // it, and the attempt stopped occupying the registration.
    assert.equal(await readOwnerRecord(runtimeRoot, crashedAttemptId), null);
    assert.equal(await readRegistrationPointer(runtimeRoot), null);
    // This create's own rows: intent, then its failure closure - no release step in
    // between any more. Its metadata is failed with NO binding row, which the
    // store's own materialization rules accept.
    const own = lastCreatedMetadata(fixture);
    assert.deepEqual(await store.readGameSessionMetadata({ gameSessionId: own.gameSessionId }), {
      gameSessionId: own.gameSessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 2,
    });
    assert.equal(
      await store.readGameSessionWorldBinding({ gameSessionId: own.gameSessionId, integrationId: "stardew" }),
      null,
    );
  } finally {
    // A recovery driven from inside this create's own lifecycle CONSUMES the
    // attempt that same lifecycle is running on: the owner record the close
    // would quarantine is gone, so the close reports
    // `stardew_lifecycle_close_incomplete` instead of silently succeeding. That
    // consequence is recorded here rather than hidden - it is the same-attempt
    // half of what this file's report names - and the admission server is
    // released unconditionally so the run can exit.
    const closeOutcome = await fixture.coordinator.close().then(
      () => "closed",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    assert.equal(closeOutcome, "stardew_lifecycle_close_incomplete");
    await fixture.broker.close();
    control.close();
  }
});

/**
 * Property 2, third path - the broker's PLAYER-ROLE EARLY RETURN, end to end over
 * the real store, the real composer and the real installation registration.
 *
 * The native never adopts the player's world, so the broker classifies the AI side
 * internally - cleaning it up on its kill-on-close path - and acknowledges with the
 * player's own `unavailable`. The Host calls that the AI-side terminal, and the
 * ruling makes it a refusal of this create, not a recovery of the player's world:
 * the world slot is the player's to keep, so the create refuses under its own
 * resume-instead code and presents NO release at all.
 *
 * WHAT THIS TEST ALSO RECORDS, because it must not read as resolved: the durable
 * finalize is deliberately NOT driven on this terminal. It requires BOTH roles
 * durably contained, which this path never records, so driving it would make the
 * engine quarantine the attempt as a side effect of its own refusal - burning the
 * very recoverability the follow-up change needs. So today a crash like this leaves
 * the session BLOCKED: the create is refused with "this world is the player's,
 * resume it", and the resume is itself refused, because the crashed attempt's
 * registration pointer is still bound to its reservation. The attempt record
 * itself is untouched, still non-terminal, and still openable by the sanctioned
 * opener - so the gap is exactly the pointer release that the durable-engine
 * change exists to land, and nothing else. This is asserted below rather than
 * described, so the gap stays visible instead of silently reading as healed.
 */
test("the create-side trigger refuses a world whose recovery settled the AI side, and the still-bound pointer blocks its own resume", async () => {
  const harness = await integrationHarness({ bootstrapId: crashedAttemptId, recoveryAnswer: "ai_settled_player_preserved" });
  const { runtimeRoot, store, fixture, control } = harness;
  let blockedFixture: IntegrationFixture | undefined;
  try {
    await prepareLaunchedPlayerHost(fixture);
    await crashCreate(fixture, "integration-ai-side-terminal-crash");

    const leftover = await readSlotLeftover(fixture);
    assert.notEqual(leftover, null);
    const registrationBytes = JSON.stringify(await readStardewInstallationRegistration(runtimeRoot));
    const membersBefore = fixture.authorityMembers().length;

    const outcome = await driveAdmittedCreate(fixture, "integration-ai-side-terminal-create");
    // The create's OWN bounded refusal - not the generic unavailable outcome, and
    // not the held-gate verdict, which would claim a lease fact that was never
    // observed (the gate DID open here).
    assert.equal(outcome.kind, "refusal");
    assert.equal(
      (outcome as Readonly<{ message: string }>).message,
      STARDEW_GAME_CREATE_WORLD_HELD_BY_PLAYER_RESUME_REQUIRED,
    );
    // The drive ran ONCE, for this create's own world ref.
    const recoveries = fixture.sessionOperations().filter((operation) => operation.startsWith("recover:"));
    assert.equal(recoveries.length, 1);
    // The coordinator presented NO release at all: the world slot is the player's,
    // so the only members this create reached are its own intent and its own
    // failure closure.
    assert.deepEqual(fixture.authorityMembers().slice(membersBefore), [
      "createGameSessionMetadata",
      "failGameSessionCreation",
    ]);
    // The leftover's own rows are exactly what the crash left: it still holds the
    // world slot, with its own handle, and the pointer still names it.
    assert.deepEqual(await readSlotLeftover(fixture), leftover);
    assert.equal(await readRegistrationPointer(runtimeRoot), crashedAttemptId);
    assert.equal(JSON.stringify(await readStardewInstallationRegistration(runtimeRoot)), registrationBytes);

    // The attempt record is exactly the shape the deliberate terminal leaves: the
    // durable `recovering` CAS ran (the gate opened), the recorded actor is the one
    // the drive adopted, NO role is recorded contained, and nothing claims a pending
    // cleanup retry - so nothing was fabricated and nothing was quarantined.
    const record = await readCrashedAttemptRecord(fixture);
    assert.equal(record.state, "recovering");
    assert.equal(record.guardianState, "recovering");
    assert.equal(record.playerHostState, "reserved");
    assert.equal(record.aiClientState, "reserved");
    assert.equal(record.cleanupDisposition, "pending");
    assert.notEqual(record.recoveryInstanceId, null);

    // Still openable by the sanctioned opener: the refusal did not burn the
    // attempt's recoverability, and no terminal or quarantined state was invented
    // for a world that was deliberately preserved.
    const opened = await openRecoverableStardewBootstrapOwner({
      transactionRoot: runtimeRoot,
      bootstrapFacts: { bootstrapId: crashedAttemptId, playerId: principal.playerId, companionId: principal.companionId },
    });
    assert.equal(opened.ownerRecordRevision, record.ownerRecordRevision);

    // THE RESIDUAL, asserted rather than described: with the finalize half still
    // blocked, the crashed attempt keeps its registration pointer, and a fresh
    // lifecycle cannot even reserve - so the resume this refusal points at is
    // refused too, with the registration refusal as its cause.
    blockedFixture = await createIntegrationFixture({
      runtimeRoot,
      bootstrapId: successorAttemptId,
      slotRef: runtimeSlotRef,
      store,
      crashPolicy: { unappliableSettleClosure: false },
      recoveryAnswer: "contained",
    });
    await expectActivationRefused(blockedFixture, "stardew_bootstrap_registration_unavailable");
    assert.equal(await readRegistrationPointer(runtimeRoot), crashedAttemptId);
  } finally {
    // The same-attempt consequence this file's report names: a recovery driven from
    // inside this create's own lifecycle leaves the attempt in a position its own
    // close cannot settle, so the close reports `stardew_lifecycle_close_incomplete`
    // rather than silently succeeding. It is recorded, not hidden, and the admission
    // servers are released unconditionally so the run can exit.
    const closeOutcome = await fixture.coordinator.close().then(
      () => "closed",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    assert.equal(closeOutcome, "stardew_lifecycle_close_incomplete");
    await blockedFixture?.close();
    await fixture.broker.close();
    control.close();
  }
});

/**
 * Property 3 - the two halves actually meet.
 *
 * The crashed attempt's own leftover (real store rows, real `owner.json`, real
 * bound registration pointer) is recovered, finalized and released, and only
 * then does a later lifecycle's `game.create` register its own world on that very
 * slot.
 *
 * What each half is, and what it is not:
 *
 * - The recovery is driven by the REAL coordinator helper
 *   (`driveStardewOwnedPlayerHostRecovery`) over the REAL opener
 *   (`openRecoverableStardewBootstrapOwner`) and the REAL composition drive
 *   (`containedRuntimeTeardownFromCollaborator` over the same collaborator the
 *   launches used). The durable `beginRecovery`/role-containment CASes and the
 *   finalization are the real engine's.
 * - The native ANSWER is not: the scripted Desktop stand-in reports `contained`
 *   because no real named-mutex gate, no real Guardian process and no live run
 *   exist in this file (see the header). Nothing here establishes mutex
 *   ownership.
 * - The slot release uses the holder handle READ FROM THE SLOT and a store-minted
 *   `holder_gone` verdict. That verdict has no production producer yet, so it is
 *   minted with the store's own mint function: no probe ran for it.
 *
 * The point that used to refuse the next reservation is asserted on both sides of
 * the recovery: before it, the next lifecycle's own activation is refused because
 * the crashed attempt still occupies the registration pointer; after it, the same
 * activation succeeds, and the later create gets all the way through the world
 * registration on this slot - the registration that was refused as a duplicate
 * before the recovery.
 */
test("a real leftover is recovered, finalized and released, and the next lifecycle's create then registers its own world on that slot", async () => {
  const runtimeRoot = await prepareIntegrationRoot();
  const { control, store } = openRealCreationAuthority(runtimeRoot);
  let crashedBroker: IntegrationBroker | undefined;
  let blockedFixture: IntegrationFixture | undefined;
  let successorFixture: IntegrationFixture | undefined;
  try {
    const crashedFixture = await createIntegrationFixture({
      runtimeRoot,
      bootstrapId: crashedAttemptId,
      slotRef: runtimeSlotRef,
      store,
      crashPolicy: { unappliableSettleClosure: false },
      recoveryAnswer: "contained",
    });
    crashedBroker = crashedFixture.broker;
    await prepareLaunchedPlayerHost(crashedFixture);
    await crashCreate(crashedFixture, "integration-next-create-crash");
    const leftover = await readSlotLeftover(crashedFixture);
    assert.notEqual(leftover, null);
    assert.equal(leftover!.holder.holderHandle, crashedAttemptId);
    // The crashed process is gone. Nothing closed it, and nothing may: an
    // ordinary coordinator close quarantines the exact owner
    // (`quarantineOwnedPlayerHostOwner` in the close attempt), which is exactly
    // the state that makes the attempt unrecoverable. A crash leaves the
    // attempt non-terminal and its registration pointer bound - which is what
    // the recovery below needs, and what blocks the next reservation.
    assert.equal(await readRegistrationPointer(runtimeRoot), crashedAttemptId);

    // The next lifecycle: its reservation is refused, and the durable reason is
    // the crashed attempt's own bound pointer.
    blockedFixture = await createIntegrationFixture({
      runtimeRoot,
      bootstrapId: successorAttemptId,
      slotRef: runtimeSlotRef,
      store,
      crashPolicy: { unappliableSettleClosure: false },
      recoveryAnswer: "contained",
    });
    await expectActivationRefused(blockedFixture, "stardew_bootstrap_registration_unavailable");
    assert.equal(await readRegistrationPointer(runtimeRoot), crashedAttemptId);
    assert.deepEqual(await readSlotLeftover(blockedFixture), leftover);

    // The recovery of the crashed attempt through the real coordinator drive.
    const opened = await openRecoverableStardewBootstrapOwner({
      transactionRoot: runtimeRoot,
      bootstrapFacts: {
        bootstrapId: leftover!.holder.holderHandle,
        playerId: principal.playerId,
        companionId: principal.companionId,
      },
    });
    const request: StardewOwnerRecoveryRequest = Object.freeze({
      // The crash left no recorded actor, so this mints one exactly as the
      // create-side trigger does.
      recoveryInstanceId: opened.recoveryInstanceId ?? randomUUID(),
      readRecoveryBinding: () => readRecoverableStardewBootstrapOwnerRecoveryBinding(opened),
    });
    await driveStardewOwnedPlayerHostRecovery(crashedFixture.recoveryTeardown, opened.owner, request);
    // The finalization is durable: the attempt's record reached its terminal
    // successor and its cleanup consumed it, and it stopped occupying the
    // registration.
    assert.equal(await readOwnerRecord(runtimeRoot, crashedAttemptId), null);
    assert.equal(await readRegistrationPointer(runtimeRoot), null);
    // The slot release: the handle read FROM THE SLOT and the store's own mint
    // for a holder-gone verdict (no production producer yet - see the header).
    assert.deepEqual(
      await store.releaseGameSessionWorldBindingSlot({
        integrationId: "stardew",
        bindingRef: runtimeSlotRef,
        holderHandle: leftover!.holder.holderHandle,
        proof: slotReleaseProof(leftover!.holder.holderHandle, productionGameSessionWorldBindingSlotLeaseVerdict.holderGone),
      }),
      {
        gameSessionId: leftover!.holder.gameSessionId,
        integrationId: "stardew",
        bindingRef: runtimeSlotRef,
        status: "terminal",
        revision: 2,
      },
    );
    const settledSlot = await store.readGameSessionWorldBindingSlotHolder({
      integrationId: "stardew",
      bindingRef: runtimeSlotRef,
    });
    assert.equal(settledSlot?.status, "terminal");
    assert.equal(settledSlot?.gameSessionId, leftover!.holder.gameSessionId);

    // The later reservation now gets PAST the point that refused it.
    successorFixture = await createIntegrationFixture({
      runtimeRoot,
      bootstrapId: laterAttemptId,
      slotRef: runtimeSlotRef,
      store,
      crashPolicy: { unappliableSettleClosure: false },
      recoveryAnswer: "contained",
    });
    await prepareLaunchedPlayerHost(successorFixture);
    assert.equal(await readRegistrationPointer(runtimeRoot), laterAttemptId);

    // ... and the create registers its own world on that slot and attaches.
    const membersBefore = successorFixture.authorityMembers().length;
    const outcome = await driveAdmittedCreate(successorFixture, "integration-next-create");
    assert.equal(outcome.kind, "result");
    const created = (outcome as Readonly<{ result: unknown }>).result as Readonly<{
      apiVersion: 1;
      status: string;
      gameSessionId: string | null;
    }>;
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(created), true);
    assert.equal(created.status, "attached");
    const sessionId = created.gameSessionId!;
    assert.match(sessionId, /^[A-Za-z0-9_-]{32}$/);
    // The durable steps of this create: intent, register, complete. The slot that
    // refused a foreign registration before the recovery accepted this one.
    assert.deepEqual(successorFixture.authorityMembers().slice(membersBefore), [
      "createGameSessionMetadata",
      "registerGameSessionWorldBinding",
      "completeGameSessionBinding",
    ]);
    assert.deepEqual(await store.readGameSessionWorldBinding({ gameSessionId: sessionId, integrationId: "stardew" }), {
      gameSessionId: sessionId,
      integrationId: "stardew",
      bindingRef: runtimeSlotRef,
      status: "registered",
      revision: 1,
    });
    assert.deepEqual(await store.readGameSessionMetadata({ gameSessionId: sessionId }), {
      gameSessionId: sessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "resumable",
      revision: 2,
    });
    // The slot's occupant is this lifecycle's own attempt, never the crashed one.
    const successor = await store.readGameSessionWorldBindingSlotHolder({
      integrationId: "stardew",
      bindingRef: runtimeSlotRef,
    });
    assert.equal(successor?.gameSessionId, sessionId);
    assert.equal(successor?.holderHandle, laterAttemptId);
    // The recovered leftover keeps its settled rows and no longer blocks.
    assert.deepEqual(await store.readGameSessionMetadata({ gameSessionId: leftover!.holder.gameSessionId }), {
      gameSessionId: leftover!.holder.gameSessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 3,
    });
    assert.deepEqual(store.listResumableGameSessions(), [
      await store.readGameSessionMetadata({ gameSessionId: sessionId }),
    ]);
  } finally {
    // The crashed lifecycle is deliberately NOT closed: a crashed process closes
    // nothing, and closing it would quarantine the attempt. Only its admission
    // server is released so this run can exit.
    await crashedBroker?.close();
    await blockedFixture?.close();
    await successorFixture?.close();
    control.close();
  }
});
