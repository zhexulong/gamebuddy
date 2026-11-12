#!/usr/bin/env node
/**
 * A gate must be able to say "I measured nothing" differently from "I measured and found nothing".
 *
 * WHY. Every false reading this tree has published this month has one shape: a check exits 0 having read nothing, and
 * its exit status is the only thing anyone downstream reads.
 *
 *   `check:publint`                `spawnSync("bun")` started only a `.ps1` shim, so no publint message was ever read,
 *                                  and the gate's tolerance branch called that emptiness a pass.
 *   `test:stardew-soil-itm-canary` five cases skipped and `node --test` exited 0, so the suite reported a pass over five
 *                                  skips.
 *   `check:cross-language-wire-parity`
 *                                  37 frames measured, 31 paired, the 6 it could not pair written as prose *below* a
 *                                  `passed` verdict.
 *   native-multiplayer-sensitivity  a register marked generated, 96 of 106 actions, refused by its own producer.
 *
 * Each was fixed on its own. What did not exist is the check over the REGISTRY of gates that asks the question for
 * every gate, including the ones nobody has written yet. This is that check.
 *
 * THE QUESTION, per gate, and the three ways a gate answers it wrong:
 *
 *   `gate_without_population`            nothing the gate prints counts the objects it examined. A run over zero
 *                                        objects then prints exactly what a run over nine hundred prints.
 *   `gate_skip_can_pass`                 its population can all skip, and an all-skip run exits 0. `node --test` prints
 *                                        `# pass 0` and exits 0, which is the same green as a suite that measured.
 *   `gate_pairs_a_subset_and_passes`     it names a subset it could not pair (`unpaired`, `unmatched`, `unmeasured`)
 *                                        and never compares that count against zero, so the count cannot reach the
 *                                        verdict - it can only reach the prose.
 *
 * WHAT IT READS, and what that is worth. The reading is the gate's own SOURCE, comments blanked: the population words
 * it prints, whether its command hands control to a decider of its own, and whether a subset count is compared rather
 * than interpolated. It runs nothing. That is deliberate, and it has a stated cost: a gate can satisfy the rule and
 * still lie, because a population word in a dead branch reads the same as one on the verdict line. The alternative
 * design - run every gate's default invocation and judge its output - is what `tools/lib/harness-conformance.mjs`
 * already does for the `tools/check-*.mjs` half, and doing it here too would put the ladder inside the ladder: the
 * population is 330 gates, including C# compiles and live-run verifiers, so a rung that ran them would cost hours and
 * would fail for every reason a gate can fail. The rule is therefore a property of the gate's own report contract, and
 * the three gates above are the proof it catches the shape that shipped three times.
 *
 * POPULATION. Derived, never listed: `tools/lib/gate-population.mjs` is the ONE derivation of "what is a gate" (every
 * `package.json` script in the `audit:`/`check:`/`test:` namespace plus every `tools/check-*.mjs` file no script
 * names), and the ladder's own `PRELUDE_RUNGS` is imported rather than parsed. A member whose command names no source
 * file in this repository (`pnpm knip`, a dotnet test project, a PowerShell transcript) cannot be read at all; those are
 * named on their own line with the reason, and the two numbers reconcile with the same population
 * `tools/check-harness-conformance.mjs` prints: `examined N + outside N_out = that tool's examined`.
 *
 * VERDICT AND DEBT. The measurement is the debt, and the debt is recorded, not accepted:
 *
 *   `gates examined N · with a population line M · without K · unreadable R`   the partition, `M + K + R = N`
 *   `findings N · without_population A · skip_can_pass B · pairs_a_subset C`    the causes, which are not disjoint
 *
 * Findings are kept in `tools/gate-population-baseline.json`, which `--update` writes from a real reading - never by
 * hand, which is why it is a record of debt rather than a list of exemptions. The ratchet turns both ways: a finding
 * the baseline does not record is red (a new silent gate cannot land), and a baseline entry that is no longer a finding
 * is red too (a paid debt must be deleted, so an entry cannot outlive the thing it described). This is the same
 * mechanism `tools/audit-gate-red-proofs.mjs` uses for gates that were never seen red, and for the same reason: the
 * alternative is a gate that can never be green, which nobody keeps running.
 *
 * BLOCKED, NOT SKIPPED. A reading that could not be taken is exit 2 with the reason and the gate named, and it is
 * counted apart from both buckets. `examined 0` is itself blocked (`gate_population_population_empty`): a check whose
 * population is empty agrees with itself, which is the defect this gate exists for.
 *
 * SELF-CLASSIFICATION. This file is in its own population, because it is a `tools/check-*.mjs` gate with a script. It
 * prints where it landed (`self: with a population line`), and the rule is applied to it by the same code: it prints
 * `gates examined N`, and its not-measured path is `gate_population_population_empty` with exit 2. A version of this
 * file that dropped either would be reported against itself by name in the same run.
 *
 * USAGE:
 *   node tools/check-gate-populations.mjs              # the reading; exit 1 on an unrecorded or stale finding
 *   node tools/check-gate-populations.mjs --json       # machine output
 *   node tools/check-gate-populations.mjs --root DIR   # read another tree (the red proofs use this)
 *   node tools/check-gate-populations.mjs --update     # rewrite the baseline from this reading
 *
 * RED PROOFS. Each is a copy of the tree outside the repository (package.json + tools/), with one member restored to the
 * shape that shipped. The copies are the proof the rule is not vacuous, and each names the finding it produced.
 *
 * red-proof: history restoring `git show b00e40a4^:tools/check-publint.mjs` in a copy of the tree ->
 *   `gate_without_population: check:publint` and exit 1, because the pre-fix gate printed a pass over zero publint
 *   messages (tools/check-gate-populations.mjs)
 * red-proof: history restoring `9918a084^`'s script and suite in a copy -> `gate_skip_can_pass:
 *   test:stardew-soil-itm-canary`, the run that reported `tests 5 · pass 0 · skipped 5` with exit 0
 *   (tools/check-gate-populations.mjs)
 * red-proof: history the wire parity gate's pre-fix verdict restored in a copy ->
 *   `gate_pairs_a_subset_and_passes: check:cross-language-wire-parity`, `passed` over 31 of 37 paired frames
 *   (tools/check-gate-populations.mjs)
 *
 * No game, no network, no model, no child process.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { populationFieldPattern } from "./lib/assert-non-vacuous.mjs";
import { deriveGatePopulation } from "./lib/gate-population.mjs";
import { indexedGatePopulation } from "./lib/indexed-sources.mjs";
import { blankComments, PRELUDE_RUNGS } from "./prelive.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = "tools/gate-population-baseline.json";
const BASELINE_SCHEMA = "gamebuddy-gate-population-baseline/v1";
/** This file, which is in the population and is classified by the same call. */
const SELF = "tools/check-gate-populations.mjs";

/**
 * The words a gate counts when it says what it READ. The list is the whole rule for `gate_without_population`, so a new
 * member has to mean the same thing: an object the gate examined.
 *
 * The found side is deliberately absent - `findings`, `violations`, `problems`, `errors` - because a gate that prints
 * `0 findings` has told a reader nothing about how many objects produced zero, which is this gate's entire question.
 * `unpaired`/`unmeasured` are absent for the same reason: they are the subset shape, judged by `SUBSET_WORDS`.
 */
export const POPULATION_WORDS = Object.freeze([
  "actions",
  "arms",
  "awaits",
  "calls",
  "cases",
  "classes",
  "descriptors",
  "documents",
  "entries",
  "examined",
  "fields",
  "files",
  "frames",
  "functions",
  "imports",
  "items",
  "keys",
  "lines",
  "matches",
  "members",
  "messages",
  "nodes",
  "objects",
  "occurrences",
  "pairs",
  "records",
  "references",
  "registers",
  "routes",
  "rows",
  "scanned",
  "scenarios",
  "sites",
  "slots",
  "sources",
  "symbols",
  "tests",
  "tiles",
  "types",
  "walked",
]);

/**
 * The words a gate uses for a subset it could not account for. A count under one of these names is a population
 * measurement that the gate makes and then has to USE: the shape this gate exists for is the one where it is printed.
 */
export const SUBSET_WORDS = Object.freeze([
  "uncovered",
  "unmapped",
  "unmatched",
  "unmeasured",
  "unpaired",
  "unresolved",
]);

/** A skip a suite can take, in the forms `node --test` accepts: the option, the call, the case-level flag. */
const SKIP_CAPABLE = /\bskip\s*:\s*[^,}]+|\.skip\(|\bskipUnless\b|\bskipIf\b/u;

/** A gate that publishes a not-measured verdict of its own: a marker plus the exit path that carries it. */
const NOT_MEASURED_MARKER = /(?:_not_measured|_skipped|not_measured|allowEmpty)/u;
const EXIT_PATH = /process\.exitCode|process\.exit\(|exitCode\s*[:=]/u;

/** The command runs the Node test runner directly, so the runner's own `# tests N` report is the gate's population. */
const RUNS_NODE_TEST = /\bnode\s+--(?:import|experimental-)[^&|]*--test\b|\bnode\s+--test\b/u;

/** A suite file: a test runner's input, never a decider. */
const SUITE_ENTRY = /\.test\.(?:mjs|cjs|ts|js)$/u;

/** A collection a statement pushes into: `gaps.push(...)` names `gaps`. */
const PUSH_SITE = /([A-Za-z_$][\w$]*)\.push\(/gu;

/** A source this gate can read: nothing else is a reading, and pretending otherwise is the defect it measures. */
const READABLE_SOURCE = /\.(?:mjs|cjs|js|ts|tsx|jsx)$/u;

/**
 * The source with its quoted literals blanked, for the scans that hunt IDENTIFIERS.
 *
 * A vocabulary written as strings - this file's own `SUBSET_WORDS`, a fixture naming a node `"unresolved"` - is not a
 * count the gate holds, and reading it as one would report the gate that declares the words. Template literals are left
 * alone: that is where a gate interpolates the number it actually measured, and the wire parity gate's own
 * `${report.frames.unpaired.join(", ")}` would otherwise be read as a quote that never closes.
 *
 * Both facts are load-bearing, each measured on a real gate: without the string rule the gate reported itself as naming
 * six subset words it only declares; without the template rule an unquoted quote inside one template blanked the
 * hundreds of lines that followed, and the reconstructed pre-fix wire gate read as clean.
 */
/** A character preserved as itself, or as a space when it is being blanked: newlines stay, so lines stay true. */
const blanked = (character) => (character === "\n" ? "\n" : " ");

/** Inside a single- or double-quoted literal: blank everything but the delimiters. */
function stepQuote(source, index, stack, out) {
  const quote = stack.at(-1).quote;
  if (source[index] === "\\") {
    out.push("  ");
    return index + 2;
  }
  if (source[index] === quote) {
    stack.pop();
    out.push(quote);
    return index + 1;
  }
  out.push(blanked(source[index]));
  return index + 1;
}

/** Inside a template literal's TEXT: copy it, and descend into `${` without reading its quotes as delimiters. */
function stepTemplate(source, index, stack, out) {
  const character = source[index];
  if (character === "\\") {
    out.push(source.slice(index, index + 2));
    return index + 2;
  }
  if (character === "`") {
    stack.pop();
    out.push(character);
    return index + 1;
  }
  if (character === "$" && source[index + 1] === "{") {
    stack.push({ kind: "expression", depth: 1 });
    out.push("${");
    return index + 2;
  }
  out.push(character);
  return index + 1;
}

/** Inside a template literal's `${ … }`: track the braces so the expression's end is known. */
function stepExpression(source, index, stack, out) {
  const top = stack.at(-1);
  const character = source[index];
  if (character === "{") top.depth += 1;
  if (character === "}") top.depth -= 1;
  if (top.depth === 0) stack.pop();
  out.push(character);
  return index + 1;
}

/** Outside any literal: a backtick or a quote opens one. */
function stepCode(source, index, stack, out) {
  const character = source[index];
  if (character === "`") stack.push({ kind: "template" });
  else if (character === '"' || character === "'") stack.push({ kind: "quote", quote: character });
  out.push(character);
  return index + 1;
}

export function blankStringLiterals(source) {
  const out = [];
  const stack = [];
  let index = 0;
  while (index < source.length) {
    const state = stack.at(-1)?.kind ?? "code";
    if (state === "quote") index = stepQuote(source, index, stack, out);
    else if (state === "template") index = stepTemplate(source, index, stack, out);
    else if (state === "expression") index = stepExpression(source, index, stack, out);
    else index = stepCode(source, index, stack, out);
  }
  return out.join("");
}

/**
 * `examined ${count}` and `${count} <word>`: both orders appear in this tree, and a rule that accepted one would report
 * half of the gates that already answer the question.
 *
 * The gap is short on purpose. Measured on the pre-fix `check-publint.mjs`: a 90-character window matched the word
 * `types` in the printed sentence "missing types condition for exports: ${path}" and read a gate that printed no count
 * at all as one that had - the defect this gate exists for, committed by the gate itself. A count sits beside its
 * number, so 24 characters is the whole licence.
 */
function populationLinePattern() {
  const words = POPULATION_WORDS.join("|");
  // One token of slack, never a sentence: `files examined ${n}` and `${n} tests` are counts, while
  // "missing types condition for exports: ${path}" is prose that happens to carry a word from the list. Measured on the
  // pre-fix `check-publint.mjs`: a 90-character window read that sentence as a population line and passed the exact
  // defect this gate exists for.
  return [
    new RegExp(`\\b(?:${words})\\b(?:[ \\t]+\\S+)?[ \\t]*[:=]?[ \\t]*\\$\\{`, "u"),
    new RegExp(`\\$\\{[^}]{0,90}\\}[ \\t]*[,:·|/-]?[ \\t]*\\b(?:${words})\\b`, "u"),
  ];
}

/** The innermost `{ ... }` block around an offset, or the rest of the file when there is none. */
function enclosingBlock(code, index) {
  let depth = 0;
  let open = -1;
  for (let cursor = index; cursor >= 0; cursor--) {
    if (code[cursor] === "}") depth += 1;
    else if (code[cursor] === "{") {
      if (depth === 0) {
        open = cursor;
        break;
      }
      depth -= 1;
    }
  }
  if (open < 0) return "";
  depth = 0;
  for (let cursor = open; cursor < code.length; cursor++) {
    if (code[cursor] === "{") depth += 1;
    else if (code[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open, cursor + 1);
    }
  }
  return code.slice(open);
}

/** Every collection a piece of code pushes into. */
function collectors(code) {
  return new Set([...code.matchAll(PUSH_SITE)].map((match) => match[1]));
}

/**
 * Does the subset count reach a DECISION, not just a printed line?
 *
 * Two accepted shapes, and the second is why this is not a one-line test: the count is compared against zero itself
 * (`unpaired.length === 0 ? "passed" : "blocked"`), or the block that collects it hands the same failure to another
 * collection the verdict compares. The wire parity gate is the second shape - it pushes the frame into `unpaired` and
 * the refusal into `gaps` in the same `if`, and the verdict is `gaps.length > 0 ? "blocked" : ...` - so a rule that
 * only accepted a direct comparison would report the gate that was FIXED for this defect.
 *
 * The limit, stated: a gate that collects and only prints is reported; a gate that routes the count through a helper
 * two functions away is accepted as clean although the reading cannot follow it. That is the cost of asking the
 * question from source instead of running 343 gates.
 */
export function subsetReachesVerdict(code, name) {
  if (countsCompared(code, name)) return true;
  const sites = [...code.matchAll(new RegExp(`\\b${name}\\.push\\(`, "gu"))];
  for (const site of sites) {
    const block = enclosingBlock(code, site.index);
    for (const other of collectors(block)) if (other !== name && countsCompared(code, other)) return true;
  }
  return false;
}

/** The comparisons that put a count into a decision rather than into prose. */
function countsCompared(code, name) {
  const word = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [
    new RegExp(`\\b${word}\\b[^\\n;]{0,40}\\.(?:length|size)\\s*(?:[=!<>]=|>|<)`, "u"),
    new RegExp(`\\.(?:length|size)\\s*(?:[=!<>]=|>|<)\\s*0\\s*\\?\\s*[^\\n;]{0,40}\\b${word}\\b`, "u"),
    new RegExp(`if\\s*\\(\\s*!?\\s*${word}\\s*[.)]`, "u"),
    new RegExp(`\\b${word}\\b[^\\n;]{0,20}\\.(?:length|size)\\s*\\?`, "u"),
    new RegExp(`\\b${word}\\s*\\.(?:length|size)\\s*(?:\\?|&&|\\|\\|)`, "u"),
    new RegExp(`\\b${word}\\s*\\?\\s*[^\\n;]{0,40}:`, "u"),
  ].some((pattern) => pattern.test(code));
}

/**
 * Does the gate print how many objects it examined?
 *
 * Two accepted spellings, and both are the tree's own: a report key from `tools/lib/assert-non-vacuous.mjs`
 * (`population`/`fields`/`cases`/`examined`, imported rather than restated, because two spellings of that list disagree
 * the first time one of them learns a member), and a printed count naming an object from `POPULATION_WORDS`.
 */
export function publishesPopulation(code) {
  if (populationFieldPattern().test(code)) return true;
  return populationLinePattern().some((pattern) => pattern.test(code));
}

/**
 * The subset counts the gate HOLDS: a word from `SUBSET_WORDS` that the gate BUILDS as a list, with a size read off it.
 *
 * Both halves are load-bearing, each measured on a real gate. A word that only appears as a label or inside a string is
 * not a count (`unmeasured` is a column heading in the wire parity gate's own verdict line) - and if "builds" is dropped,
 * that heading is read as a list because the number beside it happens to be `${unpaired.length}`.
 */
export function subsetCounts(code) {
  const identifiers = blankStringLiterals(code);
  return SUBSET_WORDS.filter((word) => {
    const built = new RegExp(`\\b${word}\\b\\s*=\\s*\\[\\]|\\b${word}\\.push\\(`, "u").test(identifiers);
    const sized = new RegExp(`\\b${word}\\b[^\\n;]{0,40}\\.(?:length|size)\\b`, "u").test(identifiers);
    return built && sized;
  });
}

/** Can a run that examined nothing print exactly what a run that examined everything prints? */
export function publishesNotMeasured(code) {
  return NOT_MEASURED_MARKER.test(code) && EXIT_PATH.test(code);
}

/**
 * Classify one gate from its entry sources.
 *
 * `sources` is the gate's entry files read as text, already comment-blanked by the caller; `command` is what
 * `package.json` runs. The three findings are decided in the order a reader would ask them, and the first one that
 * applies is the one reported, so each gate has one cause rather than three symptoms.
 */
export function classifyGate({ id, command, entryFiles, sources }) {
  const code = sources.join("\n");
  const suites = entryFiles.filter((file) => SUITE_ENTRY.test(file));
  const everyEntryIsSuite = entryFiles.length > 0 && suites.length === entryFiles.length;
  // A suite file run directly still prints the runner's `# tests N` report, so it answers the population question the
  // same way `node --test` does - and it inherits the same all-skip pass.
  const runnerReports = RUNS_NODE_TEST.test(command) || everyEntryIsSuite;
  const skippable =
    suites.length > 0 && suites.every((file) => SKIP_CAPABLE.test(sources[entryFiles.indexOf(file)] ?? ""));
  // Three ways a gate can say what it measured, and the third is the strongest: a not-measured verdict is a gate telling
  // a reader the measurement did not happen, which is the distinction this whole check is about.
  if (!(runnerReports || publishesPopulation(code) || publishesNotMeasured(code)))
    return { id, code: "gate_without_population", detail: "prints no count of the objects it examined" };
  // The runner's `# tests N` report is a population line, and it is also the reason an all-skip run passes: the suite
  // exits 0 and the runner prints `# pass 0`, which no reader downstream treats as "measured nothing".
  if (runnerReports && everyEntryIsSuite && skippable && !publishesNotMeasured(code))
    return {
      id,
      code: "gate_skip_can_pass",
      detail: `runs node --test over ${suites.length} suite(s) that can all skip, and nothing decides before the runner`,
    };
  const identifiers = blankStringLiterals(code);
  const uncompared = subsetCounts(code).filter((word) => !subsetReachesVerdict(identifiers, word));
  if (uncompared.length > 0)
    return {
      id,
      code: "gate_pairs_a_subset_and_passes",
      detail: `holds ${uncompared.join(", ")} and nothing compares that count or the refusal it feeds, so the verdict cannot read it`,
    };
  return null;
}

/** Read one entry file under `root`, or `null` when it is missing or not a source this gate can read. */
function readSource(root, file) {
  if (!READABLE_SOURCE.test(file)) return null;
  try {
    return blankComments(readFileSync(path.join(root, file), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The population, scoped to what can be read.
 *
 * The population is `tools/lib/indexed-sources.mjs`'s - the ONE derivation (`tools/lib/gate-population.mjs`) restricted to
 * what the INDEX carries, because a gate file another lane has not staged is not yet anyone's and measuring it would move
 * this gate's baseline with no commit behind it. That library states the incident: an untracked gate file took the format
 * ratchet from `files=2` to `files=3` with nothing behind it. A `git archive` copy - what the red proofs read - has no
 * index at all, so the directory scan is the whole reading there and `indexed: false` says which of the two a reader is
 * looking at. Members the index does not carry are named, never swallowed.
 *
 * `outside` is the population's other half, printed with its reason: a gate whose command runs `pnpm knip` or a dotnet
 * test project names no file here, so measuring it from source is impossible and calling it clean would be the silent pass
 * this gate is about.
 */
export function readGates({ root = REPOSITORY_ROOT } = {}) {
  let population;
  let indexed = true;
  let untrackedNotCounted = [];
  try {
    population = indexedGatePopulation({ root });
    untrackedNotCounted = population.untrackedNotCounted;
  } catch {
    population = deriveGatePopulation({ root });
    indexed = false;
  }
  const ladder = new Set(PRELUDE_RUNGS.flatMap((rung) => rung.gates));
  const examined = [];
  const outside = [];
  for (const gate of population.gates) {
    const entryFiles = gate.entryFiles.filter((file) => READABLE_SOURCE.test(file));
    if (entryFiles.length === 0) {
      outside.push({ id: gate.id, detail: `runs \`${gate.command}\`, which names no source file in this repository` });
      continue;
    }
    const sources = entryFiles.map((file) => readSource(root, file));
    const unreadable = entryFiles.filter((_, index) => sources[index] === null);
    if (unreadable.length > 0) {
      examined.push({ id: gate.id, command: gate.command, entryFiles, unreadable });
      continue;
    }
    examined.push({ id: gate.id, command: gate.command, entryFiles, sources });
  }
  for (const file of ladder) {
    if (examined.some((gate) => gate.entryFiles.includes(file) || gate.id === file)) continue;
    if (untrackedNotCounted.includes(file)) continue;
    const source = readSource(root, file);
    if (source === null) continue;
    examined.push({ id: file, command: `node ${file}`, entryFiles: [file], sources: [source] });
  }
  return { examined, outside, indexed, untrackedNotCounted };
}

/**
 * The census and the findings. `blocked` members are the readings that could not be taken, each with its reason; they
 * are counted apart from the two verdict buckets so `with a population line M + without K + unreadable R = examined N`
 * holds exactly, and every member of the population lands in one of the three.
 */
export function judgeGates({ gates }) {
  const findings = [];
  const blocked = [];
  const buckets = [];
  for (const gate of gates) {
    if (gate.unreadable !== undefined) {
      blocked.push({ id: gate.id, detail: `entry not readable as source: ${gate.unreadable.join(", ")}` });
      buckets.push({ id: gate.id, bucket: "unreadable", entryFiles: gate.entryFiles });
      continue;
    }
    const finding = classifyGate(gate);
    if (finding === null) buckets.push({ id: gate.id, bucket: "with a population line", entryFiles: gate.entryFiles });
    else {
      findings.push(finding);
      buckets.push({ id: gate.id, bucket: "without", code: finding.code, entryFiles: gate.entryFiles });
    }
  }
  return { findings, blocked, buckets };
}

/** The baseline as a set, or `null` when the file is absent or not the shape this gate writes. */
export function readBaseline({ root = REPOSITORY_ROOT } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, BASELINE_PATH), "utf8"));
    if (parsed?.schema !== BASELINE_SCHEMA || !Array.isArray(parsed.gates)) return null;
    return new Set(parsed.gates.filter((entry) => typeof entry === "string"));
  } catch {
    return null;
  }
}

/** One finding as the baseline's key: the cause and the gate, so a renamed gate is a new finding and an old stale row. */
export function baselineKey(finding) {
  return `${finding.code} ${finding.id}`;
}

/** Findings the baseline does not record, and baseline rows that are no longer findings. Both are red. */
export function reconcile({ findings, baseline }) {
  if (baseline === null) return { unrecorded: [...findings], stale: [], baselineMissing: true };
  const keys = new Set(findings.map(baselineKey));
  return {
    unrecorded: findings.filter((finding) => !baseline.has(baselineKey(finding))),
    stale: [...baseline].filter((key) => !keys.has(key)).sort(),
    baselineMissing: false,
  };
}

/** The baseline document, with the reading that produced it. Sorted, so `--update` rewrites only what changed. */
export function baselineDocument(findings) {
  return {
    schema: BASELINE_SCHEMA,
    note:
      "Gates measured silent about their own population at this commit. A record of debt, not an acceptance of it: " +
      "delete a row by making the gate say what it examined, never by adding one by hand. `--update` writes this file.",
    gates: findings.map(baselineKey).sort(),
  };
}

/** The census lines: the partition, the causes, the half that could not be read, and where the population came from. */
export function describeCensus({ examined, outside, findings, blocked, indexed = true, untrackedNotCounted = [] }) {
  const without = findings.length;
  const unreadable = blocked.length;
  const withLine = examined - without - unreadable;
  const count = (code) => findings.filter((finding) => finding.code === code).length;
  return {
    withLine,
    without,
    unreadable,
    lines: [
      `gates examined ${examined} · with a population line ${withLine} · without ${without} · unreadable ${unreadable}`,
      `findings ${findings.length} · without_population ${count("gate_without_population")} · ` +
        `skip_can_pass ${count("gate_skip_can_pass")} · pairs_a_subset ${count("gate_pairs_a_subset_and_passes")} ` +
        `(causes are not disjoint: a gate can be silent for two reasons)`,
      `outside ${outside.length} (no source file to read; counted apart from the partition, named with the command)`,
      indexed
        ? `population: the index, which does not carry ${untrackedNotCounted.length} gate file(s) yet` +
          (untrackedNotCounted.length === 0 ? "" : `: ${[...untrackedNotCounted].sort().join(", ")}`)
        : "population: the directory, because this tree carries no git index (a copy - what the red proofs read)",
    ],
  };
}

/** The exit status of each ratchet verdict: `passed` is the only one a caller can treat as a reading. */
const EXIT_FOR_STATUS = Object.freeze({ passed: 0, failed: 1, blocked: 2 });

/** The ratchet's verdict, in the three words `tools/lib/harness-conformance.mjs` also uses. */
function ratchetStatus({ baselineMissing, unrecorded, stale }) {
  if (baselineMissing) return "blocked";
  return unrecorded.length === 0 && stale.length === 0 ? "passed" : "failed";
}

/**
 * The self-verification report every gate in `tools/lib/harness-conformance.mjs`'s `GATES_WITH_FALSIFIER` prints.
 *
 * It carries `examined`, so the SAME judge this gate reads in others (`tools/lib/assert-non-vacuous.mjs`) reads this
 * gate: a run over zero gates is `blocked` there for the same reason it is exit 2 here. That is what makes the answer
 * to "would this gate catch itself" a measurement instead of a promise - the conformance suite runs this file's default
 * invocation and judges its population with the rule this file enforces on 345 others.
 */
export function buildReport({
  examined,
  findings,
  blocked,
  unrecorded,
  stale,
  baselineMissing,
  self,
  indexed,
  untrackedNotCounted,
}) {
  const causes = ["gate_without_population", "gate_skip_can_pass", "gate_pairs_a_subset_and_passes"];
  const status = ratchetStatus({ baselineMissing, unrecorded, stale });
  return {
    gate: "gate_populations/v1",
    status,
    examined: examined.length,
    withPopulationLine: examined.length - findings.length - blocked.length,
    without: findings.length,
    unreadable: blocked.length,
    populationSource: indexed ? "index" : "directory",
    untrackedNotCounted: [...untrackedNotCounted].sort(),
    self,
    checks: [
      ...causes.map((code) => ({
        id: code,
        status: unrecorded.some((finding) => finding.code === code) ? "failed" : "passed",
        detail: `${findings.filter((finding) => finding.code === code).length} gate(s) with this cause`,
      })),
      {
        id: "baseline_current",
        status,
        detail: `${unrecorded.length} unrecorded · ${stale.length} stale`,
      },
    ],
    unrecorded: unrecorded.map(baselineKey),
    stale,
  };
}

/** The human reading: the partition, where this file landed, and every member that made a bucket. */
function writeHumanRun({ census, self, blocked, outside, findings, unrecorded, stale, baselineMissing, report }) {
  for (const line of census.lines) process.stdout.write(`${line}\n`);
  // This file is one of the population and is judged by the same rule, which is the only answer to "would it catch
  // itself" that is a measurement rather than a promise.
  process.stdout.write(
    self.id === null
      ? `self: not in the index yet - ${SELF} is classified by the same rule as soon as it is staged\n`
      : `self: ${self.code === null ? "with a population line" : `without (${self.code})`} - ${self.id} is a member of the population and is classified by the same call, not by an exemption\n`,
  );
  for (const entry of blocked) process.stdout.write(`blocked: ${entry.id}: ${entry.detail}\n`);
  for (const entry of outside) process.stdout.write(`outside: ${entry.id}: ${entry.detail}\n`);
  for (const finding of findings) process.stdout.write(`  ${finding.code}: ${finding.id}: ${finding.detail}\n`);
  for (const finding of unrecorded)
    process.stdout.write(`gate_population_finding_unrecorded: ${baselineKey(finding)}\n`);
  for (const key of stale) process.stdout.write(`gate_population_baseline_stale: ${key}\n`);
  if (baselineMissing)
    process.stdout.write(`gate_population_baseline_unreadable: ${BASELINE_PATH} is absent or not ${BASELINE_SCHEMA}\n`);
  else if (unrecorded.length === 0 && stale.length === 0) process.stdout.write("gate_population_baseline_current\n");
  // The report is the LAST line and one line long, which is the shape `selfVerificationReport` reads in reverse.
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex < 0 ? REPOSITORY_ROOT : path.resolve(argv[rootIndex + 1] ?? "");
  const { examined, outside, indexed, untrackedNotCounted } = readGates({ root });
  const { findings, blocked, buckets } = judgeGates({ gates: examined });
  const census = describeCensus({
    examined: examined.length,
    outside,
    findings,
    blocked,
    indexed,
    untrackedNotCounted,
  });
  const selfBucket = buckets.find((entry) => (entry.entryFiles ?? []).includes(SELF)) ?? null;
  const self = { id: selfBucket?.id ?? null, bucket: selfBucket?.bucket ?? "outside", code: selfBucket?.code ?? null };

  // Zero is blocked, never green: a population that measured nothing agrees with itself, and `--update` must not record
  // that agreement as the baseline.
  if (examined.length === 0) {
    process.stdout.write(`gate_population_population_empty: 0 gate read under ${root}\n`);
    return 2;
  }

  if (argv.includes("--update")) {
    writeFileSync(path.join(root, BASELINE_PATH), `${JSON.stringify(baselineDocument(findings), null, 2)}\n`);
    process.stdout.write(
      `gate_population_baseline_written: ${findings.length} finding(s) over ${examined.length} gate(s)\n`,
    );
    return 0;
  }

  const baseline = readBaseline({ root });
  const { unrecorded, stale, baselineMissing } = reconcile({ findings, baseline });
  const report = buildReport({
    examined,
    findings,
    blocked,
    unrecorded,
    stale,
    baselineMissing,
    self,
    indexed,
    untrackedNotCounted,
  });
  const ratchet = { baselineMissing, unrecorded, stale };

  if (argv.includes("--json"))
    process.stdout.write(`${JSON.stringify({ ...report, findings, blocked, outside }, null, 2)}\n`);
  else writeHumanRun({ census, self, blocked, outside, findings, unrecorded, stale, baselineMissing, report });

  const status = ratchetStatus(ratchet);
  return EXIT_FOR_STATUS[status];
}

if (import.meta.main) process.exitCode = main();
