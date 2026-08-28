import { spawn } from "node:child_process";
import { runActionProject } from "@gamebuddy/game-action-devkit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFixedPackageUtf8File } from "./package-safe-reader.mjs";

const SCHEMA = "gamebuddy-stardew-action-portfolio/v1";
const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORTFOLIO_RELATIVE_PATH = "portfolio.json";
const PORTFOLIO_MAX_JSON_BYTES = 64 * 1024;
const REPOSITORY_ROOT = path.resolve(PACKAGE_DIRECTORY, "../../..");
const SCAFFOLD_CHECKER = "src/scaffold-contract.mjs";
const ACTION_SURFACE_CHECKER = "src/action-surface-check.mjs";
const ENTRY_KEYS = new Set(["id", "kind", "actionId"]);
const CANONICAL_ENTRY_IDS = Object.freeze([
  "equip-tool-contract-check",
  "scaffold-contract",
  "action-surface-check",
  "package-deterministic-tests",
]);
const IDS = new Set(CANONICAL_ENTRY_IDS);

function fail(code) {
  throw new Error(`stardew_action_portfolio_${code}`);
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))) fail("invalid_shape");
}

export function validateDeterministicPortfolio(input) {
  exactKeys(input, new Set(["schema", "entries"]));
  if (input.schema !== SCHEMA || !Array.isArray(input.entries) || input.entries.length !== 4) fail("invalid_schema");
  const seen = new Set();
  const entries = input.entries.map((entry) => {
    if (entry?.kind === "action-check") {
      exactKeys(entry, ENTRY_KEYS);
      if (entry.id !== "equip-tool-contract-check" || entry.actionId !== "equip_tool") fail("invalid_action_check");
    } else if (entry?.kind === "scaffold-check") {
      exactKeys(entry, new Set(["id", "kind"]));
      if (entry.id !== "scaffold-contract") fail("invalid_scaffold_check");
    } else if (entry?.kind === "action-surface-check") {
      exactKeys(entry, new Set(["id", "kind"]));
      if (entry.id !== "action-surface-check") fail("invalid_action_surface_check");
    } else if (entry?.kind === "package-tests") {
      exactKeys(entry, new Set(["id", "kind"]));
      if (entry.id !== "package-deterministic-tests") fail("invalid_package_tests");
    } else {
      fail("entry_not_pr_safe");
    }
    if (!IDS.has(entry.id) || seen.has(entry.id)) fail("entry_duplicate_or_unknown");
    if (entry.id !== CANONICAL_ENTRY_IDS[seen.size]) fail("entry_order");
    seen.add(entry.id);
    return Object.freeze({ ...entry });
  });
  if (seen.size !== IDS.size) fail("entry_missing");
  return Object.freeze(entries);
}

export async function readDeterministicPortfolio() {
  const text = await readFixedPackageUtf8File({
    packageDirectory: PACKAGE_DIRECTORY,
    relativePath: PORTFOLIO_RELATIVE_PATH,
    maxBytes: PORTFOLIO_MAX_JSON_BYTES,
    errorPrefix: "stardew_action_portfolio",
  });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("invalid_json");
  }
  return validateDeterministicPortfolio(parsed);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: PACKAGE_DIRECTORY, shell: false, stdio: "inherit", windowsHide: true });
    child.once("error", () => reject(new Error("stardew_action_portfolio_command_failed")));
    child.once("close", (code, signal) => code === 0 && !signal ? resolve() : reject(new Error("stardew_action_portfolio_command_failed")));
  });
}

export async function runDeterministicPortfolio({ runCommand = run, runProject = runActionProject } = {}) {
  if (typeof runCommand !== "function" || typeof runProject !== "function") fail("invalid_runner");
  const entries = await readDeterministicPortfolio();
  for (const entry of entries) {
    if (entry.kind === "action-check") {
      await runProject({ projectFile: path.join(PACKAGE_DIRECTORY, "game-action-project.json"), invocation: { command: "check", actionId: entry.actionId } });
    } else if (entry.kind === "scaffold-check") {
      await runCommand(process.execPath, [SCAFFOLD_CHECKER, REPOSITORY_ROOT]);
    } else if (entry.kind === "action-surface-check") {
      await runCommand(process.execPath, [ACTION_SURFACE_CHECKER]);
    } else if (entry.kind === "package-tests") {
      await runCommand(process.execPath, ["src/run-tests.mjs"]);
    } else fail("invalid_entry");
  }
  return Object.freeze({ gameId: "stardew", status: "deterministic-ci", entries: entries.map((entry) => entry.id) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDeterministicPortfolio().then((report) => process.stdout.write(`${JSON.stringify(report)}\n`), (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
