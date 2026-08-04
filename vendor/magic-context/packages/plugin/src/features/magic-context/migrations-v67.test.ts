/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { clearSession, getOrCreateSessionMeta } from "./storage-meta-session";
import { clearCachedM0M1, persistCachedM0 } from "./storage-meta-shared";

function columnNames(db: Database, table: string): Set<string> {
    return new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (column) => column.name,
        ),
    );
}

function seedAppliedVersion(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    for (let current = 1; current <= version; current += 1) {
        db.prepare(
            "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
        ).run(current, `seed v${current}`, 0);
    }
}

describe("migration v67: cached m0 mural payload", () => {
    test("adds the frozen mural columns to a legacy session_meta table", () => {
        const db = new Database(":memory:");
        try {
            db.exec("CREATE TABLE session_meta (session_id TEXT PRIMARY KEY)");
            db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-legacy");
            seedAppliedVersion(db, 66);

            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            const columns = columnNames(db, "session_meta");
            expect(columns.has("cached_m0_mural_data_url")).toBe(true);
            expect(columns.has("cached_m0_mural_hash")).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("round-trips and clears the mural payload with its cached baseline", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const sessionId = "ses-mural-cache";
            persistCachedM0(db, sessionId, {
                m0Bytes: Buffer.from("cached m0"),
                muralDataUrl: "data:image/png;base64,ZmFrZQ==",
                muralHash: "frozen-hash",
                projectMemoryEpoch: 0,
                projectUserProfileVersion: 0,
                maxCompartmentSeq: 0,
                maxMemoryId: 0,
                maxMutationId: 0,
                maxMemoryMutationId: 0,
                m1Bytes: Buffer.from("cached m1"),
                projectDocsHash: "",
                materializedAt: 1,
                sessionFactsVersion: 0,
                upgradeState: null,
            });

            const persisted = getOrCreateSessionMeta(db, sessionId);
            expect(persisted.cachedM0MuralDataUrl).toBe("data:image/png;base64,ZmFrZQ==");
            expect(persisted.cachedM0MuralHash).toBe("frozen-hash");

            clearCachedM0M1(db, sessionId);
            const cleared = getOrCreateSessionMeta(db, sessionId);
            expect(cleared.cachedM0Bytes).toBeNull();
            expect(cleared.cachedM0MuralDataUrl).toBeNull();
            expect(cleared.cachedM0MuralHash).toBeNull();

            clearSession(db, sessionId);
            expect(
                db
                    .prepare("SELECT session_id FROM session_meta WHERE session_id = ?")
                    .get(sessionId),
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
