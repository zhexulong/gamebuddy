/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { clearSession } from "./storage-meta-session";

function tableExists(db: Database, table: string): boolean {
    return Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    );
}

describe("migration v53: Synapse embedding storage", () => {
    test("fresh schema creates durable batch and measurement tables", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(tableExists(db, "embedding_registrations")).toBe(true);
            expect(tableExists(db, "synapse_batch_ledger")).toBe(true);
            expect(tableExists(db, "shadow_embedding_registrations")).toBe(true);
            expect(tableExists(db, "embedding_measurement_corpus")).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("migrates a v52 database and clearSession removes session rows", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.exec(`
                DROP TABLE embedding_measurement_corpus;
                DROP TABLE shadow_embedding_registrations;
                DROP TABLE synapse_batch_ledger;
                DELETE FROM schema_migrations WHERE version >= 53;
            `);
            runMigrations(db);
            db.prepare(
                "INSERT INTO synapse_batch_ledger (session_id, request_key) VALUES (?, ?)",
            ).run("ses-v53", "request-1");
            db.prepare(
                "INSERT INTO embedding_measurement_corpus (session_id, dedup_key, cohort_key) VALUES (?, ?, ?)",
            ).run("ses-v53", "query-1", "cohort-1");

            clearSession(db, "ses-v53");

            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM synapse_batch_ledger WHERE session_id = ?",
                    )
                    .get("ses-v53"),
            ).toEqual({ count: 0 });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM embedding_measurement_corpus WHERE session_id = ?",
                    )
                    .get("ses-v53"),
            ).toEqual({ count: 0 });
        } finally {
            closeQuietly(db);
        }
    });
});
