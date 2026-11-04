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
      "- unwatered crops: 2 in reach",
      "]",
    ].join("\n"),
  );
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
