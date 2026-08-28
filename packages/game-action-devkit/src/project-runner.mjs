import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COMMANDS = new Set(["inventory", "check", "preflight", "run-live", "status"]);
const MANIFEST_KEYS = new Set(["schema", "gameId", "projectVersion", "adapter", "toolInventory"]);
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
  for (const key of ["profileFile", "briefFile"]) {
    if (invocation[key] !== undefined) normalized[key] = assertRelativeFile(invocation[key], `invalid_${key}`);
  }
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
  const declaredAdapterFile = path.resolve(declaredBaseDirectory, assertRelativeFile(raw.adapter, "invalid_adapter"));
  const declaredInventoryFile = path.resolve(declaredBaseDirectory, assertRelativeFile(raw.toolInventory, "invalid_tool_inventory"));
  if (!declaredAdapterFile.startsWith(`${declaredBaseDirectory}${path.sep}`) || !declaredInventoryFile.startsWith(`${declaredBaseDirectory}${path.sep}`)) fail("manifest_path_escape");
  let baseDirectory;
  let adapterFile;
  let inventoryFile;
  try {
    [baseDirectory, adapterFile, inventoryFile] = await Promise.all([realpath(declaredBaseDirectory), realpath(declaredAdapterFile), realpath(declaredInventoryFile)]);
  } catch { fail("manifest_dependency_missing"); }
  if (!adapterFile.startsWith(`${baseDirectory}${path.sep}`) || !inventoryFile.startsWith(`${baseDirectory}${path.sep}`)) fail("manifest_dependency_escape");
  return Object.freeze({
    manifestFile: resolved,
    baseDirectory,
    gameId: raw.gameId,
    projectVersion: raw.projectVersion,
    adapterFile,
    inventoryFile,
  });
}

export async function runActionProject({ projectFile, invocation }) {
  const manifest = await readActionProjectManifest(projectFile);
  const immutableInvocation = normalizeInvocation(invocation);
  let adapter;
  try { adapter = await import(pathToFileURL(manifest.adapterFile).href); } catch { fail("adapter_unloadable"); }
  if (typeof adapter.runActionProject !== "function") fail("adapter_contract_missing");
  const report = await adapter.runActionProject(Object.freeze({ manifest, invocation: immutableInvocation }));
  if (!isObject(report) || report.gameId !== manifest.gameId || typeof report.status !== "string") fail("adapter_report_invalid");
  return Object.freeze(report);
}
