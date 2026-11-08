/**
 * How much of the published action surface one run actually used.
 *
 * WHY THIS EXISTS. Measured 2026-11-07 on `round39`: the bundle reported `executionTrace: { ok: true, rows: 124 }`
 * and a session verdict of `completed`, and the run was judged on its other clauses. Those 124 executions were 15
 * distinct actions out of the 95 the Mod publishes, and one action (`cut_weeds`, 32 executions) held a quarter of
 * them. Nothing in the artifact said so, so "the actions are fine" was measured only over the few safe repeats the
 * model had degenerated to. A count of executions cannot tell a varied day from 124 repetitions of the three
 * actions that cannot go wrong; the count has to be read against the COVERAGE it was achieved over.
 *
 * THREE MEASUREMENTS, each answering a question the others cannot:
 *   - coverage: attempted and succeeded, against the PUBLISHED population. The population comes from
 *     `stardew-published-action-registry.mjs`, which parses the Mod's own registration table - a list written here
 *     would be a second spelling of the catalog and would fail open the first time an action is published.
 *   - families: the distinct Mod action families among the attempts, so "15 actions" cannot hide that every one of
 *     them was farming.
 *   - concentration: the largest single action's share of the run's EXECUTIONS. Coverage can read acceptably while
 *     the day was one action repeated, which is exactly the shape round39 had.
 *
 * THE RATCHET. `tools/action-breadth-baseline.json` records the best breadth each scenario has shown, plus the
 * actions a fixture cannot reach with the reason each one cannot. A run below the recorded best is
 * `narrow:below_baseline:<label>`; an action that was excluded and then attempted anyway is
 * `narrow:excluded_action_attempted:<actionId>`, because a carve-out that has silently stopped being true makes
 * every later reading smaller than it looks.
 *
 * NOT MEASURED IS NOT NARROW. `not_measured:<reason>` is a state of its own, never folded into `rich` - and never
 * into `narrow` either: a gate that cannot judge must say so instead of failing the run it was handed.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readAllPublishedExecutionStardewActionIds,
  readStardewActionFamilies,
} from "./stardew-published-action-registry.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Where the ratchet and its declared exclusions live. Data, so a reader audits numbers and reasons in one place. */
export const ACTION_BREADTH_BASELINE_PATH = resolve(root, "tools", "action-breadth-baseline.json");

/**
 * One action holding more than this share of a run's executions is repetition, not variety.
 *
 * 40 % is a threshold with a measurement behind it rather than a round number. Over the multiday bundles on this
 * machine that carry a program journal, every run above it is one whose journal is dominated by a single safe
 * action (`move_to_tile` at 80 % on `round25`, 65 % on `round23`, 63 % on `round21`), and the best-covered run
 * (`round38`) sits at 22 % (`break_rock`). Below it, the largest action is one part of a day rather than the day.
 */
export const ACTION_BREADTH_CONCENTRATION_SHARE = 0.4;

/** The verdict a run earns when it is neither narrow nor unmeasurable. */
export const ACTION_BREADTH_RICH = "rich";

/** An action the family table does not name. REPORTED, never dropped: a silent skip would shrink the denominator. */
export const UNMAPPED_FAMILY = "unmapped";

function fail(code) {
  throw new Error(`action_breadth_${code}`);
}

/**
 * The population a run is measured against: every published, non-experimental Mod registration, with its family.
 *
 * All published execution actions, including the ones the descriptor gate exempts: an exemption from a descriptor
 * contract is not an exemption from being dispatchable, and leaving `navigate_to_destination` out would let a
 * navigation-heavy run read as narrower than the surface it actually had.
 */
export async function readActionBreadthSurface() {
  const actionIds = await readAllPublishedExecutionStardewActionIds();
  if (!Array.isArray(actionIds) || actionIds.length === 0) fail("published_action_population_empty");
  const familyOf = readStardewActionFamilies();
  const families = new Map(actionIds.map((actionId) => [actionId, familyOf.get(actionId) ?? UNMAPPED_FAMILY]));
  return Object.freeze({
    actionIds,
    families,
    familyCount: new Set(families.values()).size,
  });
}

/**
 * The ratchet, read and validated. A baseline file that cannot be trusted is REFUSED rather than defaulted: a
 * missing exemption reason would otherwise become a smaller denominator nobody can audit.
 */
export async function readActionBreadthBaseline({ path = ACTION_BREADTH_BASELINE_PATH } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`baseline_unreadable:${String(error instanceof Error ? error.message : error)}`);
  }
  const baselines = parsed?.baselines;
  if (baselines === null || typeof baselines !== "object" || Array.isArray(baselines))
    fail("baseline_missing_baselines");
  for (const [scenario, entry] of Object.entries(baselines)) {
    if (typeof entry?.label !== "string" || entry.label.length === 0) fail(`baseline_label_missing:${scenario}`);
    if (!Number.isInteger(entry?.attempted) || entry.attempted <= 0) fail(`baseline_attempted_invalid:${scenario}`);
    if (!Number.isInteger(entry?.families) || entry.families <= 0) fail(`baseline_families_invalid:${scenario}`);
  }
  const exclusions = parsed?.exclusions ?? [];
  if (!Array.isArray(exclusions)) fail("baseline_exclusions_not_a_list");
  for (const entry of exclusions) {
    if (typeof entry?.actionId !== "string" || entry.actionId.length === 0) fail("baseline_exclusion_without_action");
    // The same discipline the prelive gate register applies to its own exemptions: a reason too short to name the
    // fact is a finding, because "unreachable" is an opinion until it says which native precondition makes it so.
    if (typeof entry?.reason !== "string" || entry.reason.length < 40)
      fail(`baseline_exclusion_unreasoned:${entry.actionId}`);
  }
  return Object.freeze({ baselines, exclusions });
}

/** The join key between a journal node (`(programId, nodeId)`) and the candidate the Host submitted. */
function nodeKey(programId, nodeId) {
  return `${String(programId)}\u001f${String(nodeId)}`;
}

/**
 * Executions per action, from both channels of a run's record.
 *
 * A flat dispatch carries its own `action`; a program execution row carries only the journal's identity, so its action
 * is joined from the candidate the Host submitted - never guessed. An execution whose node is absent from that
 * candidate is attributed to NOTHING, and the caller is told how many, because attributing it to "unknown" would let
 * an unreadable journal look like one more action.
 *
 * `programRows` are the DEDUPLICATED rows `execution-trace.mjs` owns (`programExecutionRows`): the identity of one
 * execution is that module's fact, and re-deriving it here would be a second spelling of it.
 */
export function actionExecutionCounts({ actionRows = null, programRows = [], programSubmissions = [] } = {}) {
  const actionOfNode = new Map();
  for (const submission of programSubmissions ?? []) {
    if (typeof submission?.programId !== "string") continue;
    for (const node of submission?.nodes ?? []) {
      if (typeof node?.nodeId !== "string" || typeof node?.actionId !== "string") continue;
      actionOfNode.set(nodeKey(submission.programId, node.nodeId), node.actionId);
    }
  }
  const counts = new Map();
  let attributed = 0;
  const record = (actionId) => {
    if (typeof actionId !== "string" || actionId.length === 0) return;
    counts.set(actionId, (counts.get(actionId) ?? 0) + 1);
    attributed += 1;
  };
  for (const row of actionRows ?? []) record(row?.action);
  for (const row of programRows ?? []) record(actionOfNode.get(nodeKey(row?.programId, row?.nodeId)));
  return { counts, attributed };
}

/**
 * The whole reading: coverage, families, concentration, the ratchet, and the one verdict they add up to.
 *
 * `attempted` / `succeeded` are the run's OWN published lists rather than a second derivation here, so the artifact
 * and this reading cannot disagree about which actions the run used. `executions` is the run's declared execution
 * count (`executionTrace.rows`), and `actionRows` / `programRows` are the two halves of that trace when the caller
 * holds them; a caller that has only the result file passes `actionRows: null`, and the flat executions are then
 * reported as unattributed instead of being silently left out of the concentration.
 */
export async function measureActionBreadth({
  scenario = null,
  attempted = [],
  succeeded = [],
  executions = 0,
  actionRows = null,
  programRows = [],
  programSubmissions = [],
  surface = null,
  baseline = null,
} = {}) {
  const resolvedSurface = surface ?? (await readActionBreadthSurface());
  const resolvedBaseline = baseline ?? (await readActionBreadthBaseline());
  const published = new Set(resolvedSurface.actionIds);
  const exclusions = new Map((resolvedBaseline.exclusions ?? []).map((entry) => [entry.actionId, entry]));
  const attemptedIds = Object.freeze([...new Set(attempted)]);
  const succeededSet = new Set(succeeded);
  const familyOf = (actionId) => resolvedSurface.families.get(actionId) ?? UNMAPPED_FAMILY;
  const familyNames = Object.freeze([...new Set(attemptedIds.map(familyOf))].sort());
  const { counts, attributed } = actionExecutionCounts({ actionRows, programRows, programSubmissions });
  // The run's declared count is the authority for "how many executions this run had"; the per-action counts only say
  // how many of them could be named. A caller that publishes no count falls back to what it attributed.
  const total = Number.isInteger(executions) && executions > 0 ? executions : attributed;
  const unattributed = Math.max(0, total - attributed);
  const largest = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0] ?? null;
  const concentration =
    largest === null || unattributed > 0
      ? null
      : Object.freeze({
          actionId: largest[0],
          family: familyOf(largest[0]),
          executions: largest[1],
          share: largest[1] / attributed,
        });
  const concentrationReason =
    concentration !== null
      ? null
      : unattributed > 0
        ? `executions_unattributed:${String(unattributed)}`
        : total === 0
          ? "no_executions"
          : "no_execution_attributed_to_an_action";
  const outsidePopulation = Object.freeze(attemptedIds.filter((actionId) => !published.has(actionId)));
  const excludedAttempted = Object.freeze(attemptedIds.filter((actionId) => exclusions.has(actionId)));
  // An exemption whose action left the catalog is an exemption nobody can act on, so it is named rather than kept.
  const staleExclusions = Object.freeze([...exclusions.keys()].filter((actionId) => !published.has(actionId)));
  const scenarioBaseline = scenario === null ? null : (resolvedBaseline.baselines[scenario] ?? null);
  const perAction = Object.freeze(
    [...new Set([...counts.keys(), ...attemptedIds])]
      .map((actionId) =>
        Object.freeze({
          actionId,
          family: familyOf(actionId),
          executions: counts.get(actionId) ?? 0,
          succeeded: succeededSet.has(actionId),
          excluded: exclusions.has(actionId),
        }),
      )
      .sort((left, right) => right.executions - left.executions || left.actionId.localeCompare(right.actionId)),
  );
  const verdict = deriveVerdict({
    published,
    attemptedCount: attemptedIds.length,
    familyCount: familyNames.length,
    total,
    concentration,
    excludedAttempted,
    staleExclusions,
    outsidePopulation,
    scenario,
    scenarioBaseline,
  });
  return Object.freeze({
    scenario,
    attempted: attemptedIds.length,
    succeeded: succeededSet.size,
    published: published.size,
    judged: published.size - [...exclusions.keys()].filter((actionId) => published.has(actionId)).length,
    families: familyNames.length,
    publishedFamilies: resolvedSurface.familyCount,
    familyNames,
    executions: total,
    attributedExecutions: attributed,
    unattributedExecutions: unattributed,
    concentration,
    concentrationReason,
    baseline: scenarioBaseline === null ? null : Object.freeze({ ...scenarioBaseline }),
    // Named rather than folded into the verdict alone: an exclusion that was attempted, an exclusion whose action has
    // left the catalog, and an attempt on an action this tree does not publish are three different facts about the
    // list and the surface, and a reader has to be able to act on each one.
    excludedAttempted,
    staleExclusions,
    outsidePopulation,
    perAction,
    verdict,
  });
}

/**
 * The verdict, in the order a reader should be told about it.
 *
 * Every `narrow:` arm is decided BEFORE the measurement gaps, because a run that was both narrow and unmeasurable in
 * some corner is narrow: the gap explains a missing number, not a missing variety.
 */
function deriveVerdict({
  published,
  attemptedCount,
  familyCount,
  total,
  concentration,
  excludedAttempted,
  staleExclusions,
  outsidePopulation,
  scenario,
  scenarioBaseline,
}) {
  if (total === 0 && attemptedCount === 0) return "not_measured:no_executions";
  if (excludedAttempted.length > 0) return `narrow:excluded_action_attempted:${excludedAttempted.join(",")}`;
  if (concentration !== null && concentration.share > ACTION_BREADTH_CONCENTRATION_SHARE)
    return `narrow:concentrated_on:${concentration.actionId}`;
  if (
    scenarioBaseline !== null &&
    (attemptedCount < scenarioBaseline.attempted || familyCount < scenarioBaseline.families)
  )
    return `narrow:below_baseline:${scenarioBaseline.label}`;
  if (published.size === 0) return "not_measured:published_action_population_empty";
  if (staleExclusions.length > 0) return `not_measured:excluded_action_not_published:${staleExclusions.join(",")}`;
  if (outsidePopulation.length > 0) return `not_measured:attempted_outside_population:${outsidePopulation.join(",")}`;
  if (scenarioBaseline === null) return `not_measured:no_baseline_for_scenario:${scenario ?? "none"}`;
  return ACTION_BREADTH_RICH;
}

/**
 * The run's `action_breadth` clause: narrow is a failed clause, unmeasurable is not.
 *
 * A measurement this tree could not take is our gap, and charging it to the companion would be the same mistake as a
 * gate that cannot judge and fails anyway - so `not_measured:` passes and stays visible in the published verdict.
 */
export function actionBreadthClause(breadth) {
  const verdict = typeof breadth?.verdict === "string" ? breadth.verdict : "not_measured:action_breadth_unreadable";
  return Object.freeze({ id: "action_breadth", passed: !verdict.startsWith("narrow:"), reasonCode: verdict });
}

/** The reading as lines a terminal or a run log can carry, one fact per line, population first. */
export function formatActionBreadth(breadth) {
  const share =
    breadth.concentration === null
      ? `not_judged (${breadth.concentrationReason ?? "no_concentration_reading"})`
      : `${breadth.concentration.actionId} ${breadth.concentration.executions} (${(breadth.concentration.share * 100).toFixed(1)}%)`;
  const coverage = breadth.published === 0 ? 0 : (breadth.attempted / breadth.published) * 100;
  return Object.freeze([
    `action_breadth: population ${String(breadth.published)} published, ${String(breadth.judged)} judged (${String(breadth.published - breadth.judged)} excluded)`,
    `action_breadth: attempted ${String(breadth.attempted)} of ${String(breadth.published)} (${coverage.toFixed(1)}%); succeeded ${String(breadth.succeeded)} of ${String(breadth.published)}`,
    `action_breadth: families ${String(breadth.families)} of ${String(breadth.publishedFamilies)}${breadth.familyNames.length === 0 ? "" : ` ${breadth.familyNames.join(",")}`}`,
    `action_breadth: executions ${String(breadth.executions)} (${String(breadth.attributedExecutions)} attributed); concentration ${share}`,
    `action_breadth: verdict ${breadth.verdict}`,
  ]);
}
