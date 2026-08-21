import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  decompile,
  disposeTarget,
  sourceState,
  targetAssembly,
  validate,
} from "./lib/stardew-portfolio-m9-accept-special-order-source-boundary.mjs";

const value = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const gamePath = value("--game-path") || process.env.GAMEBUDDY_STARDEW_GAME_PATH;
const manifest = value("--manifest");
if (!manifest) {
  console.error("Usage: --game-path <path> --manifest <redacted-json>");
  process.exitCode = 2;
} else {
  let target;
  try {
    target = await targetAssembly(gamePath);
    const authority = await readFile("tools/stardew-portfolio-m9-special-order-action-contract.json");
    const model = JSON.parse(await readFile(path.resolve(manifest), "utf8"));
    const decompiled = await decompile(target);
    try {
      console.log(
        JSON.stringify({
          state: "verified_blocked_boundary",
          ...validate(
            model,
            createHash("sha256").update(authority).digest("hex"),
            await sourceState(decompiled.output),
            decompiled.tool.payload,
          ),
        }),
      );
    } finally {
      await rm(decompiled.output, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`${error.code || "m9_accept_source_boundary_check_failed"}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await disposeTarget(target);
  }
}
