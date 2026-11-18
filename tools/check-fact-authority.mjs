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
 *   6 `a_trace_is_produced_as_its_own_fact:<kind>`
 *        population: the wire's `$defs/executionState` union, partitioned by the TWO authorities that already
 *        declare which receipt states are progress - the Mod's own `IsTerminal` and the Host's own
 *        `HELD_RECEIPT_PROGRESS_STATES` - crossed with the Mod's receipt publish seam (`receiptPublished?.Invoke`).
 *        property: a receipt state is either an OUTCOME (published once) or FOLDED into the evidence of the
 *        receipt that settles its execution. A state neither authority calls settled must never reach the fact
 *        stream, because the request's own response already carried it and the settlement will say what the
 *        execution did.
 *        print: `states examined N · outcomes O · evidence E · own-fact F · seams S`; `O + E = N` and `F > 0`
 *        fails, naming each state and the emitting `file:line`.
 *
 *   7 `settlement_evidence_still_carries_them:<kind>`
 *        population: the same folded states, AND every receipt the Mod mints and withholds from the fact stream
 *        (`RememberTerminal(...)` with `publish: false`, derived from the producer).
 *        property: the fold is not a deletion - the seam RECORDS the step, CARRIES it on the settled receipt,
 *        BOUNDS it, and COUNTS what did not fit (`steps_omitted`), so "walked 40 tiles then chopped" survives as
 *        evidence instead of as its own message. A WITHHELD receipt is not a deletion either: it must still STATE its
 *        own content in evidence (`tool=watering_can` is what the plan's reader loses if it does not), the funnel must
 *        still write that evidence into the durable transition row a plan's settlement is composed from, and the
 *        funnel's one publish point must still consult the flag - otherwise `publish: false` is a comment.
 *        print: `folded states examined N · recorded R · carried C · bounded B · counted K` and
 *        `withheld receipts examined S · stated T · journaled J · seam W`; anything short of N or S fails, naming
 *        the state or the receipt and the half that is missing.
 *
 *   8 `a_listener_failure_does_not_name_its_fact:<site>`
 *        population: every dispatch loop in `host/src` that hands a fact to listeners - derived from the source, by the
 *        shape a fact-listener dispatch has (`for (const listener of …factListeners…)`), never from a list of the two
 *        sites that existed when this was written.
 *        property: a listener that throws closes the bridge, and the reason it publishes says WHICH fact was in flight
 *        and WHY it threw - through the ONE composer (`factListenerFailureReasonCode`), so the bridge's own listeners
 *        and the launcher's event source cannot drift into two vocabularies.
 *        print: `wrappers examined N · names the fact F · names only the failure S`; `S > 0` fails, naming
 *        `file:line` and the bare code it publishes instead.
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
      finding(
        "progress_reported_as_a_fact",
        kind,
        `${bodySite} publishes \`${kind}\`, which the wire itself files under ` +
          "`$defs/bodyTrace` - a trace of the body, not a change of the world. The receipt for the same execution is the answer.",
      ),
    );
    continue;
  }
  const transitionSite = traceByTransition.get(kind);
  if (transitionSite !== undefined) {
    traces.push(
      finding(
        "progress_reported_as_a_fact",
        kind,
        `${transitionSite.file}:${transitionSite.line} emits \`${kind}\` on a ` +
          `non-terminal state (${transitionSite.state}) - the body is still going, and that is body state, not news. ` +
          "Walking belongs in the settlement's evidence or in the next snapshot, never in the fact stream.",
      ),
    );
    continue;
  }
  if (isEmitted(kind)) events.push(kind);
  else declaredOnce.push(kind);
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
    settlement.hasBound ? null : `the row list is not bounded by a named constant${settlementOverflow(settlement)}`,
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
        'the production notion of "progress" exists nowhere the product can read it - a concept a test owns is a ' +
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
// Check 6 · a_trace_is_produced_as_its_own_fact
// ---------------------------------------------------------------------------------------------------------------
const receiptStates = readReceiptStates();
const seam = readReceiptPublishSeam();
const ownFacts = [];
for (const state of receiptStates.partition.disagreed)
  ownFacts.push(
    finding(
      "a_trace_is_produced_as_its_own_fact",
      state,
      receiptStates.partition.disagreement(state) +
        " - two authorities disagree about whether this state is a settled receipt, and a state that is progress in " +
        "one of them and an outcome in the other is a flood waiting for the day the two are read by different modules.",
    ),
  );
for (const state of receiptStates.partition.progress) {
  if (seam.everyPublishIsGuarded) continue;
  ownFacts.push(
    finding(
      "a_trace_is_produced_as_its_own_fact",
      state,
      seam.unguarded.file +
        ":" +
        String(seam.unguarded.line) +
        " hands every receipt to the fact stream, `" +
        state +
        "` included. That state is a body trace in both authorities that declare one, the request's own response " +
        "already carried it, and the receipt that SETTLES the execution is the answer - so this is one execution " +
        "answered twice, which the pump then holds latest-only and never uses.",
    ),
  );
}
if (seam.count !== 1)
  ownFacts.push(
    finding(
      "a_trace_is_produced_as_its_own_fact",
      "publish_seam",
      String(seam.count) +
        " receipt publish seams were found in " +
        MOD_ROOT +
        " (" +
        seam.sites.map((site) => site.file + ":" + String(site.line)).join(", ") +
        "). One funnel is what makes the fold drainable; a second path around it publishes receipts nothing folds.",
    ),
  );
const checkSix = {
  examined: receiptStates.wire.length,
  outcomes: receiptStates.partition.terminal.length,
  evidence: receiptStates.partition.progress.length,
  ownFact: ownFacts.length,
  seams: seam.count,
};
report.checks.a_trace_is_produced_as_its_own_fact = checkSix;
if (receiptStates.wire.length === 0) blocked("the wire declares no `$defs/executionState` union to partition");
if (checkSix.outcomes + checkSix.evidence !== checkSix.examined)
  findings.push(
    finding(
      "a_trace_is_produced_as_its_own_fact",
      "partition",
      String(checkSix.examined) +
        " wire states, " +
        String(checkSix.outcomes) +
        " outcomes and " +
        String(checkSix.evidence) +
        " folded states, which does not add up - a state in neither half is a state " +
        "nobody decided about.",
    ),
  );
if (ownFacts.length > 0) findings.push(...ownFacts);

// ---------------------------------------------------------------------------------------------------------------
// Check 7 · settlement_evidence_still_carries_them
// ---------------------------------------------------------------------------------------------------------------
const fold = readTraceFold();
const withheld = readWithheldSteps();
const unfolded = [];
for (const state of receiptStates.partition.progress) {
  const missing = [
    fold.recorded ? null : "the trace is not RECORDED against its execution (`RecordTraceStep`)",
    fold.carried ? null : "the settled receipt does not CARRY the recorded steps (`CarryTraceSteps`)",
    fold.bounded
      ? null
      : "the fold is unbounded, so one long walk can overflow the receipt frame and lose the settlement (" +
        fold.boundReading +
        ")",
    fold.counted ? null : "what did not fit is not COUNTED (`steps_omitted`), so a truncated walk reads as a whole one",
    fold.named ? null : "the settlement does not say how many steps it folded (`steps=N`)",
  ].filter((entry) => entry !== null);
  if (missing.length === 0) continue;
  unfolded.push(
    finding(
      "settlement_evidence_still_carries_them",
      state,
      fold.file +
        " does not carry `" +
        state +
        "` into the settlement that settles its execution: " +
        missing.join("; ") +
        ". A deletion that loses the information is not the fix; a deletion that moves it into evidence is.",
    ),
  );
}
const unstated = [];
for (const step of withheld.steps) {
  const missing = [
    step.stated
      ? null
      : "the step STATES no evidence, so withholding it from the fact stream deletes what it said rather than " +
        "moving it into the settlement's evidence line",
    withheld.journaled
      ? null
      : "the funnel no longer writes the receipt's evidence into the durable transition row " +
        "(`FarmhandExecutionReceipt(..., receipt.Evidence, ...)`), which is the row a plan's settlement is composed " +
        "from - so the evidence a withheld step carries reaches no reader at all",
    withheld.seamGuarded
      ? null
      : "the funnel does not consult `publish` at its one publish point (`if (settled && publish)`), so the receipt " +
        "is a fact again and `publish: false` is a comment",
  ].filter((entry) => entry !== null);
  if (missing.length === 0) continue;
  unstated.push(
    finding(
      "settlement_evidence_still_carries_them",
      step.kind,
      `${step.file}:${step.line} mints \`${step.kind}\` as a step and does not publish it, and ` +
        missing.join("; ") +
        ". What the fact used to say has to survive somewhere a reader reaches: the receipt's own evidence line, " +
        "carried into the plan's journal row.",
    ),
  );
}
const checkSeven = {
  examined: receiptStates.partition.progress.length,
  recorded: fold.recorded ? checkSix.evidence : 0,
  carried: fold.carried ? checkSix.evidence : 0,
  bounded: fold.bounded ? checkSix.evidence : 0,
  counted: fold.counted && fold.named ? checkSix.evidence : 0,
  withheldExamined: withheld.steps.length,
  withheldStated: withheld.steps.filter((step) => step.stated).length,
  withheldJournaled: withheld.journaled ? withheld.steps.length : 0,
  withheldSeam: withheld.seamGuarded ? withheld.steps.length : 0,
};
report.checks.settlement_evidence_still_carries_them = checkSeven;
if (checkSeven.examined === 0) blocked("no receipt state is folded, so there is no evidence fold to read");
if (checkSeven.withheldExamined === 0)
  blocked(
    "no receipt is withheld from the fact stream, so the step half of the settlement's evidence was not measured - " +
      "nothing here reads a step that was deleted instead of moved",
  );
if (unfolded.length > 0) findings.push(...unfolded);
if (unstated.length > 0) findings.push(...unstated);

// ---------------------------------------------------------------------------------------------------------------
// Check 8 · a_listener_failure_does_not_name_its_fact
// ---------------------------------------------------------------------------------------------------------------
const wrappers = readFactListenerWrappers();
const unnamedWrappers = wrappers.filter((wrapper) => !wrapper.namesTheFact);
const checkEight = {
  examined: wrappers.length,
  namesTheFact: wrappers.length - unnamedWrappers.length,
  namesOnlyFailure: unnamedWrappers.length,
};
report.checks.a_listener_failure_does_not_name_its_fact = checkEight;
if (checkEight.examined === 0)
  blocked("no fact-listener dispatch was found in host/src, so no wrapper's failure reason was read");
for (const wrapper of unnamedWrappers)
  findings.push(
    finding(
      "a_listener_failure_does_not_name_its_fact",
      wrapper.site,
      `${wrapper.site} closes on \`${wrapper.publishes}\` - the fact that was being delivered and the error's own token are ` +
        "discarded at the throw site, so every occurrence of this fault reads as the same unattributable close. Compose the " +
        "reason with `factListenerFailureReasonCode(fact, error)` (host/src/local-stardew-bridge.ts) and publish THAT.",
    ),
  );

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

/**
 * Which receipt states the wire admits, and which of them are settled - asked of the TWO authorities that already answer.
 *
 * Neither answer is restated here. The MOD's `IsTerminal` names the states that have not ended; the HOST's
 * `HELD_RECEIPT_PROGRESS_STATES` names the ones its pump holds latest-only because they never open a turn. A state one
 * of them calls progress and the other calls an outcome is the defect this check exists for, so the disagreement is a
 * finding of its own rather than a tie broken silently.
 */
function readReceiptStates() {
  const wireStates = readWire().receiptStates;
  const modProgress = [...readNonTerminalStates()].map(toWireStateToken).sort();
  const hostHeld = readHostHeldReceiptStates();
  const progress = unionSorted([...modProgress, ...hostHeld]);
  const terminal = wireStates.filter((state) => !progress.includes(state));
  const disagreed = progress.filter((state) => !(modProgress.includes(state) && hostHeld.includes(state)));
  return {
    wire: wireStates,
    partition: {
      progress,
      terminal,
      disagreed,
      disagreement(state) {
        const inMod = modProgress.includes(state);
        const inHost = hostHeld.includes(state);
        const sides = [
          inMod ? null : `${EXECUTION_STATES} IsTerminal calls it settled`,
          inHost ? null : `${EVENT_PUMP} HELD_RECEIPT_PROGRESS_STATES does not know it`,
        ].filter((entry) => entry !== null);
        return (
          "`" +
          state +
          "` is progress in " +
          (inMod ? "the Mod" : "the Host") +
          " but not in " +
          (inMod ? "the Host" : "the Mod") +
          ": " +
          sides.join("; ")
        );
      },
    },
  };
}

/** The Host's own declaration of "this receipt state never opens a turn": the table `TRACE_KINDS` is derived from. */
function readHostHeldReceiptStates() {
  const path = join(ROOT, EVENT_PUMP);
  if (!existsSync(path)) blocked(`${EVENT_PUMP} does not exist`);
  const text = readFileSync(path, "utf8");
  const at = text.indexOf("export const HELD_RECEIPT_PROGRESS_STATES");
  if (at < 0) blocked(`${EVENT_PUMP} no longer declares which receipt states it holds as progress`);
  const end = text.indexOf("});", at);
  if (end < 0) blocked(`${EVENT_PUMP} declares HELD_RECEIPT_PROGRESS_STATES without a table body`);
  return [...text.slice(at, end).matchAll(/(?:^|\n)\s{2}([a-z0-9_]+):/gu)].map((match) => match[1]).sort();
}

/** `ExecutionState.MeaningfulProgress` -> `meaningful_progress`, which is how the wire spells the same member. */
function toWireStateToken(name) {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

/**
 * Where a receipt leaves the Mod, and whether the terminality predicate is what decides.
 *
 * Population: every `receiptPublished?.Invoke(...)` in the Mod's production sources. Property: each one is guarded by
 * a branch whose condition is the producer's OWN `IsTerminal()`, either inline or through a local assigned from it.
 */
function readReceiptPublishSeam() {
  const files = walkProductionFiles(MOD_ROOT, (name) => name.endsWith(".cs"));
  const terminalityLocals = new Set();
  const sites = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(/(\w+)\s*=\s*[\w.?]*\.IsTerminal\(\)/gu))
      terminalityLocals.add(`${file}:${match[1]}`);
    for (const match of text.matchAll(/receiptPublished\??\.Invoke\(/gu))
      sites.push({ file, index: match.index, line: lineOf(text, match.index), text });
  }
  let guardedCount = 0;
  let unguarded = null;
  for (const site of sites) {
    if (publishIsGuardedByTerminality(site, terminalityLocals)) guardedCount += 1;
    else if (unguarded === null) unguarded = { file: site.file, line: site.line };
  }
  return {
    count: sites.length,
    sites,
    unguarded: unguarded ?? sites.at(0) ?? { file: `${MOD_ROOT}/farmhandexecutioncontroller.cs`, line: 0 },
    everyPublishIsGuarded: sites.length > 0 && guardedCount === sites.length,
  };
}

/** The lines above a publish: `if (settled)` where `settled` came from `IsTerminal()`, or the call inline. */
function publishIsGuardedByTerminality(site, terminalityLocals) {
  const before = site.text
    .slice(Math.max(0, site.index - 400), site.index)
    .split("\n")
    .filter((line) => line.trim() !== "");
  for (const line of before.slice(-3)) {
    if (/\.IsTerminal\(\)/u.test(line)) return true;
    // `if (settled && publish)` is still the terminality guard: the second condition WITHHOLDS a settled receipt, it
    // never lets an unsettled one through, so the local is read from the first operand.
    const guard = /if\s*\(\s*!?\s*(\w+)\s*(?:&&[^)]*)?\)/u.exec(line);
    if (guard !== null && terminalityLocals.has(`${site.file}:${guard[1]}`)) return true;
  }
  return false;
}

/**
 * The fold that has to replace the traces: recorded against the execution, carried on the settled receipt, BOUNDED and
 * COUNTED. A deletion without this half loses the walk it was meant to move.
 */
function readTraceFold() {
  const files = walkProductionFiles(MOD_ROOT, (name) => name.endsWith(".cs"));
  let text = "";
  let file = `${MOD_ROOT}/farmhandexecutioncontroller.cs`;
  for (const candidate of files) {
    const body = readFileSync(join(ROOT, candidate), "utf8");
    if (!body.includes("receiptPublished")) continue;
    text = body;
    file = candidate;
    break;
  }
  const stepsBound = /MaximumFoldedTraceSteps\s*=\s*\d+/u.test(text);
  const charsBound = /MaximumFoldedTraceChars\s*=\s*\d+/u.test(text);
  const consultsSteps = /steps\.Count\s*==\s*MaximumFoldedTraceSteps/u.test(text);
  const consultsChars = /characters\s*\+\s*step\.Length\s*>\s*MaximumFoldedTraceChars/u.test(text);
  return {
    file,
    recorded: /RecordTraceStep\(/u.test(text),
    carried: /=\s*this\.CarryTraceSteps\(/u.test(text),
    bounded: stepsBound && charsBound && consultsSteps && consultsChars,
    boundReading:
      "steps: " +
      (stepsBound ? "named" : "absent") +
      ", chars: " +
      (charsBound ? "named" : "absent") +
      ", steps consulted: " +
      (consultsSteps ? "yes" : "no") +
      ", chars consulted: " +
      (consultsChars ? "yes" : "no"),
    counted: /Omitted\+\+/u.test(text) && /steps_omitted=/u.test(text),
    named: /\bfolded=/u.test(text),
  };
}

/**
 * Every receipt the Mod mints and WITHHOLDS from the fact stream, with what it must still say.
 *
 * <p>
 * Population, DERIVED from the producer: each `RememberTerminal(...)` call that passes `publish: false`, plus the two
 * halves of the funnel such a call depends on. A withheld receipt is not a deleted one - the dispatch that asked for
 * it, the ledger and the plan's own journal row all still read it - so the properties are exactly what is left once
 * the fact stream is gone:
 * </p>
 * <ul>
 *   <li>`stated` - the step STATES its own content in its evidence. `tool=watering_can;before=…` is the sentence the
 *       fact used to carry; an empty evidence here is the information deleted rather than moved.</li>
 *   <li>`journaled` - the funnel writes that evidence into the durable transition row
 *       (`FarmhandExecutionReceipt(..., receipt.Evidence, ...)`), which is the row `planBatchAnswer` composes a plan's
 *       settlement from, so the reader of the settlement still learns which tool it was.</li>
 *   <li>`seamGuarded` - the funnel's one publish point consults the flag (`if (settled && publish)`). Without it a
 *       `publish: false` at a mint site is a comment and the receipt is a fact again.</li>
 * </ul>
 */
function readWithheldSteps() {
  const files = walkProductionFiles(MOD_ROOT, (name) => name.endsWith(".cs"));
  const steps = [];
  const seams = [];
  let journaled = false;
  let seamGuarded = false;
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    if (/if\s*\(\s*settled\s*&&\s*publish\s*\)[\s\S]{0,120}?this\.receiptPublished\?\.Invoke\(/u.test(text))
      seamGuarded = true;
    if (/receipt\.ReasonCode,\s*receipt\.Revision,\s*receipt\.Evidence,/u.test(text)) journaled = true;
    for (const match of text.matchAll(/RememberTerminal\(([\s\S]{0,700}?)\);/gu)) {
      if (!/publish:\s*false/u.test(match[1])) continue;
      const kind = /ExecutionState\.\w+\s*,\s*"([a-z0-9_]+)"/u.exec(match[1])?.[1] ?? "unresolved";
      const evidence = (
        /ExecutionState\.\w+\s*,\s*"[a-z0-9_]+"\s*,\s*([\s\S]*?),\s*publish:\s*false/u.exec(match[1])?.[1] ?? ""
      ).trim();
      steps.push({
        kind,
        file,
        line: lineOf(text, match.index),
        evidence,
        stated: evidence !== "" && evidence !== "null",
        fields: [...evidence.matchAll(/([a-z_]+)=/gu)].map((entry) => entry[1]),
      });
    }
    if (text.includes("receiptPublished?.Invoke("))
      seams.push({ file, line: lineOf(text, text.indexOf("receiptPublished?.Invoke(")) });
  }
  return { steps, journaled, seamGuarded, seams, file: seams[0]?.file ?? `${MOD_ROOT}/farmhandexecutioncontroller.cs` };
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

/**
 * Every place in `host/src` that hands a fact to listeners, and whether the reason it closes on names that fact.
 *
 * <p>
 * The population is the SOURCE's own shape rather than a list of the sites that existed when this was written: a
 * `for (const listener of …factListeners…)` loop is what delivering a fact looks like, so a third wrapper written
 * tomorrow is measured without anyone remembering to add it here. A loop counts as a WRAPPER only when a `try` opens
 * before it and a `catch` closes after it - the `catch` that closes the bridge is exactly the block that has to say
 * WHICH fact was in flight and WHY it threw.
 * </p>
 * <p>
 * MEASURED 2026-11-17: two runs (one of them the best of the night) published `fact_listener_failed` and nothing else,
 * so an artifact could not say whether a projection, the pump, a receipt fold or a serialization fault had thrown. The
 * composer (`factListenerFailureReasonCode`) is the one spelling; a wrapper that closes on a literal instead of on the
 * composer is what this check refuses.
 * </p>
 */
function readFactListenerWrappers() {
  const files = walkProductionFiles("host/src", (name) => /\.ts$|\.mts$/u.test(name)).filter(
    (file) => !isTestFile(file),
  );
  const wrappers = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(/for \(const \w+ of [^)]*[Ff]actListeners[^)]*\)/gu)) {
      const catchBody = listenerCatchAfter(text, match.index + match[0].length);
      // A dispatch with no enclosing `try` publishes no reason of its own: its throw belongs to whatever owns the
      // loop, and this check is about what a WRAPPER says when it closes the bridge.
      if (catchBody === null) continue;
      const site = `${file}:${lineOf(text, match.index)}`;
      const namesTheFact = catchBody.includes("factListenerFailureReasonCode(");
      wrappers.push({ site, namesTheFact, publishes: publishedCode(catchBody) });
    }
  }
  return wrappers;
}

/** The text of the `catch` body that follows a listener dispatch inside its own `try`, or `null` when there is none. */
function listenerCatchAfter(text, afterDispatch) {
  // The dispatch has to sit inside a `try {`: look back to the nearest statement boundary and require one there.
  const before = text.slice(0, afterDispatch);
  if (!/try \{/u.test(before.slice(Math.max(0, before.length - 800)))) return null;
  const statementEnd = skipStatement(text, afterDispatch);
  const catchMatch = /\} catch (?:\(\w+(?:: [^)]*)?\) )?\{/u.exec(text.slice(statementEnd, statementEnd + 400));
  if (catchMatch === null) return null;
  return bracedBody(text, statementEnd + catchMatch.index + catchMatch[0].length);
}

/** The index just past a loop's body, whether it is one braced block or a single statement. */
function skipStatement(text, index) {
  let cursor = index;
  while (cursor < text.length && /\s/u.test(text[cursor])) cursor++;
  if (text[cursor] !== "{") {
    const semicolon = text.indexOf(";", cursor);
    return semicolon === -1 ? text.length : semicolon + 1;
  }
  return cursor + bracedBody(text, cursor + 1).length + 2;
}

/** The text between a block's opening brace and its matching one. */
function bracedBody(text, index) {
  let depth = 1;
  for (let cursor = index; cursor < text.length; cursor++) {
    if (text[cursor] === "{") depth++;
    else if (text[cursor] === "}") depth--;
    if (depth === 0) return text.slice(index, cursor);
  }
  return text.slice(index);
}

/** The reason code a wrapper's catch hands to `close`/`disconnect`, as far as it names one. */
function publishedCode(catchBody) {
  for (const code of ["fact_listener_failed", "event_pump_event_overflow", "close_reason_unnamed"])
    if (catchBody.includes(`"${code}"`) || catchBody.includes(`\`${code}`)) return code;
  return "an unnamed code";
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
    (rows > shown
      ? ` and ${rows - shown} must be COUNTED (\`… ${rows} shown ${shown}\`), never dropped in silence`
      : "")
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
  lines.push(
    `settlement_evidence_still_carries_them: folded states examined ${checkSeven.examined} · recorded ${checkSeven.recorded} · ` +
      `carried ${checkSeven.carried} · bounded ${checkSeven.bounded} · counted ${checkSeven.counted} · ` +
      `withheld receipts examined ${checkSeven.withheldExamined} · stated ${checkSeven.withheldStated} · ` +
      `journaled ${checkSeven.withheldJournaled} · seam ${checkSeven.withheldSeam}`,
  );
  lines.push(
    `a_listener_failure_does_not_name_its_fact: wrappers examined ${checkEight.examined} · ` +
      `names the fact ${checkEight.namesTheFact} · names only the failure ${checkEight.namesOnlyFailure}`,
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
