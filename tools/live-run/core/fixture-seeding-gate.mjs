import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fixture-seeding gate (live-run dependency guard).
 *
 * The live-run harness depends on the Mod's native-local fixtures actually
 * seeding the world: a fixture that silently plants nothing makes every ladder
 * rung fail with `*_ready_crop_missing`, and the failure only appears in a real
 * game run — it is invisible to type checks, unit tests, and the fixture's own
 * happy-path assertions.
 *
 * The trap, verified against the target 1.6.15 assembly:
 *
 *   Game1.parseDebugInput(string) splits the WHOLE string by whitespace and
 *   calls DebugCommands.TryHandle(command); TryHandle dispatches on command[0]
 *   ONLY. SpreadDirt's handler is `SpreadDirt(string[] command, IGameLogger log)`
 *   and never reads command[1..]. So
 *
 *     parseDebugInput("SpreadDirt SpreadSeeds 745")
 *
 *   spreads dirt and SILENTLY SKIPS the seeding. The correct call is two
 *   invocations. This was introduced by merge-refactoring two lines into one
 *   (2026-10-04) across four fixtures and only a real live run exposed it.
 *
 * Only zero-argument commands are checked, because only they are provably
 * argument-blind; commands that legitimately take quoted multi-word arguments
 * (e.g. `Build "Slime Hutch" x y`) must not be flagged.
 */

/** Debug commands whose handler never reads past command[0]. */
const ARGUMENT_BLIND_COMMANDS = Object.freeze(["SpreadDirt", "RemoveDirt"]);

/** Every `parseDebugInput("<literal>"` call in a C# source string. */
export function parseDebugInputLiterals(source) {
  const found = [];
  const pattern = /parseDebugInput\(\s*"((?:[^"\\]|\\.)*)"/gu;
  for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

/**
 * Literals that combine an argument-blind command with a following command, so
 * the second command never runs. Returns the offending literals.
 */
export function findFoldedDebugCommandLiterals(source) {
  const offenders = [];
  for (const literal of parseDebugInputLiterals(source)) {
    const tokens = literal.trim().split(/\s+/u).filter((token) => token.length > 0);
    if (tokens.length < 2) continue;
    if (ARGUMENT_BLIND_COMMANDS.includes(tokens[0])) offenders.push(literal);
  }
  return offenders;
}

/** Scan the Mod's fixture partials, which is where native-local seeding lives. */
export async function scanFixtureSeeding({ stardewRoot, readdirImpl = readdir, readFileImpl = readFile } = {}) {
  if (typeof stardewRoot !== "string" || stardewRoot.length === 0) {
    throw new Error("stardew_root_required");
  }
  let entries;
  try {
    entries = await readdirImpl(stardewRoot);
  } catch {
    return { scanned: [], offenders: [], unreadable: true };
  }
  const files = entries
    .filter((name) => /^ModEntry\.Fixtures.*\.cs$/u.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const scanned = [];
  const offenders = [];
  for (const name of files) {
    const path = join(stardewRoot, name);
    let source;
    try {
      source = await readFileImpl(path, "utf8");
    } catch {
      continue;
    }
    scanned.push(name);
    for (const literal of findFoldedDebugCommandLiterals(source)) offenders.push({ file: name, literal });
  }
  return { scanned, offenders, unreadable: false };
}
