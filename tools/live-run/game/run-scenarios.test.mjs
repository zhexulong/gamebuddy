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

const RUNNER_PATH = new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url);
const RUNNER = readFileSync(RUNNER_PATH, "utf8");
const LAUNCHER = readFileSync(new URL("./launch-ladder-live.mjs", import.meta.url), "utf8");

const SCENARIOS = ["morning_routine", "memory_covenant", "npc_social_and_presence", "multiday_routine"];

/** The scenario list both entry points declare, so they cannot disagree about what exists. */
function declaredScenarios(source) {
  const match = source.match(/const SCENARIOS = Object\.freeze\(\[([^\]]*)\]\)/u);
  assert.ok(match, "an entry point must declare its scenario list");
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
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
  const prompts = RUNNER.slice(
    RUNNER.indexOf("const SCENARIO_PROMPTS = Object.freeze({"),
    RUNNER.indexOf("const SESSION_GOALS"),
  );
  for (const scenario of SCENARIOS) {
    const at = prompts.indexOf(`${scenario}: Object.freeze({`);
    assert.ok(at >= 0, `${scenario} must own a prompt block`);
    const block = prompts.slice(at, prompts.indexOf("}),", at));
    assert.match(block, /zh: `[^`]{80,}|zh: \([a-zA-Z]+\) =>/u, `${scenario} needs a real Chinese prompt`);
    assert.match(block, /en: `[^`]{80,}|en: \([a-zA-Z]+\) =>/u, `${scenario} needs a real English prompt`);
  }
  // The companion-voice rule and the presence paragraph are shared constants: a prompt that stops asking for
  // them would let the interaction gate fail for a scenario that was never told how to speak.
  assert.match(prompts, /\$\{PRESENCE_PARAGRAPH_ZH\}\$\{COMPANION_VOICE_RULE_ZH\}/u);
  assert.match(prompts, /\$\{PRESENCE_PARAGRAPH_EN\}\$\{COMPANION_VOICE_RULE_EN\}/u);
});

test("the multi-day prompt is the one that tells the companion to end its own day", () => {
  // Nobody else ends the night: the loop only watches. So "the day is yours to end" has to be SAID, and it has
  // to be said in the prompt rather than arranged by the harness, because a night the harness started would be
  // a scripted crossing rather than the companion's own day.
  const prompts = RUNNER.slice(
    RUNNER.indexOf("const SCENARIO_PROMPTS = Object.freeze({"),
    RUNNER.indexOf("const SESSION_GOALS"),
  );
  const at = prompts.indexOf("multiday_routine: Object.freeze({");
  const block = prompts.slice(at, prompts.indexOf("}),", at));
  assert.match(block, /睡下/u, "the Chinese prompt must say to go to bed");
  assert.match(block, /sleep in your bed/u, "the English prompt must say to sleep in your bed");
  // ...and the action's OWN precondition, which the lifecycle enforces by name: it only begins a night from
  // inside the farmhouse, so a prompt that omits this leaves the companion dispatching a sleep it cannot take.
  assert.match(block, /只在农舍屋内生效/u, "the Chinese prompt must state the indoor precondition");
  assert.match(block, /only works indoors/u, "the English prompt must state the indoor precondition");
  // The watcher must not dispatch a night of its own: it reads the receipt of the dispatch the COMPANION made,
  // and its one write is the settlement-menu dismissal.
  const watcher = RUNNER.slice(
    RUNNER.indexOf("async function watchNightRollover(day"),
    RUNNER.indexOf("async function startVoiceLane"),
  );
  assert.doesNotMatch(watcher, /action: "advance_day"/u, "the watcher must not dispatch a night");
  assert.match(watcher, /entry\.action === "advance_day"/u, "the watcher reads the companion's own dispatch");
  assert.match(watcher, /action: "dismiss_modal"/u, "the watcher closes the settlement menu the rollover raises");
  // The watcher must WAIT for the night to begin rather than observing from the first second of the day: a
  // watcher that polls the world for the whole turn cannot tell "not yet" from "never", and was measured
  // observing from t=0 on the first multi-day run.
  assert.match(watcher, /const waitForNightToBegin = async \(\) => \{/u, "the watcher waits for the night to begin");
  assert.match(watcher, /companion_did_not_sleep/u, "a day without a night is named");
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
  assert.match(
    RUNNER,
    /import \{ executeFresh, TERMINAL_STATES \} from "\.\.\/\.\.\/lib\/stardew-native-smoke-harness-v1\.mjs";/,
  );
});

test("a day that only reported back is asked again, by the companion's own decision", () => {
  // Measured 2026-10-17 (run m11): the companion worked six real pieces of farm work in 360s and then reported to
  // the player. `companion_did_not_sleep` named it correctly, but the harness had never asked again - a day ends
  // when the companion SLEEPS, so a settled turn that dispatched no `advance_day` has not ended it.
  assert.match(RUNNER, /const MULTIDAY_SLEEP_ATTEMPTS = \(\(\) => \{/u);
  assert.match(RUNNER, /export const MULTI_DAY_SLEEP_REMINDER = Object\.freeze\(\{/u);
  assert.match(RUNNER, /function dispatchedAdvanceDaySince\(startIndex\) \{/u);
  const dayTurn = RUNNER.slice(RUNNER.indexOf("dayTurn: async (day) => {"), RUNNER.indexOf("nightWatch: (day) =>"));
  assert.match(dayTurn, /for \(let attempt = 0; attempt < MULTIDAY_SLEEP_ATTEMPTS; attempt \+= 1\) \{/u);
  assert.match(dayTurn, /if \(dispatchedAdvanceDaySince\(before\)\) break;/u, "a real night stops the reminders");
  // The reminder is delivered as a PLAYER turn: the night stays the companion's decision, and `advance_day` is
  // never dispatched by the harness on its behalf.
  assert.match(dayTurn, /const nudged = await runAgentTurn\(reminder, tools\);/u);
  assert.doesNotMatch(dayTurn, /action: "advance_day"/u);
  // Both locales carry the reminder, and it says the two steps the lifecycle actually requires.
  const reminder = RUNNER.slice(
    RUNNER.indexOf("export const MULTI_DAY_SLEEP_REMINDER"),
    RUNNER.indexOf("function dispatchedAdvanceDaySince"),
  );
  assert.match(reminder, /zh: "/u);
  assert.match(reminder, /en: "/u);
  assert.match(reminder, /睡下/u, "the reminder must say to sleep");
  assert.match(reminder, /只在农舍屋内生效/u, "the reminder must repeat the indoor precondition");
  assert.match(reminder, /sleep in your bed/u);
  assert.match(reminder, /advance_day/u);
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
  assert.ok(RUNNER.includes("玩家说好的规矩"), "the rule is seeded through the management surface");
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
  const verdict = RUNNER.slice(RUNNER.indexOf("    state:\n"), RUNNER.indexOf('        ? "passed"'));
  for (const clause of Object.values(clauses))
    assert.ok(verdict.includes(`${clause} &&`), `the verdict must read ${clause}`);
  // The shared gates stay in the verdict: a scenario clause must not be able to make an unassembled persona or a
  // recital-shaped reply pass.
  for (const shared of ["contextPassed &&", "contentPassed &&", "worldBookPassed &&", "interactionPassed"]) {
    assert.ok(verdict.includes(shared), `the verdict must still read ${shared}`);
  }
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
