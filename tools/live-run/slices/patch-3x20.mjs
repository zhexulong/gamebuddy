#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { clearedKinds, constantsIn, SOURCES } from "../../../gates/stardew/audit-stardew-clearing-vocabulary.mjs";
import { evidenceDetail } from "../../lib/level-up-evidence.mjs";
import { executeFresh, waitForTerminal } from "../../lib/stardew-native-smoke-harness-v1.mjs";
import { parseReceiptFields } from "../../lib/stardew-receipt-evidence.mjs";
/**
 * SLICE ④ - THE MAP EITHER HOLDS A 3x20 PATCH OR SAYS SO, TILE BY TILE.
 *
 * THE PROPERTY. Sixty tiles in one 3-wide, 20-long strip near the farmhouse end with `hoed && crop && watered`, read from
 * the world's own rectangle answer. If any tile cannot get there, the slice prints THAT TILE and the Mod's own reason -
 * which is the finding, not a failure of the slice.
 *
 * WHY IT IS A SLICE. Measured `round92` and again `round93`: she was asked for one 3-wide, twenty-long strip and planted
 * across x 62..79, y 17..26 instead, because "which rectangle should I open" was arithmetic she had to invent from a
 * grid. `round93` answered `soil_tilled 0` against `seed_planted 28`: nothing had ever proved that the map could hold the
 * strip, so the run discovered it in the middle of a night, 35 minutes in. The seam is not `till_soil` or `plant_seed` -
 * both are fine - it is that no cheap check ever asked the ground whether it could carry the shape.
 *
 * WHAT CAN BECOME SOIL, NOT WHAT ALREADY IS. The published `soilTiles` family is a TARGET list: a row exists for ground
 * the Hoe admits NOW (`IsTillableTile`), so a tile with a weed, a rock, grass or a twig on it is not in it. Measured on
 * this slice: the biggest block of that ground was `28x19` - one row short of the strip - and the conclusion "this map
 * cannot hold a 3x20 patch" was a statement about bare ground being read as a statement about the field. It is the same
 * defect as `tillable=no` and `free_footprints=0`: a probe that measures the current state and calls it the possible
 * state, when the whole field is one rectangle and everything standing on it is removable.
 *
 * So the measurement is a WHOLE-MAP SCAN through the rectangle query (`tileArea`, the Mod's `TileAreaQuery`), one tile at
 * a time with its own `tillable`/`occupantKind`/`hoed`: a tile counts toward a block when the Hoe admits it, when it is
 * already under the Hoe, or when what stands on it is a kind SOME PUBLISHED ACTION CLEARS. That last set is not written
 * here - it is read from the Mod's own `Clears(...)` declarations through the reader the clearing-vocabulary gate
 * publishes (`gates/stardew/audit-stardew-clearing-vocabulary.mjs`), so a kind that gains or loses a clearer changes this
 * slice in the same edit.
 *
 * AND THE OCCUPANT IS NAMED, PER TILE, because a block that is 60 tiles of rock is not the same promise as 60 tiles of
 * empty ground: the accounting line prints `clear=<n>` beside `occupants=<kind>:<n>,...`, and the strip it picks is
 * printed with its own counts before anything runs.
 *
 * THE CHAIN IS RUN, NOT ASSUMED. For the strip it picks the slice runs `clear -> till -> plant -> water`, one program
 * per verb against a fresh observation AND a fresh rectangle read of the strip (a `water_crop` node compiled against bare
 * ground is a node whose crop does not exist yet, and a plan over tiles the surviving read does not cover is a plan the
 * compiler refuses for a fact about the reading rather than about the ground), and asks the world after each step which
 * tiles are still owed. A step that refuses is reported with the compiler's or the Mod's own reason code:
 * `live_program_script_not_compiled:<code>`, `soil_not_diggable:<reason>`, `seed_not_owned_in_pack`,
 * `watering_can_empty`. A refusal without a reason was itself a defect here - the driver read a `compiled.ok` field the
 * compiler has not had for months, so every script answered `live_program_script_not_compiled:no_reason_code` and not
 * one node was ever submitted.
 *
 * WHAT IT DOES NOT COVER, stated so nobody reads more into a green. (1) Whether the GROUND under an occupied tile is
 * diggable at all is not published per tile - the tile says `tillable: false` for both "a weed is in the way" and "this
 * is water" - so a strip of weeds is a strip the Hoe is EXPECTED to admit once cleared, and the `till` step is what
 * settles it: a `soil_not_diggable:<reason>` refusal names the tile and the permanent clause that refused it. (2) It does
 * not choose the rectangle a player would have chosen; it takes the closest block that holds the shape. (3) It does not
 * prove a waterer can carry sixty tiles without a refill - a `watering_can_empty` refusal is reported as the finding. (4)
 * It says nothing about harvesting what it plants.
 *
 * THE BOUND. `--budget-ms` (default five minutes) is this slice's own bound on the whole pass. A patch that is still
 * incomplete when it expires is `blocked`, naming the tiles still outstanding - never `passed`, and never a claim that
 * the ground refused something it was not asked. Sixty tiles cost three native actions each, so a full green pass cannot
 * fit a short CI step: the FAST answer is the refusal, which arrives on the first tile that cannot be worked.
 *
 * USAGE
 *   node tools/live-run/slices/patch-3x20.mjs [--budget-ms <n>] [--dry-run] [--keep-log]
 */
import { refusal, restoreEnding } from "../../live-action.mjs";
import {
  describeRowReceipts,
  emptyContext,
  loadProgramHostModules,
  runOneProgram,
  visibleActionIds,
} from "../../live-program.mjs";
import {
  announceSlice,
  describeSlicePlan,
  finishSlice,
  observeReadyWorld,
  runSliceWorld,
  startSlice,
  USAGE_COMMON,
} from "./harness.mjs";

const NAME = "patch-3x20";
const SCENARIO = "crop_research";
const WIDTH = 3;
const LENGTH = 20;
const TILES = WIDTH * LENGTH;
const DEFAULT_BUDGET_MS = 300_000;
/** The chain, in the order the property needs it: nothing can be tilled under an occupant, and nothing planted on bare ground. */
const CHAIN = Object.freeze(["clear", "till_soil", "plant_seed", "water_crop"]);
/** The rectangle question's own bound (`BridgeTileAreaQueryResult.AreaLimit`), so every request is inside it by construction. */
const MAX_AREA_TILES = 100;
/** Ten by ten is exactly that bound, so a whole-map scan is made of answers that are inside it and none that is truncated. */
const SCAN_SIDE = 10;
/** The printout's word for a tile with nothing on it: the one kind no action has to clear. */
const NOTHING_TO_CLEAR = "clear";
/** The actions a plan may name besides the verb's own: walking to a tile and the two ways a tool is put in hand. */
const PLAN_ACTIONS = Object.freeze([
  "move_to_tile",
  "travel",
  "equip_tool",
  "till_soil",
  "plant_seed",
  "water_crop",
  "refill_watering_can",
]);

export const USAGE = `usage: node tools/live-run/slices/patch-3x20.mjs [options]

  Scans the farm's own tiles for ground that can BECOME the ${String(TILES)}-tile strip, prints the block accounting and
  the strip's occupants, then clears, tills, plants and waters it - naming the first tile and reason code that refuses.

${USAGE_COMMON}`;

const keyOf = (tile) => `${String(tile.x)},${String(tile.y)}`;

/**
 * The clearing actions the Mod's catalogue declares, keyed by the occupant kind they clear.
 *
 * THIS IS THE MOD'S OWN ANSWER, read from its declarations rather than written here: `Clears(...)` in
 * `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs`, resolved through the vocabulary the classifier
 * publishes its words from. A kind in neither table - cleared by no action and declared unclearable - is not a kind this
 * slice may count as removable, and the gate that owns that crossing
 * (`gates/stardew/audit-stardew-clearing-vocabulary.mjs`) fails if one ever appears.
 */
export function clearingActions() {
  const constants = constantsIn(readFileSync(SOURCES.vocabulary, "utf8"));
  return clearedKinds(readFileSync(SOURCES.catalog, "utf8"), constants);
}

/**
 * What one scanned tile is worth to a strip: the kind the accounting prints, and whether it can become soil.
 *
 * Three states, and the difference between the last two is the whole slice: `tillable` is the Hoe's admission NOW, a
 * `kind` some action clears is ground a patch can be OPENED in, and anything else - water, a wall, a bush, a fruit tree -
 * ends a block. `hoed` is a tile already under the Hoe: it is soil, and it needs no clearing and no tilling.
 */
export function classifyTile(row, clearers) {
  if (row.tillable === true) return { usable: true, kind: NOTHING_TO_CLEAR };
  if (row.hoed === true) return { usable: true, kind: "hoed" };
  if (row.occupantKind === "none") return { usable: false, kind: "unfarmable_ground" };
  return clearers.has(row.occupantKind)
    ? { usable: true, kind: row.occupantKind }
    : { usable: false, kind: row.occupantKind };
}

/** Every tile of a rectangle, in reading order, so two runs of this slice work the same ground in the same order. */
export function rectangleTiles({ x, y, w, h }) {
  const tiles = [];
  for (let offsetY = 0; offsetY < h; offsetY += 1)
    for (let offsetX = 0; offsetX < w; offsetX += 1) tiles.push({ x: x + offsetX, y: y + offsetY });
  return tiles;
}

/**
 * The blocks of usable ground: connected sets of tiles joined by a cardinal step, each with its own bounding box.
 *
 * THE BOX IS NOT THE BLOCK, and that matters more here than it did for the published one: a bounding box can hold a hole
 * (a bush, a puddle, a chest) and a box that says `3x20` can therefore contain no 3x20 rectangle at all. That is why the
 * slice does not stop at boxes - `rectangleIn` asks the strip question of the tiles themselves.
 */
export function connectedBlocks(usable) {
  const remaining = new Set(usable);
  const blocks = [];
  for (const start of usable) {
    if (!remaining.has(start)) continue;
    const region = [];
    const pending = [start];
    remaining.delete(start);
    while (pending.length > 0) {
      const key = pending.pop();
      region.push(key);
      const [x, y] = key.split(",").map(Number);
      for (const neighbour of [
        `${String(x + 1)},${String(y)}`,
        `${String(x - 1)},${String(y)}`,
        `${String(x)},${String(y + 1)}`,
        `${String(x)},${String(y - 1)}`,
      ])
        if (remaining.has(neighbour)) {
          remaining.delete(neighbour);
          pending.push(neighbour);
        }
    }
    const xs = region.map((key) => Number(key.split(",")[0]));
    const ys = region.map((key) => Number(key.split(",")[1]));
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x + 1;
    const h = Math.max(...ys) - y + 1;
    blocks.push({ x, y, w, h, area: w * h, tiles: region.length });
  }
  return blocks;
}

/**
 * The strip this block really holds, in both orientations, or null.
 *
 * Exact, tile by tile: the shape the property is about is a RECTANGLE of sixty usable tiles, and a bounding box that is
 * big enough says nothing about whether one is in it.
 */
export function rectangleIn(block, usable, { width = WIDTH, length = LENGTH } = {}) {
  for (const [w, h] of [
    [width, length],
    [length, width],
  ]) {
    if (block.w < w || block.h < h) continue;
    for (let y = block.y; y + h <= block.y + block.h; y += 1)
      for (let x = block.x; x + w <= block.x + block.w; x += 1) {
        let fits = true;
        for (let offsetY = 0; offsetY < h && fits; offsetY += 1)
          for (let offsetX = 0; offsetX < w; offsetX += 1)
            if (!usable.has(`${String(x + offsetX)},${String(y + offsetY)}`)) {
              fits = false;
              break;
            }
        if (fits) return { x, y, w, h };
      }
  }
  return null;
}

/**
 * The whole scan as one reading: every tile classified, the blocks, and the blocks that really hold the shape.
 *
 * The population is the farm's own map, not the actor's window: the published family is a radius-bounded list with a row
 * cap, and a strip twenty long is never inside one.
 */
export function measureFarm(rows, clearers) {
  const tiles = new Map();
  for (const row of rows) tiles.set(keyOf(row), { ...row, ...classifyTile(row, clearers) });
  const usableList = [...tiles.values()].filter((tile) => tile.usable === true).map(keyOf);
  const usable = new Set(usableList);
  const blocks = connectedBlocks(usableList);
  const holding = blocks
    .map((block) => ({ block, rectangle: rectangleIn(block, usable) }))
    .filter((entry) => entry.rectangle !== null);
  const largest = [...blocks].sort((left, right) => right.area - left.area)[0] ?? null;
  return { tiles, usable, blocks, holding, largest };
}

/** The block nearest the actor that really holds the shape, and the strip inside it. */
export function chooseStrip(measured, actorTile) {
  if (measured.holding.length === 0) return Object.freeze({ ok: false });
  const nearest = [...measured.holding].sort(
    (left, right) =>
      chebyshev(actorTile, left.block) - chebyshev(actorTile, right.block) || right.block.area - left.block.area,
  )[0];
  return Object.freeze({ ok: true, strip: nearest.rectangle, block: nearest.block });
}

function chebyshev(tile, block) {
  const x = Number.isInteger(tile?.x) ? tile.x : block.x;
  const y = Number.isInteger(tile?.y) ? tile.y : block.y;
  const dx = Math.max(block.x - x, x - (block.x + block.w - 1), 0);
  const dy = Math.max(block.y - y, y - (block.y + block.h - 1), 0);
  return Math.max(dx, dy);
}

/** What the strip is made of, by kind, most tiles first: `clear:41,weed:12,stone:7`. */
export function occupantCounts(measured, strip) {
  const counts = new Map();
  for (const tile of rectangleTiles(strip)) {
    const entry = measured.tiles.get(keyOf(tile));
    const kind = entry === undefined ? "unmeasured" : entry.kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

/** The measurement as the two lines a reader gets, whatever the chain then does. */
export function describeAccounting(measured, choice) {
  const blocks = `blocks ${String(measured.blocks.length)} · blocks_holding_${String(WIDTH)}x${String(LENGTH)} ${String(measured.holding.length)} · best ${largestBlock(measured.blocks)}`;
  if (choice.ok !== true) return `${blocks} · occupants=none: no block holds the shape, so nothing was picked`;
  const counts = occupantCounts(measured, choice.strip)
    .map(([kind, count]) => `${kind}:${String(count)}`)
    .join(",");
  const tiles = rectangleTiles(choice.strip).filter((tile) => {
    const entry = measured.tiles.get(keyOf(tile));
    return entry !== undefined && entry.kind !== NOTHING_TO_CLEAR && entry.kind !== "hoed";
  }).length;
  return `${blocks} · strip=${String(choice.strip.x)},${String(choice.strip.y)} wxh=${String(choice.strip.w)}x${String(choice.strip.h)} · clear=${String(tiles)} tiles · till=${String(TILES)} · plant=${String(TILES)} · water=${String(TILES)} · occupants=${counts}`;
}

/** The map's own size, read from the rectangle query's own off-map answer (`...;map=80x65`). */
export async function mapSize(client) {
  const probes = [
    { x: 0, y: 0, w: 1, h: MAX_AREA_TILES },
    { x: 0, y: MAX_AREA_TILES, w: 1, h: MAX_AREA_TILES },
    { x: 0, y: 0, w: MAX_AREA_TILES, h: 1 },
    { x: MAX_AREA_TILES, y: 0, w: MAX_AREA_TILES, h: 1 },
  ];
  for (const probe of probes) {
    const answer = await client.tileArea(probe);
    const bounds = /map=(\d+)x(\d+)/u.exec(String(answer?.detail ?? ""));
    if (bounds !== null) return { w: Number(bounds[1]), h: Number(bounds[2]) };
  }
  throw refusal("slice_map_bounds_unreadable:inspect_tiles_off_map");
}

/**
 * Every tile of the map, in answers that are each inside the rectangle query's own bound.
 *
 * A rectangle that came back short is refused BY NAME rather than read as if it were whole: a scan missing a row would
 * cut a block in two and the accounting would be wrong in the direction that reads like a finding.
 */
export async function scanFarm(client) {
  const size = await mapSize(client);
  const rows = [];
  for (let y = 0; y < size.h; y += SCAN_SIDE)
    for (let x = 0; x < size.w; x += SCAN_SIDE) {
      const w = Math.min(SCAN_SIDE, size.w - x);
      const h = Math.min(SCAN_SIDE, size.h - y);
      const answer = await client.tileArea({ x, y, w, h });
      if (answer?.status !== "answered")
        throw refusal(`slice_tile_area_refused:${String(answer?.status)}:${String(answer?.detail)}`, undefined, {
          rectangle: { x, y, w, h },
        });
      const answered = Array.isArray(answer.rows) ? answer.rows : [];
      if (answered.length !== w * h || (answer.omitted ?? 0) !== 0)
        throw refusal(
          `slice_tile_area_incomplete:${String(answered.length)}of${String(w * h)}:omitted=${String(answer.omitted)}`,
          undefined,
          { rectangle: { x, y, w, h } },
        );
      for (const row of answered)
        rows.push({
          x: row.x,
          y: row.y,
          tillable: row.tillable === true,
          hoed: row.hoed === true,
          watered: row.watered === true,
          crop: row.crop === true,
          occupant: row.occupant ?? null,
          occupantKind: row.occupantKind ?? null,
          passable: row.passable === true,
        });
    }
  return { size, rows };
}

/**
 * The clear step as one program: one call per occupant kind, over the strip's tiles of that kind.
 *
 * TWO ANSWERS, and the second is the one a reader needs: which calls to make, and which occupants NOTHING THIS POLICY
 * OFFERS clears. A tile whose kind has no enabled clearing action is not "nothing to do" - it is the reason the till step
 * will refuse under it, and the fixture this slice runs arms six actions, none of them a clearing one.
 */
export function clearPlan(measured, strip, clearers, offered) {
  const byAction = new Map();
  const unaddressable = new Map();
  for (const tile of rectangleTiles(strip)) {
    const entry = measured.tiles.get(keyOf(tile));
    if (entry === undefined || entry.usable !== true) continue;
    if (entry.kind === NOTHING_TO_CLEAR || entry.kind === "hoed") continue;
    const action = (clearers.get(entry.kind) ?? []).find((id) => offered.has(id));
    if (action === undefined) {
      unaddressable.set(entry.kind, (unaddressable.get(entry.kind) ?? 0) + 1);
      continue;
    }
    const list = byAction.get(action) ?? [];
    list.push(tile);
    byAction.set(action, list);
  }
  return {
    plan: [...byAction.entries()].map(([action, tiles]) => ({ action, tiles })),
    unaddressable: [...unaddressable.entries()].map(([kind, count]) => ({ kind, count })),
  };
}

/** The plan script for one verb over a fixed tile list; a literal, so the compiler bounds exactly the calls written here. */
export function scriptFor(verb, tiles) {
  const literal = JSON.stringify(tiles);
  const charge = verb === "plant_seed" ? "" : ", charge: 0";
  return `const tiles = ${literal};\nfor (const t of tiles) builder.${verb}({ x: t.x, y: t.y${charge} });`;
}

/**
 * The planting script.
 *
 * The seed is the one INTENTION a planting node carries (`expectedQualifiedItemId`); the slot and the tile's target id are
 * readings the compiler binds from the observation it compiles against, which is why neither is written here.
 */
export function plantScript(tiles, qualifiedItemId) {
  return `const tiles = ${JSON.stringify(tiles)};\nfor (const t of tiles) builder.plant_seed({ x: t.x, y: t.y, expectedQualifiedItemId: ${JSON.stringify(qualifiedItemId)} });`;
}

/** The clear step's script: the same shape, one loop per (action, tiles) pair the strip needs. */
export function clearScript(plan) {
  return plan
    .map(({ action, tiles }) => `for (const t of ${JSON.stringify(tiles)}) builder.${action}({ x: t.x, y: t.y });`)
    .join("\n");
}

/** The seed the slice plants: the item the world offers the most planting tiles for, read from `seedTargets`. */
export function seedToPlant(snapshot) {
  const rows = Array.isArray(snapshot?.seedTargets) ? snapshot.seedTargets : [];
  const counts = new Map();
  for (const row of rows)
    if (typeof row?.qualifiedItemId === "string")
      counts.set(row.qualifiedItemId, (counts.get(row.qualifiedItemId) ?? 0) + 1);
  const planted = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  return planted === undefined ? null : planted[0];
}

/** The world's own answer for the strip: one row per tile, with the four facts the property is made of. */
export async function readStrip(client, strip) {
  if (strip.w * strip.h > MAX_AREA_TILES) throw refusal(`slice_strip_too_large:${String(strip.w)}x${String(strip.h)}`);
  const answer = await client.tileArea({ x: strip.x, y: strip.y, w: strip.w, h: strip.h });
  return {
    status: answer?.status ?? null,
    detail: answer?.detail ?? null,
    rows: Array.isArray(answer?.rows)
      ? answer.rows.map((row) => ({
          x: row.x,
          y: row.y,
          tillable: row.tillable === true,
          hoed: row.hoed === true,
          crop: row.crop === true,
          watered: row.watered === true,
          occupant: row.occupant ?? null,
          occupantKind: row.occupantKind ?? null,
        }))
      : [],
  };
}

function doneFor(verb, row) {
  if (verb === "clear") return row.hoed === true || row.occupantKind === "none";
  if (verb === "till_soil") return row.hoed;
  if (verb === "plant_seed") return row.crop;
  return row.watered;
}

/** The tiles one verb still owes, from the rectangle answer taken after its program settled. */
export function outstandingFor(verb, read) {
  if (read.rows.length === 0) return null;
  return read.rows.filter((row) => !doneFor(verb, row)).map((row) => ({ x: row.x, y: row.y }));
}

/** The Mod's own word for one tile, from the terminal receipts of the verb that was supposed to work it. */
export function reasonByTile(receipts, actionIds) {
  const wanted = new Set(actionIds);
  const reasons = new Map();
  for (const receipt of receipts) {
    if (!wanted.has(receipt?.actionId)) continue;
    if (typeof receipt.reasonCode !== "string") continue;
    if (receipt.state === "succeeded") continue;
    const fields = parseReceiptFields(evidenceDetail(receipt.evidence));
    const tile = fields?.get("tile") ?? fields?.get("target");
    if (typeof tile === "string" && !reasons.has(tile)) reasons.set(tile, receipt.reasonCode);
  }
  return reasons;
}

/**
 * One step of the chain: read the strip, compile against that fresh read and observation, submit, settle, then read the
 * ground again.
 *
 * THE READ COMES FIRST, and it is the one the plan is written from. The compiler proves a tile outside the snapshot's
 * six-tile window by the LAST rectangle this session read (`plan_script_target_outside_the_read` and the third answer
 * beside it), and the whole-map scan that chose the strip is sixty reads old by the time a step compiles: its answer was
 * replaced one block at a time. A step that compiled after the scan without reading the strip again asked the compiler
 * about tiles nobody's surviving read covered, which is the count `read_covers=0` states - and that is the slice's own
 * read travelling by a route the compiler cannot see, not the world refusing the strip.
 */
async function runStep({ session, modules, strip, step, script, actionIds, settleMs }) {
  const plan = {
    scenarioKey: SCENARIO,
    scenario: "native_crop_research_v1",
    actions: [...PLAN_ACTIONS, ...actionIds],
    script,
    scriptPath: null,
    settleMs,
  };
  await readStrip(session.client, strip);
  const context = emptyContext();
  let refusalText = null;
  try {
    await runOneProgram({ plan, session, modules, context });
  } catch (error) {
    refusalText = String(error?.message ?? error).slice(0, 400);
  }
  const read = await readStrip(session.client, strip);
  return {
    verb: step,
    refusal: refusalText,
    compiled:
      context.compiled === null
        ? null
        : {
            status: context.compiled.status,
            dropped: context.compiled.dropped ?? [],
            droppedCount: context.compiled.droppedCount ?? 0,
            rejected: context.compiled.rejected ?? [],
            nodes: context.nodes === null ? null : context.nodes.length,
          },
    settled:
      context.settled === null
        ? null
        : { reachedTerminal: context.settled.reachedTerminal, elapsedMs: context.settled.elapsedMs },
    receipts: describeRowReceipts({ receipts: context.receipts, actionIds }),
    outstanding: outstandingFor(step, read),
    reasons: boundedReasons(reasonByTile(context.receipts, actionIds)),
  };
}

/** The reason map, bounded: a sixty-tile strip can name sixty refusals and a block that size is not a diagnosis. */
function boundedReasons(reasons) {
  return [...reasons.entries()].slice(0, TILES).map(([tile, reasonCode]) => ({ tile, reasonCode }));
}

/** Walk out of the farmhouse, scan the farm, then run the chain over the strip the scan chose. */
export async function measurePatch({ client, receipts, budgetMs }) {
  const session = { client, receipts };
  const modules = await loadProgramHostModules();
  const inside = await observeReadyWorld(client, { budgetMs });
  const warps = Array.isArray(inside.warps) ? inside.warps : [];
  // A published warp is the only way out, and the row this slice sends must be one the wire accepts: `-1` is how the
  // engine spells an edge warp, and `travel`'s published source range refuses it. Selecting the first row whose target
  // merely differed from here sent `-1` and was answered `warp_out_of_range`.
  const out = warps.find(
    (warp) =>
      typeof warp?.targetLocation === "string" &&
      !/^FarmHouse/u.test(warp.targetLocation) &&
      Number.isInteger(warp.sourceX) &&
      warp.sourceX >= 0 &&
      Number.isInteger(warp.sourceY) &&
      warp.sourceY >= 0 &&
      warp.accessible !== false,
  );
  const travelled =
    out === undefined || inside.location === out.targetLocation
      ? { skipped: true, from: inside.location, to: inside.location, warps }
      : await travelOut(session, out, budgetMs, warps);
  const farm = await observeReadyWorld(client, { budgetMs });
  const clearers = clearingActions();
  const scan = await scanFarm(client);
  const measured = measureFarm(scan.rows, clearers);
  const choice = chooseStrip(measured, farm.tile ?? null);
  process.stderr.write(`[slice] ${NAME} ${describeAccounting(measured, choice)}\n`);
  if (!choice.ok)
    return {
      location: { from: inside.location, to: farm.location },
      travelled,
      map: scan.size,
      accounting: describeAccounting(measured, choice),
      strip: null,
      blocks: measured.blocks,
      largest: measured.largest,
      steps: [],
      after: { status: null, rows: [] },
      complete: false,
      elapsedMs: 0,
    };

  const strip = choice.strip;
  const stripTiles = rectangleTiles(strip);
  const counts = occupantCounts(measured, strip);
  const offered = new Set(visibleActionIds(client, modules));
  const clear = clearPlan(measured, strip, clearers, offered);
  const clearTiles =
    clear.plan.reduce((total, entry) => total + entry.tiles.length, 0) +
    clear.unaddressable.reduce((total, entry) => total + entry.count, 0);
  const unaddressable = clear.unaddressable.map((entry) => `${entry.kind}:${String(entry.count)}`).join(",");
  process.stderr.write(
    `[slice] ${NAME} strip=${String(strip.x)},${String(strip.y)} wxh=${String(strip.w)}x${String(strip.h)} · clear=${String(clearTiles)} tiles · till=${String(TILES)} · plant=${String(TILES)} · water=${String(TILES)} · occupants=${counts.map(([kind, count]) => `${kind}:${String(count)}`).join(",")}${unaddressable === "" ? "" : ` · this policy clears no ${unaddressable}`}\n`,
  );

  const startedAt = Date.now();
  const steps = [];
  const seed = seedToPlant(farm);
  const chain = [
    {
      step: "clear",
      needed: clearTiles,
      ...(clearTiles === 0
        ? { skip: "strip_already_clear" }
        : clear.unaddressable.length > 0
          ? { refusal: `slice_no_enabled_action_clears:${unaddressable}` }
          : { script: () => clearScript(clear.plan), actionIds: clear.plan.map((entry) => entry.action) }),
    },
    { step: "till_soil", needed: TILES, script: () => scriptFor("till_soil", stripTiles), actionIds: ["till_soil"] },
    {
      step: "plant_seed",
      needed: TILES,
      ...(seed === null
        ? { refusal: "slice_no_seed_to_plant:seedTargets" }
        : { script: () => plantScript(stripTiles, seed), actionIds: ["plant_seed"] }),
    },
    { step: "water_crop", needed: TILES, script: () => scriptFor("water_crop", stripTiles), actionIds: ["water_crop"] },
  ];
  for (const entry of chain) {
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 5_000) {
      steps.push({ verb: entry.step, skipped: `slice_budget_exhausted_before_${entry.step}`, needed: entry.needed });
      break;
    }
    if (entry.skip !== undefined) {
      steps.push({ verb: entry.step, skipped: entry.skip, needed: entry.needed, outstanding: [] });
      continue;
    }
    if (entry.refusal !== undefined) {
      steps.push({ verb: entry.step, refusal: entry.refusal, needed: entry.needed });
      break;
    }
    const result = await runStep({
      session,
      modules,
      strip,
      step: entry.step,
      script: entry.script(),
      actionIds: entry.actionIds,
      settleMs: remaining,
    });
    steps.push({ ...result, needed: entry.needed });
    if (result.refusal !== null) break;
    if (result.outstanding !== null && result.outstanding.length > 0) {
      // The first step that cannot finish the strip ends the pass: planting over ground that was not hoed would answer a
      // refusal about soil, and a report full of those would bury the one finding that matters.
      break;
    }
  }
  const after = await readStrip(client, strip);
  return {
    location: { from: inside.location, to: farm.location },
    travelled,
    map: scan.size,
    accounting: describeAccounting(measured, choice),
    strip: { x: strip.x, y: strip.y, w: strip.w, h: strip.h, block: choice.block, blocks: measured.blocks },
    stripOccupants: counts,
    clear: {
      tiles: clearTiles,
      plan: clear.plan.map((entry) => ({ action: entry.action, tiles: entry.tiles.length })),
      unaddressable: clear.unaddressable,
    },
    steps,
    after: { status: after.status, rows: after.rows },
    complete: after.rows.length === TILES && after.rows.every((row) => row.hoed && row.crop && row.watered),
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * The way out of the house: WALK to the published exit tile, then take it.
 *
 * Two calls, not one, and the reason is measured: `travel({x:3,y:12})` from the farmhouse tile `(9,9)` - the exact warp
 * the snapshot published, `targetLocation: Farm` - was answered `rejected/warp_out_of_range`, because the transition admits
 * the door only while the actor is beside it. The walk is the product's own `move_to_tile`, so nothing is faked and the
 * distance the engine charges is the distance the player would walk.
 */
async function travelOut({ client, receipts }, warp, budgetMs, warps) {
  const source = { x: warp.sourceX, y: warp.sourceY };
  const walked = await dispatchOne({ client, receipts, budgetMs, action: "move_to_tile", args: source });
  if (walked.state !== "succeeded")
    throw refusal(`slice_walk_to_exit_refused:${String(walked.state)}:${String(walked.reasonCode)}`, undefined, {
      source,
      warps,
    });
  const travelled = await dispatchOne({ client, receipts, budgetMs, action: "travel", args: source });
  if (travelled.state !== "succeeded")
    throw refusal(`slice_travel_out_refused:${String(travelled.state)}:${String(travelled.reasonCode)}`, undefined, {
      source,
      warps,
    });
  return {
    skipped: false,
    from: warp.targetLocation,
    source,
    walk: { state: walked.state, reasonCode: walked.reasonCode },
    terminal: { state: travelled.state, reasonCode: travelled.reasonCode },
  };
}

/** One action, submitted fresh and held to its terminal: the shape a slice uses when it is not submitting a program. */
async function dispatchOne({ client, receipts, budgetMs, action, args }) {
  const snapshot = await observeReadyWorld(client, { budgetMs });
  const requestId = `slice_patch_${action}_${Date.now()}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
  });
  return await waitForTerminal(receipts, accepted, Math.min(budgetMs, 60_000));
}

/**
 * The verdict: the world's own rectangle answer decides, and an incomplete strip names the tile and the Mod's word for it.
 *
 * `blocked` is kept apart from `failed` on purpose: a slice whose own budget expired has not learned whether the ground
 * can carry the strip, and reporting that as `failed` would be the slice claiming a fact about the map it never measured.
 */
export function judgePatch(measured, budgetMs) {
  if (measured.complete) return { status: "passed", detail: `patch_${String(TILES)}_complete` };
  // THE GROUND'S OWN ANSWER, and the one the farming rotation needs first: no block on this map holds the strip in
  // EITHER orientation. This is `failed` and not `blocked`: every tile of the map was read, and the map said no. The
  // accounting travels in the detail because "how big was the best" is the finding.
  if (measured.strip === null)
    return {
      status: "failed",
      detail: `patch_${String(WIDTH)}x${String(LENGTH)}_does_not_fit_this_ground:blocks=${String(measured.blocks.length)}:largest=${largestBlock(measured.blocks)}`,
    };
  if (measured.after.rows.length === 0)
    return { status: "failed", detail: `strip_unreadable:${String(measured.after.status)}` };
  const unpaid = [];
  for (const step of CHAIN) {
    const row = measured.steps.find((entry) => entry.verb === step);
    if (row === undefined) {
      unpaid.push(`${step}:not_run`);
      break;
    }
    if (row.skipped !== undefined) {
      if (step === "clear") continue;
      unpaid.push(`${step}:${row.skipped}`);
      break;
    }
    if (row.refusal !== null) {
      unpaid.push(`${step}:refused:${row.refusal}`);
      break;
    }
    // A CALL THE COMPILER REFUSED has no receipt, so the tiles it was for would otherwise be reported as
    // `no_terminal_receipt` - a code that names nothing. The compiler's own `dropped` entry is the reason.
    if (row.compiled !== null && row.compiled.droppedCount > 0) {
      unpaid.push(`${step}:${String(row.compiled.droppedCount)}_calls_refused:${row.compiled.dropped[0]}`);
      break;
    }
    if (row.outstanding !== null && row.outstanding.length > 0) {
      const first = row.outstanding[0];
      const reason = row.reasons.find((entry) => entry.tile === `${String(first.x)},${String(first.y)}`);
      unpaid.push(
        `${step}:${String(row.needed - row.outstanding.length)}/${String(row.needed)}:first_refused=${String(first.x)},${String(first.y)}:${reason?.reasonCode ?? "no_terminal_receipt"}`,
      );
      break;
    }
  }
  if (measured.elapsedMs >= budgetMs)
    return { status: "blocked", detail: `slice_budget_exhausted:${unpaid[0] ?? "unknown"}` };
  return { status: "failed", detail: `patch_incomplete:${unpaid[0] ?? "unknown"}` };
}

/** The biggest block the ground published, by area, named so a reader sees how close the strip came. */
function largestBlock(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return "none";
  const largest = [...blocks].sort((left, right) => right.w * right.h - left.w * left.h)[0];
  return `${String(largest.w)}x${String(largest.h)}@${String(largest.x)},${String(largest.y)}`;
}

async function main(argv) {
  const started = await startSlice({
    name: NAME,
    argv,
    usage: USAGE,
    scenarioKey: SCENARIO,
    budgetMs: DEFAULT_BUDGET_MS,
  });
  if (started === null) return;
  const { options, plan } = started;
  const calls = [
    "travel",
    "scan",
    "clear",
    ...CHAIN.filter((step) => step !== "clear").map((step) => `${step}x${String(TILES)}`),
  ];
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(describeSlicePlan({ name: NAME, plan, calls }), null, 2)}\n`);
    return;
  }
  announceSlice({ name: NAME, plan, calls });
  let run;
  try {
    run = await runSliceWorld({
      plan,
      body: ({ client, receipts }) => measurePatch({ client, receipts, budgetMs: options.budgetMs }),
    });
  } catch (error) {
    finishSlice({ name: NAME, status: "blocked", detail: String(error?.message ?? error), facts: {} });
    return;
  }
  const ending = restoreEnding(run.restore);
  if (ending !== null) {
    finishSlice({
      name: NAME,
      status: "blocked",
      detail: ending,
      facts: { measured: run.result, restore: run.restore },
    });
    return;
  }
  if (run.failure !== null) {
    finishSlice({
      name: NAME,
      status: "blocked",
      detail: String(run.failure?.message ?? run.failure),
      facts: { stack: run.failure?.stack ?? null, detail: run.failure?.detail ?? null, restore: run.restore },
    });
    return;
  }
  const judged = judgePatch(run.result, options.budgetMs);
  finishSlice({
    name: NAME,
    status: judged.status,
    detail: judged.detail,
    facts: { measured: run.result, restore: run.restore, elapsedMs: run.elapsedMs },
  });
}

if (import.meta.main) await main(process.argv.slice(2));
