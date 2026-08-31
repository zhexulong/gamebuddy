import { access, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TOOLS_DIR = fileURLToPath(new URL(".", import.meta.url));
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

async function defaultDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function defaultExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultRead(path) {
  return await readFile(path, "utf8");
}

/**
 * Test-only composition seam for the agent-live environment/fixture admission.
 * It deliberately has no Host surface, replay, topology, receipt, or mutation
 * dependency; those facts belong to their independent owners.
 */
export async function runAgentLivePreflightTestHarness(options = {}) {
  const directory = options.isDirectory ?? defaultDirectory;
  const fileExists = options.exists ?? defaultExists;
  const read = options.readFile ?? defaultRead;
  const items = [];

  const [gamePathReady, releaseDirReady] = await Promise.all([
    directory(options.gamePath ?? "game"),
    directory(options.releaseDir ?? "release"),
  ]);
  items.push(item(
    "runtime_paths",
    gamePathReady && releaseDirReady ? "ready" : "blocked",
    gamePathReady && releaseDirReady ? "game and release directories accessible" : "game-path or release-dir inaccessible",
  ));

  const paths = FIXTURE_PATH_REQUIREMENTS.map((relative) => TOOLS_DIR + relative);
  const present = await Promise.all(paths.map(fileExists));
  const missing = FIXTURE_PATH_REQUIREMENTS.filter((_, index) => !present[index]);
  let exportsReady = false;
  if (missing.length === 0) {
    try {
      const source = await read(TOOLS_DIR + "lib/stardew-native-local-player-fixture.mjs");
      exportsReady = FIXTURE_LIB_EXPORTS.every((expected) => source.includes(expected));
    } catch {
      exportsReady = false;
    }
  }
  const fixtureReady = missing.length === 0 && exportsReady;
  items.push(item(
    "fixture_transaction",
    fixtureReady ? "ready" : "blocked",
    fixtureReady ? "prepare, navigation mutation, restore, and cleanup owners present" : missing.length > 0 ? `missing: ${missing.join(",")}` : "fixture owner contract unreadable",
  ));

  return items.every((entry) => entry.status === "ready")
    ? report("PREFLIGHT_READY", items)
    : report("BLOCKED", items);
}
