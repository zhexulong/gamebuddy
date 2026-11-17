import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import {
  COMPANION_REFLECTION_MAX_ATTEMPTS,
  companionReflectionPendingPath,
  companionReflectionRuntimeCwd,
  createCompanionSessionReflectionChild,
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
