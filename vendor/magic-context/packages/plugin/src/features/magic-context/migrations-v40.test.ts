/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function tagIndexes(db: Database): string[] {
    return (db.prepare("PRAGMA index_list(tags)").all() as Array<{ name: string }>).map(
        (index) => index.name,
    );
}

function fallbackOwnerPlanUsesIndex(db: Database): boolean {
    const plan = db
        .prepare(
            `EXPLAIN QUERY PLAN
             SELECT 1
             FROM tags
             WHERE session_id = ?
               AND type = 'tool'
               AND tool_owner_message_id LIKE 'pi-msg-%'
             LIMIT 1`,
        )
        .all("ses-1") as Array<{ detail: string }>;
    return plan.some((row) => row.detail.includes("idx_tags_pi_fallback_tool_owner"));
}

describe("migration v40 — Pi fallback tool owner index", () => {
    test("fresh database has the fallback-owner index used by the cheap gate", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(tagIndexes(db)).toContain("idx_tags_pi_fallback_tool_owner");
            expect(fallbackOwnerPlanUsesIndex(db)).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrade from v39 creates the fallback-owner index", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (39, 'pre-v40 fixture', 1);
                CREATE TABLE tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT,
                    message_id TEXT,
                    type TEXT,
                    tool_owner_message_id TEXT,
                    tag_number INTEGER
                );
            `);

            runMigrations(db);

            expect(tagIndexes(db)).toContain("idx_tags_pi_fallback_tool_owner");
            expect(fallbackOwnerPlanUsesIndex(db)).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });
});
