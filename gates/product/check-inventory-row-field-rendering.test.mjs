/**
 * The falsifiers for `check-inventory-row-field-rendering.mjs`.
 *
 * Every case mutates a COPY of the tree the gate reads and asks the gate for its verdict, so what is measured is the
 * gate's own reading of files, not a re-implementation of it. The claims under test:
 *
 *   1. THE TREE PASSES, and the population is derived from authorities - the wire schema's row records, the Host
 *      validator's argument names, the row renderer's own claim/placement/value declarations, and a scan of every module
 *      that reads the pack family. Nothing here lists a renderer the scan would not find, or a field the schema would
 *      not.
 *   2. THE MEMBER IS NAMED, PER RENDERER AND PER FAMILY. Deleting one composer's slot interpolation is
 *      `inventory_row_field_dropped:slot:inventoryItemFacts:<composer>` even while the sibling still prints it.
 *   3. THE SHIPPED DEFECT IS RED. The row renderer as `round62` ran it - `ROW_TILE_FIELD_PAIRS` narrowed to `x`/`y` -
 *      is `inventory_row_field_dropped:sourceX:doorTargets:nearbyTargetFamilies` and the same for `sourceY`: the door
 *      was in range, the wire published it, and the family printed on neither line. That is a real defect replayed, not
 *      a synthetic one.
 *   4. THE STATE HALF IS CHECKED, not believed. Deleting `candidate[state.field]` from the renderer, or declaring a
 *      value the wire does not publish, is red.
 *   5. THE POPULATION IS DERIVED, both ways. A tile spelling added to a row record is demanded with no edit here; a
 *      schema whose pack fields no argument names is BLOCKED, and so is a renderer the gate cannot find.
 *
 * red-proof: inject  `ROW_TILE_FIELD_PAIRS` narrowed to `x`/`y` (the renderer `round62` ran) -> `sourceX`/`sourceY` at
 *   `doorTargets` (this suite)
 * red-proof: inject  one composer's slot interpolation deleted in a copy of the tree -> `inventory_row_field_dropped`
 *   naming that composer, while the sibling composer still prints the field (this suite)
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  auditInventoryRowFields,
  declaredStateFields,
  declaredTilePairs,
  demandedRowFields,
  interpolations,
  printsField,
  READER_DISPOSITIONS,
  ROW_FAMILY_RENDERER,
  wireTileSpellings,
  WITHHELD_TILE_SPELLINGS,
} from "./check-inventory-row-field-rendering.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);

/**
 * The files the gate reads, as paths relative to a root.
 *
 * These are every module with a disposition in `READER_DISPOSITIONS` - a fixture that omitted one would redden
 * `inventory_row_field_reader_stale` for a reason the case did not inject - plus the row renderer whose declarations the
 * crossing is built from.
 */
const FIXTURE_FILES = Object.freeze([
  "protocol/bridge-v1.schema.json",
  "host/src/protocol.ts",
  ROW_FAMILY_RENDERER.path,
  ...Object.keys(READER_DISPOSITIONS),
]);

/** A copied tree the gate can be pointed at, so an injected defect is the only difference from the real one. */
function fixtureTree(t) {
  const root = mkdtempSync(join(tmpdir(), "inventory-row-field-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of FIXTURE_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPOSITORY_ROOT, file), join(root, file));
  }
  return root;
}

/** Rewrite one file in a fixture tree by substitution; a substitution that changed nothing is a broken fixture. */
function rewrite(root, path, replace) {
  const target = join(root, path);
  const before = readFileSync(target, "utf8");
  const after = replace(before);
  assert.notEqual(after, before, `the fixture injection changed nothing in ${path}, so the case proves nothing`);
  writeFileSync(target, after);
}

const codes = (reading) => reading.violations.map((violation) => violation.code);

test("the tree passes: every renderer places every family it claims and prints every field it owes", () => {
  const reading = auditInventoryRowFields({ root: REPOSITORY_ROOT });
  assert.equal(reading.status, "passed", `the real tree is red: ${codes(reading).join(", ")}`);
  // The population is printed, not assumed: a run that crossed nothing would pass every assertion below it.
  assert.ok(reading.examined > 0, "the gate crossed no renderer with a field, which is a blocked reading");
  assert.ok(
    reading.families >= 70,
    `the per-turn line claims ${String(reading.families)} families: the claim table was read as something smaller`,
  );
  assert.ok(
    reading.rowFields > 100,
    `the crossing examined ${String(reading.rowFields)} row fields: the row records were read as something smaller`,
  );
  // TWO SPELLINGS OF ONE FACT are in the table, one of them the door's: this is the pair that made the shipped defect
  // possible, and a run that read only `x`/`y` would still pass every other assertion here. `ownerTileX`/`ownerTileY`
  // is the third: a shop's rows carry no `x`/`y` at all, and the tile its keeper stands on is where the actor has to be
  // before the counter opens.
  assert.deepEqual(reading.tilePairs, [
    ["x", "y"],
    ["sourceX", "sourceY"],
    ["ownerTileX", "ownerTileY"],
  ]);
  assert.ok(
    reading.placeable.includes("shopTargets"),
    `\`shopTargets\` publishes \`ownerTileX\`/\`ownerTileY\` so its hours and stock can be read off the line: ${reading.placeable.join(", ")}`,
  );
  assert.ok(
    reading.placeable.includes("doorTargets"),
    `\`doorTargets\` publishes \`sourceX\`/\`sourceY\` and the renderer must place it: ${reading.placeable.join(", ")}`,
  );
  // ...and the families it CANNOT place are counted rather than dropped, which is the third defect in `round62`'s
  // falsifier: a family with rows printed on neither the populated line nor the empty one.
  assert.ok(
    reading.placeable.length < reading.families,
    "every claimed family being placeable would mean the omission count is untested by this tree",
  );
  // The pack family's own crossing is unchanged: slot and id are demanded by actions and printed by both composers.
  assert.ok(reading.demanded.includes("slot"), `the pack row's slot is demanded: ${reading.demanded.join(", ")}`);
  assert.equal(reading.demanded.includes("displayName"), false, "no action argument names `displayName`");
  assert.equal(reading.demanded.includes("stack"), false, "no action argument names `stack`");
  for (const state of reading.states)
    assert.ok(
      reading.claimedFamilies.includes(state.family),
      `a declared value for ${state.family} needs the line to claim that family`,
    );
});

test("the renderer as `round62` ran it drops the door, and the finding names sourceX/sourceY", (t) => {
  const root = fixtureTree(t);
  rewrite(root, ROW_FAMILY_RENDERER.path, (source) =>
    source.replace('  Object.freeze(["sourceX", "sourceY"] as const),\n', ""),
  );
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), [
    "inventory_row_field_dropped:sourceX:doorTargets:nearbyTargetFamilies",
    "inventory_row_field_dropped:sourceY:doorTargets:nearbyTargetFamilies",
  ]);
  const detail = reading.violations[0].detail;
  assert.match(detail, /doorTargets/u, "the finding names the family to open");
  assert.match(detail, /sourceX\/sourceY/u, "and the pair the wire publishes");
  assert.match(detail, /WITHHELD_TILE_SPELLINGS/u, "and the two ways to make it green");
});

test("a tile spelling the wire grows is demanded with no edit here", (t) => {
  const root = fixtureTree(t);
  rewrite(root, "protocol/bridge-v1.schema.json", (source) => {
    const schema = JSON.parse(source);
    schema.$defs.weedTarget.properties.gridX = { type: "integer" };
    schema.$defs.weedTarget.properties.gridY = { type: "integer" };
    return JSON.stringify(schema, null, 1);
  });
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), [
    "inventory_row_field_dropped:gridX:weedTargets:nearbyTargetFamilies",
    "inventory_row_field_dropped:gridY:weedTargets:nearbyTargetFamilies",
  ]);
});

test("a spelling the renderer starts reading makes its exemption expire", (t) => {
  const root = fixtureTree(t);
  rewrite(root, ROW_FAMILY_RENDERER.path, (source) =>
    source.replace(
      '  Object.freeze(["sourceX", "sourceY"] as const),\n',
      '  Object.freeze(["sourceX", "sourceY"] as const),\n  Object.freeze(["stationX", "stationY"] as const),\n',
    ),
  );
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "failed");
  // BOTH debts are paid by one pair: `minecartTargets` publishes `station` and `targetTile` and nothing else, so
  // reading either one makes the family placeable and leaves the other exemption with no row left to place.
  assert.deepEqual(codes(reading), [
    "inventory_row_stale_tile_spelling_exemption:station",
    "inventory_row_stale_tile_spelling_exemption:targetTile",
  ]);
  assert.ok(WITHHELD_TILE_SPELLINGS.station !== undefined, "the fixture only proves something while the entry exists");
});

test("one composer dropping the pack slot is red, even while the sibling still prints it", (t) => {
  const root = fixtureTree(t);
  rewrite(root, "host/src/fact-brief.ts", (source) => source.replace(" 槽 ${String(row.slot)} ", ""));
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), ["inventory_row_field_dropped:slot:inventoryItemFacts:formatCarrying"]);
  const detail = reading.violations[0].detail;
  assert.match(detail, /host\/src\/fact-brief\.ts|formatCarrying/u, "the finding names the function to open");
  assert.match(detail, /print the row's own value/u, "and what would have to change");
});

test("both composers dropping it names both, and the field as undelivered", (t) => {
  const root = fixtureTree(t);
  rewrite(root, "host/src/fact-brief.ts", (source) => source.replace(" 槽 ${String(row.slot)} ", ""));
  rewrite(root, "host/src/snapshot-projection.ts", (source) => source.replace(" [slot ${String(row.slot)}]", ""));
  const reading = auditInventoryRowFields({ root });
  assert.deepEqual(codes(reading).sort(), [
    "inventory_row_field_dropped:slot:inventoryItemFacts:carryingText",
    "inventory_row_field_dropped:slot:inventoryItemFacts:formatCarrying",
    "inventory_row_field_nowhere_delivered:slot:inventoryItemFacts",
  ]);
});

test("the declared colour is checked, not believed", (t) => {
  const root = fixtureTree(t);
  rewrite(root, ROW_FAMILY_RENDERER.path, (source) =>
    source.replace("stateSuffix(state, candidate[state.field])", '""'),
  );
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), [
    "inventory_row_state_field_not_printed:colorTargets:color",
    "inventory_row_state_field_not_printed:soilTiles:hoeDirt",
  ]);
});

test("a declared value the wire does not publish is red rather than quietly skipped", (t) => {
  const root = fixtureTree(t);
  rewrite(root, ROW_FAMILY_RENDERER.path, (source) =>
    source.replace('Object.freeze({ field: "color", label: "色" })', 'Object.freeze({ field: "colour", label: "色" })'),
  );
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), ["inventory_row_state_field_unpublished:colorTargets:colour"]);
});

test("a module that starts reading the pack family has to be declared", (t) => {
  const root = fixtureTree(t);
  const path = "host/src/new-carrier.ts";
  writeFileSync(
    join(root, path),
    "export function describe(snapshot: { inventoryItemFacts?: readonly { displayName: string }[] }): number {\n" +
      "  return snapshot.inventoryItemFacts?.length ?? 0;\n" +
      "}\n",
  );
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), [`inventory_row_field_reader_undeclared:${path}`]);
});

test("a disposition whose module stopped reading the pack family has expired", (t) => {
  const root = fixtureTree(t);
  rewrite(root, "host/src/game-lookup.ts", (source) => source.replaceAll("inventoryItemFacts", "inventoryRows"));
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), ["inventory_row_field_reader_stale:host/src/game-lookup.ts"]);
});

test("a pack field added to the schema joins the population with no edit here", (t) => {
  const root = fixtureTree(t);
  // `quantity` is an argument `shop_purchase` already declares, so a row that starts carrying it is demanded at once.
  rewrite(root, "protocol/bridge-v1.schema.json", (source) => {
    const schema = JSON.parse(source);
    schema.$defs.inventoryItemFact.properties.quantity = { type: "integer" };
    return JSON.stringify(schema, null, 1);
  });
  const reading = auditInventoryRowFields({ root });
  assert.ok(
    reading.demanded.includes("quantity"),
    `a field the schema publishes and an argument names was not demanded: ${reading.demanded.join(", ")}`,
  );
  assert.ok(
    codes(reading).includes("inventory_row_field_dropped:quantity:inventoryItemFacts:formatCarrying"),
    `and both composers must print it: ${codes(reading).join(", ")}`,
  );
});

test("a crossing that examined nothing is blocked, never green", (t) => {
  const root = fixtureTree(t);
  rewrite(root, "protocol/bridge-v1.schema.json", (source) => {
    const schema = JSON.parse(source);
    schema.$defs.inventoryItemFact.properties = { paint: { type: "string" } };
    return JSON.stringify(schema, null, 1);
  });
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "blocked");
  assert.ok(codes(reading).includes("inventory_row_field_population_empty"), codes(reading).join(", "));
});

test("a composer the gate cannot find is blocked rather than counted as printing everything", (t) => {
  const root = fixtureTree(t);
  rewrite(root, "host/src/fact-brief.ts", (source) =>
    source.replace("function formatCarrying(", "function formatPack("),
  );
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "blocked");
  assert.deepEqual(codes(reading), ["inventory_row_field_renderer_missing:formatCarrying"]);
});

test("a row renderer the gate cannot find is blocked, not a pass over nothing", (t) => {
  const root = fixtureTree(t);
  rewrite(root, ROW_FAMILY_RENDERER.path, (source) =>
    source.replace("export function nearbyTargetFamilies(", "export function nearbyFamilies("),
  );
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "blocked");
  assert.match(reading.unreadable.join(" "), /nearbyTargetFamilies/u);
});

test("reading a field is not printing it: only an interpolation delivers a value", () => {
  const readsWithoutPrinting =
    'function formatPack(rows) { return rows.filter((row) => row.slot > 0).map((row) => `${row.displayName}`).join("、"); }';
  assert.equal(printsField(readsWithoutPrinting, "slot"), false, "a filter is not a delivery");
  assert.equal(printsField(readsWithoutPrinting, "displayName"), true);

  // A NESTED template is still read as a whole: the pack sentence nests its counted tail, and a reader that stopped at
  // the first brace would answer about a fragment of the line.
  const nested =
    'function formatPack(rows) { return `${rows.map((row) => `${row.slot}`).join("、")}${rows.length > 8 ? ` 其余 ${rows.length}` : ""}`; }';
  assert.equal(printsField(nested, "slot"), true);
  assert.ok(interpolations(nested).length > 0, "the reader found no interpolation in a template literal");
});

test("`expected<Field>` names the field it is checked against, and nothing else does", () => {
  const demanded = demandedRowFields(
    ["slot", "qualifiedItemId", "displayName", "stack"],
    new Set(["slot", "expectedQualifiedItemId", "expectedTargetId", "quantity"]),
  );
  assert.deepEqual(demanded, ["slot", "qualifiedItemId"]);
});

test("the wire's tile spellings are derived from the row records, not listed", () => {
  const spellings = wireTileSpellings(
    new Map([
      ["doorTargets", ["sourceX", "sourceY", "targetLocation", "targetX", "targetY"]],
      ["weedTargets", ["targetId", "x", "y"]],
      ["shopTargets", ["targetId", "ownerTileX", "ownerTileY", "ownerName"]],
      // A lone `X` with no `Y` is an id or a flag, not a place: `maxX` alone must not become a spelling.
      ["oddFamily", ["maxX", "x", "y"]],
    ]),
  );
  assert.deepEqual([...spellings.keys()].sort(), ["ownerTile", "source", "target", "x"]);
  assert.deepEqual(spellings.get("x"), { stem: "x", fields: ["x", "y"], families: ["weedTargets", "oddFamily"] });
  assert.deepEqual(spellings.get("source"), {
    stem: "source",
    fields: ["sourceX", "sourceY"],
    families: ["doorTargets"],
  });
});

test("the renderer's declarations are read out of its source, so the crossing cannot drift from it", () => {
  const source = readFileSync(join(REPOSITORY_ROOT, ROW_FAMILY_RENDERER.path), "utf8");
  assert.deepEqual(declaredTilePairs(source), [
    ["x", "y"],
    ["sourceX", "sourceY"],
    ["ownerTileX", "ownerTileY"],
  ]);
  assert.deepEqual(declaredStateFields(source), [
    { family: "colorTargets", field: "color" },
    { family: "soilTiles", field: "hoeDirt" },
  ]);
});
