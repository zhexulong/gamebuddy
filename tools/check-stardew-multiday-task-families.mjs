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
    violations: [
      ...requirement.violations,
      ...unpaired.map((entry) => ({ code: `world_family_declaration_half_written:${entry}` })),
    ],
    declarations,
    producedFamilies,
    knownFamilies: new Set(actionFamilies.values()),
  });

  process.stdout.write(
    `${JSON.stringify({
      gate: "stardew_multiday_task_families/v1",
      status: verdict.status,
      blocked: verdict.blocked,
      rotation: verdict.tasks,
      examined: verdict.examined,
      declaredFamilies: verdict.declaredFamilies,
      advertised: verdict.advertised,
      absent: verdict.absent,
      findings: verdict.findings,
    })}\n`,
  );
  if (verdict.status === "blocked") process.exitCode = 2;
  else if (verdict.status === "failed") process.exitCode = 1;
}
