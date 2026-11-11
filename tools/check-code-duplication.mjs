#!/usr/bin/env node
/**
 * Duplication is a gate, not a percentage: one block of >= 40 tokens appearing at >= 3 sites fails, whatever share
 * of the tree that is.
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
 * WHAT IT ASSERTS, per clone group - the sites jscpd reports for one repeated text, grouped by that text:
 *
 *   1. a group with >= MIN_TOKENS tokens at >= MIN_SITES sites is a finding, named with EVERY site and the group's
 *      first line of code, so the reader recognises the block without opening the report;
 *   2. a group recorded in `tools/duplicate-code-baseline.json` at the same or a smaller size passes, because that
 *      duplication already existed when the baseline was written;
 *   3. a baselined group that gained sites or tokens is a finding (`clone_group_grew`), and one that lost them is a
 *      finding too (`stale_clone_baseline`): the baseline can only shrink, so a fix has to be recorded rather than
 *      silently leaving an entry behind.
 *
 * THE BASELINE IS A RATCHET, NOT AN ACCEPT LIST. `--write-baseline` records today's groups when the file does not
 * exist yet, and after that REFUSES to write while any group is new or grew - a green run therefore never becomes the
 * way to accept new duplication, only the way to record a shrink. Line numbers in the baseline are documentation; the
 * comparisons are the site COUNT and the token count, because a line inserted above a site must not turn the gate red.
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
 *                    `stale_clone_baseline:<hash>`. Both directions on real jscpd output, in
 *                    tools/check-code-duplication.test.mjs, whose throwaway trees are copied from the real body.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
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

/** The group's first line of code, which is what makes a hash recognisable to a reader. */
export function firstLineOf(fragment) {
  const line = fragment.split("\n").find((entry) => entry.trim() !== "") ?? "";
  return line.trim().length > 160 ? `${line.trim().slice(0, 157)}...` : line.trim();
}

/**
 * jscpd's pairwise report, folded into groups: one entry per repeated text, holding every site it was reported at.
 * A pair's two files are both sites, and a site reported by several pairs is counted once.
 */
export function groupClones(duplicates, root = REPO) {
  const groups = new Map();
  for (const duplicate of duplicates) {
    const hash = groupHash(duplicate.fragment);
    let group = groups.get(hash);
    if (group === undefined) {
      group = { hash, tokens: duplicate.tokens, fragment: duplicate.fragment, sites: new Map() };
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
 * The rule, as one reading of one report: which groups break it, which of those the baseline already recorded, and
 * whether the baseline still describes the tree. `groups` is `groupClones(...)`; `baseline.groups` is the file.
 */
export function evaluateGroups({ groups, baseline, minTokens = MIN_TOKENS, minSites = MIN_SITES }) {
  const counted = groups.filter((group) => group.tokens >= minTokens && group.sites.length >= minSites);
  const recorded = new Map((baseline?.groups ?? []).map((entry) => [entry.hash, entry]));
  const findings = [];
  let baselined = 0;
  for (const group of counted) {
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
  const live = new Set(counted.map((group) => group.hash));
  for (const entry of recorded.values()) {
    if (live.has(entry.hash)) continue;
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
    baselined,
    newGroups: findings.filter((entry) => entry.code === "clone_group").length,
    grown: findings.filter((entry) => entry.code === "clone_group_grew").length,
    stale: findings.filter((entry) => entry.code === "stale_clone_baseline").length,
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
    checks,
  });
}

function censusLine(reading) {
  if (reading.status === "blocked")
    return `files examined ${reading.examined} · clone groups 0 · BLOCKED ${reading.reason}`;
  return (
    `files examined ${reading.examined} · clone groups ${reading.counted.length} · new ${reading.newGroups} · ` +
    `grown ${reading.grown} · baselined ${reading.baselined}` +
    `${reading.stale === 0 ? "" : ` · stale ${reading.stale}`}`
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
    const payload = baselinePayload(reading.counted);
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
