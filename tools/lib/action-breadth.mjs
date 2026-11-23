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
 * THE RATCHET. `tools/action-breadth-baseline.json` records the best attempts each scenario has shown - its attempted
 * count, the per-family split of its attempts, and the coverage floor as the ACTIONS the best census-bearing run could
 * address and the ones it addressed - plus the actions a fixture cannot reach with the reason each one cannot. What is
 * compared is coverage, never an absolute count of families: a run is not below a run that worked in more families, it is
 * below one whose families it also had and skipped. An action that was excluded and then attempted is
 * `narrow:excluded_action_attempted:<actionId>`, because a carve-out that has silently stopped being true makes every
 * later reading smaller than it looks.
 *
 * WHAT THIS ASKS, in one line: of the work her own day made reachable, did she touch as much as the best run on this
 * machine touched of the work the two days SHARED? A criterion that answers differently when the world publishes fewer
 * families is measuring the world, not her.
 *
 * THE FLOOR IS COMPARED ON THE WORLD BOTH RUNS HAD. Measured 2026-11-23, three consecutive multiday runs: `round95`
 * attempted 26 of 57 addressable (45.6 %, rich), `round96` 20 of 55 (36.4 %, narrow), `round97` 18 of 53 (34.0 %,
 * narrow), against a floor recorded as `round76`'s 17 of 43 (39.5 %). Three of those four numbers moved for reasons that
 * are not her: the addressable width fell 57 -> 55 -> 53 because families published nothing on those days
 * (`artifactSpotTargets` and `petBowlTargets` went from one row to none, with them two more), and the floor's own numerator
 * had been taken outside its denominator - `round76` named 17 attempted actions and 43 addressable ones, but `chop_stump`,
 * `chop_tree` and `pickup_item` ran against families its census never carried a row for, so its coverage of its own world
 * was 14 of 43 (32.6 %), not 17 of 43. Those two defects are what failed `round96` and `round97`: 36.4 % and 34.0 % clear
 * the floor's real 32.6 %.
 *
 * So the floor is recorded as the floor run's OWN action ids - what it could address and what it addressed - and the
 * comparison is taken on the actions this run's world and the floor's world both made addressable. Equal denominators make
 * the count comparison the ratio comparison, and the bar cannot move with the world: a family that publishes nothing leaves
 * both the denominator and the bar by the same action. Against the floor as this file used to record it, the rule agrees
 * with the rate rule on 17 of the 26 census-bearing multiday bundles here and disagrees on nine, all nine toward `rich`
 * (`round80`, `round81`, `round84`, `round86`, `round87b`, `round89`, `round91`, `round96`, `round97`); against the
 * floor's corrected 14 of 43 the two agree on all 26, and differ only where a world wider than a floor's can lower a run's
 * rate while it touched nothing less - which is the structural reason for the change and not a rescue of a particular run.
 * The four both rules fail are the four thin days (`round45` 6 of 31 shared, `round46` 2 of 30, `round87` 9 of 40,
 * `round90` 12 of 41, against the floor's 14).
 * Keeping the fixed floor and printing how much of each shortfall is the world was the alternative: it needs the same
 * action ids to be honest - two ratios cannot say which actions left - and once it has them it still fails a run for a
 * world wider than the floor's. Explaining a wrong number is not the same as not printing it. `sameWorld` is published
 * with every reading so the population of the comparison is visible, and an empty one is `not_measured` rather than a
 * pass: a comparison nobody could make must not read as one she won.
 *
 * A VERDICT NAMES WHAT IT COMPARED. Two populations decide every breadth reading - what the world published and made
 * addressable, and what the companion chose to attempt - and a verdict that names neither cannot be argued with.
 * Measured 2026-11-20 on `round84`: `published 101 · addressable 55 · attempted 18 · succeeded 16` came back as
 * `narrow:below_baseline:round38`, and nothing in that code said the comparison was 18 of 55 against round76's 17 of 43;
 * `round38` recorded no addressable width at all, so the label named a run the coverage dimension never used. The code
 * now carries the dimension and both halves of the population it compared -
 * `narrow:below_baseline:<label>:coverage=<this run>/<shared>:held=<h>/<shared>:by=<holder>`, where `<shared>` is the
 * actions both worlds made addressable - and `narrow:below_baseline:<label>:families=<names>` stays as it was, because the
 * token `families` already says which
 * dimension failed and the names are the ones this run offered and skipped. Every reading prints both populations beside
 * the bar they were held to (`formatActionBreadth`), so the 46 actions round84 published and never could address are
 * visible as a fact about its world rather than charged to the companion.
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
import { TARGET_FIELD } from "../../gates/stardew/audit-stardew-discovery-channels.mjs";
import {
  readAllPublishedExecutionStardewActionIds,
  readStardewActionFamilies,
  readStardewActionToolClaims,
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

/**
 * Which snapshot `toolSlots[].category` values satisfy each tool a registration can declare.
 *
 * The words and the categories are the MOD's, not this file's: `ToolCategory` names one category per tool class, and the
 * three words that are not categories are the Mod's own predicates (`heavy_hitter` is `Tool.isHeavyHitter`;
 * `heavy_hitter_not_melee_weapon` is the cask's `isHeavyHitter() && !(t is MeleeWeapon)`;
 * `axe_or_pickaxe` is the pair no single category can say) - `farmhandexecutioncontroller.resourcetoolactions.cs:713-728`.
 * A claim word absent here is NOT read as "no tool needed": it is published as `toolClaimUnmeasured`, because a rule
 * this table cannot interpret must not silently withhold an action from a run's denominator.
 *
 * `weapon` appears as a category the snapshot publishes but no claim names it; `heavy_hitter` reaches it because the
 * engine's own predicate admits MeleeWeapon and Slingshot.
 */
export const TOOL_CLAIM_CATEGORIES = Object.freeze({
  axe: Object.freeze(["axe"]),
  pickaxe: Object.freeze(["pickaxe"]),
  hoe: Object.freeze(["hoe"]),
  watering_can: Object.freeze(["watering_can"]),
  fishing_rod: Object.freeze(["fishing_rod"]),
  shears: Object.freeze(["shears"]),
  milk_pail: Object.freeze(["milk_pail"]),
  pan: Object.freeze(["pan"]),
  lantern: Object.freeze(["lantern"]),
  raft: Object.freeze(["raft"]),
  scythe: Object.freeze(["scythe"]),
  axe_or_pickaxe: Object.freeze(["axe", "pickaxe"]),
  heavy_hitter: Object.freeze(["axe", "pickaxe", "hoe", "weapon"]),
  heavy_hitter_not_melee_weapon: Object.freeze(["axe", "pickaxe", "hoe"]),
});

/**
 * Target families whose rows say nothing about their action's subject, each with the fact that would.
 *
 * The addressable join treats "this family carried a row" as "this action is constructible". That is true of a family
 * discovery filters to the action's own subject and FALSE of a family it publishes wholesale: `inventoryItemFacts`
 * enumerates every non-empty backpack slot (`farmhandexecutioncontroller.targetdiscovery.cs:1068-1080`), so a row there
 * only says the actor's bag is not empty - never that it holds something `open_geode` opens (`Utility.IsGeode`, the
 * engine predicate the handler asks at `farmhandexecutioncontroller.geodeactions.cs:158`), and the snapshot publishes no
 * item category that could answer it. Measured 2026-11-18 (`round76`): 16 ordinary farm slots put `open_geode` in the
 * denominator of a run that never had a geode.
 *
 * This is a declared list rather than a derived one - the Mod does not publish which families it filters - so it is held
 * to the same standard as the baseline's exclusions: each entry names the publisher and the missing fact, and an action
 * withheld here that the run ATTEMPTED is put back in the denominator and reported, so an entry that stops being true
 * cannot quietly shrink the surface.
 */
export const SUPERSET_WITNESS_FAMILIES = Object.freeze({
  inventoryItemFacts:
    "publishes every non-empty backpack slot, so its rows say the bag is not empty, never that it holds the item the action opens",
});

/** Who produced a census. Published with it, so a reader knows whose observation the denominator rests on. */
export const SNAPSHOT_CENSUS_SOURCE = "runner_observations";

function fail(code) {
  throw new Error(`action_breadth_${code}`);
}

/** A published action id: the only kind of entry the baseline's id lists and a run's attempt list may carry. */
function isActionId(value) {
  return typeof value === "string" && value.length > 0;
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
  const declaredTools = readStardewActionToolClaims();
  return Object.freeze({
    actionIds,
    families,
    familyCount: new Set(families.values()).size,
    // An action absent from this map names no snapshot family: its target is the actor's own body, tile or a menu
    // (the discovery audit's `NON_SNAPSHOT_TARGET_ACTIONS`), so no row count can gate it.
    targetFieldOf,
    targetFields: Object.freeze([...new Set(targetFieldOf.values())].sort()),
    // The tool each action's OWN registration declares. A row needs its tool in the pack before the action can run, and
    // the snapshot publishes that as `toolSlots[].category`; the family row alone says nothing about it.
    toolClaimOf: new Map(
      actionIds
        .filter((actionId) => declaredTools.has(actionId))
        .map((actionId) => [actionId, declaredTools.get(actionId)]),
    ),
    toolClaimWords: Object.freeze(
      [...new Set(actionIds.map((actionId) => declaredTools.get(actionId)).filter(Boolean))].sort(),
    ),
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
 * The tool categories one snapshot published, accumulated into `categories`.
 *
 * The snapshot names a category per tool in the pack (`toolSlots[].category`), which is the same vocabulary a
 * registration's `tool:` claim uses, so this is the one fact that can tell whether an action whose witness family was
 * full was actually possible. It is a SET because "the axe was in the pack at some point" is what the run needs: the
 * question is whether the tool was ever held, not in which slot at which instant.
 */
export function addSnapshotToolCategories(categories, snapshot) {
  if (snapshot === null || typeof snapshot !== "object") return categories;
  for (const row of Array.isArray(snapshot.toolSlots) ? snapshot.toolSlots : [])
    if (typeof row?.category === "string" && row.category.length > 0) categories.add(row.category);
  return categories;
}

/**
 * The census a bundle publishes: one entry per target family in the catalog, with the rows the run's snapshots
 * carried for it - `0` included - beside the tools those snapshots ever held.
 *
 * The zeroes are the point. A census that listed only the families it saw rows for could not be told apart from one
 * that never looked at a family, so an empty world and an unobserved one would read the same, and a later target
 * family added to the catalog would silently vanish from the denominator instead of being reported as drift.
 *
 * `tools` is null when the caller did not sample it: that is "this census never declared what the run held", which is a
 * different answer from an empty list and must not withhold every tool-bound action silently.
 */
export function buildSnapshotCensus({ surface, rows, snapshots, tools }) {
  const observed = rows instanceof Map ? rows : new Map(Object.entries(rows ?? {}));
  return Object.freeze({
    source: SNAPSHOT_CENSUS_SOURCE,
    snapshots: Number.isInteger(snapshots) && snapshots > 0 ? snapshots : 0,
    tools:
      tools === undefined || tools === null
        ? null
        : Object.freeze([...(tools instanceof Set ? tools : new Set(tools))].sort()),
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
    // `null` is a bundle from before the tool reading: the reader can say "this run's census never declared what it
    // held", which is not the same answer as an empty list and must not withhold every tool-bound action silently.
    tools: Array.isArray(census.tools)
      ? Object.freeze(census.tools.filter((tool) => typeof tool === "string" && tool.length > 0))
      : null,
    families: Object.freeze(families.map((entry) => Object.freeze({ family: entry.family, rows: entry.rows }))),
  });
}

/**
 * The addressable set of one run: what it could have done, given the world its snapshots showed it.
 *
 * Target-bound actions need a row in their family; actions that name no family need nothing, because their target is
 * the actor itself. Declared exclusions are subtracted last, and only the ones that were still addressable are
 * reported, so an expired carve-out cannot quietly shrink the denominator.
 *
 * A FAMILY ROW IS NOT ALWAYS THE ACTION'S PRECONDITION. `round76` (2026-11-18) counted `fish_here` as addressable because
 * 32 water tiles were in reach, while the action needs a rod in the pack that this run never held; the same shape made
 * `open_geode` addressable off a backpack full of ordinary items. The tool half is decidable from the declaration (every
 * action whose registration carries a `tool:` claim) against the single fact the snapshot publishes about it
 * (`toolSlots[].category`), so the rule is the Mod's own claim read against the run's own reading - and an action the run
 * DISPATCHED is addressable whatever the census failed to evidence, because its own execution is proof the precondition
 * held. That last half is not charity: without it the ruler would charge the run for our sampling gap.
 */
export function deriveAddressable({ surface, census, exclusions = [], attempted = [] }) {
  const normalized = normalizeCensus(census);
  if (normalized === null) return null;
  const rows = new Map(normalized.families.map((entry) => [entry.family, entry.rows]));
  const excluded = new Set(exclusions);
  const attemptedSet = new Set(attempted);
  const held = normalized.tools;
  // A tool the run DEMONSTRABLY used is held: an attempted action whose registration declares exactly one tool category
  // could not have run without that tool in the pack, and the Mod resolves the tool from the pack itself. This is what
  // keeps a census that predates the tool reading from withholding an action the run obviously could perform - `round76`
  // never sampled `toolSlots`, yet its `break_rock` execution proves the pickaxe was there.
  const provenByUse = new Set();
  for (const actionId of attemptedSet) {
    const word = surface.toolClaimOf?.get(actionId);
    const categories = word === undefined ? undefined : TOOL_CLAIM_CATEGORIES[word];
    if (categories !== undefined && categories.length === 1) provenByUse.add(categories[0]);
  }
  const withheld = [];
  const fromAttempt = [];
  const toolClaimUnmeasured = [];
  const targetBound = [];
  const targetless = [];
  for (const actionId of surface.actionIds) {
    const field = surface.targetFieldOf.get(actionId);
    if (field === undefined) targetless.push(actionId);
    else if ((rows.get(field) ?? 0) > 0) targetBound.push(actionId);
  }
  const addressable = [];
  for (const actionId of [...targetBound, ...targetless]) {
    if (excluded.has(actionId)) continue;
    const field = surface.targetFieldOf.get(actionId);
    const superset = field !== undefined && SUPERSET_WITNESS_FAMILIES[field] !== undefined ? field : null;
    const word = surface.toolClaimOf?.get(actionId);
    if (word === undefined) {
      if (superset === null) addressable.push(actionId);
      else if (attemptedSet.has(actionId)) {
        fromAttempt.push(actionId);
        addressable.push(actionId);
      } else withheld.push(Object.freeze({ actionId, reason: `witness_is_a_superset:${superset}` }));
      continue;
    }
    const categories = TOOL_CLAIM_CATEGORIES[word];
    if (categories === undefined) {
      // A claim word this tree cannot interpret is NAMED and left in the denominator: withholding on it would be a
      // measurement artefact dressed as a fact about the run.
      toolClaimUnmeasured.push(Object.freeze({ actionId, word }));
      addressable.push(actionId);
      continue;
    }
    if (held !== null && categories.some((category) => held.includes(category))) {
      addressable.push(actionId);
      continue;
    }
    if (attemptedSet.has(actionId) || categories.some((category) => provenByUse.has(category))) {
      fromAttempt.push(actionId);
      addressable.push(actionId);
      continue;
    }
    withheld.push(Object.freeze({ actionId, reason: `tool_not_held:${word}` }));
  }
  const families = Object.freeze(
    [...new Set(targetBound.map((actionId) => surface.targetFieldOf.get(actionId)))].sort().map((family) =>
      Object.freeze({
        family,
        rows: rows.get(family) ?? 0,
        // The actions this FAMILY made constructible, whatever their own precondition then decided: the family's
        // contribution and the action's addressability are two facts, and `withheld` below says which of these the
        // second one removed - a family that printed an empty list because its only action was withheld would look like
        // a family that contributed nothing.
        actionIds: Object.freeze(targetBound.filter((actionId) => surface.targetFieldOf.get(actionId) === family)),
      }),
    ),
  );
  return Object.freeze({
    actionIds: Object.freeze(addressable),
    targetBound: Object.freeze(targetBound.filter((actionId) => !excluded.has(actionId))),
    targetless: Object.freeze(targetless.filter((actionId) => !excluded.has(actionId))),
    // An exclusion that WOULD have been addressable: the ones a reader has to be able to weigh against the surface.
    excludedAddressable: Object.freeze([...targetBound, ...targetless].filter((actionId) => excluded.has(actionId))),
    families,
    // Every action whose witness family carried a row but whose own declared precondition did not hold: what the
    // family-only denominator used to charge the run for, named with the word that failed.
    withheld: Object.freeze(withheld),
    // The actions that stayed in the denominator on the run's own execution rather than on its census. A reader has to
    // see this list, because it is exactly where the census under-sampled.
    fromAttempt: Object.freeze(fromAttempt),
    toolClaimUnmeasured: Object.freeze(toolClaimUnmeasured),
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
  const floors = new Map();
  for (const [scenario, entry] of Object.entries(baselines)) {
    if (typeof entry?.label !== "string" || entry.label.length === 0) fail(`baseline_label_missing:${scenario}`);
    if (!Number.isInteger(entry?.attempted) || entry.attempted <= 0) fail(`baseline_attempted_invalid:${scenario}`);
    if (!Number.isInteger(entry?.families) || entry.families <= 0) fail(`baseline_families_invalid:${scenario}`);
    if (entry?.addressable !== null && entry?.addressable !== undefined) {
      if (!Number.isInteger(entry.addressable) || entry.addressable < entry.attempted)
        fail(`baseline_addressable_invalid:${scenario}`);
    }
    // The per-family split of `attempted`, when the entry records one: the ratchet compares families against these, so a
    // split that does not add up to the total would silently compare a different run. Every key must be a family name and
    // every count a positive integer, because a zero-count family is a family the run did not work in.
    if (entry?.familiesAttempted !== null && entry?.familiesAttempted !== undefined) {
      const split = entry.familiesAttempted;
      if (typeof split !== "object" || Array.isArray(split) || Object.keys(split).length === 0)
        fail(`baseline_families_attempted_invalid:${scenario}`);
      let sum = 0;
      for (const [family, count] of Object.entries(split)) {
        if (typeof family !== "string" || family.length === 0 || !Number.isInteger(count) || count <= 0)
          fail(`baseline_families_attempted_invalid:${scenario}:${family}`);
        sum += count;
      }
      if (sum !== entry.attempted)
        fail(`baseline_families_do_not_sum:${scenario}:${String(sum)}:${String(entry.attempted)}`);
    }
    // The floor is recorded as the ACTIONS the recorded run could address and the ones it addressed, never as a pair of
    // counts: a rate over a world of its own is what made the verdict move with the world, and the comparison needs the
    // identities to stand on the part of the world both runs had. `attempted` and `addressable` are derived from the two
    // lists below - one spelling, so a count can never disagree with the ids it counts.
    if (entry?.coverageFloor !== null && entry?.coverageFloor !== undefined) {
      const floor = entry.coverageFloor;
      if (typeof floor?.label !== "string" || floor.label.length === 0)
        fail(`baseline_coverage_floor_invalid:${scenario}`);
      const addressable = floor?.addressableActionIds;
      const attempted = floor?.attemptedActionIds;
      if (!Array.isArray(addressable) || addressable.length === 0 || !addressable.every(isActionId))
        fail(`baseline_coverage_floor_unpopulated:${scenario}`);
      if (new Set(addressable).size !== addressable.length) fail(`baseline_coverage_floor_duplicate:${scenario}`);
      if (!Array.isArray(attempted) || attempted.length === 0 || !attempted.every(isActionId))
        fail(`baseline_coverage_floor_unattempted:${scenario}`);
      const addressableSet = new Set(addressable);
      const outside = attempted.filter((actionId) => !addressableSet.has(actionId));
      if (outside.length > 0) fail(`baseline_coverage_floor_attempted_outside:${scenario}:${outside.join(",")}`);
      floors.set(scenario, Object.freeze({ ...floor, attempted: attempted.length, addressable: addressable.length }));
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
  return Object.freeze({
    // The floor's counts are DERIVED above and carried beside its ids, so every reader prints one number per fact.
    baselines: Object.freeze(
      Object.fromEntries(
        Object.entries(baselines).map(([scenario, entry]) => [
          scenario,
          floors.has(scenario) ? Object.freeze({ ...entry, coverageFloor: floors.get(scenario) }) : entry,
        ]),
      ),
    ),
    exclusions,
  });
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
 *
 * `executedRows` are the rows that already name their action AND are already keyed on one identity by the reader that
 * produced them: a receipt in the runner log does both, so the runner log is a third channel beside the flat trace and
 * the programme journal rather than one of them wearing the other's name.
 */
export function actionExecutionCounts({
  actionRows = null,
  programRows = [],
  programSubmissions = [],
  executedRows = [],
} = {}) {
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
  for (const row of executedRows ?? []) record(row?.actionId);
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
 * executions are then reported as unattributed instead of being silently left out of the concentration. `executedRows`
 * is the third channel: the runner's own receipts, each already keyed on the execution identity its producer gave it.
 */
export async function measureActionBreadth({
  scenario = null,
  attempted = [],
  succeeded = [],
  executions = 0,
  actionRows = null,
  programRows = [],
  programSubmissions = [],
  executedRows = [],
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
  const { counts, attributed } = actionExecutionCounts({ actionRows, programRows, programSubmissions, executedRows });
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
    // The run's own dispatches, so a precondition the census could not evidence cannot withdraw an action the run
    // really executed (see `deriveAddressable`).
    attempted: attemptedIds,
  });
  const addressableSet = addressable === null ? null : new Set(addressable.actionIds);
  const withheldOf = new Map((addressable?.withheld ?? []).map((entry) => [entry.actionId, entry.reason]));
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
          // Why a census-witnessed action is not in the denominator, for the reader who asks about this row.
          withheld: withheldOf.get(actionId) ?? null,
        }),
      )
      .sort((left, right) => right.executions - left.executions || left.actionId.localeCompare(right.actionId)),
  );
  const addressableCount = addressable === null ? null : addressable.actionIds.length;
  // The families the run's WORLD put in front of it: those an addressable TARGET-BOUND action belongs to. A family reachable
  // only through an action that names no target (`travel`, `move_to_tile`, `sleep`) is available to every run whatever the
  // world holds, so counting it in the family comparison charges a run for not walking to town - which is the same
  // fixture-vs-companion mistake as the absolute family count this comparison replaced.
  const addressableFamilyNames =
    addressable === null
      ? null
      : Object.freeze(
          [
            ...new Set(
              addressable.actionIds.filter((actionId) => resolvedSurface.targetFieldOf.has(actionId)).map(familyOf),
            ),
          ].sort(),
        );
  // ONE derivation of the ratchet comparison, read twice: by the verdict below and by the fields this result publishes,
  // so the artifact and the decision cannot disagree about what was compared, or about which families the run skipped.
  const baselineComparison =
    scenarioBaseline === null
      ? null
      : belowBaseline({
          attemptedIds,
          addressableIds: addressable === null ? Object.freeze([]) : addressable.actionIds,
          familyNames,
          addressableFamilyNames,
          scenarioBaseline,
        });
  const verdict = deriveVerdict({
    published,
    attemptedCount: attemptedIds.length,
    baselineComparison,
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
    // The witness family carried a row but the action's own declared precondition did not hold (`tool_not_held:<word>`),
    // and the actions kept on the run's own execution because its census could not evidence them. Both are published so
    // a reader can weigh the denominator instead of trusting it.
    addressableWithheld: addressable === null ? null : addressable.withheld,
    addressableFromAttempt: addressable === null ? null : addressable.fromAttempt,
    toolClaimUnmeasured: addressable === null ? null : addressable.toolClaimUnmeasured,
    censusFamiliesAbsent: addressable === null ? null : addressable.censusFamiliesAbsent,
    // Coverage of the world this run was given; the catalog coverage stays beside it as context, never as the
    // denominator (it is the number that charged the companion for the fixture's world).
    coverage: addressableCount === null || addressableCount === 0 ? null : attemptedIds.length / addressableCount,
    catalogCoverage: published.size === 0 ? null : attemptedIds.length / published.size,
    families: familyNames.length,
    // Every family this run's own world made addressable, and the ones it could have worked in and did not: the
    // comparison the ratchet makes is over these, never over the fixture's family count.
    addressableFamilyNames,
    // The bar this run was held to, in the terms of the dimension that holds it, and which dimension that was. Published
    // rather than left in the verdict string, so a reader of the artifact can weigh the comparison instead of decoding it.
    baselineCompared: baselineComparison === null ? null : baselineComparison.held,
    baselineFailed: baselineComparison === null ? null : baselineComparison.belowBy,
    baselineMissedFamilies: baselineComparison === null ? null : baselineComparison.missedFamilies,
    // The population the coverage dimension was compared over, and the two counts inside it: this run's attempts there,
    // the floor run's there, and the floor run's actions this run did not touch - named, so the comparison can be
    // recomputed and argued with from the artifact alone.
    baselineSameWorld: baselineComparison === null ? null : baselineComparison.sameWorld,
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
 * The reading of a run whose breadth could not be measured at all: the code that says which reader threw, and every
 * population it would have published as `null`.
 *
 * The counts the caller already holds travel - `attempted` and `succeeded` are the run's own dispatch trace, not this
 * reading's work - so an artifact whose breadth gate failed still says how many actions the run used. The verdict is
 * the gap itself (`not_measured:action_breadth:<reason>`), never `rich`: a reading nobody took is not a pass.
 *
 * `NOT MEASURED IS NOT NARROW` (see the header) is why this publishes rather than throws, and the shape is asserted
 * against `measureActionBreadth`'s own output in `action-breadth.test.mjs`: one reading, one shape, whichever way the
 * numbers arrived.
 */
export function unmeasuredActionBreadth({ scenario = null, code, attempted = 0, succeeded = 0 }) {
  return Object.freeze({
    scenario,
    attempted,
    succeeded,
    published: null,
    judged: null,
    census: null,
    addressable: null,
    addressableTargetBound: null,
    addressableTargetless: null,
    addressableFamilies: null,
    addressableExcluded: null,
    addressableWithheld: null,
    addressableFromAttempt: null,
    toolClaimUnmeasured: null,
    censusFamiliesAbsent: null,
    coverage: null,
    catalogCoverage: null,
    families: null,
    addressableFamilyNames: null,
    baselineCompared: null,
    baselineFailed: null,
    baselineMissedFamilies: null,
    baselineSameWorld: null,
    publishedFamilies: null,
    familyNames: Object.freeze([]),
    executions: null,
    attributedExecutions: null,
    unattributedExecutions: null,
    concentration: null,
    concentrationReason: null,
    baseline: null,
    excludedAttempted: Object.freeze([]),
    staleExclusions: Object.freeze([]),
    outsidePopulation: Object.freeze([]),
    outsideAddressable: Object.freeze([]),
    perAction: Object.freeze([]),
    verdict: code,
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
  baselineComparison,
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
  // comparison has no denominator, so the only comparison left would be against the fixture's world rather than the
  // companion's work, and the verdict says so instead of deciding on it.
  if (censusAbsent) return "not_measured:no_snapshot_census";
  if (baselineComparison !== null && baselineComparison.below) {
    // WHICH DIMENSION FAILED, and the numbers it failed on: a code that names only the ratchet's label reads like a
    // count and cannot be recomputed (`round84`, 2026-11-20), so the coverage arm carries both halves of both ratios.
    if (baselineComparison.belowBy === "coverage") {
      const held = baselineComparison.held;
      const shared = baselineComparison.sameWorld;
      return `narrow:below_baseline:${scenarioBaseline.label}:coverage=${String(shared.attempted)}/${String(shared.addressable)}:held=${String(held.attempted)}/${String(held.addressable)}:by=${held.label}`;
    }
    return `narrow:below_baseline:${scenarioBaseline.label}:families=${baselineComparison.missedFamilies.join(",")}`;
  }
  // A ratchet that cannot compare this run - no shared action with the floor's world and no family split either - is a
  // measurement this tree could not take, and it says so instead of reading as a comparison she won.
  if (baselineComparison !== null && baselineComparison.unmeasured !== null)
    return `not_measured:${baselineComparison.unmeasured}`;
  if (published.size === 0) return "not_measured:published_action_population_empty";
  if (staleExclusions.length > 0) return `not_measured:excluded_action_not_published:${staleExclusions.join(",")}`;
  if (censusFamiliesAbsent.length > 0) return `not_measured:census_family_absent:${censusFamiliesAbsent.join(",")}`;
  if (outsidePopulation.length > 0) return `not_measured:attempted_outside_population:${outsidePopulation.join(",")}`;
  if (outsideAddressable.length > 0) return `not_measured:action_outside_addressable:${outsideAddressable.join(",")}`;
  if (scenarioBaseline === null) return `not_measured:no_baseline_for_scenario:${scenario ?? "none"}`;
  return ACTION_BREADTH_RICH;
}

/**
 * The coverage floor the coverage dimension is compared against: the recorded run, the ACTIONS its world made
 * addressable, and the ones it addressed.
 *
 * The floor is the ONE bar for this dimension. `round38`'s own attempted count (24) is the family dimension's population
 * and never a coverage width - its bundle predates the census, so the width of its world is not a number this gate ever
 * measured - which is why a verdict that named it for a ratio `round76` held sent a reader looking for a denominator that
 * run never had.
 */
function coverageFloorOf(scenarioBaseline) {
  const floor = scenarioBaseline.coverageFloor ?? null;
  if (floor === null || floor === undefined) return null;
  return Object.freeze({
    label: floor.label,
    attemptedActionIds: floor.attemptedActionIds,
    addressableActionIds: floor.addressableActionIds,
  });
}

/**
 * The part of the world this run and the floor run BOTH had, and how much of it each addressed.
 *
 * The population is `this run's addressable actions ∩ the floor's addressable actions`, and both counts are taken inside
 * it: `attempted` is what this run did there, `held` is what the floor run did there. Equal denominators make the count
 * comparison the ratio comparison, and the bar cannot move with the world - an action whose family published nothing
 * leaves BOTH sides by the same action, which is the defect this replaced: `round97` attempted 18 of 53 and was held to a
 * rate recorded over 43, so the same 18 attempts read as 34.0 % or 40.0 % depending on what the fixture published.
 *
 * Null when the two worlds share nothing: the ratchet then has no population to compare over, and the caller says so
 * rather than passing a run on a comparison nobody made.
 */
function coverageOnSharedWorld({ floor, addressableIds, attemptedIds }) {
  const floorAddressable = new Set(floor.addressableActionIds);
  const shared = addressableIds.filter((actionId) => floorAddressable.has(actionId));
  if (shared.length === 0) return null;
  const sharedSet = new Set(shared);
  const attempted = new Set(attemptedIds);
  const held = new Set(floor.attemptedActionIds.filter((actionId) => sharedSet.has(actionId)));
  return Object.freeze({
    label: floor.label,
    addressable: shared.length,
    attempted: shared.filter((actionId) => attempted.has(actionId)).length,
    held: held.size,
    // The floor's actions this run did not touch, named: the same fact the family dimension prints member by member.
    skipped: Object.freeze(shared.filter((actionId) => held.has(actionId) && !attempted.has(actionId)).sort()),
  });
}

/**
 * Whether this run is below the recorded best, which dimension says so, and the value it was held to.
 *
 * TWO DIMENSIONS, both measured on the world this run was given.
 *
 * COVERAGE is compared on the world the two runs SHARE: the actions both this run's snapshots and the floor run's made
 * addressable. Inside that population the two counts are comparable directly, and the ratio comparison (equal
 * denominators) is the same statement - but a fraction whose denominator is only this run's world is not, because the
 * world publishes a different number of families every day: `round95` attempted 26 of 57 (45.6 %) and passed, `round96`
 * 20 of 55 (36.4 %) and `round97` 18 of 53 (34.0 %) failed, while the 18 attempts of `round97` are 41.9 % of a 43-wide
 * world. A criterion that answers differently when the world publishes fewer families is measuring the world.
 *
 * FAMILIES are compared as COVERAGE OF THE SAME FAMILIES, never as an absolute count of families. The old rule was
 * `familyCount < baseline.families → below`, and it vetoed any run whose world or task mix was narrower than the best
 * run's: `round38` worked in eleven families including `transport_warps` and `world_navigation`, so three farm-only days
 * that did real work in every family their own world offered were "below" it for the families they never had - the
 * fixture's world charged to the companion, which is the same class of lie as the catalog denominator. What is compared
 * now is the share of THIS run's own families the baseline also worked in, against how many of them this run worked in:
 * a family this run's world never offered is not asked of it, and a family it offered and the run skipped is named.
 *
 * `held` is the dimension's own bar in the dimension's own terms - a share of the shared world for coverage, a set for
 * families - so the reading that prints it can state what the run was held to instead of leaving a reader to derive it.
 * COVERAGE DECIDES FIRST, because its bar is one population and a run below it needs no second dimension to explain the
 * verdict; the family dimension is reached only when the ratio cleared or could not be measured. `unmeasured` names the
 * one state that is neither: no floor, no shared world, and no family split to compare, i.e. a ratchet that cannot say
 * anything about this run - which the verdict reports as `not_measured` rather than as a pass.
 */
function belowBaseline({ attemptedIds, addressableIds, familyNames, addressableFamilyNames, scenarioBaseline }) {
  const floor = coverageFloorOf(scenarioBaseline);
  const sameWorld = floor === null ? null : coverageOnSharedWorld({ floor, addressableIds, attemptedIds });
  const coverageHeld =
    sameWorld === null
      ? null
      : Object.freeze({
          dimension: "coverage",
          label: sameWorld.label,
          attempted: sameWorld.held,
          addressable: sameWorld.addressable,
          what: "the actions both worlds made addressable, and how many of them the floor run addressed",
        });
  if (sameWorld !== null && sameWorld.attempted < sameWorld.held)
    return Object.freeze({
      below: true,
      missedFamilies: Object.freeze([]),
      belowBy: "coverage",
      held: coverageHeld,
      sameWorld,
      unmeasured: null,
    });
  const baselineFamilies = scenarioBaseline.familiesAttempted ?? null;
  const familiesComparable = baselineFamilies !== null && addressableFamilyNames !== null;
  if (!familiesComparable)
    return Object.freeze({
      below: false,
      missedFamilies: Object.freeze([]),
      belowBy: null,
      held: coverageHeld,
      sameWorld,
      // A population of zero is never green: with no shared action and no family split there is nothing to compare.
      unmeasured: sameWorld === null ? `no_shared_world_with_baseline:${floor?.label ?? scenarioBaseline.label}` : null,
    });
  const touched = new Set(familyNames);
  // The families this run's world offered AND the recorded best worked in: the only families it can be charged for
  // skipping. The bar is that set; the count held is how much of it this run used.
  const offered = addressableFamilyNames.filter((family) => (baselineFamilies[family] ?? 0) > 0);
  const missedFamilies = Object.freeze(offered.filter((family) => !touched.has(family)).sort());
  return Object.freeze({
    below: missedFamilies.length > 0,
    missedFamilies,
    belowBy: missedFamilies.length > 0 ? "families" : null,
    held:
      missedFamilies.length === 0
        ? coverageHeld
        : Object.freeze({
            dimension: "families",
            label: scenarioBaseline.label,
            offered: Object.freeze(offered),
            touched: offered.filter((family) => touched.has(family)).length,
            what: "the families this run's world offered that the recorded best worked in",
          }),
    sameWorld,
    unmeasured: null,
  });
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

/**
 * The bar this run was held to, in words that say what the number IS rather than only what it is.
 *
 * A ratio with no holder is a number a reader cannot argue with: `round84` came back `narrow:below_baseline:round38`
 * while the ratio it failed - 18 of 55 against 17 of 43 - belonged to `round76`, a run `round38`'s entry had never
 * recorded a width for. So the holder travels with the pair, and a reading that could compare nothing says which input
 * was missing instead of printing a bar nobody held.
 *
 * The coverage arm prints the SHARED-WORLD pair, not the floor's own rate: `13 of 40 same-world by round76, this run 15`
 * is a comparison of two runs in one world, and the floor's original 43 is a fact about `round76`'s day that this run
 * cannot be charged with. Printing the run's own number beside the bar is what lets a reader see which of the two moved.
 */
function baselineHeldText(breadth) {
  const held = breadth.baselineCompared ?? null;
  // A run that published no census has no world of its own to hold anything against: printing round76's ratio beside its
  // catalog count would be the mixed comparison identity the baseline file refuses to record.
  if (breadth.census === null)
    return "not_measured (this run published no snapshot census, so it has no world of its own to compare)";
  if (held !== null && held.dimension === "families")
    return `${String(held.touched)} of ${String(held.offered.length)} families by ${held.label} (${held.what})`;
  const shared = breadth.baselineSameWorld ?? null;
  if (held !== null && shared !== null)
    return `${String(held.attempted)} of ${String(held.addressable)} same-world by ${held.label}, this run ${String(shared.attempted)} (${held.what})`;
  if (held !== null) return `${String(held.attempted)} of ${String(held.addressable)} by ${held.label} (${held.what})`;
  if (breadth.baseline === null || breadth.baseline === undefined)
    return `none (no ratchet recorded for scenario ${breadth.scenario ?? "none"})`;
  return "not_measured (the recorded ratchet holds neither a coverage floor nor a family split to compare)";
}

/** The reading as lines a terminal or a run log can carry, one fact per line, population and census first. */
export function formatActionBreadth(breadth) {
  // A READING NOBODY COULD TAKE has no population to print, and the verdict is its whole content: `round98`'s baseline
  // reader threw during assembly, and the artifact it published was the gap code. Printing `attempted 0` beside it would
  // turn a measurement that was never taken into a day that did nothing.
  if (breadth.published === null && breadth.census === null && breadth.addressable === null)
    return Object.freeze([`action_breadth: not measured - ${breadth.verdict}`]);
  const share =
    breadth.concentration === null
      ? `not_judged (${breadth.concentrationReason ?? "no_concentration_reading"})`
      : `${breadth.concentration.actionId} ${breadth.concentration.executions} (${(breadth.concentration.share * 100).toFixed(1)}%)`;
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const census = breadth.census ?? null;
  const withRows = census === null ? 0 : census.families.filter((entry) => entry.rows > 0).length;
  // THE THREE READINGS, SIDE BY SIDE, and the bar the verdict compared them against. `attempted T of addressable A` is
  // what the companion chose out of what its own snapshots made reachable, `published F of G families` is how wide that
  // world was, and `published P` is what the catalog offered in total. All three are printed because all three move for
  // different reasons: `round95`/`96`/`97` attempted 26/20/18 of worlds 57/55/53 wide, so a reader has to be able to see
  // which of them the verdict turned on. The difference `P - A` is the part of the catalog this world never made
  // addressable (`round84`: 46 of 101), a fact about the fixture and never about her.
  const populations =
    breadth.addressable === null || breadth.addressable === 0
      ? `attempted ${String(breadth.attempted)} of ${String(breadth.published)} published; succeeded ${String(breadth.succeeded)} (no snapshot census, so the addressable width is not measurable)`
      : `attempted ${String(breadth.attempted)} of ${String(breadth.addressable)} addressable (${percent(breadth.coverage ?? 0)}) (published ${String(withRows)} of ${String(census.families.length)} families); succeeded ${String(breadth.succeeded)} of ${String(breadth.addressable)}; published ${String(breadth.published)} (${String(breadth.published - breadth.addressable)} never addressable in this world)`;
  const compared = `${populations}; baseline-held ${baselineHeldText(breadth)}; compared ${breadth.baselineFailed ?? "none"}`;
  return Object.freeze([
    `action_breadth: population ${String(breadth.published)} published, ${String(breadth.judged)} judged (${String(breadth.published - breadth.judged)} excluded)`,
    census === null
      ? "action_breadth: census none published - the addressable surface cannot be measured"
      : `action_breadth: census ${String(census.snapshots)} snapshots from ${census.source}, ${String(withRows)} of ${String(census.families.length)} target families with rows`,
    breadth.addressable === null
      ? "action_breadth: addressable not_measured (no snapshot census)"
      : `action_breadth: addressable ${String(breadth.addressable)} of ${String(breadth.published)} published (target-bound ${String(breadth.addressableTargetBound)}, targetless ${String(breadth.addressableTargetless)})`,
    // Only when there is something to say: an empty line for the ordinary run would be noise in every artifact.
    ...(breadth.addressableWithheld !== null && (breadth.addressableWithheld ?? []).length > 0
      ? [
          `action_breadth: withheld ${breadth.addressableWithheld.map((entry) => `${entry.actionId}(${entry.reason})`).join(",")} - the family had a row, the action's own precondition did not hold`,
        ]
      : []),
    ...(breadth.addressableFromAttempt !== null && (breadth.addressableFromAttempt ?? []).length > 0
      ? [
          `action_breadth: from_attempt ${breadth.addressableFromAttempt.join(",")} - addressable on the run's own execution, which its census could not evidence`,
        ]
      : []),
    ...(breadth.toolClaimUnmeasured !== null && (breadth.toolClaimUnmeasured ?? []).length > 0
      ? [
          `action_breadth: tool_claim_unmeasured ${breadth.toolClaimUnmeasured.map((entry) => `${entry.actionId}(${entry.word})`).join(",")} - a declared tool word this tree cannot interpret, so the action stays in the denominator`,
        ]
      : []),
    `action_breadth: ${compared}`,
    `action_breadth: families ${String(breadth.families)} of ${String(breadth.publishedFamilies)}${breadth.familyNames.length === 0 ? "" : ` ${breadth.familyNames.join(",")}`}`,
    `action_breadth: executions ${String(breadth.executions)} (${String(breadth.attributedExecutions)} attributed); concentration ${share}`,
    `action_breadth: verdict ${breadth.verdict}`,
  ]);
}
