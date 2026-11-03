/**
 * Gate for the PARSER AGREEMENT defect class: a vocabulary has two readers, they disagree about
 * which tokens are IN it, and the tests only ever feed the spelling the author writes - so the
 * disagreement is invisible until a real document arrives.
 *
 * Four instances, one shape (`design/` ADR-006 families, measured 2026-11-02):
 *
 *   1. `host/src/tavern/macro-engine.ts` - `MACRO_PATTERN` (recognition, for replacement) required the
 *      name flush against the braces while `macroKey` (classification) tolerated `{{ char }}`. A spaced
 *      macro was classified and never replaced, and the surviving braces then read as junk to
 *      `hasUnrenderedMacro`, which dropped the whole field carrying them. Fixed in `e6b09cc7`, and the
 *      fix introduced ONE shared grammar (`BRACED_MACRO`/`ANGLE_MACRO`) feeding both readers - which is
 *      what this entry now protects from drifting apart again.
 *   2. `packages/game-action-program/src/descriptors.mjs` vs the descriptor key sets in
 *      `host/src/protocol.ts`: four spellings, drifted twice (`693c19a8`, `eff7646f`).
 *   3. `integrations/stardew/action-development/src/action-surface.mjs` vs `descriptors.mjs`:
 *      `approach`/`sceneTarget` landed on the producer side and sat a day before the consumer caught
 *      up (`450c8f90` -> `6e5fcd9c`).
 *   4. `dialogue-web/src/i18n.ts` label keys vs the components that read them: `i18n.7` caught one,
 *      several orphans were found by hand.
 *
 * THE POPULATION IS `VOCABULARIES` - a declaration list, not a scan, so the fifth vocabulary joins by
 * being declared rather than by someone remembering. Each entry names its authority, its readers (a
 * path plus how to extract that reader's member set), and the rule that must hold between the readers,
 * with a reason whenever the rule is not equality. Two things make a declaration fail rather than
 * quietly stop comparing: a reader whose path is not on disk, and a reader whose declared grammar
 * constants or function are no longer in the file it names.
 *
 * HOW A READER'S MEMBER SET IS EXTRACTED, and why the probe corpus is not derived from the grammar:
 *
 *   - the grammar is read OUT of the authority's own source and evaluated as written (see
 *     `evaluateDeclarations`), so what is compared is the shipped grammar rather than a second copy of
 *     it;
 *   - the probe corpus is deliberately NOT derived from that grammar. Deriving it would delete the
 *     spaced probes in the same stroke that deletes `\s*` from `BRACED_MACRO`, and the gate would go
 *     blind exactly when the grammar drifts - a check whose population moves with the thing it checks
 *     can only ever agree. The member corpus therefore comes from the vocabulary's own name literals
 *     crossed with the spelling axes two readers can disagree about (spacing, parametric tail, case,
 *     brace vs angle), which is also how instance 1's divergence is reachable at all.
 *
 * The product is not imported: `tools/` may not depend on `host/src` (`.dependency-cruiser.tools.cjs`,
 * severity error), and these constants are executable JavaScript as written.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The file both macro readers live in. Declared once: a reader names it and the corpus reads it. */
export const MACRO_ENGINE_PATH = "host/src/tavern/macro-engine.ts";

/**
 * The grammar both macro readers are built from, in declaration order - `MACRO_NAME` first because the
 * others interpolate it. Each reader lists only the declarations IT reads: a constant renamed out from
 * under one reader is then a finding about that reader, not about both.
 *
 * The two lists share the name/brace/angle grammar and differ in the one pattern they build from it,
 * which is exactly the invariant this vocabulary protects: the spelling is a fact about the vocabulary,
 * and only recognition and classification may be separate readers of it.
 */
const MACRO_RECOGNITION_GRAMMAR = Object.freeze(["MACRO_NAME", "BRACED_MACRO", "ANGLE_MACRO", "MACRO_PATTERN"]);
const MACRO_CLASSIFICATION_GRAMMAR = Object.freeze(["MACRO_NAME", "BRACED_MACRO", "ANGLE_MACRO", "WHOLE_MACRO"]);

/**
 * The two shapes this file declares a macro name in: `["char", ...]` is a key of the resolved table and
 * `  time: "..."` a key of the left-literal one. Reading the declaration shapes rather than every
 * string literal is what keeps a regex flag (`"giu"`) or a locale prefix out of the corpus, and what
 * lets a macro added to either table join it without anyone editing this gate.
 */
const MACRO_NAME_IN_SOURCE = Object.freeze([/^\s*\["([a-z][a-z0-9_]*)",/gmu, /^\s*([a-z][a-z0-9_]*):\s*/gmu]);

/** The spelling axes two macro readers can disagree about. Every combination is probed. */
const MACRO_LEADING = Object.freeze(["", " ", "\t", "  "]);
const MACRO_TRAILING = Object.freeze(["", " ", "\t"]);
const MACRO_TAILS = Object.freeze(["", "::a::b", " x"]);
const ANGLE_PADDING = Object.freeze(["", " "]);

/**
 * Tokens that are not macros at all. They carry the other half of the rule: two readers must agree
 * about what they REJECT as well as what they accept, or a recognition pattern that matches a
 * substring reports a token as a macro that its own classifier does not know.
 */
const MACRO_JUNK = Object.freeze([
  "{{}}",
  "{{ }}",
  "{{-x}}",
  "{{1abc}}",
  '{{"char"}}',
  "{{{char}}}",
  "{{char}}}",
  "{{char}",
  "{{char}}{{user}}",
  "{{ char }}extra",
  "<>",
  "< >",
  "<<bot>>",
  "< bot",
  "{{// note}}",
]);

/** A macro token in either spelling, at every spacing the two readers could disagree about. */
function macroSpellings(name) {
  const spellings = [];
  for (const leading of MACRO_LEADING)
    for (const trailing of MACRO_TRAILING)
      for (const tail of MACRO_TAILS) spellings.push(`{{${leading}${name}${tail}${trailing}}}`);
  const casings = [name, name.toUpperCase(), `${name[0].toUpperCase()}${name.slice(1)}`];
  for (const casing of casings)
    for (const leading of ANGLE_PADDING)
      for (const trailing of ANGLE_PADDING) spellings.push(`<${leading}${casing}${trailing}>`);
  return spellings;
}

/** The member population of the macro vocabulary: its own names, at every spelling axis, plus junk. */
export function macroMembers(source) {
  const names = new Set();
  for (const pattern of MACRO_NAME_IN_SOURCE) for (const match of source.matchAll(pattern)) names.add(match[1]);
  const members = new Set(MACRO_JUNK);
  for (const name of [...names].sort()) for (const spelling of macroSpellings(name)) members.add(spelling);
  return Object.freeze([...members]);
}

/**
 * The declared vocabularies. Add an entry to make a fifth vocabulary a member of this defect class;
 * a vocabulary that is not here is not compared.
 */
export const VOCABULARIES = Object.freeze([
  Object.freeze({
    name: "tavern-macro",
    authority: MACRO_ENGINE_PATH,
    members: macroMembers,
    // Equality, both ways. Recognition without classification leaves the `{{...}}` in the rendered
    // text; classification without recognition drops the whole field that carries it. Neither
    // direction is a state anything downstream can recover from, so the rule is not one-sided.
    rule: Object.freeze({ hold: "equal" }),
    readers: Object.freeze([
      Object.freeze({
        name: "MACRO_PATTERN",
        path: MACRO_ENGINE_PATH,
        function: "renderMacros",
        derives: Object.freeze(["MACRO_PATTERN"]),
        declarations: MACRO_RECOGNITION_GRAMMAR,
        match: (declarations, token) => expressionMatchesWhole(declarations.MACRO_PATTERN, token),
      }),
      Object.freeze({
        name: "macroKey",
        path: MACRO_ENGINE_PATH,
        function: "macroKey",
        derives: Object.freeze(["WHOLE_MACRO"]),
        declarations: MACRO_CLASSIFICATION_GRAMMAR,
        match: (declarations, token) => expressionMatchesWhole(declarations.WHOLE_MACRO, token),
      }),
    ]),
  }),
]);

/**
 * Whether `expression` consumes `token` and nothing else.
 *
 * The whole-token view is what both readers mean: `renderMacros` replaces one token at a time, and
 * `macroKey` is anchored. A scanning pattern that matched only part of the token would still be a
 * disagreement, so the match has to start at 0 and end at the end.
 */
function expressionMatchesWhole(expression, token) {
  const match = new RegExp(expression.source, expression.flags.replace(/g/u, "")).exec(token);
  return match !== null && match.index === 0 && match[0] === token;
}

/**
 * One `const NAME = ...;` statement as the file writes it, or `null` when the file does not declare it.
 *
 * The statement's extent is found by scanning rather than by taking the line: a declaration may wrap,
 * and a `;` inside a template literal (`String.raw`...``) is not the end of the statement.
 */
function declarationStatement(source, name) {
  const anchor = new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*=`, "mu").exec(source);
  if (anchor === null) return null;
  let depth = 0;
  let quote = null;
  for (let index = anchor.index; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === ";" && depth === 0) return source.slice(anchor.index, index + 1);
  }
  return null;
}

/**
 * The values a file's own declarations produce, evaluated as written.
 *
 * `missing` is not an error here: it is the answer to "does the reader this declaration names still
 * exist", which the caller reports by name instead of skipping the comparison.
 */
export function evaluateDeclarations(source, names) {
  const statements = [];
  const missing = [];
  for (const name of names) {
    const statement = declarationStatement(source, name);
    if (statement === null) missing.push(name);
    else statements.push(statement);
  }
  if (missing.length > 0) return { values: null, missing };
  return { values: runInNewContext(`${statements.join("\n")}\n({ ${names.join(", ")} });`), missing };
}

/** One top-level `function name(...)` body, so an extraction can prove it reads what that function reads. */
function functionBody(source, name) {
  const anchor = new RegExp(`^(?:export\\s+)?function\\s+${name}\\s*\\(`, "mu").exec(source);
  if (anchor === null) return null;
  const end = source.indexOf("\n}", anchor.index);
  return end === -1 ? null : source.slice(anchor.index, end);
}

const readerFinding = (vocabulary, reader, code, detail) => ({
  code,
  vocabulary: vocabulary.name,
  reader: reader.name,
  detail,
});

const RULES = new Set(["equal", "subset", "superset"]);

/**
 * What every non-comparison finding ends with.
 *
 * `reader_missing`, `reader_unreadable` and `reader_not_derived` are statements about the GATE's ability to
 * read a reader, never about the two readers agreeing. "Could not read this reader" and "this reader
 * disagrees" must not read alike: a hand edit that factors one grammar out into a second constant, or that
 * puts a second statement on the same line, would otherwise be filed as a note - and the disagreement it
 * hides would never be looked for, which is the exact silence this whole gate exists to remove.
 */
const COMPARISON_SKIPPED = ", so this reader was not read and no comparison was made";

/**
 * Read every declared vocabulary from source, compare its readers per the declared rule, and report
 * every member they disagree about plus every declaration that can no longer be read.
 *
 * `root` is a parameter so the falsifier can point the same declarations at a drifted copy of the
 * authority instead of editing the repository.
 */
export function auditParserAgreement({ root = REPOSITORY_ROOT, vocabularies = VOCABULARIES } = {}) {
  const sources = new Map();
  const readSource = (path) => {
    if (!sources.has(path)) {
      try {
        sources.set(path, readFileSync(join(root, path), "utf8"));
      } catch {
        sources.set(path, null);
      }
    }
    return sources.get(path);
  };

  const findings = [];
  const readings = [];
  for (const vocabulary of vocabularies) {
    const declared = vocabulary.readers.length;
    if (declared < 2) {
      findings.push({
        code: "readers_unpaired",
        vocabulary: vocabulary.name,
        reader: null,
        detail: `the \`${vocabulary.rule.hold}\` rule compares readers and ${declared} was declared, so no comparison was made`,
      });
      readings.push({ vocabulary: vocabulary.name, members: 0, declared, compared: false, readers: [] });
      continue;
    }
    const members = readMembers(vocabulary, readSource, findings);
    const readers = readReaders(vocabulary, members, readSource, findings);
    const compared = members.length > 0 && readers.length === declared;
    if (compared) findings.push(...compareReaders(vocabulary, readers));
    readings.push({
      vocabulary: vocabulary.name,
      members: members.length,
      declared,
      compared,
      readers: readers.map((reader) => ({ name: reader.name, accepted: reader.accepted.size })),
    });
  }
  return { readings, findings };
}

function readMembers(vocabulary, readSource, findings) {
  const source = readSource(vocabulary.authority);
  if (source === null) {
    findings.push({
      code: "authority_missing",
      vocabulary: vocabulary.name,
      reader: null,
      detail: `${vocabulary.authority} is not on disk, so no member was read and no comparison was made`,
    });
    return [];
  }
  const members = vocabulary.members(source);
  if (members.length === 0)
    findings.push({
      code: "members_empty",
      vocabulary: vocabulary.name,
      reader: null,
      detail: `${vocabulary.authority} yields no members, so no comparison was made`,
    });
  return members;
}

/** Each declared reader's accepted set, or a finding naming the declaration that can no longer be read. */
function readReaders(vocabulary, members, readSource, findings) {
  const readers = [];
  for (const reader of vocabulary.readers) {
    const source = readSource(reader.path);
    if (source === null) {
      findings.push(
        readerFinding(
          vocabulary,
          reader,
          "reader_missing",
          `it declares ${reader.path}, which is not on disk${COMPARISON_SKIPPED}`,
        ),
      );
      continue;
    }
    let evaluated;
    try {
      evaluated = evaluateDeclarations(source, reader.declarations);
    } catch (error) {
      findings.push(
        readerFinding(
          vocabulary,
          reader,
          "reader_unreadable",
          `its declarations do not evaluate in ${reader.path} (${error.message})${COMPARISON_SKIPPED}`,
        ),
      );
      continue;
    }
    const { values, missing } = evaluated;
    if (values === null) {
      findings.push(
        readerFinding(
          vocabulary,
          reader,
          "reader_unreadable",
          `it declares ${missing.map((name) => `\`${name}\``).join(", ")}, which this gate could not read as a top-level \`const\` in ${reader.path}${COMPARISON_SKIPPED}`,
        ),
      );
      continue;
    }
    if (reader.function !== undefined) {
      const body = functionBody(source, reader.function);
      if (body === null) {
        findings.push(
          readerFinding(
            vocabulary,
            reader,
            "reader_not_derived",
            `it speaks for \`${reader.function}\`, which ${reader.path} does not define${COMPARISON_SKIPPED}`,
          ),
        );
        continue;
      }
      const absent = reader.derives.filter((name) => !body.includes(name));
      if (absent.length > 0) {
        findings.push(
          readerFinding(
            vocabulary,
            reader,
            "reader_not_derived",
            `it reads ${absent.join(", ")}, but \`${reader.function}\` in ${reader.path} no longer names them${COMPARISON_SKIPPED}`,
          ),
        );
        continue;
      }
    }
    const accepted = new Set(members.filter((token) => reader.match(values, token)));
    if (accepted.size === 0) {
      findings.push(
        readerFinding(
          vocabulary,
          reader,
          "reader_empty",
          `it accepted none of the ${members.length} members, so the comparison is one-sided`,
        ),
      );
    }
    readers.push({ name: reader.name, accepted });
  }
  return readers;
}

/** The declared rule, applied. A member only one side knows is the finding this gate exists for. */
function compareReaders(vocabulary, readers) {
  const findings = [];
  const { hold, left, right, reason } = vocabulary.rule;
  if (!RULES.has(hold)) {
    findings.push({
      code: "rule_unusable",
      vocabulary: vocabulary.name,
      reader: null,
      detail: `the rule \`${hold}\` is not one of ${[...RULES].join("|")}`,
    });
    return findings;
  }
  if (hold !== "equal" && (typeof reason !== "string" || reason.trim() === "")) {
    findings.push({
      code: "rule_unreasoned",
      vocabulary: vocabulary.name,
      reader: null,
      detail: `the \`${hold}\` rule must say why the two readers are allowed to differ`,
    });
    return findings;
  }
  const [primary, ...rest] = readers;
  const pairs =
    hold === "equal"
      ? rest.map((other) => ({ held: primary, other, directions: ["held", "other"] }))
      : [
          {
            held: readers.find((reader) => reader.name === left),
            other: readers.find((reader) => reader.name === right),
            directions: hold === "subset" ? ["other"] : ["held"],
          },
        ];
  for (const pair of pairs) {
    if (pair.held === undefined || pair.other === undefined) {
      findings.push({
        code: "rule_unusable",
        vocabulary: vocabulary.name,
        reader: null,
        detail: `the \`${hold}\` rule names ${left} and ${right}, which are not both declared readers (${readers.map((reader) => reader.name).join(", ")})`,
      });
      continue;
    }
    for (const member of pair.held.accepted)
      if (pair.directions.includes("held") && !pair.other.accepted.has(member))
        findings.push(memberFinding(vocabulary, { member, reader: pair.held.name, missingFrom: pair.other.name }));
    for (const member of pair.other.accepted)
      if (pair.directions.includes("other") && !pair.held.accepted.has(member))
        findings.push(memberFinding(vocabulary, { member, reader: pair.other.name, missingFrom: pair.held.name }));
  }
  return findings;
}

const memberFinding = (vocabulary, { member, reader, missingFrom }) => ({
  code: "member_disagreement",
  vocabulary: vocabulary.name,
  reader,
  member,
  detail: `${reader} accepts ${JSON.stringify(member)} and ${missingFrom} does not`,
});

/** One line per finding, in the `<snake_case_marker>:<subject>: <detail>` form the other gates print. */
export function formatFinding(finding) {
  const subject = finding.reader === null ? finding.vocabulary : `${finding.vocabulary}:${finding.reader}`;
  return `parser_agreement_${finding.code}:${subject}: ${finding.detail}`;
}
