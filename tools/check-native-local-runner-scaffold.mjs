#!/usr/bin/env node
/**
 * IS THIS SMOKE RUNNER STILL HAND-WRITTEN?
 *
 * WHY. `tools/lib/native-local-runner-scaffold.mjs` holds the lifecycle every `run-stardew-native-local-*.mjs` smoke
 * runner used to spell for itself - the fixture-config refusal, observe-fresh and the capability check, the requestId mint
 * and the execute, the terminal wait, the evidence parse, the stale reread, and the bootstrap with its exit code. Measured
 * 2026-11-14: the 127th runner (`fcc2c1b7`'s `run-stardew-native-local-player-sweep-scythe-smoke.mjs`) was a copy of a
 * sibling with the action's own words swapped, and `tools/check-code-duplication.mjs` recorded it as the fifth clone group
 * GROWING by one site. Five groups, one commit. The tree was not short of a helper library - it was short of a default,
 * and a default is a gate or it is a suggestion.
 *
 * THE QUESTION THIS ASKS is not "does this file define `parseEvidence`". That is a substring check wearing a rule's
 * clothes: an inline arrow, a renamed local, or the same three statements pasted into a `try` all slip past it, and the
 * copy the detector was written for is not the copy that arrives next. The question is whether the runner still OWNS THE
 * PROCESS - reads its own client config, connects its own client, mints its own request, prints its own result. So:
 *
 *   conforming  = imports the template AND supplies a `defineSmokeScenario(...)` definition AND does not read its own
 *                 config or connect its own client.
 *   hand-written = anything else, which owes a baseline entry.
 *
 * The three conditions are one property read from three sides, and each side is a thing the template would otherwise have
 * to trust: an import nobody calls proves nothing, and a call beside a hand-rolled `readNativeClientConfig()` is a runner
 * that still owns its own lifecycle and only borrows the helpers.
 *
 * THE POPULATION is every `run-stardew-native-local-*.mjs` under `tools/`, recursively, in the index - derived by a
 * directory scan, never by a list here, so the runner written tomorrow is judged the moment it exists. `tools/lib/**` is
 * not in it (a template is not a runner), and a file whose name carries `.test.` or `.mutation.` is a falsifier rather
 * than a runner. `tools/lib/indexed-sources.mjs`'s rule applies: a runner the index does not carry is another lane's work
 * in flight, so it is dropped from the population and PUBLISHED by name, never silently judged.
 *
 * THE BASELINE only shrinks. `tools/baselines/native-local-runner-scaffold.json` records the runners that predate the
 * template, each with the reason `predates_the_template`; this tree records 130. Three rules, and the direction of each:
 *
 *   * a hand-written runner NOT in the baseline is a finding - a new runner cannot enter the baseline, there is
 *     deliberately no flag that adds an entry;
 *   * a baseline entry whose runner now conforms, or whose runner is gone, is a finding - a migrated runner must leave,
 *     and `--record-shrinks` deletes exactly those entries and nothing else;
 *   * an entry whose reason is not `predates_the_template` is a finding - a baseline without its reason is a silencer.
 *
 * ZERO POPULATION IS BLOCKED, NEVER GREEN. An empty scan, an unreadable template module, or a git index git refuses to
 * answer all print `not_measured:<why>` and exit 2. "Every runner is on the template" is a claim about a population, and a
 * population of nothing agrees with it.
 *
 * WHAT THIS DOES NOT SEE, said out loud: whether a migrated runner USES the template correctly - a definition that omits
 * `assertPostcondition` throws at import (`native_local_scenario_definition_invalid:<field>`) and the runner's own suite
 * and live gate own that; and whether a baselined runner still works at all. This gate reads one fact per file, which is
 * the fact that was wrong 127 times.
 *
 * VERDICT. `runners examined N · on the template M · hand-written K · baselined B`, then one line per finding.
 * Exit 0 every runner conforms or is baselined, 1 a finding, 2 blocked.
 *
 * red-proof: inject  a runner that reads its own `readNativeClientConfig()` beside the template import ->
 *   `runner_reimplements_the_scaffold:<injected runner>:hand_written_bootstrap:readNativeClientConfig`
 *   (tools/check-native-local-runner-scaffold.test.mjs)
 * red-proof: inject  a new hand-written runner not in the baseline -> `runner_reimplements_the_scaffold:<file>:...`
 *   (tools/check-native-local-runner-scaffold.test.mjs)
 * red-proof: history  the sweep-scythe runner at `fcc2c1b7`, before its migration, replayed into the population ->
 *   `runner_reimplements_the_scaffold:tools/run-stardew-native-local-player-sweep-scythe-smoke.mjs:...`
 *   (tools/check-native-local-runner-scaffold.test.mjs)
 * red-proof: inject  a baseline entry for a runner that now conforms, and one whose runner is gone ->
 *   `stale_baseline:<file>` twice, and `--record-shrinks` deletes both
 *   (tools/check-native-local-runner-scaffold.test.mjs)
 * red-proof: inject  an empty population and an unreadable template -> `not_measured:*` at exit 2
 *   (tools/check-native-local-runner-scaffold.test.mjs)
 *
 * USAGE
 *   node tools/check-native-local-runner-scaffold.mjs
 *   node tools/check-native-local-runner-scaffold.mjs --json
 *   node tools/check-native-local-runner-scaffold.mjs --record-shrinks
 */

export const gateDeclaration = {
  id: "check-native-local-runner-scaffold",
  domain: "stardew",
  tier: "l0",
  kind: "ratchet",
};

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describeUntracked, untrackedSources } from "./lib/indexed-sources.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** The template's one path. A runner imports the lifecycle from it, or it owns the lifecycle. */
export const TEMPLATE_FILE = "tools/lib/native-local-runner-scaffold.mjs";

/** The template's exports a runner cannot do without: the definition and the bootstrap. */
export const TEMPLATE_EXPORTS = Object.freeze(["defineSmokeScenario", "runSmokeScenarioMain"]);

/** The runners this asks about: the native-local smoke family, minus its own falsifiers. */
export const RUNNER_FILE = /^run-stardew-native-local-.*\.mjs$/u;
const SIBLING_FALSIFIER = /\.(?:test\.mjs|mutation\.mjs)$/u;

/** The one reason a baseline entry may carry. Anything else is a silencer with a nicer name. */
export const BASELINE_REASON = "predates_the_template";

export const BASELINE_PATH = "tools/baselines/native-local-runner-scaffold.json";

/** The scan's root, relative to the repository, and the prefix every runner path is published under. */
const SCAN_ROOT = "tools";

const TEMPLATE_IMPORT = /from\s+["'](?:\.\/)?lib\/native-local-runner-scaffold\.mjs["']/u;
const SUPPLIES_DEFINITION = /\bdefineSmokeScenario\s*\(/u;
/** Two calls that mean the runner still owns its own process, whatever helpers it borrows beside them. */
const HANDS_WRITTEN_BOOTSTRAP = Object.freeze([
  ["readNativeClientConfig", /\breadNativeClientConfig\s*\(/u],
  ["connectNativeLocalClient", /\bconnectNativeLocalClient\s*\(/u],
  ["connectWithRetry", /\bconnectWithRetry\s*\(/u],
]);

/** Line and block comments stripped, so a comment that describes the old shape is not a finding. */
export function stripComments(source) {
  return String(source ?? "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => {
      const index = line.indexOf("//");
      return index < 0 ? line : line.slice(0, index);
    })
    .join("\n");
}

/**
 * What one runner file does about the template: imports it, defines against it, and whether it still starts its own
 * process. Every reason is a finding on its own, because they are different mistakes with different fixes.
 */
export function readRunner(source) {
  const code = stripComments(source);
  const owns = HANDS_WRITTEN_BOOTSTRAP.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
  const importsTemplate = TEMPLATE_IMPORT.test(code);
  const suppliesDefinition = SUPPLIES_DEFINITION.test(code);
  const reasons = [];
  if (!importsTemplate) reasons.push("no_template_import");
  else if (!suppliesDefinition) reasons.push("imports_the_template_without_a_definition");
  for (const name of owns) reasons.push(`hand_written_bootstrap:${name}`);
  return { importsTemplate, suppliesDefinition, ownsBootstrap: owns, conforming: reasons.length === 0, reasons };
}

/** Every runner file under `tools/`, recursively, as repo-relative paths with forward slashes. */
export function runnerFiles({ root = ROOT, directory = SCAN_ROOT } = {}) {
  const found = [];
  const walk = (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(absolute, entry.name), child);
        continue;
      }
      if (!RUNNER_FILE.test(entry.name) || SIBLING_FALSIFIER.test(entry.name)) continue;
      found.push(child);
    }
  };
  walk(resolve(root, directory), directory);
  return found.sort();
}

/** The template's own exports, read from its source so a missing one is blocked rather than assumed. */
export function readTemplateExports(source) {
  const missing = TEMPLATE_EXPORTS.filter(
    (name) => !new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`, "u").test(source),
  );
  return { missing, ok: missing.length === 0 };
}

/** A reading that could not be made. Blocked, exit 2, with the reason - never an empty population that agrees with itself. */
export function blocked(reason) {
  return Object.freeze({
    schema: "gamebuddy-native-local-runner-scaffold/v1",
    blocked: reason,
    examined: 0,
    conforming: 0,
    handWritten: 0,
    baselined: 0,
    untracked: Object.freeze([]),
    rows: Object.freeze([]),
    findings: Object.freeze([]),
    stale: Object.freeze([]),
    ok: false,
  });
}

/**
 * The verdict: every runner in the population, and what its baseline entry does or does not excuse.
 *
 * `runners` is `[{ file, source }]` and `baseline` is `[{ file, reason }]`. Both are handed in so a falsifier drives the
 * real rule over a synthetic tree instead of editing this repository.
 */
export function checkRunnerScaffold({ runners, baseline, templateSource }) {
  const template = readTemplateExports(templateSource);
  if (!template.ok) return blocked(`template_export_missing:${template.missing.join(",")}`);
  if (runners.length === 0) return blocked("runner_population_empty");

  const recorded = new Map();
  const findings = [];
  for (const entry of baseline) {
    if (recorded.has(entry.file)) {
      findings.push(`baseline_entry_duplicated:${entry.file}: two entries name one runner, delete one`);
      continue;
    }
    recorded.set(entry.file, entry);
    if (entry.reason !== BASELINE_REASON)
      findings.push(
        `baseline_entry_without_a_reason:${entry.file}: reason "${entry.reason ?? ""}" is not ${BASELINE_REASON}`,
      );
  }

  const rows = [];
  const stale = [];
  const live = new Set();
  for (const runner of runners) {
    live.add(runner.file);
    const reading = readRunner(runner.source);
    const entry = recorded.get(runner.file);
    rows.push({ file: runner.file, ...reading, baselined: entry !== undefined });
    if (!reading.conforming) {
      if (entry === undefined)
        findings.push(`runner_reimplements_the_scaffold:${runner.file}:${reading.reasons.join("+")}`);
      continue;
    }
    if (entry !== undefined)
      stale.push(
        `stale_baseline:${runner.file}: the baseline records it as ${entry.reason}, and it imports the template and ` +
          "defines a scenario now - delete the entry",
      );
  }
  for (const file of [...recorded.keys()].sort()) {
    if (live.has(file)) continue;
    stale.push(`stale_baseline:${file}: no runner of that name is in the tree - delete the entry`);
  }

  return Object.freeze({
    schema: "gamebuddy-native-local-runner-scaffold/v1",
    blocked: null,
    examined: rows.length,
    conforming: rows.filter((row) => row.conforming).length,
    handWritten: rows.filter((row) => !row.conforming).length,
    baselined: rows.filter((row) => row.baselined).length,
    untracked: Object.freeze([]),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    findings: Object.freeze([...findings, ...stale]),
    stale: Object.freeze(stale),
    ok: findings.length === 0 && stale.length === 0,
  });
}

export function renderScaffoldReport(report) {
  if (report.blocked !== null) return [`not_measured:${report.blocked}`];
  const lines = [
    `runners examined ${report.examined} · on the template ${report.conforming} · ` +
      `hand-written ${report.handWritten} · baselined ${report.baselined}` +
      (report.untracked.length > 0 ? ` · untracked not counted ${describeUntracked(report.untracked)}` : ""),
  ];
  for (const finding of report.findings) lines.push(finding);
  lines.push(
    report.ok
      ? `  green: every runner either imports the template or is a recorded ${BASELINE_REASON} entry`
      : `  ${report.findings.length} finding(s)`,
  );
  return lines;
}

/** The baseline file, as the entries this gate compares against. */
export function readBaseline({ root = ROOT } = {}) {
  const parsed = JSON.parse(readFileSync(resolve(root, BASELINE_PATH), "utf8"));
  if (!Array.isArray(parsed.entries)) throw new Error("baseline has no `entries` array");
  return parsed.entries;
}

/** The whole run over the real tree: the index decides the population, the scan decides what exists. */
export function runScaffoldGate({ root = ROOT, withIndex = true } = {}) {
  let templateSource;
  try {
    templateSource = readFileSync(resolve(root, TEMPLATE_FILE), "utf8");
  } catch (error) {
    return { report: blocked(`template_unreadable:${error?.code ?? error}`), untracked: [] };
  }
  const onDisk = runnerFiles({ root });
  let untracked = [];
  if (withIndex) {
    try {
      const outside = untrackedSources({ roots: [SCAN_ROOT], root });
      untracked = onDisk.filter((file) => outside.has(file));
    } catch (error) {
      return { report: blocked(`runner_index_unreadable:${String(error?.message ?? error)}`), untracked: [] };
    }
  }
  const indexed = onDisk.filter((file) => !untracked.includes(file));
  const runners = indexed.map((file) => ({ file, source: readFileSync(resolve(root, file), "utf8") }));
  const baseline = readBaseline({ root });
  const report = checkRunnerScaffold({ runners, baseline, templateSource });
  return { report: Object.freeze({ ...report, untracked: Object.freeze(untracked) }), untracked };
}

/** Delete exactly the entries the report calls stale, and nothing else. The baseline has no other writer. */
export function recordShrinks({ root = ROOT, stale, entries = readBaseline({ root }) }) {
  const doomed = new Set(stale.map((line) => /^stale_baseline:([^:]+):/u.exec(line)?.[1]).filter(Boolean));
  const kept = entries.filter((entry) => !doomed.has(entry.file));
  const removed = entries.filter((entry) => doomed.has(entry.file)).map((entry) => entry.file);
  return { path: resolve(root, BASELINE_PATH), kept, removed };
}

async function main() {
  if (process.argv.includes("--record-shrinks")) {
    const { report } = runScaffoldGate();
    if (report.blocked !== null) {
      process.stdout.write(`not_measured:${report.blocked}\n`);
      process.exitCode = 2;
      return;
    }
    const { path, kept, removed } = recordShrinks({ stale: report.stale });
    if (removed.length === 0) {
      process.stdout.write("record_shrinks: the baseline already describes the tree, nothing to delete\n");
      return;
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, `${JSON.stringify({ entries: kept }, null, 2)}\n`, "utf8");
    process.stdout.write(`record_shrinks: deleted ${removed.length} entr(y|ies)\n`);
    for (const file of removed) process.stdout.write(`  ${file}\n`);
    return;
  }

  const { report } = runScaffoldGate();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.blocked !== null ? 2 : Number(!report.ok);
    return;
  }
  for (const line of renderScaffoldReport(report)) process.stdout.write(`${line}\n`);
  process.exitCode = report.blocked !== null ? 2 : Number(!report.ok);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
