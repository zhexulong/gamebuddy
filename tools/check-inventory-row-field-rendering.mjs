#!/usr/bin/env node
/**
 * The gate for "an action asks for a field of the pack row that the text she reads never printed".
 *
 * WHY (measured 2026-11-23, the 7-dimension review of this tree). `inventoryItemFacts` is the Mod's own bounded
 * inventory publication: 36 rows of `{slot, qualifiedItemId, displayName, stack}`. Both renderers of that family printed
 * the count and the name and dropped the SLOT:
 *
 *   host/src/fact-brief.ts        `<world-state>`: `12 份 石头`
 *   host/src/snapshot-projection.ts  the per-turn fact block: `Carrying: 12x Stone`
 *
 * Three actions address a pack row by that number and by nothing else - `open_geode` takes `slot` plus
 * `expectedQualifiedItemId`, `deposit_silo_hay` and `put_item_in_fish_tank` take `slot` - so the companion was asked
 * for a number she had never been shown, and her only route to it was a `stardew_observe` round trip whose necessity
 * nothing stated. The one field was the instance; the class is that no check related the fields a row CARRIES to the
 * fields an action DEMANDS, per renderer, in the family's own terms.
 *
 * THE POPULATION IS THREE AUTHORITIES, none of them a list here:
 *
 *   carried fields   `protocol/bridge-v1.schema.json`: the `$defs.snapshot.properties.inventoryItemFacts.items.$ref`
 *                    record's own property names. A row field added to the Mod joins this gate by existing.
 *   demanded names   `host/src/protocol.ts`'s `EXECUTION_REQUEST_ARGUMENT_RULES`, read through the reader
 *                    `tools/check-action-surface-parity.mjs` already owns (the `exactArgs([...])` rows, where
 *                    `argumentNames` is data). One reader, two gates - a second parse of the same table would be a
 *                    second spelling.
 *   the readers      every module under `READER_ROOTS` that reads the family in field position
 *                    (`.inventoryItemFacts`), with comments stripped. A renderer that is not listed here is found by
 *                    the scan, not by memory: the sibling above stayed green precisely because the one renderer its
 *                    author knew about was the one being checked.
 *
 * A carried field is DEMANDED when an action argument names it, literally (`slot`) or through the `expected<Field>`
 * spelling the Host uses for a value it checks against the row (`expectedQualifiedItemId` names `qualifiedItemId`).
 *
 * THE PROPERTY, in three parts:
 *
 *   inventory_row_field_dropped:<field>:<renderer>   a renderer of the family does not interpolate a demanded field into
 *                                                    the sentence it composes. Every renderer owes it: reading a field
 *                                                    to filter on it is not printing it (the composer filtered rows on
 *                                                    `row.qualifiedItemId` and printed no id), and a sentence the model
 *                                                    reads every turn is not made whole by its sibling sentence.
 *   inventory_row_field_nowhere_delivered:<field>     the backstop for a family with no renderer at all: nothing in the
 *                                                    configuration interpolates the field while an action demands it.
 *   inventory_row_field_reader_undeclared:<path>      a module reads the family and this gate has no disposition for it:
 *                                                    a renderer (named, checked) or a consumer that quotes the whole
 *                                                    row (with the reason it cannot drop a field).
 *
 * WHAT THIS GATE CANNOT SEE, said rather than implied. It reads source, so it proves a demanded field reaches a
 * template in a named function: not that the build ships that function, not that the value is the row's own rather than
 * a default, not that the line stays readable. Those are the renderers' own suites' job -
 * `host/src/fact-brief.private.test.ts` and `host/src/snapshot-projection-consumed-fields.test.ts` drive the real
 * composers and assert each row's own slot appears and that another world's slot replaces it.
 *
 * Usage:
 *   node tools/check-inventory-row-field-rendering.mjs                  # the gate; exit 1 on a finding, 2 on no population
 *   node tools/check-inventory-row-field-rendering.mjs --json           # the crossed population, machine-readable
 *   node tools/check-inventory-row-field-rendering.mjs --root <dir>      # the gate's own fixture (a copied tree)
 *
 * red-proof: history  the commit before this unit's fix - `formatCarrying` mapped rows to `{name, stack}` and
 *            `carryingText` printed `Nx label` - exits 1 with
 *            `inventory_row_field_dropped:slot:formatCarrying`, `...:qualifiedItemId:formatCarrying`,
 *            `...:slot:carryingText` and `...:qualifiedItemId:carryingText`.
 * red-proof: inject  the slot interpolation deleted from either composer in a copied tree -> exit 1, the field and the
 *            renderer named (tools/check-inventory-row-field-rendering.test.mjs).
 * red-proof: inject  a new module reading `.inventoryItemFacts` appears -> `inventory_row_field_reader_undeclared`, so
 *            the population cannot fall behind the code (the same suite).
 */

export const gateDeclaration = {
  id: "check-inventory-row-field-rendering",
  domain: "product",
  tier: "l0",
  kind: "totality",
};

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readWireSurface } from "./check-action-surface-parity.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The wire document: the row shape the Mod publishes and the Host validates. */
export const WIRE_SCHEMA = "protocol/bridge-v1.schema.json";

/** The Host validator: the one authority on which argument names an action demands. */
export const ARGUMENT_SOURCE = "host/src/protocol.ts";

/** The family whose rows an action addresses one row at a time. */
export const FAMILY = "inventoryItemFacts";

/** Where the readers of that family live. A reader outside these roots is a scan that lost the code, not a pass. */
export const READER_ROOTS = Object.freeze(["host/src"]);

/**
 * Every module that reads the family, and what it does with the rows.
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

/** The modules that read the family in field position (`.inventoryItemFacts`), comments already stripped. */
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

/**
 * The property names of the family's own row record, read from the `$ref` the family points at.
 *
 * A family whose rows are declared inline, or whose record is missing, is a vocabulary this gate cannot read: it throws
 * rather than returning an empty list, because a population that measured nothing agrees with itself.
 */
export function carriedRowFields(schema) {
  const properties = schema?.$defs?.snapshot?.properties;
  const family = properties?.[FAMILY];
  const reference = family?.items?.$ref;
  if (typeof reference !== "string") throw new Error(`${FAMILY}_row_ref_unreadable`);
  const record = schema?.$defs?.[reference.slice(reference.lastIndexOf("/") + 1)];
  const fields = record?.properties;
  if (fields === undefined || typeof fields !== "object") throw new Error(`${FAMILY}_row_properties_unreadable`);
  const names = Object.keys(fields);
  if (names.length === 0) throw new Error(`${FAMILY}_row_properties_empty`);
  return names;
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
  const open = code.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  return null;
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

/** The reading: the crossed population, and every renderer that drops a field an action demands. */
export function auditInventoryRowFields({ root = REPOSITORY_ROOT } = {}) {
  const schemaSource = read(root, WIRE_SCHEMA);
  const protocolSource = read(root, ARGUMENT_SOURCE);
  const unreadable = [];
  if (schemaSource === null) unreadable.push(WIRE_SCHEMA);
  if (protocolSource === null) unreadable.push(ARGUMENT_SOURCE);
  if (unreadable.length > 0) return { status: "blocked", violations: [], unreadable, examined: 0 };

  let carried;
  let demanded;
  try {
    const schema = JSON.parse(schemaSource);
    carried = carriedRowFields(schema);
    demanded = demandedRowFields(carried, demandedArgumentNames(readWireSurface(protocolSource)));
  } catch (error) {
    return {
      status: "blocked",
      violations: [],
      unreadable: [`${WIRE_SCHEMA} or ${ARGUMENT_SOURCE}: ${error.message}`],
      examined: 0,
    };
  }

  const readers = familyReaders(root);
  const violations = [];
  for (const path of readers) {
    const disposition = READER_DISPOSITIONS[path];
    if (disposition !== undefined) continue;
    violations.push({
      code: `inventory_row_field_reader_undeclared:${path}`,
      detail:
        "this module reads `.inventoryItemFacts` and READER_DISPOSITIONS says nothing about it: declare it as a " +
        "renderer (with the function that composes its sentence) or as a verbatim consumer with the reason it cannot " +
        "drop a field",
    });
  }
  for (const [path, disposition] of Object.entries(READER_DISPOSITIONS)) {
    if (readers.includes(path)) continue;
    violations.push({
      code: `inventory_row_field_reader_stale:${path}`,
      detail: `this module no longer reads the family, so its ${disposition.kind} disposition exempts nothing and must be deleted`,
    });
  }

  // A CROSSING THAT EXAMINED NOTHING AGREES WITH ITSELF. Zero demanded fields means the row fields and the argument
  // names met nowhere - a schema or a validator this reader can no longer read - and it is blocked rather than green.
  if (demanded.length === 0)
    return {
      status: "blocked",
      violations: [
        ...violations,
        {
          code: "inventory_row_field_population_empty",
          detail:
            `none of the ${String(carried.length)} carried field(s) (${carried.join(", ")}) is named by an action ` +
            "argument, so no row field can be judged: the schema and the validator disagree about the pack row",
        },
      ],
      examined: 0,
      carried,
      demanded,
      readers,
    };

  const renderers = Object.entries(READER_DISPOSITIONS).filter(([, disposition]) => disposition.kind === "renderer");
  const examined = [];
  const delivered = new Set();
  let rendererMissing = false;
  for (const [path, disposition] of renderers) {
    const source = read(root, path);
    const body = source === null ? null : functionBody(source, disposition.fn);
    if (body === null) {
      rendererMissing = true;
      violations.push({
        code: `inventory_row_field_renderer_missing:${disposition.fn}`,
        detail: `${path} declares no \`function ${disposition.fn}\`: the ${disposition.composes} it owns cannot be read`,
      });
      continue;
    }
    for (const field of demanded) {
      const prints = printsField(body, field);
      if (prints) delivered.add(field);
      examined.push({ field, renderer: disposition.fn, reads: readsField(body, field), prints });
      if (prints) continue;
      violations.push({
        code: `inventory_row_field_dropped:${field}:${disposition.fn}`,
        detail:
          `\`${disposition.fn}\` composes ${disposition.composes} without \`${field}\`: an action argument demands that ` +
          "field, so print the row's own value here",
      });
    }
  }
  for (const field of demanded) {
    if (delivered.has(field)) continue;
    violations.push({
      code: `inventory_row_field_nowhere_delivered:${field}`,
      detail: `no renderer of the family interpolates \`${field}\`, and an action argument demands it: the turn carries rows whose address cannot be named from any of it`,
    });
  }

  const dropped = examined.filter((entry) => !entry.prints).length;
  return {
    // A MISSING COMPOSER IS A PREMISE, NOT A FAILING FIELD: the gate could not read what it judges, and the difference
    // is the difference between "this field is dropped" and "this reader is blind here".
    status: rendererMissing ? "blocked" : violations.length === 0 ? "passed" : "failed",
    examined: examined.length,
    carried,
    demanded,
    readers,
    renderers: renderers.length,
    dropped,
    examinedRows: examined,
    violations,
    unreadable: [],
  };
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const reading = auditInventoryRowFields({ root });
  const report = {
    gate: "inventory-row-field-rendering",
    status: reading.status,
    examined: reading.examined ?? 0,
    carriedFields: reading.carried ?? [],
    demandedFields: reading.demanded ?? [],
    readers: reading.readers ?? [],
    renderers: reading.renderers ?? 0,
    dropped: reading.dropped ?? 0,
    checks: [
      {
        id: "demanded_field_population",
        status: (reading.demanded ?? []).length === 0 ? "blocked" : "passed",
        detail: `${String((reading.demanded ?? []).length)} row field(s) an action argument names`,
      },
      {
        id: "every_reader_declared",
        status: (reading.readers ?? []).length === 0 ? "blocked" : "passed",
        detail: `${String((reading.readers ?? []).length)} module(s) read the family`,
      },
      {
        id: "every_demanded_field_printed",
        status: reading.status === "blocked" ? "blocked" : reading.violations.length === 0 ? "passed" : "failed",
        detail: `${String(reading.violations.length)} violation(s)`,
      },
    ],
  };
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...report, examinedRows: reading.examinedRows ?? [] })}\n`);
  } else {
    process.stdout.write(
      `inventory row fields carried ${String(report.carriedFields.length)} · demanded ${String(report.demandedFields.length)} ` +
        `(${report.demandedFields.join(", ") || "none"}) · readers ${String(report.readers.length)} ` +
        `(${report.readers.join(", ") || "none"}) · renderers ${String(report.renderers)} · ` +
        `crossed ${String(report.examined)} · dropped ${String(report.dropped)} · status ${report.status}\n`,
    );
    for (const line of reading.unreadable) process.stderr.write(`inventory_row_field_unreadable: ${line}\n`);
    for (const violation of reading.violations) process.stderr.write(`${violation.code}: ${violation.detail}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  if ((reading.examined ?? 0) === 0) {
    process.stderr.write(
      "inventory_row_field_population_empty: no carried field was crossed with an action argument, so nothing can be " +
        "judged; a green run reads crossed>=1\n",
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = reading.status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
