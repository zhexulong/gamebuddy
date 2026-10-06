#!/usr/bin/env node
/**
 * Gate for the "name used outside the scope that declares it" bug class.
 *
 * See `tools/lib/scope-reference-audit.mjs` for the rules, the exact bug shapes they
 * catch, and the false-positive boundary.
 *
 * Usage:
 *   node tools/check-scope-references.mjs                       # tools/ (default scope)
 *   node tools/check-scope-references.mjs tools/live-run        # one subtree
 *   node tools/check-scope-references.mjs --ext .ts host/src    # opt-in TypeScript
 *   node tools/check-scope-references.mjs --json
 *   node tools/check-scope-references.mjs --rules read_before_declaration
 *
 * Exit code is 1 when any finding is reported, 0 otherwise.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  analyzeFile,
  PARSE_ERROR_RULE,
  SCOPE_REFERENCE_RULES,
  SUPPORTED_EXTENSIONS,
} from "./lib/scope-reference-audit.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

function parseArguments(argv) {
  const options = {
    paths: [],
    extensions: [".mjs", ".js", ".cjs"],
    rules: [...SCOPE_REFERENCE_RULES],
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--ext") options.extensions.push(...splitList(argv[++index]));
    else if (argument === "--only-ext") options.extensions = splitList(argv[++index]);
    else if (argument === "--rules") options.rules = splitList(argv[++index]);
    else if (argument.startsWith("--ext=")) options.extensions.push(...splitList(argument.slice(6)));
    else if (argument.startsWith("--only-ext=")) options.extensions = splitList(argument.slice(11));
    else if (argument.startsWith("--rules=")) options.rules = splitList(argument.slice(8));
    else if (argument.startsWith("--")) throw new Error(`unknown option ${argument}`);
    else options.paths.push(argument);
  }
  if (options.paths.length === 0) options.paths.push("tools");
  options.extensions = [...new Set(options.extensions.map((extension) => extension.toLowerCase()))];
  for (const extension of options.extensions) {
    if (SUPPORTED_EXTENSIONS[extension] === undefined) {
      throw new Error(`no grammar for extension ${extension}`);
    }
  }
  for (const rule of options.rules) {
    if (!SCOPE_REFERENCE_RULES.includes(rule)) throw new Error(`unknown rule ${rule}`);
  }
  return options;
}

function splitList(value) {
  if (value === undefined) throw new Error("missing value for a list option");
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function collectFiles(target, extensions, out) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOTDIR") {
      out.add(path.resolve(target));
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await collectFiles(full, extensions, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (extensions.includes(path.extname(entry.name).toLowerCase())) out.add(path.resolve(full));
  }
}

function relativeToRepo(absolutePath) {
  const relative = path.relative(REPO_ROOT, absolutePath);
  return relative.startsWith("..") ? absolutePath : relative.split(path.sep).join("/");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const files = new Set();
  for (const target of options.paths) await collectFiles(path.resolve(REPO_ROOT, target), options.extensions, files);

  const ordered = [...files].sort();
  const typescriptFiles = ordered.filter((file) => [".cts", ".mts", ".ts", ".tsx"].includes(path.extname(file)));
  if (typescriptFiles.length > 0) {
    // The TS grammar has not been classified for type positions, so its findings are
    // advisory: see the module doc-comment in lib/scope-reference-audit.mjs.
    process.stderr.write(
      `warning: ${typescriptFiles.length} TypeScript file(s) in scope — type positions are not\n` +
        "  classified and parse_error can fire on valid TS the grammar cannot parse.\n" +
        "  Treat these findings as advisory; do not gate on them yet.\n",
    );
  }
  const findings = [];
  const unparsed = [];
  for (const file of ordered) {
    const result = await analyzeFile(file, { fileName: relativeToRepo(file), rules: options.rules });
    if (!result.parsed) unparsed.push(result.fileName);
    for (const finding of result.findings) findings.push(finding);
  }

  const counts = Object.fromEntries(
    [PARSE_ERROR_RULE, ...SCOPE_REFERENCE_RULES].map((rule) => [
      rule,
      findings.filter((finding) => finding.rule === rule).length,
    ]),
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ filesScanned: ordered.length, counts, findings }, null, 2)}\n`);
  } else {
    for (const finding of findings) {
      process.stdout.write(
        `${finding.fileName}:${finding.line}:${finding.column}  ${finding.rule}  ${finding.message}\n`,
      );
    }
    const summary = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([rule, count]) => `${count} ${rule}`)
      .join(", ");
    process.stdout.write(
      `scope-reference gate: ${ordered.length} files scanned, ${findings.length} findings` +
        `${findings.length === 0 ? "" : ` (${summary})`}, ${unparsed.length} unparsed\n`,
    );
  }

  process.exitCode = findings.length === 0 ? 0 : 1;
}

await main();
