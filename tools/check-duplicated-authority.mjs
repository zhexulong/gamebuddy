#!/usr/bin/env node
/**
 * CI gate for the DUPLICATED AUTHORITY class (see lib/duplicated-authority.mjs).
 *
 * Default output is the first finding in `duplicated_authority:<id>:<path>:<line>`
 * form and exit 1; `--json` prints every finding as a JSON array (still exit 1
 * when any exist). A clean repo prints `duplicated_authority: none` and exits 0.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findDuplicatedAuthorities, formatFinding } from "./lib/duplicated-authority.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const findings = findDuplicatedAuthorities(repoRoot);

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
} else if (findings.length === 0) {
  console.log("duplicated_authority: none");
} else {
  console.log(formatFinding(findings[0]));
}

process.exitCode = findings.length === 0 ? 0 : 1;
