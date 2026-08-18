import { rm } from "node:fs/promises";
import path from "node:path";
import {
  actionContractAuthorityHash,
  decompile,
  derive,
  disposeTargetAssembly,
  readContainedFile,
  sourceState,
  targetAssembly,
  writeVerifiedAtomicJson,
} from "./lib/stardew-portfolio-m10-donate-museum-source-boundary.mjs";

const value = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const gamePath = value("--game-path") || process.env.GAMEBUDDY_STARDEW_GAME_PATH;
const out = value("--out");

if (!out) {
  console.error("Usage: --game-path <path> --out <redacted-json>");
  process.exitCode = 2;
} else
  try {
    const target = await targetAssembly(gamePath);
    try {
      const projectRoot = path.resolve(".");
      const contractPath = path.resolve(projectRoot, "tools/stardew-portfolio-m10-museum-action-contract.json");
      const contract = await readContainedFile(projectRoot, contractPath, {
        missingCode: "contract_missing",
        reparseCode: "contract_reparse_detected",
      });
      const decompiled = await decompile(target);
      try {
        const model = derive(
          target,
          await sourceState(decompiled.output),
          actionContractAuthorityHash(contract),
          new Date().toISOString(),
        );
        await writeVerifiedAtomicJson(out, model);
        console.log(
          JSON.stringify({
            state: "blocked_boundary_attested",
            primitive: model.primitive,
            blockerCode: model.conclusion.blockerCode,
            fileCount: model.sourceManifest.fileCount,
            anchorCount: model.anchors.length,
          }),
        );
      } finally {
        await rm(decompiled.output, { recursive: true, force: true });
      }
    } finally {
      await disposeTargetAssembly(target);
    }
  } catch (error) {
    console.error(`${error.code || "m10_source_boundary_failed"}: ${error.message}`);
    process.exitCode = 1;
  }
