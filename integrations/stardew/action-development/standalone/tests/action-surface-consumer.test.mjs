import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTION_SURFACE_ENVELOPE_KEYS,
  ACTION_SURFACE_MAX_JSON_BYTES,
  ACTION_SURFACE_SCHEMA,
  ACTION_SURFACE_ACTION_KEYS,
  parseActionSurface,
  validateActionSurface,
} from "../src/action-surface.mjs";
import {
  projectActionSurface,
  projectExecutableRegistrations,
  validateActionProjection,
} from "../src/action-projection-check.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.dirname(directory);
const fixturePath = path.join(directory, "fixtures", "action-surface.v1.fixture.json");
const schemaPath = path.join(packageDirectory, "contracts", "action-surface.v1.schema.json");
const fixtureText = await readFile(fixturePath, "utf8");
const fixture = JSON.parse(fixtureText);

function fails(code, callback) {
  assert.throws(callback, new RegExp(`stardew_(?:action_surface|action_projection)_${code}`));
}

function cloneFixture() {
  return structuredClone(fixture);
}

const EXPECTED_CATALOG = fixture.actions;
test("accepts the explicit non-authoritative package fixture and returns a frozen consumer view", () => {
  const validated = parseActionSurface(fixtureText);
  const expectedArtifact = {
    schema: ACTION_SURFACE_SCHEMA,
    catalogRevision: 1,
    actions: EXPECTED_CATALOG,
  };
  assert.equal(fixtureText, JSON.stringify(expectedArtifact));
  assert.equal(Buffer.byteLength(fixtureText, "utf8"), Buffer.byteLength(JSON.stringify(expectedArtifact), "utf8"));
  assert.equal(validated.schema, ACTION_SURFACE_SCHEMA);
  assert.equal(validated.catalogRevision, 1);
  assert.deepEqual(validated.actions, EXPECTED_CATALOG);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.actions), true);
  assert.equal(Object.isFrozen(validated.actions[0]), true);
});

test("schema and consumer field sets are exact and versioned", async () => {
  const schemaText = await readFile(schemaPath, "utf8");
  assert.equal(schemaText.endsWith("\n"), true);
  const schema = JSON.parse(schemaText);
  assert.equal(schema.$id, ACTION_SURFACE_SCHEMA);
  assert.deepEqual(schema.required, ACTION_SURFACE_ENVELOPE_KEYS);
  assert.deepEqual(schema.$defs.action.required, ACTION_SURFACE_ACTION_KEYS);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.action.additionalProperties, false);
  assert.equal(schema.properties.actions["x-gamebuddy-uniqueBy"], "actionId");
  assert.deepEqual(schema.$defs.action.properties.lifecycle.enum, ["published", "experimental"]);
  assert.deepEqual(schema.$defs.action.properties.kind.enum, ["execution", "read_only"]);
});

test("rejects duplicate JSON keys before JSON.parse can collapse them", () => {
  fails("duplicate_key", () => parseActionSurface(
    '{"schema":"gamebuddy-action-descriptors/v1","gameId":"stardew","actions":[],"actions":[]}',
  ));
  fails("duplicate_key", () => parseActionSurface(
    '{"schema":"gamebuddy-action-descriptors/v1","gameId":"stardew","actions":[{"actionId":"plant_seed","actionId":"plant_seed","familyId":"farming_crops","identityVersion":1,"lifecycle":"published","kind":"execution"}]}',
  ));
});

test("rejects wrong schema, game, missing or unknown fields, duplicates, and invalid registration values", () => {
  const wrongSchema = cloneFixture();
  wrongSchema.schema = "gamebuddy-stardew-action-surface/v2";
  fails("invalid_schema", () => validateActionSurface(wrongSchema));

  const unknownEnvelope = cloneFixture();
  unknownEnvelope.extra = true;
  fails("invalid_envelope_shape", () => validateActionSurface(unknownEnvelope));

  const unknownRegistration = cloneFixture();
  unknownRegistration.actions[0].descriptor = "not-registration";
  fails("invalid_action_shape", () => validateActionSurface(unknownRegistration));

  const duplicateIds = cloneFixture();
  duplicateIds.actions[1].actionId = duplicateIds.actions[0].actionId;
  fails("duplicate_action_id", () => validateActionSurface(duplicateIds));

  for (const [field, value, code] of [
    ["actionId", "../escape", "invalid_action_id"],
    ["identityVersion", 0, "invalid_identity_version"],
    ["lifecycle", "planned", "invalid_lifecycle"],
    ["kind", "control", "invalid_kind"],
  ]) {
    const changed = cloneFixture();
    changed.actions[0][field] = value;
    fails(code, () => validateActionSurface(changed));
  }
});

test("enforces bounded JSON text, arrays, identifiers, numbers, and plain data", () => {
  fails("bounds", () => parseActionSurface(" ".repeat(ACTION_SURFACE_MAX_JSON_BYTES + 1)));
  fails("bounds", () => validateActionSurface({
    schema: ACTION_SURFACE_SCHEMA,
    catalogRevision: 1,
    actions: Array.from({ length: 129 }, (_, index) => ({ ...fixture.actions[0], actionId: `action_${index}` })),
  }));

  const longId = cloneFixture();
  longId.actions[0].actionId = `a${"b".repeat(128)}`;
  fails("bounds", () => validateActionSurface(longId));

  const uppercaseId = cloneFixture();
  uppercaseId.actions[0].actionId = "Move_to_tile";
  fails("invalid_action_id", () => validateActionSurface(uppercaseId));

  const unsafeVersion = cloneFixture();
  unsafeVersion.actions[0].identityVersion = Number.MAX_SAFE_INTEGER + 1;
  fails("invalid_identity_version", () => validateActionSurface(unsafeVersion));

  const producerOverflowVersion = cloneFixture();
  producerOverflowVersion.actions[0].identityVersion = 2_147_483_648;
  fails("invalid_identity_version", () => validateActionSurface(producerOverflowVersion));

  const nanVersion = cloneFixture();
  nanVersion.actions[0].identityVersion = Number.NaN;
  fails("invalid_data", () => validateActionSurface(nanVersion));

  fails("invalid_data", () => validateActionSurface(new Proxy(fixture, {})));
  fails("invalid_data", () => validateActionSurface(Object.create(null)));
  fails("invalid_data", () => validateActionSurface(new Date(0)));
});

test("rejects dynamic publication fields from the static artifact", () => {
  for (const field of ["enabledActionIds", "revision", "sessionId", "advertised", "available"]) {
    const changed = cloneFixture();
    changed[field] = field === "enabledActionIds" ? [] : 1;
    fails("dynamic_publication_field", () => validateActionSurface(changed));

    const registrationWithDynamicField = cloneFixture();
    registrationWithDynamicField.actions[0][field] = true;
    fails(
      field === "catalogRevision" || field === "revision" || field === "sessionId" || field === "advertised" || field === "available"
        ? "dynamic_publication_field"
        : "dynamic_publication_field",
      () => validateActionSurface(registrationWithDynamicField),
    );
  }
});

test("source surface projection is restrictive: descriptors select, never create actions", () => {
  const projection = validateActionProjection(fixture, {
    descriptors: [{ actionId: "move_to_tile", madeUp: "ignored" }],
  });
  assert.deepEqual(projection.actions.map(({ actionId }) => actionId), ["move_to_tile"]);

  const selected = projectActionSurface(fixture, {
    descriptors: [{ actionId: "not_published_in_surface" }],
  });
  assert.deepEqual(selected.actions, []);
  assert.deepEqual(selected.executable, []);

  const descriptorWithRegistration = {
    actionId: "new_action",
    familyId: "invented_family",
    identityVersion: 99,
    lifecycle: "published",
    kind: "execution",
  };
  const noExpansion = projectActionSurface(fixture, { descriptors: [descriptorWithRegistration] });
  assert.deepEqual(noExpansion.actions, []);
  assert.deepEqual(noExpansion.executable, []);

  const descriptorExpansion = projectActionSurface(fixture, { descriptors: ["move_to_tile", "new_action"] });
  assert.deepEqual(descriptorExpansion.actions.map(({ actionId }) => actionId), ["move_to_tile"]);
});

test("execution projection includes only published execution actions and never read-only entries", () => {
  const projection = validateActionProjection(fixture);
  const expectedPublishedExecution = EXPECTED_CATALOG.filter(
    ({ lifecycle, kind }) => lifecycle === "published" && kind === "execution",
  );
  const expectedReadOnly = EXPECTED_CATALOG.filter(({ kind }) => kind === "read_only");
  assert.deepEqual(projection.actions, EXPECTED_CATALOG);
  assert.deepEqual(projection.executable, expectedPublishedExecution);
  assert.deepEqual(projectExecutableRegistrations(fixture), expectedPublishedExecution);
  assert.deepEqual(projection.readOnly, expectedReadOnly);
  assert.equal(projection.actions.length, 31);
  assert.equal(projection.executable.length, 26);
  assert.equal(projection.readOnly.length, 2);
  assert.ok(projection.executable.every(({ lifecycle, kind }) => lifecycle === "published" && kind === "execution"));
  assert.ok(projection.readOnly.every(({ kind }) => kind === "read_only"));
});

test("consumer source is package-independent and cannot invoke producers, runtime, or bridge", async () => {
  const sourceFiles = [
    "../src/action-surface.mjs",
    "../src/action-projection-check.mjs",
  ];
  for (const relativePath of sourceFiles) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:from|import)\s+["'](?:\.\.\/){2,}/);
    assert.doesNotMatch(source, /(?:from|import)\s+["'][^"']*(?:host|core|mod|bridge|tools|\.ci|package\.json)[^"']*["']/i);
    assert.doesNotMatch(source, /(?:dotnet|child_process|execFile|named.?pipe|socket|https?:\/\/)/i);
    assert.doesNotMatch(source, /(?:readFile|writeFile|readdir|realpath|path\.join|fileURLToPath)/);
  }
});
