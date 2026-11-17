#!/usr/bin/env node
/**
 * What is a FACT, and what is only the executor narrating itself?
 *
 * The authority is `design/fact-authority.md` (zhexulong/gamebuddy-docs): a fact is a change of the world or a
 * decision; the body's own trace is neither. This gate is that authority's enforcement, and it exists because round64
 * measured the cost of not having one: 401 facts of which 130 said "she moved one tile" and 130 more said it again in a
 * second spelling, so the pump assembled 134 batches and discarded 126 of them, and opened 8 turns.
 *
 * 「守恒的是事件；下降的是踪迹。把踪迹算进事实里，等于把洪水当成水位。」
 *
 * THE FIVE CHECKS, one gate, because they are five faces of one defect and fixing one without the others moves the
 * flood rather than removing it.
 *
 *   1 `progress_reported_as_a_fact:<kind>`
 *        population: every fact kind the Mod and the Host can emit - DERIVED, never listed: the wire's
 *        `semanticEvent.kind` union, the wire's `bodyTrace.category` union (which is the wire's own declaration that a
 *        kind is a trace of the body), the Mod's `transition(State, "<reason>")` call sites, and the Host's
 *        `*_SEMANTIC_KIND` constants.
 *        property: every emittable kind is an EVENT - a change of the world or a decision.
 *        print: `kinds examined N · events E · traces T · declared-once D`; N = E + T + D; `T > 0` fails, naming each
 *        kind and its emitter `file:line`.
 *
 *   2 `settlement_is_one_answer_with_a_bounded_evidence:<program>`
 *        population: every settlement the Host can mint (derived: every `*_SEMANTIC_KIND` whose value is a settlement).
 *        property: ONE answer per program - an exactly-once claim, a bounded row list, a COUNTED remainder, and the
 *        `ok`/`reason` shape a tool result has.
 *        print: `programs examined N · one-answer A · bounded B · shaped S · dribbled D`; `D > 0` fails.
 *
 *   3 `fact_flushed_then_discarded:<suppressor>`
 *        population: every fact kind the Mod can emit, against the Host's IN-FLIGHT suppressor tables (the facts it
 *        discards because a program is in flight).
 *        property: "a program is in flight" is a judgement about TURNS, never a suppressor of a fact. A fact that can
 *        never open a turn must not become a pending batch at all.
 *        print: `kinds examined N · suppressed S`; `S > 0` fails, naming the kind, the table and its `file:line`.
 *
 *   4 `delivered_text_never_arrived:<reason>`
 *        population: every population the turn-delivery account publishes (`NATIVE_COMPANION_TURN_DELIVERY`).
 *        property: each counted population is paired with a REASON-KEYED account of what did not arrive.
 *        print: `populations examined N · named-absent A · unnamed U`; `U > 0` fails.
 *
 *   5 `progress_kinds_declared_only_in_a_test:<kind>`
 *        population: every progress concept declared in this tree (`*PROGRESS*` set declarations).
 *        property: a production concept is declared in production code, not only inside a test file.
 *        print: `concepts examined N · in-production P · test-only T`; `T > 0` fails, naming `file:line`.
 *
 * ZERO POPULATION IS BLOCKED, NEVER GREEN. A derivation that finds no wire union and no transition call site agrees
 * with itself over a source tree it never opened, so an empty population prints `fact_authority_no_population: <what
 * could not be derived>` and exits 2.
 *
 * Usage:
 *   node tools/check-fact-authority.mjs                # the verdict; exit 1 on any finding
 *   node tools/check-fact-authority.mjs --json         # the whole reading, findings included
 *   node tools/check-fact-authority.mjs --root <dir>   # the gate's own fixture tree
 *
 * red-proof: inject  a `this.transition(ExecutionState.MeaningfulProgress, "tile_advanced", ...)` call into a fixture
 *            Mod tree and a `route_progress` member into the fixture wire's `bodyTrace` union ->
 *            `progress_reported_as_a_fact:tile_advanced` names `StardewBodyController.cs:<line>` and
 *            `progress_reported_as_a_fact:route_progress` names the body-trace arm; the same fixture without them is
 *            green (`tools/check-fact-authority.test.mjs`). The other four are falsified the same way, each on a
 *            synthetically defective tree that differs from the good one by exactly one defect.
 */

export const gateDeclaration = {
  id: "check-fact-authority",
  domain: "product",
  tier: "l1",
  kind: "contract",
};

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GATE_ID = "fact-authority";
const WIRE_PATH = "protocol/bridge-v1.schema.json";
const MOD_ROOT = "integrations/stardew";
const EXECUTION_MANAGER = `${MOD_ROOT}/farmhandexecutioncontroller.cs`;
const EXECUTION_STATES = `${MOD_ROOT}/src/Core/Models/BridgeProtocolModels.cs`;
const EVENT_PUMP = "host/src/event-pump.ts";
const COMPANION_LOOP = "host/src/companion-loop.ts";
const ROOT = resolve(
  process.argv.includes("--root") ? (process.argv[process.argv.indexOf("--root") + 1] ?? ".") : repositoryRoot(),
);

const findings = [];
const report = { gate: GATE_ID, population: 0, checks: {} };

// ---------------------------------------------------------------------------------------------------------------
// Check 1 · progress_reported_as_a_fact
// ---------------------------------------------------------------------------------------------------------------
const wire = readWire();
const mod = readModEmitters();
const host = readHostKinds();

const traceByBodyUnion = new Map();
for (const kind of wire.bodyTraceKinds) {
  const emitter = mod.categoryArms.get(kind) ?? mod.bodyIdleSite(kind);
  if (emitter !== undefined) traceByBodyUnion.set(kind, `${emitter.file}:${emitter.line}`);
}

const traceByTransition = new Map();
for (const site of mod.transitions) {
  if (mod.nonTerminalStates.has(site.state)) traceByTransition.set(site.reason, site);
}

const population = unionSorted([
  ...wire.eventKinds,
  ...mod.transitions.map((site) => site.reason),
  ...host.mintedKinds,
]);

const events = [];
const traces = [];
const declaredOnce = [];
for (const kind of population) {
  const bodySite = traceByBodyUnion.get(kind);
  if (bodySite !== undefined) {
    traces.push(
      finding("progress_reported_as_a_fact", kind, `${bodySite} publishes \`${kind}\`, which the wire itself files under ` +
        "`$defs/bodyTrace` - a trace of the body, not a change of the world. The receipt for the same execution is the answer."),
    );
    continue;
  }
  const transitionSite = traceByTransition.get(kind);
  if (transitionSite !== undefined) {
    traces.push(
      finding("progress_reported_as_a_fact", kind, `${transitionSite.file}:${transitionSite.line} emits \`${kind}\` on a ` +
        `non-terminal state (${transitionSite.state}) - the body is still going, and that is body state, not news. ` +
        "Walking belongs in the settlement's evidence or in the next snapshot, never in the fact stream."),
    );
    continue;
  }
  if (!isEmitted(kind)) declaredOnce.push(kind);
  else events.push(kind);
}

// `declared-once` is a READING, not a pass with the door open on the defect: a kind the wire declares and nothing
// produces is a spelling waiting to be emitted again, and the moment a producer returns it lands in `traces` above.
const checkOne = {
  examined: population.length,
  events: events.length,
  traces: traces.length,
  declaredOnce: declaredOnce.length,
};
report.checks.progress_reported_as_a_fact = {
  ...checkOne,
  traceKinds: traces.map((entry) => entry.id),
  declaredOnceKinds: declaredOnce,
};
if (population.length === 0)
  blocked("the wire's event unions and the Mod's transition call sites both derived nothing");
if (checkOne.traces > 0) findings.push(...traces);

// ---------------------------------------------------------------------------------------------------------------
// Check 2 · settlement_is_one_answer_with_a_bounded_evidence
// ---------------------------------------------------------------------------------------------------------------
const settlements = readSettlements();
const settlementReadings = [];
for (const settlement of settlements) {
  const oneAnswer = settlement.claimsOnce;
  const bounded = settlement.hasBound && settlement.hasCountedRemainder;
  const shaped = settlement.hasOk && settlement.hasReason;
  settlementReadings.push({ ...settlement, oneAnswer, bounded, shaped });
  if (oneAnswer && bounded && shaped) continue;
  const failures = [
    oneAnswer ? null : "no exactly-once claim keyed by program id, so a second read answers twice",
    settlement.hasBound
      ? null
      : `the row list is not bounded by a named constant${settlementOverflow(settlement)}`,
    settlement.hasCountedRemainder
      ? null
      : `what did not fit is not COUNTED (\`omitted\`), so a long plan reads as a complete one${settlementOverflow(settlement)}`,
    shaped ? null : "the answer carries no `ok`/`reason`, so it is not the shape of a tool result",
  ].filter((entry) => entry !== null);
  findings.push(
    finding(
      "settlement_is_one_answer_with_a_bounded_evidence",
      settlement.programId,
      `${settlement.file}:${settlement.line} mints \`${settlement.kind}\` and ${failures.join("; ")}`,
    ),
  );
}
const checkTwo = {
  examined: settlementReadings.length,
  oneAnswer: settlementReadings.filter((entry) => entry.oneAnswer).length,
  bounded: settlementReadings.filter((entry) => entry.bounded).length,
  shaped: settlementReadings.filter((entry) => entry.shaped).length,
  dribbled: settlementReadings.filter((entry) => !(entry.oneAnswer && entry.bounded && entry.shaped)).length,
};
report.checks.settlement_is_one_answer_with_a_bounded_evidence = checkTwo;
if (checkTwo.examined === 0) blocked("no settlement projection was found in host/src");

// ---------------------------------------------------------------------------------------------------------------
// Check 3 · fact_flushed_then_discarded
// ---------------------------------------------------------------------------------------------------------------
const suppressors = readInFlightSuppressors();
const suppressed = [];
for (const table of suppressors.tables) {
  for (const kind of table.kinds) {
    if (!isModFactKind(kind)) continue;
    suppressed.push(
      finding(
        "fact_flushed_then_discarded",
        kind,
        `${table.file}:${table.line} lists \`${kind}\` in ${table.name}, so this fact becomes a pending batch and is then ` +
          "discarded because a program is in flight. 「有程序在飞」是对轮次的判断，不是一条事实的 suppressor - " +
          "a fact that can never open a turn must never become a batch.",
      ),
    );
  }
}
const checkThree = { examined: population.length, suppressed: suppressed.length };
report.checks.fact_flushed_then_discarded = checkThree;
if (suppressors.tables.length === 0) blocked(`${EVENT_PUMP} declares no in-flight suppressor table`);
if (checkThree.suppressed > 0) findings.push(...suppressed);

// ---------------------------------------------------------------------------------------------------------------
// Check 4 · delivered_text_never_arrived
// ---------------------------------------------------------------------------------------------------------------
const delivery = readDeliveryAccount();
const unnamed = [];
for (const counted of delivery.counted) {
  if (counted.hasReasonAccount) continue;
  unnamed.push(
    finding(
      "delivered_text_never_arrived",
      counted.name,
      `${delivery.file}:${delivery.line} publishes \`${counted.name}\` with no reason-keyed account of what did not ` +
        "arrive beside it, so a withheld piece is indistinguishable from a piece that never existed.",
    ),
  );
}
const checkFour = {
  examined: delivery.counted.length,
  named: delivery.counted.filter((entry) => entry.hasReasonAccount).length,
  unnamed: unnamed.length,
};
report.checks.delivered_text_never_arrived = checkFour;
if (delivery.counted.length === 0) blocked(`${COMPANION_LOOP} publishes no turn-delivery account this gate can read`);
if (checkFour.unnamed > 0) findings.push(...unnamed);

// ---------------------------------------------------------------------------------------------------------------
// Check 5 · progress_kinds_declared_only_in_a_test
// ---------------------------------------------------------------------------------------------------------------
const progressConcepts = readProgressConcepts();
const testOnly = [];
for (const concept of progressConcepts) {
  if (concept.production.length > 0) continue;
  testOnly.push(
    finding(
      "progress_kinds_declared_only_in_a_test",
      concept.name,
      `${concept.test[0].file}:${concept.test[0].line} is the only declaration of \`${concept.name}\` in this tree, so ` +
        "the production notion of \"progress\" exists nowhere the product can read it - a concept a test owns is a " +
        "concept production cannot enforce.",
    ),
  );
}
const checkFive = {
  examined: progressConcepts.length,
  inProduction: progressConcepts.filter((entry) => entry.production.length > 0).length,
  testOnly: testOnly.length,
};
report.checks.progress_kinds_declared_only_in_a_test = checkFive;
if (progressConcepts.length === 0) blocked("no progress concept could be derived from the tree");
if (checkFive.testOnly > 0) findings.push(...testOnly);

// ---------------------------------------------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------------------------------------------
report.population = checkOne.examined;
render();
report.findings = findings.map((entry) => ({ code: entry.code, id: entry.id, detail: entry.detail }));
report.verdict = findings.length === 0 ? "passed" : "failed";
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(findings.length === 0 ? 0 : 1);

// ---------------------------------------------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------------------------------------------

/** The wire's own unions. This is the authority for which kinds exist, not a list in this file. */
function readWire() {
  const path = join(ROOT, WIRE_PATH);
  if (!existsSync(path)) blocked(`${WIRE_PATH} does not exist`);
  const schema = JSON.parse(readFileSync(path, "utf8"));
  const definitions = schema.$defs ?? {};
  const eventKinds = definitions.semanticEvent?.properties?.kind?.enum ?? [];
  const bodyTraceKinds = definitions.bodyTrace?.properties?.category?.enum ?? [];
  const receiptStates = definitions.executionState?.enum ?? [];
  if (eventKinds.length === 0) blocked(`${WIRE_PATH} declares no semanticEvent.kind union`);
  if (bodyTraceKinds.length === 0) blocked(`${WIRE_PATH} declares no bodyTrace.category union`);
  return { eventKinds, bodyTraceKinds, receiptStates };
}

/**
 * Every place the Mod says something about itself or an execution.
 *
 * `transitions` are the `this.transition(State, "reason", ...)` call sites: the body controller's own vocabulary, which
 * is where the per-tile flood is born. `categoryArms` are the receipt-state-to-body-trace map in the execution manager,
 * which is the SECOND spelling of the same statement. `nonTerminalStates` is read from the Mod's own `IsTerminal`, so
 * "still running" is the producer's answer and not a second copy of it here.
 */
function readModEmitters() {
  const files = walkProductionFiles(MOD_ROOT, (name) => name.endsWith(".cs"));
  const transitions = [];
  const categoryArms = new Map();
  let idleSite = null;
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(/\.transition\(\s*ExecutionState\.(\w+)\s*,\s*"([a-z0-9_]+)"/gu))
      transitions.push({ state: match[1], reason: match[2], file, line: lineOf(text, match.index) });
    for (const match of text.matchAll(/AddPublicTrace\(\s*"([a-z0-9_]+)"/gu))
      if (idleSite === null) idleSite = { file, line: lineOf(text, match.index) };
  }
  const managerPath = join(ROOT, EXECUTION_MANAGER);
  if (existsSync(managerPath)) {
    const text = readFileSync(managerPath, "utf8");
    const switchAt = text.indexOf("string? category = receipt.State switch");
    if (switchAt >= 0) {
      const block = text.slice(switchAt, text.indexOf("};", switchAt));
      for (const match of block.matchAll(/ExecutionState\.(\w+)\s*=>\s*"([a-z0-9_]+)"/gu))
        categoryArms.set(match[2], { file: EXECUTION_MANAGER, line: lineOf(text, switchAt + match.index) });
    }
  }
  return {
    transitions,
    categoryArms,
    nonTerminalStates: readNonTerminalStates(),
    bodyIdleSite: (kind) => (kind === "body_idle" && idleSite !== null ? idleSite : undefined),
  };
}

/**
 * The states the Mod's own `IsTerminal` says are NOT settled - `Accepted`, `Running`, `MeaningfulProgress`.
 *
 * Read from `BridgeProtocolModels.cs` rather than restated, because a second copy of this set is a disagreement
 * scheduled for the day one of them changes.
 */
function readNonTerminalStates() {
  const path = join(ROOT, EXECUTION_STATES);
  if (!existsSync(path)) blocked(`${EXECUTION_STATES} does not exist`);
  const text = readFileSync(path, "utf8");
  const expression = /state is not \(([^)]*)\)/u.exec(text);
  if (expression === null) blocked(`${EXECUTION_STATES} no longer states which states are terminal`);
  const names = [...expression[1].matchAll(/ExecutionState\.(\w+)/gu)].map((match) => match[1]);
  if (names.length === 0) blocked(`${EXECUTION_STATES} names no non-terminal state`);
  return new Set(names);
}

/** The kinds the Host mints itself: constants named `*_SEMANTIC_KIND`, which is how a Host fact is spelled. */
function readHostKinds() {
  const files = walkProductionFiles("host/src", (name) => name.endsWith(".ts") && !name.includes(".test."));
  const mintedKinds = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(/_SEMANTIC_KIND\s*=\s*"([a-z0-9_]+)"/gu)) mintedKinds.push(match[1]);
  }
  return { mintedKinds: [...new Set(mintedKinds)].sort() };
}

/**
 * Is this kind produced anywhere in this tree - by a transition, a body-trace arm, or a Host constant?
 *
 * A mere wire DECLARATION is not production: `$defs/semanticEvent.kind` says which kinds the protocol admits, and a
 * kind nothing emits is exactly the `declared-once` reading - one spelling, in the declaration, with no producer to
 * disagree with it.
 */
function isEmitted(kind) {
  return (
    mod.transitions.some((site) => site.reason === kind) ||
    mod.categoryArms.has(kind) ||
    host.mintedKinds.includes(kind)
  );
}

/** Was this kind something the MOD says about its own body? Check 3's population is the Mod's half, and only that. */
function isModFactKind(kind) {
  return (
    wire.eventKinds.includes(kind) ||
    wire.receiptStates.includes(kind) ||
    mod.transitions.some((site) => site.reason === kind) ||
    mod.categoryArms.has(kind)
  );
}

/**
 * Every settlement the Host can mint, and whether its answer has the shape of a tool result.
 *
 * The population is derived from the Host's own `*_SEMANTIC_KIND` constants: a kind whose value says it is a
 * settlement names a module that must answer once, with bounded and counted evidence, in `ok`/`reason` shape.
 */
function readSettlements() {
  const files = walkProductionFiles("host/src", (name) => name.endsWith(".ts") && !name.includes(".test."));
  const settlements = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(/_SEMANTIC_KIND\s*=\s*"([a-z0-9_]+settled[a-z0-9_]*)"/gu)) {
      const kind = match[1];
      const boundName = /slice\(0,\s*(MAX_[A-Z0-9_]+)\)/u.exec(text)?.[1];
      const boundValue = boundName === undefined ? null : readBoundValue(text, boundName);
      settlements.push({
        programId: kind,
        kind,
        file,
        line: lineOf(text, match.index),
        claimsOnce: /\w+\.has\(input\.programId\)\)\s*return undefined;/u.test(text),
        hasBound: boundName !== undefined,
        boundName: boundName ?? null,
        boundValue,
        hasCountedRemainder: /omitted:\s*[\w.]*length\s*-\s*\w+\.length/u.test(text),
        hasOk: /\bok:\s/u.test(text),
        hasReason: /\breason:\s/u.test(text),
      });
    }
  }
  return settlements;
}

/** The numeric value of a `const NAME = 12;` declaration, so a finding can state the arithmetic it is about. */
function readBoundValue(text, name) {
  const declared = new RegExp(`const ${name}\\s*=\\s*(\\d+)`, "u").exec(text);
  return declared === null ? null : Number(declared[1]);
}

/**
 * The Host's IN-FLIGHT suppressor tables: the facts it admits and then throws away because a program is running.
 *
 * Read as source because the question is what the table DECLARES - a runtime probe would only see the members today's
 * fixtures happen to exercise. The `HELD_*` tables are deliberately not read here: holding a kind to its latest value
 * is a different decision (and check 5 is where the notion of "progress" is judged).
 */
function readInFlightSuppressors() {
  const path = join(ROOT, EVENT_PUMP);
  if (!existsSync(path)) blocked(`${EVENT_PUMP} does not exist`);
  const text = readFileSync(path, "utf8");
  const tables = [];
  for (const name of ["IN_FLIGHT_RECEIPT_PROGRESS_STATES", "IN_FLIGHT_SEMANTIC_PROGRESS_KINDS"]) {
    const at = text.indexOf(`export const ${name}`);
    if (at < 0) continue;
    const end = text.indexOf("});", at);
    if (end < 0) continue;
    const block = text.slice(at, end);
    const kinds = [...block.matchAll(/(?:^|\n)\s{2}([a-z0-9_]+):/gu)].map((match) => match[1]);
    tables.push({ name, file: EVENT_PUMP, line: lineOf(text, at), kinds });
  }
  return { tables };
}

/**
 * The turn-delivery account, and which of its counted populations has a reason-keyed account of what did not arrive.
 *
 * `NATIVE_COMPANION_TURN_DELIVERY` publishes `textParts` and `bubbles`. Beside the parts there is `suppressed` keyed by
 * the projection's own reason; beside the bubbles there is nothing, so a bubble the surface withheld reads exactly like
 * a turn that spoke no line.
 */
function readDeliveryAccount() {
  const path = join(ROOT, COMPANION_LOOP);
  if (!existsSync(path)) blocked(`${COMPANION_LOOP} does not exist`);
  const text = readFileSync(path, "utf8");
  const at = text.indexOf("NATIVE_COMPANION_TURN_DELIVERY ${JSON.stringify(");
  if (at < 0) blocked(`${COMPANION_LOOP} no longer publishes a turn-delivery account`);
  const blockStart = text.indexOf("{", at);
  const block = text.slice(blockStart, text.indexOf("})}", blockStart));
  const reasonKeyed = /suppressed/u.test(block);
  const counted = [];
  for (const name of ["textParts", "bubbles"]) {
    if (!new RegExp(`(?:^|[\\s{,])${name}:`, "u").test(block)) continue;
    counted.push({
      name,
      hasReasonAccount: name === "textParts" ? reasonKeyed : /suppressedBubbles|bubblesSuppressed/u.test(block),
    });
  }
  return { file: COMPANION_LOOP, line: lineOf(text, at), counted };
}

/** Every `*PROGRESS*` set declaration in this tree, split by whether production code declares it. */
function readProgressConcepts() {
  const files = walkProductionFiles("host/src", (name) => /\.ts$|\.mts$/u.test(name));
  const concepts = new Map();
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(/(?:export\s+)?const\s+([A-Z0-9_]*PROGRESS[A-Z0-9_]*)\s*(?::[^=]*)?=/gu)) {
      const name = match[1];
      if (!concepts.has(name)) concepts.set(name, { name, production: [], test: [] });
      const entry = concepts.get(name);
      const site = { file, line: lineOf(text, match.index) };
      if (isTestFile(file)) entry.test.push(site);
      else entry.production.push(site);
    }
  }
  return [...concepts.values()].filter((entry) => entry.test.length > 0 || entry.production.length > 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------------------------

function walkProductionFiles(relativeRoot, accept, { recurse = true } = {}) {
  const root = join(ROOT, relativeRoot);
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relativePath = relative(ROOT, path).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (!recurse) continue;
      if (["tests", "bin", "obj", "node_modules", "dist", "dist-test", "fixtures"].includes(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      out.push(...walkProductionFiles(relativePath, accept));
      continue;
    }
    if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) continue;
    if (accept(entry.name)) out.push(relativePath);
  }
  return out.sort();
}

function isTestFile(file) {
  return /\.test\.(?:ts|mts|mjs)$|\.test-support\.(?:ts|mjs)$/u.test(file);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function unionSorted(values) {
  return [...new Set(values)].sort();
}

function finding(code, id, detail) {
  return { code, id, detail };
}

/**
 * The arithmetic of one settlement's evidence bound, in the terms a reader can check: sixty rows is an ordinary plan
 * (`MAX_BODY_PROGRAM_NODES` is 256), and the question is what the answer says about the ones that do not fit.
 *
 * The bound is the module's OWN constant, so this sentence is derived from the number the projection uses and cannot
 * drift from it.
 */
function settlementOverflow(settlement) {
  const rows = 60;
  if (settlement.boundValue === null || settlement.boundValue === undefined)
    return `: over ${rows} rows it prints all ${rows} and says nothing about a bound`;
  const shown = Math.min(rows, settlement.boundValue);
  return (
    `: over ${rows} rows it shows ${shown}` +
    (rows > shown ? ` and ${rows - shown} must be COUNTED (\`… ${rows} shown ${shown}\`), never dropped in silence` : "")
  );
}

function blocked(reason) {
  process.stdout.write(`fact_authority_no_population: ${reason}\n`);
  process.exit(2);
}

function render() {
  const lines = [];
  lines.push(
    `progress_reported_as_a_fact: kinds examined ${checkOne.examined} · events ${checkOne.events} · ` +
      `traces ${checkOne.traces} · declared-once ${checkOne.declaredOnce}`,
  );
  if (declaredOnce.length > 0)
    lines.push(`  declared-once (the wire declares them and nothing produces them): ${declaredOnce.join(", ")}`);
  lines.push(
    `settlement_is_one_answer_with_a_bounded_evidence: programs examined ${checkTwo.examined} · ` +
      `one-answer ${checkTwo.oneAnswer} · bounded ${checkTwo.bounded} · shaped ${checkTwo.shaped} · ` +
      `dribbled ${checkTwo.dribbled}`,
  );
  lines.push(
    `fact_flushed_then_discarded: kinds examined ${checkThree.examined} · suppressed ${checkThree.suppressed}`,
  );
  lines.push(
    `delivered_text_never_arrived: populations examined ${checkFour.examined} · named-absent ${checkFour.named} · ` +
      `unnamed ${checkFour.unnamed}`,
  );
  lines.push(
    `progress_kinds_declared_only_in_a_test: concepts examined ${checkFive.examined} · ` +
      `in-production ${checkFive.inProduction} · test-only ${checkFive.testOnly}`,
  );
  for (const entry of findings) {
    lines.push(`✖ ${entry.code}:${entry.id} - ${entry.detail}`);
    if (entry.code === "progress_reported_as_a_fact")
      lines.push("  「守恒的是事件；下降的是踪迹。把踪迹算进事实里，等于把洪水当成水位。」");
  }
  lines.push(
    `${GATE_ID}: ${findings.length === 0 ? "passed" : "failed"} · findings ${findings.length} · ` +
      `examined ${report.population}`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

function repositoryRoot() {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "protocol/bridge-v1.schema.json")) && directory !== dirname(directory))
    directory = dirname(directory);
  return directory;
}
