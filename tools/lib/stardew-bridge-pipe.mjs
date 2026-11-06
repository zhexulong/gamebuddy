/**
 * The bridge pipe name, read from the config the MOD reads.
 *
 * Single authority on purpose: this was hardcoded in the ladder orchestrator while the fixture seeded a different name
 * into `<modsPath>/GameBuddy.Stardew/config.json`, so the Mod opened one pipe and the launcher listened on another - and
 * the failure surfaced 150 s later as `stardew_pipe_not_listening` instead of as the one-line mismatch it was (measured
 * 2026-10-19).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STARDEW_MOD_FOLDER } from "./stardew-mod-folder.mjs";

/** The Mod's own config path inside a mods directory. */
export function bridgeConfigPath(modsPath) {
  return join(modsPath, STARDEW_MOD_FOLDER, "config.json");
}

/**
 * The pipe name the Mod will listen on, or a NAMED refusal (`bridge_config_unreadable` / `bridge_pipe_name_invalid`)
 * rather than a silent fallback to a guess.
 */
export function bridgePipeNameFor(modsPath) {
  const configPath = bridgeConfigPath(modsPath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`bridge_config_unreadable:${configPath}:${String(error?.code ?? error)}`);
  }
  const name = parsed?.PipeName;
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(name))
    throw new Error(`bridge_pipe_name_invalid:${configPath}:${String(name)}`);
  return name;
}

/**
 * Print the config path for a mods directory, so a PowerShell harness can join no folder name of its own.
 *
 * The harnesses cannot import this module, and `tools/run-stardew-native-local-player-move-fixture.ps1` spelled the
 * folder by hand instead: it read `Mods/GameBuddy.Stardew/config.json` while every fixture deploys `Mods/GameBuddy`,
 * so a correct lane failed preflight with `Missing harness path` and a name that pointed at the wrong half.
 */
function cliMain(argv) {
  if (argv.length === 2 && argv[0] === "--print-config-path") {
    process.stdout.write(`${bridgeConfigPath(argv[1])}\n`);
    return;
  }
  process.stderr.write("usage: stardew-bridge-pipe.mjs --print-config-path <modsPath>\n");
  process.exitCode = 2;
}

const isCli = process.argv[1]?.replaceAll("\\", "/").endsWith("tools/lib/stardew-bridge-pipe.mjs") === true;
if (isCli) cliMain(process.argv.slice(2));
