import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_PRIVATE_RESULT_BYTES,
  beginPrivateResultFile,
  cleanupPrivateResultFile,
  readPrivateResultFile,
  writePrivateResultFile,
} from "@gamebuddy/game-action-devkit";
import { runEquipToolLifecycle } from "../src/equip-tool-lifecycle.mjs";
import { createImmutableReleaseBundleBinding, IMMUTABLE_RELEASE_BUNDLE_FILES } from "../src/immutable-release-bundle.mjs";
import { writeLifecycleCleanupResult } from "../src/write-lifecycle-result.mjs";

const proof = Object.freeze({
  schema: "gamebuddy-action-scenario-result/v1",
  runId: "ar1_test",
  gameId: "stardew",
  actionId: "equip_tool",
  stage: "run-live",
  profileIdentity: "target-profile",
  claimScope: "native-local-equip-tool-v1",
  receipt: Object.freeze({
    state: "succeeded",
    reasonCode: "tool_selected",
    hasEvidence: true,
    request: Object.freeze({ requestId: "req", idempotencyKey: "idem", action: "equip_tool", args: Object.freeze({ slot: 1 }), expectedRevision: 4 }),
    accepted: Object.freeze({ requestId: "req", executionId: "exec" }),
    terminal: Object.freeze({ requestId: "req", executionId: "exec", state: "succeeded", reasonCode: "tool_selected", revision: 5 }),
    evidence: Object.freeze({ slot: 1, before: "Hoe", expected: "Axe", after: "Axe" }),
  }),
  postcondition: Object.freeze({ revision: 5, currentTool: "Axe", expectedTool: "Axe", selected: Object.freeze({ slot: 1, label: "Axe" }) }),
  verdict: "passed",
  reasonCode: "tool_selected",
});
const cleanup = Object.freeze({ schema: "gamebuddy-stardew-lifecycle-cleanup-result/v1", completed: true });
const BUNDLE_CONTENTS = Object.freeze({
  "GameBuddy.Stardew.dll": "mod",
  "GameBuddy.Stardew.Core.dll": "core",
  "GameBuddy.Stardew.deps.json": "{}",
  "manifest.json": JSON.stringify({ Name: "GameBuddy", UniqueID: "zhexulong.GameBuddy", EntryDll: "GameBuddy.Stardew.dll", Version: "0.1.0" }),
});
function bundleDigest() {
  const hash = createHash("sha256");
  for (const name of IMMUTABLE_RELEASE_BUNDLE_FILES) {
    hash.update(Buffer.from(name)); hash.update(Buffer.from([0])); hash.update(Buffer.from(BUNDLE_CONTENTS[name]));
  }
  return hash.digest("hex");
}

async function removeFixtureTree(directory) {
  const { lstat, readdir } = await import("node:fs/promises");
  const pending = [{ path: directory, visited: false }];
  let steps = 0;
  while (pending.length > 0) {
    if (++steps > 10_000) throw new Error("equip_lifecycle_fixture_cleanup_unbounded");
    const current = pending.pop();
    const stats = await lstat(current.path).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stats) continue;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      await unlink(current.path);
      continue;
    }
    if (!current.visited) {
      pending.push({ path: current.path, visited: true });
      const entries = await readdir(current.path);
      for (const entry of entries) pending.push({ path: path.join(current.path, entry), visited: false });
      continue;
    }
    await rmdir(current.path);
  }
}

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "equip-lifecycle-"));
  const projectRoot = path.join(root, "project");
  const releaseDir = path.join(root, "release");
  const modsPath = path.join(root, "game", "Mods");
  const runRoot = path.join(root, "runs");
  await mkdir(projectRoot); await mkdir(releaseDir); await mkdir(modsPath, { recursive: true }); await mkdir(runRoot);
  for (const [name, contents] of Object.entries(BUNDLE_CONTENTS)) await writeFile(path.join(releaseDir, name), contents);
  try { await callback({ root, projectRoot, releaseDir, modsPath, runRoot }); }
  finally { await removeFixtureTree(root); }
}

function profile(root) {
  return Object.freeze({
    gameInstallPath: path.join(root, "game"), modsPath: path.join(root, "game", "Mods"), fixtureTransactionRoot: path.join(root, "fixture-transaction"), nativeFixtureRoot: path.join(root, "native-fixture"),
    saveIdentity: "GameBuddyFixtureEquipTool_123", templateIdentity: "GameBuddyFixtureEquipTool_123",
    profileIdentity: "target-profile", timeoutMs: 30_000,
  });
}

function claims(root, texts = [JSON.stringify(proof), JSON.stringify(cleanup)]) {
  let index = 0;
  const entries = new Map();
  return {
    entries,
    beginResult: async () => {
      const current = index++;
      const resultFile = path.join(root, `result-${current}.json`);
      await writeFile(resultFile, texts[current] ?? "");
      const claim = Object.freeze({ resultFile, current });
      entries.set(claim, { text: texts[current], cleaned: false });
      return claim;
    },
    readResult: async (claim) => entries.get(claim).text,
    cleanupResult: async (claim) => { entries.get(claim).cleaned = true; await unlink(claim.resultFile); },
  };
}

function productionClaims(root) {
  const claims = [];
  return {
    claims,
    beginResult: async () => {
      const claim = await beginPrivateResultFile({ root });
      claims.push(claim);
      return claim;
    },
    readResult: readPrivateResultFile,
    cleanupResult: cleanupPrivateResultFile,
  };
}

test("real writer and Devkit claims flow through lifecycle parser and immutable binding", async () => fixture(async ({ root, projectRoot, releaseDir, modsPath, runRoot }) => {
  const c = productionClaims(root);
  const binding = await createImmutableReleaseBundleBinding({
    releaseDir, modsPath, runRoot, runIdentity: "ar1_test", expectedDigest: bundleDigest(),
  });
  const result = await binding.runLifecycle(async ({ releaseDir: stagedReleaseDir }) => runEquipToolLifecycle({
    projectRoot,
    profile: profile(root),
    runId: "ar1_test",
    releaseDir: stagedReleaseDir,
    resultRoot: root,
    ...c,
    resolvePowerShell: () => "fake-powershell",
    runChild: async ({ args }) => {
      const value = (flag) => args[args.indexOf(flag) + 1];
      await writePrivateResultFile(value("-ResultFile"), JSON.stringify(proof));
      await writeLifecycleCleanupResult(value("-LifecycleResultFile"), { completed: true });
      return { code: 0, signal: null };
    },
  }));
  assert.equal(result.receipt.evidence.expected, "Axe");
  assert.equal(result.postcondition.currentTool, "Axe");
  assert.equal(binding.inspect().restored, true);
  assert.equal(c.claims.length, 2);
  for (const claim of c.claims) await assert.rejects(readFile(claim.resultFile), /ENOENT/);
  await binding.close();
}));

test("lifecycle adapter passes exact fixed arguments and validates separate action and cleanup results", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  const c = claims(root);
  let call;
  const result = await runEquipToolLifecycle({
    projectRoot, profile: profile(root), runId: "ar1_test", releaseDir, resultRoot: root,
    ...c,
    resolvePowerShell: () => "fake-powershell",
    runChild: async (input) => { call = input; return { code: 0, signal: null }; },
  });
  assert.equal(result.cleanupResult.completed, true);
  assert.equal(result.operationResult.receipt.evidence.expected, "Axe");
  assert.equal(call.command, "fake-powershell");
  assert.equal(call.cwd, projectRoot);
  assert.equal(call.stdio, "pipe");
  assert.equal(call.terminationPolicy, "immediate");
  const value = (flag) => call.args[call.args.indexOf(flag) + 1];
  assert.equal(value("-GamePath"), path.join(root, "game"));
  assert.equal(value("-ModsPath"), path.join(root, "game", "Mods"));
  assert.equal(value("-FixtureRoot"), path.join(root, "native-fixture"));
  assert.equal(value("-SaveName"), "GameBuddyFixtureEquipTool_123");
  assert.equal(value("-TemplateName"), "GameBuddyFixtureEquipTool_123");
  assert.equal(value("-ReleaseDir"), releaseDir);
  assert.equal(value("-Action"), "equip_tool");
  assert.equal(value("-TimeoutSeconds"), "30");
  assert.notEqual(value("-ResultFile"), value("-LifecycleResultFile"));
  assert.match(value("-ScenarioIdentity"), /"runId":"ar1_test"/);
  assert.ok([...c.entries.values()].every((entry) => entry.cleaned));
}));

test("lifecycle adapter fails closed for child, proof, cleanup receipt, and cleanup errors", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  const base = { projectRoot, profile: profile(root), runId: "ar1_test", releaseDir, resultRoot: root, resolvePowerShell: () => "fake" };
  await assert.rejects(() => runEquipToolLifecycle({ ...base, ...claims(root), runChild: async () => ({ code: 2, signal: null }) }), /child_nonzero/);
  const wrongProof = { ...proof, runId: "other" };
  await assert.rejects(() => runEquipToolLifecycle({ ...base, ...claims(root, [JSON.stringify(wrongProof), JSON.stringify(cleanup)]), runChild: async () => ({ code: 0, signal: null }) }), /action_result_invalid/);
  await assert.rejects(() => runEquipToolLifecycle({ ...base, ...claims(root, [JSON.stringify(proof), JSON.stringify({ ...cleanup, completed: false })]), runChild: async () => ({ code: 0, signal: null }) }), /cleanup_not_completed/);
  const c = claims(root);
  await assert.rejects(
    () => runEquipToolLifecycle({ ...base, ...c, cleanupResult: async () => { throw new Error("raw_cleanup_detail"); }, runChild: async () => ({ code: 0, signal: null }) }),
    (error) => error.message === "stardew_equip_tool_lifecycle_result_cleanup_failed"
      && error.cause === undefined
      && error.errors === undefined,
  );
  for (const entry of c.entries.keys()) await unlink(entry.resultFile).catch(() => {});
}));

test("private-result claim creation failures are bounded and clean an earlier claim", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  const base = {
    projectRoot,
    profile: profile(root),
    runId: "ar1_test",
    releaseDir,
    resultRoot: root,
    resolvePowerShell: () => "fake",
  };
  await assert.rejects(
    () => runEquipToolLifecycle({
      ...base,
      beginResult: async () => { throw new Error("raw_first_claim_detail"); },
    }),
    (error) => error.message === "stardew_equip_tool_lifecycle_result_claim_failed"
      && error.cause === undefined
      && error.errors === undefined,
  );

  const firstClaim = Object.freeze({ resultFile: path.join(root, "first-claim.json") });
  await writeFile(firstClaim.resultFile, "claim");
  let attempts = 0;
  const cleaned = [];
  await assert.rejects(
    () => runEquipToolLifecycle({
      ...base,
      beginResult: async () => {
        attempts += 1;
        if (attempts === 1) return firstClaim;
        throw new Error("raw_second_claim_detail");
      },
      cleanupResult: async (claim) => { cleaned.push(claim); await unlink(claim.resultFile); },
    }),
    (error) => error.message === "stardew_equip_tool_lifecycle_result_claim_failed"
      && error.cause === undefined
      && error.errors === undefined,
  );
  assert.deepEqual(cleaned, [firstClaim]);
  await assert.rejects(readFile(firstClaim.resultFile), /ENOENT/);
}));

test("production two-claim protocol rejects missing, malformed, oversized, wrong-identity, and incomplete results", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  const base = {
    projectRoot,
    profile: profile(root),
    runId: "ar1_test",
    releaseDir,
    resultRoot: root,
    resolvePowerShell: () => "fake",
  };
  const run = (writeClaims) => runEquipToolLifecycle({
    ...base,
    runChild: async ({ args }) => {
      const value = (flag) => args[args.indexOf(flag) + 1];
      await writeClaims({
        actionFile: value("-ResultFile"),
        lifecycleFile: value("-LifecycleResultFile"),
      });
      return { code: 0, signal: null };
    },
  });
  const writeAction = (file, value = proof) => writePrivateResultFile(file, JSON.stringify(value));
  const writeCleanup = (file, completed = true) => writeLifecycleCleanupResult(file, { completed });

  await assert.rejects(run(async ({ lifecycleFile }) => writeCleanup(lifecycleFile)), /action_result_missing/);
  await assert.rejects(run(async ({ actionFile }) => writeAction(actionFile)), /cleanup_result_missing/);
  await assert.rejects(run(async ({ actionFile, lifecycleFile }) => {
    await writePrivateResultFile(actionFile, "{");
    await writeCleanup(lifecycleFile);
  }), /action_result_invalid/);
  await assert.rejects(run(async ({ actionFile, lifecycleFile }) => {
    await writeFile(actionFile, "x".repeat(MAX_PRIVATE_RESULT_BYTES + 1), { flag: "wx" });
    await writeCleanup(lifecycleFile);
  }), /action_result_invalid/);
  await assert.rejects(run(async ({ actionFile, lifecycleFile }) => {
    await writeAction(actionFile, { ...proof, runId: "ar1_wrong" });
    await writeCleanup(lifecycleFile);
  }), /action_result_invalid/);
  await assert.rejects(run(async ({ actionFile, lifecycleFile }) => {
    await writeAction(actionFile);
    await writePrivateResultFile(lifecycleFile, "{}");
  }), /cleanup_result_invalid/);
  await assert.rejects(run(async ({ actionFile, lifecycleFile }) => {
    await writeAction(actionFile);
    await writeCleanup(lifecycleFile, false);
  }), /cleanup_not_completed/);
  await assert.rejects(run(async ({ actionFile, lifecycleFile }) => {
    await writeAction(actionFile);
    await writeCleanup(lifecycleFile);
    await writePrivateResultFile(actionFile, JSON.stringify(proof));
  }), /child_failed/);

  await assert.rejects(
    () => runEquipToolLifecycle({ ...base, runChild: async () => { throw new Error("raw_child_detail"); } }),
    (error) => error.message === "stardew_equip_tool_lifecycle_child_failed"
      && error.cause === undefined
      && error.errors === undefined,
  );
  await assert.rejects(
    () => runEquipToolLifecycle({ ...base, runChild: async () => { throw new Error("game_action_child_timeout"); } }),
    /child_timeout/,
  );
  await assert.rejects(
    () => runEquipToolLifecycle({ ...base, runChild: async () => { throw new Error("game_action_child_spawn_failed"); } }),
    /child_spawn_failed/,
  );
}));
