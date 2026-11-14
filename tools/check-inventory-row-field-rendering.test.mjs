/**
 * The falsifiers for `check-inventory-row-field-rendering.mjs`.
 *
 * Every case mutates a COPY of the tree the gate reads and asks the gate for its verdict, so what is measured is the
 * gate's own reading of files, not a re-implementation of it. The claims under test:
 *
 *   1. THE TREE PASSES, and the population is derived from three authorities - the wire schema's row record, the Host
 *      validator's argument names, and a scan of every module that reads the family. Nothing here lists a renderer that
 *      the scan would not find, and nothing lists a field the schema would not.
 *   2. THE MEMBER IS NAMED, PER RENDERER. Deleting one composer's slot interpolation is
 *      `inventory_row_field_dropped:slot:<that composer>` even while the sibling still prints it: a sentence the model
 *      reads every turn is not made whole by another sentence somewhere else in the turn.
 *   3. A READER WITH NO DISPOSITION IS RED. A new module that reads `.inventoryItemFacts` is
 *      `inventory_row_field_reader_undeclared`; a disposition whose module stopped reading the family is
 *      `inventory_row_field_reader_stale`. That is what keeps the population level with the code.
 *   4. THE POPULATION IS DERIVED, both ways. A row field added to the schema and named by an argument the validator
 *      already declares is demanded with no edit here; a schema whose row fields no argument names is BLOCKED.
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
  READER_DISPOSITIONS,
} from "./check-inventory-row-field-rendering.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The files the gate reads, as paths relative to a root.
 *
 * These are the three modules that read the family - every member of `READER_DISPOSITIONS`, because a fixture that
 * omitted one would redden `inventory_row_field_reader_stale` for a reason the case did not inject.
 */
const FIXTURE_FILES = Object.freeze([
  "protocol/bridge-v1.schema.json",
  "host/src/protocol.ts",
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

test("the tree passes: every renderer prints every field an action demands", () => {
  const reading = auditInventoryRowFields({ root: REPOSITORY_ROOT });
  assert.equal(reading.status, "passed", `the real tree is red: ${codes(reading).join(", ")}`);
  // The population is printed, not assumed: a run that crossed nothing would pass every assertion below it.
  assert.ok(reading.examined > 0, "the gate crossed no renderer with a demanded field, which is a blocked reading");
  assert.ok(
    reading.readers.length >= 3,
    `the scan found ${String(reading.readers.length)} reader(s) of the family: ${reading.readers.join(", ")}`,
  );
  assert.ok(
    reading.demanded.includes("slot"),
    `the pack row's slot is demanded by three actions and the gate did not derive it: ${reading.demanded.join(", ")}`,
  );
  // ...and the reverse, so the gate is not demanding every field the wire carries: a name nobody accepts is not an
  // address, and printing it would be demanded by nothing.
  assert.equal(reading.demanded.includes("displayName"), false, "no action argument names `displayName`");
  assert.equal(reading.demanded.includes("stack"), false, "no action argument names `stack`");
});

test("one composer dropping the slot is red, even while the sibling still prints it", (t) => {
  const root = fixtureTree(t);
  rewrite(root, "host/src/fact-brief.ts", (source) => source.replace(" [槽 ${String(row.slot)}]", ""));
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), ["inventory_row_field_dropped:slot:formatCarrying"]);
  const detail = reading.violations[0].detail;
  assert.match(detail, /host\/src\/fact-brief\.ts|formatCarrying/u, "the finding names the function to open");
  assert.match(detail, /print the row's own value/u, "and what would have to change");
});

test("both composers dropping it names both, and the field as undelivered", (t) => {
  const root = fixtureTree(t);
  rewrite(root, "host/src/fact-brief.ts", (source) => source.replace(" [槽 ${String(row.slot)}]", ""));
  rewrite(root, "host/src/snapshot-projection.ts", (source) => source.replace(" [slot ${String(row.slot)}]", ""));
  const reading = auditInventoryRowFields({ root });
  assert.deepEqual(codes(reading).sort(), [
    "inventory_row_field_dropped:slot:carryingText",
    "inventory_row_field_dropped:slot:formatCarrying",
    "inventory_row_field_nowhere_delivered:slot",
  ]);
});

test("a module that starts reading the family has to be declared", (t) => {
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

test("a disposition whose module stopped reading the family has expired", (t) => {
  const root = fixtureTree(t);
  rewrite(root, "host/src/game-lookup.ts", (source) => source.replaceAll("inventoryItemFacts", "inventoryRows"));
  const reading = auditInventoryRowFields({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), ["inventory_row_field_reader_stale:host/src/game-lookup.ts"]);
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
  assert.equal(reading.examined, 0);
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
