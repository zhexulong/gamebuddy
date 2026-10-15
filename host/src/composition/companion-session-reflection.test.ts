import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { reflectCompanionSessionOnce } from "./companion-session-reflection.js";

/**
 * The reflection runs inside the exit reclamation, so what matters most here is that it cannot become a second
 * failure of the exit it belongs to: every outcome that is not a completed reflection is a bounded status, and
 * nothing it does is allowed to throw.
 */

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
