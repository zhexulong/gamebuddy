#!/usr/bin/env node
/**
 * Every `switch` over a union must hand the impossible case to `assertNever`, or a new member is silent.
 *
 * WHY. A `switch` whose cases cover today's members and whose `default` returns a fallback value compiles
 * when a member is added and quietly answers with the fallback. The compiler cannot help, because the code
 * never told it the fallback was unreachable. `game-presentation.ts` carried the pairing in one file: a
 * local `exhaustive(value: never): string` guarded `companionModLabel`, and `companionModIsReady` - a
 * boolean reader that cannot use a string-returning guard - wrote `exhaustive(outcome); return false;`
 * instead. Same union, same intent, two spellings, and only one of them read as the assertion it was.
 * `dialogue-web/src/assert-never.ts` is the one spelling; this gate is what keeps every switch using it.
 *
 * WHAT IT ASSERTS, per switch, with the TypeScript checker rather than a text pattern:
 *
 *   1. the subject's type IS a union of literal members (a "closed vocabulary"). If it is not - a `string`
 *      from the Host, a number, a boolean - no case list can be exhaustive and the switch is a
 *      `switch_open_vocabulary` row below, named with its own type;
 *   2. every member of that union is handled by a `case`, and the members a switch misses are named;
 *   3. the `default` clause hands the switch's own subject to a call whose argument type is `never`, which
 *      is the compile-time proof that the remaining branch cannot happen. The argument must BE the
 *      subject (or a path into it): a `default: assertNever(otherUnion)` does not discharge this switch.
 *
 * THE POPULATION IS DERIVED. It is the file list of `dialogue-web/tsconfig.json` - the workspace's own
 * `include` - so a new source file joins this gate without an edit here. `examined N` is printed with the
 * class counts, and an empty population is `blocked` with exit 1: a gate that examined nothing has not
 * passed.
 *
 * THE EXEMPTIONS ARE STATED, COUNTED AND EXPIRE. A switch whose subject is an open vocabulary is not a
 * defect - the Host may publish a code this build has no sentence for, and the fallback sentence is the
 * designed answer - but it must say so here, by file, subject and how many such switches the file holds.
 * An entry that matches nothing is `exemption_expired`; an open-vocabulary switch with no entry is
 * `exemption_missing`. Neither direction is a silent pass.
 *
 * WHAT IT DOES NOT ASSERT, stated so a green run is not read as more than it is: that a switch with a
 * `case` for a member does anything sensible with it, and that a subject typed as a union of object types
 * (switched over through a discriminant property, which is what `ChatUIState`/`ProblemStep` subjects are)
 * has no member left over - the checker's `never` is exactly that proof, and it is required per switch.
 *
 * red-proof: inject  ProblemView loses its `default: return assertNever(step)`
 *                    -> `switch_default_does_not_assert_never: <file>:78:step.kind covers all members of
 *                    "control" | "outside_surface" | "self_heals" | "no_step" but its default does not hand the
 *                    subject to a call whose argument is never`; a fifth member added to `ProblemStep` -> `tsc` says
 *                    `TS2345: Argument of type 'Readonly<{ kind: "red_proof_only" }>' is not assignable to parameter of
 *                    type 'never'` and the gate names it (`switch_not_exhaustive ... does not handle "red_proof_only"`).
 *                    Both readings are made by tools/check-switch-exhaustiveness.test.mjs, whose fixtures live in a
 *                    throwaway workspace so the red case sits beside the reader instead of in this tree.
 */
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WEB_ROOT = join(ROOT, "dialogue-web");
const WEB_ROOT = DEFAULT_WEB_ROOT;
/** The TypeScript compiler the web workspace builds with: the same parser, not a second spelling of it. */
const typescript = createRequire(join(WEB_ROOT, "package.json"))("typescript");

/**
 * Open-vocabulary switches, each with the reason it cannot be exhaustive.
 *
 * `subject` is the switch's own subject text and `count` the number of such switches the file holds, so an
 * entry expires in both directions: lose a switch and the entry reports more than it found; add one and the
 * entry reports fewer. Both are failures, not notes.
 */
export const OPEN_VOCABULARY_EXEMPTIONS = Object.freeze([
  {
    file: "dialogue-web/src/components/CharactersPanel.tsx",
    subject: "code",
    count: 1,
    reason:
      "`TavernProblemError.code` is a `string`: the Host's problem vocabulary is open, and the default " +
      "branch's `problemTextWithCode` sentence is the designed answer for a code this build does not know.",
  },
  {
    file: "dialogue-web/src/components/CompanionCardExportSection.tsx",
    subject: "code",
    count: 1,
    reason:
      "The export refusal reads `TavernProblemError.code` (`string`): an unknown code keeps the base sentence with " +
      "the code appended, which is the fallback this function exists for. It lived in CharactersSurfacePanel " +
      "until that file was split; the exemption follows the switch rather than the file that used to hold it.",
  },
  {
    file: "dialogue-web/src/components/CompanionWorldBookSection.tsx",
    subject: "code",
    count: 1,
    reason:
      "The world-book refusal reads `TavernProblemError.code` (`string`) for the same reason as the export one: an " +
      "unknown code keeps the base sentence with the code appended. Split out of CharactersSurfacePanel with the " +
      "rest of her own world book.",
  },
  {
    file: "dialogue-web/src/components/CompanionInspectorDrawer.tsx",
    subject: "code",
    count: 2,
    reason:
      "The picture and removal refusals, both reading `TavernProblemError.code` (`string`): same open " +
      "vocabulary, same designed fallback sentence.",
  },
  {
    file: "dialogue-web/src/components/character-domain-labels.ts",
    subject: "key",
    count: 1,
    reason:
      "`field.toLowerCase()` is a card field key from the imported file, not a union in this build: the " +
      "`default: break` falls through to the regex families below and then `humanizeFieldKey`, which is the " +
      "path for a field this list has never seen.",
  },
  {
    file: "dialogue-web/src/game-presentation.ts",
    subject: "source",
    count: 1,
    reason:
      "`installationSourceLabel` takes `source: string` - the discovery session's vocabulary, published as " +
      "a plain string - and answers `gameInstallationSourceOther` for a member this build has no sentence for.",
  },
]);

function parseConfig(webRoot) {
  const configPath = join(webRoot, "tsconfig.json");
  const config = typescript.readConfigFile(configPath, typescript.sys.readFile);
  if (config.error !== undefined)
    throw new Error(typescript.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  return typescript.parseJsonConfigFileContent(config.config, typescript.sys, webRoot);
}

/** The literal text of one union member, or `null` for a member no `case` label could ever name. */
function literalOf(type) {
  const { flags } = type;
  if ((flags & typescript.TypeFlags.StringLiteral) !== 0) return type.value;
  if ((flags & typescript.TypeFlags.NumberLiteral) !== 0) return String(type.value);
  if ((flags & typescript.TypeFlags.BooleanLiteral) !== 0) return type.intrinsicName;
  if ((flags & typescript.TypeFlags.Null) !== 0) return "null";
  if ((flags & typescript.TypeFlags.Undefined) !== 0) return "undefined";
  return null;
}

/**
 * What this subject is, for the verdict: a closed union of literals, an open vocabulary, or neither.
 *
 * A union with even one non-literal member (`string`, an object) can never be fully named by `case`
 * labels, so it is an open vocabulary rather than a defect - and it is still printed, with its type.
 */
function classify(type, checker) {
  const members = type.isUnion() ? type.types : [type];
  const literals = members.map((member) => literalOf(member));
  const typeText = checker.typeToString(type);
  if (literals.some((literal) => literal === null)) return { kind: "open_vocabulary", typeText, members: [] };
  if (literals.length < 2) return { kind: "not_a_union", typeText, members: [] };
  return { kind: "literal_union", typeText, members: literals };
}

/** The literal a `case` label names, as the checker reads it. */
function caseLiteral(clause, checker) {
  const label = checker.getTypeAtLocation(clause.expression);
  const members = label.isUnion() ? label.types : [label];
  return members.map((member) => literalOf(member)).filter((literal) => literal !== null);
}

const squash = (text) => text.replace(/\s+/gu, "");

/**
 * True when this node hands the switch's own subject - or a path into it - to a call whose argument type
 * is `never`. `assertNever(state)` for subject `state.phase` counts (the object is narrowed to never);
 * `assertNever(somethingElse)` does not.
 */
function assertsNeverOfSubject(node, subjectText, checker) {
  const subject = squash(subjectText);
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (typescript.isCallExpression(current)) {
      for (const argument of current.arguments) {
        const argumentText = squash(argument.getText());
        const namesSubject =
          subject === argumentText || subject.startsWith(`${argumentText}.`) || argumentText.startsWith(`${subject}.`);
        if (!namesSubject) continue;
        if ((checker.getTypeAtLocation(argument).flags & typescript.TypeFlags.Never) !== 0) {
          found = true;
          return;
        }
      }
    }
    typescript.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function readSwitch(file, node, sourceFile, checker) {
  const subjectText = node.expression.getText(sourceFile);
  const type = checker.getTypeAtLocation(node.expression);
  const verdict = classify(type, checker);
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const row = { file, line, subject: subjectText, kind: verdict.kind, typeText: verdict.typeText, unhandled: [] };
  if (verdict.kind !== "literal_union") return row;
  const covered = new Set();
  for (const clause of node.caseBlock.clauses) {
    if (!typescript.isCaseClause(clause)) continue;
    for (const literal of caseLiteral(clause, checker)) covered.add(literal);
  }
  row.unhandled = verdict.members.filter((member) => !covered.has(member));
  const defaultClause = node.caseBlock.clauses.find((clause) => typescript.isDefaultClause(clause));
  row.hasDefault = defaultClause !== undefined;
  row.assertsNever = defaultClause !== undefined && assertsNeverOfSubject(defaultClause, subjectText, checker);
  return row;
}

/** Every `switch` in one parsed file, nested ones included. */
function switchesOf(sourceFile, file, checker) {
  const rows = [];
  const visit = (node) => {
    if (typescript.isSwitchStatement(node)) rows.push(readSwitch(file, node, sourceFile, checker));
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return rows;
}

const finding = (code, detail) => ({ code, detail });

/**
 * The reading, over a workspace. `webRoot` and `exemptions` are arguments so the falsifier can point it at a
 * throwaway workspace instead of a second implementation of this reader (`tools/check-switch-exhaustiveness.test.mjs`).
 */
/**
 * Exemption bookkeeping, split out of the reading so the reading stays readable: every open-vocabulary subject must be
 * stated with the count observed, and every statement must still match something (an expired exemption is a lie).
 */
function exemptionFindings({ exemptions, byFile }) {
  const out = [];
  for (const exemption of exemptions) {
    const observed = byFile.get(`${exemption.file}\u0000${exemption.subject}`) ?? 0;
    if (observed === exemption.count) continue;
    out.push(
      finding(
        observed === 0 ? "exemption_expired" : "exemption_count_mismatch",
        `${exemption.file} subject "${exemption.subject}": stated ${exemption.count} open-vocabulary switch(es), ` +
          `found ${observed}`,
      ),
    );
  }
  for (const [key, observed] of byFile) {
    const [file, subject] = key.split("\u0000");
    const stated = exemptions.filter((exemption) => exemption.file === file && exemption.subject === subject);
    if (stated.length > 0) continue;
    out.push(
      finding(
        "exemption_missing",
        `${file} subject "${subject}" (open vocabulary, ${observed} switch(es)) has no stated exemption, so it reads ` +
          `as a silent pass: state why it cannot be exhaustive, or give it an assertNever default`,
      ),
    );
  }
  return out;
}

export function checkSwitchExhaustiveness({
  webRoot = DEFAULT_WEB_ROOT,
  exemptions = OPEN_VOCABULARY_EXEMPTIONS,
} = {}) {
  const webRootPath = resolve(webRoot);
  const parsed = parseConfig(webRootPath);
  const program = typescript.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const rows = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const inside = relative(webRootPath, sourceFile.fileName);
    if (inside.startsWith("..") || inside.split(sep)[0] !== "src") continue;
    rows.push(
      ...switchesOf(sourceFile, relative(dirname(webRootPath), sourceFile.fileName).split(sep).join("/"), checker),
    );
  }
  const findings = [];
  const stack = [];
  const byFile = new Map();
  for (const row of rows) {
    if (row.kind !== "literal_union") {
      byFile.set(`${row.file}\u0000${row.subject}`, (byFile.get(`${row.file}\u0000${row.subject}`) ?? 0) + 1);
      continue;
    }
    const label = `${row.file}:${row.line}:${row.subject}`;
    if (row.unhandled.length > 0) {
      stack.push(
        finding(
          "switch_not_exhaustive",
          `${label} does not handle ${row.unhandled.map((member) => `"${member}"`).join(", ")} of ${row.typeText}` +
            `${row.hasDefault === false ? " and has no default" : ""}`,
        ),
      );
      continue;
    }
    if (row.assertsNever !== true) {
      stack.push(
        finding(
          "switch_default_does_not_assert_never",
          `${label} covers all ${row.kind === "literal_union" ? "members" : "cases"} of ${row.typeText} but its ` +
            `default does not hand the subject to a call whose argument is never, so a new member compiles and falls through`,
        ),
      );
    }
  }
  findings.push(...stack, ...exemptionFindings({ exemptions, byFile }));
  const counts = {
    literal_union: rows.filter((row) => row.kind === "literal_union").length,
    open_vocabulary: rows.filter((row) => row.kind === "open_vocabulary").length,
    not_a_union: rows.filter((row) => row.kind === "not_a_union").length,
  };
  let status = "failed";
  if (rows.length === 0) status = "blocked";
  else if (findings.length === 0) status = "passed";
  return {
    status,
    findings,
    examined: rows.length,
    counts,
    rows,
  };
}

/** The population as the report prints it: one line per switch, so a green run shows what it read. */
function verdictOf(row) {
  if (row.kind !== "literal_union") return row.kind;
  if (row.unhandled.length > 0) return `misses ${row.unhandled.join(",")}`;
  if (row.assertsNever === true) return "exhaustive";
  return "default does not assert never";
}

function printRows(rows) {
  for (const row of rows) {
    console.log(
      `[switch-exhaustiveness] ${row.file}:${row.line} subject=${row.subject} type=${row.typeText} — ${verdictOf(row)}`,
    );
  }
}

function main() {
  const webRootIndex = process.argv.indexOf("--web-root");
  const webRoot = webRootIndex === -1 ? DEFAULT_WEB_ROOT : process.argv[webRootIndex + 1];
  const verdict = checkSwitchExhaustiveness({ webRoot });
  printRows(verdict.rows);
  console.log(
    `[switch-exhaustiveness] examined ${verdict.examined} (closed unions ${verdict.counts.literal_union}, ` +
      `open vocabularies ${verdict.counts.open_vocabulary}, not a union ${verdict.counts.not_a_union})`,
  );
  for (const entry of verdict.findings) console.log(`[switch-exhaustiveness] ${entry.code}: ${entry.detail}`);
  console.log(
    JSON.stringify({
      gate: "switch-exhaustiveness",
      status: verdict.status,
      examined: verdict.examined,
      checks: [
        {
          id: "union_switch_asserts_never",
          status: verdict.findings.some((entry) => entry.code.startsWith("switch_")) ? "failed" : "passed",
        },
        {
          id: "open_vocabulary_stated",
          status: verdict.findings.some((entry) => entry.code.startsWith("exemption_")) ? "failed" : "passed",
        },
      ],
      findings: verdict.findings,
    }),
  );
  if (verdict.status === "blocked") {
    console.error("[switch-exhaustiveness] blocked: this gate examined no switch");
    process.exit(1);
  }
  process.exit(verdict.findings.length === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
