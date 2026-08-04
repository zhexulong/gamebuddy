import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v29 — notes.anchor_ordinal", () => {
    test("adds a nullable anchor_ordinal column to notes on a fresh DB, idempotently", () => {
        const db = new Database(":memory:");
        try {
            // Mirror openDatabase: initializeDatabase (creates session_meta etc.)
            // then runMigrations (v1 creates `notes`, v29 adds the column).
            // Running migrations twice proves idempotency (PRAGMA guard skips ALTER).
            initializeDatabase(db);
            runMigrations(db);
            runMigrations(db);

            expect(columnNames(db, "notes")).toContain("anchor_ordinal");
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: LATEST_MIGRATION_VERSION });
        } finally {
            closeQuietly(db);
        }
    });

    test("anchor_ordinal stores an integer and round-trips as null when unset", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            db.prepare(
                "INSERT INTO notes (type, status, content, session_id, created_at, updated_at, anchor_ordinal) VALUES ('session', 'active', ?, ?, ?, ?, ?)",
            ).run("anchored", "ses_x", 1, 1, 4242);
            db.prepare(
                "INSERT INTO notes (type, status, content, session_id, created_at, updated_at) VALUES ('session', 'active', ?, ?, ?, ?)",
            ).run("unanchored", "ses_x", 1, 1);

            const rows = db
                .prepare("SELECT content, anchor_ordinal FROM notes ORDER BY id ASC")
                .all() as Array<{ content: string; anchor_ordinal: number | null }>;

            expect(rows).toEqual([
                { content: "anchored", anchor_ordinal: 4242 },
                { content: "unanchored", anchor_ordinal: null },
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});
