import assert from "node:assert/strict";
import test from "node:test";

import { SNAPSHOT_KEYS, type Snapshot } from "./protocol.js";
import { projectGameSnapshotContext } from "./snapshot-projection.js";
import { formatSnapshotHud, MAX_SNAPSHOT_HUD_BYTES, SNAPSHOT_HUD_LINES } from "./snapshot-hud.js";

const baseSnapshot: Snapshot = {
  revision: 7,
  location: "Farm",
  tile: { x: 5, y: 10 },
  stamina: 82,
  health: 100,
  actionable: true,
  capabilities: ["water_crop", "till_soil"],
  catalogRevision: 3,
  enabledActionIds: ["water_crop"],
  presentationLocale: "en-US",
  exhausted: false,
  timeOfDay: 620,
  dayOfMonth: 3,
  seasonIndex: 0,
  year: 1,
  weather: "rain",
  currentTool: "Hoe",
  currentToolSlot: 1,
  currentToolSlotItem: "(H)21",
  inventorySlots: 12,
  soilTiles: [{ x: 4, y: 10 }],
  toolSlots: [{ slot: 1, label: "Hoe" }],
  cropTargets: [
    { targetId: "crop_1", x: 4, y: 10, cropId: "24", displayName: "Cauliflower" },
    { targetId: "crop_2", x: 5, y: 10, cropId: "24", displayName: "Cauliflower" },
  ],
  // The whole-map rows the Mod sends alongside the radius scan. A fixture without them describes a world the Mod cannot
  // produce, and they are exactly the rows the crop lines read.
  wateringWhereabouts: [{ location: "Farm", needsWaterCount: 2, nearestX: 4, nearestY: 10 }],
  harvestWhereabouts: [{ location: "Farm", readyForHarvestCount: 3, nearestX: 12, nearestY: 20 }],
};

function lineValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const match = /^- (.+?): ([\s\S]*)$/u.exec(raw);
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2]);
  }
  return values;
}

function changedLineNames(before: string, after: string): readonly string[] {
  const left = lineValues(before);
  const right = lineValues(after);
  return [...new Set([...left.keys(), ...right.keys()])].filter((name) => left.get(name) !== right.get(name)).sort();
}

test("the state block is byte-identical for two turns in the same world", () => {
  const first = formatSnapshotHud(baseSnapshot);
  const second = formatSnapshotHud(baseSnapshot);
  // A structurally equal but distinct snapshot must render the same bytes too: the block is composed from
  // state, never from object identity.
  const clone = formatSnapshotHud(JSON.parse(JSON.stringify(baseSnapshot)) as Snapshot);

  assert.equal(first, second);
  assert.equal(first, clone);
  // What the harness renders for one real snapshot, pinned so a change to the block is a visible diff.
  assert.equal(
    first,
    [
      "[State HUD:",
      "- time: 06:20",
      "- calendar: Spring, day 3, year 1",
      "- weather: rain",
      "- where: Farm at (5, 10)",
      "- body: free",
      "- stamina: 82",
      "- health: 100",
      "- exhausted: no",
      "- held tool: Hoe in slot 1",
      "- unwatered crops: 2 on Farm (nearest 4,10)",
      "- ripe crops: 3 on Farm (nearest 12,20)",
      "- mine ladders: none here",
      "- mailbox: none here",
      "- refill water: none here",
      "- fishable water: none here",
      "- shop: none here",
      "- mine floors: none here",
      "]",
    ].join("\n"),
  );
});

test("two different worlds render two different blocks, so a stale rebuild is detectable", () => {
  // The block is composed once per snapshot and re-sent verbatim into every later turn, so the question this pins is
  // whether a block built from a snapshot the companion has left can be told apart from one built from the world it
  // stands in now. Two snapshots, one clock line and one where line apart, must not render the same bytes.
  const before = formatSnapshotHud(baseSnapshot);
  const after = formatSnapshotHud({
    ...baseSnapshot,
    timeOfDay: 2_200,
    location: "FarmHouse",
    tile: { x: 9, y: 9 },
  });

  assert.notEqual(after, before);
  assert.equal(lineValues(after).get("time"), "22:00");
  assert.equal(lineValues(after).get("where"), "FarmHouse at (9, 9)");
});

/**
 * The defect: a block printed from a snapshot nobody refreshed.
 *
 * Measured 2026-11-05 (`2026-11-05T11-37-35-764Z-multiday_routine`): six consecutive turns were handed the same
 * `time: 18:00` / `where: Farm at (70, 13)` block. A warp into the FarmHouse had already been receipted and the 22:00
 * milestone had arrived - the model's own reasoning read "It's 22:00 now" in the same turn the block said 18:00 - so
 * it waited instead of sleeping and the run ended `companion_did_not_sleep`. Nothing refreshes a snapshot between
 * turns (`local-stardew-bridge.ts#acceptSnapshot`: the protocol has no unsolicited push), so the block has to say how
 * old the reading it prints is.
 */
test("a block printed from an older snapshot names the clock it is speaking about", () => {
  const current = formatSnapshotHud(baseSnapshot);
  const aged = formatSnapshotHud(baseSnapshot, 3);

  assert.equal(lineValues(aged).get("time"), "06:20 (observed 3 turns ago - not the current world)");
  assert.equal(lineValues(aged).get("where"), "Farm at (5, 10) (observed 3 turns ago - not the current world)");
  // The unqualified line is exactly what let a three-turn-old clock be read as now.
  assert.doesNotMatch(aged, /^- time: \d\d:\d\d$/mu);
  // Age zero IS the current reading, and it stays the bare line.
  assert.equal(lineValues(current).get("time"), "06:20");
  assert.doesNotMatch(current, /turns? ago/u);
});

test("the same snapshot at the same age renders byte-identically", () => {
  const first = formatSnapshotHud(baseSnapshot, 3);
  const clone = formatSnapshotHud(JSON.parse(JSON.stringify(baseSnapshot)) as Snapshot, 3);

  assert.equal(first, clone);
  // Only the age separates two renderings of one snapshot: the clause is a function of the snapshot and the turn
  // count, never of a wall clock or of how long the process has been up.
  assert.notEqual(formatSnapshotHud(baseSnapshot, 4), first);
  assert.match(formatSnapshotHud(baseSnapshot, 1), /\(observed 1 turn ago/u);
});

test("a spent stamina moves exactly one line and nothing else", () => {
  const before = formatSnapshotHud(baseSnapshot);
  const after = formatSnapshotHud({ ...baseSnapshot, stamina: 12 });

  assert.deepEqual(changedLineNames(before, after), ["stamina"]);
  assert.equal(lineValues(after).get("stamina"), "12");
  // The change is a substitution, not a reflow: same line count, same order.
  assert.deepEqual([...lineValues(after).keys()], [...lineValues(before).keys()]);
});

test("the size cap holds, and names the line that grew", () => {
  const runaway = formatSnapshotHud({ ...baseSnapshot, location: "Farm".repeat(2_000) });

  assert.ok(
    Buffer.byteLength(runaway, "utf8") <= MAX_SNAPSHOT_HUD_BYTES,
    `state block must stay inside ${MAX_SNAPSHOT_HUD_BYTES} bytes, got ${Buffer.byteLength(runaway, "utf8")}`,
  );
  // The failure names the field: silence would leave the next reader raising the cap instead of bounding
  // the value at the source that produced it.
  assert.match(runaway, /omitted over 1200 bytes: where /u);
  // Everything that did fit is still there.
  assert.equal(lineValues(runaway).get("stamina"), "82");
});

test("every printed field is a declared snapshot field, and no line reads an undeclared one", () => {
  const declared = new Set<string>(SNAPSHOT_HUD_LINES.flatMap((line) => line.fields as readonly string[]));
  const namesFor = (key: string): readonly string[] =>
    SNAPSHOT_HUD_LINES.filter((line) => (line.fields as readonly string[]).includes(key)).map((line) => line.name);
  // A probe per field the block declares. Also the positive direction of the gate: the block must READ these,
  // not print a constant that happens to match today's fixture.
  const declaredProbes = new Map<string, unknown>([
    ["timeOfDay", 1_250],
    ["seasonIndex", 1],
    ["dayOfMonth", 2],
    ["year", 2],
    ["weather", "snow"],
    ["location", "FarmHouse"],
    ["tile", { x: 9, y: 8 }],
    ["actionable", false],
    ["actorDispositionKind", "modal"],
    ["stamina", 42],
    ["health", 21],
    ["exhausted", true],
    ["currentTool", "Axe"],
    ["currentToolSlot", 2],
    ["cropTargets", []],
    // The whole-map row the unwatered line reads. A probe that moves it to a DIFFERENT map is the only one that can tell
    // "read from this field" apart from "printed the figure" - the base row is already Farm, so replacing it with another
    // Farm row would change no bytes.
    ["wateringWhereabouts", [{ location: "Desert", needsWaterCount: 7, nearestX: 3, nearestY: 4 }]],
    // The ripe-crop row, probed the same way and for the same reason: an off-map row is the only probe that can tell
    // "read from this field" apart from "printed the base fixture's figure".
    ["harvestWhereabouts", [{ location: "Desert", readyForHarvestCount: 7 }]],
    ["mineEntranceTargets", [{ targetId: "mine_entrance_0123456789abcdef", x: 12, y: 3 }]],
    ["mailboxTargets", [{ targetId: "mailbox_0123456789abcdef", location: "Farm", x: 3, y: 4, pendingCount: 2 }]],
    ["refillWateringCanTargets", [{ targetId: "watering_can_refill_0123456789abcdef", x: 12, y: 3 }]],
    // The water a rod may be cast at. The id is what `fish_here` demands verbatim, so the probe is the whole row: an
    // empty array would only prove the line exists.
    ["waterTargets", [{ targetId: "water_0123456789abcdef", x: 12, y: 3 }]],
    [
      "shopTargets",
      [
        {
          targetId: "shop_0123456789abcdef",
          shopId: "SeedShop",
          ownerName: "Pierre",
          location: "Farm",
          ownerTileX: 4,
          ownerTileY: 5,
          ownerInReach: false,
          stockCount: 34,
        },
      ],
    ],
    [
      "mineElevatorFloorTargets",
      [{ targetId: "mine_elevator_5_0123456789abcdef", floor: 5, isCurrentFloor: false, isMineEntrance: false }],
    ],
  ]);
  // The fixture carries no `actorDispositionKind`, so `actionable` is the field that decides the body line. A
  // disposition would shadow it, and the gate would then be silent about a declared field that stopped being read.
  const base = formatSnapshotHud(baseSnapshot);

  for (const key of SNAPSHOT_KEYS) {
    const probe = declaredProbes.get(key);
    const mutated = formatSnapshotHud({ ...baseSnapshot, [key]: probe ?? ["unread"] } as unknown as Snapshot);
    const changed = changedLineNames(base, mutated);

    if (!declared.has(key)) {
      // The population comes from the protocol's own key list, so this holds for fields nobody has added to
      // the block yet - which is the point: a line may not start reading one without declaring it.
      assert.deepEqual(changed, [], `${key} changed ${changed.join(", ")} although no HUD line declares it`);
      continue;
    }
    assert.ok(probe !== undefined, `${key} is declared by a HUD line but has no probe`);
    assert.notEqual(changed.length, 0, `${key} is declared by ${namesFor(key).join(", ")} but changed no line`);
    assert.deepEqual(
      changed.filter((name) => !namesFor(key).includes(name)),
      [],
      `${key} changed a line that does not declare it`,
    );
  }
});

test("the state block stays out of the snapshot projection's own detail text", () => {
  const projection = projectGameSnapshotContext(baseSnapshot, 10_000, 10_250);
  assert.equal(projection.available, true);
  if (!projection.available) return;

  // Two renderings of one snapshot, and they must not be confused for one another: `text` describes the moment
  // that was observed (and leaves the weather to the turn-level environment line), while the standing state block
  // is attached beside it by the fact builder and re-sent every turn.
  assert.doesNotMatch(projection.text, /State HUD/u);
  assert.doesNotMatch(projection.text, /rain/u);
  // One spelling of the clock: both renderers share the formatter.
  assert.match(projection.text, /Time: 06:20/u);
  assert.match(formatSnapshotHud(baseSnapshot), /time: 06:20/u);
});
test("the dry-crop line counts the whole map, not the radius scan", () => {
  // The defect this pins: `cropTargets` is a radius-6 entity scan, so a companion standing in its own house read "0 in reach"
  // with dry crops outside, and a live run spent an afternoon in Town with full stamina on an unwatered farm. The whole-map
  // fact was already being sent; the line simply did not read it.
  const here = formatSnapshotHud({
    ...baseSnapshot,
    wateringWhereabouts: [{ location: "Farm", needsWaterCount: 34, nearestX: 12, nearestY: 20 }],
  });
  assert.equal(lineValues(here).get("unwatered crops"), "34 on Farm (nearest 12,20)");
});

test("dry crops on another map are reported, never folded into a zero", () => {
  // Standing in Town with a dry farm: "0" alone would say "nothing to do" in the one place the work is not.
  const elsewhere = formatSnapshotHud({
    ...baseSnapshot,
    location: "Town",
    wateringWhereabouts: [{ location: "Farm", needsWaterCount: 12, nearestX: 30, nearestY: 8 }],
  });
  // And a coordinate on ANOTHER map is never printed even when the row carries one: (30,8) is a tile on the Farm, not a
  // place the companion standing in Town can walk to.
  assert.equal(lineValues(elsewhere).get("unwatered crops"), "0 here; 12 on Farm");
});

test("a dry Greenhouse does not hide behind a dry Farm", () => {
  // The line printed the FIRST other-map row, so one dry map was named and the rest were invisible - two dry maps read as
  // one, and the number the model acted on was whichever the wire happened to list first.
  const both = formatSnapshotHud({
    ...baseSnapshot,
    location: "FarmHouse",
    wateringWhereabouts: [{ location: "Farm", needsWaterCount: 12 }],
    harvestWhereabouts: [],
  });
  const greenhouse = formatSnapshotHud({
    ...baseSnapshot,
    location: "FarmHouse",
    wateringWhereabouts: [
      { location: "Farm", needsWaterCount: 12 },
      { location: "Greenhouse", needsWaterCount: 4 },
    ],
    harvestWhereabouts: [],
  });
  assert.equal(lineValues(both).get("unwatered crops"), "0 here; 12 on Farm");
  assert.equal(lineValues(greenhouse).get("unwatered crops"), "0 here; 12 on Farm; 4 on Greenhouse");
});

test("the crop lines name three other maps and count the rest", () => {
  const many = formatSnapshotHud({
    ...baseSnapshot,
    location: "Town",
    wateringWhereabouts: [
      { location: "Farm", needsWaterCount: 12 },
      { location: "Greenhouse", needsWaterCount: 4 },
      { location: "IslandWest", needsWaterCount: 2 },
      { location: "Desert", needsWaterCount: 1 },
      { location: "Forest", needsWaterCount: 6 },
    ],
    harvestWhereabouts: [],
  });
  const rendered = lineValues(many).get("unwatered crops") ?? "";
  assert.match(rendered, /\(\+2 more maps\)$/u, "three named, two counted - never silently dropped");
  assert.ok(
    Buffer.byteLength(many, "utf8") <= MAX_SNAPSHOT_HUD_BYTES,
    `the block must stay inside ${MAX_SNAPSHOT_HUD_BYTES} bytes`,
  );
});

test("a whereabouts row without a coordinate renders without one, never as undefined or -1", () => {
  // This is the shape the Mod publishes for every map the companion is NOT standing on. Its count is the fact; its tile is
  // not an address, so it is ABSENT - and an absent number must never leak into the block as `undefined` or as the magic
  // `-1` a reader would then treat as a place.
  const offMap = formatSnapshotHud({
    ...baseSnapshot,
    location: "FarmHouse",
    wateringWhereabouts: [{ location: "Farm", needsWaterCount: 12 }],
    harvestWhereabouts: [{ location: "Farm", readyForHarvestCount: 3 }],
  });
  assert.equal(lineValues(offMap).get("unwatered crops"), "0 here; 12 on Farm");
  assert.equal(lineValues(offMap).get("ripe crops"), "0 here; 3 on Farm");
  assert.doesNotMatch(offMap, /undefined|NaN|-1\)|nearest -1/u);
});

test("the whereabouts arrays are sorted, so the wire's own order cannot change the block", () => {
  // The Mod orders these rows by location, and the block must not depend on that being true: a reordered array is the same
  // world, so it must be the same bytes - otherwise the cached history prefix changes and the model reads it as movement.
  const rows = {
    wateringWhereabouts: [
      { location: "Farm", needsWaterCount: 12 },
      { location: "Greenhouse", needsWaterCount: 4 },
      { location: "Desert", needsWaterCount: 1 },
    ],
    harvestWhereabouts: [
      { location: "Farm", readyForHarvestCount: 3 },
      { location: "Greenhouse", readyForHarvestCount: 8 },
      { location: "Desert", readyForHarvestCount: 2 },
    ],
  };
  const ordered = formatSnapshotHud({ ...baseSnapshot, location: "FarmHouse", ...rows });
  const reversed = formatSnapshotHud({
    ...baseSnapshot,
    location: "FarmHouse",
    wateringWhereabouts: [...rows.wateringWhereabouts].reverse(),
    harvestWhereabouts: [...rows.harvestWhereabouts].reverse(),
  });
  assert.equal(reversed, ordered);
  assert.equal(formatSnapshotHud({ ...baseSnapshot, location: "FarmHouse", ...rows }), ordered);
  assert.equal(lineValues(ordered).get("unwatered crops"), "0 here; 1 on Desert; 12 on Farm; 4 on Greenhouse");
  assert.equal(lineValues(ordered).get("ripe crops"), "0 here; 2 on Desert; 3 on Farm; 8 on Greenhouse");
});

test("ripe crops are a per-turn fact, in the three shapes the dry-crop line already uses", () => {
  const here = formatSnapshotHud({
    ...baseSnapshot,
    location: "Farm",
    harvestWhereabouts: [{ location: "Farm", readyForHarvestCount: 9, nearestX: 2, nearestY: 7 }],
  });
  assert.equal(lineValues(here).get("ripe crops"), "9 on Farm (nearest 2,7)");

  const none = formatSnapshotHud({ ...baseSnapshot, harvestWhereabouts: [] });
  assert.equal(lineValues(none).get("ripe crops"), "none on any map");

  const both = formatSnapshotHud({
    ...baseSnapshot,
    location: "Farm",
    harvestWhereabouts: [
      { location: "Farm", readyForHarvestCount: 9, nearestX: 2, nearestY: 7 },
      { location: "Greenhouse", readyForHarvestCount: 4 },
    ],
  });
  assert.equal(lineValues(both).get("ripe crops"), "9 on Farm (nearest 2,7); 4 on Greenhouse");
});

test("a ripe crop count moves its own line and the dry-crop line stays where it was", () => {
  const before = formatSnapshotHud(baseSnapshot);
  const after = formatSnapshotHud({
    ...baseSnapshot,
    harvestWhereabouts: [{ location: "Farm", readyForHarvestCount: 4, nearestX: 12, nearestY: 20 }],
  });
  assert.deepEqual(changedLineNames(before, after), ["ripe crops"]);
});

test("no dry crops anywhere is stated as a fact, not left blank", () => {
  const none = formatSnapshotHud({ ...baseSnapshot, wateringWhereabouts: [] });
  assert.equal(lineValues(none).get("unwatered crops"), "none on any map");
});

test("the dry-crop line ignores the cropTargets count when the whole-map fact disagrees", () => {
  // Two spellings of one fact is the failure mode here: if the radius scan says 2 and the map says 34, 34 is the answer.
  const both = formatSnapshotHud({
    ...baseSnapshot,
    cropTargets: [
      { targetId: "crop_1", x: 4, y: 10, cropId: "24", displayName: "Cauliflower" },
      { targetId: "crop_2", x: 5, y: 10, cropId: "24", displayName: "Cauliflower" },
    ],
    wateringWhereabouts: [{ location: "Farm", needsWaterCount: 34, nearestX: 12, nearestY: 20 }],
  });
  const rendered = lineValues(both).get("unwatered crops") ?? "";
  assert.match(rendered, /34/u);
  assert.doesNotMatch(rendered, /in reach/u, "the radius answer must not survive beside the whole-map one");
});

/**
 * The two map-fixed lines, and the three constraints every line here obeys: bounded, fixed order, byte-identical while
 * the world is unchanged.
 *
 * The defect they pin is one quadrant error, twice: a fact that belongs to the MAP was delivered as if it belonged to a
 * radius around the actor, so the only way to ask was a 6.9k-token `stardew_observe` - in a mine shaft, at 01:00, which is
 * precisely where the companion gets lost.
 */
const mineSnapshot: Snapshot = {
  ...baseSnapshot,
  location: "UndergroundMine",
  mineEntranceTargets: [
    { targetId: "mine_entrance_ffffffffffffffff", x: 15, y: 9 },
    { targetId: "mine_entrance_0123456789abcdef", x: 12, y: 3 },
  ],
};

test("a mine's ladders are named every turn, sorted by tile rather than by array order", () => {
  const rendered = lineValues(formatSnapshotHud(mineSnapshot)).get("mine ladders");
  assert.equal(
    rendered,
    "mine_entrance_0123456789abcdef at (12, 3), mine_entrance_ffffffffffffffff at (15, 9)",
    "the ids are what `use_mine_ladder` takes, and the order is the tile's, not the wire array's",
  );

  // Same two ladders, the other way round on the wire: one unchanged world must render one unchanged block.
  const reordered = formatSnapshotHud({
    ...mineSnapshot,
    mineEntranceTargets: [...(mineSnapshot.mineEntranceTargets ?? [])].reverse(),
  });
  assert.equal(reordered, formatSnapshotHud(mineSnapshot));
});

test("the ladder line is bounded at the source, and counts what it does not print", () => {
  const many = formatSnapshotHud({
    ...mineSnapshot,
    mineEntranceTargets: Array.from({ length: 9 }, (_, index) => ({
      targetId: `mine_entrance_${String(index).padStart(16, "0")}`,
      x: index,
      y: 0,
    })),
  });
  const rendered = lineValues(many).get("mine ladders") ?? "";
  assert.match(rendered, /\+5 more$/u, "four rows printed, five counted - never silently dropped");
  assert.ok(
    Buffer.byteLength(rendered, "utf8") < 260,
    `the ladder line must stay small, got ${Buffer.byteLength(rendered, "utf8")} bytes`,
  );
  assert.ok(Buffer.byteLength(many, "utf8") <= MAX_SNAPSHOT_HUD_BYTES);
});

test("outside a mine the ladder line says so, and the mailbox line names only this location's box", () => {
  assert.equal(lineValues(formatSnapshotHud(baseSnapshot)).get("mine ladders"), "none here");

  const here = lineValues(
    formatSnapshotHud({
      ...baseSnapshot,
      mailboxTargets: [
        { targetId: "mailbox_ffffffffffffffff", location: "Town", x: 9, y: 9, pendingCount: 1 },
        { targetId: "mailbox_0123456789abcdef", location: "Farm", x: 3, y: 4, pendingCount: 2 },
      ],
    }),
  ).get("mailbox");
  assert.equal(here, "2 pending at (3, 4) mailbox_0123456789abcdef");
  assert.equal(lineValues(formatSnapshotHud(baseSnapshot)).get("mailbox"), "none here");
});

test("the mailbox line changes when mail arrives and not before", () => {
  const one = formatSnapshotHud({
    ...baseSnapshot,
    mailboxTargets: [{ targetId: "mailbox_0123456789abcdef", location: "Farm", x: 3, y: 4, pendingCount: 2 }],
  });
  const again = formatSnapshotHud({
    ...baseSnapshot,
    mailboxTargets: [{ targetId: "mailbox_0123456789abcdef", location: "Farm", x: 3, y: 4, pendingCount: 2 }],
  });
  assert.equal(one, again);
  const more = formatSnapshotHud({
    ...baseSnapshot,
    // The id is hashed from the pending count and the head letter, so new mail is a new id: the line follows the world.
    mailboxTargets: [{ targetId: "mailbox_ffffffffffffffff", location: "Farm", x: 3, y: 4, pendingCount: 3 }],
  });
  assert.deepEqual(changedLineNames(one, more), ["mailbox"]);
});

/**
 * The refill-water line: the third map-fixed family an action targets, and the same quadrant error as the other two.
 *
 * `refillWateringCanTargets` is a whole-map scan of the engine's own `CanRefillWateringCanOnTile`, so a pond outside
 * the entity radius is invisible to `cropTargets` and nothing moved it into the per-turn block - `refill_watering_can`
 * names `expectedTargetId`, and the id only ever arrived in an observe of the whole map.
 */
const refillSnapshot: Snapshot = {
  ...baseSnapshot,
  refillWateringCanTargets: [
    { targetId: "watering_can_refill_ffffffffffffffff", x: 40, y: 41 },
    { targetId: "watering_can_refill_0123456789abcdef", x: 9, y: 11 },
  ],
};

test("the nearest water on this map is named every turn, by the actor's tile rather than the wire's order", () => {
  const rendered = lineValues(formatSnapshotHud(refillSnapshot)).get("refill water");
  assert.equal(
    rendered,
    "nearest (9, 11) watering_can_refill_0123456789abcdef (+1 more)",
    "the nearest row is what a refill plan walks to, and the rest are counted rather than dropped",
  );

  // One unchanged world, the wire array the other way round: the block is folded into the cached history, so it must
  // render the same bytes. The Mod sorts nearest-first, but an order that arrived on the wire is not a fact to trust.
  const reordered = formatSnapshotHud({
    ...refillSnapshot,
    refillWateringCanTargets: [...(refillSnapshot.refillWateringCanTargets ?? [])].reverse(),
  });
  assert.equal(reordered, formatSnapshotHud(refillSnapshot));
});

test("a map with no water states it, and states it in the same bytes twice", () => {
  // Empty is a fact (this map has no tile the engine refills from), never an empty string: a blank value reads as
  // "no opinion" and sends the model to an observe to find out which it is.
  const dry = formatSnapshotHud({ ...baseSnapshot, refillWateringCanTargets: [] });
  assert.equal(lineValues(dry).get("refill water"), "none here");
  // Absent and empty are one world: the Mod sends the family only while `refill_watering_can` is advertised.
  assert.equal(formatSnapshotHud(baseSnapshot), dry);
  assert.equal(formatSnapshotHud({ ...baseSnapshot, refillWateringCanTargets: [] }), dry);

  const one = formatSnapshotHud(refillSnapshot);
  assert.equal(lineValues(one).get("refill water")?.startsWith("nearest (9, 11) "), true);
  assert.ok(
    Buffer.byteLength(lineValues(one).get("refill water") ?? "", "utf8") < 90,
    "one row plus a count, bound at the source",
  );
});

/**
 * The fishable-water line: the fourth map-fixed family an action targets, and the one whose id cannot be derived.
 *
 * `waterTargets` is `DiscoverWaterTargets` - a whole-map scan of the engine's own `canFishHere` + `isTileFishable` pair,
 * kept where a cardinal neighbour is standable - and `fish_here` refuses a cast unless `expectedTargetId` names the tile
 * it was handed. So a snapshot that does not print the id leaves a fishing day with no address until a whole-map observe.
 * Unlike the crop lines there is no second family whose value would do: `refillWateringCanTargets` covers the same water
 * with a different hash, and the cast recomputes and compares its own.
 */
const waterSnapshot: Snapshot = {
  ...baseSnapshot,
  waterTargets: [
    { targetId: "water_ffffffffffffffff", x: 40, y: 41 },
    { targetId: "water_0123456789abcdef", x: 6, y: 12 },
  ],
};

test("the nearest castable water is named every turn, by the actor's tile rather than the wire's order", () => {
  assert.equal(
    lineValues(formatSnapshotHud(waterSnapshot)).get("fishable water"),
    "nearest (6, 12) water_0123456789abcdef (+1 more)",
    "the id is what `fish_here` takes, and the nearest is the actor's own tile's answer",
  );

  // One unchanged world, the wire array the other way round: the block is folded into the cached history, so it must
  // render the same bytes.
  const reordered = formatSnapshotHud({
    ...waterSnapshot,
    waterTargets: [...(waterSnapshot.waterTargets ?? [])].reverse(),
  });
  assert.equal(reordered, formatSnapshotHud(waterSnapshot));
});

test("no castable water is stated as a fact, and the two water lines stay two facts", () => {
  const none = formatSnapshotHud({ ...baseSnapshot, waterTargets: [] });
  assert.equal(lineValues(none).get("fishable water"), "none here");
  // Absent and empty are one world: the Mod sends the family only while `fish_here` is advertised.
  assert.equal(formatSnapshotHud(baseSnapshot), none);

  // Both lines read the nearest row of their OWN family: they are not two spellings of one tile, because the ids are
  // hashed by different actions and only one of the two is accepted by a cast.
  const both = lineValues(
    formatSnapshotHud({
      ...waterSnapshot,
      refillWateringCanTargets: [{ targetId: "watering_can_refill_aaaaaaaaaaaaaaaa", x: 9, y: 11 }],
    }),
  );
  assert.equal(both.get("fishable water"), "nearest (6, 12) water_0123456789abcdef (+1 more)");
  assert.equal(both.get("refill water"), "nearest (9, 11) watering_can_refill_aaaaaaaaaaaaaaaa");
});

test("the fishable-water line is bounded at one row, whatever the family's own cap sends", () => {
  // The Mod caps `waterTargets` at 32 and the Host validates that cap, so the widest world this line can be handed is 32
  // rows: printing them would pay ~700 bytes every turn for one cast.
  const atCap = Array.from({ length: 32 }, (_, index) => ({
    targetId: `water_${String(index).padStart(16, "0")}`,
    x: index,
    y: 0,
  }));
  const text = formatSnapshotHud({ ...baseSnapshot, waterTargets: atCap });
  const line = lineValues(text).get("fishable water") ?? "";
  assert.match(line, /\(\+31 more\)$/u, "one row printed, thirty-one counted - never silently dropped");
  assert.ok(Buffer.byteLength(line, "utf8") < 90, `one row plus a count, bound at the source; got ${line}`);
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_SNAPSHOT_HUD_BYTES);
});
