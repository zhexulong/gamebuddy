import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { bindWindowsStaleLockReclaimer, withPathLock } from "./path-lock.js";
import {
  createStardewBootstrapGuardianPrivateArmBindingFacade,
  type StardewBootstrapGuardianNativePorts,
} from "./stardew-bootstrap-guardian.private.js";
import { createStardewPrivateBootstrapCompositionForTesting } from "./stardew-private-bootstrap-composer.test-support-internal.js";
import type { StardewPrivateBootstrapCoreDependencies } from "./stardew-private-bootstrap-composer.core.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";

const roots: string[] = [];
const binding = Object.freeze({
  bindingRevision: "revision-1",
  guardianInstanceId: "guardian-instance-1",
  guardianEpoch: 1,
  leaseName: "Local\\GameBuddy-Lease-1",
  playerJobName: "Local\\GameBuddy-PlayerJob-1",
  aiJobName: "Local\\GameBuddy-AiJob-1",
});

test.beforeEach(() => bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedLockHelper)));
test.after(() => bindWindowsStaleLockReclaimer(undefined));
test.after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("private arm binding fresh-reads the sole strict v4 owner before one frozen binding callback", async () => {
  const fixture = await createOwner();
  const facade = createFacade(fixture.root);
  let calls = 0;

  const result = await facade.consumeArmBinding((actual) => {
    calls += 1;
    assert.deepEqual(actual, { ...binding, ownerRecordRevision: 1 });
    assert.equal(Object.isFrozen(actual), true);
    assert.deepEqual(Object.keys(actual).sort(), ["aiJobName", "bindingRevision", "guardianEpoch", "guardianInstanceId", "leaseName", "ownerRecordRevision", "playerJobName"]);
    return "accepted";
  });

  assert.equal(result, "accepted");
  assert.equal(calls, 1);
  await assert.rejects(facade.consumeArmBinding(() => "replayed"), /arm_binding_unavailable/);
});

test("private arm binding requires persistence before binding and consumes failed attempts", async () => {
  const root = await createRoot();
  const facade = createFacade(root);
  let called = false;

  await assert.rejects(facade.consumeArmBinding(() => { called = true; }), /ENOENT|invalid_stardew_bootstrap_owner/);
  assert.equal(called, false);
  await writeOwner(root, ownerRecord());
  await assert.rejects(facade.consumeArmBinding(() => { called = true; }), /arm_binding_unavailable/);
  assert.equal(called, false);
});

test("private arm binding rejects correlation, revision, state, and strict-record mismatches before callback", async () => {
  for (const [name, mutate, correlation] of [
    ["v3-schema", (record: Record<string, unknown>) => { record.schema = "gamebuddy-stardew-private-bootstrap-owner/v3"; }, {}],
    ["stale-owner-revision", (record: Record<string, unknown>) => { record.ownerRecordRevision = 2; }, {}],
    ["bootstrap", (record: Record<string, unknown>) => { record.bootstrapId = "other-bootstrap"; }, {}],
    ["player", (record: Record<string, unknown>) => { record.playerId = "other-player"; }, {}],
    ["companion", (record: Record<string, unknown>) => { record.companionId = "other-companion"; }, {}],
    ["revision", (record: Record<string, unknown>) => { (record.guardian as Record<string, unknown>).bindingRevision = "revision-2"; }, {}],
    ["expired", (record: Record<string, unknown>) => { record.expiresAtMs = Date.now() - 1; }, {}],
    ["quarantined", (record: Record<string, unknown>) => { record.state = "quarantined"; record.cleanupDisposition = "retry_required"; }, {}],
    ["unknown-key", (record: Record<string, unknown>) => { record.unexpected = true; }, {}],
    ["unsafe-name", (record: Record<string, unknown>) => { (record.guardian as Record<string, unknown>).leaseName = "Global\\unsafe"; }, {}],
    ["duplicate-name", (record: Record<string, unknown>) => { (record.guardian as Record<string, unknown>).aiJobName = binding.playerJobName; }, {}],
  ] as const) {
    const fixture = await createOwner(mutate);
    const facade = createFacade(fixture.root, correlation);
    let called = false;
    await assert.rejects(
      facade.consumeArmBinding(() => { called = true; }),
      /arm_binding_mismatch|invalid_stardew_bootstrap_owner/,
      name,
    );
    assert.equal(called, false, name);
  }
});

test("private arm binding rejects record replacement before callback and never invokes it", async () => {
  const fixture = await createOwner();
  const facade = createFacade(fixture.root);
  const path = join(fixture.root, "stardew-private-bootstrap", "bootstrap-1", "owner.json");
  await writeFile(path, `${JSON.stringify({ ...ownerRecord(), ownerRecordRevision: 2 })}\n`, "utf8");
  let called = false;
  await assert.rejects(facade.consumeArmBinding(() => { called = true; }), /arm_binding_mismatch/);
  assert.equal(called, false);
});

test("private arm binding consumes before its locked read and rejects a replacement raced after consume begins", async () => {
  const fixture = await createOwner();
  const facade = createFacade(fixture.root);
  const path = join(fixture.root, "stardew-private-bootstrap", "bootstrap-1", "owner.json");
  let releaseLock!: () => void;
  const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve; });
  let enteredLock!: () => void;
  const entered = new Promise<void>((resolve) => { enteredLock = resolve; });
  const holder = withPathLock(path, async () => {
    enteredLock();
    await lockHeld;
  }, { containmentRoot: fixture.root });
  await entered;
  let calls = 0;
  const pending = facade.consumeArmBinding(() => { calls += 1; });
  await writeFile(path, `${JSON.stringify({ ...ownerRecord(), ownerRecordRevision: 2 })}\n`, "utf8");
  releaseLock();
  await holder;
  await assert.rejects(pending, /arm_binding_mismatch/);
  assert.equal(calls, 0);
  await assert.rejects(facade.consumeArmBinding(() => { calls += 1; }), /arm_binding_unavailable/);
  assert.equal(calls, 0);
});

test("private arm binding rejects invalid facade correlation without reading an owner", () => {
  assert.throws(
    () => createStardewBootstrapGuardianPrivateArmBindingFacade({
      runtimeRoot: "",
      bootstrapId: "bootstrap-1",
      playerId: "player-1",
      companionId: "companion-1",
      expectedRevision: "revision-1",
      expectedOwnerRecordRevision: 1,
    }),
    /invalid_stardew_bootstrap_guardian_arm_correlation/,
  );
});

function createFacade(
  root: string,
  overrides: Partial<Parameters<typeof createStardewBootstrapGuardianPrivateArmBindingFacade>[0]> = {},
) {
  return createStardewBootstrapGuardianPrivateArmBindingFacade({
    runtimeRoot: root,
    bootstrapId: "bootstrap-1",
    playerId: "player-1",
    companionId: "companion-1",
    expectedRevision: "revision-1",
    expectedOwnerRecordRevision: 1,
    ...overrides,
  });
}

async function createOwner(mutate?: (record: Record<string, unknown>) => void) {
  const root = await createRoot();
  const record = ownerRecord();
  mutate?.(record);
  await writeOwner(root, record);
  return { root };
}

function ownerRecord(): Record<string, unknown> {
  return {
    schema: "gamebuddy-stardew-private-bootstrap-owner/v4",
    bootstrapId: "bootstrap-1",
    playerId: "player-1",
    companionId: "companion-1",
    guardian: { ...binding },
    ownerRecordRevision: 1,
    state: "reserved",
    guardianState: "reserved",
    playerHostState: "reserved",
    aiClientState: "reserved",
    recoveryInstanceId: null,
    playerHost: { kind: "launch_reserved", launchGeneration: "player-generation-1" },
    aiClient: { kind: "launch_reserved", launchGeneration: "ai-generation-1" },
    expiresAtMs: Date.now() + 60_000,
    cleanupDisposition: "pending",
    managedPaths: ["owner.json"],
  };
}

async function writeOwner(root: string, record: Record<string, unknown>): Promise<void> {
  const directory = join(root, "stardew-private-bootstrap", "bootstrap-1");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "owner.json"), `${JSON.stringify(record)}\n`, "utf8");
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-guardian-private-"));
  roots.push(root);
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
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
  });
  child.stdin.on("data", (chunk: Buffer) => {
    void (async () => {
      const request = JSON.parse(chunk.toString("utf8")) as HelperRequest;
      let result = "indeterminate";
      if (request.operation === "release_owned_lock") {
        const path = resolve(request.root, ...request.segments);
        try {
          const value = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
          if (value.token === request.token) { await rm(path, { force: true }); result = "released"; }
          else result = "kept_token_mismatch";
        } catch { result = "missing"; }
      }
      child.stdout.end(`${JSON.stringify({ schemaVersion: 1, result })}\n`);
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    })();
  });
  return child as unknown as ChildProcess;
}


test("private owner durably arms, independently activates roles, and contains one role without draining the other", async () => {
  const fixture = await createGuardianOwnerFixture();
  const { owner, events, readRecord } = fixture;
  await owner.arm();
  await owner.launchPlayerHost();
  await owner.launchAiClient();
  await owner.containPlayerHost();
  assert.deepEqual(events, ["drain:playerHost"]);
  assert.deepEqual(await readRecord(), { state: "closing", guardianState: "closing", playerHostState: "contained", aiClientState: "closing", ownerRecordRevision: 6 });
  await owner.containAiClient();
  assert.deepEqual(events, ["drain:playerHost", "drain:aiClient"]);
  assert.equal(await owner.close(), "contained");
  assert.deepEqual(events, ["drain:playerHost", "drain:aiClient", "release"]);
  assert.deepEqual(await readRecord(), { state: "contained", guardianState: "contained", playerHostState: "contained", aiClientState: "contained", ownerRecordRevision: 8 });
});

test("private owner final CAS precedes retryable release without repeated native drain or CAS", async () => {
  const fixture = await createGuardianOwnerFixture({ releaseFailures: 1 });
  await fixture.owner.arm();
  assert.equal(await fixture.owner.close(), "unavailable");
  assert.deepEqual(fixture.events, ["drain:playerHost", "drain:aiClient", "release"]);
  assert.deepEqual(await fixture.readRecord(), { state: "contained", guardianState: "contained", playerHostState: "contained", aiClientState: "contained", ownerRecordRevision: 6 });
  assert.equal(await fixture.owner.close(), "contained");
  assert.deepEqual(fixture.events, ["drain:playerHost", "drain:aiClient", "release", "release"]);
  assert.deepEqual(await fixture.readRecord(), { state: "contained", guardianState: "contained", playerHostState: "contained", aiClientState: "contained", ownerRecordRevision: 6 });
});

test("private owner second creation, forged owner, and cross-composition owner reject before native calls", async () => {
  const fixture = await createGuardianOwnerFixture();
  assert.throws(() => fixture.internal.createStardewBootstrapGuardianOwner(fixture.phaseOwner, fixture.native), /binding_unavailable/);
  assert.throws(() => fixture.internal.createStardewBootstrapGuardianOwner(Object.freeze({}) as typeof fixture.phaseOwner, fixture.native), /binding_unavailable|not_registered/);
  const other = await createGuardianOwnerFixture();
  assert.throws(() => fixture.internal.createStardewBootstrapGuardianOwner(other.phaseOwner, fixture.native), /binding_unavailable|not_registered/);
  assert.deepEqual(fixture.events, []);
});

test("recovery acquire failure is unavailable and leaves durable bytes untouched", async () => {
  const fixture = await createGuardianOwnerFixture({ acquireThrows: true });
  const before = await fixture.readRecord();
  assert.equal(await fixture.owner.recoverOrQuarantine("recovery-1"), "unavailable");
  assert.deepEqual(fixture.events, ["acquire"]);
  assert.deepEqual(await fixture.readRecord(), before);
});

test("recovery quarantine release retry does not reclassify or CAS", async () => {
  const fixture = await createGuardianOwnerFixture({ classifications: ["contained", "unavailable"], releaseFailures: 1 });
  assert.equal(await fixture.owner.recoverOrQuarantine("recovery-1"), "unavailable");
  assert.deepEqual(fixture.events, ["acquire", "classify:playerHost", "classify:aiClient", "gate-release"]);
  assert.deepEqual(await fixture.readRecord(), { state: "quarantined", guardianState: "quarantined", playerHostState: "contained", aiClientState: "quarantined", ownerRecordRevision: 4 });
  assert.equal(await fixture.owner.recoverOrQuarantine("recovery-1"), "quarantined");
  assert.deepEqual(fixture.events, ["acquire", "classify:playerHost", "classify:aiClient", "gate-release", "gate-release"]);
  await assert.rejects(fixture.owner.recoverOrQuarantine("recovery-2"), /transition_unavailable/);
});

test("recovery second-role native throw quarantines without replaying contained role", async () => {
  const fixture = await createGuardianOwnerFixture({ classifyThrowsAt: 1 });
  assert.equal(await fixture.owner.recoverOrQuarantine("recovery-1"), "quarantined");
  assert.deepEqual(fixture.events, ["acquire", "classify:playerHost", "classify:aiClient", "gate-release"]);
  assert.equal(await fixture.owner.recoverOrQuarantine("recovery-1"), "quarantined");
  assert.deepEqual(fixture.events, ["acquire", "classify:playerHost", "classify:aiClient", "gate-release"]);
  assert.deepEqual(await fixture.readRecord(), { state: "quarantined", guardianState: "quarantined", playerHostState: "contained", aiClientState: "quarantined", ownerRecordRevision: 4 });
});

test("recovery retains held gate without mutation and retries release after final CAS", async () => {
  const held = await createGuardianOwnerFixture({ held: true });
  assert.equal(await held.owner.recoverOrQuarantine("recovery-1"), "unavailable");
  assert.deepEqual(held.events, ["acquire"]);
  assert.deepEqual(await held.readRecord(), { state: "reserved", guardianState: "reserved", playerHostState: "reserved", aiClientState: "reserved", ownerRecordRevision: 1 });
  const fixture = await createGuardianOwnerFixture({ releaseFailures: 1 });
  assert.equal(await fixture.owner.recoverOrQuarantine("recovery-1"), "unavailable");
  assert.deepEqual(fixture.events, ["acquire", "classify:playerHost", "classify:aiClient", "gate-release"]);
  assert.deepEqual(await fixture.readRecord(), { state: "contained", guardianState: "contained", playerHostState: "contained", aiClientState: "contained", ownerRecordRevision: 5 });
  assert.equal(await fixture.owner.recoverOrQuarantine("recovery-1"), "contained");
  assert.deepEqual(fixture.events, ["acquire", "classify:playerHost", "classify:aiClient", "gate-release", "gate-release"]);
});

test("recovery partial classification quarantines after only the first durable contained role", async () => {
  const fixture = await createGuardianOwnerFixture({ classifications: ["contained", "unavailable"] });
  assert.equal(await fixture.owner.recoverOrQuarantine("recovery-1"), "quarantined");
  assert.deepEqual(fixture.events, ["acquire", "classify:playerHost", "classify:aiClient", "gate-release"]);
  assert.deepEqual(await fixture.readRecord(), { state: "quarantined", guardianState: "quarantined", playerHostState: "contained", aiClientState: "quarantined", ownerRecordRevision: 4 });
});

async function createGuardianOwnerFixture(input: Readonly<{ held?: boolean; acquireThrows?: boolean; classifyThrowsAt?: number; releaseFailures?: number; classifications?: readonly ("contained" | "unavailable" | "quarantined")[] }> = {}) {
  const root = await createRoot();
  const dependencies: StardewPrivateBootstrapCoreDependencies = {
    rawSpawn: () => { throw new Error("not used"); }, rawProbe: () => ({ pid: 1, creationDate: "test" }), rawPlayerHostSpawn: () => { throw new Error("not used"); }, rawPlayerHostProbe: () => ({ pid: 1, creationDate: "test" }),
    createBootstrapIdentity: () => "bootstrap-1", createGuardianRevision: () => "revision-1", createGuardianInstanceId: () => "guardian-instance-1", createGuardianEpoch: () => 1,
    createGuardianLeaseName: () => "Local\\Guardian-Lease-1", createGuardianPlayerJobName: () => "Local\\Guardian-Player-1", createGuardianAiJobName: () => "Local\\Guardian-Ai-1", createLaunchGeneration: () => "ai-generation-1", createPlayerHostLaunchGeneration: () => "player-generation-1", createBridgePipeName: () => "bridge", createBridgeToken: () => "bridge-token-012345", nowMs: () => 1_000,
  };
  const internal = createStardewPrivateBootstrapCompositionForTesting(dependencies);
  const composition = internal.composition;
  const claim = composition.broker.confirm({ playerId: "player-1", companionId: "companion-1", browserSessionId: "browser-1", expiresAtMs: 5_000 }).consume("browser-1");
  const phaseOwner = await composition.reserveOwnedPlayerHostPhaseA(root, claim, composition.playerHostProcessOwner.reservePlayerHostLaunch(), composition.aiClientProcessOwner.reserveAiClientLaunch());
  const events: string[] = []; let releaseFailures = input.releaseFailures ?? 0; let classificationIndex = 0;
  const ownerPath = join(root, "stardew-private-bootstrap", "bootstrap-1", "owner.json");
  const readDurable = async () => JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
  const native: StardewBootstrapGuardianNativePorts = {
    controlledClose: {
      async drainRole(_binding, role) {
        const record = await readDurable();
        assert.equal(record.state, "closing"); assert.equal(record.guardianState, "closing");
        assert.equal(record[role === "playerHost" ? "playerHostState" : "aiClientState"], "closing");
        events.push(`drain:${role}`);
      },
      async releaseAndExit() {
        const record = await readDurable(); assert.equal(record.state, "contained"); assert.equal(record.guardianState, "contained");
        events.push("release"); if (releaseFailures-- > 0) throw new Error("release failed");
      },
    },
    recoveryGate: {
      async acquire() { events.push("acquire"); if (input.acquireThrows) throw new Error("acquire failed"); return input.held ? { kind: "held" as const } : { kind: "acquired" as const, capability: Object.freeze({}) as never }; },
      async release() { const record = await readDurable(); assert.equal(record.state === "contained" || record.state === "quarantined", true); assert.equal(record.guardianState, record.state); events.push("gate-release"); if (releaseFailures-- > 0) throw new Error("release failed"); },
    },
    recoveryClassification: {
      async classify(_binding, _capability, role) {
        const record = await readDurable(); assert.equal(record.state, "recovering"); assert.equal(record.guardianState, "recovering"); assert.equal(record.recoveryInstanceId, "recovery-1");
        events.push(`classify:${role}`); if (classificationIndex++ === input.classifyThrowsAt) throw new Error("classify failed"); return input.classifications?.[classificationIndex - 1] ?? "contained";
      },
    },
  };
  const owner = internal.createStardewBootstrapGuardianOwner(phaseOwner, native);
  return { internal, phaseOwner, native, owner, events, async readRecord() { const record = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>; return { state: record.state, guardianState: record.guardianState, playerHostState: record.playerHostState, aiClientState: record.aiClientState, ownerRecordRevision: record.ownerRecordRevision }; } };
}
