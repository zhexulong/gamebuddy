#!/usr/bin/env node
import { access, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Non-mutating Navigation action-admission preflight.
 *
 * This entry checks only the current environment and fixture transaction
 * surface needed to begin one new action attempt. Host contract parity,
 * topology implementation admission, replay, terminal receipts, evidence,
 * and postconditions are separate boundaries and are never read, produced,
 * or consumed here.
 */
const TOOLS_DIR = fileURLToPath(new URL(".", import.meta.url));

const OPTION_NAMES = new Set(["gamePath", "releaseDir"]);
const FIXTURE_PATH_REQUIREMENTS = Object.freeze([
  "prepare-stardew-action-fixture.ps1",
  "restore-stardew-native-local-player-fixture.mjs",
  "run-stardew-native-local-player-navigation-mutation-fixture.ps1",
  "lib/stardew-native-local-player-fixture.mjs",
]);
const FIXTURE_LIB_EXPORTS = Object.freeze([
  "export function fixtureActions(",
  "export function fixtureScenario(",
  "export async function restoreNativeLocalPlayerFixture(",
]);

function item(name, status, detail = "") {
  return Object.freeze({ name, status, detail: String(detail ?? "") });
}

function report(state, items) {
  return Object.freeze({
    state,
    topology: "single_player_native_companion",
    items: Object.freeze(items),
    mutationCount: 0,
    executionReceiptCount: 0,
    ready: state === "PREFLIGHT_READY",
  });
}

function blocked(items) {
  return report("BLOCKED", items);
}

function hasOnlyProductionData(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype) return false;
  if (Object.keys(options).some((name) => !OPTION_NAMES.has(name))) return false;
  return ["gamePath", "releaseDir"].every((name) => typeof options[name] === "string" && options[name].length > 0);
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readFixtureSource(path) {
  return await readFile(path, "utf8");
}

export async function runAgentLivePreflight(options = {}) {
  if (!hasOnlyProductionData(options)) return blocked([item("input", "blocked", "game-path and release-dir are required strings")]);

  const items = [];
  const [gamePathReady, releaseDirReady] = await Promise.all([
    isDirectory(options.gamePath),
    isDirectory(options.releaseDir),
  ]);
  items.push(item(
    "runtime_paths",
    gamePathReady && releaseDirReady ? "ready" : "blocked",
    gamePathReady && releaseDirReady ? "game and release directories accessible" : "game-path or release-dir inaccessible",
  ));

  const fixturePaths = FIXTURE_PATH_REQUIREMENTS.map((relative) => TOOLS_DIR + relative);
  const fixturePresent = await Promise.all(fixturePaths.map(exists));
  const missing = FIXTURE_PATH_REQUIREMENTS.filter((_, index) => !fixturePresent[index]);
  let fixtureExportsReady = false;
  if (missing.length === 0) {
    try {
      const fixtureSource = await readFixtureSource(TOOLS_DIR + "lib/stardew-native-local-player-fixture.mjs");
      fixtureExportsReady = FIXTURE_LIB_EXPORTS.every((expected) => fixtureSource.includes(expected));
    } catch {
      fixtureExportsReady = false;
    }
  }
  const fixtureReady = missing.length === 0 && fixtureExportsReady;
  items.push(item(
    "fixture_transaction",
    fixtureReady ? "ready" : "blocked",
    fixtureReady ? "prepare, navigation mutation, restore, and cleanup owners present" : missing.length > 0 ? `missing: ${missing.join(",")}` : "fixture owner contract unreadable",
  ));

  return items.every((entry) => entry.status === "ready")
    ? report("PREFLIGHT_READY", items)
    : blocked(items);
}

function argument(args, name) {
  for (let index = 0; index < args.length; index += 1) if (args[index] === name) return args[index + 1];
  return undefined;
}

async function cliMain(args) {
  const result = await runAgentLivePreflight({
    gamePath: argument(args, "--game-path"),
    releaseDir: argument(args, "--release-dir"),
  });
  console.log(JSON.stringify({
    state: result.state,
    topology: result.topology,
    items: result.items,
    mutationCount: result.mutationCount,
    executionReceiptCount: result.executionReceiptCount,
  }));
  process.exitCode = result.ready ? 0 : 1;
}

if (process.argv[1] && new URL(`file:${process.argv[1]}`).href === import.meta.url) {
  cliMain(process.argv.slice(2)).catch((error) => {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  });
}
