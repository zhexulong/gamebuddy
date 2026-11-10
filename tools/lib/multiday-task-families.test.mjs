import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DAILY_TASK_ACTION_HINTS, DAILY_TASK_ROTATION, SWEEP_DAILY_TASKS } from "./multiday-daily-tasks.mjs";
import {
  isProviderInvoked,
  multidayTaskFamilyVerdict,
  parseWorldTargetFamilies,
  rotationRequirement,
} from "./multiday-task-families.mjs";
import { readStardewActionFamilies } from "./stardew-published-action-registry.mjs";

const FIXTURES_DIR = new URL("../../integrations/stardew/", import.meta.url);
const actionFamilies = readStardewActionFamilies();
const knownFamilies = new Set(actionFamilies.values());

/** The rotation's requirement as the REAL table states it - so these cases are about `tend_the_animals`, not a stand-in. */
function realRequirement() {
  return rotationRequirement({
    rotation: DAILY_TASK_ROTATION,
    taskActions: DAILY_TASK_ACTION_HINTS,
    actionFamilies,
    sweepFamilies: new Map(SWEEP_DAILY_TASKS.map((task) => [task.id, task.families])),
  });
}

function verdictFor({ sources, requirement = realRequirement() }) {
  const { declarations, unpaired } = parseWorldTargetFamilies(sources);
  const producedFamilies = declarations
    .filter((declaration) => isProviderInvoked(declaration.provider, sources))
    .map((declaration) => declaration.family);
  return multidayTaskFamilyVerdict({
    tasks: requirement.tasks,
    violations: [
      ...requirement.violations,
      ...unpaired.map((entry) => ({ code: `world_family_declaration_half_written:${entry}` })),
    ],
    declarations,
    producedFamilies,
    knownFamilies,
  });
}

/** A C# Given as the fixture writes one: the advertisement, the method, and whether it is called. */
function givenSource({ invoked }) {
  return [
    "internal const string PlaySessionAnimalGivenProvider = nameof(InstallNativeLocalPlaySessionAnimalGiven);",
    'internal const string PlaySessionAnimalGivenFamily = "animals_pets";',
    "private void InstallNativeLocalPlaySessionAnimalGiven(Farmer player, Farm farm, Vector2 startTile)",
    "{",
    "}",
    invoked ? "        InstallNativeLocalPlaySessionAnimalGiven(player, farm, startTile, null);" : "",
  ].join("\n");
}

test("the shipped defect is named: a declared family whose Given is not invoked", () => {
  // Measured 2026-11-09, commit 568a9e18: the coop was switched off in the composed multi-day world and the rotation went
  // on handing out `tend_the_animals`. This is that world, and the finding must name the task AND the family.
  const verdict = verdictFor({ sources: [givenSource({ invoked: false })] });
  assert.equal(verdict.status, "failed");
  assert.deepEqual(verdict.absent, ["animals_pets"]);
  assert.ok(
    verdict.findings.some((entry) => entry.code === "task_requires_absent_family:tend_the_animals:animals_pets"),
    `expected tend_the_animals:animals_pets, saw ${verdict.findings.map((entry) => entry.code).join(", ")}`,
  );
});

test("an invoked Given publishes its family, and nothing else is refused", () => {
  const verdict = verdictFor({ sources: [givenSource({ invoked: true })] });
  assert.equal(verdict.status, "passed", JSON.stringify(verdict.findings));
  assert.deepEqual(verdict.advertised, ["animals_pets"]);
  assert.deepEqual(verdict.findings, []);
});

test("`nameof` in the declaration is not an invocation", () => {
  // The declaration names the method inside `nameof(...)`, so a naive scan reads every advertisement as true - the one
  // reading that would make this gate agree with whatever the fixture claims.
  const source = givenSource({ invoked: false });
  assert.match(source, /nameof\(InstallNativeLocalPlaySessionAnimalGiven\)/u);
  assert.equal(isProviderInvoked("InstallNativeLocalPlaySessionAnimalGiven", [source]), false);
});

test("a commented-out call is not an invocation", () => {
  const source = `${givenSource({ invoked: false })}\n// InstallNativeLocalPlaySessionAnimalGiven(player, farm, startTile, null);\n`;
  assert.equal(isProviderInvoked("InstallNativeLocalPlaySessionAnimalGiven", [source]), false);
});

test("a rotation task that names no family, and an action the catalog has no family for, are both findings", () => {
  const noFamily = rotationRequirement({
    rotation: ["a_task_with_nothing_in_it"],
    taskActions: { a_task_with_nothing_in_it: [] },
    actionFamilies,
  });
  assert.deepEqual(
    noFamily.violations.map((entry) => entry.code),
    ["task_names_no_family:a_task_with_nothing_in_it"],
  );
  const unknownAction = rotationRequirement({
    rotation: ["a_task"],
    taskActions: { a_task: ["an_action_not_in_the_catalog"] },
    actionFamilies,
  });
  // Both are true: the action resolves to no family, and the task therefore names none. A single finding would leave one
  // of the two silences unnamed.
  assert.deepEqual(
    unknownAction.violations.map((entry) => entry.code),
    ["task_action_has_no_family:a_task:an_action_not_in_the_catalog", "task_names_no_family:a_task"],
  );
});

test("a declared family the catalog does not carry is named, not silently compared", () => {
  const source = [
    "internal const string ThingGivenProvider = nameof(InstallThingGiven);",
    'internal const string ThingGivenFamily = "not_a_family";',
    "private void InstallThingGiven()",
    "{",
    "}",
    "        InstallThingGiven();",
  ].join("\n");
  const verdict = verdictFor({ sources: [source] });
  assert.ok(
    verdict.findings.some((entry) => entry.code.startsWith("unknown_declared_family:not_a_family")),
    verdict.findings.map((entry) => entry.code).join(", "),
  );
});

test("a half-written advertisement is a finding, not a silent one-sided claim", () => {
  const verdict = verdictFor({
    sources: ['internal const string PlaySessionAnimalGivenFamily = "animals_pets";'],
  });
  assert.ok(
    verdict.findings.some((entry) =>
      entry.code.startsWith("world_family_declaration_half_written:family_without_provider"),
    ),
    verdict.findings.map((entry) => entry.code).join(", "),
  );
});

test("zero population is BLOCKED, never green", () => {
  // Three zeroes, told apart: no rotation, no advertisement, and nothing to examine against it.
  const noRotation = verdictFor({
    sources: [givenSource({ invoked: true })],
    requirement: { tasks: [], violations: [] },
  });
  assert.equal(noRotation.status, "blocked");
  assert.equal(noRotation.blocked, "no_rotation_tasks");
  const noAdvertisement = verdictFor({ sources: [] });
  assert.equal(noAdvertisement.status, "blocked");
  assert.equal(noAdvertisement.blocked, "world_advertises_no_target_family");
});

test("the REAL fixture advertises the animal family to the REAL rotation", () => {
  // The arm that keeps the fix from being undone: the composed play-session world invokes the coop Given, so the family
  // `tend_the_animals` names is published. Re-disabling that call turns this red with the code above.
  const fixturesDir = fileURLToPath(FIXTURES_DIR);
  const sources = readdirSync(fixturesDir)
    .filter((name) => name.startsWith("ModEntry.Fixtures") && name.endsWith(".cs"))
    .sort()
    .map((name) => readFileSync(join(fixturesDir, name), "utf8"));
  assert.ok(sources.length > 10, `expected the fixture partials, saw ${String(sources.length)}`);
  const verdict = verdictFor({ sources });
  assert.deepEqual(verdict.findings, [], verdict.findings.map((entry) => entry.code).join(", "));
  assert.deepEqual(verdict.advertised, ["animals_pets"]);
  assert.ok(verdict.examined > 50, `expected every task family to be examined, saw ${String(verdict.examined)}`);
});
