import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createStardewBootstrapGuardianPrivateArmBindingFacade } from "./stardew-bootstrap-guardian.private.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";

const roots: string[] = [];
const binding = Object.freeze({
  revision: "revision-1",
  leaseName: "Local\\GameBuddy-Lease-1",
  playerJobName: "Local\\GameBuddy-PlayerJob-1",
  aiJobName: "Local\\GameBuddy-AiJob-1",
});

test.beforeEach(() => bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedLockHelper)));
test.after(() => bindWindowsStaleLockReclaimer(undefined));
test.after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("private arm binding fresh-reads the sole strict v3 owner before one frozen binding callback", async () => {
  const fixture = await createOwner();
  const facade = createFacade(fixture.root);
  let calls = 0;

  const result = await facade.consumeArmBinding((actual) => {
    calls += 1;
    assert.deepEqual(actual, binding);
    assert.equal(Object.isFrozen(actual), true);
    assert.deepEqual(Object.keys(actual).sort(), ["aiJobName", "leaseName", "playerJobName", "revision"]);
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
    ["bootstrap", (record: Record<string, unknown>) => { record.bootstrapId = "other-bootstrap"; }, {}],
    ["player", (record: Record<string, unknown>) => { record.playerId = "other-player"; }, {}],
    ["companion", (record: Record<string, unknown>) => { record.companionId = "other-companion"; }, {}],
    ["revision", (record: Record<string, unknown>) => { (record.guardian as Record<string, unknown>).revision = "revision-2"; }, {}],
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

test("private arm binding rejects invalid facade correlation without reading an owner", () => {
  assert.throws(
    () => createStardewBootstrapGuardianPrivateArmBindingFacade({
      runtimeRoot: "",
      bootstrapId: "bootstrap-1",
      playerId: "player-1",
      companionId: "companion-1",
      expectedRevision: "revision-1",
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
    schema: "gamebuddy-stardew-private-bootstrap-owner/v3",
    bootstrapId: "bootstrap-1",
    playerId: "player-1",
    companionId: "companion-1",
    guardian: { ...binding },
    playerHost: { kind: "launch_reserved", launchGeneration: "player-generation-1" },
    aiClient: { kind: "launch_reserved", launchGeneration: "ai-generation-1" },
    expiresAtMs: Date.now() + 60_000,
    state: "reserved",
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
