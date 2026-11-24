#!/usr/bin/env node
/**
 * A claim about the Mod's code cites a SYMBOL, because a line range expires in silence.
 *
 * WHY. `cropTargets.publishedAsWork` cited `farmhandtargetdiscovery.cs` by a line range while it claimed
 * `DiscoverCropTargets` publishes only rows that need water. That file grew from 1,743 to 2,843 lines, the function moved
 * out of the range, and the reason text did not change a word - so the citation kept its shape and lost its subject, and
 * the only thing that would have noticed was a reader. A symbol is looked up wherever it moved to, so the same claim is
 * checkable or it fails by name. THE RESOLUTION IS NOT WRITTEN HERE: `tools/lib/source-citation.mjs` owns the spelling of
 * a citation and the declaration test, and every citation-bearing gate comes through it, so two gates cannot disagree
 * about what a citation means.
 *
 * POPULATION, derived on every run from the tree's own text - no list of sites anywhere:
 *   1. every text file `git ls-files` publishes (this repository's own text, so a lane's untracked scratch file is not a
 *      member), read as written. `tools/line-range-citation-baseline.json` is the one file skipped, because its rows ARE
 *      the citations it records; scanning it would count every recorded debt as a new one.
 *   2. every `<file>.cs:<from>-<to>` in that text is a LINE-RANGE citation and every `<file>.cs:<symbol>` is a SYMBOL
 *      citation. A `<file>.cs:<line>` is counted and printed but is NOT in this population: `engineReadingAt` in
 *      `gates/stardew/check-stardew-invented-gates.mjs` reads a cited line to recover a NUMBER (the radius a native call
 *      is given) and a symbol cannot carry a number. That limit is printed on every run rather than left to be found.
 *
 * THREE CLASSES OF CITED FILE, and the third is the only one this gate converts:
 *   own     a `.cs` this repository publishes (`integrations/stardew/**`, `desktop/**`, any tracked `.cs`). A line range
 *           here is a claim about code WE edit, in the file that grows under our hands, so it must name a symbol. Every
 *           range recorded in the baseline is debt this gate counts and refuses to let grow; a range that is not
 *           recorded is a finding the moment it lands.
 *   engine  a `.cs` the decompiled mount holds (`ref/external/StardewValleyDecompiled`, the same constant
 *           `gates/stardew/check-stardew-invented-gates.mjs` exports). A NAMED EXCEPTION, and the reason is in the tree
 *           rather than "we did not get to them": the engine is pinned to a game version, and `engineReadingAt` there
 *           must read the cited line to recover the number the Mod's constant is compared against - a symbol cannot
 *           carry a number. The exception is printed with its count, its file and that call on every run.
 *   unheld  a file neither index holds: the citation names a file this tree cannot read, so no symbol could be checked
 *           there either. Recorded in the same baseline (it is not this gate's to convert) and printed by name.
 *
 * THE BASELINE IS A RATCHET, AND IT IS DERIVED. A row is `{ path, cited }`: the file the claim is written in and the
 * citation text, with no line number anywhere, so a claim that moves down its file is the same row and a claim whose
 * citation CHANGED is a row that matches nothing. Three readings follow, and they are the whole design:
 *   `citation_is_a_line_range:<site> (<cited>, cited file is <class>)`  a range nothing records - red, immediately.
 *   `citation_debt_row_stale:<path> (<cited>)`                         a recorded range nobody converted and whose text no
 *                                                                       longer matches - red, naming the row to delete.
 *   `citation_names_a_symbol_the_file_does_not_declare:<site>`          a symbol citation whose declaration is not there.
 * `line-range citations: N (debt) · symbol citations: M` is the verdict line: N may fall slowly and can never grow, M
 * only means what the second finding below leaves of it.
 *
 * WHAT A GREEN RUN DOES NOT SAY, the limit of a gate over another language. Finding the declaration proves the citation
 * points at code that exists. It does NOT prove that code still does what the sentence around the citation claims - for
 * `publishedAsWork`, that the predicate still publishes only rows that need the work. That second question is a reading
 * of the C# body, owed by whoever changes it, and nothing here pretends to answer it.
 *
 * Refusals, printed with their code and exit 2 rather than passed: the decompiled mount is absent
 * (`stardew_decompile_root_missing`, which `tools/prelive.mjs` reads as UNAVAILABLE) because without it an engine
 * citation cannot be told from a file this tree does not hold; `git ls-files` cannot be read
 * (`citation_population_not_measured`); the population is empty (`citation_population_empty`).
 *
 * USAGE:
 *   node gates/stardew/check-stardew-source-citations.mjs            # the reading
 *   node gates/stardew/check-stardew-source-citations.mjs --json     # the report line alone
 *   node gates/stardew/check-stardew-source-citations.mjs --update   # rewrite the debt baseline from this run
 *
 * source-invariant: a claim about this repository's C# code is checkable only against a symbol, so a line range in the
 * tree's own text is a claim whose subject nobody re-reads - the invariant is that the debt count never grows and each
 * recorded row still matches the exact citation text it was recorded under.
 * source-expiry: when the last own-source line-range citation is converted, so the debt class is empty and the baseline
 * file is deleted - or 2027-03-01, whichever comes first, so this reading is re-taken rather than trusted.
 */

export const gateDeclaration = {
  id: "check-stardew-source-citations",
  domain: "stardew",
  tier: "l2",
  kind: "ratchet",
};

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DECOMPILED_ROOT, indexEngineSources } from "./check-stardew-invented-gates.mjs";
import {
  RANGE_CITATION,
  SINGLE_LINE_CITATION,
  SYMBOL_CITATION,
  namesFile,
  resolveCitation,
  sourceNames,
} from "../../tools/lib/source-citation.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const ROOT = repositoryRoot(import.meta.url);

/** Where the un-converted citations are recorded. Written by `--update` from a real scan, never by hand. */
export const BASELINE_PATH = "tools/line-range-citation-baseline.json";
export const BASELINE_SCHEMA = "gamebuddy-line-range-citation-baseline/v1";

/** The files this gate reads: the shapes a claim about C# source is written in. */
const TEXT_FILE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|cs|md|json|ps1|ya?ml|sql|txt)$/u;

/** A file too large to be a sentence about code: counted as skipped rather than read. */
const SIZE_CAP = 4_000_000;

/** The one file whose text is not scanned: its rows are the citations it records. */
const SELF_REFERENTIAL = `/${BASELINE_PATH}`;

/**
 * Every text file git publishes, as `{ path, text }`, or `null` when git cannot answer.
 *
 * `git ls-files` rather than a walk of the working directory: this checkout carries hundreds of `.tmp-*.log` files that
 * quote citations from runs, and a walk would make a lane's scratch output part of the gate's population.
 */
export function trackedTextFiles({ root = ROOT, git = spawnSync } = {}) {
  const listed = git("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, windowsHide: true });
  if (listed.status !== 0 || typeof listed.stdout !== "string") return null;
  const sources = [];
  const skipped = [];
  for (const path of listed.stdout.split("\0")) {
    if (path === "" || !TEXT_FILE.test(path)) continue;
    if (`/${path}` === SELF_REFERENTIAL) continue;
    const absolute = join(root, path.replace(/\\/gu, "/"));
    let text;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (text.length > SIZE_CAP) {
      skipped.push(path);
      continue;
    }
    sources.push({ path, text });
  }
  return { sources, skipped };
}

/** Which of the three classes a cited file falls in: this repository's own source, the engine, or neither. */
export function citationClass(citedFile, { ownNames, engineNames }) {
  if (namesFile(ownNames, citedFile)) return "own";
  if (namesFile(engineNames, citedFile)) return "engine";
  return "unheld";
}

/** The row in `pending` that records this citation, removed so it cannot record a second site; `null` when none does. */
function takeRow(pending, path, cited) {
  const index = pending.findIndex((row) => row.path === path && row.cited === cited);
  return index < 0 ? null : pending.splice(index, 1)[0];
}

/** Every site in these sources, as data - the scan the findings and the baseline are both derived from. */
export function scanSources({ sources, ownNames, engineNames }) {
  const sites = [];
  const counts = { own: 0, engine: 0, unheld: 0, symbols: 0, singleLine: 0 };
  for (const { path, text } of sources) {
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      const site = `${path}:${String(index + 1)}`;
      for (const match of line.matchAll(RANGE_CITATION)) {
        const cited = `${match[1]}.cs:${match[2]}-${match[3]}`;
        const citedFile = `${match[1]}.cs`;
        const authority = citationClass(citedFile, { ownNames, engineNames });
        counts[authority] += 1;
        sites.push({ kind: "range", site, path, cited, citedFile, authority, claim: line.trim() });
      }
      for (const match of line.matchAll(SYMBOL_CITATION)) {
        const citedFile = `${match[1]}.cs`;
        counts.symbols += 1;
        sites.push({
          kind: "symbol",
          site,
          path,
          cited: `${citedFile}:${match[2]}`,
          citedFile,
          symbol: match[2],
          authority: citationClass(citedFile, { ownNames, engineNames }),
          claim: line.trim(),
        });
      }
      for (const match of line.matchAll(SINGLE_LINE_CITATION)) {
        counts.singleLine += 1;
        sites.push({ kind: "line", site, path, cited: `${match[1]}.cs:${match[2]}` });
      }
    }
  }
  return { sites, counts };
}

/**
 * The reading: every range this run found, held against the baseline, plus every symbol citation held against the
 * declaration it names.
 *
 * `readSource(citedFile)` is how a symbol citation's file is read for its declarations. It is a parameter rather than a
 * file read in here, so the falsifier can hand this function a source set and a file table this repository does not have.
 */
export function citationReading({ sources, ownNames, engineNames, readSource, baseline = [] }) {
  const { sites, counts } = scanSources({ sources, ownNames, engineNames });
  const findings = [];
  const recorded = [];
  const pending = [...baseline];
  const tiers = { declaration: 0, mention: 0 };
  let debt = 0;
  let symbolDebt = 0;
  for (const site of sites) {
    // A citation of a file this tree does not hold is unverifiable in either spelling - there is nothing to read, so
    // neither a line nor a name can be resolved against it. That is a row in the baseline, not a claim of correctness.
    if (site.authority === "unheld") {
      if (takeRow(pending, site.path, site.cited) === null)
        findings.push({
          code:
            site.kind === "range" ? "citation_is_a_line_range" : "citation_names_a_file_the_tree_does_not_hold",
          site: site.site,
          detail: `\`${site.cited}\` names a file neither this repository nor ${DECOMPILED_ROOT} holds, so nothing about it can be checked`,
        });
      else if (site.kind === "range") debt += 1;
      else symbolDebt += 1;
      recorded.push({ path: site.path, cited: site.cited });
      continue;
    }
    if (site.kind === "range") {
      // Positional by construction: `engineReadingAt` reads the cited line for the number. A NAMED exception, printed.
      if (site.authority === "engine") continue;
      if (takeRow(pending, site.path, site.cited) === null)
        findings.push({
          code: "citation_is_a_line_range",
          site: site.site,
          detail:
            `\`${site.cited}\` is a line range over this repository's own source; a range stops containing its subject ` +
            "without anyone editing the sentence that cites it, so name the symbol",
        });
      else debt += 1;
      recorded.push({ path: site.path, cited: site.cited });
      continue;
    }
    if (site.kind === "line") continue;
    const text = readSource(site.citedFile);
    const resolved = text === null ? null : resolveCitation(text, site.symbol);
    if (resolved === null)
      findings.push({
        code: "citation_names_a_symbol_the_file_does_not_carry",
        site: site.site,
        detail:
          `${site.citedFile} neither declares nor mentions \`${site.symbol}\`, so the claim this citation anchors at ` +
          `\`${site.claim.slice(0, 120)}\` names nothing`,
      });
    else tiers[resolved.tier] += 1;
  }
  for (const row of pending)
    findings.push({
      code: "citation_debt_row_stale",
      site: row.path,
      detail: `the baseline records \`${row.cited}\` at ${row.path} and this run found no such citation there - convert it and delete the row with --update, or restore the text it was recorded under`,
    });
  return {
    findings,
    counts: { ...counts, debt, symbolDebt, declared: tiers.declaration, mentioned: tiers.mention },
    recorded: recorded.sort((left, right) => (left.path + left.cited).localeCompare(right.path + right.cited)),
    examined: sources.length,
  };
}

/**
 * The debt baseline, or `null` when the file is absent or is not the shape this gate writes.
 *
 * `null` is not "no debt": a baseline that cannot be read is a refusal, because a run that treated it as empty would
 * report every recorded citation as a new one and make the ratchet unusable rather than clear.
 */
export function readBaseline({ root = ROOT, path = BASELINE_PATH } = {}) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return [];
  try {
    const parsed = JSON.parse(readFileSync(absolute, "utf8"));
    if (parsed?.schema !== BASELINE_SCHEMA || !Array.isArray(parsed.rows)) return null;
    return parsed.rows.filter((row) => typeof row?.path === "string" && typeof row?.cited === "string");
  } catch {
    return null;
  }
}

/** The document `--update` writes: sorted, so a re-run rewrites only what changed. */
export function baselineDocument(rows) {
  return {
    schema: BASELINE_SCHEMA,
    note:
      "Line-range citations of source code, recorded from a real scan by `node " +
      "gates/stardew/check-stardew-source-citations.mjs --update` and never by hand. Each row is `{ path, cited }`: the " +
      "file the claim is written in and the citation text, with no line number. A row whose citation is converted stops " +
      "matching and reds the gate until it is deleted; a range that is not recorded here is red the moment it lands. " +
      "Converting a citation changes the tree, then `--update` records what is left.",
    rows,
  };
}

/** The report line the suite and the tooling read: the counts, the findings, and one check per rule. */
export function buildReport({ reading, blocked = null }) {
  const codes = [
    "citation_is_a_line_range",
    "citation_names_a_file_the_tree_does_not_hold",
    "citation_debt_row_stale",
    "citation_names_a_symbol_the_file_does_not_carry",
  ];
  const checks = codes.map((code) => ({
    id: code,
    status: blocked === null ? (reading.findings.some((f) => f.code === code) ? "failed" : "passed") : "not_measured",
    detail: `${String(reading.findings.filter((f) => f.code === code).length)} finding(s)`,
  }));
  return {
    gate: "stardew-source-citations/v1",
    status: blocked !== null ? "blocked" : reading.findings.length === 0 ? "passed" : "failed",
    reason: blocked,
    files: reading.examined,
    lineRanges: { debt: reading.counts.debt, engine: reading.counts.engine, unheld: reading.counts.unheld },
    symbols: reading.counts.symbols,
    singleLines: reading.counts.singleLine,
    findings: reading.findings.map((finding) => `${finding.code}:${finding.site} (${finding.detail})`),
    checks,
  };
}

/** The reading over the real tree, or the reason it could not be taken. One function, so the CLI and its suite agree. */
export function auditCitations({ root = ROOT, git = spawnSync, engine = indexEngineSources({ root }) } = {}) {
  const listed = trackedTextFiles({ root, git });
  if (listed === null) return { blocked: "citation_population_not_measured", reading: { examined: 0, counts: empty(), findings: [], recorded: [] } };
  if (engine === null) return { blocked: "stardew_decompile_root_missing", reading: { examined: 0, counts: empty(), findings: [], recorded: [] } };
  const baseline = readBaseline({ root });
  if (baseline === null) return { blocked: "citation_baseline_not_measured", reading: { examined: 0, counts: empty(), findings: [], recorded: [] } };
  const ownPaths = listed.sources.map((source) => source.path).filter((path) => path.endsWith(".cs"));
  const engineNames = sourceNames([...engine.keys()]);
  const ownNames = sourceNames(ownPaths);
  const ownByPath = new Map(ownPaths.map((path) => [path.toLowerCase().split("/").pop(), resolve(root, path)]));
  const readSource = (citedFile) => {
    const name = citedFile.toLowerCase();
    for (const [key, absolute] of ownByPath) if (name === key || key.endsWith(`.${name}`)) return readFileSync(absolute, "utf8");
    for (const [key, absolute] of engine) if (name === key.toLowerCase() || key.toLowerCase().endsWith(`.${name}`)) return readFileSync(absolute, "utf8");
    return null;
  };
  const reading = citationReading({ sources: listed.sources, ownNames, engineNames, readSource, baseline });
  if (reading.examined === 0) return { blocked: "citation_population_empty", reading };
  return { blocked: null, reading, baseline };
}

const empty = () => ({
  own: 0,
  engine: 0,
  unheld: 0,
  symbols: 0,
  singleLine: 0,
  debt: 0,
  symbolDebt: 0,
  declared: 0,
  mentioned: 0,
});

/** The verdict lines a reader sees, so a suite can assert them without spawning a subprocess. */
export function renderReading({ reading, blocked = null }) {
  const lines = [
    `line-range citations: ${String(reading.counts.debt)} (debt) · symbol citations: ${String(reading.counts.symbols)}`,
    `  decompiled engine: ${String(reading.counts.engine)} line ranges are POSITIONAL BY CONSTRUCTION - ${DECOMPILED_ROOT} is pinned to a game version and ` +
      "`engineReadingAt` (gates/stardew/check-stardew-invented-gates.mjs) reads the cited line for the number a constant is compared against",
    `  cited files this tree does not hold: ${String(reading.counts.unheld)} line range(s) and ${String(reading.counts.symbolDebt)} symbol citation(s), recorded as debt - nothing about them can be checked`,
    `  symbol citations resolved: ${String(reading.counts.declared)} by declaration · ${String(reading.counts.mentioned)} by a mention only (a fixture literal, not a member)`,
    `  single-line citations: ${String(reading.counts.singleLine)} - counted, not this population (a value read keeps its line)`,
    `  files examined: ${String(reading.examined)}`,
  ];
  if (blocked !== null) lines.push(`${blocked}: this run measured nothing`);
  for (const finding of reading.findings) lines.push(`${finding.code}:${finding.site} - ${finding.detail}`);
  return lines;
}

function reportLine(report) {
  return JSON.stringify(report);
}

function main(argv) {
  const result = auditCitations();
  const report = buildReport(result);
  if (argv.includes("--update")) {
    if (result.blocked !== null) {
      process.stdout.write(`citation_baseline_not_written: ${result.blocked}\n`);
      return 2;
    }
    writeFileSync(resolve(ROOT, BASELINE_PATH), `${JSON.stringify(baselineDocument(result.reading.recorded), null, 2)}\n`);
    process.stdout.write(
      `citation_baseline: recorded ${String(result.reading.recorded.length)} line-range citation(s) in ${BASELINE_PATH}\n`,
    );
    const leftovers = result.reading.findings.filter((finding) => finding.code !== "citation_debt_row_stale");
    for (const finding of leftovers) process.stdout.write(`${finding.code}:${finding.site} - ${finding.detail}\n`);
    return leftovers.length === 0 ? 0 : 1;
  }
  if (argv.includes("--json")) {
    process.stdout.write(`${reportLine(report)}\n`);
    return result.blocked !== null ? 2 : report.status === "passed" ? 0 : 1;
  }
  for (const line of renderReading(result)) process.stdout.write(`${line}\n`);
  process.stdout.write(`${reportLine(report)}\n`);
  return result.blocked !== null ? 2 : report.status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  process.exitCode = main(process.argv.slice(2));
