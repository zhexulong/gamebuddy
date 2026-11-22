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
 *   projection_field_unproduced:<member>.<field>   ...one level in, inside a `strictObject` member
 *   projection_field_not_in_contract:<member>.<field>  ...one level in: the shape the member's NAME resolves to does
 *                                                  not declare it (measured 2026-11-18: `prerequisites.missingItems`)
 *   browser_projection_population_empty            nothing was read - BLOCKED, exit 2, never green
 *   nested_member_population_empty                 no member resolved to a shape with a literal to compare - BLOCKED
 *
 * WHAT IT READS, AND WHY THAT IS PART OF THE RULE. The producer side is the `game:` literal of the function declared to
 * return `GameBrowserStateV1`, not the first `game:` literal in the file: the fact-group builders (`projectGameFacts`)
 * write one each and come first, and a reader that took the first match compared the contract against a fact group -
 * which is how this gate sat red and ignored instead of catching `prerequisites.missingItems` at the commit that broke
 * it. A spread (`...facts.instance.game`) supplies members this reader cannot name, so it is a CEILING: the reading
 * prints how many members it excused that way, and only a member that is neither written nor inside that ceiling is
 * `projection_field_unproduced`.
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
import { rootFromArgv } from "../../tools/lib/gate-preamble.mjs";
import { bracesFrom, withoutComments } from "../../tools/lib/gate-preamble.mjs";

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

/** The `game` object's members from the contract's own `strictObject`, as name → expression. */
export function contractGameMembers(contractSource) {
  const code = withoutComments(contractSource);
  const declaration = /(?:export\s+)?const\s+GameBrowserStateV1Schema\s*=/u.exec(code);
  if (declaration === null) throw new Error("GameBrowserStateV1Schema is not declared: this gate reads it by name");
  const outer = code.indexOf("(", declaration.index);
  const at = code.indexOf("game:", outer);
  if (at < 0) throw new Error("GameBrowserStateV1Schema declares no `game` projection");
  const open = code.indexOf("{", at);
  const body = open < 0 ? null : bracesFrom(code, open);
  if (body === null) throw new Error("the `game` projection is not an object literal this gate can read");
  const members = new Map(objectEntries(body));
  if (members.size === 0) throw new Error("the `game` projection declares no field");
  return members;
}

/** The `game` object's field names, from the contract's own `strictObject`. */
export function contractGameFields(contractSource) {
  return [...contractGameMembers(contractSource).keys()];
}

/**
 * The producer's `game: Object.freeze({ … })` projection members, as name → expression.
 *
 * THE FUNCTION IS FOUND BY ITS RETURN TYPE, not by the first `game:` literal in the file. The fact-group builders
 * (`projectGameFacts`) also write `game: Object.freeze({ … })`, one per fact group, and they come FIRST in the file;
 * a reader that took the first match compared the contract against the fact group and reported the six members the
 * real projection writes as never written. That is how a gate stays red for a week and gets skipped.
 */
export function producedGameFields(producerSource) {
  const code = withoutComments(producerSource);
  const bodies = producerProjectionBodies(code);
  if (bodies.length === 0) throw new Error("the producer writes no `game: Object.freeze({ … })` projection");
  const [body] = bodies;
  const entries = objectEntries(body);
  if (entries.length === 0) throw new Error("the producer's `game` projection declares no field");
  return new Map(entries);
}

/** Every `game: Object.freeze({ … })` body inside a function declared to return the contract's own state. */
function producerProjectionBodies(code) {
  const bodies = [];
  for (const match of code.matchAll(/\)\s*:\s*GameBrowserStateV1\s*\{/gu)) {
    const open = code.indexOf("{", match.index + match[0].length - 1);
    const fnBody = open < 0 ? null : bracesFrom(code, open);
    if (fnBody === null) continue;
    const at = /(?:^|\n)\s*game: Object\.freeze\(\{/u.exec(fnBody);
    if (at === null) continue;
    const literal = bracesFrom(fnBody, fnBody.indexOf("{", at.index + at[0].length - 1));
    if (literal !== null) bodies.push(literal);
  }
  return bodies;
}

/**
 * The member names a spread inside the projection can supply, as a CEILING.
 *
 * `...facts.instance.game` is not resolvable by name from here, but every name it can carry is written by one of the
 * fact-group `game:` literals in the same file. So the union of those literals is the widest set the spread can supply:
 * the "producer never writes it" rule is applied only to a member that is neither written explicitly nor inside that
 * ceiling, and the reading prints how many fields were excused this way so the ceiling is never read as an exact
 * comparison.
 */
export function spreadCoveredFields(producerSource) {
  const code = withoutComments(producerSource);
  const projection = producerProjectionBodies(code)[0];
  const covered = new Set();
  for (const match of code.matchAll(/(?:^|\n)\s*game: Object\.freeze\(\{/gu)) {
    const open = code.indexOf("{", match.index + match[0].length - 1);
    const literal = open < 0 ? null : bracesFrom(code, open);
    if (literal === null || literal === projection) continue;
    for (const name of new Map(objectEntries(literal)).keys()) covered.add(name);
  }
  return covered;
}

/** Every number a producer value writes for itself, ignoring the digits inside string literals. */
export function numericLiterals(expression) {
  const withoutStrings = expression
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replace(/'(?:[^'\\]|\\.)*'/gu, "''")
    .replace(/`(?:[^`\\]|\\.)*`/gu, "``");
  return [...withoutStrings.matchAll(/(?<![\w$.])\d+(?:\.\d+)?(?![\w$])/gu)].map((match) => match[0]);
}

/**
 * The contract module's own `strictObject({ … })` declarations, by name.
 *
 * A `game` member is usually a REFERENCE to one of these (`prerequisites: GamePrerequisiteStateV1Schema`), so the
 * member's shape is not at the member: it is at the declaration its name points at. Resolving it here is what makes
 * the nested reading possible without a hand-written table of "shapes to check".
 */
export function strictObjectDeclarations(contractSource) {
  const code = withoutComments(contractSource);
  const declarations = new Map();
  for (const match of code.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*strictObject\(\{/gu)) {
    const open = code.indexOf("{", match.index + match[0].length - 1);
    const body = open < 0 ? null : bracesFrom(code, open);
    if (body === null) continue;
    const members = new Map(objectEntries(body));
    if (members.size > 0) declarations.set(match[1], members);
  }
  return declarations;
}

/**
 * The object shape a contract member's expression names, as name → expression, or null for a leaf.
 *
 * An inline `strictObject({ … })`, or a bare name that the module declares as one, is a shape; a union, an enum, a
 * `Type.String(...)` and a `Type.Optional(...)` are leaves whose members no producer literal can be compared to.
 */
export function contractMemberShape(expression, declarations, seen = new Set()) {
  const value = expression.trim();
  if (value.startsWith("strictObject({")) return new Map(objectEntries(bracesFrom(value, value.indexOf("{")) ?? ""));
  if (!/^[A-Za-z_$][\w$]*$/u.test(value)) return null;
  const declared = declarations.get(value);
  if (declared === undefined || seen.has(value)) return null;
  seen.add(value);
  return declared;
}

/** Every object literal a producer expression can take as its value, one per branch it can choose between. */
export function producerValueLiterals(expression) {
  const literals = [];
  for (const match of expression.matchAll(/Object\.freeze\(\s*\{/gu)) {
    const open = expression.indexOf("{", match.index + match[0].length - 1);
    const body = open < 0 ? null : bracesFrom(expression, open);
    if (body !== null) literals.push(body);
  }
  if (literals.length === 0 && expression.trim().startsWith("{")) {
    const body = bracesFrom(expression.trim(), 0);
    if (body !== null) literals.push(body);
  }
  return literals;
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
  let members;
  let coveredBySpread = new Set();
  try {
    members = contractGameMembers(contractSource);
    fields = [...members.keys()];
    produced = producedGameFields(producerSource);
    coveredBySpread = spreadCoveredFields(producerSource);
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
  const declaredShapes = strictObjectDeclarations(contractSource);
  /**
   * ONE LEVEL IN, WHERE THE MERGE BROKE THE TREE (measured 2026-11-18, `ef9b8c15`).
   *
   * `0f2ca8e3` deleted `missingItems` from `GamePrerequisiteStateV1Schema` - the Host's readiness view is binary and has
   * no per-item list - and the producer in `game-browser-state-provider.ts` kept writing it. Neither `typecheck` nor
   * this gate saw it: the literal is wrapped in `Object.freeze`, so no excess-property check applies, and the rules
   * above compare only the `game` object's IMMEDIATE members, where `prerequisites` is present on both sides. The
   * product consequence was a Host that refused its own bootstrap: the composed root validates every game snapshot it
   * projects, so `game.state.read` failed its contract with 409 `game_snapshot_mismatch` before a session existed.
   *
   * The row below is the same two directions as above, at the depth where a `strictObject` member is answered by an
   * object literal: the shape comes from the declaration the member's name resolves to, and the literal comes from the
   * producer's own branches. A member answered by a spread or a helper call is opaque here and is left to the runtime
   * check that guards the wire (`composed-reference-game-browser.ts`) and to the provider's own validation tests.
   */
  let nestedExamined = 0;
  for (const [field, contractExpression] of members) {
    const shape = contractMemberShape(contractExpression, declaredShapes);
    if (shape === null) continue;
    const expression = produced.get(field);
    if (expression === undefined) continue;
    const literals = producerValueLiterals(expression);
    if (literals.length === 0) continue;
    nestedExamined += 1;
    const written = new Set();
    for (const literal of literals)
      for (const name of new Map(objectEntries(literal)).keys()) {
        written.add(name);
        if (shape.has(name)) continue;
        violations.push({
          code: `projection_field_not_in_contract:${field}.${name}:${PRODUCER_PATH}`,
          detail:
            `the producer writes \`game.${field}.${name}\` and \`${contractExpression.trim()}\` declares no such field: ` +
            "a value no consumer can read, and a snapshot the contract refuses",
        });
      }
    // A spread inside the literal means part of the value comes from elsewhere, so an absent member is not evidence.
    if (literals.some((literal) => literal.includes("..."))) continue;
    for (const name of shape.keys())
      if (!written.has(name))
        violations.push({
          code: `projection_field_unproduced:${field}.${name}:${PRODUCER_PATH}`,
          detail: `the contract declares \`game.${field}.${name}\` and every literal the producer answers \`${field}\` with omits it`,
        });
  }

  for (const field of fields) {
    const expression = produced.get(field);
    if (expression === undefined) {
      // A member a spread supplies is not a member nobody answers. The ceiling is printed, not assumed exact.
      if (coveredBySpread.has(field)) {
        dispositions.push({ field, derived: null, constant: null, covered: true });
        continue;
      }
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
  // One member is one finding: a branch that writes the same foreign field in both arms is one defect, not two.
  const unique = [...new Map(violations.map((violation) => [violation.code, violation])).values()];
  // FAIL ON ZERO, one level up as well as at the top: a nested reading that found no literal to compare examined
  // nothing, and a check whose population is empty agrees with itself.
  if (nestedExamined === 0)
    violations.push({
      code: "nested_member_population_empty",
      detail:
        "no `game` member resolved to a `strictObject` shape the producer answers with an object literal, so the " +
        "nested rule judged nothing: the reader is broken, not the tree",
    });
  return {
    status: unique.length === 0 ? "passed" : "failed",
    examined: fields.length,
    nested: nestedExamined,
    derived: fields.length - constant,
    constant,
    declared: Object.keys(declarations).length,
    dispositions,
    violations: unique,
    unreadable: [],
  };
}

function main(argv) {
  const root = rootFromArgv(argv, REPOSITORY_ROOT);
  const reading = auditBrowserStateProjection({ root });
  const report = {
    gate: "browser-state-projection-fields",
    status: reading.status,
    examined: reading.examined,
    derived: reading.derived ?? 0,
    constant: reading.constant ?? 0,
    declared: reading.declared ?? 0,
    nested: reading.nested ?? 0,
    checks: [
      {
        id: "game_projection_population",
        status: reading.examined === 0 ? "blocked" : "passed",
        detail: `${String(reading.examined)} field(s) in the contract's \`game\` projection`,
      },
      {
        id: "nested_member_population",
        status: reading.nested === 0 ? "blocked" : "passed",
        detail: `${String(reading.nested ?? 0)} \`game\` member(s) compared one level in against the shape its name resolves to`,
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
      `browser projection fields examined ${String(report.examined)} · nested ${String(reading.nested ?? 0)} · ` +
        `derived ${String(report.derived)} · constant ${String(report.constant)} · declared ${String(report.declared)} · ` +
        `status ${report.status}\n`,
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
