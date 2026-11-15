#!/usr/bin/env node
/**
 * The gate for "a row field the renderer never reads, so a published subject cannot be seen".
 *
 * <p>
 * WHY (measured 2026-11-23, `round62`'s own snapshot replayed through the product's renderer). The per-turn line
 * 「门 (3,12)」 did not exist: the FarmHouse door sat at Chebyshev 4 from her, inside the radius-6 discovery envelope,
 * `doorTargets` published the row, and the block printed no door at all. `nearbyTargetFamilies` placed a row through
 * `x`/`y` and `isWarp` names a door's SOURCE tile `sourceX`/`sourceY`, so every row of that family failed the test and
 * was dropped by `continue`. The counts agreed with the silence: `total` read 1, `omitted` read 1, and the family
 * printed on neither the populated line nor the 「这一带没有」 one - so nothing said a door existed.
 * </p>
 * <p>
 * ...and the same shape one field over: `colorTargets` carried `color: "119,191,255"` and the line printed
 * 「可染色处 (3,7)」, so the one value that tells a repaintable chest from the chest next to it was not in the sentence.
 * The first unit was `inventoryItemFacts`' slot (`b3f27426`): three actions addressed a pack row by a number no
 * renderer printed. One family was the instance; the class is that NO check related the fields a row CARRIES to the
 * fields a renderer DELIVERS, per family, in the family's own terms.
 * </p>
 *
 * THE POPULATION IS FOUR AUTHORITIES, none of them a list here:
 *
 *   the row records   `protocol/bridge-v1.schema.json`: the `$defs.snapshot.properties` families whose items are a
 *                     `$ref` record, and that record's own property names. A row field added to the Mod joins this gate
 *                     by existing; a family added to the wire joins with it.
 *   the claim         `TARGET_FAMILY_LABELS` / `NON_ROW_FAMILIES` in the row renderer: the families the per-turn line
 *                     says it prints as rows. A family in the first and not the second is CLAIMED, and a claimed family
 *                     owes the line a row for every row it publishes.
 *   the renderer      the row renderer's own placement contract, `ROW_TILE_FIELD_PAIRS`, read out of the source so the
 *                     gate crosses the fields the renderer actually reads rather than the ones a gate author assumed;
 *                     plus `ROW_STATE_FIELDS`, the value it prints beside a tile.
 *   demanded names    `host/src/protocol.ts`'s `EXECUTION_REQUEST_ARGUMENT_RULES`, through the reader
 *                     `tools/check-action-surface-parity.mjs` already owns, for the action-addressed family.
 *
 * THE PROPERTIES:
 *
 *   inventory_row_field_dropped:<field>:<family>:<renderer>   a renderer of the family does not deliver a field the
 *                    row carries and the family's contract says it must. For `inventoryItemFacts` that is every field an
 *                    action argument names (`slot`, `qualifiedItemId`); for the tile renderer that is a family which
 *                    spells its tile in a pair the renderer does not read, so not one of its rows can be placed. The
 *                    field is named, not just the family: "the door is invisible" is a symptom, `sourceX` is the seam.
 *   inventory_row_field_nowhere_delivered:<field>:<family>   no renderer of the family interpolates it while the
 *                    contract demands it (the backstop for a family with no renderer at all).
 *   inventory_row_field_reader_undeclared:<path>      a module reads a family and this gate has no disposition for it:
 *                    a renderer (named, checked) or a consumer that quotes the whole row, with the reason.
 *   inventory_row_state_field_unpublished:<family>:<field>   `ROW_STATE_FIELDS` prints a value the wire never publishes
 *                    on that family any more - an entry must expire, or it becomes a comfortable note.
 *   inventory_row_state_field_not_printed:<family>:<field>   the renderer declares the value and no longer puts it in
 *                    the sentence (the table is a claim, and a claim this gate can check).
 *   inventory_row_state_entry_stale:<family>          a `ROW_STATE_FIELDS` entry for a family the line no longer claims.
 *
 * WHAT THIS GATE CANNOT SEE, said rather than implied.
 *
 *   - It reads source, so it proves a field reaches a template in a named function: not that the build ships that
 *     function, not that the line stays readable. The renderers' own suites drive the real composers - that is where a
 *     rendered row's own values are asserted.
 *   - THE STATE HALF'S POPULATION IS A JUDGEMENT, NOT A DERIVATION. Which families owe a value beside their tile is a
 *     product decision; what is derived is everything AROUND it - that the family is one the wire publishes, that the
 *     field is one the family's rows carry, and that the renderer prints what the table claims. The candidates a
 *     derivation would name are the claimed families whose rows carry exactly ONE field beyond their address and their
 *     name (measured today: `colorTargets`, `siloTargets`, `fenceGateTargets`, `horseTargets`, `mailboxTargets`,
 *     `museumRewardTargets`, `feedTroughTargets`, `cookingStationTargets`, `craftingRecipeTargets`,
 *     `cookingRecipeTargets`, `soilTiles`); one of them is fixed here and the rest are the next unit, named rather than
 *     hidden.
 *   - The one-object-two-facts half is NOT in this gate: `colorTargets` says a chest can be repainted while
 *     `formatChestsSummary` printed 「本图箱子: 0」 about the same chest, because the two lines are read from two
 *     different predicates (`chestsSummary.chestCount` from the container scan, `colorTargets` from the paint
 *     discovery). That disagreement is a fact about two producers, and no row-field crossing can see it.
 *
 * Usage:
 *   node tools/check-inventory-row-field-rendering.mjs                  # the gate; exit 1 on a finding, 2 on no population
 *   node tools/check-inventory-row-field-rendering.mjs --json           # the crossed population, machine-readable
 *   node tools/check-inventory-row-field-rendering.mjs --root <dir>      # the gate's own fixture (a copied tree)
 *
 * red-proof: history  the commit before `b3f27426` - `formatCarrying` mapped rows to `{name, stack}` and `carryingText`
 *            printed `Nx label` - exits 1 with `inventory_row_field_dropped:slot:inventoryItemFacts:formatCarrying`,
 *            `...:qualifiedItemId:inventoryItemFacts:formatCarrying` and the sibling composer's two.
 * red-proof: history  `ROW_TILE_FIELD_PAIRS` narrowed to `[["x","y"]]` - the renderer as `round62` shipped it - exits 1
 *            naming `sourceX` and `sourceY` at `doorTargets`, which is the shipped defect replayed rather than invented
 *            (tools/check-inventory-row-field-rendering.test.mjs).
 * red-proof: inject  the slot interpolation deleted from either composer, or `candidate[state.field]` dropped from the
 *            tile renderer, in a copied tree -> exit 1, the field and the renderer named (the same suite).
 */

export const gateDeclaration = {
  id: "check-inventory-row-field-rendering",
  domain: "product",
  tier: "l0",
  kind: "totality",
};

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readWireSurface } from "./check-action-surface-parity.mjs";
import { tableKeys } from "./check-snapshot-field-rendering.mjs";
import { bracesFrom, rootFromArgv } from "./lib/gate-preamble.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The wire document: the row shapes the Mod publishes and the Host validates. */
export const WIRE_SCHEMA = "protocol/bridge-v1.schema.json";

/** The Host validator: the one authority on which argument names an action demands. */
export const ARGUMENT_SOURCE = "host/src/protocol.ts";

/** The family whose rows an action addresses one row at a time. */
export const FAMILY = "inventoryItemFacts";

/** Where the readers of that family live. A reader outside these roots is a scan that lost the code, not a pass. */
export const READER_ROOTS = Object.freeze(["host/src"]);

/**
 * The renderer of the per-turn rows, and the two declarations that ARE its row contract.
 *
 * `tiles` is what places a row and `states` is what it prints beside the tile. Both are read out of the renderer's own
 * source and both are required to be USED there: a declaration the renderer stopped reading would make every crossing
 * below a fiction, so the body is checked to reference it.
 */
export const ROW_FAMILY_RENDERER = Object.freeze({
  path: "host/src/game-world-vocabulary.ts",
  fn: "nearbyTargetFamilies",
  composes: "the per-turn nearby-target lines",
  claims: "TARGET_FAMILY_LABELS",
  declines: "NON_ROW_FAMILIES",
  tiles: "ROW_TILE_FIELD_PAIRS",
  states: "ROW_STATE_FIELDS",
});

/**
 * Every module that reads the pack family, and what it does with the rows.
 *
 * `renderer` names the function that composes the sentence, because that is what is checked. `verbatim` is a consumer
 * that hands the whole row on - it cannot drop a field, so it owes a reason rather than a function. An entry EXPIRES:
 * a module that stops reading the family is `inventory_row_field_reader_stale`, and a module that starts reading it with
 * no entry is `inventory_row_field_reader_undeclared`.
 */
export const READER_DISPOSITIONS = Object.freeze({
  "host/src/fact-brief.ts": { kind: "renderer", fn: "formatCarrying", composes: "the `<world-state>` pack sentence" },
  "host/src/snapshot-projection.ts": {
    kind: "renderer",
    fn: "carryingText",
    composes: "the per-turn fact block's `- Carrying:` line",
  },
  "host/src/game-lookup.ts": {
    kind: "verbatim",
    reason:
      "answers `inventory` by handing the published rows on whole (`rows: bounded.rows`), so every field a row carries " +
      "reaches the answer; it composes no sentence of its own and drops nothing",
  },
});

const read = (root, path) => {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    return null;
  }
};

/** A line comment, a block comment: text a reader wrote for a person, never a read of a field. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/u, ""))
    .join("\n");
}

/** Every non-test `.ts` module under a root directory. */
function modulesUnder(root, directory) {
  const found = [];
  const base = resolve(root, directory);
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const absolute = join(base, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-test") continue;
      found.push(...modulesUnder(root, relative(root, absolute).split("\\").join("/")));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (/\.(?:private\.)?test\.ts$/u.test(entry.name) || /\.test-support\.ts$/u.test(entry.name)) continue;
    found.push(relative(root, absolute).split("\\").join("/"));
  }
  return found;
}

/** The modules that read the pack family in field position (`.inventoryItemFacts`), comments already stripped. */
export function familyReaders(root) {
  const pattern = new RegExp(`\\.${FAMILY}\\b`, "u");
  const readers = [];
  for (const directory of READER_ROOTS)
    for (const path of modulesUnder(root, directory)) {
      const source = read(root, path);
      if (source === null) continue;
      if (pattern.test(withoutComments(source))) readers.push(path);
    }
  return readers.sort();
}

/** Every family the wire publishes as an array of rows, with the property names of its own row record. */
export function rowFamilies(schema) {
  const properties = schema?.$defs?.snapshot?.properties;
  if (properties === undefined || typeof properties !== "object") throw new Error("snapshot_properties_unreadable");
  const families = new Map();
  for (const [family, declaration] of Object.entries(properties)) {
    const reference = declaration?.items?.$ref;
    if (typeof reference !== "string") continue;
    const record = schema?.$defs?.[reference.slice(reference.lastIndexOf("/") + 1)];
    const fields = record?.properties;
    if (fields === undefined || typeof fields !== "object") continue;
    const names = Object.keys(fields);
    if (names.length === 0) continue;
    families.set(family, names);
  }
  if (families.size === 0) throw new Error("row_families_empty");
  return families;
}

/**
 * The property names of the pack family's own row record, read from the `$ref` the family points at.
 *
 * A family whose rows are declared inline, or whose record is missing, is a vocabulary this gate cannot read: it throws
 * rather than returning an empty list, because a population that measured nothing agrees with itself.
 */
export function carriedRowFields(schema) {
  const families = rowFamilies(schema);
  const fields = families.get(FAMILY);
  if (fields === undefined) throw new Error(`${FAMILY}_row_ref_unreadable`);
  return fields;
}

/** Every argument name any action demands, from the Host validator's own `exactArgs` rows. */
export function demandedArgumentNames(wireSurface) {
  if (wireSurface.problems.length > 0) throw new Error(wireSurface.problems.join(","));
  const names = new Set();
  for (const argumentsOfAction of wireSurface.actions.values()) for (const name of argumentsOfAction) names.add(name);
  if (names.size === 0) throw new Error("argument_table_empty");
  return names;
}

/**
 * The carried fields some action argument names: the literal spelling, or the `expected<Field>` one.
 *
 * `expected<Field>` is how the Host spells "this value must be the row's own" - `expectedQualifiedItemId`,
 * `expectedTargetId` - so it names the field as surely as the field's own name does.
 */
export function demandedRowFields(carried, argumentNames) {
  return carried.filter(
    (field) =>
      argumentNames.has(field) || argumentNames.has(`expected${field.charAt(0).toUpperCase()}${field.slice(1)}`),
  );
}

/** The body of `function <name>(...) { … }`, or null. */
export function functionBody(source, name) {
  const code = withoutComments(source);
  const at = code.search(new RegExp(`function ${name}\\(`, "u"));
  if (at < 0) return null;
  // The parameter list first, so a brace INSIDE it is never mistaken for the body; then the first brace that ENDS its
  // line, because a return-type literal (`): Readonly<{ field: string }> {`) opens one mid-line. A reader that took the
  // first brace after the name would hand back the type and answer about a declaration instead of a sentence.
  let depth = 0;
  let cursor = code.indexOf("(", at);
  if (cursor < 0) return null;
  for (; cursor < code.length; cursor += 1) {
    if (code[cursor] === "(") depth += 1;
    else if (code[cursor] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  for (let index = cursor + 1; index < code.length; index += 1) {
    if (code[index] !== "{") continue;
    const end = code.indexOf("\n", index);
    if (code.slice(index + 1, end < 0 ? code.length : end).trim() !== "") continue;
    return bracesFrom(code, index);
  }
  return null;
}

/**
 * The source of `export const <name> = …` up to the end of its first bracketed literal, or null.
 *
 * The slice ends at the declaration's OWN closing bracket: reading to the end of the file picked up the members of every
 * table declared after it, which credited a field to a table it is not in.
 */
export function declarationBody(source, name) {
  const code = withoutComments(source);
  const at = code.indexOf(`export const ${name}`);
  if (at < 0) return null;
  // After the `=`, because a type annotation can carry its own brackets (`readonly [string, string][]`) and a slice
  // that started at one of those would describe the type rather than the value.
  const equals = code.indexOf("=", at);
  if (equals < 0) return null;
  const open = code.slice(equals).search(/[[{]/u);
  if (open < 0) return null;
  const start = equals + open;
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    if (code[index] === "{" || code[index] === "[") depth += 1;
    else if (code[index] === "}" || code[index] === "]") {
      depth -= 1;
      if (depth === 0) return code.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * The tile spellings the renderer reads, in the wire's own field names: `[["x","y"],["sourceX","sourceY"]]` today.
 *
 * Read from the renderer rather than written here, because this is the contract the crossing is about: a gate that
 * carried its own copy of it would keep passing after the renderer stopped reading the pair.
 */
export function declaredTilePairs(source) {
  const body = declarationBody(source, ROW_FAMILY_RENDERER.tiles);
  if (body === null) throw new Error(`${ROW_FAMILY_RENDERER.tiles}_unreadable: the row renderer declares no placement`);
  const pairs = [...body.matchAll(/\[\s*"([A-Za-z]\w*)"\s*,\s*"([A-Za-z]\w*)"\s*\]/gu)].map((match) => [
    match[1],
    match[2],
  ]);
  if (pairs.length === 0) throw new Error(`${ROW_FAMILY_RENDERER.tiles}_empty: the renderer places no row at all`);
  return pairs;
}

/** The fields any tile pair is spelled with, so a row that carries one of them is a row with a tile. */
export const tileFields = (pairs) => new Set(pairs.flat());

/**
 * Every way the wire spells a tile, derived from the row records themselves: two fields ending `X` and `Y` on the same
 * stem are the wire's own way of naming a place (`x`/`y`, `sourceX`/`sourceY`, `ownerTileX`/`ownerTileY`, ...).
 *
 * DERIVED, NOT LISTED. A list here would be the same mistake as a hand-written renderer table: the Mod grows a spelling
 * and the check keeps answering about the spellings it was written for. `sourceX`/`sourceY` is exactly such a spelling -
 * it is on the wire for `warp` and `doorTargets`, and the row renderer read only `x`/`y`.
 */
export function wireTileSpellings(families) {
  const spellings = new Map();
  const add = (stem, fields, family) => {
    const spelling = spellings.get(stem) ?? { stem, fields, families: [] };
    if (!spelling.families.includes(family)) spelling.families.push(family);
    spellings.set(stem, spelling);
  };
  for (const [family, fields] of families) {
    const carried = new Set(fields);
    // The bare pair is the wire's first spelling and the only one whose `X` is lower case, so it is named rather than
    // matched: `x`/`y` is what seventy-two families publish and what the renderer reads first.
    if (carried.has("x") && carried.has("y")) add("x", ["x", "y"], family);
    for (const field of fields) {
      if (!/X$/u.test(field)) continue;
      const stem = field.slice(0, -1);
      if (!carried.has(`${stem}Y`)) continue;
      add(stem, [`${stem}X`, `${stem}Y`], family);
    }
  }
  if (spellings.size === 0) throw new Error("wire_tile_spellings_empty: no row record spells a tile");
  return spellings;
}

/** The stem a declared tile pair is spelled with: `["x","y"]` is `x`, `["sourceX","sourceY"]` is `source`. */
export const pairStem = ([xField]) => (xField === "x" ? "x" : xField.slice(0, -1));

/**
 * The tile spellings the row renderer deliberately does not place a row through, each with the reason.
 *
 * AN ENTRY EXPIRES BOTH WAYS: the renderer starts reading that pair (`stale_tile_spelling_exemption`), or the wire stops
 * publishing it at all. A spelling whose reason names another field is the record of where the fact does print; a
 * spelling whose reason says it is a place in this map and names a file is a DEBT, and that file owes the next unit.
 */
export const WITHHELD_TILE_SPELLINGS = Object.freeze({
  target: {
    reason:
      "the ARRIVAL tile, on the destination map (`targetLocation`, `targetX`/`targetY`) - not a place in the map she is standing in. Printing it beside the door would move the door across maps.",
  },
  offset: {
    reason:
      "a shift from the pot's own `x`/`y`, which the line already places the row at: an offset is not a place, and printing it as a coordinate would name a tile the row is not on.",
  },
  destination: {
    reason:
      "where a warp ITEM would send her, on another map - the row is a backpack item (`slot`, `qualifiedItemId`), so its place is the pack, not the destination tile.",
  },
  ownerTile: {
    reason:
      "the tile the shop's keeper stands on: a real place in this map, and the row carries no `x`/`y` at all, so the line prints only `共 N 格，都没有可读的坐标` today. Placing the shop at its owner's tile is the next unit.",
    owedBy: "host/src/game-world-vocabulary.ts",
  },
  station: {
    reason:
      "the minecart station tile: a real place in this map, and the family publishes no `x`/`y`, so the line cannot place a cart today. Placing it at its station is the next unit.",
    owedBy: "host/src/game-world-vocabulary.ts",
  },
  targetTile: {
    reason:
      "the destination tile a minecart network id resolves to, which is the ride's answer rather than where the cart stands (`stationX`/`stationY`). Same unit as `station`.",
    owedBy: "host/src/game-world-vocabulary.ts",
  },
});

/**
 * The non-tile fields the row renderer reads off every row it prints, on top of the tile pair it places it with.
 *
 * `kind` and `displayName` are read together (the name prints only for a row that says what kind of thing it is),
 * `w`/`h` become the footprint suffix, and a declared state field is read per family. This is the "read by the renderer"
 * half of the report: `rowFields - read` is what the line does not look at, which is a fact a reader should see rather
 * than infer, and which the "dropped" count must not be confused with - a handle or a state the line never promised is
 * not a drop.
 */
export const READER_ROW_FIELDS = Object.freeze(["kind", "displayName", "w", "h"]);

/** The families the per-turn line claims to print as rows: its label table minus the ones it declines, with reasons. */
export function claimedFamilies(source) {
  const labels = tableKeys(source, ROW_FAMILY_RENDERER.claims);
  if (labels.length === 0) throw new Error(`${ROW_FAMILY_RENDERER.claims}_empty`);
  const declined = new Set(tableKeys(source, ROW_FAMILY_RENDERER.declines));
  return { labels, claimed: labels.filter((family) => !declined.has(family)), declined };
}

/** The value each family prints beside its row, from the renderer's own `ROW_STATE_FIELDS`. */
export function declaredStateFields(source) {
  const body = declarationBody(source, ROW_FAMILY_RENDERER.states);
  if (body === null) throw new Error(`${ROW_FAMILY_RENDERER.states}_unreadable`);
  return [...body.matchAll(/(\w+):\s*Object\.freeze\(\{\s*field:\s*"(\w+)"/gu)].map((match) => ({
    family: match[1],
    field: match[2],
  }));
}

/**
 * Every `${…}` expression a function's template literals interpolate, brace-balanced.
 *
 * Balanced rather than `/\$\{([^{}]*)\}/` so a nested template stays visible: the pack sentence nests one (the counted
 * tail inside the composed line), and a reader that stopped at the first brace would answer about a fragment of it.
 */
export function interpolations(body) {
  const expressions = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "$" || body[index + 1] !== "{") continue;
    let depth = 1;
    let cursor = index + 2;
    for (; cursor < body.length && depth > 0; cursor += 1) {
      if (body[cursor] === "{") depth += 1;
      else if (body[cursor] === "}") depth -= 1;
    }
    if (depth !== 0) break;
    expressions.push(body.slice(index + 2, cursor - 1));
    index = cursor - 1;
  }
  return expressions;
}

/** Whether a composer's templates interpolate a field read off something (`row.slot`). */
export function printsField(body, field) {
  const pattern = new RegExp(`\\.${field}\\b`, "u");
  return interpolations(body).some((expression) => pattern.test(expression));
}

/** Whether a composer reads a field at all - the read that must become a print. */
export function readsField(body, field) {
  return new RegExp(`\\.${field}\\b`, "u").test(body);
}

/**
 * Whether some claimed family's ONLY tile spelling is `stem` - i.e. whether the debt an exemption names still has a row
 * to place. A `owedBy` whose family became placeable another way has been paid.
 */
function unplaceableOwes(families, claimed, spellings, readStems, stem) {
  const spelling = spellings.get(stem);
  if (spelling === undefined) return false;
  return spelling.families.some(
    (family) =>
      claimed.includes(family) &&
      (families.get(family) ?? []).length > 0 &&
      [...spellings.values()].filter((one) => one.families.includes(family)).every((one) => !readStems.has(one.stem)),
  );
}

/**
 * The row-field crossing: every family the wire publishes against the renderers that claim to print it.
 *
 * Returns the crossed population, one row per (family, field, verdict), so the report can print what it examined and a
 * lane can read its own debt. `violations` is what makes the exit code 1; `blocked` names a source this gate needed and
 * could not read, because a premise that is absent is not a pass.
 */
export function auditInventoryRowFields({ root = REPOSITORY_ROOT } = {}) {
  const schemaSource = read(root, WIRE_SCHEMA);
  const protocolSource = read(root, ARGUMENT_SOURCE);
  const rendererSource = read(root, ROW_FAMILY_RENDERER.path);
  const unreadable = [];
  if (schemaSource === null) unreadable.push(WIRE_SCHEMA);
  if (protocolSource === null) unreadable.push(ARGUMENT_SOURCE);
  if (rendererSource === null) unreadable.push(ROW_FAMILY_RENDERER.path);
  if (unreadable.length > 0) return { status: "blocked", violations: [], unreadable, examined: 0 };

  let families;
  let packFields;
  let argumentNames;
  let pairs;
  let claims;
  let states;
  try {
    const schema = JSON.parse(schemaSource);
    families = rowFamilies(schema);
    packFields = carriedRowFields(schema);
    argumentNames = demandedArgumentNames(readWireSurface(protocolSource));
    pairs = declaredTilePairs(rendererSource);
    claims = claimedFamilies(rendererSource);
    states = declaredStateFields(rendererSource);
  } catch (error) {
    return { status: "blocked", violations: [], unreadable: [error.message], examined: 0 };
  }

  const violations = [];
  const rendererCode = withoutComments(rendererSource);
  const rendererBody = functionBody(rendererSource, ROW_FAMILY_RENDERER.fn);
  if (rendererBody === null)
    return {
      status: "blocked",
      violations: [],
      unreadable: [
        `${ROW_FAMILY_RENDERER.path}: no \`function ${ROW_FAMILY_RENDERER.fn}\`: the ${ROW_FAMILY_RENDERER.composes} it owns cannot be read`,
      ],
      examined: 0,
    };

  // A DECLARATION THE RENDERER STOPPED USING IS A CONTRACT ON PAPER. Both are the placement/value halves of every
  // crossing below, so a module that references neither would make every verdict here a statement about dead text.
  // The reference is looked for in the whole module rather than in one function: placement lives in `rowTile` and the
  // value in `stateSuffix`, two helpers of the same renderer, and a check that only read `nearbyTargetFamilies` would
  // have called both of them unused.
  for (const table of [ROW_FAMILY_RENDERER.tiles, ROW_FAMILY_RENDERER.states])
    if (!rendererCode.includes(table))
      violations.push({
        code: `inventory_row_state_field_not_printed:${table}`,
        detail: `${ROW_FAMILY_RENDERER.path} never references \`${table}\`, so the contract this gate crosses with is not the one the renderer reads`,
      });

  const tiles = tileFields(pairs);
  const statesOf = new Map(states.map((state) => [state.family, state.field]));
  const examined = [];
  const placeable = [];
  const countedOmissions = [];
  const readStems = new Set(pairs.map(pairStem));
  const spellings = wireTileSpellings(families);
  for (const family of claims.claimed) {
    const carried = families.get(family);
    if (carried === undefined) {
      violations.push({
        code: `inventory_row_family_unpublished:${family}`,
        detail: `\`${ROW_FAMILY_RENDERER.claims}\` prints this family and the wire publishes no row record for it`,
      });
      continue;
    }
    const usedPair = pairs.find((pair) => pair.every((field) => carried.includes(field)));
    const published = [...spellings.values()].filter((spelling) => spelling.families.includes(family));
    if (usedPair !== undefined) placeable.push(family);
    // A SPELLING THE WIRE PUBLISHES AND THE RENDERER DOES NOT READ IS A ROW THAT CANNOT BE PLACED - unless the reason
    // for not reading it is written down. The field is named, not just the family: "the door is invisible" is the
    // symptom and `sourceX` is the seam.
    const unread = published.filter((spelling) => !readStems.has(spelling.stem));
    const unreadWithoutReason = unread.filter((spelling) => WITHHELD_TILE_SPELLINGS[spelling.stem] === undefined);
    for (const spelling of unreadWithoutReason)
      for (const field of spelling.fields)
        violations.push({
          code: `inventory_row_field_dropped:${field}:${family}:${ROW_FAMILY_RENDERER.fn}`,
          detail:
            `\`${family}\` publishes its tile as \`${spelling.fields.join("/")}\` and \`${ROW_FAMILY_RENDERER.fn}\` ` +
            `places a row only through ${pairs.map((pair) => pair.join("/")).join(" or ")}, so this family's rows are ` +
            "dropped by the placement test and the family never prints: read that pair, or write the reason beside it " +
            "in WITHHELD_TILE_SPELLINGS",
        });
    if (usedPair === undefined && published.length === 0) countedOmissions.push(family);
    for (const field of carried)
      examined.push({
        family,
        field,
        read: (usedPair ?? []).includes(field) || READER_ROW_FIELDS.includes(field) || statesOf.get(family) === field,
      });
  }
  for (const [stem, exemption] of Object.entries(WITHHELD_TILE_SPELLINGS)) {
    if (!spellings.has(stem)) {
      violations.push({
        code: `inventory_row_stale_tile_spelling_exemption:${stem}`,
        detail: `the wire spells no tile as \`${stem}X\`/\`${stem}Y\` any more, so the exemption exempts nothing and must be deleted`,
      });
      continue;
    }
    if (readStems.has(stem)) {
      violations.push({
        code: `inventory_row_stale_tile_spelling_exemption:${stem}`,
        detail: `\`${ROW_FAMILY_RENDERER.fn}\` places rows through \`${stem}X\`/\`${stem}Y\` now, so the exemption (${exemption.reason}) has expired and must be deleted`,
      });
      continue;
    }
    if (typeof exemption.reason !== "string" || exemption.reason.trim() === "")
      violations.push({
        code: `inventory_row_tile_spelling_exemption_without_reason:${stem}`,
        detail:
          "a spelling the line does not place is a decision, and a decision with no sentence is indistinguishable from an oversight",
      });
    if (exemption.owedBy !== undefined && !unplaceableOwes(families, claims.claimed, spellings, readStems, stem))
      violations.push({
        code: `inventory_row_stale_tile_spelling_exemption:${stem}`,
        detail: `no claimed family's ONLY tile spelling is \`${stem}X\`/\`${stem}Y\` any more, so the debt ${exemption.owedBy} owes has no row left to place`,
      });
  }

  // THE PACK FAMILY: a field an action argument names must reach every composer's sentence.
  const demanded = demandedRowFields(packFields, argumentNames);
  const readers = familyReaders(root);
  for (const path of readers) {
    if (READER_DISPOSITIONS[path] !== undefined) continue;
    violations.push({
      code: `inventory_row_field_reader_undeclared:${path}`,
      detail:
        `this module reads \`.${FAMILY}\` and READER_DISPOSITIONS says nothing about it: declare it as a renderer (with ` +
        "the function that composes its sentence) or as a verbatim consumer with the reason it cannot drop a field",
    });
  }
  for (const [path, disposition] of Object.entries(READER_DISPOSITIONS)) {
    if (readers.includes(path)) continue;
    violations.push({
      code: `inventory_row_field_reader_stale:${path}`,
      detail: `this module no longer reads the family, so its ${disposition.kind} disposition exempts nothing and must be deleted`,
    });
  }
  const renderers = Object.entries(READER_DISPOSITIONS).filter(([, disposition]) => disposition.kind === "renderer");
  const delivered = new Set();
  for (const [path, disposition] of renderers) {
    const source = read(root, path);
    const body = source === null ? null : functionBody(source, disposition.fn);
    if (body === null) {
      violations.push({
        code: `inventory_row_field_renderer_missing:${disposition.fn}`,
        detail: `${path} declares no \`function ${disposition.fn}\`: the ${disposition.composes} it owns cannot be read`,
      });
      continue;
    }
    for (const field of demanded) {
      const prints = printsField(body, field);
      if (prints) delivered.add(field);
      examined.push({ family: FAMILY, field, read: prints, renderer: disposition.fn });
      if (prints) continue;
      violations.push({
        code: `inventory_row_field_dropped:${field}:${FAMILY}:${disposition.fn}`,
        detail:
          `\`${disposition.fn}\` composes ${disposition.composes} without \`${field}\`: an action argument demands that ` +
          "field, so print the row's own value here",
      });
    }
  }
  for (const field of demanded) {
    if (delivered.has(field)) continue;
    violations.push({
      code: `inventory_row_field_nowhere_delivered:${field}:${FAMILY}`,
      detail: `no renderer of the family interpolates \`${field}\`, and an action argument demands it: the turn carries rows whose address cannot be named from any of it`,
    });
  }

  // THE STATE HALF: every declared value must be published by that family's rows and printed by the renderer.
  const claimedSet = new Set(claims.claimed);
  for (const { family, field } of states) {
    if (!claimedSet.has(family)) {
      violations.push({
        code: `inventory_row_state_entry_stale:${family}`,
        detail: `\`${ROW_FAMILY_RENDERER.states}\` prints a value for \`${family}\` and \`${ROW_FAMILY_RENDERER.claims}\` no longer claims it: the entry exempts nothing and must be deleted`,
      });
      continue;
    }
    if (!(families.get(family) ?? []).includes(field)) {
      violations.push({
        code: `inventory_row_state_field_unpublished:${family}:${field}`,
        detail: `\`${ROW_FAMILY_RENDERER.states}\` prints \`${field}\` beside a \`${family}\` row and the wire publishes no such field on that family`,
      });
      continue;
    }
    examined.push({ family, field, read: true, state: true });
    const stateTemplates = interpolations(withoutComments(functionBody(rendererSource, "stateSuffix") ?? ""));
    const printsTheValue =
      rendererCode.includes("candidate[state.field]") &&
      stateTemplates.some((one) => /state\.label/u.test(one)) &&
      stateTemplates.some((one) => /\bvalue\b/u.test(one));
    if (printsTheValue) continue;
    violations.push({
      code: `inventory_row_state_field_not_printed:${family}:${field}`,
      detail: `\`${ROW_FAMILY_RENDERER.states}\` claims \`${field}\` reaches the \`${family}\` line and \`${ROW_FAMILY_RENDERER.fn}\` no longer reads it: the declaration is the defect it was meant to prevent`,
    });
  }

  // A CROSSING THAT EXAMINED NOTHING AGREES WITH ITSELF. Zero demanded pack fields means the row fields and the
  // argument names met nowhere - a schema or a validator this reader can no longer read - and it is blocked, not green.
  const populationEmpty = demanded.length === 0;
  if (populationEmpty)
    violations.push({
      code: "inventory_row_field_population_empty",
      detail:
        `none of the ${String(packFields.length)} carried field(s) (${packFields.join(", ")}) is named by an action ` +
        "argument, so no pack row field can be judged: the schema and the validator disagree about the pack row",
    });

  const rowEntries = examined.filter((entry) => entry.family !== FAMILY);
  const rowFields = rowEntries.length;
  const rowFieldsRead = rowEntries.filter((entry) => entry.read === true).length;
  const rendererMissing = violations.some((violation) =>
    violation.code.startsWith("inventory_row_field_renderer_missing:"),
  );
  return {
    // A MISSING COMPOSER IS A PREMISE, NOT A FAILING FIELD: the gate could not read what it judges, and the difference
    // is the difference between "this field is dropped" and "this reader is blind here".
    status: rendererMissing || populationEmpty ? "blocked" : violations.length === 0 ? "passed" : "failed",
    examined: examined.length,
    families: claims.claimed.length,
    claimedFamilies: claims.claimed,
    placeable,
    tilePairs: pairs,
    tileFields: [...tiles],
    states,
    rowFields,
    rowFieldsRead,
    beyondTheContract: rowFields - rowFieldsRead,
    dropped: violations.filter((violation) => violation.code.startsWith("inventory_row_field_dropped:")).length,
    carried: packFields,
    demanded,
    readers,
    renderers: renderers.length,
    examinedRows: examined,
    violations,
    unreadable: [],
  };
}

function main(argv) {
  const root = rootFromArgv(argv, REPOSITORY_ROOT);
  const reading = auditInventoryRowFields({ root });
  const report = {
    gate: "inventory-row-field-rendering",
    status: reading.status,
    familiesExamined: reading.families ?? 0,
    rowFields: reading.rowFields ?? 0,
    rowFieldsRead: reading.rowFieldsRead ?? 0,
    beyondTheContract: reading.beyondTheContract ?? 0,
    dropped: reading.dropped ?? 0,
    tilePairs: reading.tilePairs ?? [],
    stateFields: reading.states ?? [],
    placeableFamilies: reading.placeable ?? [],
    carriedFields: reading.carried ?? [],
    demandedFields: reading.demanded ?? [],
    readers: reading.readers ?? [],
    renderers: reading.renderers ?? 0,
    checks: [
      {
        id: "row_family_population",
        status: (reading.families ?? 0) === 0 ? "blocked" : "passed",
        detail: `${String(reading.families ?? 0)} family/families the per-turn line claims`,
      },
      {
        id: "demanded_field_population",
        status: (reading.demanded ?? []).length === 0 ? "blocked" : "passed",
        detail: `${String((reading.demanded ?? []).length)} pack field(s) an action argument names`,
      },
      {
        id: "every_reader_declared",
        status: (reading.readers ?? []).length === 0 ? "blocked" : "passed",
        detail: `${String((reading.readers ?? []).length)} module(s) read the pack family`,
      },
      {
        id: "every_row_field_delivered",
        status: reading.status === "blocked" ? "blocked" : reading.violations.length === 0 ? "passed" : "failed",
        detail: `${String(reading.violations.length)} violation(s)`,
      },
    ],
  };
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...report, examinedRows: reading.examinedRows ?? [] })}\n`);
  } else {
    process.stdout.write(
      `row families examined ${String(report.familiesExamined)} · row fields ${String(report.rowFields)} · ` +
        `read by the renderer ${String(report.rowFieldsRead)} (beyond the contract ${String(report.beyondTheContract)}) · ` +
        `dropped ${String(report.dropped)} · ` +
        `placeable families ${String(report.placeableFamilies.length)}/${String(report.familiesExamined)} ` +
        `· state values ${String(report.stateFields.length)} · status ${report.status}\n`,
    );
    for (const line of reading.unreadable) process.stderr.write(`inventory_row_field_unreadable: ${line}\n`);
    for (const violation of reading.violations) process.stderr.write(`${violation.code}: ${violation.detail}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  if ((reading.examined ?? 0) === 0 || (reading.demanded ?? []).length === 0) {
    process.stderr.write(
      "inventory_row_field_population_empty: nothing was crossed, so nothing can be judged; a green run reads " +
        "families>=1 and demanded>=1\n",
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = reading.status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
