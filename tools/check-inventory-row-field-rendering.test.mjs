/**
 * The falsifiers for `check-inventory-row-field-rendering.mjs`.
 *
 * Every case mutates a COPY of the tree the gate reads and then asks the gate for its verdict, so what is measured is the
 * gate's own reading of files, not a re-implementation of it. The three claims under test:
 *
 *   1. THE TREE PASSES, and the population is the two authorities crossed - `slot` and `qualifiedItemId` are demanded
 *      because the wire carries them and an action argument names them, not because a list here remembers them.
 *   2. THE MEMBER IS NAMED. Deleting the slot interpolation from the composer is
 *      `inventory_row_field_dropped:slot:formatCarrying`: the field, the renderer, and the thing to print.
 *   3. THE POPULATION IS DERIVED. A row field added to the schema and named by an argument the validator already
 *      declares is demanded with no edit to this suite or to the gate; a schema whose row fields no argument names is
 *      BLOCKED rather than green, because a crossing that examined nothing agrees with itself.
 *
 * The renderer is also shown to be the only thing that counts as a delivery: a composer that READS the field without
 * interpolating it - the historical shape, `filter((row) => !seeds.has(row.qualifiedItemId))` - is not a rendering.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditInventoryRowFields,
  demandedRowFields,
  interpolations,
  printsField,
} from "./check-inventory-row-field-rendering.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The files the gate reads, as paths relative to a root. */
const FIXTURE_FILES = Object.freeze([
  "protocol/bridge-v1.schema.json",
  "host/src/protocol.ts",
  "host/src/fact-brief.ts",
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

test("the tree passes: every carried field an action demands reaches the pack sentence", () => {
  const reading = auditInventoryRowFields({ root: REPOSITORY_ROOT });
  assert.equal(reading.status, "passed", `the real tree is red: ${codes(reading).join(", ")}`);
  // The population is printed, not assumed: a run that crossed nothing would pass every assertion below it.
  assert.ok(reading.examined > 0, "the gate crossed no carried field with an argument, which is a blocked reading");
  assert.ok(
    reading.demanded.includes("slot"),
    `the pack row's slot is demanded by three actions and the gate did not derive it: ${reading.demanded.join(", ")}`,
  );
  // ...and the reverse, so the gate is not demanding every field the wire carries: a name nobody accepts is not an
  // address, and printing it would be demanded by nothing.
  assert.equal(reading.demanded.includes("displayName"), false, "no action argument names `displayName`");
});

test("a dropped slot is red and names the field, the renderer and the fix", (t) => {
  const root = fixtureTree(t);
  rewrite(root, "host/src/fact-brief.ts", (source) => source.replace(" [槽 ${String(row.slot)}]", ""));
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), ["inventory_row_field_dropped:slot:formatCarrying"]);
  const detail = reading.violations[0].detail;
  assert.match(detail, /host\/src\/fact-brief\.ts/u, "the finding names the file to open");
  assert.match(detail, /print the row's own value/u, "and what would have to change");
});

test("a row field added to the schema joins the population with no edit here", (t) => {
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
    codes(reading).includes("inventory_row_field_dropped:quantity:formatCarrying"),
    `and the composer does not print it, so it is red: ${codes(reading).join(", ")}`,
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
  assert.equal(reading.examined, 0);
  assert.deepEqual(codes(reading), ["inventory_row_field_population_empty"]);
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
