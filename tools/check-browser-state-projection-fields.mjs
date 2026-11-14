#!/usr/bin/env node
/**
 * The gate for "a field the browser state projection publishes is a literal, so the panel states a fact the Host never
 * measured".
 *
 * WHY (measured 2026-11-23, the 7-dimension review of this tree). `game.state.read` answered
 *
 *     capabilitySummary: Object.freeze({ available: false, count: 0 })
 *
 * unconditionally, so `dialogue-web`'s companion board read the literal and said "no capability published" whatever the
 * live surface said: `capabilitiesLabel` and `deriveCapabilityBoard` both branch on `.available`, and `.available` was a
 * word this file wrote rather than a fact it read. The survey found the shape four times in one object (`role`,
 * `companionName` and `selectedSave` are also literals); three of them are honest debts with no source today and one of
 * them - the capability count - was a fact the Host already measures elsewhere.
 *
 * THE POPULATION IS THE CONTRACT'S OWN FIELD SET. `host/src/game-browser-contract/index.ts` declares
 * `GameBrowserStateV1Schema.game` as a `strictObject`, and the producer in
 * `host/src/game-browser/game-browser-state-provider.ts` must answer every member of it. Both directions are checked: a
 * contract field with no producer value, and a producer field the contract does not declare, are named. A hand-written
 * list of "fields to watch" would be a test - it can only catch what its author remembered.
 *
 * THE PROPERTY. A producer value is CONSTANT when it cannot vary with any input the provider was given: a `null`, a
 * boolean, a number, a string literal, or an array/object literal built only of those. Everything else is derived -
 * `attachment.status`, `actionAuthority?.status ?? "unavailable"`, `prerequisitesMet ? … : …` - and a derived value is
 * the only kind a live fact can reach the browser through.
 *
 * A CONSTANT IS NOT ALWAYS A LIE, AND THE REASON IS THE RECORD THAT SOMEONE LOOKED. `UNPUBLISHED_PROJECTION_FIELDS`
 * carries one entry per constant field: why nothing can publish it today, and which file owes the next move. The entry
 * EXPIRES - the moment the field starts being derived, `stale_constant_field_reason:<field>` goes red and the entry is
 * deleted rather than kept as a comfortable note - and a blank reason is `constant_field_without_a_reason:<field>`.
 *
 * FINDINGS, each naming the drifting member:
 *   published_field_is_a_constant:<field>:<file>   a contract field whose value no input can change
 *   constant_field_without_a_reason:<field>        ...and nobody wrote down why that is acceptable
 *   stale_constant_field_reason:<field>            a declared constant that is derived now, or has left the projection
 *   projection_field_unproduced:<field>:<file>     the contract declares it and the producer never writes it
 *   projection_field_not_in_contract:<field>:<file> the producer writes a field the contract does not declare
 *   browser_projection_population_empty            nothing was read - BLOCKED, exit 2, never green
 *
 * Usage:
 *   node tools/check-browser-state-projection-fields.mjs               # the gate; exit 1 on a finding, 2 on no population
 *   node tools/check-browser-state-projection-fields.mjs --json        # every field's disposition, machine-readable
 *   node tools/check-browser-state-projection-fields.mjs --root <dir>   # the gate's own fixture (a copied tree)
 *
 * red-proof: history  the commit before this unit's fix reddens with
 *            `published_field_is_a_constant:capabilitySummary:host/src/game-browser/game-browser-state-provider.ts` while
 *            the panel rendered `available: false` as "no capability published".
 * red-proof: inject  `capabilitySummary` restored to a frozen literal in a copied tree -> exit 1, the code above
 *            (tools/check-browser-state-projection-fields.test.mjs).
 * red-proof: inject  an `UNPUBLISHED_PROJECTION_FIELDS` entry for a DERIVED field -> exit 1,
 *            `stale_constant_field_reason:<field>`: an exemption must expire (the same suite).
 */

export const gateDeclaration = {
  id: "check-browser-state-projection-fields",
  domain: "product",
  tier: "l0",
  kind: "totality",
};

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The browser contract: the ONE declaration of what `game.state.read` publishes. */
export const CONTRACT_PATH = "host/src/game-browser-contract/index.ts";

/** The producer that answers it. */
export const PRODUCER_PATH = "host/src/game-browser/game-browser-state-provider.ts";

/**
 * The constant fields that are decisions rather than facts, each with the reason and the owner who owes the next move.
 *
 * An entry is checked twice: the field must still be constant (or the entry has expired), and the reason must be written.
 */
export const UNPUBLISHED_PROJECTION_FIELDS = Object.freeze({
  role: {
    reason:
      "The embodied role an attestation would name. Nothing this projection may read publishes one: " +
      "`host/src/stardew-role-lifecycle-facade.ts` states in its own header that no field may claim capability or " +
      "companion role attestation, and the board renders `role !== \"companion\"` as the truthful 'no companion yet' " +
      "until an attestation surface exists.",
    owedBy: "host/src/stardew-role-lifecycle-facade.ts",
  },
  companionName: {
    reason:
      "The companion's own name, which travels with the role attestation above: no reader in this projection carries " +
      "it, and a name invented here would be the surface naming a companion the Host has not attested.",
    owedBy: "host/src/stardew-role-lifecycle-facade.ts",
  },
  selectedSave: {
    reason:
      "The save id inside the selected world. The world-binding reader publishes the opaque `worldRef` that " +
      "`selectedWorld` carries and no save identity beside it, so this field waits on a save-selection surface rather " +
      "than on a renderer.",
    owedBy: "host/src/stardew-production-lifecycle-coordinator.internal.ts",
  },
});

const read = (root, path) => {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    return null;
  }
};

/** A line comment, a block comment: text a reader wrote for a person, never a value. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/u, ""))
    .join("\n");
}

/** The text from an opening brace to its match, or null. */
function bracesFrom(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

/**
 * One object literal's top-level members, as `[name, expression]`, comments already stripped.
 *
 * Splitting is depth- and quote-aware rather than line-based: `browserSession: strictObject({ … })` and a multi-line
 * `Object.freeze({ … })` both carry braces of their own, and a line reader would attribute their members to their parent.
 */
export function objectEntries(body) {
  const inner = body.slice(body.indexOf("{") + 1, body.lastIndexOf("}"));
  const entries = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  const push = (end) => {
    const chunk = inner.slice(start, end).trim();
    start = end + 1;
    if (chunk === "") return;
    const separator = chunk.indexOf(":");
    if (separator < 0) return;
    const name = chunk.slice(0, separator).trim();
    if (!/^[A-Za-z_$][\w$]*$/u.test(name)) return;
    entries.push([name, chunk.slice(separator + 1).trim()]);
  };
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quote !== null) {
      if (character === quote && inner[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{" || character === "(" || character === "[") depth += 1;
    else if (character === "}" || character === ")" || character === "]") depth -= 1;
    else if (character === "," && depth === 0) push(index);
  }
  push(inner.length);
  return entries;
}

/** The `Object.freeze({ … })` / `{ … }` / `[ … ]` literal an expression is wrapped in, or null. */
function literalWrapper(expression) {
  const frozen = /^Object\.freeze\(\s*([[{])/u.exec(expression);
  if (frozen !== null) return expression.slice(frozen[0].length - 1).trim();
  if (expression.startsWith("{") || expression.startsWith("[")) return expression;
  return null;
}

/**
 * Whether a producer value cannot vary with ANY input: a primitive literal, or a literal built only of literals.
 *
 * Deliberately syntactic. A reader that tried to reason about reachability would answer "it could vary" for code that
 * never runs, which is the answer the defect already had.
 */
export function isConstantExpression(expression) {
  const value = expression.trim();
  if (/^(?:null|undefined|true|false|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')$/u.test(value)) return true;
  const literal = literalWrapper(value);
  if (literal === null) return false;
  if (literal.startsWith("[")) {
    const inner = literal.slice(1, literal.lastIndexOf("]"));
    return inner.trim() === "" || splitTopLevel(inner).every((element) => isConstantExpression(element));
  }
  return objectEntries(literal).every(([, member]) => isConstantExpression(member));
}

/** The top-level elements of an array literal, depth- and quote-aware. */
function splitTopLevel(inner) {
  const elements = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quote !== null) {
      if (character === quote && inner[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{" || character === "(" || character === "[") depth += 1;
    else if (character === "}" || character === ")" || character === "]") depth -= 1;
    else if (character === "," && depth === 0) {
      elements.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail !== "") elements.push(tail);
  return elements;
}

/** The `game` object's field names, from the contract's own `strictObject`. */
export function contractGameFields(contractSource) {
  const code = withoutComments(contractSource);
  const declaration = code.indexOf("export const GameBrowserStateV1Schema");
  if (declaration < 0) throw new Error("GameBrowserStateV1Schema is not declared: this gate reads it by name");
  const outer = code.indexOf("(", declaration);
  const at = code.indexOf("game:", outer);
  if (at < 0) throw new Error("GameBrowserStateV1Schema declares no `game` projection");
  const open = code.indexOf("{", at);
  const body = open < 0 ? null : bracesFrom(code, open);
  if (body === null) throw new Error("the `game` projection is not an object literal this gate can read");
  const fields = objectEntries(body).map(([name]) => name);
  if (fields.length === 0) throw new Error("the `game` projection declares no field");
  return fields;
}

/** The producer's `game: Object.freeze({ … })` members, as name → expression. */
export function producedGameFields(producerSource) {
  const code = withoutComments(producerSource);
  const at = /(?:^|\n)\s*game: Object\.freeze\(\{/u.exec(code);
  if (at === null) throw new Error("the producer writes no `game: Object.freeze({ … })` projection");
  const open = code.indexOf("{", at.index + at[0].length - 2);
  const body = open < 0 ? null : bracesFrom(code, open);
  if (body === null) throw new Error("the producer's `game` projection is not an object literal this gate can read");
  const entries = objectEntries(body);
  if (entries.length === 0) throw new Error("the producer's `game` projection declares no field");
  return new Map(entries);
}

/** Every number a producer value writes for itself, ignoring the digits inside string literals. */
export function numericLiterals(expression) {
  const withoutStrings = expression
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replace(/'(?:[^'\\]|\\.)*'/gu, "''")
    .replace(/`(?:[^`\\]|\\.)*`/gu, "``");
  return [...withoutStrings.matchAll(/(?<![\w$.])\d+(?:\.\d+)?(?![\w$])/gu)].map((match) => match[0]);
}

/** The reading: which contract fields the producer answers, and which of those it answers with a literal. */
export function auditBrowserStateProjection({
  root = REPOSITORY_ROOT,
  declarations = UNPUBLISHED_PROJECTION_FIELDS,
} = {}) {
  const contractSource = read(root, CONTRACT_PATH);
  const producerSource = read(root, PRODUCER_PATH);
  const unreadable = [];
  if (contractSource === null) unreadable.push(CONTRACT_PATH);
  if (producerSource === null) unreadable.push(PRODUCER_PATH);
  if (unreadable.length > 0) return { status: "blocked", violations: [], unreadable, examined: 0, dispositions: [] };

  let fields;
  let produced;
  try {
    fields = contractGameFields(contractSource);
    produced = producedGameFields(producerSource);
  } catch (error) {
    return {
      status: "blocked",
      violations: [],
      unreadable: [`${CONTRACT_PATH} or ${PRODUCER_PATH}: ${error.message}`],
      examined: 0,
      dispositions: [],
    };
  }

  const violations = [];
  const dispositions = [];
  for (const field of fields) {
    const expression = produced.get(field);
    if (expression === undefined) {
      dispositions.push({ field, derived: null, constant: null });
      violations.push({
        code: `projection_field_unproduced:${field}:${PRODUCER_PATH}`,
        detail: `the contract declares \`${field}\` and the producer never writes it: the panel reads a field nobody answers`,
      });
      continue;
    }
    const constant = isConstantExpression(expression);
    const declared = declarations[field];
    dispositions.push({ field, constant, derived: !constant, value: expression });
    if (!constant) {
      if (declared !== undefined)
        violations.push({
          code: `stale_constant_field_reason:${field}`,
          detail: `the producer derives \`${field}\` now (${expression}), so the declared reason (owed by ${declared.owedBy}) has expired and must be deleted`,
        });
      continue;
    }
    if (declared === undefined) {
      violations.push({
        code: `published_field_is_a_constant:${field}:${PRODUCER_PATH}`,
        detail:
          `\`${field}\` is \`${expression}\`: no input the provider is given can change it, so the browser renders a ` +
          "literal as a fact. Derive it from the live surface, or record why nothing can publish it in " +
          "UNPUBLISHED_PROJECTION_FIELDS",
      });
      continue;
    }
    if (typeof declared.reason !== "string" || declared.reason.trim() === "")
      violations.push({
        code: `constant_field_without_a_reason:${field}`,
        detail: `\`${field}\` is declared as an unpublished fact with nothing said about what would publish it`,
      });
    continue;
  }

  // A NUMBER IN THIS PROJECTION IS ALWAYS A COUNT OF SOMETHING THE HOST MEASURED. A field that writes one for itself -
  // `count: 0` beside an absent source - states a measurement nobody took: the same defect as a literal field, one level
  // in, and the shape the capability summary used (`{available: false, count: 0}`) to say "nothing is published" and
  // "nobody looked" with the same zero.
  for (const [field, expression] of produced) {
    if (declarations[field] !== undefined) continue;
    const literals = numericLiterals(expression);
    if (literals.length === 0) continue;
    violations.push({
      code: `published_field_reports_a_zero_it_did_not_measure:${field}:${PRODUCER_PATH}`,
      detail:
        `\`${field}\` writes the number(s) ${literals.join(", ")} for itself in \`${expression}\`: a count in this ` +
        "projection comes from a reader, so derive it or declare the field in UNPUBLISHED_PROJECTION_FIELDS",
    });
  }

  const onContract = new Set(fields);
  for (const field of produced.keys())
    if (!onContract.has(field))
      violations.push({
        code: `projection_field_not_in_contract:${field}:${PRODUCER_PATH}`,
        detail: `the producer writes \`${field}\` and the contract declares no such field: a value no consumer can read`,
      });
  for (const [field, declared] of Object.entries(declarations)) {
    if (onContract.has(field)) continue;
    violations.push({
      code: `stale_constant_field_reason:${field}`,
      detail: `the contract declares no \`${field}\`, so its reason (owed by ${declared.owedBy}) exempts nothing and must be deleted`,
    });
  }

  const constant = dispositions.filter((entry) => entry.constant === true).length;
  return {
    status: violations.length === 0 ? "passed" : "failed",
    examined: fields.length,
    derived: fields.length - constant,
    constant,
    declared: Object.keys(declarations).length,
    dispositions,
    violations,
    unreadable: [],
  };
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const reading = auditBrowserStateProjection({ root });
  const report = {
    gate: "browser-state-projection-fields",
    status: reading.status,
    examined: reading.examined,
    derived: reading.derived ?? 0,
    constant: reading.constant ?? 0,
    declared: reading.declared ?? 0,
    checks: [
      {
        id: "game_projection_population",
        status: reading.examined === 0 ? "blocked" : "passed",
        detail: `${String(reading.examined)} field(s) in the contract's \`game\` projection`,
      },
      {
        id: "no_field_is_a_literal",
        status: reading.status === "blocked" ? "blocked" : reading.violations.length === 0 ? "passed" : "failed",
        detail: `${String(reading.violations.length)} violation(s)`,
      },
    ],
  };
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...report, dispositions: reading.dispositions })}\n`);
  } else {
    process.stdout.write(
      `browser projection fields examined ${String(report.examined)} · derived ${String(report.derived)} · ` +
        `constant ${String(report.constant)} · declared ${String(report.declared)} · status ${report.status}\n`,
    );
    for (const line of reading.unreadable) process.stderr.write(`browser_projection_unreadable: ${line}\n`);
    for (const violation of reading.violations) process.stderr.write(`${violation.code}: ${violation.detail}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  if (reading.examined === 0) {
    process.stderr.write(
      "browser_projection_population_empty: the contract's `game` projection was not read, so nothing can be judged; " +
        "a green run reads examined>=1\n",
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = reading.status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
