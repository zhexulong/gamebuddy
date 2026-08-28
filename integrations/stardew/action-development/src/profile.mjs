import { types } from "node:util";
import { parseJsonWithoutDuplicateKeys } from "./json-text.mjs";

const SCHEMA = "gamebuddy-action-target-profile/v1";
const KEYS = new Set(["schema", "profileIdentity", "targetVersion"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fail(code) {
  throw new Error(`stardew_action_profile_${code}`);
}

function plainRecord(value) {
  if (types.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("invalid_shape");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== KEYS.size || keys.some((key) => typeof key !== "string" || !KEYS.has(key))) fail("invalid_shape");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("invalid_shape");
  }
}

function opaque(value, code) {
  if (typeof value !== "string" || !ID.test(value)) fail(code);
  return value;
}

export function parseTargetProfileText(text) {
  return validateTargetProfile(parseJsonWithoutDuplicateKeys(text, "stardew_action_profile"));
}

export function validateTargetProfile(input) {
  plainRecord(input);
  if (input.schema !== SCHEMA) fail("invalid_schema");
  return Object.freeze({
    schema: SCHEMA,
    profileIdentity: opaque(input.profileIdentity, "invalid_identity"),
    targetVersion: opaque(input.targetVersion, "invalid_target_version"),
  });
}
