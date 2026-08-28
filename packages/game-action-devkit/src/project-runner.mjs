import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COMMANDS = new Set(["inventory", "check", "preflight", "run-live", "status"]);
const MANIFEST_KEYS = new Set(["schema", "gameId", "projectVersion", "adapter", "portfolio", "toolInventory", "evidenceRoot", "defaultProfileExample"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fail(code) {
  throw new Error(`game_action_project_${code}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRelativeFile(value, code) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value) || value.includes("\\")) fail(code);
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) fail(code);
  return normalized;
}

function assertId(value, code) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(code);
}

export function mintEvidenceRunId() {
  return `ar1_${Date.now().toString(36)}_${randomBytes(16).toString("hex")}`;
}

async function assertCanonicalOwnedDirectory(baseDirectory, declaredDirectory) {
  const relative = path.relative(baseDirectory, declaredDirectory);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) fail("manifest_path_escape");
  let current = baseDirectory;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail("manifest_dependency_escape");
    } catch (error) {
      if (error?.code === "ENOENT") return declaredDirectory;
      throw error;
    }
  }
  return realpath(declaredDirectory);
}

export function normalizeInvocation(invocation) {
  if (!isObject(invocation)) fail("invalid_invocation");
  const allowed = new Set(["command", "actionId", "profileFile", "briefFile"]);
  if (Object.keys(invocation).some((key) => !allowed.has(key))) fail("invalid_invocation_key");
  if (!COMMANDS.has(invocation.command)) fail("invalid_command");
  const normalized = { command: invocation.command };
  if (invocation.actionId !== undefined) {
    assertId(invocation.actionId, "invalid_action_id");
    normalized.actionId = invocation.actionId;
  }
  if (invocation.profileFile !== undefined) {
    if (typeof invocation.profileFile !== "string" || !path.isAbsolute(invocation.profileFile) || invocation.profileFile.includes("\0") || path.normalize(invocation.profileFile) !== invocation.profileFile) fail("invalid_profileFile");
    normalized.profileFile = invocation.profileFile;
  }
  if (invocation.briefFile !== undefined) normalized.briefFile = assertRelativeFile(invocation.briefFile, "invalid_briefFile");
  return Object.freeze(normalized);
}

export async function readActionProjectManifest(projectFile) {
  if (typeof projectFile !== "string" || projectFile.length === 0) fail("invalid_manifest_path");
  const resolved = path.resolve(projectFile);
  let raw;
  try { raw = JSON.parse(await readFile(resolved, "utf8")); } catch { fail("manifest_unreadable"); }
  if (!isObject(raw) || Object.keys(raw).some((key) => !MANIFEST_KEYS.has(key)) || Object.keys(raw).length !== MANIFEST_KEYS.size) fail("manifest_invalid");
  if (raw.schema !== "gamebuddy-action-project/v1" || !Number.isInteger(raw.projectVersion) || raw.projectVersion < 1) fail("manifest_invalid");
  assertId(raw.gameId, "invalid_game_id");
  const declaredBaseDirectory = path.dirname(resolved);
  const fileReferences = [
    ["adapterFile", raw.adapter, "invalid_adapter"],
    ["portfolioFile", raw.portfolio, "invalid_portfolio"],
    ["inventoryFile", raw.toolInventory, "invalid_tool_inventory"],
    ["defaultProfileExampleFile", raw.defaultProfileExample, "invalid_default_profile_example"],
  ];
  let baseDirectory;
  try { baseDirectory = await realpath(declaredBaseDirectory); } catch { fail("manifest_dependency_missing"); }
  const files = {};
  try {
    await Promise.all(fileReferences.map(async ([name, value, code]) => {
      const declared = path.resolve(baseDirectory, assertRelativeFile(value, code));
      if (!declared.startsWith(`${baseDirectory}${path.sep}`)) fail("manifest_path_escape");
      const canonical = await realpath(declared);
      if (!canonical.startsWith(`${baseDirectory}${path.sep}`)) fail("manifest_dependency_escape");
      files[name] = canonical;
    }));
  } catch (error) {
    if (String(error?.message).startsWith("game_action_project_")) throw error;
    fail("manifest_dependency_missing");
  }
  const declaredEvidenceRoot = path.resolve(baseDirectory, assertRelativeFile(raw.evidenceRoot, "invalid_evidence_root"));
  const evidenceRoot = await assertCanonicalOwnedDirectory(baseDirectory, declaredEvidenceRoot);
  return Object.freeze({
    manifestFile: resolved,
    baseDirectory,
    gameId: raw.gameId,
    projectVersion: raw.projectVersion,
    ...files,
    evidenceRoot,
  });
}

export async function runActionProject({ projectFile, invocation }) {
  const manifest = await readActionProjectManifest(projectFile);
  const normalizedInvocation = normalizeInvocation(invocation);
  if (["preflight", "run-live"].includes(normalizedInvocation.command) && normalizedInvocation.profileFile === undefined) fail("profile_required");
  let canonicalBriefFile;
  if (normalizedInvocation.briefFile !== undefined) {
    const declaredBriefFile = path.resolve(manifest.baseDirectory, normalizedInvocation.briefFile);
    if (!declaredBriefFile.startsWith(`${manifest.baseDirectory}${path.sep}`)) fail("brief_path_escape");
    try {
      canonicalBriefFile = await realpath(declaredBriefFile);
      if (!canonicalBriefFile.startsWith(`${manifest.baseDirectory}${path.sep}`)) fail("brief_dependency_escape");
      if (!(await lstat(canonicalBriefFile)).isFile()) fail("brief_dependency_invalid");
    } catch (error) {
      if (String(error?.message).startsWith("game_action_project_")) throw error;
      fail("brief_dependency_missing");
    }
  }
  const resolvedInvocation = canonicalBriefFile === undefined
    ? normalizedInvocation
    : Object.freeze({ ...normalizedInvocation, briefFile: canonicalBriefFile });
  const immutableInvocation = resolvedInvocation.command === "run-live"
    ? Object.freeze({ ...resolvedInvocation, runId: mintEvidenceRunId() })
    : resolvedInvocation;
  let adapter;
  try { adapter = await import(pathToFileURL(manifest.adapterFile).href); } catch { fail("adapter_unloadable"); }
  if (typeof adapter.runActionProject !== "function") fail("adapter_contract_missing");
  const report = await adapter.runActionProject(Object.freeze({ manifest, invocation: immutableInvocation }));
  if (!isObject(report) || report.gameId !== manifest.gameId || typeof report.status !== "string") fail("adapter_report_invalid");
  return Object.freeze(report);
}
