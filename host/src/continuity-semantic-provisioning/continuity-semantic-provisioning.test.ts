import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const path = join(root, ".gamebuddy-semantic-continuity-v1", "gamebuddy-continuity-v1.sqlite");
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

test("fresh authority writes the exact v44 fresh-only schema and v21 marker pair", () => {
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
     assert.equal(marker.schemaVersion, 44);
     assert.equal(PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION, 44);
    const reopened = openKnownProductionContinuity(input(root));
    try {
       assert.equal(reopened.schemaVersion, 44);
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

test("historical fresh marker pairs through v42/v21 are rejected byte-preserving", () => {
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
     { version: 21, schemaVersion: 42 },
     { version: 21, schemaVersion: 43 },
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

test("an interrupted first run is recovered by the next fresh provision", () => {
  const root = canonicalTestRootSync("s3-interrupted-fresh-");
  try {
    const authority = join(root, ".gamebuddy-semantic-continuity-v1"),
      databasePath = join(authority, "gamebuddy-continuity-v1.sqlite"),
      markerPath = join(authority, "production-authority-marker.json");
    // The shapes an interrupted first run leaves behind: the directory the fresh path
    // created before its database, that database before the completion marker the fresh
    // path writes last, and that database with SQLite's own journal beside it after a
    // crash inside a transaction.
    const leftovers: readonly (readonly string[])[] = [
      [],
      ["gamebuddy-continuity-v1.sqlite"],
      ["gamebuddy-continuity-v1.sqlite", "gamebuddy-continuity-v1.sqlite-journal"],
    ];
    for (const leftover of leftovers) {
      rmSync(authority, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      mkdirSync(authority, { recursive: true });
      for (const entry of leftover) writeFileSync(join(authority, entry), "interrupted-first-run");
      const recovered = provisionFreshProductionContinuity(input(root));
      const storeId = recovered.storeId;
      recovered.close();
      // Discarded, not adopted: no byte of the leftover survives, a complete authority
      // stands in its place, and the next launch can open it as known.
      assert.equal(readFileSync(databasePath).includes(Buffer.from("interrupted-first-run")), false);
      assert.ok(existsSync(markerPath));
      const reopened = openKnownProductionContinuity(input(root));
      try {
        assert.equal(reopened.storeId, storeId);
      } finally {
        reopened.close();
      }
    }
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* SQLite handle cleanup is best effort on Windows */
    }
  }
});

test("a fresh provision refuses every leftover authority it cannot prove incomplete", () => {
  const root = canonicalTestRootSync("s3-not-incomplete-");
  try {
    const authority = join(root, ".gamebuddy-semantic-continuity-v1"),
      databasePath = join(authority, "gamebuddy-continuity-v1.sqlite"),
      markerPath = join(authority, "production-authority-marker.json");
    // A directory holding anything the fresh path never creates before its marker is
    // not proven incomplete, so it is refused instead of deleted.
    mkdirSync(authority, { recursive: true });
    writeFileSync(databasePath, "leftover-database");
    writeFileSync(join(authority, "surface-sessions"), "unexpected-artifact");
    assert.throws(() => provisionFreshProductionContinuity(input(root)), /production_authority_artifact_present/);
    assert.equal(readFileSync(join(authority, "surface-sessions"), "utf8"), "unexpected-artifact");
    rmSync(join(authority, "surface-sessions"));
    // A marker that is there but carries nothing valid does not prove completion
    // either, and its presence is therefore refused rather than discarded.
    writeFileSync(markerPath, "{}");
    const markerBefore = readFileSync(markerPath),
      databaseBefore = readFileSync(databasePath);
    assert.throws(() => provisionFreshProductionContinuity(input(root)), /production_authority_artifact_present/);
    assert.deepEqual(readFileSync(markerPath), markerBefore);
    assert.deepEqual(readFileSync(databasePath), databaseBefore);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});

test("a known mount refuses a missing or leftover authority and deletes nothing", () => {
  const root = canonicalTestRootSync("s3-known-refuses-");
  try {
    const authority = join(root, ".gamebuddy-semantic-continuity-v1"),
      databasePath = join(authority, "gamebuddy-continuity-v1.sqlite");
    // A genuinely lost authority stays fail-closed: known never provisions.
    assert.throws(() => openKnownProductionContinuity(input(root)), /production_store_not_admitted/);
    // A leftover from an interrupted first run is not something known adopts either, and
    // the known path never deletes: the fresh launch that recovers it still can.
    mkdirSync(authority, { recursive: true });
    writeFileSync(databasePath, "interrupted-first-run");
    const leftoverBefore = readdirSync(authority);
    assert.throws(() => openKnownProductionContinuity(input(root)), /production_authority_artifact_present/);
    assert.deepEqual(readdirSync(authority), leftoverBefore);
    assert.equal(readFileSync(databasePath, "utf8"), "interrupted-first-run");
    const recovered = provisionFreshProductionContinuity(input(root));
    recovered.close();
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});
