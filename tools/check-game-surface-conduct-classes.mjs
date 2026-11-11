#!/usr/bin/env node
/**
 * The gate for "a rule that governs FORM, sitting in the Game prompt floor" - one such rule is the instance, the class
 * is that nothing noticed it.
 *
 * WHY (measured 2026-11-11, round46b). The Game floor carried `Speak before you act: ... always deliver a spoken remark
 * to your partner first in the same reply before calling any action or planning tool. Never run tools in total
 * silence ...`. The shipped card already governs how a turn is shaped - `default-companion/card.json`, `system_prompt`:
 * 「说话紧扣当下真实生活体验，收放自如，不啰嗦不客套」 - and an unconditional "always speak first" overrides 收放自如 with
 * its opposite. The floor's own doctrine said so before the rule was deleted: "the prompt governs the floor, the card
 * governs the form; anything that governs form gets deleted". The run answered the rule with 132 bubbles over 93 prompt
 * turns, 90 of them standalone speech with no tool call in the same message, one bubble every 16 seconds. Every review
 * of that file was green, because nothing asked which kind each rule was.
 *
 * THE POPULATION IS THE CONDUCT LIST ITSELF - the elements of `GAME_SURFACE_INTERACTION_CONDUCT` in
 * `host/src/game-surface-prompt-floor.ts`, read by name from the source so a rule added tomorrow joins this gate
 * without an edit here. A hand-written list of rules to check is a test: it can only catch what its author remembered.
 *
 * THE FLOOR HAS TWO OWNERS, so one table is not enough. A rule written inline in the floor module belongs to it; an
 * element that is an IDENTIFIER (`LIVE_STATE_GROUNDING`, ...) belongs to the module that declares it, today
 * `games/stardew/prompt/stardew-game-conduct.ts` - the rules that are true of this save format rather than of a game
 * surface. Each module carries its own `..._CONDUCT_CLASSES` table beside the rules it owns, positionally: entry `n`
 * classifies that module's rule `n`, in the order the floor's one list reads them.
 *
 * THE PROPERTY. Every rule is one of exactly three kinds, and its module's table says which:
 *   - FLOOR   - what she must never do (break character, speak out of world or as a helper, violate a contract rule);
 *   - CHANNEL - how to operate the surface (the mounted tool that moves her body, the machine vocabulary a receipt has
 *               to be translated out of, what to do when an action is refused, what the delivery carries);
 *   - FORM    - how long a turn is, how many beats it carries, what shape the prose takes. THE CARD OWNS THIS, so a
 *               FORM rule in the floor is a finding rather than a classification:
 *               `floor_governs_form:<id>:<module>`.
 * The two populations of a module are positional and must have equal length: a rule at an index its table does not
 * reach is `conduct_rule_without_a_class:<index>:<first words>`, and a table entry with no rule behind it is
 * `stale_conduct_class:<id>` - removing a rule must remove its class, or the table becomes a list nobody reads. An
 * identifier the floor composes but no module declares is `conduct_rule_unowned:<index>:<name>`.
 *
 * Classifying a rule is a judgment, so every entry carries one line of `reason` saying why: an entry with no reason is
 * `conduct_class_without_reason:<id>`, and a value outside the three kinds is `conduct_class_unknown:<id>` rather than
 * silently not-FORM.
 *
 * READING IS BY DECLARATION NAME, NOT BY PARSING TYPESCRIPT. The floor's rules are one element per line - the file's own
 * doc says so - and a table is read as brace-delimited entries, so neither the formatter nor a comment can move what
 * this reads. A list whose elements are no longer one per line makes the reader throw, and that is reported as blocked:
 * a gate that mis-parsed the floor and then passed would be worse than no gate.
 *
 * THE DEFAULT RUN PRINTS THE REPORT, ONE `checks[]` ENTRY PER RULE IT CAN GO RED ON, so
 * `tools/lib/harness-conformance.mjs` reads what this gate judges instead of trusting its prose - the same report shape
 * `tools/check-snapshot-field-rendering.mjs` prints. The entries come from `CONDUCT_RULES`, which every violation below
 * splices its code from: a rule that exists on one side and not the other cannot pass unremarked.
 *
 * Usage:
 *   node tools/check-game-surface-conduct-classes.mjs                 # the gate; exit 1 on a violation, 2 when blocked
 *   node tools/check-game-surface-conduct-classes.mjs --json          # every rule's class, machine-readable
 *   node tools/check-game-surface-conduct-classes.mjs --root <dir>    # the gate's own fixture (a copied tree)
 *
 * red-proof: inject  restoring the deleted "Speak before you act" rule to the floor's list AND classifying it FORM ->
 *            exit 1, `floor_governs_form:speak_before_acting:host/src/game-surface-prompt-floor.ts`, and that rule's
 *            `checks[]` entry reads failed (tools/check-game-surface-conduct-classes.test.mjs).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The floor's own module: the composed list, and the class table of the rules it writes itself. */
export const CONDUCT_SOURCE = "host/src/game-surface-prompt-floor.ts";

/**
 * Every module that owns rules the floor composes, with the name of the table that classifies its rules.
 *
 * <p>
 * This is a list of OWNERS, not of rules: the rules are the composed list's elements, and each one is attributed to the
 * module that declares it. Adding a game means adding its module here - and a module that declares a rule the floor
 * composes but never appears here is `conduct_rule_unowned`, so a missing owner is a finding rather than an omission.
 * </p>
 */
export const CONDUCT_OWNERS = Object.freeze([
  { module: CONDUCT_SOURCE, table: "GAME_SURFACE_CONDUCT_CLASSES" },
  { module: "host/src/games/stardew/prompt/stardew-game-conduct.ts", table: "STARDEW_GAME_CONDUCT_CLASSES" },
]);

const RULES_DECLARATION = "const GAME_SURFACE_INTERACTION_CONDUCT = [";
const RULE_DECLARATION = /^export const ([A-Z][A-Z0-9_]*) =\s*$/u;

/** The three kinds the doctrine names. A class outside this set is a finding, not a fourth kind. */
export const CONDUCT_CLASSES = Object.freeze(["FLOOR", "CHANNEL", "FORM"]);

/**
 * Every rule this gate can go red on: `code` is the finding code (and the `checks[]` id), `protects` the property it
 * protects. Violations splice their code from here, so the report and the findings cannot disagree about which rules
 * exist - the list is written once.
 */
const CONDUCT_RULES = Object.freeze({
  unowned: {
    code: "conduct_rule_unowned",
    protects: "every rule the floor composes is declared by a module in CONDUCT_OWNERS",
  },
  classless: {
    code: "conduct_rule_without_a_class",
    protects: "every composed rule is classified by the table of the module that owns it",
  },
  stale: { code: "stale_conduct_class", protects: "no class entry outlives the rule it classifies" },
  unknown: { code: "conduct_class_unknown", protects: "every class is one of FLOOR / CHANNEL / FORM" },
  unreasoned: { code: "conduct_class_without_reason", protects: "every class carries the line of argument for it" },
  form: { code: "floor_governs_form", protects: "no rule in the floor governs the turn's form - the card owns that" },
});

/** One code per rule, in the order the report lists them. */
export const CONDUCT_RULE_CODES = Object.freeze(Object.values(CONDUCT_RULES).map((rule) => rule.code));

/** The lines between a declaration's opening line and the line that closes it, trimmed. */
function declarationBody(source, declaration, module) {
  const at = source.indexOf(declaration);
  if (at < 0) throw new Error(`${declaration} is not declared in ${module}: this gate reads it by name`);
  const after = source.indexOf("\n", at);
  if (after < 0) throw new Error(`${declaration} in ${module} is not closed on a later line`);
  const lines = [];
  for (const line of source.slice(after + 1).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("]")) return lines;
    lines.push(trimmed);
  }
  throw new Error(`${declaration} in ${module} is never closed by a line starting with "]"`);
}

/** One composed element's own text: `literal` for a string written here, `identifier` for a name declared elsewhere. */
function elementOf(line, index) {
  const body = line.endsWith(",") ? line.slice(0, -1) : null;
  if (body === null)
    throw new Error(
      `conduct element ${String(index)} does not end in a comma, so it is not one rule per line: ${line.slice(0, 60)}...`,
    );
  const open = body.slice(0, 1);
  const close = body.slice(-1);
  if (open === close && ["'", '"', "`"].includes(open)) return { kind: "literal", text: body.slice(1, -1) };
  if (/^[A-Z][A-Z0-9_]*$/u.test(body)) return { kind: "identifier", name: body };
  throw new Error(
    `conduct element ${String(index)} is neither a string literal nor a rule name: ${line.slice(0, 60)}...`,
  );
}

/** Every rule name a module declares as an exported string, with its text. */
function declaredRules(source) {
  const declared = new Map();
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = RULE_DECLARATION.exec(lines[index]);
    if (match === null) continue;
    const valueLine = lines[index + 1]?.trim() ?? "";
    const literal = valueLine.endsWith(";") ? valueLine.slice(0, -1) : null;
    if (literal === null || !/^["'`]/u.test(literal))
      throw new Error(
        `${match[1]} is not declared as a string literal on the following line: ${valueLine.slice(0, 60)}`,
      );
    declared.set(match[1], literal.slice(1, -1));
  }
  return declared;
}

/**
 * Every classified entry in one module's table, in declaration order.
 *
 * Read as brace-delimited blocks rather than lines, so the formatter may break an entry across lines without moving what
 * this sees. An entry missing `id` or `class` is a shape the gate refuses rather than a rule it silently skips.
 */
function tableEntries(source, table, module) {
  const body = declarationBody(source, `const ${table}`, module).join("\n");
  return [...body.matchAll(/\{[^{}]*\}/gu)].map((match, index) => {
    const block = match[0];
    const id = /\bid:\s*"([^"]*)"/u.exec(block)?.[1];
    const klass = /\bclass:\s*"([^"]*)"/u.exec(block)?.[1];
    const reason = /\breason:\s*"([^"]*)"/u.exec(block)?.[1] ?? "";
    if (id === undefined || klass === undefined)
      throw new Error(`${table} entry ${String(index)} is not { id, class, reason }: ${block.slice(0, 60)}...`);
    return { id, class: klass, reason };
  });
}

/**
 * Every rule in the floor, in the order the model reads it, attributed to the module that declares it.
 *
 * Throws rather than returning an empty list when the shape is not what this reads: a gate that silently examined
 * nothing agrees with itself, and the caller turns the throw into `blocked`.
 */
export function conductRules(sources) {
  const floor = sources.get(CONDUCT_SOURCE);
  if (floor === undefined) throw new Error(`${CONDUCT_SOURCE} is not in the population this gate reads`);
  const declared = new Map();
  for (const [module, source] of sources)
    for (const [name, text] of declaredRules(source)) declared.set(name, { text, module });

  const rules = declarationBody(floor, RULES_DECLARATION, CONDUCT_SOURCE)
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
    .map((line, index) => {
      const element = elementOf(line, index);
      if (element.kind === "literal") return { index, module: CONDUCT_SOURCE, text: element.text, name: null };
      const owner = declared.get(element.name);
      if (owner === undefined) return { index, module: null, text: element.name, name: element.name, unowned: true };
      return { index, module: owner.module, text: owner.text, name: element.name };
    });
  if (rules.length === 0)
    throw new Error(`${RULES_DECLARATION} declares no rule: the Game floor is empty, which is not a classification`);
  return rules;
}

/** The first few words of a rule, for a finding that names the rule rather than an index. */
export function firstWords(rule, count = 5) {
  return rule
    .replace(/\\'/gu, "'")
    .split(/\s+/u)
    .filter((word) => word !== "")
    .slice(0, count)
    .join(" ");
}

const read = (root, module) => {
  try {
    return readFileSync(resolve(root, module), "utf8");
  } catch {
    return null;
  }
};

/**
 * The whole reading: every rule, the class it carries, and the findings that make the exit code 1.
 *
 * `rules` is one row per rule - the report a reviewer reads to see the floor's own composition and who owns each line -
 * and `violations` is what fails the gate. `unreadable` is a source this gate needed and could not read, reported as
 * blocked: a classification that cannot be checked is not a classification.
 */
export function auditConductClasses({ root = REPOSITORY_ROOT } = {}) {
  const sources = new Map();
  const unreadable = [];
  for (const owner of CONDUCT_OWNERS) {
    const source = read(root, owner.module);
    if (source === null) unreadable.push(owner.module);
    else sources.set(owner.module, source);
  }
  if (unreadable.length > 0)
    return { status: "blocked", examined: 0, rules: [], classes: {}, violations: [], unreadable };

  let rules;
  const tables = new Map();
  try {
    rules = conductRules(sources);
    for (const owner of CONDUCT_OWNERS)
      tables.set(owner.module, tableEntries(sources.get(owner.module), owner.table, owner.module));
  } catch (error) {
    return {
      status: "blocked",
      examined: 0,
      rules: [],
      classes: {},
      violations: [],
      unreadable: [`${CONDUCT_SOURCE}: ${error.message}`],
    };
  }

  const violations = [];
  const rows = [];
  const counts = { FLOOR: 0, CHANNEL: 0, FORM: 0 };
  for (const rule of rules) {
    if (rule.unowned) {
      violations.push({
        code: `${CONDUCT_RULES.unowned.code}:${String(rule.index)}:${rule.name}`,
        detail:
          "the floor composes this rule but no module in CONDUCT_OWNERS declares it: name the module that owns it, " +
          "and give it an entry in that module's table",
      });
    }
  }

  // One module at a time: its rules in the order the floor reads them, paired positionally with its own table.
  for (const owner of CONDUCT_OWNERS) {
    const mine = rules.filter((rule) => rule.module === owner.module);
    const table = tables.get(owner.module) ?? [];
    const total = Math.max(mine.length, table.length);
    for (let position = 0; position < total; position += 1) {
      const rule = mine[position];
      const entry = table[position];
      if (entry === undefined) {
        violations.push({
          code: `${CONDUCT_RULES.classless.code}:${String(rule.index)}:${firstWords(rule.text)}`,
          detail:
            `this rule of ${owner.module} carries no class in ${owner.table}: classify it FLOOR, CHANNEL or FORM ` +
            "(and if it is FORM, delete it - the card governs form)",
        });
        continue;
      }
      if (rule === undefined) {
        violations.push({
          code: `${CONDUCT_RULES.stale.code}:${entry.id}`,
          detail:
            `${owner.table} classifies ${String(table.length)} rule(s) and ${owner.module} carries ${String(mine.length)}: ` +
            "removing a rule must remove its class entry, or the table stops describing the floor. The pairing is " +
            "positional, so a rule removed from the middle also shifts every entry after it - start from the first " +
            "mismatch between the two lists",
        });
        continue;
      }
      rows.push({ index: rule.index, module: rule.module, class: entry.class, id: entry.id });
      if (!CONDUCT_CLASSES.includes(entry.class)) {
        violations.push({
          code: `${CONDUCT_RULES.unknown.code}:${entry.id}`,
          detail: `"${entry.class}" is not one of ${CONDUCT_CLASSES.join(" / ")}: a class outside the doctrine is not a class`,
        });
        continue;
      }
      counts[entry.class] += 1;
      if (entry.reason.trim() === "")
        violations.push({
          code: `${CONDUCT_RULES.unreasoned.code}:${entry.id}`,
          detail: "a class with no reason is a label nobody argued for, which is how a form rule gets called floor",
        });
      if (entry.class === "FORM")
        violations.push({
          code: `${CONDUCT_RULES.form.code}:${entry.id}:${owner.module}`,
          detail:
            "this rule governs the turn's form, and the card owns that: delete the rule rather than classifying it. " +
            "The floor may bound a monologue; it may not decide how long a turn is or how many beats it carries",
        });
    }
  }

  return {
    status: violations.length === 0 ? "passed" : "failed",
    examined: rules.length,
    classes: counts,
    rules: rows,
    violations,
    unreadable: [],
  };
}

/**
 * One rule's verdict: `blocked` when the reading judged nothing at all, `failed` when the rule fired, `passed` otherwise.
 */
function ruleStatus(count, nothingJudged) {
  if (nothingJudged) return "blocked";
  return count === 0 ? "passed" : "failed";
}

/**
 * The gate's report: its id, verdict and population, plus one `checks[]` entry per rule in `CONDUCT_RULES` - the report
 * `tools/lib/harness-conformance.mjs` runs this gate to read.
 */
export function conductReport(reading) {
  const nothingJudged = reading.status === "blocked" || reading.examined === 0;
  const fired = new Map();
  for (const violation of reading.violations) {
    const code = violation.code.split(":")[0];
    fired.set(code, (fired.get(code) ?? 0) + 1);
  }
  const checks = [
    {
      id: "conduct_population",
      status: reading.examined === 0 ? "blocked" : "passed",
      detail: `${String(reading.examined)} rule(s) in GAME_SURFACE_INTERACTION_CONDUCT`,
    },
    ...Object.values(CONDUCT_RULES).map((rule) => {
      const count = fired.get(rule.code) ?? 0;
      return {
        id: rule.code,
        status: ruleStatus(count, nothingJudged),
        detail: count === 0 ? rule.protects : `${String(count)} violation(s) of ${rule.protects}`,
      };
    }),
  ];
  const blocks = reading.classes;
  return {
    gate: "game-surface-conduct-classes",
    status: reading.status,
    examined: reading.examined,
    FLOOR: blocks.FLOOR ?? 0,
    CHANNEL: blocks.CHANNEL ?? 0,
    FORM: blocks.FORM ?? 0,
    checks,
  };
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const json = argv.includes("--json");
  const reading = auditConductClasses({ root });
  const report = conductReport(reading);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...report, rules: reading.rules })}\n`);
  } else {
    process.stdout.write(
      `conduct rules examined ${String(report.examined)} · FLOOR ${String(report.FLOOR)} · ` +
        `CHANNEL ${String(report.CHANNEL)} · FORM ${String(report.FORM)} · status ${report.status}\n`,
    );
    for (const owner of CONDUCT_OWNERS) {
      const owned = reading.rules.filter((rule) => rule.module === owner.module).length;
      process.stdout.write(`  ${owner.module}: ${String(owned)} rule(s)\n`);
    }
    for (const line of reading.unreadable) process.stderr.write(`conduct_classes_unreadable: ${line}\n`);
    for (const violation of reading.violations) process.stderr.write(`${violation.code}: ${violation.detail}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  if (reading.status === "blocked") {
    process.stderr.write(
      "game_surface_conduct_classes: the conduct or a table could not be read, so nothing was judged; a green run " +
        "reads examined>=1\n",
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = reading.status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
