#!/usr/bin/env node
/** Independently re-decompile and verify the redacted M8 elevator realization dossier. */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verify } from "./stardew-portfolio-m8-elevator-source-realization.mjs";

function fail(message) {
  throw new Error(message);
}
function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (
      !argv[index]?.startsWith("--") ||
      !argv[index + 1] ||
      argv[index + 1].startsWith("--") ||
      Object.hasOwn(values, argv[index])
    )
      fail("Usage: --game-path <path> --dossier <dossier>.");
    values[argv[index]] = argv[index + 1];
  }
  if (Object.keys(values).length !== 2 || !values["--game-path"] || !values["--dossier"])
    fail("Usage: --game-path <path> --dossier <dossier>.");
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = args(process.argv.slice(2));
    const result = await verify({ gamePath: input["--game-path"], dossierPath: input["--dossier"] });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`check-stardew-portfolio-m8-elevator-source-realization: ${error.message}`);
    process.exitCode = 1;
  }
}
