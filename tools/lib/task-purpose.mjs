/**
 * A task's PURPOSE, and the difference between it and an action's success.
 *
 * Three levels are decided in this product, and they are not interchangeable:
 *
 *   1. ACTION POSTCONDITION - did this one action do what it promised? Decided by the Mod's receipt and, on the
 *      Host side, by `IntegrationActionCatalog.hasCompletionEvidence`: the per-action evidence parser in
 *      `host/src/stardew-game-integration-adapter.ts`, gated one rule per action by
 *      `host/src/stardew-completion-evidence-coverage.test.ts`. A receipt whose state is `succeeded` but whose
 *      detail does not parse as THAT action's own postcondition is evidence of nothing, and this module refuses it.
 *
 *   2. TASK CRITERION - was the PURPOSE achieved? A purpose is a statement about the world, and it is never the
 *      same fact as "an action succeeded". `break_rock`'s postcondition is true when a rock left the layer; the
 *      purpose "a mine was entered and something was broken inside it" is false when the rock was on the surface.
 *      The table below is the only place a daily task is declared accomplished.
 *
 *   3. REPORT - what the run publishes and tells the player. It is projected FROM (2). It never decides (2).
 *
 * Measured: a `go_mining`-shaped day declared `[travel, enter_mine, break_rock]`, broke rocks on the surface, and
 * was counted as having accomplished the task because `break_rock` came back `succeeded`. The postcondition was
 * real; the purpose was never touched. So a criterion is composed from postconditions that TOGETHER state the
 * purpose - the order the world saw them in is part of the statement - and "some declared action succeeded"
 * satisfies none of them.
 *
 * WHAT A CRITERION MAY NOT DO. It may not read a fact the receipts do not publish, and it may not substitute a
 * readable neighbour for the purpose (clearing "one patch somewhere" is not clearing the east patch). Where the
 * purpose needs a fact nothing publishes, the entry carries `missingFact` instead of `steps`: the task is then
 * `unproven` with that sentence attached, and `judgeTaskPurpose` still cannot return `achieved` for it.
 */

import { STARDEW_GAME_INTEGRATION_ADAPTER } from "../../host/dist-test/stardew-game-integration-adapter.js";

import { SWEEP_DAILY_TASKS } from "./multiday-daily-tasks.mjs";
import { bestWindow, largestFilledRectangle, windowHoldsAll } from "./tile-patch.mjs";

/** A step of a criterion: one admitted postcondition. */
const step = (actionId) => Object.freeze({ actionId });

/** A step satisfied by any one of several actions - the same purpose reached by different native seams. */
const anyOf = (...actionIds) => Object.freeze({ anyOf: Object.freeze(actionIds) });

const criterion = (purpose, steps, { ordered = true } = {}) =>
  Object.freeze({ purpose, steps: Object.freeze(steps), ordered });

/**
 * A purpose that cannot be decided from published facts, with the fact that would be needed.
 *
 * This is not an exclusion from the gate: the gate requires every rotation task to have an entry, and this entry
 * still answers `unproven` rather than `achieved` for any receipt set, however complete.
 */
const gap = (purpose, missingFact) => Object.freeze({ purpose, missingFact });

/**
 * A purpose that is a SHAPE in the world, declared as the rectangle it asks for.
 *
 * `steps` cannot state this one: a patch is not "these actions happened", it is "the tiles those actions changed
 * form one 3x20 strip". So the entry declares the rectangle, and beside it the actions whose own postcondition names
 * the tile it changed and the evidence field that name is in - the only tile coordinates any receipt publishes.
 * Whether a set of coordinates contains the declared rectangle is decided in `tile-patch.mjs`.
 */
const patch = (purpose, { width, height, tilledBy, croppedBy }) =>
  Object.freeze({
    purpose,
    patch: Object.freeze({ width, height }),
    tilledBy: Object.freeze(tilledBy),
    croppedBy: Object.freeze(croppedBy),
  });

/** One action that proves a tile is tilled or carries a crop, and the evidence field that names the tile. */
const tileProof = (actionId, tileField) => Object.freeze({ actionId, tileField });

/**
 * What each rotation task's purpose requires, keyed by the task ids in `multiday-daily-tasks.mjs`.
 *
 * Each criterion reads only postconditions the Mod already publishes and the Host already validates, and each one
 * requires at least two of them, so no single action's success can satisfy a task.
 */
export const TASK_PURPOSE_CRITERIA = Object.freeze({
  clear_east_patch: gap(
    "the east patch has no weeds and rocks left in it",
    "no fact says which part of the farm is the east patch: `cut_weeds`/`cut_grass`/`break_rock`/`chop_stump` publish the target they removed and the tool they used, never the map or the region, so 'a patch was cleared somewhere' is the strongest statement a run can make.",
  ),
  water_and_harvest: criterion("a crop was brought in and the ground it left was then planted", [
    step("harvest_crop"),
    step("plant_seed"),
  ]),
  forage_and_trees: criterion(
    "something was picked up and a tree was shaken",
    [step("pickup_forage"), step("shake_tree")],
    { ordered: false },
  ),
  craft_and_place_machine: criterion("a machine was crafted, then put down, then put to work", [
    step("craft_item"),
    step("place_owned_object"),
    step("machine_load"),
  ]),
  town_market: gap(
    "something was bought in town and the post was brought in",
    "no published fact places the actor in Town: `shop_purchase` publishes the shop and `claim_mail_attachment` the farm mailbox, neither publishes a map, and `travel` publishes endpoints only when travel is the route that was used.",
  ),
  town_visit: gap(
    "a conversation happened in town",
    "`talk_to_npc` publishes the NAME of the map the conversation happened on (Farm, SeedShop, Saloon, ...), and nothing publishes which of those maps is Town, so a word at the farm and a word in the square are the same fact.",
  ),
  mine_delve: criterion("a mine level was entered and something was broken after it", [
    step("enter_mine"),
    anyOf("break_rock", "break_container"),
  ]),
  store_and_sort: criterion("something was put into a chest and taken back out", [
    step("chest_store"),
    step("chest_retrieve"),
  ]),
  till_and_sow: criterion("the ground was tilled, then planted, then watered", [
    step("till_soil"),
    step("plant_seed"),
    step("water_crop"),
  ]),
  tidy_and_repair: criterion(
    "debris was cleared and something placed was put away",
    [step("clear_debris"), step("remove_placed_item")],
    { ordered: false },
  ),
  tend_the_animals: criterion(
    "an animal was petted, fed, and its product collected",
    [step("pet_animal"), step("feed_animal"), step("collect_animal_product")],
    { ordered: false },
  ),
  dress_and_display: criterion("something else was put on and the house was given a display", [
    step("equip_wearable"),
    anyOf("dress_mannequin", "set_sign_display"),
  ]),
  clear_and_cultivate: criterion("a patch was cleared, then tilled, then planted and watered", [
    anyOf("chop_tree", "chop_stump", "clear_debris"),
    step("till_soil"),
    step("plant_seed"),
    step("water_crop"),
  ]),
  // THE ONLY CRITERION THAT COUNTS TILES. `clear_east_patch` cannot say which part of the farm was cleared, and
  // `till_and_sow` cannot say how much was tilled, because a receipt names one tile and no criterion asked for a
  // shape. This one does: sixty tiles, all tilled, all carrying a crop, inside a 3x20 strip - a plot longer than the
  // 13x13 window one snapshot sees, so the boundary has to survive her walking out of view.
  clear_and_plant_long_patch: patch(
    "one long strip, three tiles wide and twenty long, was tilled and sown the whole way",
    {
      width: 3,
      height: 20,
      // `till_soil` proves the HoeDirt at the tile it turned (`before=none;after=HoeDirt`) and names that tile as its
      // `target`; `plant_seed` and `water_crop` each name the `tile` the crop is on. No other action a real patch day
      // uses - `cut_weeds`, `break_rock`, `clear_debris` - publishes a tile, which is why clearing cannot prove a
      // shape and only the tilling and sowing can.
      tilledBy: [tileProof("till_soil", "target")],
      croppedBy: [tileProof("plant_seed", "tile"), tileProof("water_crop", "tile")],
    },
  ),
  // Two steps, because the purpose is not "an action succeeded": it is that she went to water and came back with a
  // fish. `navigate_to_destination`/`travel` is how a day reaches water `waterTargets` named, and `fish_here` is the
  // catch; a one-step criterion would be a single success standing in for the whole purpose.
  a_fish_from_the_water: criterion("she went to the water and came back with a fish", [
    anyOf("navigate_to_destination", "travel"),
    step("fish_here"),
  ]),
  home_and_hearth: gap(
    "the house was tidied and a few things put out so it feels lived in",
    "`place_owned_object` publishes the one object it set down and the map it landed on, and nothing publishes what the room now holds - the note's own end state ('so it feels lived in') has no fact behind it, and 'tidy it up' names no action with a postcondition.",
  ),
  home_upgrade: gap(
    "the carpenter was asked about extending the house",
    "the farmhouse upgrade is an answer inside the carpenter's own dialogue; no receipt reports it. `shop_purchase` reports a shop sale, and the game's upgrade branch (`GameLocation.answerDialogueAction`) mints no world fact.",
  ),
  mine_ladder_to_depth: gap(
    "a mine level was worked deeper and then left by its own exit ladder",
    "the exit half is `use_mine_ladder`, which the Mod catalog registers `FarmhandActionLifecycle.Experimental` (`FarmhandActionDefinitions.cs:270`): the action is not published, so no run can dispatch it and no receipt can prove a ladder was taken.",
  ),
  furnish_and_arrange: gap(
    "placed furniture was moved and something was recoloured",
    "the move half is `move_placed_furniture`, which the Mod catalog registers `FarmhandActionLifecycle.Experimental`: it is not published, so no run can dispatch it, and `color_placed_object` alone is one action rather than the arrangement.",
  ),
  run_the_machines: criterion("a machine was loaded and its output collected", [
    step("machine_load"),
    step("machine_collect_output"),
  ]),
  // The sweep tasks, each of whose purpose is "this group of the farm was worked". No receipt names a group - one
  // receipt names one action and one target - so every one of them is a gap, and a criterion built from two of the
  // group's actions would claim a purpose the group never had. The sentences live on the task definitions in
  // `multiday-daily-tasks.mjs`, beside the grouping that decides them, rather than being written a second time here.
  ...Object.fromEntries(SWEEP_DAILY_TASKS.map((task) => [task.id, gap(task.purpose, task.missingFact)])),
});

/**
 * The admitted evidence a purpose may read: one entry per receipt that is BOTH a success state AND its own
 * action's postcondition, as the Host decides that question.
 *
 * A `succeeded` receipt with no evidence, or with evidence that does not parse as the action it names, is moved to
 * `refused` instead of being counted. That list is what lets a caller say "the receipt existed and proved nothing"
 * rather than "the run did nothing", and it is the reason a refused receipt can only ever produce `unproven`.
 *
 * The admitted entry keeps the receipt it admitted, so a criterion about tiles reads the SAME evidence the Host just
 * validated instead of re-deciding admission: one authority per fact, even when the fact is "this receipt proves a
 * tile".
 */
export function purposeReceipts(receipts) {
  const admitted = [];
  const refused = [];
  for (const receipt of receipts ?? []) {
    if (receipt === null || typeof receipt !== "object") continue;
    const actionId = receipt.actionId;
    if (typeof actionId !== "string" || actionId.length === 0) continue;
    // Only a success state is a candidate. A failure or an in-flight state is not evidence of anything, and it is
    // not "refused" either - there is nothing to refuse.
    if (receipt.state !== "succeeded") continue;
    if (
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(actionId, {
        state: receipt.state,
        reasonCode: typeof receipt.reasonCode === "string" ? receipt.reasonCode : "",
        evidence: receipt.evidence,
      }) !== true
    ) {
      refused.push(Object.freeze({ actionId, reasonCode: "succeeded_receipt_without_its_own_postcondition" }));
      continue;
    }
    admitted.push(Object.freeze({ actionId, receipt }));
  }
  return Object.freeze({ admitted: Object.freeze(admitted), refused: Object.freeze(refused) });
}

/** The first receipt, at or after `from`, that satisfies this step without reusing an already-consumed one. */
function matchingIndexIn(admitted, used, from, candidate) {
  const actionIds = candidate.actionId === undefined ? candidate.anyOf : [candidate.actionId];
  for (let index = from; index < admitted.length; index += 1) {
    if (!used.has(index) && actionIds.includes(admitted[index].actionId)) return index;
  }
  return -1;
}

/**
 * Whether every step of a criterion is satisfied, each by a DISTINCT admitted receipt.
 *
 * An ordered criterion (`ordered: true`, the default) matches its steps forward through the receipt log, so the
 * order the world saw them in is part of the statement: a rock broken before the mine was entered cannot satisfy
 * "a mine was entered and something was broken after it", and water poured before the seed went in cannot satisfy
 * "tilled, then planted, then watered". An unordered one still requires distinct receipts, so one action cannot
 * answer two of its steps.
 */
function criterionSatisfied(entry, admitted) {
  const used = new Set();
  let cursor = -1;
  for (const candidate of entry.steps) {
    const index = matchingIndexIn(admitted, used, entry.ordered === false ? 0 : cursor + 1, candidate);
    if (index < 0) return false;
    used.add(index);
    cursor = index;
  }
  return true;
}

/**
 * The fields of the Mod's evidence literal, as the producer wrote them.
 *
 * A lenient reader on purpose: this parses what admission ALREADY accepted, so a field it cannot read costs a tile
 * rather than a verdict - and a criterion that loses a tile reports `unproven` or a smaller count, never an
 * achievement it did not see.
 */
function evidenceFields(detail) {
  const fields = new Map();
  for (const part of detail.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const field = part.slice(0, separator);
    if (!fields.has(field)) fields.set(field, part.slice(separator + 1));
  }
  return fields;
}

/** A tile the way the Mod spells one - `x,y`, both within the map's coordinate bound - or null. */
function tileOf(value) {
  const match = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/u.exec(typeof value === "string" ? value : "");
  if (match === null) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return x <= 1000 && y <= 1000 ? Object.freeze({ x, y }) : null;
}

const tileKey = (tile) => `${String(tile.x)},${String(tile.y)}`;

/**
 * The tiles the run proved, grouped by the map they are on.
 *
 * Two sources, and they are not the same kind of fact. A receipt proves what IT changed, and the tile it names is
 * part of that action's own postcondition, so the coordinate is exactly as trustworthy as the receipt. An observed
 * row is what the companion could see at one moment, and it is read as it describes itself: a `cropTargets` row is a
 * crop, while a `soilTiles` row counts as tilled ONLY when the row's own `hoeDirt` says so - the Mod's
 * `DiscoverSoilTiles` skips every tile that already has HoeDirt, because the family is the `till_soil` target list,
 * and counting those rows as tilled would let untilled ground be reported as a finished plot.
 */
function patchTileFacts(entry, admitted, observations) {
  const byLocation = new Map();
  const factsFor = (location) => {
    const existing = byLocation.get(location);
    if (existing !== undefined) return existing;
    const created = { tilled: new Map(), cropped: new Map() };
    byLocation.set(location, created);
    return created;
  };
  const mapOf = (location) =>
    typeof location === "string" && location.length > 0 && location !== "none" ? location : null;
  for (const admittedReceipt of admitted) {
    const proofs = [...entry.tilledBy, ...entry.croppedBy].filter(
      (proof) => proof.actionId === admittedReceipt.actionId,
    );
    const detail = admittedReceipt.receipt?.evidence?.detail;
    if (proofs.length === 0 || typeof detail !== "string") continue;
    const fields = evidenceFields(detail);
    const location = mapOf(fields.get("location"));
    const tile = tileOf(fields.get(proofs[0].tileField));
    if (location === null || tile === null) continue;
    const facts = factsFor(location);
    for (const proof of proofs) {
      const target = entry.tilledBy.includes(proof) ? facts.tilled : facts.cropped;
      target.set(tileKey(tile), tile);
    }
  }
  const observedOn = mapOf(observations?.location);
  if (observedOn !== null) {
    const facts = factsFor(observedOn);
    for (const row of observations?.soilTiles ?? []) {
      const tile = tileOf(`${String(row?.x)},${String(row?.y)}`);
      if (row?.hoeDirt === true && tile !== null) facts.tilled.set(tileKey(tile), tile);
    }
    for (const row of observations?.cropTargets ?? []) {
      const tile = tileOf(`${String(row?.x)},${String(row?.y)}`);
      if (tile !== null) facts.cropped.set(tileKey(tile), tile);
    }
  }
  return byLocation;
}

/**
 * What one map's proven tiles say about the declared patch.
 *
 * `holdsAll` is the line between the two failures that must not read alike: a set of tiles that fits inside one
 * declared window is a patch that is not finished yet, and a set that fits inside none of them is a different shape
 * however many tiles it holds.
 */
function patchReading(location, facts, orientations) {
  const qualified = [...facts.tilled.keys()]
    .filter((key) => facts.cropped.has(key))
    .map((key) => facts.tilled.get(key));
  const windows = orientations.map((orientation) => bestWindow(qualified, orientation));
  let window = windows[0];
  for (const candidate of windows) {
    if (candidate !== null && (window === null || candidate.count > window.count)) window = candidate;
  }
  return Object.freeze({
    location,
    coordinateCount: facts.tilled.size + facts.cropped.size,
    tileCount: qualified.length,
    window,
    holdsAll: orientations.some((orientation) => windowHoldsAll(qualified, orientation)),
    largestRectangle: largestFilledRectangle(qualified),
  });
}

/**
 * The verdict for a patch purpose: did the run prove the declared rectangle?
 *
 * Four outcomes, and they are deliberately four. `achieved` needs a full window of tiles that are BOTH tilled and
 * carrying a crop. A run inside one declared window but short of its 60 tiles is a patch that is not finished, and it
 * reports the count it reached. A run whose tiles fit inside no declared window worked a different shape, and that is
 * named as its own finding with the largest rectangle it did form. A run whose receipts carry no tile at all leaves
 * us nothing to place on a map, which is our gap rather than her failure.
 */
function judgePatch(entry, admitted, refused, observations) {
  const declared = entry.patch;
  const area = declared.width * declared.height;
  // The same strip laid across the farm and laid down it is the same work, so the declared shape is tried in both
  // orientations. Rotation is the criterion's decision, not the geometry's.
  const orientations = [declared, Object.freeze({ width: declared.height, height: declared.width })];
  const byLocation = patchTileFacts(entry, admitted, observations);
  const readings = [...byLocation].map(([location, facts]) => patchReading(location, facts, orientations));
  const proved = readings.find((reading) => reading.window?.count === area);
  if (proved !== undefined) {
    const strip = proved.window;
    return Object.freeze({
      state: "achieved",
      reasonCode: "task_purpose_achieved",
      purpose: entry.purpose,
      missingFact: null,
      patch: declared,
      location: proved.location,
      patchTiles: proved.tileCount,
      patchWindow: strip,
      detail: `${String(area)}/${String(area)} tiles of a ${String(strip.width)}x${String(strip.height)} strip at ${String(strip.x)},${String(strip.y)} are tilled and sown`,
    });
  }
  // A refused receipt means the evidence that would have decided this purpose exists and proved nothing about the
  // action it named. That is not "the patch is not there"; it is "this run cannot tell", and it is treated as such -
  // but only for the actions this criterion reads a TILE from. Measured 2026-11-06 (`round38`): the patch day refused
  // nine receipts of `move_to_tile`, `shop_purchase`, `harvest_crop` and `dismiss_modal`, none of which publishes a
  // coordinate this criterion counts, and the criterion answered `unproven` - telling a reader that the plot could not
  // be read while every tile that decides it was admitted and in hand. Twenty tiles tilled, thirteen planted, and the
  // artifact could say neither "achieved" nor "3/60".
  const tileProvingActionIds = new Set(
    [...entry.tilledBy, ...entry.croppedBy].map((tileProofEntry) => tileProofEntry.actionId),
  );
  if (refused.some((receipt) => tileProvingActionIds.has(receipt.actionId))) {
    return Object.freeze({
      state: "unproven",
      reasonCode: "task_purpose_evidence_without_postcondition",
      purpose: entry.purpose,
      missingFact: null,
      patch: declared,
    });
  }
  if (readings.every((reading) => reading.coordinateCount === 0)) {
    return Object.freeze({
      state: "unproven",
      reasonCode: "task_purpose_has_no_tile_coordinates",
      purpose: entry.purpose,
      missingFact:
        "no receipt of this run carried a tile for the patch: `till_soil` names the tile it turned and `plant_seed`/`water_crop` name the tile their crop is on, so with none of those admitted nothing says where the plot was. This is the run's observation gap, not a failure of the companion's.",
      patch: declared,
    });
  }
  // The plot is the map the most tiles were proven on. A map with no proven tile at all is not the plot; it is the
  // bedroom she slept in, or the garden pots in the house, and it only speaks when no map proves anything.
  const populated = readings.filter((reading) => reading.coordinateCount > 0);
  const best = [...populated].sort(
    (left, right) =>
      right.coordinateCount - left.coordinateCount ||
      (right.holdsAll ? 1 : 0) - (left.holdsAll ? 1 : 0) ||
      (right.window?.count ?? 0) - (left.window?.count ?? 0) ||
      (right.largestRectangle?.area ?? 0) - (left.largestRectangle?.area ?? 0) ||
      left.location.localeCompare(right.location),
  )[0];
  const strip = best.window ?? Object.freeze({ width: declared.width, height: declared.height, count: 0 });
  if (best.holdsAll) {
    return Object.freeze({
      state: "not_achieved",
      reasonCode: "task_purpose_not_achieved",
      purpose: entry.purpose,
      missingFact: null,
      patch: declared,
      location: best.location,
      patchTiles: best.tileCount,
      patchWindow: strip,
      detail: `${String(strip.count)}/${String(area)} tiles inside the best ${String(strip.width)}x${String(strip.height)} window at ${String(strip.x)},${String(strip.y)}`,
    });
  }
  const largest = best.largestRectangle;
  return Object.freeze({
    state: "not_achieved",
    reasonCode: "tiles_do_not_form_the_declared_patch",
    purpose: entry.purpose,
    missingFact: null,
    patch: declared,
    location: best.location,
    patchTiles: best.tileCount,
    largestRectangle: largest,
    detail: `the largest rectangle found is ${String(largest.width)}x${String(largest.height)} (${String(largest.area)} tiles), not the declared ${String(declared.width)}x${String(declared.height)}`,
  });
}

/**
 * Did the task's own purpose hold?
 *
 * `achieved` is reachable only through the criterion above. Everything else is named: `not_achieved` when the
 * receipts are complete evidence that the purpose did not hold, `unproven` when the criterion cannot be evaluated at
 * all (no entry, or a published fact it needs is missing) or when the receipts that would have decided it carried no
 * postcondition of their own.
 *
 * `observations` is the snapshot rows the run saw (`{ location, soilTiles, cropTargets }`), and only a shape
 * criterion reads it: a purpose about three actions is decided by the receipts alone, while a purpose about a strip
 * of tiles may also count what the companion could see. Absent, the criterion reads the receipts.
 */
export function judgeTaskPurpose(taskId, receipts, observations = null) {
  const entry = TASK_PURPOSE_CRITERIA[taskId];
  const { admitted, refused } = purposeReceipts(receipts);
  const common = Object.freeze({
    taskId,
    admittedActionIds: Object.freeze([...new Set(admitted.map((receipt) => receipt.actionId))].sort()),
    refusedReceipts: refused,
  });
  if (entry === undefined) {
    return Object.freeze({
      ...common,
      state: "unproven",
      reasonCode: "task_purpose_not_declared",
      purpose: null,
      missingFact: `no purpose criterion is declared for "${String(taskId)}", so nothing can say whether it was accomplished.`,
    });
  }
  if (entry.missingFact !== undefined) {
    return Object.freeze({
      ...common,
      state: "unproven",
      reasonCode: "task_purpose_needs_an_unpublished_fact",
      purpose: entry.purpose,
      missingFact: entry.missingFact,
    });
  }
  if (entry.patch !== undefined) {
    return Object.freeze({ ...common, ...judgePatch(entry, admitted, refused, observations) });
  }
  if (criterionSatisfied(entry, admitted)) {
    return Object.freeze({
      ...common,
      state: "achieved",
      reasonCode: "task_purpose_achieved",
      purpose: entry.purpose,
      missingFact: null,
    });
  }
  // A refused receipt means the evidence that would have decided this purpose exists and proved nothing about the
  // action it named. That is not "the purpose did not hold"; it is "this run cannot tell", and it is treated as such.
  if (refused.length > 0) {
    return Object.freeze({
      ...common,
      state: "unproven",
      reasonCode: "task_purpose_evidence_without_postcondition",
      purpose: entry.purpose,
      missingFact: null,
    });
  }
  return Object.freeze({
    ...common,
    state: "not_achieved",
    reasonCode: "task_purpose_not_achieved",
    purpose: entry.purpose,
    missingFact: null,
  });
}
