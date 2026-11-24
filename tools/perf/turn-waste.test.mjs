// source-invariant: each NOTHING_CHANGED_TERMINALS entry names a line of the Mod that mints that reason code, and
//   that line contains the code as a literal. A vocabulary row with no producer behind it would silently classify
//   real work as waste, and a code the Mod renames would silently stop being classified.
// source-expiry: when the reason codes move out of `farmhandexecutioncontroller.*.cs` (a rename, a split, or the
//   Mod's receipts moving to a generated vocabulary), this check must read that vocabulary instead; it fails loudly
//   on the missing file rather than passing on no rows.
// red-proof: fixture  a synthetic run with 10 empty turns of 19 -> `turn_waste_above_ceiling:0.526:0.5`, exit 1
//   (tools/perf/turn-waste.test.mjs)
// red-proof: history  `round99`'s own record -> `turn_waste: empty turns 27 of 96 = 28.1% · refused resubmissions 1 ·
//   repeated identical reads 0`, `turn_waste_ok` (tools/perf/turn-waste.test.mjs)
/**
 * Turn waste's own checks: is a turn's emptiness decided by what its submissions bought rather than by prose; are
 * the three numbers kept apart; and is a turn the artifacts cannot decide kept OUT of the waste count.
 *
 * The three numbers have three causes, so they are asserted separately: a suite that only checked the share would
 * pass a run whose share came from retries and a run whose share came from reads. `round99` is the case all three
 * were written for - one refused plan re-sent, four observe rounds, and no identical re-read.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareTurnWaste,
  leadingJson,
  measureTurnWaste,
  NOTHING_CHANGED_TERMINALS,
  outcomeOf,
  REFUSED_STATES,
  renderTurnWaste,
  TURN_WASTE_CEILING,
  TURN_WASTE_POPULATION_FLOOR,
} from "../lib/turn-waste.mjs";

const gatePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "gates", "data", "check-perf-budget.mjs");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROUND_99 = join(repositoryRoot, ".live-runs", "game-ladder", "2026-11-24T09-55-06-982Z-multiday_routine");

/** One assistant turn carrying `calls`, each with the tool result `answers` gives it. */
function turn(calls) {
  const content = calls.map((call, index) => ({
    type: "toolCall",
    id: call.id ?? `call_${String(index)}`,
    name: call.name,
    arguments: call.arguments ?? {},
  }));
  return { message: { role: "assistant", content } };
}

function result(callId, toolName, answer) {
  return {
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName,
      content: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }],
    },
  };
}

/** A flat action's answer: the execution identity and its state. */
const executed = (id, actionId, state, reasonCode) => ({
  actionId,
  executionId: id,
  state,
  reasonCode,
  observation: { tileX: 1, tileY: 1, location: "Farm" },
});

/** A program's answer, settled, with the nodes that settled it. */
const programAnswer = (programId, nodes) => ({ programId, planStatus: "compiled", settled: true, nodes });

/** One bundle directory holding a `result.json` that binds its session record, and that record. */
async function bundleOf(root, name, { lines, programOutcomes = [] }) {
  const directory = join(root, name);
  await mkdir(join(directory, "sessions"), { recursive: true });
  await writeFile(
    join(directory, "result.json"),
    `${JSON.stringify({ toolTiming: { record: "session.jsonl" }, programOutcomes }, null, 2)}\n`,
  );
  await writeFile(join(directory, "sessions", "session.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return directory;
}

test("a submission's outcome is decided by what its answer shows, and the unknown is its own answer", () => {
  assert.deepEqual(outcomeOf({ tool: "stardew_observe", answer: null, outcomes: new Map() }), {
    kind: "no_receipt",
    why: "stardew_observe",
  });
  assert.equal(
    outcomeOf({ tool: "stardew_express_emote", answer: executed("e1", "express_emote", "succeeded", "emote_started"), outcomes: new Map() })
      .kind,
    "changed",
  );
  assert.equal(
    outcomeOf({ tool: "stardew_express_emote", answer: executed("e1", "express_emote", "rejected", "cutscene_active"), outcomes: new Map() })
      .kind,
    "refused",
  );
  assert.equal(
    outcomeOf({ tool: "stardew_plan_work", answer: executed("e1", "dismiss_modal", "succeeded", "nothing_to_dismiss"), outcomes: new Map() })
      .kind,
    "no_change",
  );
  assert.deepEqual(
    outcomeOf({ tool: "stardew_plan_work", answer: programAnswer("plan_1", [{ nodeId: "n01", state: "succeeded", reasonCode: "weeds_cut" }]), outcomes: new Map() }),
    { kind: "changed" },
  );
  assert.equal(
    outcomeOf({
      tool: "stardew_plan_work",
      answer: programAnswer("plan_1", [{ nodeId: "n01", state: "succeeded", reasonCode: "weed_target_gone" }]),
      outcomes: new Map(),
    }).kind,
    "no_change",
  );
  assert.equal(
    outcomeOf({ tool: "stardew_plan_work", answer: { planStatus: "refused", reasonCode: "plan_script_empty_no_builder_call" }, outcomes: new Map() })
      .kind,
    "refused",
  );
  // An unsettled answer is resolved from the run's own program outcomes; a program with no settled node is the
  // artifact saying it cannot answer, which is `not_measured` and never waste.
  const outcomes = new Map([
    ["plan_2", { programId: "plan_2", nodeOutcomes: [{ nodeId: "n01", state: "running" }] }],
    ["plan_3", { programId: "plan_3", nodeOutcomes: [{ nodeId: "n01", state: "succeeded", reasonCode: "weeds_cut" }] }],
  ]);
  assert.equal(
    outcomeOf({ tool: "stardew_plan_work", answer: { programId: "plan_2", settled: false, nodes: [{ state: "running" }] }, outcomes }).kind,
    "not_measured",
  );
  assert.equal(
    outcomeOf({ tool: "stardew_plan_work", answer: { programId: "plan_3", settled: false, nodes: [{ state: "pending" }] }, outcomes }).kind,
    "changed",
  );
  assert.equal(outcomeOf({ tool: "stardew_plan_work", answer: undefined, outcomes }).kind, "not_measured");
  assert.equal(outcomeOf({ tool: "stardew_plan_work", answer: null, unreadable: true, outcomes }).kind, "not_measured");
  assert.equal(
    outcomeOf({ tool: "stardew_express_emote", answer: executed("e1", "express_emote", "uncertain", "no_answer"), outcomes }).kind,
    "refused",
  );
  assert.equal(REFUSED_STATES.includes("uncertain"), true);
});

test("the answer is the object a tool result STARTS with, because the Host appends prose to some of them", () => {
  assert.deepEqual(leadingJson('{"state":"rejected"} A cutscene currently holds the farmhand.'), { state: "rejected" });
  assert.deepEqual(leadingJson('{"a":{"b":1}} trailing} brace'), { a: { b: 1 } });
  assert.equal(leadingJson("<world-state> 世界（revision 8）"), null, "a prose observation carries no execution identity");
  assert.equal(leadingJson('{ not json }'), null);
});

test("the nothing-changed table names a line of the Mod for every code, and that line mints it", () => {
  const codes = Object.keys(NOTHING_CHANGED_TERMINALS);
  assert.ok(codes.length > 0, "an empty vocabulary would classify every no-op as a change");
  for (const code of codes) {
    const [path, line] = NOTHING_CHANGED_TERMINALS[code].split(":");
    const absolute = join(repositoryRoot, path);
    assert.equal(existsSync(absolute), true, `${code} names ${path}, which does not exist`);
    const source = readFileSync(absolute, "utf8").split(/\r?\n/u);
    const text = source[Number(line) - 1] ?? "";
    assert.match(text, new RegExp(`"${code}"`, "u"), `${code} must be minted at ${path}:${line}`);
  }
});

test("ten empty turns of nineteen fail the gate, and the three numbers are printed apart", async () => {
  const root = await mkdtemp(join(tmpdir(), "turn-waste-red-"));
  try {
    const lines = [];
    for (let index = 0; index < 9; index += 1) {
      lines.push(turn([{ id: `w${String(index)}`, name: "stardew_plan_work", arguments: { script: `builder.cut_weeds({ x: ${String(index)}, y: 1 });` } }]));
      lines.push(
        result(
          `w${String(index)}`,
          "stardew_plan_work",
          programAnswer(`plan_${String(index)}`, [{ nodeId: "n01", state: "succeeded", reasonCode: "weeds_cut" }]),
        ),
      );
    }
    for (let index = 0; index < 10; index += 1) {
      lines.push(turn([{ id: `r${String(index)}`, name: "stardew_observe", arguments: { limit: index } }]));
      lines.push(result(`r${String(index)}`, "stardew_observe", `<world-state> revision ${String(index)}`));
    }
    await bundleOf(root, "2026-01-01T00-00-00-000Z-empty", { lines });
    const measurement = measureTurnWaste({ bundleRoot: root });
    assert.equal(measurement.turns.withSubmission, 19);
    assert.equal(measurement.empty.turns, 10);
    assert.equal(measurement.share, 0.526);
    assert.equal(measurement.refusedResubmissions, 0);
    assert.equal(measurement.repeatedReads, 0);
    const verdict = compareTurnWaste({ measurement });
    assert.equal(verdict.kind, "above");
    const rendered = renderTurnWaste({ measurement, verdict, bundleRoot: root });
    assert.equal(rendered.failed, true);
    assert.match(rendered.lines.join("\n"), /^turn_waste: empty turns 10 of 19 = 52\.6% \(every run in the population\) · refused resubmissions 0 · repeated identical reads 0$/mu);
    assert.match(rendered.lines.join("\n"), /^ {2}worst run: 2026-01-01T00-00-00-000Z-empty 10 of 19 = 52\.6%$/mu);
    assert.match(rendered.lines.join("\n"), /^ {2}judged run: 2026-01-01T00-00-00-000Z-empty 10 of 19 = 52\.6% /mu);
    assert.match(rendered.lines.join("\n"), /^turn_waste_above_ceiling:0\.526:0\.5 runs=1 run=2026-01-01T00-00-00-000Z-empty /mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a turn the artifacts cannot decide is printed as not_measured and kept out of the share", async () => {
  const root = await mkdtemp(join(tmpdir(), "turn-waste-unknown-"));
  try {
    const lines = [
      turn([{ id: "a", name: "stardew_plan_work", arguments: { script: "builder.cut_weeds({ x: 1, y: 1 });" } }]),
      result("a", "stardew_plan_work", programAnswer("plan_live", [{ nodeId: "n01", state: "succeeded", reasonCode: "weeds_cut" }])),
      // The run ended while this node was still running: the artifact says so, and the reading must not.
      turn([{ id: "b", name: "stardew_plan_work", arguments: { script: "builder.cut_weeds({ x: 2, y: 1 });" } }]),
      result("b", "stardew_plan_work", { programId: "plan_cut", settled: false, nodes: [{ nodeId: "n01", state: "running" }] }),
      // A tool call whose result never reached the record.
      turn([{ id: "c", name: "stardew_observe", arguments: { limit: 3 } }]),
    ];
    await bundleOf(root, "2026-01-01T00-00-00-000Z-cut", {
      lines,
      programOutcomes: [{ programId: "plan_cut", nodeOutcomes: [{ nodeId: "n01", state: "running" }] }],
    });
    const measurement = measureTurnWaste({ bundleRoot: root });
    assert.equal(measurement.turns.withSubmission, 3);
    assert.equal(measurement.empty.turns, 0, "neither undecidable turn may be counted as waste");
    assert.equal(measurement.notMeasured.submissions, 2);
    assert.deepEqual(measurement.notMeasured.byCause, { "a node was still in flight when the run ended": 1, "no tool result": 1 });
    const rendered = renderTurnWaste({ measurement, verdict: compareTurnWaste({ measurement }), bundleRoot: root });
    assert.match(rendered.lines.join("\n"), /^turn_waste_not_measured: 2 submission\(s\) /mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated reads need the same selection and no action between them", async () => {
  const root = await mkdtemp(join(tmpdir(), "turn-waste-reads-"));
  try {
    const observe = (id, argumentsOfCall) => [
      turn([{ id, name: "stardew_observe", arguments: argumentsOfCall }]),
      result(id, "stardew_observe", `<world-state> ${id}`),
    ];
    const lines = [
      ...observe("o1", { limit: 3 }),
      ...observe("o2", { limit: 3 }),
      // The same read again, but an action changed something in between: a fresh look, not a repeat.
      turn([{ id: "a1", name: "stardew_express_emote", arguments: { emote: "note" } }]),
      result("a1", "stardew_express_emote", executed("x1", "express_emote", "succeeded", "emote_started")),
      ...observe("o3", { limit: 3 }),
    ];
    await bundleOf(root, "2026-01-01T00-00-00-000Z-reads", { lines });
    const measurement = measureTurnWaste({ bundleRoot: root });
    assert.equal(measurement.reads.examined, 3);
    assert.equal(measurement.repeatedReads, 1, "only the second read of the pair repeats an identical selection");
    assert.equal(measurement.empty.turns, 3, "all three read turns bought nothing the receipts can show");
    assert.deepEqual(measurement.reads.byTool, { stardew_observe: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a refused resubmission is the SAME work after a refusal, and a later request into a moved world is not", async () => {
  const root = await mkdtemp(join(tmpdir(), "turn-waste-retry-"));
  try {
    const plan = (id, script, nodes) => [
      turn([{ id, name: "stardew_plan_work", arguments: { script } }]),
      result(id, "stardew_plan_work", programAnswer(`plan_${id}`, nodes)),
    ];
    const refusedNodes = [
      { nodeId: "n01", actionId: "move_to_tile", state: "rejected", reasonCode: "policy_identity_mismatch", tile: { x: 3, y: 12 } },
      { nodeId: "n02", actionId: "enter_exit", state: "rejected", reasonCode: "policy_identity_mismatch", tile: { x: 3, y: 12 } },
    ];
    const lines = [
      ...plan("p0", "builder.enter_exit({ x: 3, y: 12 });", refusedNodes),
      // The same two nodes, re-sent under a new program id: the same work, and the turn the refusal cost.
      ...plan("p1", "builder.enter_exit({ x: 3, y: 12 });", refusedNodes.map((entry) => ({ ...entry, state: "succeeded", reasonCode: "enter_exit_completed" }))),
      // A refusal is not remembered once the world has moved: this emote is refused, the next one succeeds, and the
      // third is a new request rather than a retry.
      turn([{ id: "e1", name: "stardew_express_emote", arguments: { emote: "note" } }]),
      result("e1", "stardew_express_emote", executed("x1", "express_emote", "rejected", "cutscene_active")),
      turn([{ id: "e2", name: "stardew_express_emote", arguments: { emote: "note" } }]),
      result("e2", "stardew_express_emote", executed("x2", "express_emote", "succeeded", "emote_started")),
      turn([{ id: "e3", name: "stardew_express_emote", arguments: { emote: "note" } }]),
      result("e3", "stardew_express_emote", executed("x3", "express_emote", "succeeded", "emote_started")),
    ];
    await bundleOf(root, "2026-01-01T00-00-00-000Z-retry", { lines });
    const measurement = measureTurnWaste({ bundleRoot: root });
    assert.equal(measurement.refusedResubmissions, 2, "the plan re-sent after its refusal, and the emote retried once");
    assert.deepEqual(measurement.refusedResubmissionKeys, [
      ['action:stardew_express_emote:{emote:"note"}', 1],
      ["program:enter_exit@3,12()|move_to_tile@3,12()", 1],
    ]);
    const rendered = renderTurnWaste({ measurement, verdict: compareTurnWaste({ measurement }), bundleRoot: root });
    assert.match(rendered.lines.join("\n"), /^ {2}refused resubmission: program:enter_exit@3,12\(\)\|move_to_tile@3,12\(\) re-sent 1 time\(s\) while nothing had moved$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the gate entry prints this section for a healthy synthetic run", async () => {
  const root = await mkdtemp(join(tmpdir(), "turn-waste-cli-"));
  try {
    const lines = [];
    for (let index = 0; index < TURN_WASTE_POPULATION_FLOOR; index += 1) {
      lines.push(turn([{ id: `c${String(index)}`, name: "stardew_express_emote", arguments: { emote: "note" } }]));
      lines.push(result(`c${String(index)}`, "stardew_express_emote", executed(`x${String(index)}`, "express_emote", "succeeded", "emote_started")));
    }
    await bundleOf(root, "2026-01-01T00-00-00-000Z-healthy", { lines });
    const stdout = execFileSync(process.execPath, [gatePath, "--turn-waste-only", "--bundles", root], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(stdout, /^turn_waste_population: bundleRoot=.* bundles with a session record 1 · turns examined 12 /mu);
    assert.match(stdout, /^turn_waste: empty turns 0 of 12 = 0\.0% \(every run in the population\) · refused resubmissions 0 · repeated identical reads 0$/mu);
    assert.match(stdout, /^ {2}judged run: 2026-01-01T00-00-00-000Z-healthy 0 of 12 = 0\.0% /mu);
    assert.match(stdout, /^turn_waste_ok runs=1 judged=0 ceiling=0\.5$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bundle that names no session record is counted, not read as a zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "turn-waste-norecord-"));
  try {
    const directory = join(root, "2026-01-01T00-00-00-000Z-silent");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "result.json"), `${JSON.stringify({ toolTiming: { record: null } })}\n`);
    const measurement = measureTurnWaste({ bundleRoot: root });
    assert.equal(measurement.bundles, 1);
    assert.equal(measurement.bundlesWithRecord, 0);
    assert.match(measurement.withoutRecord[0], /the bundle names no session record/u);
    assert.equal(compareTurnWaste({ measurement }).kind, "blocked");
    assert.equal(renderTurnWaste({ measurement, verdict: compareTurnWaste({ measurement }), bundleRoot: root }).failed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "round99's own record replays as three numbers",
  { skip: !existsSync(ROUND_99) },
  () => {
    const measurement = measureTurnWaste({ bundleRoot: ROUND_99 });
    assert.equal(measurement.bundlesWithRecord, 1);
    assert.equal(measurement.turns.examined, 114, "the run's own assistant records");
    assert.equal(measurement.turns.withSubmission, 96);
    assert.equal(measurement.empty.turns, 27);
    assert.equal(measurement.share, 0.281);
    assert.equal(measurement.refusedResubmissions, 1, "the refused plan re-sent as plan_1, and nothing else");
    assert.equal(measurement.repeatedReads, 0, "no read repeated an identical selection with no action between");
    assert.equal(measurement.reads.examined, 13);
    const verdict = compareTurnWaste({ measurement });
    assert.equal(verdict.kind, "ok");
    assert.equal(renderTurnWaste({ measurement, verdict, bundleRoot: ROUND_99 }).failed, false);
    assert.equal(TURN_WASTE_CEILING, 0.5);
  },
);
