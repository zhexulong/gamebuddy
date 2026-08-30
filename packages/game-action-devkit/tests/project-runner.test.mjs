import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readdir, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeInvocation, readActionProjectManifest, runActionProject } from "../src/project-runner.mjs";

async function removeTree(root) {
  const pending = [{ target: root, visited: false }];
  let operations = 0;
  while (pending.length > 0) {
    if (++operations > 10_000) throw new Error("project_runner_test_cleanup_did_not_converge");
    const current = pending.pop();
    let details;
    try {
      details = await lstat(current.target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      await unlink(current.target);
      continue;
    }
    if (current.visited) {
      try {
        await rmdir(current.target);
        continue;
      } catch (error) {
        if (error?.code !== "ENOTEMPTY") throw error;
      }
    }
    pending.push({ target: current.target, visited: true });
    for (const entry of await readdir(current.target, { withFileTypes: true })) {
      pending.push({ target: path.join(current.target, entry.name), visited: false });
    }
  }
}

async function withProject(files, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "action-project-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text);
    }
    await callback(root);
  } finally { await removeTree(root); }
}

const adapter = `export async function runActionProject({ manifest, invocation }) { return { schema: "gamebuddy-action-scenario-result/v1", gameId: manifest.gameId, status: invocation.command, actionId: invocation.actionId ?? null, ...(invocation.runId === undefined ? {} : { runId: invocation.runId }), evidenceRoot: manifest.evidenceRoot, briefFile: invocation.briefFile ?? null }; }`;
const manifestValue = { schema: "gamebuddy-action-project/v1", gameId: "stardew", projectVersion: 1, adapter: "./adapter.mjs", portfolio: "./portfolio.json", toolInventory: "./inventory.json", evidenceRoot: "./artifacts/action-runs", defaultProfileExample: "./profile.json" };
const manifest = JSON.stringify(manifestValue);
const dependencies = { "adapter.mjs": adapter, "portfolio.json": "{}", "inventory.json": "{}", "profile.json": "{}" };
const portfolioMissingAdapter = `export async function runActionProject({ manifest, invocation }) { if (invocation.command !== "status" || invocation.actionId !== undefined || manifest.portfolioMissing !== true || !Object.isFrozen(manifest)) throw new Error("portfolio_missing_observation_invalid"); return { schema: "gamebuddy-action-scenario-result/v1", gameId: manifest.gameId, status: "blocked", reasonCode: "portfolio_missing" }; }`;

test("normalizes only explicit immutable invocation fields", () => {
  const profileFile = path.join(os.tmpdir(), "profiles", "default.json");
  const invocation = normalizeInvocation({ command: "preflight", actionId: "equip_tool", profileFile });
  assert.deepEqual(invocation, { command: "preflight", actionId: "equip_tool", profileFile });
  assert.ok(Object.isFrozen(invocation));
    assert.throws(() => normalizeInvocation({ command: "check", gameId: "stardew" }), /invalid_invocation_key/);
    assert.throws(() => normalizeInvocation({ command: "run-live", runId: "operator-run" }), /invalid_invocation_key/);
    assert.throws(() => normalizeInvocation({ command: "run-live", evidenceRoot: "C:/operator" }), /invalid_invocation_key/);
  assert.throws(() => normalizeInvocation({ command: "check", actionId: "../equip" }), /invalid_action_id/);
  assert.throws(() => normalizeInvocation({ command: "check", briefFile: "../brief.json" }), /invalid_briefFile/);
});

test("loads a strict project manifest and delegates without a game registry", async () => {
  await withProject({ "project.json": manifest, ...dependencies }, async (root) => {
    const loaded = await readActionProjectManifest(path.join(root, "project.json"));
    assert.equal(loaded.gameId, "stardew");
    const result = await runActionProject({ projectFile: loaded.manifestFile, invocation: { command: "status", actionId: "equip_tool" } });
    assert.deepEqual(result, { schema: "gamebuddy-action-scenario-result/v1", gameId: "stardew", status: "status", actionId: "equip_tool", evidenceRoot: path.join(root, "artifacts", "action-runs"), briefFile: null });
  });
});

test("allows selectorless status to report a missing portfolio while strict reads reject it", async () => {
  await withProject({
    "project.json": JSON.stringify({ ...manifestValue, adapter: "./portfolio-missing-adapter.mjs" }),
    "portfolio-missing-adapter.mjs": portfolioMissingAdapter,
    "inventory.json": "{}",
    "profile.json": "{}",
  }, async (root) => {
    const projectFile = path.join(root, "project.json");
    const status = await runActionProject({ projectFile, invocation: { command: "status" } });
    assert.deepEqual(status, {
      schema: "gamebuddy-action-scenario-result/v1",
      gameId: "stardew",
      status: "blocked",
      reasonCode: "portfolio_missing",
    });
    await assert.rejects(
      runActionProject({ projectFile, invocation: { command: "check" } }),
      /manifest_dependency_missing/,
    );
    await assert.rejects(readActionProjectManifest(projectFile), /manifest_dependency_missing/);

    await writeFile(path.join(root, "portfolio.json"), "{}");
    await unlink(path.join(root, "portfolio.json"));
    await assert.rejects(
      runActionProject({ projectFile, invocation: { command: "status", actionId: "equip_tool" } }),
      /manifest_dependency_missing/,
    );
  });
});

test("rejects an absent portfolio through a symlink even for selectorless status", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "action-project-portfolio-outside-"));
  try {
    await writeFile(path.join(outside, "portfolio.json"), "{}");
    await withProject({
      "project.json": manifest,
      "adapter.mjs": adapter,
      "inventory.json": "{}",
      "profile.json": "{}",
    }, async (root) => {
      try { await symlink(path.join(outside, "portfolio.json"), path.join(root, "portfolio.json"), "file"); } catch (error) {
        if (error?.code === "EPERM") return t.skip("file symlinks unavailable");
        throw error;
      }
      await assert.rejects(
        runActionProject({ projectFile: path.join(root, "project.json"), invocation: { command: "status" } }),
        /manifest_dependency_escape/,
      );
    });
  } finally { await removeTree(outside); }
});

test("mints a fresh bounded opaque run id and passes canonical manifest roots for every run-live attempt", async () => {
  await withProject({ "project.json": manifest, ...dependencies }, async (root) => {
    const projectFile = path.join(root, "project.json");
    const [first, second] = await Promise.all([
      runActionProject({ projectFile, invocation: { command: "run-live", actionId: "equip_tool", profileFile: path.join(root, "profile.json") } }),
      runActionProject({ projectFile, invocation: { command: "run-live", actionId: "equip_tool", profileFile: path.join(root, "profile.json") } }),
    ]);
    assert.match(first.runId, /^ar1_[a-z0-9]+_[a-f0-9]{32}$/);
    assert.notEqual(first.runId, second.runId);
    assert.equal(first.evidenceRoot, path.join(root, "artifacts", "action-runs"));
  });
});

test("resolves a declared brief to one canonical project-owned regular file", async (t) => {
  await withProject({ "project.json": manifest, ...dependencies, "briefs/equip.json": "{}" }, async (root) => {
    const result = await runActionProject({
      projectFile: path.join(root, "project.json"),
      invocation: { command: "preflight", actionId: "equip_tool", profileFile: path.join(root, "profile.json"), briefFile: "briefs/equip.json" },
    });
    assert.equal(result.briefFile, path.join(root, "briefs", "equip.json"));

    const outside = await mkdtemp(path.join(os.tmpdir(), "action-project-brief-outside-"));
    try {
      await writeFile(path.join(outside, "brief.json"), "{}");
      try { await symlink(path.join(outside, "brief.json"), path.join(root, "briefs", "linked.json"), "file"); } catch (error) {
        if (error?.code === "EPERM") return t.skip("file symlinks unavailable");
        throw error;
      }
      await assert.rejects(
        runActionProject({ projectFile: path.join(root, "project.json"), invocation: { command: "preflight", actionId: "equip_tool", profileFile: path.join(root, "profile.json"), briefFile: "briefs/linked.json" } }),
        /brief_dependency_escape/,
      );
    } finally { await removeTree(outside); }
  });
});

test("rejects adapter and inventory dependencies that physically escape the project directory", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "action-project-outside-"));
  try {
    await writeFile(path.join(outside, "adapter.mjs"), adapter);
    await writeFile(path.join(outside, "inventory.json"), "{}");
    for (const [linkName, targetName, localFiles] of [
      ["adapter.mjs", "adapter.mjs", { ...dependencies, "adapter.mjs": undefined }],
      ["inventory.json", "inventory.json", { ...dependencies, "inventory.json": undefined }],
    ]) {
       await withProject(Object.fromEntries(Object.entries(localFiles).filter(([, value]) => value !== undefined)), async (root) => {
        try { await symlink(path.join(outside, targetName), path.join(root, linkName), "file"); } catch (error) {
          if (error?.code === "EPERM") return t.skip("file symlinks unavailable");
          throw error;
        }
        await writeFile(path.join(root, "project.json"), manifest);
        await assert.rejects(readActionProjectManifest(path.join(root, "project.json")), /manifest_dependency_escape/);
      });
    }
  } finally { await removeTree(outside); }
});

test("validates the neutral scenario-result schema and field bounds", async () => {
  const reports = [
    { gameId: "stardew", status: "ok" },
    { schema: "wrong", gameId: "stardew", status: "ok" },
    { schema: "gamebuddy-action-scenario-result/v1", gameId: "stardew", status: null },
    { schema: "gamebuddy-action-scenario-result/v1", gameId: "stardew", status: "x".repeat(129) },
    ...["outcome", "reasonCode", "claimScope", "runId", "evidenceRoot"].map((field) => ({ schema: "gamebuddy-action-scenario-result/v1", gameId: "stardew", status: "ok", [field]: null })),
    { schema: "gamebuddy-action-scenario-result/v1", gameId: "stardew", status: "ok", actionId: "not opaque/id" },
    { schema: "gamebuddy-action-scenario-result/v1", gameId: "stardew", status: "ok", reasonCode: "x".repeat(513) },
  ];
  await withProject({ "project.json": manifest, ...dependencies }, async (root) => {
    for (const [index, report] of reports.entries()) {
      const adapter = `./adapter-${index}.mjs`;
      const projectFile = path.join(root, `project-${index}.json`);
      await writeFile(path.join(root, `adapter-${index}.mjs`), `export async function runActionProject() { return ${JSON.stringify(report)}; }`);
      await writeFile(projectFile, JSON.stringify({ ...manifestValue, adapter }));
      await assert.rejects(runActionProject({ projectFile, invocation: { command: "status" } }), /adapter_report_invalid/);
    }
    const validIndex = reports.length;
    const valid = {
      schema: "gamebuddy-action-scenario-result/v1",
      gameId: "stardew",
      status: "ok",
      actionId: null,
      scenarioId: null,
      briefFile: null,
      outcome: "x".repeat(512),
      reasonCode: "x".repeat(512),
      claimScope: "x".repeat(512),
      runId: "x".repeat(128),
      evidenceRoot: "x".repeat(512),
    };
    const validProjectFile = path.join(root, `project-${validIndex}.json`);
    await writeFile(path.join(root, `adapter-${validIndex}.mjs`), `export async function runActionProject() { return ${JSON.stringify(valid)}; }`);
    await writeFile(validProjectFile, JSON.stringify({ ...manifestValue, adapter: `./adapter-${validIndex}.mjs` }));
    const result = await runActionProject({ projectFile: validProjectFile, invocation: { command: "status" } });
    assert.equal(result.status, "ok");
  });
});

test("fails closed for malformed manifests, escaping references, missing dependencies, and invalid reports", async () => {
  await withProject(dependencies, async (root) => {
    await writeFile(path.join(root, "bad.json"), JSON.stringify({ ...manifestValue, adapter: "../adapter.mjs" }));
    await assert.rejects(readActionProjectManifest(path.join(root, "bad.json")), /invalid_adapter/);
    await writeFile(path.join(root, "missing.json"), JSON.stringify({ ...manifestValue, adapter: "./missing.mjs" }));
    await assert.rejects(readActionProjectManifest(path.join(root, "missing.json")), /manifest_dependency_missing/);
    await writeFile(path.join(root, "invalid.mjs"), "export async function runActionProject() { return { status: 'ok' }; }");
    await writeFile(path.join(root, "invalid.json"), JSON.stringify({ ...manifestValue, adapter: "./invalid.mjs" }));
    await assert.rejects(runActionProject({ projectFile: path.join(root, "invalid.json"), invocation: { command: "check" } }), /adapter_report_invalid/);
  });
});
