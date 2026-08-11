#!/usr/bin/env node
/**
 * Inspect a real, locally installed pinned Stardew target and emit a
 * non-runtime gameplay-surface candidate report.
 *
 * The game directory is an input only. The inspector never edits it, never
 * loads a save, never starts the game, and never grants an action. It refuses
 * to report an inspection for a mismatched target assembly.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectStardewGameplaySurface } from "./lib/stardew-gameplay-surface-inspector.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  process.stderr.write([
    "Usage: node tools/inspect-stardew-gameplay-surface.mjs --game-path <absolute-path> [--out <file>] [--pretty]",
    "The target path may also be supplied through GAMEBUDDY_STARDEW_GAME_PATH.",
  ].join("\n") + "\n");
}

const gamePath = argument("--game-path") || process.env.GAMEBUDDY_STARDEW_GAME_PATH;
const outputPath = argument("--out");
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  usage();
  process.exit(0);
}
if (!gamePath) {
  usage();
  process.stderr.write("game_path_required: provide --game-path or GAMEBUDDY_STARDEW_GAME_PATH.\n");
  process.exit(2);
}

try {
  const report = await inspectStardewGameplaySurface({ gamePath: path.resolve(gamePath) });
  const text = `${JSON.stringify(report, null, process.argv.includes("--pretty") ? 2 : 0)}\n`;
  if (outputPath) await writeFile(path.resolve(outputPath), text, "utf8");
  else process.stdout.write(text);
} catch (error) {
  process.stderr.write(`${error.code || "stardew_gameplay_surface_inspection_failed"}: ${error.message}\n`);
  process.exitCode = 1;
}
