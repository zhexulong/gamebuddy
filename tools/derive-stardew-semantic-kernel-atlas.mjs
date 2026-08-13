#!/usr/bin/env node
/**
 * Produce a whole-game, source-first semantic-kernel discovery atlas from a
 * locally attested pinned Stardew installation. This remains a static audit:
 * it never launches the game or grants/executes a GameBuddy action.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectStardewGameplaySurface } from "./lib/stardew-gameplay-surface-inspector.mjs";
import { deriveStardewSemanticKernelAtlas } from "./lib/stardew-source-semantic-kernel-atlas.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  process.stderr.write(
    [
      "Usage: node tools/derive-stardew-semantic-kernel-atlas.mjs --game-path <absolute-path> [--out <file>] [--pretty]",
      "The target path may also be supplied through GAMEBUDDY_STARDEW_GAME_PATH.",
    ].join("\n") + "\n",
  );
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
  const inspection = await inspectStardewGameplaySurface({ gamePath: path.resolve(gamePath) });
  const atlas = deriveStardewSemanticKernelAtlas(inspection);
  const text = `${JSON.stringify(atlas, null, process.argv.includes("--pretty") ? 2 : 0)}\n`;
  if (outputPath) await writeFile(path.resolve(outputPath), text, "utf8");
  else process.stdout.write(text);
} catch (error) {
  process.stderr.write(`${error.code || "stardew_semantic_kernel_atlas_failed"}: ${error.message}\n`);
  process.exitCode = 1;
}
