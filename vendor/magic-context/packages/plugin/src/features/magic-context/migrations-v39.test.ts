/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function columnNames(db: Database): string[] {
    return (db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v39 — compaction marker target end message id", () => {
    test("fresh database has nullable compaction_marker_target_end_message_id column", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db)).toContain("compaction_marker_target_end_message_id");
            db.prepare("INSERT INTO session_meta (session_id) VALUES ('ses-1')").run();
            const row = db
                .prepare(
                    "SELECT compaction_marker_target_end_message_id FROM session_meta WHERE session_id = 'ses-1'",
                )
                .get() as { compaction_marker_target_end_message_id: string | null };
            expect(row.compaction_marker_target_end_message_id).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrade adds column and backfills JSON targetEndMessageId when present", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (38, 'pre-v39 fixture', 1);
                CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY,
                    compaction_marker_state TEXT DEFAULT ''
                );
                INSERT INTO session_meta (session_id, compaction_marker_state) VALUES (
                    'ses-json',
                    '{"boundaryMessageId":"msg-user","summaryMessageId":"msg-summary","compactionPartId":"prt-comp","summaryPartId":"prt-summary","boundaryOrdinal":10,"targetEndMessageId":"msg-target"}'
                );
                INSERT INTO session_meta (session_id, compaction_marker_state) VALUES (
                    'ses-legacy',
                    '{"boundaryMessageId":"msg-user","summaryMessageId":"msg-summary","compactionPartId":"prt-comp","summaryPartId":"prt-summary","boundaryOrdinal":10}'
                );
            `);

            runMigrations(db);
            runMigrations(db);

            expect(columnNames(db)).toContain("compaction_marker_target_end_message_id");
            const rows = db
                .prepare(
                    "SELECT session_id, compaction_marker_target_end_message_id FROM session_meta ORDER BY session_id",
                )
                .all() as Array<{
                session_id: string;
                compaction_marker_target_end_message_id: string | null;
            }>;
            expect(rows).toEqual([
                { session_id: "ses-json", compaction_marker_target_end_message_id: "msg-target" },
                { session_id: "ses-legacy", compaction_marker_target_end_message_id: null },
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});
