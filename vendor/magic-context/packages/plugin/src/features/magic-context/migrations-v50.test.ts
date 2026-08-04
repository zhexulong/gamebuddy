/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { clearSession } from "./storage-meta-session";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v50 — ctx-wrapup durable marker", () => {
    test("fresh DB schema includes wrapup_in_progress_state", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(columnNames(db, "session_meta")).toContain("wrapup_in_progress_state");
        } finally {
            closeQuietly(db);
        }
    });

    test("migrated DB adds wrapup_in_progress_state idempotently", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (49, 'pre-v50 fixture', 1);
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
            runMigrations(db);
            expect(columnNames(db, "session_meta")).toContain("wrapup_in_progress_state");
            const row = db
                .prepare(
                    "SELECT wrapup_in_progress_state FROM session_meta WHERE session_id = 'ses-old'",
                )
                .get() as { wrapup_in_progress_state: string | null };
            expect(row.wrapup_in_progress_state).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("clearSession removes the session-scoped wrapup marker with session_meta", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.prepare(
                "INSERT INTO session_meta (session_id, wrapup_in_progress_state) VALUES (?, ?)",
            ).run("ses-clear", JSON.stringify({ holderId: "h", expiresAt: 999 }));

            clearSession(db, "ses-clear");

            expect(
                db.prepare("SELECT 1 FROM session_meta WHERE session_id = ?").get("ses-clear"),
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
