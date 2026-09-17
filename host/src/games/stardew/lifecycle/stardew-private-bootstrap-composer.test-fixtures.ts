/**
 * Shared fixture factories for stardew-private-bootstrap-composer.test.ts.
 *
 * These helpers were extracted VERBATIM from the test file; the test file
 * imports them instead of re-defining the same boilerplate per test.
 * createRoot keeps its exact default prefix ("gamebuddy-private-bootstrap-")
 * and every call-site prefix is preserved, including the helper-internal
 * variants "gamebuddy-attachment-factory-", "gamebuddy-stardew-stageb-package-"
 * and "gamebuddy-stagec-package-". Assertions inside moved helpers
 * (assertAttemptFixtureUnchanged, admissionInspector) are byte-identical and
 * still run in the same tests via these imported helpers.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import type {
  StardewAiClientProcessProbe,
  StardewAiClientProcessSpawn,
} from "../../../stardew-ai-client-process-owner.js";
import type {
  StardewOwnedPlayerHostBootstrap,
  StardewPrivateBootstrapComposition,
} from "./stardew-private-bootstrap-composer.js";
import {
  consumeOwnedPlayerHostBootstrap,
  stageOwnedPlayerHostProfile,
  terminalizeOwnedPlayerHostBootstrap,
} from "./stardew-private-bootstrap-composer.internal.js";
import { bindStardewPrivateBootstrapOwnerTestSupport } from "./stardew-private-bootstrap-composer.test-support.js";
import {
  createOwnerTransitionsForTesting,
  createStardewPrivateBootstrapCompositionForTesting,
  type StardewPrivateModProfileStagingTestSupportInput,
} from "./stardew-private-bootstrap-composer.test-support-internal.js";
import { admitStardewInstallation, type AdmittedStardewInstallation } from "../../../stardew-installation-admission.js";
import { createTestWindowsReparseInspector } from "../../../windows-reparse-inspector/index.test-support.js";
import type { WindowsPathObjectIdentity } from "../../../windows-reparse-inspector/index.js";

const CREATION = "20250102030405.000000+000";
const OWNER_SCHEMA = "gamebuddy-stardew-private-bootstrap-owner/v4";
export const OWNER_FILE = "owner.json";
export const temporaryRoots: string[] = [];

export function signedAttachmentSession(sessionToken: string, launchGeneration = "player-generation-1") {
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

export function ownerTestView(owner: StardewOwnedPlayerHostBootstrap) {
  return bindStardewPrivateBootstrapOwnerTestSupport(owner);
}

export function signedAttachmentValue<T extends { signature: string }>(value: T, token: string): T {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signature;
  return {
    ...value,
    signature: createHmac("sha256", token).update(JSON.stringify(unsigned), "utf8").digest("base64url"),
  };
}

export function manifestForAttachment(input: Readonly<{
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

export async function prepareManifestHandoffFixture(processOverrides: Readonly<{
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

export async function prepareMaterializedAiClientFixture(processOverrides: Readonly<{
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

export async function prepareLaunchedAiClientFixture(processOverrides: Readonly<{
  spawn?: StardewAiClientProcessSpawn;
  probe?: StardewAiClientProcessProbe;
}> = {}) {
  const fixture = await prepareMaterializedAiClientFixture(processOverrides);
  const installation = await admitForStageC([admissionChain(), admissionChain(), admissionChain()]);
  const launch = await fixture.testCore.launchMaterializedAiClient(fixture.owner, installation);
  assert.deepEqual(launch, { status: { kind: "awaiting_ai_client_attestation" } });
  return fixture;
}

export function assertFieldlessFrozen(value: object): void {
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Reflect.ownKeys(value), []);
  assert.equal(JSON.stringify(value), "{}");
}

export function createStageBTestHarness(input: Readonly<{
  recheck(phase: "pre" | "post"): Promise<void>;
  verifyPackage(): Promise<void>;
}>) {
  return {
    async bindOwnedPlayerHostBootstrap(owner: Parameters<typeof consumeOwnedPlayerHostBootstrap>[0]): Promise<object> {
      try {
        return await consumeOwnedPlayerHostBootstrap(owner, async () => {
          await input.recheck("pre");
          await input.verifyPackage();
          await input.recheck("post");
          await stageOwnedPlayerHostProfile(owner);
          try { await input.recheck("post"); }
          catch (error) {
            try { await ownerTestView(owner).quarantine(); } catch { /* preserve reread failure */ }
            terminalizeOwnedPlayerHostBootstrap(owner);
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

export type SpawnCall = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string | undefined;
  environmentGeneration: string | undefined;
}>;

export type CapturedLaunch = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string | undefined;
  environment: Readonly<NodeJS.ProcessEnv>;
}>;

export function createHarness(input: Readonly<{
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

export async function createAttachmentFactoryFixture(processOverrides: Readonly<{
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
  const owner = await testCore.composition.reserveOwnedPlayerHostBootstrap(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  await createStageBTestHarness({ recheck: async () => undefined, verifyPackage: async () => undefined }).bindOwnedPlayerHostBootstrap(owner);
  return { root, harness, testCore, owner };
}


export function defaultStagingDependencies(): StardewPrivateModProfileStagingTestSupportInput {
  let secretIndex = 0;
  const entries = Object.freeze([
    "GameBuddy.Stardew.Core.dll",
    "GameBuddy.Stardew.deps.json",
    "GameBuddy.Stardew.dll",
    "Raffinert.FuzzySharp.dll",
    "manifest.json",
  ]);
  let packagePromise: Promise<Readonly<{ root: string; entries: readonly string[] }>> | undefined;
  return {
    readPackage: async () => {
      packagePromise ??= (async () => {
        const root = await createRoot("gamebuddy-stardew-stageb-package-");
        await Promise.all(entries.map((entry) => writeFile(join(root, entry), `fixture-${entry}`, "utf8")));
        return Object.freeze({ root, entries });
      })();
      return packagePromise;
    },
    createSecret: () => `test-provisioning-secret-${++secretIndex}-0123456789`,
    nowMs: () => 1_000,
  };
}

export async function createRoot(prefix = "gamebuddy-private-bootstrap-"): Promise<string> {
  const parent = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof parent !== "string" || parent.length === 0) throw new Error("test_local_app_data_unavailable");
  const root = await mkdtemp(join(await realpath(parent), prefix));
  temporaryRoots.push(root);
  return root;
}

export function mintOwnedTriple(
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

export function mintPair(
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

export async function reserveFresh(
  harness: ReturnType<typeof createHarness>,
  root: string,
  input: Parameters<typeof mintPair>[1] = {},
) {
  const pair = mintPair(harness.composition, input);
  return harness.composition.reserveExternalPlayerHostPhaseA(root, pair.claim, pair.reservation);
}

export function ownerPath(root: string, bootstrapId = "bootstrap-1"): string {
  return join(root, "stardew-private-bootstrap", bootstrapId, OWNER_FILE);
}

export function createOwnerTransitions(
  harness: ReturnType<typeof createHarness>,
  input: Parameters<typeof createOwnerTransitionsForTesting>[1],
) {
  return createOwnerTransitionsForTesting(harness.testCore, input);
}

export function expectedGuardianBinding(input: Readonly<{ revision?: string; instanceId?: string; epoch?: number; leaseName?: string; playerJobName?: string; aiJobName?: string }> = {}) {
  return {
    bindingRevision: input.revision ?? "revision-1",
    guardianInstanceId: input.instanceId ?? "guardian-instance-1",
    guardianEpoch: input.epoch ?? 1,
    leaseName: input.leaseName ?? "Local\\GameBuddy-Test-Lease-1",
    playerJobName: input.playerJobName ?? "Local\\GameBuddy-Test-PlayerJob-1",
    aiJobName: input.aiJobName ?? "Local\\GameBuddy-Test-AiJob-1",
  };
}

export function expectedOwnedRecord(input: Readonly<{
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

export function expectedRecord(input: Readonly<{
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

export async function writeRegistrationAttemptFixture(
  root: string,
  input: Readonly<{ marker: boolean; activeAttempt: boolean; owner: boolean }>,
): Promise<Readonly<{ before: Map<string, string | null> }>> {
  const registrationDirectory = join(root, "stardew-installation-registration");
  const registrationPath = join(registrationDirectory, "registration.json");
  const markerPath = join(registrationDirectory, "owner-transaction.json");
  const preparedOwnerPath = ownerPath(root);
  await mkdir(registrationDirectory, { recursive: true });
  await writeFile(registrationPath, JSON.stringify({
    schema: "gamebuddy-stardew-installation-registration/v1",
    binding: { rootLayoutVersion: 1 },
    revision: input.activeAttempt ? 2 : 1,
    state: "ready",
    locator: "C:\\StardewValley",
    activeAttempt: input.activeAttempt ? { bootstrapCorrelation: "bootstrap-1" } : null,
  }), "utf8");
  if (input.marker) await writeFile(markerPath, JSON.stringify({
    schema: "gamebuddy-stardew-installation-owner-transaction/v1",
    operation: "prepare_bind",
    bootstrapCorrelation: "bootstrap-1",
    registrationRevision: 2,
    ownerRecordRevision: 1,
  }), "utf8");
  if (input.owner) {
    await mkdir(dirname(preparedOwnerPath), { recursive: true });
    await writeFile(preparedOwnerPath, JSON.stringify(expectedOwnedRecord()), "utf8");
  }
  const before = new Map<string, string | null>();
  for (const path of [registrationPath, markerPath, preparedOwnerPath]) {
    try { before.set(path, await readFile(path, "utf8")); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      before.set(path, null);
    }
  }
  return Object.freeze({ before });
}

export async function assertAttemptFixtureUnchanged(fixture: Awaited<ReturnType<typeof writeRegistrationAttemptFixture>>): Promise<void> {
  for (const [path, expected] of fixture.before) {
    if (expected === null) await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
    else assert.equal(await readFile(path, "utf8"), expected);
  }
}

export const admissionCandidate = "C:\\Games\\Stardew Valley";
export const admissionExecutable = `${admissionCandidate}\\StardewModdingAPI.exe`;
export const admissionVolumeIdentity = "0123456789abcdef";

export function admissionIdentity(
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

export function admissionChain(): readonly WindowsPathObjectIdentity[] {
  return Object.freeze([
    admissionIdentity("directory", "00000000000000000000000000000011"),
    admissionIdentity("directory", "00000000000000000000000000000012"),
    admissionIdentity("directory", "00000000000000000000000000000013"),
    admissionIdentity("regular_file", "00000000000000000000000000000014"),
  ]);
}

export function changedAdmissionAt(index: number): readonly WindowsPathObjectIdentity[] {
  return Object.freeze(admissionChain().map((identity, position) =>
    position === index ? { ...identity, fileId: "ffffffffffffffffffffffffffffffff" } : identity,
  ));
}

export function admissionRequest(path: string): object {
  return { schemaVersion: 2, operation: "inspect_path_chain_v2", path };
}

export function admissionResponse(components: readonly WindowsPathObjectIdentity[]): string {
  return `${JSON.stringify({ schemaVersion: 2, operation: "inspect_path_chain_v2", status: "ok", components })}\n`;
}

export function admissionInspector(
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

export async function admitForStageC(
  chains: readonly (readonly WindowsPathObjectIdentity[])[],
): Promise<AdmittedStardewInstallation> {
  return admitStardewInstallation(admissionInspector(chains), admissionCandidate);
}

export async function createStageBPackage(): Promise<Readonly<{ root: string; entries: readonly string[] }>> {
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

export function stageCStaging(
  packageSource: Readonly<{ root: string; entries: readonly string[] }>,
): StardewPrivateModProfileStagingTestSupportInput {
  return {
    readPackage: async () => packageSource,
    createSecret: () => "session-secret-stagec-012345",
    nowMs: () => 1_000,
  };
}

export async function stageCStageB(
  harness: ReturnType<typeof createHarness>,
  root: string,
): Promise<StardewOwnedPlayerHostBootstrap> {
  const triple = mintOwnedTriple(harness.composition);
  const owner = await harness.composition.reserveOwnedPlayerHostBootstrap(
    root, triple.claim, triple.playerHostReservation, triple.aiClientReservation,
  );
  await createStageBTestHarness({
    recheck: async () => undefined,
    verifyPackage: async () => undefined,
  }).bindOwnedPlayerHostBootstrap(owner);
  return owner;
}

export async function readDirectory(path: string): Promise<readonly string[]> {
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

export function requestPath(request: HelperRequest): string {
  return resolve(request.root, ...request.segments);
}

export function simulatedLockHelper(): ChildProcess {
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

export function helperChild(
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

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("wait_for_timeout");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

export async function waitForPublishedAttachmentRequest(sessionDirectory: string): Promise<Record<string, unknown>> {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
