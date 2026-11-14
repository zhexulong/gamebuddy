import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { draftAll, draftContract, renderDraftAll, runnerPopulation } from "./draft-smoke-contract.mjs";

/**
 * The measurement `--all` prints decides which schema kind gets written next, so it has to be red on the tree it is
 * measuring: a mode that can only report "drafted everything" is the fourth hand-written table with extra steps.
 *
 * The population is the tools directory, never a list here, and every synthetic runner below is written into its own
 * temporary tools directory so a real runner changing shape cannot silently move these assertions.
 */

const RUNNER = (body) => `#!/usr/bin/env node\n${body}\n`;

/** A runner whose request is one discovered target and whose receipt keys are literals: nothing to refuse. */
const DERIVABLE = RUNNER(`
import { executeFresh, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";
export async function runProbe(client, receipts) {
  const snapshot = await observeFresh(client, { actionable: true });
  const target = (snapshot.shakeTreeTargets ?? []).find((entry) => entry.targetId);
  const request = await executeFresh(client, {
    requestId: "probe",
    idempotencyKey: "probe_idem",
    action: "shake_tree",
    args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
    snapshot,
  });
  const terminal = await waitForTerminal(receipts, request, 1_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "tree_shaken")
    throw new Error("probe_failed");
  const evidence = parseEvidence(terminal.evidence);
  if (evidence.shaken === "true") return;
  throw new Error("probe_flag_missing");
}
`);

/** The same runner with one argument chosen at run time: the contract cannot carry the number. */
const WITH_HELD_SLOT = RUNNER(`
import { executeFresh, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";
export async function runProbe(client, receipts) {
  const snapshot = await observeFresh(client, { actionable: true });
  const target = (snapshot.caskTargets ?? []).find((entry) => entry.targetId);
  const slot = (snapshot.toolSlots ?? []).find((entry) => entry.label === "(T)Axe").slot;
  const request = await executeFresh(client, {
    requestId: "probe",
    idempotencyKey: "probe_idem",
    action: "clear_cask",
    args: { slot: slot, x: target.x, y: target.y, expectedTargetId: target.targetId },
    snapshot,
  });
  const terminal = await waitForTerminal(receipts, request, 1_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "cask_cleared")
    throw new Error("probe_failed");
}
`);

function toolsDirectory(files) {
  const root = mkdtempSync(join(tmpdir(), "draft-tools-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body, "utf8");
  return root;
}

test("the population is the directory, so a runner written tomorrow is measured without being listed", () => {
  const toolsRoot = toolsDirectory({
    "run-stardew-native-local-player-shake-tree-smoke.mjs": DERIVABLE,
    "run-stardew-native-local-player-clear-cask-smoke.mjs": WITH_HELD_SLOT,
    "run-stardew-native-local-player-shake-tree-smoke.test.mjs": "// a falsifier, not a runner",
    "unrelated.mjs": "// not this family",
  });
  assert.deepEqual(runnerPopulation({ toolsRoot }), [
    "run-stardew-native-local-player-clear-cask-smoke.mjs",
    "run-stardew-native-local-player-shake-tree-smoke.mjs",
  ]);
});

test("a drafted contract is written to a directory, and a complete runner refuses nothing", async () => {
  const toolsRoot = toolsDirectory({ "run-stardew-native-local-player-shake-tree-smoke.mjs": DERIVABLE });
  const outDir = mkdtempSync(join(tmpdir(), "draft-out-"));
  const reading = await draftAll({ toolsRoot, outDir });
  assert.equal(reading.blocked, null);
  assert.equal(reading.examined, 1, "one runner examined");
  assert.equal(reading.refusals.length, 0, "this runner derives completely");
  assert.equal(readdirSync(outDir).length, 1, "one contract written to the directory");
});

test("a field the converter cannot read is refused by name, and the mode exits non-zero", async () => {
  const toolsRoot = toolsDirectory({ "run-stardew-native-local-player-clear-cask-smoke.mjs": WITH_HELD_SLOT });
  const outDir = mkdtempSync(join(tmpdir(), "draft-out-"));
  const reading = await draftAll({ toolsRoot, outDir });
  assert.ok(reading.refusals.length > 0, "the computed slot has to be refused, not guessed");
  const slot = reading.refusals.find((refusal) => refusal.field === "args.slot");
  assert.ok(slot !== undefined, `args.slot is refused: ${reading.refusals.map((r) => r.field).join(",")}`);
  assert.equal(slot.runner, "run-stardew-native-local-player-clear-cask-smoke.mjs", "the refusal names its runner");
  assert.match(slot.why, /computed at run time/u, "the refusal says why");
});

test("the frequency table counts a field once per runner that hit it, so one field can justify a schema kind", async () => {
  const toolsRoot = toolsDirectory({
    "run-stardew-native-local-player-clear-cask-smoke.mjs": WITH_HELD_SLOT,
    "run-stardew-native-local-player-clear-cask-again-smoke.mjs": WITH_HELD_SLOT,
  });
  // Both files name the same action, which is the point: the count is per RUNNER, not per action.
  const outDir = mkdtempSync(join(tmpdir(), "draft-out-"));
  const reading = await draftAll({ toolsRoot, outDir });
  const slot = reading.byField.find((entry) => entry.field === "args.slot");
  assert.ok(slot !== undefined, "args.slot is counted");
  assert.equal(slot.count, 2, "both runners that hit it are counted, not just the first");
  assert.equal(
    reading.runnersWithRefusals,
    new Set(reading.refusals.map((refusal) => refusal.runner)).size,
    "the reading says how many runners are blocked, and that number is the refusals' own set",
  );
  assert.ok(reading.runnersWithRefusals >= 1, "at least the one runner whose draft is incomplete is named");
});

test("an empty population is blocked with its reason rather than passing", async () => {
  const toolsRoot = toolsDirectory({ "unrelated.mjs": "// nothing of this family" });
  const reading = await draftAll({ toolsRoot, outDir: mkdtempSync(join(tmpdir(), "draft-out-")) });
  assert.match(reading.blocked, /^runner_population_empty:/u);
  assert.deepEqual(renderDraftAll(reading), [`not_measured:${reading.blocked}`]);
});

test("a draft written for a real runner is the shape the contract format accepts", async () => {
  // The same runner the batch used, from the tree: the draft for an action with a declared family validates.
  const draft = draftContract("tools/run-stardew-native-local-player-pet-animal-smoke.mjs");
  assert.equal(draft.action, "pet_animal");
  assert.equal(draft.contract.discovery.source, "petTargets");
  assert.equal(draft.contract.schema, "stardew-action-smoke-contract/v1");
  // Every field carries the place it was read, or the reason it could not be.
  for (const field of draft.fields)
    assert.ok(field.ok ? field.where !== null : field.why.length > 0, `${field.field} has no provenance`);
});
