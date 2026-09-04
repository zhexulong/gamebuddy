#!/usr/bin/env node
/** Run independent, blocking Knip reports and promote only validated JSON. */
import { spawn } from "node:child_process";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const reports = [
  ["workspace.json", []],
  ["production.json", ["--production"]],
];
const baseArgs = ["exec", "knip", "--config", "knip.json", "--reporter", "json"];
export const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
export const pnpmSpawnOptions = { shell: false };

function failure(message, cause) {
  const error = new Error(message, { cause });
  error.code = "KNIP_RUNNER";
  return error;
}
const itemFields = new Set(["name", "namespace", "kind", "specifier", "line", "col", "pos"]);
const namedItemFields = new Set(["name"]);
const issueFields = new Map([
  ["owners", namedItemFields],
  ["binaries", namedItemFields],
  ["unlisted", namedItemFields],
  ["cycles", itemFields],
  ["duplicates", itemFields],
  ...["catalog", "catalogReferences", "dependencies", "devDependencies", "enumMembers", "exports", "files", "namespaceMembers", "nsExports", "nsTypes", "optionalPeerDependencies", "types", "unresolved"]
    .map((name) => [name, itemFields]),
]);
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validItem(value, fields) {
  return plainObject(value) && typeof value.name === "string" && value.name.length > 0 &&
    Object.entries(value).every(([key, entry]) => fields.has(key) &&
      (key === "name" || ["namespace", "kind", "specifier"].includes(key) && typeof entry === "string" ||
        ["line", "col", "pos"].includes(key) && Number.isInteger(entry) && entry >= 0));
}
function validIssueEntries(entries, fields) {
  return Array.isArray(entries) && entries.every((entry) => validItem(entry, fields));
}
export function validReport(value) {
  if (!plainObject(value) || !Array.isArray(value.issues) ||
    !Object.keys(value).every((key) => key === "issues")) return false;
  return value.issues.every((issue) => plainObject(issue) && typeof issue.file === "string" && issue.file.length > 0 &&
    Object.entries(issue).every(([key, entries]) => {
      if (key === "file") return true;
      const fields = issueFields.get(key);
      if (!fields) return false;
      if (key === "cycles" || key === "duplicates")
        return Array.isArray(entries) && entries.every((group) => validIssueEntries(group, fields));
      return validIssueEntries(entries, fields);
    }));
}

export function execute(command, args, cwd) {
  return new Promise((resolveResult) => {
    let settled = false;
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...pnpmSpawnOptions });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        resolveResult({ code: null, stdout, stderr, error });
      }
    });
    child.once("close", (code) => {
      if (!settled) {
        settled = true;
        resolveResult({ code, stdout, stderr });
      }
    });
  });
}

async function freshOutputDirectory(output) {
  const destination = resolve(output);
  const repository = await realpath(root);
  let parent;
  try {
    parent = await realpath(resolve(destination, ".."));
  } catch (error) {
    throw failure("Knip output parent must exist", error);
  }
  const outsidePath = relative(repository, parent);
  if (parent === repository || (!outsidePath.startsWith("..") && !isAbsolute(outsidePath)))
    throw failure("Knip output must be outside the repository");
  try {
    const stat = await lstat(destination);
    if (stat.isSymbolicLink() || stat.isDirectory() || stat.isFile())
      throw failure("Knip output root must not already exist");
    const canonicalDestination = await realpath(destination);
    const destinationRelative = relative(repository, canonicalDestination);
    if (!destinationRelative.startsWith("..") && !isAbsolute(destinationRelative))
      throw failure("Knip output must be outside the repository");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(destination, { recursive: false });
  return destination;
}

async function promote(destination, name, report) {
  const temporary = resolve(destination, `.tmp-${name}-${process.pid}`);
  const target = resolve(destination, name);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function runReports(output, { cwd = root, run = execute } = {}) {
  const destination = await freshOutputDirectory(output);
  const results = [];
  for (const [name, mode] of reports) {
    const result = await run(pnpmCommand, [...baseArgs, ...mode], cwd);
    let report;
    let error = result.error ? `spawn failure: ${result.error.message}` : null;
    if (!error) {
      try {
        report = JSON.parse(result.stdout);
        if (!validReport(report)) throw new Error("report must be a JSON object");
      } catch (cause) {
        error = `invalid JSON report: ${cause.message}`;
      }
    }
    const finding = result.code === 1 && !error;
    const successful = (result.code === 0 || finding) && !error;
    if (successful) await promote(destination, name, report);
    results.push({ name, code: result.code, finding, promoted: successful, error, stderr: result.stderr });
  }
  const failed = results.some((result) => result.error || ![0, 1].includes(result.code));
  return { output: destination, results, exitCode: failed ? 2 : results.some((result) => result.finding) ? 1 : 0 };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("usage: node tools/run-knip-reports.mjs <fresh-disposable-output-directory>");
    process.exitCode = 2;
  } else {
    try {
      const result = await runReports(args[0]);
      for (const report of result.results)
        console.error(`${report.name}: exit ${report.code ?? "spawn-failure"}${report.finding ? " (findings)" : ""}`);
      process.exitCode = result.exitCode;
    } catch (error) {
      console.error(`Knip report runner failed: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
