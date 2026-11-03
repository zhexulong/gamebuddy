import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import { PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import {
  fingerprintDatabase,
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
const AUTHORITY = ".gamebuddy-semantic-continuity-v1";
const DATABASE = "gamebuddy-continuity-v1.sqlite";

/**
 * The fingerprint must see a COMMITTED write, and under WAL the main file does not move when one
 * happens - so a fingerprint over the main file alone reports "unchanged" for exactly the case it
 * exists to catch.
 *
 * This drives the real `fingerprintDatabase` against a real authority rather than re-implementing its
 * predicate, and it asserts the two readings that make the defect visible together: the main file is
 * byte-identical across the commit, AND the fingerprint still changes. MEASURED 2026-11-01 on this
 * store: main file unchanged, 12 392 bytes of committed history sitting in `-wal`.
 *
 * RED against a main-file-only fingerprint: `fingerprintDatabase` returned the same digest before and
 * after a committed write, which would let `production_store_changed_during_open` pass on a store that
 * changed underneath it.
 */
test("the authority fingerprint covers a committed write that leaves the main database file identical", () => {
  const root = canonicalTestRootSync("s3-fingerprint-wal-");
  try {
    const fresh = provisionFreshProductionContinuity(input(root));
    fresh.close();
    const authorityRoot = join(root, AUTHORITY);
    const databasePath = join(authorityRoot, DATABASE);
    const before = fingerprintDatabase(authorityRoot);
    const mainBefore = readFileSync(databasePath);

    // A committed write through a plain connection, so the reading is about what SQLite does to the
    // files rather than about the store's command surface.
    const db = new DatabaseSync(databasePath);
    try {
      assert.equal(
        (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
        "wal",
        "the authority is not in WAL mode, so this gate is no longer describing the store it protects",
      );
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        "INSERT INTO production_game_session_metadata VALUES('fp-row','fp-request','stardew',NULL,'failed',2)",
      ).run();
      db.exec("COMMIT");
      const walPath = `${databasePath}-wal`;
      assert.ok(existsSync(walPath), "a committed write left no -wal, so there is nothing for the fingerprint to miss");
      assert.deepEqual(
        readFileSync(databasePath),
        mainBefore,
        "the main database file DID change across the commit, so this gate no longer reproduces the WAL case it exists for: a main-file-only fingerprint would have caught this write by accident",
      );
      assert.notEqual(
        fingerprintDatabase(authorityRoot),
        before,
        "the authority fingerprint did not change across a committed write: the database file was byte-identical and the committed frames live in -wal, so `production_store_changed_during_open` would report an unchanged store while it changed",
      );
    } finally {
      db.close();
    }
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});

/**
 * A read-only connection is still a DIRECTORY writer under WAL, and that is the price of the mode.
 *
 * MEASURED 2026-11-01: `new DatabaseSync(path, { readOnly: true })` creates `-wal` and `-shm` beside a
 * WAL database, and under DELETE it creates nothing. So an out-of-band reader - a test asserting on
 * committed state, a diagnostic - leaves files in an authority root that
 * `assertAuthorityRootContainsOnly` then refuses for every later process.
 *
 * The assertion is the DERIVED property rather than the file names: whatever a read-only open creates,
 * it must be the database's own family (`databaseFamilyEntry`) or the root's admission check must
 * reject it. That is what the admission check allows, so it is what this pins.
 */
test("a read-only open leaves only the database's own family in the authority root", () => {
  const root = canonicalTestRootSync("s3-readonly-family-");
  try {
    const fresh = provisionFreshProductionContinuity(input(root));
    fresh.close();
    const authorityRoot = join(root, AUTHORITY);
    const before = readdirSync(authorityRoot).sort();
    const db = new DatabaseSync(join(authorityRoot, DATABASE), { readOnly: true });
    try {
      db.prepare("SELECT 1 AS one FROM production_bootstrap").get();
    } finally {
      db.close();
    }
    const added = readdirSync(authorityRoot)
      .filter((entry) => !before.includes(entry))
      .sort();
    // The property, derived from the same name the database has: anything a read-only open creates
    // must be a sidecar OF THIS DATABASE, because that is all the authority-root admission accepts
    // beyond the marker. A reader that invented a differently-named artifact would make the root
    // unopenable for the next launch, and this names it.
    const foreign = added.filter((entry) => !entry.startsWith(`${DATABASE}-`));
    assert.deepEqual(
      foreign,
      [],
      `a read-only open added ${foreign.join(", ")} to the authority root, which is not part of the ${DATABASE} family: the next admission would refuse the root with production_authority_artifact_present`,
    );
    // And the root still opens as known, which is the property a player's next launch depends on.
    const reopened = openKnownProductionContinuity(input(root));
    reopened.close();
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
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

test("fresh authority writes the exact v45 fresh-only schema and v21 marker pair", () => {
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
    assert.equal(marker.schemaVersion, 45);
    assert.equal(PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION, 45);
    const reopened = openKnownProductionContinuity(input(root));
    try {
      assert.equal(reopened.schemaVersion, 45);
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

test("historical fresh marker pairs through v44/v21 are rejected byte-preserving", () => {
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
    { version: 21, schemaVersion: 44 },
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
    // path writes last, and that database with SQLite's own artifacts beside it after a
    // crash inside a transaction. The artifacts are the WAL family, because that is what
    // the store runs: MEASURED 2026-11-01, a fresh authority mid-provision is a 4 KB main
    // file beside a 239 KB `-wal` that holds the committed bootstrap row.
    const leftovers: readonly (readonly string[])[] = [
      [],
      ["gamebuddy-continuity-v1.sqlite"],
      ["gamebuddy-continuity-v1.sqlite", "gamebuddy-continuity-v1.sqlite-wal"],
      ["gamebuddy-continuity-v1.sqlite", "gamebuddy-continuity-v1.sqlite-wal", "gamebuddy-continuity-v1.sqlite-shm"],
      // A rollback journal is no longer what this store writes, but a directory carried over
      // from a DELETE-mode build still holds one and the discard predicate must keep covering it.
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
