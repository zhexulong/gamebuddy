import assert from "node:assert/strict";
import test from "node:test";
import {
  productionStoreSchemaAdmission,
  productionStoreSchemaCoverage,
  productionStoreSchemaDrops,
  PRODUCTION_CONTINUITY_STORE_SCHEMA_MIGRATIONS,
  PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION,
} from "./continuity-semantic-production-store.js";

/**
 * The gate for a defect class that has now happened once: `PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION` went
 * from 45 to 46 while the two objects it removed went with it and no step took a 45 root there, so every
 * existing root on this machine stopped opening - and nothing said so, because the refusal was a bare
 * `unsupported_production_store_schema` behind a composition that never reached a surface.
 *
 * What makes this a gate rather than an instance test is where its population comes from: the version
 * constant and the migration table, in that order of authority. No version is listed here, so a bump cannot
 * pass by being forgotten.
 *
 * VERIFIED RED (2026-11-18, real code, one edit): raising the constant to 47 and rebuilding makes this test
 * fail with
 *
 *   schema version 47 has no migration registered: add { from: 46, to: 47 } to
 *   PRODUCTION_CONTINUITY_STORE_SCHEMA_MIGRATIONS beside the bump, or a store written by version 46 cannot open
 *
 * and the same build answers `production_store_schema_unopenable:46` for the version that was current one
 * edit earlier - which is what the provisioning marker check asks, so a root minted at 46 would be refused by
 * name instead of by silence.
 */
test("every schema version this build claims to come from has a migration step to this one", () => {
  console.log(
    `schema coverage: migrations ${PRODUCTION_CONTINUITY_STORE_SCHEMA_MIGRATIONS.map((step) => `${String(step.from)}->${String(step.to)}`).join(",")}, current ${String(PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION)}`,
  );
  assert.deepEqual(
    productionStoreSchemaCoverage(),
    [],
    "the version this build opens and the migrations it carries disagree",
  );
  // The decision table, read through the same function the open path, the migration and the provisioning
  // marker check use: a version with a step migrates, this build's version opens, anything else is refused.
  assert.equal(productionStoreSchemaAdmission(PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION).status, "current");
  assert.equal(productionStoreSchemaAdmission(PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION - 1).status, "migrate");
  assert.equal(productionStoreSchemaAdmission(44).status, "unopenable");
  assert.equal(productionStoreSchemaAdmission(PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION + 1).status, "unopenable");
  assert.equal(productionStoreSchemaAdmission(null).status, "unopenable");
  // What an upgrade record publishes for a version 45 root, derived from the table rather than restated at
  // the place that writes the record.
  assert.deepEqual(productionStoreSchemaDrops(PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION - 1), [
    "production_continuity_thread.lifecycle",
    "production_chat_lifecycle_metadata",
    "production_continuity_command.command_kind=transition_chat_lifecycle",
  ]);
});
