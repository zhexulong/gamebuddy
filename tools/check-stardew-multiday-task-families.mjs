#!/usr/bin/env node
/**
 * Does the multi-day world actually publish every target family its day's task names?
 *
 * <p>
 * The defect: `tend_the_animals` was rotated into a world with no coop in it. The coop Given had been switched off - its
 * footprint severed the door->field route - and no gate anywhere noticed, because the animal actions have their own
 * single-action fixtures which build their own coop. A green gate proved by deleting the subject.
 * </p>
 *
 * <p>
 * Two readings: the tasks come from `tools/lib/multiday-daily-tasks.mjs` BY IMPORT (a regex over its text would keep
 * passing after the table moved), with action->family from the Mod's registration catalog; and the world's advertisement
 * comes from the fixture's own declarations, where a Given states the family it makes publishable beside the method that
 * installs it. That statement is only true while the method is invoked, which is asked of the fixture source - so
 * deleting the call is what turns this gate red, exactly as deleting the call shipped the defect.
 * </p>
 *
 * <p>
 * The rules and their falsifiers live in `tools/lib/multiday-task-families.mjs` (tested by `multiday-task-families
 * .test.mjs`); this runs them against the real tree.
 * </p>
 *
 * <p>
 * The default run IS this gate's self-verification report: one summary line stating what was examined, then a JSON
 * object carrying `population` and a `checks[]` entry for each rule below, its status DERIVED from the findings that
 * came back. `every_finding_code_is_a_declared_rule` is what keeps that list honest - a finding no rule claims is red
 * on the rule nobody wrote. `tools/check-harness-conformance.mjs` reads the report rather than this prose.
 * </p>
 *
 * <pre>
 *   node tools/check-stardew-multiday-task-families.mjs
 * </pre>
 *
 * <p>
 * Exit 1 on a task whose family the world does not publish; exit 2 (blocked, never green) when a prerequisite is absent -
 * no rotation, no advertisement, or nothing to examine.
 * </p>
 *
 * red-proof: inject  the shipped state, the coop Given declared but not invoked ->
 *                    `task_requires_absent_family:tend_the_animals:animals_pets` and exit 1
 *                    (tools/lib/multiday-task-families.test.mjs)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DAILY_TASK_ACTION_HINTS, DAILY_TASK_ROTATION, SWEEP_DAILY_TASKS } from "./lib/multiday-daily-tasks.mjs";
import {
  isProviderInvoked,
  multidayTaskFamilyVerdict,
  parseWorldTargetFamilies,
  rotationRequirement,
} from "./lib/multiday-task-families.mjs";
import { readStardewActionFamilies } from "./lib/stardew-published-action-registry.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES_DIR = join(REPO, "integrations", "stardew");

/** The finding code a verdict entry carries, without the ids it names: `task_requires_absent_family:tend_the_animals` -> `task_requires_absent_family`. */
const codeOf = (entry) => String(entry.code).split(":")[0];

/** The one spelling of the code this file both writes (an unpaired advertisement) and claims as a rule. */
const HALF_WRITTEN = "world_family_declaration_half_written";

/**
 * The rules this gate can report red, each owning the finding codes that break it.
 *
 * <p>
 * `checks[]` is derived from this table and from the findings that came back - never asserted beside them, which is how
 * a report ends up agreeing with itself. The three population rules are the zeroes told apart, so a run that examined
 * nothing is `blocked` rather than `passed`.
 * </p>
 */
const RULES = Object.freeze([
  Object.freeze({ id: "rotation_task_names_a_published_family", codes: ["task_requires_absent_family"] }),
  Object.freeze({ id: "every_task_action_has_a_family", codes: ["task_action_has_no_family"] }),
  Object.freeze({ id: "every_rotation_task_names_a_family", codes: ["task_names_no_family"] }),
  Object.freeze({ id: "every_declared_family_is_a_catalog_family", codes: ["unknown_declared_family"] }),
  Object.freeze({ id: "every_advertisement_is_whole", codes: [HALF_WRITTEN] }),
]);

/** The per-rule outcomes a verdict supports, plus the guard that a finding is claimed by one of them. */
function reportChecks(verdict) {
  const drawn = verdict.findings.map(codeOf);
  const population = (reason) => (verdict.blocked === reason ? "blocked" : "passed");
  const checks = [
    { id: "rotation_population_non_empty", status: population("no_rotation_tasks") },
    { id: "world_advertisement_non_empty", status: population("world_advertises_no_target_family") },
    { id: "task_family_pairs_examined", status: population("no_task_family_pair_examined") },
  ];
  for (const rule of RULES) {
    const broken = verdict.findings.filter((entry) => rule.codes.includes(codeOf(entry)));
    checks.push({
      id: rule.id,
      status: broken.length === 0 ? "passed" : "failed",
      ...(broken.length === 0 ? {} : { detail: broken.map((entry) => entry.code).join(", ") }),
    });
  }
  const claimed = new Set(RULES.flatMap((rule) => rule.codes));
  const unclaimed = drawn.filter((code) => !claimed.has(code));
  checks.push({
    id: "every_finding_code_is_a_declared_rule",
    status: unclaimed.length === 0 ? "passed" : "failed",
    ...(unclaimed.length === 0 ? {} : { detail: `no rule claims ${[...new Set(unclaimed)].join(", ")}` }),
  });
  return checks;
}

if (import.meta.main) {
  // The fixture partials: every `ModEntry.Fixtures*.cs`, because the Given that provisions the targets and the composed
  // world that invokes it are different files of one partial class.
  const fixtureSources = readdirSync(FIXTURES_DIR)
    .filter((name) => name.startsWith("ModEntry.Fixtures") && name.endsWith(".cs"))
    .sort()
    .map((name) => readFileSync(join(FIXTURES_DIR, name), "utf8"));

  const { declarations, unpaired } = parseWorldTargetFamilies(fixtureSources);
  const producedFamilies = declarations
    .filter((declaration) => isProviderInvoked(declaration.provider, fixtureSources))
    .map((declaration) => declaration.family);

  const actionFamilies = readStardewActionFamilies();
  const requirement = rotationRequirement({
    rotation: DAILY_TASK_ROTATION,
    taskActions: DAILY_TASK_ACTION_HINTS,
    actionFamilies,
    sweepFamilies: new Map(SWEEP_DAILY_TASKS.map((task) => [task.id, task.families])),
  });

  const verdict = multidayTaskFamilyVerdict({
    tasks: requirement.tasks,
    violations: [...requirement.violations, ...unpaired.map((entry) => ({ code: `${HALF_WRITTEN}:${entry}` }))],
    declarations,
    producedFamilies,
    knownFamilies: new Set(actionFamilies.values()),
  });

  const checks = reportChecks(verdict);
  process.stdout.write(
    `multiday_task_families examined ${String(verdict.examined)} task-family pair(s) · rotation ` +
      `${String(verdict.tasks)} · declared ${String(verdict.declaredFamilies)} · advertised ` +
      `${verdict.advertised.join(",") || "none"} · status ${verdict.status}` +
      `${verdict.blocked === null ? "" : ` (${verdict.blocked})`}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      gate: "stardew_multiday_task_families/v1",
      status: verdict.status,
      blocked: verdict.blocked,
      rotation: verdict.tasks,
      population: verdict.examined,
      declaredFamilies: verdict.declaredFamilies,
      advertised: verdict.advertised,
      absent: verdict.absent,
      checks,
      findings: verdict.findings,
    })}\n`,
  );
  if (verdict.status === "blocked") process.exitCode = 2;
  else if (verdict.status === "failed") process.exitCode = 1;
}
