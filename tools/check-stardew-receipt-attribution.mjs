#!/usr/bin/env node
/**
 * Gate: attribution labels in a Stardew receipt must be backed by this run's
 * observation. A label is not a measurement merely because a local model can
 * compute it: the evidence must carry the measurement that made the label true.
 * Unknown attribution remains `undecided`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const SOURCE_ROOT = resolve(REPOSITORY_ROOT, "integrations/stardew");
const SOURCE_EXTENSIONS = new Set([".cs"]);
const EXCLUDED_PARTS = new Set(["bin", "obj", "tests"]);
const ATTRIBUTION_KEYS = Object.freeze(["path_search", "route_exists", "budget", "arrival", "derived", "stalled_by"]);

function parseEvidence(evidence) {
  if (typeof evidence !== "string") return new Map();
  const fields = new Map();
  for (const field of evidence.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0) continue;
    fields.set(field.slice(0, separator), field.slice(separator + 1));
  }
  return fields;
}

function isUndecided(value) {
  return value === "undecided" || value === "unknown";
}

/** Validate one receipt evidence string without inventing a measurement. */
export function validateReceiptAttribution(evidence) {
  const fields = parseEvidence(evidence);
  const violations = [];
  for (const key of ATTRIBUTION_KEYS) {
    const value = fields.get(key);
    if (value === undefined) continue;
    if (key === "arrival") {
      if (!isUndecided(value) && (!fields.has("tile") || !fields.has("target") || fields.get("tile") === "none" || fields.get("target") === "none")) {
        violations.push({ key, issue: "missing_run_measurement", value });
      }
      continue;
    }
    if (key === "stalled_by") {
      if (!isUndecided(value) && (!fields.has("stalled_ticks") || !fields.has("stopped_by"))) {
        violations.push({ key, issue: "missing_run_measurement", value });
      }
      continue;
    }
    if (!isUndecided(value) && !fields.has("measurement")) {
      violations.push({ key, issue: "missing_run_measurement", value });
    }
  }
  return Object.freeze({ ok: violations.length === 0, violations, fields });
}

function shouldScan(path) {
  const lower = path.toLowerCase();
  return [...SOURCE_EXTENSIONS].some((extension) => lower.endsWith(extension))
    && !lower.split(/[\\/]/u).some((part) => EXCLUDED_PARTS.has(part));
}

function collectFiles(root) {
  const files = [];
  const visit = (path) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (shouldScan(path)) files.push(path);
  };
  visit(root);
  return files.sort();
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|\s)\/\/.*$/gmu, "$1");
}

function scanProductionSource(source, path) {
  const clean = stripComments(source);
  const findings = [];
  const line = (needle) => clean.slice(0, clean.indexOf(needle)).split("\n").length;
  if (/path_search\s*=/u.test(clean) && !/measurement\s*=|path_search\s*=\s*undecided/u.test(clean)) {
    findings.push({ path, line: line("path_search"), key: "path_search", issue: "producer_has_no_measurement_field" });
  }
  if (/route_exists\w*\s*=/u.test(clean) && !/measurement\s*=/u.test(clean)) {
    findings.push({ path, line: line("route_exists"), key: "route_exists", issue: "producer_has_no_measurement_field" });
  }
  if (/\bbudget\s*=/u.test(clean) && !/measurement\s*=|budget\s*=\s*undecided/u.test(clean)) {
    findings.push({ path, line: line("budget="), key: "budget", issue: "producer_has_no_measurement_field" });
  }
  if (/\bderived\s*=/u.test(clean) && !/measurement\s*=/u.test(clean)) {
    findings.push({ path, line: line("derived="), key: "derived", issue: "producer_has_no_measurement_field" });
  }
  return findings;
}

export function checkStardewReceiptAttribution({ sourceOverrides = {}, root = SOURCE_ROOT } = {}) {
  const findings = [];
  for (const path of collectFiles(root)) {
    const relativePath = relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");
    // Receipt-producing code is the narrow authority for attribution labels. Logs,
    // fixture setup and persistence codecs may mention the vocabulary without
    // publishing a receipt fact and are deliberately outside this source gate.
    const source = Object.hasOwn(sourceOverrides, relativePath) ? sourceOverrides[relativePath] : readFileSync(path, "utf8");
    if (!/LocalExecutionReceipt|RememberTerminal|ExecutionState\.(Succeeded|Rejected|Uncertain|Cancelled)/u.test(source)) continue;
    findings.push(...scanProductionSource(source, relativePath));
  }
  return Object.freeze({
    gate: "stardew-receipt-attribution/v1",
    findings: Object.freeze(findings),
    ok: findings.length === 0,
  });
}

function main() {
  const report = checkStardewReceiptAttribution();
  for (const finding of report.findings) process.stdout.write(`  ${finding.path}:${finding.line} ${finding.key} ${finding.issue}\n`);
  process.stdout.write(`stardew receipt attribution gate: ${report.findings.length} finding(s)\n`);
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
