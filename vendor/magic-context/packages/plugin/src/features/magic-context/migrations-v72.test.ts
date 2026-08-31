/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { getCompactionModeRecord, setCompactionModeRecord } from "./storage-meta-persisted";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v72 — per-session compaction mode record (issue #266)", () => {
    test("fresh DB schema includes compaction_mode_record", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(columnNames(db, "session_meta")).toContain("compaction_mode_record");
        } finally {
            closeQuietly(db);
        }
    });

    test("migrated DB adds compaction_mode_record idempotently with NULL default", () => {
        const db = new Database(":memory:");
        try {
            // A pre-v72 fixture: session_meta exists without the new column.
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (71, 'pre-v72 fixture', 1);
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
            // Idempotent: a second run must not error or duplicate.
            runMigrations(db);
            expect(columnNames(db, "session_meta")).toContain("compaction_mode_record");
            const row = db
                .prepare(
                    "SELECT compaction_mode_record FROM session_meta WHERE session_id = 'ses-old'",
                )
                .get() as { compaction_mode_record: string | null };
            // Pre-existing rows are unambiguously no-record (NULL).
            expect(row.compaction_mode_record).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("schema-fence remains in lockstep after v72", () => {
        expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
    });

    test("read/write helpers round-trip on, off, and null (no-record)", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const sessionId = "ses-mode";

            // No record initially (row created by helper).
            expect(getCompactionModeRecord(db, sessionId)).toBeNull();

            setCompactionModeRecord(db, sessionId, "on");
            expect(getCompactionModeRecord(db, sessionId)).toBe("on");

            setCompactionModeRecord(db, sessionId, "off");
            expect(getCompactionModeRecord(db, sessionId)).toBe("off");

            // Clear back to no-record.
            setCompactionModeRecord(db, sessionId, null);
            expect(getCompactionModeRecord(db, sessionId)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("setCompactionModeRecord rejects an invalid value", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(() => setCompactionModeRecord(db, "ses-bad", "disabled" as any)).toThrow();
        } finally {
            closeQuietly(db);
        }
    });
});
