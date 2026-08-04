/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database, type Database as DatabaseType } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { healAllNullColumns } from "./storage-schema-helpers";

function tableExists(db: DatabaseType, table: string): boolean {
    return Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    );
}

function migrationRecorded(db: DatabaseType, version: number): boolean {
    return Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version));
}

describe("migration v51 — durable backfill state and strict healing", () => {
    test("fresh and upgraded databases include the versioned tool-owner state table", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(tableExists(db, "tool_owner_backfill_state")).toBe(true);
            expect(migrationRecorded(db, 51)).toBe(true);

            db.exec(`
                DELETE FROM schema_migrations WHERE version >= 51;
                DROP TABLE tool_owner_backfill_state;
            `);
            db.prepare("INSERT INTO session_meta (session_id, cache_ttl) VALUES (?, NULL)").run(
                "ses-v51",
            );

            runMigrations(db);

            expect(tableExists(db, "tool_owner_backfill_state")).toBe(true);
            expect(migrationRecorded(db, 51)).toBe(true);
            expect(
                db
                    .prepare("SELECT cache_ttl FROM session_meta WHERE session_id = ?")
                    .get("ses-v51"),
            ).toEqual({ cache_ttl: "" });
        } finally {
            closeQuietly(db);
        }
    });

    test("missing session_meta columns are tolerated", () => {
        const db = new Database(":memory:");
        try {
            db.exec("CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, cache_ttl TEXT)");
            db.prepare("INSERT INTO session_meta (session_id, cache_ttl) VALUES (?, NULL)").run(
                "ses-minimal",
            );

            expect(() => healAllNullColumns(db)).not.toThrow();
            expect(
                db
                    .prepare("SELECT cache_ttl FROM session_meta WHERE session_id = ?")
                    .get("ses-minimal"),
            ).toEqual({ cache_ttl: "" });
        } finally {
            closeQuietly(db);
        }
    });

    test("coalesces all present NULL fallbacks in one table update", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY,
                    cache_ttl TEXT,
                    prior_boundary_ordinal INTEGER,
                    memory_block_cache TEXT,
                    memory_block_ids TEXT,
                    memory_block_count INTEGER
                );
                INSERT INTO session_meta VALUES ('nulls', NULL, NULL, NULL, NULL, NULL);
                INSERT INTO session_meta VALUES ('repair', '5m', 1, 'stale cache', '', 2);
            `);
            const preparedUpdates: string[] = [];
            const originalPrepare = db.prepare.bind(db);
            const observedDb = new Proxy(db, {
                get(target, property) {
                    if (property === "prepare") {
                        return (sql: string) => {
                            if (sql.startsWith("UPDATE session_meta")) preparedUpdates.push(sql);
                            return originalPrepare(sql);
                        };
                    }
                    const value = Reflect.get(target, property, target) as unknown;
                    return typeof value === "function" ? value.bind(target) : value;
                },
            }) as DatabaseType;

            healAllNullColumns(observedDb);

            expect(preparedUpdates).toHaveLength(2);
            expect(preparedUpdates[0]).toContain("cache_ttl = COALESCE(cache_ttl, ?)");
            expect(
                db
                    .prepare(
                        "SELECT cache_ttl, prior_boundary_ordinal, memory_block_cache, memory_block_ids, memory_block_count FROM session_meta WHERE session_id = 'nulls'",
                    )
                    .get(),
            ).toEqual({
                cache_ttl: "",
                prior_boundary_ordinal: 1,
                memory_block_cache: "",
                memory_block_ids: "",
                memory_block_count: 0,
            });
            expect(
                db
                    .prepare(
                        "SELECT memory_block_cache FROM session_meta WHERE session_id = 'repair'",
                    )
                    .get(),
            ).toEqual({ memory_block_cache: "" });
        } finally {
            closeQuietly(db);
        }
    });

    test("non-schema healer errors roll back and leave v51 unrecorded", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.exec(`
                DELETE FROM schema_migrations WHERE version >= 51;
                DROP TABLE tool_owner_backfill_state;
            `);

            const originalPrepare = db.prepare.bind(db);
            const injectedError = new Error("database is busy") as Error & { code: string };
            injectedError.code = "SQLITE_BUSY";
            const failingDb = new Proxy(db, {
                get(target, property) {
                    if (property === "prepare") {
                        return (sql: string) => {
                            if (sql.startsWith("UPDATE session_meta SET cache_ttl")) {
                                return {
                                    run: () => {
                                        throw injectedError;
                                    },
                                };
                            }
                            return originalPrepare(sql);
                        };
                    }
                    const value = Reflect.get(target, property, target) as unknown;
                    return typeof value === "function" ? value.bind(target) : value;
                },
            }) as DatabaseType;

            expect(() => runMigrations(failingDb)).toThrow(/database is busy/);
            expect(migrationRecorded(db, 51)).toBe(false);
            expect(tableExists(db, "tool_owner_backfill_state")).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });
});
