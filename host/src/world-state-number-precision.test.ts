/**
 * GATE `a_number_reaches_the_prompt_at_the_precision_it_is_meant:<field>`.
 *
 * <p>
 * FLOAT NOISE IS A NUMBER THE WORLD NEVER SAID. Measured 2026-11-25 (`round77`), the per-turn block fed the model
 * `体力: 254.20001`, then `63.699966`, `245.90004`, `73.80031` and `65.10014`. The native value is a `float` and the wire
 * publishes it unchanged, so the game's own tenths arrived carrying arithmetic in their last three to five digits - and a
 * reading whose precision is invented costs the model a comparison it cannot make: 254.20001 and 254.2 are one stamina,
 * so a fact that says both is a fact with two spellings.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE BLOCK'S OWN NUMBERS. The block is split into the segments it is composed from, every segment that
 * carries a number is one field, and the precision of a field is what its own text shows - so a field added to the block
 * tomorrow is measured without this file changing, and the failure names the field and the raw string. The declared
 * precision is `DECLARED_DECIMAL_PLACES` below: one tenth, the precision the game spends stamina at, stated once in
 * `formatGameStamina`.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { composeWorldState } from "./fact-brief.js";
import { formatGameStamina } from "./game-world-vocabulary.js";
import type { Snapshot } from "./protocol.js";

/**
 * The finest precision any number on this line is meant to reach the prompt at: one tenth.
 *
 * A tenth is the precision the native game spends stamina at - every one of the five readings measured on `round77` is a
 * tenth plus float noise - and no other number the block prints is fractional at all. A token carrying more decimal
 * places than this is representation noise, not a measurement.
 */
const DECLARED_DECIMAL_PLACES = 1;

/** A number as it appears in the block: an integer, or a decimal. */
const NUMERIC_TOKEN = /-?\d+(?:\.\d+)?/gu;

/** The block's facts are joined with `；` and its lines with `\n`, so a "field" is one of either. */
function segmentsOf(block: string): readonly string[] {
  return block
    .split(/[\n；]/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * The name a segment gives its own number: the label before its `:` when it has one, otherwise the text that precedes
 * the first number. Read from the block rather than from a table, so a renamed field is named as it now reads.
 */
function fieldNameOf(segment: string): string {
  const separator = segment.search(/[:：]/u);
  if (separator > 0) return segment.slice(0, separator).trim();
  const firstNumber = segment.search(NUMERIC_TOKEN);
  return firstNumber > 0 ? segment.slice(0, firstNumber).trim() : segment;
}

/** How many decimal places a printed number shows. `254` shows none; `254.2` shows one; `254.20001` shows five. */
function decimalPlacesOf(token: string): number {
  const point = token.indexOf(".");
  return point < 0 ? 0 : token.length - point - 1;
}

/** One field of the block that carries at least one number, with the tokens it printed and the ones past its precision. */
type NumberField = Readonly<{ field: string; printed: readonly string[]; raw: readonly string[] }>;

/**
 * Every field of one block that prints a number, with the tokens that show more precision than this line is meant to
 * carry. `raw` is the finding; `printed` keeps the whole reading so a passing field is visible as measured rather than
 * absent.
 */
function numericFieldsOf(block: string): readonly NumberField[] {
  const byField = new Map<string, string[]>();
  for (const segment of segmentsOf(block)) {
    const tokens = segment.match(NUMERIC_TOKEN);
    if (tokens === null) continue;
    const field = fieldNameOf(segment);
    byField.set(field, [...(byField.get(field) ?? []), ...tokens]);
  }
  return [...byField]
    .map(([field, printed]) =>
      Object.freeze({
        field,
        printed,
        raw: printed.filter((token) => decimalPlacesOf(token) > DECLARED_DECIMAL_PLACES),
      }),
    )
    .sort((left, right) => left.field.localeCompare(right.field));
}

/** The five stamina readings `round77` handed the model, verbatim, plus the two ends of the bar they have to preserve. */
const MEASURED_STAMINA: readonly number[] = [254.20001, 63.699966, 245.90004, 73.80031, 65.10014, 0, 270];

/** A snapshot whose only varying fact is the stamina reading, so the block under it is the real composer's output. */
function snapshotWith(stamina: number): Snapshot {
  return {
    revision: 771,
    location: "Farm",
    tile: { x: 65, y: 20 },
    stamina,
    health: 100,
    actionable: true,
    capabilities: [],
    catalogRevision: 3,
    enabledActionIds: [],
    presentationLocale: "zh-CN",
    exhausted: false,
    timeOfDay: 2020,
    dayOfMonth: 6,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    currentTool: "(T)Axe",
    currentToolSlot: 0,
    toolSlots: [{ slot: 0, label: "(T)Axe", category: "axe", upgradeLevel: 0 }],
    inventoryItemFacts: [],
  } as unknown as Snapshot;
}

function blockOf(stamina: number): string {
  const snapshot = snapshotWith(stamina);
  return composeWorldState({ snapshot, revision: snapshot.revision, ageTurns: 0, ageMs: 0, contentAgeMs: 0 });
}

test("a_number_reaches_the_prompt_at_the_precision_it_is_meant: no field prints a float's arithmetic", () => {
  const fields = MEASURED_STAMINA.flatMap((stamina) => numericFieldsOf(blockOf(stamina)));
  const raw = fields.filter((field) => field.raw.length > 0);
  const rounded = fields.length - raw.length;
  console.log(
    `a_number_reaches_the_prompt_at_the_precision_it_is_meant:block · fields examined ${String(fields.length)} · rounded ${String(rounded)} · raw ${String(raw.length)}`,
  );
  assert.ok(fields.length > 0, "zero numeric fields is blocked, never green: the block is the population");
  assert.ok(
    fields.some((field) => field.field === "体力"),
    `the stamina field is one of the numbers measured: ${fields.map((field) => field.field).join(", ")}`,
  );
  assert.deepEqual(
    raw.map((field) => `${field.field}=${field.raw.join(",")}`),
    [],
    `a field reaches the prompt at a precision no field is meant to have: ${raw
      .map((field) => `${field.field} printed ${field.raw.join(",")}`)
      .join(" | ")}`,
  );
  // The reading itself is the tenths the game spends: a noise-free spelling of the same measurement.
  assert.match(
    blockOf(254.20001),
    /体力: 254\.2/u,
    `the measured reading prints its own tenths: ${blockOf(254.20001)}`,
  );
});

test("a_number_reaches_the_prompt_at_the_precision_it_is_meant: the shipped line is REFUSED by that reading", () => {
  // THE FALSIFIER, quoting `round77` verbatim: the precision the prompt carried before this gate existed.
  const shipped = numericFieldsOf("体力: 254.20001");
  assert.deepEqual(
    shipped.map((field) => `${field.field}=${field.raw.join(",")}`),
    ["体力=254.20001"],
    "a reading that shows a float's arithmetic must be reported with the field and the raw string",
  );
});

test("a_number_reaches_the_prompt_at_the_precision_it_is_meant: the range survives the rounding", () => {
  // A precision that flattened the bottom of the bar would be no better than the noise: drained, nearly drained, one
  // point and full have to stay four different facts.
  const spellings = [0, 0.1, 1, 270.5].map((stamina) => formatGameStamina(stamina, false, true));
  assert.deepEqual(spellings, ["体力: 0", "体力: 0.1", "体力: 1", "体力: 270.5"], `every reading keeps its own value`);
  assert.equal(new Set(spellings).size, spellings.length, "two readings of different stamina never print the same");
  // A positive reading never collapses onto zero: the smallest tenth the game spends stays visible as itself.
  assert.notEqual(formatGameStamina(0.1, false, true), formatGameStamina(0, false, true));
  assert.equal(formatGameStamina(-15, false, true), "体力: -15", "a drained reading keeps its sign");
  assert.equal(formatGameStamina(Number.NaN, true, true), "", "an unreadable reading stays silent, never zero");
});
