/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function columns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
    );
}

describe("migration v60: live memory resnapshot ownership", () => {
    test("creates the owner-generation column and keeps the schema fence aligned", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(columns(db, "mirror_resnapshot_state")).toContain("generation");
            expect(
                db.prepare("SELECT status, generation FROM mirror_resnapshot_state").get(),
            ).toEqual({ status: "pending_check", generation: null });
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades v59 state without disturbing staged rows", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.prepare(
                "UPDATE mirror_resnapshot_state SET status = 'resnapshotting' WHERE domain = 'memories'",
            ).run();
            db.prepare(
                "INSERT INTO mirror_live_staging VALUES ('abandoned', 'project', 1, 'CONSTRAINTS', 'hash', NULL)",
            ).run();
            db.exec(`
                ALTER TABLE mirror_resnapshot_state DROP COLUMN generation;
                DELETE FROM schema_migrations WHERE version >= 60;
            `);

            runMigrations(db);

            expect(
                db.prepare("SELECT status, generation FROM mirror_resnapshot_state").get(),
            ).toEqual({ status: "resnapshotting", generation: null });
            expect(db.prepare("SELECT generation FROM mirror_live_staging").get()).toEqual({
                generation: "abandoned",
            });
        } finally {
            closeQuietly(db);
        }
    });
});

test("v60 heals a database whose v58 ran before the resnapshot table existed", () => {
    // Shipped-migration edit shape: version 58 is recorded but the table was never
    // created because the recorded run used the original v58 body.
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        runMigrations(db);
        db.exec("DROP TABLE mirror_resnapshot_state");
        db.prepare("DELETE FROM schema_migrations WHERE version >= 60").run();
        runMigrations(db);
        const row = db
            .prepare(
                "SELECT status, generation FROM mirror_resnapshot_state WHERE domain = 'memories'",
            )
            .get() as { status: string; generation: string | null };
        expect(row.status).toBe("pending_check");
        expect(row.generation).toBeNull();
    } finally {
        closeQuietly(db);
    }
});
