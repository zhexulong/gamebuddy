import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTION_SURFACE_ENVELOPE_KEYS,
  ACTION_SURFACE_MAX_JSON_BYTES,
  ACTION_SURFACE_ACTION_KEYS,
  ACTION_SURFACE_SCHEMA,
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

function registration(
  actionId = "plant_seed",
  familyId = "farming_crops",
  lifecycle = "published",
  kind = "execution",
) {
  return { actionId, identityVersion: 1, lifecycle, kind, argumentSchema: {}, outputFacts: {}, resourceTemplate: { claims: [{ key: "embodied_actor", value: "ScopePlayer" }] }, effect: "write", postcondition: { name: "native_action_postcondition" } };
}

const EXPECTED_CATALOG = Object.freeze([
  registration("move_to_tile", "movement_navigation"),
  registration("equip_tool", "body_tools"),
  registration("travel", "transport_warps"),
  registration("enter_exit", "movement_navigation"),
  registration("till_soil", "farming_crops"),
  registration("pickup_forage", "resource_gathering"),
  registration("pickup_item", "inventory_items"),
  registration("water_crop", "farming_crops"),
  registration("plant_seed", "farming_crops"),
  registration("fertilize_tile", "farming_crops"),
  registration("machine_inspect", "machines_processing"),
  registration("machine_load", "machines_processing"),
  registration("machine_collect_output", "machines_processing"),
  registration("collect_animal_product", "animals_pets"),
  registration("feed_animal", "animals_pets"),
  registration("use_item", "inventory_items"),
  registration("harvest_crop", "farming_crops"),
  registration("place_wood_fence", "buildings_farm_management"),
  registration("place_crab_pot", "buildings_farm_management"),
  registration("bait_crab_pot", "buildings_farm_management"),
  registration("chop_tree_source", "resource_gathering"),
  registration("break_rock_source", "resource_gathering"),
  registration("clear_hoedirt", "farming_crops"),
  registration("dig_artifact_spot", "resource_gathering"),
  registration("refill_watering_can", "farming_crops"),
  registration("inspect_world_map", "world_navigation", "published", "read_only"),
  registration("find_destination", "world_navigation", "published", "read_only"),
  registration("clear_debris", "resource_gathering", "experimental"),
  registration("npc_relationship", "npc_social", "experimental"),
  registration("pet_animal", "animals_pets", "experimental"),
]);

test("accepts the explicit non-authoritative package fixture and returns a frozen consumer view", () => {
  const validated = parseActionSurface(fixtureText);
  const expectedArtifact = {
    schema: ACTION_SURFACE_SCHEMA,
    catalogRevision: 1,
    actions: fixture.actions,
  };
  assert.equal(JSON.stringify(fixture), JSON.stringify(expectedArtifact));
  assert.equal(Buffer.byteLength(fixtureText, "utf8"), Buffer.byteLength(JSON.stringify(fixture) + "\n", "utf8"));
  assert.equal(validated.schema, ACTION_SURFACE_SCHEMA);
  assert.equal(validated.catalogRevision, 1);
  assert.deepEqual(validated.actions, fixture.actions);
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
    '{"schema":"gamebuddy-action-descriptors/v1","catalogRevision":1,"actions":[],"actions":[]}',
  ));
  fails("duplicate_key", () => parseActionSurface(
    '{"schema":"gamebuddy-action-descriptors/v1","catalogRevision":1,"actions":[{"actionId":"plant_seed","actionId":"plant_seed"}]}',
  ));
});

test("rejects wrong schema, game, missing or unknown fields, duplicates, and invalid registration values", () => {
  const wrongSchema = cloneFixture();
  wrongSchema.schema = "gamebuddy-stardew-action-surface/v2";
  fails("invalid_schema", () => validateActionSurface(wrongSchema));

  const wrongRevision = cloneFixture();
  wrongRevision.catalogRevision = -1;
  fails("invalid_catalog_revision", () => validateActionSurface(wrongRevision));

  const unknownEnvelope = cloneFixture();
  unknownEnvelope.extra = true;
  fails("invalid_envelope_shape", () => validateActionSurface(unknownEnvelope));

  const unknownRegistration = cloneFixture();
  unknownRegistration.actions[0].descriptor = "not-action";
  fails("invalid_action_shape", () => validateActionSurface(unknownRegistration));

  const missingRegistrationField = cloneFixture();
  delete missingRegistrationField.actions[0].resourceTemplate;
  fails("invalid_action_shape", () => validateActionSurface(missingRegistrationField));

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

test("enforces canonical typed argument/output maps and ScopePlayer resource claims", () => {
  for (const [field, value, code] of [
    ["argumentSchema", [], "invalid_action"],
    ["argumentSchema", { x: "integer" }, "invalid_action"],
    ["argumentSchema", { x: { type: "number" } }, "invalid_action"],
    ["argumentSchema", { x: { type: "integer", extra: true } }, "invalid_argument_schema_entry_shape"],
    ["outputFacts", [], "invalid_action"],
    ["outputFacts", { result: "number" }, "invalid_action"],
    ["outputFacts", { result: 1 }, "invalid_action"],
  ]) {
    const changed = cloneFixture();
    changed.actions[0][field] = value;
    fails(code, () => validateActionSurface(changed));
  }

  const invalidClaimKey = cloneFixture();
  invalidClaimKey.actions[0].resourceTemplate.claims[0].key = "not-valid-key";
  fails("invalid_resource_claim_key", () => validateActionSurface(invalidClaimKey));

  for (const value of ["ActionId", "ScopeFarm", 1, { type: "ScopePlayer" }]) {
    const changed = cloneFixture();
    changed.actions[0].resourceTemplate.claims[0].value = value;
    fails("invalid_resource_claim_value", () => validateActionSurface(changed));
  }

  const extraTemplateField = cloneFixture();
  extraTemplateField.actions[0].resourceTemplate.extra = true;
  fails("invalid_resource_template_shape", () => validateActionSurface(extraTemplateField));
});

test("enforces bounded JSON text, arrays, identifiers, numbers, and plain data", () => {
  fails("bounds", () => parseActionSurface(" ".repeat(ACTION_SURFACE_MAX_JSON_BYTES + 1)));
  fails("bounds", () => validateActionSurface({
    schema: ACTION_SURFACE_SCHEMA,
    catalogRevision: 1,
    actions: Array.from({ length: 129 }, (_, index) => registration(`action_${index}`)),
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

test("source surface projection is restrictive: descriptors select, never create registrations", () => {
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

test("execution projection includes only published execution registrations and never read-only entries", () => {
  const projection = validateActionProjection(fixture);
  const expectedPublishedExecution = fixture.actions.filter(
    ({ lifecycle, kind }) => lifecycle === "published" && kind === "execution",
  );
  const expectedReadOnly = fixture.actions.filter(({ kind }) => kind === "read_only");
  assert.deepEqual(projection.actions.map(({ actionId }) => actionId), fixture.actions.map(({ actionId }) => actionId));
  assert.deepEqual(projection.executable.map(({ actionId }) => actionId), expectedPublishedExecution.map(({ actionId }) => actionId));
  assert.deepEqual(projectExecutableRegistrations(fixture), expectedPublishedExecution);
  assert.deepEqual(projection.readOnly.map(({ actionId }) => actionId), expectedReadOnly.map(({ actionId }) => actionId));
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
