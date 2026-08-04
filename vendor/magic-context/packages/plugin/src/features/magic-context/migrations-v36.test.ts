import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

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

describe("migration v36 — session project ownership", () => {
    test("fresh DB schema includes session project ownership and schema fence version", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(tableColumns(db, "session_projects")).toEqual(
                expect.arrayContaining(["session_id", "harness", "project_path", "updated_at"]),
            );
            expect(indexNames(db)).toContain("idx_session_projects_project");
            // v36 introduced session_projects; assert the migration ran, not that
            // it's the latest (the schema-version-fence test owns the latest pin).
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(36);
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: LATEST_MIGRATION_VERSION });
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades a v35 database with the session ownership table", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (35, 'pre-v36 fixture', 1);
            `);

            runMigrations(db);

            expect(tableColumns(db, "session_projects")).toEqual(
                expect.arrayContaining(["session_id", "harness", "project_path", "updated_at"]),
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

    test("v36 seeds ownership for already-chunk-embedded sessions, skipping ambiguous ones", () => {
        const db = new Database(":memory:");
        try {
            // A v35 DB whose chunk-embedding table predates the ownership map.
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (35, 'pre-v36 fixture', 1);
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
                INSERT INTO compartments (id, session_id, sequence, start_message, end_message, title, content, created_at)
                VALUES
                    (1, 'sesA', 0, 1, 2, 'A1', 'content', 1),
                    (2, 'sesA', 1, 3, 4, 'A2', 'content', 1),
                    (3, 'sesB', 0, 1, 2, 'B1', 'content', 1),
                    (4, 'sesB', 1, 3, 4, 'B2', 'content', 1);
                CREATE TABLE compartment_chunk_embeddings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    project_path TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    window_index INTEGER NOT NULL,
                    start_ordinal INTEGER NOT NULL,
                    end_ordinal INTEGER NOT NULL,
                    chunk_hash TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    dims INTEGER NOT NULL,
                    vector BLOB NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(compartment_id, window_index)
                );
                -- clean single-project session (two windows, same project): seed it
                INSERT INTO compartment_chunk_embeddings (compartment_id, session_id, project_path, harness, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
                VALUES (1,'sesA','git:alpha','opencode',0,1,2,'h1','m',1,x'00',1);
                INSERT INTO compartment_chunk_embeddings (compartment_id, session_id, project_path, harness, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
                VALUES (1,'sesA','git:alpha','opencode',1,1,2,'h2','m',1,x'00',1);
                -- same session id under a DIFFERENT harness: independent ownership row
                INSERT INTO compartment_chunk_embeddings (compartment_id, session_id, project_path, harness, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
                VALUES (2,'sesA','git:beta','pi',0,3,4,'h3','m',1,x'00',1);
                -- ambiguous session (pre-scope bug split across two projects): skip
                INSERT INTO compartment_chunk_embeddings (compartment_id, session_id, project_path, harness, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
                VALUES (3,'sesB','git:gamma','opencode',0,1,2,'h4','m',1,x'00',1);
                INSERT INTO compartment_chunk_embeddings (compartment_id, session_id, project_path, harness, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
                VALUES (4,'sesB','git:delta','opencode',0,3,4,'h5','m',1,x'00',1);
            `);

            runMigrations(db);

            const rows = db
                .prepare(
                    "SELECT session_id, harness, project_path FROM session_projects ORDER BY session_id, harness",
                )
                .all();
            // sesA/opencode→alpha and sesA/pi→beta seeded; sesB skipped (ambiguous).
            expect(rows).toEqual([
                { session_id: "sesA", harness: "opencode", project_path: "git:alpha" },
                { session_id: "sesA", harness: "pi", project_path: "git:beta" },
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});
