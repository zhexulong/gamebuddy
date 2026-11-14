import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { draftAll, draftContract, renderDraftAll, runnerPopulation } from "./draft-smoke-contract.mjs";
import { deriveActionFacts, validateSmokeContract } from "./lib/stardew-action-smoke-contract.mjs";

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

/** The one refusal for a field, asserted to exist so a missing one fails with its own name. */
function refused(draft, field) {
  const found = draft.fields.find((entry) => entry.field === field && !entry.ok);
  assert.ok(
    found !== undefined,
    `expected a refusal on ${field}, got: ${draft.fields
      .filter((entry) => !entry.ok)
      .map((entry) => entry.field)
      .join(",")}`,
  );
  return found;
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

/**
 * THE ARGUMENT OBJECT IS WHERE THE REQUEST FOR *THIS* ACTION PUTS IT.
 *
 * `node tools/draft-smoke-contract.mjs --all` read the FIRST `args:` object literal in the file, so 26 of 119
 * runners looked as if they carried no argument object at all: the first literal belongs to the `equip_tool`
 * prerequisite (or the argument object is positional, or held in a `const`, or inside a local helper). These
 * runners pin the reading that replaced it - the request is found by the VALUE of its `action`, never by position.
 */
const EQUIP_FIRST = RUNNER(`
import { executeFresh, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";
export async function runProbe(client, receipts) {
  const snapshot = await observeFresh(client, { actionable: true });
  const equipped = await executeFresh(client, {
    requestId: "equip",
    idempotencyKey: "equip_idem",
    action: "equip_tool",
    args: { tool: "axe" },
    snapshot,
  });
  const target = (snapshot.caskTargets ?? []).find((entry) => entry.targetId);
  const accepted = await executeFresh(client, {
    requestId: "clear",
    idempotencyKey: "clear_idem",
    action: "clear_cask",
    args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
    snapshot,
  });
  const terminal = await waitForTerminal(receipts, accepted, 1_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "cask_cleared")
    throw new Error("probe_failed");
  if (equipped.state !== "accepted") throw new Error("equip_failed");
}
`);

/** The same slice with its request dispatched through a local helper whose parameters are not in the obvious order. */
const POSITIONAL = RUNNER(`
import { executeFresh, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";
const ACTION = "water_crop";
export async function runProbe(client, receipts) {
  const snapshot = await observeFresh(client, { actionable: true });
  const target = (snapshot.cropTargets ?? []).find((entry) => entry.targetId);
  const accepted = await send(client, receipts, snapshot, ACTION, {
    x: target.x,
    y: target.y,
    expectedTargetId: target.targetId,
  });
  const terminal = await waitForTerminal(receipts, accepted, 1_000);
  if (terminal.state !== "succeeded") throw new Error("probe_failed");
}

async function send(client, receipts, snapshot, action, args) {
  return executeFresh(client, {
    requestId: "probe",
    idempotencyKey: "probe_idem",
    action,
    args,
    snapshot,
  });
}
`);

test("the argument object is the one this action's request carries, not the first `args:` in the file", () => {
  const draft = draftContract(
    join(
      toolsDirectory({ "run-stardew-native-local-player-clear-cask-smoke.mjs": EQUIP_FIRST }),
      "run-stardew-native-local-player-clear-cask-smoke.mjs",
    ),
  );
  assert.deepEqual(
    draft.contract.args,
    { x: "$target.x", y: "$target.y", expectedTargetId: "$target.targetId" },
    `the clear_cask request's arguments, not the equip_tool prerequisite's: ${JSON.stringify(draft.fields.filter((field) => !field.ok))}`,
  );
  assert.equal(
    draft.fields.some((field) => field.field === "args.tool"),
    false,
    "the prerequisite's `tool` argument is not this slice's",
  );
  for (const field of draft.fields.filter((entry) => entry.field.startsWith("args.")))
    assert.ok(
      field.ok ? field.where.startsWith("runner:") : field.why.length > 0,
      `${field.field} says where it was read or why it was not`,
    );
});

test("a request dispatched through a local helper is read by its parameter names, not by argument position", () => {
  const draft = draftContract(
    join(
      toolsDirectory({ "run-stardew-native-local-player-water-crop-smoke.mjs": POSITIONAL }),
      "run-stardew-native-local-player-water-crop-smoke.mjs",
    ),
  );
  assert.deepEqual(draft.contract.args, { x: "$target.x", y: "$target.y", expectedTargetId: "$target.targetId" });
  assert.deepEqual(
    draft.contract.discovery.requiredFields,
    ["targetId", "x", "y"],
    "the substituted fields are the target's own, read off the arguments the call site actually passes",
  );
});

/** The argument object held in a `const`, and the same slot holding the result of a call. */
const HELD_IN_CONST = (initializer) =>
  RUNNER(`
import { executeFresh, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";
const ACTION = "water_crop";
export async function runProbe(client, receipts) {
  const snapshot = await observeFresh(client, { actionable: true });
  const target = (snapshot.cropTargets ?? []).find((entry) => entry.targetId);
  const args = ${initializer};
  const accepted = await execute(client, receipts, snapshot, ACTION, args);
  const terminal = await waitForTerminal(receipts, accepted, 1_000);
  if (terminal.state !== "succeeded") throw new Error("probe_failed");
}

async function execute(client, receipts, snapshot, action, args) {
  return executeFresh(client, { requestId: "probe", idempotencyKey: "probe_idem", action, args, snapshot });
}
`);

test("an argument object held in a `const` is followed; one built by a call is refused with its own reason", () => {
  const name = "run-stardew-native-local-player-water-crop-smoke.mjs";
  const held = draftContract(
    join(
      toolsDirectory({ [name]: HELD_IN_CONST("{ x: target.x, y: target.y, expectedTargetId: target.targetId }") }),
      name,
    ),
  );
  assert.deepEqual(held.contract.args, { x: "$target.x", y: "$target.y", expectedTargetId: "$target.targetId" });

  const built = draftContract(
    join(toolsDirectory({ [name]: HELD_IN_CONST("chooseArguments(snapshot, target)") }), name),
  );
  const refusal = refused(built, "args");
  assert.match(refusal.why, /computed at run time/u, "the refusal says the value is not data");
  assert.match(refusal.why, /chooseArguments/u, "the refusal names the expression it could not read");
});

/** Two dispatches of the same action with different arguments: the positive one and an unknown-id negative. */
const TWO_REQUESTS = RUNNER(`
import { executeFresh } from "./lib/stardew-native-smoke-harness-v1.mjs";
const ACTION = "water_crop";
export async function runProbe(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  const target = (snapshot.cropTargets ?? []).find((entry) => entry.targetId);
  const refused = await executeFresh(client, {
    requestId: "unknown",
    idempotencyKey: "unknown_idem",
    action: ACTION,
    args: { x: target.x, y: target.y, expectedTargetId: "crop_0000000000000000" },
    snapshot,
  });
  const accepted = await executeFresh(client, {
    requestId: "real",
    idempotencyKey: "real_idem",
    action: ACTION,
    args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
    snapshot,
  });
  return [refused, accepted];
}
`);

test("two dispatches whose argument objects differ are refused by name, with every site", () => {
  const name = "run-stardew-native-local-player-water-crop-smoke.mjs";
  const draft = draftContract(join(toolsDirectory({ [name]: TWO_REQUESTS }), name));
  const refusal = refused(draft, "args");
  assert.match(refusal.why, /2 sites whose argument objects differ/u, "a contract states one request");
  assert.deepEqual(
    [...refusal.why.matchAll(/runner:(\d+)/gu)].map((match) => match[1]).length,
    2,
    `both dispatch sites are named: ${refusal.why}`,
  );
});

/**
 * The three shapes the `delta` list carries, each written the way a runner writes it.
 *
 * The lower bound is `Number(evidence.dropped) >= 1`, not `evidence.dropped >= 1`: the unwrapped pattern this
 * converter shipped read that shape zero times in the whole tree (see
 * `run-stardew-native-local-player-break-resource-clump-smoke.mjs:175`), so the shape was declared and never derived.
 */
const THREE_DELTA_SHAPES = RUNNER(`
import { executeFresh, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";
export async function runProbe(client, receipts) {
  const accepted = await executeFresh(client, {
    requestId: "probe",
    idempotencyKey: "probe_idem",
    action: "ride_bus",
    args: {},
    snapshot,
  });
  const terminal = await waitForTerminal(receipts, accepted, 1_000);
  const evidence = parseEvidence(terminal.evidence);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "bus_arrived")
    throw new Error("probe_failed");
  const passed =
    Number(evidence.passengers_after) === Number(evidence.passengers_before) + 1 &&
    evidence.fare_paid === evidence.fare_due &&
    Number(evidence.stops_served) >= 2;
  if (!passed) throw new Error("probe_failed");
}
`);

test("delta is derived from the three shapes the format carries, each read through Number(...)", () => {
  const name = "run-stardew-native-local-player-ride-bus-smoke.mjs";
  const draft = draftContract(join(toolsDirectory({ [name]: THREE_DELTA_SHAPES }), name));
  const delta = draft.contract.delta ?? [];
  assert.deepEqual(
    delta,
    [
      { from: "passengers_before", to: "passengers_after", equals: 1 },
      { from: "fare_due", to: "fare_paid", equals: 0 },
      { to: "stops_served", atLeast: 2 },
    ],
    "a sum, an equality and a lower bound - one entry each, no shape counted twice",
  );
});

/** An action whose declaration names no target (`ride_bus`) and one whose declaration names a family (`water_crop`). */
const TARGETLESS = RUNNER(`
import { executeFresh, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";
export async function runProbe(client, receipts) {
  const accepted = await executeFresh(client, {
    requestId: "probe",
    idempotencyKey: "probe_idem",
    action: "ride_bus",
    args: {},
    snapshot,
  });
  const terminal = await waitForTerminal(receipts, accepted, 1_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "bus_arrived")
    throw new Error("probe_failed");
}
`);

test("a draft's discovery block says `none` in words when the declaration names no target, and carries `source` when it does", () => {
  const targetless = "run-stardew-native-local-player-ride-bus-smoke.mjs";
  const draft = draftContract(join(toolsDirectory({ [targetless]: TARGETLESS }), targetless));
  // The premise, from the declaration that owns it: if ride_bus ever names a family this test stops applying.
  assert.equal(deriveActionFacts("ride_bus").targetFamily, null, "ride_bus declares no targetFamily");
  assert.equal(typeof draft.contract.discovery?.none, "string", "the block exists and says why in words");
  assert.ok(draft.contract.discovery.none.length >= 24, "a reason short enough to be a placeholder is refused");
  const loaded = validateSmokeContract(draft.contract);
  assert.equal(loaded.discovery, null, "the format reads `none` as no discovery");
  assert.equal(
    loaded.derived.discoveryNone,
    draft.contract.discovery.none,
    "the reason survives into the loaded contract",
  );

  const naming = "run-stardew-native-local-player-water-crop-smoke.mjs";
  const sourced = draftContract(join(toolsDirectory({ [naming]: POSITIONAL }), naming));
  assert.equal(sourced.contract.discovery.source, "cropTargets", "a family-naming draft carries its source");
});

test("`--all` reports its verdict through the exit code instead of crashing after it prints", () => {
  const executed = spawnSync(
    process.execPath,
    ["tools/draft-smoke-contract.mjs", "--all", "--out", mkdtempSync(join(tmpdir(), "draft-all-"))],
    {
      encoding: "utf8",
      cwd: resolve(import.meta.dirname, ".."),
    },
  );
  // Measured on this tree, which still has refusals: the mode is red today and must say so as a verdict.
  assert.equal(
    executed.stderr,
    "",
    "the sweep finishes; an ERR_INVALID_ARG_TYPE here is the exit code being a promise",
  );
  assert.match(executed.stdout, /^runners examined \d+ · drafted \d+/mu, "the reading is printed");
  assert.ok(
    [0, 1].includes(executed.status),
    `refusals exit 1, a complete tree exits 0, got ${String(executed.status)}`,
  );
});
