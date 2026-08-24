import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";
import {
  hostPublishedProjection,
  parseModProjectionManifest,
  verifyStardewActionProjection,
} from "./verify-stardew-action-projection.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * The three actual shared-harness consumer classes proven by this verifier.
 * Class representatives come from artifacts/p2/second-wave.host-harness-interface.json
 * (machine-inspect read-only, till-soil immediate mutation, machine-collect-output
 * delayed multi-stage). Evidence below is static: the live gate never launches
 * Stardew, never sends a bridge action, and never executes a runner smoke contract.
 */
const CONSUMER_CLASSES = Object.freeze({
  read_only: Object.freeze({
    actionId: "machine_inspect",
    runner: "run-stardew-native-local-player-machine-inspect-smoke.mjs",
    terminalReasonCode: "machine_inspected",
    mustImport: [
      "assertExactCapabilities",
      "connectNativeLocalClient",
      "executeFresh",
      "observeFresh",
      "readNativeClientConfig",
      "waitForFreshSnapshot",
      "waitForTerminal",
    ],
    mustNotImport: ["delay", "waitForActionable", "waitForStableRevision"],
  }),
  immediate_mutation: Object.freeze({
    actionId: "till_soil",
    runner: "run-stardew-native-local-player-till-soil-smoke.mjs",
    terminalReasonCode: "soil_tilled",
    mustImport: [
      "connectNativeLocalClient",
      "executeFresh",
      "observeFresh",
      "waitForStableRevision",
      "waitForTerminal",
    ],
    mustNotImport: ["delay"],
  }),
  delayed_multi_stage: Object.freeze({
    actionId: "machine_collect_output",
    runner: "run-stardew-native-local-player-machine-collect-output-smoke.mjs",
    terminalReasonCode: "machine_coffee_collected",
    mustImport: ["connectNativeLocalClient", "delay", "executeFresh", "observeFresh", "waitForTerminal"],
    mustNotImport: ["waitForStableRevision"],
  }),
});

function harnessImportBlock(source) {
  const match = source.match(/import \{([\s\S]*?)\} from "\.\/lib\/stardew-native-smoke-harness-v1\.mjs";/);
  assert.ok(match, "runner must import the actual shared harness module");
  return match[1];
}

async function runnerSource(className) {
  const expected = CONSUMER_CLASSES[className];
  return readFile(resolve(ROOT, "tools", expected.runner), "utf8");
}

const action = Object.freeze({
  actionId: "move_to_tile",
  familyId: "movement_navigation",
  identityVersion: 1,
  lifecycle: "published",
  requiredCapability: "move_to_tile",
});
const manifest = (actions = [action]) => JSON.stringify({ schema: "farmhand_action_projection_manifest/v1", actions });
const host = (actions) => ({ PUBLISHED_STARDEW_ACTIONS: actions ?? [action] });

function fails(code, callback) {
  assert.throws(callback, new RegExp(`stardew_action_projection_${code}`));
}

test("verifies exact default Mod-to-Host projection bidirectionally", () => {
  assert.deepEqual(
    verifyStardewActionProjection(parseModProjectionManifest(manifest()), hostPublishedProjection(host())),
    { actionCount: 1 },
  );
});

test("rejects malformed JSON and schema violations", () => {
  fails("manifest_json", () => parseModProjectionManifest("{"));
  fails("manifest_schema", () => parseModProjectionManifest(JSON.stringify({ schema: "wrong", actions: [action] })));
  fails("manifest_action_shape", () => parseModProjectionManifest(manifest([{ ...action, extra: true }])));
});

test("rejects duplicate and missing actions in either projection", () => {
  fails("manifest_duplicate_action_id", () => parseModProjectionManifest(manifest([action, action])));
  fails("host_missing_move_to_tile", () =>
    verifyStardewActionProjection(parseModProjectionManifest(manifest()), hostPublishedProjection(host([]))),
  );
  fails("manifest_missing_move_to_tile", () =>
    verifyStardewActionProjection(parseModProjectionManifest(manifest([])), hostPublishedProjection(host())),
  );
});

test("rejects family, identity, lifecycle, and required-capability drift", () => {
  for (const [field, value] of [
    ["familyId", "other"],
    ["identityVersion", 2],
    ["lifecycle", "experimental"],
    ["requiredCapability", "other_capability"],
  ]) {
    const changed = { ...action, [field]: value };
    if (field === "lifecycle") {
      fails("manifest_action_fields", () => parseModProjectionManifest(manifest([changed])));
    } else {
      fails(`field_mismatch_move_to_tile_${field}`, () =>
        verifyStardewActionProjection(parseModProjectionManifest(manifest()), hostPublishedProjection(host([changed]))),
      );
    }
  }
});

test("actual descriptor identity binds the three shared-harness consumer classes to their runners", async () => {
  for (const [className, expected] of Object.entries(CONSUMER_CLASSES)) {
    const gate = STARDEW_PUBLISHED_ACTION_GATES.find((entry) => entry.actionId === expected.actionId);
    assert.ok(gate, `${className}: descriptor entry missing for ${expected.actionId}`);
    assert.equal(gate.runner, expected.runner, `${className}: runner identity drift for ${expected.actionId}`);
    assert.equal(
      gate.terminalReasonCode,
      expected.terminalReasonCode,
      `${className}: terminal reason drift for ${expected.actionId}`,
    );
    await access(resolve(ROOT, "tools", gate.runner), constants.R_OK);
  }
});

test("the three consumer-class runners import the actual shared harness and nothing else", async () => {
  for (const className of Object.keys(CONSUMER_CLASSES)) {
    const expected = CONSUMER_CLASSES[className];
    const source = await runnerSource(className);
    const imports = harnessImportBlock(source);
    for (const name of expected.mustImport) {
      assert.match(imports, new RegExp(`\\b${name}\\b`), `${className}: missing harness import ${name}`);
    }
    for (const name of expected.mustNotImport) {
      assert.doesNotMatch(imports, new RegExp(`\\b${name}\\b`), `${className}: class marker ${name} must be absent`);
    }
    // The runner must be a shared-harness consumer only: the single import is
    // the shared harness; no legacy host route, no parallel runner, no Portfolio.
    assert.deepEqual(
      [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]),
      ["./lib/stardew-native-smoke-harness-v1.mjs"],
      `${className}: runner must import only the shared harness`,
    );
  }
});

test("read-only consumer class (machine_inspect) reads back an unchanged target on the fresh snapshot", async () => {
  const source = await runnerSource("read_only");
  // One read-only execute of machine_inspect through the harness.
  assert.match(source, /"inspect_machine",\s*"machine_inspect"/);
  // The postcondition re-reads the fresh snapshot and proves the target is
  // unchanged (no mutation occurred); evidence mirrors read-only snapshot facts.
  assert.match(source, /const unchanged = sameMachine\(target, reread\);/);
  assert.match(source, /unchangedTarget: unchanged,/);
  assert.match(source, /reasonCode: passed \? "machine_inspected"/);
  assert.match(source, /evidence\.ready_for_harvest === String\(target\.readyForHarvest\)/);
});

test("immediate mutation consumer class (till_soil) binds its postcondition to the exact terminal revision", async () => {
  const source = await runnerSource("immediate_mutation");
  // One immediate mutation execute of till_soil through the harness.
  assert.match(source, /const accepted = await execute\("till", "till_soil", target, snapshot, trace, client\);/);
  assert.match(source, /receipt\.reasonCode !== "soil_tilled"/);
  // The mutation settles in the terminal revision window: the post-terminal
  // observation must not advance past receipt.revision.
  assert.match(source, /const after = await waitForStableRevision\(client, \{/);
  assert.match(source, /revision: receipt\.revision,/);
  assert.match(source, /after\.revision === receipt\.revision/);
  // Mutation evidence: bare soil becomes HoeDirt in the same window; the tilled
  // tile disappears from the fresh soil list.
  assert.match(source, /evidence\.before === "none"/);
  assert.match(source, /evidence\.after === "HoeDirt"/);
  assert.match(source, /freshTargetGone;/);
});

test("delayed multi-stage consumer class (machine_collect_output) executes two stages across a game-clock delay", async () => {
  const source = await runnerSource("delayed_multi_stage");
  // Two distinct actions consumed through the harness in one contract.
  assert.match(source, /const ACTION_LOAD = "machine_load";/);
  assert.match(source, /const ACTION_COLLECT = "machine_collect_output";/);
  assert.match(source, /const loadAccepted = await execute\([\s\S]*?ACTION_LOAD,/);
  assert.match(source, /const collectAccepted = await execute\([\s\S]*?ACTION_COLLECT,/);
  // Two distinct terminals are awaited.
  assert.match(source, /const loadTerminal = await waitForTerminal\(receipts, loadAccepted, terminalTimeoutMs\);/);
  assert.match(
    source,
    /const collectTerminal = await waitForTerminal\(receipts, collectAccepted, terminalTimeoutMs\);/,
  );
  // The inter-stage readiness wait is a delayed game-clock stage: the runner
  // polls with the harness delay primitive until the machine is ready and
  // fails closed instead of skipping game time.
  assert.match(source, /const ready = await waitForReadyTarget\(client, loadTarget\.targetId, readyTimeoutMs\);/);
  assert.match(source, /minutesUntilReady === 0/);
  assert.match(source, /await delay\(500\);/);
  assert.match(source, /machine_ready_timeout_without_time_skip/);
});

test("Portfolio topology isolation is unchanged for the three consumer classes", async () => {
  for (const className of Object.keys(CONSUMER_CLASSES)) {
    const _expected = CONSUMER_CLASSES[className];
    const source = await runnerSource(className);
    // Each consumer fails closed when the fixture config enables Portfolio.
    assert.match(source, /Portfolio\?\.Enable/, `${className}: runner must fail closed on Portfolio enable`);
  }
  // Neither the runners nor the shared harness import any Portfolio module.
  for (const className of Object.keys(CONSUMER_CLASSES)) {
    const source = await runnerSource(className);
    assert.ok(
      [...source.matchAll(/from "([^"]+)"/g)].every((match) => !match[1].includes("portfolio")),
      `${className}: runner must not import Portfolio modules`,
    );
  }
  const harness = await readFile(resolve(ROOT, "tools/lib/stardew-native-smoke-harness-v1.mjs"), "utf8");
  assert.doesNotMatch(harness, /portfolio/, "shared harness must stay Portfolio-free");
});
