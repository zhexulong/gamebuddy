#!/usr/bin/env node
/**
 * Guard: a live-run gate must not PASS because there was nothing to look at.
 *
 * WHY (measured 2026-10-06, commit a58a4386)
 *
 * The game ladder reported "assembly passed" for a companion with NO persona,
 * because its judgement was `expectation === null ? true : <check>`: a disposable
 * runtime root has no expectation BY CONSTRUCTION, so the gate passed without
 * observing anything. Three sibling copies existed (content, context, world book)
 * plus a voice clause that passed when voice was configured but never started.
 *
 * The fix is a verdict vocabulary (tools/live-run/core/evidence-verdict.mjs) whose
 * missing-evidence outcome is `unobserved`, never a pass. This guard keeps the old
 * shape from coming back: any `? true` / `?? true` inside a pass-shaped expression
 * must either be rewritten as an evidence verdict or carry an explicit
 * `absence-as-pass: <reason>` marker, so a deliberate exception is always written
 * down and reviewable.
 *
 * Usage: node tools/check-live-run-verdict-guards.mjs [--root <dir>] [--json]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Names whose value is consumed as "this part of the run is OK". */
const PASS_SHAPED = /\b(passed|Passed|assembled|Assembled|verified|contentPassed|contextAssembled|worldBookAssembled)\b/;
/** A branch whose absence path is literally `true`. */
const ABSENCE_PASS = /\?\s*true\b|\?\?\s*true\b/;
/** The deliberate-exception marker, which requires a reason. */
const MARKER = /absence-as-pass:\s*\S/;

function collectModules(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.mjs$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) files.push(path);
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  else files.push(root);
  return files.sort();
}

export function findAbsencePassBranches({ root }) {
  const findings = [];
  for (const file of collectModules(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (!ABSENCE_PASS.test(line)) return;
      // The exception must be declared ON the branch or the two lines above it,
      // and it must carry a reason on that same line: a bare marker is not an
      // exception (a reasonless exemption is the silent pass again).
      const window = [lines[index - 2], lines[index - 1], line].filter((entry) => typeof entry === "string");
      if (window.some((entry) => MARKER.test(entry))) return;
      // A pass-shaped name may sit on this line or on the head of the expression
      // it continues (the ladder spreads one judgement over several lines).
      const head = [lines[index - 3], lines[index - 2], lines[index - 1], line]
        .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
        .slice(-3)
        .join("\n");
      if (!PASS_SHAPED.test(line) && !PASS_SHAPED.test(head)) return;
      findings.push({
        file: relative(repositoryRoot, file).replaceAll("\\", "/"),
        line: index + 1,
        snippet: line.trim().slice(0, 160),
      });
    });
  }
  return findings;
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : join(repositoryRoot, "tools", "live-run");
  const findings = findAbsencePassBranches({ root });
  if (json) {
    process.stdout.write(`${JSON.stringify({ root, findings }, null, 2)}\n`);
  } else if (findings.length === 0) {
    process.stdout.write(`live-run verdict guards: 0 absence-as-pass branches under ${relative(repositoryRoot, root) || root}\n`);
  } else {
    process.stdout.write(`live-run verdict guards: ${findings.length} absence-as-pass branch(es) - a gate must not pass because there was nothing to look at:\n`);
    for (const finding of findings) process.stdout.write(`  ${finding.file}:${finding.line}  ${finding.snippet}\n`);
    process.stdout.write("  fix: judge it with tools/live-run/core/evidence-verdict.mjs, or mark it `absence-as-pass: <reason>` if the absence genuinely is the expected outcome\n");
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
