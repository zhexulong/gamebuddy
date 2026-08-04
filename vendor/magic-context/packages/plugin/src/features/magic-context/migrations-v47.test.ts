/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
    );
}

describe("migration v47 — compiled smart-note checks", () => {
    test("fresh database has smart-note check columns", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(columnNames(db, "notes")).toEqual(
                expect.arrayContaining([
                    "compiled_check",
                    "manifest_json",
                    "check_hash",
                    "check_cron",
                    "check_status",
                    "check_failure_count",
                    "check_network_failure_count",
                    "check_quarantined_until",
                    "check_next_due_at",
                    "check_compiled_at",
                    "policy_version",
                ]),
            );
        } finally {
            closeQuietly(db);
        }
    });
});
