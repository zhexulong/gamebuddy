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
 * THE PAIRING USED TO BE POSITIONAL AND THIS GATE READ ITS RESULT (measured 2026-11-15). The floor carried its rules as
 * one array and their classes as another, joined only by array index, and this gate paired each module's rules with that
 * module's table by position. Swapping the markdown/delivery rule with the observation-honesty rule - two rules of
 * different classes - moved the class onto its neighbour's rule and left the report reading `status: passed`,
 * `examined 19`, `FLOOR 10`, `CHANNEL 9`, exit 0: the observation contract was recorded as a delivery rule and the
 * delivery rule as observation honesty. A gate that reads the result of a pairing cannot see the pairing move, so the
 * pairing itself had to become structural: the class now lives inside the rule's own entry, and an element of the
 * composed prompt is a REFERENCE to a declared rule, never a copy of its text.
 *
 * THE POPULATION IS THE CONDUCT LIST ITSELF - the elements of `GAME_SURFACE_INTERACTION_CONDUCT` in
 * `host/src/game-surface-prompt-floor.ts`, read by name from the source so a rule added tomorrow joins this gate
 * without an edit here. A hand-written list of rules to check is a test: it can only catch what its author remembered.
 * An element is one of:
 *   - `GAME_SURFACE_CONDUCT_RULES.<id>.text` - a rule the floor owns, declared with its class in
 *     `GAME_SURFACE_CONDUCT_RULES` (a record keyed by the rule's id);
 *   - an IDENTIFIER (`LIVE_STATE_GROUNDING`, ...) - a rule a game module exports, classified by that module's own
 *     `..._CONDUCT_CLASSES` table and joined to it BY THE RULE'S NAME, never by position: the id of such a rule is its
 *     declaration name lowercased, and a table entry naming nothing is a finding;
 *   - a STRING LITERAL - a rule spelled into the prompt instead of declared: `conduct_rule_without_a_class`, because a
 *     rule written there carries no entry for its class to live in.
 *
 * THE PROPERTY. Every rule is one of exactly three kinds, and its own declaration says which:
 *   - FLOOR   - what she must never do (break character, speak out of world or as a helper, violate a contract rule);
 *   - CHANNEL - how to operate the surface (the mounted tool that moves her body, the machine vocabulary a receipt has
 *               to be translated out of, what to do when an action is refused, what the delivery carries);
 *   - FORM    - how long a turn is, how many beats it carries, what shape the prose takes. THE CARD OWNS THIS, so a
 *               FORM rule in the floor is a finding rather than a classification:
 *               `floor_governs_form:<id>:<module>`.
 * A class is stated ONCE, inside the rule's own entry. The floor's `GAME_SURFACE_CONDUCT_CLASSES` is a projection of
 * those entries, so a class written back into it is `conduct_class_restated:<id>` - the second spelling that can
 * disagree with the entry it names. A composed rule no module declares is `conduct_rule_unowned:<index>:<name>`; a
 * declared rule no composed element reaches is `stale_conduct_class:<id>`, because removing a rule must remove its
 * class, or the table becomes a list nobody reads.
 *
 * Classifying a rule is a judgment, so every entry carries one line of `reason` saying why: an entry with no reason is
 * `conduct_class_without_reason:<id>`, and a value outside the three kinds is `conduct_class_unknown:<id>` rather than
 * silently not-FORM.
 *
 * READING IS BY DECLARATION NAME, NOT BY PARSING TYPESCRIPT. The composed list's elements are one per line - the file's
 * own doc says so - and an entry or table row is read as the lines between its own braces, so the formatter may break a
 * reason across lines without moving what this sees. A shape this cannot read makes the reader throw, and that is
 * reported as blocked: a gate that mis-parsed the floor and then passed would be worse than no gate.
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
 * red-proof: inject  a second, hand-written class table beside the floor's entries with one entry's class flipped ->
 *            exit 1, `conduct_class_restated:<id>`, naming the class it states and the one the rule's own entry
 *            declares (tools/check-game-surface-conduct-classes.test.mjs). Also injected there, each seen red once: a
 *            rule's text spelled into the composed list instead of a reference to its entry, an entry classified FORM,
 *            a Stardew rule removed from the floor while its class stays behind, a class outside the three kinds, a
 *            class with no reason, a composed name no module declares, a renamed declaration (blocked, exit 2 - never
 *            green), and a list whose elements are no longer one per line (blocked).
 */

export const gateDeclaration = {
  id: "check-game-surface-conduct-classes",
  domain: "product",
  tier: "l1",
  kind: "contract",
};

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The floor's own module: the classed rules, the composed list, and the projection of those entries as a table. */
export const CONDUCT_SOURCE = "host/src/game-surface-prompt-floor.ts";

/**
 * Every module that owns rules the floor composes, with the declaration that classifies its rules.
 *
 * <p>
 * This is a list of OWNERS, not of rules: the rules are the composed list's elements, and each one is attributed to the
 * module that declares it. Adding a game means adding its module here - and a module that declares a rule the floor
 * composes but never appears here is `conduct_rule_unowned`, so a missing owner is a finding rather than an omission.
 * A `classedRules` owner declares each rule and its class in one entry; the others declare rule texts and classify them
 * in a table keyed by the rule's declaration name.
 * </p>
 */
export const CONDUCT_OWNERS = Object.freeze([
  {
    module: CONDUCT_SOURCE,
    classedRules: "const GAME_SURFACE_CONDUCT_RULES = {",
    table: "GAME_SURFACE_CONDUCT_CLASSES",
  },
  { module: "host/src/games/stardew/prompt/stardew-game-conduct.ts", table: "STARDEW_GAME_CONDUCT_CLASSES" },
]);

const COMPOSED_DECLARATION = "const GAME_SURFACE_INTERACTION_CONDUCT = [";
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
    protects: "every composed rule is an entry that carries its own class, never a text spelled into the prompt",
  },
  restated: {
    code: "conduct_class_restated",
    protects: "a rule's class is stated once, inside its own entry, and never again in a table beside it",
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

/** One composed element: a reference to a classed rule, the name of a rule a game module exports, or a bare literal. */
function elementOf(line, index) {
  const body = line.endsWith(",") ? line.slice(0, -1) : null;
  if (body === null)
    throw new Error(
      `conduct element ${String(index)} does not end in a comma, so it is not one rule per line: ${line.slice(0, 60)}...`,
    );
  const open = body.slice(0, 1);
  const close = body.slice(-1);
  if (open === close && ["'", '"', "`"].includes(open)) return { kind: "literal", text: body.slice(1, -1) };
  const classed = /^([A-Z][A-Z0-9_]*)\.([a-z][a-z0-9_]*)\.text$/u.exec(body);
  if (classed !== null) return { kind: "classed", declaration: classed[1], id: classed[2] };
  if (/^[A-Z][A-Z0-9_]*$/u.test(body)) return { kind: "identifier", name: body };
  throw new Error(
    `conduct element ${String(index)} is neither a string literal, a rule reference nor a rule name: ${line.slice(0, 60)}...`,
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

/** A quoted string as written in the source, unescaped just enough to compare and to print. */
const unquote = (literal) => literal.slice(1, -1).replace(/\\"/gu, '"');

/**
 * The rules a module declares and classes in one entry: a record keyed by the rule's id, each entry carrying the text,
 * the class and the line of argument. Read as the lines between an entry's own braces, so a reason may wrap and a rule
 * text may contain anything at all - including the `${...}` of a template - without moving what this sees.
 */
function classedRules(source, declaration, module) {
  const at = source.indexOf(declaration);
  if (at < 0) throw new Error(`${declaration} is not declared in ${module}: this gate reads it by name`);
  const lines = source.slice(source.indexOf("\n", at) + 1).split("\n");
  const entries = new Map();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\}\s*(?:as\s+const|;)/u.test(line)) return entries;
    const key = /^(\s+)([a-z][a-z0-9_]*): \{\s*$/u.exec(line);
    if (key === null) {
      if (line.trim() !== "")
        throw new Error(`${declaration} in ${module} has a line this reader cannot place: ${line}`);
      index += 1;
      continue;
    }
    const indent = key[1].length;
    const id = key[2];
    const body = [];
    index += 1;
    for (; index < lines.length; index += 1) {
      const inner = lines[index];
      if (inner.trim() === "}," && inner.length - inner.trimStart().length === indent) break;
      body.push(inner);
    }
    if (index >= lines.length) throw new Error(`${declaration} in ${module} never closes the entry ${id}`);
    const block = body.join("\n");
    const klass = /\bclass:\s*"([^"]*)"/u.exec(block)?.[1];
    const reason = /\breason:\s*("(?:[^"\\]|\\.)*")/su.exec(block)?.[1];
    if (klass === undefined || reason === undefined)
      throw new Error(`${declaration} entry ${id} in ${module} is not { class, reason, text }: ${block.slice(0, 60)}`);
    if (entries.has(id)) throw new Error(`${declaration} in ${module} declares ${id} twice, so its class is ambiguous`);
    entries.set(id, { id, class: klass, reason: unquote(reason), module });
    index += 1;
  }
  throw new Error(`${declaration} in ${module} is never closed by a line starting with "}"`);
}

/**
 * Every classified row in one module's table, in declaration order.
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

/** The text of a declaration, from its own name to the next top-level declaration in that file. */
function declarationText(source, declaration, module) {
  const at = source.indexOf(declaration);
  if (at < 0) throw new Error(`${declaration} is not declared in ${module}: this gate reads it by name`);
  const next = /\n(?:export )?(?:const|function) /u.exec(source.slice(at + 1));
  return next === null ? source.slice(at) : source.slice(at, at + 1 + next.index);
}

/**
 * The class literals a module's table states rather than projects.
 *
 * A table derived from the rules' own entries states no class at all, and that is what makes it unable to disagree with
 * the entry it names. Anything stated here is the second spelling this unit removed - the one that can drift.
 */
function restatedClasses(source, table, module) {
  const text = declarationText(source, `export const ${table}`, module);
  return [...text.matchAll(/class:\s*"(FLOOR|CHANNEL|FORM)"/gu)].map((match) => {
    const before = text.slice(Math.max(0, match.index - 400), match.index);
    return {
      id: /\bid:\s*"([^"]*)"/u.exec(before.slice(before.lastIndexOf("{")))?.[1] ?? null,
      class: match[1],
    };
  });
}

/**
 * Every rule a module declares with a class, in one population keyed by the rule's id.
 *
 * A `classedRules` owner states the class inside the rule's entry. A game module declares its rules as exported texts
 * and classifies them in a table; the two are joined BY NAME - the id of such a rule is its declaration name lowercased
 * - so reordering either side moves nothing. A table row naming no declared rule is returned as an orphan rather than
 * dropped: a class nobody's rule carries is a finding.
 */
function declaredPopulation(sources) {
  const declared = new Map();
  const orphans = [];
  const restated = [];
  for (const owner of CONDUCT_OWNERS) {
    const source = sources.get(owner.module);
    if (owner.classedRules !== undefined) {
      for (const [id, entry] of classedRules(source, owner.classedRules, owner.module)) declared.set(id, entry);
      restated.push(
        ...restatedClasses(source, owner.table, owner.module).map((row) => ({ ...row, module: owner.module })),
      );
      continue;
    }
    const texts = declaredRules(source);
    for (const entry of tableEntries(source, owner.table, owner.module)) {
      const name = [...texts.keys()].find((candidate) => candidate.toLowerCase() === entry.id);
      if (name === undefined) {
        orphans.push({ ...entry, module: owner.module });
        continue;
      }
      declared.set(entry.id, { ...entry, text: texts.get(name), module: owner.module });
    }
  }
  return { declared, orphans, restated };
}

/**
 * Every rule in the floor, in the order the model reads it, with the class its own declaration gives it.
 *
 * Throws rather than returning an empty list when the shape is not what this reads: a gate that silently examined
 * nothing agrees with itself, and the caller turns the throw into `blocked`.
 */
export function conductRules(sources) {
  const floor = sources.get(CONDUCT_SOURCE);
  if (floor === undefined) throw new Error(`${CONDUCT_SOURCE} is not in the population this gate reads`);
  const { declared, orphans, restated } = declaredPopulation(sources);
  for (const rule of declared.values()) rule.composed = false;

  const rules = declarationBody(floor, COMPOSED_DECLARATION, CONDUCT_SOURCE)
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
    .map((line, index) => {
      const element = elementOf(line, index);
      if (element.kind === "literal") return { index, module: null, text: element.text, name: null, classless: true };
      const id = element.kind === "classed" ? element.id : element.name.toLowerCase();
      const entry = declared.get(id);
      if (entry === undefined)
        return element.kind === "classed"
          ? { index, module: null, id, text: id, name: id, classless: true }
          : { index, module: null, id, text: element.name, name: element.name, unowned: true };
      entry.composed = true;
      return {
        index,
        module: entry.module,
        id: entry.id,
        text: entry.text ?? entry.id,
        name: element.name ?? entry.id,
        class: entry.class,
        reason: entry.reason,
      };
    });
  if (rules.length === 0)
    throw new Error(`${COMPOSED_DECLARATION} declares no rule: the Game floor is empty, which is not a classification`);
  return { rules, declared, orphans, restated };
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

  let reading;
  try {
    reading = conductRules(sources);
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
  for (const rule of reading.rules) {
    if (rule.unowned) {
      violations.push({
        code: `${CONDUCT_RULES.unowned.code}:${String(rule.index)}:${rule.name}`,
        detail:
          "the floor composes this rule but no module in CONDUCT_OWNERS declares it: name the module that owns it, " +
          "and give it an entry in that module's table",
      });
      continue;
    }
    if (rule.classless) {
      violations.push({
        code: `${CONDUCT_RULES.classless.code}:${String(rule.index)}:${firstWords(rule.text)}`,
        detail:
          "this rule reaches the prompt without a declaration that carries its class: write it as an entry of " +
          "GAME_SURFACE_CONDUCT_RULES (text, class, reason) and compose it as a reference to that entry, or declare " +
          "it in the game module that owns it and classify it in that module's table",
      });
      continue;
    }
    rows.push({ index: rule.index, module: rule.module, class: rule.class, id: rule.id });
    if (!CONDUCT_CLASSES.includes(rule.class)) {
      violations.push({
        code: `${CONDUCT_RULES.unknown.code}:${rule.id}`,
        detail: `"${rule.class}" is not one of ${CONDUCT_CLASSES.join(" / ")}: a class outside the doctrine is not a class`,
      });
      continue;
    }
    counts[rule.class] += 1;
    if (rule.reason.trim() === "")
      violations.push({
        code: `${CONDUCT_RULES.unreasoned.code}:${rule.id}`,
        detail: "a class with no reason is a label nobody argued for, which is how a form rule gets called floor",
      });
    if (rule.class === "FORM")
      violations.push({
        code: `${CONDUCT_RULES.form.code}:${rule.id}:${rule.module}`,
        detail:
          "this rule governs the turn's form, and the card owns that: delete the rule rather than classifying it. " +
          "The floor may bound a monologue; it may not decide how long a turn is or how many beats it carries",
      });
  }

  for (const entry of reading.declared.values()) {
    if (entry.composed) continue;
    violations.push({
      code: `${CONDUCT_RULES.stale.code}:${entry.id}`,
      detail:
        `${entry.id} is declared by ${entry.module} and the floor's composed list never reaches it: removing a rule ` +
        "must remove its class entry, or the table stops describing the floor",
    });
  }
  for (const entry of reading.orphans) {
    violations.push({
      code: `${CONDUCT_RULES.stale.code}:${entry.id}`,
      detail:
        `${entry.module}'s table classifies ${entry.id}, and no rule in that module is declared by that name: the id ` +
        "of a rule is its declaration name lowercased, so a class for a rule that no longer exists is a list nobody reads",
    });
  }
  for (const row of reading.restated) {
    const entry = reading.declared.get(row.id ?? "");
    violations.push({
      code: `${CONDUCT_RULES.restated.code}:${row.id ?? row.module}`,
      detail:
        `${row.module}'s table states the class "${row.class}"` +
        (entry === undefined
          ? " instead of projecting it: a class is declared inside the rule's own entry, so a table that states one is " +
            "a second spelling that can drift from it"
          : `, and that rule's own entry declares "${entry.class}". A class is declared once, inside the rule's own ` +
            "entry, and a table beside it is the second spelling that let a reordering go unseen: delete the entry " +
            "from the table and let it project"),
    });
  }

  return {
    status: violations.length === 0 ? "passed" : "failed",
    examined: reading.rules.length,
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
      "game_surface_conduct_classes: the conduct or a declaration could not be read, so nothing was judged; a green " +
        "run reads examined>=1\n",
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = reading.status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
