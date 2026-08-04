/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function tableExists(db: Database, table: string): boolean {
    return Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    );
}

describe("migration v59: live memory resnapshot staging", () => {
    test("creates the generation-keyed staging table and keeps the schema fence aligned", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(tableExists(db, "mirror_live_staging")).toBe(true);
            expect(db.prepare("SELECT status FROM mirror_resnapshot_state").get()).toEqual({
                status: "pending_check",
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades a v58 database without disturbing the live snapshot", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.prepare(
                "INSERT INTO mirror_live_memory_rows VALUES ('project', 1, 'CONSTRAINTS', 'hash', NULL)",
            ).run();
            db.exec(`
                DROP TABLE mirror_live_staging;
                DELETE FROM schema_migrations WHERE version >= 59;
            `);

            runMigrations(db);

            expect(tableExists(db, "mirror_live_staging")).toBe(true);
            expect(db.prepare("SELECT module_project FROM mirror_live_memory_rows").get()).toEqual({
                module_project: "project",
            });
        } finally {
            closeQuietly(db);
        }
    });
});
