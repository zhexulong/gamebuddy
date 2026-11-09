import type { Snapshot } from "./protocol.js";

/**
 * How many bytes the state block may occupy.
 *
 * It is re-sent WHOLE with every turn, so it is a per-turn tax on every later turn's context. The block is
 * bounded here rather than trusted, and the bound names the line that grew instead of silently cutting state
 * in half (see `formatSnapshotHud`).
 */
export const MAX_SNAPSHOT_HUD_BYTES = 1_200;

/**
 * One line of the block, and the snapshot fields it reads.
 *
 * The declaration is the gate: `fields` is typed `keyof Snapshot`, so a line cannot be written for a field the
 * snapshot does not carry, and `snapshot-hud.test.ts` derives its population from the protocol's own
 * `SNAPSHOT_KEYS` to prove no line reads a field it did not declare.
 */
type SnapshotHudLine = Readonly<{
  /** The line's key in the block, and the name the size bound reports when this line is what grew. */
  name: string;
  fields: readonly (keyof Snapshot)[];
  /**
   * `ageTurns` is how many delivered turns ago the snapshot was observed; 0 is the current reading. Only the lines
   * whose value a later turn falsifies read it (see `aged`).
   */
  render: (snapshot: Snapshot, ageTurns: number) => string;
}>;

/** Fixed order, because the block is re-sent every turn and a reordered block is a changed cache prefix. */ export const SNAPSHOT_HUD_LINES: readonly SnapshotHudLine[] =
  Object.freeze([
    {
      name: "time",
      fields: ["timeOfDay"],
      render: (snapshot, ageTurns) => aged(formatGameClock(snapshot.timeOfDay), ageTurns),
    },
    {
      name: "calendar",
      fields: ["seasonIndex", "dayOfMonth", "year"],
      render: (snapshot) => `${seasonName(snapshot.seasonIndex)}, day ${snapshot.dayOfMonth}, year ${snapshot.year}`,
    },
    { name: "weather", fields: ["weather"], render: (snapshot) => snapshot.weather },
    {
      name: "where",
      fields: ["location", "tile"],
      render: (snapshot, ageTurns) =>
        aged(`${snapshot.location} at (${snapshot.tile.x}, ${snapshot.tile.y})`, ageTurns),
    },
    {
      name: "body",
      fields: ["actionable", "actorDispositionKind"],
      render: bodyStateOf,
    },
    { name: "stamina", fields: ["stamina"], render: (snapshot) => `${snapshot.stamina}` },
    { name: "health", fields: ["health"], render: (snapshot) => `${snapshot.health}` },
    { name: "exhausted", fields: ["exhausted"], render: (snapshot) => (snapshot.exhausted ? "yes" : "no") },
    { name: "held tool", fields: ["currentTool", "currentToolSlot"], render: heldToolOf },
    {
      // WHOLE MAP, not a radius.
      //
      // This line rendered `cropTargets.length` - the radius-6 entity scan - so a companion standing in its own house read
      // "0 in reach" while thirty-four crop tiles sat dry outside, and a live run spent a whole afternoon in Town with full
      // stamina on an unwatered farm. The whole-map fact already existed and was already being sent (`wateringWhereabouts`
      // counts every loaded location with the engine's own `HoeDirt.needsWatering()`), so the fix is to read it here rather
      // than to add anything.
      //
      // The radius answer is kept as a second clause ONLY when it differs from the whole-map total for this map, because two
      // numbers that are always equal are two spellings of one fact.
      name: "unwatered crops",
      fields: ["wateringWhereabouts", "location"],
      render: (snapshot) => unwateredCropsOf(snapshot),
    },
    {
      // THE SAME QUADRANT, ONE CROP LATER. `harvestWhereabouts` was already published and already validated, and this block
      // never read it - so the only way to learn that anything was ripe was a full `stardew_observe`, and a companion who
      // had just finished watering had no per-turn signal that the crop it walked past was ready. Nothing is added here:
      // the count is the Mod's own whole-map scan, and the line has the same shape as the dry-crop one beside it.
      name: "ripe crops",
      fields: ["harvestWhereabouts", "location"],
      render: (snapshot) => ripeCropsOf(snapshot),
    },
    {
      // THE WAY OUT OF A MINE LEVEL, read every turn because the fact does not move.
      //
      // `mineEntranceTargets` is published from a whole-layer scan of the level's own Buildings layer: the exit ladder
      // (tile 115) and the descent ladder (tile 173) are one family with one row shape, so a companion that had to
      // discover them by observation was trapped at 01:00 with a 6.9k-token observe as its only way to ask. A ladder does
      // not move while the level is unchanged, which is exactly the shape a per-turn line is for - the same quadrant error
      // as the dry-crop line above, one map over.
      //
      // The kind (exit or descent) is NOT on the wire: the id is hashed from kind + tile and the row carries only the id
      // and the tile. This line therefore names the ladders and never claims which is which - the action re-reads the live
      // tile and refuses a tile that is neither.
      name: "mine ladders",
      fields: ["mineEntranceTargets"],
      render: mineLaddersOf,
    },
    {
      // The location's mailbox: one map-fixed point, the same quadrant and the same reason as the ladders.
      //
      // `claim_mail_attachment` needs the mailbox's own opaque id, and the id is hashed from location, tile, the pending
      // count and the head letter - so it changes when mail arrives and is stable while nothing does. That is a per-turn
      // line: the alternative is an observe to find out whether there is a mailbox here at all.
      name: "mailbox",
      fields: ["mailboxTargets", "location"],
      render: mailboxOf,
    },
    {
      // WATER ON THIS MAP, the third of the same quadrant error: `refillWateringCanTargets` is a whole-map scan of the
      // engine's own `CanRefillWateringCanOnTile`, so a pond ten tiles away is a fact that never moves - and the only way
      // to ask for it was an observe of the entire map.
      //
      // One row is printed, the nearest, because that is the one a refill plan walks to: the Mod publishes the nearest
      // rows first and caps the list, so a line that printed all eight would pay ~300 bytes every turn for one call.
      name: "refill water",
      fields: ["refillWateringCanTargets", "tile"],
      render: (snapshot) => nearestWaterOf(snapshot.refillWateringCanTargets ?? [], snapshot.tile),
    },
    {
      // WATER A ROD MAY BE CAST AT - the same quadrant, and CARRIED rather than withheld for a reason a reader can check.
      //
      // `waterTargets` is `DiscoverWaterTargets` (`farmhandexecutioncontroller.fishingactions.cs:62`): a whole-map scan of
      // the engine's own `canFishHere` + `isTileFishable` pair, kept only where a cardinal neighbour is a tile the body can
      // stand on, then sorted nearest-first and capped. Nothing about the SET depends on where the actor stands or what it
      // just did - only the order and the cap do - so a per-turn line is the right shape for it.
      //
      // Why not withheld, decided by what the agent would use instead: `fish_here` refuses unless `expectedTargetId` names
      // this exact tile (it recomputes the hash and rejects `water_not_fishable:target_changed`), so `x`/`y` alone are not
      // an address and the id has to be visible. The only other family over water is `refillWateringCanTargets`: same row
      // shape, different predicate (`CanRefillWateringCanOnTile`) and a different id (`watering_can_refill_...`), so a
      // refill row is refused by the cast. With no substitute to name, the alternative to this line is a whole-map observe
      // before the first cast of the day.
      //
      // One row, the nearest by the actor's own tile, with the rest counted - the shape the refill line beside it uses.
      name: "fishable water",
      fields: ["waterTargets", "tile"],
      render: (snapshot) => nearestWaterOf(snapshot.waterTargets ?? [], snapshot.tile),
    },
    {
      // A SHOP IS A PLACE, NOT A DISCOVERY.
      //
      // `shopTargets` is published from the map's own shop data (`Location` plus the owner's tile), so it is map-fixed: the
      // same shop sits at the same counter all day. `shop_purchase` needs the shop's opaque id, and before this line the
      // only way to learn that this map has a shop at all was an observe of everything. One row, the one whose location is
      // where the companion stands, with the id the action takes.
      name: "shop",
      fields: ["shopTargets", "location"],
      render: shopHereOf,
    },
    {
      // THE MINE'S ELEVATOR IS A FIXED TABLE OF FLOORS.
      //
      // `mineElevatorFloorTargets` comes from a whole-layer scan inside `TryFindMineElevatorTile` - not a radius - so the
      // floor list is the same every turn the level is unchanged, and `ride_mine_elevator` needs one of these ids. The
      // current floor is marked rather than implied: a list without it makes the companion read the whole ladder to work
      // out where it already is.
      name: "mine floors",
      fields: ["mineElevatorFloorTargets", "location"],
      render: mineFloorsOf,
    },
  ]);

/**
 * The Game model's standing state block: where the companion is, what time it is, and whether its body is free.
 *
 * <p>
 * STATE IS NOT A DELTA. A snapshot is delivered once, when it is observed; four turns later the model still
 * "knows" the stamina and the tile it read then, and the only way to find out what is true NOW is to call
 * `stardew_observe` again. That round trip is the defect this block removes, so the Host re-states the latest
 * snapshot into every turn's fact batch (`CompanionHostService.#restateWorldSnapshot`) and this renders it.
 * Events stay deltas: a receipt or a semantic event happened once and is delivered once.
 * </p>
 * <p>
 * WHAT THE BLOCK CANNOT DO IS BE CURRENT ON ITS OWN. Nothing refreshes a snapshot between turns - the protocol has no
 * unsolicited push (`local-stardew-bridge.ts#acceptSnapshot`), so the newest reading is the last one the model or the
 * attach asked for - and a block re-stated from it therefore describes a moment that has already passed. A reading
 * that is not this turn's says so; the wording and the measurement behind it live in `aged`.
 * </p>
 * <p>
 * Determinism is a requirement, not a courtesy. The fact batch is folded into the session's cached history, and
 * the model reads the block to decide what to do next: a block that changes when nothing happened is both a
 * cache invalidation and a false signal that something did. So: fixed line order, no clock of our own, no map
 * iteration, no field rendered twice, and the one age it may print is `ageTurns` - a count of delivered turns the
 * caller owns, never a sampled wall-clock reading.
 * </p>
 */
export function formatSnapshotHud(snapshot: Snapshot, ageTurns = 0): string {
  const kept = SNAPSHOT_HUD_LINES.map((line) => ({ name: line.name, value: line.render(snapshot, ageTurns) }));
  const omitted: string[] = [];
  let text = composeHud(kept, omitted);
  // Over budget means one value carried more than a HUD line should. Drop the widest line first and NAME it:
  // the remedy is to bound that value at its source, never to raise the cap on the next turn's context.
  while (utf8Bytes(text) > MAX_SNAPSHOT_HUD_BYTES && kept.length > 0) {
    const widest = kept.reduce((worst, line) => (utf8Bytes(line.value) > utf8Bytes(worst.value) ? line : worst));
    omitted.push(widest.name);
    kept.splice(kept.indexOf(widest), 1);
    text = composeHud(kept, omitted);
  }
  return text;
}

/**
 * Qualifies a value that came from a snapshot older than the turn it is printed in.
 *
 * <p>
 * Measured 2026-11-05 (`2026-11-05T11-37-35-764Z-multiday_routine`): six consecutive turns were handed the same
 * `time: 18:00` / `where: Farm at (70, 13)` block. A warp into the FarmHouse had been receipted three turns earlier
 * and the 22:00 `time_milestone` had arrived - the model's own reasoning read "It's 22:00 now" in the same turn the
 * block said 18:00 - so it decided to wait rather than sleep, and the run ended `companion_did_not_sleep`.
 * </p>
 * <p>
 * The age is in TURNS, and that is the only unit the Host may use. It has no current game clock (that is the very
 * thing it is missing) and a wall-clock age says nothing about a world that advances only when someone acts: a
 * 40-second turn can pass an in-game hour while a 40-minute one passes none. A count of delivered turns is the one
 * age the Host can state without inventing a fact.
 * </p>
 */
function aged(value: string, ageTurns: number): string {
  if (ageTurns < 1) return value;
  const turns = ageTurns === 1 ? "1 turn" : `${String(ageTurns)} turns`;
  return `${value} (observed ${turns} ago - not the current world)`;
}

/**
 * Whether the body can take a new command, and what holds it when it cannot.
 *
 * Deliberately not `activeExecution`: that key is withheld from the always-on block by name ("the Host already
 * owns execution state from action receipts"), and an action id here would read as an instruction to repeat the
 * previous turn rather than as a description of the body. `actionable` plus the disposition answer the question
 * from facts that are already projected every turn.
 */
function bodyStateOf(snapshot: Snapshot): string {
  const disposition = snapshot.actorDispositionKind;
  if (disposition !== undefined && disposition !== "idle") return `busy (${disposition})`;
  return snapshot.actionable ? "free" : "busy (not actionable)";
}

/**
 * How many ladder rows the mine line prints before it counts the rest.
 *
 * A mine level publishes at most two (the exit and the descent), but the mine ENTRANCE map publishes up to sixteen
 * `Mine` Action tiles, and sixteen ids of 38 bytes each would push the whole block past its byte budget. Four keeps the
 * line under ~200 bytes and the remainder is named, never dropped silently.
 */
const MAX_MINE_LADDER_ROWS = 4;

/**
 * The mine-ladder line: where the level's ladders are, and the ids the action needs to take one.
 *
 * Three shapes, each said plainly:
 *
 *   in a level    `mine_entrance_1a2b... at (12, 3), mine_entrance_9c8d... at (15, 9)`
 *   not in one    `none here`
 *   more than the cap   the first few by tile, then `+N more` - never silently truncated
 *
 * Deterministic by construction: the rows are sorted by tile, never trusted in the array's own order, and nothing here
 * reads a clock. The Mod's own order puts the exit ladder first, but the row shape does not carry the kind, so sorting by
 * tile is the only order this line can justify.
 */
function mineLaddersOf(snapshot: Snapshot): string {
  const rows = snapshot.mineEntranceTargets ?? [];
  if (rows.length === 0) return "none here";
  const ordered = [...rows].sort((left, right) => left.x - right.x || left.y - right.y);
  const shown = ordered.slice(0, MAX_MINE_LADDER_ROWS).map((row) => `${row.targetId} at (${row.x}, ${row.y})`);
  if (ordered.length > shown.length) shown.push(`+${ordered.length - shown.length} more`);
  return shown.join(", ");
}

/**
 * The mailbox line: this location's mailbox, its pending count, and the id `claim_mail_attachment` takes.
 *
 * The Mod publishes the mailbox of the location the actor stands in, and its id is hashed from the location, the tile,
 * the pending count and the head letter. "No mailbox here" is a fact, not an absence, so it is stated rather than left
 * blank; a row from another location is never rendered, because the action only accepts the one under the actor's feet.
 */
function mailboxOf(snapshot: Snapshot): string {
  const rows = snapshot.mailboxTargets ?? [];
  const here = rows.find((row) => row.location === snapshot.location);
  if (here === undefined) return "none here";
  return `${here.pendingCount} pending at (${here.x}, ${here.y}) ${here.targetId}`;
}

/**
 * Both water lines: the nearest row of one water family and the id the action that takes it binds.
 *
 * Shared because the row is shared: `refillWateringCanTargets` and `waterTargets` carry the same `{ targetId, x, y }`
 * (`host/src/protocol-target-facts.ts` says so by construction, one validator), and both lines answer the same question -
 * where the nearest water on this map is. They differ in which action reads the id, so they stay two lines.
 *
 * Two shapes, each said plainly:
 *
 *   water on this map   `nearest (12, 20) watering_can_refill_0123456789abcdef (+7 more)`
 *   none                `none here` - a fact, not an absence: this map has no tile the engine answers yes for
 *
 * The nearest row is DERIVED from the actor's tile by the same rule the Mod sorts by (Chebyshev distance, then x, then
 * y), never taken from the wire array's own order: a reordered array is the same world, and the block is folded into the
 * cached history, so it must render the same bytes.
 */
function nearestWaterOf(
  rows: readonly Readonly<{ targetId: string; x: number; y: number }>[],
  actor: Readonly<{ x: number; y: number }>,
): string {
  const distance = (row: Readonly<{ x: number; y: number }>): number =>
    Math.max(Math.abs(row.x - actor.x), Math.abs(row.y - actor.y));
  const [nearest] = [...rows].sort(
    (left, right) => distance(left) - distance(right) || left.x - right.x || left.y - right.y,
  );
  if (nearest === undefined) return "none here";
  const rest = rows.length - 1;
  return `nearest (${nearest.x}, ${nearest.y}) ${nearest.targetId}${rest > 0 ? ` (+${String(rest)} more)` : ""}`;
}

/**
 * The shop line: the shop the companion is standing in, its stock count, and the id `shop_purchase` takes.
 *
 *   here   `Woody's shop at (12, 8) 34 items shop_1a2b…`
 *   none   `none here` - a fact: this map has no shop counter, so a purchase is not a thing to try
 *
 * The row is chosen by the location the companion stands in, never by array order, because the block is folded into the
 * cached history and must render the same bytes for the same world.
 */
function shopHereOf(snapshot: Snapshot): string {
  const rows = snapshot.shopTargets ?? [];
  const here = rows.find((row) => row.location === snapshot.location);
  if (here === undefined) return "none here";
  return `${here.ownerName} at (${here.ownerTileX}, ${here.ownerTileY}) ${here.stockCount} items ${here.targetId}`;
}

/**
 * The mine-elevator line: the floors this level's elevator reaches, and which one the companion is on.
 *
 *   floors   `5, 10, 15 (here: 15)`
 *   none     `none here` - a fact: this level has no elevator, so `ride_mine_elevator` has nothing to accept
 *
 * Floors are printed in the order the game's own table holds them, which is ascending, and the mark is derived from the
 * row's own `isCurrentFloor` rather than from a guess about the actor's depth.
 */
function mineFloorsOf(snapshot: Snapshot): string {
  const rows = snapshot.mineElevatorFloorTargets ?? [];
  if (rows.length === 0) return "none here";
  const floors = rows.map((row) => String(row.floor)).join(", ");
  const here = rows.find((row) => row.isCurrentFloor);
  return here === undefined ? floors : `${floors} (here: ${String(here.floor)})`;
}

function heldToolOf(snapshot: Snapshot): string {
  const tool = snapshot.currentTool ?? "nothing";
  const slot = snapshot.currentToolSlot;
  return slot === undefined || slot === null ? tool : `${tool} in slot ${slot}`;
}

/**
 * One whole-map crop row, with its count read from its own family's member name.
 *
 * `nearestX`/`nearestY` are OPTIONAL AND A PAIR: the Mod publishes them only for the map the actor stands on, because a
 * coordinate on another map is not an address. An absent tile is therefore rendered as ABSENT - never as `-1`, which the
 * Host refuses, and never as `undefined`.
 */
type CropWhereabouts = Readonly<{ location: string; count: number; nearestX?: number; nearestY?: number }>;

/** How many other maps the line names before it counts the rest. Three keeps it a line, and the rest is named. */
const MAX_NAMED_OTHER_MAPS = 3;

/**
 * The dry-crop line, read from the whole-map fact rather than the radius scan.
 *
 * `wateringWhereabouts` carries one row per loaded location that has dry crops. Three shapes, each said plainly:
 *
 *   somewhere        `34 on Farm (nearest 12,20); 12 on Greenhouse` - every map is named; this one carries its tile
 *   only elsewhere   `0 here; 12 on Farm`                          - "0" alone would report "nothing to do" in the one
 *                                                                    place the work is not, and another map's tile is not
 *                                                                    an address the companion can walk to
 *   nowhere          `none on any map`                             - a fact, not an absence
 *
 * Deterministic by construction: the rows are SORTED by location, never trusted in the wire array's own order, and a line
 * whose order changed while nothing in the world did would be both a cache invalidation and a false signal.
 */
function unwateredCropsOf(snapshot: Snapshot): string {
  return cropWhereaboutsOf(
    snapshot,
    (snapshot.wateringWhereabouts ?? []).map((row) => ({ ...row, count: row.needsWaterCount })),
  );
}

/** The same line for the crops that are ready to pick. */
function ripeCropsOf(snapshot: Snapshot): string {
  return cropWhereaboutsOf(
    snapshot,
    (snapshot.harvestWhereabouts ?? []).map((row) => ({ ...row, count: row.readyForHarvestCount })),
  );
}

function cropWhereaboutsOf(snapshot: Snapshot, rows: readonly CropWhereabouts[]): string {
  const ordered = [...rows].sort((left, right) =>
    left.location < right.location ? -1 : left.location > right.location ? 1 : 0,
  );
  const here = ordered.find((row) => row.location === snapshot.location);
  const elsewhere = ordered.filter((row) => row.location !== snapshot.location);
  if (here === undefined && elsewhere.length === 0) return "none on any map";

  const named = elsewhere.slice(0, MAX_NAMED_OTHER_MAPS).map((row) => `${row.count} on ${row.location}`);
  if (elsewhere.length > named.length) named.push(`(+${elsewhere.length - named.length} more maps)`);
  return [here === undefined ? "0 here" : describeCropWhereabouts(here), ...named].join("; ");
}

/**
 * One row: its count, its map, and - only for the map the actor stands on - the nearest tile.
 *
 * A coordinate for another map is deliberately never printed, even if one reaches this renderer: the Host accepts a
 * both-or-neither pair on any row, and printing it would present a place the companion cannot walk to.
 */
function describeCropWhereabouts(row: CropWhereabouts): string {
  if (row.nearestX === undefined || row.nearestY === undefined) return `${row.count} on ${row.location}`;
  return `${row.count} on ${row.location} (nearest ${row.nearestX},${row.nearestY})`;
}

function composeHud(lines: readonly Readonly<{ name: string; value: string }>[], omitted: readonly string[]): string {
  const rendered = lines.map((line) => `- ${line.name}: ${line.value}`);
  if (omitted.length > 0)
    rendered.push(
      `- omitted over ${MAX_SNAPSHOT_HUD_BYTES} bytes: ${omitted.join(", ")} (bound the value at its source)`,
    );
  return `[State HUD:\n${rendered.join("\n")}\n]`;
}

/** Renders a Stardew time-of-day int (e.g. 2350) as HH:MM (23:50). */
export function formatGameClock(timeOfDay: number): string {
  if (!Number.isInteger(timeOfDay) || timeOfDay < 0 || timeOfDay > 2600) return `${timeOfDay}`;
  const hours = Math.floor(timeOfDay / 100);
  const minutes = timeOfDay % 100;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The season's own name, spelled once for every renderer that prints a calendar. */
export function seasonName(seasonIndex: number): string {
  return ["Spring", "Summer", "Fall", "Winter"][seasonIndex] ?? "Unknown";
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
