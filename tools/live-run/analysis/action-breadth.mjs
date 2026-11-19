#!/usr/bin/env node
/**
 * Did this run USE the action surface it was given, or repeat the few actions that cannot go wrong?
 *
 * WHY. Measured 2026-11-07: a completed `multiday_routine` run (`round39`) published `executionTrace: { ok: true,
 * rows: 124 }` and was judged on its other clauses. It had attempted 15 distinct actions, one of them (`cut_weeds`)
 * for a quarter of its executions, and its catalog said nothing about either fact. This entry is the on-demand half of
 * the fix; the other half is the `action_breadth` clause the runner publishes in every bundle
 * (`tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs`), so a narrow run is visible in its own verdict.
 *
 * THE DENOMINATOR IS THE RUN'S OWN WORLD, NOT THE CATALOG. The first version divided by the 95 published actions; but
 * a target-bound action is only constructible while its `*Targets` family has a row in the snapshot, and the snapshot
 * is the player's own location within Chebyshev radius 6. One `FixtureScenario` string arms one world, so a run can
 * address a fraction of the catalog - and dividing by the catalog charged the companion for the fixture. The
 * denominator is now the run's own published `snapshotCensus`, joined to actions through the discovery audit's
 * `TARGET_FIELD` map, plus the actions that name no snapshot family at all.
 *
 *   node tools/live-run/analysis/action-breadth.mjs --run <runDir> [--result <result.json>] [--log <log>] [--baseline <path>]
 *
 * MID-RUN, FROM THE LOG. A run publishes `result.json` only when it ENDS, and breadth is exactly the reading that
 * matters while a run is going: a run that goes narrow looks like a run that is working. Measured 2026-11-19: `round78`
 * was stopped eleven minutes in and this tool could print nothing, although its runner log carried all 74 execution
 * receipts - ten action families, counted by hand during the audit. So every reading here is available from the log as
 * well, and each one prints WHICH FILE it read: `result.json` and the log cannot agree on a partial run (the bundle
 * holds executions that settled without a receipt), and the difference is a fact about the run, printed beside both
 * numbers, never summed into one.
 *
 * POPULATION (derived, printed, never hand-listed): the published execution actions of the Mod's registration table,
 * read through `tools/lib/stardew-published-action-registry.mjs`, minus the actions this fixture declares it cannot
 * reach (`tools/action-breadth-baseline.json` -> `exclusions`, each with the native precondition that says why).
 *
 * MEASURED: the bundle's own `attemptedActionIds` / `succeededActionIds` against its own `snapshotCensus`
 * (addressable); the per-action execution counts, joined from the program journal to the submitted candidate and, for
 * a flat-only run, from the run directory's `actionTrace.jsonl`; and the concentration the largest single action
 * holds. From the log: the same attempted/succeeded/executions/counts, keyed on the `executionId` each receipt carries,
 * with the count of identities beside the count of lines so a doubled row cannot double a number. The census is the
 * BUNDLE's fact alone, so a mid-run reading has no addressable width and says `not_measured:no_snapshot_census`.
 *
 * THE SETTLEMENT IS READ FROM THE RECEIPTS, NEVER FROM THE ROW'S EXISTENCE. Measured 2026-11-19, reading `round79`'s log
 * through this file: all NINE per-action rows printed `succeeded`, because a row was marked from the run's list of actions
 * with AT LEAST ONE success - and `move_placed_furniture` carried six executions of which four were `rejected`. A reader
 * asking how that action went was told "it worked" while four receipts said it did not. So every row now prints the
 * settlements of its OWN executions, counted once per `executionId`
 * (`executions 6 (6 distinct executionIds) · succeeded 2 · rejected 4 · uncertain 0`); every settlement a receipt names is
 * printed by name instead of being folded into a count of two; and a row with no receipt behind it says
 * `not_measured:<why>` rather than a success. `a_reading_of_success_names_the_settlement_it_read` is the gate for it: the
 * population is every per-action row this tool prints, a row that reads as an outcome without naming the settlement behind
 * it fails and is named, and `rows examined R · settled S · assumed A` says how much of that population was read.
 *
 * VERDICT: `rich` / `narrow:<reason>` / `not_measured:<missing input>`. Exit 0 for `rich`, 1 for `narrow:`, 2 for
 * `not_measured:` - a reading this tree could not take is refused rather than reported as a pass. A bundle that
 * publishes no census is `not_measured:no_snapshot_census` and is never measured against the catalog instead: the
 * numbers of the bundles that predate the census (`round38`, `round39`) are not gate verdicts and are not recorded as
 * any. A reading taken from the log is marked `partial: true`, because it is what the run had done when the log was
 * last written rather than an account of the run.
 *
 * WHAT THE DAY ASKED FOR, WHICH IS WHAT A COUNT HAS TO BE READ AGAINST. Measured 2026-11-19: `round79` was read as a
 * behavioural regression because farming, foraging, mining, social and fishing were all zero - while its day-one task was
 * `furnish_and_arrange`, whose declared action set is `place_owned_object` / `move_placed_furniture` /
 * `remove_placed_item` / `color_placed_object` / `dress_mannequin` / `set_sign_display`. She had done that work, and no
 * row in this file mentioned the day. So every row that scores what the run DID now carries `day_task=<the task>` (and
 * `day_family=yes|sibling|no` where the row is one action), each day prints `attempted X of N` beside
 * `succeeded S of E executions` - the right work, and whether it landed, kept apart - and
 * `a_reading_of_productivity_names_the_day_it_judged` fails naming any scoring row that names no day. The day's task comes
 * from the bundle's `taskPurposes`, else from the session record (the note is the player's message and the task sentence is
 * in it), else the row says `not_measured:<why>` - a run with no day task anywhere names that absence rather than inviting
 * a reader to conclude neglect.
 *
 * red-proof (this tree cannot take it): run against `E:/projects/round39/tools/_multiday_routine-round39.result.json`
 * and the reading exits 2 with `action_breadth: verdict not_measured:no_snapshot_census`. The number it used to print
 * - `attempted 15 of 95` - is the catalog denominator that charged the companion for the fixture's world.
 *
 * red-proof (history): `tools/_multiday_routine-round79-live-runner.log` read nine `succeeded` rows under the previous
 * version of this file. This one reads `move_placed_furniture ... executions 6 (6 distinct executionIds) · succeeded 2 ·
 * rejected 4 · uncertain 0` and its gate reads `rows examined 9 · settled 9 · assumed 0 · not_measured 0`.
 *
 * red-proof (productivity, this tree): the same run now prints `action_breadth_day: day 1 · day_task=furnish_and_arrange ·
 * family {place_owned_object,move_placed_furniture,remove_placed_item,color_placed_object,dress_mannequin,
 * set_sign_display}` and `action_breadth_day_family: day 1 · day_task=furnish_and_arrange day_family=yes · attempted 3 of
 * 6 · succeeded 5 of 11 executions (rejected 6)`, with `a_reading_of_productivity_names_the_day_it_judged rows examined
 * 14 · day-task named 14 · family-scored 11 · unanchored 0`. The previous version printed `attempted 9 of 101 published`
 * and every per-action row with no day in it at all (`tools/live-run/analysis/action-breadth.test.mjs`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatActionBreadth,
  measureActionBreadth,
  readActionBreadthBaseline,
  readActionBreadthSurface,
} from "../../lib/action-breadth.mjs";
import {
  actionExecutions,
  actionStates,
  attemptedActions,
  describeRunnerLog,
  locateRunnerLog,
  readRunnerLog,
  succeededActions,
} from "../../lib/live-runner-log.mjs";
// What a day of a multiday run was ASKED for: the rotation, the task's declared action set, and the sentences the runner
// writes a day's note from. Read by import, never parsed out of their text, so a task added tomorrow is anchored today.
import { DAILY_TASK_ACTION_HINTS, sweepTaskPrompts } from "../../lib/multiday-daily-tasks.mjs";
import { createReadingLedger, FROM_RESULT, FROM_RUNNER_LOG } from "../../lib/reading-source.mjs";
import { readStardewActionFamilies } from "../../lib/stardew-published-action-registry.mjs";
// The one definition of what a program execution IS, so this reading cannot count a redelivered journal event twice
// while the run's own manifest counted it once.
import { programExecutionRows } from "../game/execution-trace.mjs";

/**
 * Every line this tool prints, kept as well as printed.
 *
 * `productivityGate` reads the SAME text the reader sees rather than a caller's intention - the rule
 * `reading-source.mjs` already holds every reading to, applied to the one judgement this tool makes about her work.
 */
const PRINTED = [];

function out(line) {
  PRINTED.push(line);
  process.stdout.write(`${line}\n`);
}

/** The settlements every per-action row prints by name, in the order a reader asks about them. */
const NAMED_SETTLEMENTS = Object.freeze(["succeeded", "rejected", "uncertain"]);

/** A receipt that recorded no state: an execution whose settlement nobody wrote down, kept visible, never rounded. */
const UNCLASSIFIED_SETTLEMENT = "no_state";

/** Why a row carries no settlement: no receipt was read for it, so no execution of it can be placed. */
const NO_SETTLEMENT_READ = "no_per_execution_settlement_read";

/** The gate: every per-action row names the settlement it read, or says that it could not read one. */
const SETTLEMENT_GATE = "a_reading_of_success_names_the_settlement_it_read";

const SETTLED_ROW = /succeeded \d+ · rejected \d+ · uncertain \d+/u;
const ABSENT_ROW = /settlement not_measured:\S+/u;

function parseArgs(argv) {
  const options = { result: null, run: null, logPath: null, logDir: null, baselinePath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--result") options.result = argv[(index += 1)] ?? null;
    else if (argv[index] === "--run") options.run = argv[(index += 1)] ?? null;
    else if (argv[index] === "--log") options.logPath = argv[(index += 1)] ?? null;
    else if (argv[index] === "--log-dir") options.logDir = argv[(index += 1)] ?? null;
    else if (argv[index] === "--baseline") options.baselinePath = argv[(index += 1)] ?? undefined;
  }
  return options;
}

/** One run directory's flat request frames: the only place a flat dispatch's action id is recorded. */
async function readFlatActionRows(runDir) {
  if (typeof runDir !== "string" || runDir.length === 0) return null;
  const path = join(runDir, "actionTrace.jsonl");
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** One receipt's settlement, with a receipt that recorded none kept visible instead of being counted as a success. */
function settlementOf(state) {
  return typeof state === "string" && state.length > 0 ? state : UNCLASSIFIED_SETTLEMENT;
}

/**
 * Per action, the settlement of each of its executions, keyed on the identity the producer gave it.
 *
 * The receipts are `live-runner-log.mjs`'s own rows, already deduplicated on the `executionId` each one carries, and the
 * identity is kept as the KEY rather than as a counter here: a receipt written twice in the log is one execution, so it
 * can neither add an execution nor a settlement to the row that names it.
 */
export function settlementsByAction(log) {
  const byAction = new Map();
  for (const receipt of log.receipts) {
    if (receipt.actionId === null) continue;
    const executions = byAction.get(receipt.actionId) ?? new Map();
    if (!executions.has(receipt.identity)) executions.set(receipt.identity, settlementOf(receipt.state));
    byAction.set(receipt.actionId, executions);
  }
  return byAction;
}

/** How many executions reached each settlement. */
function settlementCounts(executions) {
  const counts = new Map();
  for (const settlement of executions.values()) counts.set(settlement, (counts.get(settlement) ?? 0) + 1);
  return counts;
}

/**
 * The settlements as text: the three that must stay apart first, then every other settlement a receipt named, by name.
 *
 * The three are printed even when zero, because "no refusal" and "nobody recorded a settlement" are different answers
 * and a row that omitted its zeroes would let a reader supply one. Anything this file did not anticipate (`failed`,
 * `cancelled`, `no_state`) is appended by name rather than added into one of the three - a count of two states would be
 * the same defect this row exists to end.
 */
function settlementLine(counts) {
  const named = NAMED_SETTLEMENTS.map((state) => `${state} ${String(counts.get(state) ?? 0)}`);
  const other = [...counts.keys()]
    .filter((settlement) => !NAMED_SETTLEMENTS.includes(settlement))
    .sort()
    .map((settlement) => `${settlement} ${String(counts.get(settlement))}`);
  return [...named, ...other].join(" · ");
}

/**
 * Every per-action row, each beside the settlements its own executions carry - and each row returned for the gate.
 *
 * `settlements` is per-action identity maps read from the run's receipts, or `null` when no receipt answered this run (a
 * bundle on its own publishes no per-execution settlement). A null settlement is printed as `not_measured`, never as a
 * success: the row still says how many executions the run counted, which is a different fact from how they went.
 *
 * Every row names the day it is judged against (`day_task=`) and whether the action is one that day asked for
 * (`day_family=`): `express_emote 14` on a `furnish_and_arrange` day is fourteen executions of something the day did not
 * ask for, and a reader told only "14 executions" has to guess whether the day's work was skipped or the reading is.
 */
function reportPerAction(breadth, settlements, dayReading) {
  const anchor = dayTaskAnchor(dayReading);
  const rows = [];
  for (const row of breadth.perAction) {
    const marks = [
      row.excluded ? "excluded" : null,
      row.withheld === null || row.withheld === undefined
        ? row.addressable === null
          ? null
          : row.addressable
            ? "addressable"
            : "outside_addressable"
        : `withheld:${row.withheld}`,
    ].filter((mark) => mark !== null);
    const executions = settlements === null ? null : (settlements.get(row.actionId) ?? null);
    const counted =
      executions === null
        ? `executions ${String(row.executions)} · settlement not_measured:${NO_SETTLEMENT_READ}`
        : `executions ${String(row.executions)} (${String(executions.size)} distinct executionIds) · ${settlementLine(settlementCounts(executions))}`;
    const reading = `action_breadth_action:${row.actionId}`;
    const text = `action_breadth_action: ${row.actionId} family=${row.family} ${counted}${marks.length === 0 ? "" : ` ${marks.join(" ")}`} · ${anchor} day_family=${dayFamilyOf(dayReading, row.actionId)}`;
    rows.push({ reading, line: text });
    out(text);
  }
  return rows;
}

/**
 * The whole log's settlements, beside the identity population they were counted on.
 *
 * `actionStates` is `live-runner-log.mjs`'s own count, already keyed on the identity each receipt carries, so this line
 * and the per-action rows can never disagree about one execution: a log whose receipt appears twice prints one identity,
 * not two settlements.
 */
function logSettlementLine(log) {
  const identities = log.counts.receipts;
  return `${String(identities)} executions (${String(identities)} distinct executionIds) · ${settlementLine(actionStates(log))}`;
}

/**
 * The gate: every per-action row either names the settlement it read, or says that it could not read one.
 *
 * THE POPULATION IS EVERY ROW, and the failure is the one fact this file got wrong: `move_placed_furniture` printed
 * `succeeded` beside six executions of which four were `rejected`, because a row's outcome was read from a list of
 * actions rather than from the settlements its own receipts carry. So a row is one of three things - it names the
 * settlements it counted (`succeeded 2 · rejected 4`), it states `not_measured:<why>`, or it is ASSUMED: printed as an
 * outcome with no receipt behind it. Every assumed row fails and is named, and a population of zero is blocked rather
 * than passed, because a gate that examined nothing agrees with itself.
 */
export function settlementGate(rows) {
  const findings = [];
  let settled = 0;
  let assumed = 0;
  let absent = 0;
  for (const row of rows) {
    if (SETTLED_ROW.test(row.line)) {
      settled += 1;
      continue;
    }
    if (ABSENT_ROW.test(row.line)) {
      absent += 1;
      continue;
    }
    assumed += 1;
    findings.push(
      `${SETTLEMENT_GATE}:${row.reading} - this row reads as an outcome and names no settlement behind it (${row.line.trim()}); count what each of its executions settled, or say not_measured:<why>`,
    );
  }
  if (rows.length === 0)
    findings.push(
      `${SETTLEMENT_GATE}:blocked - rows examined 0 · settled 0 · assumed 0 · not_measured 0 · this tool printed no per-action row, so this gate would agree with itself`,
    );
  const lines = [
    ...findings,
    `${SETTLEMENT_GATE} rows examined ${String(rows.length)} · settled ${String(settled)} · assumed ${String(assumed)} · not_measured ${String(absent)}`,
  ];
  return Object.freeze({ lines, failed: assumed > 0 || rows.length === 0 });
}

// ---------------------------------------------------------------------------------------------------------------------
// WHAT THE DAY ASKED FOR, printed beside what she did.
//
// Measured 2026-11-19 (`round79`): the run was read as a behavioural regression because farming, foraging, mining, social
// and fishing were all zero - while her day-one task was `furnish_and_arrange`, one of the rotation's days in
// `tools/lib/multiday-daily-tasks.mjs`, whose declared action set is `place_owned_object` / `move_placed_furniture` /
// `remove_placed_item` / `color_placed_object` / `dress_mannequin` / `set_sign_display`. She had done that work
// (`place_owned_object 3 · move_placed_furniture 6 · color_placed_object 2 · rotate_furniture 4`), and no reading in this
// tree said so: every row scored an action count with no statement of what the day had asked for. So every row that
// scores what a run DID now carries `day_task=<the task>` - and `day_family=yes|sibling|no` where the row is one action -
// and the
// gate below fails naming any row that scores an action count and names no day.
//
// THE TWO NUMBERS ARE SEPARATE, and that is the whole point. `attempted 3 of 6` answers "was this the right work";
// `succeeded 5 of 11 executions` answers "did the work land". A day that did the wrong work and a day that did the right
// work badly are different findings, and one number cannot state both - so neither is derived from the other, and no
// threshold is touched by any of this. A day whose task names no farm action is CORRECT with a farm count of zero, and
// `dayBlockShape` says so in those words rather than leaving a reader to infer neglect.
//
// WHERE THE DAY'S TASK COMES FROM, in the order a reader can trust: the bundle's own `taskPurposes` (the run's
// declaration of what each day was asked); else the session record, because a day's note IS the player's message and the
// task sentence is in it - found under the run directory (a captured copy) or, for a run that never captured, under the
// runtime root the log's own `RUN_ROOT` line names; else `not_measured:<why>` naming which file was missing. A run with
// no bundle has not ended, so a reading taken from its session is PARTIAL exactly like every other reading taken without
// `result.json`, and it says so on its own line.

/** The gate: a row that scores what the run did names the day it judged. */
const PRODUCTIVITY_GATE = "a_reading_of_productivity_names_the_day_it_judged";

/**
 * A row that scores what the run DID: a count of its actions, of their executions, or of the families they reached.
 *
 * The pattern IS the population, so a row added tomorrow is examined without editing this. What it excludes by
 * construction are the two counts that are not statements about her day: the CATALOG (`population 101 published`) and the
 * LOG's own arithmetic (`41 executions keyed on the executionId each receipt carries`), which measures the log's
 * bookkeeping rather than the run's work.
 */
const ACTION_COUNT_ROW =
  /\b(?:attempted \d+|\d+ attempted) of (?:\d+|not_measured)|\bexecutions? (?:\(\d+|\d+ \()|\bexecutions [a-z]+ +\d+ of \d+|\bfamilies \d+ of \d+|concentration \S+ \d+/u;

const DAY_TASK_ANCHOR = /day_task=(\S+)/u;
const DAY_FAMILY_ANCHOR = /day_family=(?:yes|sibling|no)\b/u;
const NOT_MEASURED = "not_measured:";

/** The Mod families a reader means when they ask "why is the farm count zero". */
const FIELD_FAMILIES = Object.freeze(["farming_crops", "resource_gathering", "animals_pets"]);

/** Where the runner declares the sentence each task is asked in, and how a day's note is composed from it. */
const RUNNER_SOURCE = new URL("../game/run-stardew-native-local-agent-ab-live.mjs", import.meta.url);

/** One `const NAME = …;` declaration out of a source, by bracket matching: the runner never loads here. */
function runnerConstant(source, name) {
  const at = source.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`runner_declaration_missing:${name}`);
  let depth = 0;
  for (let index = at; index < source.length; index += 1) {
    const char = source[index];
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === ";" && depth === 0) return source.slice(at, index + 1);
  }
  throw new Error(`runner_declaration_unterminated:${name}`);
}

/**
 * The sentence each task is asked in, both locales, read from the runner's OWN tables.
 *
 * The tables are the runner's because the runner is what composes a day's note, and a second copy here would be a second
 * spelling of the same sentence - the defect a task table grown by a spread already caused once (`town_errand`, whose
 * missing key was handed to a whole day as the literal string "undefined"). The literals are evaluated with
 * `sweepTaskPrompts` bound, which is how the sweep tasks' own sentences arrive without being listed twice.
 */
export function readTaskPrompts() {
  const source = readFileSync(RUNNER_SOURCE, "utf8");
  const literals = ["DAILY_TASK_PROMPT_ZH", "DAILY_TASK_PROMPT_EN"].map((name) => runnerConstant(source, name));
  const build = new Function(
    "sweepTaskPrompts",
    `${literals.join("\n")}\nreturn { DAILY_TASK_PROMPT_ZH, DAILY_TASK_PROMPT_EN };`,
  );
  const { DAILY_TASK_PROMPT_ZH, DAILY_TASK_PROMPT_EN } = build(sweepTaskPrompts);
  return Object.freeze({ zh: DAILY_TASK_PROMPT_ZH, en: DAILY_TASK_PROMPT_EN });
}

/** The published action ids a task names - the set the day is judged against, or `null` for a task this tree does not declare. */
export function taskActions(taskId) {
  const actions = DAILY_TASK_ACTION_HINTS[taskId];
  return Array.isArray(actions) ? Object.freeze([...actions]) : null;
}

/** What each day of this run was asked to do, as the run's own bundle declares it. */
export function dayTasksFromBundle(result) {
  const purposes = Array.isArray(result?.taskPurposes) ? result.taskPurposes : [];
  const tasks = [];
  for (const [index, entry] of purposes.entries()) {
    const task = typeof entry?.task === "string" ? entry.task : typeof entry?.taskId === "string" ? entry.taskId : null;
    if (task === null) continue;
    tasks.push(Object.freeze({ day: Number.isInteger(entry.day) ? entry.day : index + 1, task }));
  }
  return Object.freeze(tasks);
}

/**
 * What each day of this run was asked to do, as the session record states it.
 *
 * A day's note is a player message, and the task is the sentence the runner put in its mouth - so the task id is
 * recovered by finding the ONE task whose sentence the message carries, in either locale. A message carrying none is not
 * a day note (the fact pump's own turns are user messages too) and a message carrying two is ambiguous and refused;
 * both are skipped rather than guessed, and the note delivered twice for one day counts once.
 *
 * The day number is the position of the note: day 1 is the first note the record carries.
 */
export function dayTasksFromSession(text, prompts) {
  const known = Object.keys(DAILY_TASK_ACTION_HINTS);
  const tasks = [];
  for (const line of String(text).split(/\r?\n/u)) {
    if (line.trim().length === 0 || !line.includes('"role":"user"')) continue;
    // The pump's batches are user messages as well; none of them carries a day's note.
    if (line.includes("gamebuddy_fact_batch")) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const message = record?.message ?? record;
    if (message?.role !== "user") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const messageText = parts
      .filter((part) => typeof part === "string" || part?.type === "text")
      .map((part) => (typeof part === "string" ? part : part.text))
      .join("\n");
    const matched = known.filter((taskId) => {
      for (const locale of ["zh", "en"]) {
        const sentence = prompts?.[locale]?.[taskId];
        if (typeof sentence === "string" && sentence.trim().length > 0 && messageText.includes(sentence.trim()))
          return true;
      }
      return false;
    });
    if (matched.length !== 1) continue;
    if (tasks.length > 0 && tasks[tasks.length - 1].task === matched[0]) continue;
    // The instant the note arrived: the only boundary an execution can be placed on a day by, and it is the run's own
    // clock - the same clock the receipts carry.
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
    tasks.push(Object.freeze({ day: tasks.length + 1, task: matched[0], at: Number.isFinite(at) ? at : null }));
  }
  return Object.freeze(tasks);
}

/** How far a session record's own write time may sit from the run's window and still be that run's. */
const SESSION_WINDOW_MS = 60_000;

/** Every session record under `root`, restricted to the window this run was writing in. */
function sessionFilesUnder(root, { sinceMs = null, untilMs = null } = {}) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      if (!full.replaceAll("\\", "/").includes("surface-sessions")) continue;
      if (sinceMs !== null && untilMs !== null) {
        const modified = statSync(full).mtimeMs;
        if (modified < sinceMs || modified > untilMs) continue;
      }
      found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

/** The runtime root the log itself names: `RUN_ROOT {"runtimeRoot":"…"}`. */
export function runtimeRootFromLog(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith("RUN_ROOT ")) continue;
    try {
      const parsed = JSON.parse(line.slice("RUN_ROOT ".length));
      if (typeof parsed?.runtimeRoot === "string" && parsed.runtimeRoot.length > 0) return parsed.runtimeRoot;
    } catch {}
  }
  return null;
}

/**
 * The session record this run wrote, and where it was found.
 *
 * Two places and no third: the capture inside the run directory (a finished run copies its runtime root there, and a
 * session inside a run directory is that run's by construction), and - for a run that never captured - the runtime root
 * the log names, restricted to the window between the log's first and last instants, because a runtime root holds the
 * sessions of every run that used it. Two candidates inside the window is refused rather than resolved, for the reason
 * `locateRunnerLog` refuses: picking one would be a coin toss over which run was read.
 */
export function findRunSession({ runDir, log }) {
  const sinceMs = Number.isFinite(log?.firstAtMs) ? log.firstAtMs - SESSION_WINDOW_MS : null;
  const untilMs = Number.isFinite(log?.lastAtMs) ? log.lastAtMs + SESSION_WINDOW_MS : null;
  const captured = typeof runDir === "string" && runDir.length > 0 ? sessionFilesUnder(runDir) : [];
  if (captured.length === 1)
    return Object.freeze({ path: captured[0], how: "the copy captured in this run directory", why: null });
  if (captured.length > 1)
    return Object.freeze({
      path: null,
      how: null,
      why: `${String(captured.length)} session records overlap this run under ${runDir}, so which one it wrote is not decidable here`,
    });
  const runtimeRoot = log === null || log === undefined ? null : runtimeRootFromLog(log.path);
  if (runtimeRoot === null)
    return Object.freeze({
      path: null,
      how: null,
      why: "this run's log names no RUN_ROOT, so the runtime root that holds its session record is unknown",
    });
  const contexts = join(runtimeRoot, "contexts");
  const live = existsSync(contexts) ? sessionFilesUnder(contexts, { sinceMs, untilMs }) : [];
  if (live.length === 1)
    return Object.freeze({ path: live[0], how: `the runtime root this run's log names (${runtimeRoot})`, why: null });
  if (live.length > 1)
    return Object.freeze({
      path: null,
      how: null,
      why: `${String(live.length)} session records under ${contexts} were written inside this run's window, so which one it wrote is not decidable here`,
    });
  return Object.freeze({
    path: null,
    how: null,
    why: `no session record under ${contexts} was written inside this run's window (${sinceMs === null || untilMs === null ? "unknown window" : `${String(sinceMs)}..${String(untilMs)} ms`})`,
  });
}

/**
 * What each day of this run was asked to do, and which file answered.
 *
 * `source` is `result.json` or `session:<file>`; `why` says what was missing when neither answered, so the row that
 * scores her work can state the absence instead of implying neglect - and `code` is the same absence as one token, because
 * the anchor on a scoring row has to stay a single word (`day_task=not_measured:<code>`) while the sentence belongs on the
 * one line that has room for it. Nothing is inferred from the rotation's position: a run can be launched with a pinned
 * first day (`GAMEBUDDY_FIRST_DAY_TASK`), and a reading of the rotation would then be a reading of the task nobody asked
 * for.
 */
export async function readDayTasks({ result = null, log = null, runDir = null }) {
  const declared = dayTasksFromBundle(result);
  if (declared.length > 0)
    return Object.freeze({
      tasks: declared,
      source: FROM_RESULT,
      how: "the bundle's own taskPurposes",
      code: null,
      why: null,
    });
  const session = findRunSession({ runDir, log });
  if (session.path === null)
    return Object.freeze({
      tasks: Object.freeze([]),
      source: null,
      how: null,
      code: "no_task_purposes_and_no_session_record",
      why: `no result.json declares this run's days and no session record of it was found: ${session.why}`,
    });
  let prompts;
  try {
    prompts = readTaskPrompts();
  } catch (error) {
    return Object.freeze({
      tasks: Object.freeze([]),
      source: null,
      how: null,
      code: "runner_task_tables_unreadable",
      why: `${basename(session.path)} was found but the runner's task tables could not be read (${String(error instanceof Error ? error.message : error)})`,
    });
  }
  const tasks = dayTasksFromSession(await readFile(session.path, "utf8"), prompts);
  if (tasks.length === 0)
    return Object.freeze({
      tasks,
      source: null,
      how: null,
      code: "session_names_no_rotation_task",
      why: `${basename(session.path)} carries no day note naming a task in the rotation`,
    });
  return Object.freeze({ tasks, source: `session:${basename(session.path)}`, how: session.how, code: null, why: null });
}

/** The anchor every row that scores the run's work carries, or the statement that no day could be named. */
export function dayTaskAnchor(reading) {
  if (reading.tasks.length === 0) return `day_task=${NOT_MEASURED}${reading.code}`;
  return `day_task=${reading.tasks.map((entry) => entry.task).join("+")}`;
}

/**
 * How one action stands against the day's own declared set - the fact `day_family=` prints.
 *
 * `yes`: the task names it. `sibling`: the task does not name it, but it is in the same Mod family as something the task
 * does name - `rotate_furniture` on a `furnish_and_arrange` day is arranging work by the Mod's own catalog even though the
 * rotation never asks for it, and calling that `no` would read real work as none of the day's. `no`: neither.
 */
export function dayFamilyOf(reading, actionId, families = readStardewActionFamilies()) {
  const actions = reading.tasks.flatMap((entry) => taskActions(entry.task) ?? []);
  if (actions.includes(actionId)) return "yes";
  const dayFamilies = new Set(actions.map((named) => families.get(named)).filter((family) => family !== undefined));
  return dayFamilies.has(families.get(actionId)) ? "sibling" : "no";
}

/**
 * Each day's own executions, split at the instant the NEXT day's note arrived.
 *
 * The boundary is the run's own: a day's note is a message the session record timestamps, and a receipt carries the
 * `atMs` its producer stamped - one clock, two artifacts, no invented boundary. Everything before the second day's note
 * belongs to day 1 (including whatever ran before the first note), so every receipt lands somewhere.
 *
 * `null` and a reason when the split cannot be taken: the days came from a bundle (no instant per execution), a note
 * carries no timestamp, or an execution carries none - three absences told apart, never one number standing in for
 * another.
 */
export function executionsByDay(log, reading) {
  if (reading.tasks.length < 2) return Object.freeze({ days: null, why: null });
  if (log === null) return Object.freeze({ days: null, why: "no runner log to read the executions from" });
  if (reading.tasks.some((entry) => !Number.isFinite(entry.at)))
    return Object.freeze({ days: null, why: "a day's note carries no instant, so where its day began is unknown" });
  const unplaced = log.receipts.filter((receipt) => !Number.isFinite(receipt.atMs)).length;
  if (unplaced > 0)
    return Object.freeze({
      days: null,
      why: `${String(unplaced)} of the run's ${String(log.receipts.length)} executions carry no instant, so they cannot be placed on a day`,
    });
  const days = reading.tasks.map((entry, index) => {
    const next = reading.tasks[index + 1];
    const receipts = log.receipts.filter(
      (receipt) =>
        (index === 0 || receipt.atMs >= entry.at) &&
        receipt.atMs < (next === undefined ? Number.POSITIVE_INFINITY : next.at),
    );
    const executionsByAction = new Map();
    for (const receipt of receipts)
      if (receipt.actionId !== null)
        executionsByAction.set(receipt.actionId, (executionsByAction.get(receipt.actionId) ?? 0) + 1);
    return Object.freeze({ day: entry.day, executionsByAction, settlements: settlementsByAction({ receipts }) });
  });
  return Object.freeze({ days: Object.freeze(days), why: null });
}

/**
 * The two numbers per day: was this the day's work, and did it land.
 *
 * `attempted X of N` counts the day's own declared actions that ran at all, against the number the task declares -
 * coverage of the day's work. `succeeded S of E executions` counts the settlements of those actions' executions - whether
 * the work landed. Neither is derived from the other and neither is a threshold, so a day that did the right work badly
 * and a day that did the wrong work are different readings of one line.
 *
 * `perDay` is `executionsByDay`'s answer when the split could be taken; without it the run's days are read as one union
 * and the line says which artifact was missing.
 */
export function formatDayTasks(reading, { executionsByAction, settlements = null, perDay = null, familyOf = null }) {
  if (reading.tasks.length === 0) return Object.freeze({ tasks: [], families: [], siblings: [], shape: [] });
  const families = familyOf ?? readStardewActionFamilies();
  const split = perDay?.days ?? null;
  const partial = reading.source === FROM_RESULT ? "" : " (partial - this run published no result.json)";
  const taskLines = reading.tasks.map(
    (entry) =>
      `day ${String(entry.day)} · day_task=${entry.task} · family {${(taskActions(entry.task) ?? []).join(",")}} · source ${reading.source}${partial} - ${reading.how}`,
  );
  const familyLines = [];
  if (split !== null) {
    for (const [index, entry] of reading.tasks.entries()) {
      familyLines.push(
        familyLine({
          label: `day ${String(entry.day)}`,
          anchor: `day_task=${entry.task}`,
          actions: taskActions(entry.task) ?? [],
          executionsByAction: split[index].executionsByAction,
          settlements: split[index].settlements,
          scope: "this day's executions, split at the next day's note",
        }),
      );
    }
  } else if (reading.tasks.length === 1) {
    // One day: the run's executions ARE that day's, so no split is needed and none is claimed.
    familyLines.push(
      familyLine({
        label: `day ${String(reading.tasks[0].day)}`,
        anchor: `day_task=${reading.tasks[0].task}`,
        actions: taskActions(reading.tasks[0].task) ?? [],
        executionsByAction,
        settlements,
        scope: "this day, the whole run",
      }),
    );
  } else {
    familyLines.push(
      familyLine({
        label: `days ${reading.tasks.map((entry) => String(entry.day)).join(",")}`,
        anchor: dayTaskAnchor(reading),
        actions: [...new Set(reading.tasks.flatMap((entry) => taskActions(entry.task) ?? []))],
        executionsByAction,
        settlements,
        scope:
          perDay?.why === null || perDay?.why === undefined
            ? "whole run (an execution carries no day, so the run's days are read together)"
            : `whole run (${perDay.why})`,
      }),
    );
  }
  // The actions the run worked that are in the SAME Mod family as the day's work without being named by the task. Measured
  // 2026-11-19: `rotate_furniture` ran four times on `furnish_and_arrange`'s day and the task never names it, so a reader
  // counting only the declared set reads four executions of real arranging work as absent from the day.
  const named = new Set(reading.tasks.flatMap((entry) => taskActions(entry.task) ?? []));
  const dayFamilies = new Set(
    [...named].map((actionId) => families.get(actionId)).filter((family) => family !== undefined),
  );
  const siblings = [...(executionsByAction?.keys() ?? [])]
    .filter((actionId) => !named.has(actionId) && dayFamilies.has(families.get(actionId)))
    .sort(
      (left, right) =>
        (executionsByAction.get(right) ?? 0) - (executionsByAction.get(left) ?? 0) || left.localeCompare(right),
    )
    .map(
      (actionId) =>
        `${dayTaskAnchor(reading)} · ${actionId} ${String(executionsByAction.get(actionId))} executions in ${String(families.get(actionId))} - the same Mod family as the day's work, not named by the task`,
    );
  // A day that asked for no farm action and saw none is CORRECT, and a reader told only "farming 0" cannot know that. The
  // statement is derived from the day's own declared set and that day's own executions, so it cannot outlive either - and
  // it is only printable when the numbers ARE that day's: a run whose days could not be split has no per-day farm count,
  // and saying "this day ran 90" of the run's ninety would be the same false attribution one level down.
  const shape = reading.tasks.flatMap((entry, index) => {
    if (split === null && (reading.tasks.length > 1 || executionsByAction === null)) return [];
    const dayFamilySet = new Set([...(taskActions(entry.task) ?? [])].map((actionId) => families.get(actionId)));
    if (FIELD_FAMILIES.some((family) => dayFamilySet.has(family))) return [];
    const counts = split === null ? executionsByAction : split[index].executionsByAction;
    const fieldExecutions = [...(counts?.keys() ?? [])]
      .filter((actionId) => FIELD_FAMILIES.includes(families.get(actionId)))
      .reduce((total, actionId) => total + (counts.get(actionId) ?? 0), 0);
    return [
      `day ${String(entry.day)} · day_task=${entry.task} · the task names no ${FIELD_FAMILIES.join(", ")} action, and this day ran ${String(fieldExecutions)} executions in those families - that is the day's shape, not a day of work missed`,
    ];
  });
  return Object.freeze({
    tasks: Object.freeze(taskLines),
    families: Object.freeze(familyLines),
    siblings: Object.freeze(siblings),
    shape: Object.freeze(shape),
  });
}

/** One day's two numbers, as the line a reader gets. */
function familyLine({ label, anchor, actions, executionsByAction, settlements, scope }) {
  const counted = executionsByAction !== null && executionsByAction !== undefined;
  const executionsOf = (actionId) => executionsByAction?.get(actionId) ?? 0;
  const attempted = actions.filter((actionId) => executionsOf(actionId) > 0);
  const executions = actions.reduce((total, actionId) => total + executionsOf(actionId), 0);
  const counts = new Map();
  for (const actionId of actions)
    for (const settlement of (settlements?.get(actionId) ?? new Map()).values())
      counts.set(settlement, (counts.get(settlement) ?? 0) + 1);
  const other = [...counts.keys()]
    .filter((settlement) => settlement !== "succeeded" && settlement !== "rejected")
    .sort()
    .map((settlement) => ` · ${settlement} ${String(counts.get(settlement))}`)
    .join("");
  // Three states, never one: the day's actions ran (a count), no artifact counts executions per action (an absence), and
  // the executions settled without a receipt naming a settlement (a different absence). A missing count printed as `0 of
  // N` would read as "she attempted none of it", which is the verdict this line exists to avoid.
  const coverage = counted
    ? `attempted ${String(attempted.length)} of ${String(actions.length)}`
    : `attempted ${NOT_MEASURED}no_per_action_execution_count of ${String(actions.length)}`;
  const landed =
    settlements === null || settlements === undefined || !counted
      ? `succeeded ${NOT_MEASURED}${NO_SETTLEMENT_READ}${counted ? ` of ${String(executions)} executions` : ""}`
      : `succeeded ${String(counts.get("succeeded") ?? 0)} of ${String(executions)} executions (rejected ${String(counts.get("rejected") ?? 0)}${other})`;
  const missed = counted
    ? ` · not attempted ${actions.filter((actionId) => executionsOf(actionId) === 0).join(",") || "none"}`
    : "";
  return `${label} · ${anchor} day_family=yes · ${coverage} · ${landed}${missed} · scope ${scope}`;
}

/**
 * The gate: every row that scores what the run did names the day it judged.
 *
 * POPULATION: every printed row of this tool that states a count of the run's own actions, executions or families. A row
 * with no `day_task=` fails and is named - an "unproductive" verdict with no day-task beside it is a verdict about the
 * reader, not about the run. A row that says `day_task=not_measured:<why>` is neither: it states that no artifact answers
 * which day it judged, which is the honest half of the same rule (`round79` has no `result.json`; its day's task came
 * from its session record, and a run with neither would say so here). `family-scored` counts the rows judged against the
 * day's own action set, so a reader can see how much of the population the new reading reaches.
 *
 * `requireRows` is the caller's answer to whether a population of zero is a defect. For `action-breadth` it is: its rows
 * ARE its answer, and a run that printed none measured nothing. For the scorecard it is not - a battery of metrics whose
 * artifact carries no breadth figure has no scoring row to misread, and its own `not_measured` rows already say why - so
 * the zero is printed loudly and does not fail the run.
 */
export function productivityGate(lines, { requireRows = true } = {}) {
  const rows = (Array.isArray(lines) ? lines : []).filter((line) => ACTION_COUNT_ROW.test(String(line)));
  const findings = [];
  let named = 0;
  let familyScored = 0;
  let absent = 0;
  for (const line of rows) {
    const text = String(line);
    const anchor = DAY_TASK_ANCHOR.exec(text);
    if (anchor === null) {
      findings.push(
        `${PRODUCTIVITY_GATE}:${readingOf(text)} - this row scores an action count and names no day it judged (${text.trim()}); print the day's task beside it, or say day_task=not_measured:<why>`,
      );
      continue;
    }
    if (anchor[1].startsWith("not_measured")) {
      absent += 1;
      continue;
    }
    named += 1;
    if (DAY_FAMILY_ANCHOR.test(text)) familyScored += 1;
  }
  if (rows.length === 0)
    findings.push(
      `${PRODUCTIVITY_GATE}:blocked - rows examined 0 · day-task named 0 · family-scored 0 · unanchored 0 · this tool printed no row scoring an action count, so this gate would agree with itself`,
    );
  const gateLines = [
    ...findings,
    `${PRODUCTIVITY_GATE} rows examined ${String(rows.length)} · day-task named ${String(named)} · family-scored ${String(familyScored)} · unanchored ${String(rows.length - named - absent)}${absent === 0 ? "" : ` · day-task not_measured ${String(absent)}`}`,
  ];
  return Object.freeze({ lines: gateLines, failed: findings.length > 0 && (rows.length > 0 || requireRows) });
}

/** The name a failure can point at: `action_breadth_action:move_placed_furniture`, `breadth`, … */
function readingOf(line) {
  const colon = line.indexOf(":");
  if (colon > 0 && !line.slice(0, colon).includes(" ")) {
    const first =
      line
        .slice(colon + 1)
        .trim()
        .split(/\s+/u)[0] ?? "";
    return first.length === 0 ? line.slice(0, colon) : `${line.slice(0, colon)}:${first}`;
  }
  return line.trim().split(/\s+/u)[0] ?? line.trim();
}

/** A row kept as printed, with the day it judged appended when it scores the run's work. */
function anchored(line, anchor) {
  return ACTION_COUNT_ROW.test(line) ? `${line} · ${anchor}` : line;
}

/**
 * Why the addressable number is what it is, one line per family that gave the run anything to address.
 *
 * Printed beside the summary because an addressable set nobody can decompose is a number a reader has to trust: the
 * rows each family published and the actions they made constructible say which part of the world this run had.
 */
function reportAddressable(breadth) {
  const census = breadth.census ?? null;
  if (census === null) {
    out(
      "action_breadth_census: none - this run publishes no snapshotCensus, so the world it ran in cannot be read back",
    );
    return;
  }
  out(
    `action_breadth_census: ${String(census.snapshots)} snapshots from ${census.source}; ${String(census.families.filter((entry) => entry.rows > 0).length)} of ${String(census.families.length)} target families carried rows`,
  );
  for (const entry of breadth.addressableFamilies ?? [])
    out(
      `action_breadth_addressable_family: ${entry.family} rows=${String(entry.rows)} actions=${entry.actionIds.join(",")}`,
    );
  if (breadth.addressableExcluded !== null && breadth.addressableExcluded.length > 0)
    out(
      `action_breadth_addressable_excluded: ${breadth.addressableExcluded.join(",")} - addressable in this world, withheld by the baseline's declared exclusions`,
    );
  const withoutRows = census.families.filter((entry) => entry.rows === 0).map((entry) => entry.family);
  if (withoutRows.length > 0)
    out(`action_breadth_addressable_absent: ${withoutRows.join(",")} carried no row in any of the run's snapshots`);
}

/**
 * The target families the run's OWN receipts say it acted in, from the run directory's `timeline.jsonl`.
 *
 * Every Mod settlement states its chore by the family name the observation publishes (`chore=itemTargets`, …), so this is
 * the run's own statement of which families its work reached - the one reading that can tell a census which sampled too
 * little apart from a world that held nothing. Null when the run directory or its timeline is absent: a bundle without
 * one is not evidence that the census was right.
 */
async function readActedFamilies(runDir) {
  if (typeof runDir !== "string" || runDir.length === 0) return null;
  const path = join(runDir, "timeline.jsonl");
  if (!existsSync(path)) return null;
  const acted = new Map();
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const detail = entry?.worldFactPayload?.evidence?.detail ?? entry?.evidence?.detail;
    if (typeof detail !== "string") continue;
    for (const pair of detail.split(";")) {
      const index = pair.indexOf("=");
      if (index <= 0 || pair.slice(0, index) !== "chore") continue;
      const family = pair.slice(index + 1);
      if (family.length > 0) acted.set(family, (acted.get(family) ?? 0) + 1);
    }
  }
  return acted;
}

/**
 * Whether the census sampled the families the run actually worked in.
 *
 * The census is a sample of the world this run was given, so it is only as good as its sample rate: `round76` published 8
 * snapshots, and the families of its 40 successful `pickup_item`/`chop_tree`/`chop_stump` executions carried no row in any
 * of them - which reads as "she acted outside her addressable surface" when the truth is "the census never looked".
 * Each family the run's own receipts name is a family it SAW, so a zero here is our sampling gap and is reported as one.
 */
function reportCensusContact(breadth, actedFamilies) {
  const census = breadth.census ?? null;
  if (census === null || actedFamilies === null) return;
  const rowsOf = new Map(census.families.map((entry) => [entry.family, entry.rows]));
  const missed = [...actedFamilies]
    .filter(([family]) => (rowsOf.get(family) ?? 0) === 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const unsampled = [...actedFamilies.keys()].filter((family) => !rowsOf.has(family)).sort();
  if (unsampled.length > 0)
    out(
      `action_breadth_census_unmapped: ${unsampled.join(",")} carried the run's work but names no action's target family, so no denominator can join it`,
    );
  for (const [family, count] of missed)
    out(
      `action_breadth_census_gap: ${family} carried ${String(count)} of the run's own settlements but had no row in any of the ${String(census.snapshots)} snapshots the census sampled; the sample missed the frames the run really worked in`,
    );
  if (missed.length === 0 && unsampled.length === 0)
    out(
      `action_breadth_census_contact: all ${String(actedFamilies.size)} families the run worked in carried a row in its census`,
    );
}

function reportFindings(breadth, flatDispatchCount, rowsRead) {
  for (const actionId of breadth.excludedAttempted)
    out(
      `action_breadth_exclusion_stale: ${actionId} is excluded as unreachable but this run attempted it; remove the exclusion or say why it still holds`,
    );
  for (const actionId of breadth.staleExclusions)
    out(
      `action_breadth_exclusion_orphaned: ${actionId} is excluded but is no longer a published action; delete the entry`,
    );
  for (const actionId of breadth.outsidePopulation)
    out(
      `action_breadth_outside_population: ${actionId} was attempted and is not in this tree's published population; an experimental or withdrawn action is not published, so a fixture that enabled one measures against a wider surface than this ratchet records`,
    );
  for (const actionId of breadth.outsideAddressable)
    out(
      `action_breadth_outside_addressable: ${actionId} was dispatched and is not addressable in this run's own census; the census missed a family the run used, so the coverage above is measured against the wrong world`,
    );
  if (rowsRead === null && flatDispatchCount > 0)
    out(
      `action_breadth_flat_trace_unread: ${String(flatDispatchCount)} flat dispatches have no rows (no run directory or no actionTrace.jsonl), so they are unattributed to any action`,
    );
}

/** The run directory the arguments named, whichever way they named it. */
function runDirOf(options) {
  if (typeof options.run === "string" && options.run.length > 0) return resolve(options.run);
  const anchor = options.result ?? options.logPath;
  return typeof anchor === "string" && anchor.length > 0 ? dirname(resolve(anchor)) : null;
}

/**
 * The run's launch receipt: the only thing on disk that binds a run directory to the log it wrote.
 *
 * `startedAtMs` is the instant the launcher armed the directory, and the log's own first line carries the instant its
 * process started writing - which is what makes the log identifiable by CONTENT rather than by "newest".
 */
function readLaunch(runDir) {
  if (runDir === null) return null;
  const path = join(runDir, "launch.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      startedAtMs: Number.isFinite(parsed?.startedAtMs) ? parsed.startedAtMs : null,
      label: typeof parsed?.label === "string" && parsed.label.length > 0 ? parsed.label : null,
    };
  } catch {
    return null;
  }
}

/** The bundle, or the reason it cannot be read: an absent file and a broken one are two different facts. */
function readBundle(path) {
  if (path === null)
    return { value: null, path: null, why: "no --result and no run directory, so no bundle was named" };
  if (!existsSync(path)) return { value: null, path, why: `${path} does not exist` };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), path, why: null };
  } catch (error) {
    return {
      value: null,
      path,
      why: `${path} is not JSON - ${String(error instanceof Error ? error.message : error)}`,
    };
  }
}

/**
 * The reading the bundle answers, in the shape both sources fill.
 *
 * `attempted` is `null` rather than empty when the bundle does not publish it: a hand-stopped run can have a
 * `result.json` with no attempted list, and "no list" is what lets the log answer in its place instead.
 */
function bundleReading(result) {
  const value = result ?? {};
  return {
    source: FROM_RESULT,
    partial: false,
    scenario: typeof value.scenario === "string" ? value.scenario : null,
    attempted: Array.isArray(value.attemptedActionIds) ? value.attemptedActionIds : null,
    succeeded: Array.isArray(value.succeededActionIds) ? value.succeededActionIds : [],
    executions: Number.isInteger(value.executionTrace?.rows) ? value.executionTrace.rows : 0,
    programRows: programExecutionRows(value.programOutcomes ?? []),
    programSubmissions: value.programSubmissions ?? [],
    executedRows: [],
    census: value.snapshotCensus ?? null,
    flatDispatchCount: Number.isInteger(value.executionTrace?.flat) ? value.executionTrace.flat : 0,
  };
}

/**
 * The reading the runner log answers: the same questions, keyed on the identity each receipt carries.
 *
 * The census is absent here deliberately - it is the bundle's own fact about the world the run's snapshots showed it -
 * so a mid-run reading has no addressable width and says `not_measured:no_snapshot_census` rather than falling back to
 * the catalog. `executions` is the number of receipt IDENTITIES, not of receipt lines.
 */
function logReading(log) {
  return {
    source: FROM_RUNNER_LOG,
    partial: true,
    attempted: attemptedActions(log),
    succeeded: succeededActions(log),
    executions: log.counts.receipts,
    programRows: [],
    programSubmissions: [],
    executedRows: log.receipts,
    census: null,
    flatDispatchCount: 0,
  };
}

/** What the log's identities are, and what counting its lines instead would have said. */
function identityLine(log) {
  const counts = log.counts;
  return (
    `${String(counts.receipts)} executions keyed on the executionId each receipt carries, out of ${String(counts.receiptLines)} receipt lines (${String(counts.collapsedReceipts)} collapsed on that identity)` +
    ` · ${String(counts.detailInBoth)} carry the same detail in evidence.detail and worldFactPayload.evidence.detail and are read once` +
    ` · ${String(counts.submissions)} programme identities out of ${String(counts.submissionLines)} submissions (${String(counts.collapsedSubmissions)} re-submitted) naming ${String(counts.submittedNodes)} nodes`
  );
}

/**
 * The same run read twice: the bundle's counts beside the log's, and the difference named rather than reconciled.
 *
 * They CANNOT agree, and the difference is a fact: an execution that settled without publishing a receipt is in the
 * bundle and not in the log, so the log is a lower bound on executions. Summing them would count every execution that
 * did publish one twice; printing one and hiding the other would lose exactly the executions a reader is asking about.
 */
function reportBothSources({ fromBundle, fromLog, breadth, readings, log }) {
  if (fromBundle === null || fromBundle.attempted === null) return;
  readings.fromResult("action_breadth.bundle_executions", fromBundle.executions);
  readings.fromLog("action_breadth.log_executions", fromLog.executions);
  const inLog = actionExecutions(log).counts;
  const differing = [];
  for (const row of breadth.perAction) {
    const logged = inLog.get(row.actionId) ?? 0;
    if (row.executions !== logged) differing.push(`${row.actionId} ${String(row.executions)} vs ${String(logged)}`);
  }
  for (const [actionId, count] of inLog)
    if (!breadth.perAction.some((row) => row.actionId === actionId))
      differing.push(`${actionId} 0 vs ${String(count)}`);
  const executions = fromBundle.executions - fromLog.executions;
  out(
    `action_breadth_log_vs_bundle: result.json names ${String(fromBundle.attempted.length)} actions in ${String(fromBundle.executions)} executions, live-runner.log ${String(fromLog.attempted.length)} in ${String(fromLog.executions)} identities - ${String(executions)} execution(s) the bundle counts and no receipt names (the log is a lower bound); ` +
      (differing.length === 0
        ? "every per-action count agrees"
        : `${String(differing.length)} per-action count(s) differ: ${differing.join(", ")}`) +
      " - two readings of one run, never summed",
  );
}

/** The verdict's exit code, with an unsourced reading failing the run before the verdict is read. */
function exitCodeFor(breadth, gateFailed) {
  if (gateFailed) return 1;
  return breadth.verdict === "rich" ? 0 : breadth.verdict.startsWith("narrow:") ? 1 : 2;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.result === null && options.run === null && options.logPath === null) {
    out(
      "action_breadth_usage: node tools/live-run/analysis/action-breadth.mjs --run <runDir> | --result <result.json> | --log <live-runner.log> [--baseline <path>]",
    );
    process.exitCode = 2;
    return;
  }
  const readings = createReadingLedger();
  const runDir = runDirOf(options);
  const launch = readLaunch(runDir);
  const bundle = readBundle(
    options.result !== null ? resolve(options.result) : runDir === null ? null : join(runDir, "result.json"),
  );
  const located = locateRunnerLog({
    runDir,
    logPath: options.logPath,
    logDir: options.logDir,
    startedAtMs: launch?.startedAtMs ?? null,
  });
  const log = located.path === null ? null : readRunnerLog(located.path);
  if (bundle.value === null && log === null) {
    // Refuse to hand back "nothing to measure": neither record exists, and passing would be the silence the gate
    // exists to end. WHICH record was missing is the reader's first question, so both are named with their reasons.
    out(`action_breadth_refused: no reading can be taken from this run - neither a bundle nor a log was read`);
    out(`action_breadth_bundle: ${bundle.why}`);
    out(`action_breadth_log: ${located.why}`);
    for (const line of readings.lines()) out(line);
    for (const line of settlementGate([]).lines) out(line);
    for (const line of productivityGate([]).lines) out(line);
    process.exitCode = 2;
    return;
  }
  const fromBundle = bundle.value === null ? null : bundleReading(bundle.value);
  const fromLog = log === null ? null : logReading(log);
  // The bundle is the run's own account and answers first; the log speaks when the bundle is absent OR when it
  // publishes no attempted list (a hand-stopped run can have neither field), and the source line says which spoke.
  const chosen = fromBundle !== null && fromBundle.attempted !== null ? fromBundle : fromLog;
  if (chosen === null) {
    out(
      `action_breadth_refused: ${bundle.path} publishes no attemptedActionIds and no runner log answers this run; breadth cannot be measured`,
    );
    out(`action_breadth_log: ${located.why}`);
    for (const line of readings.lines()) out(line);
    for (const line of settlementGate([]).lines) out(line);
    for (const line of productivityGate([]).lines) out(line);
    process.exitCode = 2;
    return;
  }
  if (chosen.source === FROM_RESULT) {
    out(`action_breadth_source: ${FROM_RESULT} - the run's own bundle, ${bundle.path}`);
  } else {
    out(
      `action_breadth_source: live-runner.log - ${fromBundle === null ? "this run publishes no result.json" : "its result.json publishes no attemptedActionIds"}, so every reading below is taken from the runner's log the run wrote while it was running`,
    );
    out(`action_breadth_log_binding: ${located.path} - ${located.how}`);
    out(`action_breadth_log: ${describeRunnerLog(log)}`);
    out(
      `action_breadth_partial: true - no result.json in this run directory, so these readings are what the run had done when its log was last written, not a verdict on the run`,
    );
  }
  if (log !== null && chosen.source === FROM_RESULT)
    out(
      `action_breadth_log_binding: ${located.path} - ${located.how} (read as a second source, never added to the bundle's counts)`,
    );
  // The settlements come from the receipts alone, and only when the log is what answered: a row's outcome is what its own
  // executions settled, and a bundle field is a LIST OF ACTIONS, which is the fact that printed nine successes over four
  // refusals. Reading them beside a bundle's per-action counts would also put two populations on one line.
  const settlements = chosen.source === FROM_RUNNER_LOG ? settlementsByAction(log) : null;
  const surface = await readActionBreadthSurface();
  const baseline = await readActionBreadthBaseline(
    options.baselinePath === undefined ? undefined : { path: options.baselinePath },
  );
  const scenario = fromBundle?.scenario ?? launch?.label ?? null;
  const trailDir = bundle.value?.bundle?.runDir ?? bundle.value?.capture?.dir ?? runDir;
  const flatRows = await readFlatActionRows(trailDir);
  const actedFamilies = await readActedFamilies(trailDir);
  const breadth = await measureActionBreadth({
    scenario,
    attempted: chosen.attempted,
    succeeded: chosen.succeeded,
    executions: chosen.executions,
    actionRows: chosen.source === FROM_RESULT ? flatRows : null,
    programRows: chosen.programRows,
    programSubmissions: chosen.programSubmissions,
    // The receipts of the runner's log, each already keyed on the identity its producer gave it.
    executedRows: chosen.executedRows,
    // The run's own account of the world it ran in: the families its snapshots published. Absent (a bundle from
    // before this field existed, or a run that has not ended) is `not_measured:no_snapshot_census`, never a fall
    // back to the catalog.
    census: chosen.census,
    surface,
    baseline,
  });
  const reading = chosen.source;
  readings[reading === FROM_RESULT ? "fromResult" : "fromLog"]("action_breadth.attempted", breadth.attempted);
  readings[reading === FROM_RESULT ? "fromResult" : "fromLog"]("action_breadth.families", breadth.families);
  readings[reading === FROM_RESULT ? "fromResult" : "fromLog"]("action_breadth.executions", breadth.executions);
  // The addressable width is the BUNDLE's fact: the log carries no snapshot census, so a mid-run reading has none.
  readings.fromResult(
    "action_breadth.addressable",
    breadth.addressable === null ? "not_measured (the run published no snapshot census)" : breadth.addressable,
  );
  const excluded = baseline.exclusions
    .map((entry) => entry.actionId)
    .filter((actionId) => surface.actionIds.includes(actionId));
  // WHAT THE DAY ASKED FOR, before any count of what she did: the day is the frame every number below is read in, and a
  // count printed above the frame is the reading this unit exists to end.
  const dayReading = await readDayTasks({ result: bundle.value, log, runDir });
  const executionsByAction = (() => {
    const counted =
      log === null
        ? new Map(breadth.perAction.map((row) => [row.actionId, row.executions]))
        : actionExecutions(log).counts;
    // A bundle whose program journal attributed no execution to any action cannot say what ran: that is an absence, and
    // `attempted 0 of 6` would read as "she attempted none of it" - the verdict this reading exists to avoid.
    return [...counted.values()].some((count) => count > 0) ? counted : null;
  })();
  const dayBlock = formatDayTasks(dayReading, {
    executionsByAction,
    settlements,
    perDay: executionsByDay(log, dayReading),
  });
  const anchor = dayTaskAnchor(dayReading);
  if (dayBlock.tasks.length === 0) out(`action_breadth_day: ${anchor} - ${dayReading.why}`);
  for (const line of dayBlock.tasks) out(`action_breadth_day: ${line}`);
  for (const line of dayBlock.families) out(`action_breadth_day_family: ${line}`);
  for (const line of dayBlock.siblings) out(`action_breadth_day_sibling: ${line}`);
  for (const line of dayBlock.shape) out(`action_breadth_day_shape: ${line}`);
  out(
    `action_breadth_population: ${String(surface.actionIds.length)} published${excluded.length === 0 ? "" : `, excluded ${String(excluded.length)}: ${excluded.sort().join(",")}`}`,
  );
  if (chosen.source === FROM_RUNNER_LOG) {
    out(`action_breadth_identities: ${identityLine(log)}`);
    out(anchored(`action_breadth_settlements: ${logSettlementLine(log)}`, anchor));
  }
  reportAddressable(breadth);
  for (const line of formatActionBreadth(breadth)) out(anchored(line, anchor));
  out(
    `action_breadth_baseline: ${
      breadth.baseline === null
        ? `none recorded for scenario ${breadth.scenario ?? "none"}`
        : `best seen ${breadth.baseline.label} - attempted ${String(breadth.baseline.attempted)}, families ${String(breadth.baseline.families)}, addressable ${breadth.baseline.addressable === null ? "not recorded" : String(breadth.baseline.addressable)}, coverage floor ${breadth.baseline.coverageFloor === undefined ? "not recorded" : `${String(breadth.baseline.coverageFloor.attempted)} of ${String(breadth.baseline.coverageFloor.addressable)} (${String(breadth.baseline.coverageFloor.label)})`}`
    }`,
  );
  if ((breadth.baselineMissedFamilies ?? []).length > 0)
    out(
      `action_breadth_baseline_families: ${breadth.baselineMissedFamilies.join(",")} - this run's world offered these families, the recorded best worked in them, and this run did not`,
    );
  reportFindings(breadth, chosen.flatDispatchCount, chosen.source === FROM_RESULT ? flatRows : null);
  reportCensusContact(breadth, actedFamilies);
  const actionRows = reportPerAction(breadth, settlements, dayReading);
  const gate = settlementGate(actionRows);
  for (const line of gate.lines) out(line);
  if (log !== null && fromLog !== null)
    reportBothSources({
      fromBundle: fromBundle === null || fromBundle.attempted === null ? null : fromBundle,
      fromLog,
      breadth,
      readings,
      log,
    });
  if (bundle.value?.actionBreadth !== undefined && bundle.value.actionBreadth !== null) {
    // The bundle already publishes this reading (every run from this commit on does). Comparing the recorded numbers
    // against today's derivation is how a stale bundle is told apart from a moved tree.
    const recorded = bundle.value.actionBreadth;
    const agrees =
      recorded.attempted === breadth.attempted &&
      recorded.published === breadth.published &&
      (recorded.addressable ?? null) === breadth.addressable;
    out(
      `action_breadth_bundle: recorded attempted=${String(recorded.attempted)} published=${String(recorded.published)} addressable=${String(recorded.addressable ?? "none")} verdict=${String(recorded.verdict)}${agrees ? "" : " - DISAGREES with this reading"}`,
    );
  }
  out(
    `action_breadth_verdict: ${breadth.verdict}${chosen.partial ? " (partial - the run has not ended, so this is what it had done and not what it did)" : ""}`,
  );
  const productGate = productivityGate(PRINTED);
  for (const line of productGate.lines) out(line);
  for (const line of readings.lines()) out(line);
  process.exitCode = exitCodeFor(breadth, readings.failed() || gate.failed || productGate.failed);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
