import path from "node:path";
import { types } from "node:util";
import { parseJsonWithoutDuplicateKeys } from "./json-text.mjs";

const SCHEMA = "gamebuddy-action-target-profile/v1";
const KEYS = new Set([
  "schema", "profileIdentity", "targetVersion", "gameInstallPath", "modsPath", "releaseDir", "fixtureTransactionRoot", "nativeFixtureRoot",
  "saveIdentity", "templateIdentity", "gameVersion", "smapiVersion", "adapterVersion",
  "runtimeLeaseRoot", "runtimeLeaseIdentity", "timeoutMs", "nativeClientConfigFile",
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const NATIVE_SAVE = /^GameBuddyFixture[A-Za-z0-9_-]{0,64}_[0-9]{1,32}$/;
const PLACEHOLDER = /(?:example|placeholder|replace[-_ ]?me|<[^>]+>)/i;

function fail(code) { throw new Error(`stardew_action_profile_${code}`); }

function plainRecord(value) {
  if (types.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("invalid_shape");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== KEYS.size || keys.some((key) => typeof key !== "string" || !KEYS.has(key))) fail("invalid_shape");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("invalid_shape");
  }
}

function text(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}
function absolute(value, code) {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value) || path.normalize(value) !== value) fail(code);
  return value;
}

export function parseTargetProfileText(text) { return validateTargetProfile(parseJsonWithoutDuplicateKeys(text, "stardew_action_profile")); }

export function validateTargetProfile(input) {
  plainRecord(input);
  if (input.schema !== SCHEMA) fail("invalid_schema");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 30_000 || input.timeoutMs > 300_000) fail("invalid_timeout");
  if (!NATIVE_SAVE.test(input.saveIdentity) || input.templateIdentity !== input.saveIdentity) fail("invalid_save_binding");
  return Object.freeze({
    schema: SCHEMA,
    profileIdentity: text(input.profileIdentity, ID, "invalid_identity"),
    targetVersion: text(input.targetVersion, VERSION, "invalid_target_version"),
    gameInstallPath: absolute(input.gameInstallPath, "invalid_game_install_path"),
    modsPath: absolute(input.modsPath, "invalid_mods_path"),
    releaseDir: absolute(input.releaseDir, "invalid_release_dir"),
    fixtureTransactionRoot: absolute(input.fixtureTransactionRoot, "invalid_fixture_transaction_root"),
    nativeFixtureRoot: absolute(input.nativeFixtureRoot, "invalid_native_fixture_root"),
    saveIdentity: text(input.saveIdentity, ID, "invalid_save_identity"),
    templateIdentity: text(input.templateIdentity, ID, "invalid_template_identity"),
    gameVersion: text(input.gameVersion, VERSION, "invalid_game_version"),
    smapiVersion: text(input.smapiVersion, VERSION, "invalid_smapi_version"),
    adapterVersion: text(input.adapterVersion, VERSION, "invalid_adapter_version"),
    runtimeLeaseRoot: absolute(input.runtimeLeaseRoot, "invalid_runtime_lease_root"),
    runtimeLeaseIdentity: text(input.runtimeLeaseIdentity, ID, "invalid_runtime_lease_identity"),
    timeoutMs: input.timeoutMs,
    nativeClientConfigFile: absolute(input.nativeClientConfigFile, "invalid_native_client_config_file"),
  });
}

export function assertReadyTargetProfile(profile, { profileFile, exampleProfileFile } = {}) {
  if (!path.isAbsolute(profileFile ?? "")) fail("profile_path_not_absolute");
  if (exampleProfileFile && path.resolve(profileFile) === path.resolve(exampleProfileFile)) fail("example_not_ready");
  if (Object.values(profile).some((value) => typeof value === "string" && PLACEHOLDER.test(value))) fail("placeholder_not_ready");
  return profile;
}
