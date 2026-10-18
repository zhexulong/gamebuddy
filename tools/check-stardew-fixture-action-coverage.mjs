/**
 * The gate for a fixture lane granting what its run needs.
 *
 * `tools/lib/fixture-action-coverage.mjs` holds the rules and their falsifiers; this runs them against the real
 * fixture and the real published surface, and adds the cross-check that ties the two together: the action the
 * launcher passes for the multi-day scenario must be a DECLARED lane, and that lane must carry the actions that
 * run cannot work without.
 *
 *   node tools/check-stardew-fixture-action-coverage.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fixtureActionCoverageViolations,
  parseFixtureActionSets,
  REQUIRED_LANE_ACTIONS,
} from "./lib/fixture-action-coverage.mjs";
import { fixtureScenario } from "./lib/stardew-native-local-player-fixture.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(REPO, "tools", "lib", "stardew-native-local-player-fixture.mjs");
const RUNNER = join(REPO, "tools", "live-run", "game", "run-stardew-native-local-agent-ab-live.mjs");
/** The scenario key the runner publishes for the multi-day lane. */
const LANE_SCENARIO_KEY = "multiday_routine";
const SURFACE = join(
  REPO,
  "integrations",
  "stardew",
  "action-development",
  "contracts",
  "generated",
  "action-surface.v1.json",
);

const checks = [];
const check = (id, ok, detail) =>
  checks.push({ id, status: ok ? "passed" : "failed", ...(detail === undefined ? {} : { detail }) });
const violations = [];
const violation = (code, where) => violations.push({ code, where });

const sets = parseFixtureActionSets(readFileSync(FIXTURE, "utf8"));
const publishedIds = new Set(JSON.parse(readFileSync(SURFACE, "utf8")).actions.map((action) => action.actionId));
for (const entry of fixtureActionCoverageViolations({ sets, publishedIds, required: REQUIRED_LANE_ACTIONS })) {
  violation(entry.code, entry.where);
}

// The join the fixture rules cannot make on their own.
//
// The `--action` value (which selects the LANE, and therefore the enabled set) is chosen by the operator, while the
// runner requires a Mod FIXTURE SCENARIO by name (`REQUIRED_FIXTURE_SCENARIO`). Nothing tied the two together, which
// is how the night's worst blocker was reachable: a lane whose set omitted an action the night needs, passing both
// the runner's own admission check and this gate. The fixture already owns the mapping between them
// (`fixtureScenario(actions, action)`), so the gate asserts the lane REQUIRED_LANE_ACTIONS names really does produce
// the scenario the runner demands.
const runner = readFileSync(RUNNER, "utf8");
const requiredScenario = new RegExp(`${LANE_SCENARIO_KEY}:\\s*"([a-z0-9_]+)"`, "u").exec(runner)?.[1] ?? null;
check("runner_declares_the_multiday_fixture_scenario", requiredScenario !== null, String(requiredScenario));
const lane = "play_session_multi_day";
const laneSet = sets.get(lane) ?? [];
if (requiredScenario !== null) {
  if (laneSet.length === 0) {
    violation(`required_lane_not_declared:${lane}`, FIXTURE);
  } else {
    const produced = fixtureScenario(laneSet, lane);
    check(
      "the_required_lane_produces_the_required_scenario",
      produced === requiredScenario,
      `${lane} -> ${produced}; runner requires ${requiredScenario}`,
    );
    if (produced !== requiredScenario) violation(`lane_scenario_mismatch:${lane}:${produced}`, FIXTURE);
  }
}
for (const [lane, required] of Object.entries(REQUIRED_LANE_ACTIONS)) {
  const granted = sets.get(lane) ?? [];
  for (const id of required) {
    check(`lane_${lane}_grants_${id}`, granted.includes(id), granted.join(","));
  }
}

const failed = checks.filter((entry) => entry.status !== "passed");
process.stdout.write(
  `${JSON.stringify({
    gate: "stardew_fixture_action_coverage/v1",
    status: violations.length === 0 && failed.length === 0 ? "passed" : "failed",
    lanes: sets.size,
    publishedActions: publishedIds.size,
    checks,
    violations,
  })}\n`,
);
if (violations.length > 0 || failed.length > 0) process.exitCode = 1;
