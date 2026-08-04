/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function tableExists(db: Database, name: string): boolean {
    return Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
    );
}

function indexExists(db: Database, name: string): boolean {
    return Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name),
    );
}

function columns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
    );
}

describe("migration v43 — memory verification side table", () => {
    test("fresh database has memory_verifications and verify watermark columns", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(tableExists(db, "memory_verifications")).toBe(true);
            expect(indexExists(db, "idx_memory_verifications_memory")).toBe(true);
            expect(columns(db, "task_schedule_state")).toContain("last_checked_commit");
            expect(columns(db, "task_schedule_state")).toContain("last_broad_run_at");
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrade from v42 creates side table, index, and columns", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                PRAGMA foreign_keys=ON;
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (42, 'pre-v43 fixture', 1);
                CREATE TABLE memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    category TEXT NOT NULL,
                    content TEXT NOT NULL,
                    normalized_hash TEXT NOT NULL,
                    first_seen_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL
                );
                CREATE TABLE task_schedule_state (
                    project_path  TEXT    NOT NULL,
                    task          TEXT    NOT NULL,
                    last_run_at   INTEGER,
                    next_due_at   INTEGER,
                    schedule      TEXT,
                    last_status   TEXT,
                    last_error    TEXT,
                    retry_count   INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (project_path, task)
                );
            `);

            runMigrations(db);

            expect(tableExists(db, "memory_verifications")).toBe(true);
            expect(indexExists(db, "idx_memory_verifications_memory")).toBe(true);
            expect(columns(db, "task_schedule_state")).toContain("last_checked_commit");
            expect(columns(db, "task_schedule_state")).toContain("last_broad_run_at");
        } finally {
            closeQuietly(db);
        }
    });
});
