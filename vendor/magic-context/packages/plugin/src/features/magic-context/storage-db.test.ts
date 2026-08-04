/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    closeDatabase,
    isDatabasePersisted,
    openDatabase,
    resolveDatabasePath,
} from "./storage-db";
import { clearSession } from "./storage-meta-session";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function useTempDataHome(prefix: string): string {
    const dataHome = makeTempDir(prefix);
    process.env.XDG_DATA_HOME = dataHome;
    return dataHome;
}

function resolveDbPath(dataHome: string): string {
    // Plugin v0.16+ — shared cortexkit/magic-context path. See data-path.ts.
    return join(dataHome, "cortexkit", "magic-context", "context.db");
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows
        }
    }
    tempDirs.length = 0;
});

describe("storage-db", () => {
    describe("#given openDatabase", () => {
        it("#when called first time #then creates DB with WAL mode and busy_timeout", () => {
            const dataHome = useTempDataHome("storage-db-wal-");

            const db = openDatabase();

            const wal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
            const timeout = db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
            expect(wal.journal_mode.toLowerCase()).toBe("wal");
            expect(Object.values(timeout)[0]).toBe(5000);
            expect(existsSync(resolveDbPath(dataHome))).toBe(true);
            expect(isDatabasePersisted(db)).toBe(true);
        });

        it("#when called first time #then restricts storage dir to 0o700 and DB files to 0o600", () => {
            // POSIX-only: chmod is a no-op on Windows (modes are not honored).
            if (process.platform === "win32") return;
            const dataHome = useTempDataHome("storage-db-perms-");

            openDatabase();

            const dbPath = resolveDbPath(dataHome);
            const dbDir = dirname(dbPath);
            // Low 9 permission bits only (mask off file-type/setuid bits).
            expect(statSync(dbDir).mode & 0o777).toBe(0o700);
            expect(statSync(dbPath).mode & 0o777).toBe(0o600);
            for (const suffix of ["-wal", "-shm"]) {
                const sidecar = `${dbPath}${suffix}`;
                if (existsSync(sidecar)) {
                    expect(statSync(sidecar).mode & 0o777).toBe(0o600);
                }
            }
        });

        it("#when called first time #then creates required tables", () => {
            useTempDataHome("storage-db-tables-");

            const db = openDatabase();

            const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all() as Array<{ name: string }>;
            const tableNames = tables.map((t) => t.name);
            expect(tableNames).toEqual(
                expect.arrayContaining([
                    "tags",
                    "pending_ops",
                    "source_contents",
                    "compression_depth",
                    "session_meta",
                ]),
            );
        });

        it("#when clearSession runs #then every session-scoped table is emptied", () => {
            // Discover the contract from schema shape instead of maintaining a
            // second table list. Any new table with session_id is seeded here and
            // must be cleared by clearSession, so lifecycle omissions fail loudly.
            useTempDataHome("storage-db-clearsession-");
            const db = openDatabase();
            const sessionId = "ses_clearsession_fresh";
            const tableNames = (
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                    )
                    .all() as Array<{ name: string }>
            )
                .map((row) => row.name)
                .filter((table) => {
                    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                        name: string;
                    }>;
                    return columns.some((column) => column.name === "session_id");
                });

            db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
            for (const table of tableNames) {
                const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                    name: string;
                    type: string;
                    notnull: number;
                    dflt_value: string | null;
                    pk: number;
                }>;
                const insertedColumns = columns.filter(
                    (column) =>
                        column.name === "session_id" ||
                        (column.dflt_value === null &&
                            (column.notnull === 1 ||
                                (column.pk > 0 && column.type.toUpperCase() !== "INTEGER"))),
                );
                const values = insertedColumns.map((column) => {
                    if (column.name === "session_id") return sessionId;
                    const type = column.type.toUpperCase();
                    if (type.includes("INT") || type.includes("REAL")) return 1;
                    if (type.includes("BLOB")) return new Uint8Array([1]);
                    return "seed";
                });
                const placeholders = insertedColumns.map(() => "?").join(", ");
                db.prepare(
                    `INSERT INTO ${table} (${insertedColumns.map((column) => column.name).join(", ")}) VALUES (${placeholders})`,
                ).run(...values);
                expect(
                    db
                        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
                        .get(sessionId),
                ).toEqual({ count: 1 });
            }
            db.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");

            clearSession(db, sessionId);

            for (const table of tableNames) {
                expect(
                    db
                        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
                        .get(sessionId),
                    `${table} retained session-scoped rows`,
                ).toEqual({ count: 0 });
            }
        });

        it("#when called first time #then creates required session-scoped indexes", () => {
            useTempDataHome("storage-db-indexes-");

            const db = openDatabase();
            const indexes = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
                .all() as Array<{ name: string }>;
            const indexNames = indexes.map((item) => item.name);

            expect(indexNames).toEqual(
                expect.arrayContaining([
                    "idx_tags_session_tag_number",
                    "idx_pending_ops_session",
                    "idx_source_contents_session",
                    "idx_compartments_session",
                    "idx_compression_depth_session",
                    "idx_session_facts_session",
                    "idx_notes_session_status",
                    "idx_notes_project_status",
                    "idx_notes_type_status",
                ]),
            );
        });

        it("#when called a second time #then returns cached instance (singleton)", () => {
            useTempDataHome("storage-db-cached-");

            const db1 = openDatabase();
            const db2 = openDatabase();

            expect(db1).toBe(db2);
        });

        it("#when file path setup fails #then throws so callers fail closed (no in-memory fallback)", () => {
            const dataHome = useTempDataHome("storage-db-fallback-");
            // Block mkdirSync by planting a file at the cortexkit segment of
            // the new shared path. See storage.test.ts for the same pattern.
            writeFileSync(join(dataHome, "cortexkit"), "not-a-directory", "utf-8");

            // Failing closed is intentional. Falling back to :memory: silently
            // disables persistent state (memories, historian compartments,
            // tags) but keeps the transform running, which on Pi/OpenCode can
            // let the full raw history reach the model and overflow context.
            // Callers must catch this and disable Magic Context for the run.
            expect(() => openDatabase()).toThrow(/storage unavailable/i);
        });

        it("#when an existing session_meta table lacks compartment_in_progress #then openDatabase adds the missing column", () => {
            const dataHome = useTempDataHome("storage-db-migrate-compartment-flag-");
            const dbPath = resolveDbPath(dataHome);
            mkdirSync(join(dataHome, "cortexkit", "magic-context"), {
                recursive: true,
            });
            const legacyDb = new Database(dbPath);
            legacyDb.run(`
        CREATE TABLE session_meta (
          session_id TEXT PRIMARY KEY,
          last_response_time INTEGER,
          cache_ttl TEXT,
          counter INTEGER DEFAULT 0,
          last_nudge_tokens INTEGER DEFAULT 0,
          last_nudge_band TEXT DEFAULT '',
          last_transform_error TEXT DEFAULT '',
          nudge_anchor_message_id TEXT DEFAULT '',
          nudge_anchor_text TEXT DEFAULT '',
          sticky_turn_reminder_text TEXT DEFAULT '',
          sticky_turn_reminder_message_id TEXT DEFAULT '',
          is_subagent INTEGER DEFAULT 0,
          last_context_percentage REAL DEFAULT 0,
          last_input_tokens INTEGER DEFAULT 0,
          observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_alert_sent INTEGER NOT NULL DEFAULT 0,
          times_execute_threshold_reached INTEGER DEFAULT 0,
          historian_failure_count INTEGER DEFAULT 0,
          historian_last_error TEXT DEFAULT NULL,
          historian_last_failure_at INTEGER DEFAULT NULL,
          cleared_reasoning_through_tag INTEGER DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
      `);
            closeQuietly(legacyDb);

            const db = openDatabase();
            const columns = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;

            expect(columns.map((column) => column.name)).toEqual(
                expect.arrayContaining([
                    "compartment_in_progress",
                    "historian_failure_count",
                    "historian_last_error",
                    "historian_last_failure_at",
                ]),
            );
        });

        it("#when an existing memory_embeddings table lacks model_id #then openDatabase adds the missing column", () => {
            const dataHome = useTempDataHome("storage-db-migrate-embedding-model-");
            const dbPath = resolveDbPath(dataHome);
            mkdirSync(join(dataHome, "cortexkit", "magic-context"), {
                recursive: true,
            });
            const legacyDb = new Database(dbPath);
            legacyDb.run(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          normalized_hash TEXT NOT NULL,
          source_session_id TEXT,
          source_type TEXT DEFAULT 'historian',
          seen_count INTEGER DEFAULT 1,
          retrieval_count INTEGER DEFAULT 0,
          first_seen_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          last_retrieved_at INTEGER,
          status TEXT DEFAULT 'active',
          expires_at INTEGER,
          verification_status TEXT DEFAULT 'unverified',
          verified_at INTEGER,
          superseded_by_memory_id INTEGER,
          merged_from TEXT,
          metadata_json TEXT,
          UNIQUE(project_path, category, normalized_hash)
        );

        CREATE TABLE memory_embeddings (
          memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL
        );
      `);
            closeQuietly(legacyDb);

            const db = openDatabase();
            const columns = db.prepare("PRAGMA table_info(memory_embeddings)").all() as Array<{
                name?: string;
            }>;

            expect(columns.map((column) => column.name)).toContain("model_id");
        });
    });

    describe("#given closeDatabase", () => {
        it("#when called after openDatabase #then clears the cached instance", () => {
            useTempDataHome("storage-db-close-");

            const db1 = openDatabase();
            closeDatabase();
            const db2 = openDatabase();

            expect(db1).not.toBe(db2);
        });

        it("#when called multiple times #then does not throw", () => {
            useTempDataHome("storage-db-multi-close-");

            openDatabase();
            expect(() => closeDatabase()).not.toThrow();
            expect(() => closeDatabase()).not.toThrow();
            expect(() => closeDatabase()).not.toThrow();
        });

        it("#when called without prior open #then does not throw", () => {
            expect(() => closeDatabase()).not.toThrow();
        });
    });

    // Regression guard for the 2026-06-01 (v26) / 2026-06-19 (v41) incidents:
    // a `bun test` run from a CWD whose bunfig lacks `[test] preload` ran the
    // package suites with NO isolation, so a bare openDatabase() migrated the
    // user's REAL shared DB. The NODE_ENV=test backstop in resolveDatabasePath
    // makes that structurally impossible from ANY CWD.
    describe("#given the test-isolation backstop", () => {
        const realStorageRoot = join(homedir(), ".local", "share", "cortexkit");

        it("#when NODE_ENV=test and XDG_DATA_HOME unset #then never resolves to the real shared DB", () => {
            // Simulate an UNISOLATED run: no preload-set vars at all.
            const savedXdg = process.env.XDG_DATA_HOME;
            const savedTestDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            process.env.NODE_ENV = "test";
            delete process.env.XDG_DATA_HOME;
            delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            try {
                const { dbPath } = resolveDatabasePath();
                expect(dbPath.startsWith(realStorageRoot)).toBe(false);
                expect(dbPath.includes("mc-test-db-backstop-")).toBe(true);
            } finally {
                if (savedXdg !== undefined) process.env.XDG_DATA_HOME = savedXdg;
                if (savedTestDir !== undefined)
                    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = savedTestDir;
            }
        });

        it("#when a test sets its own XDG_DATA_HOME #then that controlled dir is honored", () => {
            const dataHome = useTempDataHome("storage-db-backstop-xdg-");
            const { dbPath } = resolveDatabasePath();
            expect(dbPath).toBe(resolveDbPath(dataHome));
        });

        it("#then every test package wires the isolation preload (root + plugin + pi-plugin + cli)", () => {
            // Structural guard: a new test package that forgets its bunfig
            // `[test] preload` is the exact hole that caused both incidents.
            const repoRoot = join(__dirname, "..", "..", "..", "..", "..");
            const bunfigs = [
                "bunfig.toml",
                "packages/plugin/bunfig.toml",
                "packages/pi-plugin/bunfig.toml",
                "packages/cli/bunfig.toml",
            ];
            for (const rel of bunfigs) {
                const full = join(repoRoot, rel);
                expect(existsSync(full)).toBe(true);
                const body = readFileSync(full, "utf8");
                expect(body.includes("[test]")).toBe(true);
                expect(body.includes("preload")).toBe(true);
                expect(body.includes("test-preload.ts")).toBe(true);
            }
        });
    });
});
