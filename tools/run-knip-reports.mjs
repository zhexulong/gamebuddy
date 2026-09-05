#!/usr/bin/env node
/** Run independent, blocking Knip reports and promote only validated JSON. */
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const reports = [
  ["workspace.json", []],
  ["production.json", ["--production"]],
];
const baseArgs = ["exec", "knip", "--config", "knip.json", "--reporter", "json"];
export const pnpmCommand = process.platform === "win32" ? process.execPath : "pnpm";
export const pnpmSpawnOptions = { shell: false };
const knipCommandArgs =
  process.platform === "win32" ? [resolve(root, "node_modules/knip/bin/knip.js")] : ["exec", "knip"];

function failure(message, cause) {
  const error = new Error(message, { cause });
  error.code = "KNIP_RUNNER";
  return error;
}

function parseCliArgs(args) {
  const values = {};
  const names = new Set(["--output-dir", "--allowed-root", "--ledger"]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!names.has(name) || values[name] !== undefined || !value || value.startsWith("-") || args.length !== 6)
      throw failure(
        "usage: node tools/run-knip-reports.mjs --output-dir <fresh-output> --allowed-root <trusted-allowed-root> --ledger <ledger-file>",
      );
    values[name] = value;
  }
  if (
    values["--output-dir"] === undefined ||
    values["--allowed-root"] === undefined ||
    values["--ledger"] === undefined
  )
    throw failure(
      "usage: node tools/run-knip-reports.mjs --output-dir <fresh-output> --allowed-root <trusted-allowed-root> --ledger <ledger-file>",
    );
  return { output: values["--output-dir"], allowedRoot: values["--allowed-root"], ledgerPath: values["--ledger"] };
}
const itemFields = new Set(["name", "namespace", "kind", "specifier", "line", "col", "pos"]);
const namedItemFields = new Set(["name"]);
const issueFields = new Map([
  ["owners", namedItemFields],
  ["binaries", namedItemFields],
  ["unlisted", namedItemFields],
  ["cycles", itemFields],
  ["duplicates", itemFields],
  ...[
    "catalog",
    "catalogReferences",
    "dependencies",
    "devDependencies",
    "enumMembers",
    "exports",
    "files",
    "namespaceMembers",
    "nsExports",
    "nsTypes",
    "optionalPeerDependencies",
    "types",
    "unresolved",
  ].map((name) => [name, itemFields]),
]);
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validItem(value, fields) {
  return (
    plainObject(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    Object.entries(value).every(
      ([key, entry]) =>
        fields.has(key) &&
        (key === "name" ||
          (["namespace", "kind", "specifier"].includes(key) && typeof entry === "string") ||
          (["line", "col", "pos"].includes(key) && Number.isInteger(entry) && entry >= 0)),
    )
  );
}
function validIssueEntries(entries, fields) {
  return Array.isArray(entries) && entries.every((entry) => validItem(entry, fields));
}
export function validReport(value) {
  if (!plainObject(value) || !Array.isArray(value.issues) || !Object.keys(value).every((key) => key === "issues"))
    return false;
  return value.issues.every(
    (issue) =>
      plainObject(issue) &&
      typeof issue.file === "string" &&
      issue.file.length > 0 &&
      Object.entries(issue).every(([key, entries]) => {
        if (key === "file") return true;
        const fields = issueFields.get(key);
        if (!fields) return false;
        if (key === "cycles" || key === "duplicates")
          return Array.isArray(entries) && entries.every((group) => validIssueEntries(group, fields));
        return validIssueEntries(entries, fields);
      }),
  );
}

function findingIdentity({ file, category, name }) {
  return `${file}|${category}|${name}`;
}

const ledgerRecordFields = new Set(["identity", "owner", "obligation", "risk", "evidence", "validUntil", "status"]);
function validLedger(ledger, now = new Date()) {
  if (
    !plainObject(ledger) ||
    ledger.schemaVersion !== 1 ||
    !Array.isArray(ledger.findings) ||
    !Object.keys(ledger).every((key) => key === "schemaVersion" || key === "findings")
  )
    return false;
  const current = now instanceof Date && !Number.isNaN(now.valueOf()) ? now : new Date(0);
  const identities = new Set();
  for (const entry of ledger.findings) {
    if (
      !plainObject(entry) ||
      !Object.keys(entry).every((key) => ledgerRecordFields.has(key)) ||
      Object.keys(entry).length !== ledgerRecordFields.size ||
      typeof entry.identity !== "string" ||
      !entry.identity ||
      typeof entry.owner !== "string" ||
      !entry.owner.trim() ||
      typeof entry.obligation !== "string" ||
      !entry.obligation.trim() ||
      typeof entry.risk !== "string" ||
      !entry.risk.trim() ||
      !Array.isArray(entry.evidence) ||
      entry.evidence.length === 0 ||
      !entry.evidence.every((item) => typeof item === "string" && item.trim()) ||
      typeof entry.validUntil !== "string" ||
      !["unresolved_blocking", "resolved"].includes(entry.status)
    )
      return false;
    const expiry = new Date(entry.validUntil);
    if (Number.isNaN(expiry.valueOf()) || expiry <= current || identities.has(entry.identity)) return false;
    identities.add(entry.identity);
  }
  return true;
}

export function validateFindingLedger(actual, ledger, now = new Date()) {
  if (!Array.isArray(actual) || !validLedger(ledger, now)) return false;
  const records = ledger.findings;
  const known = new Map(records.map((entry) => [entry.identity, entry.status]));
  const actualIdentities = actual.map(findingIdentity);
  if (new Set(actualIdentities).size !== actualIdentities.length) return false;
  for (const identity of actualIdentities) if (!known.has(identity) || known.get(identity) === "resolved") return false;
  return records.every((entry) => entry.status !== "unresolved_blocking" || actualIdentities.includes(entry.identity));
}

export function execute(command, args, cwd) {
  return new Promise((resolveResult) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...pnpmSpawnOptions,
    });
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

async function assertRegularDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure(`${label} must be a regular directory`);
}

async function assertCanonicalDirectory(path, label) {
  await assertRegularDirectory(path, label);
  const canonical = await realpath(path);
  if (canonical !== path) throw failure(`${label} must not be an alias`);
}

async function freshOutputDirectory(output, allowedRoot) {
  if (typeof allowedRoot !== "string" || !allowedRoot) throw failure("Knip allowed root is required");
  const destination = resolve(output);
  const requestedRoot = resolve(allowedRoot);
  const repository = await realpath(root);
  const canonicalRoot = await realpath(requestedRoot).catch((error) => {
    throw failure("Knip allowed root must exist", error);
  });
  await assertCanonicalDirectory(canonicalRoot, "Knip allowed root");
  if (requestedRoot !== canonicalRoot) throw failure("Knip allowed root must not be an alias");
  const outsidePath = relative(repository, canonicalRoot);
  if (canonicalRoot === repository || (!outsidePath.startsWith("..") && !isAbsolute(outsidePath)))
    throw failure("Knip allowed root must be outside the repository");

  const parent = dirname(destination);
  let current = parent;
  while (true) {
    try {
      await assertCanonicalDirectory(current, "Knip output parent");
    } catch (error) {
      if (error.code === "ENOENT") throw failure("Knip output parent must exist", error);
      throw error;
    }
    if (current === parse(current).root) break;
    current = dirname(current);
  }
  const parentRelative = relative(canonicalRoot, parent);
  if (parent !== canonicalRoot && (parentRelative.startsWith("..") || isAbsolute(parentRelative)))
    throw failure("Knip output parent must be beneath the allowed root");
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent) throw failure("Knip output parent must not be an alias");
  const parentWithinAllowedRoot = relative(canonicalRoot, canonicalParent);
  if (
    canonicalParent !== canonicalRoot &&
    (parentWithinAllowedRoot.startsWith("..") || isAbsolute(parentWithinAllowedRoot))
  )
    throw failure("Knip output parent must be beneath the allowed root");
  try {
    await lstat(destination);
    throw failure("Knip output root must not already exist");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(destination, { recursive: false });
  const canonicalDestination = await realpath(destination);
  if (canonicalDestination !== destination) throw failure("Knip output root must not be an alias");
  await assertRegularDirectory(destination, "Knip output root");
  const postCreateParent = await realpath(dirname(destination));
  if (postCreateParent !== canonicalParent) throw failure("Knip output parent changed during creation");
  const postCreateRelative = relative(canonicalRoot, postCreateParent);
  if (postCreateParent !== canonicalRoot && (postCreateRelative.startsWith("..") || isAbsolute(postCreateRelative)))
    throw failure("Knip output parent escaped the allowed root");
  await assertCanonicalDirectory(destination, "Knip output root");
  return destination;
}

async function promote(destination, name, report) {
  await assertCanonicalDirectory(destination, "Knip output root");
  const parentIdentity = await realpath(destination);
  const temporary = resolve(destination, `.tmp-${name}-${process.pid}`);
  const target = resolve(destination, name);
  try {
    await lstat(target);
    throw failure("Knip report target must not already exist");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.close();
    const temporaryInfo = await lstat(temporary);
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink())
      throw failure("Knip temporary report must be a regular file");
    await assertCanonicalDirectory(destination, "Knip output root");
    if ((await realpath(destination)) !== parentIdentity) throw failure("Knip report parent changed before promotion");
    try {
      await lstat(target);
      throw failure("Knip report target must not already exist");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(temporary, target);
    // Rename is atomic, but filesystem changes can still race these checks; any
    // detected race is returned as a failure with the residual left observable.
    await assertCanonicalDirectory(destination, "Knip output root");
    if ((await realpath(destination)) !== parentIdentity) throw failure("Knip report parent changed during promotion");
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) throw failure("Knip report target must be a regular file");
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function loadLedger(ledgerPath, ledger, output) {
  if ((ledger !== undefined) === (ledgerPath !== undefined))
    throw failure("exactly one explicit Knip finding ledger is required");
  if (ledger !== undefined) {
    if (!validLedger(ledger)) throw failure("invalid Knip finding ledger schema");
    return ledger;
  }
  if (typeof ledgerPath !== "string" || !ledgerPath) throw failure("explicit Knip finding ledger is required");
  const path = resolve(ledgerPath);
  const outputPath = resolve(output);
  const info = await lstat(path).catch((error) => {
    throw failure("Knip finding ledger must exist", error);
  });
  if (!info.isFile() || info.isSymbolicLink()) throw failure("Knip finding ledger must be a regular file");
  const canonical = await realpath(path);
  const ledgerRelativeToOutput = relative(outputPath, canonical);
  if (
    canonical !== path ||
    ledgerRelativeToOutput === "" ||
    (!ledgerRelativeToOutput.startsWith("..") && !isAbsolute(ledgerRelativeToOutput))
  )
    throw failure("Knip finding ledger must not be inside output");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw failure("invalid Knip finding ledger", error);
  }
  if (!validLedger(parsed)) throw failure("invalid Knip finding ledger schema");
  return parsed;
}

function reportFindings(report) {
  return report.issues.flatMap((issue) =>
    Object.entries(issue)
      .filter(([category, entries]) => category !== "file" && entries.length > 0)
      .flatMap(([category, entries]) => entries.map((entry) => ({ file: issue.file, category, name: entry.name }))),
  );
}

export async function runReports(output, { allowedRoot, ledgerPath, ledger, cwd = root, run = execute } = {}) {
  if (typeof allowedRoot !== "string" || !allowedRoot) throw failure("Knip allowed root is required");
  const findingLedger = await loadLedger(ledgerPath, ledger, output);
  const destination = await freshOutputDirectory(output, allowedRoot);
  const results = [];
  for (const [name, mode] of reports) {
    const result = await run(
      pnpmCommand,
      [...knipCommandArgs, ...baseArgs.slice(process.platform === "win32" ? 2 : 0), ...mode],
      cwd,
    );
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
    if (
      !error &&
      result.code === 1 &&
      /(?:parse|parser|config(?:uration)?|unknown option|invalid argument|fatal error|plugin|runtime|uncaught|exception)/i.test(
        result.stderr ?? "",
      )
    )
      error = "Knip reported a parser or configuration error";
    const finding = result.code === 1 && !error;
    const successful = (result.code === 0 || finding) && !error;
    if (successful) await promote(destination, name, report);
    results.push({ name, code: result.code, finding, promoted: successful, error, stderr: result.stderr, report });
  }
  const failed = results.some((result) => result.error || ![0, 1].includes(result.code));
  if (!failed) {
    const production = results.find(({ name }) => name === "production.json");
    if (!production || !validateFindingLedger(reportFindings(production.report), findingLedger))
      return { output: destination, results, exitCode: 2 };
  }
  return { output: destination, results, exitCode: failed ? 2 : results.some((result) => result.finding) ? 1 : 0 };
}

if (import.meta.main) {
  try {
    const { output, allowedRoot, ledgerPath } = parseCliArgs(process.argv.slice(2));
    const result = await runReports(output, { allowedRoot, ledgerPath, cwd: root });
    for (const report of result.results)
      console.error(`${report.name}: exit ${report.code ?? "spawn-failure"}${report.finding ? " (findings)" : ""}`);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`Knip report runner failed: ${error.message}`);
    process.exitCode = 2;
  }
}
