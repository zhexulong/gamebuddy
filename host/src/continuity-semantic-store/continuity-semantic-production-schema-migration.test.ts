import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import {
  PRODUCTION_STORE_DATABASE,
  rewriteProductionStoreAsVersion45,
} from "../test-support/production-store-v45-fixture.test-support.js";
import {
  migrateProductionContinuityStoreSchema,
  openProductionContinuityStore,
  PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION,
  type ProductionBootstrapInput,
  type TavernExactContentReceipt,
} from "./continuity-semantic-production-store.js";

const DATABASE = PRODUCTION_STORE_DATABASE;
const DROPPED_TABLE = "production_chat_lifecycle_metadata";
const principal = { continuityId: "continuity1", companionId: "companion1", playerId: "player1" } as const;
const bootstrap: ProductionBootstrapInput = {
  principal,
  bootstrapOperationId: "bootstrap1",
  authorityGeneration: 1,
  authorityRootIdentity: "a".repeat(64),
};
const holderBindingDigest = "b".repeat(64);

function receiptFor(chatThreadId: string, chatSurfaceSessionId: string): TavernExactContentReceipt {
  return Object.freeze({
    chatThreadId,
    chatSurfaceSessionId,
    continuityId: principal.continuityId,
    companionId: principal.companionId,
    digest: "c".repeat(64),
  });
}

/** One root holding real data: an initial Chat registered, verified and selected. */
function rootWithSelectedChat(): string {
  const root = canonicalTestRootSync("production-schema-migration-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const claim = store.claim({
      holderBindingDigest,
      operationId: "claim-1",
      expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
    });
    const registered = store.register({ holderBindingDigest, operationId: "register-1", expected: claim.vector });
    const verified = store.verify(
      { holderBindingDigest, operationId: "verify-1", expected: registered.vector },
      receiptFor(registered.chatThreadId!, registered.chatSurfaceSessionId!),
    );
    store.select({ holderBindingDigest, operationId: "select-1", expected: verified.vector });
  } finally {
    control.close();
  }
  return root;
}

function readOnly<T>(root: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(root, DATABASE), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Every table's row count, by name - the reading the migration must leave untouched. */
function rowCounts(root: string): Record<string, number> {
  return readOnly(root, (db) => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((table) => table.name);
    return Object.fromEntries(
      tables.map((table) => [table, (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]),
    );
  });
}

/**
 * A root whose only fact is the version it records. The open path has to answer about the version before it
 * can know anything else about the file, so this is the smallest fixture that exercises that answer.
 */
function rootRecordingVersion(version: number): string {
  const root = canonicalTestRootSync("production-schema-version-");
  const db = new DatabaseSync(join(root, DATABASE));
  try {
    db.exec(
      "CREATE TABLE production_store_meta (singleton INTEGER PRIMARY KEY, store_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL)",
    );
    db.prepare("INSERT INTO production_store_meta VALUES(1,?,?)").run("00000000-0000-0000-0000-000000000000", version);
  } finally {
    db.close();
  }
  return root;
}

/**
 * The defect this lane was opened for: the 45 -> 46 bump dropped the Chat lifecycle mirror without a step
 * that takes a 45 root there, so every existing root refused to open and nothing repaired it.
 *
 * The order of the readings is the proof. First the refusal, by name and without a transaction - today's
 * behaviour. Then the migration, then the same root opened, with every surviving table's row count quoted
 * before and after and the selection naming the same Chat.
 */
test("a version 45 store refuses to open by name, then opens after the migration with every surviving table intact", () => {
  const root = rootWithSelectedChat();
  try {
    rewriteProductionStoreAsVersion45(root);
    const countsBefore = rowCounts(root);
    const selectionBefore = readOnly(root, (db) =>
      db
        .prepare("SELECT chat_thread_id,chat_surface_session_id,selection_revision FROM production_active_selection")
        .all(),
    );
    assert.equal(countsBefore[DROPPED_TABLE], 1, "the fixture did not carry the mirror's CAS row");

    assert.throws(
      () => openProductionContinuityStore({ runtimeRoot: root }),
      /production_store_schema_migration_required:45/,
      "a version 45 store must refuse by naming the version, not as an unknown schema",
    );

    const upgrade = migrateProductionContinuityStoreSchema({ runtimeRoot: root });
    assert.deepEqual(upgrade, { fromVersion: 45, toVersion: PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION });
    assert.equal(
      migrateProductionContinuityStoreSchema({ runtimeRoot: root }),
      null,
      "the migration is not idempotent: a second run must report that there was nothing to do",
    );

    const countsAfter = rowCounts(root);
    const surviving = Object.keys(countsAfter).sort();
    assert.deepEqual(
      surviving,
      Object.keys(countsBefore)
        .filter((table) => table !== DROPPED_TABLE)
        .sort(),
      "the set of tables changed beyond the mirror table the step declares",
    );
    for (const table of surviving)
      assert.equal(countsAfter[table], countsBefore[table], `${table} lost or gained rows during the migration`);

    const shape = readOnly(root, (db) => ({
      version: (db.prepare("SELECT schema_version FROM production_store_meta").get() as { schema_version: number })
        .schema_version,
      threadColumns: (db.prepare("PRAGMA table_info(production_continuity_thread)").all() as { name: string }[]).map(
        (column) => column.name,
      ),
      commandSql: (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='production_continuity_command'")
          .get() as {
          sql: string;
        }
      ).sql,
      tables: (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (table) => table.name,
      ),
    }));
    assert.equal(shape.version, PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION);
    assert.equal(shape.threadColumns.includes("lifecycle"), false, "the migration kept the mirror column");
    assert.equal(shape.tables.includes(DROPPED_TABLE), false, "the migration kept the mirror's CAS table");
    assert.equal(shape.commandSql.includes("transition_chat_lifecycle"), false);

    const control = openProductionContinuityStore({ runtimeRoot: root });
    try {
      const metadata = control.validateBootstrap(bootstrap);
      const store = control.bindBootstrapContext({ bootstrap, metadata });
      const catalog = store.readChatCatalog();
      const selectionAfter = readOnly(root, (db) =>
        db
          .prepare("SELECT chat_thread_id,chat_surface_session_id,selection_revision FROM production_active_selection")
          .all(),
      );
      console.log(
        `schema migration: version 45 -> ${String(shape.version)}, selection ${JSON.stringify(selectionAfter)}, tables ${String(surviving.length)}`,
      );
      assert.deepEqual(selectionAfter, selectionBefore, "the selection moved during the migration");
      assert.deepEqual(
        catalog.threads.map((thread) => thread.chatThreadId),
        [(selectionBefore as { chat_thread_id: string }[])[0]!.chat_thread_id],
        "the catalog no longer names the Chat the selection names",
      );
      assert.equal(catalog.threads[0]!.contentState, "verified");
    } finally {
      control.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The other half of "never leave recognised-older -> throw": a version with no step is refused by name, and
 * the refusal says which version, because that is the one thing an operator needs to know.
 *
 * The property asserted is that a refusal is not a partial migration: the file still records the version it
 * arrived with. Byte-identity is NOT the property here and cannot be - the open path sets the journal mode
 * before it reads anything, so SQLite's own header moves on every open.
 */
test("a version this build cannot come from is refused by name and is never migrated", () => {
  for (const [version, expected] of [
    [44, /production_store_schema_unopenable:44/],
    [PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION + 1, /production_store_schema_unopenable:47/],
  ] as const) {
    const root = rootRecordingVersion(version);
    try {
      assert.throws(() => openProductionContinuityStore({ runtimeRoot: root }), expected);
      assert.throws(() => migrateProductionContinuityStoreSchema({ runtimeRoot: root }), expected);
      assert.equal(
        readOnly(
          root,
          (db) =>
            (db.prepare("SELECT schema_version FROM production_store_meta").get() as { schema_version: number })
              .schema_version,
        ),
        version,
        "a refused version was migrated anyway",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
