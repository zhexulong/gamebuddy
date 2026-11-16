// red-proof: compose the day's note as a `<player-note>` block again, or prefix the delivered text with a label, or
//   trim one character off the speech -> `player_speech_inside_a_fact_block:<task>`,
//   `player_speech_labelled:<task>` and `player_speech_not_verbatim:<task>`
//   (tools/live-run/game/multiday-day-note.test.mjs)
/**
 * THE DAY'S NOTE, JUDGED ON THE MESSAGE SHE RECEIVES, FOR EVERY TASK THE TABLES CAN STATE.
 *
 * <p>
 * A day's note is one player message. On `2026-11-14`, day 1 of a `multiday_routine` run, it was narrated stage
 * direction - `给你做的：「现在是星露谷的早晨（连续第 1 天），桌上留着他的便签。」`, his errand under
 * `他的事，不是给你做的：`, the day's rules as further items, and a `给你做的` label on every line. Three things were
 * wrong at once and only one of them was wording:
 * </p>
 *
 * <ol>
 *   <li>Nobody says 「桌上留着便签」. A person talking to their companion says what they want.</li>
 *   <li>「这一天才真正过去」 and 「只在嘴里说“我睡了”而身体没躺下，天不会自己过去」 are instructions to a model, and the Game
 *     prompt floor already carries them (`SLEEPING_IS_AN_ACTION`, `BED_IS_INSIDE`) for every run.</li>
 *   <li>The labels were the harness's meta-language. The note was a fact block, so its reader had to guess whose each
 *     sentence was, and it guessed wrong the one turn it mattered: her thinking that day was `The player left a note:
 *     they're going to town to make a machine.` and she submitted nothing.</li>
 * </ol>
 *
 * <p>
 * SO THE GATE IS ON THE DELIVERED TEXT, NOT ON THE COMPOSER. The population is the prompt table's OWN keys in both
 * locales, so a task added to the rotation without a readable note fails here rather than in a game launch. Each note
 * is composed by the scenario's own template and put through the product's real composer
 * (`host/dist-test/fact-brief.js#composeFactBrief`, the same function the pump calls), and the assertions read that
 * string - a copy of the composition here would agree with itself and prove nothing about what she is handed.
 * </p>
 *
 * <h2>The three failure codes</h2>
 *
 * <ul>
 *   <li>`player_speech_not_verbatim:<task>` - the words are missing, appear more than once, or are not the message's
 *     head. A trim, a re-punctuation, a merge or a dropped clause lands here.</li>
 *   <li>`player_speech_inside_a_fact_block:<task>` - the words sit inside a `<...>` region. The prompt floor tells her
 *     every block is written by the machine, so speech inside one is speech presented as data - the defect above.</li>
 *   <li>`player_speech_labelled:<task>` - a wrapper or label is added around it (`player-note`, `他跟你说的`,
 *     `给你做的`, `他的事，不是给你做的`, `上面没有给你做的事`).</li>
 * </ul>
 *
 * <p>
 * Plus the note's own content: the task text must be in the message, and the message must carry no stage direction
 * (`便签`, `桌上`, `连续第`). The value of `_day` is not asserted anywhere, deliberately: which day it is belongs to
 * `<world-state>`'s date line, read from `snapshot.dayOfMonth`/`seasonIndex`/`year`, and restating it in the player's
 * mouth was half of the narration this gate exists to keep out.
 * </p>
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { composeFactBrief } from "../../../host/dist-test/fact-brief.js";
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
 * because those keys are derived from the published surface, and a table grown by a spread has to grow here too - a
 * hand list of tasks would be exactly the second population that lets a new task go unread.
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

/** The player input a day's note arrives as: the same shape the control server enqueues. */
const inputOf = (text, locale) =>
  Object.freeze({ source: "player_text", inputId: "day_note", text, locale, timestampMs: 1 });

/** Every `<name>…</name>` region of the delivered text, as `[start, end)` indices. */
function blockSpans(text) {
  const spans = [];
  for (const open of text.matchAll(/<([a-z-]+)>/gu)) {
    const name = open[1];
    const close = text.indexOf(`</${name}>`, open.index + open[0].length);
    assert.notEqual(close, -1, `the <${name}> block is never closed, so its extent cannot be read`);
    spans.push([open.index, close + `</${name}>`.length]);
  }
  return spans;
}

/** The labels and wrappers this shape replaced. A message carrying one is speech presented as a labelled section. */
const RETIRED_LABELS = Object.freeze([
  "player-note",
  "他跟你说的",
  "给你做的",
  "他的事",
  "上面没有给你做的事",
  "note on the table",
  "That is yours to handle",
]);

/** The stage direction this shape replaced: narration about a table, a note and a run of days. */
const STAGE_DIRECTION = Object.freeze(["便签", "桌上", "连续第"]);

/**
 * Everything wrong with one delivered turn, as failure codes that name the task.
 *
 * A pure function of `(note, text, taskText)` so the second test can drive it with a message the product does NOT
 * compose: the gate's own red proof is the same code path as its green verdict.
 */
function violationsOf({ task, note, text, taskText }) {
  const violations = [];
  // The fixture is speech, so it carries no block markup of its own. If one ever did, the scan below could not tell
  // whose tag it was and the gate would be judging an ambiguous message: name it instead of guessing.
  if (/<\/?[a-z-]+>/u.test(note))
    violations.push(`note_carries_block_markup:${task} (${JSON.stringify(note)} is not speech alone)`);
  const occurrences = text.split(note).length - 1;
  if (occurrences !== 1 || !text.startsWith(note))
    violations.push(
      `player_speech_not_verbatim:${task} (${
        occurrences === 0
          ? "the words are absent"
          : occurrences > 1
            ? `the words appear ${String(occurrences)} times`
            : `the message opens ${JSON.stringify(text.slice(0, 40))} rather than with the words`
      })`,
    );
  const spans = blockSpans(text);
  const at = text.indexOf(note);
  if (at !== -1 && spans.some(([start, end]) => at >= start && at + note.length <= end))
    violations.push(
      `player_speech_inside_a_fact_block:${task} (the words sit inside ${JSON.stringify(text.slice(at - 20, at))}…)`,
    );
  for (const label of RETIRED_LABELS)
    if (text.includes(label))
      violations.push(`player_speech_labelled:${task} (${JSON.stringify(label)} is in the message)`);
  if (!text.includes(taskText))
    violations.push(`task_not_stated:${task} (the message never names ${JSON.stringify(taskText)})`);
  for (const direction of STAGE_DIRECTION)
    if (text.includes(direction))
      violations.push(`stage_direction:${task} (${JSON.stringify(direction)} is narration, not speech)`);
  return violations;
}

/** One delivered turn for one day's note, through the product's own composer. */
function deliver(note, locale) {
  return composeFactBrief({
    inputs: [inputOf(note, locale)],
    snapshot: undefined,
    events: [],
    locale,
  });
}

test("the day's note reaches her as the player's own words, verbatim and outside every block", () => {
  const { DAILY_TASK_PROMPT_ZH, DAILY_TASK_PROMPT_EN, SCENARIO_PROMPTS } = loadPromptTables();
  const violations = [];
  let examined = 0;
  for (const [locale, table] of [
    ["zh", DAILY_TASK_PROMPT_ZH],
    ["en", DAILY_TASK_PROMPT_EN],
  ]) {
    for (const task of Object.keys(table)) {
      examined += 1;
      const note = SCENARIO_PROMPTS.multiday_routine[locale](1, task);
      violations.push(
        ...violationsOf({ task, note, text: deliver(note, locale), taskText: String(table[task]).trim() }),
      );
    }
  }
  // A population of zero agrees with itself: the tables are read by key, and a table that could not be read would
  // report nothing at all.
  assert.ok(examined > 0, "the task tables must state at least one task");
  process.stderr.write(
    `DAY_NOTE_GATE days scheduled 1 · messages examined ${String(examined)} over ${String(examined / 2)} task(s), both locales\n`,
  );
  assert.deepEqual(violations, [], `the day's note is not speech in the delivered turn:\n${violations.join("\n")}`);
});

/**
 * The falsifier: the same checker over messages the product no longer composes, each with the code it must raise.
 *
 * Without this the gate is decoration - it would pass on the day its own assertions stopped being reachable. Every
 * case here is a real shape from this file's own history or the composition one step away from the current one.
 */
test("the checker is red on every shape it exists to forbid", () => {
  const task = "clear_east_patch";
  const taskText = "the east patch wants clearing - weeds and rocks.";
  const speech = `I'm heading into town today - take care of this for me while I'm gone: ${taskText} No need to wait up.`;
  const cases = [
    ["a labelled block wrapper", `<player-note>\n${speech}\n</player-note>`, "player_speech_labelled:clear_east_patch"],
    [
      "the words inside a block",
      `<world-facts>\n${speech}\n</world-facts>`,
      "player_speech_inside_a_fact_block:clear_east_patch",
    ],
    ["one character trimmed off", speech.slice(0, -1), "player_speech_not_verbatim:clear_east_patch"],
    [
      "a block put in front of the speech",
      `<world-state>\n世界：尚未收到观察\n</world-state>\n${speech}`,
      "player_speech_not_verbatim:clear_east_patch",
    ],
    ["the words said twice", `${speech}\n${speech}`, "player_speech_not_verbatim:clear_east_patch"],
    ["the task left out", "I'm heading into town today. No need to wait up.", "task_not_stated:clear_east_patch"],
    ["the old stage direction", `There is a note on the table. ${speech}`, "player_speech_labelled:clear_east_patch"],
  ];
  const missed = [];
  for (const [name, text, expected] of cases) {
    const raised = violationsOf({ task, note: speech, text, taskText });
    if (!raised.some((code) => code.startsWith(expected)))
      missed.push(`${name}: expected ${expected}, raised ${JSON.stringify(raised)}`);
  }
  // The green case rides here too, so a checker that rejects everything is red as well as one that accepts everything.
  const clean = violationsOf({
    task,
    note: speech,
    text: `${speech}\n<world-state>\n世界：尚未收到观察\n</world-state>`,
    taskText,
  });
  if (clean.length > 0) missed.push(`a clean message raised ${JSON.stringify(clean)}`);
  assert.deepEqual(missed, [], missed.join("\n"));
});
