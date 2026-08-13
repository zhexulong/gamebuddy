import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { deriveSoilInteractionTransitionModel, sourceManifestForSoilItm } from "./lib/stardew-soil-itm-canary.mjs";

const REQUIRED_SOURCE_PATHS = [
  "StardewValley/Tools/Hoe.cs",
  "StardewValley/Object.cs",
  "StardewValley/Utility.cs",
  "StardewValley/TerrainFeatures/HoeDirt.cs",
  "StardewValley/Tools/WateringCan.cs",
  "StardewValley/Crop.cs",
];

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}.`);
    args.set(token.slice(2), value);
    index += 1;
  }
  return args;
}

function safeRelativePath(root, absolutePath) {
  const path = relative(root, absolutePath).split(sep).join("/");
  if (path.startsWith("../") || path === ".." || path.length === 0)
    throw new Error(`Source path escapes source root: ${absolutePath}`);
  return path;
}

async function readRequiredSources(sourceRoot) {
  const sources = {};
  for (const relativePath of REQUIRED_SOURCE_PATHS) {
    const absolutePath = resolve(sourceRoot, relativePath);
    safeRelativePath(sourceRoot, absolutePath);
    sources[relativePath] = await readFile(absolutePath, "utf8");
  }
  return sources;
}

async function atomicJson(outPath, value) {
  await mkdir(dirname(outPath), { recursive: true });
  const tempPath = `${outPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, outPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = resolve(args.get("source-root") ?? ".tmp-stardew-decompile");
  const modelPath = resolve(args.get("model") ?? "tools/stardew-soil-itm-canary.model.json");
  const outPath = resolve(args.get("out") ?? ".worktree/stardew-soil-itm-canary-report.json");
  const sourceFiles = await readRequiredSources(sourceRoot);
  const rawModel = JSON.parse(await readFile(modelPath, "utf8"));
  rawModel.sourceManifestSha256 = sourceManifestForSoilItm(sourceFiles).sha256;
  const report = deriveSoilInteractionTransitionModel({ sourceFiles, model: rawModel });
  await atomicJson(outPath, report);
  process.stdout.write(
    `${JSON.stringify({ canaryId: report.canaryId, coverage: report.coverage, outPath }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.code ?? "soil_itm_derivation_failed"}: ${error.message}\n`);
  process.exitCode = 1;
});
