#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const ignoredDirs = new Set([".git", "node_modules"]);
const scannedRoots = new Set([".github", "handbook", "architecture", "domains", "adr", "operations", "tasks", "archive", "scripts", "templates"]);
const scannedMigrationFiles = new Set([
  "migration/README.md",
  "migration/MIGRATION_RULES.md",
  "migration/document-inventory.csv",
  "migration/redaction-report.md",
  "migration/semantic-coverage.csv",
  "migration/semantic-coverage-summary.md",
  "migration/coverage-batch-001-triage.md",
  "migration/coverage-batch-001-review.md",
  "migration/coverage-batch-002-review.md",
]);
const rootFiles = new Set(["README.md", "package.json", ".gitignore", ".gitattributes"]);
const ignoredFiles = new Set(["scripts/check-sensitive-content.mjs", "scripts/archive-legacy-sources.mjs"]);
const findings = [];
const binaryExtensions = new Set([".db", ".sqlite", ".sqlite3", ".log", ".wav", ".mp3", ".zip", ".7z", ".pem", ".key"]);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["credential assignment", /\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*["']?(?!<|\$\{|example|redacted|none|null)[A-Za-z0-9_./+=-]{12,}/i],
  ["bearer credential", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/i],
  ["GitHub token", /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["user profile path", /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^<>{}\s"'`]+|\/(?:home|Users)\/[^<>{}\s"'`]+)/],
  ["Pi/session artifact path", /(?:[A-Za-z]:[\\/][^\n]*?(?:\.pi|PiData|subagent-(?:artifacts|sessions)|cortexkit)[\\/][^\s"'`)]+|file:\/\/\/[^\s"'`)]+)/i],
];

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(absolute)));
    else result.push(absolute);
  }
  return result;
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

for (const file of await walk(root)) {
  const relative = rel(file);
  const firstSegment = relative.split("/", 1)[0];
  if (ignoredFiles.has(relative) || (!rootFiles.has(relative) && !scannedRoots.has(firstSegment) && !scannedMigrationFiles.has(relative))) continue;
  const extension = path.extname(file).toLowerCase();
  if (binaryExtensions.has(extension) || path.basename(file).startsWith(".env")) {
    findings.push(`${relative}: forbidden artifact extension`);
    continue;
  }
  if (![".md", ".json", ".jsonc", ".csv", ".yml", ".yaml", ".mjs", ".txt"].includes(extension)) continue;
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const [category, pattern] of patterns) {
      if (pattern.test(lines[index])) findings.push(`${relative}:${index + 1}: ${category}`);
    }
  }
}

if (findings.length) {
  console.error(`Sensitive-content check failed (${findings.length} findings):`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log("Sensitive-content check passed for governed repository paths.");
}
