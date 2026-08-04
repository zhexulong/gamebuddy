import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function tableColumns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function indexNames(db: Database): string[] {
    return (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
            name: string;
        }>
    ).map((row) => row.name);
}

describe("migration v33 — compartment chunk embeddings", () => {
    test("fresh DB schema includes compartment_chunk_embeddings", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(tableColumns(db, "compartment_chunk_embeddings")).toEqual(
                expect.arrayContaining([
                    "id",
                    "compartment_id",
                    "session_id",
                    "project_path",
                    "harness",
                    "window_index",
                    "start_ordinal",
                    "end_ordinal",
                    "chunk_hash",
                    "model_id",
                    "dims",
                    "vector",
                    "created_at",
                ]),
            );
            expect(indexNames(db)).toEqual(
                expect.arrayContaining(["idx_cce_session", "idx_cce_project_model"]),
            );
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: LATEST_MIGRATION_VERSION });
        } finally {
            closeQuietly(db);
        }
    });

    test("migrated DB creates table, indexes, unique window constraint, and cascade", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                PRAGMA foreign_keys=ON;
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (32, 'pre-v33 fixture', 1);
                CREATE TABLE compartments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    start_message INTEGER NOT NULL,
                    end_message INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(session_id, sequence)
                );
                INSERT INTO compartments (session_id, sequence, start_message, end_message, title, content, created_at)
                VALUES ('ses-v33', 0, 1, 2, 'First', 'content', 10);
            `);

            runMigrations(db);
            runMigrations(db);

            const compartmentId = (
                db.prepare("SELECT id FROM compartments").get() as { id: number }
            ).id;
            const vector = new Uint8Array(new Float32Array([1, 0]).buffer);
            db.prepare(
                `INSERT INTO compartment_chunk_embeddings
                 (compartment_id, session_id, project_path, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
                 VALUES (?, 'ses-v33', '/repo', 0, 1, 2, 'h1', 'm1', 2, ?, 20)`,
            ).run(compartmentId, vector);

            expect(() =>
                db
                    .prepare(
                        `INSERT INTO compartment_chunk_embeddings
                     (compartment_id, session_id, project_path, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
                     VALUES (?, 'ses-v33', '/repo', 0, 1, 2, 'h2', 'm1', 2, ?, 21)`,
                    )
                    .run(compartmentId, vector),
            ).toThrow();

            db.prepare("DELETE FROM compartments WHERE id = ?").run(compartmentId);
            expect(
                db.prepare("SELECT COUNT(*) AS count FROM compartment_chunk_embeddings").get(),
            ).toEqual({ count: 0 });
        } finally {
            closeQuietly(db);
        }
    });
});
