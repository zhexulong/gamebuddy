/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    getPersistedTodoPermissionDenied,
    setPersistedTodoPermissionDenied,
} from "./storage-meta-persisted";
import { clearSession } from "./storage-meta-session";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v73 — durable todowrite permission verdict", () => {
    test("fresh and migrated schemas use a non-boolean unknown verdict", () => {
        const fresh = new Database(":memory:");
        const migrated = new Database(":memory:");
        try {
            initializeDatabase(fresh);
            runMigrations(fresh);
            expect(columnNames(fresh, "session_meta")).toContain("todo_permission_denied");

            migrated.exec(`
                CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    description TEXT NOT NULL,
                    applied_at INTEGER NOT NULL
                );
                INSERT INTO schema_migrations (version, description, applied_at)
                VALUES (72, 'pre-v73 fixture', 1);
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
            runMigrations(migrated);
            runMigrations(migrated);
            const row = migrated
                .prepare(
                    "SELECT todo_permission_denied FROM session_meta WHERE session_id = 'ses-old'",
                )
                .get() as { todo_permission_denied: number };
            expect(row.todo_permission_denied).toBe(2);
            expect(getPersistedTodoPermissionDenied(migrated, "ses-old")).toBeNull();
        } finally {
            closeQuietly(fresh);
            closeQuietly(migrated);
        }
    });

    test("helpers preserve false distinctly and clearSession removes the verdict", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const sessionId = "ses-permission";

            expect(getPersistedTodoPermissionDenied(db, sessionId)).toBeNull();
            setPersistedTodoPermissionDenied(db, sessionId, true);
            expect(getPersistedTodoPermissionDenied(db, sessionId)).toBe(true);
            setPersistedTodoPermissionDenied(db, sessionId, false);
            expect(getPersistedTodoPermissionDenied(db, sessionId)).toBe(false);

            clearSession(db, sessionId);
            expect(getPersistedTodoPermissionDenied(db, sessionId)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("retains v73 in migration history after later schema upgrades", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(
                db.prepare("SELECT version FROM schema_migrations WHERE version = 73").get(),
            ).toEqual({ version: 73 });
        } finally {
            closeQuietly(db);
        }
    });
});
