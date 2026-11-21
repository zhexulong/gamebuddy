/**
 * A gate that reads this repository's own source must say, in its own file, what no compiler can check and when that
 * reading expires.
 *
 * WHY (measured 2026-11-22 on this checkout): 157 gate files read a file through the file system or the AST seam, and
 * one of them - the gate that enforces this rule - had ever written down why the reading is not a compile error. The
 * rule was in nobody's hands: `tools/check-source-shape-readers.mjs` catches a raw layout claim, and
 * `tools/audit-gate-inputs.mjs` says where a population comes from, but nothing asked the question the fifth layer of
 * gate selection asks - which invariant does this reading hold that the language cannot, and when must someone look
 * again.
 *
 * THE DERIVATION, and the one it deliberately leaves out. A gate is in the population when its own entry text imports a
 * file system read/scan call or the AST seam; nothing is hand-listed, so a gate committed tomorrow is in the population
 * the moment it is staged. A gate that delegates its reading to a module it imports (`tools/lib/…`) reads source with no
 * read call of its own and is therefore NOT in the population - that delegation is `tools/audit-gate-inputs.mjs`'s
 * closure reading (depth 2), and following it here would make this population the whole tree. The consequence of the
 * import rule one step further: a gate whose only input is a declaration (`*.json`, `*.md`) is in the population too,
 * and the declaration it owes is then about the declaration it reads - which is the blessed case, not the forbidden one,
 * and it still has to say what no compiler checks about it.
 *
 * THE DECLARATION the gate writes, in its own file, as a comment (a value a compiler could hold is not prose a reviewer
 * can audit):
 *
 *   // source-invariant: <the invariant no compiler can express>
 *   // source-expiry: <a date this reading must be reviewed by, or a `when …` event that retires it>
 *
 * A date already in the past is a review nobody did, so it is red rather than recorded. A one-word invariant is a
 * marker, not a claim, so there is a length floor - the same kind of guard `tools/audit-gate-inputs.mjs` puts on a
 * recorded reason.
 *
 * THE VERDICTS, three of them:
 *
 *   declared   the gate states both lines, and the expiry has not passed. Nothing to say.
 *   debt       the gate owes the declaration and is recorded in `tools/source-reading-baseline.json`, written by
 *              `gates/meta/check-harness-conformance.mjs --update-source-reading` from a real reading and never by hand.
 *   undeclared the gate owes it and nothing records it: `source_reading_undeclared:<gate>`, by name.
 *
 * The ratchet turns both ways, like every baseline in this tree: a row whose gate now declares (`source_reading_row_stale`)
 * or which no gate file carries any more is red until the row is deleted, so a row cannot outlive the debt it describes.
 * A population of zero is `source_reading_population_empty`, because a check that measured nothing agrees with itself.
 *
 * No game, no network, no model, no child process: it reads gate sources and compares two comment lines.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------------------------------
// What counts as reading our own source, and what a declaration is
// ---------------------------------------------------------------------------------------------------

/**
 * A gate reads this repository's own source when it imports the file system's read/scan calls or the AST seam.
 *
 * This is the population derivation and nothing else: no gate is listed here, so a gate file committed tomorrow is in the
 * population the moment it is staged. The names are the calls that RETURN a file's bytes; `writeFileSync` alone is a
 * baseline writer, not a source reader, and a gate that only writes is not asked to declare a reading it does not do.
 */
const SOURCE_READ_CALLS = Object.freeze([
  "createReadStream",
  "glob",
  "globSync",
  "openSync",
  "opendirSync",
  "readFile",
  "readFileSync",
  "readSync",
  "readdir",
  "readdirSync",
]);

/** The module whose parser is this repository's shared seam for reading its own source's STRUCTURE. */
const AST_SEAM = /(?:^|\/)javascript-ast\.mjs$/u;

/** The two module specifiers the read calls arrive under. */
const FILE_SYSTEM_MODULE = /^(?:node:)?fs(?:\/promises)?$/u;

/** The comment marker a gate declares the invariant under, and the one it declares the expiry under. */
export const SOURCE_INVARIANT_MARKER = "source-invariant";
export const SOURCE_EXPIRY_MARKER = "source-expiry";

/** Where the gates that owe a declaration and have not written one yet are recorded. Debt, written by `--update`. */
export const SOURCE_READING_BASELINE_PATH = "tools/source-reading-baseline.json";
export const SOURCE_READING_BASELINE_SCHEMA = "gamebuddy-source-reading-baseline/v1";

/**
 * How long a declaration has to be before it says anything, and what an expiry may be.
 *
 * A one-word invariant (`// source-invariant: yes`) is a marker, not a claim, so the length floor is the same kind of
 * guard `tools/audit-gate-inputs.mjs` puts on a recorded reason. An expiry is a date this reading must be reviewed by,
 * or a `when …` clause naming the event that retires it - and a date that has already passed is a review nobody did,
 * which is why it is red rather than recorded.
 */
const DECLARATION_FLOOR = 40;
const STATED_EXPIRY = /\bwhen\b|\d{4}-\d{2}-\d{2}/u;
const DATED_EXPIRY = /\d{4}-\d{2}-\d{2}/u;

/**
 * The evidence that this gate source reads this repository's own source, or `null` when it reads none.
 *
 * A default or namespace binding is followed through its member call (`fs.readFileSync(`), because that is how most of
 * this tree's gates import it. What this does NOT follow, stated because it is the hole a reader will look for: a gate
 * that delegates its reading to a module it imports (`tools/lib/…`) reads source with no read call of its own, and is
 * therefore not in this population. That delegation is measured next door - `tools/audit-gate-inputs.mjs` follows the
 * closure to depth 2 and classifies what each gate reads - and following it here would make this file's population the
 * whole tree rather than the gates whose own text reads a file.
 */
export function readsOwnSource(source) {
  const callPattern = new RegExp(`\\.(?:${SOURCE_READ_CALLS.join("|")})\\s*\\(`, "u");
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/gu)) {
    const [, clause, specifier] = match;
    if (AST_SEAM.test(specifier)) return `the AST seam ${specifier}`;
    if (!FILE_SYSTEM_MODULE.test(specifier)) continue;
    for (const binding of clause.replace(/[{}]/gu, " ").split(",")) {
      const text = binding.trim();
      if (text === "") continue;
      // `* as fs` and `{ readFileSync as read }` both arrive with a name the member call does not use.
      const alias = /\*\s+as\s+([A-Za-z_$][\w$]*)/u.exec(text);
      const name = alias === null ? text.split(/\s+as\s+/u)[0] : alias[1];
      if (SOURCE_READ_CALLS.includes(name)) return `${specifier}:${name}`;
      // A default (`import fs from "node:fs"`) or namespace binding names nothing until the member is read.
      if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}${callPattern.source}`, "u").test(source))
        return `${specifier}:${name}`;
    }
  }
  return null;
}

/**
 * The declaration a gate file carries, read from its own comment lines.
 *
 * Comments rather than a value because the declaration is prose a reviewer checks; a computed one is not a declaration a
 * reader can audit. Only lines that ARE comments count, so the same words inside a string or a doc example declare
 * nothing - the same boundary `red-proof:` markers have.
 */
export function parseSourceReadingDeclaration(source) {
  const field = (marker) => {
    const match = new RegExp(`^[ \\t]*//[ \\t]*${marker}:[ \\t]*(\\S.*)$`, "mu").exec(source);
    return match === null ? null : match[1].trim();
  };
  return { invariant: field(SOURCE_INVARIANT_MARKER), expiry: field(SOURCE_EXPIRY_MARKER) };
}

/** Why one gate's declaration is not one a reviewer can act on, in the order a reader would ask. */
function declarationProblems({ path, source, evidence, today }) {
  const declaration = parseSourceReadingDeclaration(source);
  const problems = [];
  if (declaration.invariant === null || declaration.invariant.length < DECLARATION_FLOOR)
    problems.push({
      code: "source_reading_invariant_missing",
      detail:
        `reads ${evidence} and states no \`// ${SOURCE_INVARIANT_MARKER}: …\` line naming the invariant no compiler ` +
        `can express (${DECLARATION_FLOOR}+ characters)`,
    });
  if (declaration.expiry === null || !STATED_EXPIRY.test(declaration.expiry))
    problems.push({
      code: "source_reading_expiry_missing",
      detail:
        `reads ${evidence} and states no \`// ${SOURCE_EXPIRY_MARKER}: …\` line carrying a date or a \`when …\` ` +
        "clause that retires this reading",
    });
  else {
    const date = DATED_EXPIRY.exec(declaration.expiry);
    if (date !== null && new Date(`${date[0]}T00:00:00Z`) < today)
      problems.push({
        code: "source_reading_expiry_passed",
        detail: `the declared expiry \`${declaration.expiry}\` is before today, so the review it names never happened`,
      });
  }
  return problems.map((problem) => ({ ...problem, detail: `${path}: ${problem.detail}` }));
}

/**
 * The judgment: for every gate that reads this repository's own source, does it declare the invariant and the expiry?
 *
 * Three verdicts, and the third is the one that keeps the rule from being aspirational: a gate with a complete
 * declaration passes, a gate recorded in the baseline owes the declaration and is named as debt on the census line, and a
 * gate with neither is a finding that names it. The ratchet turns both ways - a baseline row whose gate now declares, or
 * which no gate file carries any more, is a finding too, so a row cannot outlive the debt it describes.
 *
 * `owed` is every gate whose declaration is not one a reviewer can act on, whether or not the baseline records it; that is
 * what `--update-source-reading` writes, because a baseline written from the rows it already holds records nothing.
 */
export function judgeSourceReadingDeclarations({ members, baseline = null, today = new Date() } = {}) {
  const findings = [];
  const reading = [];
  const declared = new Set();
  const owed = [];
  const debt = new Set();
  for (const member of members) {
    const evidence = readsOwnSource(member.source);
    if (evidence === null) continue;
    reading.push(member.path);
    const problems = declarationProblems({ path: member.path, source: member.source, evidence, today });
    const recorded = baseline?.has(member.path) === true;
    if (problems.length === 0) {
      declared.add(member.path);
      continue;
    }
    owed.push(member.path);
    // A recorded gate owes the declaration and is named as debt on the census line; naming it twice - once per missing
    // marker - would bury the gates nobody recorded under 300 lines about the ones the baseline already covers.
    if (recorded) {
      debt.add(member.path);
      continue;
    }
    for (const problem of problems) findings.push({ code: `${problem.code}:${member.path}`, detail: problem.detail });
    findings.push({
      code: `source_reading_undeclared:${member.path}`,
      detail:
        `reads ${evidence} with no \`// ${SOURCE_INVARIANT_MARKER}:\`/\`// ${SOURCE_EXPIRY_MARKER}:\` declaration and no ` +
        `row in ${SOURCE_READING_BASELINE_PATH}`,
    });
  }
  for (const row of baseline ?? []) {
    if (debt.has(row)) continue;
    findings.push({
      code: `source_reading_row_stale:${row}`,
      detail: reading.includes(row)
        ? "declares the invariant now, so the recorded debt is paid - delete the row"
        : `no gate file in the population reads this repository's own source at \`${row}\`, so the row outlived what it described`,
    });
  }
  const census = {
    examined: members.length,
    reading: reading.length,
    declared: declared.size,
    recorded: debt.size,
    undeclared: reading.length - declared.size - debt.size,
  };
  if (reading.length === 0)
    findings.push({
      code: "source_reading_population_empty",
      detail: `none of the ${members.length} gate file(s) read this repository's own source, so this reading measured nothing`,
    });
  return { findings, census, declared: [...declared].sort(), owed: owed.sort(), recorded: [...debt].sort() };
}

/** The census line, in the words the rule is written in: the population, what declares, what owes, what nobody knows. */
export function describeSourceReadingCensus(census) {
  return [
    `gates that read our own source ${census.reading} · declared ${census.declared} · ` +
      `recorded as debt ${census.recorded} · no declaration and no row ${census.undeclared}`,
  ];
}

/** The baseline as a set of gate paths, or `null` when the file is absent or not the shape this writes. */
export function readSourceReadingBaseline({ root }) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, SOURCE_READING_BASELINE_PATH), "utf8"));
    if (parsed?.schema !== SOURCE_READING_BASELINE_SCHEMA || !Array.isArray(parsed.gates)) return null;
    return new Set(parsed.gates.filter((entry) => typeof entry === "string"));
  } catch {
    return null;
  }
}

/** The baseline document, from a real reading. Sorted, so `--update` rewrites only what changed. */
export function sourceReadingBaselineDocument(paths) {
  return {
    schema: SOURCE_READING_BASELINE_SCHEMA,
    note:
      "Gates that read this repository's own source and declare no `// source-invariant:`/`// source-expiry:` line at " +
      "this commit. A record of debt, not an acceptance of it: delete a row by stating the invariant and the expiry in " +
      "the gate's own file, never by adding one by hand. `--update-source-reading` writes this file; a row the tree has " +
      "outgrown fails the reading.",
    gates: [...paths].sort(),
  };
}
