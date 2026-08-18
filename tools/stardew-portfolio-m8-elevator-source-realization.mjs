#!/usr/bin/env node
/** Exact-target, redacted source realization for the M8 elevator primitive only. */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ACTION = "select_mine_elevator_floor";
const TOPOLOGY = "single_player_native_companion";
const ASSEMBLY = "Stardew Valley.dll";
const TARGET = Object.freeze({
  relativeFileName: ASSEMBLY,
  fileVersion: "1.6.15.24356",
  productVersion: "1.6.15.24356",
  length: 6268416,
  sha256: "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee",
});
const OPTIONS = Object.freeze(["--disable-updatecheck", "-p", "--nested-directories"]);
const TOOL_VERSION = "ilspycmd: 9.1.0.7988";
const TOOL_SHA256 = "5da34ef8b7a3d7e2057d27a0a84ec8e1ccdddb35d6d519058fce1e2f374c4c7f";
const TOOL_INSTALL_RELATIVE_PATH = ".dotnet/tools/ilspycmd.exe";
const TOOL_PAYLOAD_INSTALL_RELATIVE_PATH =
  ".dotnet/tools/.store/ilspycmd/9.1.0.7988/ilspycmd/9.1.0.7988/tools/net8.0/any";
const TOOL_PAYLOAD_FILE_COUNT = 59;
const TOOL_PAYLOAD_CANONICAL_SHA256 = "4bfe5d499f00ffe9373d400ab68a069b8fed079a96ae3aaa7804423f0eba80ea";
const SNAPSHOT_THREAT_BOUNDARY =
  "The input DLL is copied into a newly created Windows private temporary directory with inheritance removed and access restricted to the current user and SYSTEM; each snapshot root/file is rejected if it is a reparse point and its lstat identity, resolved path, size, and hash must match immediately before and after decompilation. This fails closed for observed drift, reparse substitution, and replacement by principals outside that private ACL. It does not claim resistance to malicious code already executing as this process/current user (which can alter ACLs or race a pathname open), kernel compromise, or a compromised .NET host.";
const CONTRACT = "fixtures/stardew/portfolio-m8-elevator-contract.example.json";
const HASH = /^[a-f0-9]{64}$/;
const ROOT_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "realizationId",
  "actionId",
  "topology",
  "target",
  "decompiler",
  "sourceManifest",
  "primitiveContract",
  "anchors",
  "semanticBoundary",
  "provenanceBoundary",
  "conclusion",
]);
const ANCHORS = Object.freeze([
  {
    anchorId: "mine_elevator_presentation",
    relativePath: "StardewValley/Locations/MineShaft.cs",
    locate: "public override bool checkAction",
    needle: "Game1.activeClickableMenu = new MineElevatorMenu();",
    semanticRole: "elevator_presentation_guard_and_menu_construction",
  },
  {
    anchorId: "mine_elevator_finite_checkpoint_materialization",
    relativePath: "StardewValley/Menus/MineElevatorMenu.cs",
    locate: "public MineElevatorMenu()",
    needle: "Math.Min(MineShaft.lowestLevelReached, 120) / 5",
    semanticRole: "finite_unlocked_five_floor_checkpoint_materialization",
  },
  {
    anchorId: "mine_elevator_selection_commit",
    relativePath: "StardewValley/Menus/MineElevatorMenu.cs",
    locate: "public override void receiveLeftClick",
    needle: "Game1.enterMine(Convert.ToInt32(elevator.name));",
    semanticRole: "materialized_selection_and_current_floor_guarded_native_commit",
  },
  {
    anchorId: "mine_elevator_enter_mine_warp",
    relativePath: "StardewValley/Game1.cs",
    locate: "public static void enterMine(int whatLevel, int? forceLayout = null)",
    needle: "warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2);",
    semanticRole: "native_enter_mine_warp_delegation",
  },
]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const manifestHash = (files) =>
  sha256(`${files.map(({ relativePath, sha256: digest }) => `${relativePath}\t${digest}`).join("\n")}\n`);
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_dossier", `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail("invalid_dossier", `${label} has unknown or missing fields.`);
}
function safeRelative(relativePath) {
  return (
    typeof relativePath === "string" &&
    relativePath !== "" &&
    !path.isAbsolute(relativePath) &&
    !relativePath.includes("\\") &&
    relativePath.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(Object.assign(new Error(`${command} failed (${code}): ${stderr.trim()}`), { code: "command_failed" })),
    );
  });
}
function normalizeVersion(value) {
  const parts = String(value || "").match(/\d+/g);
  return parts?.length === 4 ? parts.join(".") : String(value || "").trim();
}
async function versionInfo(assembly) {
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "$p=$env:GAMEBUDDY_INSPECT_ASSEMBLY;(Get-Item -LiteralPath $p).VersionInfo | ConvertTo-Json -Compress",
    ],
    { ...process.env, GAMEBUDDY_INSPECT_ASSEMBLY: assembly },
  );
  return JSON.parse(stdout);
}
function assertTargetBytes(bytes) {
  if (bytes.length !== TARGET.length)
    fail("target_mismatch", "Target assembly length does not match the locked Stardew assembly.");
  const digest = sha256(bytes);
  if (digest !== TARGET.sha256)
    fail("target_mismatch", "Target assembly hash does not match the locked Stardew assembly.");
  return digest;
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function resolveLockedToolPath(home = os.homedir()) {
  if (typeof home !== "string" || !path.isAbsolute(home))
    fail("tool_install_path_invalid", "The fixed ilspycmd home path is invalid.");
  return path.join(home, ...TOOL_INSTALL_RELATIVE_PATH.split("/"));
}
function resolveLockedPayloadRoot(home = os.homedir()) {
  if (typeof home !== "string" || !path.isAbsolute(home))
    fail("tool_install_path_invalid", "The fixed ilspycmd home path is invalid.");
  return path.join(home, ...TOOL_PAYLOAD_INSTALL_RELATIVE_PATH.split("/"));
}
async function payloadState(root) {
  const visit = async (prefix = "") => {
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() =>
      fail("tool_payload_missing", "The fixed ilspycmd payload is missing."),
    );
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink())
          fail("tool_payload_reparse", `The fixed ilspycmd payload contains a reparse point: ${relativePath}`);
        if (entry.isDirectory()) return visit(relativePath);
        return entry.isFile()
          ? [relativePath]
          : fail("tool_payload_invalid", `The fixed ilspycmd payload contains a non-file entry: ${relativePath}`);
      }),
    );
    return nested.flat();
  };
  const files = (await visit()).sort();
  const manifest = await Promise.all(
    files.map(async (relativePath) => ({
      relativePath,
      sha256: sha256(await readFile(path.join(root, relativePath))),
    })),
  );
  return { fileCount: manifest.length, canonicalSha256: manifestHash(manifest) };
}
async function verifyLockedTool(tool) {
  const bytes = await readFile(tool.toolPath).catch(() =>
    fail("tool_missing", "The fixed installed ilspycmd executable is missing."),
  );
  if (sha256(bytes) !== TOOL_SHA256)
    fail("tool_hash_mismatch", "The fixed installed ilspycmd executable hash differs.");
  const payload = await payloadState(tool.payloadRoot);
  if (payload.fileCount !== TOOL_PAYLOAD_FILE_COUNT || payload.canonicalSha256 !== TOOL_PAYLOAD_CANONICAL_SHA256)
    fail("tool_payload_drift", "The fixed installed ilspycmd payload/dependency closure differs.");
  return tool;
}
async function lockedTool() {
  const tool = { toolPath: resolveLockedToolPath(), payloadRoot: resolveLockedPayloadRoot() };
  await verifyLockedTool(tool);
  const { stdout } = await run(tool.toolPath, ["--version"]);
  if (stdout.split(/\r?\n/)[0].trim() !== TOOL_VERSION)
    fail("decompiler_version_mismatch", "Locked ilspycmd version required.");
  return tool;
}
async function securePrivateDirectory(prefix) {
  const root = await mkdtemp(path.join(process.env.TEMP || os.tmpdir(), prefix));
  try {
    await run("icacls.exe", [
      root,
      "/inheritance:r",
      "/grant:r",
      `${process.env.USERNAME}:(OI)(CI)F`,
      "/grant:r",
      "SYSTEM:(OI)(CI)F",
    ]);
    return root;
  } catch {
    await rm(root, { recursive: true, force: true });
    fail("snapshot_private_acl_failed", "Could not establish the Windows private snapshot ACL.");
  }
}
async function snapshotIdentity(target) {
  const root = await lstat(target.snapshotRoot).catch(() =>
    fail("target_snapshot_missing", "Target snapshot root is missing."),
  );
  const file = await lstat(target.path).catch(() => fail("target_snapshot_missing", "Target snapshot is missing."));
  if (!root.isDirectory() || root.isSymbolicLink() || !file.isFile() || file.isSymbolicLink())
    fail("target_snapshot_reparse", "Target snapshot root or file is a reparse point.");
  const resolvedRoot = await realpath(target.snapshotRoot),
    resolvedFile = await realpath(target.path);
  if (!inside(resolvedRoot, resolvedFile))
    fail("target_snapshot_reparse", "Target snapshot resolved outside its private root.");
  return { rootDev: root.dev, rootIno: root.ino, fileDev: file.dev, fileIno: file.ino, resolvedRoot, resolvedFile };
}
export async function verifySnapshot(target) {
  if (
    !target ||
    typeof target !== "object" ||
    typeof target.path !== "string" ||
    typeof target.snapshotRoot !== "string" ||
    !inside(target.snapshotRoot, target.path)
  )
    fail("target_snapshot_invalid", "Target snapshot identity is invalid.");
  const identity = await snapshotIdentity(target);
  if (canonical(identity) !== canonical(target.identity))
    fail("target_snapshot_identity_drift", "Target snapshot identity drifted.");
  const details = await stat(target.path).catch(() => fail("target_snapshot_missing", "Target snapshot is missing."));
  const bytes = await readFile(target.path);
  const digest = assertTargetBytes(bytes);
  if (details.size !== TARGET.length || target.length !== TARGET.length || target.sha256 !== digest)
    fail("target_snapshot_drift", "Target snapshot drifted.");
  const versions = await versionInfo(target.path);
  if (
    normalizeVersion(versions.FileVersion) !== TARGET.fileVersion ||
    normalizeVersion(versions.ProductVersion) !== TARGET.productVersion
  )
    fail("target_version_mismatch", "Target snapshot version does not match the locked Stardew assembly.");
  return target;
}
export async function targetAssembly(gamePath) {
  if (!gamePath) fail("usage", "--game-path is required.");
  const root = path.resolve(gamePath);
  const assembly = path.resolve(root, ASSEMBLY);
  if (!assembly.startsWith(`${root}${path.sep}`)) fail("path_escape", "Assembly path escapes supplied game path.");
  await stat(assembly).catch(() => fail("target_missing", "Target assembly is missing."));
  const bytes = await readFile(assembly);
  const digest = assertTargetBytes(bytes);
  const snapshotRoot = await securePrivateDirectory("gamebuddy-m8-elevator-target-");
  const snapshotPath = path.join(snapshotRoot, ASSEMBLY);
  try {
    await writeFile(snapshotPath, bytes, { flag: "wx", mode: 0o444 });
    await chmod(snapshotPath, 0o444);
    const target = Object.freeze({
      path: snapshotPath,
      snapshotRoot,
      length: bytes.length,
      sha256: digest,
      identity: await snapshotIdentity({ path: snapshotPath, snapshotRoot }),
    });
    await verifySnapshot(target);
    return target;
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}
export async function disposeTargetAssembly(target) {
  if (target?.snapshotRoot) await rm(target.snapshotRoot, { recursive: true, force: true });
}
async function listCs(root, prefix = "") {
  const entries = await readdir(path.resolve(root, prefix), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        fail("source_tree_invalid", `Decompiler output contains a symbolic link: ${relativePath}`);
      if (entry.isDirectory()) return listCs(root, relativePath);
      return entry.isFile() && relativePath.endsWith(".cs") ? [relativePath] : [];
    }),
  );
  return nested.flat();
}
async function decompile(target) {
  await verifySnapshot(target);
  const output = await securePrivateDirectory("gamebuddy-m8-elevator-");
  try {
    const tool = await lockedTool();
    await verifyLockedTool(tool);
    await verifySnapshot(target);
    await run(tool.toolPath, [...OPTIONS, "-o", output, target.path]);
    await verifyLockedTool(tool);
    await verifySnapshot(target);
    const names = (await listCs(output)).sort();
    const files = await Promise.all(
      names.map(async (relativePath) => ({
        relativePath,
        sha256: sha256(await readFile(path.resolve(output, relativePath))),
      })),
    );
    if (!files.length) fail("source_manifest_empty", "Fresh decompile produced no C# source.");
    return { output, files, canonicalSha256: manifestHash(files) };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
function declarationStarts(source, locate) {
  const positions = [];
  for (let index = source.indexOf(locate); index >= 0; index = source.indexOf(locate, index + locate.length)) {
    const lineStart = source.lastIndexOf("\n", index - 1) + 1;
    let after = index + locate.length,
      body = -1;
    if (/^[\t ]*$/.test(source.slice(lineStart, index))) {
      for (; after < source.length; after += 1) {
        if (source[after] === "{") {
          body = after;
          break;
        }
        if (source[after] === ";" || source[after] === "}") break;
      }
    }
    if (body >= 0) positions.push(index);
  }
  return positions;
}
function bodyEnd(source, brace) {
  let depth = 0,
    state = "code";
  for (let index = brace; index < source.length; index += 1) {
    const current = source[index],
      next = source[index + 1];
    if (state === "line") {
      if (current === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "string") {
      if (current === "\\") index += 1;
      else if (current === '"') state = "code";
      continue;
    }
    if (state === "char") {
      if (current === "\\") index += 1;
      else if (current === "'") state = "code";
      continue;
    }
    if (current === "/" && next === "/") {
      state = "line";
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      state = "block";
      index += 1;
      continue;
    }
    if (current === '"') {
      state = "string";
      continue;
    }
    if (current === "'") {
      state = "char";
      continue;
    }
    if (current === "{") depth += 1;
    else if (current === "}" && --depth === 0) return index + 1;
  }
  fail("anchor_missing", "Required declaration is unterminated.");
}
function methodSlice(bytes, locate) {
  const source = bytes.toString("utf8");
  const starts = declarationStarts(source, locate);
  if (starts.length !== 1)
    fail("anchor_declaration_not_unique", `Required declaration is missing or non-unique: ${locate}`);
  const start = starts[0],
    brace = source.indexOf("{", start);
  if (brace < 0) fail("anchor_missing", `Required declaration has no body: ${locate}`);
  const end = bodyEnd(source, brace);
  return { startByte: Buffer.byteLength(source.slice(0, start)), endByte: Buffer.byteLength(source.slice(0, end)) };
}
function countBytes(bytes, needle) {
  let at = 0,
    matches = 0;
  const sought = Buffer.from(needle);
  while ((at = bytes.indexOf(sought, at)) >= 0) {
    matches += 1;
    at += sought.length;
  }
  return matches;
}
export function extractAnchors(sourceFiles) {
  return ANCHORS.map((expected) => {
    const bytes = sourceFiles[expected.relativePath];
    if (!Buffer.isBuffer(bytes)) fail("source_missing", `Required source unavailable: ${expected.relativePath}`);
    const range = methodSlice(bytes, expected.locate);
    const slice = bytes.subarray(range.startByte, range.endByte);
    const text = slice.toString("utf8");
    if (countBytes(slice, expected.needle) !== 1)
      fail("anchor_not_unique", `Required needle is missing or non-unique within declaration: ${expected.anchorId}`);
    if (
      expected.anchorId === "mine_elevator_presentation" &&
      (!text.includes("case 112:") || !text.includes("mineLevel <= 120"))
    )
      fail("anchor_missing", "Presentation guard is incomplete.");
    if (
      expected.anchorId === "mine_elevator_finite_checkpoint_materialization" &&
      (!text.includes("for (int i = 1;") ||
        !text.includes("i <= num") ||
        !text.includes("(i * 5).ToString()") ||
        !text.includes("elevators.Add"))
    )
      fail("anchor_missing", "Finite checkpoint materialization is incomplete.");
    if (
      expected.anchorId === "mine_elevator_selection_commit" &&
      (!text.includes("foreach (ClickableComponent elevator in elevators)") ||
        !text.includes("elevator.containsPoint") ||
        !text.includes("Convert.ToInt32(elevator.name) == Game1.CurrentMineLevel") ||
        !text.includes("ridingMineElevator = true") ||
        !text.includes("Game1.exitActiveMenu"))
    )
      fail("anchor_missing", "Selection membership/current-floor/commit semantics are incomplete.");
    return {
      anchorId: expected.anchorId,
      relativePath: expected.relativePath,
      declaration: expected.locate,
      startByte: range.startByte,
      endByte: range.endByte,
      fileSha256: sha256(bytes),
      sliceSha256: sha256(slice),
      needle: expected.needle,
      semanticRole: expected.semanticRole,
    };
  });
}
async function anchorFiles(result) {
  return Object.fromEntries(
    await Promise.all(
      ANCHORS.map(async ({ relativePath }) => [
        relativePath,
        await readFile(path.resolve(result.output, relativePath)),
      ]),
    ),
  );
}
async function contractAuthority(root) {
  const contract = JSON.parse(await readFile(path.resolve(root, CONTRACT), "utf8"));
  if (
    contract.action?.actionId !== ACTION ||
    contract.action?.actionClass !== "primitive" ||
    contract.topology !== TOPOLOGY
  )
    fail("contract_authority_drift", "Primitive contract authority drifted.");
  return { relativePath: CONTRACT, canonicalSha256: sha256(canonical(contract)) };
}
export function validateDossier(dossier, authority) {
  exact(dossier, ROOT_FIELDS, "dossier");
  if (
    dossier.schemaVersion !== 1 ||
    dossier.artifactKind !== "portfolio_primitive_exact_target_source_realization" ||
    dossier.realizationId !== "portfolio_m8_elevator_source_realization_v1" ||
    dossier.actionId !== ACTION ||
    dossier.topology !== TOPOLOGY
  )
    fail("invalid_dossier", "Dossier identity is invalid.");
  exact(dossier.target, Object.keys(TARGET), "target");
  if (canonical(dossier.target) !== canonical(TARGET)) fail("target_mismatch", "Dossier target drifted.");
  exact(
    dossier.decompiler,
    [
      "tool",
      "version",
      "toolInstallRelativePath",
      "toolSha256",
      "payloadInstallRelativePath",
      "payloadFileCount",
      "payloadCanonicalSha256",
      "options",
      "configurationDigest",
      "extractedAtUtc",
    ],
    "decompiler",
  );
  const configurationDigest = sha256(
    canonical({
      tool: "ilspycmd",
      toolInstallRelativePath: TOOL_INSTALL_RELATIVE_PATH,
      toolSha256: TOOL_SHA256,
      payloadInstallRelativePath: TOOL_PAYLOAD_INSTALL_RELATIVE_PATH,
      payloadFileCount: TOOL_PAYLOAD_FILE_COUNT,
      payloadCanonicalSha256: TOOL_PAYLOAD_CANONICAL_SHA256,
      options: OPTIONS,
      targetRelativeFileName: ASSEMBLY,
    }),
  );
  if (
    dossier.decompiler.tool !== "ilspycmd" ||
    dossier.decompiler.version !== TOOL_VERSION ||
    dossier.decompiler.toolInstallRelativePath !== TOOL_INSTALL_RELATIVE_PATH ||
    dossier.decompiler.toolSha256 !== TOOL_SHA256 ||
    dossier.decompiler.payloadInstallRelativePath !== TOOL_PAYLOAD_INSTALL_RELATIVE_PATH ||
    dossier.decompiler.payloadFileCount !== TOOL_PAYLOAD_FILE_COUNT ||
    dossier.decompiler.payloadCanonicalSha256 !== TOOL_PAYLOAD_CANONICAL_SHA256 ||
    canonical(dossier.decompiler.options) !== canonical(OPTIONS) ||
    dossier.decompiler.configurationDigest !== configurationDigest ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(dossier.decompiler.extractedAtUtc)
  )
    fail("invalid_dossier", "Dossier decompiler tuple is invalid.");
  exact(dossier.sourceManifest, ["csharpFileCount", "canonicalSha256"], "sourceManifest");
  if (
    !Number.isInteger(dossier.sourceManifest.csharpFileCount) ||
    dossier.sourceManifest.csharpFileCount <= 0 ||
    !HASH.test(dossier.sourceManifest.canonicalSha256)
  )
    fail("source_manifest_mismatch", "Dossier source manifest shape is invalid.");
  exact(dossier.primitiveContract, ["relativePath", "canonicalSha256"], "primitiveContract");
  if (!authority || canonical(dossier.primitiveContract) !== canonical(authority))
    fail("contract_authority_drift", "Dossier primitive contract authority drifted.");
  if (!Array.isArray(dossier.anchors) || dossier.anchors.length !== ANCHORS.length)
    fail("anchor_invalid", "Dossier must contain exactly four anchors.");
  const seen = new Set();
  for (const anchor of dossier.anchors) {
    exact(
      anchor,
      [
        "anchorId",
        "relativePath",
        "declaration",
        "startByte",
        "endByte",
        "fileSha256",
        "sliceSha256",
        "needle",
        "semanticRole",
      ],
      "anchor",
    );
    const expected = ANCHORS.find((entry) => entry.anchorId === anchor.anchorId);
    if (
      !expected ||
      seen.has(anchor.anchorId) ||
      !safeRelative(anchor.relativePath) ||
      anchor.relativePath !== expected.relativePath ||
      anchor.declaration !== expected.locate ||
      anchor.needle !== expected.needle ||
      anchor.semanticRole !== expected.semanticRole ||
      !Number.isInteger(anchor.startByte) ||
      !Number.isInteger(anchor.endByte) ||
      anchor.startByte < 0 ||
      anchor.endByte <= anchor.startByte ||
      !HASH.test(anchor.fileSha256) ||
      !HASH.test(anchor.sliceSha256)
    )
      fail("anchor_invalid", "Dossier anchor identity or shape is invalid.");
    seen.add(anchor.anchorId);
  }
  if (seen.size !== ANCHORS.length) fail("anchor_invalid", "Dossier has missing anchors.");
  exact(dossier.provenanceBoundary, ["snapshotThreatBoundary"], "provenanceBoundary");
  if (dossier.provenanceBoundary.snapshotThreatBoundary !== SNAPSHOT_THREAT_BOUNDARY)
    fail("invalid_dossier", "Dossier provenance boundary drifted.");
  exact(dossier.semanticBoundary, ["contextualEquivalence", "guardCommitContinuation", "excluded"], "semanticBoundary");
  if (
    dossier.semanticBoundary.contextualEquivalence !==
      "Choosing one freshly observed materialized elevator checkpoint is equivalent to the native elevator selection semantic commit only while the local player's current reachable grab tile is MineShaft checkAction case 112 and mineLevel is at most 120; UI/click mechanics are presentation and are not bridge inputs, and this does not grant arbitrary enterMine authority." ||
    dossier.semanticBoundary.guardCommitContinuation !==
      "MineShaft checkAction permits only reachable case-112 elevator interaction at mineLevel <= 120; the native menu materializes five-floor checkpoints through Math.Min(lowestLevelReached, 120), rejects non-materialized/current-floor selection, sets ridingMineElevator, then enters the selected mine; enterMine delegates the native warp." ||
    canonical(dossier.semanticBoundary.excluded) !==
      canonical(["ladders", "combat", "route discovery", "new-depth progression", "persistence"])
  )
    fail("invalid_dossier", "Dossier semantic boundary drifted.");
  exact(
    dossier.conclusion,
    ["primitiveSourceRealizationStatus", "projectionState", "liveState", "nonClaim"],
    "conclusion",
  );
  if (
    dossier.conclusion.primitiveSourceRealizationStatus !== "realized" ||
    dossier.conclusion.projectionState !== "eligible_for_separate_projection_review" ||
    dossier.conclusion.liveState !== "not_performed" ||
    dossier.conclusion.nonClaim !==
      "This primitive source realization does not claim aggregate M8 route realization, publication, capability enablement, receipt evidence, liveness, or live closure."
  )
    fail("invalid_dossier", "Dossier conclusion makes an unauthorized claim.");
  return true;
}
export async function mint({ gamePath, output, root = process.cwd() }) {
  if (!output) fail("usage", "An explicit --output path is required.");
  const target = await targetAssembly(gamePath);
  try {
    const result = await decompile(target);
    try {
      const authority = await contractAuthority(root);
      const dossier = {
        schemaVersion: 1,
        artifactKind: "portfolio_primitive_exact_target_source_realization",
        realizationId: "portfolio_m8_elevator_source_realization_v1",
        actionId: ACTION,
        topology: TOPOLOGY,
        target: TARGET,
        decompiler: {
          tool: "ilspycmd",
          version: TOOL_VERSION,
          toolInstallRelativePath: TOOL_INSTALL_RELATIVE_PATH,
          toolSha256: TOOL_SHA256,
          payloadInstallRelativePath: TOOL_PAYLOAD_INSTALL_RELATIVE_PATH,
          payloadFileCount: TOOL_PAYLOAD_FILE_COUNT,
          payloadCanonicalSha256: TOOL_PAYLOAD_CANONICAL_SHA256,
          options: OPTIONS,
          configurationDigest: sha256(
            canonical({
              tool: "ilspycmd",
              toolInstallRelativePath: TOOL_INSTALL_RELATIVE_PATH,
              toolSha256: TOOL_SHA256,
              payloadInstallRelativePath: TOOL_PAYLOAD_INSTALL_RELATIVE_PATH,
              payloadFileCount: TOOL_PAYLOAD_FILE_COUNT,
              payloadCanonicalSha256: TOOL_PAYLOAD_CANONICAL_SHA256,
              options: OPTIONS,
              targetRelativeFileName: ASSEMBLY,
            }),
          ),
          extractedAtUtc: new Date().toISOString(),
        },
        sourceManifest: { csharpFileCount: result.files.length, canonicalSha256: result.canonicalSha256 },
        primitiveContract: authority,
        provenanceBoundary: { snapshotThreatBoundary: SNAPSHOT_THREAT_BOUNDARY },
        anchors: extractAnchors(await anchorFiles(result)),
        semanticBoundary: {
          contextualEquivalence:
            "Choosing one freshly observed materialized elevator checkpoint is equivalent to the native elevator selection semantic commit only while the local player's current reachable grab tile is MineShaft checkAction case 112 and mineLevel is at most 120; UI/click mechanics are presentation and are not bridge inputs, and this does not grant arbitrary enterMine authority.",
          guardCommitContinuation:
            "MineShaft checkAction permits only reachable case-112 elevator interaction at mineLevel <= 120; the native menu materializes five-floor checkpoints through Math.Min(lowestLevelReached, 120), rejects non-materialized/current-floor selection, sets ridingMineElevator, then enters the selected mine; enterMine delegates the native warp.",
          excluded: ["ladders", "combat", "route discovery", "new-depth progression", "persistence"],
        },
        conclusion: {
          primitiveSourceRealizationStatus: "realized",
          projectionState: "eligible_for_separate_projection_review",
          liveState: "not_performed",
          nonClaim:
            "This primitive source realization does not claim aggregate M8 route realization, publication, capability enablement, receipt evidence, liveness, or live closure.",
        },
      };
      validateDossier(dossier, authority);
      await writeFile(path.resolve(output), `${JSON.stringify(dossier, null, 2)}\n`, { flag: "w" });
      return dossier;
    } finally {
      await rm(result.output, { recursive: true, force: true });
    }
  } finally {
    await disposeTargetAssembly(target);
  }
}
export async function verify({ gamePath, dossierPath, root = process.cwd() }) {
  const dossier = JSON.parse(await readFile(path.resolve(dossierPath), "utf8"));
  const authority = await contractAuthority(root);
  validateDossier(dossier, authority);
  const target = await targetAssembly(gamePath);
  try {
    const result = await decompile(target);
    try {
      if (
        dossier.sourceManifest.csharpFileCount !== result.files.length ||
        dossier.sourceManifest.canonicalSha256 !== result.canonicalSha256
      )
        fail("source_manifest_mismatch", "Fresh complete source manifest count or canonical hash drifted.");
      const observed = extractAnchors(await anchorFiles(result));
      for (const expected of observed) {
        const actual = dossier.anchors.find((anchor) => anchor.anchorId === expected.anchorId);
        if (canonical(actual) !== canonical(expected))
          fail("anchor_drift", `Fresh exact-target anchor drifted: ${expected.anchorId}`);
      }
      return {
        actionId: ACTION,
        anchorCount: observed.length,
        primitiveSourceRealizationStatus: "realized",
        projectionState: "eligible_for_separate_projection_review",
        liveState: "not_performed",
      };
    } finally {
      await rm(result.output, { recursive: true, force: true });
    }
  } finally {
    await disposeTargetAssembly(target);
  }
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
      fail("usage", "Usage: --game-path <path> --output <dossier> | --dossier <dossier>.");
    values[argv[index]] = argv[index + 1];
  }
  return values;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = args(process.argv.slice(2).filter((value, index) => index !== 0 || value !== "--"));
    const gamePath = input["--game-path"];
    const result =
      input["--output"] && !input["--dossier"]
        ? await mint({ gamePath, output: input["--output"] })
        : input["--dossier"] && !input["--output"]
          ? await verify({ gamePath, dossierPath: input["--dossier"] })
          : fail("usage", "Choose exactly one of --output or --dossier.");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`stardew-portfolio-m8-elevator-source-realization: ${error.message}`);
    process.exitCode = 1;
  }
}
