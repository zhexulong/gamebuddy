// red-proof: inject  renaming one rung's scenario in the runner's translation table -> `✖ a retired rung number still
//   resolves, but only through the one translation table` (tools/live-run/game/run-scenarios.test.mjs)
// red-proof: history 0a86267a's multiday composer (the labelled stage-direction note, 「连续第 N 天」 at the front) ->
//   `✖ the multi-day note asks for the day's task and hands the day over, without coaching it`, naming
//   `stage_direction:zh:<task>` for 便签/桌上/连续第 and `day_number_in_the_note:zh:<task>`
// red-proof: inject  an emptied scenario prompt (`zh: \`干活。\``) -> `✖ every scenario has a prompt in both locales`,
//   "morning_routine.zh must be a written prompt, not a placeholder"; dropping a locale key -> the same test, naming
//   the missing locale
// The three-scenario contract: what each one promises, and the things the retirement had to stop doing.
//
// The rung numbers 0-5 are gone because they described the order the harness learned things in rather than what
// a run is about - and two of them were the same Keg errand with different walk lengths. What replaced them is
// three scenarios, each an observation this project actually wants. These assertions are the contract's own:
// a fourth name, a scenario with no prompt, a scenario with no acceptance clause, or a nursery-style route
// smuggled into a prompt must each fail here rather than in a live run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sweepTaskPrompts } from "../../lib/multiday-daily-tasks.mjs";

const RUNNER_PATH = new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url);
const RUNNER = readFileSync(RUNNER_PATH, "utf8");
const LAUNCHER = readFileSync(new URL("./launch-ladder-live.mjs", import.meta.url), "utf8");

const SCENARIOS = ["morning_routine", "memory_covenant", "npc_social_and_presence", "multiday_routine"];

/**
 * The night tool is spelled `sleep`, which is also the ordinary English verb these prompts use on purpose ("go to
 * bed and sleep so the night passes"), so the bare word can no longer separate intent from coaching. The two shapes
 * that still can: the DISPATCH an agent would copy (a quoted action id) and a tool name that is still a code word.
 */
const DISPATCH_IN_PROMPT = /action:\s*"sleep"|["'`]sleep["'`]/u;
const TOOL_CODE_WORD = /move_to_tile|stardew_/u;

/** The scenario list both entry points declare, so they cannot disagree about what exists. */
function declaredScenarios(source) {
  const match = source.match(/const SCENARIOS = Object\.freeze\(\[([^\]]*)\]\)/u);
  assert.ok(match, "an entry point must declare its scenario list");
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
}

/**
 * One `const NAME = …;` declaration out of the runner's source, cut by bracket matching.
 *
 * The runner never loads here - importing it starts a live run - so its prompt tables are cut out of the source and
 * evaluated, and the assertions below read the text the COMPOSER produces. Reading the template's own spelling is what
 * this file did until 2026-11-15, and a wording change (你看着办 -> 怎么安排你自己定, beside a `(_day, task) =>` whose
 * parameters a source regex did not allow) then read as a scenario with no prompt at all.
 */
function runnerConstant(name) {
  const at = RUNNER.indexOf(`const ${name} =`);
  assert.ok(at !== -1, `the runner must declare ${name}`);
  let depth = 0;
  for (let index = at; index < RUNNER.length; index += 1) {
    const char = RUNNER[index];
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === ";" && depth === 0) return RUNNER.slice(at, index + 1);
  }
  assert.fail(`unterminated declaration for ${name}: the scan never reached a top-level ";"`);
}

/**
 * The runner's task tables and its `SCENARIO_PROMPTS`, evaluated with the sweep prompts bound.
 *
 * `sweepTaskPrompts` is passed in because those keys are derived from the Mod's published surface, so a table grown by a
 * spread grows here too. Same reading and the same reason as `multiday-day-note.test.mjs`.
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
 * A placeholder is not a prompt: a floor on the composed TEXT, deliberately not on the wording.
 *
 * The shortest scenario prompt composes to just over 60 characters today and a placeholder ("TODO", "undefined") is
 * a handful, so 40 separates the two without becoming a bar the next edit to the copy has to clear.
 */
const MIN_PROMPT_LENGTH = 40;

/** A scenario's prompt as the companion would receive it: a string as written, a function composed for day 1 and a task. */
function composePrompt(prompt, locale, table) {
  if (typeof prompt !== "function") return prompt;
  const task = Object.keys(table)[0];
  assert.ok(task !== undefined, `a composed ${locale} prompt needs a task, and the table states none`);
  return prompt(1, task);
}

test("both entry points declare exactly the three scenarios", () => {
  assert.deepEqual(declaredScenarios(RUNNER).sort(), [...SCENARIOS].sort());
  assert.deepEqual(declaredScenarios(LAUNCHER).sort(), [...SCENARIOS].sort());
});

test("an unknown scenario fails closed instead of resolving to a default", () => {
  // Both readers must refuse by name: silently falling back to a scenario would run an experiment nobody asked
  // for and report it under the other scenario's name.
  assert.match(RUNNER, /throw new Error\(`unknown_run_scenario:/u);
  assert.match(LAUNCHER, /throw new Error\(`unknown_run_scenario:/u);
  const runnerThrow = RUNNER.indexOf("unknown_run_scenario");
  const runnerRun = RUNNER.indexOf("const SCENARIO =");
  assert.ok(runnerRun >= 0 && runnerThrow > runnerRun, "the refusal must be part of building the selector");
});

test("a retired rung number still resolves, but only through the one translation table", () => {
  // An operator's existing `--ladder 6` keeps working; nothing downstream may consult the digit, so the table
  // is the single place a number is interpreted.
  assert.match(RUNNER, /const LEGACY_SCENARIO_BY_LADDER = Object\.freeze\(\{/u);
  for (const digit of ["0", "1", "2", "3", "4", "5", "6"]) {
    assert.match(
      RUNNER,
      new RegExp(`^  ${digit}: "(?:${SCENARIOS.join("|")})",$`, "mu"),
      `ladder ${digit} must map to a scenario`,
    );
  }
  // The digit is read ONCE (in code; the other mention is the explanatory comment above it). Any other read is
  // a path where the retired vocabulary decides behaviour again.
  const readLines = RUNNER.split("\n").filter(
    (line) => line.includes("GAMEBUDDY_AGENT_LADDER") && !line.trimStart().startsWith("//"),
  );
  assert.equal(
    readLines.length,
    1,
    `GAMEBUDDY_AGENT_LADDER must be read exactly once in code (found ${readLines.length})`,
  );
  assert.equal((LAUNCHER.match(/option\("ladder"/gu) ?? []).length, 1);
});

test("a scenario refuses a fixture that cannot answer its question", () => {
  // Measured live 2026-10-16: `memory_covenant` ran the plain play-session fixture, so the field held cauliflowers.
  // The companion truthfully said it had never planted a strawberry, and the covenant clause then read as a
  // violation of a rule about a crop that was never in the ground. The fixture is the QUESTION's world, so a
  // mismatch is refused before the game starts, not discovered in the verdict.
  assert.match(RUNNER, /const REQUIRED_FIXTURE_SCENARIO = Object\.freeze\(\{/);
  assert.match(RUNNER, /memory_covenant: "native_strawberry_covenant_v1",/);
  assert.match(RUNNER, /npc_social_and_presence: "native_jodi_harvest_deliver_v1",/);
  // The multi-day scenario needs BOTH halves of its world in one fixture, so it names the composed scenario.
  assert.match(RUNNER, /multiday_routine: "native_multi_day_play_session_v1",/);
  // morning_routine must NOT be pinned: it decides its own work, so any armed world is a valid world for it.
  assert.doesNotMatch(RUNNER, /morning_routine: "native_/);
  assert.match(RUNNER, /throw new Error\(\s*`scenario_fixture_mismatch: \$\{SCENARIO\} needs/);
  // The check must run before the game is launched, so it sits next to reading the Mod config.
  const configRead = RUNNER.indexOf("const config = JSON.parse");
  const fixtureCheck = RUNNER.indexOf("scenario_fixture_mismatch");
  assert.ok(configRead >= 0 && fixtureCheck > configRead, "the fixture check follows the config read");
  assert.match(RUNNER, /configuredFixtureScenario,/);
});

test("every scenario has a prompt in both locales, and none of them is empty", () => {
  // The population is the declared scenario list, and the table must not drift from it: a scenario in one and not the
  // other is a run that names a scenario whose prompt it cannot compose.
  const { DAILY_TASK_PROMPT_ZH, DAILY_TASK_PROMPT_EN, SCENARIO_PROMPTS } = loadPromptTables();
  assert.deepEqual(
    Object.keys(SCENARIO_PROMPTS).sort(),
    [...SCENARIOS].sort(),
    "the prompt table and the declared scenario list must be the same population",
  );
  // A function prompt takes (day, task), so a task is part of the input it needs. The task comes from the table that
  // WRITES it, per locale, so this check is about "there is a real prompt" for every scenario at once.
  const tables = { zh: DAILY_TASK_PROMPT_ZH, en: DAILY_TASK_PROMPT_EN };
  const composed = [];
  for (const scenario of SCENARIOS) {
    for (const locale of ["zh", "en"]) {
      const prompt = SCENARIO_PROMPTS[scenario]?.[locale];
      assert.ok(prompt !== undefined, `${scenario} must own a ${locale} prompt`);
      const text = composePrompt(prompt, locale, tables[locale]);
      assert.equal(typeof text, "string", `${scenario}.${locale} must compose to text`);
      assert.ok(
        text.trim().length >= MIN_PROMPT_LENGTH,
        `${scenario}.${locale} must be a written prompt, not a placeholder: ${JSON.stringify(text)}`,
      );
      composed.push({ name: `${scenario}.${locale}`, text });
    }
  }
  // The runner states the TASK; how the companion talks belongs to the system prompt alone
  // (`host/src/identity-profile.ts` plus the character card), which already forbids bracketed stage direction, walkie-talkie
  // dispatch and step-by-step inventories. The duplication that used to live here meant two authorities for one rule -
  // and every run since paid for it: measured 2026-11-03 (`round26`), the companion still spoke as "已完成 A，正在执行 B"
  // with the words "不是任务播报员" sitting in its own prompt.
  for (const { name, text } of composed) {
    assert.ok(!text.includes("不是任务播报员"), `${name} must not coach the voice`);
    assert.ok(!text.toLowerCase().includes("not a task announcer"), `${name} must not coach the voice`);
  }
  // An interpolated CONSTANT reaches the companion as its text, never as its name, so this half is read where the
  // reference itself would be: a prompt block that interpolates a voice rule is the duplication, however it is worded.
  const block = RUNNER.slice(
    RUNNER.indexOf("const SCENARIO_PROMPTS = Object.freeze({"),
    RUNNER.indexOf("const SESSION_GOALS"),
  );
  assert.doesNotMatch(block, /PRESENCE_PARAGRAPH|COMPANION_VOICE_RULE/u, "the runner must not coach the voice");
});

test("the run budget is a harness bound that fits the scenario, not one fixed number", () => {
  // Measured 2026-10-17 on run m12: with a fixed 10-minute run deadline, the FIRST accepted night consumed the
  // budget and every later dispatch came back `bridge_connect_deadline_exceeded` - a harness fault that read
  // exactly like the companion failing, while the Mod's own sleep lifecycle had genuinely started.
  assert.match(RUNNER, /const RUN_BUDGET_MS = \(\(\) => \{/u);
  assert.match(RUNNER, /SCENARIO === "multiday_routine" \? 4 \* 60 \* 60 \* 1000 : 600_000/u);
  assert.match(RUNNER, /const deadline = Date\.now\(\) \+ RUN_BUDGET_MS;/u);
  // An operator can override it, and the override must be a positive integer rather than anything truthy.
  assert.match(RUNNER, /const requested = Number\.parseInt\(process\.env\.GAMEBUDDY_RUN_BUDGET_MS \?\? "", 10\);/u);
  assert.match(RUNNER, /if \(Number\.isInteger\(requested\) && requested > 0\) return requested;/u);
  // And the doc has to say it is a harness bound, never a product verdict.
  assert.match(RUNNER, /A harness bound, never a product verdict/u);
});

test("the rollover watcher dispatches through the harness, not with a raw execute", () => {
  // Measured 2026-10-17 on run g12: both of the watcher's dispatches used `client.execute` directly, without
  // `expectedRevision` and without a deadline, and the Host refused them with `receipt_not_found` - so the probe
  // that reads the pending level-up never produced a receipt, and the agent's own guesses filled the gap. The
  // smoke harness's `executeFresh` supplies the revision and the bound; using it is what makes the dispatch
  // admissible.
  const watcher = RUNNER.slice(
    RUNNER.indexOf("async function watchNightRollover(day"),
    RUNNER.indexOf("async function startVoiceLane"),
  );
  assert.match(watcher, /await executeFresh\(client, \{/);
  assert.doesNotMatch(watcher, /client\.execute\(\{/);
  assert.equal((watcher.match(/await executeFresh\(client, \{/gu) ?? []).length, 2, "both dispatches");
  // A REFUSAL is the immediate answer and mints no later receipt: `rejected` is not in the shared TERMINAL_STATES,
  // so polling the fact log for it timed out on run g15 and the probe reported "the pair was never published"
  // while the refusal carrying the pair was already in hand. Both dispatches check the response first.
  assert.equal(
    (watcher.match(/if \(typeof accepted\?\.state === "string" && accepted\.state !== "accepted"\)/gu) ?? []).length,
    2,
    "both dispatches read a refusal from the response",
  );
  assert.match(
    RUNNER,
    /import \{ executeFresh, TERMINAL_STATES \} from "\.\.\/\.\.\/lib\/stardew-native-smoke-harness-v1\.mjs";/,
  );
});

test("no scenario prompt prescribes a route", () => {
  const prompts = RUNNER.slice(
    RUNNER.indexOf("const SCENARIO_PROMPTS = Object.freeze({"),
    RUNNER.indexOf("const SESSION_GOALS"),
  );
  for (const banned of [
    "先检查（inspect）",
    "先观察 observe",
    "equip_tool 然后",
    "Complete in this order",
    "be efficient",
    "请严格按以下顺序",
  ]) {
    assert.ok(!prompts.includes(banned), `a scenario prompt must not coach the route: ${banned}`);
  }
  // What a prompt MAY state: the intent and the world's facts.
  assert.ok(prompts.includes("她需要一颗新鲜花椰菜"), "the villager's errand is the intent and stays");
  assert.ok(prompts.includes("she needs a fresh cauliflower"));
});

test("the covenant rule is never in the prompt: it is planted in memory", () => {
  // The whole point of memory_covenant is that the rule reaches the companion through MEMORY. A prompt that
  // names it would make the test pass by coaching, so the rule's text may only appear at the seeding site.
  const prompts = RUNNER.slice(
    RUNNER.indexOf("const SCENARIO_PROMPTS = Object.freeze({"),
    RUNNER.indexOf("const SESSION_GOALS"),
  );
  for (const rule of ["一颗都不要卖掉", "never sold or sent to the shipping bin", "不能卖掉"]) {
    assert.ok(!prompts.includes(rule), `the covenant prompt must not state the rule: ${rule}`);
  }
  // The rule's own words are ONE of the seeds the management surface is called with. Binding the text to that call
  // is what keeps this a memory the companion READS rather than a prompt line it was handed: a rule that moved into
  // a prompt, or into any other call, fails here. The seed's wording is the runner's to change.
  assert.match(
    RUNNER,
    /seedMemoriesViaManagementSurface\(\{[\s\S]{0,240}?seeds: \[[\s\S]{0,80}?一颗都不能卖掉/u,
    "the rule is one of the seeds the management surface is called with",
  );
});

test("every scenario owns an acceptance clause, and the verdict ANDs all three", () => {
  const clauses = {
    morning_routine: "morningRoutinePassed",
    memory_covenant: "memoryCovenantPassed",
    npc_social_and_presence: "npcSocialAndPresencePassed",
  };
  for (const [scenario, clause] of Object.entries(clauses)) {
    assert.match(
      RUNNER,
      new RegExp(`const ${clause} =\\n    SCENARIO === "${scenario}"`, "u"),
      `${scenario} must own its clause`,
    );
  }
  // The verdict is the rung's clause list, and the AND is `deriveRungVerdict`'s: every clause must be `passed` for the
  // run to be. Reading the list is the point - a scenario clause that is declared but never reaches the verdict is a
  // clause that cannot fail.
  const verdict = RUNNER.slice(
    RUNNER.indexOf("const rungClauses = Object.freeze(["),
    RUNNER.indexOf("const result = await buildRunResult({\n    rungClauses,"),
  );
  assert.ok(verdict.length > 0, "the rung's clauses must be declared in one list");
  for (const clause of Object.values(clauses))
    assert.ok(verdict.includes(`passed: ${clause}`), `the verdict must read ${clause}`);
  // The shared gates stay in the verdict: a scenario clause must not be able to make an unassembled persona or a
  // recital-shaped reply pass.
  for (const shared of ["contextPassed", "contentPassed", "worldBookPassed", "interactionPassed"]) {
    assert.ok(verdict.includes(`passed: ${shared},`), `the verdict must still read ${shared}`);
  }
  assert.match(
    RUNNER,
    /const rung =\n\s*rungClauses === null\n\s*\? null\n\s*: deriveRungVerdict\(\[/u,
    "the clauses are ANDed by one derivation, and the verdict is its answer",
  );
});

test("the scenario, not the digit, is what a run reports and names its artifacts", () => {
  assert.match(RUNNER, /scenario: SCENARIO,\n    legacyLadder: LEGACY_LADDER,/u);
  assert.match(RUNNER, /legacyLadder: LEGACY_LADDER,/u);
  // Result and capture names follow the scenario too: two scenarios' artifacts must not collide.
  assert.match(RUNNER, /label: SCENARIO/u);
  assert.match(RUNNER, /`_\$\{SCENARIO\}-\$\{Date\.now\(\)\}\.result\.json`/u);
  assert.match(LAUNCHER, /`_\$\{scenario\}\$\{suffix\}\.result\.json`/u);
  assert.match(LAUNCHER, /`_\$\{scenario\}\$\{suffix\}-live-runner\.log`/u);
  assert.match(LAUNCHER, /GAMEBUDDY_AGENT_SCENARIO: scenario,/u);
});

test("farmer-to-farmer presence is not one of the single-player scenarios", () => {
  // Warp sync and two-farmer accompaniment need the second player that only the multiplayer topology has, so
  // they belong to the co-op loop. Naming them here as if this ladder covered them was a topology error.
  const prompts = RUNNER.slice(
    RUNNER.indexOf("const SCENARIO_PROMPTS = Object.freeze({"),
    RUNNER.indexOf("const SESSION_GOALS"),
  );
  for (const coOpOnly of ["门扉同步", "warp sync", "两名农民", "two farmers"]) {
    assert.ok(!prompts.includes(coOpOnly), `a single-player scenario must not claim ${coOpOnly}`);
  }
  assert.match(RUNNER, /Farmer-to-farmer presence and warp\n\/\/ sync are NOT one of these scenarios/u);
});

/** A frame carrying one of these tells her the ORDER, which is the decision this scenario exists to observe. */
const FRAME_ROUTE_WORDS = Object.freeze(["先", "再", "然后", "步骤", "第一步", "in this order", "step 1", "then "]);

/** Narration about a table, a note and a run of days: the shape 2026-11-14's note had. */
const STAGE_DIRECTION = Object.freeze(["便签", "桌上", "连续第", "note on the table"]);

/**
 * Everything wrong with ONE composed multi-day note, as codes that name the locale and the task.
 *
 * A pure function of the composed texts, so the falsifier can drive it with notes this runner no longer composes and
 * the checker's own red proof runs down the same code path as its green verdict.
 */
function noteViolationsOf({ locale, task, taskText, note, noteLater }) {
  const where = `${locale}:${task}`;
  const violations = [];
  const stated = note.split(taskText).length - 1;
  if (stated === 0) violations.push(`task_not_stated:${where} (the note never asks for ${JSON.stringify(taskText)})`);
  if (stated > 1)
    violations.push(`task_stated_twice:${where} (the ask reads as a checklist: stated ${String(stated)} times)`);
  const at = note.indexOf(taskText);
  const head = at === -1 ? "" : note.slice(0, at).trim();
  const tail = at === -1 ? "" : note.slice(at + taskText.length).trim();
  if (at !== -1 && head.length === 0)
    violations.push(`note_opens_on_the_ask:${where} (nothing of the player's own comes first)`);
  // THE HAND-OVER, as a shape rather than a sentence: he asks, then says something of his own about the day, which is
  // where "the arrangement is yours" lives in both locales. A note that ENDS on the ask is a bare imperative - it hands
  // nothing over - while any rewording of the closing clause passes. The assertion this replaced quoted 「你看着办」
  // and went red on 「怎么安排你自己定」, which is the same hand-over written by a better copywriter.
  if (at !== -1 && tail.length === 0)
    violations.push(`note_ends_on_the_ask:${where} (nothing hands the day over after it)`);
  for (const word of FRAME_ROUTE_WORDS)
    if (`${head} ${tail}`.includes(word))
      violations.push(`frame_prescribes_an_order:${where} (${JSON.stringify(word)} tells her the order)`);
  // Which day it is belongs to `<world-state>`'s date line, restated from the snapshot every turn; a note that changes
  // with the day number has put the calendar back into the player's mouth.
  if (note !== noteLater) violations.push(`day_number_in_the_note:${where} (day 1 and day 7 read differently)`);
  for (const direction of STAGE_DIRECTION)
    if (note.includes(direction))
      violations.push(`stage_direction:${where} (${JSON.stringify(direction)} is narration, not speech)`);
  if (DISPATCH_IN_PROMPT.test(note)) violations.push(`dispatch_spelled:${where}`);
  if (TOOL_CODE_WORD.test(note)) violations.push(`tool_named:${where}`);
  if (/农舍|farmhouse/u.test(note)) violations.push(`step_prescribed:${where}`);
  return violations;
}

test("the multi-day note asks for the day's task and hands the day over, without coaching it", () => {
  // The assertions are about the text the COMPANION RECEIVES, so they run on `SCENARIO_PROMPTS.multiday_routine`'s own
  // output for every task both tables can state - not on how the template is spelled. Narrowing the reading to the
  // template lines is how this test went blind once already (2026-10-26: it checked one backtick line of a prompt that
  // had grown to several), and quoting its wording is what made 2026-11-15's rewrite look like a broken prompt.
  const { DAILY_TASK_PROMPT_ZH, DAILY_TASK_PROMPT_EN, SCENARIO_PROMPTS } = loadPromptTables();
  const multiday = SCENARIO_PROMPTS.multiday_routine;
  assert.ok(multiday, "multiday_routine must own a prompt block");
  const violations = [];
  let examined = 0;
  for (const [locale, table] of [
    ["zh", DAILY_TASK_PROMPT_ZH],
    ["en", DAILY_TASK_PROMPT_EN],
  ]) {
    const tasks = Object.keys(table);
    // A population of zero agrees with itself: the tables are read by key, and a note composed for no task would pass.
    assert.ok(tasks.length > 0, `the ${locale} task table must state at least one task`);
    for (const task of tasks) {
      examined += 1;
      violations.push(
        ...noteViolationsOf({
          locale,
          task,
          taskText: String(table[task]).trim(),
          note: multiday[locale](1, task),
          noteLater: multiday[locale](7, task),
        }),
      );
    }
  }
  process.stderr.write(
    `MULTIDAY_NOTE_GATE tasks examined ${String(examined)} over ${String(examined / 2)} task(s), both locales\n`,
  );
  assert.deepEqual(violations, [], `the day's note is not the player handing the day over:\n${violations.join("\n")}`);
  // The hour is theirs; the tool and the steps are not the prompt's business. Naming them is the coaching this
  // file's own comment says was deleted, and design/handbook/live-run-patterns.md forbids it ("the prompt gives the
  // player's intent, not steps, tool names or coordinates"). The refusal receipt is where "the night tool only works
  // indoors" belongs. Measured 2026-10-17/18: the coaching was there, and a reviewer graded it over-encoding.
  //
  // The tool was renamed `advance_day` -> `sleep`, and `sleep` is the ordinary verb the prompt must use, so the word
  // alone is no longer evidence of coaching: what must not appear is the dispatch, or another tool's code word.
  // Both are read above, per composed note, for every task.
  // The same rule for the prompt the loop offers LATER in the day, which is outside `SCENARIO_PROMPTS` and was
  // therefore unread by the assertions above. It states the clock and hands the decision over; naming the tool
  // there would be the same coaching one layer along.
  const latePrompt = RUNNER.slice(
    RUNNER.indexOf("const promptForLateDay"),
    RUNNER.indexOf("let status = null;", RUNNER.indexOf("const promptForLateDay")),
  );
  assert.ok(latePrompt.length > 0, "the late-day prompt must exist for this assertion to read it");
  assert.doesNotMatch(latePrompt, DISPATCH_IN_PROMPT, "the late-day prompt must not spell the dispatch");
  assert.doesNotMatch(latePrompt, TOOL_CODE_WORD, "the late-day prompt must not name a tool");
  // The night stays the companion's own decision, so the loop never dispatches one: `sleep` appears only as
  // the receipt it reads back.
  const watcher = RUNNER.slice(
    RUNNER.indexOf("async function watchNightRollover(day"),
    RUNNER.indexOf("async function startVoiceLane"),
  );
  assert.doesNotMatch(watcher, /action: "sleep"/u, "the watcher must not dispatch a night");
  // BOTH channels, because `sleep` reaches the game either way: as a flat request frame the runner sent
  // (`actionTrace`) or as a Body Program node the Mod ran natively. A program execution has no request frame at all,
  // but its receipt names its own `actionId`, which is what the watcher reads instead. Measured 2026-10-31
  // (`round18`): every dispatch went through a program, `actionTrace.jsonl` held 1 byte, and a watcher that looked
  // only at the flat trace published two `entered_via=native_sleep_prompt` nights as `terminal: null, cause:
  // "engine"`.
  assert.match(watcher, /entry\?*\.action === "sleep"/u, "the watcher reads the companion's own dispatch");
  assert.match(
    watcher,
    /receipt\.actionId !== "sleep"/u,
    "and the receipt a program node minted, which names the action it ran",
  );
});

/**
 * The falsifier: the same checker over notes the runner no longer composes, each with the code it must raise.
 *
 * Without it the checker could stop being reachable and still look green. Every case is a shape from this file's
 * history or one edit away from today's composer, and the clean case rides along so a checker that rejects
 * everything is red as well as one that accepts everything.
 */
test("the note checker is red on every shape it forbids", () => {
  const base = {
    locale: "en",
    task: "clear_east_patch",
    taskText: "the east patch wants clearing - weeds and rocks.",
    note: "I'm heading into town today. the east patch wants clearing - weeds and rocks. Sort the day out however you like.",
  };
  base.noteLater = base.note;
  const cases = [
    [
      "the 2026-11-14 note, with the day count and the table",
      { note: `There is a note on the table from your partner. ${base.taskText} Sort the rest out.` },
      "stage_direction:",
    ],
    [
      "a note that counts the days",
      {
        note: `${base.taskText} (day 7 for you) sort the rest out.`,
        noteLater: `${base.taskText} (day 1 for you) sort the rest out.`,
      },
      "day_number_in_the_note:",
    ],
    ["a note that ends on the ask", { note: `I'm heading into town today. ${base.taskText}` }, "note_ends_on_the_ask:"],
    [
      "a frame that tells her the order",
      { note: `I'm heading into town today. ${base.taskText} Then do the rocks, and then the yard.` },
      "frame_prescribes_an_order:",
    ],
    [
      "the ask said twice",
      { note: `${base.taskText} I'm heading out. ${base.taskText} Sort the rest out.` },
      "task_stated_twice:",
    ],
    [
      "the task left out",
      { note: "I'm heading into town today. Sort the day out however you like." },
      "task_not_stated:",
    ],
    [
      "a note that spells the dispatch",
      { note: `I'm heading out. ${base.taskText} Send action: "sleep" when you are done.` },
      "dispatch_spelled:",
    ],
    [
      "a note that names the tool",
      { note: `I'm heading out. ${base.taskText} Call stardew_sleep when you are done.` },
      "tool_named:",
    ],
    [
      "a note that prescribes the step",
      { note: `I'm heading out. ${base.taskText} Do it in the farmhouse.` },
      "step_prescribed:",
    ],
  ];
  const missed = [];
  for (const [name, overrides, expected] of cases) {
    const raised = noteViolationsOf({ ...base, ...overrides });
    if (!raised.some((code) => code.startsWith(expected)))
      missed.push(`${name}: expected ${expected}*, raised ${JSON.stringify(raised)}`);
  }
  const clean = noteViolationsOf(base);
  if (clean.length > 0) missed.push(`a note that hands the day over raised ${JSON.stringify(clean)}`);
  assert.deepEqual(missed, [], missed.join("\n"));
});

test("the harness does not nudge a companion that ended its day without sleeping", () => {
  // The harness used to inject a SECOND PLAYER MESSAGE per day ("the day is not over yet..."), which the RUNBOOK
  // forbids in as many words: a second player message is itself a steer, and if it produces the sleep then "it
  // closed the loop" was really "it was pushed". The run now reports companion_did_not_sleep with no retry.
  assert.doesNotMatch(RUNNER, /MULTI_DAY_SLEEP_REMINDER/u);
  assert.doesNotMatch(RUNNER, /MULTIDAY_SLEEP_ATTEMPTS/u);
  assert.doesNotMatch(RUNNER, /dispatchedAdvanceDaySince/u);
  assert.match(RUNNER, /companion_did_not_sleep/u);
});

test("a night the watch named a deadlock is not flattened back into a bare `night_never_started`", () => {
  // The loop's `rollover_menu_deadlock` reaches the run record only if this exit keeps the suffix. The prefix is the
  // finding (no `advance_day` started a night), and the suffix is WHICH kind of night it was - so an exit that dropped
  // the watch's reason would undo the distinction one layer along, where nobody would look for it.
  const watcher = RUNNER.slice(
    RUNNER.indexOf("async function watchNightRollover(day"),
    RUNNER.indexOf("async function startVoiceLane"),
  );
  assert.match(
    watcher,
    /reasonCode: `night_never_started:\$\{String\(outcome\.reasonCode \?\? "companion_did_not_sleep"\)\}`/u,
    "the watch's own reason is the suffix: a deadlock and a slow night must not share one word",
  );
});

test("the night's day-before baseline is read BEFORE the wait, not after it", () => {
  // Measured 2026-10-28 (`round6`): the watch began on spring 5, the engine's 02:00 pass-out crossed to spring 6, the
  // wait noticed the moved calendar and returned, and the baseline was re-read afterwards - so it recorded 6, the day
  // the night ENDED on. The crossing check at the end of the watch then compared 6 against 6 and could only answer
  // "not advanced", whatever else the night did.
  //
  // The assertion is an ORDER, because that is the defect: `startDay` is captured before `waitForNightToBegin` runs and
  // `dayBefore` is derived from it.
  const watcher = RUNNER.slice(
    RUNNER.indexOf("async function watchNightRollover(day"),
    RUNNER.indexOf("async function startVoiceLane"),
  );
  const startDayAt = watcher.indexOf("const startDay =");
  const waitAt = watcher.indexOf("await waitForNightToBegin()");
  const dayBeforeAt = watcher.indexOf("const dayBefore =");
  assert.ok(startDayAt >= 0, "the watcher captures the day it began on");
  assert.ok(waitAt >= 0, "the watcher waits for the night to begin");
  assert.ok(dayBeforeAt >= 0, "the watcher needs a day-before baseline");
  assert.ok(startDayAt < waitAt, "the day is captured before the wait moves it");
  assert.ok(waitAt < dayBeforeAt, "the baseline is derived after the wait returns");
  assert.match(watcher, /const dayBefore = Number\.isInteger\(startDay\)/u);
  assert.doesNotMatch(
    watcher,
    /const dayBefore = client\.state\?\.snapshot\?\.dayOfMonth/u,
    "a late re-read records the day the night ended on",
  );
});
