/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { loadProtectedTailMeta } from "./storage-meta";

const V37_COLUMNS = ["emergency_drain_active", "historian_drain_failure_at"] as const;

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v37 — emergency drain catch-up latch", () => {
    test("fresh DB schema includes the latch columns and defaults", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const columns = columnNames(db, "session_meta");
            for (const column of V37_COLUMNS) expect(columns).toContain(column);
            const meta = loadProtectedTailMeta(db, "ses-v37-fresh");
            expect(meta.emergencyDrainActive).toBe(0);
            expect(meta.historianDrainFailureAt).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("migrated DB adds and heals the latch columns idempotently", () => {
        const db = new Database(":memory:");
        try {
            // Pre-v37 fixture: session_meta WITHOUT the new columns, plus a row.
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (36, 'pre-v37 fixture', 1);
                CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    last_response_time INTEGER DEFAULT 0,
                    cache_ttl TEXT DEFAULT '5m',
                    counter INTEGER DEFAULT 0,
                    compartment_in_progress INTEGER DEFAULT 0,
                    prior_boundary_ordinal INTEGER DEFAULT 1
                );
                INSERT INTO session_meta (session_id) VALUES ('ses-old');
            `);

            runMigrations(db);
            runMigrations(db); // idempotent

            const columns = columnNames(db, "session_meta");
            for (const column of V37_COLUMNS) expect(columns).toContain(column);
            const row = db
                .prepare(
                    "SELECT emergency_drain_active, historian_drain_failure_at FROM session_meta WHERE session_id = 'ses-old'",
                )
                .get();
            expect(row).toEqual({ emergency_drain_active: 0, historian_drain_failure_at: 0 });
        } finally {
            closeQuietly(db);
        }
    });
});
