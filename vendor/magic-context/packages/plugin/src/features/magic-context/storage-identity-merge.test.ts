import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { auditIdentityMerge, mergeProjectIdentities } from "./storage-identity-merge";

let db: Database | null = null;

function makeDb(): Database {
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function insertMemory(
    database: Database,
    projectPath: string,
    content: string,
    hash: string,
): number {
    const result = database
        .prepare(
            `INSERT INTO memories
                (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?, 'CONSTRAINTS', ?, ?, 1, 1, 1, 1)`,
        )
        .run(projectPath, content, hash) as { lastInsertRowid?: number };
    return Number(result.lastInsertRowid);
}

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

describe("project identity merge", () => {
    test("dry-run audits schema-scoped tables without writing", () => {
        const database = makeDb();
        insertMemory(database, "dir:old", "old", "old-hash");
        database.prepare("INSERT INTO project_state(project_path) VALUES (?)").run("dir:old");

        const report = mergeProjectIdentities(database, "dir:old", "git:new", { dryRun: true });

        expect(report.dryRun).toBe(true);
        expect(report.auditedTables.map((table) => table.tableName)).toContain("memories");
        expect(report.auditedTables.map((table) => table.tableName)).toContain("project_state");
        expect(report.changedRows).toBe(2);
        expect(database.prepare("SELECT COUNT(*) AS count FROM identity_merge_log").get()).toEqual({
            count: 0,
        });
        expect(database.prepare("SELECT project_path FROM memories").get()).toEqual({
            project_path: "dir:old",
        });
    });

    test("rekeys audited rows, supersedes memory collisions, bumps epoch, and logs each mutation", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "dir:old", "legacy", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
        database
            .prepare("INSERT INTO project_state(project_path, project_memory_epoch) VALUES (?, 4)")
            .run("git:new");
        database
            .prepare(
                "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run("ses-old", "opencode", "dir:old", 1);
        database
            .prepare(
                "INSERT INTO git_commits(sha, project_path, short_sha, message, committed_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run("sha-old", "dir:old", "sha-old", "legacy commit", 1, 1);

        const report = mergeProjectIdentities(database, "dir:old", "git:new", { now: 10 });

        expect(report.changedRows).toBeGreaterThanOrEqual(4);
        expect(
            database
                .prepare(
                    "SELECT project_path, status, superseded_by_memory_id FROM memories WHERE id = ?",
                )
                .get(sourceId),
        ).toEqual({
            project_path: "dir:old",
            status: "archived",
            superseded_by_memory_id: targetId,
        });
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memories WHERE project_path = 'git:new'")
                .get(),
        ).toEqual({
            count: 1,
        });
        expect(
            database
                .prepare("SELECT project_path FROM session_projects WHERE session_id = 'ses-old'")
                .get(),
        ).toEqual({
            project_path: "git:new",
        });
        expect(
            database.prepare("SELECT project_path FROM git_commits WHERE sha = 'sha-old'").get(),
        ).toEqual({
            project_path: "git:new",
        });
        expect(
            database
                .prepare(
                    "SELECT project_memory_epoch FROM project_state WHERE project_path = 'git:new'",
                )
                .get(),
        ).toEqual({
            project_memory_epoch: 5,
        });
        expect(database.prepare("SELECT COUNT(*) AS count FROM identity_merge_log").get()).toEqual({
            count: report.changedRows,
        });
    });

    test("refuses a module-owned source pool before any mutation", () => {
        const database = makeDb();
        insertMemory(database, "dir:module", "memory", "module-hash");
        database
            .prepare(
                "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, ?, ?)",
            )
            .run("dir:module", "store", 1);

        expect(() => mergeProjectIdentities(database, "dir:module", "git:new")).toThrow(
            "managed by the Rust module",
        );
        expect(auditIdentityMerge(database, "dir:module", "git:new").changedRows).toBe(2);
        expect(database.prepare("SELECT project_path FROM memories").get()).toEqual({
            project_path: "dir:module",
        });
    });
});
