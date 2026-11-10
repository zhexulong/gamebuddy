// The consolidated reader has to refuse the two things the twelve `.tmp` readers got wrong, once each, by name:
// a count that came from a token in a text blob, and a number printed where the field it needed was absent.
//
// Every fixture is fabricated on purpose, so one property is stated per test: a `toolCall` count does not move when the
// same tool name appears in prose and in thinking, a code does not appear because a non-JSON text part mentions it, a
// `not measured` names the missing field and exits 2 instead of printing 0, and the bundle questions count the
// bundle's own fields. No game, nothing read from `.live-runs`.
//
// red-proof: inject  a `text` part mentioning a tool name counted as a `toolCall` part -> `tool calls 4 of 4 toolCall
//                    parts` where the structured parts were 3, and this suite failed on `/3 of 3 toolCall parts/`
// red-proof: inject  `notMeasured()` returning `0 of 1 <unit>` instead of naming the field -> three `not measured`
//                    tests failed at once (turns, progress, session-absent), each naming its own question
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const READER = join(import.meta.dirname, "session-reading.mjs");
const START = Date.parse("2026-11-10T09:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const RECORD = ["runtime-root", "contexts", "ctx-1", "surface-sessions", "game-1", "sessions", "session-1.jsonl"];

function run({ records = [], result = null }) {
  const directory = mkdtempSync(join(tmpdir(), "session-reading-"));
  const recordPath = join(directory, ...RECORD);
  mkdirSync(join(recordPath, ".."), { recursive: true });
  writeFileSync(recordPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  if (result !== null) writeFileSync(join(directory, "result.json"), JSON.stringify(result), "utf8");
  return directory;
}

function ask(directory, question, argument = null) {
  const argv = [READER, "--run", directory, "--question", question];
  if (argument !== null) argv.push(argument);
  const child = spawnSync(process.execPath, argv, { encoding: "utf8" });
  return { status: child.status, text: `${child.stdout}${child.stderr}` };
}

/** The one output line whose label is `label`, so an assertion names the reading it is about. */
function lineFor(text, label) {
  const found = text.split("\n").find((line) => line.trim().startsWith(label));
  assert.ok(found !== undefined, `no line for ${JSON.stringify(label)} in:\n${text}`);
  return found;
}

const assistantMessage = (atMs, parts) => ({
  type: "message",
  timestamp: iso(atMs),
  message: { role: "assistant", timestamp: atMs, durationMs: 1000, content: parts },
});

const window = { startedAtMs: START, endedAtMs: START + 60_000 };

test("a toolCall count comes from structured parts, and the same name in prose or thinking does not move it", (t) => {
  const directory = run({
    result: window,
    records: [
      assistantMessage(START, [
        { type: "text", text: "I should call stardew_observe again, and stardew_observe answers with a snapshot." },
        { type: "thinking", thinking: "stardew_observe twice more would be wasteful; stardew_observe is expensive." },
        { type: "toolCall", id: "call_a", name: "stardew_observe", arguments: {} },
        { type: "toolCall", id: "call_b", name: "stardew_observe", arguments: {} },
        { type: "toolCall", id: "call_c", name: "stardew_plan_work", arguments: {} },
      ]),
    ],
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const { status, text } = ask(directory, "tools");
  assert.equal(status, 0, text);
  assert.match(lineFor(text, "tool calls"), /3 of 3 toolCall parts/);
  assert.match(lineFor(text, "stardew_observe"), /2 of 3 toolCall parts/);
  assert.match(lineFor(text, "stardew_plan_work"), /1 of 3 toolCall parts/);
});

test("a code is counted from a parsed node row, and a mention of the same code in a text part is not counted", (t) => {
  const directory = run({
    result: window,
    records: [
      // The defect this replaces: `"failureCode":"cutscene_active"` sitting in prose used to be counted as a failure by
      // a regex over the raw line. It is not JSON, so it is not a node row, so it is not a code.
      assistantMessage(START, [
        { type: "text", text: 'the log said failureCode":"cutscene_active" and reasonCode":"cutscene_active' },
        {
          type: "text",
          text: JSON.stringify({
            nodes: [{ nodeId: "n01", actionId: "till_soil", state: "failed", failureCode: "soil_not_diggable" }],
          }),
        },
      ]),
    ],
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const { status, text } = ask(directory, "codes");
  assert.equal(status, 0, text);
  assert.match(lineFor(text, "coded terminals"), /1 of 1 terminal node rows/);
  assert.ok(text.includes("soil_not_diggable"), text);
  assert.ok(!text.includes("cutscene_active"), `a prose mention became a code:\n${text}`);
});

test("a question whose session carried no assistant message prints not measured and names the field, never 0", (t) => {
  const directory = run({
    result: window,
    records: [
      { type: "message", timestamp: iso(START), message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ],
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const { status, text } = ask(directory, "turns");
  assert.equal(status, 2, text);
  const row = lineFor(text, "assistant turns");
  assert.match(row, /not measured:/);
  assert.match(row, /needs message\.timestamp/);
  assert.ok(!/ 0 of /.test(row), `a missing field printed a zero: ${row}`);
});

test("a bundle question on a run directory with no result.json names the missing field and exits 2", (t) => {
  const directory = run({ records: [assistantMessage(START, [{ type: "text", text: "ok" }])] });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const { status, text } = ask(directory, "progress");
  assert.equal(status, 2, text);
  const row = lineFor(text, "programmes");
  assert.match(row, /not measured:/);
  assert.match(row, /result\.json programSubmissions/);
  assert.ok(!/ 0 of /.test(row), `a missing bundle printed a zero: ${row}`);
});

test("no session anywhere in the run prints not measured naming the field the reader needed", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-reading-empty-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "result.json"), JSON.stringify(window), "utf8");

  const { status, text } = ask(directory, "tools");
  assert.equal(status, 2, text);
  assert.match(text, /not measured: session-derived readings/);
  assert.match(text, /needs runtime-root\/contexts/);
});

test("nodes counts the bundle's planned nodes against the settled state of the same node", (t) => {
  const directory = run({
    result: {
      ...window,
      programSubmissions: [
        { programId: "plan_1", nodes: [{ actionId: "till_soil" }, { actionId: "plant_seed" }] },
        { programId: "plan_2", nodes: [{ actionId: "till_soil" }] },
      ],
      programOutcomes: [
        {
          programId: "plan_1",
          nodeOutcomes: [
            { sequence: 1, actionId: "till_soil", state: "failed" },
            { sequence: 2, actionId: "plant_seed", state: "succeeded" },
          ],
        },
        { programId: "plan_2", nodeOutcomes: [{ sequence: 1, actionId: "till_soil", state: "succeeded" }] },
      ],
    },
    records: [],
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const { status, text } = ask(directory, "nodes");
  assert.equal(status, 0, text);
  assert.match(lineFor(text, "planned"), /3 of 3 submitted nodes/);
  assert.match(lineFor(text, "settled"), /3 of 3 submitted nodes/);
  assert.match(lineFor(text, "succeeded"), /2 of 3 settled nodes/);
  assert.match(lineFor(text, "till_soil"), /planned 2 \/ succeeded 1/);
});
