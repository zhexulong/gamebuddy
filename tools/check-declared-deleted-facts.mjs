#!/usr/bin/env node
/**
 * A kind the authority says is deleted must be COUNTABLE TO ZERO in a run's own log.
 *
 * WHY (measured 2026-11-17/18, `round66`). `design/fact-authority.md` declares nine kinds of body trace not-facts. Seven
 * stopped being produced and the aggregate fell hard, so the report said "356 → 62, the flood is fixed" - and every
 * merge was verified with `typecheck` and `build`, neither of which reads a log. `accepted` arrived 46 times,
 * `running` 17, `tool_equipped` once, and nobody noticed for a day, because the two biggest kinds had died and the
 * survivors were the smaller ones. A declared deletion that is not measured is a claim; this gate is the measurement.
 *
 * THE POPULATION IS DERIVED FROM TWO AUTHORITIES AND THE GATE REFUSES TO PASS IF THEY CONTRADICT EACH OTHER.
 *
 *   the document  `design/fact-authority.md` - the two sentences that declare a deletion (`不需要存在`, `不得成为候选
 *                 事实`) carry backticked tokens, and §1's not-fact column names four further kinds in prose. Each prose
 *                 row is glossed to the kind it names, or declared to name no single kind with a reason, so a row
 *                 nobody accounted for fails (`declared_deleted_doc_row_unclassified`). The document lives in
 *                 `zhexulong/gamebuddy-docs` and a CI checkout does not mount it; the checked-in transcription
 *                 `tools/fixtures/declared-deleted/doc-declared-not-facts.json` is used when the mount is absent and is
 *                 compared MEMBER BY MEMBER against the document whenever it is present, so a transcription that drifts
 *                 fails by the name of the member that moved.
 *
 *   the code      `host/src/event-pump.ts`: `HELD_RECEIPT_PROGRESS_STATES`, `IN_FLIGHT_RECEIPT_PROGRESS_STATES`,
 *                 `HELD_SEMANTIC_PROGRESS_KINDS`, `SETTLED_PROGRAM_OUTCOMES`, and the `"progress"`/`"in_flight_progress"`
 *                 assignments of `buildFactTurnConsequence`. Every table the classification reads is asserted to still be
 *                 read by it (`fact_turn_consequence_stops_reading`), a member that is both HELD and SETTLED is refused
 *                 (`declared_deleted_member_is_also_settled`), and so is a held receipt state the Mod's own `IsTerminal`
 *                 calls settled (`declared_deleted_state_the_producer_calls_terminal`) - that pairing is the round39 bug,
 *                 a settled fact held latest-only and quietly dropped.
 *
 * CONTradiction, DIRECTIONAL AND PRINTED. A member both vocabularies can spell (a receipt state or a semantic kind) must
 * be `progress` in the code when the document calls it a not-fact, and must NOT be held when the document's FACT column
 * names it (`一次拒绝` = `rejected`, `玩家说话` = `player_input`). Members only one side can spell are a READING, not a
 * disagreement: the document names transition reasons and reason codes (`tile_advanced`, `tool_equipped`), which no
 * consequence table has a shape for, and the code names receipt states the document never mentions. The gate prints
 * `agreed/doc-only/code-only` rather than pretending the two lists are the same set - set equality here would be red at
 * every commit and would make the measurement unreadable, which is how a gate gets ignored.
 *
 * THE LOG IS PARSED BY VALUE, NEVER BY MENTION, because counting substrings has lied three times in one day: `accepted`
 * is named 2337 times in `round66` while 46 facts carry it (once per `BRIDGE_DIAGNOSTIC`, per chat-ingress line, per
 * `AGENT_PROGRAM_SUBMIT`), and the pump's own `GAME_TURN_ACCOUNT` prints every `TRACE_KINDS` member with a count,
 * mostly zero (`traces 2 {receipt:accepted: 2, semantic:route_progress: 0, ...}`). So only `BRIDGE_FACT` lines are read,
 * each is JSON-parsed, and a kind counts when it appears in a KIND POSITION as a value: `type`, `state`, `reasonCode`,
 * `worldFactKind`, `kind`, and the same three inside `worldFactPayload`. Free text - `evidence.detail`, the account
 * lines, every diagnostic - is never searched. One fact counts once for a kind however many positions repeat it.
 *
 * WHAT IT PRINTS.
 *
 *   `declared-deleted kinds examined N · gone G · still produced S`, then one line per survivor:
 *   `✖ declared_deleted_fact_still_produced:<kind> · <count> · <emitting file:line> (<position>)`
 *      the emitter for a held receipt STATE is the Mod's receipt publish seam, because that is the only way a receipt of
 *      that state reaches the fact stream; for any other kind it is the first production site that spells the literal,
 *      and `unresolved` when there is none.
 *      a state survivor also names the reason codes it arrived with, because that is what a reader has to fix
 *      (`running · 17 · tool_approach_completed 14, item_pickup_approach_completed 3`).
 *
 * THE THREE ZEROES ARE TOLD APART.
 *   zero population        BLOCKED, exit 2 - a derivation that found neither a document nor a table agrees with itself.
 *   no log at all          BLOCKED by name when the caller named one (exit 2); with no argument the run prints
 *                          `declared_deleted_facts_log_skipped: <where it looked>` and exits 0, because this is a
 *                          POST-RUN gate and a commit cannot be failed for a log that does not exist yet. CI reads that
 *                          marker as `not_measured`, never as a pass.
 *   a log with no facts    BLOCKED, exit 2 - a log whose screens hold no `BRIDGE_FACT` line was not a run.
 *   a log with facts and no survivor is the genuine zero, and it is printed as `still produced 0` beside `examined N`.
 *
 * WHAT IT IS HONEST ABOUT NOT DOING. A log can only show the positions its format writes. `snapshot` is classified
 * `progress` by the pump and is not written as a `BRIDGE_FACT` at all, so its reading is a CEILING: the gate prints it
 * as `unobservable-in-this-log` rather than counting it as gone. Nothing here can tell a kind that was never produced
 * from a kind whose producer logs under another name; both read as zero, which is the direction a deletion wants.
 *
 * Usage:
 *   node tools/check-declared-deleted-facts.mjs                     # newest run log, else the skip marker
 *   node tools/check-declared-deleted-facts.mjs --log <path>        # the verdict over one run's log
 *   node tools/check-declared-deleted-facts.mjs --log <path> --expect accepted=46,running=17
 *                                                                   # assert the exact survivor reading (a history pin)
 *   node tools/check-declared-deleted-facts.mjs --root <dir>        # fixture tree for the document and the pump
 *   node tools/check-declared-deleted-facts.mjs --doc <path>        # the document, when it is mounted elsewhere
 *   node tools/check-declared-deleted-facts.mjs --log-dir <dir>     # where to look when no --log is given
 *
 * red-proof: history  `--log tools/fixtures/declared-deleted/round66-facts.runner-log` (the real `round66` fact stream) ->
 *                     exit 1, `✖ declared_deleted_fact_still_produced:accepted · 46`,
 *                     `:running · 17 · ... tool_approach_completed 14, item_pickup_approach_completed 3`,
 *                     `:tool_equipped · 1 · ...resourcetoolactions.cs:576`; the same log with those fact lines removed is
 *                     `still produced 0`, exit 0 (`tools/check-declared-deleted-facts.test.mjs`)
 * red-proof: inject   `semantic:body_idle` classified `decision` in a fixture pump while the fixture document still
 *                     declares `body_idle` a not-fact -> `declared_deleted_doc_and_code_disagree:body_idle`; the same
 *                     fixture with the document's declaration removed is clean
 */

export const gateDeclaration = {
  id: "check-declared-deleted-facts",
  domain: "product",
  tier: "l1",
  kind: "contract",
};

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GATE_ID = "declared-deleted-facts";
const DOC_PATH = "design/fact-authority.md";
const TRANSCRIPTION_PATH = "tools/fixtures/declared-deleted/doc-declared-not-facts.json";
const EVENT_PUMP = "host/src/event-pump.ts";
const MODELS = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
const WIRE = "protocol/bridge-v1.schema.json";
const MOD_ROOT = "integrations/stardew";
const HOST_ROOT = "host/src";

/** The two sentences in which the document declares that a kind need not exist. Their tokens are the population. */
const DELETION_MARKERS = ["不需要存在", "不得成为候选事实"];

/**
 * §1's not-fact column names kinds in prose, and prose is not a token a log can be counted for. Each row is glossed to
 * the kind it names - the gloss EXPIRES: a row whose phrase has left the document, or a gloss whose kind production
 * no longer spells, is a finding rather than a quiet miss. A row that names no single kind says so, with its reason.
 */
const ROW_GLOSSES = Object.freeze([
  { phrase: "走了一格", kind: "tile_advanced" },
  { phrase: "身体空闲了", kind: "body_idle" },
  { phrase: "执行开始了", kind: "execution_started" },
  { phrase: "工具被装上了", kind: "tool_equipped" },
]);

/** The rows of the not-fact column that name no single kind, and why nobody can count them as one. */
const ROW_UNNAMED = Object.freeze([
  {
    phrase: "正在做第 N 项",
    why: "a programme's step position has no kind of its own: the step rides a receipt in a progress state, so it is counted by that state's member and never by a word of its own",
  },
]);

/** The document's FACT column, in the two places it names something a consequence table classifies. */
const FACT_GLOSSES = Object.freeze([
  { phrase: "一次拒绝", shape: "receipt:rejected" },
  { phrase: "玩家说话", shape: "semantic:player_input" },
]);

/** The positions a fact carries a KIND as a value. Free text is not one of them, deliberately. */
const KIND_FIELDS = Object.freeze(["type", "state", "reasonCode", "worldFactKind", "kind"]);
const PAYLOAD_FIELDS = Object.freeze(["state", "reasonCode", "kind", "worldFactKind"]);

const argv = process.argv.slice(2);
const ROOT = resolve(option("--root") ?? repositoryRoot());
const findings = [];

const doc = readDocumentAuthority();
const code = readCodeAuthority();
const wire = readWire();
const population = assemblePopulation(doc, code, wire);
const seam = readReceiptPublishSeam();

const logPath = option("--log") ?? newestRunLog(option("--log-dir"));
let reading = null;
if (logPath !== null) reading = measure(readLog(logPath), population.members, wire);

const verdict = decide({ reading, population });
report(verdict);
process.exitCode = verdict.exitCode;

// ---------------------------------------------------------------------------------------------------------------
// The document half
// ---------------------------------------------------------------------------------------------------------------

/**
 * The kinds the document declares deleted, plus the reading of which of its rows nobody accounted for.
 *
 * The mount is the authority. When it is absent the checked-in transcription speaks, and when BOTH are available the
 * transcription is compared against the parse member by member - a transcription is a snapshot with a verifier, never a
 * second authority.
 */
function readDocumentAuthority() {
  const explicit = option("--doc");
  const path = explicit ?? join(ROOT, DOC_PATH);
  const transcription = readTranscription();
  if (!existsSync(path)) return absentDocument({ path, explicit, transcription });
  return readMountedDocument({ path, transcription });
}

/** No mount: the transcription speaks, unless the caller NAMED a document and that document is not there. */
function absentDocument({ path, explicit, transcription }) {
  if (explicit !== null) {
    findings.push(
      finding(
        "declared_deleted_doc_missing",
        DOC_PATH,
        `the document named by --doc does not exist (${path}), so the document half of the population was not ` +
          "measured - not read and found empty, absent",
      ),
    );
    return { source: path, mounted: false, tokens: new Map(), rows: [], factShapes: new Map(), transcription };
  }
  return {
    source: transcriptionPath(),
    mounted: false,
    tokens: new Map(transcription.notFacts.map((kind) => [kind, { line: 0, from: "transcription" }])),
    rows: [],
    factShapes: new Map(transcription.factShapes.map((shape) => [shape, { line: 0 }])),
    transcription,
  };
}

/** The mount is the authority: the declaration sentences, the §1 rows and their glosses, and the transcription checked. */
function readMountedDocument({ path, transcription }) {
  const text = readFileSync(path, "utf8");
  const tokens = declaredTokens(text);
  const rows = notFactRows(text);
  for (const row of rows) {
    const glossed = ROW_GLOSSES.find((gloss) => row.cell.includes(gloss.phrase));
    if (glossed !== undefined && !tokens.has(glossed.kind))
      tokens.set(glossed.kind, { line: row.line, from: `the row 「${glossed.phrase}」` });
  }
  checkGlosses({ rows, text, transcription });
  const factShapes = new Map();
  for (const gloss of FACT_GLOSSES)
    if (text.includes(gloss.phrase)) factShapes.set(gloss.shape, { line: lineOf(text, text.indexOf(gloss.phrase)) });
  // A transcription that moved away from the mounted document, named member by member: the mount is the authority and
  // the transcription speaks only where the mount is absent, so the two disagreeing is the defect.
  disagreements(tokens, transcription);
  return { source: path, mounted: true, tokens, unnamed: transcription.unnamed, rows, factShapes, transcription };
}

/**
 * The kinds the document's deletion sentences declare.
 *
 * The sentence the marker ends is the declaration: taking the whole LINE pulls in every other backticked token on it (the
 * `- **`route_progress` / `tile_advanced` / ... 不需要存在。** 它们既非结果也非决定。` line, and the
 * `... 推送不需要存在。她想知道，就调用 `observe`.` line), which put `observe` - a tool the fix is to CALL - into the
 * deleted population.
 */
function declaredTokens(text) {
  const tokens = new Map();
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    for (const marker of DELETION_MARKERS) {
      let at = line.indexOf(marker);
      while (at >= 0) {
        for (const match of declaringSentence(line, at).matchAll(/`([a-z][a-z0-9_]+)`/gu))
          if (!tokens.has(match[1])) tokens.set(match[1], { line: index + 1, from: "declaration" });
        at = line.indexOf(marker, at + marker.length);
      }
    }
  }
  return tokens;
}

/** Every gloss and every exemption must still match a row, and every row must be accounted for: all three expire. */
function checkGlosses({ rows, text, transcription }) {
  for (const gloss of ROW_GLOSSES)
    if (!rows.some((row) => row.cell.includes(gloss.phrase)))
      findings.push(
        finding(
          "declared_deleted_gloss_stale",
          gloss.kind,
          `the gloss 「${gloss.phrase}」 -> \`${gloss.kind}\` no longer matches a row of ${DOC_PATH}'s not-fact ` +
            "column, so it excuses nothing; delete it or fix the phrase",
        ),
      );
  for (const row of rows)
    if (!coveredRow(row))
      findings.push(
        finding(
          "declared_deleted_doc_row_unclassified",
          row.cell,
          `${DOC_PATH}:${row.line} declares 「${row.cell}」 not a fact and this gate cannot count it: it is neither ` +
            "glossed to a kind nor declared to name none. A declaration this gate cannot measure is the shape that " +
            "let the flood back in - gloss it or state why it has no kind",
        ),
      );
  for (const entry of transcription.unnamed)
    if (!text.includes(entry.phrase))
      findings.push(
        finding(
          "declared_deleted_gloss_stale",
          entry.phrase,
          `${TRANSCRIPTION_PATH} says 「${entry.phrase}」 names no single kind for a stated reason, and ${DOC_PATH} no ` +
            "longer carries that phrase - an exemption that outlives the row it excuses is a row nobody reads",
        ),
      );
}

function coveredRow(row) {
  return (
    ROW_GLOSSES.some((gloss) => row.cell.includes(gloss.phrase)) ||
    ROW_UNNAMED.some((entry) => row.cell.includes(entry.phrase))
  );
}

/** Every row of the not-fact column: 2-cell markdown rows, header and separator dropped. */
function notFactRows(text) {
  const rows = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const cells = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/u.exec(line);
    if (cells === null) continue;
    const cell = cells[2]
      .replaceAll("**", "")
      .replace(/（[^）]*）/gu, "")
      .replaceAll('"', "")
      .trim();
    if (cell === "" || /^-+$/u.test(cell) || cell === "不是事实") continue;
    rows.push({ line: index + 1, cell });
  }
  return rows;
}

function readTranscription() {
  // A fixture tree overrides the document without having to carry a copy of the transcription: the shipped one is
  // the reading the mount produced, and a fixture that changes only the document is exactly the drift the comparison
  // below is for.
  const local = transcriptionPath();
  const path = existsSync(local) ? local : join(moduleRoot(), TRANSCRIPTION_PATH);
  if (!existsSync(path))
    blocked(`${TRANSCRIPTION_PATH} does not exist, and ${DOC_PATH} is not mounted, so the document half is unreadable`);
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const notFacts = Array.isArray(payload.notFacts) ? payload.notFacts : [];
  if (notFacts.length === 0) blocked(`${TRANSCRIPTION_PATH} declares no not-fact`);
  return {
    notFacts: [...notFacts].sort(),
    unnamed: Array.isArray(payload.unnamed) ? payload.unnamed : [],
    factShapes: Array.isArray(payload.factShapes) ? payload.factShapes : [],
    measured: payload.measured ?? "unstated",
  };
}

/** A transcription that moved away from the mounted document, member by member. */
function disagreements(tokens, transcription) {
  const mounted = [...tokens.keys()].sort();
  const recorded = [...transcription.notFacts].sort();
  for (const kind of mounted.filter((entry) => !recorded.includes(entry)))
    findings.push(
      finding(
        "declared_deleted_transcription_drift",
        kind,
        `${DOC_PATH} declares \`${kind}\` a not-fact and ${TRANSCRIPTION_PATH} does not list it, so a checkout ` +
          "without the mount would not count it at all - re-read the document and record the member",
      ),
    );
  for (const kind of recorded.filter((entry) => !mounted.includes(entry)))
    findings.push(
      finding(
        "declared_deleted_transcription_drift",
        kind,
        `${TRANSCRIPTION_PATH} lists \`${kind}\`, which ${DOC_PATH} no longer declares a not-fact; a transcription ` +
          "that outlives its authority keeps a kind in the population nobody is counting anymore",
      ),
    );
  return { mounted, recorded };
}

// ---------------------------------------------------------------------------------------------------------------
// The code half
// ---------------------------------------------------------------------------------------------------------------

/**
 * What the pump's own tables classify as progress, and whether the classification still reads them.
 *
 * The consequence table is BUILT by code, so it is read where it is assigned: a table the builder stops reading is a
 * table whose members silently become `decision` (the builder's default for an unknown shape is a turn), so the
 * assignment itself is the assertion.
 */
function readCodeAuthority() {
  const path = join(ROOT, EVENT_PUMP);
  if (!existsSync(path)) blocked(`${EVENT_PUMP} does not exist`);
  const text = readFileSync(path, "utf8");
  const held = readTable(text, "HELD_RECEIPT_PROGRESS_STATES");
  const inFlight = readTable(text, "IN_FLIGHT_RECEIPT_PROGRESS_STATES");
  const heldKinds = readTable(text, "HELD_SEMANTIC_PROGRESS_KINDS");
  const settled = readTable(text, "SETTLED_PROGRAM_OUTCOMES");
  if (held.length + inFlight.length + heldKinds.length === 0)
    blocked(`${EVENT_PUMP} declares no progress-only table this gate can read`);

  const builder = builderBody(text);
  const assignments = [
    { name: "HELD_RECEIPT_PROGRESS_STATES", consequence: "progress", table: "receipt" },
    { name: "IN_FLIGHT_RECEIPT_PROGRESS_STATES", consequence: "in_flight_progress", table: "receipt" },
    { name: "HELD_SEMANTIC_PROGRESS_KINDS", consequence: "progress", table: "semantic" },
    { name: "SETTLED_PROGRAM_OUTCOMES", consequence: "decision", table: "settled" },
  ];
  for (const entry of assignments) {
    const pattern = new RegExp(`Object\\.keys\\(${entry.name}\\)[\\s\\S]{0,160}?=\\s*"${entry.consequence}"`, "u");
    if (!pattern.test(builder))
      findings.push(
        finding(
          "fact_turn_consequence_stops_reading",
          entry.name,
          `${EVENT_PUMP} classifies facts by its own tables and no longer assigns \`${entry.consequence}\` from ` +
            `${entry.name} inside \`buildFactTurnConsequence\`, so every member of that table falls to the builder's ` +
            "default - a turn - and the deletion this gate measures is no longer the product's own ruling",
        ),
      );
  }
  const snapshotProgress = /\bsnapshot:\s*"progress"/u.test(builder);
  if (!snapshotProgress)
    findings.push(
      finding(
        "fact_turn_consequence_stops_reading",
        "snapshot",
        `${EVENT_PUMP}'s classification no longer names \`snapshot\` as progress, so the one shape declared progress ` +
          "without a table is gone from the population with no word about where it went",
      ),
    );

  const members = [];
  for (const [state, site] of held)
    members.push({ kind: state, shape: `receipt:${state}`, consequence: "progress", site });
  for (const [state, site] of inFlight)
    members.push({ kind: state, shape: `receipt:${state}`, consequence: "in_flight_progress", site });
  for (const [kind, site] of heldKinds)
    members.push({ kind, shape: `semantic:${kind}`, consequence: "progress", site });
  members.push({ kind: "snapshot", shape: "snapshot", consequence: "progress", site: { file: EVENT_PUMP, line: 0 } });

  for (const [outcome, site] of settled)
    for (const member of members)
      if (member.kind === outcome)
        findings.push(
          finding(
            "declared_deleted_member_is_also_settled",
            outcome,
            `${site.file}:${site.line} declares \`${outcome}\` a settlement outcome - one call's whole answer - while ` +
              "the same name is a progress-only member, so the answer and the trace it settles are one kind",
          ),
        );

  const nonTerminal = readNonTerminalStates();
  if (nonTerminal.size > 0)
    for (const member of members)
      if (member.shape.startsWith("receipt:") && !nonTerminal.has(member.kind))
        findings.push(
          finding(
            "declared_deleted_state_the_producer_calls_terminal",
            member.kind,
            `${member.site.file}:${member.site.line} holds \`${member.kind}\` latest-only because it never opens a turn, ` +
              `and ${MODELS}'s \`IsTerminal\` calls that same state settled, so the Mod publishes it as an outcome and the ` +
              "pump throws all but the last one away (the round39 shape: a fact nobody was ever woken for)",
          ),
        );

  return { members, settled: new Set(settled.keys()) };
}

/**
 * The states the Mod's own `IsTerminal` says are NOT settled - the producer's answer to "is this an outcome", read
 * rather than restated. `Set` empty when the Mod states it in a shape this gate cannot read, and the caller then skips
 * the pairing rather than inventing one.
 */
function readNonTerminalStates() {
  const path = join(ROOT, MODELS);
  if (!existsSync(path)) return new Set();
  const expression = /state is not \(([^)]*)\)/u.exec(readFileSync(path, "utf8"));
  if (expression === null) return new Set();
  return new Set(
    [...expression[1].matchAll(/ExecutionState\.(\w+)/gu)].map((match) =>
      match[1].replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase(),
    ),
  );
}

/** The sentence a deletion marker ends, back to the previous full stop: the scope of what it declares. */
function declaringSentence(line, markerIndex) {
  const before = line.slice(0, markerIndex);
  const boundary = Math.max(...["。", "；", "！", "？"].map((stop) => before.lastIndexOf(stop)));
  return before.slice(boundary < 0 ? 0 : boundary + 1);
}

/** One `export const NAME ... = Object.freeze({ key: "why", ... })` table's keys, with the line each was read from. */
function readTable(text, name) {
  const at = text.indexOf(`export const ${name}`);
  if (at < 0) return new Map();
  const open = text.indexOf("{", at);
  const close = open < 0 ? -1 : matchingBrace(text, open);
  if (close < 0) return new Map();
  const rows = new Map();
  for (const match of text.slice(open, close).matchAll(/(?:^|\n)\s{2}([a-z0-9_]+):/gu))
    rows.set(match[1], { file: EVENT_PUMP, line: lineOf(text, at + match.index) });
  return rows;
}

/**
 * The `}` matching the `{` at `open`, so an EMPTY table (`Object.freeze({});`) closes on its own line.
 *
 * The first version searched for `\n});`, which skipped past `IN_FLIGHT_RECEIPT_PROGRESS_STATES = Object.freeze({});`
 * and closed over the next 2,200 characters - so `succeeded` and `refused`, the settlement outcomes, were read as held
 * receipt progress states and the gate reported four survivors where the run holds two.
 */
function matchingBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The body of `buildFactTurnConsequence`, where the consequence of every shape is assigned. */
function builderBody(text) {
  const at = text.indexOf("function buildFactTurnConsequence");
  if (at < 0) blocked(`${EVENT_PUMP} no longer builds the fact consequence table`);
  const end = text.indexOf("\n}", at);
  return text.slice(at, end < 0 ? text.length : end);
}

// ---------------------------------------------------------------------------------------------------------------
// The population
// ---------------------------------------------------------------------------------------------------------------

/** One member per kind, with the authorities that declare it and the consequence the pump gives its shape. */
function assemblePopulation(document, codeHalf, wireSchema) {
  const members = new Map();
  const add = (kind, declaredBy, site, shape, consequence) => {
    const entry = members.get(kind) ?? { kind, declaredBy: new Set(), shape, consequence, site };
    entry.declaredBy.add(declaredBy);
    if (site !== undefined && entry.site === undefined) entry.site = site;
    if (shape !== undefined) entry.shape = shape;
    if (consequence !== undefined) entry.consequence = consequence;
    members.set(kind, entry);
  };
  for (const [kind, site] of document.tokens) add(kind, "doc", site);
  for (const member of codeHalf.members) add(member.kind, "code", member.site, member.shape, member.consequence);
  for (const member of members.values()) {
    member.shape = member.shape ?? shapeOf(member.kind, wireSchema);
    member.consequence = member.consequence ?? codeConsequence(member.shape, wireSchema, codeHalf);
  }

  const agreed = [...members.values()].filter((member) => member.declaredBy.size === 2);
  const docOnly = [...members.values()].filter(
    (member) => member.declaredBy.size === 1 && member.declaredBy.has("doc"),
  );
  const codeOnly = [...members.values()].filter(
    (member) => member.declaredBy.size === 1 && member.declaredBy.has("code"),
  );

  // The contradiction: a kind the DOCUMENT declares deleted, whose shape the pump's classification can express, and that
  // the pump would let open a turn. Membership of a held table is NOT required - dropping the member from its table is
  // the drift itself, because the builder's default for an unlisted shape is `decision`, so the deleted kind comes back
  // without anyone writing it down. That is what the `authority/` fixture injects (`body_idle` removed from the held
  // semantic kinds), and it is the regression this check exists for.
  for (const member of members.values()) {
    if (!member.declaredBy.has("doc")) continue;
    if (member.consequence === undefined) continue;
    if (member.consequence === "progress" || member.consequence === "in_flight_progress") continue;
    findings.push(
      finding(
        "declared_deleted_doc_and_code_disagree",
        member.kind,
        `the document declares \`${member.kind}\` a not-fact and ${EVENT_PUMP} classifies \`${member.shape}\` as ` +
          `\`${member.consequence}\`, so a fact of a deleted kind can open a turn - one claim, two authorities, and ` +
          (member.declaredBy.has("code")
            ? "they part ways"
            : "the code half has stopped naming it at all, which is how a deletion is undone in silence"),
      ),
    );
  }
  // The mirror: a shape the document's FACT column names must not be held as progress.
  for (const shape of document.factShapes.keys()) {
    const consequence = codeConsequence(shape, wireSchema, codeHalf);
    if (consequence !== "progress" && consequence !== "in_flight_progress") continue;
    findings.push(
      finding(
        "declared_deleted_doc_and_code_disagree",
        shape,
        `the document's fact column names \`${shape}\` news and ${EVENT_PUMP} files it as \`${consequence}\`, so the ` +
          "one thing the model must be woken for is a trace held latest-only",
      ),
    );
  }

  if (members.size === 0)
    blocked("neither the document nor the pump's tables named a deleted kind this gate can count");

  return {
    members: [...members.values()].sort((left, right) => left.kind.localeCompare(right.kind)),
    agreed: agreed.length,
    docOnly,
    codeOnly,
  };
}

/**
 * How the pump spells a kind as a shape, derived from the wire's own unions: `receipt:<state>` for a receipt state,
 * `semantic:<kind>` for a semantic or body-trace kind, and nothing at all for a name no union carries - `tile_advanced`
 * and `tool_equipped` are transition reasons and reason codes, which no consequence table has a shape for.
 */
function shapeOf(kind, wireSchema) {
  if (kind === "snapshot") return "snapshot";
  if (wireSchema === null) return undefined;
  if (wireSchema.states.has(kind)) return `receipt:${kind}`;
  if (wireSchema.kinds.has(kind)) return `semantic:${kind}`;
  return undefined;
}

/**
 * The consequence the pump gives a shape: the held table's answer when the shape is a member, and otherwise the builder's
 * DEFAULT for a shape it can express. A shape no union carries is `undefined` - the code says nothing about it, which is
 * not the same answer as "it may open a turn".
 */
function codeConsequence(shape, wireSchema, codeHalf) {
  if (shape === undefined || wireSchema === null) return undefined;
  const held = codeHalf?.members.find((member) => member.shape === shape);
  if (held !== undefined) return held.consequence;
  if (shape === "snapshot") {
    const snapshot = codeHalf?.members.find((member) => member.shape === "snapshot");
    return snapshot === undefined ? undefined : snapshot.consequence;
  }
  if (shape.startsWith("receipt:"))
    return wireSchema.states.has(shape.slice("receipt:".length)) ? "decision" : undefined;
  if (shape.startsWith("semantic:"))
    return wireSchema.kinds.has(shape.slice("semantic:".length)) ? "decision" : undefined;
  if (shape.startsWith("settled:")) return "decision";
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------------------------------------------

function readLog(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) blocked(`the log ${path} does not exist`);
  const text = readFileSync(absolute, "utf8");
  const lines = text.split(/\r?\n/u);
  const facts = [];
  const unreadable = [];
  let mentions = 0;
  for (const [index, line] of lines.entries()) {
    if (line.includes("GAME_TURN_ACCOUNT ") || line.includes("BRIDGE_DIAGNOSTIC ")) mentions += 1;
    const at = line.indexOf("BRIDGE_FACT ");
    if (at < 0) continue;
    const rest = line.slice(at + "BRIDGE_FACT ".length);
    const brace = rest.indexOf("{");
    try {
      facts.push({ line: index + 1, fact: JSON.parse(brace < 0 ? rest : rest.slice(brace)) });
    } catch {
      unreadable.push(index + 1);
    }
  }
  if (facts.length === 0)
    blocked(
      `${path} holds no BRIDGE_FACT line this gate can parse, so it is not a run to measure (${unreadable.length} unreadable)`,
    );
  return { path, absolute, lines: lines.length, facts, unreadable, mentions };
}

/** Every kind value one fact carries, and the field it arrived in. */
function kindValues(fact) {
  const values = new Map();
  const take = (source, field) => {
    const value = source?.[field];
    if (typeof value !== "string") return;
    if (!values.has(value)) values.set(value, []);
    const positions = values.get(value);
    if (!positions.includes(field)) positions.push(field);
  };
  for (const field of KIND_FIELDS) take(fact, field);
  for (const field of PAYLOAD_FIELDS) take(fact?.worldFactPayload, field);
  return values;
}

/** The survivor reading: one count per declared-deleted kind, counted once per fact, by value. */
function measure(log, members, wireSchema) {
  const counts = new Map();
  const positions = new Map();
  const reasons = new Map();
  for (const { fact } of log.facts) {
    const values = kindValues(fact);
    for (const member of members) {
      if (!values.has(member.kind)) continue;
      counts.set(member.kind, (counts.get(member.kind) ?? 0) + 1);
      const seen = positions.get(member.kind) ?? new Set();
      for (const position of values.get(member.kind)) seen.add(position);
      positions.set(member.kind, seen);
      if (member.shape?.startsWith("receipt:")) {
        const code = fact?.worldFactPayload?.reasonCode ?? fact?.reasonCode;
        if (typeof code === "string" && code !== member.kind) {
          const tally = reasons.get(member.kind) ?? new Map();
          tally.set(code, (tally.get(code) ?? 0) + 1);
          reasons.set(member.kind, tally);
        }
      }
    }
  }
  const observability = new Map();
  for (const member of members) {
    const writeable =
      member.shape === undefined ||
      member.shape.startsWith("receipt:") ||
      member.shape.startsWith("semantic:") ||
      wireSchema?.eventKindValues?.has(member.kind) === true;
    observability.set(member.kind, writeable ? "observable" : "unobservable-in-this-log");
  }
  return { log, counts, positions, reasons, observability };
}

// ---------------------------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------------------------

function decide({ reading: measured, population: members }) {
  const expectation = option("--expect");
  if (measured === null) {
    process.stdout.write(
      `declared_deleted_facts_log_skipped: no run log found under ${option("--log-dir") ?? "tools/, .live-runs/"} - ` +
        "this is a POST-RUN gate, so a checkout with no run has nothing to measure. Point it at one with `--log <path>`\n",
    );
    process.stdout.write(
      `${GATE_ID}: not measured · declared-deleted kinds examined ${members.members.length} · log none\n`,
    );
    return {
      exitCode: findings.length === 0 ? 0 : 1,
      survivors: [],
      gone: [],
      population: members,
      measured: null,
      expectation: undefined,
    };
  }

  const survivors = members.members
    .filter((member) => (measured.counts.get(member.kind) ?? 0) > 0)
    .map((member) => ({ ...member, count: measured.counts.get(member.kind) }));
  const gone = members.members.filter((member) => (measured.counts.get(member.kind) ?? 0) === 0);
  let mismatch = null;
  if (expectation !== null) mismatch = compareExpectation(expectation, survivors, members);

  // A pin is not a verdict: `--expect` says "this committed log is the real history and it holds exactly these", so the
  // survivors it names are the EXPECTED reading of that log rather than a finding about today's code. Any other finding
  // (the authorities disagreeing, a transcription that drifted) still fails the run.
  if (expectation === null)
    for (const survivor of survivors)
      findings.push(
        finding(
          "declared_deleted_fact_still_produced",
          survivor.kind,
          `${survivor.kind} · ${survivor.count} · ${emitterOf(survivor)} (${[...(measured.positions.get(survivor.kind) ?? [])].join("+") || "value"})` +
            reasonsSuffix(measured.reasons.get(survivor.kind)),
        ),
      );

  const exitCode = findings.length > 0 || mismatch !== null ? 1 : 0;
  return {
    exitCode,
    survivors,
    gone,
    population: members,
    measured,
    expectation: expectation === null ? undefined : mismatch,
  };
}

/** The CI form: the reading of a committed log pinned to the members and counts it is known to hold. */
function compareExpectation(text, survivors, members) {
  const wanted = new Map();
  for (const pair of text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")) {
    const [kind, count] = pair.split("=");
    wanted.set(kind, Number(count));
  }
  const actual = new Map(survivors.map((survivor) => [survivor.kind, survivor.count]));
  const wrong = [];
  for (const [kind, count] of wanted) {
    const declared = members.members.some((member) => member.kind === kind);
    if (!declared)
      wrong.push(`\`${kind}\` is not a declared-deleted kind any authority names, so this pin cannot hold`);
    else if ((actual.get(kind) ?? 0) !== count)
      wrong.push(`\`${kind}\` was pinned at ${count} and the log holds ${actual.get(kind) ?? 0}`);
  }
  for (const [kind, count] of actual)
    if (!wanted.has(kind)) wrong.push(`\`${kind}\` was not pinned and the log holds ${count}`);
  return wrong.length === 0 ? null : wrong;
}

function emitterOf(member) {
  if (member.shape?.startsWith("receipt:") && seam !== null) return `${seam.file}:${seam.line} (the publish seam)`;
  const site = literalSite(member.kind);
  return site === null ? "unresolved" : `${site.file}:${site.line}`;
}

function reasonsSuffix(tally) {
  if (tally === undefined || tally.size === 0) return "";
  const named = [...tally.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason, count]) => `${reason} ${count}`);
  return ` · reasonCodes ${named.join(", ")}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Production sites
// ---------------------------------------------------------------------------------------------------------------

/** The single point where a receipt leaves the Mod for the fact stream: the only way a state reaches a log. */
function readReceiptPublishSeam() {
  for (const file of walk(MOD_ROOT, (name) => name.endsWith(".cs"))) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const at = text.indexOf("receiptPublished?.Invoke(");
    if (at >= 0) return { file, line: lineOf(text, at) };
  }
  return null;
}

/** The first production site that spells the kind as its own string literal, across the Mod and the Host. */
function literalSite(kind) {
  const needle = `"${kind}"`;
  const files = [
    ...walk(MOD_ROOT, (name) => name.endsWith(".cs")),
    ...walk(HOST_ROOT, (name) => name.endsWith(".ts") && !isTest(name)),
  ];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const at = text.indexOf(needle);
    if (at >= 0) return { file, line: lineOf(text, at) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------------------------

function readWire() {
  // The wire's unions are the VOCABULARY, not the fixture: a tree that changes only the pump (the `authority/` fixture)
  // still has to be read against the protocol's own spelling of a shape, so the checkout's wire is the fallback.
  const local = join(ROOT, WIRE);
  const path = existsSync(local) ? local : join(moduleRoot(), WIRE);
  if (!existsSync(path)) return null;
  const schema = JSON.parse(readFileSync(path, "utf8"));
  const definitions = schema.$defs ?? {};
  const kinds = new Set([
    ...(definitions.semanticEvent?.properties?.kind?.enum ?? []),
    ...(definitions.bodyTrace?.properties?.category?.enum ?? []),
  ]);
  const states = new Set(definitions.executionState?.enum ?? []);
  const worldKinds = new Set(definitions.worldFact?.properties?.kind?.enum ?? []);
  return { states, kinds, eventKindValues: new Set([...states, ...kinds, ...worldKinds]) };
}

/** The newest run log the repository holds, or null: the caller then says it looked and found nothing. */
function newestRunLog(directory) {
  const roots = directory === null ? [join(ROOT, "tools"), join(ROOT, ".live-runs")] : [resolve(directory)];
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && /(?:live-runner|live-run)\.log$/u.test(entry.name)) candidates.push(join(root, entry.name));
      if (!entry.isDirectory() || ["node_modules", "fixtures", "dist", "bin", "obj"].includes(entry.name)) continue;
      for (const nested of readdirSync(join(root, entry.name), { withFileTypes: true }))
        if (nested.isFile() && /(?:live-runner|live-run)\.log$/u.test(nested.name))
          candidates.push(join(root, entry.name, nested.name));
    }
  }
  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function walk(relativeRoot, accept) {
  const root = join(ROOT, relativeRoot);
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relativePath = path.slice(ROOT.length + 1).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (["tests", "bin", "obj", "node_modules", "dist", "dist-test", "fixtures"].includes(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      out.push(...walk(relativePath, accept));
      continue;
    }
    if (accept(entry.name)) out.push(relativePath);
  }
  return out.sort();
}

function isTest(name) {
  return /\.test\./u.test(name);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function transcriptionPath() {
  return join(ROOT, TRANSCRIPTION_PATH);
}

function option(name) {
  const index = argv.indexOf(name);
  return index < 0 || index + 1 >= argv.length ? null : argv[index + 1];
}

function finding(code, id, detail) {
  return { code, id, detail };
}

function blocked(reason) {
  process.stderr.write(`declared_deleted_facts_blocked: ${reason}\n`);
  process.stdout.write(`${JSON.stringify({ gate: GATE_ID, population: 0, blocked: reason, verdict: "blocked" })}\n`);
  process.exit(2);
}

function repositoryRoot() {
  let directory = gateRoot();
  while (!existsSync(join(directory, "protocol/bridge-v1.schema.json")) && directory !== dirname(directory))
    directory = dirname(directory);
  return directory;
}

/** The checkout THIS FILE belongs to: the shipped transcription is read from here even when `--root` names a fixture. */
function moduleRoot() {
  let directory = gateRoot();
  while (!existsSync(join(directory, "package.json")) && directory !== dirname(directory))
    directory = dirname(directory);
  return directory;
}

/** Where THIS FILE lives: the shipped fixtures and the transcription are read from here, never from a fixture tree. */
function gateRoot() {
  return dirname(fileURLToPath(import.meta.url));
}

function report(verdict) {
  const population = verdict.population;
  process.stdout.write(
    `declared-deleted facts: kinds examined ${population.members.length} · declared-by-doc ${count(population, "doc")} · ` +
      `declared-by-code ${count(population, "code")} · agreed ${population.agreed} · ` +
      `doc-only ${population.docOnly.length} · code-only ${population.codeOnly.length}`,
  );
  if (population.docOnly.length > 0)
    process.stdout.write(` (doc-only: ${population.docOnly.map((member) => member.kind).join(", ")})`);
  if (population.codeOnly.length > 0)
    process.stdout.write(` (code-only: ${population.codeOnly.map((member) => member.kind).join(", ")})`);
  process.stdout.write("\n");
  process.stdout.write(
    `declared-deleted facts: document ${doc.mounted ? doc.source : `${doc.source} (not mounted; transcription ${doc.transcription.measured})`}\n`,
  );
  if (verdict.measured !== null) {
    const log = verdict.measured.log;
    process.stdout.write(
      `declared-deleted facts: log ${log.path} · ${log.lines} lines · ${log.facts.length} fact lines · ` +
        `${log.mentions} account/diagnostic lines carry MENTIONS that are not counted` +
        `${log.unreadable.length === 0 ? "" : ` · ${log.unreadable.length} unreadable: ${log.unreadable.join(",")}`}\n`,
    );
  }
  process.stdout.write(
    `declared-deleted kinds examined ${population.members.length} · gone ${verdict.gone.length} · ` +
      `still produced ${verdict.survivors.length}` +
      `${verdict.expectation === undefined ? "" : " (this log's reading, pinned by --expect)"}` +
      `${verdict.measured === null ? " (nothing measured: no log)" : ""}\n`,
  );
  if (verdict.measured === null)
    process.stdout.write(
      "declared-deleted facts: no log was read, so no kind was counted as gone - the skip marker above is the reading\n",
    );
  if (verdict.expectation !== undefined)
    for (const survivor of verdict.survivors)
      process.stdout.write(
        `declared-deleted fact pinned: ${survivor.kind} · ${survivor.count} · ${[...(verdict.measured?.positions.get(survivor.kind) ?? [])].join("+")}` +
          `${reasonsSuffix(verdict.measured?.reasons.get(survivor.kind))}\n`,
      );
  if (verdict.measured !== null) {
    const ceilings = verdict.gone.filter((member) => verdict.measured.observability.get(member.kind) !== "observable");
    if (ceilings.length > 0)
      process.stdout.write(
        `declared-deleted facts: ceiling reading for ${ceilings.map((member) => member.kind).join(", ")} - this log ` +
          "format does not write those shapes, so zero is a ceiling here and not a measurement of the producer\n",
      );
  }
  if (verdict.expectation !== null && verdict.expectation !== undefined)
    findings.push(finding("declared_deleted_expectation_mismatch", "expect", verdict.expectation.join("; ")));
  for (const entry of findings) process.stderr.write(`✖ ${entry.code}:${entry.id} - ${entry.detail}\n`);
  process.stdout.write(
    `${GATE_ID}: ${verdict.exitCode === 0 ? (verdict.measured === null ? "not measured" : "passed") : "failed"} · ` +
      `findings ${findings.length} · examined ${population.members.length}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      gate: GATE_ID,
      population: population.members.length,
      doc: count(population, "doc"),
      code: count(population, "code"),
      log: verdict.measured?.log.path ?? null,
      facts: verdict.measured?.log.facts.length ?? 0,
      gone: verdict.gone.length,
      survivors: verdict.survivors.map((survivor) => ({ kind: survivor.kind, count: survivor.count })),
      verdict: verdict.exitCode === 0 ? (verdict.measured === null ? "not_measured" : "passed") : "failed",
    })}\n`,
  );
}

function count(population, authority) {
  return population.members.filter((member) => member.declaredBy.has(authority)).length;
}
