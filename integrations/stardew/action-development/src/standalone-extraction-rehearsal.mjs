import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
  copyFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../../..");
const STANDALONE_DIRECTORY = path.join(PACKAGE_DIRECTORY, "standalone");
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const EXCLUDED_DIRECTORY_NAMES = new Set(["node_modules", "bin", "obj"]);
const EXPECTED_NODE_VERSION = "v24.13.0";
const EXPECTED_PNPM_VERSION = "11.1.3";
const EXPECTED_DOTNET_VERSION = "8.0.424";
const EXPECTED_PORTFOLIO_ENTRIES = Object.freeze([
  "equip-tool-contract-check",
  "scaffold-contract",
  "action-surface-check",
  "action-source-projection-check",
  "static-production-admission",
  "package-deterministic-tests",
]);

function fail(code) {
  throw new Error(`stardew_action_extraction_rehearsal_${code}`);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function removeOwnedTemporaryTree(root) {
  const temporaryDirectory = path.resolve(os.tmpdir());
  const absoluteRoot = path.resolve(root);
  if (absoluteRoot === temporaryDirectory || !isInside(temporaryDirectory, absoluteRoot)) fail("cleanup_root_invalid");
  const visit = async (directory) => {
    if (!isInside(absoluteRoot, directory)) fail("cleanup_escape");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (!isInside(absoluteRoot, absolutePath)) fail("cleanup_escape");
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) await unlink(absolutePath);
      else if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) await unlink(absolutePath);
      else fail("cleanup_entry_not_regular");
    }
    await rmdir(directory);
  };
  await visit(absoluteRoot);
}

async function assertTreeHasNoLinksOrAmbientOutputs(root) {
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) fail("source_link_forbidden");
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) fail("ambient_output_present");
        await visit(absolutePath);
      } else if (!entry.isFile()) {
        fail("source_entry_not_regular");
      }
    }
  };
  await visit(root);
}

async function assertNoFormerRootLiteral(root, excludedPath) {
  const forbidden = Object.freeze([
    REPOSITORY_DIRECTORY,
    REPOSITORY_DIRECTORY.replaceAll("\\", "/"),
    pathToFileURL(REPOSITORY_DIRECTORY).href,
  ]);
  const textExtensions = new Set([".cjs", ".cs", ".csproj", ".json", ".mjs", ".md", ".props", ".targets", ".txt", ".yaml", ".yml"]);
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (absolutePath === excludedPath) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
        const text = await readFile(absolutePath, "utf8");
        if (forbidden.some((value) => text.includes(value))) fail("former_root_literal_present");
      }
    }
  };
  await visit(root);
}

function denyFormerRootHookSource() {
  const deniedRoot = JSON.stringify(path.resolve(REPOSITORY_DIRECTORY));
  return `"use strict";\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst { fileURLToPath } = require("node:url");\nconst { syncBuiltinESMExports } = require("node:module");\nconst deniedRoot = ${deniedRoot};\nfunction normalize(value) {\n  if (value instanceof URL) return fileURLToPath(value);\n  if (Buffer.isBuffer(value)) return value.toString();\n  return typeof value === "string" ? value : null;\n}\nfunction assertAllowed(value) {\n  const raw = normalize(value);\n  if (raw === null) return;\n  const absolute = path.resolve(raw);\n  const relative = path.relative(deniedRoot, absolute);\n  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {\n    throw new Error("stardew_action_extraction_rehearsal_former_root_read_blocked");\n  }\n}\nfor (const name of ["access", "accessSync", "createReadStream", "existsSync", "lstat", "lstatSync", "open", "openSync", "opendir", "opendirSync", "readFile", "readFileSync", "readdir", "readdirSync", "realpath", "realpathSync", "stat", "statSync"]) {\n  const original = fs[name];\n  if (typeof original !== "function") continue;\n  const guarded = function guarded(first, ...rest) { assertAllowed(first); return original.call(this, first, ...rest); };\n  Object.assign(guarded, original);\n  if (typeof original.native === "function") {\n    guarded.native = function guardedNative(first, ...rest) { assertAllowed(first); return original.native.call(this, first, ...rest); };\n  }\n  fs[name] = guarded;\n}\nfor (const name of ["access", "lstat", "open", "opendir", "readFile", "readdir", "realpath", "stat"]) {\n  const original = fs.promises[name];\n  if (typeof original !== "function") continue;\n  fs.promises[name] = function guarded(first, ...rest) { assertAllowed(first); return original.call(this, first, ...rest); };\n}\nsyncBuiltinESMExports();\n`;
}

function run(command, args, { cwd, environment }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = { stdout: [], stderr: [], bytes: 0 };
    const append = (field) => (chunk) => {
      chunks.bytes += chunk.length;
      if (chunks.bytes > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      chunks[field].push(Buffer.from(chunk));
    };
    child.stdout.on("data", append("stdout"));
    child.stderr.on("data", append("stderr"));
    child.once("error", (error) => reject(new Error(`stardew_action_extraction_rehearsal_process_failed:${command}:${error.code ?? "unknown"}`)));
    child.once("close", (code, signal) => {
      const stdout = Buffer.concat(chunks.stdout).toString("utf8");
      const stderr = Buffer.concat(chunks.stderr).toString("utf8");
      if (chunks.bytes > MAX_PROCESS_OUTPUT_BYTES) reject(new Error("stardew_action_extraction_rehearsal_process_output_oversized"));
      else if (code !== 0 || signal) reject(new Error(`stardew_action_extraction_rehearsal_process_failed:${command}:${code ?? "signal"}:${stderr.slice(-4096)}`));
      else resolve(Object.freeze({ stdout, stderr }));
    });
  });
}

async function resolvePnpmCliPath() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, "node_modules", "pnpm", "bin", "pnpm.mjs"));
    candidates.push(path.join(directory, "node_modules", "pnpm", "bin", "pnpm.cjs"));
  }
  for (const candidate of candidates) {
    try {
      const stats = await lstat(candidate);
      if (stats.isFile() && !stats.isSymbolicLink()) return candidate;
    } catch {
      // Continue through fixed pnpm CLI candidates.
    }
  }
  fail("pnpm_cli_missing");
}

function parsePortfolioReceipt(stdout) {
  for (const line of stdout.split(/\r?\n/u).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.status === "deterministic-ci") return parsed;
    } catch {
      // Continue to the preceding bounded output line.
    }
  }
  fail("portfolio_receipt_missing");
}

export async function runStandaloneExtractionRehearsal() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-stardew-extraction-rehearsal-"));
  try {
    if (!isInside(path.resolve(os.tmpdir()), temporaryRoot)) fail("temporary_root_invalid");
    await cp(STANDALONE_DIRECTORY, temporaryRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter(source) {
        return source === STANDALONE_DIRECTORY || !EXCLUDED_DIRECTORY_NAMES.has(path.basename(source));
      },
    });
    await copyFile(path.join(temporaryRoot, "inputs", "pnpm-lock.yaml"), path.join(temporaryRoot, "pnpm-lock.yaml"));
    await copyFile(path.join(temporaryRoot, "inputs", "global.json"), path.join(temporaryRoot, "global.json"));
    await assertTreeHasNoLinksOrAmbientOutputs(temporaryRoot);

    const denyHookPath = path.join(temporaryRoot, ".deny-former-root.cjs");
    await writeFile(denyHookPath, denyFormerRootHookSource(), { encoding: "utf8", flag: "wx" });
    await assertNoFormerRootLiteral(temporaryRoot, denyHookPath);

    const environment = {
      ...process.env,
      INIT_CWD: temporaryRoot,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--require=${denyHookPath}`,
      PWD: temporaryRoot,
    };
    delete environment.npm_config_workspace_dir;
    delete environment.PNPM_WORKSPACE_DIR;

    const pnpmCliPath = await resolvePnpmCliPath();
    const nodeVersion = (await run(process.execPath, ["--version"], { cwd: temporaryRoot, environment })).stdout.trim();
    const pnpmVersion = (await run(process.execPath, [pnpmCliPath, "--version"], { cwd: temporaryRoot, environment })).stdout.trim();
    const dotnetVersion = (await run("dotnet", ["--version"], { cwd: temporaryRoot, environment })).stdout.trim();
    if (nodeVersion !== EXPECTED_NODE_VERSION) fail("node_version_mismatch");
    if (pnpmVersion !== EXPECTED_PNPM_VERSION) fail("pnpm_version_mismatch");
    if (dotnetVersion !== EXPECTED_DOTNET_VERSION) fail("dotnet_version_mismatch");

    await run(process.execPath, [pnpmCliPath, "install", "--frozen-lockfile", "--ignore-workspace"], { cwd: temporaryRoot, environment });
    const actionCi = await run(process.execPath, [pnpmCliPath, "action:ci"], { cwd: temporaryRoot, environment });
    const receipt = parsePortfolioReceipt(actionCi.stdout);
    if (receipt.gameId !== "stardew" || JSON.stringify(receipt.entries) !== JSON.stringify(EXPECTED_PORTFOLIO_ENTRIES)) {
      fail("portfolio_receipt_invalid");
    }

    return Object.freeze({
      schema: "gamebuddy-stardew-standalone-extraction-rehearsal/v1",
      status: "passed",
      devkitSource: "packed-artifact",
      dependencyInstall: "frozen",
      formerRootPolicy: "runtime-denied",
      legacyClosureExecuted: false,
      nodeVersion,
      pnpmVersion,
      dotnetVersion,
      actionCiStatus: receipt.status,
      entries: Object.freeze([...EXPECTED_PORTFOLIO_ENTRIES]),
    });
  } finally {
    await removeOwnedTemporaryTree(temporaryRoot);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStandaloneExtractionRehearsal()
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
