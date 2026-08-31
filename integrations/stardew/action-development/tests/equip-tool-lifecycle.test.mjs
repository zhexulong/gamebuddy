import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginPrivateResultFile,
  cleanupPrivateResultFile,
  readPrivateResultFile,
  writePrivateResultFile,
} from "@gamebuddy/game-action-devkit";
import { runEquipToolLifecycle } from "../src/equip-tool-lifecycle.mjs";
import { createImmutableReleaseBundleBinding, IMMUTABLE_RELEASE_BUNDLE_FILES } from "../src/immutable-release-bundle.mjs";
import { writeStardewClosureBackendResult } from "../src/write-lifecycle-result.mjs";

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

const BUNDLE_CONTENTS = Object.freeze({
  "GameBuddy.Stardew.dll": "mod",
  "GameBuddy.Stardew.Core.dll": "core",
  "Raffinert.FuzzySharp.dll": "fuzzy",
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

function recordingClaims(root) {
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

function scriptedClaims(root, actionText) {
  let index = 0;
  const entries = new Map();
  async function removeClaimDirectory(directory) {
    const pending = [{ path: directory, visited: false }];
    let steps = 0;
    while (pending.length > 0) {
      if (++steps > 10_000) throw new Error("equip_lifecycle_claim_cleanup_unbounded");
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
        const entriesList = await readdir(current.path);
        for (const entry of entriesList) pending.push({ path: path.join(current.path, entry), visited: false });
        continue;
      }
      await rmdir(current.path);
    }
  }
  return {
    entries,
    beginResult: async () => {
      const directory = await mkdtemp(path.join(root, `claim-${index++}-`));
      const resultFile = path.join(directory, "scenario-result.json");
      await writeFile(resultFile, actionText);
      const claim = Object.freeze({ directory, resultFile });
      entries.set(claim, { cleaned: false });
      return claim;
    },
    readResult: async (claim) => readFile(claim.resultFile, "utf8"),
    cleanupResult: async (claim) => {
      if (entries.has(claim)) entries.get(claim).cleaned = true;
      await removeClaimDirectory(claim.directory);
    },
  };
}

test("real writer and Devkit claims flow through lifecycle adapter via injected backend", async () => fixture(async ({ root, projectRoot, releaseDir, modsPath, runRoot }) => {
  const c = recordingClaims(root);
  const binding = await createImmutableReleaseBundleBinding({
    releaseDir, modsPath, runRoot, runIdentity: "ar1_test", expectedDigest: bundleDigest(),
  });
  const runBackend = async ({ actionResultFile, lifecycleResultFile }) => {
    await writePrivateResultFile(actionResultFile, JSON.stringify(proof));
    await writeStardewClosureBackendResult(lifecycleResultFile, { state: "completed" });
    return Object.freeze({ state: "completed" });
  };
  const result = await binding.runLifecycle(
    async ({ releaseDir: stagedReleaseDir }) => runEquipToolLifecycle({
      projectRoot,
      profile: profile(root),
      runId: "ar1_test",
      releaseDir: stagedReleaseDir,
      resultRoot: root,
      ...c,
      runBackend,
    }),
  );
  assert.equal(result.receipt.evidence.expected, "Axe");
  assert.equal(result.postcondition.currentTool, "Axe");
  assert.equal(binding.inspect().restored, true);
  assert.equal(c.claims.length, 2);
  for (const claim of c.claims) await assert.rejects(readFile(claim.resultFile), /ENOENT/);
  await binding.close();
}));

test("adapter rejects malformed public input without opening private result claims", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  let claimsOpened = 0;
  await assert.rejects(
    () => runEquipToolLifecycle({
      projectRoot,
      profile: undefined,
      runId: "ar1_test",
      releaseDir,
      resultRoot: root,
      beginResult: async () => { claimsOpened += 1; return Object.freeze({ resultFile: path.join(root, "unexpected.json"), directory: root }); },
      readResult: async () => "",
      cleanupResult: async () => {},
    }),
    (error) => error.message === "stardew_equip_tool_lifecycle_invalid_input"
      && error.cause === undefined && error.errors === undefined,
  );
  assert.equal(claimsOpened, 0);
}));

test("adapter passes exact backend inputs and cleans exactly two claims", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  const c = scriptedClaims(root, JSON.stringify(proof));
  let backendInput;
  const result = await runEquipToolLifecycle({
    projectRoot, profile: profile(root), runId: "ar1_test", releaseDir, resultRoot: root,
    beginResult: c.beginResult,
    readResult: c.readResult,
    cleanupResult: c.cleanupResult,
    runBackend: async (input) => {
      backendInput = input;
      return Object.freeze({ state: "completed" });
    },
  });
  assert.equal(result.operationResult.receipt.evidence.expected, "Axe");
  assert.equal(backendInput.projectRoot, projectRoot);
  assert.equal(backendInput.runId, "ar1_test");
  assert.deepEqual(backendInput.profile, profile(root));
  assert.notEqual(backendInput.actionResultFile, backendInput.lifecycleResultFile);
  assert.equal(c.entries.size, 2);
  assert.ok([...c.entries.values()].every((entry) => entry.cleaned));
}));

test("adapter fails closed for backend failures, missing action proof, and claim cleanup errors", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  const base = { projectRoot, profile: profile(root), runId: "ar1_test", releaseDir, resultRoot: root };

  await assert.rejects(
    () => runEquipToolLifecycle({
      ...base,
      ...scriptedClaims(root, JSON.stringify(proof)),
      runBackend: async () => { throw new Error("stardew_closure_backend_phase_fixture_prepare_failed"); },
    }),
    (error) => error.message === "stardew_equip_tool_lifecycle_backend_phase_fixture_prepare_failed"
      && error.cause === undefined && error.errors === undefined,
  );

  for (const backendError of [
    "raw_backend_detail C:\\private",
    "stardew_closure_backend_raw_C:\\private",
  ]) {
    await assert.rejects(
      () => runEquipToolLifecycle({
        ...base,
        ...scriptedClaims(root, JSON.stringify(proof)),
        runBackend: async () => { throw new Error(backendError); },
      }),
      (error) => error.message === "stardew_equip_tool_lifecycle_backend_unknown"
        && error.cause === undefined && error.errors === undefined
        && !error.message.includes("raw") && !error.message.includes("C:\\"),
    );
  }

  await assert.rejects(
    () => runEquipToolLifecycle({
      ...base,
      ...scriptedClaims(root, JSON.stringify(proof)),
      runBackend: async () => Object.freeze({ state: "failed" }),
    }),
    (error) => error.message === "stardew_equip_tool_lifecycle_backend_not_completed"
      && error.cause === undefined && error.errors === undefined,
  );

  await assert.rejects(
    () => runEquipToolLifecycle({
      ...base,
      ...scriptedClaims(root, ""),
      runBackend: async () => Object.freeze({ state: "completed" }),
    }),
    (error) => error.message === "stardew_equip_tool_lifecycle_action_result_missing"
      && error.cause === undefined && error.errors === undefined,
  );

  await assert.rejects(
    () => runEquipToolLifecycle({
      ...base,
      ...scriptedClaims(root, JSON.stringify({ ...proof, runId: "other_run" })),
      runBackend: async () => Object.freeze({ state: "completed" }),
    }),
    (error) => error.message === "stardew_equip_tool_lifecycle_action_result_invalid"
      && error.cause === undefined && error.errors === undefined,
  );

  const cleanupOnlyClaims = scriptedClaims(root, JSON.stringify(proof));
  await cleanupOnlyClaims.beginResult({ root });
  await cleanupOnlyClaims.beginResult({ root });
  await assert.rejects(
    () => runEquipToolLifecycle({
      ...base,
      beginResult: cleanupOnlyClaims.beginResult,
      readResult: cleanupOnlyClaims.readResult,
      cleanupResult: async (claim) => { throw new Error("raw_cleanup_detail"); },
      runBackend: async () => Object.freeze({ state: "completed" }),
    }),
    (error) => error.message === "stardew_equip_tool_lifecycle_result_cleanup_failed"
      && error.cause === undefined && error.errors === undefined,
  );
}));

test("private-result claim creation failures are bounded and clean an earlier claim", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  const base = {
    projectRoot,
    profile: profile(root),
    runId: "ar1_test",
    releaseDir,
    resultRoot: root,
    runBackend: async () => Object.freeze({ state: "completed" }),
  };
  await assert.rejects(
    () => runEquipToolLifecycle({
      ...base,
      beginResult: async () => { throw new Error("raw_first_claim_detail"); },
      readResult: async () => "",
      cleanupResult: async () => {},
    }),
    (error) => error.message === "stardew_equip_tool_lifecycle_result_claim_failed"
      && error.cause === undefined
      && error.errors === undefined,
  );

  let attempts = 0;
  const cleaned = [];
  await assert.rejects(
    () => runEquipToolLifecycle({
      ...base,
      beginResult: async () => {
        attempts += 1;
        if (attempts === 1) return await beginPrivateResultFile({ root });
        throw new Error("raw_second_claim_detail");
      },
      readResult: async (claim) => readFile(claim.resultFile, "utf8"),
      cleanupResult: async (claim) => { cleaned.push(claim); await cleanupPrivateResultFile(claim); },
    }),
    (error) => error.message === "stardew_equip_tool_lifecycle_result_claim_failed"
      && error.cause === undefined
      && error.errors === undefined,
  );
  assert.equal(cleaned.length, 1);
}));

test("second claim creation failure with failing cleanup of an earlier claim returns bounded cleanup error", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  const base = {
    projectRoot,
    profile: profile(root),
    runId: "ar1_test",
    releaseDir,
    resultRoot: root,
    runBackend: async () => Object.freeze({ state: "completed" }),
  };
  let attempts = 0;
  const cleaned = [];
  await assert.rejects(
    () => runEquipToolLifecycle({
      ...base,
      beginResult: async () => {
        attempts += 1;
        if (attempts === 1) return await beginPrivateResultFile({ root });
        throw new Error("raw_second_claim_detail");
      },
      readResult: async (claim) => readFile(claim.resultFile, "utf8"),
      cleanupResult: async (claim) => { cleaned.push(claim); throw new Error("raw_cleanup_failure"); },
    }),
    (error) => error.message === "stardew_equip_tool_lifecycle_result_cleanup_failed"
      && error.cause === undefined
      && error.errors === undefined,
  );
  assert.equal(cleaned.length, 1);
}));

test("lifecycle adapter rejects invalid outer timeouts before opening private result claims", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  for (const timeoutMs of [0, -1, Number.MAX_SAFE_INTEGER]) {
    let claimsOpened = 0;
    await assert.rejects(
      () => runEquipToolLifecycle({
        projectRoot,
        profile: { ...profile(root), timeoutMs },
        runId: "ar1_test",
        releaseDir,
        resultRoot: root,
        beginResult: async () => { claimsOpened += 1; return Object.freeze({ resultFile: path.join(root, "unexpected.json"), directory: root }); },
        readResult: async () => "",
        cleanupResult: async () => {},
        runBackend: async () => Object.freeze({ state: "completed" }),
      }),
      (error) => error.message === "stardew_equip_tool_lifecycle_invalid_input"
        && error.cause === undefined && error.errors === undefined,
    );
    assert.equal(claimsOpened, 0);
  }
}));