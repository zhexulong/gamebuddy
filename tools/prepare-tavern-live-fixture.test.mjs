import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const root = resolve(".");
const script = resolve("tools/prepare-tavern-live-fixture.mjs");
const identity = { playerId: "live_player_01", companionId: "live_companion_01", continuityId: "live_continuity_01" };

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

test("Tavern live fixture bootstrap writes exactly the inert TVL-03 catalog through Host artifact envelopes", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "gamebuddy-tavern-live-fixture-"));
  try {
    const result = await run(["--runtime-root", runtimeRoot, "--identity", JSON.stringify(identity)]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report, {
      schemaVersion: 1,
      fixture: "tavern_live_tvl03_v1",
      artifactCount: 4,
      artifacts: report.artifacts,
    });
    assert.deepEqual(
      report.artifacts.map((item) => item.id),
      ["live_persona_v1", "live_scenario_v1", "live_examples_v1", "live_greetings_v1"],
    );
    assert.ok(report.artifacts.every((item) => item.revision === 1 && /^[a-f0-9]{64}$/u.test(item.canonicalHash)));

    const { resolveRuntimePaths } = await loadHostProductionModule("runtime.js");
    const { TavernArtifactStore } = await loadHostProductionModule("tavern/artifact-store.js");
    const { resolveTavernPaths, tavernRevisionPath } = await loadHostProductionModule("tavern/tavern-paths.js");
    const { validateTavernArtifact } = await loadHostProductionModule("tavern/types.js");
    const paths = resolveTavernPaths(resolveRuntimePaths(identity, runtimeRoot), identity);
    const store = new TavernArtifactStore(runtimeRoot);
    const reads = await Promise.all([
      store.read(tavernRevisionPath(join(paths.playerRoot, "personas", "live_persona_v1"), 1), validateTavernArtifact),
      store.read(
        tavernRevisionPath(join(paths.companionRoot, "scenarios", "live_scenario_v1"), 1),
        validateTavernArtifact,
      ),
      store.read(
        tavernRevisionPath(join(paths.companionRoot, "dialogue-examples", "live_examples_v1"), 1),
        validateTavernArtifact,
      ),
      store.read(
        tavernRevisionPath(join(paths.companionRoot, "greetings", "live_greetings_v1"), 1),
        validateTavernArtifact,
      ),
    ]);
    assert.deepEqual(
      reads.map((entry) => entry.artifact.revision),
      [1, 1, 1, 1],
    );
    assert.equal(reads[0].artifact.personaId, "live_persona_v1");
    assert.equal(reads[1].artifact.scenarioId, "live_scenario_v1");
    assert.equal(reads[2].artifact.examplesId, "live_examples_v1");
    assert.equal(reads[3].artifact.greetingSetId, "live_greetings_v1");
    assert.deepEqual(
      reads[3].artifact.variants.map((item) => item.variantId),
      ["first", "alternate"],
    );
    assert.deepEqual(
      report.artifacts.map((item) => item.canonicalHash),
      reads.map((entry) => entry.canonicalHash),
    );

    const repeated = await run(["--runtime-root", runtimeRoot, "--identity", JSON.stringify(identity)]);
    assert.notEqual(repeated.code, 0);
    assert.match(repeated.stderr, /tavern_revision_conflict/);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("Tavern live fixture bootstrap rejects repository roots and non-opaque identities", async () => {
  const insideRepository = await run(["--runtime-root", root, "--identity", JSON.stringify(identity)]);
  assert.notEqual(insideRepository.code, 0);
  assert.match(insideRepository.stderr, /runtime_root_inside_repository/);

  const external = await mkdtemp(join(tmpdir(), "gamebuddy-tavern-live-fixture-invalid-"));
  try {
    const invalidIdentity = await run([
      "--runtime-root",
      external,
      "--identity",
      JSON.stringify({ ...identity, extra: "no" }),
    ]);
    assert.notEqual(invalidIdentity.code, 0);
    assert.match(invalidIdentity.stderr, /invalid_tavern_live_fixture_identity/);
  } finally {
    await rm(external, { recursive: true, force: true });
  }
});
