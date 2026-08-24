import { rm } from "node:fs/promises";
import path from "node:path";
import {
  actionContractAuthorityHash,
  decompile,
  disposeTargetAssembly,
  readContainedFile,
  sourceState,
  targetAssembly,
  validate,
} from "./lib/stardew-portfolio-m10-donate-museum-source-boundary.mjs";

const value = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const gamePath = value("--game-path") || process.env.GAMEBUDDY_STARDEW_GAME_PATH,
  manifestPath = value("--manifest");
if (!manifestPath) {
  console.error("Usage: --game-path <path> --manifest <redacted-json>");
  process.exitCode = 2;
} else
  try {
    const target = await targetAssembly(gamePath);
    try {
      const projectRoot = path.resolve("."),
        contractPath = path.resolve(projectRoot, "tools/stardew-portfolio-m10-museum-action-contract.json"),
        resolvedManifest = path.resolve(manifestPath),
        contract = await readContainedFile(projectRoot, contractPath, {
          missingCode: "contract_missing",
          reparseCode: "contract_reparse_detected",
        }),
        contractHash = actionContractAuthorityHash(contract),
        decompiled = await decompile(target);
      try {
        const model = JSON.parse(
          await readContainedFile(path.parse(resolvedManifest).root, resolvedManifest, {
            missingCode: "artifact_missing",
            reparseCode: "artifact_reparse_detected",
          }),
        );
        console.log(
          JSON.stringify({
            state: "verified_blocked_boundary",
            ...validate(model, contractHash, await sourceState(decompiled.output), decompiled.output),
          }),
        );
      } finally {
        await rm(decompiled.output, { recursive: true, force: true });
      }
    } finally {
      await disposeTargetAssembly(target);
    }
  } catch (error) {
    console.error(`${error.code || "m10_source_boundary_check_failed"}: ${error.message}`);
    process.exitCode = 1;
  }
