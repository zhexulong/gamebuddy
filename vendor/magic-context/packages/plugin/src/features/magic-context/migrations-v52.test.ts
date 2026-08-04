/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v52 — emergency recovery origin", () => {
    test("fresh schema includes the replay-safe origin column", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(columnNames(db, "session_meta")).toContain("emergency_recovery_origin");
        } finally {
            closeQuietly(db);
        }
    });

    test("migrates an armed legacy session without inventing an origin", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    description TEXT NOT NULL,
                    applied_at INTEGER NOT NULL
                );
                INSERT INTO schema_migrations (version, description, applied_at)
                VALUES (51, 'pre-v52 fixture', 1);
                CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY,
                    needs_emergency_recovery INTEGER NOT NULL DEFAULT 0,
                    detected_context_limit INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO session_meta (session_id, needs_emergency_recovery)
                VALUES ('ses-legacy-proactive', 1);
            `);

            runMigrations(db);
            runMigrations(db);

            const row = db
                .prepare(
                    "SELECT needs_emergency_recovery, emergency_recovery_origin FROM session_meta WHERE session_id = ?",
                )
                .get("ses-legacy-proactive") as {
                needs_emergency_recovery: number;
                emergency_recovery_origin: string | null;
            };
            expect(row).toEqual({
                needs_emergency_recovery: 1,
                emergency_recovery_origin: "",
            });
        } finally {
            closeQuietly(db);
        }
    });
});
