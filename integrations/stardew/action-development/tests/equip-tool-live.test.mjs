import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writePrivateResultFile } from "@gamebuddy/game-action-devkit";
import { runEquipToolLifecycle } from "../src/equip-tool-lifecycle.mjs";
import { runEquipToolLive, readEquipToolLiveStatus } from "../src/equip-tool-live.mjs";
import { createImmutableReleaseBundleBinding } from "../src/immutable-release-bundle.mjs";

const profile = Object.freeze({
  profileIdentity: "local-target",
  targetVersion: "stardew-1.6.15-smapi-4.1",
  releaseDir: "C:\\release",
  modsPath: "C:\\game\\Mods",
  runtimeLeaseRoot: "C:\\lease",
  runtimeLeaseIdentity: "target-machine-lease",
});

function exactProof(runId) {
  const requestId = "equip-request";
  const executionId = "equip-execution";
  return Object.freeze({
    schema: "gamebuddy-action-scenario-result/v1",
    gameId: "stardew",
    actionId: "equip_tool",
    runId,
    stage: "run-live",
    profileIdentity: profile.profileIdentity,
    claimScope: "native-local-equip-tool-v1",
    receipt: Object.freeze({
      state: "succeeded",
      reasonCode: "tool_selected",
      hasEvidence: true,
      request: Object.freeze({ requestId, idempotencyKey: "equip-idem", action: "equip_tool", args: Object.freeze({ slot: 1 }), expectedRevision: 4 }),
      accepted: Object.freeze({ requestId, executionId }),
      terminal: Object.freeze({ requestId, executionId, state: "succeeded", reasonCode: "tool_selected", revision: 5 }),
      evidence: Object.freeze({ slot: 1, before: "Axe", expected: "Hoe", after: "Hoe" }),
    }),
    postcondition: Object.freeze({ revision: 5, currentTool: "Hoe", expectedTool: "Hoe", selected: Object.freeze({ slot: 1, label: "Hoe" }) }),
    verdict: "passed",
    reasonCode: "tool_selected",
  });
}

function harness({ lifecycleFails = false, proofVerdict = "passed" } = {}) {
  const order = [];
  const finalizations = [];
  const value = {
    preflight: async () => { order.push("preflight"); return Object.freeze({ state: "READY", ready: true, bundle: Object.freeze({ digest: "a".repeat(64) }) }); },
    consumeReadyProfile: () => { order.push("profile"); return profile; },
    acquireLease: async ({ identity }) => {
      order.push(`lease:${identity}`);
      return { release: async () => order.push("lease-release") };
    },
    beginEvidence: async ({ root, identity }) => { order.push(`evidence:${root}:${identity.runId}`); return { identity }; },
    createBundle: async ({ runIdentity, expectedDigest }) => {
      order.push(`bundle:${runIdentity}:${expectedDigest}`);
      return {
        async runLifecycle(operation) {
          order.push("lifecycle");
          if (lifecycleFails) throw new Error("lifecycle failed");
          const proof = await operation({ releaseDir: "C:\\lease\\immutable" });
          return proofVerdict === "passed" ? proof : Object.freeze({ ...proof, verdict: proofVerdict });
        },
        async close() { order.push("bundle-close"); },
      };
    },
    runLifecycle: async ({ runId, releaseDir }) => { order.push(`child:${runId}:${releaseDir}`); return exactProof(runId); },
    finalizeComplete: async (_run, options) => { order.push("finalize-complete"); finalizations.push(options); return options; },
    finalizeIncomplete: async (_run, options) => { order.push("finalize-incomplete"); finalizations.push(options); return Object.freeze({ status: "incomplete", ...options }); },
  };
  return { order, finalizations, value };
}

function invoke(runId, dependencies) {
  return runEquipToolLive({
    manifest: Object.freeze({ gameId: "stardew", baseDirectory: "C:\\project", evidenceRoot: "C:\\project\\artifacts\\action-runs" }),
    invocation: Object.freeze({ command: "run-live", actionId: "equip_tool", profileFile: "C:\\operator\\profile.json", runId }),
    dependencies,
  });
}

test("run-live binds unique run identity and finalizes only after lifecycle, staging, and lease cleanup", async () => {
  const fake = harness();
  const report = await invoke("ar1_first", fake.value);
  assert.deepEqual(report, { gameId: "stardew", actionId: "equip_tool", status: "live", state: "PASSED", runId: "ar1_first", evidenceStatus: "complete", verdict: "passed" });
  assert.deepEqual(fake.order, [
    "preflight", "profile", "lease:target-machine-lease", "evidence:C:\\project\\artifacts\\action-runs:ar1_first",
    `bundle:ar1_first:${"a".repeat(64)}`, "lifecycle", "child:ar1_first:C:\\lease\\immutable",
    "bundle-close", "lease-release", "finalize-complete",
  ]);
  const metadata = fake.finalizations[0].metadata;
  assert.equal(metadata.runId, "ar1_first");
  assert.equal(metadata.request.action, "equip_tool");
  assert.deepEqual(metadata.evidence, { slot: 1, before: "Axe", expected: "Hoe", after: "Hoe" });
  assert.deepEqual(metadata.cleanup, { lifecycle: true, immutableStaging: true, runtimeLease: true });
});

test("two attempts with one profile use distinct evidence destinations while sharing only lease identity", async () => {
  const first = harness();
  const second = harness();
  await invoke("ar1_first", first.value);
  await invoke("ar1_second", second.value);
  assert.match(first.order.find((entry) => entry.startsWith("evidence:")), /ar1_first$/);
  assert.match(second.order.find((entry) => entry.startsWith("evidence:")), /ar1_second$/);
  assert.ok(first.order.includes("lease:target-machine-lease"));
  assert.ok(second.order.includes("lease:target-machine-lease"));
});

test("lifecycle failure produces incomplete evidence once and never reports passed", async () => {
  const fake = harness({ lifecycleFails: true });
  const report = await invoke("ar1_failed", fake.value);
  assert.equal(report.state, "INCOMPLETE");
  assert.equal(report.verdict, "uncertain");
  assert.equal(fake.order.filter((entry) => entry.startsWith("child:")).length, 0);
  assert.ok(fake.order.indexOf("lease-release") < fake.order.indexOf("finalize-incomplete"));
  assert.equal(fake.finalizations[0].metadata.cleanup.lifecycle, false);
  assert.equal(fake.finalizations[0].metadata.cleanup.immutableStaging, false);
  assert.equal(fake.finalizations[0].metadata.cleanup.runtimeLease, true);
});

test("non-passing exact proof is incomplete even after successful cleanup", async () => {
  const fake = harness({ proofVerdict: "failed" });
  const report = await invoke("ar1_not_passed", fake.value);
  assert.equal(report.state, "INCOMPLETE");
  assert.equal(report.verdict, "uncertain");
  assert.deepEqual(fake.finalizations[0].metadata.cleanup, { lifecycle: true, immutableStaging: true, runtimeLease: true });
});

test("real immutable binding and Devkit claims turn missing cleanup receipt into one incomplete outer finalization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "equip-tool-live-real-failure-"));
  const releaseDir = path.join(root, "release");
  const modsPath = path.join(root, "game", "Mods");
  const runtimeLeaseRoot = path.join(root, "lease");
  await mkdir(releaseDir);
  await mkdir(modsPath, { recursive: true });
  await mkdir(runtimeLeaseRoot);
  const files = ["GameBuddy.Stardew.dll", "GameBuddy.Stardew.Core.dll", "manifest.json", "GameBuddy.Stardew.deps.json"];
  const hash = createHash("sha256");
  for (const name of files) {
    const bytes = Buffer.from(`fixture:${name}`, "utf8");
    await writeFile(path.join(releaseDir, name), bytes);
    hash.update(Buffer.from(name, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
  }
  const digest = hash.digest("hex");
  const realProfile = Object.freeze({ ...profile, releaseDir, modsPath, runtimeLeaseRoot });
  const finalizations = [];
  let childCalls = 0;
  let leaseReleases = 0;
  let completeCalls = 0;
  let stagingDirectory;
  try {
    const report = await invoke("ar1_real_cleanup_failure", {
      preflight: async () => Object.freeze({ state: "READY", ready: true, bundle: Object.freeze({ digest }) }),
      consumeReadyProfile: () => realProfile,
      acquireLease: async () => ({ release: async () => { leaseReleases++; } }),
      beginEvidence: async ({ identity }) => ({ identity }),
      createBundle: async (options) => {
        const binding = await createImmutableReleaseBundleBinding(options);
        stagingDirectory = binding.inspect().releaseDir;
        return binding;
      },
      runLifecycle: (options) => runEquipToolLifecycle({
        ...options,
        resolvePowerShell: () => "fake-powershell",
        runChild: async ({ args }) => {
          childCalls++;
          const actionFile = args[args.indexOf("-ResultFile") + 1];
          await writePrivateResultFile(actionFile, JSON.stringify(exactProof(options.runId)));
          return { code: 0, signal: null };
        },
      }),
      finalizeComplete: async () => { completeCalls++; throw new Error("unexpected complete finalization"); },
      finalizeIncomplete: async (_run, options) => {
        finalizations.push(options);
        return Object.freeze({ status: "incomplete", verdict: options.verdict });
      },
    });
    assert.equal(report.state, "INCOMPLETE");
    assert.equal(report.verdict, "uncertain");
    assert.equal(childCalls, 1);
    assert.equal(completeCalls, 0);
    assert.equal(finalizations.length, 1);
    assert.equal(leaseReleases, 1);
    assert.equal(finalizations[0].metadata.cleanup.lifecycle, false);
    assert.equal(finalizations[0].metadata.cleanup.immutableStaging, false);
    assert.deepEqual((await readdir(stagingDirectory)).sort(), files.sort());
  } finally {
    if (stagingDirectory) {
      for (const name of await readdir(stagingDirectory).catch(() => [])) await unlink(path.join(stagingDirectory, name));
      await rmdir(stagingDirectory).catch(() => {});
    }
    for (const name of await readdir(releaseDir).catch(() => [])) await unlink(path.join(releaseDir, name));
    await rmdir(releaseDir).catch(() => {});
    await rmdir(runtimeLeaseRoot).catch(() => {});
    await rmdir(modsPath).catch(() => {});
    await rmdir(path.dirname(modsPath)).catch(() => {});
    await rmdir(root).catch(() => {});
  }
});

test("status reads only the validated latest evidence observation", async () => {
  const expected = Object.freeze({ availability: "available", identity: Object.freeze({ gameId: "stardew", actionId: "equip_tool", runId: "ar1_latest" }), status: "complete", verdict: "passed" });
  let calls = 0;
  const report = await readEquipToolLiveStatus({
    manifest: Object.freeze({ gameId: "stardew", evidenceRoot: "C:\\project\\artifacts\\action-runs" }),
    invocation: Object.freeze({ command: "status", actionId: "equip_tool", profileFile: "C:\\operator\\profile.json" }),
    dependencies: { readLatestEvidence: async (input) => { calls++; assert.deepEqual(input, { root: "C:\\project\\artifacts\\action-runs", gameId: "stardew", actionId: "equip_tool" }); return expected; } },
  });
  assert.equal(calls, 1);
  assert.deepEqual(report, { gameId: "stardew", actionId: "equip_tool", status: "evidence", observation: expected });
});
