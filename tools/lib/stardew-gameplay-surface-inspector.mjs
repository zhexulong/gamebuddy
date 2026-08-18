import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyGameplayMember,
  classifyUiSurface,
  contentAssetIsGameplayRelevant,
  contentAssetMappingStatus,
  contentOperationDomain,
  classifyDataLoaderTable,
  dataLoaderAssetPath,
  hasUiInputMethods,
  isGameplayType,
  isUiInputMethod,
  logicalContentAssetPath,
  logicalContentOperationFamily,
} from "./stardew-gameplay-surface-rules.mjs";
import { extractLiteralOperationSelectors } from "./stardew-gameplay-surface-selector.mjs";
import { buildPlayerCommandGraph } from "./stardew-player-command-graph.mjs";
import { auditBridgeRouteEquivalence } from "./stardew-player-command-equivalence-audit.mjs";

const EXPECTED_VERSION = "1.6.15";
const EXPECTED_BUILD = 24356;
const EXPECTED_ASSEMBLY_VERSION = "1.6.15.24356";
const ASSEMBLY_NAME = "Stardew Valley.dll";
const execFileAsync = promisify(execFile);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

function parseVersion(resourceText) {
  const fileVersion = resourceText.match(/FileVersion\s*:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null;
  const productVersion = resourceText.match(/ProductVersion\s*:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null;
  return { fileVersion, productVersion };
}

async function findSourceFiles(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) await findSourceFiles(root, full, output);
    else if (entry.isFile() && entry.name.endsWith(".cs")) output.push(full);
  }
  return output;
}

function typeBlock(source, fullTypeName) {
  const shortName = fullTypeName.split(".").at(-1);
  const pattern = new RegExp(
    `(?:class|struct|interface|enum)\\s+${shortName}\\b[\\s\\S]*?(?=\\n(?:public |internal |private |protected |class |struct |interface |enum )|\\s*$)`,
  );
  return source.match(pattern)?.[0] ?? "";
}

function methodsFromSource(source, fullTypeName) {
  const block = typeBlock(source, fullTypeName);
  if (!block) return [];
  const shortName = fullTypeName.split(".").at(-1);
  const methods = new Set();
  const pattern =
    /\b(?:public|private|protected|internal|protected\s+internal|private\s+protected)?\s*(?:static\s+|virtual\s+|override\s+|abstract\s+|sealed\s+|async\s+)*[A-Za-z_][\w<>,.?\[\]]*\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:\{|=>)/g;
  for (const match of block.matchAll(pattern)) {
    // A constructor is not a player-reachable operation by itself.
    if (match[1] !== shortName) methods.add(match[1]);
  }
  return [...methods].sort();
}

function typeNameFromSourcePath(sourceRoot, sourcePath) {
  const relative = path.relative(sourceRoot, sourcePath).replaceAll(path.sep, "/");
  if (!relative.startsWith("StardewValley/") || !relative.endsWith(".cs")) return null;
  return relative.slice(0, -3).replaceAll("/", ".");
}

async function discoverGameplaySources(sourceRoot) {
  const files = await findSourceFiles(sourceRoot);
  const sources = [];
  for (const file of files.sort()) {
    const typeName = typeNameFromSourcePath(sourceRoot, file);
    if (!typeName || !isGameplayType(typeName)) continue;
    sources.push({
      typeName,
      file,
      sourceFile: path.relative(sourceRoot, file).replaceAll(path.sep, "/"),
    });
  }
  return sources;
}

async function inspectInstalledAssembly(gamePath) {
  const assemblyPath = path.join(gamePath, ASSEMBLY_NAME);
  let file;
  try {
    file = await stat(assemblyPath);
  } catch {
    fail("target_assembly_missing", `Missing ${ASSEMBLY_NAME} under the supplied game path.`);
  }
  const hash = await sha256(assemblyPath);
  let resourceText = "";
  try {
    const result = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$p = $env:GAMEBUDDY_INSPECT_ASSEMBLY; (Get-Item -LiteralPath $p).VersionInfo | Format-List FileVersion,ProductVersion",
      ],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        env: { ...process.env, GAMEBUDDY_INSPECT_ASSEMBLY: assemblyPath },
      },
    );
    resourceText = result.stdout || "";
  } catch (error) {
    fail("assembly_metadata_unavailable", `Could not read Windows file metadata for ${ASSEMBLY_NAME}.`, {
      cause: error.message,
    });
  }
  const versions = parseVersion(resourceText);
  if (versions.fileVersion !== `${EXPECTED_VERSION}.${EXPECTED_BUILD}`) {
    fail(
      "target_installation_mismatch",
      `Expected Stardew ${EXPECTED_VERSION} build ${EXPECTED_BUILD}; got file version ${versions.fileVersion ?? "unknown"}.`,
      versions,
    );
  }
  return {
    relativePath: ASSEMBLY_NAME,
    lengthBytes: file.size,
    sha256: hash,
    fileVersion: versions.fileVersion,
    productVersion: versions.productVersion,
    assemblyVersion: EXPECTED_ASSEMBLY_VERSION,
  };
}

async function decompileAssembly(assemblyPath) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-stardew-surface-"));
  const ilspyPath = process.env.ILSPYCMD_PATH || "ilspycmd";
  const options = ["--disable-updatecheck", "-p", "--nested-directories"];
  const configurationDigest = createHash("sha256")
    .update(JSON.stringify({ tool: "ilspycmd", options, outputLayout: "nested-directories", target: ASSEMBLY_NAME }))
    .digest("hex");
  try {
    const versionResult = await execFileAsync(ilspyPath, ["--version"], { encoding: "utf8", maxBuffer: 64 * 1024 });
    await execFileAsync(ilspyPath, [...options, "-o", outputRoot, assemblyPath], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
    });
    return {
      outputRoot,
      tool: "ilspycmd",
      toolVersion: (versionResult.stdout || "").trim().split(/\r?\n/)[0] || "unknown",
      configurationDigest,
    };
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    fail("assembly_decompilation_failed", "Could not decompile the supplied target assembly with ilspycmd.", {
      cause: error.message,
    });
  }
}

async function inspectSourceSnapshot(sourceRoot) {
  const files = await findSourceFiles(sourceRoot);
  const records = [];
  for (const file of files.sort()) {
    records.push(`${path.relative(sourceRoot, file).replaceAll(path.sep, "/")}\t${await sha256(file)}`);
  }
  return {
    root: sourceRoot,
    fileCount: records.length,
    contentManifestSha256: createHash("sha256")
      .update(`${records.join("\n")}\n`)
      .digest("hex"),
  };
}

const contentProbeProject = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../stardew-content-probe/ContentProbe.csproj",
);

async function probeTargetContent(gamePath) {
  try {
    const result = await execFileAsync("dotnet", ["run", "--project", contentProbeProject, "--", gamePath], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      cwd: path.dirname(contentProbeProject),
    });
    const output = (result.stdout || "").trim();
    const parsed = JSON.parse(output);
    if (
      parsed?.state !== "probed" ||
      parsed?.gameAssemblyVersion !== EXPECTED_ASSEMBLY_VERSION ||
      !Array.isArray(parsed?.tables)
    ) {
      fail("content_probe_invalid", "Target-game DataLoader probe returned an invalid report.");
    }
    return parsed;
  } catch (error) {
    if (error.code && error.code.startsWith("content_probe")) throw error;
    fail("content_probe_failed", "Could not load target-game DataLoader tables from the supplied installation.", {
      cause: error.message,
    });
  }
}

function classifyProbedTables(probe) {
  return probe.tables.map((table) => {
    const classification =
      table.state === "loaded"
        ? classifyDataLoaderTable(table.method)
        : { mappingStatus: "needs_expansion", semanticKind: "content_probe_failed" };
    return {
      method: table.method,
      assetPath: dataLoaderAssetPath(table.method),
      state: table.state,
      count: table.count ?? null,
      keySample: Array.isArray(table.keySample) ? table.keySample : [],
      returnType: table.returnType ?? null,
      ...classification,
    };
  });
}

async function inspectContent(gamePath) {
  const contentRoot = path.join(gamePath, "Content");
  const hashesPath = path.join(contentRoot, "ContentHashes.json");
  let contentHashes = {};
  try {
    contentHashes = JSON.parse(await readFile(hashesPath, "utf8"));
  } catch {
    fail("content_manifest_missing", "Missing or invalid Content/ContentHashes.json.");
  }
  const relevantAssetFiles = Object.keys(contentHashes).filter(contentAssetIsGameplayRelevant).sort();
  const relevantAssets = [...new Set(relevantAssetFiles.map(logicalContentAssetPath))].sort();
  const relevantAssetManifestSha256 = createHash("sha256")
    .update(`${relevantAssets.join("\\n")}\\n`)
    .digest("hex");
  const operationFamilies = new Map();
  for (const assetPath of relevantAssets) {
    const operationFamily = logicalContentOperationFamily(assetPath);
    const entry = operationFamilies.get(operationFamily) ?? {
      operationFamily,
      assetCount: 0,
      sampleAssets: [],
      mappingStatus: "needs_expansion",
      semanticKinds: new Set(),
      keyDomains: [],
    };
    entry.assetCount += 1;
    if (entry.sampleAssets.length < 8) entry.sampleAssets.push(assetPath);
    const domain = contentOperationDomain(assetPath);
    if (
      !entry.keyDomains.some(
        (candidate) => candidate.domainKind === domain.domainKind && candidate.keyDomain === domain.keyDomain,
      )
    ) {
      entry.keyDomains.push(domain);
    }
    entry.semanticKinds.add(contentAssetMappingStatus(assetPath).semanticKind ?? "content_operation");
    operationFamilies.set(operationFamily, entry);
  }
  const contentOperationFamilies = [...operationFamilies.values()]
    .map(({ semanticKinds, ...entry }) => ({
      ...entry,
      keyDomains: entry.keyDomains.sort((left, right) =>
        `${left.domainKind}:${left.keyDomain}`.localeCompare(`${right.domainKind}:${right.keyDomain}`),
      ),
      semanticKinds: [...semanticKinds].sort(),
    }))
    .sort((left, right) => left.operationFamily.localeCompare(right.operationFamily));
  return {
    contentRoot: "Content",
    contentHashesSha256: await sha256(hashesPath),
    contentHashesCount: Object.keys(contentHashes).length,
    relevantAssetFileCount: relevantAssetFiles.length,
    relevantAssetCount: relevantAssets.length,
    relevantAssetManifestSha256,
    relevantAssets,
    relevantAssetNodes: relevantAssets.map((assetPath) => ({ assetPath, ...contentAssetMappingStatus(assetPath) })),
    contentOperationFamilies,
    contentOperationFamilyCount: contentOperationFamilies.length,
    unmappedRelevantAssetCount: contentOperationFamilies.length,
  };
}

export async function inspectStardewGameplaySurface({ gamePath } = {}) {
  if (!gamePath)
    fail(
      "game_path_required",
      "Provide gamePath or GAMEBUDDY_STARDEW_GAME_PATH; no implicit installation scan is allowed.",
    );
  const resolvedGamePath = path.resolve(gamePath);
  const assemblyPath = path.join(resolvedGamePath, ASSEMBLY_NAME);
  const assembly = await inspectInstalledAssembly(resolvedGamePath);
  const decompilation = await decompileAssembly(assemblyPath);
  try {
    const sourceFiles = await discoverGameplaySources(decompilation.outputRoot);
    const members = [];
    for (const source of sourceFiles) {
      const sourceText = await readFile(source.file, "utf8");
      const methods = methodsFromSource(sourceText, source.typeName);
      const uiSurface = classifyUiSurface(source.typeName, methods);
      if (uiSurface) {
        members.push({
          typeName: source.typeName,
          sourceFile: source.sourceFile,
          methodName: "<ui-surface>",
          observedMethods: methods.filter((methodName) => isUiInputMethod(methodName)),
          ...uiSurface,
        });
      }
      for (const methodName of methods) {
        const classification = classifyGameplayMember(source.typeName, methodName);
        if (classification) {
          const member = {
            typeName: source.typeName,
            sourceFile: source.sourceFile,
            methodName,
            ...classification,
          };
          members.push(member);
          if (
            classification.mappingStatus === "needs_expansion" &&
            ["performAction", "answerDialogueAction", "answerDialogue", "checkAction"].includes(methodName)
          ) {
            for (const selector of extractLiteralOperationSelectors(sourceText, methodName)) {
              members.push({
                typeName: source.typeName,
                sourceFile: source.sourceFile,
                methodName,
                operationSelector: selector.selector,
                operationSelectorKind: selector.selectorKind,
                mappingStatus: "needs_expansion",
                basisPrimitiveIds: [],
                semanticKind: methodName.startsWith("answerDialogue")
                  ? "dialogue_operation"
                  : "native_operation_selector",
                parentNode: `${source.typeName}.${methodName}`,
              });
            }
          }
        }
      }
    }
    const game1Source = sourceFiles.find((source) => source.typeName === "StardewValley.Game1");
    const relevantGraphTypes = new Set([
      "StardewValley.Game1",
      "StardewValley.GameLocation",
      "StardewValley.Farmer",
      "StardewValley.Tool",
      "StardewValley.Tools.Axe",
      "StardewValley.Tools.Pickaxe",
      "StardewValley.Tools.Hoe",
      "StardewValley.Tools.WateringCan",
      "StardewValley.Tools.FishingRod",
      "StardewValley.Tools.Pan",
      "StardewValley.Tools.MeleeWeapon",
    ]);
    const sourceIndex = Object.fromEntries(
      await Promise.all(
        sourceFiles
          .filter((source) => relevantGraphTypes.has(source.typeName))
          .map(async (source) => [
            source.typeName,
            { source: await readFile(source.file, "utf8"), sourceFile: source.sourceFile },
          ]),
      ),
    );
    const playerCommandGraph = game1Source
      ? // Game1 contains several partial declarations in the decompiler output.
        // Reassemble them deterministically so ingress methods such as
        // updateActiveMenu are not silently treated as absent.
        buildPlayerCommandGraph(
          (
            await Promise.all(
              sourceFiles
                .filter((source) => source.typeName === "StardewValley.Game1")
                .sort((left, right) => left.sourceFile.localeCompare(right.sourceFile))
                .map((source) => readFile(source.file, "utf8")),
            )
          ).join("\n\n"),
          { sourceFile: game1Source.sourceFile, sourceIndex },
        )
      : {
          schemaVersion: 1,
          state: "unknown",
          rootMethod: "StardewValley.Game1.UpdateControlInput",
          sourceFile: "StardewValley/Game1.cs",
          errors: ["Target source reconstruction did not contain StardewValley.Game1."],
          ingressRoots: [],
          commandPaths: [],
          supportingPaths: [],
          nonGameplayPaths: [],
          unknownReachableEdges: [{ reason: "game1_source_missing" }],
          pendingCommandCandidates: [],
        };
    const bridgeSource = await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../integrations/stardew/ExecutionManager.cs"),
      "utf8",
    );
    const bridgeEquivalenceAudit = auditBridgeRouteEquivalence(bridgeSource);
    const content = await inspectContent(resolvedGamePath);
    const dataLoaderProbe = await probeTargetContent(resolvedGamePath);
    const dataLoaderTables = classifyProbedTables(dataLoaderProbe);
    const sourceSnapshot = await inspectSourceSnapshot(decompilation.outputRoot);
    return {
      state: "inspected",
      target: { game: "Stardew Valley", version: EXPECTED_VERSION, build: EXPECTED_BUILD },
      assembly,
      attestation: { extractedAtUtc: new Date().toISOString() },
      decompilation: {
        tool: decompilation.tool,
        toolVersion: decompilation.toolVersion,
        configurationDigest: decompilation.configurationDigest,
      },
      sourceSnapshot: {
        fileCount: sourceSnapshot.fileCount,
        gameplaySourceFileCount: sourceFiles.length,
        contentManifestSha256: sourceSnapshot.contentManifestSha256,
      },
      playerCommandGraph,
      bridgeEquivalenceAudit,
      staticGameplayNodes: members,
      staticGameplayNodeCount: members.length,
      mappedCount: members.filter((member) => member.mappingStatus === "mapped").length,
      needsExpansionCount: members.filter((member) => member.mappingStatus === "needs_expansion").length,
      supportingTransitionCount: members.filter((member) => member.mappingStatus === "not_surface").length,
      content,
      dataLoaderProbe: {
        gameAssemblyVersion: dataLoaderProbe.gameAssemblyVersion,
        dataLoaderType: dataLoaderProbe.dataLoaderType,
        tableCount: dataLoaderProbe.tableCount,
        toolContent: dataLoaderProbe.toolContent ?? null,
        tables: dataLoaderTables,
        gameplayTableCount: dataLoaderTables.filter((table) => table.semanticKind !== "supporting_content_data").length,
        pendingGameplayTableCount: dataLoaderTables.filter((table) => table.mappingStatus === "needs_expansion").length,
      },

      note: "Static assembly/content inspection is source evidence for a Player-Reachable Command Path graph. Target-game DataLoader tables and literal selectors are direct discovery inputs; they neither grant actions nor constitute completeness until ingress-reachable paths, typed bridge routes, and native rule boundaries are fully classified. Bridge-equivalence audit findings are diagnostic gaps, not publication or live-gate outcomes.",
    };
  } finally {
    await rm(decompilation.outputRoot, { recursive: true, force: true });
  }
}
