import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdtemp, readFile, readdir, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
export const TARGET_VERSION = "1.6.15.24356";
export const TARGET_LENGTH = 6268416;
export const TARGET_SHA256 = "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee";
export const TOOL_VERSION = "ilspycmd: 9.1.0.7988";
export const TOOL_PATH = "C:/Users/27251/.dotnet/tools/ilspycmd.exe";
export const TOOL_SHA256 = "5da34ef8b7a3d7e2057d27a0a84ec8e1ccdddb35d6d519058fce1e2f374c4c7f";
export const TOOL_PAYLOAD_ROOT =
  "C:/Users/27251/.dotnet/tools/.store/ilspycmd/9.1.0.7988/ilspycmd/9.1.0.7988/tools/net8.0/any";
export const OPTIONS = Object.freeze(["--disable-updatecheck", "-p", "--nested-directories"]);
export const BLOCKER_CODE = "native_sleep_ingress_unavailable";
export const ILSPY_EXECUTION_ENVIRONMENT_POLICY = Object.freeze({
  mode: "explicit_windows_runtime_allowlist",
  retainedVariables: Object.freeze(["SystemRoot", "WINDIR", "TEMP", "TMP"]),
  rejectsInheritedToolConfiguration: true,
});
export const TRUST_BOUNDARY = Object.freeze({
  localCheckerTcb: Object.freeze([
    "Node.js checker process",
    "locked launcher and payload closure hashes",
    "fresh private target snapshot content, ACL, and identity checks with no-reparse validation around access",
  ]),
  outsideLocalCheckerBoundary: Object.freeze([
    "Windows OS and .NET apphost/runtime",
    "same-user, administrator, or kernel hostile-process replacement between observations and execution",
  ]),
});
export const NON_CLAIM =
  "This exact-target, finite candidate classification does not state global or cross-version nonexistence and does not establish an ingress, action execution, receipt, persistence, publication, or live closure.";
export const CANDIDATE_INGRESSES = Object.freeze([
  {
    id: "normal_ui_confirmation_path",
    classification: "forbidden",
    reason: "The normal TouchAction Sleep path requires native player movement and confirmation.",
  },
  {
    id: "private_sleep_continuations",
    classification: "forbidden",
    reason: "Sleep_Yes reaches private GameLocation.startSleep and doSleep continuations.",
  },
  {
    id: "raw_day_or_save_lifecycle",
    classification: "forbidden",
    reason: "Game1.NewDay and SaveGame.Save are raw lifecycle methods, not a typed sleep ingress.",
  },
  {
    id: "public_generic_dialogue_dispatcher",
    classification: "prohibited",
    reason: 'answerDialogueAction("Sleep_Yes") skips the semantic confirmation state.',
  },
  {
    id: "approved_typed_non_ui_semantic_ingress",
    classification: "absent",
    reason: "No approved typed non-UI ingress is established in this frozen candidate classification.",
  },
]);
export const PROHIBITIONS = Object.freeze([
  "UI/input",
  "private GameLocation.startSleep",
  "private GameLocation.doSleep",
  "Game1.NewDay",
  "SaveGame.Save",
  "public answerDialogueAction dispatch",
  "reflection",
  "save edit",
]);
export const ANCHORS = Object.freeze([
  [
    "normal_touchaction_sleep_invitation",
    "StardewValley/GameLocation.cs",
    "public virtual void performTouchAction(string[] action, Vector2 playerStandingPosition)",
    [
      'if (value == "Sleep" && !Game1.newDay && Game1.shouldTimePass() && Game1.player.hasMoved && !Game1.player.passedOut)',
      'createQuestionDialogue(Game1.content.LoadString("Strings\\\\Locations:FarmHouse_Bed_GoToSleep"), createYesNoResponses(), "Sleep", null);',
    ],
    [],
    "The normal TouchAction Sleep branch gates and creates the native confirmation dialogue.",
  ],
  [
    "sleep_yes_dialogue_continuation",
    "StardewValley/GameLocation.cs",
    "public virtual bool answerDialogueAction(string questionAndAnswer, string[] questionParams)",
    ['case "Sleep_Yes":', "startSleep();"],
    [],
    "The public generic dialogue dispatcher maps Sleep_Yes to the private sleep continuation; it is not an approved semantic ingress.",
  ],
  [
    "private_start_sleep",
    "StardewValley/GameLocation.cs",
    "private void startSleep()",
    ["Game1.player.timeWentToBed.Value = Game1.timeOfDay;", "doSleep();"],
    [],
    "The private continuation invokes doSleep directly in the non-multiplayer normal chain.",
  ],
  [
    "private_do_sleep",
    "StardewValley/GameLocation.cs",
    "private void doSleep()",
    [
      "Game1.NewDay(600f);",
      "Game1.NewDay(0f);",
      "Game1.player.lastSleepLocation.Value = Game1.currentLocation.NameOrUniqueName;",
    ],
    [],
    "The private continuation starts the day-transition lifecycle and records sleep location.",
  ],
  [
    "new_day_lifecycle_entry",
    "StardewValley/Game1.cs",
    "public static void NewDay(float timeToPause)",
    ["newDay = true;", "newDaySync.create();"],
    [],
    "NewDay is a raw lifecycle entry reached from doSleep, not a sleep semantic ingress.",
  ],
  [
    "save_raw_serializer",
    "StardewValley/SaveGame.cs",
    "public static IEnumerator<int> Save()",
    ['LogVerbose("SaveGame.Save() called.");', "IEnumerator<int> loader = getSaveEnumerator();"],
    [],
    "SaveGame.Save is a raw serializer and does not establish the normal sleep confirmation path.",
  ],
]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const digest = (files) =>
  sha(files.map((file) => `${file.relativePath}\t${file.lengthBytes}\t${file.sha256}`).join("\n") + "\n");
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
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function exactFields(value, fields, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())
  )
    fail("schema_invalid", `${label} fields drift.`);
}
function normalPath(relativePath) {
  return (
    typeof relativePath === "string" &&
    relativePath &&
    !relativePath.startsWith("/") &&
    !relativePath.includes("\\") &&
    relativePath.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function sorted(a, b) {
  return a.relativePath.localeCompare(b.relativePath);
}
const WINDOWS_BOOTSTRAP_POWERSHELL_ATTRIBUTES_SOURCE =
  "$paths=$env:GB_SLEEP_BOOTSTRAP_PATHS|ConvertFrom-Json -ErrorAction Stop; [object[]]$attributes=@($paths|ForEach-Object {[int]((Get-Item -Force -LiteralPath $_ -ErrorAction Stop).Attributes)}); ConvertTo-Json -InputObject $attributes -Compress";
async function bootstrapNoLinkAncestors(file, code) {
  let current = path.resolve(file),
    root = path.parse(current).root;
  for (;;) {
    const info = await lstat(current).catch(() => fail(code, `Missing bootstrap path: ${current}`));
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      fail(code, `Invalid bootstrap path: ${current}`);
    if (current === root) return;
    current = path.dirname(current);
  }
}
async function validatedWindowsPowerShellPath({
  missingCode = "reparse_query_failed",
  reparseCode = "reparse_query_failed",
} = {}) {
  if (process.platform !== "win32") return undefined;
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== "string" || !systemRoot)
    fail(missingCode, "SystemRoot is required to locate powershell.exe.");
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const ancestors = [];
  for (let current = path.resolve(executable), root = path.parse(current).root; ; current = path.dirname(current)) {
    ancestors.push(current);
    if (current === root) break;
  }
  // This is the sole bootstrap exception: Windows attributes cannot be queried until a
  // PowerShell process exists. It first rejects link/type substitutions with Node, then
  // the restricted bootstrap process verifies every executable ancestor's reparse bit.
  await bootstrapNoLinkAncestors(executable, reparseCode);
  const { stdout } = await exec(
    executable,
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_BOOTSTRAP_POWERSHELL_ATTRIBUTES_SOURCE],
    {
      encoding: "utf8",
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        GB_SLEEP_BOOTSTRAP_PATHS: JSON.stringify(ancestors),
      },
    },
  ).catch(() => fail(reparseCode, "PowerShell bootstrap reparse validation failed."));
  let attributes;
  try {
    attributes = JSON.parse(stdout);
  } catch {
    fail(reparseCode, "PowerShell bootstrap attributes could not be parsed.");
  }
  if (
    !Array.isArray(attributes) ||
    attributes.length !== ancestors.length ||
    attributes.some((value) => !Number.isSafeInteger(value) || (value & 0x400) !== 0)
  )
    fail(reparseCode, "PowerShell bootstrap detected an ambiguous or reparse ancestor.");
  return executable.replaceAll("\\", "/");
}
async function windowsAttributes(file) {
  if (process.platform !== "win32") return undefined;
  const powershellPath = await validatedWindowsPowerShellPath();
  const { stdout } = await exec(
    powershellPath,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$p=$env:GB_SLEEP_REPARSE_PATH;[int](Get-Item -Force -LiteralPath $p -ErrorAction Stop).Attributes",
    ],
    {
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, GB_SLEEP_REPARSE_PATH: file },
    },
  ).catch(() => fail("reparse_query_failed", `Windows attribute query failed: ${file}`));
  const value = Number(stdout.trim());
  if (!Number.isSafeInteger(value))
    fail("reparse_query_failed", `Windows attributes are missing or ambiguous: ${file}`);
  return value;
}
function tuple(info, attributes) {
  if (![info.dev, info.ino, info.mode].every(Number.isFinite)) return null;
  return `${info.dev}:${info.ino}:${info.mode}:${attributes ?? "nonwindows"}`;
}
export async function assertNoReparsePoint(
  file,
  {
    missingCode = "path_missing",
    reparseCode = "reparse_point_detected",
    platform = process.platform,
    lstatPath = lstat,
    statPath = stat,
    windowsAttributesOf = windowsAttributes,
  } = {},
) {
  const info = await lstatPath(file).catch(() => fail(missingCode, `Missing path: ${file}`));
  const attributes = platform === "win32" ? await windowsAttributesOf(file) : undefined;
  if (
    info.isSymbolicLink() ||
    (platform === "win32" && !Number.isSafeInteger(attributes)) ||
    (attributes & 0x400) !== 0 ||
    (!info.isFile() && !info.isDirectory())
  )
    fail(reparseCode, `Reparse point or non-normal path is not allowed: ${file}`);
  const resolved = await statPath(file).catch(() => fail(missingCode, `Missing path: ${file}`));
  if (!resolved.isFile() && !resolved.isDirectory()) fail(reparseCode, `Path changed type: ${file}`);
  return {
    info: resolved,
    identity: tuple(resolved, attributes) || fail(reparseCode, `Path identity is ambiguous: ${file}`),
  };
}
export async function assertNoReparseAncestors(file, options = {}) {
  let current = path.resolve(file),
    root = path.parse(current).root;
  const identities = [];
  for (;;) {
    identities.push([current, (await assertNoReparsePoint(current, options)).identity]);
    if (current === root) return identities;
    current = path.dirname(current);
  }
}
export async function capturePathBoundary(file, code, options = {}) {
  return assertNoReparseAncestors(file, { ...options, missingCode: code, reparseCode: code });
}
export async function assertPathBoundary(boundary, code, options = {}) {
  for (const [file, identity] of boundary) {
    const now = (await assertNoReparsePoint(file, { ...options, missingCode: code, reparseCode: code })).identity;
    if (now !== identity) fail(code, `Path identity drift: ${file}`);
  }
}
async function checkedPath(file, code) {
  return capturePathBoundary(file, code);
}
async function checkedRead(file, code, encoding) {
  const boundary = await checkedPath(file, code);
  const bytes = await readFile(file, encoding);
  await assertPathBoundary(boundary, code);
  return bytes;
}
export async function checkedReadFile(file, code, encoding) {
  return checkedRead(file, code, encoding);
}
export async function checkedMkdir(directory, code) {
  const parent = await checkedPath(path.dirname(directory), code);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await assertPathBoundary(parent, code);
  return checkedPath(directory, code);
}
export async function checkedMkdtemp(prefix, code) {
  const parent = await checkedPath(path.dirname(prefix), code);
  const output = await mkdtemp(prefix);
  await assertPathBoundary(parent, code);
  await checkedPath(output, code);
  return output;
}
export async function checkedRemove(root, code) {
  if (!root) return;
  const boundary = await checkedPath(root, code);
  await rm(root, { recursive: true, force: false });
  for (const [ancestor] of boundary.slice(1))
    await assertNoReparsePoint(ancestor, { missingCode: code, reparseCode: code });
}
export async function checkedAtomicWrite(file, content, code) {
  const parent = path.dirname(file),
    parentBoundary = await checkedPath(parent, code),
    temporary = path.join(parent, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let tempCreated = false;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    tempCreated = true;
    const tempBoundary = await checkedPath(temporary, code);
    await assertPathBoundary(parentBoundary, code);
    const existing = await lstat(file)
      .then(() => true)
      .catch(() => false);
    const outputBoundary = existing ? await checkedPath(file, code) : null;
    await assertPathBoundary(parentBoundary, code);
    await rename(temporary, file);
    tempCreated = false;
    await assertPathBoundary(parentBoundary, code);
    await checkedPath(file, code);
    if (outputBoundary) void outputBoundary;
    await assertPathBoundary(tempBoundary.slice(1), code).catch(() => {});
  } finally {
    if (tempCreated) {
      await assertPathBoundary(parentBoundary, code);
      await rm(temporary, { force: true });
      await assertPathBoundary(parentBoundary, code);
    }
  }
}
export function ilspyExecutionEnvironment(source = process.env) {
  const env = {};
  for (const name of ILSPY_EXECUTION_ENVIRONMENT_POLICY.retainedVariables)
    if (typeof source[name] === "string" && source[name]) env[name] = source[name];
  return env;
}
async function filesUnder(root, current = root, output = [], csOnly = false) {
  const code = csOnly ? "decompile_tree_invalid" : "tool_payload_invalid";
  const boundary = await checkedPath(current, code);
  const entries = await readdir(current, { withFileTypes: true });
  await assertPathBoundary(boundary, code);
  for (const entry of entries) {
    const item = path.join(current, entry.name);
    if (entry.isSymbolicLink()) fail(code, `Symlink: ${item}`);
    if (entry.isDirectory()) await filesUnder(root, item, output, csOnly);
    else if (entry.isFile() && (!csOnly || item.endsWith(".cs"))) output.push(item);
    else if (!entry.isFile()) fail(code, `Invalid tree entry: ${item}`);
  }
  return output;
}
export const WINDOWS_SNAPSHOT_VALIDATOR_SOURCE =
  "$r=$env:GB_SLEEP_ROOT;$f=$env:GB_SLEEP_FILE;$icacls=$env:GB_SLEEP_ICACLS;$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if([string]::IsNullOrWhiteSpace($icacls) -or -not (Test-Path -LiteralPath $icacls -PathType Leaf)){throw 'icacls missing'}; foreach($p in @($r,$f)){if(((Get-Item -Force -LiteralPath $p -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'reparse'}}; $acl=Get-Acl -LiteralPath $r -ErrorAction Stop; $facts=[pscustomobject]@{currentSid=$currentSid;ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {[pscustomobject]@{sid=$_.IdentityReference.Value;accessType=$_.AccessControlType.ToString();rights=[int]$_.FileSystemRights;inheritanceFlags=[int]$_.InheritanceFlags;propagationFlags=[int]$_.PropagationFlags;isInherited=[bool]$_.IsInherited}})}; $facts | ConvertTo-Json -Compress -Depth 4";
const FULL_CONTROL = 2032127;
const REQUIRED_INHERITANCE_FLAGS = 3;
export function validateWindowsSnapshotAclFacts(facts) {
  if (
    !facts ||
    typeof facts !== "object" ||
    Array.isArray(facts) ||
    JSON.stringify(Object.keys(facts).sort()) !== JSON.stringify(["currentSid", "ownerSid", "rules"].sort())
  )
    fail("snapshot_boundary_invalid", "Windows snapshot ACL facts are missing or malformed.");
  if (
    typeof facts.currentSid !== "string" ||
    !facts.currentSid ||
    typeof facts.ownerSid !== "string" ||
    !facts.ownerSid ||
    !Array.isArray(facts.rules)
  )
    fail("snapshot_boundary_invalid", "Windows snapshot ACL facts are missing or malformed.");
  if (facts.ownerSid !== facts.currentSid || facts.rules.length !== 1)
    fail("snapshot_boundary_invalid", "Private Windows snapshot ACL must have exactly one owner ACE.");
  const [rule] = facts.rules;
  if (
    !rule ||
    typeof rule !== "object" ||
    Array.isArray(rule) ||
    JSON.stringify(Object.keys(rule).sort()) !==
      JSON.stringify(["sid", "accessType", "rights", "inheritanceFlags", "propagationFlags", "isInherited"].sort()) ||
    rule.sid !== facts.currentSid ||
    rule.accessType !== "Allow" ||
    rule.rights !== FULL_CONTROL ||
    rule.inheritanceFlags !== REQUIRED_INHERITANCE_FLAGS ||
    rule.propagationFlags !== 0 ||
    rule.isInherited !== false
  )
    fail("snapshot_boundary_invalid", "Private Windows snapshot ACL must be one explicit current-SID FullControl ACE.");
  return facts;
}
async function windowsSystemExecutable(name) {
  if (process.platform !== "win32") return undefined;
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== "string" || !systemRoot)
    fail("snapshot_boundary_invalid", `SystemRoot is required to locate ${name}.`);
  const executable = path.join(systemRoot, "System32", name);
  await assertNoReparseAncestors(executable, {
    missingCode: "snapshot_boundary_invalid",
    reparseCode: "snapshot_boundary_invalid",
  });
  return executable.replaceAll("\\", "/");
}
async function windowsIcaclsPath() {
  return windowsSystemExecutable("icacls.exe");
}
async function windowsPowerShellPath() {
  return validatedWindowsPowerShellPath({
    missingCode: "snapshot_boundary_invalid",
    reparseCode: "snapshot_boundary_invalid",
  });
}
export function windowsSnapshotValidatorEnvironment(snapshotRoot, snapshotPath, icaclsPath, source = process.env) {
  const env = { GB_SLEEP_ROOT: snapshotRoot, GB_SLEEP_FILE: snapshotPath, GB_SLEEP_ICACLS: icaclsPath };
  for (const name of ["SystemRoot", "WINDIR"])
    if (typeof source[name] === "string" && source[name]) env[name] = source[name];
  return env;
}
export async function windowsSnapshotValidatorInvocation(snapshotRoot, snapshotPath) {
  const [powershellPath, icaclsPath] = await Promise.all([windowsPowerShellPath(), windowsIcaclsPath()]);
  if (!powershellPath || !icaclsPath)
    fail("snapshot_boundary_invalid", "Explicit Windows validator paths are required.");
  return {
    executable: powershellPath,
    args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SNAPSHOT_VALIDATOR_SOURCE],
    options: { encoding: "utf8", env: windowsSnapshotValidatorEnvironment(snapshotRoot, snapshotPath, icaclsPath) },
  };
}
async function windowsSnapshotBoundary(snapshotRoot, snapshotPath) {
  if (process.platform !== "win32") return;
  const invocation = await windowsSnapshotValidatorInvocation(snapshotRoot, snapshotPath);
  const { stdout } = await exec(invocation.executable, invocation.args, invocation.options).catch(() =>
    fail("snapshot_boundary_invalid", "Private Windows snapshot ACL/reparse validation failed."),
  );
  let facts;
  try {
    facts = JSON.parse(stdout);
  } catch {
    fail("snapshot_boundary_invalid", "Windows snapshot ACL facts could not be parsed.");
  }
  validateWindowsSnapshotAclFacts(facts);
}
async function validateSnapshot(target) {
  if (
    !target?.snapshotPath ||
    !target.snapshotRoot ||
    target.lengthBytes !== TARGET_LENGTH ||
    target.sha256 !== TARGET_SHA256
  )
    fail("target_snapshot_required", "Verified snapshot required.");
  const rootBoundary = await checkedPath(target.snapshotRoot, "snapshot_boundary_invalid"),
    leafBoundary = await checkedPath(target.snapshotPath, "snapshot_boundary_invalid");
  const bytes = await checkedRead(target.snapshotPath, "snapshot_boundary_invalid");
  await assertPathBoundary(rootBoundary, "snapshot_boundary_invalid");
  await assertPathBoundary(leafBoundary, "snapshot_boundary_invalid");
  await windowsSnapshotBoundary(target.snapshotRoot, target.snapshotPath);
  if (bytes.length !== TARGET_LENGTH || sha(bytes) !== TARGET_SHA256)
    fail("target_snapshot_mismatch", "Target snapshot content changed.");
}
export async function targetAssembly(gamePath) {
  if (!gamePath) fail("game_path_required", "Explicit --game-path or GAMEBUDDY_STARDEW_GAME_PATH is required.");
  const assemblyPath = path.join(path.resolve(gamePath), "Stardew Valley.dll"),
    sourceBoundary = await checkedPath(assemblyPath, "target_assembly_missing");
  const bytes = await checkedRead(assemblyPath, "target_assembly_missing");
  await assertPathBoundary(sourceBoundary, "target_assembly_missing");
  if (bytes.length !== TARGET_LENGTH || sha(bytes) !== TARGET_SHA256)
    fail("target_snapshot_mismatch", "Target assembly does not match 1.6.15.24356.");
  const snapshotRoot = await checkedMkdtemp(
      path.join(process.env.TEMP || os.tmpdir(), "gb-sleep-day-source-"),
      "snapshot_boundary_invalid",
    ),
    snapshotPath = path.join(snapshotRoot, "Stardew Valley.dll");
  try {
    const icaclsPath = await windowsIcaclsPath();
    if (process.platform === "win32") {
      const powershellPath = await windowsPowerShellPath();
      const { stdout } = await exec(
        powershellPath,
        ["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
        { encoding: "utf8", env: ilspyExecutionEnvironment() },
      );
      await exec(icaclsPath, [snapshotRoot, "/inheritance:r", "/grant:r", `*${stdout.trim()}:(OI)(CI)F`], {
        encoding: "utf8",
        env: ilspyExecutionEnvironment(),
      }).catch(() => fail("snapshot_boundary_invalid", "Could not enforce private snapshot ACL."));
    }
    await checkedAtomicWrite(snapshotPath, bytes, "snapshot_boundary_invalid");
    await windowsSnapshotBoundary(snapshotRoot, snapshotPath);
    const version = (
      await exec(
        await windowsPowerShellPath(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$p=$env:GB_SLEEP_ASSEMBLY;(Get-Item -LiteralPath $p).VersionInfo.FileVersion",
        ],
        { encoding: "utf8", env: { ...ilspyExecutionEnvironment(), GB_SLEEP_ASSEMBLY: snapshotPath } },
      )
    ).stdout.trim();
    await validateSnapshot({ snapshotRoot, snapshotPath, lengthBytes: bytes.length, sha256: sha(bytes) });
    if (version !== TARGET_VERSION) fail("target_version_mismatch", "Target assembly version mismatch.");
    return { snapshotRoot, snapshotPath, lengthBytes: bytes.length, sha256: sha(bytes), fileVersion: version };
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}
export async function disposeTarget(target) {
  if (target?.snapshotRoot) await checkedRemove(target.snapshotRoot, "snapshot_cleanup_failed");
}
export async function lockedTool() {
  const launcherBoundary = await checkedPath(TOOL_PATH, "tool_missing"),
    launcher = await checkedRead(TOOL_PATH, "tool_missing");
  if (sha(launcher) !== TOOL_SHA256) fail("tool_hash_mismatch", "Locked ilspycmd hash mismatch.");
  const paths = await filesUnder(TOOL_PAYLOAD_ROOT),
    files = [];
  for (const item of paths.sort()) {
    const relativePath = path.relative(TOOL_PAYLOAD_ROOT, item).replaceAll(path.sep, "/");
    if (!normalPath(relativePath)) fail("tool_payload_invalid", "Noncanonical tool payload path.");
    const bytes = await checkedRead(item, "tool_payload_invalid");
    files.push({ relativePath, lengthBytes: bytes.length, sha256: sha(bytes) });
  }
  await assertPathBoundary(launcherBoundary, "tool_closure_drift");
  const version = (await exec(TOOL_PATH, ["--version"], { encoding: "utf8", env: ilspyExecutionEnvironment() })).stdout
    .trim()
    .split(/\r?\n/)[0];
  await assertPathBoundary(launcherBoundary, "tool_closure_drift");
  if (version !== TOOL_VERSION) fail("tool_version_mismatch", "Locked ilspycmd version mismatch.");
  return { path: TOOL_PATH, sha256: TOOL_SHA256, payload: { files, sha256: digest(files) } };
}
export async function decompile(target, { execute = exec } = {}) {
  await validateSnapshot(target);
  const output = await checkedMkdtemp(
    path.join(process.env.TEMP || os.tmpdir(), "gb-sleep-day-decompile-"),
    "decompile_tree_invalid",
  );
  try {
    const outputBoundary = await checkedPath(output, "decompile_tree_invalid"),
      tool = await lockedTool(),
      before = { launcherSha256: tool.sha256, payload: tool.payload };
    await validateSnapshot(target);
    await execute(tool.path, [...OPTIONS, "-o", output, target.snapshotPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: ilspyExecutionEnvironment(),
    });
    await validateSnapshot(target);
    await assertPathBoundary(outputBoundary, "decompile_tree_invalid");
    const after = await lockedTool();
    if (after.sha256 !== before.launcherSha256 || JSON.stringify(after.payload) !== JSON.stringify(before.payload))
      fail("tool_closure_drift", "Tool closure drifted during decompilation.");
    return { output, tool: { ...tool, executionEnvironmentPolicy: ILSPY_EXECUTION_ENVIRONMENT_POLICY } };
  } catch (error) {
    await checkedRemove(output, "decompile_cleanup_failed").catch(() => {});
    throw error;
  }
}
export async function sourceState(root) {
  const rootBoundary = await checkedPath(root, "decompile_tree_invalid"),
    sourceFiles = await filesUnder(root, root, [], true),
    files = [],
    buffers = {};
  for (const item of sourceFiles.sort()) {
    const relativePath = path.relative(root, item).replaceAll(path.sep, "/");
    if (!normalPath(relativePath)) fail("decompile_tree_invalid", "Noncanonical source path.");
    const bytes = await checkedRead(item, "decompile_tree_invalid");
    files.push({ relativePath, lengthBytes: bytes.length, sha256: sha(bytes) });
    buffers[relativePath] = bytes;
  }
  await assertPathBoundary(rootBoundary, "decompile_tree_invalid");
  return { files, buffers };
}
export function methodSlice(bytes, signature) {
  const source = bytes.toString("utf8"),
    first = source.indexOf(signature);
  if (first < 0 || source.indexOf(signature, first + signature.length) >= 0)
    fail("anchor_not_unique", `Missing/non-unique method: ${signature}`);
  const open = source.indexOf("{", first + signature.length);
  let depth = 0;
  for (let i = open; i >= open && i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return {
        startByte: Buffer.byteLength(source.slice(0, first)),
        endByte: Buffer.byteLength(source.slice(0, i + 1)),
        bytes: Buffer.from(source.slice(first, i + 1)),
      };
  }
  fail("anchor_not_unique", `Unterminated method: ${signature}`);
}
function anchor(state, definition) {
  const [anchorId, relativePath, methodSignature, required, forbidden, semanticRole] = definition,
    file = state.buffers[relativePath];
  if (!file) fail("anchor_not_unique", `Missing source: ${relativePath}`);
  const slice = methodSlice(file, methodSignature),
    text = slice.bytes.toString("utf8");
  if (required.some((token) => !text.includes(token)) || forbidden.some((token) => text.includes(token)))
    fail("anchor_semantics_missing", `${anchorId} semantics missing.`);
  return {
    anchorId,
    relativePath,
    methodSignature,
    startByte: slice.startByte,
    endByte: slice.endByte,
    fileSha256: sha(file),
    methodSliceSha256: sha(slice.bytes),
    required,
    forbidden,
    semanticRole,
  };
}
export async function derive(target, decompRoot, tool) {
  const state = await sourceState(decompRoot),
    locked = tool || (await lockedTool());
  return {
    schemaVersion: 3,
    artifactKind: "portfolio_sleep_day_source_boundary",
    attestationId: "portfolio_sleep_day_source_boundary_v3",
    extractedAtUtc: new Date().toISOString(),
    action: "single_player_sleep_and_advance_day",
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
      toolPayload: { fileCount: locked.payload.files.length, ...locked.payload },
      options: OPTIONS,
      executionEnvironmentPolicy: ILSPY_EXECUTION_ENVIRONMENT_POLICY,
      configurationDigest,
    },
    trustBoundary: TRUST_BOUNDARY,
    sourceManifest: { fileCount: state.files.length, sha256: digest(state.files), files: state.files },
    anchors: ANCHORS.map((definition) => anchor(state, definition)),
    candidateIngressClassification: CANDIDATE_INGRESSES,
    prohibitions: PROHIBITIONS,
    conclusion: {
      attestationState: "blocked_attested",
      blockerCode: BLOCKER_CODE,
      approvedTypedNonUiIngress: "none",
      nonClaim: NON_CLAIM,
    },
  };
}
export function validate(model, state, payload) {
  exactFields(
    model,
    [
      "schemaVersion",
      "artifactKind",
      "attestationId",
      "extractedAtUtc",
      "action",
      "topology",
      "target",
      "decompilation",
      "trustBoundary",
      "sourceManifest",
      "anchors",
      "candidateIngressClassification",
      "prohibitions",
      "conclusion",
    ],
    "attestation",
  );
  if (
    model.schemaVersion !== 3 ||
    model.artifactKind !== "portfolio_sleep_day_source_boundary" ||
    model.attestationId !== "portfolio_sleep_day_source_boundary_v3" ||
    model.action !== "single_player_sleep_and_advance_day" ||
    model.topology !== "single_player_native_companion"
  )
    fail("schema_invalid", "Identity drift.");
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
  exactFields(model.trustBoundary, ["localCheckerTcb", "outsideLocalCheckerBoundary"], "trustBoundary");
  if (JSON.stringify(model.trustBoundary) !== JSON.stringify(TRUST_BOUNDARY))
    fail("trust_boundary_drift", "Trust boundary drift.");
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
    fail("decompile_config_drift", "Tool configuration drift.");
  if (
    !payload ||
    JSON.stringify(model.decompilation.toolPayload.files) !== JSON.stringify(payload.files) ||
    model.decompilation.toolPayload.sha256 !== payload.sha256 ||
    model.decompilation.toolPayload.fileCount !== payload.files.length
  )
    fail("tool_payload_drift", "Tool payload drift.");
  exactFields(model.sourceManifest, ["fileCount", "sha256", "files"], "sourceManifest");
  if (
    !Array.isArray(model.sourceManifest.files) ||
    model.sourceManifest.fileCount !== model.sourceManifest.files.length ||
    JSON.stringify(model.sourceManifest.files) !== JSON.stringify(state?.files) ||
    model.sourceManifest.sha256 !== digest(state.files)
  )
    fail("manifest_tree_mismatch", "Complete source manifest drift.");
  if (!Array.isArray(model.anchors) || model.anchors.length !== ANCHORS.length)
    fail("anchor_set_invalid", "Anchor set drift.");
  for (let i = 0; i < ANCHORS.length; i++)
    if (JSON.stringify(model.anchors[i]) !== JSON.stringify(anchor(state, ANCHORS[i])))
      fail("anchor_drift", `Anchor drift: ${ANCHORS[i][0]}.`);
  if (JSON.stringify(model.candidateIngressClassification) !== JSON.stringify(CANDIDATE_INGRESSES))
    fail("candidate_universe_drift", "Candidate classification drift.");
  if (JSON.stringify(model.prohibitions) !== JSON.stringify(PROHIBITIONS))
    fail("prohibition_drift", "Prohibition drift.");
  exactFields(
    model.conclusion,
    ["attestationState", "blockerCode", "approvedTypedNonUiIngress", "nonClaim"],
    "conclusion",
  );
  if (
    model.conclusion.attestationState !== "blocked_attested" ||
    model.conclusion.blockerCode !== BLOCKER_CODE ||
    model.conclusion.approvedTypedNonUiIngress !== "none" ||
    model.conclusion.nonClaim !== NON_CLAIM
  )
    fail("conclusion_invalid", "Conclusion drift.");
  return {
    state: "blocked_attested",
    blockerCode: BLOCKER_CODE,
    fileCount: state.files.length,
    anchorCount: ANCHORS.length,
  };
}
export { sha, digest };
