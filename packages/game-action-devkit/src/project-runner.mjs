import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COMMANDS = new Set(["check", "preflight", "run-live", "status"]);
const MANIFEST_KEYS = new Set(["schema", "gameId", "projectVersion", "adapter", "portfolio", "toolInventory", "evidenceRoot", "defaultProfileExample"]);
const REPORT_KEYS = new Set(["schema", "gameId", "actionId", "scenarioId", "status", "outcome", "reasonCode", "claimScope", "runId", "evidenceRoot", "briefFile"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPORT_FIELD_MAX_LENGTHS = Object.freeze({ gameId: 128, actionId: 128, scenarioId: 128, status: 128, runId: 128, outcome: 512, reasonCode: 512, claimScope: 512, evidenceRoot: 512, briefFile: 512 });
export const MAX_ADAPTER_REPORT_BYTES = 64 * 1024 - 1;

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

async function inspectOwnedPortfolioPath(baseDirectory, declaredFile) {
  const relative = path.relative(baseDirectory, declaredFile);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) fail("manifest_path_escape");
  let current = baseDirectory;
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (details.isSymbolicLink()) fail("manifest_dependency_escape");
    if (index < parts.length - 1 && !details.isDirectory()) fail("manifest_dependency_missing");
  }
  return true;
}

async function loadActionProjectManifest(projectFile, { allowMissingPortfolio = false } = {}) {
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
  let portfolioMissing = false;
  try {
    await Promise.all(fileReferences.map(async ([name, value, code]) => {
      const declared = path.resolve(baseDirectory, assertRelativeFile(value, code));
      if (!declared.startsWith(`${baseDirectory}${path.sep}`)) fail("manifest_path_escape");
      if (allowMissingPortfolio && name === "portfolioFile" && !await inspectOwnedPortfolioPath(baseDirectory, declared)) {
        files[name] = declared;
        portfolioMissing = true;
        return;
      }
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
    ...(portfolioMissing ? { portfolioMissing: true } : {}),
  });
}

export async function readActionProjectManifest(projectFile) {
  return loadActionProjectManifest(projectFile);
}

function assertReportString(value, field, { nullable = false, opaque = false } = {}) {
  if (nullable && value === null) return;
  const maxLength = REPORT_FIELD_MAX_LENGTHS[field];
  if (typeof value !== "string" || maxLength === undefined || [...value].length === 0 || [...value].length > maxLength) fail("adapter_report_invalid");
  if (opaque && !ID_PATTERN.test(value)) fail("adapter_report_invalid");
}

function validateAdapterReport(report, manifest) {
  const keys = isObject(report) ? Object.keys(report) : [];
  if (!isObject(report) || keys.length > REPORT_KEYS.size || keys.some((key) => !REPORT_KEYS.has(key))) fail("adapter_report_invalid");
  if (["schema", "gameId", "status"].some((key) => !Object.hasOwn(report, key))) fail("adapter_report_invalid");
  if (report.schema !== "gamebuddy-action-scenario-result/v1" || report.gameId !== manifest.gameId) fail("adapter_report_invalid");
  if (typeof report.schema !== "string" || report.schema.length === 0) fail("adapter_report_invalid");
  assertReportString(report.gameId, "gameId", { opaque: true });
  assertReportString(report.status, "status");
  for (const field of ["actionId", "scenarioId", "briefFile"]) {
    if (Object.hasOwn(report, field)) assertReportString(report[field], field, { nullable: true, opaque: field !== "briefFile" });
  }
  for (const field of ["outcome", "reasonCode", "claimScope", "runId", "evidenceRoot"]) {
    if (Object.hasOwn(report, field)) assertReportString(report[field], field);
  }
  let serialized;
  try { serialized = JSON.stringify(report); } catch { fail("adapter_report_invalid"); }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_ADAPTER_REPORT_BYTES) fail("adapter_report_invalid");
  return Object.freeze({ ...report });
}

export async function runActionProject({ projectFile, invocation }) {
  const normalizedInvocation = normalizeInvocation(invocation);
  const manifest = normalizedInvocation.command === "status" && normalizedInvocation.actionId === undefined
    ? await loadActionProjectManifest(projectFile, { allowMissingPortfolio: true })
    : await readActionProjectManifest(projectFile);
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
  return validateAdapterReport(report, manifest);
}
