import path from "node:path";
import {
  assertPathBoundary,
  capturePathBoundary,
  checkedReadFile,
  checkedRemove,
  decompile,
  disposeTarget,
  sourceState,
  targetAssembly,
  validate,
} from "./lib/stardew-portfolio-sleep-day-source-boundary.mjs";

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? undefined : process.argv[i + 1];
};
const gamePath = arg("--game-path") || process.env.GAMEBUDDY_STARDEW_GAME_PATH,
  manifest = arg("--manifest");
if (!manifest) {
  console.error("Usage: --game-path <path> --manifest <json>");
  process.exitCode = 2;
} else {
  let target;
  try {
    const resolvedManifest = path.resolve(manifest),
      manifestBoundary = await capturePathBoundary(resolvedManifest, "manifest_path_invalid");
    const model = JSON.parse(await checkedReadFile(resolvedManifest, "manifest_path_invalid", "utf8"));
    await assertPathBoundary(manifestBoundary, "manifest_path_invalid");
    target = await targetAssembly(gamePath);
    const d = await decompile(target);
    try {
      const state = await sourceState(d.output);
      await assertPathBoundary(manifestBoundary, "manifest_path_invalid");
      console.log(JSON.stringify({ state: "verified_blocked_boundary", ...validate(model, state, d.tool.payload) }));
    } finally {
      await checkedRemove(d.output, "decompile_cleanup_failed");
    }
  } catch (e) {
    console.error(`${e.code || "sleep_day_source_boundary_check_failed"}: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await disposeTarget(target);
  }
}
