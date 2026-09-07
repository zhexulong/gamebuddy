import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import { PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import {
  openKnownProductionContinuity,
  provisionFreshProductionContinuity,
} from "./continuity-semantic-provisioning.internal.js";

const principal = { continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" };
const input = (runtimeCwd: string) => ({
  runtimeCwd,
  principal,
  bootstrapOperationId: "bootstrap_01",
  authorityGeneration: 1,
});
test("production provisioning is fresh-only and malformed store is byte-preserved", () => {
  const root = canonicalTestRootSync("s3-provision-");
  try {
    const fresh = provisionFreshProductionContinuity(input(root));
    assert.equal(fresh.schemaVersion, PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION);
    fresh.close();
    assert.throws(() => provisionFreshProductionContinuity(input(root)));
    const path = join(root, ".gamebuddy-semantic-continuity-v1", "gamebuddy-continuity-v1.sqlite"),
      _before = readFileSync(path);
    writeFileSync(path, Buffer.from("malformed-production-store"));
    const poisoned = readFileSync(path);
    assert.throws(() => openKnownProductionContinuity(input(root)));
    assert.deepEqual(readFileSync(path), poisoned);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* SQLite handle cleanup is best effort on Windows */
    }
  }
});

test("provision close is terminal at the public store boundary", () => {
  const root = canonicalTestRootSync("s3-close-terminal-");
  try {
    const fresh = provisionFreshProductionContinuity(input(root));
    fresh.close();
    assert.throws(() => fresh.store.readChatCatalog(), /production_store_already_closed/);
    assert.throws(() => fresh.close(), /production_store_already_closed/);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});

test("fresh authority writes the exact v42 fresh-only schema and v21 marker pair", () => {
  const root = canonicalTestRootSync("s3-marker-exact-");
  try {
    const fresh = provisionFreshProductionContinuity(input(root));
    const expectedStoreId = fresh.storeId;
    fresh.close();
    const markerPath = join(root, ".gamebuddy-semantic-continuity-v1", "production-authority-marker.json"),
      marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(marker).sort(), [
      "authorityGeneration",
      "authorityRootIdentity",
      "bootstrapOperationId",
      "companionId",
      "continuityId",
      "playerId",
      "schemaVersion",
      "storeId",
      "version",
    ]);
    assert.equal(marker.version, 21);
    assert.equal(marker.schemaVersion, 42);
    assert.equal(PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION, 42);
    const reopened = openKnownProductionContinuity(input(root));
    try {
      assert.equal(reopened.schemaVersion, 42);
      assert.equal(reopened.storeId, expectedStoreId);
      assert.equal(reopened.store.readChatCatalog().vector.partitionRevision, 1);
    } finally {
      reopened.close();
    }
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});

test("historical fresh marker pairs through v41/v21 are rejected byte-preserving", () => {
  for (const marker of [
    { version: 2, schemaVersion: 15 },
    { version: 3, schemaVersion: 16 },
    { version: 4, schemaVersion: 17 },
    { version: 5, schemaVersion: 18 },
    { version: 6, schemaVersion: 19 },
    { version: 7, schemaVersion: 20 },
    { version: 8, schemaVersion: 21 },
    { version: 9, schemaVersion: 22 },
    { version: 10, schemaVersion: 23 },
    { version: 11, schemaVersion: 24 },
    { version: 12, schemaVersion: 25 },
    { version: 13, schemaVersion: 26 },
    { version: 14, schemaVersion: 27 },
    { version: 15, schemaVersion: 28 },
    { version: 16, schemaVersion: 29 },
    { version: 17, schemaVersion: 30 },
    { version: 17, schemaVersion: 31 },
    { version: 18, schemaVersion: 31 },
    { version: 19, schemaVersion: 32 },
    { version: 20, schemaVersion: 33 },
    { version: 21, schemaVersion: 34 },
    { version: 21, schemaVersion: 35 },
    { version: 21, schemaVersion: 36 },
    { version: 21, schemaVersion: 37 },
    { version: 21, schemaVersion: 38 },
    { version: 21, schemaVersion: 39 },
    { version: 21, schemaVersion: 40 },
    { version: 21, schemaVersion: 41 },
  ]) {
    const root = canonicalTestRootSync("s3-marker-");
    try {
      const fresh = provisionFreshProductionContinuity(input(root));
      fresh.close();
      const markerPath = join(root, ".gamebuddy-semantic-continuity-v1", "production-authority-marker.json");
      writeFileSync(
        markerPath,
        JSON.stringify({
          ...marker,
          bootstrapOperationId: "bootstrap_01",
          authorityGeneration: 1,
          authorityRootIdentity: "0".repeat(64),
          continuityId: principal.continuityId,
          companionId: principal.companionId,
          playerId: principal.playerId,
          storeId: "0".repeat(36),
        }),
      );
      const before = readFileSync(markerPath),
        databasePath = join(root, ".gamebuddy-semantic-continuity-v1", "gamebuddy-continuity-v1.sqlite"),
        databaseBefore = readFileSync(databasePath);
      assert.throws(() => openKnownProductionContinuity(input(root)));
      assert.deepEqual(readFileSync(markerPath), before);
      assert.deepEqual(readFileSync(databasePath), databaseBefore);
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* best effort */
      }
    }
  }
});

test("fresh authority marker rejects every mutated field without rewriting marker bytes", () => {
  const fields: { field: string; value: unknown }[] = [
    { field: "version", value: 20 },
    { field: "schemaVersion", value: 34 },
    { field: "bootstrapOperationId", value: "other-bootstrap" },
    { field: "authorityGeneration", value: 2 },
    { field: "authorityRootIdentity", value: "f".repeat(64) },
    { field: "continuityId", value: "other-continuity" },
    { field: "companionId", value: "other-companion" },
    { field: "playerId", value: "other-player" },
    { field: "storeId", value: "0".repeat(36) },
  ];
  for (const { field, value } of fields) {
    const root = canonicalTestRootSync("s3-marker-field-");
    try {
      const fresh = provisionFreshProductionContinuity(input(root));
      fresh.close();
      const markerPath = join(root, ".gamebuddy-semantic-continuity-v1", "production-authority-marker.json"),
        marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
      marker[field] = value;
      writeFileSync(markerPath, JSON.stringify(marker));
      const before = readFileSync(markerPath);
      assert.throws(() => openKnownProductionContinuity(input(root)), `mutated ${field} accepted`);
      assert.deepEqual(readFileSync(markerPath), before, `${field} marker was rewritten`);
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* best effort */
      }
    }
  }
});
