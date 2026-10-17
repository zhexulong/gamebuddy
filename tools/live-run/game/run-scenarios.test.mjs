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

const SCENARIOS = ["morning_routine", "memory_covenant", "npc_social_and_presence"];

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
    assert.match(block, /zh: `[^`]{80,}/u, `${scenario} needs a real Chinese prompt`);
    assert.match(block, /en: `[^`]{80,}/u, `${scenario} needs a real English prompt`);
  }
  // The companion-voice rule and the presence paragraph are shared constants: a prompt that stops asking for
  // them would let the interaction gate fail for a scenario that was never told how to speak.
  assert.match(prompts, /\$\{PRESENCE_PARAGRAPH_ZH\}\$\{COMPANION_VOICE_RULE_ZH\}/u);
  assert.match(prompts, /\$\{PRESENCE_PARAGRAPH_EN\}\$\{COMPANION_VOICE_RULE_EN\}/u);
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
