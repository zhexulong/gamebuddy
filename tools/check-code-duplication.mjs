#!/usr/bin/env node
/**
 * Duplication is a gate, not a percentage: one block of >= 40 tokens appearing at >= 3 sites fails, whatever share
 * of the tree that is - unless the block is a DECLARATION rather than an implementation (see FACADE below).
 *
 * WHY. `jscpd` has been a dependency with a `jscpd.json` config since the config was written and nothing ever
 * prevented anything: its `exitCode` was 0, its `format` was `javascript`/`typescript` so the C# Mod was never
 * tokenised, its paths omitted `integrations/stardew`, and no rung, script or workflow invoked it - a report nobody
 * ran. Meanwhile the largest real family in this tree is the eight-step admission pipeline repeated under 24
 * different method names (`receiptsByRequestId.TryGetValue` -> `this.revision++` -> `Guid.NewGuid` -> `nowMs` ->
 * `AdmitExecution(...)` -> the handler call -> `RememberTerminal(...)`), spread over
 * `integrations/stardew/farmhandexecutioncontroller.*.cs`. A percentage threshold cannot see it: measured on this
 * tree, the duplicated lines are 7.7% of the total and the duplicated tokens 9.3%, and 9.3% is a number nobody fails a
 * build over - which is why the rule below has no percentage in it.
 *
 * FACADE: TWO FACTS WORE ONE NAME. A group above the threshold is one of two different things, and counting them
 * together is what made the honest fix unrecordable:
 *
 *   - DUPLICATION - the same implementation text at N sites. It is removable, and removing it must lower the count.
 *   - FACADE - a declaration at N sites: the signature and parameter list of one method per catalogue entry, plus the
 *     one delegation that head performs. `RequestLocalPlantSeed`, `RequestLocalClearCask`, `RequestLocalPickupForage`
 *     ... are the same envelope because the game action catalogue gives them the same envelope; folding 46 actions
 *     into one generic dispatcher would delete the product, not the repetition. Nothing here is copied logic.
 *
 * MEASURED, 2026-11-12, over the 46 `farmhandexecutioncontroller*.cs` partials at HEAD (7fe2d52e), at this file's
 * thresholds: 39 groups. Folding the eight-step pipeline behind one admission seam at 57 sites gave 27 - but not as
 * "twelve fewer": 24 groups disappeared and 12 appeared, of which 6 are
 * `public LocalExecutionReceipt RequestLocal<Action>(...)` followed by `{` and the one `AdmitLocalExecution(...)`
 * delegation. The duplication was removed and the count went the wrong way, because the window had shifted onto the
 * signature. The same run is the falsifier for the alternatives:
 *
 *   - `--mode strict` (no identifier normalisation) reads 43 groups before the seam and 35 after - WORSE on the
 *     facade, because the facade's identifiers are identical and survive normalisation either way; and it STOPS
 *     catching 34 of the 39 groups that exist today, which is exactly the renamed-but-identical body this gate exists
 *     for (the per-action handler call, the per-site `RememberTerminal`, the per-tool refusal). Strict mode answers
 *     the opposite question to the one asked here.
 *   - an ignore pattern cannot express it: jscpd's `--ignore-pattern` skips matching TOKENS, so it would have to name
 *     the seam, the profile and every parameter - one spelling per call site, which is the drift this gate refuses.
 *
 * SO THE RULE IS `isFacadeOnly(fragment)`, evaluated on the text jscpd matched, and it fails CLOSED: a fragment is a
 * facade only while EVERY non-blank, non-comment line of it is declaration text (a signature or a parameter, naming no
 * value: no literal, no spread, no assignment), a brace, a delegation (`return <identifier>;` or
 * `if (<condition>) return <identifier>;`) or a pass-through read (`Type name = a.b.c;`). One lookup, one minted
 * receipt, one comparison, one second branch, one string - anything the rule does not positively recognise - keeps the
 * group as duplication. The fragment must also contain at least one declaration line, so a window that begins inside a
 * body is never a facade. What that releases today is measured, not asserted: on this tree it is exactly one group,
 * `2a848276806f` at 3 sites / 71 tokens, the recursive parameter list of `ClearingPlanner`; on the pre-seam controllers
 * it is none of the 39. What it would release and should not: a method head whose only statement is a single admission
 * guard, even when that guard is an inline `receiptsByRequestId.TryGetValue` rather than a seam call - the rule cannot
 * tell those two apart, and it is safe to be blind to them because the family the gate exists for is five statements
 * of lookup, `revision++`, `Guid.NewGuid`, `nowMs` and the guard, not one.
 *
 * WHAT IT ASSERTS, per clone group - the sites jscpd reports for one repeated text, grouped by that text:
 *
 *   1. a DUPLICATION group with >= MIN_TOKENS tokens at >= MIN_SITES sites is a finding, named with EVERY site and the
 *      group's first line of code, so the reader recognises the block without opening the report;
 *   2. a group recorded in `tools/duplicate-code-baseline.json` at the same or a smaller size passes, because that
 *      duplication already existed when the baseline was written;
 *   3. a baselined group that gained sites or tokens is a finding (`clone_group_grew`), and one that lost them is a
 *      finding too (`stale_clone_baseline`): the baseline can only shrink, so a fix has to be recorded rather than
 *      silently leaving an entry behind;
 *   4. a FACADE group is counted and printed (`facade-only:<hash>: ...`) and is not a finding, because there is no
 *      change a reader could make in response; a baseline entry that records one is `facade_only_clone_baselined`,
 *      which is a different fact from `stale_clone_baseline` and says so - an entry for a group the tree still has,
 *      under a name that no longer claims it is duplication.
 *
 * THE POPULATION IS PRINTED BOTH WAYS, so neither fact can hide inside the other: `clone groups N · of which
 * facade-only M · duplication K`. K is what the ratchet governs and what `--write-baseline` records; a new or grown
 * duplication group still fails, which is the hard failure this file always had.
 *
 * THE BASELINE IS A RATCHET, NOT AN ACCEPT LIST. `--write-baseline` records today's duplication groups when the file
 * does not exist yet, and after that REFUSES to write while any group is new or grew - a green run therefore never
 * becomes the way to accept new duplication, only the way to record a shrink. Line numbers in the baseline are
 * documentation; the comparisons are the site COUNT and the token count, because a line inserted above a site must not
 * turn the gate red.
 *
 * THE POPULATION is this file's `SOURCE_TREES`, and `jscpd.json` must declare the same paths, formats, ignore list and
 * thresholds or `jscpd_config_disagrees:<field>` fails: two spellings of "what is examined" drift apart the first time
 * one of them is edited. `integrations/stardew` and `desktop` are here because they are this repository's C# sources,
 * and `csharp` is in the format list because dropping the tree that matters is the defect this gate exists for.
 *
 * jscpd SKIPS FILES GIT IGNORES (`scratch/`, `.tmp/`), and it exits 0 having examined nothing when a path resolves to
 * no file. So zero files, or a declared format with zero files, is `blocked` (exit 2) naming the format - never a pass.
 * `examined N` counts the files jscpd tokenised, so `0 findings` beside it means something.
 *
 * WHAT IT DOES NOT ASSERT: that a group below the rule is good code, that near-duplicates under 40 tokens matter, or
 * that two implementations of one idea share no line: jscpd matches token sequences, and a rename it normalises may
 * make two structurally identical bodies one group. What it refuses is the specific thing that shipped: the same
 * block copied a third time.
 *
 * USAGE:
 *   node tools/check-code-duplication.mjs                  # the verdict; exit 1 on a new/grown/stale group
 *   node tools/check-code-duplication.mjs --write-baseline  # record a shrink; refuses to record growth
 *
 * red-proof: inject  a fourth copy of the admission pipeline body into a `farmhandexecutioncontroller.*.cs` partial
 *                    while that group's baseline entry stays at its recorded site count ->
 *                    `clone_group_grew:99908b2b6e7b: now 24 sites at 67 tokens, the baseline recorded 23` naming every
 *                    site; with today's baseline removed, the same group reads
 *                    `clone_group:64tokens:9sites: integrations/stardew/farmhandexecutioncontroller.<each partial>.cs`
 *                    beside `files examined 1270 · clone groups 354 · new 354`; an entry whose sites are gone ->
 *                    `stale_clone_baseline:<hash>`.
 * red-proof: facades  three controller partials whose methods share an envelope and one `AdmitLocalExecution(...)`
 *                    delegation, with no baseline -> `clone groups 1 · of which facade-only 1 · duplication 0`, status
 *                    `passed`, and `facade-only:<hash>: 3 sites at <n> tokens :: public LocalExecutionReceipt
 *                    RequestLocal<Action>(` printed; a genuine lookup -> `revision++` -> `Guid.NewGuid` -> `nowMs`
 *                    preamble injected into the same three methods -> `clone_group:<n>tokens:3sites:` ... status
 *                    `failed`, with `facade-only` unchanged; a baseline that records the facade group ->
 *                    `facade_only_clone_baselined:<hash>`.
 *
 * Every direction above is red on jscpd's own report, in tools/check-code-duplication.test.mjs, whose throwaway trees
 * are copied from the real body.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "tools/duplicate-code-baseline.json";
const JSCPD_CONFIG = "jscpd.json";
const JSCPD_ENTRY = "jscpd/run-jscpd.js";

/** The rule, as three numbers: a block this long, repeated this many times, is a finding. */
export const MIN_TOKENS = 40;
export const MIN_SITES = 3;
export const MIN_LINES = 5;

/** The source trees this repository owns. Vendored, mounted (`ref/`, `design/`) and built trees are not ours. */
export const SOURCE_TREES = Object.freeze([
  "host/src",
  "host/scripts",
  "dialogue-web/src",
  "packages",
  "tools",
  "integrations/stardew",
  "desktop",
]);

/** What is not source of ours, or is a copy of it: build output, generated bundles, the decompiled game, tests. */
export const IGNORES = Object.freeze([
  "**/vendor/**",
  "**/ref/**",
  "**/tmp/**",
  "**/.worktrees/**",
  "**/dist*/**",
  "**/*.test.*",
  "**/node_modules/**",
  "**/.commit-validation/**",
  "**/tools/lib/**",
  "**/bin/**",
  "**/obj/**",
  "**/tests/**",
  "**/GameBuddy.Desktop.Tests/**",
]);

/** The formats this tree writes source in. `csharp` is why the Mod appears at all. */
export const FORMATS = Object.freeze(["javascript", "typescript", "csharp"]);

/** `E:\...` / `\\?\E:\...` / `a\b.cs` -> `a/b.cs`, relative to the tree that was examined. */
export function normaliseSitePath(name, root = REPO) {
  const absolute = name.replace(/^\\\\\?\\/u, "");
  const relative = path.isAbsolute(absolute) ? path.relative(root, absolute) : absolute;
  return relative.replaceAll("\\", "/");
}

/** The identity of a clone group: the text jscpd matched, hashed so a baseline line stays readable. */
export function groupHash(fragment) {
  return createHash("sha256").update(fragment).digest("hex").slice(0, 12);
}

const compareSites = (left, right) => left.file.localeCompare(right.file) || left.line - right.line;

/** Statements and declarations, told apart by the only thing a token report cannot tell us: the source text. */
const CONTROL_HEADS = /^(if|else|for|foreach|while|switch|using|lock|catch|try|finally|do|case|default)\b/u;
const NAMES_NO_VALUE = /["'`]|\d|\s=\s|\s=/u;
const isBrace = (line) => line === "{" || line === "}";
const isDeclaration = (line) =>
  !(/[;={}]/u.test(line) || NAMES_NO_VALUE.test(line) || line.includes("...") || CONTROL_HEADS.test(line)) &&
  (line.includes("(") || /[),]$/u.test(line));

/**
 * A fragment is a sequence of units: declaration text, braces, and statements (a control head and its body joined to
 * the line that closes it). Nothing here parses a language; it separates the two kinds of line a clone window can be
 * made of, which is all the facade rule needs.
 */
export function fragmentUnits(fragment) {
  const lines = fragment
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"));
  const units = [];
  let pending = null;
  for (const line of lines) {
    if (pending === null && isBrace(line)) {
      units.push({ kind: "brace", text: line });
      continue;
    }
    if (pending === null && isDeclaration(line)) {
      units.push({ kind: "declaration", text: line });
      continue;
    }
    pending = pending === null ? line : `${pending} ${line}`;
    if (/[;{]$/u.test(line)) {
      units.push({ kind: "statement", text: pending });
      pending = null;
    }
  }
  if (pending !== null) units.push({ kind: "statement", text: pending });
  return units;
}

const DECISION_OR_VALUE = /[&|?=<>[\]]|"|'|`|new\s|\+\+|--/u;
const IDENTIFIER = /^[A-Za-z_][\w.]*$/u;

/** `return <identifier>;`, or `if (<condition>) return <identifier>;` - a head handing its one job to somewhere else. */
function isDelegation(text) {
  const flat = text.replace(/\s+/gu, " ").trim();
  const guarded = flat.match(/^if \((.*)\) return (.*);$/u);
  const plain = flat.match(/^return (.*);$/u);
  const expression = guarded === null ? plain?.[1] : guarded[2];
  return expression !== undefined && IDENTIFIER.test(expression);
}

/** `Type name = a.b.c;` - reading a value through, with no call, no operator and nothing minted. */
function isPassThroughRead(text) {
  const match = text
    .replace(/\s+/gu, " ")
    .trim()
    .match(/^[A-Za-z_][\w.<>?]* [A-Za-z_]\w* = ([^;]*);$/u);
  return match !== null && !DECISION_OR_VALUE.test(match[1]) && !match[1].includes("(");
}

/**
 * The rule that separates the two facts: a clone window that declares an ENVELOPE is not a copy of an implementation.
 * It must declare something (a window that opens inside a body never qualifies), and every statement in it must be a
 * delegation or a pass-through read - no lookup, no minted receipt, no branch, no literal, no arithmetic. Anything
 * this function does not positively recognise leaves the group a duplication finding, which is the safe direction.
 */
export function isFacadeOnly(fragment) {
  const units = fragmentUnits(fragment);
  if (!units.some((unit) => unit.kind === "declaration")) return false;
  return units
    .filter((unit) => unit.kind === "statement")
    .every((unit) => isDelegation(unit.text) || isPassThroughRead(unit.text));
}

/** The group's first line of code, which is what makes a hash recognisable to a reader. */
export function firstLineOf(fragment) {
  const line = fragment.split("\n").find((entry) => entry.trim() !== "") ?? "";
  return line.trim().length > 160 ? `${line.trim().slice(0, 157)}...` : line.trim();
}

/**
 * jscpd's pairwise report, folded into groups: one entry per repeated text, holding every site it was reported at.
 * A pair's two files are both sites, and a site reported by several pairs is counted once. Each group carries the kind
 * of fact it is (`duplication` or `facade`), decided once from the text that is its identity.
 */
export function groupClones(duplicates, root = REPO) {
  const groups = new Map();
  for (const duplicate of duplicates) {
    const hash = groupHash(duplicate.fragment);
    let group = groups.get(hash);
    if (group === undefined) {
      group = {
        hash,
        tokens: duplicate.tokens,
        fragment: duplicate.fragment,
        kind: isFacadeOnly(duplicate.fragment) ? "facade" : "duplication",
        sites: new Map(),
      };
      groups.set(hash, group);
    }
    group.tokens = Math.max(group.tokens, duplicate.tokens);
    for (const site of [duplicate.firstFile, duplicate.secondFile]) {
      const file = normaliseSitePath(site.name, root);
      group.sites.set(`${file}:${site.start}`, { file, line: site.start });
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, sites: [...group.sites.values()].sort(compareSites) }))
    .sort((left, right) => left.hash.localeCompare(right.hash));
}

const describeSites = (sites) => sites.map((site) => `${site.file}:${site.line}`).join(", ");

/** A rule violation, in the line shape an operator reads first: what it is, where every copy is, what the text is. */
function violation(code, prefix, group) {
  return {
    code,
    hash: group.hash,
    detail: `${prefix}: ${describeSites(group.sites)} :: ${firstLineOf(group.fragment)}`,
  };
}

/**
 * The rule, as one reading of one report: which groups are duplication and break it, which of those the baseline
 * already recorded, whether the baseline still describes the tree, and which groups the rule read as a facade instead.
 * `groups` is `groupClones(...)`; `baseline.groups` is the file.
 */
export function evaluateGroups({ groups, baseline, minTokens = MIN_TOKENS, minSites = MIN_SITES }) {
  const counted = groups.filter((group) => group.tokens >= minTokens && group.sites.length >= minSites);
  const facade = counted.filter((group) => group.kind === "facade");
  const duplication = counted.filter((group) => group.kind !== "facade");
  const recorded = new Map((baseline?.groups ?? []).map((entry) => [entry.hash, entry]));
  const findings = [];
  let baselined = 0;
  for (const group of duplication) {
    const entry = recorded.get(group.hash);
    if (entry === undefined) {
      findings.push(violation("clone_group", `clone_group:${group.tokens}tokens:${group.sites.length}sites`, group));
      continue;
    }
    baselined += 1;
    if (group.tokens > entry.tokens || group.sites.length > entry.sites.length) {
      findings.push(
        violation(
          "clone_group_grew",
          `clone_group_grew:${group.hash}: now ${group.sites.length} sites at ${group.tokens} tokens, the baseline ` +
            `recorded ${entry.sites.length} sites at ${entry.tokens} tokens`,
          group,
        ),
      );
      continue;
    }
    if (group.tokens < entry.tokens || group.sites.length < entry.sites.length) {
      findings.push(
        violation(
          "stale_clone_baseline",
          `stale_clone_baseline:${group.hash}: the baseline recorded ${entry.sites.length} sites at ${entry.tokens} ` +
            `tokens, the tree now has ${group.sites.length} at ${group.tokens} tokens - record the shrink with ` +
            "--write-baseline",
          group,
        ),
      );
    }
  }
  const live = new Set(duplication.map((group) => group.hash));
  const facades = new Set(facade.map((group) => group.hash));
  for (const entry of recorded.values()) {
    if (live.has(entry.hash)) continue;
    if (facades.has(entry.hash)) {
      findings.push({
        code: "facade_only_clone_baselined",
        hash: entry.hash,
        detail:
          `facade_only_clone_baselined:${entry.hash}: the baseline records ${entry.sites.length} sites at ` +
          `${entry.tokens} tokens (${entry.sites.join(", ")}), and this gate reads that group as a facade - a ` +
          "declaration, not an implementation - so the entry claims duplication the tree does not have: delete it",
      });
      continue;
    }
    findings.push({
      code: "stale_clone_baseline",
      hash: entry.hash,
      detail:
        `stale_clone_baseline:${entry.hash}: the baseline records ${entry.sites.length} sites at ${entry.tokens} tokens ` +
        `(${entry.sites.join(", ")}), and no group that size is in the tree any more - delete the entry`,
    });
  }
  return {
    examinedGroups: groups.length,
    counted,
    facade,
    duplication,
    baselined,
    newGroups: findings.filter((entry) => entry.code === "clone_group").length,
    grown: findings.filter((entry) => entry.code === "clone_group_grew").length,
    stale: findings.filter((entry) => entry.code === "stale_clone_baseline").length,
    reclassified: findings.filter((entry) => entry.code === "facade_only_clone_baselined").length,
    findings,
  };
}

/** `jscpd.json` and this file must say the same thing, or the report and the gate examine different trees. */
export function configDisagreements({ config, sourceTrees = SOURCE_TREES, formats = FORMATS, ignores = IGNORES }) {
  const disagreements = [];
  const same = (field, ours, theirs) => {
    const left = [...ours].sort().join("\n");
    const right = [...(Array.isArray(theirs) ? theirs : [])].sort().join("\n");
    if (left !== right) disagreements.push({ field, ours: [...ours].join(","), config: right.replaceAll("\n", ",") });
  };
  same("path", sourceTrees, config.path);
  same("format", formats, config.format);
  same("ignore", ignores, config.ignore);
  for (const field of ["minTokens", "minLines"]) {
    const ours = field === "minTokens" ? MIN_TOKENS : MIN_LINES;
    if (config[field] !== ours) disagreements.push({ field, ours: String(ours), config: String(config[field]) });
  }
  return disagreements;
}

/**
 * Run the installed jscpd over the trees being examined and read the JSON report it wrote. The report is the artifact:
 * the console counts are not parsed, and a run that printed a verdict but wrote no readable report is `blocked`.
 *
 * jscpd resolves from THIS file, not from the examined tree: it is a devDependency of this repository, and a synthetic
 * tree in a throwaway directory must be measurable by the same binary as the repository itself.
 */
export function runJscpd({
  root = REPO,
  trees = SOURCE_TREES,
  formats = FORMATS,
  ignores = IGNORES,
  spawn = spawnSync,
} = {}) {
  let entry;
  try {
    entry = createRequire(import.meta.url).resolve(JSCPD_ENTRY);
  } catch {
    return { ok: false, reason: `jscpd_not_installed: ${JSCPD_ENTRY} does not resolve from ${REPO}` };
  }
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "gamebuddy-clones-"));
  try {
    const args = [
      entry,
      ...trees,
      "--min-tokens",
      String(MIN_TOKENS),
      "--min-lines",
      String(MIN_LINES),
      "--format",
      formats.join(","),
      "--ignore",
      ignores.join(","),
      "--reporters",
      "json",
      "--output",
      output,
      "--absolute",
      "--silent",
    ];
    const outcome = spawn(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 10 * 60_000 });
    if (outcome.error?.code === "ETIMEDOUT") return { ok: false, reason: "jscpd_timeout:10000ms" };
    const reportPath = path.join(output, "jscpd-report.json");
    if (!fs.existsSync(reportPath)) {
      const said = `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`
        .trim()
        .split("\n")
        .find((line) => line.trim());
      return {
        ok: false,
        reason: `jscpd_report_missing: exit=${outcome.status} ${said ?? "(it printed nothing)"}`.trim(),
      };
    }
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    if (outcome.status !== 0)
      return { ok: false, reason: `jscpd_failed: exit=${outcome.status} despite writing a report` };
    return { ok: true, report };
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

/** The files each declared format was actually tokenised in, so a dropped tree is a blocked reading. */
export function formatPopulations(report, formats = FORMATS) {
  return Object.fromEntries(formats.map((format) => [format, report.statistics?.formats?.[format]?.sources ?? 0]));
}

/** The baseline payload for a set of groups: what the ratchet records and nothing it could re-derive. */
export function baselinePayload(groups) {
  return {
    groups: [...groups]
      .sort((left, right) => left.hash.localeCompare(right.hash))
      .map((group) => ({
        hash: group.hash,
        tokens: group.tokens,
        sites: group.sites.map((site) => `${site.file}:${site.line}`),
      })),
  };
}

/** One group per line, so a shrink is a diff of lines rather than a re-indented block. */
export function serialiseBaseline(payload) {
  const groups = payload.groups.map(
    (group) => `    ${JSON.stringify({ hash: group.hash, tokens: group.tokens, sites: group.sites })}`,
  );
  return `{\n  "groups": [\n${groups.join(",\n")}\n  ]\n}\n`;
}

export function readBaseline({ root = REPO } = {}) {
  const text = fs.existsSync(path.join(root, BASELINE)) ? fs.readFileSync(path.join(root, BASELINE), "utf8") : null;
  if (text === null) return { groups: [] };
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.groups)) throw new Error("duplicate_code_baseline_malformed:groups");
  return parsed;
}

/** The whole reading, for the CLI and for the test: population, rule, findings, verdict. */
export function checkCodeDuplication({
  root = REPO,
  trees = SOURCE_TREES,
  formats = FORMATS,
  ignores = IGNORES,
  baseline = readBaseline({ root }),
  spawn = spawnSync,
  config,
} = {}) {
  const disagreements = configDisagreements({
    config: config ?? JSON.parse(fs.readFileSync(path.join(root, JSCPD_CONFIG), "utf8")),
    sourceTrees: trees,
    formats,
    ignores,
  });
  const run = runJscpd({ root, trees, formats, ignores, spawn });
  if (!run.ok) return { status: "blocked", reason: run.reason, disagreements, examined: 0 };
  const examined = run.report.statistics?.total?.sources ?? 0;
  const populations = formatPopulations(run.report, formats);
  const groups = groupClones(run.report.duplicates ?? [], root);
  const empty = Object.entries(populations)
    .filter(([, files]) => files === 0)
    .map(([format]) => format);
  if (examined === 0)
    return {
      status: "blocked",
      reason: "code_duplication_examined_no_files",
      populations,
      disagreements,
      examined,
    };
  if (empty.length > 0)
    return {
      status: "blocked",
      reason: `format_examined_no_files:${empty.join(",")}`,
      populations,
      disagreements,
      examined,
    };
  const reading = evaluateGroups({ groups, baseline });
  const findings = [
    ...disagreements.map((entry) => ({
      code: "jscpd_config_disagrees",
      detail: `jscpd_config_disagrees:${entry.field}: the config declares ${entry.config || "(nothing)"}, this gate ${entry.ours}`,
    })),
    ...reading.findings,
  ];
  return { status: findings.length === 0 ? "passed" : "failed", examined, populations, ...reading, findings };
}

/** The report line `tools/check-harness-conformance.mjs` reads: the gate's own id, verdict and population. */
function reportLine(reading) {
  const checks = [
    {
      id: "clone_groups_within_baseline",
      status: reading.status === "failed" ? "failed" : reading.status === "blocked" ? "blocked" : "passed",
    },
  ];
  return JSON.stringify({
    gate: "code_duplication",
    status: reading.status,
    examined: reading.examined,
    ...(reading.reason === undefined ? {} : { reason: reading.reason }),
    ...(reading.counted === undefined
      ? {}
      : {
          cloneGroups: reading.counted.length,
          facadeOnly: reading.facade.length,
          duplication: reading.duplication.length,
        }),
    checks,
  });
}

/** A facade group, named so the reader can see what the rule let through and disagree with it. */
export function facadeLine(group) {
  return (
    `  facade-only:${group.hash}: ${group.sites.length} sites at ${group.tokens} tokens :: ${describeSites(group.sites)} ` +
    `:: ${firstLineOf(group.fragment)}`
  );
}

export function censusLine(reading) {
  if (reading.status === "blocked")
    return `files examined ${reading.examined} · clone groups 0 · BLOCKED ${reading.reason}`;
  return (
    `files examined ${reading.examined} · clone groups ${reading.counted.length} · of which facade-only ` +
    `${reading.facade.length} · duplication ${reading.duplication.length} · new ${reading.newGroups} · ` +
    `grown ${reading.grown} · baselined ${reading.baselined}` +
    `${reading.stale === 0 ? "" : ` · stale ${reading.stale}`}` +
    `${reading.reclassified === 0 ? "" : ` · reclassified ${reading.reclassified}`}`
  );
}

/**
 * What `--write-baseline` must refuse to record: a group that is new or grew. The first write is the only one that may
 * name groups this file has never recorded - that is how today's tree is written down - and every later write may only
 * record a shrink, so a green run never becomes the way to accept new duplication.
 */
export function baselineWriteRefusal({ reading, creating }) {
  if (creating) return [];
  return (reading.findings ?? []).filter((entry) => entry.code === "clone_group" || entry.code === "clone_group_grew");
}

function main(argv) {
  const writeBaseline = argv.includes("--write-baseline");
  let reading;
  try {
    reading = checkCodeDuplication({});
  } catch (error) {
    process.stdout.write(`code_duplication_blocked: ${String(error?.message ?? error)}\n`);
    process.stdout.write(`${reportLine({ status: "blocked", examined: 0 })}\n`);
    process.exitCode = 2;
    return;
  }
  const lines = [censusLine(reading)];
  for (const group of reading.facade ?? []) lines.push(facadeLine(group));
  for (const entry of reading.findings ?? []) lines.push(`  ${entry.detail}`);
  if (writeBaseline) {
    if (reading.counted === undefined) {
      lines.push("baseline_write_refused: the reading is blocked, so there is no population to record");
      process.stdout.write(`${lines.join("\n")}\n`);
      process.stdout.write(`${reportLine(reading)}\n`);
      process.exitCode = 2;
      return;
    }
    const creating = !fs.existsSync(path.join(REPO, BASELINE));
    const refused = baselineWriteRefusal({ reading, creating });
    if (refused.length > 0) {
      lines.push(
        `baseline_write_refused: ${refused.length} group(s) are new or grew - the baseline may only record a shrink`,
      );
      process.stdout.write(`${lines.join("\n")}\n`);
      process.stdout.write(`${reportLine({ ...reading, status: "failed" })}\n`);
      process.exitCode = 1;
      return;
    }
    const payload = baselinePayload(reading.duplication);
    fs.writeFileSync(path.join(REPO, BASELINE), serialiseBaseline(payload), "utf8");
    lines.push(
      `${creating ? "baseline_created" : "baseline_written"}: ${payload.groups.length} group(s) -> ${BASELINE}`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    process.stdout.write(`${reportLine({ ...reading, status: "passed" })}\n`);
    return;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  process.stdout.write(`${reportLine(reading)}\n`);
  if (reading.status !== "passed") process.exitCode = reading.status === "blocked" ? 2 : 1;
}

if (import.meta.main) main(process.argv.slice(2));
