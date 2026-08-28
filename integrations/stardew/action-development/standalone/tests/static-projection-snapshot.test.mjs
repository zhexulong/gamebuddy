import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  STATIC_PROJECTION_SCHEMA,
  STATIC_PROJECTION_FIXED_PROTOCOL_CONTROL_IDS,
  parseStaticActionDescriptorSnapshot,
  validateStaticActionDescriptorSnapshot,
} from "../src/static-projection/action-descriptor-snapshot.mjs";

const allowedActionIds = Object.freeze([
  "move_to_tile",
  "inspect_world_map",
  ...STATIC_PROJECTION_FIXED_PROTOCOL_CONTROL_IDS,
]);

const validSnapshot = Object.freeze({
  schema: STATIC_PROJECTION_SCHEMA,
  developmentOnly: true,
  gameId: "stardew",
  actions: Object.freeze([
    Object.freeze({
      actionId: "move_to_tile",
      kind: "execution",
      lifecycle: "published",
      advertised: true,
      executable: true,
    }),
    Object.freeze({
      actionId: "inspect_world_map",
      kind: "read_only",
      lifecycle: "published",
      advertised: true,
      executable: false,
    }),
    Object.freeze({
      actionId: "inspect_self",
      kind: "read_only",
      lifecycle: "published",
      advertised: true,
      executable: false,
    }),
  ]),
});

function fails(code, callback) {
  assert.throws(callback, new RegExp(`stardew_static_projection_${code}`));
}

function cloneSnapshot() {
  return structuredClone(validSnapshot);
}

test("accepts a valid restricted development snapshot and returns an immutable consumer view", () => {
  const validated = validateStaticActionDescriptorSnapshot(validSnapshot, { allowedActionIds });
  assert.equal(validated.schema, STATIC_PROJECTION_SCHEMA);
  assert.equal(validated.developmentOnly, true);
  assert.deepEqual(
    validated.actions.map(({ actionId, kind, advertised, executable }) => ({
      actionId,
      kind,
      advertised,
      executable,
    })),
    [
      { actionId: "move_to_tile", kind: "execution", advertised: true, executable: true },
      { actionId: "inspect_world_map", kind: "read_only", advertised: true, executable: false },
      { actionId: "inspect_self", kind: "read_only", advertised: true, executable: false },
    ],
  );
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.actions), true);
  assert.equal(Object.isFrozen(validated.actions[0]), true);
});

test("parses JSON text while rejecting duplicate object keys", () => {
  const text = JSON.stringify(validSnapshot);
  assert.equal(parseStaticActionDescriptorSnapshot(text, { allowedActionIds }).actions.length, 3);
  fails("duplicate_key", () => parseStaticActionDescriptorSnapshot(
    '{"schema":"gamebuddy-stardew-static-action-projection/v1","developmentOnly":true,"gameId":"stardew","actions":[],"actions":[]}',
    { allowedActionIds },
  ));
});

test("enforces exact versioned envelope, action shape, bounded identity, lifecycle, and booleans", () => {
  const wrongSchema = cloneSnapshot();
  wrongSchema.schema = "wrong/v1";
  fails("invalid_schema", () => validateStaticActionDescriptorSnapshot(wrongSchema, { allowedActionIds }));

  const unknownEnvelopeKey = cloneSnapshot();
  unknownEnvelopeKey.extra = "not allowed";
  fails("invalid_envelope_shape", () => validateStaticActionDescriptorSnapshot(unknownEnvelopeKey, { allowedActionIds }));

  const unknownActionKey = cloneSnapshot();
  unknownActionKey.actions[0].extra = "not allowed";
  fails("invalid_action_shape", () => validateStaticActionDescriptorSnapshot(unknownActionKey, { allowedActionIds }));

  for (const [field, value] of [
    ["actionId", "../move_to_tile"],
    ["lifecycle", "experimental"],
    ["advertised", "true"],
    ["executable", 1],
  ]) {
    const changed = cloneSnapshot();
    changed.actions[0][field] = value;
    fails(field === "actionId" ? "invalid_action_id" : field === "lifecycle" ? "invalid_lifecycle" : `invalid_${field}`,
      () => validateStaticActionDescriptorSnapshot(changed, { allowedActionIds }));
  }

  const duplicateIds = cloneSnapshot();
  duplicateIds.actions[1].actionId = "move_to_tile";
  fails("duplicate_action_id", () => validateStaticActionDescriptorSnapshot(duplicateIds, { allowedActionIds }));
});

test("read-only and fixed protocol controls are never executable", () => {
  const readonlyExecution = cloneSnapshot();
  readonlyExecution.actions[1].executable = true;
  fails("readonly_executable", () => validateStaticActionDescriptorSnapshot(readonlyExecution, { allowedActionIds }));

  const controlExecution = cloneSnapshot();
  controlExecution.actions[2].executable = true;
  fails("control_executable", () => validateStaticActionDescriptorSnapshot(controlExecution, { allowedActionIds }));

  const controlAsExecution = cloneSnapshot();
  controlAsExecution.actions[2].kind = "execution";
  fails("control_kind", () => validateStaticActionDescriptorSnapshot(controlAsExecution, { allowedActionIds }));

  const hiddenExecution = cloneSnapshot();
  hiddenExecution.actions[0].advertised = false;
  fails("execution_not_advertised", () => validateStaticActionDescriptorSnapshot(hiddenExecution, { allowedActionIds }));
});

test("rejects duplicate IDs, escape-shaped IDs, forbidden fields/content, and action-set expansion", () => {
  const escaped = cloneSnapshot();
  escaped.actions[0].actionId = "move_to_tile%2fescape";
  fails("invalid_action_id", () => validateStaticActionDescriptorSnapshot(escaped, { allowedActionIds }));

  const secret = cloneSnapshot();
  secret.actions[0].secret = "do-not-carry-secrets";
  fails("forbidden_field", () => validateStaticActionDescriptorSnapshot(secret, { allowedActionIds }));

  const endpoint = cloneSnapshot();
  endpoint.actions[0].actionId = "https_endpoint";
  fails("forbidden_content", () => validateStaticActionDescriptorSnapshot(endpoint, { allowedActionIds }));

  const expanded = cloneSnapshot();
  expanded.actions.push({
    actionId: "unlisted_action",
    kind: "execution",
    lifecycle: "published",
    advertised: true,
    executable: true,
  });
  fails("action_not_allowed", () => validateStaticActionDescriptorSnapshot(expanded, { allowedActionIds }));

  const topLevelAllowlist = cloneSnapshot();
  topLevelAllowlist.allowedActionIds = ["unlisted_action"];
  fails("invalid_envelope_shape", () => validateStaticActionDescriptorSnapshot(topLevelAllowlist, { allowedActionIds }));
});

test("rejects proxies, non-plain values, and missing or mutable caller allowlists", () => {
  fails("invalid_data", () => validateStaticActionDescriptorSnapshot(new Proxy(validSnapshot, {}), { allowedActionIds }));
  fails("invalid_data", () => validateStaticActionDescriptorSnapshot(Object.create(null), { allowedActionIds }));
  fails("invalid_data", () => validateStaticActionDescriptorSnapshot(new Date(0), { allowedActionIds }));
  fails("invalid_options", () => validateStaticActionDescriptorSnapshot(validSnapshot));
  fails("invalid_allowed_action_ids", () => validateStaticActionDescriptorSnapshot(validSnapshot, {
    allowedActionIds: ["move_to_tile"],
  }));
  fails("invalid_allowed_action_ids", () => validateStaticActionDescriptorSnapshot(validSnapshot, {
    allowedActionIds: Object.freeze(["move_to_tile", "move_to_tile"]),
  }));
});

test("is a development-only local consumer with no production or root imports", async () => {
  const source = await readFile(new URL("../src/static-projection/action-descriptor-snapshot.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:from|import)\s+["'](?:\.\.\/){2,}/);
  assert.doesNotMatch(source, /(?:from|import)\s+["'](?:[^"']*(?:host|mod|bridge|portfolio|root|production)[^"']*)["']/i);
});
