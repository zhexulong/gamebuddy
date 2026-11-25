import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import { reloadMagicContextInRuntimeRoot } from "../runtime-core.internal.js";
import {
  COMPANION_REFLECTION_MAX_ATTEMPTS,
  type CompanionSessionReflectionDeps,
  companionReflectionPendingPath,
  companionReflectionRuntimeCwd,
  createCompanionSessionReflectionChild,
  recordPendingCompanionReflection,
  reflectCompanionSessionOnce,
  runPendingCompanionReflection,
} from "./companion-session-reflection.js";

/**
 * The reflection runs inside the exit reclamation, so what matters most here is that it cannot become a second
 * failure of the exit it belongs to: every outcome that is not a completed reflection is a bounded status, and
 * nothing it does is allowed to throw.
 */

/** A real loaded manifest for one isolated runtime root, so the exit step derives the same root the runtime uses. */
async function manifestFor(runtimeRoot: string) {
  const path = join(runtimeRoot, "manifest.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot,
      principal: { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" },
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
  );
  return await loadHostDeploymentManifest(path);
}

test("a runtime root with no store completes without a reflection and without throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "companion-reflection-"));
  const outcome = await reflectCompanionSessionOnce({ runtimeCwd: root, timeoutMs: 5_000 });
  assert.equal(outcome, "not_applicable");
});

test("a store without folded history has nothing to reflect on", async () => {
  const root = mkdtempSync(join(tmpdir(), "companion-reflection-"));
  // The store path the vendored package resolves from this root, created as an empty SQLite file: opening it
  // yields a schema, and the schema has no session_meta row to name an identity.
  const storeDir = join(root, "data", "cortexkit", "magic-context");
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, "context.db"), "");
  const outcome = await reflectCompanionSessionOnce({ runtimeCwd: root, timeoutMs: 5_000 });
  assert.ok(outcome === "not_applicable" || outcome === "failed", `unexpected outcome: ${outcome}`);
});

test("the environment it borrowed is restored, including when unset", async () => {
  const root = mkdtempSync(join(tmpdir(), "companion-reflection-"));
  const before = {
    storage: process.env.MAGIC_CONTEXT_STORAGE_DIR,
    xdgData: process.env.XDG_DATA_HOME,
    xdgConfig: process.env.XDG_CONFIG_HOME,
  };
  await reflectCompanionSessionOnce({ runtimeCwd: root, timeoutMs: 5_000 });
  assert.equal(process.env.MAGIC_CONTEXT_STORAGE_DIR, before.storage);
  assert.equal(process.env.XDG_DATA_HOME, before.xdgData);
  assert.equal(process.env.XDG_CONFIG_HOME, before.xdgConfig);
});

/**
 * The exit is the one path where nobody is waiting for the reflection, so it must not run one.
 *
 * This is the measured property, not a wording: a reflection is a spawned model call (8 748 ms against a reachable
 * provider, 4 306 ms against one that rejected the key), while the marker this step writes now is a single file.
 * The bound is deliberately loose - an order of magnitude below the model call and an order of magnitude above a
 * file write - so it measures the difference in kind rather than the speed of this machine.
 */
test("the exit records the reflection it owes instead of running one", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "companion-reflection-exit-"));
  const manifest = await manifestFor(root);
  const child = createCompanionSessionReflectionChild(manifest, "surface_01");
  const startedAt = Date.now();
  await child.close();
  const elapsedMs = Date.now() - startedAt;
  t.diagnostic(`the exit step returned in ${elapsedMs} ms`);
  const markerPath = companionReflectionPendingPath(companionReflectionRuntimeCwd(manifest, "surface_01"));
  assert.equal(existsSync(markerPath), true, `the exit wrote no reflection marker at ${markerPath}`);
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { schema: string; attempts: number };
  assert.equal(marker.schema, "gamebuddy-companion-reflection-pending/v1");
  assert.equal(marker.attempts, 0);
  assert.ok(elapsedMs < 1_000, `the exit step took ${elapsedMs} ms, which is a reflection attempt and not a marker`);
});

/** A launch that owes nothing reads one absent file and touches no store and no model. */
test("a launch with no recorded reflection does nothing at all", async () => {
  const root = mkdtempSync(join(tmpdir(), "companion-reflection-idle-"));
  assert.equal(await runPendingCompanionReflection({ runtimeCwd: root, timeoutMs: 5_000 }), "none");
});

/** The deferred reflection runs beside the next launch and is owed no longer once it has run. */
test("the next launch runs the recorded reflection once and clears the marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "companion-reflection-deferred-"));
  const manifest = await manifestFor(root);
  await createCompanionSessionReflectionChild(manifest, "surface_01").close();
  const runtimeCwd = companionReflectionRuntimeCwd(manifest, "surface_01");
  // No store under this root, so the reflection has nothing to reflect on: that is the bounded
  // `not_applicable` answer, and it still discharges the marker.
  assert.equal(await runPendingCompanionReflection({ runtimeCwd, timeoutMs: 5_000 }), "not_applicable");
  assert.equal(existsSync(companionReflectionPendingPath(runtimeCwd)), false);
  assert.equal(await runPendingCompanionReflection({ runtimeCwd, timeoutMs: 5_000 }), "none");
});

/**
 * A reflection that cannot run is retried by the marker's own attempt count and then abandoned under its own name,
 * so one unreadable store cannot make every future launch pay for the same failure forever.
 */
test("a reflection that keeps failing is abandoned after its own attempt ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "companion-reflection-failing-"));
  const manifest = await manifestFor(root);
  const runtimeCwd = companionReflectionRuntimeCwd(manifest, "surface_01");
  const storeDir = join(runtimeCwd, "data", "cortexkit", "magic-context");
  mkdirSync(storeDir, { recursive: true });
  // A file that is not a SQLite database: the store cannot open, so every attempt fails for a real reason.
  writeFileSync(join(storeDir, "context.db"), "this is not a sqlite database");
  await createCompanionSessionReflectionChild(manifest, "surface_01").close();
  const outcomes: string[] = [];
  for (let attempt = 0; attempt < COMPANION_REFLECTION_MAX_ATTEMPTS; attempt += 1) {
    outcomes.push(await runPendingCompanionReflection({ runtimeCwd, timeoutMs: 5_000 }));
  }
  assert.deepEqual(outcomes, ["failed", "failed", "abandoned"]);
  assert.equal(existsSync(companionReflectionPendingPath(runtimeCwd)), false);
  assert.equal(await runPendingCompanionReflection({ runtimeCwd, timeoutMs: 5_000 }), "none");
});

/**
 * One reflection attempt whose provider call never returns on its own.
 *
 * Exactly the shape the dreamer's spawned call has: it holds until it answers or until the registration it belongs
 * to is aborted, and the abort is what settles it. The seam carries no store, root or model capability - the store
 * resolving phase is the production plan's, and a focused test cannot script a live model call.
 */
function hangingReflection(probe: { entered: boolean; aborts: number }): CompanionSessionReflectionDeps {
  let abortCall: () => void = () => undefined;
  const call = new Promise<void>((_resolve, reject) => {
    abortCall = () => reject(new Error("companion_reflection_preempted"));
  });
  return Object.freeze({
    plan: async () =>
      Object.freeze({
        kind: "run" as const,
        attempt: Object.freeze({
          run: async (): Promise<void> => {
            probe.entered = true;
            await call;
          },
          abort: (): void => {
            probe.aborts += 1;
            abortCall();
          },
          close: (): void => undefined,
        }),
      }),
  });
}

async function untilProviderCallStarts(probe: { entered: boolean }): Promise<void> {
  for (let tick = 0; tick < 2_000 && !probe.entered; tick += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probe.entered, true, "the attempt never reached its provider call");
}

/**
 * A MOUNT NEVER WAITS FOR A MODEL CALL.
 *
 * The reflection runs a spawned provider call (this module's own measurement: 8 748 ms against a reachable provider,
 * 4 306 ms against one that rejected the key) inside the window that pins MAGIC_CONTEXT_STORAGE_DIR, cwd and the two
 * XDG roots. Measured on that accessor before this test existed: a mount started inside the window waited 9 005 ms
 * of it, against 13 ms with no holder at all. The property is not that the reflection is fast - it is that the mount
 * never pays for the call: it asks the attempt to yield, the dreamer's own abort stops the spawned call, and the
 * mount takes the globals for the milliseconds its own load needs.
 */
test("a reflection whose provider call hangs does not hold a runtime mount", async (t) => {
  const reflectionRoot = mkdtempSync(join(tmpdir(), "companion-reflection-hung-"));
  const mountRoot = mkdtempSync(join(tmpdir(), "companion-reflection-mount-"));
  const mountStore = join(mountRoot, "data", "cortexkit", "magic-context");
  const ambient = {
    cwd: process.cwd(),
    storage: process.env.MAGIC_CONTEXT_STORAGE_DIR,
    data: process.env.XDG_DATA_HOME,
    config: process.env.XDG_CONFIG_HOME,
  };
  const probe = { entered: false, aborts: 0 };
  let mountRead: string | undefined;
  try {
    const reflection = reflectCompanionSessionOnce(
      { runtimeCwd: reflectionRoot, timeoutMs: 2_000 },
      hangingReflection(probe),
    );
    await untilProviderCallStarts(probe);
    const startedAt = Date.now();
    await reloadMagicContextInRuntimeRoot(
      {
        reload: async (): Promise<void> => {
          mountRead = process.env.MAGIC_CONTEXT_STORAGE_DIR;
        },
      } as unknown as DefaultResourceLoader,
      mountRoot,
    );
    const mountElapsedMs = Date.now() - startedAt;
    const outcome = await reflection;
    t.diagnostic(`mount ${mountElapsedMs} ms, reflection ${outcome}, abort calls ${probe.aborts}`);
    assert.equal(outcome, "preempted", "the attempt names the mount that took the globals rather than a failure");
    assert.equal(probe.aborts, 1, "the mount asks once, and the dreamer's own abort is what stops the call");
    assert.equal(mountRead, mountStore, "the mount resolves its own store, never the reflection's");
    assert.ok(mountElapsedMs < 1_000, `the mount waited ${mountElapsedMs} ms for a provider call it must not wait for`);
    assert.equal(process.env.MAGIC_CONTEXT_STORAGE_DIR, ambient.storage);
    assert.equal(process.env.XDG_DATA_HOME, ambient.data);
    assert.equal(process.env.XDG_CONFIG_HOME, ambient.config);
    assert.equal(process.cwd(), ambient.cwd);
  } finally {
    if (ambient.storage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = ambient.storage;
    if (ambient.data === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = ambient.data;
    if (ambient.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ambient.config;
    process.chdir(ambient.cwd);
    rmSync(reflectionRoot, { recursive: true, force: true });
    rmSync(mountRoot, { recursive: true, force: true });
  }
});

/**
 * The other half of that preemption: it costs the reflection nothing it has to pay for.
 *
 * A reflection that loses the globals to a mount did not fail - it never got to answer - so its marker stays and
 * its attempt count does not move. A budget that counted these would abandon a reflection on the third mount of a
 * session, which is a decision the player never made and never saw.
 */
test("a preempted reflection keeps its marker and spends no attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "companion-reflection-preempted-"));
  const mountRoot = mkdtempSync(join(tmpdir(), "companion-reflection-preempted-mount-"));
  const probe = { entered: false, aborts: 0 };
  try {
    await recordPendingCompanionReflection(root);
    const reflection = runPendingCompanionReflection({ runtimeCwd: root, timeoutMs: 2_000 }, hangingReflection(probe));
    await untilProviderCallStarts(probe);
    await reloadMagicContextInRuntimeRoot(
      { reload: async (): Promise<void> => undefined } as unknown as DefaultResourceLoader,
      mountRoot,
    );
    assert.equal(await reflection, "deferred");
    const marker = JSON.parse(readFileSync(companionReflectionPendingPath(root), "utf8")) as { attempts: number };
    assert.equal(marker.attempts, 0, "a preempted attempt is not a failure and must not spend the retry budget");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mountRoot, { recursive: true, force: true });
  }
});

test("a short session with 0 compartments and only mechanical XML turns returns not_applicable without calling a model", async () => {
  const root = mkdtempSync(join(tmpdir(), "companion-reflection-mechanical-"));
  const storeDir = join(root, "data", "cortexkit", "magic-context");
  mkdirSync(storeDir, { recursive: true });
  const dbPath = join(storeDir, "context.db");
  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.exec(`
      CREATE TABLE session_meta (
        session_id TEXT PRIMARY KEY,
        last_response_time INTEGER,
        cached_m0_project_identity TEXT
      );
      CREATE TABLE compartments (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        start_message INTEGER NOT NULL,
        end_message INTEGER NOT NULL,
        title TEXT,
        content TEXT,
        importance INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE message_history_fts (
        session_id TEXT,
        message_ordinal TEXT,
        message_id TEXT,
        role TEXT,
        content TEXT
      );
    `);
    sqlite
      .prepare("INSERT INTO session_meta (session_id, last_response_time, cached_m0_project_identity) VALUES (?, ?, ?)")
      .run("ses-mechanical", Date.now(), "project-mechanical");
    sqlite
      .prepare(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "ses-mechanical",
        "1",
        "m1",
        "user",
        "<world-state>Day 1</world-state>\n<execution-result>settled</execution-result>",
      );
  } finally {
    sqlite.close();
  }
  try {
    const outcome = await reflectCompanionSessionOnce({ runtimeCwd: root, timeoutMs: 5_000 });
    assert.equal(outcome, "not_applicable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
