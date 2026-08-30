import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runActionProject } from "../src/project-adapter.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(directory);

test("only exposes the current package-owned inventory command", async () => {
  const report = await runActionProject({
    manifest: { gameId: "stardew", inventoryFile: path.join(projectDirectory, "tool-inventory.json") },
    invocation: { command: "inventory" },
  });
  assert.equal(report.gameId, "stardew");
  assert.equal(report.status, "inventory");
  assert.equal(report.fileCount, 166);
  await assert.rejects(runActionProject({ manifest: { gameId: "stardew" }, invocation: { command: "check" } }), /action_not_available/);
  const foreignDirectory = await mkdtemp(path.join(os.tmpdir(), "foreign-inventory-"));
  const foreignInventory = path.join(foreignDirectory, "tool-inventory.json");
  await writeFile(foreignInventory, JSON.stringify({ schema: "gamebuddy-stardew-tool-inventory/v1", entries: [] }));
  await assert.rejects(runActionProject({ manifest: { gameId: "stardew", inventoryFile: foreignInventory }, invocation: { command: "inventory" } }), /inventory_not_package_owned/);
  await rm(foreignDirectory, { recursive: true, force: true });
});

test("checks only equip_tool through the generated Core contract artifact", async () => {
  const report = await runActionProject({
    manifest: { gameId: "stardew" },
    invocation: { command: "check", actionId: "equip_tool" },
  });
  assert.deepEqual(report, { schema: "gamebuddy-action-scenario-result/v1", gameId: "stardew", status: "checked", actionId: "equip_tool" });
  await assert.rejects(
    runActionProject({ manifest: { gameId: "stardew" }, invocation: { command: "check", actionId: "enter_mine" } }),
    /action_not_available/,
  );
  const preflight = await runActionProject({
    manifest: { gameId: "stardew" },
    invocation: { command: "preflight", actionId: "equip_tool" },
  });
  assert.equal(preflight.status, "preflight");
  assert.equal(preflight.outcome, "blocked");
  await assert.rejects(
    runActionProject({ manifest: { gameId: "stardew" }, invocation: { command: "unknown", actionId: "equip_tool" } }),
    /command_not_available/,
  );
});
