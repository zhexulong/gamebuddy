/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function columnDefault(db: Database, table: string, column: string): unknown {
    const row = (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
            dflt_value: unknown;
        }>
    ).find((entry) => entry.name === column);
    return row?.dflt_value;
}

describe("migration v44 — memory classification columns", () => {
    test("fresh database has scope and shareable defaults", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnDefault(db, "memories", "scope")).toBe("'project'");
            expect(columnDefault(db, "memories", "shareable")).toBe("0");
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrade from v43 adds defaults without rewriting existing memory data", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                PRAGMA foreign_keys=ON;
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (43, 'pre-v44 fixture', 1);
                CREATE TABLE memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    category TEXT NOT NULL,
                    content TEXT NOT NULL,
                    normalized_hash TEXT NOT NULL,
                    importance INTEGER,
                    source_session_id TEXT,
                    source_type TEXT DEFAULT 'historian',
                    seen_count INTEGER DEFAULT 1,
                    retrieval_count INTEGER DEFAULT 0,
                    first_seen_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL,
                    status TEXT DEFAULT 'active'
                );
                INSERT INTO memories (project_path, category, content, normalized_hash, importance, first_seen_at, created_at, updated_at, last_seen_at)
                VALUES ('/repo', 'PROJECT_RULES', 'Existing memory', 'hash', 77, 1, 1, 1, 1);
            `);

            runMigrations(db);

            const row = db
                .prepare("SELECT content, importance, scope, shareable FROM memories WHERE id = 1")
                .get() as {
                content: string;
                importance: number;
                scope: string;
                shareable: number;
            };
            expect(row).toEqual({
                content: "Existing memory",
                importance: 77,
                scope: "project",
                shareable: 0,
            });
        } finally {
            closeQuietly(db);
        }
    });
});
