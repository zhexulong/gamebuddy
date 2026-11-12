/**
 * 游戏动作的性能标准：一个"原生玩家"做完同样的活要花多久，以及我们花了多久。
 *
 * WHY THIS EXISTS. "A native player does actions much faster than we do" was an
 * observation nobody could check: the repository priced Host code in benchmark
 * processes (`tools/perf/*.bench.mjs`) and summed a whole run's native time
 * (`tools/live-run/round-verdict.mjs` -> `floor_native`), but nothing compared ONE
 * action's game-side cost against what the ENGINE itself forces a player to spend on
 * it. Without that number, "slow" and "the animation is slow" are the same word.
 *
 * TWO THINGS ARE UNIFIED HERE:
 *
 *   1. the LIVE-RUN NATIVE PACE - the game-side milliseconds one action takes, taken
 *      from the stamps the artifacts already carry (see `GAME_SIDE_INTERVAL` below),
 *      and
 *   2. an ACTION-LEVEL FLOOR - `nativeFloorMs`, built from constants that each carry
 *      the `ref/**` line they come from.
 *
 * Their ratio is the verdict. A ratio at or below 1 means the engine's own animation
 * (or the walk) dominates and no optimisation is owed; a ratio above it means our own
 * serialisation is visible, and that half is the actionable one.
 *
 * THE GAME-SIDE INTERVAL IS EXCLUDED BY CONSTRUCTION, NEVER BY SUBTRACTION.
 * `GAME_SIDE_INTERVAL` names the exact stamps. No channel contains prompt
 * assembly, provider latency or the agent's think time, because the agent's turn ends
 * before the dispatch stamp and starts after the settle stamp - there is no latency
 * left to subtract, and none is ever subtracted. `thinkMs`
 * (`tools/lib/action-cadence.mjs`) is the other half of the wall clock and is a
 * different statistic on a different pair of stamps.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not price actions for which the engine
 * declares no animation constant: menus, warps, the day rollover, fishing. Those are
 * reported as `unpriced` with the reason, because an invented constant is worse than a
 * named gap - and this repository has an invented-gates ledger to prove it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { readStardewActionFamilies } from "./stardew-published-action-registry.mjs";

/**
 * The two timestamps that bound the game-side interval, named once so no reader has
 * to reconstruct which wall clock a number belongs to.
 *
 * `flat`: `actionTrace.jsonl`, written by
 *   `tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs:3811` (dispatch,
 *   stamped immediately BEFORE the bridge call) and `:3835` (settle, stamped
 *   immediately AFTER the receipt returns). Contains the pipe round trip and the
 *   Mod's game-thread work; contains no model step.
 * `program`: `result.json` -> `programOutcomes[].executions[]`, the Mod's own
 *   monotonic `atMs`/`settledAtMs` (`tools/live-run/game/execution-trace.mjs:44`).
 *   Contains the Mod's work only. The action id is not on the row: it is joined from
 *   `programOutcomes[].nodeOutcomes[].actionId` by `nodeId`.
 *
 * `receipts`: `timeline.jsonl`, the Mod's own receipt chain for one execution - the
 *   first event it wrote for it, and the terminal receipt that closed it. It is the
 *   ONLY channel that records the route: one `tile_advanced` receipt per tile the
 *   actor walked, inside the same chain as the duration. It is therefore the only
 *   channel on which `nativeFloorMs` can be given the distance, and the one the
 *   verdict reads.
 *
 * THE CHANNELS ARE DIFFERENT CLOCKS and are never mixed in one statistic. `program`
 * brackets the Mod's durable journal writes; `receipts` brackets the action itself;
 * `flat` brackets the pipe round trip. Each row prints every channel it has, and
 * reads one of them: `CHANNEL_PREFERENCE`, deepest decomposition first.
 *
 * WHY THE WALK HAD TO BECOME A CHANNEL. An action that walks to its target first
 * (`Approach = self_walked` in the Mod's catalogue) performs that walk INSIDE the
 * interval every channel measures, so a floor of one swing accused `harvest_crop` of
 * 135x the engine at a p50 of 2257 ms - which is 10 tiles of walking at the rate the
 * route receipts record. `program` and `flat` cannot see the distance and charge zero;
 * `receipts` counts the tiles, so the floor can charge them.
 */
export const GAME_SIDE_INTERVAL = Object.freeze({
  receipts: Object.freeze({
    start: "timeline[].atMs of the execution's first receipt",
    end: "timeline[].atMs of the execution's terminal receipt",
    distance: "timeline[].reasonCode === 'tile_advanced' receipts: one per tile walked",
  }),
  flat: Object.freeze({ start: "actionTrace[].dispatchedAtMs", end: "actionTrace[].settledAtMs" }),
  program: Object.freeze({
    start: "result.programOutcomes[].executions[].atMs",
    end: "result.programOutcomes[].executions[].settledAtMs",
    actionId: "result.programOutcomes[].nodeOutcomes[].actionId, joined by nodeId",
  }),
});

/**
 * Which channel a row's verdict reads, deepest decomposition first: the receipt chain
 * (duration AND distance from one execution), then the Mod's journal span, then the
 * pipe round trip. An action is read from the first channel that measured it, so no
 * action leaves the population because one artifact is absent from its bundle.
 */
export const CHANNEL_PREFERENCE = Object.freeze(["receipts", "program", "flat"]);

/**
 * One engine constant, with the line it comes from.
 *
 * `source` is `{ file, line, quote }` when the number is read off the decompiled tree,
 * or `{ invented: reason }` when it is not - and a constant with neither is refused at
 * load time by `assertDeclaredConstants`. That assertion is the whole reason this shape
 * exists: a constant whose provenance nobody wrote down is the one thing this module
 * must never contain.
 */
const DECOMPILED = "ref/external/StardewValleyDecompiled/Stardew Valley";
const engine = (file, line, quote) => Object.freeze({ file, line, quote });

/** One tile, in pixels: `Game1.cs:103`. */
const TILE_PX = Object.freeze({
  value: 64,
  source: engine(`${DECOMPILED}/StardewValley/Game1.cs`, 103, "public const int tileSize = 64;"),
});

/** The native update loop's tick: the Mod states the FPS and converts ticks to ms by 60. */
export const TICK_MS = Object.freeze({
  value: 1000 / 60,
  source: engine("integrations/stardew/StardewBodyController.cs", 65, "Stardew's native update loop is 60 FPS"),
});

/** The same 60, as the Mod's own tick-to-millisecond conversion. */
const TICK_TO_MS_DIVISOR = Object.freeze({
  value: 60,
  source: engine(
    "integrations/stardew/farmhandexecutioncontroller.movementactions.cs",
    88,
    "requestedDeadlineMs ?? nowMs + DefaultDeadlineTicks * 1000L / 60L",
  ),
});

/**
 * The quantum of every stamp this module subtracts.
 *
 * `dispatchedAtMs` is `Date.now()` (`run-stardew-native-local-agent-ab-live.mjs:3811`)
 * and the receipt chain's `atMs` is the same clock, so a duration is a whole number of
 * milliseconds and an action that finishes inside one stamp reads 0. A RATCHET CANNOT
 * BE TIGHTER THAN THE CHANNEL'S OWN QUANTUM: a 0 ms p50 records a ratio of 0, and
 * 0 x (1 + tolerance) bounds nothing - the next run's 1 ms reading would be a
 * regression the code did not commit.
 */
const PACE_RESOLUTION_MS = Object.freeze({
  value: 1,
  source: engine(
    "tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs",
    3811,
    "const dispatchedAtMs = Date.now();",
  ),
});

/**
 * `Game1.currentGameTime.ElapsedGameTime.Milliseconds` as `Farmer.getMovementSpeed()`
 * reads it: `1/60 s` is 16.666… ms and `TimeSpan.Milliseconds` is the integer
 * millisecond component, so the walk arithmetic sees 16.
 *
 * THE ONE STEP HERE THAT IS A FRAMEWORK FACT RATHER THAN A STARDEW CONSTANT, and it is
 * declared as such rather than hidden inside the walk constant. Using the untruncated
 * 16.667 would put the walk at 485 ms/tile instead of 505 - a 4% shift that changes no
 * ordering and no verdict, because the gate is a ratchet on measured ratios.
 */
const ELAPSED_MS_PER_TICK = Object.freeze({
  value: 16,
  source: Object.freeze({
    file: "System.TimeSpan.Milliseconds",
    line: null,
    quote: "the integer millisecond component of 1/60 s = 16.666… ms",
  }),
});

/** Walking `base.speed`, and the multiplier `getMovementSpeed()` applies: `Farmer.cs`. */
const WALK_SPEED = Object.freeze({
  value: 2,
  source: engine(`${DECOMPILED}/StardewValley/Farmer.cs`, 2701, "base.speed = ((…runButton…) ? 5 : 2);"),
});

const MOVEMENT_MULTIPLIER = Object.freeze({
  value: 0.066,
  source: engine(`${DECOMPILED}/StardewValley/Farmer.cs`, 8071, "movementMultiplier = 0.066f;"),
});

/**
 * The animation classes the engine gates an action's cycle on, and what each costs.
 *
 * These are the branches of `Tool.endUsing`, not free choices:
 *  - `toolSwing`     `Tool.cs:610-620` - `animateOnce(160|168|176|184, 60f * num, 8)`,
 *                    with `num = 1` while the farmer has stamina (`Tool.cs:571`); so
 *                    8 frames x 60 ms = 480 ms. Hoe, axe, pickaxe, scythe, and any
 *                    generic active tool all land in this branch.
 *  - `wateringCanSwing` `Tool.cs:585-596` - `animateOnce(164|172|180|188, 125f * num, 3)`;
 *                    3 frames x 125 ms = 375 ms.
 *  - `hand`          no animation branch at all, so the engine's minimum for an
 *                    interaction is one tick: `Tool.beginUsing`'s `instantUse` path
 *                    (`Tool.cs:638-644`) applies the tool and clears `UsingTool` inside
 *                    the same call.
 *  - `walk`          no animation; the whole cost is the walk.
 *  - `unpriced`      the engine declares no constant for this work (a menu, a warp, the
 *                    day rollover, fishing). `null`, never a guessed number.
 */
export const ANIMATION_CLASS = Object.freeze({
  toolSwing: 480,
  wateringCanSwing: 375,
  hand: TICK_MS.value,
  walk: 0,
  unpriced: null,
});

/** How long one tile of walking takes at `Farmer.getMovementSpeed()`, in ms. */
export const WALK_MS_PER_TILE =
  (TILE_PX.value / (WALK_SPEED.value * MOVEMENT_MULTIPLIER.value * ELAPSED_MS_PER_TICK.value)) * TICK_MS.value;

/**
 * Every declared constant above, so `assertDeclaredConstants` can refuse one whose
 * provenance nobody wrote down.
 */
export const DECLARED_CONSTANTS = Object.freeze({
  TILE_PX,
  TICK_MS,
  TICK_TO_MS_DIVISOR,
  PACE_RESOLUTION_MS,
  ELAPSED_MS_PER_TICK,
  WALK_SPEED,
  MOVEMENT_MULTIPLIER,
});

/**
 * Refuses a declared constant that carries neither an engine citation nor an explicit
 * `invented` flag, and names it. Throws rather than warns: a standard built on a
 * constant nobody can point at is worse than no standard.
 */
export function assertDeclaredConstants(constants = DECLARED_CONSTANTS) {
  for (const [name, declared] of Object.entries(constants)) {
    const source = declared?.source;
    const cited = typeof source?.file === "string" && source.file.length > 0;
    const invented = typeof source?.invented === "string" && source.invented.length > 0;
    if (!(cited || invented)) throw new Error(`action_pace_constant_unsourced:${name}`);
    if (cited && typeof declared.value !== "number") throw new Error(`action_pace_constant_not_a_number:${name}`);
    if (invented) throw new Error(`action_pace_constant_invented:${name}:${source.invented}`);
  }
  return Object.keys(constants).length;
}

/**
 * The animation class each catalogue action is gated by, for the actions that are NOT
 * the `hand` default.
 *
 * The POPULATION is the Mod's own action catalogue
 * (`FarmhandActionDefinitions.cs` -> `readStardewActionFamilies`), not this table: the
 * gate asserts that every catalogue action resolves to a class, that no id here has
 * left the catalogue, and that every trace id the bundles contain is either a
 * catalogue action or declared under `TRACE_ONLY_ACTIONS`. So this table can only be
 * an exception list - adding a catalogue action makes the gate name it until it is
 * classified, which is the point.
 *
 * The class is WHICH ENGINE BRANCH the action's work runs through, which is domain
 * knowledge the Mod's own handlers already encode:
 * `tools/check-stardew-tool-family-stamina-evidence.mjs` names the native tool each
 * tool-family handler drives (`RequestLocalTillSoil` -> hoe, `RequestLocalWaterCrop` ->
 * wateringCan, `RequestLocalCutWeeds` -> scythe, …) and records that `harvest_crop` is
 * a hand pick with no tool involved.
 */
const ACTION_ANIMATION_CLASS = Object.freeze({
  toolSwing: Object.freeze([
    "till_soil",
    "clear_hoedirt",
    "dig_artifact_spot",
    "chop_tree",
    "chop_stump",
    "break_rock",
    "break_container",
    "break_resource_clump",
    "remove_placed_item",
    "clear_debris",
    "cut_weeds",
    "cut_grass",
    "scythe_crop",
    "collect_animal_product",
  ]),
  wateringCanSwing: Object.freeze(["water_crop", "refill_watering_can", "water_pet_bowl", "water_slime_hutch_trough"]),
  walk: Object.freeze(["move_to_tile"]),
  unpriced: Object.freeze([
    // Menus and modal interactions: the engine has no per-interaction animation constant.
    "respond_level_up",
    "dismiss_modal",
    "answer_dialogue",
    "shop_purchase",
    "open_geode",
    // Warps and transit: the cost is a fade or a ride, not a swing or a walk.
    "enter_exit",
    "travel",
    "navigate_to_destination",
    "enter_mine",
    "use_mine_ladder",
    "select_mine_elevator_floor",
    "ride_minecart",
    "ride_bus",
    "use_obelisk",
    "use_raft",
    "mount_transport",
    "dismount_transport",
    "use_warp_item",
    // The day boundary, and work whose engine cost is a timer rather than an animation.
    "sleep",
    "fish_here",
    "build_farm_building",
    "ship_item",
    "craft_item",
    "cook_recipe",
    "use_item",
  ]),
});

/**
 * Trace ids the bundles carry that are NOT catalogue actions, each with the reason and
 * the work it stands for.
 *
 * The trace's vocabulary is the runner's and the catalogue reader's, and several of its
 * names are not the Mod's: a new one appearing is a fact a reader must see rather than a
 * row that silently vanishes from the population.
 */
export const TRACE_ONLY_ACTIONS = Object.freeze({
  break_rock_source: Object.freeze({
    reason: "the flat channel's name for the native work `break_rock` performs",
    class: "toolSwing",
  }),
  chop_tree_source: Object.freeze({
    reason: "the axe swing at a standing tree; the catalogue reader lists no family for it",
    class: "toolSwing",
  }),
  advance_day: Object.freeze({
    reason: "the runner advances the clock between days; no Mod action performs it",
    class: "unpriced",
  }),
  for_each: Object.freeze({
    reason: "a program construct, not an action: it owns no native work of its own",
    class: "unpriced",
  }),
});

/** The catalogue's classes, read once: the file is on disk and does not change under a run. */
let cachedClasses = null;

function defaultClasses() {
  cachedClasses ??= actionAnimationClasses();
  return cachedClasses;
}

/**
 * Every catalogue action's animation class, keyed by action id.
 *
 * ONE SPELLING OF THE MAPPING: the exception lists above are folded into this map here
 * and nowhere else, so a reader cannot be looking at a different table than the gate.
 */
export function actionAnimationClasses({
  families = readStardewActionFamilies(),
  exceptions = ACTION_ANIMATION_CLASS,
  traceOnly = TRACE_ONLY_ACTIONS,
} = {}) {
  const classes = new Map();
  for (const actionId of families.keys()) classes.set(actionId, "hand");
  const claimed = new Map();
  for (const [className, actionIds] of Object.entries(exceptions)) {
    if (!(className in ANIMATION_CLASS)) throw new Error(`action_pace_unknown_animation_class:${className}`);
    for (const actionId of actionIds) {
      if (!families.has(actionId)) throw new Error(`action_pace_classifies_unknown_action:${className}:${actionId}`);
      if (claimed.has(actionId))
        throw new Error(`action_pace_action_in_two_classes:${actionId}:${claimed.get(actionId)}:${className}`);
      claimed.set(actionId, className);
      classes.set(actionId, className);
    }
  }
  for (const [actionId, declared] of Object.entries(traceOnly)) {
    if (families.has(actionId)) throw new Error(`action_pace_trace_only_shadows_catalogue:${actionId}`);
    classes.set(actionId, declared.class);
  }
  return classes;
}

/** The class of one action id, or `null` for an id nobody has classified. */
export function animationClassOf(actionId, classes = defaultClasses()) {
  return classes.get(actionId) ?? null;
}

/**
 * What a native player needs for the same work, in milliseconds.
 *
 *   nativeFloorMs = swingMs(action) * tiles + distance * WALK_MS_PER_TILE
 *
 * `tiles`   the tiles of work the action performs; one tile of work is one swing, which
 *           is how the engine's own tool cycle is built (`Tool.endUsing` animates one
 *           tile's worth of swing).
 * `distance` the tiles walked, which the CALLER supplies and which defaults to 0 — the
 *           strict LOWER bound. `distance` is charged only when the artifact RECORDED
 *           it: `receipts` counts the `tile_advanced` receipts of the same execution
 *           that produced the duration, and the other two channels sit outside the walk
 *           and so charge nothing. Zero here is "this channel cannot see a walk", never
 *           a guess about one.
 *
 * Returns `null` when the engine declares no constant for the action's work. `null` is
 * "not measured", never zero, and the caller must report it as such.
 */
export function nativeFloorMs({ action, tiles = 1, distance = 0, classes = defaultClasses() } = {}) {
  const className = animationClassOf(action, classes);
  if (className === null) throw new Error(`action_pace_unclassified_action:${String(action)}`);
  const swingMs = ANIMATION_CLASS[className];
  if (swingMs === null) return null;
  const walked = className === "walk" ? Math.max(distance, tiles) : distance;
  return swingMs * tiles + walked * WALK_MS_PER_TILE;
}

/** Nearest-rank percentile of an unsorted list; `null` for an empty one (an unknown percentile is not zero). */
export function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[rank];
}

const round = (value) => (value === null ? null : Math.round(value * 100) / 100);

/** One bundle root's `actionTrace.jsonl`, `timeline.jsonl` and `result.json` files. */
function bundleFiles(root) {
  const actionTrace = [];
  const timelines = [];
  const results = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "actionTrace.jsonl") actionTrace.push(path);
      else if (entry.name === "timeline.jsonl") timelines.push(path);
      else if (entry.name === "result.json") results.push(path);
    }
  };
  walk(root);
  return { actionTrace, timelines, results };
}

/** The rows one `actionTrace.jsonl` contributes: the FLAT channel, on the Host's clock. */
function flatRows(path) {
  const rows = [];
  let rejected = 0;
  let unattributed = 0;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry?.dispatchedAtMs !== "number" || typeof entry?.settledAtMs !== "number") continue;
    if (typeof entry.action !== "string") continue;
    if (entry.state === "rejected") {
      // A refusal closes a wait, not a piece of work: it is counted, never averaged in.
      rejected += 1;
      continue;
    }
    if (entry.state === "accepted") {
      // `accepted` is the Mod SAYING THE WORK CONTINUES: the row closes the dispatch
      // handshake, and the walk or the use happens after it. Reading it as a duration
      // made `move_to_tile` 25 ms and `break_rock_source` 35 ms - a pipe round trip
      // priced as a swing. An open wait is not a duration, so it is counted apart.
      unattributed += 1;
      continue;
    }
    rows.push({ action: entry.action, ms: entry.settledAtMs - entry.dispatchedAtMs });
  }
  return { rows, rejected, unattributed };
}

/** The rows one `result.json` contributes: the PROGRAM channel, on the Mod's clock. */
function programRows(path) {
  let result;
  try {
    result = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { rows: [], rejected: 0, unattributed: 0 };
  }
  const rows = [];
  let rejected = 0;
  let unattributed = 0;
  for (const program of Array.isArray(result?.programOutcomes) ? result.programOutcomes : []) {
    const byNode = new Map((program?.nodeOutcomes ?? []).map((node) => [node?.nodeId, node]));
    for (const execution of program?.executions ?? []) {
      if (typeof execution?.atMs !== "number" || typeof execution?.settledAtMs !== "number") continue;
      const node = byNode.get(execution.nodeId);
      if (node?.state === "rejected" || node?.state === "failed") {
        rejected += 1;
        continue;
      }
      if (typeof node?.actionId !== "string") {
        unattributed += 1;
        continue;
      }
      rows.push({ action: node.actionId, ms: execution.settledAtMs - execution.atMs });
    }
  }
  return { rows, rejected, unattributed };
}

/** The states a receipt can close on: a terminal is a closed execution, and an unfinished one is not a duration. */
const TERMINAL_RECEIPT_STATES = Object.freeze(new Set(["succeeded", "failed", "rejected", "uncertain"]));

/** A refusal closes a wait rather than a piece of work, exactly as on the other two channels. */
const REFUSED_RECEIPT_STATES = Object.freeze(new Set(["failed", "rejected"]));

/**
 * The rows one `timeline.jsonl` contributes: the RECEIPTS channel, the only one that
 * records the walk beside the duration.
 *
 * One row per execution the timeline closed. The duration is the same execution's first
 * stamp to its terminal receipt, and `tiles` is how many `tile_advanced` receipts that
 * same execution filed in between - the Mod emits one per tile the actor crossed, so the
 * distance is counted from the record rather than inferred from the geometry.
 *
 * An execution with no terminal receipt is not a duration, so it is `unattributed`
 * rather than zero - the same distinction the other channels draw for a row they cannot
 * attribute.
 */
function receiptRows(path) {
  const byExecution = new Map();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry?.atMs !== "number") continue;
    const payload = entry?.worldFactPayload;
    const executionId =
      typeof entry?.executionId === "string"
        ? entry.executionId
        : typeof payload?.executionId === "string"
          ? payload.executionId
          : typeof payload?.bodyTrace?.executionId === "string"
            ? payload.bodyTrace.executionId
            : null;
    if (executionId === null) continue;
    const chain = byExecution.get(executionId);
    if (chain === undefined) byExecution.set(executionId, [entry]);
    else chain.push(entry);
  }
  const rows = [];
  let rejected = 0;
  let unattributed = 0;
  for (const chain of byExecution.values()) {
    chain.sort((left, right) => left.atMs - right.atMs);
    let terminal;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const entry = chain[index];
      if (entry?.type !== "execution_receipt") continue;
      if (!TERMINAL_RECEIPT_STATES.has(entry?.worldFactPayload?.state)) continue;
      terminal = entry;
      break;
    }
    if (terminal === undefined) {
      unattributed += 1;
      continue;
    }
    if (REFUSED_RECEIPT_STATES.has(terminal.worldFactPayload?.state)) {
      rejected += 1;
      continue;
    }
    const action = terminal.worldFactPayload?.actionId;
    if (typeof action !== "string") {
      unattributed += 1;
      continue;
    }
    const tiles = chain.filter((entry) => entry?.reasonCode === "tile_advanced" && entry.atMs <= terminal.atMs).length;
    rows.push({ action, ms: terminal.atMs - chain[0].atMs, tiles });
  }
  return { rows, rejected, unattributed };
}

/**
 * Measures every action the bundles carry, one row per action.
 *
 * SHAPE OF ONE ROW: the action's class, the walk the verdict's channel recorded for it,
 * the floor `nativeFloorMs` gives for the same unit of work (one swing plus that walk),
 * the p50/p95 the artifacts recorded on each channel, the channel the verdict reads
 * (`CHANNEL_PREFERENCE`), and the ratio between them.
 */
export function measureActionPace({ bundleRoot, classes = defaultClasses() } = {}) {
  const root = resolve(bundleRoot ?? "");
  if (!existsSync(root)) {
    return Object.freeze({
      bundleRoot: root,
      status: "no_bundle_root",
      actionTraceFiles: 0,
      timelineFiles: 0,
      resultFiles: 0,
      timedInstances: 0,
      examinedInstances: 0,
      rows: [],
    });
  }
  const files = bundleFiles(root);
  const byChannel = new Map();
  let rejectedInstances = 0;
  let unattributedInstances = 0;
  const record = (channel, rows) => {
    for (const row of rows) {
      const key = `${channel}:${row.action}`;
      if (!byChannel.has(key)) byChannel.set(key, { channel, action: row.action, instances: [] });
      byChannel.get(key).instances.push({ ms: row.ms, tiles: row.tiles ?? 0 });
    }
  };
  for (const path of files.timelines) {
    const { rows, rejected, unattributed } = receiptRows(path);
    rejectedInstances += rejected;
    unattributedInstances += unattributed;
    record("receipts", rows);
  }
  for (const path of files.actionTrace) {
    const { rows, rejected, unattributed } = flatRows(path);
    rejectedInstances += rejected;
    unattributedInstances += unattributed;
    record("flat", rows);
  }
  for (const path of files.results) {
    const { rows, rejected, unattributed } = programRows(path);
    rejectedInstances += rejected;
    unattributedInstances += unattributed;
    record("program", rows);
  }

  const byAction = new Map();
  for (const entry of byChannel.values()) {
    if (!byAction.has(entry.action)) byAction.set(entry.action, []);
    byAction.get(entry.action).push(entry);
  }
  const rows = [];
  for (const [action, channels] of [...byAction.entries()].sort((left, right) =>
    left[0].localeCompare(right[0], "en"),
  )) {
    const chosen =
      CHANNEL_PREFERENCE.map((channel) => channels.find((entry) => entry.channel === channel)).find(
        (entry) => entry !== undefined,
      ) ?? channels[0];
    const className = animationClassOf(action, classes);
    // The walk the artifacts recorded for the instances this row reads, and the floor that
    // pays for it. A channel that cannot see the walk contributes zero, which is a stated
    // lower bound rather than a guess about one.
    const durations = chosen.instances.map((instance) => instance.ms);
    const walkTiles = round(
      percentile(
        chosen.instances.map((instance) => instance.tiles),
        0.5,
      ),
    );
    const floorMs = className === null ? null : nativeFloorMs({ action, tiles: 1, distance: walkTiles, classes });
    rows.push(
      Object.freeze({
        action,
        animationClass: className,
        channel: chosen.channel,
        instances: durations.length,
        oursMs: round(percentile(durations, 0.5)),
        oursP95Ms: round(percentile(durations, 0.95)),
        walkTiles,
        floorMs: round(floorMs),
        ratio: floorMs === null || floorMs === 0 ? null : round(percentile(durations, 0.5) / floorMs),
        channels: Object.freeze(
          channels
            .slice()
            .sort((left, right) => left.channel.localeCompare(right.channel, "en"))
            .map((entry) =>
              Object.freeze({
                channel: entry.channel,
                instances: entry.instances.length,
                p50: round(
                  percentile(
                    entry.instances.map((instance) => instance.ms),
                    0.5,
                  ),
                ),
                p95: round(
                  percentile(
                    entry.instances.map((instance) => instance.ms),
                    0.95,
                  ),
                ),
              }),
            ),
        ),
      }),
    );
  }
  const timedInstances = [...byChannel.values()].reduce((total, entry) => total + entry.instances.length, 0);
  // The instances the VERDICT reads: one channel per action, so an action timed on several channels
  // is counted once. `timedInstances` above is everything the artifacts hold, all channels together.
  const examinedInstances = rows.reduce((total, row) => total + row.instances, 0);
  return Object.freeze({
    bundleRoot: root,
    status: examinedInstances === 0 ? "no_durations" : "measured",
    actionTraceFiles: files.actionTrace.length,
    timelineFiles: files.timelines.length,
    resultFiles: files.results.length,
    timedInstances,
    examinedInstances,
    rejectedInstances,
    unattributedInstances,
    rows: Object.freeze(rows),
  });
}

/**
 * The line a reader compares across actions: what we spent, what the engine demands, and
 * the ratio.
 *
 * The walk is named on the line whenever the row's channel recorded one, because it is
 * the whole difference between the two shapes of the same number: `harvest_crop` read
 * 2257 ms against a one-swing floor of 16.67 ms (135x) until the ten tiles it walked
 * were on the floor, and the same reading then says 0.44.
 */
export function paceLine(row) {
  if (row.floorMs === null)
    return `action_pace_unpriced: ${row.action} (${row.animationClass}) tiles 1 · ours p50 ${row.oursMs}ms p95 ${row.oursP95Ms}ms · no engine constant exists for this work`;
  const walked = row.walkTiles > 0 ? ` + walk ${row.walkTiles} tiles` : "";
  return (
    `action_pace: ${row.action} · tiles 1${walked} · ours p50 ${row.oursMs}ms p95 ${row.oursP95Ms}ms · ` +
    `floor ${row.floorMs}ms (${row.animationClass}, n=${row.instances} on ${row.channel}) · ratio ${row.ratio}`
  );
}

/** How much worse an action's ratio may read than the one recorded, before it is a regression. */
export const ACTION_PACE_TOLERANCE = 0.5;

/** The baseline's per-action bound: the recorded ratio, one measurement quantum, and the tolerance. */
export function paceBound(recorded, tolerance = ACTION_PACE_TOLERANCE) {
  // An entry recorded without a floor predates the walk term; it carries no quantum to
  // add and its own ratio is the bound, exactly as before.
  const quantum =
    typeof recorded.floorMs === "number" && recorded.floorMs > 0 ? PACE_RESOLUTION_MS.value / recorded.floorMs : 0;
  return (recorded.ratio + quantum) * (1 + tolerance);
}

/**
 * The verdict on a measurement, against the ratios recorded in the baseline.
 *
 * THE BOUND IS A RATCHET, and the module says so out loud: today's ratio is what the
 * tree actually achieves, so the baseline records it and the gate asks "did this action
 * get slower than it was". Asserting 1.0 here would turn the tree red for weeks and
 * teach everyone to re-record - which is exactly how `tools/perf/baseline.json` spent
 * four commits catching nothing (`tools/check-perf-scaling.mjs` header).
 *
 * FOUR THINGS ARE FAILURES, because silence is how a gate stops working:
 *  - `above`       a priced action's ratio outgrew its bound;
 *  - `unrecorded`  a priced action has no baseline entry, so nothing bounds it;
 *  - `missing`     a baseline entry no longer has a measurement;
 *  - `unknown`     a trace action nobody classified - a new id must not drop out of the
 *                  population by existing.
 *
 * `unpriced` is NOT a failure: the engine declares no constant for that work, and a
 * guessed number would be worse than the gap. It is printed and counted on every run so
 * the gap stays visible instead of looking like a pass.
 */
export function compareActionPace({ measurement, baseline, tolerance = ACTION_PACE_TOLERANCE }) {
  const recorded = baseline?.actions ?? {};
  const above = [];
  const unrecorded = [];
  const unknown = [];
  const unpriced = [];
  const priced = [];
  const measured = new Set();
  for (const row of measurement.rows) {
    measured.add(row.action);
    if (row.animationClass === null) {
      unknown.push(row);
      continue;
    }
    if (row.floorMs === null) {
      unpriced.push(row);
      continue;
    }
    priced.push(row);
    const entry = recorded[row.action];
    if (entry === undefined) {
      unrecorded.push(row);
      continue;
    }
    const bound = paceBound(entry, tolerance);
    if (row.ratio > bound) above.push({ row, entry, bound });
  }
  const missing = Object.keys(recorded).filter((action) => !measured.has(action));
  return Object.freeze({
    examined: measurement.examinedInstances,
    priced: priced.length,
    above,
    unrecorded,
    missing,
    unknown,
    unpriced,
  });
}

/** What `--record-action-pace` writes: the priced actions' ratios, and the population they came from. */
export function actionPaceRecord({ measurement, tolerance = ACTION_PACE_TOLERANCE }) {
  const actions = {};
  for (const row of measurement.rows) {
    if (row.floorMs === null) continue;
    actions[row.action] = {
      ratio: row.ratio,
      oursMs: row.oursMs,
      floorMs: row.floorMs,
      walkTiles: row.walkTiles,
      instances: row.instances,
    };
  }
  return {
    note:
      "Per-action pace ratios recorded from the game-side durations in this checkout's own .live-runs bundles. " +
      "The ratio is the action's measured p50 game-side milliseconds over the engine floor tools/lib/action-pace.mjs " +
      "derives from the decompiled tree: ONE SWING OF THE ACTION'S OWN ANIMATION, PLUS THE WALK THE ARTIFACT RECORDED " +
      "FOR THAT ACTION (walkTiles x WALK_MS_PER_TILE, the route receipts of the same execution that produced the " +
      "duration). Walk-dominated actions therefore read as engine-dominated rather than as slowness: harvest_crop " +
      "recorded 10 tiles of walking inside its 2257 ms p50, so its floor is 16.67 + 10 x 505.05 = 5067 ms and its " +
      "ratio is 0.44, not the 135x a one-swing floor reported. tools/check-perf-budget.mjs re-measures from whatever " +
      "bundles exist and fails when an action's ratio grows past its recorded ratio plus tolerance; re-record " +
      "deliberately, in its own commit, when a change makes an action faster. Actions whose work has no engine " +
      "constant are absent here on purpose and are printed as `action_pace_unpriced` instead. The ratio is compared " +
      "across revisions, not across machines: it is a property of the game-side path, not of the box.",
    recordedFrom: {
      actionTraceFiles: measurement.actionTraceFiles,
      timelineFiles: measurement.timelineFiles,
      resultFiles: measurement.resultFiles,
      timedInstances: measurement.timedInstances,
      examinedInstances: measurement.examinedInstances,
    },
    tolerance,
    actions,
  };
}

/**
 * Everything one run prints, and whether it is a failure. Pure, so the falsifier can
 * drive it with rows it constructs and with the rows a real measurement produced.
 *
 * THE THREE ZEROES ARE TOLD APART:
 *  - `no_bundle_root`         nothing to measure today      -> blocked, not a failure;
 *  - `no_durations`           bundles exist, none is timed  -> blocked AND a failure;
 *  - readings present         -> compare.
 */
export function renderActionPace({ measurement, verdict, bundleRoot }) {
  const lines = [];
  lines.push(
    `action_pace_population: bundleRoot=${bundleRoot} actionTraceFiles=${measurement.actionTraceFiles} ` +
      `timelineFiles=${measurement.timelineFiles} resultFiles=${measurement.resultFiles} ` +
      `timedInstances=${measurement.timedInstances} ` +
      `examinedInstances=${measurement.examinedInstances} ` +
      `excludedRejected=${measurement.rejectedInstances} unattributed=${measurement.unattributedInstances} ` +
      `actions=${measurement.rows.length}`,
  );
  if (measurement.status === "no_bundle_root") {
    lines.push(
      `action_pace_blocked: no_bundle_root at ${bundleRoot} - nothing was measured, and this line is not a pass`,
    );
    return { lines, failed: false };
  }
  if (measurement.status === "no_durations") {
    lines.push(
      `action_pace_blocked: runs_carry_no_action_durations actionTraceFiles=${measurement.actionTraceFiles} ` +
        `timelineFiles=${measurement.timelineFiles} resultFiles=${measurement.resultFiles} - the bundles exist and hold no timed action, which is a defect and not an empty tree`,
    );
    return { lines, failed: true };
  }
  for (const row of measurement.rows) lines.push(paceLine(row));
  for (const row of verdict.unknown) {
    lines.push(
      `action_pace_unknown_action: ${row.action} (n=${row.instances} on ${row.channel}) is in the traces and in no catalogue ` +
        "and no declaration; classify it or declare it under TRACE_ONLY_ACTIONS, so it cannot leave the population by existing",
    );
  }
  const failed =
    verdict.above.length > 0 ||
    verdict.unrecorded.length > 0 ||
    verdict.missing.length > 0 ||
    verdict.unknown.length > 0;
  if (!failed) {
    lines.push(
      `action_pace_ok examined=${verdict.examined} priced=${verdict.priced} unpriced=${verdict.unpriced.length} ` +
        `above=0 unrecorded=0 missing=0 unknown=0`,
    );
    return { lines, failed: false };
  }
  lines.push(
    `action_pace_failed above=${verdict.above.length} unrecorded=${verdict.unrecorded.length} ` +
      `missing=${verdict.missing.length} unknown=${verdict.unknown.length} examined=${verdict.examined} priced=${verdict.priced}`,
  );
  for (const { row, entry, bound } of verdict.above) {
    lines.push(
      `action_pace_above_native_floor:${row.action}:${row.ratio}:${row.oursMs}:${row.floorMs} ` +
        `p95 ${row.oursP95Ms}ms n=${row.instances} on ${row.channel} (recorded ratio ${entry.ratio}, bound ${bound.toFixed(2)})`,
    );
  }
  for (const row of verdict.unrecorded)
    lines.push(
      `action_pace_unrecorded: ${row.action} ratio ${row.ratio} (${row.oursMs}ms / ${row.floorMs}ms) has no recorded bound`,
    );
  for (const action of verdict.missing)
    lines.push(`action_pace_missing: ${action} is recorded but no bundle measured it`);
  return { lines, failed: true };
}
