/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function columnNames(db: Database, table: string): Set<string> {
    return new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (column) => column.name,
        ),
    );
}

/** Mark migrations up to `version` as already applied so only the newer ones
 *  run — lets an upgrade test start from a hand-built pre-v65 schema without
 *  replaying every prior migration (which needs tables the stub omits). */
function seedAppliedVersion(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    for (let v = 1; v <= version; v++) {
        db.prepare(
            "INSERT OR IGNORE INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
        ).run(v, `seed v${v}`, Date.now());
    }
}

describe("migration v65: per-memory mural cue columns", () => {
    test("fresh DB carries the three mural cue columns and keeps the fence aligned", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            const names = columnNames(db, "memories");
            expect(names.has("mural_cue")).toBe(true);
            expect(names.has("mural_cue_hash")).toBe(true);
            expect(names.has("mural_cue_at")).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades a pre-v65 memories table by adding the cue columns", () => {
        const db = new Database(":memory:");
        try {
            // A minimal pre-v65 memories table WITHOUT the cue columns, as an
            // upgraded install would have before the migration runs. Seed the
            // applied version to 64 so only v65's up() runs against this stub.
            db.exec(`
                CREATE TABLE memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    category TEXT NOT NULL,
                    content TEXT NOT NULL,
                    normalized_hash TEXT NOT NULL,
                    importance INTEGER,
                    first_seen_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL
                );
            `);
            seedAppliedVersion(db, 64);
            expect(columnNames(db, "memories").has("mural_cue")).toBe(false);

            runMigrations(db);

            const after = columnNames(db, "memories");
            expect(after.has("mural_cue")).toBe(true);
            expect(after.has("mural_cue_hash")).toBe(true);
            expect(after.has("mural_cue_at")).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("v65 is a no-op when the memories table is absent", () => {
        const db = new Database(":memory:");
        try {
            // Seed to 64 so ONLY v65 is pending; a sparse DB may lack the memories
            // table, and v65 must skip rather than throw.
            seedAppliedVersion(db, 64);
            expect(() => runMigrations(db)).not.toThrow();
        } finally {
            closeQuietly(db);
        }
    });
});

describe("migration v66: bounded upgrade reminders", () => {
    test("upgrades session metadata with cooldown and cap fields", () => {
        const db = new Database(":memory:");
        try {
            db.exec("CREATE TABLE session_meta (session_id TEXT PRIMARY KEY)");
            db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-legacy");
            seedAppliedVersion(db, 65);

            runMigrations(db);

            const names = columnNames(db, "session_meta");
            expect(names.has("upgrade_reminder_last_sent_at")).toBe(true);
            expect(names.has("upgrade_reminder_count")).toBe(true);
            expect(
                db
                    .prepare("SELECT upgrade_reminder_count FROM session_meta WHERE session_id = ?")
                    .get("ses-legacy"),
            ).toEqual({ upgrade_reminder_count: 0 });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("migration v75: mural cue rejection latches", () => {
    test("fresh DB carries the durable rejection counter", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(columnNames(db, "memories")).toContain("mural_cue_rejection_count");
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades an existing memories table without changing cue state", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mural_cue TEXT,
                    mural_cue_hash TEXT,
                    mural_cue_at INTEGER
                );
                INSERT INTO memories (mural_cue, mural_cue_hash, mural_cue_at)
                VALUES ('existing cue', 'existing hash', 123);
            `);
            seedAppliedVersion(db, 74);

            runMigrations(db);

            expect(columnNames(db, "memories")).toContain("mural_cue_rejection_count");
            expect(
                db
                    .prepare(
                        "SELECT mural_cue, mural_cue_hash, mural_cue_at, mural_cue_rejection_count FROM memories",
                    )
                    .get(),
            ).toEqual({
                mural_cue: "existing cue",
                mural_cue_hash: "existing hash",
                mural_cue_at: 123,
                mural_cue_rejection_count: 0,
            });
        } finally {
            closeQuietly(db);
        }
    });
});
