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

/** The Mod's own config path inside a mods directory. */
export function bridgeConfigPath(modsPath) {
  return join(modsPath, "GameBuddy.Stardew", "config.json");
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
