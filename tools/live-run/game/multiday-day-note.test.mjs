// red-proof: inject  re-joining the player's errand and the day's task into one sentence (`我今天去镇上办事，${task}你看着办`)
//   -> `task_attributed_to_the_player:craft_and_place_machine` and `note_quotes_unbalanced:craft_and_place_machine`
//   (tools/live-run/game/multiday-day-note.test.mjs)
/**
 * THE DAY'S NOTE, JUDGED ON THE BLOCK SHE READS, FOR EVERY TASK THE TABLE CAN STATE.
 *
 * <p>
 * The defect this closes was measured on `2026-11-14`, day 1 of a `multiday_routine` run. The note's producer joined two
 * owners into one sentence - `我今天去镇上办事，${task}你看着办，…` - and the block's reader attributes PER SENTENCE
 * (exclusive first person `我` is his, everything else is hers). A sentence with two owners cannot be split by that rule,
 * and it resolved to him:
 * </p>
 *
 * <pre>
 * 他的事，不是给你做的：「桌上留着便签：“我今天去镇上办事，自己做一台机器放下去，再用起来。」
 * 给你做的：「”活干完了或者天黑累了就回床上睡，这一天才真正过去。」
 * </pre>
 *
 * <p>
 * Her own reasoning that turn: `The player left a note: they're going to town to make a machine.` She submitted nothing.
 * The quote nesting 「…“…”…」 also broke, leaving a `”` orphaned at the start of a later item - the second half of the
 * evidence, and the reason the third property below is about quotes rather than about ownership.
 * </p>
 *
 * <h2>What is asserted, and why these three</h2>
 *
 * <p>
 * The population is the prompt table's OWN keys in both locales, so a task added to the rotation without a note that can
 * be read correctly fails here rather than in a game launch. The note is composed by the scenario's own template and
 * rendered by the real block (`playerNoteLines`), and the rendered lines are what the assertions read: a rule and what
 * she reads are one thing, and a test that read the classifier would stay green while the block printed the wrong label.
 * </p>
 *
 * <ol>
 *   <li>`task_attributed_to_the_player:<task>` - the task's own sentence is inside a `他的事，不是给你做的` item, or
 *     inside no `给你做的` item at all. This is the measured failure, and the code names the task rather than the file.</li>
 *   <li>`note_text_not_preserved:<task>` - the quoted runs of the block are not the note's own characters, each exactly
 *     once, in order. Paraphrase, a dropped clause, a doubled label and an item invented out of a label all land here.</li>
 *   <li>`note_quotes_unbalanced:<task>` - an item opens a quote it does not close, or begins with a closing mark. That is
 *     how the nesting above broke, and a fragment that starts with `”` is not the player's words any more.</li>
 * </ol>
 *
 * <p>
 * The two labels are read FROM THE BLOCK (`labelsBelow`) rather than spelled here: a second hand-written copy of them
 * would agree with the block today and stop meaning anything the moment the block's wording moved. The composition below
 * therefore judges the producer against the reader's own vocabulary, which is also what keeps the scenario's labelled
 * note and the block's labels from drifting apart.
 * </p>
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { playerNoteLines } from "../../../host/dist-test/player-note.js";
import { sweepTaskPrompts } from "../../lib/multiday-daily-tasks.mjs";

const RUNNER_SOURCE = readFileSync(new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url), "utf8");

/** One `const NAME = …;` declaration out of the runner's source, by bracket matching: the runner never loads here. */
function runnerConstant(name) {
  const at = RUNNER_SOURCE.indexOf(`const ${name} =`);
  assert.ok(at !== -1, `the runner must declare ${name}`);
  let depth = 0;
  for (let index = at; index < RUNNER_SOURCE.length; index += 1) {
    const char = RUNNER_SOURCE[index];
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === ";" && depth === 0) return RUNNER_SOURCE.slice(at, index + 1);
  }
  throw new Error(`unterminated declaration for ${name}`);
}

/**
 * The task tables and the scenario's own note template, evaluated from the runner's source with the sweep prompts bound.
 *
 * The tables are read BY KEY, so their keys are the population this gate must cover. `sweepTaskPrompts` is passed in
 * because the note's own tasks are derived from the published surface, and a table grown by a spread has to grow here
 * too - a hand list of tasks would be exactly the second population that lets a new task go unread.
 */
function loadPromptTables() {
  const build = new Function(
    "sweepTaskPrompts",
    `${runnerConstant("DAILY_TASK_PROMPT_ZH")}
${runnerConstant("DAILY_TASK_PROMPT_EN")}
${runnerConstant("SCENARIO_PROMPTS")}
return { DAILY_TASK_PROMPT_ZH, DAILY_TASK_PROMPT_EN, SCENARIO_PROMPTS };`,
  );
  return build(sweepTaskPrompts);
}

/**
 * The block's two labels, asked of the block itself.
 *
 * Two notes the free-form rule cannot mistake: `我` makes him the doer, and an imperative leaves her as the only one it
 * can be. The label is everything the block prints before the first `「`.
 */
function labelsBelow() {
  const labelOf = (note) => {
    const line = playerNoteLines([note]).find((entry) => entry.includes("「"));
    assert.ok(line !== undefined, `the block must label ${JSON.stringify(note)}`);
    return line.slice(0, line.indexOf("「"));
  };
  return Object.freeze({ hisOwn: labelOf("我今天去镇上办事。"), toCompanion: labelOf("找片水，钓条鱼回来。") });
}

const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The note with its own labels taken off, so what is left is the player's and the task's characters. */
function noteOwnText(note, labels) {
  const label = new RegExp(`^(?:${escapeForRegExp(labels.hisOwn)}|${escapeForRegExp(labels.toCompanion)})`, "u");
  return note
    .split("\n")
    .map((line) => line.trim().replace(label, ""))
    .join("");
}

/** The characters inside the block's quoted runs, in order: the only place the note's own text is allowed to be. */
function quotedRuns(rendered) {
  return rendered.flatMap((line) => [...line.matchAll(/「([^」]*)」/gu)].map((match) => match[1] ?? ""));
}

const normalise = (text) => text.replace(/[\s「」]/gu, "");
const countOf = (line, mark) => [...line].filter((char) => char === mark).length;

/** An item that opens a quote it does not close, or that starts with a closing mark, is a broken quotation. */
function quoteFaults(line) {
  const faults = [];
  for (const [open, close] of [
    ["「", "」"],
    ["“", "”"],
  ])
    if (countOf(line, open) !== countOf(line, close))
      faults.push(`${open}x${String(countOf(line, open))}/${close}x${String(countOf(line, close))}`);
  for (const run of [...line.matchAll(/「([^」]*)」/gu)])
    if (/^[”」]/u.test(run[1] ?? "")) faults.push(`an item begins with a closing mark: ${JSON.stringify(run[1])}`);
  return faults;
}

test("the day's note puts the task in her own item, keeps every character once, and leaves no quote open", () => {
  const { DAILY_TASK_PROMPT_ZH, DAILY_TASK_PROMPT_EN, SCENARIO_PROMPTS } = loadPromptTables();
  const labels = labelsBelow();
  const violations = [];
  let examined = 0;
  for (const [locale, table] of [
    ["zh", DAILY_TASK_PROMPT_ZH],
    ["en", DAILY_TASK_PROMPT_EN],
  ]) {
    for (const task of Object.keys(table)) {
      examined += 1;
      const taskText = String(table[task]).trim();
      const note = SCENARIO_PROMPTS.multiday_routine[locale](1, task);
      const rendered = playerNoteLines([note]);
      const linesOf = (label) => rendered.filter((line) => line.startsWith(label));

      const hisItems = linesOf(labels.hisOwn);
      const hersItems = linesOf(labels.toCompanion);
      const inHis = hisItems.filter((line) => line.includes(taskText));
      const inHers = hersItems.filter((line) => line.includes(taskText));
      if (inHis.length > 0 || inHers.length === 0)
        violations.push(
          `task_attributed_to_the_player:${task} (${locale}: ${
            inHis.length > 0
              ? `the task is inside ${labels.hisOwn} - ${JSON.stringify(inHis[0])}`
              : `no ${labels.toCompanion} item carries it`
          })`,
        );

      const quoted = normalise(quotedRuns(rendered).join(""));
      const own = normalise(noteOwnText(note, labels));
      if (quoted !== own)
        violations.push(
          `note_text_not_preserved:${task} (${locale}: the block holds ${JSON.stringify(
            quotedRuns(rendered).join("").slice(0, 240),
          )} where the note says ${JSON.stringify(noteOwnText(note, labels).slice(0, 240))})`,
        );

      const faults = rendered.flatMap((line) => quoteFaults(line));
      if (faults.length > 0) violations.push(`note_quotes_unbalanced:${task} (${locale}: ${faults.join("; ")})`);
    }
  }
  // A population of zero agrees with itself, so it is refused rather than passed: the tables are read by key and a
  // table that could not be read would report nothing at all.
  assert.ok(examined > 0, "the task tables must state at least one task");
  process.stderr.write(
    `DAY_NOTE_GATE examined ${String(examined)} note(s) over ${String(examined / 2)} task(s), both locales\n`,
  );
  assert.deepEqual(violations, [], `the day's note is not readable as one owner per item:\n${violations.join("\n")}`);
});

/**
 * The other half, and the one that makes the first test's properties stable: the note STATES whose each part is, so the
 * block does not have to infer it from grammar.
 *
 * A composed fixture note is written by the scenario, and its ownership is known when it is written - grammar is the tool
 * for a note whose author is not present, not for one whose author is the harness. This is also the property that must
 * survive a rewrite of the free-form rule: as long as every item arrives labelled, the rule can change and the note still
 * reads correctly.
 */
test("the day's note states whose each item is, so the block never has to infer it", () => {
  const { DAILY_TASK_PROMPT_ZH, DAILY_TASK_PROMPT_EN, SCENARIO_PROMPTS } = loadPromptTables();
  const labels = labelsBelow();
  const violations = [];
  let examined = 0;
  for (const [locale, table] of [
    ["zh", DAILY_TASK_PROMPT_ZH],
    ["en", DAILY_TASK_PROMPT_EN],
  ]) {
    for (const task of Object.keys(table)) {
      examined += 1;
      const note = SCENARIO_PROMPTS.multiday_routine[locale](1, task);
      for (const line of note.split("\n").filter((entry) => entry.trim() !== ""))
        if (!line.startsWith(labels.hisOwn) && !line.startsWith(labels.toCompanion))
          violations.push(`${task} (${locale}: ${JSON.stringify(line)} states nobody's ownership)`);
    }
  }
  assert.ok(examined > 0, "the task tables must state at least one task");
  assert.deepEqual(violations, [], `the day's note must label every item:\n${violations.join("\n")}`);
});
