import path from "node:path";
import {
  assertPathBoundary,
  capturePathBoundary,
  checkedAtomicWrite,
  checkedRemove,
  decompile,
  derive,
  disposeTarget,
  targetAssembly,
} from "./lib/stardew-portfolio-sleep-day-source-boundary.mjs";

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? undefined : process.argv[i + 1];
};
const gamePath = arg("--game-path") || process.env.GAMEBUDDY_STARDEW_GAME_PATH,
  output = arg("--out");
if (!output) {
  console.error("Usage: --game-path <path> --out <json> (the output parent must already exist)");
  process.exitCode = 2;
} else {
  let target;
  try {
    const resolved = path.resolve(output),
      outputParent = await capturePathBoundary(path.dirname(resolved), "output_path_invalid");
    target = await targetAssembly(gamePath);
    const d = await decompile(target);
    try {
      const model = await derive(target, d.output, d.tool);
      await checkedAtomicWrite(resolved, `${JSON.stringify(model, null, 2)}\n`, "output_path_invalid");
      await assertPathBoundary(outputParent, "output_path_invalid");
      console.log(
        JSON.stringify({
          state: model.conclusion.attestationState,
          blockerCode: model.conclusion.blockerCode,
          anchorCount: model.anchors.length,
          fileCount: model.sourceManifest.fileCount,
        }),
      );
    } finally {
      await checkedRemove(d.output, "decompile_cleanup_failed");
    }
  } catch (e) {
    console.error(`${e.code || "sleep_day_source_boundary_failed"}: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await disposeTarget(target);
  }
}
