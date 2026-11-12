#!/usr/bin/env node
/**
 * Is every published execution action asked for by some daily task, or explained by a named blocker?
 *
 * <p>
 * The problem: 101 actions were published as execution actions while the multi-day task rotation named a small
 * subset, so a run could be entirely green and most of the surface never touched. `enter_mine` was published,
 * correct, gated and used in zero runs for months - because nothing ever asked for a mine. The same is true of
 * whatever was published last week, and no amount of reading the task table tells you which actions those are.
 * </p>
 *
 * <h2>Two derivations, deliberately independent</h2>
 * <ul>
 *   <li>POPULATION comes from the Mod-owned generated surface artifact (`kind: "execution"`). Never a hand list:
 *       a list can only catch what its author remembered, and it fails open the moment an action is published.</li>
 *   <li>COVERED is the union of the action ids every task entry names, read by IMPORTING
 *       `tools/lib/multiday-daily-tasks.mjs`. Parsing the source with a regex would read a second, textual copy of
 *       the table and would keep passing after the table moved.</li>
 * </ul>
 * <p>
 * The gate reads the artifact itself rather than taking the population from the task module, on purpose: the two
 * readings are the measurement. If the sweep builder's filter ever narrowed, this gate reports the actions it
 * stopped covering instead of agreeing with it.
 * </p>
 *
 * <h2>The exclusion table</h2>
 * <p>
 * An uncovered action is allowed ONLY by an entry in `TASK_ACTION_EXCLUSIONS` whose `reason` names the concrete
 * blocker - a second player, a horse, an island that needs unlocking. The table is validated in both directions,
 * so it cannot rot into a list of actions nobody looked at:
 * </p>
 * <ul>
 *   <li>an exclusion whose action IS covered fails the gate - the reason has been overtaken, delete the entry;</li>
 *   <li>an exclusion naming an action the surface does not publish fails the gate - it is a typo or a retired
 *       action;</li>
 *   <li>an exclusion whose reason is too short to name anything fails the gate.</li>
 * </ul>
 *
 * <h2>Usage</h2>
 * <pre>
 *   node tools/check-stardew-task-action-coverage.mjs
 * </pre>
 * <p>
 * Exit 1 on any uncovered action with no exclusion, or on any exclusion the checks above refuse.
 * </p>
 *
 * red-proof: inject  a published execution action no task names and no exclusion explains ->
 *                    `uncovered_action_without_an_exclusion:ghost_action` and exit 1; and an exclusion for a
 *                    covered action -> `exclusion_names_a_covered_action:cut_weeds`
 *                    (tools/check-stardew-task-action-coverage.test.mjs)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DAILY_TASK_ACTION_HINTS } from "./lib/multiday-daily-tasks.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SURFACE = join(
  REPO,
  "integrations",
  "stardew",
  "action-development",
  "contracts",
  "generated",
  "action-surface.v1.json",
);

/** A reason has to name something: this is the floor below which it names nothing. */
const MINIMUM_REASON_LENGTH = 40;

/**
 * The published execution actions no task can ask for, each with the blocker that makes asking impossible.
 *
 * The bar for an entry is higher than "the fixture may not contain it": the existing rotation already asks for
 * things a bare farm may not have (`home_upgrade`, `town_market`), and those days are allowed to end in "there is
 * nothing here to do", which is a true observation. An action belongs here only when a task asking for it would be
 * a FALSE statement about the world - there is no second player to speak to, no horse to mount, no bus that runs.
 *
 * Removing an entry needs no ceremony: the moment a task names the action, this gate fails and the entry goes.
 */
export const TASK_ACTION_EXCLUSIONS = Object.freeze([
  Object.freeze({
    actionId: "send_multiplayer_chat",
    reason:
      "needs a second connected player: the play-session fixture is one Farmhand in a single-player world, so a message would be sent to nobody while its `chat_message_sent` receipt reported a delivery.",
  }),
  Object.freeze({
    actionId: "mount_transport",
    reason:
      "needs a Horse, which a Farmhand never owns: the horse belongs to the farm owner's stable, the fixture builds no buildings, and there is never one standing in the world to mount.",
  }),
  Object.freeze({
    actionId: "dismount_transport",
    reason:
      "the counterpart of `mount_transport`: with no horse to mount there is nothing to dismount, so the action has no target a task could truthfully ask for.",
  }),
  Object.freeze({
    actionId: "use_raft",
    reason:
      "needs Ginger Island's raft: the raft only exists once the island is unlocked by the boat repair, and the play-session fixture starts on a spring farm with no island access.",
  }),
  Object.freeze({
    actionId: "ride_bus",
    reason:
      "needs a bus that runs: the BusStop bus is out of service until the Vault community-centre bundle is paid, so a fresh fixture has a broken-down bus and nothing to board.",
  }),
  Object.freeze({
    actionId: "use_obelisk",
    reason:
      "needs an obelisk the player has already built: an obelisk is a farm building bought and placed by the owner, the fixture places no buildings, and no task can construct one.",
  }),
]);

/**
 * The coverage reading, as data.
 *
 * Pure, so the falsifier can hand it a population the repository does not have. `actions` is the artifact's
 * execution population with the lifecycle each one declares; `taskActionHints` is the task table as the task module
 * exports it; `exclusions` is the table above.
 */
export function taskActionCoverage({ actions, taskActionHints, exclusions = TASK_ACTION_EXCLUSIONS }) {
  const violations = [];
  const published = new Set(actions.map((action) => action.actionId));
  const named = new Set(Object.values(taskActionHints ?? {}).flat());
  const reasonOf = new Map();
  for (const entry of exclusions) {
    if (reasonOf.has(entry.actionId)) {
      violations.push({ code: `exclusion_declared_twice:${entry.actionId}`, where: "TASK_ACTION_EXCLUSIONS" });
      continue;
    }
    reasonOf.set(entry.actionId, entry.reason);
  }

  // An exclusion that has been overtaken, or that names something the surface does not carry.
  for (const [actionId, reason] of reasonOf) {
    if (named.has(actionId)) violations.push({ code: `exclusion_names_a_covered_action:${actionId}`, where: actionId });
    else if (!published.has(actionId))
      violations.push({ code: `exclusion_names_an_unpublished_action:${actionId}`, where: actionId });
    if (typeof reason !== "string" || reason.trim().length < MINIMUM_REASON_LENGTH)
      violations.push({ code: `exclusion_reason_names_no_blocker:${actionId}`, where: actionId });
  }

  const uncovered = [];
  for (const action of actions) {
    if (named.has(action.actionId)) continue;
    const reason = reasonOf.get(action.actionId);
    uncovered.push(
      Object.freeze({
        actionId: action.actionId,
        lifecycle: action.lifecycle,
        reason: reason ?? null,
      }),
    );
    if (reason === undefined) {
      violations.push({ code: `uncovered_action_without_an_exclusion:${action.actionId}`, where: action.actionId });
    }
  }

  return Object.freeze({
    total: actions.length,
    covered: actions.length - uncovered.length,
    excluded: uncovered.filter((entry) => entry.reason !== null).length,
    tasks: Object.keys(taskActionHints ?? {}).length,
    uncovered: Object.freeze(uncovered),
    violations: Object.freeze(violations),
  });
}

/** The artifact's execution population with each action's declared lifecycle, and the task table. */
export function readCoverageInputs({ surfacePath = SURFACE } = {}) {
  const artifact = JSON.parse(readFileSync(surfacePath, "utf8"));
  const actions = (artifact.actions ?? [])
    .filter((action) => action.kind === "execution")
    .map((action) => Object.freeze({ actionId: action.actionId, lifecycle: action.lifecycle }));
  return Object.freeze({ actions: Object.freeze(actions), taskActionHints: DAILY_TASK_ACTION_HINTS });
}

if (import.meta.main) {
  // The population is the artifact's published execution actions, and it is printed on every run: `covered 97 of 103`
  // answers "how much" only beside `actions examined 103`.
  const report = taskActionCoverage(readCoverageInputs());
  const lines = [
    `stardew_task_action_coverage: actions examined ${String(report.total)} · covered ${String(report.covered)} · ` +
      `excluded ${String(report.excluded)} · tasks ${String(report.tasks)}`,
  ];
  for (const entry of report.uncovered) {
    lines.push(
      entry.reason === null
        ? `  UNCOVERED ${entry.actionId} [${entry.lifecycle}]`
        : `  ${entry.actionId} [${entry.lifecycle}] excluded: ${entry.reason}`,
    );
  }
  for (const violation of report.violations) lines.push(`  violation ${violation.code}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  if (report.violations.length > 0) process.exitCode = 1;
}
