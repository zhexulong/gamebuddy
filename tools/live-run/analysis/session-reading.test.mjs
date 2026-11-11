// The consolidated reader has to refuse the four things the twelve `.tmp` readers got wrong, once each, by name:
// a count that came from a token in a text blob, a number printed where the field it needed was absent, a question
// asked of the file that stopped carrying the answer, and a row read as a piece of work once per status snapshot.
//
// Every fixture is fabricated on purpose, so one property is stated per test: a `toolCall` count does not move when the
// same tool name appears in prose and in thinking, a code does not appear because a non-JSON text part mentions it, a
// `not measured` names the missing field and exits 2 instead of printing 0, a session in the launcher's own root is
// found rather than called absent, and a node published three times is one node. No game, nothing read from
// `.live-runs`, and no dependence on the machine's real `%LOCALAPPDATA%` - every root the reader searches is a fixture.
//
// red-proof: inject  a `text` part mentioning a tool name counted as a `toolCall` part -> `tool calls 4 of 4 toolCall
//                    parts` where the structured parts were 3, and this suite failed on `/3 of 3 toolCall parts/`
// red-proof: inject  `notMeasured()` returning `0 of 1 <unit>` instead of naming the field -> three `not measured`
//                    tests failed at once (turns, progress, session-absent), each naming its own question
// red-proof: history  check out tools/live-run/analysis/session-reading.mjs before this change and run this suite: `codes`
//                    exits 2 with `0 terminal node rows` on the bundle fixture, `tools` prints `session (absent)` for
//                    the record in the launcher's root, and `shape till_soil` reports 3 node rows where there is 1 node.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QUESTIONS } from "./session-reading.mjs";

const READER = join(import.meta.dirname, "session-reading.mjs");
const START = Date.parse("2026-11-10T09:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const RECORD = ["runtime-root", "contexts", "ctx-1", "surface-sessions", "game-1", "sessions", "session-1.jsonl"];
const LAUNCHER_RECORD = [
  "appdata",
  "GameBuddy",
  "contexts",
  "ctx-1",
  "surface-sessions",
  "game-1",
  "sessions",
  "live.jsonl",
];

function fixture({ records = [], result = null, launch = null, session = true }) {
  const directory = mkdtempSync(join(tmpdir(), "session-reading-"));
  if (session) writeRecord(directory, RECORD, records);
  if (result !== null) writeFileSync(join(directory, "result.json"), JSON.stringify(result), "utf8");
  if (launch !== null) writeFileSync(join(directory, "launch.json"), JSON.stringify(launch), "utf8");
  return directory;
}

/** One record written into a path under the fixture, so a root can be placed where the launcher would put it. */
function writeRecord(directory, segments, records) {
  const path = join(directory, ...segments);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return path;
}

/**
 * The reader, run against a fixture whose every root is inside that fixture.
 *
 * `%LOCALAPPDATA%` is redirected on purpose: the reader searches the launcher's real root when it is set, and a test
 * that asserted `not measured` while a real session sat on this machine would pass for the wrong reason.
 */
function ask(directory, question, argument = null) {
  const argv = [READER, "--run", directory, "--question", question];
  if (argument !== null) argv.push(argument);
  const child = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    env: {
      ...process.env,
      LOCALAPPDATA: join(directory, "appdata"),
      GAMEBUDDY_RUNTIME_ROOT: join(directory, "runtime"),
    },
  });
  return { status: child.status, text: `${child.stdout}${child.stderr}` };
}

/** The one output line whose label is `label`, so an assertion names the reading it is about. */
function lineFor(text, label) {
  const found = text.split("\n").find((line) => line.trim().startsWith(label));
  assert.ok(found !== undefined, `no line for ${JSON.stringify(label)} in:\n${text}`);
  return found;
}

/** The `root` line whose outcome matches, so an assertion names the root that ANSWERED rather than the first tried. */
function rootLineFor(text, pattern) {
  const found = text.split("\n").filter((line) => line.startsWith("root     ") && pattern.test(line));
  assert.equal(found.length, 1, `expected exactly one root line matching ${pattern}:\n${text}`);
  return found[0];
}

const assistantMessage = (atMs, parts) => ({
  type: "message",
  timestamp: iso(atMs),
  message: { role: "assistant", timestamp: atMs, durationMs: 1000, content: parts },
});

const window = { startedAtMs: START, endedAtMs: START + 60_000 };

/** A node row as the journal publishes it inside a status snapshot, under the programme that owns it. */
const snapshot = (programId, nodes) => ({
  type: "message",
  timestamp: iso(START),
  message: { role: "toolResult", content: [{ type: "text", text: JSON.stringify({ programId, nodes }) }] },
});

test("a toolCall count comes from structured parts, and the same name in prose or thinking does not move it", (t) => {
  const directory = fixture({
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
  const directory = fixture({
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
  assert.match(lineFor(text, "coded terminals"), /1 of 1 non-success nodes/);
  assert.ok(text.includes("soil_not_diggable"), text);
  assert.ok(!text.includes("cutscene_active"), `a prose mention became a code:\n${text}`);
});

test("a question whose session carried no assistant message prints not measured and names the field, never 0", (t) => {
  const directory = fixture({
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
  const directory = fixture({ records: [assistantMessage(START, [{ type: "text", text: "ok" }])] });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const { status, text } = ask(directory, "progress");
  assert.equal(status, 2, text);
  const row = lineFor(text, "programmes");
  assert.match(row, /not measured:/);
  assert.match(row, /result\.json programSubmissions/);
  assert.ok(!/ 0 of /.test(row), `a missing bundle printed a zero: ${row}`);
});

test("no session anywhere in the run prints not measured naming each root it tried", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-reading-empty-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "result.json"), JSON.stringify(window), "utf8");

  const { status, text } = ask(directory, "tools");
  assert.equal(status, 2, text);
  assert.match(text, /not measured: session-derived readings/);
  assert.match(text, /needs runtime-root\/contexts/);
  const roots = text.split("\n").filter((line) => line.startsWith("root     "));
  assert.equal(roots.length, 3, `expected the run's capture and the launcher's two roots to be named:\n${text}`);
  const separator = join("a", "b") === "a\\b" ? "\\" : "/";
  assert.ok(
    roots.some((line) => line.includes(`runtime-root${separator}contexts`)) &&
      roots.some((line) => line.includes(`runtime${separator}contexts`)) &&
      roots.some((line) => line.includes(`GameBuddy${separator}contexts`)),
    `the roots tried are not all named:\n${text}`,
  );
});

test("a session in the launcher's default root is found, and the reader says which root it read", (t) => {
  // The run was stopped by hand: it wrote `launch.json` and nothing else, so its own capture holds no session and the
  // only copy is the one the launcher's runtime root kept. The launch is now, because that is when the record is born.
  const startedAtMs = Date.now() - 2000;
  const directory = fixture({ launch: { schema: "gamebuddy-live-run-launch/v1", startedAtMs }, session: false });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeRecord(directory, LAUNCHER_RECORD, [
    assistantMessage(Date.now(), [{ type: "toolCall", id: "call_a", name: "stardew_observe", arguments: {} }]),
  ]);

  const { status, text } = ask(directory, "tools");
  assert.equal(status, 0, text);
  const root = rootLineFor(text, /\[read from:/);
  assert.match(root, /GameBuddy/, `the root that answered is not named: ${root}`);
  assert.match(root, /\[read from: the record created/, `the root does not say it answered: ${root}`);
  assert.match(lineFor(text, "session"), /live\.jsonl/, text);
  assert.match(lineFor(text, "tool calls"), /1 of 1 toolCall parts/);
});

test("a live root is not read as this run's when no record was created with the launch", (t) => {
  const directory = fixture({ launch: { startedAtMs: START }, session: false });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A record written now, in the launcher's root, for a run that started in 2026-11-10: not this run's session.
  writeRecord(directory, LAUNCHER_RECORD, [
    assistantMessage(Date.now(), [{ type: "toolCall", id: "call_a", name: "stardew_observe", arguments: {} }]),
  ]);

  const { status, text } = ask(directory, "tools");
  assert.equal(status, 2, text);
  assert.match(rootLineFor(text, /\[not used:/), /none of its 1 record\(s\) was created within 60s of 09:00/, text);
  assert.match(lineFor(text, "session"), /\(absent\)/, text);
});

test("codes answers from the bundle when the session carries no node ending, and says so", (t) => {
  // The measured defect: since the model-visible batches became prose, no node JSON reaches a text part, so the
  // session's node rows are plans (`state: pending`) and asking it for codes reported `0 terminal node rows` on a run
  // whose nodes had all ended. The bundle is written at teardown and carries them.
  const directory = fixture({
    result: {
      ...window,
      programSubmissions: [{ programId: "plan_1", nodes: [{ nodeId: "n01", actionId: "plant_seed", arguments: {} }] }],
      programOutcomes: [
        {
          programId: "plan_1",
          nodeOutcomes: [
            { nodeId: "n01", actionId: "plant_seed", state: "failed", reasonCode: "seed_not_owned_in_slot" },
          ],
        },
      ],
    },
    records: [snapshot("plan_1", [{ index: 0, actionId: "plant_seed", state: "pending", tile: { x: 61, y: 20 } }])],
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const { status, text } = ask(directory, "codes");
  assert.equal(status, 0, text);
  assert.match(lineFor(text, "source"), /\[answered: the bundle\]/, text);
  assert.match(lineFor(text, "coded terminals"), /1 of 1 non-success nodes/);
  assert.ok(text.includes("seed_not_owned_in_slot"), text);
  const cross = lineFor(text, "cross-check");
  assert.match(cross, /1 of 1 node rows carry no nodeId/, cross);
  assert.match(cross, /\[silent: the session named no node it could report an ending for\]/, cross);
});

test("a node published once per snapshot is one node, and the row count is printed beside it", (t) => {
  // A node appears in every status snapshot. Counting its rows as work made `shape plant_seed` report 16 rows for 6
  // seeds; the identity is `programId/nodeId`, and a row with no nodeId is counted as a row and never as a node.
  const directory = fixture({
    records: [
      snapshot("plan_1", [{ nodeId: "n01", actionId: "till_soil", state: "pending", tile: { x: 40, y: 9 } }]),
      snapshot("plan_1", [{ nodeId: "n01", actionId: "till_soil", state: "running", tile: { x: 40, y: 9 } }]),
      snapshot("plan_1", [
        {
          nodeId: "n01",
          actionId: "till_soil",
          state: "failed",
          reasonCode: "soil_not_diggable",
          tile: { x: 40, y: 9 },
        },
      ]),
      // Two plan rows: the same programme's nodes as they were submitted, published without a node id.
      snapshot("plan_1", [
        { index: 0, actionId: "till_soil", state: "pending", tile: { x: 40, y: 9 } },
        { index: 1, actionId: "plant_seed", state: "pending", tile: { x: 41, y: 9 } },
      ]),
    ],
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const { status, text } = ask(directory, "shape", "till_soil");
  assert.equal(status, 0, text);
  assert.match(lineFor(text, "node rows"), /5 of 5 node rows/);
  assert.match(lineFor(text, "distinct node ids"), /1 of 5 node rows/);
  assert.match(lineFor(text, "without_node_id"), /2 of 5 node rows/);
  assert.match(lineFor(text, "tiles reached"), /1 of 1 nodes naming till_soil/);

  const coded = ask(directory, "codes");
  assert.equal(coded.status, 0, coded.text);
  assert.match(lineFor(coded.text, "coded terminals"), /1 of 1 non-success nodes/, coded.text);
});

test("both sources answer and the reader prints both, naming the one that decided", (t) => {
  const directory = fixture({
    result: {
      ...window,
      programSubmissions: [{ programId: "plan_1", nodes: [{ nodeId: "n01", actionId: "till_soil", arguments: {} }] }],
      programOutcomes: [
        {
          programId: "plan_1",
          nodeOutcomes: [{ nodeId: "n01", actionId: "till_soil", state: "failed", reasonCode: "cutscene_active" }],
        },
      ],
    },
    records: [
      snapshot("plan_1", [
        { nodeId: "n01", actionId: "till_soil", state: "failed", reasonCode: "cutscene_active" },
        { nodeId: "n02", actionId: "till_soil", state: "failed", reasonCode: "soil_already_tilled" },
      ]),
    ],
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const { status, text } = ask(directory, "codes");
  assert.equal(status, 0, text);
  const cross = lineFor(text, "cross-check");
  assert.match(cross, /2 of 2 node rows are distinct nodes/, cross);
  assert.match(cross, /\[differs, and the bundle decided:/, cross);
  assert.match(cross, /only the session carries soil_already_tilled/, cross);
  assert.match(lineFor(text, "coded terminals"), /1 of 1 non-success nodes/);
});

test("nodes counts the bundle's planned nodes against the settled state of the same node", (t) => {
  const directory = fixture({
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

/**
 * The gate: a reading without a source is silent.
 *
 * The population is the reader's own `QUESTIONS` declaration, so a question kind added tomorrow is checked without
 * anybody remembering to add it here. Two properties, one per direction:
 *
 *   - where the run CARRIES the answer, the kind reads it: `source`, `method` and `window`, at least one `N of M <unit>`
 *     population, and no `not measured` at all. `not measured` means "this run does not carry it", and this run does -
 *     which is the lie the shipped reader told about a session sitting in the launcher's own root and about the node
 *     endings the bundle carries.
 *   - where the run carries nothing, the kind prints a named refusal or an answer, and never a bare number and never a
 *     label with nothing after it.
 */
test("reading_without_a_source_is_silent: every declared question prints its four facts or names what it needed", (t) => {
  t.diagnostic(`population: ${QUESTIONS.length} question kinds - ${QUESTIONS.join(", ")}`);
  assert.ok(QUESTIONS.length > 0, "the reader declared no question, so this gate examined nothing");

  const ARGUMENT = { thinking: "seed", shape: "plant_seed" };
  // Everything each kind needs: a session captured beside the run (turns, tool calls, thinking) and a bundle with a
  // coded ending (nodes, codes, shape, progress). The session's only node rows are plans, which is exactly what the
  // shipped reader counted as "no terminal state" while the bundle held the ending.
  const carries = fixture({
    result: {
      ...window,
      programSubmissions: [{ programId: "plan_1", nodes: [{ nodeId: "n01", actionId: "plant_seed", arguments: {} }] }],
      programOutcomes: [
        {
          programId: "plan_1",
          nodeOutcomes: [
            {
              nodeId: "n01",
              actionId: "plant_seed",
              state: "failed",
              reasonCode: "soil_not_diggable",
              tile: { x: 60, y: 9 },
            },
          ],
        },
      ],
    },
    records: [
      assistantMessage(START, [
        { type: "thinking", thinking: "the seed row is ready" },
        { type: "toolCall", id: "call_a", name: "stardew_observe", arguments: {} },
      ]),
      assistantMessage(START + 5_000, [{ type: "toolCall", id: "call_b", name: "stardew_plan_work", arguments: {} }]),
      snapshot("plan_1", [{ index: 0, actionId: "plant_seed", state: "pending", tile: { x: 60, y: 9 } }]),
    ],
  });
  const empty = fixture({ result: { startedAtMs: START, endedAtMs: START + 60_000 } });
  t.after(() => {
    rmSync(carries, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  });

  for (const kind of QUESTIONS) {
    const carried = ask(carries, kind, ARGUMENT[kind] ?? null);
    assert.match(
      carried.text,
      new RegExp(`^question ${kind}( |$)`, "mu"),
      `${kind} did not name the question it answered:\n${carried.text}`,
    );
    for (const field of ["source", "method", "window"])
      assert.match(
        carried.text,
        new RegExp(`^\\s*${field}\\s+\\S`, "mu"),
        `${kind} printed no ${field}:\n${carried.text}`,
      );
    assert.match(
      carried.text,
      /\s\d+ of \d+ \S|\s\S+ over \d+ of \d+ /u,
      `${kind} printed no population for the run that carries its answer:\n${carried.text}`,
    );
    assert.ok(
      !carried.text.includes("not measured"),
      `${kind} called a reading not measured on a run that carries it:\n${carried.text}`,
    );

    const refused = ask(empty, kind, ARGUMENT[kind] ?? null);
    assert.match(
      refused.text,
      new RegExp(`^question ${kind}( |$)`, "mu"),
      `${kind} did not name the question it refused:\n${refused.text}`,
    );
    const factsPrinted = ["source", "method", "window"].every((field) =>
      new RegExp(`^\\s*${field}\\s+\\S`, "mu").test(refused.text),
    );
    const population = /\s\d+ of \d+ \S|\s\S+ over \d+ of \d+ /u.test(refused.text);
    const named = /not measured: [^\n]* needs /u.test(refused.text);
    assert.ok(factsPrinted || named, `${kind} printed neither where it read nor what it needed:\n${refused.text}`);
    assert.ok(
      population || named,
      `${kind} printed a number with no population and named nothing it needed:\n${refused.text}`,
    );
    for (const line of refused.text.split("\n")) {
      if (line.trim() === "") continue;
      assert.ok(!/^\s{2,}\S+\s*$/u.test(line), `${kind} printed a label with no value: ${JSON.stringify(line)}`);
      assert.ok(
        !/^\s{2,}[^0-9]*\s\d+(?:\.\d+)?$/u.test(line),
        `${kind} printed a bare number: ${JSON.stringify(line)}`,
      );
    }
  }
});
