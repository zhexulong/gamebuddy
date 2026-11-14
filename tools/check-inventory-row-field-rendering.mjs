#!/usr/bin/env node
/**
 * The gate for "an action asks for a field of the pack row that the text she reads never printed".
 *
 * WHY (measured 2026-11-23, the 7-dimension review of this tree). `inventoryItemFacts` is the Mod's own bounded
 * inventory publication: 36 rows of `{slot, qualifiedItemId, displayName, stack}`. `<world-state>` printed each row as
 * `12 份 石头` - the name and the count - and dropped the SLOT. Three actions address a pack row by that number and by
 * nothing else:
 *
 *   open_geode               slot + expectedQualifiedItemId (`host/src/protocol.ts`, EXECUTION_REQUEST_ARGUMENT_RULES)
 *   deposit_silo_hay         slot
 *   put_item_in_fish_tank    slot
 *
 * so the companion was asked for a number she had never been shown, and her only route to it was a `stardew_observe`
 * round trip whose necessity nothing stated. The one field that was dropped is the instance; the class is that no
 * check related the fields a row CARRIES to the fields an action DEMANDS.
 *
 * THE POPULATION IS TWO AUTHORITIES CROSSED, never a list here:
 *
 *   carried fields   `protocol/bridge-v1.schema.json`: the `$defs.snapshot.properties.inventoryItemFacts.items.$ref`
 *                    record's own property names. Fixing one row field is a schema edit, and this gate follows it.
 *   demanded names   `host/src/protocol.ts`'s `EXECUTION_REQUEST_ARGUMENT_RULES`, read through the reader
 *                    `tools/check-action-surface-parity.mjs` already owns (the `exactArgs([...])` rows, `argumentNames`
 *                    as data). One reader, two gates - a second parse of the same table would be a second spelling.
 *
 * A carried field is DEMANDED when an action argument names it, either literally (`slot`) or through the
 * `expected<Field>` spelling the Host uses for a value it checks against the row (`expectedQualifiedItemId` names
 * `qualifiedItemId`). That spelling is not cosmetic: `open_geode` refuses a stale copy, so the pair is the argument.
 *
 * THE PROPERTY. A renderer that publishes this family as text must INTERPOLATE every demanded field inside the
 * function that composes the sentence. Reading the field to decide something else does not count - `formatCarrying`
 * filtered rows on `row.qualifiedItemId` and still printed no id, and a check that counted any read as a rendering
 * would have been green on the exact defect this file exists for.
 *
 * WHAT THIS GATE CANNOT SEE, said rather than implied. It is a static read of the composer, so it proves the field
 * reaches a template in that function: it cannot prove the template is the one the build ships, that the number is the
 * row's own rather than a default, or that the line stays readable. Those are the renderer's own tests' job -
 * `host/src/fact-brief.private.test.ts` drives the real composer and asserts the row's own slot appears, that a second
 * world's slot replaces it, and that a truncated list names the reading which carries the slots it dropped.
 *
 * FINDINGS, each naming the member that broke and what would have to change:
 *   inventory_row_field_dropped:<field>:<renderer>     a demanded field reaches no template in that renderer
 *   inventory_row_field_renderer_missing:<renderer>    the declared composer is gone (a premise, not a pass)
 *   inventory_row_field_vocabulary_unreadable:<why>    the row record or the argument table could not be read
 *   inventory_row_field_population_empty               nothing was crossed - BLOCKED, exit 2, never green
 *
 * Usage:
 *   node tools/check-inventory-row-field-rendering.mjs                  # the gate; exit 1 on a finding, 2 on no population
 *   node tools/check-inventory-row-field-rendering.mjs --json           # the crossed population, machine-readable
 *   node tools/check-inventory-row-field-rendering.mjs --root <dir>      # the gate's own fixture (a copied tree)
 *
 * red-proof: history  the commit before this unit's fix — `formatCarrying` mapped rows to `{name, stack}` — exits 1
 *            with `inventory_row_field_dropped:slot:formatCarrying` and `…:qualifiedItemId:formatCarrying`, and the
 *            delivered line was `身上带着 12 份 石头`.
 * red-proof: inject  the slot interpolation deleted from the composer in a copied tree -> exit 1,
 *            `inventory_row_field_dropped:slot:formatCarrying` (tools/check-inventory-row-field-rendering.test.mjs)
 * red-proof: inject  a row field ADDED to the schema fixture and named by an action argument -> the gate demands it with
 *            no edit here, so the population is derived rather than remembered (the same suite).
 */

export const gateDeclaration = {
  id: "check-inventory-row-field-rendering",
  domain: "product",
  tier: "l0",
  kind: "totality",
};

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readWireSurface } from "./check-action-surface-parity.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The wire document: the row shape the Mod publishes and the Host validates. */
const WIRE_SCHEMA = "protocol/bridge-v1.schema.json";

/** The family whose rows an action addresses one row at a time. */
const FAMILY = "inventoryItemFacts";

/** The Host validator: the one authority on which argument names an action demands. */
const ARGUMENT_SOURCE = "host/src/protocol.ts";

/**
 * The composers that publish this family as text to the model, and the function each one composes it in.
 *
 * A renderer is a member because it TURNS the rows into the sentence the companion reads. The consumer-side
 * projections (`host/src/load-...`, the lookup tools) quote the row verbatim and are not sentences, so they are not
 * members: adding one would credit reads as renderings, which is the failure mode this gate was written against.
 */
export const CARRYING_RENDERERS = Object.freeze([
  { path: "host/src/fact-brief.ts", fn: "formatCarrying", publishes: "the `<world-state>` pack sentence" },
]);

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

/** The reading: which carried field each renderer fails to deliver. */
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

  const renderers = CARRYING_RENDERERS.map((renderer) => ({ ...renderer, source: read(root, renderer.path) }));
  const missing = renderers.filter((renderer) => renderer.source === null).map((renderer) => renderer.path);
  if (missing.length > 0) return { status: "blocked", violations: [], unreadable: missing, examined: carried.length };

  // A CROSSING THAT EXAMINED NOTHING AGREES WITH ITSELF. Zero demanded fields means the row fields and the argument
  // names met nowhere - a schema or a validator this reader can no longer read - and it is blocked rather than green.
  if (demanded.length === 0)
    return {
      status: "blocked",
      violations: [
        {
          code: "inventory_row_field_population_empty",
          detail:
            `none of the ${String(carried.length)} carried field(s) (${carried.join(", ")}) is named by an action ` +
            `argument, so no row field can be judged: the schema and the validator disagree about the pack row`,
        },
      ],
      examined: 0,
      carried,
      demanded,
      renderers: renderers.length,
    };

  const violations = [];
  const examined = [];
  let rendererMissing = false;
  for (const renderer of renderers) {
    const body = functionBody(renderer.source, renderer.fn);
    if (body === null) {
      rendererMissing = true;
      violations.push({
        code: `inventory_row_field_renderer_missing:${renderer.fn}`,
        detail: `${renderer.path} declares no \`function ${renderer.fn}\`: the ${renderer.publishes} it owns cannot be read`,
      });
      continue;
    }
    for (const field of demanded) {
      const dropped = !printsField(body, field);
      examined.push({ field, renderer: renderer.fn, dropped });
      if (dropped)
        violations.push({
          code: `inventory_row_field_dropped:${field}:${renderer.fn}`,
          detail:
            `an action argument demands \`${field}\` and ${renderer.path}'s \`${renderer.fn}\` composes ` +
            `${renderer.publishes} without it: print the row's own value, or drop the action argument that demands it`,
        });
    }
  }

  const dropped = examined.filter((entry) => entry.dropped).length;
  return {
    // A MISSING COMPOSER IS A PREMISE, NOT A FAILING FIELD: the gate could not read what it judges, and the difference
    // is the difference between "this field is dropped" and "this reader is blind here".
    status: rendererMissing ? "blocked" : violations.length === 0 ? "passed" : "failed",
    examined: examined.length,
    carried,
    demanded,
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
    renderers: reading.renderers ?? 0,
    dropped: reading.dropped ?? 0,
    checks: [
      {
        id: "demanded_field_population",
        status: (reading.demanded ?? []).length === 0 ? "blocked" : "passed",
        detail: `${String((reading.demanded ?? []).length)} row field(s) an action argument names`,
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
        `(${report.demandedFields.join(", ") || "none"}) · renderers ${String(report.renderers)} · ` +
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
