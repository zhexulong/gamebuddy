#!/usr/bin/env node
/**
 * Ratchet gate over `.dependency-cruiser.tools.cjs`: no new `tools/` boundary errors or
 * `generic -> game` coupling warnings, and no stale baseline exemptions.
 *
 * `pnpm check:tools-boundaries` runs `depcruise` directly, which exits 0 on `warn` and was
 * wired into neither `prelive` nor `ci.yml`. This gate parses `depcruise`'s JSON output,
 * enforces both `error` and `warn` edges against an expiring baseline, and blocks at zero
 * examined modules.
 *
 * red-proof: test  injecting a new `generic-tools-must-not-depend-on-game-tools` warning or
 *   `tools-must-not-import-disposable-host-test-artifacts` error into the parsed report ->
 *   exit 1 naming `new_boundary_violation:<rule>:<severity>:<from> -> <to>`; removing a
 *   baseline violation -> exit 1 naming `stale_baseline_entry` (gates/arch/check-tools-boundaries.test.mjs)
 */

export const gateDeclaration = {
  id: "check-tools-boundaries",
  domain: "arch",
  tier: "l0",
  kind: "ratchet",
};

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const ROOT = repositoryRoot(import.meta.url);
export const BASELINE_PATH = "tools/baselines/tools-boundaries-baseline.json";
const DEPCRUISE_BIN = "node_modules/dependency-cruiser/bin/dependency-cruise.mjs";
const DEPCRUISE_CONFIG = ".dependency-cruiser.tools.cjs";
const TARGET_DIR = "tools";

function normalizeSlashes(value) {
  return String(value ?? "").replace(/\\/gu, "/");
}

export function violationKey(entry) {
  const rule = entry?.rule?.name ?? entry?.rule ?? "";
  const from = normalizeSlashes(entry?.from);
  const to = normalizeSlashes(entry?.to);
  return `${rule}|${from}|${to}`;
}

export function toBaselineEntry(violation) {
  return {
    rule: violation?.rule?.name ?? "unknown",
    severity: violation?.rule?.severity ?? "unknown",
    from: normalizeSlashes(violation?.from),
    to: normalizeSlashes(violation?.to),
  };
}

export function sortBaselineEntries(entries) {
  return [...entries].sort((a, b) => violationKey(a).localeCompare(violationKey(b)));
}

export function evaluateToolsBoundaries(report, baselineEntries) {
  const modulesExamined = Array.isArray(report?.modules) ? report.modules.length : 0;
  if (modulesExamined === 0) {
    return {
      verdict: "blocked",
      reason: "zero_modules_examined",
      modulesExamined: 0,
      violations: [],
      newViolations: [],
      staleBaseline: [],
    };
  }

  const rawViolations = Array.isArray(report?.summary?.violations) ? report.summary.violations : null;
  if (rawViolations === null) {
    return {
      verdict: "blocked",
      reason: "missing_summary_violations",
      modulesExamined,
      violations: [],
      newViolations: [],
      staleBaseline: [],
    };
  }

  const currentMap = new Map();
  for (const v of rawViolations) {
    const entry = toBaselineEntry(v);
    currentMap.set(violationKey(entry), entry);
  }

  const baselineMap = new Map();
  for (const b of baselineEntries ?? []) {
    const entry = {
      rule: b.rule,
      severity: b.severity,
      from: normalizeSlashes(b.from),
      to: normalizeSlashes(b.to),
    };
    baselineMap.set(violationKey(entry), entry);
  }

  const newViolations = [];
  for (const [key, entry] of currentMap) {
    if (!baselineMap.has(key)) {
      newViolations.push(entry);
    }
  }

  const staleBaseline = [];
  for (const [key, entry] of baselineMap) {
    if (!currentMap.has(key)) {
      staleBaseline.push(entry);
    }
  }

  const verdict = newViolations.length === 0 && staleBaseline.length === 0 ? "passed" : "failed";
  return {
    verdict,
    reason: verdict === "passed" ? "within_ratchet_baseline" : "ratchet_mismatch",
    modulesExamined,
    violations: sortBaselineEntries([...currentMap.values()]),
    newViolations: sortBaselineEntries(newViolations),
    staleBaseline: sortBaselineEntries(staleBaseline),
  };
}

export function runDepcruiseJson(root = ROOT) {
  const binPath = resolve(root, DEPCRUISE_BIN);
  if (!existsSync(binPath)) {
    return { ok: false, reason: `missing_depcruise_binary:${DEPCRUISE_BIN}`, report: null };
  }
  const result = spawnSync(
    process.execPath,
    [binPath, "--config", DEPCRUISE_CONFIG, "--output-type", "json", TARGET_DIR],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) {
    return { ok: false, reason: `depcruise_spawn_error:${result.error.message}`, report: null };
  }
  const stdout = String(result.stdout ?? "").trim();
  if (!stdout) {
    return { ok: false, reason: `depcruise_empty_output:exit_${result.status ?? "null"}`, report: null };
  }
  try {
    return { ok: true, reason: null, report: JSON.parse(stdout) };
  } catch (err) {
    return { ok: false, reason: `depcruise_invalid_json:${err.message}`, report: null };
  }
}

export function loadBaseline(root = ROOT) {
  const fullPath = resolve(root, BASELINE_PATH);
  if (!existsSync(fullPath)) {
    return { ok: false, entries: [] };
  }
  const parsed = JSON.parse(readFileSync(fullPath, "utf8"));
  return { ok: true, entries: Array.isArray(parsed?.entries) ? parsed.entries : [] };
}

function main(argv = process.argv.slice(2)) {
  const updateBaseline = argv.includes("--update-baseline");
  const jsonMode = argv.includes("--json");

  const probe = runDepcruiseJson(ROOT);
  if (!probe.ok) {
    if (jsonMode) {
      console.log(JSON.stringify({ verdict: "blocked", reason: probe.reason }));
    } else {
      console.error(`BLOCKED ${probe.reason}`);
    }
    return 2;
  }

  if (updateBaseline) {
    const evalAll = evaluateToolsBoundaries(probe.report, []);
    if (evalAll.verdict === "blocked") {
      console.error(`BLOCKED ${evalAll.reason}`);
      return 2;
    }
    const payload = {
      schema: "tools-boundaries-baseline/v1",
      entries: evalAll.violations,
    };
    writeFileSync(resolve(ROOT, BASELINE_PATH), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(
      `updated ${BASELINE_PATH}: examined ${evalAll.modulesExamined} module(s) · recorded ${evalAll.violations.length} baseline entry(ies)`,
    );
    return 0;
  }

  const baseline = loadBaseline(ROOT);
  if (!baseline.ok) {
    console.error(`BLOCKED missing_baseline:${BASELINE_PATH}`);
    return 2;
  }

  const outcome = evaluateToolsBoundaries(probe.report, baseline.entries);
  if (jsonMode) {
    console.log(JSON.stringify(outcome, null, 2));
  } else {
    console.log(
      `examined ${outcome.modulesExamined} module(s) · violations ${outcome.violations.length} (baseline ${baseline.entries.length} · new ${outcome.newViolations.length} · stale ${outcome.staleBaseline.length})`,
    );
    for (const v of outcome.newViolations) {
      console.error(`new_boundary_violation:${v.rule}:${v.severity}:${v.from} -> ${v.to}`);
    }
    for (const s of outcome.staleBaseline) {
      console.error(`stale_baseline_entry:${s.rule}:${s.from} -> ${s.to}`);
    }
  }

  if (outcome.verdict === "blocked") {
    return 2;
  }
  return outcome.verdict === "passed" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
