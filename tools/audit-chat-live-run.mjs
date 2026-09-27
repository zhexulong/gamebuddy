#!/usr/bin/env node
/**
 * Audit one Chat live run (`chat_run_audit/v1`) and print the `auditing-runs`
 * Phase 7 synthesis report.
 *
 * Usage:
 *   node tools/audit-chat-live-run.mjs --audit <path> [--report <path>] [--json]
 *
 * Exit codes:
 *   0 no integrity failure
 *   1 an integrity failure was found
 *   2 usage or validation error (nothing was analysed)
 *
 * A run's product is a system health report, not pass/blocked: exit 0 says "no
 * integrity failure in this trace", not "Chat is release-ready". Only comparing
 * two runs shows whether a change helped (tools/compare-chat-live-runs.mjs).
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChatRunAuditReport, formatChatRunAuditReportText, validateChatRunAudit } from "./lib/chat-run-audit.mjs";

export function parseAuditCliArgs(argv) {
  const parsed = { auditPath: undefined, reportPath: undefined, format: "text", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg.startsWith("--audit=")) {
      parsed.auditPath = arg.slice("--audit=".length);
    } else if ((arg === "--audit" || arg === "-a") && index + 1 < argv.length) {
      parsed.auditPath = argv[++index];
    } else if (arg.startsWith("--report=")) {
      parsed.reportPath = arg.slice("--report=".length);
    } else if ((arg === "--report" || arg === "-r") && index + 1 < argv.length) {
      parsed.reportPath = argv[++index];
    } else if (arg === "--json") {
      parsed.format = "json";
    } else if (arg.startsWith("--format=")) {
      parsed.format = arg.slice("--format=".length);
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  if (parsed.format !== "text" && parsed.format !== "json") {
    throw new Error(`unknown_format:${parsed.format}`);
  }
  return parsed;
}

function printUsage() {
  console.log(`
Usage: node tools/audit-chat-live-run.mjs --audit <path> [options]

Options:
  --audit, -a <path>   Path to a chat_run_audit/v1 JSON trace (required)
  --report, -r <path>  Output JSON report destination file (optional)
  --json               Print the JSON report instead of the text synthesis
  --format <json|text> Output format (default: text)
  --help, -h           Show this help message

Exit codes: 0 no integrity failure, 1 integrity failed, 2 usage/validation error.
`);
}

/**
 * Load and validate a trace, then build its report. Returns a discriminated
 * result so the CLI owns every exit code and a validation failure can never be
 * reported as a clean run.
 *
 * @param {string} auditPath
 * @param {string|null} artifactLabel
 */
export async function auditChatLiveRunFile(auditPath, artifactLabel = null) {
  let raw;
  try {
    raw = await readFile(resolve(auditPath), "utf8");
  } catch (error) {
    return { ok: false, reason: "audit_load_error", detail: error instanceof Error ? error.message : String(error) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: "audit_parse_error", detail: error instanceof Error ? error.message : String(error) };
  }
  const validation = validateChatRunAudit(parsed);
  if (!validation.valid) {
    return {
      ok: false,
      reason: "audit_validation_failed",
      detail: "trace rejected by chat_run_audit/v1 validation",
      errors: validation.errors,
    };
  }
  return { ok: true, report: buildChatRunAuditReport({ audit: parsed, artifact: artifactLabel ?? auditPath }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let cliArgs;
  try {
    cliArgs = parseAuditCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    process.exit(2);
  }
  if (cliArgs.help) {
    printUsage();
    process.exit(0);
  }
  if (!cliArgs.auditPath) {
    console.error("Error: --audit <path> is required.");
    printUsage();
    process.exit(2);
  }

  const outcome = await auditChatLiveRunFile(cliArgs.auditPath);
  if (!outcome.ok) {
    console.error(`BLOCKED: ${outcome.reason}: ${outcome.detail}`);
    for (const error of outcome.errors ?? []) {
      console.error(`  - ${error.path}: ${error.reason} (${error.detail})`);
    }
    process.exit(2);
  }

  if (cliArgs.reportPath) {
    await writeFile(resolve(cliArgs.reportPath), JSON.stringify(outcome.report, null, 2), "utf8");
  }
  if (cliArgs.format === "json") {
    console.log(JSON.stringify(outcome.report, null, 2));
  } else {
    console.log(formatChatRunAuditReportText(outcome.report));
  }
  process.exit(outcome.report.integrity.passed ? 0 : 1);
}
