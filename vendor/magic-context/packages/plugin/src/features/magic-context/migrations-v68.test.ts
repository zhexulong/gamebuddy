/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function seedAppliedVersion(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    const insert = db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
    );
    for (let current = 1; current <= version; current += 1) {
        insert.run(current, `seed v${current}`, Date.now());
    }
}

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v68: convergent message history", () => {
    test("fresh databases carry source, retry, sweep, and fence state", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(columnNames(db, "message_history_source")).toEqual([
                "session_id",
                "message_id",
                "message_ordinal",
                "source_version",
                "normalized_content_hash",
                "role",
                "harness",
                "updated_at",
            ]);
            expect(columnNames(db, "pending_session_cleanup")).toEqual([
                "session_id",
                "harness",
                "requested_at",
                "last_attempt_at",
            ]);
            expect(columnNames(db, "message_history_orphan_sweep")).toEqual([
                "harness",
                "cursor_session_id",
                "last_swept_at",
            ]);
            expect(
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_message_history_index_orphan_sweep'",
                    )
                    .get(),
            ).toBeDefined();
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades a pre-v68 message tracker schema", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE message_history_index (
                    session_id TEXT PRIMARY KEY,
                    last_indexed_ordinal INTEGER NOT NULL DEFAULT 0,
                    dirty_floor_ordinal INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode'
                );
            `);
            seedAppliedVersion(db, 66);

            runMigrations(db);

            expect(columnNames(db, "message_history_source")).toContain("normalized_content_hash");
            expect(columnNames(db, "pending_session_cleanup")).toContain("requested_at");
            expect(columnNames(db, "message_history_orphan_sweep")).toContain("cursor_session_id");
            expect(
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_message_history_index_orphan_sweep'",
                    )
                    .get(),
            ).toBeDefined();
        } finally {
            closeQuietly(db);
        }
    });

    test("guards the tracker index when a sparse fixture lacks required columns", () => {
        const db = new Database(":memory:");
        try {
            db.exec("CREATE TABLE message_history_index (session_id TEXT PRIMARY KEY)");
            seedAppliedVersion(db, 66);
            expect(() => runMigrations(db)).not.toThrow();
            expect(columnNames(db, "message_history_source")).toContain("source_version");
        } finally {
            closeQuietly(db);
        }
    });
});
