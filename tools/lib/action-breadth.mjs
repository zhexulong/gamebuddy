/**
 * How much of the action surface one run COULD address did it actually use.
 *
 * WHY THIS EXISTS. Measured 2026-11-07 on `round39`: the bundle reported `executionTrace: { ok: true, rows: 124 }`
 * and a session verdict of `completed`, and the run was judged on its other clauses. Those 124 executions were 15
 * distinct actions, one (`cut_weeds`, 32 executions) held a quarter of them - and nothing in the artifact said so.
 *
 * THE DENOMINATOR WAS THE SECOND DEFECT. The first version of this reading divided by the 95 actions the Mod
 * publishes. All 95 are dispatchable, but a target-bound action is only constructible while its `*Targets` family is
 * non-empty in the snapshot, and the snapshot is the player's own location within Chebyshev radius 6
 * (`farmhandexecutioncontroller.cs:29`, `:2329-2360`). `ModConfig.NativeLocalPlayerFixture.FixtureScenario` is ONE
 * string arming ONE world (`ModConfig.cs:156`, `:187-245`), so a run's real surface is a fraction of the catalog:
 * measured on `round38`'s own observations, 36 of the 78 target-bound actions ever had a row. Charging a run for the
 * other 59 charges it for the fixture's world, which is the same class of lie as calling 124 executions "varied".
 *
 * THREE MEASUREMENTS, each answering a question the others cannot:
 *   - addressable: what this run could have addressed at all. The families the run's OWN snapshots published with at
 *     least one row (`census`), joined to actions through the discovery audit's `TARGET_FIELD` map, plus the actions
 *     that name no snapshot family at all because their target is the actor's own body, tile or menu. The catalog
 *     population stays visible beside it as context, never as the denominator.
 *   - coverage: attempted and succeeded against that addressable set, and the families they fell in, so "15 actions"
 *     cannot hide that every one of them was farming.
 *   - concentration: the largest single action's share of the run's EXECUTIONS. Coverage can read acceptably while
 *     the day was one action repeated, which is exactly the shape round39 had.
 *
 * THE CENSUS IS THE RUN'S OWN. `buildSnapshotCensus` is fed the snapshots the runner read while the game was live, so
 * the denominator of a run and the world that run was given are the same fact. A bundle that publishes no census
 * cannot be judged: `not_measured:no_snapshot_census`, never a fallback to the catalog and never a guess. The census
 * names every target family, including the ones it saw zero rows of, so "this family was empty" and "nobody looked"
 * stay different answers - `census_family_absent:<family>` is the drift between the census and the catalog.
 *
 * THE RATCHET. `tools/action-breadth-baseline.json` records the best coverage each scenario has shown, plus the
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

// The one declaration of which snapshot family each action's targets are published under. Read from the discovery
// audit rather than copied: a second spelling would go stale the first time a target-bearing action is published, and
// this join is the whole addressable denominator.
import { TARGET_FIELD } from "../audit-stardew-discovery-channels.mjs";
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

/** Who produced a census. Published with it, so a reader knows whose observation the denominator rests on. */
export const SNAPSHOT_CENSUS_SOURCE = "runner_observations";

function fail(code) {
  throw new Error(`action_breadth_${code}`);
}

/** `PetTargets` -> `petTargets`: the snapshot key one action's targets are published under, or null when it has none. */
function snapshotTargetField(field) {
  return typeof field === "string" && field.length > 0 ? `${field[0].toLowerCase()}${field.slice(1)}` : null;
}

/**
 * The population a run is measured against: every published, non-experimental Mod registration, with its family and
 * the snapshot family its targets come from.
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
  const targetFieldOf = new Map();
  for (const actionId of actionIds) {
    const field = snapshotTargetField(TARGET_FIELD[actionId]);
    if (field !== null) targetFieldOf.set(actionId, field);
  }
  return Object.freeze({
    actionIds,
    families,
    familyCount: new Set(families.values()).size,
    // An action absent from this map names no snapshot family: its target is the actor's own body, tile or a menu
    // (the discovery audit's `NON_SNAPSHOT_TARGET_ACTIONS`), so no row count can gate it.
    targetFieldOf,
    targetFields: Object.freeze([...new Set(targetFieldOf.values())].sort()),
  });
}

/**
 * The families one snapshot publishes rows for, accumulated into `rows` (`family -> largest row count seen`).
 *
 * Every non-empty array the snapshot carries is counted, without a list of names: the census is a fact about the
 * snapshot, and narrowing it here to today's target families would hide a family a later action starts reading.
 * `buildSnapshotCensus` is what filters to the families the catalog can join through.
 */
export function addSnapshotToCensus(rows, snapshot) {
  if (snapshot === null || typeof snapshot !== "object") return rows;
  for (const [family, value] of Object.entries(snapshot))
    if (Array.isArray(value) && value.length > 0) rows.set(family, Math.max(rows.get(family) ?? 0, value.length));
  return rows;
}

/**
 * The census a bundle publishes: one entry per target family in the catalog, with the rows the run's snapshots
 * carried for it - `0` included.
 *
 * The zeroes are the point. A census that listed only the families it saw rows for could not be told apart from one
 * that never looked at a family, so an empty world and an unobserved one would read the same, and a later target
 * family added to the catalog would silently vanish from the denominator instead of being reported as drift.
 */
export function buildSnapshotCensus({ surface, rows, snapshots }) {
  const observed = rows instanceof Map ? rows : new Map(Object.entries(rows ?? {}));
  return Object.freeze({
    source: SNAPSHOT_CENSUS_SOURCE,
    snapshots: Number.isInteger(snapshots) && snapshots > 0 ? snapshots : 0,
    families: Object.freeze(
      surface.targetFields.map((family) => Object.freeze({ family, rows: observed.get(family) ?? 0 })),
    ),
  });
}

/**
 * A published census, read back and validated, or null when the bundle carries none this tree can judge.
 *
 * Null covers absent, empty and shapeless alike: each means "this run published no census", which is the one thing
 * the caller must be told, and a second reason code for a malformed census would only be a distinction the reader
 * cannot act on differently.
 */
function normalizeCensus(census) {
  if (census === null || typeof census !== "object" || Array.isArray(census)) return null;
  if (!Number.isInteger(census.snapshots) || census.snapshots <= 0) return null;
  if (!Array.isArray(census.families)) return null;
  const families = census.families.filter(
    (entry) =>
      typeof entry?.family === "string" && entry.family.length > 0 && Number.isInteger(entry.rows) && entry.rows >= 0,
  );
  if (families.length === 0) return null;
  return Object.freeze({
    source: typeof census.source === "string" && census.source.length > 0 ? census.source : "unlabeled",
    snapshots: census.snapshots,
    families: Object.freeze(families.map((entry) => Object.freeze({ family: entry.family, rows: entry.rows }))),
  });
}

/**
 * The addressable set of one run: what it could have done, given the world its snapshots showed it.
 *
 * Target-bound actions need a row in their family; actions that name no family need nothing, because their target is
 * the actor itself. Declared exclusions are subtracted last, and only the ones that were still addressable are
 * reported, so an expired carve-out cannot quietly shrink the denominator.
 */
export function deriveAddressable({ surface, census, exclusions = [] }) {
  const normalized = normalizeCensus(census);
  if (normalized === null) return null;
  const rows = new Map(normalized.families.map((entry) => [entry.family, entry.rows]));
  const excluded = new Set(exclusions);
  const targetBound = [];
  const targetless = [];
  for (const actionId of surface.actionIds) {
    const field = surface.targetFieldOf.get(actionId);
    if (field === undefined) targetless.push(actionId);
    else if ((rows.get(field) ?? 0) > 0) targetBound.push(actionId);
  }
  const addressable = Object.freeze([...targetBound, ...targetless].filter((actionId) => !excluded.has(actionId)));
  const families = Object.freeze(
    [...new Set(targetBound.map((actionId) => surface.targetFieldOf.get(actionId)))].sort().map((family) =>
      Object.freeze({
        family,
        rows: rows.get(family) ?? 0,
        actionIds: Object.freeze(targetBound.filter((actionId) => surface.targetFieldOf.get(actionId) === family)),
      }),
    ),
  );
  return Object.freeze({
    actionIds: addressable,
    targetBound: Object.freeze(targetBound.filter((actionId) => !excluded.has(actionId))),
    targetless: Object.freeze(targetless.filter((actionId) => !excluded.has(actionId))),
    // An exclusion that WOULD have been addressable: the ones a reader has to be able to weigh against the surface.
    excludedAddressable: Object.freeze([...targetBound, ...targetless].filter((actionId) => excluded.has(actionId))),
    families,
    // Every target family the catalog names but the census does not: drift between this tree's catalog and the
    // census the run published (an older runner, a renamed family), named member by member.
    censusFamiliesAbsent: Object.freeze(surface.targetFields.filter((family) => !rows.has(family))),
  });
}

/**
 * The ratchet, read and validated. A baseline file that cannot be trusted is REFUSED rather than defaulted: a
 * missing exemption reason would otherwise become a smaller denominator nobody can audit.
 *
 * `addressable` is nullable on purpose: the entry recorded before this denominator existed measured 24 actions in 11
 * families against the catalog, and its bundle publishes no census, so the width of ITS world is not a gated number.
 * Recording it anyway would put an ungated denominator into the ratchet every later run is compared against.
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
    if (entry?.addressable !== null && entry?.addressable !== undefined) {
      if (!Number.isInteger(entry.addressable) || entry.addressable < entry.attempted)
        fail(`baseline_addressable_invalid:${scenario}`);
    }
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
 * The whole reading: the census, the addressable set, coverage, families, concentration, the ratchet, and the one
 * verdict they add up to.
 *
 * `attempted` / `succeeded` are the run's OWN published lists rather than a second derivation here, so the artifact
 * and this reading cannot disagree about which actions the run used. `census` is the run's own published snapshot
 * census; without it the addressable set is null and no coverage verdict can be reached. `executions` is the run's
 * declared execution count (`executionTrace.rows`), and `actionRows` / `programRows` are the two halves of that trace
 * when the caller holds them; a caller that has only the result file passes `actionRows: null`, and the flat
 * executions are then reported as unattributed instead of being silently left out of the concentration.
 */
export async function measureActionBreadth({
  scenario = null,
  attempted = [],
  succeeded = [],
  executions = 0,
  actionRows = null,
  programRows = [],
  programSubmissions = [],
  census = null,
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
  const resolvedCensus = normalizeCensus(census);
  const addressable = deriveAddressable({
    surface: resolvedSurface,
    census: resolvedCensus,
    exclusions: [...exclusions.keys()].filter((actionId) => published.has(actionId)),
  });
  const addressableSet = addressable === null ? null : new Set(addressable.actionIds);
  // The coherence check this denominator rests on: everything the run DISPATCHED had to have been addressable, or
  // the census missed a family the run really used and the coverage it would produce is against the wrong world.
  const outsideAddressable =
    addressableSet === null
      ? Object.freeze([])
      : Object.freeze(attemptedIds.filter((actionId) => !addressableSet.has(actionId)));
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
          addressable: addressableSet === null ? null : addressableSet.has(actionId),
        }),
      )
      .sort((left, right) => right.executions - left.executions || left.actionId.localeCompare(right.actionId)),
  );
  const addressableCount = addressable === null ? null : addressable.actionIds.length;
  const verdict = deriveVerdict({
    published,
    attemptedCount: attemptedIds.length,
    addressableCount,
    familyCount: familyNames.length,
    total,
    concentration,
    excludedAttempted,
    staleExclusions,
    censusAbsent: resolvedCensus === null,
    censusFamiliesAbsent: addressable === null ? Object.freeze([]) : addressable.censusFamiliesAbsent,
    outsidePopulation,
    outsideAddressable,
    scenario,
    scenarioBaseline,
  });
  return Object.freeze({
    scenario,
    attempted: attemptedIds.length,
    succeeded: succeededSet.size,
    published: published.size,
    judged: published.size - [...exclusions.keys()].filter((actionId) => published.has(actionId)).length,
    // What the run COULD address, and how that number was reached: the census it published, the target-bound actions
    // its families made constructible, and the actions that need no family at all.
    census: resolvedCensus,
    addressable: addressableCount,
    addressableTargetBound: addressable === null ? null : addressable.targetBound.length,
    addressableTargetless: addressable === null ? null : addressable.targetless.length,
    addressableFamilies: addressable === null ? null : addressable.families,
    addressableExcluded: addressable === null ? null : addressable.excludedAddressable,
    censusFamiliesAbsent: addressable === null ? null : addressable.censusFamiliesAbsent,
    // Coverage of the world this run was given; the catalog coverage stays beside it as context, never as the
    // denominator (it is the number that charged the companion for the fixture's world).
    coverage: addressableCount === null || addressableCount === 0 ? null : attemptedIds.length / addressableCount,
    catalogCoverage: published.size === 0 ? null : attemptedIds.length / published.size,
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
    outsideAddressable,
    perAction,
    verdict,
  });
}

/**
 * The verdict, in the order a reader should be told about it.
 *
 * Every `narrow:` arm is decided BEFORE the measurement gaps, because a run that was both narrow and unmeasurable in
 * some corner is narrow: the gap explains a missing number, not a missing variety. The one exception is coverage
 * itself: without a census there is no addressable set, so `below_baseline` is decided on the families alone and the
 * missing denominator is reported as `not_measured:no_snapshot_census` instead of a coverage nobody could compute.
 */
function deriveVerdict({
  published,
  attemptedCount,
  addressableCount,
  familyCount,
  total,
  concentration,
  excludedAttempted,
  staleExclusions,
  censusAbsent,
  censusFamiliesAbsent,
  outsidePopulation,
  outsideAddressable,
  scenario,
  scenarioBaseline,
}) {
  if (total === 0 && attemptedCount === 0) return "not_measured:no_executions";
  if (excludedAttempted.length > 0) return `narrow:excluded_action_attempted:${excludedAttempted.join(",")}`;
  if (concentration !== null && concentration.share > ACTION_BREADTH_CONCENTRATION_SHARE)
    return `narrow:concentrated_on:${concentration.actionId}`;
  // A dimension this run could not measure must not be outvoted by one it could: without a census the baseline
  // comparison has no denominator, so "fewer families than the best run" is an artefact of the fixture rather than a
  // reading about the companion. The family comparison is still printed beside the verdict, as context.
  if (censusAbsent) return "not_measured:no_snapshot_census";
  if (scenarioBaseline !== null && belowBaseline({ attemptedCount, addressableCount, familyCount, scenarioBaseline }))
    return `narrow:below_baseline:${scenarioBaseline.label}`;
  if (published.size === 0) return "not_measured:published_action_population_empty";
  if (staleExclusions.length > 0) return `not_measured:excluded_action_not_published:${staleExclusions.join(",")}`;
  if (censusFamiliesAbsent.length > 0) return `not_measured:census_family_absent:${censusFamiliesAbsent.join(",")}`;
  if (outsidePopulation.length > 0) return `not_measured:attempted_outside_population:${outsidePopulation.join(",")}`;
  if (outsideAddressable.length > 0) return `not_measured:action_outside_addressable:${outsideAddressable.join(",")}`;
  if (scenarioBaseline === null) return `not_measured:no_baseline_for_scenario:${scenario ?? "none"}`;
  return ACTION_BREADTH_RICH;
}

/**
 * Whether this run is below the recorded best.
 *
 * Coverage is compared by cross-multiplication so two runs in two differently-armed worlds are compared as fractions
 * rather than as counts: a fixture that arms nine actions and a run that attempts five of them is not below a run that
 * attempted 24 of 51. A baseline entry with no `addressable` (recorded before this denominator existed) contributes
 * only its family dimension - the one number it measured against the same surface every reader can see.
 */
function belowBaseline({ attemptedCount, addressableCount, familyCount, scenarioBaseline }) {
  if (familyCount < scenarioBaseline.families) return true;
  const baselineAddressable = scenarioBaseline.addressable ?? null;
  if (baselineAddressable === null || addressableCount === null || addressableCount === 0) return false;
  return attemptedCount * baselineAddressable < scenarioBaseline.attempted * addressableCount;
}

/**
 * The run's `action_breadth` clause: narrow is a failed clause, unmeasurable is not.
 *
 * A measurement this tree could not take is our gap, and charging it to the companion would be the same mistake as a
 * gate that cannot judge and fails anyway - so `not_measured:` passes and stays visible in the published verdict. It
 * is never `rich`: a bundle with no census can be a passed run, never a measured one.
 */
export function actionBreadthClause(breadth) {
  const verdict = typeof breadth?.verdict === "string" ? breadth.verdict : "not_measured:action_breadth_unreadable";
  return Object.freeze({ id: "action_breadth", passed: !verdict.startsWith("narrow:"), reasonCode: verdict });
}

/** The reading as lines a terminal or a run log can carry, one fact per line, population and census first. */
export function formatActionBreadth(breadth) {
  const share =
    breadth.concentration === null
      ? `not_judged (${breadth.concentrationReason ?? "no_concentration_reading"})`
      : `${breadth.concentration.actionId} ${breadth.concentration.executions} (${(breadth.concentration.share * 100).toFixed(1)}%)`;
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const census = breadth.census ?? null;
  const withRows = census === null ? 0 : census.families.filter((entry) => entry.rows > 0).length;
  const coverage =
    breadth.addressable === null || breadth.addressable === 0
      ? `attempted ${String(breadth.attempted)} of ${String(breadth.published)} published (${percent(breadth.catalogCoverage ?? 0)})`
      : `attempted ${String(breadth.attempted)} of ${String(breadth.addressable)} addressable (${percent(breadth.coverage ?? 0)}); succeeded ${String(breadth.succeeded)} of ${String(breadth.addressable)}; catalog ${String(breadth.attempted)} of ${String(breadth.published)} (${percent(breadth.catalogCoverage ?? 0)})`;
  return Object.freeze([
    `action_breadth: population ${String(breadth.published)} published, ${String(breadth.judged)} judged (${String(breadth.published - breadth.judged)} excluded)`,
    census === null
      ? "action_breadth: census none published - the addressable surface cannot be measured"
      : `action_breadth: census ${String(census.snapshots)} snapshots from ${census.source}, ${String(withRows)} of ${String(census.families.length)} target families with rows`,
    breadth.addressable === null
      ? "action_breadth: addressable not_measured (no snapshot census)"
      : `action_breadth: addressable ${String(breadth.addressable)} of ${String(breadth.published)} published (target-bound ${String(breadth.addressableTargetBound)}, targetless ${String(breadth.addressableTargetless)})`,
    `action_breadth: ${coverage}`,
    `action_breadth: families ${String(breadth.families)} of ${String(breadth.publishedFamilies)}${breadth.familyNames.length === 0 ? "" : ` ${breadth.familyNames.join(",")}`}`,
    `action_breadth: executions ${String(breadth.executions)} (${String(breadth.attributedExecutions)} attributed); concentration ${share}`,
    `action_breadth: verdict ${breadth.verdict}`,
  ]);
}
