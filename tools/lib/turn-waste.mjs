/**
 * 她的回合里有多少个什么都没买到：一份按收据判定的读数，而不是按她说过的话。
 *
 * WHY THIS EXISTS. `round99`'s own account says `assistant turns examined 112 {worked: 24,
 * worked_silently: 76, spoke: 12}` - and "worked" there means only "the turn produced
 * something", never "the world moved". A day that lost its afternoon to four `stardew_observe`
 * rounds looking for a `targetId` her block never printed, to a plan refused `policy_identity_mismatch`
 * in 372 µs whose next 35 game minutes were spent thinking, and to five navigation refusals whose
 * `next_step` said `observe` again, reads in that account as a day of work. So the waste has to be
 * counted from what the receipts and submissions actually produced, not from prose and not from
 * the fact that a turn emitted something.
 *
 * THE UNIT IS ONE ASSISTANT TURN, and the evidence is the run's OWN record of it: the session JSONL
 * the bundle publishes (`result.json` -> `toolTiming.record`, the same file `tools/live-run/analysis/
 * airp-scorecard.mjs` binds its readings to). Its `assistant` records are the turns; its `toolCall`
 * parts are the submissions; its `toolResult` records carry the answer each submission got.
 *
 * ONE SUBMISSION'S OUTCOME, decided in the artifact's own terms:
 *
 *   changed        the answer carries an execution (`executionId`) or a program (`programId`) that
 *                  reached `succeeded` with a reason that is not one of the nothing-changed
 *                  terminals below, so the world or her body really moved.
 *   refused        the compiler refused the script (`planStatus: refused`), the node ended
 *                  `rejected`/`failed`/`cancelled`, or the receipt's state is a refusal.
 *   no_change      a `succeeded` receipt for work the Mod's own words say was already done - the
 *                  declared family in `NOTHING_CHANGED_TERMINALS`, each entry naming the line that
 *                  mints it (`soil_already_tilled`, `weed_target_gone`, `nothing_to_dismiss`, ...).
 *   no_receipt     the submission produced no execution at all: a read (`stardew_observe`,
 *                  `stardew_look_up`, `stardew_plan_shape`, `stardew_action_program_status`, ...).
 *   not_measured   the artifact cannot say: the node was still running when the run ended, the
 *                  submission has no tool result, or the answer carries no settleable state.
 *
 * A TURN IS WASTE WHEN EVERY SUBMISSION IT MADE BUYED NOTHING - all of them `no_receipt`,
 * `refused` or `no_change`. That is the empty-turn share.
 *
 * THE THREE NUMBERS ARE PRINTED APART, because they have three different causes and one number would hide
 * all of them, and the JUDGED RUN'S EMPTY TURNS ARE NAMED ONE BY ONE: a share is not a reading a lane can act
 * on, so the section prints, grouped by cause, `turn 41 stardew_observe`, `turn 12 stardew_plan_work
 * (move_to_tile,enter_exit) policy_identity_mismatch` and `turn 43 stardew_observe (repeats turn 41)`. A
 * reader goes from the number to the offender without re-deriving the analysis, and `round99`'s 27 empty
 * turns - 14 refusals under eleven codes, 13 reads that could buy nothing by construction - are visible as
 * the two different problems they are.
 *
 *   empty turns            turns whose submissions all produced no state change (the share below);
 *   refused resubmissions  a refused submission re-sent as the same work - keyed on the CONTENT she
 *                          asked for (the node set of a program, or the action and its arguments), so
 *                          a re-send under a new program id is still the same work and a genuinely
 *                          different plan is not counted as a retry;
 *   repeated identical reads  a read whose tool and selection repeat an earlier read with NO ACTION
 *                          between them - the shape `round99` spent its afternoon in, and the one that
 *                          costs nothing to see because the selection is in the request.
 *
 * WHAT IS NEVER COUNTED AS WASTE: a turn whose emptiness the artifacts cannot prove. A turn cut off
 * by the end of the run, a node still `running` in `programOutcomes`, an answer that could not be
 * read - each is printed as `not_measured` and kept out of the share, because a rule that counted
 * the unknown as waste would push a lane to make the unknown disappear rather than the waste. A turn
 * that submitted nothing at all (she spoke, or answered with no tool) is not an empty turn either:
 * it is counted beside the population, since a turn with no submission has nothing to have bought.
 *
 * THE THRESHOLD IS READ OFF THE DISTRIBUTION, AND IT HAS NO ROOM IN EITHER DIRECTION. The last two days
 * (2026-11-22..11-24, 10 recorded runs) read 0.167 to 0.472, and the whole current era (2026-11-18..11-24,
 * 21 runs) 0.167 to 0.650. `TURN_WASTE_CEILING` is 0.5: 1.06x the last two days' worst (`2026-11-22T06-04`,
 * 25 of 53 turns) and 0.89x the smallest doubling that has to be caught - twice `round99`, 0.562. Tightening
 * it to 0.45 would red two days of that same week that really happened (0.457 and 0.472); lifting it to 0.55
 * would let a doubled `round99` through. Two era readings DO sit above it (`2026-11-19T04-46` 0.519 of 185
 * turns, `2026-11-21T12-50` 0.650 of 20), and by this metric's own meaning those days were wasteful: more
 * than half of their working turns bought nothing. The line the gate showed as loose (1.78x) was loose
 * against `round99` alone, not against the population it judges.
 *
 * THE POPULATION IS SPLIT ON TIME, and that split is what makes one ceiling possible at all: the corpus is
 * bimodal - the 2026-10 and 11-01..11-11 runs read 0.54-1.00 (their turns were reads), the 11-18+ era reads
 * 0.17-0.65 - and the verdict judges only the MOST RECENT judgeable run, so an old day cannot red today's
 * reading. The split is on recency, not on program size or map, because the harness the turns meet is what
 * changed between the two modes.
 *
 * WHAT IT CANNOT SEE, stated: a turn that submits one action and gets a `succeeded` receipt counts as work
 * however little it bought, so six refused-then-corrected attempts inside one turn read as a working turn;
 * and a bundle that publishes no session record is `withoutRecord`, never a zero.
 *
 * THE RUN IS THE UNIT THE VERDICT JUDGES, and the corpus is printed beside it. A share over every run in
 * a checkout mixes a day that read its way across the map with one that worked, and MEASURED 2026-11-24:
 * 74 of the 106 recorded runs sit above 0.5 - every one of them a 2026-10 or early-11 day whose turns were
 * reads - so a corpus ceiling would be red on history forever and a lane would learn to ignore it. The
 * verdict reads the MOST RECENT judgeable run (the day just run, and the line names it), the corpus aggregate
 * and the three worst runs are printed above it, and a run smaller than `TURN_WASTE_POPULATION_FLOOR` working
 * turns is not judged at all.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { bundleDirectories } from "./program-pace.mjs";

/**
 * The terminals the Mod's own words say mean "there was nothing to do": a `succeeded` receipt whose
 * reason names the work as already the world's state, so it proves no change.
 *
 * EACH ENTRY NAMES THE LINE THAT MINTS IT, because a vocabulary copied from memory is how a reader
 * ends up believing a receipt is an average. A run that mints a new "already done" terminal must add
 * it here; `tools/perf/turn-waste.test.mjs` fails naming the code that appeared in an artifact and in
 * no row of this table, so the table cannot silently fall behind the Mod.
 */
export const NOTHING_CHANGED_TERMINALS = Object.freeze({
  soil_already_tilled: "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs:648",
  weed_target_gone: "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs:1319",
  rock_source_gone: "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs:382",
  tree_chop_source_gone: "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs:79",
  already_equipped: "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs:807",
  nothing_to_dismiss: "integrations/stardew/farmhandexecutioncontroller.modalactions.cs:100",
  nothing_to_answer: "integrations/stardew/farmhandexecutioncontroller.modalactions.cs:556",
});

/** The states that name a refusal rather than a change, whichever side of the wire spells them. */
export const REFUSED_STATES = Object.freeze([
  "failed",
  "rejected",
  "cancelled",
  "invalidated",
  "blocked",
  "uncertain",
]);

const REFUSED = new Set(REFUSED_STATES);

/**
 * How large a share of her submission-bearing turns may buy nothing.
 *
 * MEASURED over rounds 94-99 (`2026-11-23T03-13-05-598Z` .. `2026-11-24T09-55-06-982Z`): 34.5% (30 of
 * 87 turns), 19.5% (23/118), 34.2% (39/114), 16.7% (30/180), 28.1% (27/96). `round98` published no
 * session record and is counted `withoutRecord`, not as a zero. The line is 0.5, placed by two readings
 * from the era it judges rather than by comfort: the last two days' worst is 0.472
 * (`2026-11-22T06-04`, 25 of 53 turns), and twice `round99` - the smallest doubling that must be red - is
 * 0.562. Tightening to 0.45 reds two days of that week; lifting to 0.55 lets a doubling through.
 */
export const TURN_WASTE_CEILING = 0.5;

/**
 * How many submission-bearing turns a reading needs before the share is published at all.
 *
 * One turn can be empty for a hundred honest reasons; a population is what makes a share a reading of
 * more than one decision. The smallest run in the distribution this line was set from had 87
 * submission-bearing turns, so 12 is a floor for a SHORT run and not a target: below it the section
 * says `too_few_turns` and publishes no share rather than a share over three decisions.
 */
export const TURN_WASTE_POPULATION_FLOOR = 12;

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${key}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
};

/** The arguments of a `toolCall`, as the key a repeated read is recognised by. */
const selectionOf = (argumentsOfCall) => canonical(argumentsOfCall ?? {});

/**
 * The leading JSON object of a tool result, because the Host appends prose to some of them
 * (`{...} A cutscene currently holds the farmhand, so no action can run.`). A reminder block can
 * follow too, so the answer is the object the record STARTS with, never the whole text.
 */
export function leadingJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** The session record this bundle publishes by name, or the reason it cannot be bound. */
export function sessionRecordOf(bundleDirectory) {
  const resultPath = join(bundleDirectory, "result.json");
  if (!existsSync(resultPath)) return { path: null, why: "no result.json" };
  let result;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    return { path: null, why: "result.json is unreadable" };
  }
  const record = typeof result?.toolTiming?.record === "string" ? result.toolTiming.record : null;
  if (record === null) return { path: null, why: "the bundle names no session record" };
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(directory, entry.name));
      else if (entry.name === record) found.push(join(directory, entry.name));
    }
  };
  walk(bundleDirectory);
  if (found.length === 0) return { path: null, why: `${record} is not under this run` };
  return { path: found[0], why: null };
}

/** The program outcomes the run recorded, by program id: what a submission that outlived its turn became. */
function programOutcomesOf(bundleDirectory) {
  const resultPath = join(bundleDirectory, "result.json");
  const outcomes = new Map();
  if (!existsSync(resultPath)) return outcomes;
  let result;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    return outcomes;
  }
  for (const program of Array.isArray(result?.programOutcomes) ? result.programOutcomes : []) {
    if (typeof program?.programId === "string") outcomes.set(program.programId, program);
  }
  return outcomes;
}

const contentKeyOfNode = (node) => {
  // A node in a plan_work ANSWER carries `tile`; one in `result.programSubmissions` carries
  // `arguments`. Both identify the same work, so the key reads whichever the artifact gave and never
  // collapses two different requests of the same action into one "retry".
  const coordinates = Object.entries(node?.arguments ?? {})
    .map(([name, argument]) => `${name}=${String(argument?.canonicalValue ?? argument)}`)
    .sort()
    .join(",");
  const tile =
    typeof node?.tile?.x === "number" && typeof node?.tile?.y === "number"
      ? `@${String(node.tile.x)},${String(node.tile.y)}`
      : "";
  return `${String(node?.actionId)}${tile}(${coordinates})`;
};

/**
 * The work one submission asked for, as the key a refusal is retried by: the node set of a
 * program (so the same nodes under a new program id are the same work), the script text when the
 * script never compiled, or the action and its arguments for a flat dispatch.
 */
function workKeyOf({ tool, argumentsOfCall, answer }) {
  if (typeof answer?.programId === "string" || answer?.planStatus === "refused") {
    const nodes = Array.isArray(answer?.nodes) ? answer.nodes : [];
    const keys = nodes.map(contentKeyOfNode);
    // A node that names neither a tile nor an argument (a `navigate_to_destination` carries its
    // destination in the SCRIPT) identifies nothing, so the script is the content that was asked for.
    const identified = keys.length > 0 && keys.every((key) => /@\d+,\d+\(.+\)$|@\d+,\d+\(\)$|\w+\(.+\)$/u.test(key));
    if (identified) return `program:${keys.sort().join("|")}`;
    const script = typeof argumentsOfCall?.script === "string" ? argumentsOfCall.script : "";
    return `script:${script.replace(/\s+/gu, " ").trim()}`;
  }
  return `action:${tool}:${selectionOf(argumentsOfCall)}`;
}

/**
 * One submission's outcome, from the answer the run recorded for it.
 *
 * `notMeasured` is a first-class answer, never a zero: an unresolved node, an unreadable result and
 * a submission with no result at all are the three shapes the artifact cannot decide.
 */
export function outcomeOf({ tool, answer, unreadable = false, outcomes }) {
  if (answer === undefined) return { kind: "not_measured", why: "no tool result" };
  if (unreadable) return { kind: "not_measured", why: "unreadable result" };
  if (answer === null) return { kind: "no_receipt", why: tool };
  if (typeof answer.programId === "string" || answer?.planStatus === "refused") {
    if (answer.planStatus === "refused") return { kind: "refused", why: answer.reasonCode ?? "plan refused" };
    const settleable = (nodes) => Array.isArray(nodes) && nodes.length > 0 && nodes.every((node) => typeof node?.state === "string");
    let nodes = answer.settled === true && settleable(answer.nodes) ? answer.nodes : null;
    if (nodes === null) {
      const final = outcomes.get(answer.programId);
      nodes = settleable(final?.nodeOutcomes) ? final.nodeOutcomes : null;
    }
    if (nodes === null) return { kind: "not_measured", why: "the program has no settled node" };
    if (nodes.some((node) => node.state === "succeeded" && !(node.reasonCode in NOTHING_CHANGED_TERMINALS)))
      return { kind: "changed" };
    if (nodes.some((node) => node.state === "running" || node.state === "pending" || node.state === "accepted"))
      return { kind: "not_measured", why: "a node was still in flight when the run ended" };
    if (nodes.every((node) => REFUSED.has(node.state)))
      return { kind: "refused", why: nodes[0]?.reasonCode ?? "refused" };
    // Every node settled, none of them changed anything: a program that only did what was already done.
    return { kind: "no_change", why: nodes.find((node) => typeof node.reasonCode === "string")?.reasonCode ?? null };
  }
  if (typeof answer.executionId === "string") {
    if (answer.state === "succeeded")
      return answer.reasonCode in NOTHING_CHANGED_TERMINALS
        ? { kind: "no_change", why: answer.reasonCode }
        : { kind: "changed" };
    if (REFUSED.has(answer.state)) return { kind: "refused", why: answer.reasonCode ?? answer.state };
    return { kind: "not_measured", why: `state ${String(answer.state)}` };
  }
  // No execution identity at all: a read. It cannot change the world by construction.
  return { kind: "no_receipt", why: tool };
}

/**
 * What she put on the wire, for the line that names an empty turn: the tool, and the work when the answer
 * or the refusal names it, so `stardew_plan_work(move_to_tile,enter_exit)` says WHICH plan was refused.
 */
function submittedOf({ tool, answer }) {
  const actions = Array.isArray(answer?.nodes)
    ? [...new Set(answer.nodes.map((node) => node?.actionId).filter((action) => typeof action === "string"))].sort()
    : [];
  if (actions.length > 0) return `${tool}(${actions.join(",")})`;
  if (typeof answer?.actionId === "string") return `${tool}(${answer.actionId})`;
  return tool;
}

/** The cause a submission is counted under, in the two vocabularies the printout uses. */
const causeOf = (entry) => (entry.outcome.kind === "no_receipt" ? `no_receipt:${entry.tool}` : entry.outcome.kind);

/**
 * One empty turn, as the line that names it needs it: which turn of the run it was, and each submission it
 * made with the cause it was counted under and the code the answer gave (a read has no code - it could not
 * change anything by construction - while a refusal or a nothing-changed receipt has the Mod's own words).
 */
function emptyTurnOf({ turn, classified }) {
  return Object.freeze({
    turn,
    submissions: Object.freeze(
      classified.map((entry) =>
        Object.freeze({
          cause: causeOf(entry),
          code: entry.outcome.kind === "no_receipt" ? null : (entry.outcome.why ?? null),
          submitted: submittedOf({ tool: entry.tool, answer: entry.answer }),
          repeatsTurn: entry.repeatsTurn ?? null,
        }),
      ),
    ),
  });
}

/**
 * Every turn, every submission and the three readings over them.
 *
 * POPULATION: the bundles under `bundleRoot` that publish a session record. A bundle that names no
 * record, or names one that is not under its own directory, is counted `withoutRecord` and named -
 * a run whose record is missing has not measured nothing, it has not been measured.
 */
export function measureTurnWaste({ bundleRoot } = {}) {
  const root = resolve(bundleRoot ?? "");
  if (!existsSync(root)) {
    return Object.freeze({
      bundleRoot: root,
      status: "no_bundle_root",
      bundles: 0,
      bundlesWithRecord: 0,
      withoutRecord: Object.freeze([]),
      turns: Object.freeze({ examined: 0, withSubmission: 0, withoutSubmission: 0 }),
      submissions: Object.freeze({ examined: 0, changed: 0, refused: 0, no_change: 0, no_receipt: 0, not_measured: 0 }),
      empty: Object.freeze({ turns: 0, byCause: Object.freeze({}) }),
      refusedResubmissions: 0,
      refusedResubmissionKeys: Object.freeze([]),
      repeatedReads: 0,
      repeatedReadKeys: Object.freeze([]),
      reads: Object.freeze({ examined: 0, byTool: Object.freeze({}) }),
      readsWithoutSelection: 0,
      notMeasured: Object.freeze({ submissions: 0, byCause: Object.freeze({}) }),
      bundlesJudged: 0,
      judged: Object.freeze([]),
      newest: null,
      share: null,
    });
  }
  const directories = bundleDirectories(root);
  const withoutRecord = [];
  const byCause = new Map();
  const reads = new Map();
  const submissions = { examined: 0, changed: 0, refused: 0, no_change: 0, no_receipt: 0, not_measured: 0 };
  const turns = { examined: 0, withSubmission: 0, withoutSubmission: 0 };
  const notMeasuredByCause = new Map();
  const bundleReadings = [];
  let emptyTurns = 0;
  let bundlesWithRecord = 0;
  const refusedKeys = new Map();
  const retriedKeys = new Map();
  const repeatedReadKeys = new Map();
  let refusedResubmissions = 0;
  let repeatedReads = 0;
  let readsWithoutSelection = 0;
  for (const directory of directories) {
    const bound = sessionRecordOf(directory);
    if (bound.path === null) {
      withoutRecord.push(`${directory}: ${String(bound.why)}`);
      continue;
    }
    bundlesWithRecord += 1;
    const outcomes = programOutcomesOf(directory);
    let records;
    try {
      records = readFileSync(bound.path, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    } catch {
      withoutRecord.push(`${directory}: ${String(bound.why ?? "session record is unreadable")}`);
      continue;
    }
    let bundleTurns = 0;
    let bundleEmpty = 0;
    let bundleRefusedResubmissions = 0;
    let bundleRepeatedReads = 0;
    let turn = 0;
    const bundleEmptyTurns = [];
    const answers = new Map();
    for (const record of records) {
      if (record?.message?.role !== "toolResult") continue;
      answers.set(record.message.toolCallId, record.message);
    }
    // The run's own reads, in order, so a repeat is a repeat of an identical selection with no action
    // between. Reset by any action submission: a read after work is a fresh look, not a repeat. The map
    // holds the TURN each key was read at, so a repeat can name the turn it repeats rather than a count.
    let readsSinceAction = new Map();
    for (const record of records) {
      const message = record?.message;
      if (message?.role !== "assistant") continue;
      turns.examined += 1;
      turn += 1;
      const calls = (Array.isArray(message.content) ? message.content : []).filter((part) => part?.type === "toolCall");
      const classified = [];
      for (const call of calls) {
        // Only the game's own tools are submissions: `ctx_reduce` and the delegate belong to the
        // context layer, and a turn that only compacted its history bought nothing in the world either
        // way - it is counted apart rather than as waste.
        if (typeof call.name !== "string" || !call.name.startsWith("stardew_")) continue;
        const resultMessage = answers.get(call.id);
        const text =
          resultMessage === undefined
            ? null
            : (resultMessage.content ?? [])
                .filter((part) => part?.type === "text")
                .map((part) => part.text)
                .join("");
        // Three shapes, three different facts: no record at all (`undefined`), a record whose answer
        // is prose with no execution identity (`null` - a read), and a record that STARTS like an
        // answer and cannot be parsed (unreadable, which is `not_measured` and never waste).
        let answer;
        let unreadable = false;
        if (resultMessage === undefined) answer = undefined;
        else if (typeof text !== "string" || text.trim().length === 0) answer = null;
        else {
          answer = leadingJson(text);
          if (answer === null) unreadable = text.trimStart().startsWith("{");
        }
        const outcome = outcomeOf({ tool: call.name, answer, unreadable, outcomes });
        submissions.examined += 1;
        submissions[outcome.kind] += 1;
        const entry = { tool: call.name, argumentsOfCall: call.arguments, answer, outcome, repeatsTurn: null };
        classified.push(entry);
        // A REFUSED RESUBMISSION IS A RE-SEND OF REFUSED WORK WHILE NOTHING HAS MOVED. The cost being
        // counted is the turn the refusal made her spend, so the retry has to be the NEXT attempt at the
        // same work: a refusal is remembered only until some submission changes something, because after
        // the world moved a later request for the same work is a new request and not a retry (measured on
        // `round99`: without that boundary one refused emote counted twenty-one later emotes as retries).
        const workKey = workKeyOf({ tool: call.name, argumentsOfCall: call.arguments, answer });
        if (refusedKeys.has(workKey)) {
          refusedResubmissions += 1;
          bundleRefusedResubmissions += 1;
          retriedKeys.set(workKey, (retriedKeys.get(workKey) ?? 0) + 1);
          refusedKeys.set(workKey, refusedKeys.get(workKey) + 1);
        } else if (outcome.kind === "refused") {
          refusedKeys.set(workKey, 1);
        }
        if (outcome.kind === "changed") refusedKeys.clear();
        if (
          outcome.kind === "changed" ||
          outcome.kind === "refused" ||
          outcome.kind === "no_change" ||
          outcome.kind === "not_measured"
        )
          readsSinceAction = new Map();
        if (outcome.kind === "no_receipt") {
          const key = `${call.name}:${selectionOf(call.arguments)}`;
          reads.set(call.name, (reads.get(call.name) ?? 0) + 1);
          // A READ WITH NO RECORDED SELECTION IS NOT COMPARABLE. Older records carry no `arguments` for
          // a tool, and counting them all as "the same selection" turned 5 000 unrecorded reads into 166
          // repeated ones when this was first run over the corpus. An unknown selection is printed apart
          // and never narrowed to a repeat.
          const knownSelection = call.arguments !== null && typeof call.arguments === "object" && Object.keys(call.arguments).length > 0;
          if (!knownSelection) {
            readsWithoutSelection += 1;
            readsSinceAction = new Map();
          } else {
            if (readsSinceAction.has(key)) {
              repeatedReads += 1;
              bundleRepeatedReads += 1;
              repeatedReadKeys.set(key, (repeatedReadKeys.get(key) ?? 0) + 1);
              entry.repeatsTurn = readsSinceAction.get(key);
            }
            readsSinceAction.set(key, turn);
          }
        }
      }
      if (classified.length === 0) {
        turns.withoutSubmission += 1;
        continue;
      }
      turns.withSubmission += 1;
      bundleTurns += 1;
      const notMeasured = classified.filter((entry) => entry.outcome.kind === "not_measured");
      if (notMeasured.length > 0) {
        for (const entry of notMeasured)
          notMeasuredByCause.set(
            entry.outcome.why,
            (notMeasuredByCause.get(entry.outcome.why) ?? 0) + 1,
          );
        continue;
      }
      if (classified.every((entry) => entry.outcome.kind !== "changed")) {
        emptyTurns += 1;
        bundleEmpty += 1;
        bundleEmptyTurns.push(emptyTurnOf({ turn, classified }));
        for (const entry of classified) {
          const cause = causeOf(entry);
          byCause.set(cause, (byCause.get(cause) ?? 0) + 1);
        }
      }
    }
    bundleReadings.push(
      Object.freeze({
        bundle: directory,
        turns: bundleTurns,
        empty: bundleEmpty,
        emptyTurns: Object.freeze(bundleEmptyTurns),
        refusedResubmissions: bundleRefusedResubmissions,
        repeatedReads: bundleRepeatedReads,
        share: bundleTurns === 0 ? null : Math.round((bundleEmpty / bundleTurns) * 1000) / 1000,
      }),
    );
  }
  const notMeasuredSubmissionTotal = [...notMeasuredByCause.values()].reduce((total, count) => total + count, 0);
  const share = turns.withSubmission === 0 ? null : Math.round((emptyTurns / turns.withSubmission) * 1000) / 1000;
  const judgeable = bundleReadings
    .filter((reading) => reading.turns >= TURN_WASTE_POPULATION_FLOOR)
    .sort((left, right) => right.share - left.share);
  // THE VERDICT JUDGES THE DAY JUST RUN, not the corpus: a lane checks the run it just made, and a
  // ceiling applied to all history is a ceiling over other people's days (measured 2026-11-24: 74 of the
  // 106 recorded runs sit above 0.5, all of them 2026-10 runs whose turns were reads). The corpus
  // numbers are printed beside it so nothing is hidden.
  const newest = [...bundleReadings]
    .filter((reading) => reading.turns >= TURN_WASTE_POPULATION_FLOOR)
    .sort((left, right) => (left.bundle < right.bundle ? 1 : -1))[0] ?? null;
  return Object.freeze({
    bundleRoot: root,
    status: turns.examined === 0 ? "no_turns" : "measured",
    bundles: directories.length,
    bundlesWithRecord,
    withoutRecord: Object.freeze(withoutRecord),
    turns: Object.freeze(turns),
    submissions: Object.freeze(submissions),
    empty: Object.freeze({ turns: emptyTurns, byCause: Object.freeze(Object.fromEntries([...byCause.entries()].sort())) }),
    refusedResubmissions,
    refusedResubmissionKeys: Object.freeze(
      [...retriedKeys.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
    ),
    repeatedReads,
    repeatedReadKeys: Object.freeze([...repeatedReadKeys.entries()]),
    reads: Object.freeze({ examined: [...reads.values()].reduce((total, count) => total + count, 0), byTool: Object.freeze(Object.fromEntries([...reads.entries()].sort())) }),
    readsWithoutSelection,
    notMeasured: Object.freeze({
      submissions: notMeasuredSubmissionTotal,
      byCause: Object.freeze(Object.fromEntries([...notMeasuredByCause.entries()].sort())),
    }),
    // THE RUN IS THE UNIT: a share over a whole corpus mixes a day that read its way through the map
    // with one that worked, so the verdict judges the MOST RECENT judgeable run and the corpus number is
    // printed beside it for context (measured 2026-11-24: 74 of the 106 recorded runs sit above 0.5, all
    // of them 2026-10 runs whose turns were reads, so a corpus ceiling would be red on history forever).
    bundlesJudged: judgeable.length,
    judged: Object.freeze(judgeable.slice(0, 10)),
    newest,
    share,
  });
}

/** The verdict: the most recent judgeable run's empty-turn share against the ceiling. */
export function compareTurnWaste({ measurement, ceiling = TURN_WASTE_CEILING } = {}) {
  if (measurement.status === "no_bundle_root") return Object.freeze({ kind: "blocked", why: "no_bundle_root" });
  if (measurement.status === "no_turns") return Object.freeze({ kind: "blocked", why: "no_turns" });
  if (measurement.bundlesJudged === 0)
    return Object.freeze({ kind: "insufficient_population", turns: measurement.turns.withSubmission });
  if (measurement.newest.share > ceiling)
    return Object.freeze({ kind: "above", share: measurement.newest.share, ceiling, bundle: measurement.newest.bundle });
  return Object.freeze({ kind: "ok", share: measurement.newest.share, ceiling, bundle: measurement.newest.bundle });
}

/** The evidence under the three numbers: what made the empty turns empty, and each retry and each re-read by name. */
function detailLines(measurement) {
  const lines = [];
  const causes = Object.entries(measurement.empty.byCause)
    .map(([cause, count]) => `${cause}:${String(count)}`)
    .join(", ");
  lines.push(`  the submissions inside them (every run in the population), by cause: ${causes.length === 0 ? "none" : causes}`);
  for (const [key, count] of measurement.refusedResubmissionKeys)
    lines.push(`  refused resubmission: ${key} re-sent ${String(count)} time(s) while nothing had moved`);
  for (const [key, count] of measurement.repeatedReadKeys)
    lines.push(`  repeated read: ${key} re-read ${String(count)} time(s) with no action between`);
  if (measurement.readsWithoutSelection > 0)
    lines.push(
      `  reads with no recorded selection: ${String(measurement.readsWithoutSelection)} - not comparable, so never counted as a repeat`,
    );
  if (measurement.notMeasured.submissions > 0)
    lines.push(
      `turn_waste_not_measured: ${String(measurement.notMeasured.submissions)} submission(s) the artifacts cannot decide, ` +
        `kept out of the share: ${Object.entries(measurement.notMeasured.byCause)
          .map(([why, count]) => `${why}:${String(count)}`)
          .join(", ")}`,
    );
  return lines;
}

/**
 * The judged run's empty turns, NAMED AND GROUPED BY CAUSE, printed on a green run as well as a red one.
 *
 * A share tells a lane how much of the day bought nothing and never which turns did; the number that is
 * worth acting on is `turn 12 stardew_plan_work(move_to_tile,enter_exit) policy_identity_mismatch`, because
 * it names the turn in the session record, the work that was asked for, and the code the answer gave. Reads
 * carry no code - they cannot change anything by construction - so their line is the turn and the tool.
 */
function memberLines(reading) {
  const groups = new Map();
  let members = 0;
  // A turn that submitted the same thing twice under the same cause is ONE offender named once, with the
  // count beside it - `turn 1 stardew_look_up · turn 1 stardew_look_up` reads as a defect in the printout.
  const named = new Map();
  for (const turn of reading.emptyTurns ?? []) {
    for (const submission of turn.submissions) {
      members += 1;
      if (!groups.has(submission.cause)) groups.set(submission.cause, []);
      const code =
        submission.code === null
          ? submission.cause.startsWith("no_receipt")
            ? ""
            : " (no code in the answer)"
          : ` ${submission.code}`;
      const repeats =
        submission.repeatsTurn === null || submission.repeatsTurn === undefined
          ? ""
          : ` (repeats turn ${String(submission.repeatsTurn)})`;
      const line = `turn ${String(turn.turn)} ${submission.submitted}${code}${repeats}`;
      const key = `${submission.cause}\u0000${line}`;
      const seen = named.get(key);
      if (seen === undefined) {
        const entry = { line, count: 1 };
        named.set(key, entry);
        groups.get(submission.cause).push(entry);
      } else seen.count += 1;
    }
  }
  if (groups.size === 0) return [`  empty turns of the judged run: none, so there is no offender to name`];
  const lines = [
    `  empty turns of the judged run (${String(reading.empty)} turn(s), ${String(members)} submission(s)), by cause:`,
  ];
  const ordered = [...groups.entries()].sort((left, right) =>
    right[1].length === left[1].length ? (left[0] < right[0] ? -1 : 1) : right[1].length - left[1].length,
  );
  for (const [cause, entries] of ordered)
    lines.push(
      `    ${cause} ${String(entries.reduce((total, entry) => total + entry.count, 0))}: ` +
        entries.map((entry) => (entry.count === 1 ? entry.line : `${entry.line} (×${String(entry.count)})`)).join(" · "),
    );
  return lines;
}

/** Everything the gate prints for this section, and whether it failed. */
export function renderTurnWaste({ measurement, verdict, bundleRoot }) {
  const lines = [];
  const withoutRecord = measurement.withoutRecord.length === 0 ? "" : ` · without a session record ${String(measurement.withoutRecord.length)}`;
  lines.push(
    `turn_waste_population: bundleRoot=${bundleRoot} bundles=${String(measurement.bundles)} ` +
      `bundles with a session record ${String(measurement.bundlesWithRecord)}${withoutRecord} · ` +
      `turns examined ${String(measurement.turns.examined)} (with a submission ${String(measurement.turns.withSubmission)} · ` +
      `spoke or said nothing ${String(measurement.turns.withoutSubmission)}) · submissions ${String(measurement.submissions.examined)} · ` +
      `reads ${String(measurement.reads.examined)}`,
  );
  if (verdict.kind === "blocked") {
    lines.push(`turn_waste_blocked: ${verdict.why} at ${bundleRoot} - nothing was read, and this line is not a pass`);
    return { lines, failed: false };
  }
  if (verdict.kind === "insufficient_population") {
    lines.push(
      `turn_waste: empty turns ${String(measurement.empty.turns)} of ${String(verdict.turns)}· ` +
        `refused resubmissions ${String(measurement.refusedResubmissions)} · repeated identical reads ${String(measurement.repeatedReads)}`,
    );
    lines.push(...detailLines(measurement));
    lines.push(
      `turn_waste_too_few_turns: ${String(verdict.turns)} turns with a submission is below the ${String(TURN_WASTE_POPULATION_FLOOR)} ` +
        "this reading needs, so the counts above are printed and no share is published",
    );
    return { lines, failed: false };
  }
  lines.push(
    `turn_waste: empty turns ${String(measurement.empty.turns)} of ${String(measurement.turns.withSubmission)} = ` +
      `${((measurement.share ?? 0) * 100).toFixed(1)}% (every run in the population) · refused resubmissions ${String(measurement.refusedResubmissions)} · ` +
      `repeated identical reads ${String(measurement.repeatedReads)}`,
  );
  for (const reading of measurement.judged.slice(0, 3))
    lines.push(
      `  worst run: ${reading.bundle.split(/[\\/]/u).pop()} ${String(reading.empty)} of ${String(reading.turns)} = ` +
        `${((reading.share ?? 0) * 100).toFixed(1)}%`,
    );
  lines.push(
    `  judged run: ${verdict.bundle.split(/[\\/]/u).pop()} ${String(measurement.newest.empty)} of ` +
      `${String(measurement.newest.turns)} = ${((verdict.share ?? 0) * 100).toFixed(1)}% (the most recent run in this population)`,
  );
  lines.push(...memberLines(measurement.newest));
  lines.push(...detailLines(measurement));
  if (verdict.kind === "ok") {
    lines.push(
      `turn_waste_ok runs=${String(measurement.bundlesJudged)} judged=${String(verdict.share)} ceiling=${String(verdict.ceiling)}`,
    );
    return { lines, failed: false };
  }
  lines.push(
    `turn_waste_above_ceiling:${String(verdict.share)}:${String(verdict.ceiling)} runs=${String(measurement.bundlesJudged)} ` +
      `run=${String(verdict.bundle.split(/[\\/]/u).pop())} - this share of that day's working turns bought nothing the receipts can show`,
  );
  return { lines, failed: true };
}
