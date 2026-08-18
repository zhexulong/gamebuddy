import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
export const TARGET_VERSION = "1.6.15.24356";
export const TARGET_LENGTH = 6268416;
export const TARGET_SHA256 = "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee";
export const TOOL_VERSION = "ilspycmd: 9.1.0.7988";
export const TOOL_LAUNCHER_SHA256 = "5da34ef8b7a3d7e2057d27a0a84ec8e1ccdddb35d6d519058fce1e2f374c4c7f";
export const TOOL_LAUNCHER_RELATIVE_PATH = ".dotnet/tools/ilspycmd.exe";
export const TOOL_PAYLOAD_RELATIVE_PATH =
  ".dotnet/tools/.store/ilspycmd/9.1.0.7988/ilspycmd/9.1.0.7988/tools/net8.0/any";
export const TOOL_CLOSURE_SHA256 = "660c68db0da4f412c3294728453654fe9714c0ee19748bea94031bf57fd0c166";
export const OPTIONS = Object.freeze(["--disable-updatecheck", "-p", "--nested-directories"]);
export const CONTRACT_PATH = "tools/stardew-portfolio-m10-museum-action-contract.json";
export const BLOCKER_CODE = "m10_donate_museum_method_scoped_forbidden_ui_transaction_global_ingress_unproven";
export const NON_CLAIM =
  "Exact-target bounded source evidence only: MuseumMenu method-scoped anchors demonstrate one forbidden UI transaction containing eligibility and placement validation, collection insertion, and exact-one consumption; LibraryMuseum anchors are helpers. This checker does not establish uniqueness over the global ingress universe, source realization, authorization, publication, live execution, or release evidence. MuseumMenu UI callback invocation remains forbidden and unapproved.";
const sha = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function actionContractAuthorityHash(contractBytes) {
  const contract = JSON.parse(Buffer.from(contractBytes).toString("utf8"));
  const action = contract.actions?.find((candidate) => candidate.actionId === "donate_museum_item");
  if (!action || contract.targetVersion !== TARGET_VERSION || contract.topology !== "single_player_native_companion")
    fail("contract_authority_invalid", "M10 donation action contract authority is invalid.");
  return sha(
    canonical({
      actionId: action.actionId,
      topology: contract.topology,
      targetVersion: contract.targetVersion,
      action,
    }),
  );
}
export const configurationDigest = sha(
  JSON.stringify({
    tool: "ilspycmd",
    launcherInstallRelativePath: TOOL_LAUNCHER_RELATIVE_PATH,
    launcherSha256: TOOL_LAUNCHER_SHA256,
    payloadInstallRelativePath: TOOL_PAYLOAD_RELATIVE_PATH,
    closureSha256: TOOL_CLOSURE_SHA256,
    options: OPTIONS,
    target: "Stardew Valley.dll",
  }),
);
export const ANCHORS = Object.freeze([
  [
    "library_museum_item_eligibility_helper",
    "StardewValley/Locations/LibraryMuseum.cs",
    "return IsItemSuitableForDonation(i?.QualifiedItemId);",
    "non_ui_item_eligibility_helper_only",
  ],
  [
    "library_museum_placement_helper",
    "StardewValley/Locations/LibraryMuseum.cs",
    "public bool isTileSuitableForMuseumPiece(int x, int y)",
    "non_ui_placement_eligibility_helper_only",
  ],
  [
    "museum_menu_callback_eligibility_and_placement",
    "StardewValley/Menus/MuseumMenu.cs",
    "if (museum.isTileSuitableForMuseumPiece(num, num2) && museum.isItemSuitableForDonation(item3))",
    "forbidden_menu_callback_validates_item_and_placement",
  ],
  [
    "museum_menu_callback_collection_insertion",
    "StardewValley/Menus/MuseumMenu.cs",
    "museum.museumPieces.Add(new Vector2((float)num, (float)num2), item3.ItemId);",
    "forbidden_menu_callback_inserts_collection_piece",
  ],
  [
    "museum_menu_callback_exact_one_consumption",
    "StardewValley/Menus/MuseumMenu.cs",
    "base.heldItem = item3.ConsumeStack(1);",
    "forbidden_menu_callback_consumes_exactly_one_item",
  ],
]);
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function exact(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("schema_invalid", `${name} must be an object.`);
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !keys.includes(key))
  )
    fail("schema_invalid", `${name} fields are not exact.`);
}
function digestManifest(files) {
  return sha(files.map((file) => `${file.relativePath}\t${file.lengthBytes}\t${file.sha256}`).join("\n") + "\n");
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function identity(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.nlink}`;
}
export async function assertNoReparsePoint(
  candidate,
  {
    missingCode = "path_missing",
    reparseCode = "reparse_point_detected",
    platform = process.platform,
    lstatPath = lstat,
    statPath = stat,
    execPath = exec,
  } = {},
) {
  const link = await lstatPath(candidate).catch(() => fail(missingCode, `Path is missing: ${candidate}`));
  if (link.isSymbolicLink()) fail(reparseCode, `Path is a symbolic link: ${candidate}`);
  if (platform === "win32") {
    const { stdout } = await execPath(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$p=$env:GAMEBUDDY_REPARSE_PATH;$item=Get-Item -LiteralPath $p -Force -ErrorAction Stop;if ([bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {'true'} else {'false'}",
      ],
      { encoding: "utf8", env: { ...process.env, GAMEBUDDY_REPARSE_PATH: candidate } },
    ).catch(() => fail(reparseCode, `Windows reparse-point query failed: ${candidate}`));
    if (stdout.trim() === "true") fail(reparseCode, `Path is a Windows reparse point: ${candidate}`);
    if (stdout.trim() !== "false") fail(reparseCode, `Windows reparse-point query was indeterminate: ${candidate}`);
  }
  const resolved = await statPath(candidate).catch(() => fail(missingCode, `Path is missing: ${candidate}`));
  if (!link.isFile() && !link.isDirectory()) fail(reparseCode, `Path is not a normal file or directory: ${candidate}`);
  return resolved;
}
export async function assertNoReparseAncestors(candidate, options = {}) {
  const absolute = path.resolve(candidate),
    root = path.parse(absolute).root;
  if (!root) fail("path_root_invalid", `Path has no stable root: ${candidate}`);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    fail("path_root_invalid", `Path escapes its stable root: ${candidate}`);
  const paths = [root];
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  for (const existing of paths) await assertNoReparsePoint(existing, options);
  return absolute;
}
export async function assertContainedNoReparse(root, candidate, options = {}) {
  const absoluteRoot = path.resolve(root),
    absoluteCandidate = path.resolve(candidate);
  if (absoluteCandidate !== absoluteRoot && !inside(absoluteRoot, absoluteCandidate))
    fail("path_escape", `Path escapes containment root: ${candidate}`);
  await assertNoReparseAncestors(absoluteRoot, options);
  await assertNoReparseAncestors(absoluteCandidate, options);
  return absoluteCandidate;
}
export async function readContainedFile(root, candidate, options = {}) {
  const absolute = await assertContainedNoReparse(root, candidate, options);
  const reader = options.readFilePath || readFile;
  const before = await assertNoReparsePoint(absolute, options);
  if (!before.isFile()) fail(options.reparseCode || "reparse_point_detected", `Path is not a normal file: ${absolute}`);
  const beforeIdentity = identity(before);
  const bytes = await reader(absolute);
  await assertContainedNoReparse(root, absolute, options);
  const after = await assertNoReparsePoint(absolute, options);
  if (!after.isFile() || identity(after) !== beforeIdentity)
    fail("contained_file_identity_drift", `Contained file identity changed while reading: ${absolute}`);
  const stableBytes = await reader(absolute);
  await assertContainedNoReparse(root, absolute, options);
  const final = await assertNoReparsePoint(absolute, options);
  if (!final.isFile() || identity(final) !== beforeIdentity)
    fail("contained_file_identity_drift", `Contained file identity changed while reading: ${absolute}`);
  if (!Buffer.from(bytes).equals(Buffer.from(stableBytes)))
    fail("contained_file_content_drift", `Contained file content changed while reading: ${absolute}`);
  return bytes;
}
async function assertNotReparse(candidate, code) {
  await assertNoReparseAncestors(candidate, { missingCode: code, reparseCode: "snapshot_reparse_detected" });
  return assertNoReparsePoint(candidate, { missingCode: code, reparseCode: "snapshot_reparse_detected" });
}
async function listCs(root, current = root, result = []) {
  await assertContainedNoReparse(root, current, {
    missingCode: "decompile_tree_missing",
    reparseCode: "decompile_tree_reparse_detected",
  });
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const candidate = path.join(current, entry.name);
    await assertContainedNoReparse(root, candidate, {
      missingCode: "decompile_tree_missing",
      reparseCode: "decompile_tree_reparse_detected",
    });
    const info = await assertNoReparsePoint(candidate, {
      missingCode: "decompile_tree_missing",
      reparseCode: "decompile_tree_reparse_detected",
    });
    if (info.isDirectory()) await listCs(root, candidate, result);
    else if (info.isFile() && candidate.endsWith(".cs")) result.push(candidate);
  }
  return result;
}
function assertTargetBytes(bytes) {
  if (bytes.length !== TARGET_LENGTH) fail("target_length_mismatch", "Target assembly length differs.");
  const hash = sha(bytes);
  if (hash !== TARGET_SHA256) fail("target_hash_mismatch", "Target assembly hash differs.");
  return hash;
}
async function targetVersion(assemblyPath) {
  return (
    await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$p=$env:GAMEBUDDY_INSPECT_ASSEMBLY;(Get-Item -LiteralPath $p).VersionInfo.FileVersion",
      ],
      { encoding: "utf8", env: { ...process.env, GAMEBUDDY_INSPECT_ASSEMBLY: assemblyPath } },
    )
  ).stdout.trim();
}
async function makePrivateSnapshotRoot() {
  const parent = path.resolve(process.env.TEMP || os.tmpdir());
  await assertNoReparseAncestors(parent, {
    missingCode: "snapshot_private_root_failed",
    reparseCode: "snapshot_reparse_detected",
  });
  const root = await mkdtemp(path.join(parent, "gb-m10-target-"));
  try {
    const account =
      process.env.USERDOMAIN && process.env.USERNAME
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : process.env.USERNAME;
    if (!account)
      fail("snapshot_private_root_failed", "The current Windows account is unavailable for the private snapshot ACL.");
    await exec("icacls.exe", [root, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`], { encoding: "utf8" });
    await assertNotReparse(root, "snapshot_root_missing");
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw Object.assign(error, { code: error.code || "snapshot_private_root_failed" });
  }
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
  const rootInfo = await assertNotReparse(target.snapshotRoot, "target_snapshot_missing");
  const info = await assertNotReparse(target.path, "target_snapshot_missing");
  if (!rootInfo.isDirectory() || !info.isFile() || identity(info) !== target.identity)
    fail("target_snapshot_identity_drift", "Target snapshot identity changed.");
  const bytes = await readContainedFile(target.snapshotRoot, target.path, {
    missingCode: "target_snapshot_missing",
    reparseCode: "snapshot_reparse_detected",
  });
  const hash = assertTargetBytes(bytes);
  if (info.size !== TARGET_LENGTH || target.lengthBytes !== TARGET_LENGTH || target.sha256 !== hash)
    fail("target_snapshot_drift", "Target snapshot drifted.");
  if ((await targetVersion(target.path)) !== TARGET_VERSION)
    fail("target_version_mismatch", "Target snapshot version differs.");
}
export function resolveLockedToolPath(home = os.homedir()) {
  if (typeof home !== "string" || !path.isAbsolute(home))
    fail("tool_install_path_invalid", "The locked ilspycmd home path is invalid.");
  return path.join(home, ...TOOL_LAUNCHER_RELATIVE_PATH.split("/"));
}
function resolvePayloadPath(home = os.homedir()) {
  return path.join(home, ...TOOL_PAYLOAD_RELATIVE_PATH.split("/"));
}
export function verifyToolClosure(files) {
  if (!Array.isArray(files) || files.length === 0 || digestManifest(files) !== TOOL_CLOSURE_SHA256)
    fail("tool_closure_drift", "The resolved ilspycmd payload/dependency closure differs.");
}
async function toolClosure(home = os.homedir()) {
  const launcher = resolveLockedToolPath(home),
    payload = resolvePayloadPath(home);
  await assertNoReparseAncestors(launcher, {
    missingCode: "tool_missing",
    reparseCode: "tool_payload_reparse_detected",
  });
  await assertNoReparseAncestors(payload, {
    missingCode: "tool_payload_missing",
    reparseCode: "tool_payload_reparse_detected",
  });
  const launcherBytes = await readContainedFile(path.parse(launcher).root, launcher, {
    missingCode: "tool_missing",
    reparseCode: "tool_payload_reparse_detected",
  }).catch(() => fail("tool_missing", "The fixed installed ilspycmd launcher is missing."));
  if (sha(launcherBytes) !== TOOL_LAUNCHER_SHA256)
    fail("tool_launcher_hash_mismatch", "The fixed ilspycmd launcher hash differs.");
  const files = [
    { relativePath: "launcher/ilspycmd.exe", lengthBytes: launcherBytes.length, sha256: sha(launcherBytes) },
  ];
  async function walk(current = payload) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() =>
      fail("tool_payload_missing", "The fixed ilspycmd payload is missing."),
    )) {
      const candidate = path.join(current, entry.name),
        relative = path.relative(payload, candidate).replaceAll(path.sep, "/");
      await assertContainedNoReparse(payload, candidate, {
        missingCode: "tool_payload_missing",
        reparseCode: "tool_payload_reparse_detected",
      });
      const info = await assertNoReparsePoint(candidate, {
        missingCode: "tool_payload_missing",
        reparseCode: "tool_payload_reparse_detected",
      });
      if (info.isDirectory()) await walk(candidate);
      else if (info.isFile()) {
        const bytes = await readContainedFile(payload, candidate, {
          missingCode: "tool_payload_missing",
          reparseCode: "tool_payload_reparse_detected",
        });
        files.push({ relativePath: `payload/${relative}`, lengthBytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  await walk();
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  verifyToolClosure(files);
  return { launcher, files, closureSha256: TOOL_CLOSURE_SHA256 };
}
async function lockedTool() {
  const closure = await toolClosure();
  const version = (await exec(closure.launcher, ["--version"], { encoding: "utf8" })).stdout.trim().split(/\r?\n/)[0];
  if (version !== TOOL_VERSION) fail("tool_version_mismatch", "Locked ilspycmd version is required.");
  return closure;
}
export async function targetAssembly(gamePath) {
  if (typeof gamePath !== "string" || !gamePath) fail("game_path_required", "An explicit game path is required.");
  const gameRoot = path.resolve(gamePath),
    assemblyPath = path.join(gameRoot, "Stardew Valley.dll");
  await assertNoReparseAncestors(gameRoot, {
    missingCode: "target_assembly_missing",
    reparseCode: "target_assembly_reparse_detected",
  });
  const bytes = await readContainedFile(gameRoot, assemblyPath, {
    missingCode: "target_assembly_missing",
    reparseCode: "target_assembly_reparse_detected",
  });
  const hash = assertTargetBytes(bytes),
    snapshotRoot = await makePrivateSnapshotRoot(),
    snapshotPath = path.join(snapshotRoot, "Stardew Valley.dll");
  try {
    await assertNoReparseAncestors(snapshotRoot, {
      missingCode: "target_snapshot_missing",
      reparseCode: "snapshot_reparse_detected",
    });
    await writeFile(snapshotPath, bytes, { flag: "wx", mode: 0o600 });
    await chmod(snapshotPath, 0o600);
    const info = await assertNotReparse(snapshotPath, "target_snapshot_missing");
    const target = Object.freeze({
      path: snapshotPath,
      snapshotRoot,
      lengthBytes: bytes.length,
      sha256: hash,
      identity: identity(info),
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
export async function decompile(target) {
  const parent = path.resolve(process.env.TEMP || os.tmpdir());
  await assertNoReparseAncestors(parent, {
    missingCode: "decompile_tree_missing",
    reparseCode: "decompile_tree_reparse_detected",
  });
  const output = await mkdtemp(path.join(parent, "gb-m10-boundary-"));
  try {
    await verifySnapshot(target);
    const tool = await lockedTool();
    await verifySnapshot(target);
    await assertNoReparseAncestors(output, {
      missingCode: "decompile_tree_missing",
      reparseCode: "decompile_tree_reparse_detected",
    });
    await exec(tool.launcher, [...OPTIONS, "-o", output, target.path], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    await verifySnapshot(target);
    await assertNoReparseAncestors(output, {
      missingCode: "decompile_tree_missing",
      reparseCode: "decompile_tree_reparse_detected",
    });
    return { output };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error.code
      ? error
      : Object.assign(new Error(`Fresh decompilation failed: ${error.message}`), { code: "decompile_failed" });
  }
}
export async function sourceState(root) {
  await assertNoReparseAncestors(root, {
    missingCode: "decompile_tree_missing",
    reparseCode: "decompile_tree_reparse_detected",
  });
  const paths = await listCs(root),
    files = [],
    buffers = {};
  const normalized = paths
    .map((sourcePath) => ({ sourcePath, relativePath: path.relative(root, sourcePath).replaceAll(path.sep, "/") }))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  for (const { sourcePath, relativePath } of normalized) {
    const buffer = await readContainedFile(root, sourcePath, {
      missingCode: "decompile_tree_missing",
      reparseCode: "decompile_tree_reparse_detected",
    });
    files.push({ relativePath, lengthBytes: buffer.length, sha256: sha(buffer) });
    buffers[relativePath] = buffer;
  }
  return { files, buffers };
}
export function derive(target, state, contractHash, extractedAtUtc) {
  const anchors = ANCHORS.map(([anchorId, relativePath, needle, semanticRole]) => {
    const buffer = state.buffers[relativePath],
      startByte = buffer?.indexOf(Buffer.from(needle));
    if (!buffer || startByte < 0) fail("anchor_missing", `${anchorId} was not found.`);
    if (buffer.indexOf(Buffer.from(needle), startByte + 1) >= 0)
      fail("anchor_not_unique", `${anchorId} is not unique.`);
    const endByte = startByte + Buffer.byteLength(needle);
    return {
      anchorId,
      relativePath,
      startByte,
      endByte,
      fileSha256: sha(buffer),
      sliceSha256: sha(buffer.subarray(startByte, endByte)),
      needle,
      semanticRole,
    };
  });
  return {
    schemaVersion: 1,
    artifactKind: "portfolio_m10_donate_museum_source_boundary",
    boundaryId: "portfolio_m10_donate_museum_source_boundary_v1",
    primitive: "donate_museum_item",
    extractedAtUtc,
    target: {
      gameVersion: TARGET_VERSION,
      assembly: "Stardew Valley.dll",
      lengthBytes: target.lengthBytes,
      sha256: target.sha256,
    },
    decompilation: {
      tool: "ilspycmd",
      toolVersion: TOOL_VERSION,
      launcherInstallRelativePath: TOOL_LAUNCHER_RELATIVE_PATH,
      launcherSha256: TOOL_LAUNCHER_SHA256,
      payloadInstallRelativePath: TOOL_PAYLOAD_RELATIVE_PATH,
      closureSha256: TOOL_CLOSURE_SHA256,
      options: OPTIONS,
      configurationDigest,
    },
    primitiveContract: { path: CONTRACT_PATH, actionAuthoritySha256: contractHash },
    sourceManifest: { fileCount: state.files.length, sha256: digestManifest(state.files), files: state.files },
    anchors,
    exclusions: [
      "Museum UI/menu/callback invocation",
      "museum reward claim",
      "M10 aggregate",
      "adapter",
      "bridge",
      "fixture",
      "live execution",
      "publication",
    ],
    conclusion: {
      primitiveSourceRealizationStatus: "blocked",
      projectionState: "blocked",
      liveState: "not_performed",
      blockerCode: BLOCKER_CODE,
      nonClaim: NON_CLAIM,
    },
  };
}
export function validate(model, contractHash, state, root) {
  exact(
    model,
    [
      "schemaVersion",
      "artifactKind",
      "boundaryId",
      "primitive",
      "extractedAtUtc",
      "target",
      "decompilation",
      "primitiveContract",
      "sourceManifest",
      "anchors",
      "exclusions",
      "conclusion",
    ],
    "dossier",
  );
  if (
    model.schemaVersion !== 1 ||
    model.artifactKind !== "portfolio_m10_donate_museum_source_boundary" ||
    model.boundaryId !== "portfolio_m10_donate_museum_source_boundary_v1" ||
    model.primitive !== "donate_museum_item" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(model.extractedAtUtc)
  )
    fail("identity_invalid", "Dossier identity is invalid.");
  exact(model.target, ["gameVersion", "assembly", "lengthBytes", "sha256"], "target");
  if (
    JSON.stringify(model.target) !==
    JSON.stringify({
      gameVersion: TARGET_VERSION,
      assembly: "Stardew Valley.dll",
      lengthBytes: TARGET_LENGTH,
      sha256: TARGET_SHA256,
    })
  )
    fail("target_drift", "Target drift.");
  exact(
    model.decompilation,
    [
      "tool",
      "toolVersion",
      "launcherInstallRelativePath",
      "launcherSha256",
      "payloadInstallRelativePath",
      "closureSha256",
      "options",
      "configurationDigest",
    ],
    "decompilation",
  );
  if (
    model.decompilation.tool !== "ilspycmd" ||
    model.decompilation.toolVersion !== TOOL_VERSION ||
    model.decompilation.launcherInstallRelativePath !== TOOL_LAUNCHER_RELATIVE_PATH ||
    model.decompilation.launcherSha256 !== TOOL_LAUNCHER_SHA256 ||
    model.decompilation.payloadInstallRelativePath !== TOOL_PAYLOAD_RELATIVE_PATH ||
    model.decompilation.closureSha256 !== TOOL_CLOSURE_SHA256 ||
    JSON.stringify(model.decompilation.options) !== JSON.stringify(OPTIONS) ||
    model.decompilation.configurationDigest !== configurationDigest
  )
    fail("decompile_config_drift", "Decompiler drift.");
  exact(model.primitiveContract, ["path", "actionAuthoritySha256"], "primitiveContract");
  if (model.primitiveContract.path !== CONTRACT_PATH || model.primitiveContract.actionAuthoritySha256 !== contractHash)
    fail("contract_drift", "Contract authority drift.");
  exact(model.sourceManifest, ["fileCount", "sha256", "files"], "sourceManifest");
  if (
    !Array.isArray(model.sourceManifest.files) ||
    model.sourceManifest.fileCount !== model.sourceManifest.files.length ||
    model.sourceManifest.sha256 !== digestManifest(model.sourceManifest.files)
  )
    fail("manifest_invalid", "Source manifest is invalid.");
  let previous = null;
  for (const file of model.sourceManifest.files) {
    exact(file, ["relativePath", "lengthBytes", "sha256"], "sourceManifest.file");
    if (
      (previous !== null && !(previous < file.relativePath)) ||
      typeof file.relativePath !== "string" ||
      file.relativePath.startsWith("/") ||
      file.relativePath.includes("\\") ||
      file.relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
    )
      fail("path_escape", "Manifest path is unsafe or unsorted.");
    previous = file.relativePath;
    const buffer = state.buffers[file.relativePath];
    if (!buffer || buffer.length !== file.lengthBytes || sha(buffer) !== file.sha256)
      fail("source_drift", `Source drift: ${file.relativePath}`);
  }
  if (JSON.stringify(model.sourceManifest.files) !== JSON.stringify(state.files))
    fail("source_manifest_incomplete", "Source manifest must exactly equal the complete fresh C# source manifest.");
  if (JSON.stringify(model.anchors?.map((anchor) => anchor.anchorId)) !== JSON.stringify(ANCHORS.map(([id]) => id)))
    fail("anchor_set_invalid", "Anchor set drift.");
  for (const anchor of model.anchors) {
    exact(
      anchor,
      ["anchorId", "relativePath", "startByte", "endByte", "fileSha256", "sliceSha256", "needle", "semanticRole"],
      "anchor",
    );
    const approved = ANCHORS.find(([id]) => id === anchor.anchorId);
    if (
      !approved ||
      anchor.relativePath !== approved[1] ||
      anchor.needle !== approved[2] ||
      anchor.semanticRole !== approved[3] ||
      !Number.isInteger(anchor.startByte) ||
      !Number.isInteger(anchor.endByte) ||
      anchor.endByte <= anchor.startByte
    )
      fail("anchor_drift", "Anchor fields drift.");
    const buffer = state.buffers[anchor.relativePath];
    if (
      !buffer ||
      anchor.endByte > buffer.length ||
      sha(buffer) !== anchor.fileSha256 ||
      sha(buffer.subarray(anchor.startByte, anchor.endByte)) !== anchor.sliceSha256 ||
      buffer.indexOf(Buffer.from(anchor.needle)) !== anchor.startByte ||
      buffer.indexOf(Buffer.from(anchor.needle), anchor.startByte + 1) >= 0
    )
      fail("anchor_drift", `Anchor source drift: ${anchor.anchorId}`);
  }
  const exclusions = [
    "Museum UI/menu/callback invocation",
    "museum reward claim",
    "M10 aggregate",
    "adapter",
    "bridge",
    "fixture",
    "live execution",
    "publication",
  ];
  if (JSON.stringify(model.exclusions) !== JSON.stringify(exclusions)) fail("scope_drift", "Exclusions drift.");
  exact(
    model.conclusion,
    ["primitiveSourceRealizationStatus", "projectionState", "liveState", "blockerCode", "nonClaim"],
    "conclusion",
  );
  if (
    model.conclusion.primitiveSourceRealizationStatus !== "blocked" ||
    model.conclusion.projectionState !== "blocked" ||
    model.conclusion.liveState !== "not_performed" ||
    model.conclusion.blockerCode !== BLOCKER_CODE ||
    model.conclusion.nonClaim !== NON_CLAIM
  )
    fail("unsupported_claim", "Conclusion is not the bounded blocked conclusion.");
  return {
    primitive: model.primitive,
    primitiveSourceRealizationStatus: "blocked",
    projectionState: "blocked",
    liveState: "not_performed",
    blockerCode: BLOCKER_CODE,
    fileCount: model.sourceManifest.fileCount,
    anchorCount: model.anchors.length,
  };
}
export { sha, toolClosure };

export async function writeVerifiedAtomicJson(
  output,
  value,
  { mkdirPath = null, writeFilePath = writeFile, renamePath = rename } = {},
) {
  const finalPath = path.resolve(output),
    parent = path.dirname(finalPath);
  if (mkdirPath) await mkdirPath(parent, { recursive: true });
  await assertNoReparseAncestors(parent, {
    missingCode: "artifact_parent_missing",
    reparseCode: "artifact_output_reparse_detected",
  });
  try {
    await assertNoReparseAncestors(finalPath, {
      missingCode: "artifact_final_missing",
      reparseCode: "artifact_output_reparse_detected",
    });
  } catch (error) {
    if (error.code !== "artifact_final_missing") throw error;
  }
  const temporary = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFilePath(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await assertNoReparseAncestors(parent, {
      missingCode: "artifact_parent_missing",
      reparseCode: "artifact_output_reparse_detected",
    });
    await assertNoReparseAncestors(temporary, {
      missingCode: "artifact_temp_missing",
      reparseCode: "artifact_output_reparse_detected",
    });
    await renamePath(temporary, finalPath);
    await assertNoReparseAncestors(parent, {
      missingCode: "artifact_parent_missing",
      reparseCode: "artifact_output_reparse_detected",
    });
    await assertNoReparseAncestors(finalPath, {
      missingCode: "artifact_final_missing",
      reparseCode: "artifact_output_reparse_detected",
    });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
