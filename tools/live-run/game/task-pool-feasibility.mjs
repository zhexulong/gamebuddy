/**
 * Whether the world one OPENING observation shows can hold EVERY task in the pool - and, inside the day, the one
 * requirement a day can still lose.
 *
 * <p>
 * THE DEFECT THIS ANSWERS. The pool used to discover impossibility on day 3 of a thirty-five-minute run: a
 * `dress_and_display` day with no wearable in the pack and no mannequin or sign in the world, a `3x20` strip cut out of
 * ground that did not hold sixty tillable tiles, a `till_soil` day whose ground the fixture had already turned. Not one of
 * those needed a model to find - each is a fact of the opening snapshot, and the run paid several days to learn it. So
 * every task declares the world preconditions its purpose needs (`TASK_PRECONDITIONS` in
 * `tools/lib/multiday-daily-tasks.mjs`) and this module evaluates the whole pool against ONE observation.
 * </p>
 *
 * <p>
 * THE MOMENT IS PART OF THE ANSWER, so every reading here is stamped with its own. `estimateTaskPoolAtOpening` answers
 * "can this pool be held from the world visible in this snapshot, now" - the boot's reading, taken before a model is
 * asked anything - and the line it prints begins with `opening_snapshot` because that is the whole of what it can claim.
 * A day five hours later is a different world, and the reading must not be quoted as if it spoke for it. Measured
 * 2026-11-23 (`round96`): the launch snapshot carried three stocked seed rows and 500g, so both sowing tasks read
 * feasible; on day 2 the same family published ZERO rows with the purse at 1060, she walked to a Pierre's that was
 * carrying the desert festival's stalls - 「店里摆的全是沙漠节那些摊子，连防风草种子都没上架」 - came back empty-handed, and the
 * day's criterion filed twenty tilled tiles of a sixty-tile strip against her. The opening reading was right about the
 * world it read and could not speak for the day, which is a defect of the MOMENT and not of the reading.
 * </p>
 *
 * <p>
 * SO ONE REQUIREMENT IS ASKED AGAIN WHERE THE DAY RUNS. A task's seed counter is knowable again every time the Mod
 * refreshes `seedSupplyTargets` (`DiscoverSeedSupplyTargets`, from `Data/Shops` and the shop the game actually opened),
 * so `rereadDaySeedMarket` reads the SAME requirement the opening gate read, through the same `readSeedMarket`, on the
 * snapshot the day is standing in - and the answer is published at the minute it changed:
 * `task_precondition_broken_at:<gameMinutes>:seed_market:<rows>` when the counter stops holding what the day needs, and
 * `seed_market_changed:<gameMinutes>:<rowsAtOpen>-><rows>` when the market moved and still holds. The day then has a
 * fact to act on at 14:00 instead of a failure to explain at dusk.
 * </p>
 *
 * <p>
 * THE SNAPSHOT IS THE AGENT'S OWN. `snapshot` here is what `stardew_observe` answers - the Mod's
 * `CreateBridgeSnapshot` projection, taken from the bridge the way a smoke runner takes it (`client.observe()`, through
 * `connectNativeLocalClient`). Nothing in this file builds a world: a hand-made fixture would prove the reader agrees
 * with its author and nothing about the game. The reading is a pure function of that object, so a recorded observation can
 * be replayed - which is how a fixture change is checked without a second boot.
 * </p>
 *
 * <p>
 * THREE ZEROES, TOLD APART. A pool of zero tasks is not a pass (`blocked: "task_pool_empty"`): a check whose population is
 * empty agrees with itself. A snapshot that is not an observation is `opening_snapshot_unmeasured`, never "everything
 * infeasible". And a family the Mod did not measure this snapshot is `task_precondition_not_measured`, beside
 * `task_precondition_unmet` for a fact it measured and refused - the two are different facts with different owners, and the
 * code says which one it is.
 * </p>
 *
 * <p>
 * AND A THIRD ANSWER BESIDE FEASIBLE AND INFEASIBLE, because a target family is a WINDOW: every `Discover*` walks
 * thirteen tiles around the actor, so an empty `machineTargets` says "no machine within view", not "this farm has no
 * machine". A task whose only witness is such a family is `undecided` (`task_precondition_out_of_view`), reported and
 * never counted against the world; only the families that answer for the whole map or the whole actor can make a task
 * infeasible on emptiness, and they are named in `WHOLE_WORLD_FAMILIES`.
 * </p>
 *
 * <p>
 * WHERE IT RUNS. Three entry points, and none is a script nobody calls:
 * </p>
 * <ul>
 *   <li>the prelive ladder's snapshot rung (`tools/lib/stardew-prelive-ladder.mjs`, `--mode snapshot`), which already
 *       connects, waits for an actionable snapshot and disconnects with no model and no action dispatched - so a
 *       `-PreliveOnly` fixture boot (about twenty seconds) answers the pool as part of the boot it already pays for;</li>
 *   <li>the multi-day runner's day loop, which re-asks the seed counter on the world it is standing in
 *       (`rereadDaySeedMarket`) rather than trusting the boot's answer for a day that opened hours later; and</li>
 *   <li>this module's own command, for a fixture change that needs no ladder:
 *       `node tools/live-run/game/task-pool-feasibility.mjs --client-config <path>` (a running fixture) or
 *       `--snapshot <recorded.json>` (a replay). Exit 0 all feasible, 1 any infeasible task, 2 blocked.</li>
 * </ul>
 *
 * <p>
 * THE BUDGET IS FIFTEEN SECONDS of wall clock for the command, because that is what makes it runnable at a rung instead
 * of a batch job: the evaluation itself is milliseconds over one snapshot, so the budget is spent on the bridge and its
 * expiry is `task_pool_check_over_budget` rather than a hang.
 * </p>
 */

import { readFile } from "node:fs/promises";

import { DAILY_TASK_ROTATION, TASK_PRECONDITIONS } from "../../lib/multiday-daily-tasks.mjs";
import {
  connectNativeLocalClient,
  readNativeClientConfig,
  summarizeSnapshot,
} from "../../lib/stardew-native-smoke-harness-v1.mjs";

/** The wall-clock budget the whole command gets. See the header: the reading itself is milliseconds. */
export const TASK_POOL_BUDGET_MS = 15_000;

/**
 * The engine's own type-definition prefixes for the kinds `IsWearableItem` admits, and the reason a ring is not one.
 *
 * `EquipWearable`'s admission is `item is Hat or Boots or Ring or Clothing`
 * (`integrations/stardew/farmhandexecutioncontroller.actorstateactions.cs`), while the wire publishes only each pack
 * row's `qualifiedItemId`. Four of those four kinds' holders carry their own prefix - `(H)` hat, `(B)` boots, `(S)` shirt,
 * `(P)` pants (`StardewValley.ItemTypeDefinitions`) - and a ring carries `(O)`, the object prefix. So this reading can be
 * wrong in exactly one direction: a pack holding ONLY a ring answers "no wearable" when the truth is "not proven".
 * Declared rather than hidden, because a false `task_precondition_unmet` nobody can explain is worse than the risk.
 */
const WEARABLE_ITEM_PREFIXES = Object.freeze(["(H)", "(B)", "(S)", "(P)"]);

/**
 * The families that answer for the WHOLE map or the WHOLE actor, so an empty list there is a fact about the world.
 *
 * <p>
 * EVERY OTHER TARGET FAMILY IS A WINDOW. `Discover*` walks `TargetDiscoveryRadius` tiles around the actor
 * (`integrations/stardew/farmhandexecutioncontroller.targetdiscovery.cs`), so an empty `machineTargets` on an opening
 * Farm snapshot says "no machine within thirteen tiles" and NOT "this farm has no machine" - the machine may be in a
 * shed twenty tiles away. Reading that emptiness as infeasible would make this gate lie about a world that can do the
 * day, which is worse than the day failing honestly. So a window family that is empty makes its task
 * `task_precondition_out_of_view` - reported, never counted as infeasible - and only these families can fail a task on
 * emptiness:
 * </p>
 * <ul>
 *   <li>`warps`, `doorTargets`, `fixedInteractionPoints`, `farmBuildingTargets` - the map's own geometry, whole-map by
 *       construction (the Mod's `FarmableBlocks` comment says why a radius cannot state a map-wide fact);</li>
 *   <li>`seedSupplyTargets` - every shop in `Data/Shops` that stocks a held seed, world-wide by definition;</li>
 *   <li>`inventoryItemFacts`, `toolSlots`, `craftingRecipeTargets` - the actor's own pack, tools and learned recipes, not
 *       a place she stands.</li>
 * </ul>
 */
const WHOLE_WORLD_FAMILIES = Object.freeze(
  new Set([
    "warps",
    "doorTargets",
    "fixedInteractionPoints",
    "farmBuildingTargets",
    "seedSupplyTargets",
    "inventoryItemFacts",
    "toolSlots",
    "craftingRecipeTargets",
  ]),
);

/**
 * The requirement as the stable text its finding carries: `<task>:<this>`.
 *
 * Derived from the declaration rather than typed beside it, so a requirement cannot be reported under one name and
 * evaluated under another.
 */
export function describeRequirement(requirement) {
  switch (requirement?.fact) {
    case "family_rows":
      return `${requirement.families.join("|")}>=${String(requirement.atLeast)}`;
    case "soil_ground":
      return requirement.tiles === null
        ? `ground:${String(requirement.width)}x${String(requirement.height)}:${requirement.hoed ? "hoed" : "unhoed"}`
        : `ground:${String(requirement.tiles)}tiles:${requirement.hoed ? "hoed" : "unhoed"}`;
    case "seed_market":
      return "a_seed_counter_she_can_buy_or_already_holds";
    case "pack_kind":
      return `pack:${requirement.kind}`;
    case "money":
      return `money>=${String(requirement.atLeast)}`;
    default:
      // A requirement this module cannot read is refused by name rather than skipped: a signature member nobody
      // evaluates would make the task pass for the wrong reason.
      throw new Error(`task_precondition_kind_unknown:${String(requirement?.fact)}`);
  }
}

/**
 * One requirement against one snapshot: satisfied, or why not, and whether the fact was MEASURED.
 *
 * `measured: false` means the snapshot does not carry the family at all (the Mod withheld it because the capability that
 * publishes it was not advertised, or the replay predates the field). An empty array is measured, and empty.
 */
export function readRequirement(snapshot, requirement) {
  switch (requirement?.fact) {
    case "family_rows":
      return readFamilyRows(snapshot, requirement);
    case "soil_ground":
      return readSoilGround(snapshot, requirement);
    case "seed_market":
      return readSeedMarket(snapshot);
    case "pack_kind":
      return readPackKind(snapshot, requirement);
    case "money":
      return readMoney(snapshot, requirement);
    default:
      return { satisfied: false, measured: false, detail: `unknown requirement ${String(requirement?.fact)}` };
  }
}

function readFamilyRows(snapshot, requirement) {
  let total = 0;
  const unmeasured = [];
  for (const family of requirement.families) {
    const rows = snapshot?.[family];
    if (!Array.isArray(rows)) {
      unmeasured.push(family);
      continue;
    }
    total += rows.length;
  }
  if (total >= requirement.atLeast) return { satisfied: true, measured: true, detail: `${String(total)} rows` };
  const counted = unmeasured.length === 0 ? "" : `; not measured this snapshot: ${unmeasured.join("|")}`;
  const detail = `${String(total)} rows of ${requirement.families.join("|")} (wanted ${String(requirement.atLeast)})${counted}`;
  // A family the Mod measured as empty is DECISIVE only where the family answers for the whole map or the whole actor; a
  // target family is a window around her, and its emptiness is a statement about the window.
  const decisive = requirement.families.some(
    (family) => WHOLE_WORLD_FAMILIES.has(family) && Array.isArray(snapshot?.[family]),
  );
  if (decisive) return { satisfied: false, measured: true, detail };
  if (unmeasured.length === requirement.families.length)
    return { satisfied: false, measured: false, detail };
  return { satisfied: false, measured: true, outOfView: true, detail: `${detail}; a target family is a window on the map` };
}

/**
 * A strip of published ground the task can shape.
 *
 * Rows are grouped by the strip they belong to - `blockX`/`blockY`/`blockW`/`blockH`, the connected-strip box the Mod
 * measures over the WHOLE map - and a strip qualifies when its box can hold the declared rectangle (in either
 * orientation) or has the declared area, and every published row of it carries the declared hoe state. The box is what
 * lets one snapshot speak about a plot longer than its window; the state is only known for the rows in that window, which
 * is the ceiling the declaration names.
 */
function readSoilGround(snapshot, requirement) {
  const rows = snapshot?.soilTiles;
  if (!Array.isArray(rows)) return { satisfied: false, measured: false, detail: "soilTiles not measured" };
  if (rows.length === 0) return { satisfied: false, measured: true, detail: "no soil tile published" };
  const blocks = new Map();
  for (const row of rows) {
    if (!Number.isInteger(row?.x) || !Number.isInteger(row?.y)) continue;
    if (!Number.isInteger(row.blockW) || !Number.isInteger(row.blockH)) continue;
    const key = `${String(row.blockX)},${String(row.blockY)},${String(row.blockW)},${String(row.blockH)}`;
    const block = blocks.get(key) ?? { width: row.blockW, height: row.blockH, rows: [] };
    block.rows.push(row);
    blocks.set(key, block);
  }
  let largest = null;
  let stateRefusal = null;
  let stateUnmeasured = null;
  for (const block of blocks.values()) {
    const fits =
      requirement.tiles === null
        ? (block.width >= requirement.width && block.height >= requirement.height) ||
          (block.width >= requirement.height && block.height >= requirement.width)
        : block.width * block.height >= requirement.tiles;
    if (!fits) {
      if (largest === null || block.width * block.height > largest.width * largest.height) largest = block;
      continue;
    }
    // A row whose hoe state the Mod did not publish cannot witness either state: it is a missing reading, not a wrong one.
    const unknown = block.rows.filter((row) => typeof row.hoeDirt !== "boolean").length;
    if (unknown > 0) {
      stateUnmeasured =
        `strip ${String(block.width)}x${String(block.height)} publishes no hoe state for ` +
        `${String(unknown)} of ${String(block.rows.length)} rows`;
      continue;
    }
    const wrong = block.rows.filter((row) => row.hoeDirt !== requirement.hoed).length;
    if (wrong === 0)
      return { satisfied: true, measured: true, detail: `strip ${String(block.width)}x${String(block.height)}` };
    if (stateRefusal === null) {
      const state = requirement.hoed ? "untilled" : "tilled";
      stateRefusal =
        `strip ${String(block.width)}x${String(block.height)} has ${String(wrong)} of ` +
        `${String(block.rows.length)} published rows already ${state}`;
    }
  }
  if (stateRefusal !== null) return { satisfied: false, measured: true, detail: stateRefusal };
  if (stateUnmeasured !== null) return { satisfied: false, measured: false, detail: stateUnmeasured };
  if (blocks.size === 0)
    return {
      satisfied: false,
      measured: false,
      detail: `${String(rows.length)} soil rows carry no strip box (blockX/blockY/blockW/blockH), so no shape can be read`,
    };
  const seen =
    largest === null
      ? "no strip published"
      : `largest published strip ${String(largest.width)}x${String(largest.height)}`;
  const wanted =
    requirement.tiles === null
      ? `${String(requirement.width)}x${String(requirement.height)}`
      : `${String(requirement.tiles)} tiles`;
  return { satisfied: false, measured: true, detail: `${seen}, wanted ${wanted}` };
}

/**
 * A shop that stocks a seed she carries, and either she holds one already or the price is inside her purse.
 *
 * `seedSupplyTargets` is the family that answers this: one row per held plantable seed crossed with a shop that stocks it,
 * carrying the menu's own price, whether the shop's hours query says it is open, and where the counter is. A row with no
 * `shopId` is the engine's answer "no shop in `Data/Shops` sells this seed", which is the unmet half.
 */
function readSeedMarket(snapshot) {
  const rows = snapshot?.seedSupplyTargets;
  if (!Array.isArray(rows)) return { satisfied: false, measured: false, detail: "seedSupplyTargets not measured" };
  const withShop = rows.filter((row) => typeof row?.shopId === "string" && row.shopId.length > 0);
  if (withShop.length === 0)
    return {
      satisfied: false,
      measured: true,
      detail: `${String(rows.length)} seed supply rows, none stocked by a shop`,
    };
  const money = Number.isFinite(snapshot?.money) ? snapshot.money : null;
  const usable = withShop.filter(
    (row) =>
      (Number.isInteger(row.heldCount) && row.heldCount >= 1) ||
      (Number.isFinite(row.price) && money !== null && row.price <= money),
  );
  if (usable.length > 0) return { satisfied: true, measured: true, detail: `${String(usable.length)} affordable rows` };
  const cheapest = withShop
    .map((row) => (Number.isFinite(row.price) ? row.price : null))
    .filter((price) => price !== null)
    .sort((left, right) => left - right)[0];
  const price = cheapest === undefined ? "has no published price" : `costs ${String(cheapest)}`;
  return {
    satisfied: false,
    measured: true,
    detail: `cheapest stocked seed ${price}, purse ${money === null ? "not measured" : String(money)}`,
  };
}

function readPackKind(snapshot, requirement) {
  const rows = snapshot?.inventoryItemFacts;
  if (!Array.isArray(rows)) return { satisfied: false, measured: false, detail: "inventoryItemFacts not measured" };
  const matching = rows.filter(
    (row) =>
      typeof row?.qualifiedItemId === "string" &&
      WEARABLE_ITEM_PREFIXES.some((prefix) => row.qualifiedItemId.startsWith(prefix)),
  );
  if (matching.length > 0) return { satisfied: true, measured: true, detail: `${String(matching.length)} ${requirement.kind} rows` };
  return {
    satisfied: false,
    measured: true,
    detail: `${String(rows.length)} pack rows, none of ${requirement.kind} (${WEARABLE_ITEM_PREFIXES.join("|")})`,
  };
}

function readMoney(snapshot, requirement) {
  const money = snapshot?.money;
  if (!Number.isFinite(money)) return { satisfied: false, measured: false, detail: "money not measured" };
  return {
    satisfied: money >= requirement.atLeast,
    measured: true,
    detail: `${String(money)} of ${String(requirement.atLeast)} gold (${requirement.because})`,
  };
}

/**
 * The whole pool against ONE OPENING observation, and the line the boot prints - led by `opening_snapshot`, because that
 * is the only moment this reading speaks for.
 *
 * THREE ANSWERS PER TASK, and the difference is the difference between a world and a window: `infeasible` is a
 * requirement a WHOLE-WORLD fact refused, `undecided` is a requirement whose only witness is a family discovered within
 * thirteen tiles of her (`task_precondition_out_of_view` / `task_precondition_not_measured`), and `feasible` is both
 * halves satisfied. Only the first can fail a boot - a window's emptiness is not evidence about the farm.
 *
 * `<task>` findings are per requirement, so the reader sees WHICH half failed: `dress_and_display` names
 * `pack:wearable` or `mannequinTargets|signTargets` and never just the task.
 */
export function estimateTaskPoolAtOpening({
  snapshot,
  rotation = DAILY_TASK_ROTATION,
  signatures = TASK_PRECONDITIONS,
} = {}) {
  const startedAtMs = Date.now();
  const tasks = Array.isArray(rotation) ? rotation.filter((task) => typeof task === "string" && task.length > 0) : [];
  const findings = [];
  const rows = [];
  for (const task of tasks) {
    const signature = signatures?.[task];
    if (!Array.isArray(signature) || signature.length === 0) {
      const code = `task_precondition_undeclared:${task}`;
      findings.push(code);
      rows.push(Object.freeze({ task, verdict: "infeasible", findings: Object.freeze([code]) }));
      continue;
    }
    const codes = [];
    for (const requirement of signature) {
      const read = readRequirement(snapshot, requirement);
      if (read.satisfied === true) continue;
      const prefix =
        read.measured !== true
          ? "task_precondition_not_measured"
          : read.outOfView === true
            ? "task_precondition_out_of_view"
            : "task_precondition_unmet";
      const code = `${prefix}:${task}:${describeRequirement(requirement)}`;
      codes.push(code);
      findings.push(code);
    }
    const verdict = codes.some(
      (code) =>
        code.startsWith("task_precondition_unmet:") || code.startsWith("task_precondition_undeclared:"),
    )
      ? "infeasible"
      : codes.length > 0
        ? "undecided"
        : "feasible";
    rows.push(Object.freeze({ task, verdict, findings: Object.freeze(codes) }));
  }
  // The reverse direction: a signature for a task the pool no longer holds must not survive it.
  for (const task of Object.keys(signatures ?? {})) {
    if (tasks.includes(task)) continue;
    const code = `task_precondition_orphaned:${task}`;
    findings.push(code);
  }
  const inVerdict = (verdict) => rows.filter((row) => row.verdict === verdict).map((row) => row.task);
  const feasible = inVerdict("feasible").length;
  const infeasible = inVerdict("infeasible").length;
  const undecided = inVerdict("undecided").length;
  const blocked = readBlocked(snapshot, tasks.length, findings);
  const evaluationMs = Date.now() - startedAtMs;
  // THE MOMENT, spelled before anything else in the line: this is the reading of ONE opening snapshot, taken before a
  // model was asked anything, and every number after it is a statement about that moment only.
  const moment =
    `opening_snapshot r${Number.isInteger(snapshot?.revision) ? String(snapshot.revision) : "?"} ` +
    `${typeof snapshot?.location === "string" && snapshot.location.length > 0 ? snapshot.location : "?"}`;
  // The two readings `round96`'s two worlds differed in, printed with the population so the same pool cannot look the
  // same on a market of three stocked rows and on a market of none.
  const seedRows = Array.isArray(snapshot?.seedSupplyTargets)
    ? String(snapshot.seedSupplyTargets.length)
    : "not measured";
  const purse = Number.isFinite(snapshot?.money) ? String(snapshot.money) : "not measured";
  return Object.freeze({
    tasks: tasks.length,
    feasible,
    infeasible,
    undecided,
    readings: Object.freeze(rows),
    findings: Object.freeze(findings),
    infeasibleTasks: Object.freeze(inVerdict("infeasible")),
    undecidedTasks: Object.freeze(inVerdict("undecided")),
    // The moment, the population, the named tasks, and the seed counter's own numbers:
    // `opening_snapshot r7 Farm · tasks 22 · feasible 9 · infeasible 2 (dress_and_display, home_upgrade) · seed_market
    // rows 3 · purse 500`. A count nobody can act on is the reading this replaces; the undecided half is printed only
    // when there is one, because a window's emptiness is a reading of the gate's own reach and not of the farm.
    reading:
      `${moment}` +
      ` · tasks ${String(tasks.length)} · feasible ${String(feasible)} · infeasible ${String(infeasible)} ` +
      `(${infeasible === 0 ? "none" : inVerdict("infeasible").join(", ")})` +
      (undecided === 0 ? "" : ` · undecided ${String(undecided)} (${inVerdict("undecided").join(", ")})`) +
      ` · seed_market rows ${seedRows} · purse ${purse}`,
    blocked,
    evaluationMs,
    // The verdict code is the first DECISIVE failure - blocking first, then an unmet requirement. An out-of-view finding
    // is reported and never fails a boot: it says what the gate could not see, not what the world cannot do.
    verdictCode:
      blocked ??
      findings.find(
        (code) =>
          !code.startsWith("task_precondition_out_of_view:") && !code.startsWith("task_precondition_not_measured:"),
      ) ??
      null,
  });
}

/**
 * What makes the whole reading unusable - as opposed to a pool with an infeasible task in it.
 *
 * A zero population and an observation that never happened are refusals, not passes: "0 of 0 agreed" is the shape every
 * empty gate in this tree has been caught in.
 */
function readBlocked(snapshot, taskCount, findings) {
  if (taskCount === 0) return "task_pool_empty";
  if (!Number.isInteger(snapshot?.revision) || typeof snapshot?.location !== "string" || snapshot.location.length === 0)
    return "opening_snapshot_unmeasured";
  const orphan = findings.find((code) => code.startsWith("task_precondition_orphaned:"));
  if (orphan !== undefined) return orphan;
  return null;
}

/** One line for a boot's log, with the same numbers the payload carries. */
export function describeTaskPoolAtOpening(reading) {
  if (reading?.blocked !== null && reading?.blocked !== undefined)
    return `${reading.reading} · blocked=${reading.blocked}`;
  return reading?.reading ?? "opening_snapshot r? ? · tasks 0 · feasible 0 · infeasible 0 (none)";
}

/**
 * The day's seed counter, asked again on the world she is standing in.
 *
 * <p>
 * WHY A SECOND READING EXISTS AT ALL. The opening estimate reads ONE snapshot and answers for it, and a day does not open
 * on that snapshot: `round96` read three stocked rows and 500g at launch, and on day 2 the same family published zero
 * rows with the purse at 1060 - a Pierre's carrying the desert festival's stalls, no parsnip seed, twenty tilled tiles and
 * nothing sown. `seedSupplyTargets` is the Mod's answer to "where is a seed she holds sold today", so it is knowable
 * again every time it is refreshed: the day can be re-checked at the minute the market changes instead of at dusk.
 * </p>
 *
 * <p>
 * THE SAME READER, A DIFFERENT MOMENT. This calls `readSeedMarket` - the reader the opening gate calls - so the two
 * answers cannot disagree about a shape, only about a world. `rowsAtOpen` is the population the day opened on: it makes
 * "the market moved" a different fact from "the market is what it was", and both different from "the market says she
 * cannot hold this day".
 * </p>
 *
 * <p>
 * ONE REQUIREMENT, BY NAME, AND NOT THE WHOLE SIGNATURE. `soil_ground` INVERTS as a day works it (a strip the Hoe has
 * turned is the day succeeding, not its premise breaking) and `money` is spent by the day on purpose, so re-reading a
 * whole signature would refuse a day for doing its own work. A second requirement earns its own re-ask with its own
 * measured incident; until then this one is read by name.
 * </p>
 *
 * <p>
 * `key` is the STATE the reading found (`broken:0`, `holds:3`), so a caller publishes once per state rather than once per
 * poll: the market that answers "no seed" at 09:00 and at 14:00 is one market, and a line per poll would be a clock
 * wearing a fact's name. `code` carries the minute it was read, because the incident is the moment the day learned.
 * </p>
 */
export function rereadDaySeedMarket({
  taskId,
  snapshot,
  gameMinutes = null,
  rowsAtOpen = null,
  signatures = TASK_PRECONDITIONS,
} = {}) {
  const signature = signatures?.[taskId];
  const declared = Array.isArray(signature) ? signature.some((requirement) => requirement?.fact === "seed_market") : false;
  // A day whose declared world holds no seed counter has nothing to re-ask, and asking anyway would publish a fact about a
  // task nobody was given.
  if (!declared) return null;
  const rows = Array.isArray(snapshot?.seedSupplyTargets) ? snapshot.seedSupplyTargets.length : null;
  const minutes = Number.isInteger(gameMinutes) ? gameMinutes : null;
  const at = Number.isInteger(rowsAtOpen) ? rowsAtOpen : null;
  const read = readSeedMarket(snapshot);
  const measured = read.measured === true;
  const broken = measured && read.satisfied !== true;
  const minute = minutes === null ? "unknown" : String(minutes);
  // An unmeasured family is not an answer: `task_precondition_not_measured` already owns that state at the opening, and a
  // re-ask that spoke here would turn "nothing looked" into "the seed is not in town".
  const code = !measured
    ? null
    : broken
      ? `task_precondition_broken_at:${minute}:seed_market:${String(rows)}`
      : at !== null && rows !== null && at !== rows
        ? `seed_market_changed:${minute}:${String(at)}->${String(rows)}`
        : null;
  return Object.freeze({
    task: taskId,
    gameMinutes: minutes,
    rows,
    rowsAtOpen: at,
    measured,
    broken,
    detail: read.detail,
    key: `${broken ? "broken" : "holds"}:${rows === null ? "not_measured" : String(rows)}`,
    code,
  });
}

async function main(argv) {
  const configArg = valueOf(argv, "--client-config");
  const snapshotArg = valueOf(argv, "--snapshot");
  const budgetMs = numberValue(argv, "--budget-ms", TASK_POOL_BUDGET_MS);
  if ((configArg === undefined) === (snapshotArg === undefined)) {
    process.stderr.write(
      "usage: task-pool-feasibility.mjs --client-config <path>\n" +
        "       task-pool-feasibility.mjs --snapshot <recorded-snapshot.json>\n" +
        "       [--budget-ms <n>]\n",
    );
    process.exitCode = 2;
    return;
  }
  let snapshot = null;
  let observeMs = 0;
  if (snapshotArg !== undefined) {
    snapshot = JSON.parse(await readFile(snapshotArg, "utf8"));
  } else {
    const startedAtMs = Date.now();
    const config = await readNativeClientConfig(["--client-config", configArg]);
    const session = await withBudget(connectNativeLocalClient(config), budgetMs, "task_pool_connect_over_budget");
    try {
      snapshot = await withBudget(session.client.observe(), budgetMs, "task_pool_snapshot_over_budget");
    } finally {
      await session.close();
    }
    observeMs = Date.now() - startedAtMs;
  }
  const reading = estimateTaskPoolAtOpening({ snapshot });
  const payload = {
    tasks: reading.tasks,
    feasible: reading.feasible,
    infeasible: reading.infeasible,
    undecided: reading.undecided,
    infeasibleTasks: reading.infeasibleTasks,
    undecidedTasks: reading.undecidedTasks,
    findings: reading.findings,
    blocked: reading.blocked,
    verdictCode: reading.verdictCode,
    reading: reading.reading,
    report: `task_pool_feasibility · ${describeTaskPoolAtOpening(reading)}`,
    evaluationMs: reading.evaluationMs,
    observeMs,
    budgetMs,
    snapshot: summarizeSnapshot(snapshot),
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (reading.blocked !== null) process.exitCode = 2;
  else if (reading.infeasible > 0) process.exitCode = 1;
}

function valueOf(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 || index + 1 >= argv.length ? undefined : argv[index + 1];
}

function numberValue(argv, name, fallback) {
  const raw = valueOf(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid_task_pool_argument:${name.slice(2)}`);
  return value;
}

/** The budget, as a refusal the caller can name instead of a command that outlasts its rung. */
function withBudget(promise, budgetMs, code) {
  let timer;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(code)), budgetMs);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
