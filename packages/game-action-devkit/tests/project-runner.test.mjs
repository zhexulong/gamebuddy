import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeInvocation, readActionProjectManifest, runActionProject } from "../src/project-runner.mjs";

async function withProject(files, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "action-project-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text);
    }
    await callback(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const adapter = `export async function runActionProject({ manifest, invocation }) { return { gameId: manifest.gameId, status: invocation.command, actionId: invocation.actionId ?? null }; }`;
const manifest = JSON.stringify({ schema: "gamebuddy-action-project/v1", gameId: "stardew", projectVersion: 1, adapter: "./adapter.mjs", toolInventory: "./inventory.json" });

test("normalizes only explicit immutable invocation fields", () => {
  const invocation = normalizeInvocation({ command: "check", actionId: "equip_tool", profileFile: "profiles/default.json" });
  assert.deepEqual(invocation, { command: "check", actionId: "equip_tool", profileFile: "profiles/default.json" });
  assert.ok(Object.isFrozen(invocation));
  assert.throws(() => normalizeInvocation({ command: "check", gameId: "stardew" }), /invalid_invocation_key/);
  assert.throws(() => normalizeInvocation({ command: "check", actionId: "../equip" }), /invalid_action_id/);
  assert.throws(() => normalizeInvocation({ command: "check", briefFile: "../brief.json" }), /invalid_briefFile/);
});

test("loads a strict project manifest and delegates without a game registry", async () => {
  await withProject({ "project.json": manifest, "adapter.mjs": adapter, "inventory.json": "{}" }, async (root) => {
    const loaded = await readActionProjectManifest(path.join(root, "project.json"));
    assert.equal(loaded.gameId, "stardew");
    const result = await runActionProject({ projectFile: loaded.manifestFile, invocation: { command: "status", actionId: "equip_tool" } });
    assert.deepEqual(result, { gameId: "stardew", status: "status", actionId: "equip_tool" });
  });
});

test("rejects adapter and inventory dependencies that physically escape the project directory", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "action-project-outside-"));
  try {
    await writeFile(path.join(outside, "adapter.mjs"), adapter);
    await writeFile(path.join(outside, "inventory.json"), "{}");
    for (const [linkName, targetName, localFiles] of [
      ["adapter.mjs", "adapter.mjs", { "inventory.json": "{}" }],
      ["inventory.json", "inventory.json", { "adapter.mjs": adapter }],
    ]) {
      await withProject(localFiles, async (root) => {
        try { await symlink(path.join(outside, targetName), path.join(root, linkName), "file"); } catch (error) {
          if (error?.code === "EPERM") return t.skip("file symlinks unavailable");
          throw error;
        }
        await writeFile(path.join(root, "project.json"), manifest);
        await assert.rejects(readActionProjectManifest(path.join(root, "project.json")), /manifest_dependency_escape/);
      });
    }
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("fails closed for malformed manifests, escaping references, missing dependencies, and invalid reports", async () => {
  await withProject({ "adapter.mjs": adapter, "inventory.json": "{}" }, async (root) => {
    await writeFile(path.join(root, "bad.json"), JSON.stringify({ schema: "gamebuddy-action-project/v1", gameId: "stardew", projectVersion: 1, adapter: "../adapter.mjs", toolInventory: "./inventory.json" }));
    await assert.rejects(readActionProjectManifest(path.join(root, "bad.json")), /invalid_adapter/);
    await writeFile(path.join(root, "missing.json"), JSON.stringify({ schema: "gamebuddy-action-project/v1", gameId: "stardew", projectVersion: 1, adapter: "./missing.mjs", toolInventory: "./inventory.json" }));
    await assert.rejects(readActionProjectManifest(path.join(root, "missing.json")), /manifest_dependency_missing/);
    await writeFile(path.join(root, "invalid.mjs"), "export async function runActionProject() { return { status: 'ok' }; }");
    await writeFile(path.join(root, "invalid.json"), JSON.stringify({ schema: "gamebuddy-action-project/v1", gameId: "stardew", projectVersion: 1, adapter: "./invalid.mjs", toolInventory: "./inventory.json" }));
    await assert.rejects(runActionProject({ projectFile: path.join(root, "invalid.json"), invocation: { command: "check" } }), /adapter_report_invalid/);
  });
});
