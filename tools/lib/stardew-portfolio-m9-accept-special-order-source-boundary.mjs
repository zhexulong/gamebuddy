import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TARGET_VERSION = "1.6.15.24356";
export const TARGET_LENGTH = 6268416;
export const TARGET_SHA256 = "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee";
export const TOOL_VERSION = "ilspycmd: 9.1.0.7988";
// This review-approved launcher and its resolved .NET payload are locked. Environment overrides are ignored.
export const TOOL_PATH = "C:/Users/27251/.dotnet/tools/ilspycmd.exe";
export const TOOL_SHA256 = "5da34ef8b7a3d7e2057d27a0a84ec8e1ccdddb35d6d519058fce1e2f374c4c7f";
export const TOOL_PAYLOAD_ROOT =
  "C:/Users/27251/.dotnet/tools/.store/ilspycmd/9.1.0.7988/ilspycmd/9.1.0.7988/tools/net8.0/any";
export const OPTIONS = Object.freeze(["--disable-updatecheck", "-p", "--nested-directories"]);
const CONTRACT_PATH = "tools/stardew-portfolio-m9-special-order-action-contract.json";
export const BLOCKER_CODE = "m9_accept_non_ui_native_ingress_not_established";
export const ILSPY_EXECUTION_ENVIRONMENT_POLICY = Object.freeze({
  mode: "explicit_windows_runtime_allowlist",
  retainedVariables: Object.freeze(["SystemRoot", "WINDIR", "TEMP", "TMP"]),
  rejectsInheritedToolConfiguration: true,
});
export const TRUST_BOUNDARY = Object.freeze({
  localCheckerTcb: Object.freeze([
    "Node.js checker process",
    "locked launcher and payload closure hashes",
    "fresh private target snapshot content and identity checks",
  ]),
  outsideLocalCheckerBoundary: Object.freeze([
    "Windows OS and .NET apphost/runtime",
    "same-user, administrator, or kernel hostile-process replacement between observations and execution",
  ]),
});
const sha = (value) => createHash("sha256").update(value).digest("hex");
const payloadDigest = (files) =>
  sha(`${files.map((f) => `${f.relativePath}\t${f.lengthBytes}\t${f.sha256}`).join("\n")}\n`);
export const configurationDigest = sha(
  JSON.stringify({
    tool: "ilspycmd",
    toolPath: TOOL_PATH,
    toolSha256: TOOL_SHA256,
    toolPayloadRoot: TOOL_PAYLOAD_ROOT,
    options: OPTIONS,
    target: "Stardew Valley.dll",
    layout: "project_nested_directories",
    executionEnvironmentPolicy: ILSPY_EXECUTION_ENVIRONMENT_POLICY,
  }),
);
export const ANCHORS = Object.freeze([
  [
    "ui_board_acceptance_transaction",
    "StardewValley/Menus/SpecialOrdersBoard.cs",
    "public override void receiveLeftClick(int x, int y, bool playSound = true)",
    [
      "if (acceptLeftQuestButton.visible && acceptLeftQuestButton.containsPoint(x, y))",
      "if (leftOrder != null)",
      "Game1.player.team.acceptedSpecialOrderTypes.Add(GetOrderType());",
      "Game1.player.team.AddSpecialOrder(specialOrder.questKey.Value, specialOrder.generationSeed.Value);",
      "if (acceptRightQuestButton.visible && acceptRightQuestButton.containsPoint(x, y))",
      "if (rightOrder != null)",
      "Game1.player.team.AddSpecialOrder(specialOrder2.questKey.Value, specialOrder2.generationSeed.Value);",
    ],
    [],
    "The complete board receiveLeftClick body selects a visible offered order, commits its board type, and adds that selected order with its generation.",
  ],
  [
    "farmer_team_add_special_order",
    "StardewValley/FarmerTeam.cs",
    "public void AddSpecialOrder(string id, int? generationSeed = null, bool forceRepeatable = false)",
    [
      "SpecialOrder specialOrder = SpecialOrder.GetSpecialOrder(id, generationSeed);",
      "completedSpecialOrders.Contains(specialOrder.questKey.Value) && !forceRepeatable",
      "specialOrders.Add(specialOrder);",
    ],
    ["availableSpecialOrders", "acceptedSpecialOrderTypes", "GetOrderType()"],
    "The complete AddSpecialOrder body accepts only an id, optional generation seed, and force-repeatable behavior; it does not read available offers or commit an accepted board type.",
  ],
]);
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function exactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("schema_invalid", `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i]))
    fail("schema_invalid", `${label} has missing or unknown fields.`);
}
function exact(value, expected, label) {
  if (value !== expected) fail("schema_invalid", `${label} is invalid.`);
}
function hex(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("schema_invalid", `${label} must be a SHA-256.`);
}
function canonicalRelative(relativePath) {
  return (
    typeof relativePath === "string" &&
    relativePath.length > 0 &&
    !relativePath.startsWith("/") &&
    !relativePath.includes("\\") &&
    relativePath.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function comparePath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function manifestDigest(files) {
  return payloadDigest(files);
}
function reparse(stats, windowsAttributes = undefined) {
  return (
    stats.isSymbolicLink() ||
    (typeof stats.mode === "number" && (stats.mode & 0o170000) === 0o120000) ||
    (typeof windowsAttributes === "number" && (windowsAttributes & 0x400) !== 0)
  );
}
async function windowsFileAttributes(file, execPath = exec) {
  if (process.platform !== "win32") return undefined;
  const script =
    "$p=$env:GAMEBUDDY_M9_REPARSE_PATH;$item=Get-Item -Force -LiteralPath $p -ErrorAction Stop;[int]$item.Attributes";
  const { stdout } = await execPath("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, GAMEBUDDY_M9_REPARSE_PATH: file },
  }).catch(() => fail("reparse_query_failed", `Windows reparse-point query failed: ${file}`));
  const value = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(value)) fail("reparse_query_failed", `Windows reparse-point query was indeterminate: ${file}`);
  return value;
}
export async function assertNoReparsePoint(
  file,
  {
    missingCode = "path_missing",
    reparseCode = "reparse_point_detected",
    platform = process.platform,
    lstatPath = lstat,
    statPath = stat,
    windowsAttributesOf = windowsFileAttributes,
  } = {},
) {
  const info = await lstatPath(file).catch(() => fail(missingCode, `Missing path: ${file}`));
  const attributes = platform === "win32" ? await windowsAttributesOf(file) : undefined;
  if (reparse(info, attributes)) fail(reparseCode, `Reparse point is not allowed: ${file}`);
  const resolved = await statPath(file).catch(() => fail(missingCode, `Missing path: ${file}`));
  if (!info.isFile() && !info.isDirectory()) fail(reparseCode, `Path is not a normal file or directory: ${file}`);
  return resolved;
}
async function assertNoReparseAncestors(file, options = {}) {
  let current = path.resolve(file);
  const stop = path.parse(current).root;
  for (;;) {
    await assertNoReparsePoint(current, options);
    if (current === stop) return;
    current = path.dirname(current);
  }
}
async function _assertNoReparse(file, code) {
  return assertNoReparsePoint(file, { missingCode: code, reparseCode: code });
}
async function assertNoReparseTreePath(file, code) {
  await assertNoReparseAncestors(file, { missingCode: code, reparseCode: code });
}
export function ilspyExecutionEnvironment(source = process.env) {
  const env = {};
  for (const name of ILSPY_EXECUTION_ENVIRONMENT_POLICY.retainedVariables) {
    if (typeof source[name] === "string" && source[name]) env[name] = source[name];
  }
  return env;
}
async function listFiles(root, current = root, output = []) {
  await assertNoReparseTreePath(current, "tool_payload_reparse");
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isSymbolicLink()) fail("tool_payload_reparse", `Tool payload contains a symbolic link: ${file}`);
    if (entry.isDirectory()) await listFiles(root, file, output);
    else if (entry.isFile()) output.push(file);
    else fail("tool_payload_entry_invalid", `Tool payload contains a non-file entry: ${file}`);
  }
  return output;
}
async function listCs(root, current = root, output = []) {
  await assertNoReparseTreePath(current, "decompile_tree_entry_invalid");
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isSymbolicLink())
      fail("decompile_tree_entry_invalid", `Decompiler output contains a symbolic link: ${file}`);
    if (entry.isDirectory()) await listCs(root, file, output);
    else if (entry.isFile() && entry.name.endsWith(".cs")) output.push(file);
    else if (!entry.isFile())
      fail("decompile_tree_entry_invalid", `Decompiler output contains a non-file entry: ${file}`);
  }
  return output;
}
async function versionOf(assemblyPath) {
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
async function windowsSnapshotBoundary(snapshotRoot, snapshotPath, expectedIdentity) {
  if (process.platform !== "win32") return { platform: process.platform, identity: null };
  const script = `
$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class GbM9FileIdentity { [StructLayout(LayoutKind.Sequential)] public struct BY_HANDLE_FILE_INFORMATION { public uint FileAttributes,CreationTimeLow,CreationTimeHigh,LastAccessTimeLow,LastAccessTimeHigh,LastWriteTimeLow,LastWriteTimeHigh,VolumeSerialNumber,FileSizeHigh,FileSizeLow,NumberOfLinks,FileIndexHigh,FileIndexLow; } [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION i); }
'@;
function Id($p) { $f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { $i=New-Object GbM9FileIdentity+BY_HANDLE_FILE_INFORMATION; if(-not [GbM9FileIdentity]::GetFileInformationByHandle($f.SafeFileHandle,[ref]$i)){throw 'GetFileInformationByHandle failed'}; return "$($i.VolumeSerialNumber):$($i.FileIndexHigh):$($i.FileIndexLow)" } finally {$f.Dispose()} }
$root=$env:GB_M9_SNAPSHOT_ROOT; $file=$env:GB_M9_SNAPSHOT_PATH; foreach($p in @($root,$file)){ $item=Get-Item -Force -LiteralPath $p; if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw "reparse point: $p"} }
$me=[Security.Principal.WindowsIdentity]::GetCurrent().Name; $acl=@(& icacls.exe $root); $ownerRules=@($acl | Where-Object { $_ -match ([regex]::Escape($me) + '.*\\(F\\)') }); if($LASTEXITCODE -ne 0 -or ($acl -match '\\(I\\)') -or $ownerRules.Count -ne 1) {throw 'snapshot ACL is not private to current identity'}
$id=Id $file; if($env:GB_M9_EXPECTED_ID -and $id -ne $env:GB_M9_EXPECTED_ID){throw 'snapshot file identity changed'}; Write-Output $id`;
  try {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        GB_M9_SNAPSHOT_ROOT: snapshotRoot,
        GB_M9_SNAPSHOT_PATH: snapshotPath,
        GB_M9_EXPECTED_ID: expectedIdentity || "",
      },
    });
    return { platform: "win32", identity: stdout.trim() };
  } catch (error) {
    fail(
      "snapshot_boundary_invalid",
      `Private/reparse/identity-safe Windows snapshot boundary failed: ${error.message}`,
    );
  }
}
async function validateSnapshot(target) {
  if (
    !target?.snapshotPath ||
    !target.snapshotRoot ||
    target.sha256 !== TARGET_SHA256 ||
    target.lengthBytes !== TARGET_LENGTH
  )
    fail("target_snapshot_required", "A verified target snapshot is required.");
  await assertNoReparseTreePath(target.snapshotRoot, "snapshot_boundary_invalid");
  await assertNoReparseTreePath(target.snapshotPath, "snapshot_boundary_invalid");
  const bytes = await readFile(target.snapshotPath);
  if (bytes.length !== TARGET_LENGTH || sha(bytes) !== TARGET_SHA256)
    fail("target_snapshot_mismatch", "Target snapshot content changed.");
  const boundary = await windowsSnapshotBoundary(target.snapshotRoot, target.snapshotPath, target.snapshotIdentity);
  if (target.snapshotIdentity && boundary.identity !== target.snapshotIdentity)
    fail("snapshot_boundary_invalid", "Snapshot identity changed.");
  return boundary;
}
export async function targetAssembly(gamePath) {
  if (!gamePath || typeof gamePath !== "string")
    fail("game_path_required", "Explicit --game-path or GAMEBUDDY_STARDEW_GAME_PATH is required.");
  const assemblyPath = path.join(path.resolve(gamePath), "Stardew Valley.dll");
  await assertNoReparseTreePath(assemblyPath, "target_assembly_missing");
  const info = await stat(assemblyPath).catch(() => fail("target_assembly_missing", "Stardew Valley.dll is missing."));
  const bytes = await readFile(assemblyPath);
  if (info.size !== TARGET_LENGTH || bytes.length !== TARGET_LENGTH)
    fail("target_length_mismatch", "Target assembly length mismatch.");
  if (sha(bytes) !== TARGET_SHA256) fail("target_hash_mismatch", "Target assembly hash mismatch.");
  const snapshotRoot = await mkdtemp(path.join(process.env.TEMP || "/tmp", "gb-m9-accept-assembly-"));
  const snapshotPath = path.join(snapshotRoot, "Stardew Valley.dll");
  try {
    if (process.platform === "win32") {
      const { stdout: identity } = await exec(
        "powershell.exe",
        ["-NoProfile", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().Name"],
        { encoding: "utf8" },
      );
      await exec("icacls.exe", [snapshotRoot, "/inheritance:r", "/grant:r", `${identity.trim()}:(OI)(CI)F`], {
        encoding: "utf8",
      });
    }
    await writeFile(snapshotPath, bytes, { flag: "wx", mode: 0o600 });
    const snapshotBytes = await readFile(snapshotPath);
    if (snapshotBytes.length !== TARGET_LENGTH || sha(snapshotBytes) !== TARGET_SHA256)
      fail("target_snapshot_mismatch", "Target snapshot verification failed.");
    const firstBoundary = await windowsSnapshotBoundary(snapshotRoot, snapshotPath);
    const version = await versionOf(snapshotPath);
    if (version !== TARGET_VERSION) fail("target_version_mismatch", "Target assembly version mismatch.");
    return {
      assemblyPath,
      snapshotPath,
      snapshotRoot,
      snapshotIdentity: firstBoundary.identity,
      lengthBytes: snapshotBytes.length,
      sha256: sha(snapshotBytes),
      fileVersion: version,
    };
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}
export async function disposeTarget(target) {
  if (target?.snapshotRoot) await rm(target.snapshotRoot, { recursive: true, force: true });
}
async function toolPayloadState() {
  const paths = await listFiles(TOOL_PAYLOAD_ROOT);
  const files = [];
  for (const sourcePath of paths.sort()) {
    const relativePath = path.relative(TOOL_PAYLOAD_ROOT, sourcePath).replaceAll(path.sep, "/");
    if (!canonicalRelative(relativePath))
      fail("tool_payload_entry_invalid", `Tool payload path is not canonical: ${relativePath}`);
    const bytes = await readFile(sourcePath);
    files.push({ relativePath, lengthBytes: bytes.length, sha256: sha(bytes) });
  }
  return { files, sha256: payloadDigest(files) };
}
export async function lockedTool() {
  await assertNoReparseTreePath(TOOL_PATH, "tool_reparse");
  const bytes = await readFile(TOOL_PATH).catch(() =>
    fail("tool_missing", `Locked ilspycmd executable is missing: ${TOOL_PATH}`),
  );
  if (sha(bytes) !== TOOL_SHA256) fail("tool_hash_mismatch", "Locked ilspycmd executable hash mismatch.");
  const payload = await toolPayloadState();
  const version = (await exec(TOOL_PATH, ["--version"], { encoding: "utf8", env: ilspyExecutionEnvironment() })).stdout
    .trim()
    .split(/\r?\n/)[0];
  if (version !== TOOL_VERSION) fail("tool_version_mismatch", "Locked ilspycmd version required.");
  return { path: TOOL_PATH, sha256: TOOL_SHA256, version, payload };
}
export async function decompile(target, { execute = exec } = {}) {
  await validateSnapshot(target);
  const output = await mkdtemp(path.join(process.env.TEMP || os.tmpdir(), "gb-m9-accept-boundary-"));
  try {
    await assertNoReparseTreePath(output, "decompile_tree_entry_invalid");
    const tool = await lockedTool();
    const before = { launcherSha256: tool.sha256, payload: tool.payload };
    await validateSnapshot(target);
    await execute(tool.path, [...OPTIONS, "-o", output, target.snapshotPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: ilspyExecutionEnvironment(),
    });
    await validateSnapshot(target);
    await assertNoReparseTreePath(output, "decompile_tree_entry_invalid");
    const after = await lockedTool();
    if (after.sha256 !== before.launcherSha256 || JSON.stringify(after.payload) !== JSON.stringify(before.payload))
      fail("tool_closure_drift", "Locked ilspycmd launcher/payload closure drifted during decompilation.");
    return {
      output,
      tool: { ...tool, executionEnvironmentPolicy: ILSPY_EXECUTION_ENVIRONMENT_POLICY },
      closure: { before, after: { launcherSha256: after.sha256, payload: after.payload } },
    };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
export async function sourceState(decompRoot) {
  const paths = await listCs(decompRoot);
  const normalized = paths
    .map((sourcePath) => ({
      sourcePath,
      relativePath: path.relative(decompRoot, sourcePath).replaceAll(path.sep, "/"),
    }))
    .sort((a, b) => comparePath(a.relativePath, b.relativePath));
  const files = [],
    buffers = {};
  for (const { sourcePath, relativePath } of normalized) {
    if (!canonicalRelative(relativePath))
      fail("decompile_tree_entry_invalid", `Decompiler source path is not canonical: ${relativePath}`);
    const bytes = await readFile(sourcePath);
    files.push({ relativePath, lengthBytes: bytes.length, sha256: sha(bytes) });
    buffers[relativePath] = bytes;
  }
  return { files, buffers };
}
function methodSlice(bytes, signature) {
  const source = bytes.toString("utf8");
  const first = source.indexOf(signature);
  if (first < 0 || source.indexOf(signature, first + signature.length) >= 0)
    fail("anchor_not_unique", `Method signature is missing or non-unique: ${signature}`);
  const open = source.indexOf("{", first + signature.length);
  if (open < 0) fail("anchor_not_unique", `Method body is missing: ${signature}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return {
        startByte: Buffer.byteLength(source.slice(0, first)),
        endByte: Buffer.byteLength(source.slice(0, i + 1)),
        bytes: Buffer.from(source.slice(first, i + 1)),
      };
  }
  fail("anchor_not_unique", `Method body is unterminated: ${signature}`);
}
function checkedAnchor(state, definition) {
  const [anchorId, relativePath, signature, required, forbidden, semanticRole] = definition;
  const file = state.buffers[relativePath];
  if (!file) fail("anchor_not_unique", `${anchorId} source file missing.`);
  const slice = methodSlice(file, signature);
  const text = slice.bytes.toString("utf8");
  if (required.some((token) => !text.includes(token)) || forbidden.some((token) => text.includes(token)))
    fail("anchor_semantics_missing", `${anchorId} does not establish its required method-bound semantics.`);
  return {
    anchorId,
    relativePath,
    methodSignature: signature,
    startByte: slice.startByte,
    endByte: slice.endByte,
    fileSha256: sha(file),
    methodSliceSha256: sha(slice.bytes),
    required,
    forbidden,
    semanticRole,
  };
}
export async function derive(target, decompRoot, authorityHash, tool = undefined) {
  const state = await sourceState(decompRoot);
  const locked = tool || (await lockedTool());
  const anchors = ANCHORS.map((definition) => checkedAnchor(state, definition));
  return {
    schemaVersion: 3,
    artifactKind: "portfolio_m9_accept_special_order_source_boundary",
    attestationId: "portfolio_m9_accept_special_order_source_boundary_v1",
    extractedAtUtc: new Date().toISOString(),
    topology: "single_player_native_companion",
    target: {
      gameVersion: TARGET_VERSION,
      assembly: "Stardew Valley.dll",
      lengthBytes: target.lengthBytes,
      sha256: target.sha256,
    },
    decompilation: {
      tool: "ilspycmd",
      toolPath: TOOL_PATH,
      toolSha256: TOOL_SHA256,
      toolVersion: TOOL_VERSION,
      toolPayloadRoot: TOOL_PAYLOAD_ROOT,
      toolPayload: {
        fileCount: locked.payload.files.length,
        sha256: locked.payload.sha256,
        files: locked.payload.files,
      },
      options: OPTIONS,
      executionEnvironmentPolicy: ILSPY_EXECUTION_ENVIRONMENT_POLICY,
      configurationDigest,
    },
    trustBoundary: TRUST_BOUNDARY,
    actionContractAuthority: { relativePath: CONTRACT_PATH, sha256: authorityHash },
    sourceManifest: { fileCount: state.files.length, sha256: manifestDigest(state.files), files: state.files },
    anchors,
    boundary: {
      prohibitedIngress: "StardewValley.Menus.SpecialOrdersBoard.receiveLeftClick",
      nonUiMethod: "StardewValley.FarmerTeam.AddSpecialOrder",
      missingSemantics: [
        "fresh selected available-offer membership",
        "accepted board-type commit",
        "single native acceptance transaction",
      ],
      approvedRoute: "none",
    },
    conclusion: {
      primitiveSourceRealizationStatus: "blocked",
      projectionState: "blocked",
      liveState: "not_performed",
      blockerCode: BLOCKER_CODE,
      nonClaim:
        "This is a source-boundary attestation only. It does not authorize an adapter, bridge, fixture, publication, live run, reward claim, objective, aggregate, or milestone.",
    },
  };
}
export function validate(model, authorityHash, state, payload = undefined) {
  exactFields(
    model,
    [
      "schemaVersion",
      "artifactKind",
      "attestationId",
      "extractedAtUtc",
      "topology",
      "target",
      "decompilation",
      "trustBoundary",
      "actionContractAuthority",
      "sourceManifest",
      "anchors",
      "boundary",
      "conclusion",
    ],
    "attestation",
  );
  exact(model.schemaVersion, 3, "schemaVersion");
  exact(model.artifactKind, "portfolio_m9_accept_special_order_source_boundary", "artifactKind");
  exact(model.attestationId, "portfolio_m9_accept_special_order_source_boundary_v1", "attestationId");
  if (
    typeof model.extractedAtUtc !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(model.extractedAtUtc) ||
    Number.isNaN(Date.parse(model.extractedAtUtc))
  )
    fail("schema_invalid", "extractedAtUtc must be a UTC timestamp.");
  exact(model.topology, "single_player_native_companion", "topology");
  exactFields(model.target, ["gameVersion", "assembly", "lengthBytes", "sha256"], "target");
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
  exactFields(
    model.decompilation,
    [
      "tool",
      "toolPath",
      "toolSha256",
      "toolVersion",
      "toolPayloadRoot",
      "toolPayload",
      "options",
      "executionEnvironmentPolicy",
      "configurationDigest",
    ],
    "decompilation",
  );
  if (
    model.decompilation.tool !== "ilspycmd" ||
    model.decompilation.toolPath !== TOOL_PATH ||
    model.decompilation.toolSha256 !== TOOL_SHA256 ||
    model.decompilation.toolVersion !== TOOL_VERSION ||
    model.decompilation.toolPayloadRoot !== TOOL_PAYLOAD_ROOT ||
    JSON.stringify(model.decompilation.options) !== JSON.stringify(OPTIONS) ||
    JSON.stringify(model.decompilation.executionEnvironmentPolicy) !==
      JSON.stringify(ILSPY_EXECUTION_ENVIRONMENT_POLICY) ||
    model.decompilation.configurationDigest !== configurationDigest
  )
    fail("decompile_config_drift", "Decompiler configuration drift.");
  exactFields(model.decompilation.toolPayload, ["fileCount", "sha256", "files"], "tool payload");
  if (
    !Array.isArray(model.decompilation.toolPayload.files) ||
    model.decompilation.toolPayload.fileCount !== model.decompilation.toolPayload.files.length ||
    payloadDigest(model.decompilation.toolPayload.files) !== model.decompilation.toolPayload.sha256
  )
    fail("tool_payload_invalid", "Tool payload manifest invalid.");
  if (
    !payload ||
    JSON.stringify(model.decompilation.toolPayload.files) !== JSON.stringify(payload.files) ||
    model.decompilation.toolPayload.sha256 !== payload.sha256
  )
    fail("tool_payload_drift", "Resolved ILSpy payload/dependency closure drift.");
  exactFields(model.trustBoundary, ["localCheckerTcb", "outsideLocalCheckerBoundary"], "trustBoundary");
  if (JSON.stringify(model.trustBoundary) !== JSON.stringify(TRUST_BOUNDARY))
    fail("trust_boundary_drift", "Source artifact trust boundary drift.");
  exactFields(model.actionContractAuthority, ["relativePath", "sha256"], "actionContractAuthority");
  if (
    model.actionContractAuthority.relativePath !== CONTRACT_PATH ||
    model.actionContractAuthority.sha256 !== authorityHash
  )
    fail("authority_drift", "Action contract authority drift.");
  exactFields(model.sourceManifest, ["fileCount", "sha256", "files"], "sourceManifest");
  if (
    !Array.isArray(model.sourceManifest.files) ||
    model.sourceManifest.files.length !== model.sourceManifest.fileCount
  )
    fail("manifest_invalid", "Manifest count invalid.");
  let previous = null;
  for (const file of model.sourceManifest.files) {
    exactFields(file, ["relativePath", "lengthBytes", "sha256"], "manifest file");
    if (!canonicalRelative(file.relativePath) || (previous !== null && comparePath(previous, file.relativePath) >= 0))
      fail("manifest_invalid", "Manifest paths must be canonical and strictly ordered.");
    previous = file.relativePath;
    hex(file.sha256, "manifest sha256");
  }
  if (manifestDigest(model.sourceManifest.files) !== model.sourceManifest.sha256)
    fail("manifest_hash_mismatch", "Manifest hash mismatch.");
  if (
    !state ||
    !Array.isArray(state.files) ||
    !state.buffers ||
    JSON.stringify(model.sourceManifest.files) !== JSON.stringify(state.files)
  )
    fail("manifest_tree_mismatch", "Manifest must exactly match the complete fresh decompile source tree.");
  if (!Array.isArray(model.anchors) || model.anchors.length !== ANCHORS.length)
    fail("anchor_set_invalid", "Anchor set invalid.");
  const ids = new Set();
  for (let i = 0; i < ANCHORS.length; i++) {
    const [id, relativePath, signature, required, forbidden, semanticRole] = ANCHORS[i];
    const anchor = model.anchors[i];
    exactFields(
      anchor,
      [
        "anchorId",
        "relativePath",
        "methodSignature",
        "startByte",
        "endByte",
        "fileSha256",
        "methodSliceSha256",
        "required",
        "forbidden",
        "semanticRole",
      ],
      "anchor",
    );
    if (ids.has(anchor.anchorId)) fail("anchor_set_invalid", "Duplicate anchor.");
    ids.add(anchor.anchorId);
    if (
      anchor.anchorId !== id ||
      anchor.relativePath !== relativePath ||
      anchor.methodSignature !== signature ||
      JSON.stringify(anchor.required) !== JSON.stringify(required) ||
      JSON.stringify(anchor.forbidden) !== JSON.stringify(forbidden) ||
      anchor.semanticRole !== semanticRole
    )
      fail("anchor_set_invalid", "Anchor identity drift.");
    const expected = checkedAnchor(state, ANCHORS[i]);
    if (
      anchor.startByte !== expected.startByte ||
      anchor.endByte !== expected.endByte ||
      anchor.fileSha256 !== expected.fileSha256 ||
      anchor.methodSliceSha256 !== expected.methodSliceSha256
    )
      fail("anchor_drift", `Anchor drift: ${id}.`);
  }
  exactFields(model.boundary, ["prohibitedIngress", "nonUiMethod", "missingSemantics", "approvedRoute"], "boundary");
  if (
    model.boundary.prohibitedIngress !== "StardewValley.Menus.SpecialOrdersBoard.receiveLeftClick" ||
    model.boundary.nonUiMethod !== "StardewValley.FarmerTeam.AddSpecialOrder" ||
    JSON.stringify(model.boundary.missingSemantics) !==
      JSON.stringify([
        "fresh selected available-offer membership",
        "accepted board-type commit",
        "single native acceptance transaction",
      ]) ||
    model.boundary.approvedRoute !== "none"
  )
    fail("boundary_claim_invalid", "Boundary claim drift.");
  exactFields(
    model.conclusion,
    ["primitiveSourceRealizationStatus", "projectionState", "liveState", "blockerCode", "nonClaim"],
    "conclusion",
  );
  if (
    model.conclusion.primitiveSourceRealizationStatus !== "blocked" ||
    model.conclusion.projectionState !== "blocked" ||
    model.conclusion.liveState !== "not_performed" ||
    model.conclusion.blockerCode !== BLOCKER_CODE ||
    typeof model.conclusion.nonClaim !== "string"
  )
    fail("conclusion_invalid", "Unsupported conclusion.");
  return {
    primitiveSourceRealizationStatus: "blocked",
    projectionState: "blocked",
    liveState: "not_performed",
    blockerCode: BLOCKER_CODE,
    fileCount: model.sourceManifest.fileCount,
    anchorCount: model.anchors.length,
  };
}
export { methodSlice, validateSnapshot };
