import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  decompile,
  derive,
  disposeTarget,
  targetAssembly,
} from "./lib/stardew-portfolio-m9-accept-special-order-source-boundary.mjs";
const value = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const gamePath = value("--game-path") || process.env.GAMEBUDDY_STARDEW_GAME_PATH;
const output = value("--out");
if (!output) {
  console.error("Usage: --game-path <path> --out <redacted-json>");
  process.exitCode = 2;
} else {
  let target;
  try {
    target = await targetAssembly(gamePath);
    const authority = await readFile("tools/stardew-portfolio-m9-special-order-action-contract.json");
    const decompiled = await decompile(target);
    try {
      const model = await derive(
        target,
        decompiled.output,
        createHash("sha256").update(authority).digest("hex"),
        decompiled.tool,
      );
      const resolved = path.resolve(output);
      await mkdir(path.dirname(resolved), { recursive: true });
      const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(model, null, 2)}\n`, { flag: "wx" });
        await rename(temporary, resolved);
      } finally {
        await rm(temporary, { force: true });
      }
      console.log(
        JSON.stringify({
          state: "blocked_attested",
          blockerCode: model.conclusion.blockerCode,
          anchorCount: model.anchors.length,
          fileCount: model.sourceManifest.fileCount,
        }),
      );
    } finally {
      await rm(decompiled.output, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`${error.code || "m9_accept_source_boundary_failed"}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await disposeTarget(target);
  }
}
