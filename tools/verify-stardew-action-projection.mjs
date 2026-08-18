import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const MANIFEST_SCHEMA = "farmhand_action_projection_manifest/v1";
const ACTION_ID = /^[a-z][a-z0-9_]{1,127}$/;
const FAMILY_ID = /^[a-z][a-z0-9_]{1,127}$/;

function fail(code) {
  throw new Error(`stardew_action_projection_${code}`);
}

function record(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code);
  }
  return value;
}

function exactKeys(value, keys, code) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) fail(code);
}

function action(value, source, strictShape = false) {
  const entry = record(value, `${source}_action_invalid`);
  if (strictShape) exactKeys(entry, ["actionId", "familyId", "identityVersion", "lifecycle", "requiredCapability"], `${source}_action_shape`);
  if (!ACTION_ID.test(entry.actionId) || !FAMILY_ID.test(entry.familyId) || !Number.isSafeInteger(entry.identityVersion) || entry.identityVersion < 1 || entry.lifecycle !== "published" || !ACTION_ID.test(entry.requiredCapability)) {
    fail(`${source}_action_fields`);
  }
  return Object.freeze({
    actionId: entry.actionId,
    familyId: entry.familyId,
    identityVersion: entry.identityVersion,
    lifecycle: entry.lifecycle,
    requiredCapability: entry.requiredCapability,
  });
}

export function parseModProjectionManifest(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail("manifest_json"); }
  const manifest = record(parsed, "manifest_shape");
  exactKeys(manifest, ["schema", "actions"], "manifest_shape");
  if (manifest.schema !== MANIFEST_SCHEMA || !Array.isArray(manifest.actions)) fail("manifest_schema");
  const actions = manifest.actions.map((entry) => action(entry, "manifest", true));
  if (new Set(actions.map((entry) => entry.actionId)).size !== actions.length) fail("manifest_duplicate_action_id");
  return Object.freeze(actions);
}

export function hostPublishedProjection(hostModule) {
  if (!hostModule || !Array.isArray(hostModule.PUBLISHED_STARDEW_ACTIONS)) fail("host_export");
  const actions = hostModule.PUBLISHED_STARDEW_ACTIONS.map((entry) => action(entry, "host"));
  if (new Set(actions.map((entry) => entry.actionId)).size !== actions.length) fail("host_duplicate_action_id");
  return Object.freeze(actions);
}

export function verifyStardewActionProjection(manifestActions, hostActions) {
  const modById = new Map(manifestActions.map((entry) => [entry.actionId, entry]));
  const hostById = new Map(hostActions.map((entry) => [entry.actionId, entry]));
  for (const [actionId, mod] of modById) {
    const host = hostById.get(actionId);
    if (!host) fail(`host_missing_${actionId}`);
    for (const field of ["familyId", "identityVersion", "lifecycle", "requiredCapability"]) {
      if (mod[field] !== host[field]) fail(`field_mismatch_${actionId}_${field}`);
    }
  }
  for (const actionId of hostById.keys()) if (!modById.has(actionId)) fail(`manifest_missing_${actionId}`);
  return Object.freeze({ actionCount: modById.size });
}

export async function verifyProjectionFiles({ manifestPath, hostArtifactPath }) {
  if (!manifestPath || !hostArtifactPath) fail("usage");
  const manifestActions = parseModProjectionManifest(await readFile(manifestPath, "utf8"));
  const hostModule = await import(`${pathToFileURL(hostArtifactPath).href}?projection=${Date.now()}`);
  return verifyStardewActionProjection(manifestActions, hostPublishedProjection(hostModule));
}

if (import.meta.main) {
  const [manifestPath, hostArtifactPath] = process.argv.slice(2);
  try {
    const result = await verifyProjectionFiles({ manifestPath, hostArtifactPath });
    console.log(`Stardew action projection verified (${result.actionCount} actions).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
