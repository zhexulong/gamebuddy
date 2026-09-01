import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";

import type {
  StardewAiClientLaunchReservation,
  StardewAiClientProcessProbe,
  StardewAiClientProcessSpawn,
} from "./stardew-ai-client-process-owner.js";
import { StardewAttachmentFlow } from "./stardew-attachment.js";
import { bindWindowsStaleLockReclaimer, pathLockPath, withPathLock } from "./path-lock.js";
import type { StardewPlayerHostBootstrapClaim } from "./stardew-player-host-bootstrap.js";
import type { StardewPlayerHostLaunchReservation } from "./stardew-player-host-process-owner.js";
import * as productionComposer from "./stardew-private-bootstrap-composer.js";
import type { StardewBootstrapGuardianNativePorts } from "./stardew-bootstrap-guardian.private.js";
import type {
  StardewExternalPlayerHostPhaseAOwner,
  StardewOwnedPlayerHostPhaseAOwner,
  StardewPrivateBootstrapComposition,
} from "./stardew-private-bootstrap-composer.js";
import * as internalComposer from "./stardew-private-bootstrap-composer.internal.js";
import * as productionCore from "./stardew-private-bootstrap-composer.core.js";
import {
  consumeOwnedPlayerHostPhaseAOwner,
  stageOwnedPlayerHostPhaseB,
  terminalizeOwnedPlayerHostPhaseAOwner,
} from "./stardew-private-bootstrap-composer.internal.js";
import * as composerTestSupport from "./stardew-private-bootstrap-composer.test-support.js";
import {
  bindStardewPrivateBootstrapOwnerTestSupport,
  consumeStagedOwnedPlayerHostPhaseBForTesting,
  createStardewPrivateBootstrapComposerTestSupport,
  launchOwnedPlayerHostStageCForTesting,
} from "./stardew-private-bootstrap-composer.test-support.js";
import * as composerTestSupportInternal from "./stardew-private-bootstrap-composer.test-support-internal.js";
import {
  consumeOwnedFarmhandBridgeConnectionForTesting,
  createOwnerTransitionsForTesting,
  createStardewPrivateBootstrapCompositionForTesting,
  launchOwnedAiClientStageDForTesting,
  materializeAiClientProfileAfterManifestAdmissionForTesting,
  type StardewPrivateModProfileStagingTestSupportInput,
} from "./stardew-private-bootstrap-composer.test-support-internal.js";
import { createTestWindowsReparseInspector } from "./windows-reparse-inspector/index.test-support.js";
import type { WindowsPathObjectIdentity } from "./windows-reparse-inspector/index.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";
import {
  admitStardewInstallation,
  type AdmittedStardewInstallation,
} from "./stardew-installation-admission.js";
// StardewOwnedPlayerHostStageCResult is the return type of
// launchOwnedPlayerHostStageCForTesting, derived from the test-support import.

type Assert<T extends true> = T;
type HasExactKeys<T, TKeys extends PropertyKey> =
  Exclude<keyof T, TKeys> extends never
    ? Exclude<TKeys, keyof T> extends never
      ? true
      : false
    : false;
type ProductionInternalComposition = ReturnType<typeof internalComposer.createStardewPrivateBootstrapComposition>;
type _ProductionInternalCompositionHasExactKeys = Assert<
  HasExactKeys<
    ProductionInternalComposition,
     "composition" | "createOwnedPlayerHostAttachmentFlow" | "readAndCorrelateOwnedPlayerHostSession" | "createOwnedPlayerHostManifestHandoffCoordinator" | "materializeAiClientProfileAfterManifestAdmission" | "launchOwnedAiClientStageD" | "consumeOwnedFarmhandBridgeConnection" | "launchOwnedPlayerHostStageC" | "reserveOwnedPlayerHostPhaseAForActivation" | "stageOwnedPlayerHostPhaseB" | "terminalizeOwnedPlayerHostOwner" | "quarantineOwnedPlayerHostOwner" | "createStardewBootstrapGuardianOwner"
  >
>;
type _ProductionInternalCompositionRetainsPublicComposition = Assert<
  ProductionInternalComposition["composition"] extends StardewPrivateBootstrapComposition ? true : false
>;

const EXE = process.platform === "win32" ? "C:\\GameBuddy\\ai-client.exe" : "/gamebuddy/ai-client";
const CREATION = "20250102030405.000000+000";
const OWNER_SCHEMA = "gamebuddy-stardew-private-bootstrap-owner/v4";
const OWNER_FILE = "owner.json";

function signedAttachmentSession(sessionToken: string, launchGeneration = "player-generation-1") {
  const session = {
    schemaVersion: 1,
    integrationId: "stardew",
    integrationVersion: "0.1.0",
    gameVersion: "1.6.15",
    gameBuildNumber: 24356,
    smapiVersion: "4.5.2",
    multiplayerProtocol: "1.6.15",
    endpoint: "127.0.0.1:24642",
    saveId: "save-attachment-factory",
    worldId: "world-attachment-factory",
    publishedAtUnixMs: 1_000,
    expiresAtUnixMs: 5_000,
    nonce: "nonce-attachment-factory",
    state: "ready",
     hostPlayerId: "world-attachment-factory",
     runtimeRole: "player_host",
     launchGeneration,
     cabins: [{ cabinId: "cabin-attachment-factory", ownerFarmhandId: "12345", boundCompanionId: "", isBusy: false }],
    signature: "",
  };
  const unsigned = { ...session } as Record<string, unknown>;
  delete unsigned.signature;
  return Object.freeze({
    ...session,
    signature: createHmac("sha256", sessionToken).update(JSON.stringify(unsigned), "utf8").digest("base64url"),
  });
}

function ownerTestView(owner: StardewOwnedPlayerHostPhaseAOwner) {
  return bindStardewPrivateBootstrapOwnerTestSupport(owner);
}

function signedAttachmentValue<T extends { signature: string }>(value: T, token: string): T {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signature;
  return {
    ...value,
    signature: createHmac("sha256", token).update(JSON.stringify(unsigned), "utf8").digest("base64url"),
  };
}

function manifestForAttachment(input: Readonly<{
  token: string;
  requestId: string;
  saveId: string;
  worldId: string;
  nonce: string;
  cabinId?: string;
  farmhandId?: string;
  companionId?: string;
  endpoint?: string;
  signatureOverride?: string;
}>) {
  const value = {
    schemaVersion: 1,
    requestId: input.requestId,
    integrationId: "stardew",
    integrationVersion: "0.1.0",
    gameVersion: "1.6.15",
    gameBuildNumber: 24356,
    smapiVersion: "4.5.2",
    multiplayerProtocol: "1.6.15",
    endpoint: input.endpoint ?? "127.0.0.1:24642",
    saveId: input.saveId,
    worldId: input.worldId,
    companionId: input.companionId ?? "companion-1",
    farmhandId: input.farmhandId ?? "12345",
    cabinId: input.cabinId ?? "cabin-attachment-factory",
    sessionNonce: input.nonce,
    issuedAtUnixMs: 2_000,
    expiresAtUnixMs: 4_000,
    signature: "",
  };
  const signed = signedAttachmentValue(value, input.token);
  return input.signatureOverride === undefined ? signed : { ...signed, signature: input.signatureOverride };
}

async function prepareManifestHandoffFixture(processOverrides: Readonly<{
  spawn?: StardewAiClientProcessSpawn;
  probe?: StardewAiClientProcessProbe;
}> = {}) {
  const fixture = await createAttachmentFactoryFixture(processOverrides);
  const transactionDirectory = fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).transactionDirectory;
  const sessionDirectory = join(transactionDirectory, "session");
  const token = "session-secret-stagec-012345";
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, "stardew-session.json"), JSON.stringify(signedAttachmentSession(token)));
  const coordinator = fixture.testCore.createOwnedPlayerHostManifestHandoffCoordinator();
  return { ...fixture, sessionDirectory, token, coordinator };
}

async function prepareMaterializedAiClientFixture(processOverrides: Readonly<{
  spawn?: StardewAiClientProcessSpawn;
  probe?: StardewAiClientProcessProbe;
}> = {}) {
  const fixture = await prepareManifestHandoffFixture(processOverrides);
  const selection = await fixture.coordinator.select(fixture.owner, "cabin-attachment-factory");
  const pending = fixture.coordinator.confirmAndAdmit(selection, { confirmed: true });
  const request = await waitForPublishedAttachmentRequest(fixture.sessionDirectory);
  const requestId = request.requestId as string;
  await writeFile(join(fixture.sessionDirectory, "stardew-attachment-response.json"), JSON.stringify(signedAttachmentValue({
    schemaVersion: 1,
    requestId,
    state: "ready",
    reasonCode: "manifest_issued",
    updatedAtUnixMs: 2_100,
    manifestPath: "stardew-farmhand-manifest.json",
    signature: "",
  }, fixture.token)));
  await writeFile(join(fixture.sessionDirectory, "stardew-farmhand-manifest.json"), JSON.stringify(manifestForAttachment({
    token: fixture.token,
    requestId,
    saveId: "save-attachment-factory",
    worldId: "world-attachment-factory",
    nonce: "nonce-attachment-factory",
  })));
  const admission = await pending;
  await fixture.testCore.materializeAiClientProfileAfterManifestAdmission(fixture.owner, admission);
  return fixture;
}

async function prepareLaunchedAiClientFixture(processOverrides: Readonly<{
  spawn?: StardewAiClientProcessSpawn;
  probe?: StardewAiClientProcessProbe;
}> = {}) {
  const fixture = await prepareMaterializedAiClientFixture(processOverrides);
  const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);
  const launch = await fixture.testCore.launchOwnedAiClientStageD(fixture.owner, installation);
  assert.deepEqual(launch, { status: { kind: "awaiting_ai_client_attestation" } });
  return fixture;
}

function assertFieldlessFrozen(value: object): void {
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Reflect.ownKeys(value), []);
  assert.equal(JSON.stringify(value), "{}");
}

function createStageBTestHarness(input: Readonly<{
  recheck(phase: "pre" | "post"): Promise<void>;
  verifyPackage(): Promise<void>;
}>) {
  return {
    async bindOwnedPhaseA(owner: Parameters<typeof consumeOwnedPlayerHostPhaseAOwner>[0]): Promise<object> {
      try {
        return await consumeOwnedPlayerHostPhaseAOwner(owner, async () => {
          await input.recheck("pre");
          await input.verifyPackage();
          await input.recheck("post");
          await stageOwnedPlayerHostPhaseB(owner);
          try { await input.recheck("post"); }
          catch (error) {
            try { await ownerTestView(owner).quarantine(); } catch { /* preserve reread failure */ }
            terminalizeOwnedPlayerHostPhaseAOwner(owner);
            throw error;
          }
          return Object.freeze({});
        });
      } catch {
        throw new Error("stardew_private_stage_b_failed");
      }
    },
  };
}

const temporaryRoots: string[] = [];
test.beforeEach(() => bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedLockHelper)));
test.after(() => bindWindowsStaleLockReclaimer(undefined));
test.after(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation reservation atomically compensates Player Host when AI generation fails", async () => {
  const harness = createHarness({ launchGenerations: [""] });
  const internal = createStardewPrivateBootstrapCompositionForTesting(harness.dependencies);
  const browserSessionId = "browser-session-activation-compensation";
  const claim = internal.composition.broker.confirm({
    playerId: "player-1",
    companionId: "companion-1",
    browserSessionId,
    expiresAtMs: 10_000,
  }).consume(browserSessionId);

  await assert.rejects(
    internal.reserveOwnedPlayerHostPhaseAForActivation(await createRoot(), claim),
    /invalid_launch_generation/,
  );
  assert.deepEqual(internal.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(internal.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  await assert.rejects(
    internal.reserveOwnedPlayerHostPhaseAForActivation(await createRoot(), claim),
    /stardew_bootstrap_claim_not_available/,
  );
});

type SpawnCall = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string | undefined;
  environmentGeneration: string | undefined;
}>;

function createHarness(input: Readonly<{
  nowMs?: number;
  bootstrapIds?: readonly string[];
  launchGenerations?: readonly string[];
  playerHostLaunchGenerations?: readonly string[];
  guardianRevisions?: readonly string[];
  guardianLeaseNames?: readonly string[];
  guardianPlayerJobNames?: readonly string[];
  guardianAiJobNames?: readonly string[];
  probe?: StardewAiClientProcessProbe;
  spawn?: StardewAiClientProcessSpawn;
  playerHostProbe?: StardewAiClientProcessProbe;
  playerHostSpawn?: StardewAiClientProcessSpawn;
  staging?: StardewPrivateModProfileStagingTestSupportInput;
}> = {}) {
  let nowMs = input.nowMs ?? 1_000;
  let bootstrapIndex = 0;
  let generationIndex = 0;
  let playerHostGenerationIndex = 0;
  let guardianRevisionIndex = 0;
  let guardianLeaseNameIndex = 0;
  let guardianPlayerJobNameIndex = 0;
  let guardianAiJobNameIndex = 0;
  const spawnCalls: SpawnCall[] = [];
  const playerHostSpawnCalls: SpawnCall[] = [];
  const killCalls: number[] = [];
  const playerHostKillCalls: number[] = [];
  const defaultSpawn: StardewAiClientProcessSpawn = (executable, args, options) => {
    spawnCalls.push({
      executable,
      args: [...args],
      cwd: options.cwd,
      environmentGeneration: options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION,
    });
    return Object.freeze({
      pid: 4321,
      kill() {
        killCalls.push(4321);
        return true;
      },
    });
  };
  const defaultPlayerHostSpawn: StardewAiClientProcessSpawn = (executable, args, options) => {
    playerHostSpawnCalls.push({
      executable,
      args: [...args],
      cwd: options.cwd,
      environmentGeneration: options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION,
    });
    return Object.freeze({
      pid: 5432,
      kill() {
        playerHostKillCalls.push(5432);
        return true;
      },
    });
  };
   const baseDependencies = {
     rawSpawn: input.spawn ?? defaultSpawn,
    rawProbe: input.probe ?? ((pid: number) => ({ pid, creationDate: CREATION })),
    rawPlayerHostSpawn: input.playerHostSpawn ?? defaultPlayerHostSpawn,
    rawPlayerHostProbe: input.playerHostProbe ?? ((pid: number) => ({ pid, creationDate: CREATION })),
     createBootstrapIdentity: () => {
       const index = bootstrapIndex++;
      return input.bootstrapIds?.[index] ?? `bootstrap-${index + 1}`;
    },
     createGuardianRevision: () => input.guardianRevisions?.[guardianRevisionIndex++] ?? "revision-1",
     createGuardianInstanceId: () => "guardian-instance-1",
     createGuardianEpoch: () => 1,
     createGuardianLeaseName: () => input.guardianLeaseNames?.[guardianLeaseNameIndex++] ?? "Local\\GameBuddy-Test-Lease-1",
     createGuardianPlayerJobName: () => input.guardianPlayerJobNames?.[guardianPlayerJobNameIndex++] ?? "Local\\GameBuddy-Test-PlayerJob-1",
     createGuardianAiJobName: () => input.guardianAiJobNames?.[guardianAiJobNameIndex++] ?? "Local\\GameBuddy-Test-AiJob-1",
     createLaunchGeneration: () => {
      const index = generationIndex++;
      return input.launchGenerations?.[index] ?? `generation-${index + 1}`;
    },
    createPlayerHostLaunchGeneration: () => {
      const index = playerHostGenerationIndex++;
      return input.playerHostLaunchGenerations?.[index] ?? `player-generation-${index + 1}`;
    },
    createBridgePipeName: () => "gamebuddy-stardew-test-bridge",
    createBridgeToken: () => "test-bridge-token-0123456789",
    nowMs: () => nowMs,
  };
  const dependencies = {
    ...baseDependencies,
    staging: input.staging ?? defaultStagingDependencies(),
  };
  const testCore = createStardewPrivateBootstrapCompositionForTesting(dependencies);
  const composition = testCore.composition;

  return {
    dependencies,
    testCore,
    composition,
    spawnCalls,
    playerHostSpawnCalls,
    killCalls,
    playerHostKillCalls,
    setNow(value: number) {
      nowMs = value;
    },
  };
}

async function createAttachmentFactoryFixture(processOverrides: Readonly<{
  spawn?: StardewAiClientProcessSpawn;
  probe?: StardewAiClientProcessProbe;
}> = {}) {
  const root = await createRoot("gamebuddy-attachment-factory-");
  const packageRoot = join(root, "verified-package");
  const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
  await mkdir(packageRoot);
  for (const entry of entries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  const sessionToken = "session-secret-stagec-012345";
  const harness = createHarness({
    ...processOverrides,
    staging: {
      readPackage: async () => ({ root: packageRoot, entries }),
      createSecret: () => sessionToken,
      nowMs: () => 1_000,
    },
  });
  const testCore = createStardewPrivateBootstrapCompositionForTesting(harness.dependencies);
  const triple = mintOwnedTriple(testCore.composition);
  const owner = await testCore.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  await createStageBTestHarness({ recheck: async () => undefined, verifyPackage: async () => undefined }).bindOwnedPhaseA(owner);
  return { root, harness, testCore, owner };
}


function defaultStagingDependencies(): StardewPrivateModProfileStagingTestSupportInput {
  let secretIndex = 0;
  const artifactRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "integrations",
    "stardew",
    "bin",
    "Debug",
    "net6.0",
  );
  return {
    readPackage: async () => ({
      root: artifactRoot,
      entries: [
        "GameBuddy.Stardew.Core.dll",
        "GameBuddy.Stardew.deps.json",
        "GameBuddy.Stardew.dll",
        "Raffinert.FuzzySharp.dll",
        "manifest.json",
      ],
    }),
    createSecret: () => `test-provisioning-secret-${++secretIndex}-0123456789`,
    nowMs: () => 1_000,
  };
}

async function createRoot(prefix = "gamebuddy-private-bootstrap-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function mintOwnedTriple(
  composition: StardewPrivateBootstrapComposition,
  input: Readonly<{
    playerId?: string;
    companionId?: string;
    browserSessionId?: string;
    expiresAtMs?: number;
  }> = {},
) {
  const browserSessionId = input.browserSessionId ?? "browser-1";
  const claim = composition.broker.confirm({
    playerId: input.playerId ?? "player-1",
    companionId: input.companionId ?? "companion-1",
    browserSessionId,
    expiresAtMs: input.expiresAtMs ?? 5_000,
  }).consume(browserSessionId);
  const playerHostReservation = composition.playerHostProcessOwner.reservePlayerHostLaunch();
  const aiClientReservation = composition.aiClientProcessOwner.reserveAiClientLaunch();
  return { claim, playerHostReservation, aiClientReservation };
}

function mintPair(
  composition: StardewPrivateBootstrapComposition,
  input: Readonly<{
    playerId?: string;
    companionId?: string;
    browserSessionId?: string;
    expiresAtMs?: number;
  }> = {},
) {
  const browserSessionId = input.browserSessionId ?? "browser-1";
  const claim = composition.broker.confirm({
    playerId: input.playerId ?? "player-1",
    companionId: input.companionId ?? "companion-1",
    browserSessionId,
    expiresAtMs: input.expiresAtMs ?? 5_000,
  }).consume(browserSessionId);
  const reservation = composition.aiClientProcessOwner.reserveAiClientLaunch();
  return { claim, reservation };
}

async function reserveFresh(
  harness: ReturnType<typeof createHarness>,
  root: string,
  input: Parameters<typeof mintPair>[1] = {},
) {
  const pair = mintPair(harness.composition, input);
  return harness.composition.reserveExternalPlayerHostPhaseA(root, pair.claim, pair.reservation);
}

function ownerPath(root: string, bootstrapId = "bootstrap-1"): string {
  return join(root, "stardew-private-bootstrap", bootstrapId, OWNER_FILE);
}

function createOwnerTransitions(
  harness: ReturnType<typeof createHarness>,
  input: Parameters<typeof createOwnerTransitionsForTesting>[1],
) {
  return createOwnerTransitionsForTesting(harness.testCore, input);
}

function expectedGuardianBinding(input: Readonly<{ revision?: string; instanceId?: string; epoch?: number; leaseName?: string; playerJobName?: string; aiJobName?: string }> = {}) {
  return {
    bindingRevision: input.revision ?? "revision-1",
    guardianInstanceId: input.instanceId ?? "guardian-instance-1",
    guardianEpoch: input.epoch ?? 1,
    leaseName: input.leaseName ?? "Local\\GameBuddy-Test-Lease-1",
    playerJobName: input.playerJobName ?? "Local\\GameBuddy-Test-PlayerJob-1",
    aiJobName: input.aiJobName ?? "Local\\GameBuddy-Test-AiJob-1",
  };
}

function expectedOwnedRecord(input: Readonly<{
  bootstrapId?: string;
  playerId?: string;
  companionId?: string;
  playerHostGeneration?: string;
  aiGeneration?: string;
  expiresAtMs?: number;
  state?: "reserved" | "quarantined";
}> = {}) {
  const state = input.state ?? "reserved";
  return {
    schema: OWNER_SCHEMA,
    bootstrapId: input.bootstrapId ?? "bootstrap-1",
    playerId: input.playerId ?? "player-1",
    companionId: input.companionId ?? "companion-1",
    guardian: expectedGuardianBinding(),
    ownerRecordRevision: state === "quarantined" ? 2 : 1,
    state,
    guardianState: state === "reserved" ? "reserved" : "quarantined",
    playerHostState: state === "reserved" ? "reserved" : "quarantined",
    aiClientState: state === "reserved" ? "reserved" : "quarantined",
    recoveryInstanceId: null,
     playerHost: {
      kind: "launch_reserved",
      launchGeneration: input.playerHostGeneration ?? "player-generation-1",
    },
    aiClient: {
      kind: "launch_reserved",
      launchGeneration: input.aiGeneration ?? "generation-1",
    },
    expiresAtMs: input.expiresAtMs ?? 5_000,
    cleanupDisposition: state === "reserved" ? "pending" : "retry_required",
    managedPaths: [OWNER_FILE],
  };
}

function expectedRecord(input: Readonly<{
  bootstrapId?: string;
  playerId?: string;
  companionId?: string;
  generation?: string;
  expiresAtMs?: number;
  state?: "reserved" | "quarantined";
}> = {}) {
  const state = input.state ?? "reserved";
  return {
    schema: OWNER_SCHEMA,
    bootstrapId: input.bootstrapId ?? "bootstrap-1",
    playerId: input.playerId ?? "player-1",
    companionId: input.companionId ?? "companion-1",
    guardian: expectedGuardianBinding(),
    ownerRecordRevision: state === "quarantined" ? 2 : 1,
    state,
    guardianState: state === "reserved" ? "reserved" : "quarantined",
    playerHostState: state === "reserved" ? "reserved" : "quarantined",
    aiClientState: state === "reserved" ? "reserved" : "quarantined",
    recoveryInstanceId: null,
     playerHost: { kind: "external_unattested" },
    aiClient: {
      kind: "launch_reserved",
      launchGeneration: input.generation ?? "generation-1",
    },
    expiresAtMs: input.expiresAtMs ?? 5_000,
    cleanupDisposition: state === "reserved" ? "pending" : "retry_required",
    managedPaths: [OWNER_FILE],
  };
}

test("v4 owner transition CAS enforces legal lifecycle transitions, immutable fences, and exact revisions", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const owner = await reserveFresh(harness, root);
  const transitions = createOwnerTransitions(harness, {
    ownerPath: ownerPath(root),
    containmentRoot: root,
    immutableFence: {
      bootstrapId: "bootstrap-1", playerId: "player-1", companionId: "companion-1",
      guardian: expectedGuardianBinding(),
    },
  });
  const armed = await transitions.arm(1);
  assert.equal(armed.ownerRecordRevision, 2);
  assert.equal(armed.guardianState, "armed");
  assert.equal(armed.playerHostState, "armed");
  assert.equal(armed.aiClientState, "armed");
  const active = await transitions.activate("playerHost", 2);
  assert.equal(active.ownerRecordRevision, 3);
  assert.equal(active.playerHostState, "active");
  const closing = await transitions.beginControlledClose(3);
  assert.equal(closing.ownerRecordRevision, 4);
  const playerContained = await transitions.containControlledRole("playerHost", 4);
  assert.equal(playerContained.ownerRecordRevision, 5);
  await assert.rejects(transitions.finalizeControlledContained(5), /transition_invalid/);
  const bothContained = await transitions.containControlledRole("aiClient", 5);
  const final = await transitions.finalizeControlledContained(bothContained.ownerRecordRevision);
  assert.equal(final.ownerRecordRevision, 7);
  assert.equal(final.state, "contained");
  await assert.rejects(transitions.arm(1), /transition_mismatch/);
  await assert.rejects(transitions.beginRecovery(7, "recovery-1"), /transition_invalid/);
});

test("v4 recovery CAS binds the exact recovery actor and only finalizes both contained roles", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const owner = await reserveFresh(harness, root);
  const transition = createOwnerTransitions(harness, {
    ownerPath: ownerPath(root), containmentRoot: root,
    immutableFence: { bootstrapId: "bootstrap-1", playerId: "player-1", companionId: "companion-1", guardian: expectedGuardianBinding() },
  });
  const recovering = await transition.beginRecovery(1, "recovery-1");
  const partial = await transition.containRecoveringRole("playerHost", 2, "recovery-1");
  assert.equal(partial.playerHostState, "contained");
  assert.equal(partial.aiClientState, "reserved");
  await assert.rejects(transition.containRecoveringRole("aiClient", 3, "recovery-2"), /transition_mismatch/);
  await assert.rejects(transition.finalizeRecoveredContained(3, "recovery-1"), /transition_invalid/);
  const both = await transition.containRecoveringRole("aiClient", 3, "recovery-1");
  const final = await transition.finalizeRecoveredContained(both.ownerRecordRevision, "recovery-1");
  assert.equal(final.state, "contained");
  assert.equal(final.ownerRecordRevision, 5);
});

test("v4 recovery quarantine requires its exact actor, preserves contained roles, and clears it only in terminal successor", async () => {
  const harness = createHarness();
  const root = await createRoot();
  await reserveFresh(harness, root);
  const path = ownerPath(root);
  const transition = createOwnerTransitions(harness, {
    ownerPath: path, containmentRoot: root,
    immutableFence: { bootstrapId: "bootstrap-1", playerId: "player-1", companionId: "companion-1", guardian: expectedGuardianBinding() },
  });
  const recovering = await transition.beginRecovery(1, "recovery-1");
  const partial = await transition.containRecoveringRole("playerHost", recovering.ownerRecordRevision, "recovery-1");
  const preservedBytes = await readFile(path, "utf8");
  await assert.rejects(transition.quarantine(partial.ownerRecordRevision), /transition_invalid/);
  assert.equal(await readFile(path, "utf8"), preservedBytes, "generic quarantine must not rewrite recovery bytes");
  await assert.rejects(transition.quarantineRecovery(partial.ownerRecordRevision, "recovery-2"), /transition_mismatch/);
  assert.equal(await readFile(path, "utf8"), preservedBytes, "wrong recovery actor must not rewrite bytes");
  await assert.rejects(transition.quarantineRecovery(partial.ownerRecordRevision - 1, "recovery-1"), /transition_mismatch/);
  assert.equal(await readFile(path, "utf8"), preservedBytes, "stale recovery revision must not rewrite bytes");
  const quarantined = await transition.quarantineRecovery(partial.ownerRecordRevision, "recovery-1");
  assert.deepEqual({ state: quarantined.state, guardian: quarantined.guardianState, player: quarantined.playerHostState, ai: quarantined.aiClientState, recovery: quarantined.recoveryInstanceId },
    { state: "quarantined", guardian: "quarantined", player: "contained", ai: "quarantined", recovery: null });
});

test("v4 CAS rejects stale, v3, altered-fence, illegal in-memory successors, and unreachable bytes without changing prior bytes", async () => {
  const harness = createHarness();
  const root = await createRoot();
  await reserveFresh(harness, root);
  const path = ownerPath(root);
  const transition = createOwnerTransitions(harness, {
    ownerPath: path, containmentRoot: root,
    immutableFence: { bootstrapId: "bootstrap-1", playerId: "player-1", companionId: "companion-1", guardian: expectedGuardianBinding() },
  });
  const initialBytes = await readFile(path, "utf8");
  await assert.rejects(transition.activate("playerHost", 1), /transition_invalid/);
  assert.equal(await readFile(path, "utf8"), initialBytes, "illegal successor must not write");
  await assert.rejects(transition.arm(2), /transition_mismatch/);
  assert.equal(await readFile(path, "utf8"), initialBytes, "stale revision must not write");
  await writeFile(path, initialBytes.replace("/v4", "/v3"), "utf8");
  const v3Bytes = await readFile(path, "utf8");
  await assert.rejects(transition.arm(1), /invalid_stardew_bootstrap_owner/);
  assert.equal(await readFile(path, "utf8"), v3Bytes, "explicit v3 is never rewritten");
  await writeFile(path, initialBytes, "utf8");
  await writeFile(path, initialBytes.replace("\"bindingRevision\":\"revision-1\"", "\"bindingRevision\":\"altered-guardian\""), "utf8");
  const alteredBytes = await readFile(path, "utf8");
  await assert.rejects(transition.arm(1), /transition_mismatch/);
  assert.equal(await readFile(path, "utf8"), alteredBytes, "immutable-fence mismatch must not write");
  for (const unreachable of [
    { ...expectedRecord(), state: "recovering", guardianState: "recovering", recoveryInstanceId: "recovery-1", playerHostState: "reserved", aiClientState: "active" },
    { ...expectedRecord(), state: "recovering", guardianState: "recovering", recoveryInstanceId: "recovery-1", playerHostState: "armed", aiClientState: "closing" },
    { ...expectedRecord(), state: "recovering", guardianState: "recovering", recoveryInstanceId: "recovery-1", playerHostState: "closing", aiClientState: "active" },
    { ...expectedRecord(), guardianState: "armed", playerHostState: "reserved", aiClientState: "armed" },
  ]) {
    await writeFile(path, `${JSON.stringify(unreachable)}\n`, "utf8");
    const unreachableBytes = await readFile(path, "utf8");
    await assert.rejects(transition.quarantine(1), /invalid_stardew_bootstrap_owner/);
    assert.equal(await readFile(path, "utf8"), unreachableBytes, "unreachable predecessor is never rewritten");
  }
});

test("v4 recovery CAS rejects takeover and requires its exact actor for every recovery mutation", async () => {
  const harness = createHarness();
  const root = await createRoot();
  await reserveFresh(harness, root);
  const transition = createOwnerTransitions(harness, {
    ownerPath: ownerPath(root), containmentRoot: root,
    immutableFence: { bootstrapId: "bootstrap-1", playerId: "player-1", companionId: "companion-1", guardian: expectedGuardianBinding() },
  });
  const recovering = await transition.beginRecovery(1, "recovery-1");
  await assert.rejects(transition.beginRecovery(recovering.ownerRecordRevision, "recovery-2"), /transition_invalid/);
  await assert.rejects(transition.containRecoveringRole("playerHost", recovering.ownerRecordRevision, "recovery-2"), /transition_mismatch/);
  await assert.rejects(transition.finalizeRecoveredContained(recovering.ownerRecordRevision, "recovery-2"), /transition_mismatch/);
});

test("v4 owner quarantine is monotonic, fence-bound, preserves contained roles, and strict-rereads", async () => {
  const harness = createHarness();
  const root = await createRoot();
  await reserveFresh(harness, root);
  const transition = createOwnerTransitions(harness, {
    ownerPath: ownerPath(root), containmentRoot: root,
    immutableFence: { bootstrapId: "bootstrap-1", playerId: "player-1", companionId: "companion-1", guardian: expectedGuardianBinding() },
  });
  const quarantined = await transition.quarantine(1);
  assert.equal(quarantined.ownerRecordRevision, 2);
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.cleanupDisposition, "retry_required");
  await assert.rejects(transition.quarantine(1), /transition_mismatch/);
  const alteredFence = createOwnerTransitions(harness, {
    ownerPath: ownerPath(root), containmentRoot: root,
    immutableFence: { bootstrapId: "bootstrap-1", playerId: "player-1", companionId: "companion-1", guardian: expectedGuardianBinding({ revision: "other" }) },
  });
  await assert.rejects(alteredFence.quarantine(2), /transition_mismatch/);
  assert.equal(Object.isFrozen(quarantined), true);
  assert.equal(Object.isFrozen(quarantined.guardian), true);
});

test("public composer declaration excludes guardian native record facts", async () => {
  const source = await readFile(join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "src"), "stardew-private-bootstrap-composer.ts"), "utf8");
  for (const forbidden of ["StardewGuardianBinding", "StardewPrivateBootstrapOwnerRecord", "StardewExternalPlayerHostBootstrapOwnerRecord", "StardewOwnedPlayerHostBootstrapOwnerRecord", "leaseName", "playerJobName", "aiJobName", "ownerRecordRevision", "schema"]) assert.equal(source.includes(forbidden), false, forbidden);
});

test("production composer exports no testing or Phase-B staging entry", () => {
  assert.deepEqual(Object.keys(productionComposer), ["createStardewPrivateBootstrapComposition"]);
  for (const forbidden of ["Testing", "testing", "Stage", "stage", "Dependencies", "dependencies"]) {
    assert.equal(Object.keys(productionComposer).some((key) => key.includes(forbidden)), false);
  }
});

test("production core namespace has no injectable owner-transition testing factory", () => {
  assert.equal("createStardewBootstrapOwnerTransitionPrimitivesForTesting" in productionCore, false);
  assert.equal(Object.keys(productionCore).some((key) => /OwnerTransitionPersistence|TransitionPrimitivesForTesting/.test(key)), false);
});

test("production internal exports no testing constructor, raw owner view, or binder", () => {
  assert.deepEqual(Object.keys(internalComposer).sort(), [
    "consumeOwnedPlayerHostPhaseAOwner",
    "createStardewPrivateBootstrapComposition",
    "stageOwnedPlayerHostPhaseB",
     "terminalizeOwnedPlayerHostPhaseAOwner",
  ]);
  for (const forbidden of ["Testing", "testing", "Test", "test", "View", "view", "Bind", "bind", "Raw", "raw"]) {
    assert.equal(Object.keys(internalComposer).some((key) => key.includes(forbidden)), false);
  }
  assert.equal(internalComposer.stageOwnedPlayerHostPhaseB.length, 1);
  assert.equal("createOwnedPlayerHostAttachmentFlow" in internalComposer, false);
  assert.equal("createOwnedPlayerHostAttachmentFlow" in productionComposer, false);
  assert.equal("launchOwnedPlayerHostStageC" in internalComposer, false);
  assert.equal("launchOwnedPlayerHostStageC" in productionComposer, false);
  assert.equal("materializeAiClientProfileAfterManifestAdmission" in internalComposer, false);
  assert.equal("materializeAiClientProfileAfterManifestAdmission" in productionComposer, false);
  assert.equal("launchOwnedPlayerHostStageCForTesting" in internalComposer, false);
  assert.equal("launchOwnedPlayerHostStageCForTesting" in productionComposer, false);
  assert.deepEqual(Object.keys(composerTestSupport).sort(), [
    "bindStardewPrivateBootstrapOwnerTestSupport",
    "consumeStagedOwnedPlayerHostPhaseBForTesting",
    "createStardewPrivateBootstrapComposerTestSupport",
    "launchOwnedPlayerHostStageCForTesting",
  ]);
  assert.deepEqual(Object.keys(composerTestSupportInternal).sort(), [
    "bindStardewPrivateBootstrapOwnerTestSupport",
    "consumeOwnedFarmhandBridgeConnectionForTesting",
    "consumeStagedOwnedPlayerHostPhaseBForTesting",
    "createOwnerTransitionsForTesting",
    "createStardewPrivateBootstrapCompositionForTesting",
    "launchOwnedAiClientStageDForTesting",
    "launchOwnedPlayerHostStageCForTesting",
    "materializeAiClientProfileAfterManifestAdmissionForTesting",
  ]);
  assert.equal("materializeAiClientProfileAfterManifestAdmissionForTesting" in composerTestSupport, false);
  assert.equal("materializeAiClientProfileAfterManifestAdmissionForTesting" in composerTestSupportInternal, true);
  assert.equal(typeof composerTestSupportInternal.materializeAiClientProfileAfterManifestAdmissionForTesting, "function");
});

test("only the production internal and dedicated test-only adapter import the composer core", async () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const leaves = (await readdir(sourceRoot, { recursive: true }))
    .map((leaf) => leaf.replaceAll("\\", "/"))
    .filter((leaf) => leaf.endsWith(".ts"));
  const coreImporters: string[] = [];
  const testInternalImporters: string[] = [];
  for (const leaf of leaves) {
    const source = await readFile(join(sourceRoot, leaf), "utf8");
    if (/from\s+["'][^"']*stardew-private-bootstrap-composer\.core\.js["']/.test(source)) coreImporters.push(leaf);
    if (/from\s+["'][^"']*stardew-private-bootstrap-composer\.test-support-internal\.js["']/.test(source)) {
      testInternalImporters.push(leaf);
    }
  }
  const publicComposerSource = await readFile(join(sourceRoot, "stardew-private-bootstrap-composer.ts"), "utf8");
  assert.match(publicComposerSource, /return Object\.freeze\(\{/);
  for (const member of [
    "broker: composition.broker",
    "playerHostProcessOwner: composition.playerHostProcessOwner",
    "aiClientProcessOwner: composition.aiClientProcessOwner",
    "createRoleLifecycleFacade: composition.createRoleLifecycleFacade",
    "reserveExternalPlayerHostPhaseA: composition.reserveExternalPlayerHostPhaseA",
    "reserveOwnedPlayerHostPhaseA: composition.reserveOwnedPlayerHostPhaseA",
  ]) assert.equal(publicComposerSource.includes(member), true, member);
  assert.equal(publicComposerSource.includes("...composition"), false);
  assert.equal(publicComposerSource.includes("as StardewPrivateBootstrapComposition"), false);
  assert.equal(publicComposerSource.includes("launchOwnedPlayerHostStageC"), false);

   assert.deepEqual(coreImporters.sort(), [
     "stardew-bootstrap-guardian.private.test.ts",
     "stardew-bootstrap-guardian.private.ts",
     "stardew-owned-farmhand-game-session-materializer.internal.ts",
     "stardew-private-bootstrap-composer.internal.ts",
     "stardew-private-bootstrap-composer.test-support-internal.ts",
     "stardew-private-bootstrap-composer.test.ts",
     "stardew-production-lifecycle-coordinator.internal.ts",
     "stardew-production-lifecycle-coordinator.test-support-internal.ts",
   ]);
   assert.deepEqual(testInternalImporters.sort(), [
     "stardew-bootstrap-guardian.private.test.ts",
     "stardew-private-bootstrap-composer.test-support.ts",
    "stardew-private-bootstrap-composer.test.ts",
    "stardew-production-lifecycle-coordinator.internal.test.ts",
    "stardew-production-lifecycle-coordinator.test-support-internal.ts",
  ]);
   const productionCoreSource = await readFile(join(sourceRoot, "stardew-private-bootstrap-composer.core.ts"), "utf8");
   const productionInternal = await readFile(join(sourceRoot, "stardew-private-bootstrap-composer.internal.ts"), "utf8");
    assert.doesNotMatch(productionCoreSource, /from\s+["'][^"']*stardew-bootstrap-guardian\.private\.js["']/);
    assert.doesNotMatch(productionCoreSource, /export\s+(?:type\s+)?(?:function|type)\s+(?:createStardewBootstrapOwnerTransitionPrimitivesForTesting|OwnerTransitionPersistence)/);
   assert.doesNotMatch(productionInternal, /test-support|ForTesting|TestView|TestingComposition/);
});

test("production internal composition exposes only the private C1 materializer while public facade remains unchanged", () => {
  if (process.platform !== "win32") return;
  const internal = internalComposer.createStardewPrivateBootstrapComposition();
  assert.deepEqual(Object.keys(internal).sort(), [
    "composition",
    "consumeOwnedFarmhandBridgeConnection",
    "createOwnedPlayerHostAttachmentFlow",
    "createOwnedPlayerHostManifestHandoffCoordinator",
    "createStardewBootstrapGuardianOwner",
    "launchOwnedAiClientStageD",
    "launchOwnedPlayerHostStageC",
    "materializeAiClientProfileAfterManifestAdmission",
    "quarantineOwnedPlayerHostOwner",
    "readAndCorrelateOwnedPlayerHostSession",
    "reserveOwnedPlayerHostPhaseAForActivation",
    "stageOwnedPlayerHostPhaseB",
    "terminalizeOwnedPlayerHostOwner",
  ].sort());
  assert.equal(typeof internal.materializeAiClientProfileAfterManifestAdmission, "function");
  assert.equal(typeof internal.quarantineOwnedPlayerHostOwner, "function");
  assert.deepEqual(Object.keys(internal.composition).sort(), [
    "aiClientProcessOwner",
    "broker",
    "createRoleLifecycleFacade",
    "playerHostProcessOwner",
    "reserveExternalPlayerHostPhaseA",
    "reserveOwnedPlayerHostPhaseA",
  ]);
  assert.equal("quarantineOwnedPlayerHostOwner" in productionComposer, false);
  assert.equal("quarantineOwnedPlayerHostOwner" in internal.composition, false);
  assert.equal("materializeAiClientProfileAfterManifestAdmission" in productionComposer, false);
});

test("closed composition has exact public keys and no registrar, launch, or persistence callback", () => {
  const { composition } = createHarness();

  assert.equal(Object.isFrozen(composition), true);
  assert.deepEqual(Object.keys(composition).sort(), [
    "aiClientProcessOwner",
    "broker",
    "createRoleLifecycleFacade",
    "playerHostProcessOwner",
    "reserveExternalPlayerHostPhaseA",
     "reserveOwnedPlayerHostPhaseA",
   ]);
  for (const forbidden of ["register", "registrar", "persist", "launch", "rawSpawn", "rawProbe"]) {
    assert.equal(forbidden in composition, false);
  }
  assert.deepEqual(Object.keys(composition.broker).sort(), ["close", "confirm"]);
  assert.deepEqual(Object.keys(composition.aiClientProcessOwner).sort(), [
    "readStatus",
    "reserveAiClientLaunch",
    "stopOwnedAiClient",
  ]);
  assert.deepEqual(Object.keys(composition.playerHostProcessOwner).sort(), [
    "readStatus",
    "reservePlayerHostLaunch",
    "stopOwnedPlayerHost",
  ]);
});

test("role lifecycle facade closes over this composition's exact AI owner", async () => {
  const left = createHarness();
  const right = createHarness();
  const attachment = new StardewAttachmentFlow({
    sessionDirectory: await createRoot("gamebuddy-lifecycle-attachment-"),
    sessionToken: "session-token-012345",
    companionId: "companion-1",
    nowMs: () => 1_000,
  });
  const facade = left.composition.createRoleLifecycleFacade(attachment);

  assert.deepEqual(Reflect.ownKeys(facade), []);
  assert.equal("aiClientProcessOwner" in facade, false);
  assert.equal("reserveAiClientLaunch" in facade, false);
  assert.equal("launch" in facade, false);
  assert.deepEqual((await facade.readRoleLifecycleView()).aiClient, {
    state: "not_started",
    ownership: "none",
  });

  const rightOwner = await reserveFresh(right, await createRoot("gamebuddy-lifecycle-right-"));
  rightOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["right"] }));
  assert.deepEqual((await facade.readRoleLifecycleView()).aiClient, {
    state: "not_started",
    ownership: "none",
  });

  const leftOwner = await reserveFresh(left, await createRoot("gamebuddy-lifecycle-left-"));
  leftOwner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["left"] }));
  assert.deepEqual((await facade.readRoleLifecycleView()).aiClient, {
    state: "awaiting_attestation",
    ownership: "gamebuddy_direct_spawn",
    lastStopOutcome: "none",
  });

  assert.deepEqual(facade.stopOwnedAiClient(), { kind: "terminated", killed: true });
  assert.deepEqual((await facade.readRoleLifecycleView()).aiClient, {
    state: "stopped",
    ownership: "gamebuddy_direct_spawn",
  });
});

test("test-support accepts only raw OS, identity, and clock dependencies", () => {
  const base = {
    rawSpawn: (() => { throw new Error("unused"); }) as StardewAiClientProcessSpawn,
    rawProbe: (() => null) as StardewAiClientProcessProbe,
    rawPlayerHostSpawn: (() => { throw new Error("unused"); }) as StardewAiClientProcessSpawn,
    rawPlayerHostProbe: (() => null) as StardewAiClientProcessProbe,
     createBootstrapIdentity: () => "bootstrap-1",
     createGuardianRevision: () => "revision-1",
     createGuardianInstanceId: () => "guardian-instance-1",
     createGuardianEpoch: () => 1,
     createGuardianLeaseName: () => "Local\\GameBuddy-Test-Lease-1",
     createGuardianPlayerJobName: () => "Local\\GameBuddy-Test-PlayerJob-1",
     createGuardianAiJobName: () => "Local\\GameBuddy-Test-AiJob-1",
     createLaunchGeneration: () => "generation-1",
    createPlayerHostLaunchGeneration: () => "player-generation-1",
    nowMs: () => 1_000,
  };

  assert.throws(
    () => createStardewPrivateBootstrapComposerTestSupport({ ...base, persist: () => undefined } as never),
    /invalid_stardew_private_bootstrap_testing_dependencies/,
  );
  assert.throws(
    () => createStardewPrivateBootstrapComposerTestSupport({ ...base, registrar: () => undefined } as never),
    /invalid_stardew_private_bootstrap_testing_dependencies/,
  );
  assert.throws(
    () => createStardewPrivateBootstrapComposerTestSupport({
      ...base,
      staging: {
        readPackage: async () => ({ root: resolve("/verified-package"), entries: [] }),
        createSecret: () => "session-secret-012345",
        createPipeName: () => "legacy-bridge-pipe",
        nowMs: () => 1_000,
      },
    } as never),
    /invalid_stardew_private_bootstrap_testing_dependencies/,
  );
  const composition = createStardewPrivateBootstrapComposerTestSupport(base);
  assert.deepEqual(Object.keys(composition).sort(), [
    "aiClientProcessOwner",
    "broker",
    "createRoleLifecycleFacade",
    "playerHostProcessOwner",
    "reserveExternalPlayerHostPhaseA",
    "reserveOwnedPlayerHostPhaseA",
  ]);
});

test("exact internal claim/reservation pair writes only the v4 external-player/manager-generation record", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const owner = await reserveFresh(harness, root);

  const persisted = JSON.parse(await readFile(ownerPath(root), "utf8"));
  assert.deepEqual(persisted, expectedRecord());
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner).sort(), ["consumeAiClientLaunch", "quarantine"]);
  for (const forbidden of ["record", "transactionDirectory", "guardian", "leaseName", "playerJobName", "aiJobName"]) {
    assert.equal(forbidden in owner, false);
  }
});

test("owner persistence generates exact single-separator Local guardian names before its durable reread", async () => {
  const harness = createHarness({
    guardianRevisions: ["guardian-revision-1"],
    guardianLeaseNames: ["Local\\lease_name"],
    guardianPlayerJobNames: ["Local\\player_job_name"],
    guardianAiJobNames: ["Local\\ai_job_name"],
  });
  const root = await createRoot();
  const owner = await reserveFresh(harness, root);

  assert.deepEqual(JSON.parse(await readFile(ownerPath(root), "utf8")).guardian, {
    bindingRevision: "guardian-revision-1",
    guardianInstanceId: "guardian-instance-1",
    guardianEpoch: 1,
    leaseName: "Local\\lease_name",
    playerJobName: "Local\\player_job_name",
    aiJobName: "Local\\ai_job_name",
  });
});

test("owner persistence rejects invalid or non-distinct Guardian identities before writing owner.json", async () => {
  for (const input of [
    { guardianLeaseNames: ["Local\\\\double_separator"] },
    { guardianPlayerJobNames: ["Global\\wrong_namespace"] },
    { guardianAiJobNames: ["Local\\lease_name"], guardianLeaseNames: ["Local\\lease_name"] },
  ]) {
    const harness = createHarness(input);
    const root = await createRoot();
    await assert.rejects(reserveFresh(harness, root), /invalid_stardew_guardian_binding/);
    await assert.rejects(readFile(ownerPath(root), "utf8"), /ENOENT/);
  }
});

test("owned Phase A binds exact nominal triple and durably rereads both manager generations", async () => {
  const harness = createHarness({
    launchGenerations: ["ai-exact-generation"],
    playerHostLaunchGenerations: ["player-exact-generation"],
  });
  const root = await createRoot();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root,
    triple.claim,
    triple.playerHostReservation,
    triple.aiClientReservation,
  );
  const expected = expectedOwnedRecord({
    playerHostGeneration: "player-exact-generation",
    aiGeneration: "ai-exact-generation",
  });

  assert.deepEqual(ownerTestView(owner).record, expected);
  assert.equal(Object.isFrozen(owner), true);
  assert.equal(Object.isFrozen(ownerTestView(owner).record.playerHost), true);
  assert.equal(Object.isFrozen(ownerTestView(owner).record.aiClient), true);
  assert.deepEqual(JSON.parse(await readFile(ownerPath(root), "utf8")), expected);
  assert.deepEqual(Reflect.ownKeys(owner), []);
  assert.equal(Object.getPrototypeOf(owner), Object.prototype);
  const serialized = JSON.stringify(ownerTestView(owner).record);
  for (const forbidden of ["browserSessionId", "pid", "creationDate", "executable", "args"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("internal owned quarantine is exact-composition, retryable after persistence uncertainty, and absent publicly", async () => {
  const leftHarness = createHarness();
  const rightHarness = createHarness({ bootstrapIds: ["right-quarantine-bootstrap"] });
  const left = createStardewPrivateBootstrapCompositionForTesting(leftHarness.dependencies);
  const right = createStardewPrivateBootstrapCompositionForTesting(rightHarness.dependencies);
  const root = await createRoot();
  const triple = mintOwnedTriple(left.composition);
  const owner = await left.composition.reserveOwnedPlayerHostPhaseA(
    root,
    triple.claim,
    triple.playerHostReservation,
    triple.aiClientReservation,
  );

  assert.throws(
    () => right.quarantineOwnedPlayerHostOwner(owner),
    /stardew_owned_phase_a_owner_not_registered/,
  );
  assert.throws(
    () => left.quarantineOwnedPlayerHostOwner(Object.freeze({}) as StardewOwnedPlayerHostPhaseAOwner),
    /stardew_owned_phase_a_owner_not_registered/,
  );

  const expectedReserved = expectedOwnedRecord();
  await writeFile(ownerPath(root), "{corrupt", "utf8");
  const first = left.quarantineOwnedPlayerHostOwner(owner);
  const concurrent = left.quarantineOwnedPlayerHostOwner(owner);
  assert.equal(first, concurrent);
  await assert.rejects(first, /Unexpected token|JSON/);
  await assert.rejects(concurrent, /Unexpected token|JSON/);

  const ownerView = left.bindOwnedPlayerHostPhaseAOwner(owner);
  assert.equal(ownerView.hasPrivateMaterial(), false);
  assert.throws(
    () => ownerView.consumePlayerHostLaunch(() => undefined),
    /stardew_player_host_launch_not_available/,
  );
  assert.throws(
    () => ownerView.consumeAiClientLaunch(() => undefined),
    /stardew_ai_client_launch_not_available/,
  );

  await writeFile(ownerPath(root), `${JSON.stringify(expectedReserved)}\n`, "utf8");
  await left.quarantineOwnedPlayerHostOwner(owner);
  assert.deepEqual(JSON.parse(await readFile(ownerPath(root), "utf8")), expectedOwnedRecord({ state: "quarantined" }));
  await left.quarantineOwnedPlayerHostOwner(owner);

  assert.equal("quarantineOwnedPlayerHostOwner" in left.composition, false);
  assert.equal("quarantineOwnedPlayerHostOwner" in productionComposer, false);
});

test("owned public owner is frozen, empty, and has no record, path, quarantine, or raw launch reachability", async () => {
const harness = createHarness();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );

  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner), []);
  for (const forbidden of [
    "record", "transactionDirectory", "quarantine", "consumePlayerHostLaunch", "consumeAiClientLaunch",
  ]) assert.equal(forbidden in owner, false);
  assert.equal(JSON.stringify(owner), "{}");
});

test("bound test support rejects forged and cross-composition owners before raw spawn", async () => {
  const left = createHarness();
  const right = createHarness();
  const triple = mintOwnedTriple(left.composition);
  const owner = await left.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );

  assert.throws(
    () => bindStardewPrivateBootstrapOwnerTestSupport(Object.freeze({}) as typeof owner, left.composition),
    /stardew_owned_phase_a_owner_not_registered/,
  );
  assert.throws(
    () => bindStardewPrivateBootstrapOwnerTestSupport(owner, right.composition),
    /stardew_owned_phase_a_owner_not_registered/,
  );
  assert.deepEqual(left.playerHostSpawnCalls, []);
  assert.deepEqual(right.playerHostSpawnCalls, []);
});

test("owned Phase A rejects structural and cross-composition identities for all three inputs", async () => {
  const left = createHarness({ bootstrapIds: ["left-bootstrap"] });
  const right = createHarness({ bootstrapIds: ["right-bootstrap"] });
  const leftTriple = mintOwnedTriple(left.composition);
  const rightTriple = mintOwnedTriple(right.composition);
  const structuralClaim = Object.freeze({}) as StardewPlayerHostBootstrapClaim;
  const structuralPlayer = Object.freeze({}) as StardewPlayerHostLaunchReservation;
  const structuralAi = Object.freeze({}) as StardewAiClientLaunchReservation;

  await assert.rejects(
    left.composition.reserveOwnedPlayerHostPhaseA(
      await createRoot(), structuralClaim, leftTriple.playerHostReservation, leftTriple.aiClientReservation,
    ),
    /stardew_bootstrap_claim_not_registered/,
  );
  await assert.rejects(
    left.composition.reserveOwnedPlayerHostPhaseA(
      await createRoot(), leftTriple.claim, structuralPlayer, leftTriple.aiClientReservation,
    ),
    /stardew_player_host_reservation_not_registered/,
  );
  await assert.rejects(
    left.composition.reserveOwnedPlayerHostPhaseA(
      await createRoot(), leftTriple.claim, leftTriple.playerHostReservation, structuralAi,
    ),
    /stardew_ai_client_reservation_not_registered/,
  );
  await assert.rejects(
    left.composition.reserveOwnedPlayerHostPhaseA(
      await createRoot(), rightTriple.claim, leftTriple.playerHostReservation, leftTriple.aiClientReservation,
    ),
    /stardew_bootstrap_claim_not_registered/,
  );
  await assert.rejects(
    left.composition.reserveOwnedPlayerHostPhaseA(
      await createRoot(), leftTriple.claim, rightTriple.playerHostReservation, leftTriple.aiClientReservation,
    ),
    /stardew_player_host_reservation_not_registered/,
  );
  await assert.rejects(
    left.composition.reserveOwnedPlayerHostPhaseA(
      await createRoot(), leftTriple.claim, leftTriple.playerHostReservation, rightTriple.aiClientReservation,
    ),
    /stardew_ai_client_reservation_not_registered/,
  );
});

test("owned Phase A returns only after durable reread and rejects malformed persisted bytes", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const path = ownerPath(root);
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolveGate) => { releaseRead = resolveGate; });
  let rereadObserved = false;
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(() => helperChild(async (request) => {
    if (request.operation === "release_owned_lock") {
      await rm(requestPath(request), { force: true });
      await writeFile(path, "{not-json", "utf8");
      rereadObserved = true;
      await readGate;
      return "released";
    }
    return "indeterminate";
  })));
  const triple = mintOwnedTriple(harness.composition);
  let settled = false;
  const pending = harness.composition.reserveOwnedPlayerHostPhaseA(
    root,
    triple.claim,
    triple.playerHostReservation,
    triple.aiClientReservation,
  ).finally(() => { settled = true; });

  await waitFor(() => rereadObserved);
  assert.equal(settled, false);
  releaseRead();
  await assert.rejects(pending, /Unexpected token|JSON/);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("owned Phase A synchronously binds exact triple so concurrent reserve has one winner", async () => {
  const harness = createHarness();
  const triple = mintOwnedTriple(harness.composition);
  const results = await Promise.allSettled([
    harness.composition.reserveOwnedPlayerHostPhaseA(
      await createRoot(), triple.claim, triple.playerHostReservation, triple.aiClientReservation,
    ),
    harness.composition.reserveOwnedPlayerHostPhaseA(
      await createRoot(), triple.claim, triple.playerHostReservation, triple.aiClientReservation,
    ),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.match(String(rejected?.reason), /stardew_bootstrap_claim_not_available/);
});

test("cross-topology race binds one exact AI reservation to only one durable transaction", async () => {
  const harness = createHarness({
    bootstrapIds: ["owned-bootstrap", "external-bootstrap"],
    launchGenerations: ["shared-ai-generation"],
    playerHostLaunchGenerations: ["owned-player-generation"],
  });
  const ownedClaim = harness.composition.broker.confirm({
    playerId: "owned-player",
    companionId: "owned-companion",
    browserSessionId: "owned-browser",
    expiresAtMs: 5_000,
  }).consume("owned-browser");
  const externalClaim = harness.composition.broker.confirm({
    playerId: "external-player",
    companionId: "external-companion",
    browserSessionId: "external-browser",
    expiresAtMs: 5_000,
  }).consume("external-browser");
  const playerHostReservation = harness.composition.playerHostProcessOwner.reservePlayerHostLaunch();
  const sharedAiReservation = harness.composition.aiClientProcessOwner.reserveAiClientLaunch();
  const ownedRoot = await createRoot();
  const externalRoot = await createRoot();

  const results = await Promise.allSettled([
    harness.composition.reserveOwnedPlayerHostPhaseA(
      ownedRoot,
      ownedClaim,
      playerHostReservation,
      sharedAiReservation,
    ),
    harness.composition.reserveExternalPlayerHostPhaseA(
      externalRoot,
      externalClaim,
      sharedAiReservation,
    ),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  if (results[0]?.status !== "fulfilled" || results[1]?.status !== "rejected") {
    assert.fail("owned topology must synchronously bind the shared reservation first");
  }
  assert.match(String(results[1].reason), /stardew_ai_client_reservation_not_available/);
  assert.deepEqual(
    JSON.parse(await readFile(ownerPath(ownedRoot, "owned-bootstrap"), "utf8")),
    expectedOwnedRecord({
      bootstrapId: "owned-bootstrap",
      playerId: "owned-player",
      companionId: "owned-companion",
      playerHostGeneration: "owned-player-generation",
      aiGeneration: "shared-ai-generation",
    }),
  );
  await assert.rejects(
    readFile(ownerPath(externalRoot, "external-bootstrap"), "utf8"),
    { code: "ENOENT" },
  );
  await assert.rejects(
    harness.composition.reserveExternalPlayerHostPhaseA(
      await createRoot(),
      externalClaim,
      sharedAiReservation,
    ),
    /stardew_ai_client_reservation_not_available/,
  );

  ownerTestView(results[0].value).consumePlayerHostLaunch(() => undefined);
  ownerTestView(results[0].value).consumeAiClientLaunch(() => undefined);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
});

test("owned launch consumers are independently one-shot and escaped callbacks cannot replay", async () => {
  const harness = createHarness();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  let escapedPlayer: import("./stardew-private-bootstrap-composer.js").StardewPlayerHostLaunch | undefined;
  let escapedAi: import("./stardew-private-bootstrap-composer.js").StardewAiClientLaunch | undefined;

  ownerTestView(owner).consumePlayerHostLaunch((launch) => { escapedPlayer = launch; });
  ownerTestView(owner).consumeAiClientLaunch((launch) => { escapedAi = launch; });
  assert.throws(
    () => escapedPlayer?.({ executable: EXE, args: ["escaped-player"] }),
    /stardew_player_host_launch_callback_not_active/,
  );
  assert.throws(
    () => escapedAi?.({ executable: EXE, args: ["escaped-ai"] }),
    /stardew_ai_client_launch_callback_not_active/,
  );
  assert.throws(
    () => ownerTestView(owner).consumePlayerHostLaunch(() => undefined),
    /stardew_player_host_launch_not_available/,
  );
  assert.throws(
    () => ownerTestView(owner).consumeAiClientLaunch(() => undefined),
    /stardew_ai_client_launch_not_available/,
  );
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
});

test("owned quarantine synchronously closes both launches, including reentrant callback", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  let releasePersistence!: () => void;
  const persistenceGate = new Promise<void>((resolveGate) => { releasePersistence = resolveGate; });
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(() => helperChild(async (request) => {
    if (request.operation === "release_owned_lock") {
      await persistenceGate;
      await rm(requestPath(request), { force: true });
      return "released";
    }
    return "indeterminate";
  })));

  let quarantine!: Promise<void>;
  ownerTestView(owner).consumePlayerHostLaunch((launch) => {
    quarantine = ownerTestView(owner).quarantine();
    assert.equal(ownerTestView(owner).quarantine(), quarantine);
    assert.throws(
      () => launch({ executable: EXE, args: ["reentrant-player"] }),
      /stardew_player_host_launch_callback_not_active/,
    );
    assert.throws(
      () => ownerTestView(owner).consumeAiClientLaunch(() => undefined),
      /stardew_ai_client_launch_not_available/,
    );
  });
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
  releasePersistence();
  await quarantine;
  assert.deepEqual(ownerTestView(owner).record, expectedOwnedRecord({ state: "quarantined" }));
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("owned expiry after persistence quarantines record and revokes both roles", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const triple = mintOwnedTriple(harness.composition, { expiresAtMs: 1_500 });
  let ownerWritten = false;
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(() => helperChild(async (request) => {
    if (request.operation === "release_owned_lock") {
      await rm(requestPath(request), { force: true });
      if (!ownerWritten) {
        ownerWritten = true;
        harness.setNow(1_500);
      }
      return "released";
    }
    return "indeterminate";
  })));

  await assert.rejects(
    harness.composition.reserveOwnedPlayerHostPhaseA(
      root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
    ),
    /stardew_bootstrap_claim_expired_after_persistence/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(ownerPath(root), "utf8")),
    expectedOwnedRecord({ expiresAtMs: 1_500, state: "quarantined" }),
  );
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
});

test("owned expiry before either callback permanently revokes both roles", async () => {
  const harness = createHarness();
  const triple = mintOwnedTriple(harness.composition, { expiresAtMs: 1_500 });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  harness.setNow(1_500);

  assert.throws(
    () => ownerTestView(owner).consumePlayerHostLaunch(() => undefined),
    /stardew_bootstrap_owner_expired/,
  );
  assert.throws(
    () => ownerTestView(owner).consumePlayerHostLaunch(() => undefined),
    /stardew_player_host_launch_not_available/,
  );
  // The role-specific expiry closes the consumed Player Host authority; the
  // other exact role remains independently consumable until quarantine or its
  // own expiry check, which then permanently revokes it too.
  assert.throws(
    () => ownerTestView(owner).consumeAiClientLaunch(() => undefined),
    /stardew_bootstrap_owner_expired/,
  );
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("owned Phase-A binding permits only one successful consumer across independent session launcher instances", async () => {
  const harness = createHarness();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  const first = consumeOwnedPlayerHostPhaseAOwner(owner, async () => {
    await firstGate;
    return "first";
  });

  assert.throws(
    () => consumeOwnedPlayerHostPhaseAOwner(owner, () => "second"),
    /stardew_owned_phase_a_owner_not_registered/,
  );
  releaseFirst();
  assert.equal(await first, "first");
  assert.throws(
    () => consumeOwnedPlayerHostPhaseAOwner(owner, () => "replay"),
    /stardew_owned_phase_a_owner_not_registered/,
  );
});

test("failed owned Phase-A binding restores its exact owner only after settlement for a complete retry", async () => {
  const harness = createHarness();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  let rejectFirst!: (error: Error) => void;
  const failed = consumeOwnedPlayerHostPhaseAOwner(owner, () => new Promise<never>((_resolve, reject) => {
    rejectFirst = reject;
  }));

  assert.throws(
    () => consumeOwnedPlayerHostPhaseAOwner(owner, () => "while-binding"),
    /stardew_owned_phase_a_owner_not_registered/,
  );
  rejectFirst(new Error("transient binding failure"));
  await assert.rejects(failed, /transient binding failure/);
  assert.equal(consumeOwnedPlayerHostPhaseAOwner(owner, () => "retry"), "retry");
});

test("independently-created private Stage-B fixtures permit one owner binding, reject reentry, and retry only after failure settles", async () => {
  const harness = createHarness();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  let releasePre!: () => void;
  const preGate = new Promise<void>((resolveGate) => { releasePre = resolveGate; });
  const firstPlanner = createStageBTestHarness({
    recheck: async (phase) => { if (phase === "pre") await preGate; },
    verifyPackage: async () => undefined,
  });
  const secondPlanner = createStageBTestHarness({
    recheck: async () => undefined,
    verifyPackage: async () => undefined,
  });

  const first = firstPlanner.bindOwnedPhaseA(owner);
  await assert.rejects(secondPlanner.bindOwnedPhaseA(owner), /stardew_private_stage_b_failed/);
  releasePre();
  await first;
  await assert.rejects(secondPlanner.bindOwnedPhaseA(owner), /stardew_private_stage_b_failed/);

  const retryHarness = createHarness();
  const retryTriple = mintOwnedTriple(retryHarness.composition, { browserSessionId: "browser-retry" });
  const retryOwner = await retryHarness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), retryTriple.claim, retryTriple.playerHostReservation, retryTriple.aiClientReservation,
  );
  let rejectPre!: (error: Error) => void;
  const failedPlanner = createStageBTestHarness({
    recheck: async () => new Promise<void>((_resolve, reject) => { rejectPre = reject; }),
    verifyPackage: async () => undefined,
  });
  const failed = failedPlanner.bindOwnedPhaseA(retryOwner);
  await assert.rejects(secondPlanner.bindOwnedPhaseA(retryOwner), /stardew_private_stage_b_failed/);
  rejectPre(new Error("transient precheck failure"));
  await assert.rejects(failed, /stardew_private_stage_b_failed/);
  await secondPlanner.bindOwnedPhaseA(retryOwner);

  const postHarness = createHarness();
  const postTriple = mintOwnedTriple(postHarness.composition, { browserSessionId: "browser-post" });
  const postOwner = await postHarness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), postTriple.claim, postTriple.playerHostReservation, postTriple.aiClientReservation,
  );
  const rejectedPostPlanner = createStageBTestHarness({
    recheck: async (phase) => { if (phase === "post") throw new Error("post rejected"); },
    verifyPackage: async () => undefined,
  });
  await assert.rejects(rejectedPostPlanner.bindOwnedPhaseA(postOwner), /stardew_private_stage_b_failed/);
});

test("owned Player Host launch fresh-checks exact expiry inside its active callback", async () => {
  const harness = createHarness();
  const triple = mintOwnedTriple(harness.composition, { expiresAtMs: 1_500 });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );

  ownerTestView(owner).consumePlayerHostLaunch((launch) => {
    harness.setNow(1_500);
    assert.throws(
      () => launch({ executable: EXE, args: ["expired-player"] }),
      /stardew_bootstrap_owner_expired/,
    );
  });

  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.throws(
    () => ownerTestView(owner).consumePlayerHostLaunch(() => undefined),
    /stardew_player_host_launch_not_available/,
  );
});

test("owned AI launch fresh-checks exact expiry inside its active callback", async () => {
  const harness = createHarness();
  const triple = mintOwnedTriple(harness.composition, { expiresAtMs: 1_500 });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );

  ownerTestView(owner).consumeAiClientLaunch((launch) => {
    harness.setNow(1_500);
    assert.throws(
      () => launch({ executable: EXE, args: ["expired-ai"] }),
      /stardew_bootstrap_owner_expired/,
    );
  });

  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  assert.throws(
    () => ownerTestView(owner).consumeAiClientLaunch(() => undefined),
    /stardew_ai_client_launch_not_available/,
  );
});

test("owned quarantine persistence failure keeps the error primary and revokes both launches", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  await writeFile(ownerPath(root), "{corrupt", "utf8");

  const first = ownerTestView(owner).quarantine();
  const second = ownerTestView(owner).quarantine();
  assert.equal(first, second);
  await assert.rejects(first, /Unexpected token|JSON/);
  await assert.rejects(second, /Unexpected token|JSON/);
  assert.throws(
    () => ownerTestView(owner).consumePlayerHostLaunch((launch) => launch({ executable: EXE, args: ["after-failure-player"] })),
    /stardew_player_host_launch_not_available/,
  );
  assert.throws(
    () => ownerTestView(owner).consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["after-failure-ai"] })),
    /stardew_ai_client_launch_not_available/,
  );
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("owned Phase A rejects a reparse-like transaction boundary without touching target", async (t) => {
  const harness = createHarness();
  const root = await createRoot();
  const outside = await createRoot("gamebuddy-owned-bootstrap-outside-");
  await mkdir(join(root, "stardew-private-bootstrap"), { recursive: true });
  const link = join(root, "stardew-private-bootstrap", "bootstrap-1");
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (isNodeError(error) && (error.code === "EPERM" || error.code === "EACCES")) {
      t.skip("symlink/junction creation is unavailable");
      return;
    }
    throw error;
  }
  const triple = mintOwnedTriple(harness.composition);

  await assert.rejects(
    harness.composition.reserveOwnedPlayerHostPhaseA(
      root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
    ),
    /unsafe_path_boundary/,
  );
  assert.deepEqual(await readDirectory(outside), []);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("owned Phase A fails closed on occupied owner path without replacing bytes", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const triple = mintOwnedTriple(harness.composition);
  await mkdir(dirname(ownerPath(root)), { recursive: true });
  await writeFile(ownerPath(root), "foreign-owned-record", "utf8");

  await assert.rejects(
    harness.composition.reserveOwnedPlayerHostPhaseA(
      root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
    ),
    /stardew_bootstrap_owner_occupied/,
  );
  assert.equal(await readFile(ownerPath(root), "utf8"), "foreign-owned-record");
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("structural empty lookalikes and cross-composition identities are rejected", async () => {
  const left = createHarness({ bootstrapIds: ["left-bootstrap"], launchGenerations: ["left-generation"] });
  const right = createHarness({ bootstrapIds: ["right-bootstrap"], launchGenerations: ["right-generation"] });
  const root = await createRoot();
  const leftPair = mintPair(left.composition);
  const rightPair = mintPair(right.composition);

  await assert.rejects(
    left.composition.reserveExternalPlayerHostPhaseA(
      root,
      Object.freeze({}) as StardewPlayerHostBootstrapClaim,
      leftPair.reservation,
    ),
    /stardew_bootstrap_claim_not_registered/,
  );
  await assert.rejects(
    left.composition.reserveExternalPlayerHostPhaseA(
      root,
      leftPair.claim,
      Object.freeze({}) as StardewAiClientLaunchReservation,
    ),
    /stardew_ai_client_reservation_not_registered/,
  );
  await assert.rejects(
    left.composition.reserveExternalPlayerHostPhaseA(root, rightPair.claim, leftPair.reservation),
    /stardew_bootstrap_claim_not_registered/,
  );
  await assert.rejects(
    left.composition.reserveExternalPlayerHostPhaseA(root, leftPair.claim, rightPair.reservation),
    /stardew_ai_client_reservation_not_registered/,
  );
});

test("consumed claim cannot replay even when paired with a fresh reservation", async () => {
  const harness = createHarness();
  const pair = mintPair(harness.composition);
  const owner = await harness.composition.reserveExternalPlayerHostPhaseA(
    await createRoot(),
    pair.claim,
    pair.reservation,
  );
  owner.consumeAiClientLaunch(() => undefined);
  const freshReservation = harness.composition.aiClientProcessOwner.reserveAiClientLaunch();

  await assert.rejects(
    harness.composition.reserveExternalPlayerHostPhaseA(
      await createRoot(),
      pair.claim,
      freshReservation,
    ),
    /stardew_bootstrap_claim_not_available/,
  );
});

test("consumed reservation cannot replay even when paired with a fresh claim", async () => {
  const harness = createHarness();
  const pair = mintPair(harness.composition);
  const owner = await harness.composition.reserveExternalPlayerHostPhaseA(
    await createRoot(),
    pair.claim,
    pair.reservation,
  );
  owner.consumeAiClientLaunch(() => undefined);
  const freshClaim = harness.composition.broker.confirm({
    playerId: "player-2",
    companionId: "companion-2",
    browserSessionId: "browser-2",
    expiresAtMs: 5_000,
  }).consume("browser-2");

  await assert.rejects(
    harness.composition.reserveExternalPlayerHostPhaseA(
      await createRoot(),
      freshClaim,
      pair.reservation,
    ),
    /stardew_ai_client_reservation_not_available/,
  );
});

test("concurrent reserve of the exact pair has one durable winner", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const otherRoot = await createRoot();
  const pair = mintPair(harness.composition);

  const results = await Promise.allSettled([
    harness.composition.reserveExternalPlayerHostPhaseA(root, pair.claim, pair.reservation),
    harness.composition.reserveExternalPlayerHostPhaseA(otherRoot, pair.claim, pair.reservation),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.match(String(rejected?.reason), /stardew_bootstrap_claim_not_available/);
});

test("owner is returned only after durable owner.json reread and malformed persisted bytes fail closed", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const path = ownerPath(root);
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolveGate) => { releaseRead = resolveGate; });
  let rereadObserved = false;
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer((command, args) => {
    return helperChild(async (request) => {
      if (request.operation === "release_owned_lock") {
        await rm(requestPath(request), { force: true });
        await writeFile(path, "{not-json", "utf8");
        rereadObserved = true;
        await readGate;
        return "released";
      }
      return "indeterminate";
    });
  }));
  const pair = mintPair(harness.composition);
  let settled = false;
  const pending = harness.composition
    .reserveExternalPlayerHostPhaseA(root, pair.claim, pair.reservation)
    .finally(() => { settled = true; });

  await waitFor(() => rereadObserved);
  assert.equal(settled, false, "join must not resolve before the durable reread");
  releaseRead();
  await assert.rejects(pending, /Unexpected token|JSON/);
});

test("durable write failure permanently consumes the pair and revokes manager reservation", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const pair = mintPair(harness.composition);
  let sabotaged = false;
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(() => helperChild(async (request) => {
    if (request.operation === "release_owned_lock" && !sabotaged) {
      sabotaged = true;
      const transactionDirectory = dirname(requestPath(request));
      const movedDirectory = `${transactionDirectory}-moved`;
      await rename(transactionDirectory, movedDirectory);
      await writeFile(transactionDirectory, "blocks-safe-directory-recreation", "utf8");
      return "missing";
    }
    return "indeterminate";
  })));

  await assert.rejects(
    harness.composition.reserveExternalPlayerHostPhaseA(root, pair.claim, pair.reservation),
    /durable_path_lock_release_failed|ENOTDIR|unsafe_path_boundary/,
  );
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  await assert.rejects(
    harness.composition.reserveExternalPlayerHostPhaseA(await createRoot(), pair.claim, pair.reservation),
    /stardew_bootstrap_claim_not_available/,
  );
  const replacement = harness.composition.aiClientProcessOwner.reserveAiClientLaunch();
  assert.deepEqual(Reflect.ownKeys(replacement), []);
});

test("expiry after durable owner persistence quarantines, never spawns, and permanently revokes", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const pair = mintPair(harness.composition, { expiresAtMs: 1_500 });
  let ownerWritten = false;
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(() => helperChild(async (request) => {
    if (request.operation === "release_owned_lock") {
      await rm(requestPath(request), { force: true });
      if (!ownerWritten) {
        ownerWritten = true;
        harness.setNow(1_500);
      }
      return "released";
    }
    return "indeterminate";
  })));

  await assert.rejects(
    harness.composition.reserveExternalPlayerHostPhaseA(root, pair.claim, pair.reservation),
    /stardew_bootstrap_claim_expired_after_persistence/,
  );
  assert.deepEqual(JSON.parse(await readFile(ownerPath(root), "utf8")), expectedRecord({
    expiresAtMs: 1_500,
    state: "quarantined",
  }));
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("consume launch callback is one-shot and escaped launch authority cannot replay", async () => {
  const harness = createHarness();
  const owner = await reserveFresh(harness, await createRoot());
  let escaped: ((input: { executable: string; args: readonly string[] }) => unknown) | undefined;

  const callbackResult = owner.consumeAiClientLaunch((launch) => {
    escaped = launch;
    return "callback-result";
  });
  assert.equal(callbackResult, "callback-result");
  assert.deepEqual(harness.spawnCalls, []);
  assert.throws(() => escaped?.({ executable: EXE, args: ["escaped"] }), /stardew_ai_client_launch_callback_not_active/);
  assert.throws(
    () => owner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["replay"] })),
    /stardew_ai_client_launch_not_available/,
  );
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("launch callback permits exactly one invocation even before callback returns", async () => {
  const harness = createHarness();
  const owner = await reserveFresh(harness, await createRoot());

  owner.consumeAiClientLaunch((launch) => {
    const first = launch({ executable: EXE, args: ["first"] });
    assert.deepEqual(first, { status: { kind: "awaiting_ai_client_attestation" } });
    assert.throws(() => launch({ executable: EXE, args: ["second"] }), /stardew_ai_client_launch_callback_not_active/);
  });
  assert.equal(harness.spawnCalls.length, 1);
});

test("owner absolute expiry before callback revokes without spawn", async () => {
  const harness = createHarness();
  const owner = await reserveFresh(harness, await createRoot(), { expiresAtMs: 1_500 });
  harness.setNow(1_500);

  assert.throws(
    () => owner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["late"] })),
    /stardew_bootstrap_owner_expired/,
  );
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  assert.throws(() => owner.consumeAiClientLaunch(() => undefined), /stardew_ai_client_launch_not_available/);
});

test("external AI launch fresh-checks exact expiry inside its active callback", async () => {
  const harness = createHarness();
  const owner = await reserveFresh(harness, await createRoot(), { expiresAtMs: 1_500 });

  owner.consumeAiClientLaunch((launch) => {
    harness.setNow(1_500);
    assert.throws(
      () => launch({ executable: EXE, args: ["expired-external-ai"] }),
      /stardew_bootstrap_owner_expired/,
    );
  });

  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  assert.throws(
    () => owner.consumeAiClientLaunch(() => undefined),
    /stardew_ai_client_launch_not_available/,
  );
});

test("quarantine inside an active consume callback synchronously rejects launch without spawning", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const owner = await reserveFresh(harness, root);
  let releasePersistence!: () => void;
  const persistenceGate = new Promise<void>((resolveGate) => { releasePersistence = resolveGate; });
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(() => helperChild(async (request) => {
    if (request.operation === "release_owned_lock") {
      await persistenceGate;
      await rm(requestPath(request), { force: true });
      return "released";
    }
    return "indeterminate";
  })));

  let pendingQuarantine!: Promise<void>;
  owner.consumeAiClientLaunch((launch) => {
    pendingQuarantine = owner.quarantine();
    assert.equal(owner.quarantine(), pendingQuarantine);
    assert.throws(
      () => launch({ executable: EXE, args: ["quarantined-in-callback"] }),
      /stardew_ai_client_launch_callback_not_active/,
    );
  });

  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(
    harness.composition.aiClientProcessOwner.readStatus(),
    { kind: "ai_client_launch_pending" },
    "registration must remain reserved until quarantine persistence settles",
  );
  releasePersistence();
  await pendingQuarantine;
  assert.deepEqual(JSON.parse(await readFile(ownerPath(root), "utf8")), expectedRecord({ state: "quarantined" }));
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  assert.throws(
    () => owner.consumeAiClientLaunch(() => undefined),
    /stardew_ai_client_launch_not_available/,
  );
});

test("quarantine synchronously closes launch authority before its first await and repeated calls share one promise", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const owner = await reserveFresh(harness, root);
  let releasePersistence!: () => void;
  const persistenceGate = new Promise<void>((resolveGate) => { releasePersistence = resolveGate; });
  let quarantineWriteRelease = 0;
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(() => helperChild(async (request) => {
    if (request.operation === "release_owned_lock") {
      quarantineWriteRelease += 1;
      if (quarantineWriteRelease === 1) await persistenceGate;
      await rm(requestPath(request), { force: true });
      return "released";
    }
    return "indeterminate";
  })));

  const first = owner.quarantine();
  const second = owner.quarantine();
  assert.equal(first, second);
  assert.throws(
    () => owner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["raced"] })),
    /stardew_ai_client_launch_not_available/,
  );
  assert.deepEqual(harness.spawnCalls, []);
  releasePersistence();
  await first;
  await owner.quarantine();
  assert.deepEqual(JSON.parse(await readFile(ownerPath(root), "utf8")), expectedRecord({ state: "quarantined" }));
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("quarantine persistence failure preserves primary error and permanently closes/revokes", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const owner = await reserveFresh(harness, root);
  await writeFile(ownerPath(root), "{corrupt", "utf8");

  const first = owner.quarantine();
  const second = owner.quarantine();
  assert.equal(first, second);
  await assert.rejects(first, /Unexpected token|JSON/);
  await assert.rejects(second, /Unexpected token|JSON/);
  assert.throws(
    () => owner.consumeAiClientLaunch((launch) => launch({ executable: EXE, args: ["after-failure"] })),
    /stardew_ai_client_launch_not_available/,
  );
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("occupied owner directory and occupied lock both fail closed without replacing bytes", { timeout: 15_000 }, async () => {
  const occupiedHarness = createHarness();
  const occupiedRoot = await createRoot();
  const occupiedPair = mintPair(occupiedHarness.composition);
  await mkdir(dirname(ownerPath(occupiedRoot)), { recursive: true });
  await writeFile(ownerPath(occupiedRoot), "foreign-owner", "utf8");
  await assert.rejects(
    occupiedHarness.composition.reserveExternalPlayerHostPhaseA(
      occupiedRoot,
      occupiedPair.claim,
      occupiedPair.reservation,
    ),
    /stardew_bootstrap_owner_occupied/,
  );
  assert.equal(await readFile(ownerPath(occupiedRoot), "utf8"), "foreign-owner");

  const lockHarness = createHarness({ bootstrapIds: ["locked-bootstrap"] });
  const lockRoot = await createRoot();
  const lockPair = mintPair(lockHarness.composition);
  const lockedPath = ownerPath(lockRoot, "locked-bootstrap");
  await mkdir(dirname(lockedPath), { recursive: true });
  await writeFile(pathLockPath(lockedPath), "stale-malformed-lock", "utf8");
  const stale = new Date(Date.now() - 6 * 60_000);
  const { utimes } = await import("node:fs/promises");
  await utimes(pathLockPath(lockedPath), stale, stale);
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(() => helperChild(async (request) => {
    if (request.operation === "reclaim_stale_lock") return "indeterminate";
    return "indeterminate";
  })));
  await assert.rejects(
    lockHarness.composition.reserveExternalPlayerHostPhaseA(lockRoot, lockPair.claim, lockPair.reservation),
    /durable_path_lock_timeout/,
  );
  assert.equal(await readFile(pathLockPath(lockedPath), "utf8"), "stale-malformed-lock");
});

test("expiry while waiting under an occupied lock fails closed before owner write", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const path = ownerPath(root);
  const pair = mintPair(harness.composition, { expiresAtMs: 1_500 });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(pathLockPath(path), "stale-malformed-lock", "utf8");
  const stale = new Date(Date.now() - 6 * 60_000);
  const { utimes } = await import("node:fs/promises");
  await utimes(pathLockPath(path), stale, stale);
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(() => helperChild(async (request) => {
    if (request.operation === "reclaim_stale_lock") {
      harness.setNow(1_500);
      await rm(requestPath(request), { force: true });
      return "reclaimed";
    }
    await rm(requestPath(request), { force: true });
    return "released";
  })));

  await assert.rejects(
    harness.composition.reserveExternalPlayerHostPhaseA(root, pair.claim, pair.reservation),
    /stardew_bootstrap_claim_expired/,
  );
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("Phase B staging creates only the Player Host bootstrap without consuming either launch", async () => {
  const root = await createRoot();
  const packageRoot = join(root, "verified-package");
  const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
  await mkdir(packageRoot);
  for (const entry of entries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  const harness = createHarness({
    staging: {
      readPackage: async () => ({ root: packageRoot, entries }),
      createSecret: () => "session-secret-012345",
      nowMs: () => 1_000,
    },
  });
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  const stageB = createStageBTestHarness({
    recheck: async () => undefined,
    verifyPackage: async () => undefined,
  });

  await stageB.bindOwnedPhaseA(owner);
  // Test support can observe only presence: the retained material stays in the
  // private owner WeakMap and is not a config-recovery or public API surface.
  assert.equal(ownerTestView(owner).hasPrivateMaterial(), true);
  const transaction = ownerTestView(owner).transactionDirectory;
  const hostModDirectory = join(transaction, "player-host", "Mods", "GameBuddy");
  const host = JSON.parse(await readFile(join(hostModDirectory, "config.json"), "utf8"));
  assert.deepEqual(host, {
    HostFarmhandProvisioning: {
      Enable: true,
      SessionDirectory: join(transaction, "session"),
      SessionToken: "session-secret-012345",
      IntegrationVersion: "0.1.0",
      ManifestLifetimeSeconds: 120,
      AuthorizedCompanionIds: ["companion-1"],
    },
  });
  assert.deepEqual((await readdir(transaction)).sort(), [OWNER_FILE, "player-host"]);
  assert.deepEqual(await readdir(join(transaction, "player-host")), ["Mods"]);
  assert.deepEqual(await readdir(join(transaction, "player-host", "Mods")), ["GameBuddy"]);
  assert.deepEqual((await readdir(hostModDirectory)).sort(), ["config.json", ...entries].sort());
  for (const entry of entries) {
    assert.equal(await readFile(join(hostModDirectory, entry), "utf8"), `fixed-${entry}`);
  }
  const serializedConfig = JSON.stringify(host);
  for (const forbidden of [
    "BridgeToken", "PipeName", "FarmhandProvisioner", "ManifestPath", "EnableLocalBridge",
    "SaveId", "WorldId", "PlayerId", "FarmhandId", "endpoint", "Endpoint", "launchGeneration",
  ]) assert.equal(serializedConfig.includes(forbidden), false);
  assert.equal("CompanionId" in host.HostFarmhandProvisioning, false);
  assert.deepEqual(ownerTestView(owner).record.managedPaths, [
    OWNER_FILE,
    "player-host",
    "player-host/Mods",
    "player-host/Mods/GameBuddy",
    "player-host/Mods/GameBuddy/config.json",
    "player-host/Mods/GameBuddy/GameBuddy.Stardew.Core.dll",
    "player-host/Mods/GameBuddy/GameBuddy.Stardew.deps.json",
    "player-host/Mods/GameBuddy/GameBuddy.Stardew.dll",
    "player-host/Mods/GameBuddy/Raffinert.FuzzySharp.dll",
    "player-host/Mods/GameBuddy/manifest.json",
  ]);
  assert.deepEqual(ownerTestView(owner).record.playerHost, {
    kind: "launch_reserved",
    launchGeneration: "player-generation-1",
  });
  assert.deepEqual(ownerTestView(owner).record.aiClient, {
    kind: "launch_reserved",
    launchGeneration: "generation-1",
  });
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "player_host_launch_pending" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
});

test("partial Player Host package write rolls back without AI artifacts or launch consumption", async () => {
  const root = await createRoot();
  const packageRoot = join(root, "verified-package-rollback");
  const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
  await mkdir(packageRoot);
  for (const entry of entries) {
    await writeFile(join(packageRoot, entry), entry === "GameBuddy.Stardew.dll" ? "" : `fixed-${entry}`, "utf8");
  }
  const harness = createHarness({
    staging: {
      readPackage: async () => ({ root: packageRoot, entries }),
      createSecret: () => "session-secret-rollback-012345",
      nowMs: () => 1_000,
    },
  });
  const triple = mintOwnedTriple(harness.composition, { browserSessionId: "browser-rollback" });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  const stageB = createStageBTestHarness({
    recheck: async () => undefined,
    verifyPackage: async () => undefined,
  });

  await assert.rejects(stageB.bindOwnedPhaseA(owner), /stardew_private_stage_b_failed/);
  assert.equal(ownerTestView(owner).hasPrivateMaterial(), false);
  const transaction = ownerTestView(owner).transactionDirectory;
  const transactionEntries = await readdir(transaction);
  assert.equal(transactionEntries.includes("ai-client"), false);
  assert.equal(transactionEntries.includes("session"), false);
  for (const stagedFile of ["config.json", "GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json"]) {
    await assert.rejects(
      readFile(join(transaction, "player-host", "Mods", "GameBuddy", stagedFile), "utf8"),
      { code: "ENOENT" },
    );
  }
  assert.deepEqual(ownerTestView(owner).record.playerHost, {
    kind: "launch_reserved",
    launchGeneration: "player-generation-1",
  });
  assert.deepEqual(ownerTestView(owner).record.aiClient, {
    kind: "launch_reserved",
    launchGeneration: "generation-1",
  });
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("second package reread holds the owner lock through rollback before quarantine", async () => {
  const root = await createRoot();
  const packageRoot = join(root, "verified-package-reread-failure");
  const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
  const stagedFiles = ["config.json", ...entries];
  await mkdir(packageRoot);
  for (const entry of entries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  let packageReads = 0;
  let transaction = "";
  let releaseSecondReread!: () => void;
  const secondRereadGate = new Promise<void>((resolveGate) => { releaseSecondReread = resolveGate; });
  let signalSecondReread!: () => void;
  const secondRereadObserved = new Promise<void>((resolveObserved) => { signalSecondReread = resolveObserved; });
  const harness = createHarness({
    staging: {
      readPackage: async () => {
        packageReads += 1;
        if (packageReads === 2) {
          const hostModDirectory = join(transaction, "player-host", "Mods", "GameBuddy");
          for (const stagedFile of stagedFiles) {
            assert.equal((await readFile(join(hostModDirectory, stagedFile))).length > 0, true);
          }
          await writeFile(join(hostModDirectory, "unmanaged.marker"), "preserve", "utf8");
          signalSecondReread();
          await secondRereadGate;
          throw new Error("package_reread_failed");
        }
        return { root: packageRoot, entries };
      },
      createSecret: () => "session-secret-reread-012345",
      nowMs: () => 1_000,
    },
  });
  const triple = mintOwnedTriple(harness.composition, { browserSessionId: "browser-reread-failure" });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  transaction = ownerTestView(owner).transactionDirectory;
  const stageB = createStageBTestHarness({
    recheck: async () => undefined,
    verifyPackage: async () => undefined,
  });

  const staging = stageB.bindOwnedPhaseA(owner);
  await secondRereadObserved;
  let competingLockEntered = false;
  const competingLock = withPathLock(ownerPath(root), async () => {
    competingLockEntered = true;
  }, { containmentRoot: root });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(competingLockEntered, false);
  releaseSecondReread();
  await assert.rejects(staging, /stardew_private_stage_b_failed/);
  await competingLock;
  assert.equal(competingLockEntered, true);
  assert.equal(packageReads, 2);
  const hostModDirectory = join(transaction, "player-host", "Mods", "GameBuddy");
  for (const stagedFile of stagedFiles) {
    await assert.rejects(readFile(join(hostModDirectory, stagedFile)), { code: "ENOENT" });
  }
  assert.equal(await readFile(join(hostModDirectory, "unmanaged.marker"), "utf8"), "preserve");
  const transactionEntries = await readdir(transaction);
  assert.equal(transactionEntries.includes("ai-client"), false);
  assert.equal(transactionEntries.includes("session"), false);
  assert.deepEqual(ownerTestView(owner).record.playerHost, {
    kind: "launch_reserved",
    launchGeneration: "player-generation-1",
  });
  assert.deepEqual(ownerTestView(owner).record.aiClient, {
    kind: "launch_reserved",
    launchGeneration: "generation-1",
  });
  const durable = JSON.parse(await readFile(ownerPath(root), "utf8"));
  assert.equal(durable.state, "quarantined");
  assert.equal(durable.cleanupDisposition, "retry_required");
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("final post recheck after actual Phase B write quarantines durable owner and terminalizes binding", async () => {
  const root = await createRoot();
  const packageRoot = join(root, "verified-package-final-post");
  const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
  await mkdir(packageRoot);
  for (const entry of entries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  const harness = createHarness({
    staging: {
      readPackage: async () => ({ root: packageRoot, entries }),
      createSecret: () => "session-secret-final-012345",
      nowMs: () => 1_000,
    },
  });
  const triple = mintOwnedTriple(harness.composition, { browserSessionId: "browser-final-post" });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  let postChecks = 0;
  const stageB = createStageBTestHarness({
    recheck: async (phase) => {
      if (phase === "post" && ++postChecks === 2) throw new Error("final_post_recheck_failed");
    },
    verifyPackage: async () => undefined,
  });

  await assert.rejects(
    stageB.bindOwnedPhaseA(owner),
    (error: unknown) => error instanceof Error &&
      error.message === "stardew_private_stage_b_failed" &&
      !("cause" in error),
  );
  const transaction = ownerTestView(owner).transactionDirectory;
  const config = await readFile(join(transaction, "player-host", "Mods", "GameBuddy", "config.json"), "utf8");
  assert.equal(config !== "", true);
  assert.deepEqual((await readdir(transaction)).sort(), [OWNER_FILE, "player-host"]);
  for (const forbidden of ["BridgeToken", "PipeName", "FarmhandProvisioner", "ManifestPath"]) {
    assert.equal(config.includes(forbidden), false);
  }
  const durable = JSON.parse(await readFile(ownerPath(root), "utf8"));
  assert.deepEqual(durable.playerHost, {
    kind: "launch_reserved",
    launchGeneration: "player-generation-1",
  });
  assert.deepEqual(durable.aiClient, {
    kind: "launch_reserved",
    launchGeneration: "generation-1",
  });
  assert.equal(durable.state, "quarantined");
  assert.equal(durable.cleanupDisposition, "retry_required");
  assert.throws(() => consumeOwnedPlayerHostPhaseAOwner(owner, () => undefined), /stardew_owned_phase_a_owner_not_registered/);
  assert.throws(() => ownerTestView(owner).consumePlayerHostLaunch(() => undefined), /stardew_player_host_launch_not_available/);
  assert.throws(() => ownerTestView(owner).consumeAiClientLaunch(() => undefined), /stardew_ai_client_launch_not_available/);
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("final post failure terminalizes owner after quarantine persistence failure without spawn", async () => {
  const harness = createHarness();
  const root = await createRoot();
  const triple = mintOwnedTriple(harness.composition, { browserSessionId: "browser-final-post-corrupt" });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  let postChecks = 0;
  const stageB = createStageBTestHarness({
    recheck: async (phase) => {
      if (phase === "post" && ++postChecks === 2) {
        await writeFile(ownerPath(root), "{corrupt", "utf8");
        throw new Error("final_post_recheck_failed");
      }
    },
    verifyPackage: async () => undefined,
  });

  await assert.rejects(stageB.bindOwnedPhaseA(owner), /stardew_private_stage_b_failed/);
  const transaction = ownerTestView(owner).transactionDirectory;
  const config = await readFile(join(transaction, "player-host", "Mods", "GameBuddy", "config.json"), "utf8");
  assert.deepEqual((await readdir(transaction)).sort(), [OWNER_FILE, "player-host"]);
  for (const forbidden of ["BridgeToken", "PipeName", "FarmhandProvisioner", "ManifestPath"]) {
    assert.equal(config.includes(forbidden), false);
  }
  assert.deepEqual(ownerTestView(owner).record.playerHost, {
    kind: "launch_reserved",
    launchGeneration: "player-generation-1",
  });
  assert.deepEqual(ownerTestView(owner).record.aiClient, {
    kind: "launch_reserved",
    launchGeneration: "generation-1",
  });
  assert.throws(() => consumeOwnedPlayerHostPhaseAOwner(owner, () => undefined), /stardew_owned_phase_a_owner_not_registered/);
  assert.throws(() => ownerTestView(owner).consumePlayerHostLaunch(() => undefined), /stardew_player_host_launch_not_available/);
  assert.throws(() => ownerTestView(owner).consumeAiClientLaunch(() => undefined), /stardew_ai_client_launch_not_available/);
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("Phase B staging occupied and expiry failures quarantine the owner without launch", async () => {
  for (const mode of ["occupied", "expired"] as const) {
    const root = await createRoot();
    const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
    const harness = createHarness({
      staging: {
        readPackage: async () => {
          const packageRoot = join(root, `package-${mode}`);
          await mkdir(packageRoot, { recursive: true });
          for (const entry of entries) await writeFile(join(packageRoot, entry), entry);
          return { root: packageRoot, entries };
        },
        createSecret: () => "session-secret-012345",
        nowMs: () => mode === "expired" ? 5_000 : 1_000,
      },
    });
    const triple = mintOwnedTriple(harness.composition, { browserSessionId: `browser-${mode}` });
    const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
      root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
    );
    if (mode === "occupied") await mkdir(join(ownerTestView(owner).transactionDirectory, "foreign"));
    if (mode === "expired") harness.setNow(5_000);
    const stageB = createStageBTestHarness({
      recheck: async () => undefined,
      verifyPackage: async () => undefined,
    });
    await assert.rejects(stageB.bindOwnedPhaseA(owner));
    assert.equal(ownerTestView(owner).record.state, "quarantined");
    const transactionEntries = await readdir(ownerTestView(owner).transactionDirectory);
    assert.equal(transactionEntries.includes("ai-client"), false);
    assert.equal(transactionEntries.includes("session"), false);
    assert.deepEqual(ownerTestView(owner).record.playerHost, {
      kind: "launch_reserved",
      launchGeneration: "player-generation-1",
    });
    assert.deepEqual(ownerTestView(owner).record.aiClient, {
      kind: "launch_reserved",
      launchGeneration: "generation-1",
    });
    assert.deepEqual(harness.playerHostSpawnCalls, []);
    assert.deepEqual(harness.spawnCalls, []);
    assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
    assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  }
});

test("owned attachment factory constructs a signed compatibility reader without mutation", async () => {
  const fixture = await createAttachmentFactoryFixture();
  const transactionDirectory = fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).transactionDirectory;
  const sessionDirectory = join(transactionDirectory, "session");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, "stardew-session.json"), JSON.stringify(signedAttachmentSession("session-secret-stagec-012345")));
  const recordBefore = fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).record;
  const attachmentFlow = fixture.testCore.createOwnedPlayerHostAttachmentFlow(fixture.owner);
  assert.equal(attachmentFlow instanceof StardewAttachmentFlow, true);
  const compatibility = await attachmentFlow.readCompatibilityOutcome();
  assert.equal(compatibility.status, "compatible_unverified");
  assert.equal(compatibility.attachmentAllowed, true);
  assert.deepEqual(fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).record, recordBefore);
  assert.deepEqual(fixture.harness.playerHostSpawnCalls, []);
  assert.deepEqual(fixture.harness.spawnCalls, []);
  assert.equal(fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).hasPrivateMaterial(), true);
});
test("owned attachment factory rejects forged and cross-composition owners", async () => {
  const left = await createAttachmentFactoryFixture();
  const right = await createAttachmentFactoryFixture();
  assert.throws(
    () => left.testCore.createOwnedPlayerHostAttachmentFlow(Object.freeze({}) as StardewOwnedPlayerHostPhaseAOwner),
    /stardew_private_launch_admission_failed/,
  );
  assert.throws(
    () => right.testCore.createOwnedPlayerHostAttachmentFlow(left.owner),
    /stardew_private_launch_admission_failed/,
  );
  assert.deepEqual(left.harness.playerHostSpawnCalls, []);
  assert.deepEqual(right.harness.playerHostSpawnCalls, []);
});

test("owned attachment factory rejects owners without private material or after expiry", async () => {
  const missing = await createAttachmentFactoryFixture();
  assert.throws(
    () => missing.testCore.createOwnedPlayerHostAttachmentFlow(Object.freeze({}) as StardewOwnedPlayerHostPhaseAOwner),
    /stardew_private_launch_admission_failed/,
  );
  const expired = await createAttachmentFactoryFixture();
  expired.harness.setNow(5_000);
  assert.throws(
    () => expired.testCore.createOwnedPlayerHostAttachmentFlow(expired.owner),
    /stardew_private_launch_admission_failed/,
  );
});

test("owned attachment factory rejects quarantined owners", async () => {
  const fixture = await createAttachmentFactoryFixture();
  await fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).quarantine();
  assert.throws(
    () => fixture.testCore.createOwnedPlayerHostAttachmentFlow(fixture.owner),
    /stardew_private_launch_admission_failed/,
  );
});

test("staged Phase B owner is consumed exactly once with no launch or durable mutation", async () => {
  const root = await createRoot();
  const packageRoot = join(root, "verified-package-consume");
  const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
  await mkdir(packageRoot);
  for (const entry of entries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  const harness = createHarness({
    staging: {
      readPackage: async () => ({ root: packageRoot, entries }),
      createSecret: () => "session-secret-consume-012345",
      nowMs: () => 1_000,
    },
  });
  const triple = mintOwnedTriple(harness.composition, { browserSessionId: "browser-consume" });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );

  // Timing: before the binder completes, the owner is not yet consumable.
  assert.throws(() => consumeStagedOwnedPlayerHostPhaseBForTesting(owner), /stardew_owned_phase_a_owner_not_bound/);

  await createStageBTestHarness({
    recheck: async () => undefined,
    verifyPackage: async () => undefined,
  }).bindOwnedPhaseA(owner);

  const recordBefore = ownerTestView(owner).record;
  assert.doesNotThrow(() => consumeStagedOwnedPlayerHostPhaseBForTesting(owner));

  // One-shot: the same staged authority cannot be consumed again.
  assert.throws(() => consumeStagedOwnedPlayerHostPhaseBForTesting(owner), /stardew_owned_phase_a_phase_b_not_staged/);
  assert.deepEqual(ownerTestView(owner).record, recordBefore);
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "player_host_launch_pending" });
  assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
});

test("staged Phase B consume is composition-bound: foreign consume rejects before side effects, own consumes once, replay drains", async () => {
  const root = await createRoot();
  const packageRoot = join(root, "verified-package-composition-bound");
  const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
  await mkdir(packageRoot);
  for (const entry of entries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  const left = createHarness({
    staging: {
      readPackage: async () => ({ root: packageRoot, entries }),
      createSecret: () => "session-secret-composition-bound-012345",
      nowMs: () => 1_000,
    },
  });
  const right = createHarness();
  const triple = mintOwnedTriple(left.composition, { browserSessionId: "browser-composition-bound" });
  const owner = await left.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  await createStageBTestHarness({
    recheck: async () => undefined,
    verifyPackage: async () => undefined,
  }).bindOwnedPhaseA(owner);

  // Composition B's test-only bound consume is rejected by the composition
  // bind before the owner's staged marker, record, or any spawn side effect.
  assert.throws(
    () => consumeStagedOwnedPlayerHostPhaseBForTesting(owner, right.composition),
    /stardew_owned_phase_a_owner_not_registered/,
  );
  assert.equal(ownerTestView(owner).record.state, "reserved");
  assert.deepEqual(right.playerHostSpawnCalls, []);
  assert.deepEqual(right.spawnCalls, []);

  // The rejected foreign consume left the staged marker intact: composition A
  // then consumes the staged profile exactly once...
  assert.doesNotThrow(() => consumeStagedOwnedPlayerHostPhaseBForTesting(owner, left.composition));
  // ...and a replay of the same staged authority is permanently drained.
  assert.throws(
    () => consumeStagedOwnedPlayerHostPhaseBForTesting(owner, left.composition),
    /stardew_owned_phase_a_phase_b_not_staged/,
  );
  assert.deepEqual(left.playerHostSpawnCalls, []);
  assert.deepEqual(left.spawnCalls, []);
  assert.deepEqual(left.composition.playerHostProcessOwner.readStatus(), { kind: "player_host_launch_pending" });
  assert.deepEqual(left.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
});

test("staged Phase B consumption rejects a bound owner that never staged", async () => {
  const root = await createRoot();
  const packageRoot = join(root, "verified-package-nonstaged");
  const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
  await mkdir(packageRoot);
  for (const entry of entries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  const harness = createHarness({
    staging: {
      readPackage: async () => ({ root: packageRoot, entries }),
      createSecret: () => "session-secret-nonstaged-012345",
      nowMs: () => 1_000,
    },
  });
  const triple = mintOwnedTriple(harness.composition, { browserSessionId: "browser-nonstaged" });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  await consumeOwnedPlayerHostPhaseAOwner(owner, async () => Object.freeze({}));
  assert.throws(() => consumeStagedOwnedPlayerHostPhaseBForTesting(owner), /stardew_owned_phase_a_phase_b_not_staged/);
});

test("staged Phase B consumption rejects expired owners", async () => {
  const root = await createRoot();
  const packageRoot = join(root, "verified-package-expired-consume");
  const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
  await mkdir(packageRoot);
  for (const entry of entries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  const harness = createHarness({
    staging: {
      readPackage: async () => ({ root: packageRoot, entries }),
      createSecret: () => "session-secret-expired-consume-012345",
      nowMs: () => 1_000,
    },
  });
  const triple = mintOwnedTriple(harness.composition, { browserSessionId: "browser-expired-consume" });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  await createStageBTestHarness({
    recheck: async () => undefined,
    verifyPackage: async () => undefined,
  }).bindOwnedPhaseA(owner);
  harness.setNow(6_000);
  assert.throws(() => consumeStagedOwnedPlayerHostPhaseBForTesting(owner), /stardew_owned_phase_a_owner_expired/);
});

test("staged Phase B consumption rejects quarantined owners", async () => {
  const root = await createRoot();
  const packageRoot = join(root, "verified-package-quarantined-consume");
  const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
  await mkdir(packageRoot);
  for (const entry of entries) await writeFile(join(packageRoot, entry), `fixed-${entry}`, "utf8");
  const harness = createHarness({
    staging: {
      readPackage: async () => ({ root: packageRoot, entries }),
      createSecret: () => "session-secret-quarantined-consume-012345",
      nowMs: () => 1_000,
    },
  });
  const triple = mintOwnedTriple(harness.composition, { browserSessionId: "browser-quarantined-consume" });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  await createStageBTestHarness({
    recheck: async () => undefined,
    verifyPackage: async () => undefined,
  }).bindOwnedPhaseA(owner);
  await ownerTestView(owner).quarantine();
  assert.throws(() => consumeStagedOwnedPlayerHostPhaseBForTesting(owner), /stardew_owned_phase_a_owner_quarantined/);
});

test("staged Phase B consumption rejects forged and failed-staging owners", async () => {
  assert.throws(
    () => consumeStagedOwnedPlayerHostPhaseBForTesting(Object.freeze({}) as StardewOwnedPlayerHostPhaseAOwner),
    /stardew_owned_phase_a_owner_not_registered/,
  );
  assert.throws(
    () => consumeStagedOwnedPlayerHostPhaseBForTesting(null as unknown as StardewOwnedPlayerHostPhaseAOwner),
    /stardew_owned_phase_a_owner_not_registered/,
  );

  const root = await createRoot();
  const packageRoot = join(root, "verified-package-consume-failure");
  const entries = ["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"];
  await mkdir(packageRoot);
  for (const entry of entries) {
    await writeFile(join(packageRoot, entry), entry === "GameBuddy.Stardew.dll" ? "" : `fixed-${entry}`, "utf8");
  }
  const harness = createHarness({
    staging: {
      readPackage: async () => ({ root: packageRoot, entries }),
      createSecret: () => "session-secret-consume-failure-012345",
      nowMs: () => 1_000,
    },
  });
  const triple = mintOwnedTriple(harness.composition, { browserSessionId: "browser-consume-failure" });
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  await assert.rejects(
    createStageBTestHarness({
      recheck: async () => undefined,
      verifyPackage: async () => undefined,
    }).bindOwnedPhaseA(owner),
    /stardew_private_stage_b_failed/,
  );
  assert.equal(ownerTestView(owner).record.state, "quarantined");
  assert.throws(() => consumeStagedOwnedPlayerHostPhaseBForTesting(owner), /stardew_owned_phase_a_owner_not_bound/);
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.playerHostSpawnCalls, []);
});

test("symlink or reparse-like transaction boundary is rejected without touching target", async (t) => {
  const harness = createHarness();
  const root = await createRoot();
  const outside = await createRoot("gamebuddy-private-bootstrap-outside-");
  await mkdir(join(root, "stardew-private-bootstrap"), { recursive: true });
  const link = join(root, "stardew-private-bootstrap", "bootstrap-1");
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (isNodeError(error) && (error.code === "EPERM" || error.code === "EACCES")) {
      t.skip("symlink/junction creation is unavailable");
      return;
    }
    throw error;
  }
  const pair = mintPair(harness.composition);

  await assert.rejects(
    harness.composition.reserveExternalPlayerHostPhaseA(root, pair.claim, pair.reservation),
    /unsafe_path_boundary/,
  );
  assert.deepEqual(await readDirectory(outside), []);
  assert.deepEqual(harness.spawnCalls, []);
});

// ---------------------------------------------------------------------------
// Stage C: launch of the staged Player Host profile against an admitted
// installation. The closed-core primitive is reached only through the exact
// test composition; the public and production-internal facades never export it.
// ---------------------------------------------------------------------------

const admissionCandidate = "C:\\Games\\Stardew Valley";
const admissionExecutable = `${admissionCandidate}\\StardewModdingAPI.exe`;
const admissionVolumeIdentity = "0123456789abcdef";

function admissionIdentity(
  objectKind: "directory" | "regular_file",
  fileId: string,
): WindowsPathObjectIdentity {
  return Object.freeze({
    objectKind,
    isReparsePoint: false,
    volumeIdentity: admissionVolumeIdentity,
    fileId,
  });
}

function admissionChain(): readonly WindowsPathObjectIdentity[] {
  return Object.freeze([
    admissionIdentity("directory", "00000000000000000000000000000011"),
    admissionIdentity("directory", "00000000000000000000000000000012"),
    admissionIdentity("directory", "00000000000000000000000000000013"),
    admissionIdentity("regular_file", "00000000000000000000000000000014"),
  ]);
}

function changedAdmissionAt(index: number): readonly WindowsPathObjectIdentity[] {
  return Object.freeze(admissionChain().map((identity, position) =>
    position === index ? { ...identity, fileId: "ffffffffffffffffffffffffffffffff" } : identity,
  ));
}

function admissionRequest(path: string): object {
  return { schemaVersion: 2, operation: "inspect_path_chain_v2", path };
}

function admissionResponse(components: readonly WindowsPathObjectIdentity[]): string {
  return `${JSON.stringify({ schemaVersion: 2, operation: "inspect_path_chain_v2", status: "ok", components })}\n`;
}

function admissionInspector(
  chains: readonly (readonly WindowsPathObjectIdentity[])[],
  beforeResponse?: (readIndex: number) => Promise<void>,
): ReturnType<typeof createTestWindowsReparseInspector> {
  let index = 0;
  return createTestWindowsReparseInspector(() => {
    const readIndex = index + 1;
    const chain = chains[index++];
    if (chain === undefined) throw new Error("unexpected_inspection");
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    child.stdin.on("data", (chunk: Buffer) => void (async () => {
      const request: unknown = JSON.parse(chunk.toString("utf8"));
      assert.deepEqual(request, admissionRequest(admissionExecutable));
      if (beforeResponse !== undefined) await beforeResponse(readIndex);
      child.stdout.end(admissionResponse(chain));
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    })());
    return child as unknown as ChildProcess;
  });
}

async function admitForStageC(
  chains: readonly (readonly WindowsPathObjectIdentity[])[],
): Promise<AdmittedStardewInstallation> {
  return admitStardewInstallation(admissionInspector(chains), admissionCandidate);
}

async function createStageBPackage(): Promise<Readonly<{ root: string; entries: readonly string[] }>> {
  const root = await createRoot("gamebuddy-stagec-package-");
  const entries: readonly string[] = [
    "GameBuddy.Stardew.Core.dll",
    "GameBuddy.Stardew.deps.json",
    "GameBuddy.Stardew.dll",
    "Raffinert.FuzzySharp.dll",
    "manifest.json",
  ];
  for (const entry of entries) await writeFile(join(root, entry), `stagec-${entry}`, "utf8");
  return { root, entries };
}

function stageCStaging(
  packageSource: Readonly<{ root: string; entries: readonly string[] }>,
): StardewPrivateModProfileStagingTestSupportInput {
  return {
    readPackage: async () => packageSource,
    createSecret: () => "session-secret-stagec-012345",
    nowMs: () => 1_000,
  };
}

async function stageCStageB(
  harness: ReturnType<typeof createHarness>,
  root: string,
): Promise<StardewOwnedPlayerHostPhaseAOwner> {
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostPhaseA(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  await createStageBTestHarness({
    recheck: async () => undefined,
    verifyPackage: async () => undefined,
  }).bindOwnedPhaseA(owner);
  return owner;
}

test("Stage C starts exactly one direct Player Host with the admitted recipe and redacted status", async () => {
  const root = await createRoot();
  const packageSource = await createStageBPackage();
  const harness = createHarness({ staging: stageCStaging(packageSource) });
  const owner = await stageCStageB(harness, root);
  const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);
  const transaction = ownerTestView(owner).transactionDirectory;
  const recordBefore = ownerTestView(owner).record;

  const result = await launchOwnedPlayerHostStageCForTesting(owner, installation);

  // Stage C consumes only the Player Host reservation; future closed Stage D
  // still has its same-composition material while the AI reservation remains.
  assert.equal(ownerTestView(owner).hasPrivateMaterial(), true);
  assert.deepEqual(result, { status: { kind: "awaiting_player_host_attestation" } });
  assert.deepEqual(harness.playerHostSpawnCalls, [{
    executable: admissionExecutable,
    args: ["--mods-path", join(transaction, "player-host", "Mods")],
    cwd: admissionCandidate,
    environmentGeneration: "player-generation-1",
  }]);
  assert.deepEqual(harness.spawnCalls, []);
  assert.equal(harness.playerHostSpawnCalls.length, 1);
  assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "awaiting_player_host_attestation" });
  assert.deepEqual(ownerTestView(owner).record, recordBefore);

  // The staged marker drains permanently after the launch consumer runs.
  await assert.rejects(
    launchOwnedPlayerHostStageCForTesting(owner, installation),
    /stardew_owned_phase_a_phase_b_not_staged/,
  );
  assert.equal(harness.playerHostSpawnCalls.length, 1);

  const stopped = harness.composition.playerHostProcessOwner.stopOwnedPlayerHost();
  assert.equal(stopped.kind, "terminated");
  assert.deepEqual(harness.playerHostKillCalls, [5432]);
});

test("Stage C returns only a redacted status and leaks no child, recipe, or generation", async () => {
  const packageSource = await createStageBPackage();
  const harness = createHarness({ staging: stageCStaging(packageSource) });
  const owner = await stageCStageB(harness, await createRoot());
  const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);
  const recordBefore = ownerTestView(owner).record;

  const result = await launchOwnedPlayerHostStageCForTesting(owner, installation);

  assert.deepEqual(Reflect.ownKeys(result), ["status"]);
  assert.deepEqual(Reflect.ownKeys(result.status), ["kind"]);
  const serialized = JSON.stringify(result);
  for (const forbidden of ["pid", "5432", "generation", "executable", "args", "cwd", "StardewModdingAPI", "Mods"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  const status = harness.composition.playerHostProcessOwner.readStatus();
  assert.deepEqual(Reflect.ownKeys(status), ["kind"]);
  assert.deepEqual(ownerTestView(owner).record, recordBefore);
  harness.composition.playerHostProcessOwner.stopOwnedPlayerHost();
});

test("Stage C rejects forged and cross-composition owners before any spawn", async () => {
  const packageSource = await createStageBPackage();
  const left = createHarness({ staging: stageCStaging(packageSource) });
  const right = createHarness();
  const owner = await stageCStageB(left, await createRoot());
  const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);

  await assert.rejects(
    launchOwnedPlayerHostStageCForTesting(Object.freeze({}) as StardewOwnedPlayerHostPhaseAOwner, installation),
    /stardew_owned_phase_a_owner_not_registered/,
  );
  await assert.rejects(
    launchOwnedPlayerHostStageCForTesting(null as unknown as StardewOwnedPlayerHostPhaseAOwner, installation),
    /stardew_owned_phase_a_owner_not_registered/,
  );
  await assert.rejects(
    launchOwnedPlayerHostStageCForTesting(owner, installation, right.composition),
    /stardew_owned_phase_a_owner_not_registered/,
  );
  assert.deepEqual(left.playerHostSpawnCalls, []);
  assert.deepEqual(left.spawnCalls, []);
  assert.deepEqual(right.playerHostSpawnCalls, []);
  assert.deepEqual(right.spawnCalls, []);

  // Rejection happens before the closed-core primitive: the staged marker
  // remains intact for the exact owning composition.
  assert.doesNotThrow(() => consumeStagedOwnedPlayerHostPhaseBForTesting(owner, left.composition));
});

test("Stage C rejects unbound and never-staged owners before any spawn", async () => {
  const packageSource = await createStageBPackage();
  const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);

  // Each owner needs its own harness because the Player-Host process owner
  // allows only one outstanding reservation at a time.
  const unboundHarness = createHarness({ staging: stageCStaging(packageSource) });
  const unboundTriple = mintOwnedTriple(unboundHarness.composition);
  const unbound = await unboundHarness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), unboundTriple.claim, unboundTriple.playerHostReservation, unboundTriple.aiClientReservation,
  );
  await assert.rejects(
    launchOwnedPlayerHostStageCForTesting(unbound, installation),
    /stardew_owned_phase_a_owner_not_bound/,
  );

  const boundHarness = createHarness({ staging: stageCStaging(packageSource) });
  const boundTriple = mintOwnedTriple(boundHarness.composition);
  const bound = await boundHarness.composition.reserveOwnedPlayerHostPhaseA(
    await createRoot(), boundTriple.claim, boundTriple.playerHostReservation, boundTriple.aiClientReservation,
  );
  await consumeOwnedPlayerHostPhaseAOwner(bound, async () => Object.freeze({}));
  await assert.rejects(
    launchOwnedPlayerHostStageCForTesting(bound, installation),
    /stardew_owned_phase_a_phase_b_not_staged/,
  );

  assert.deepEqual(unboundHarness.playerHostSpawnCalls, []);
  assert.deepEqual(boundHarness.playerHostSpawnCalls, []);
  assert.deepEqual(unboundHarness.composition.playerHostProcessOwner.readStatus(), { kind: "player_host_launch_pending" });
  assert.deepEqual(boundHarness.composition.playerHostProcessOwner.readStatus(), { kind: "player_host_launch_pending" });
  assert.deepEqual(unboundHarness.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
  assert.deepEqual(boundHarness.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
});

test("Stage C rejects expired and quarantined owners before any spawn", async () => {
  const packageSource = await createStageBPackage();
  for (const mode of ["expired", "quarantined"] as const) {
    const harness = createHarness({ staging: stageCStaging(packageSource) });
    const owner = await stageCStageB(harness, await createRoot());
    const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);
    if (mode === "expired") harness.setNow(6_000);
    else await ownerTestView(owner).quarantine();

    await assert.rejects(
      launchOwnedPlayerHostStageCForTesting(owner, installation),
      mode === "expired" ? /stardew_owned_phase_a_owner_expired/ : /stardew_owned_phase_a_owner_quarantined/,
    );
    assert.deepEqual(harness.playerHostSpawnCalls, []);
    assert.deepEqual(harness.spawnCalls, []);
    if (mode === "expired") {
      assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "player_host_launch_pending" });
      assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
    } else {
      assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
      assert.deepEqual(harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
    }
  }
});

test("Stage C forged admission capability fails closed with zero spawn and keeps the staged marker", async () => {
  const packageSource = await createStageBPackage();
  const harness = createHarness({ staging: stageCStaging(packageSource) });
  const owner = await stageCStageB(harness, await createRoot());

  await assert.rejects(
    launchOwnedPlayerHostStageCForTesting(owner, Object.freeze({}) as AdmittedStardewInstallation),
    /stardew_installation_admission_failed/,
  );
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
  assert.doesNotThrow(() => consumeStagedOwnedPlayerHostPhaseBForTesting(owner));
});

test("Stage C changed admission identity means zero spawn and restores the staged marker retryable", async () => {
  const root = await createRoot();
  const packageSource = await createStageBPackage();
  const harness = createHarness({ staging: stageCStaging(packageSource) });
  const owner = await stageCStageB(harness, root);
  const transaction = ownerTestView(owner).transactionDirectory;
  const installation = await admitForStageC([
    admissionChain(),
    admissionChain(),
    changedAdmissionAt(2),
    admissionChain(),
  ]);

  await assert.rejects(
    launchOwnedPlayerHostStageCForTesting(owner, installation),
    /stardew_installation_admission_failed/,
  );
  assert.deepEqual(harness.playerHostSpawnCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(ownerTestView(owner).record.state, "reserved");

  // A complete retry of the exact launch succeeds once now that the identity
  // chain is stable: exactly one direct Player Host spawn with the exact recipe.
  const retried = await launchOwnedPlayerHostStageCForTesting(owner, installation);
  assert.deepEqual(retried, { status: { kind: "awaiting_player_host_attestation" } });
  assert.deepEqual(harness.playerHostSpawnCalls, [{
    executable: admissionExecutable,
    args: ["--mods-path", join(transaction, "player-host", "Mods")],
    cwd: admissionCandidate,
    environmentGeneration: "player-generation-1",
  }]);
  assert.deepEqual(harness.spawnCalls, []);
  assert.equal(harness.playerHostSpawnCalls.length, 1);
  await assert.rejects(
    launchOwnedPlayerHostStageCForTesting(owner, installation),
    /stardew_owned_phase_a_phase_b_not_staged/,
  );
  assert.equal(harness.playerHostSpawnCalls.length, 1);
  harness.composition.playerHostProcessOwner.stopOwnedPlayerHost();
});

test("Stage C spawn and probe failures keep one-shot marker drain and create no owned process", async () => {
  for (const mode of ["spawn-failure", "probe-failure"] as const) {
    const packageSource = await createStageBPackage();
    const attemptedSpawns: SpawnCall[] = [];
    const harness = createHarness({
      staging: stageCStaging(packageSource),
      playerHostSpawn: (executable, args, options) => {
        attemptedSpawns.push({
          executable,
          args: [...args],
          cwd: options.cwd,
          environmentGeneration: options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION,
        });
        if (mode === "spawn-failure") throw new Error("player_host_spawn_failed");
        return Object.freeze({ pid: 5432, kill: () => true });
      },
      playerHostProbe: mode === "probe-failure" ? (() => null) : undefined,
    });
    const owner = await stageCStageB(harness, await createRoot());
    const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);

    await assert.rejects(
      launchOwnedPlayerHostStageCForTesting(owner, installation),
      mode === "spawn-failure" ? /player_host_spawn_failed/ : /player_host_probe_failed_no_process/,
    );
    assert.equal(attemptedSpawns.length, 1);
    assert.deepEqual(harness.spawnCalls, []);
    // The established process-owner semantics are unchanged: no process is
    // owned, nothing is killable, and the one-shot staged marker drains.
    assert.deepEqual(harness.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
    assert.deepEqual(
      harness.composition.playerHostProcessOwner.stopOwnedPlayerHost(),
      { kind: "no_owned_player_host", killed: false },
    );
    await assert.rejects(
      launchOwnedPlayerHostStageCForTesting(owner, installation),
      /stardew_owned_phase_a_phase_b_not_staged/,
    );
    assert.equal(attemptedSpawns.length, 1);
  }
});

async function readDirectory(path: string): Promise<readonly string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}

type HelperRequest = Readonly<{
  schemaVersion: 1;
  operation: "reclaim_stale_lock" | "release_owned_lock";
  policy?: "stale_malformed" | "stale_valid_dead";
  token?: string;
  root: string;
  segments: readonly string[];
}>;

function requestPath(request: HelperRequest): string {
  return resolve(request.root, ...request.segments);
}

function simulatedLockHelper(): ChildProcess {
  return helperChild(async (request) => {
    const path = requestPath(request);
    if (request.operation === "release_owned_lock") {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (isRecord(parsed) && parsed.token === request.token) {
          await rm(path, { force: true });
          return "released";
        }
        return "kept_token_mismatch";
      } catch (error) {
        return isNodeError(error) && error.code === "ENOENT" ? "missing" : "kept_not_regular";
      }
    }
    return "indeterminate";
  });
}

function helperChild(
  respond: (request: HelperRequest) => Promise<string> | string,
): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString("utf8")) as HelperRequest;
    void (async () => {
      let result = "indeterminate";
      try {
        result = await respond(request);
      } catch {
        result = "indeterminate";
      }
      child.stdout.end(`${JSON.stringify({ schemaVersion: 1, result })}\n`);
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    })();
  });
  return child as unknown as ChildProcess;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("wait_for_timeout");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function waitForPublishedAttachmentRequest(sessionDirectory: string): Promise<Record<string, unknown>> {
  const path = join(sessionDirectory, "stardew-attachment-request.json");
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error("wait_for_attachment_request_timeout");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}


test("manifest handoff composes exact verifier chain and returns only fieldless admission", async () => {
  const fixture = await prepareManifestHandoffFixture();
  const selection = await fixture.coordinator.select(fixture.owner, "cabin-attachment-factory");
  assertFieldlessFrozen(selection);
  const requestPending = fixture.coordinator.confirmAndAdmit(selection, { confirmed: true });
  const request = await waitForPublishedAttachmentRequest(fixture.sessionDirectory);
  const requestId = request.requestId as string;
  assert.equal(typeof requestId, "string");
  const response = signedAttachmentValue({
    schemaVersion: 1,
    requestId,
    state: "ready",
    reasonCode: "manifest_issued",
    updatedAtUnixMs: 2_100,
    manifestPath: "stardew-farmhand-manifest.json",
    signature: "",
  }, fixture.token);
  await writeFile(join(fixture.sessionDirectory, "stardew-attachment-response.json"), JSON.stringify(response));
  await writeFile(
    join(fixture.sessionDirectory, "stardew-farmhand-manifest.json"),
    JSON.stringify(manifestForAttachment({
      token: fixture.token,
      requestId,
      saveId: "save-attachment-factory",
      worldId: "world-attachment-factory",
      nonce: "nonce-attachment-factory",
    })),
  );
  const admission = await requestPending;
  assertFieldlessFrozen(admission);
  assert.equal("requestId" in admission, false);
  assert.equal("manifest" in admission, false);
  assert.deepEqual(fixture.harness.playerHostSpawnCalls, []);
  assert.deepEqual(fixture.harness.spawnCalls, []);
   assert.deepEqual(fixture.testCore.composition.playerHostProcessOwner.readStatus(), { kind: "player_host_launch_pending" });
   assert.deepEqual(fixture.testCore.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
});

test("manifest handoff rejects forged and cross-composition selections without request publication", async () => {
  const left = await prepareManifestHandoffFixture();
  const right = await prepareManifestHandoffFixture();
  const selection = await left.coordinator.select(left.owner, "cabin-attachment-factory");
  await assert.rejects(
    () => right.coordinator.confirmAndAdmit(selection, { confirmed: true }),
    /invalid_stardew_manifest_handoff_selection/,
  );
  const forged = Object.freeze(Object.create(null)) as Parameters<typeof left.coordinator.confirmAndAdmit>[0];
  await assert.rejects(
    () => left.coordinator.confirmAndAdmit(forged, { confirmed: true }),
    /invalid_stardew_manifest_handoff_selection/,
  );
  await assert.rejects(readFile(join(left.sessionDirectory, "stardew-attachment-request.json"), "utf8"), { code: "ENOENT" });
  assert.deepEqual(left.harness.playerHostSpawnCalls, []);
  assert.deepEqual(right.harness.playerHostSpawnCalls, []);
});

test("manifest handoff binds literal confirmation and rejects replay or concurrent confirmation", async () => {
  const fixture = await prepareManifestHandoffFixture();
  const selection = await fixture.coordinator.select(fixture.owner, "cabin-attachment-factory");
  for (const confirmation of [undefined, { confirmed: false }, { confirmed: "true" }] as unknown[]) {
    await assert.rejects(
      () => fixture.coordinator.confirmAndAdmit(selection, confirmation as Readonly<{ confirmed: true }>),
      /user_confirmation_required/,
    );
  }
  const first = fixture.coordinator.confirmAndAdmit(selection, { confirmed: true });
  await assert.rejects(
    () => fixture.coordinator.confirmAndAdmit(selection, { confirmed: true }),
    /invalid_stardew_manifest_handoff_selection/,
  );
  const request = await waitForPublishedAttachmentRequest(fixture.sessionDirectory);
  const requestId = request.requestId as string;
  const response = signedAttachmentValue({
    schemaVersion: 1,
    requestId,
    state: "rejected",
    reasonCode: "binding_readback_mismatch",
    updatedAtUnixMs: 2_100,
    signature: "",
  }, fixture.token);
  await writeFile(join(fixture.sessionDirectory, "stardew-attachment-response.json"), JSON.stringify(response));
  await assert.rejects(first, /stardew_manifest_handoff_failed/);
  await assert.rejects(
    () => fixture.coordinator.confirmAndAdmit(selection, { confirmed: true }),
    /invalid_stardew_manifest_handoff_selection/,
  );
});

test("manifest handoff fails closed on owner expiry or quarantine before request", async () => {
  const expired = await prepareManifestHandoffFixture();
  const expiredSelection = await expired.coordinator.select(expired.owner, "cabin-attachment-factory");
  expired.harness.setNow(5_000);
  await assert.rejects(
    () => expired.coordinator.confirmAndAdmit(expiredSelection, { confirmed: true }),
    /stardew_manifest_handoff_not_admissible/,
  );
  await assert.rejects(readFile(join(expired.sessionDirectory, "stardew-attachment-request.json"), "utf8"), { code: "ENOENT" });

  const quarantined = await prepareManifestHandoffFixture();
  const quarantinedSelection = await quarantined.coordinator.select(quarantined.owner, "cabin-attachment-factory");
   await quarantined.testCore.bindOwnedPlayerHostPhaseAOwner(quarantined.owner).quarantine();
  await assert.rejects(
    () => quarantined.coordinator.confirmAndAdmit(quarantinedSelection, { confirmed: true }),
    /stardew_manifest_handoff_not_admissible/,
  );
  await assert.rejects(readFile(join(quarantined.sessionDirectory, "stardew-attachment-request.json"), "utf8"), { code: "ENOENT" });
});

test("C1 materialization admits genuine manifest and writes exact AI-client profile", async () => {
  const fixture = await prepareManifestHandoffFixture();
  const selection = await fixture.coordinator.select(fixture.owner, "cabin-attachment-factory");
  const pending = fixture.coordinator.confirmAndAdmit(selection, { confirmed: true });
  const request = await waitForPublishedAttachmentRequest(fixture.sessionDirectory);
  const requestId = request.requestId as string;
  await writeFile(join(fixture.sessionDirectory, "stardew-attachment-response.json"), JSON.stringify(signedAttachmentValue({
    schemaVersion: 1,
    requestId,
    state: "ready",
    reasonCode: "manifest_issued",
    updatedAtUnixMs: 2_100,
    manifestPath: "stardew-farmhand-manifest.json",
    signature: "",
  }, fixture.token)));
  await writeFile(join(fixture.sessionDirectory, "stardew-farmhand-manifest.json"), JSON.stringify(manifestForAttachment({
    token: fixture.token,
    requestId,
    saveId: "save-attachment-factory",
    worldId: "world-attachment-factory",
    nonce: "nonce-attachment-factory",
  })));
  const admission = await pending;
  await fixture.testCore.materializeAiClientProfileAfterManifestAdmission(fixture.owner, admission);
  const transaction = fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).transactionDirectory;
  const aiModDirectory = join(transaction, "ai-client", "Mods", "GameBuddy");
  const config = JSON.parse(await readFile(join(aiModDirectory, "config.json"), "utf8"));
  assert.deepEqual(config, {
    EnableLocalBridge: true,
    PipeName: "gamebuddy-stardew-test-bridge",
    BridgeToken: "test-bridge-token-0123456789",
    SaveId: "save-attachment-factory",
    WorldId: "world-attachment-factory",
    PlayerId: "12345",
    CompanionId: "companion-1",
    ActionPolicyVersion: 1,
    FarmhandProvisioner: {
      Enable: true,
      ManifestPath: join(fixture.sessionDirectory, "stardew-farmhand-manifest.json"),
      SessionToken: fixture.token,
      IntegrationVersion: "0.1.0",
      TimeoutSeconds: 45,
    },
  });
  assert.deepEqual((await readdir(join(transaction, "ai-client"))).sort(), ["Mods"]);
  assert.deepEqual((await readdir(join(transaction, "ai-client", "Mods"))).sort(), ["GameBuddy"]);
  assert.deepEqual((await readdir(aiModDirectory)).sort(), ["config.json", ...["GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json", "GameBuddy.Stardew.dll", "Raffinert.FuzzySharp.dll", "manifest.json"]].sort());
  assert.deepEqual(fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).record.managedPaths.slice(-9), [
    "ai-client",
    "ai-client/Mods",
    "ai-client/Mods/GameBuddy",
    "ai-client/Mods/GameBuddy/config.json",
    "ai-client/Mods/GameBuddy/GameBuddy.Stardew.Core.dll",
    "ai-client/Mods/GameBuddy/GameBuddy.Stardew.deps.json",
    "ai-client/Mods/GameBuddy/GameBuddy.Stardew.dll",
    "ai-client/Mods/GameBuddy/Raffinert.FuzzySharp.dll",
    "ai-client/Mods/GameBuddy/manifest.json",
  ]);
  assert.deepEqual(fixture.testCore.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
  await assert.rejects(
    () => fixture.testCore.materializeAiClientProfileAfterManifestAdmission(fixture.owner, admission),    /stardew_ai_client_profile_materialization_not_admissible/,
  );
});

test("C1 materialization rejects forged and cross-composition admissions without writes or reservation consumption", async () => {
  const left = await prepareManifestHandoffFixture();
  const right = await prepareManifestHandoffFixture();
  const selection = await left.coordinator.select(left.owner, "cabin-attachment-factory");
  const pending = left.coordinator.confirmAndAdmit(selection, { confirmed: true });
  const request = await waitForPublishedAttachmentRequest(left.sessionDirectory);
  const requestId = request.requestId as string;
  await writeFile(join(left.sessionDirectory, "stardew-attachment-response.json"), JSON.stringify(signedAttachmentValue({
    schemaVersion: 1, requestId, state: "ready", reasonCode: "manifest_issued", updatedAtUnixMs: 2_100,
    manifestPath: "stardew-farmhand-manifest.json", signature: "",
  }, left.token)));
  await writeFile(join(left.sessionDirectory, "stardew-farmhand-manifest.json"), JSON.stringify(manifestForAttachment({
    token: left.token, requestId, saveId: "save-attachment-factory", worldId: "world-attachment-factory", nonce: "nonce-attachment-factory",
  })));
  const admission = await pending;
  await assert.rejects(
    () => right.testCore.materializeAiClientProfileAfterManifestAdmission(right.owner, admission),
    /stardew_ai_client_profile_materialization_not_admissible/,
  );
  await assert.rejects(
    () => left.testCore.materializeAiClientProfileAfterManifestAdmission(left.owner, Object.freeze(Object.create(null)) as typeof admission),    /stardew_ai_client_profile_materialization_not_admissible/,
  );
  assert.deepEqual(left.harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(right.harness.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual((await readdir(left.testCore.bindOwnedPlayerHostPhaseAOwner(left.owner).transactionDirectory)).sort(), ["owner.json", "player-host", "session"]);
});

test("C1 materialization failure quarantines, rolls back AI artifacts, and permanently consumes admission", async () => {
  const fixture = await prepareManifestHandoffFixture();
  const selection = await fixture.coordinator.select(fixture.owner, "cabin-attachment-factory");
  const pending = fixture.coordinator.confirmAndAdmit(selection, { confirmed: true });
  const request = await waitForPublishedAttachmentRequest(fixture.sessionDirectory);
  const requestId = request.requestId as string;
  await writeFile(join(fixture.sessionDirectory, "stardew-attachment-response.json"), JSON.stringify(signedAttachmentValue({
    schemaVersion: 1, requestId, state: "ready", reasonCode: "manifest_issued", updatedAtUnixMs: 2_100,
    manifestPath: "stardew-farmhand-manifest.json", signature: "",
  }, fixture.token)));
  await writeFile(join(fixture.sessionDirectory, "stardew-farmhand-manifest.json"), JSON.stringify(manifestForAttachment({
    token: fixture.token, requestId, saveId: "save-attachment-factory", worldId: "world-attachment-factory", nonce: "nonce-attachment-factory",
  })));
  const admission = await pending;
  await writeFile(join(fixture.root, "verified-package", "GameBuddy.Stardew.dll"), "", "utf8");
  await assert.rejects(
    () => fixture.testCore.materializeAiClientProfileAfterManifestAdmission(fixture.owner, admission),
    /stardew_ai_client_profile_materialization_package_invalid/,
  );
  assert.equal(fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).record.state, "quarantined");
   assert.deepEqual((await readdir(fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).transactionDirectory)).sort(), ["owner.json", "player-host", "session"]);
  await assert.rejects(
    () => materializeAiClientProfileAfterManifestAdmissionForTesting(fixture.owner, admission, fixture.harness.composition),
    /stardew_ai_client_profile_materialization_not_admissible/,
  );
  assert.deepEqual(fixture.testCore.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
});

test("manifest handoff uses production response and manifest verification for mismatch and signature failures", async () => {
  const mismatch = await prepareManifestHandoffFixture();
  const mismatchSelection = await mismatch.coordinator.select(mismatch.owner, "cabin-attachment-factory");
  const mismatchPending = mismatch.coordinator.confirmAndAdmit(mismatchSelection, { confirmed: true });
  const mismatchRequest = await waitForPublishedAttachmentRequest(mismatch.sessionDirectory);
  const mismatchRequestId = mismatchRequest.requestId as string;
  await writeFile(join(mismatch.sessionDirectory, "stardew-attachment-response.json"), JSON.stringify(signedAttachmentValue({
    schemaVersion: 1,
    requestId: "different-request",
    state: "ready",
    reasonCode: "manifest_issued",
    updatedAtUnixMs: 2_100,
    manifestPath: "stardew-farmhand-manifest.json",
    signature: "",
  }, mismatch.token)));
  await assert.rejects(mismatchPending, /stardew_manifest_handoff_failed/);
  assert.equal(mismatchRequestId.length > 0, true);

  const tampered = await prepareManifestHandoffFixture();
  const tamperedSelection = await tampered.coordinator.select(tampered.owner, "cabin-attachment-factory");
  const tamperedPending = tampered.coordinator.confirmAndAdmit(tamperedSelection, { confirmed: true });
  const tamperedRequest = await waitForPublishedAttachmentRequest(tampered.sessionDirectory);
  const tamperedRequestId = tamperedRequest.requestId as string;
  await writeFile(join(tampered.sessionDirectory, "stardew-attachment-response.json"), JSON.stringify(signedAttachmentValue({
    schemaVersion: 1,
    requestId: tamperedRequestId,
    state: "ready",
    reasonCode: "manifest_issued",
    updatedAtUnixMs: 2_100,
    manifestPath: "stardew-farmhand-manifest.json",
    signature: "",
  }, tampered.token)));
  await writeFile(join(tampered.sessionDirectory, "stardew-farmhand-manifest.json"), JSON.stringify(manifestForAttachment({
    token: tampered.token,
    requestId: tamperedRequestId,
    saveId: "save-attachment-factory",
    worldId: "world-attachment-factory",
    nonce: "nonce-attachment-factory",
    signatureOverride: "tampered-manifest-signature",
  })));
  await assert.rejects(tamperedPending, /stardew_manifest_handoff_failed/);
});


test("manifest handoff rejects a wrong player-host launch generation and quarantines before selection", async () => {
  const fixture = await createAttachmentFactoryFixture();
  const transactionDirectory = ownerTestView(fixture.owner).transactionDirectory;
  const sessionDirectory = join(transactionDirectory, "session");
  const token = "session-secret-stagec-012345";
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    join(sessionDirectory, "stardew-session.json"),
    JSON.stringify(signedAttachmentSession(token, "player-generation-wrong")),
  );
  const coordinator = fixture.testCore.createOwnedPlayerHostManifestHandoffCoordinator();

  await assert.rejects(
    () => coordinator.select(fixture.owner, "cabin-attachment-factory"),
    /stardew_player_host_generation_mismatch/,
  );
  assert.equal(ownerTestView(fixture.owner).record.state, "quarantined");
  assert.deepEqual(fixture.harness.playerHostSpawnCalls, []);
  assert.deepEqual(fixture.harness.spawnCalls, []);
  assert.deepEqual(fixture.testCore.composition.playerHostProcessOwner.readStatus(), { kind: "idle" });
  assert.deepEqual(fixture.testCore.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
  await assert.rejects(
    () => readFile(join(sessionDirectory, "stardew-attachment-request.json"), "utf8"),
    { code: "ENOENT" },
  );
});

test("manifest handoff concurrent replay and cross-composition failures preserve an unconsumed AI reservation", async () => {
  const left = await prepareManifestHandoffFixture();
  const right = await prepareManifestHandoffFixture();
  const selection = await left.coordinator.select(left.owner, "cabin-attachment-factory");

  await assert.rejects(
    () => right.coordinator.confirmAndAdmit(selection, { confirmed: true }),
    /invalid_stardew_manifest_handoff_selection/,
  );
  const first = left.coordinator.confirmAndAdmit(selection, { confirmed: true });
  await assert.rejects(
    () => left.coordinator.confirmAndAdmit(selection, { confirmed: true }),
    /invalid_stardew_manifest_handoff_selection/,
  );
  const request = await waitForPublishedAttachmentRequest(left.sessionDirectory);
  await writeFile(
    join(left.sessionDirectory, "stardew-attachment-response.json"),
    JSON.stringify(signedAttachmentValue({
      schemaVersion: 1,
      requestId: request.requestId as string,
      state: "rejected",
      reasonCode: "binding_readback_mismatch",
      updatedAtUnixMs: 2_100,
      signature: "",
    }, left.token)),
  );
  await assert.rejects(first, /stardew_manifest_handoff_failed/);
  await assert.rejects(
    () => left.coordinator.confirmAndAdmit(selection, { confirmed: true }),
    /invalid_stardew_manifest_handoff_selection/,
  );
  assert.deepEqual(left.harness.playerHostSpawnCalls, []);
  assert.deepEqual(left.harness.spawnCalls, []);
  assert.deepEqual(left.testCore.composition.playerHostProcessOwner.readStatus(), { kind: "player_host_launch_pending" });
  assert.deepEqual(left.testCore.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
  assert.deepEqual(right.harness.playerHostSpawnCalls, []);
  assert.deepEqual(right.harness.spawnCalls, []);
  assert.deepEqual(right.testCore.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
});

test("Stage D rejects pre-materialization and cross-composition owners without consuming AI launch", async () => {
  const left = await prepareManifestHandoffFixture();
  const right = await prepareMaterializedAiClientFixture();
  const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);

  await assert.rejects(
    () => launchOwnedAiClientStageDForTesting(left.owner, installation),
    /stardew_ai_client_profile_not_materialized/,
  );
  await assert.rejects(
    () => launchOwnedAiClientStageDForTesting(right.owner, installation, left.harness.composition),
    /stardew_owned_phase_a_owner_not_registered/,
  );
  assert.deepEqual(left.testCore.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
  assert.deepEqual(right.testCore.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
  assert.deepEqual(left.harness.spawnCalls, []);
  assert.deepEqual(right.harness.spawnCalls, []);
});

test("Stage D fresh installation mismatch spawns nothing and a new admission can retry", async () => {
  const fixture = await prepareMaterializedAiClientFixture();
  const stale = await admitForStageC([
    admissionChain(),
    admissionChain(),
    changedAdmissionAt(2),
  ]);
  await assert.rejects(
    () => fixture.testCore.launchOwnedAiClientStageD(fixture.owner, stale),
    /stardew_installation_admission_failed/,
  );
  assert.deepEqual(fixture.harness.spawnCalls, []);
  assert.deepEqual(fixture.testCore.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });

  const fresh = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);
  const result = await fixture.testCore.launchOwnedAiClientStageD(fixture.owner, fresh);
  assert.deepEqual(result, { status: { kind: "awaiting_ai_client_attestation" } });
  assert.equal(fixture.harness.spawnCalls.length, 1);
});

test("Stage D rejects Bridge config replaced during installation reread before consuming AI launch", async () => {
  const fixture = await prepareMaterializedAiClientFixture();
  const transactionDirectory = fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).transactionDirectory;
  const configPath = join(transactionDirectory, "ai-client", "Mods", "GameBuddy", "config.json");
  const canonicalConfig = await readFile(configPath, "utf8");
  const inspector = admissionInspector(
    [admissionChain(), admissionChain(), admissionChain(), admissionChain()],
    async (readIndex) => {
      if (readIndex === 3)
        await writeFile(configPath, JSON.stringify({ EnableLocalBridge: false }));
    },
  );
  const installation = await admitStardewInstallation(inspector, admissionCandidate);

  await assert.rejects(
    () => fixture.testCore.launchOwnedAiClientStageD(fixture.owner, installation),
    /stardew_ai_client_bridge_config_changed/,
  );
  assert.deepEqual(fixture.harness.spawnCalls, []);
  assert.deepEqual(fixture.testCore.composition.aiClientProcessOwner.readStatus(), {
    kind: "ai_client_launch_pending",
  });

  await writeFile(configPath, canonicalConfig);
  const result = await fixture.testCore.launchOwnedAiClientStageD(fixture.owner, installation);
  assert.deepEqual(result, { status: { kind: "awaiting_ai_client_attestation" } });
  assert.equal(fixture.harness.spawnCalls.length, 1);
});

test("Stage D rejects replaced private Bridge config before consuming AI launch authority", async () => {
  const fixture = await prepareMaterializedAiClientFixture();
  const transactionDirectory = fixture.testCore.bindOwnedPlayerHostPhaseAOwner(fixture.owner).transactionDirectory;
  const configPath = join(transactionDirectory, "ai-client", "Mods", "GameBuddy", "config.json");
  await writeFile(configPath, JSON.stringify({ EnableLocalBridge: false }));
  const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);

  await assert.rejects(
    () => fixture.testCore.launchOwnedAiClientStageD(fixture.owner, installation),
    /stardew_ai_client_bridge_config_changed/,
  );
  assert.deepEqual(fixture.harness.spawnCalls, []);
  assert.deepEqual(fixture.testCore.composition.aiClientProcessOwner.readStatus(), {
    kind: "ai_client_launch_pending",
  });
});

test("Stage D spawn and probe failures consume the exact AI launch authority", async () => {
  for (const mode of ["spawn", "probe"] as const) {
    const attempted: SpawnCall[] = [];
    const fixture = await prepareMaterializedAiClientFixture({
      spawn: (executable, args, options) => {
        attempted.push({ executable, args: [...args], cwd: options.cwd, environmentGeneration: options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION });
        if (mode === "spawn") throw new Error("stage_d_spawn_failed");
        return Object.freeze({ pid: 4321, kill: () => true });
      },
      probe: mode === "probe" ? (() => null) : undefined,
    });
    const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);
    let failure: unknown;
    try { await fixture.testCore.launchOwnedAiClientStageD(fixture.owner, installation); }
    catch (error) { failure = error; }
    assert.match(String(failure), mode === "spawn" ? /stage_d_spawn_failed/ : /probe_failed_no_process/);
    assert.equal(attempted.length, 1);
    assert.deepEqual(fixture.testCore.composition.aiClientProcessOwner.readStatus(), { kind: "idle" });
    const retry = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);
    await assert.rejects(
      () => fixture.testCore.launchOwnedAiClientStageD(fixture.owner, retry),
      /stardew_ai_client_launch_not_available/,
    );
    assert.equal(attempted.length, 1);
  }
});

test("private Farmhand Bridge connection binds exact scope and generation once", async () => {
  const fixture = await prepareLaunchedAiClientFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let observed: unknown;
  const first = fixture.testCore.consumeOwnedFarmhandBridgeConnection(fixture.owner, async (connection) => {
    observed = connection;
    await gate;
    return Object.freeze({ close: () => undefined });
  });

  await assert.rejects(
    () => fixture.testCore.consumeOwnedFarmhandBridgeConnection(
      fixture.owner,
      () => Object.freeze({ close: () => undefined }),
    ),
    /stardew_farmhand_bridge_connection_not_available/,
  );
  release();
  assert.equal(typeof (await first).close, "function");
  assert.deepEqual(observed, {
    scope: {
      integrationId: "stardew",
      saveId: "save-attachment-factory",
      worldId: "world-attachment-factory",
      playerId: "12345",
      companionId: "companion-1",
    },
    pipeName: "gamebuddy-stardew-test-bridge",
    token: "test-bridge-token-0123456789",
    launchGeneration: "generation-1",
  });
  assert.equal(Object.isFrozen(observed), true);
  await assert.rejects(
    () => fixture.testCore.consumeOwnedFarmhandBridgeConnection(
      fixture.owner,
      () => Object.freeze({ close: () => undefined }),
    ),
    /stardew_farmhand_bridge_connection_not_available/,
  );
});

test("private Farmhand Bridge connection retries only callback-local transient failure", async () => {
  const fixture = await prepareLaunchedAiClientFixture();
  let attempts = 0;
  await assert.rejects(
    () => fixture.testCore.consumeOwnedFarmhandBridgeConnection(fixture.owner, () => {
      attempts += 1;
      throw new Error("pipe_not_ready");
    }),
    /pipe_not_ready/,
  );
  const connected = await fixture.testCore.consumeOwnedFarmhandBridgeConnection(fixture.owner, () => {
    attempts += 1;
    return Object.freeze({ close: () => undefined });
  });
  assert.equal(typeof connected.close, "function");
  assert.equal(attempts, 2);
});

test("private Farmhand Bridge connection awaits async cleanup when AI stops after callback", async () => {
  const fixture = await prepareLaunchedAiClientFixture();
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let signalCloseEntered!: () => void;
  const closeEntered = new Promise<void>((resolve) => {
    signalCloseEntered = resolve;
  });
  let settled = false;
  const consuming = fixture.testCore.consumeOwnedFarmhandBridgeConnection(fixture.owner, () => {
    fixture.testCore.composition.aiClientProcessOwner.stopOwnedAiClient();
    return Object.freeze({
      close: async () => {
        signalCloseEntered();
        await closeGate;
      },
    });
  });
  void consuming.finally(() => {
    settled = true;
  }).catch(() => undefined);
  await Promise.race([
    closeEntered,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("async_close_not_entered")), 5_000)),
  ]);
  try {
    assert.equal(settled, false);
  } finally {
    releaseClose();
  }
  await assert.rejects(consuming, /stardew_farmhand_bridge_ai_client_not_awaiting_attestation/);
  assert.equal(settled, true);
});

test("private Farmhand Bridge connection rejects wrong owner, tamper, and stopped AI before callback", async () => {
  const left = await prepareLaunchedAiClientFixture();
  const right = await prepareLaunchedAiClientFixture();
  let callbacks = 0;
  await assert.rejects(
    () => consumeOwnedFarmhandBridgeConnectionForTesting(
      left.owner,
      () => {
        callbacks += 1;
        return Object.freeze({ close: () => undefined });
      },
      right.harness.composition,
    ),
    /stardew_owned_phase_a_owner_not_registered/,
  );

  const transactionDirectory = left.testCore.bindOwnedPlayerHostPhaseAOwner(left.owner).transactionDirectory;
  await writeFile(
    join(transactionDirectory, "ai-client", "Mods", "GameBuddy", "config.json"),
    JSON.stringify({ EnableLocalBridge: false }),
  );
  await assert.rejects(
    () => left.testCore.consumeOwnedFarmhandBridgeConnection(left.owner, () => {
      callbacks += 1;
      return Object.freeze({ close: () => undefined });
    }),
    /stardew_ai_client_bridge_config_changed/,
  );
  assert.equal(callbacks, 0);

  right.testCore.composition.aiClientProcessOwner.stopOwnedAiClient();
  await assert.rejects(
    () => right.testCore.consumeOwnedFarmhandBridgeConnection(right.owner, () => {
      callbacks += 1;
      return Object.freeze({ close: () => undefined });
    }),
    /stardew_farmhand_bridge_ai_client_not_awaiting_attestation/,
  );
  assert.equal(callbacks, 0);
});

test("connected no-live C1 composition privately provisions Bridge scope before exact AI launch", async () => {
  const playerHostGeneration = "connected-player-generation";
  const aiClientGeneration = "connected-ai-generation";
  const companionId = "connected-companion";
  const packageSource = await createStageBPackage();
  const harness = createHarness({
    launchGenerations: [aiClientGeneration],
    playerHostLaunchGenerations: [playerHostGeneration],
    staging: stageCStaging(packageSource),
  });
  const testCore = createStardewPrivateBootstrapCompositionForTesting(harness.dependencies);
  const root = await createRoot("gamebuddy-connected-c1-");
  const triple = mintOwnedTriple(testCore.composition, {
    playerId: "connected-player",
    companionId,
  });
  const owner = await testCore.composition.reserveOwnedPlayerHostPhaseA(
    root,
    triple.claim,
    triple.playerHostReservation,
    triple.aiClientReservation,
  );
  await createStageBTestHarness({
    recheck: async () => undefined,
    verifyPackage: async () => undefined,
  }).bindOwnedPhaseA(owner);

  const ownerView = testCore.bindOwnedPlayerHostPhaseAOwner(owner);
  assert.deepEqual(ownerView.record.playerHost, {
    kind: "launch_reserved",
    launchGeneration: playerHostGeneration,
  });
  assert.deepEqual(ownerView.record.aiClient, {
    kind: "launch_reserved",
    launchGeneration: aiClientGeneration,
  });
  assert.equal(ownerView.hasPrivateMaterial(), true);
  assert.deepEqual(testCore.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });

  const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);
  const launchResult = await testCore.launchOwnedPlayerHostStageC(owner, installation);
  assert.deepEqual(launchResult, { status: { kind: "awaiting_player_host_attestation" } });
  assert.equal(harness.playerHostSpawnCalls.length, 1);
  assert.equal(harness.playerHostSpawnCalls[0]?.environmentGeneration, playerHostGeneration);
  assert.deepEqual(testCore.composition.playerHostProcessOwner.readStatus(), {
    kind: "awaiting_player_host_attestation",
  });
  assert.deepEqual(testCore.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
  assert.deepEqual(harness.spawnCalls, []);

  const transactionDirectory = ownerView.transactionDirectory;
  const sessionDirectory = join(transactionDirectory, "session");
  const sessionToken = "session-secret-stagec-012345";
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    join(sessionDirectory, "stardew-session.json"),
    JSON.stringify(signedAttachmentSession(sessionToken, playerHostGeneration)),
  );

  const coordinator = testCore.createOwnedPlayerHostManifestHandoffCoordinator();
  const selection = await coordinator.select(owner, "cabin-attachment-factory");
  assertFieldlessFrozen(selection);
  const admissionPending = coordinator.confirmAndAdmit(selection, { confirmed: true });
  const request = await waitForPublishedAttachmentRequest(sessionDirectory);
  const requestId = request.requestId as string;
  assert.equal(request.companionId, companionId);
  assert.equal(request.cabinId, "cabin-attachment-factory");
  assert.equal(request.endpoint, undefined);

  await writeFile(
    join(sessionDirectory, "stardew-attachment-response.json"),
    JSON.stringify(signedAttachmentValue({
      schemaVersion: 1,
      requestId,
      state: "ready",
      reasonCode: "manifest_issued",
      updatedAtUnixMs: 2_100,
      manifestPath: "stardew-farmhand-manifest.json",
      signature: "",
    }, sessionToken)),
  );
  await writeFile(
    join(sessionDirectory, "stardew-farmhand-manifest.json"),
    JSON.stringify(manifestForAttachment({
      token: sessionToken,
      requestId,
      saveId: "save-attachment-factory",
      worldId: "world-attachment-factory",
      nonce: "nonce-attachment-factory",
      companionId,
    })),
  );
  const admission = await admissionPending;
  assertFieldlessFrozen(admission);

  const publicProjection = JSON.stringify({
    launchResult,
    selection,
    admission,
    playerHostStatus: testCore.composition.playerHostProcessOwner.readStatus(),
    aiClientStatus: testCore.composition.aiClientProcessOwner.readStatus(),
  });
  for (const forbidden of [
    "BridgeToken",
    "PipeName",
    "EnableLocalBridge",
    "SessionToken",
    "SessionDirectory",
    "ManifestPath",
    "publicSecret",
    "ready",
    "connected",
    "generation",
    playerHostGeneration,
    aiClientGeneration,
    sessionToken,
    transactionDirectory,
  ]) {
    assert.equal(publicProjection.includes(forbidden), false, forbidden);
  }

  await testCore.materializeAiClientProfileAfterManifestAdmission(owner, admission);
  assert.deepEqual(testCore.composition.aiClientProcessOwner.readStatus(), { kind: "ai_client_launch_pending" });
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.playerHostSpawnCalls[0]?.environmentGeneration, playerHostGeneration);

  const aiInstallation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);
  const aiLaunchResult = await testCore.launchOwnedAiClientStageD(owner, aiInstallation);
  assert.deepEqual(aiLaunchResult, { status: { kind: "awaiting_ai_client_attestation" } });
  assert.deepEqual(testCore.composition.aiClientProcessOwner.readStatus(), {
    kind: "awaiting_ai_client_attestation",
  });
  assert.equal(harness.spawnCalls.length, 1);
  const aiSpawn = harness.spawnCalls[0] as SpawnCall | undefined;
  assert.ok(aiSpawn);
  assert.equal(aiSpawn.executable, admissionExecutable);
  assert.equal(aiSpawn.cwd, admissionCandidate);
  assert.deepEqual(aiSpawn.args, ["--mods-path", join(transactionDirectory, "ai-client", "Mods")]);
  assert.equal(aiSpawn.environmentGeneration, aiClientGeneration);

  const hostConfig = await readFile(
    join(transactionDirectory, "player-host", "Mods", "GameBuddy", "config.json"),
    "utf8",
  );
  const aiConfigPath = join(transactionDirectory, "ai-client", "Mods", "GameBuddy", "config.json");
  const aiConfig = JSON.parse(await readFile(aiConfigPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(aiConfig, {
    EnableLocalBridge: true,
    PipeName: "gamebuddy-stardew-test-bridge",
    BridgeToken: "test-bridge-token-0123456789",
    SaveId: "save-attachment-factory",
    WorldId: "world-attachment-factory",
    PlayerId: "12345",
    CompanionId: companionId,
    ActionPolicyVersion: 1,
    FarmhandProvisioner: {
      Enable: true,
      ManifestPath: join(sessionDirectory, "stardew-farmhand-manifest.json"),
      SessionToken: sessionToken,
      IntegrationVersion: "0.1.0",
      TimeoutSeconds: 45,
    },
  });
  assert.equal(hostConfig.includes("BridgeToken"), false);
  assert.equal(hostConfig.includes("PipeName"), false);
  assert.equal(hostConfig.includes("EnableLocalBridge"), false);
});
