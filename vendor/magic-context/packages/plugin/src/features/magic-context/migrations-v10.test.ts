/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    adoptNullOwnerToolTag,
    deleteTagsByMessageId,
    deleteToolTagsByOwner,
    getNullOwnerToolTag,
    getTagsBySession,
    getToolTagNumberByOwner,
    insertTag,
} from "./storage-tags";

/**
 * Schema migration v10 tests.
 *
 * Verifies the new `tool_owner_message_id` column, the partial UNIQUE
 * index that prevents composite-identity duplicates, and the lookup
 * index that backs the lazy-adoption fallback path.
 *
 * Plan v3.3.1 §"Schema migration v10".
 */
describe("schema migration v10", () => {
    test("adds tool_owner_message_id column with NULL default", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);

        const cols = db.prepare("PRAGMA table_info(tags)").all() as Array<{
            name: string;
            dflt_value: string | null;
            type: string;
        }>;
        const owner = cols.find((c) => c.name === "tool_owner_message_id");
        expect(owner).toBeDefined();
        expect(owner?.type).toBe("TEXT");
        // SQLite stores DEFAULT NULL as null in PRAGMA output.
        expect(owner?.dflt_value === null || owner?.dflt_value === "NULL").toBe(true);

        closeQuietly(db);
    });

    test("creates partial UNIQUE index for composite identity", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);

        const idx = db
            .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
            .get("idx_tags_tool_composite") as { sql: string } | undefined;
        expect(idx).toBeDefined();
        expect(idx?.sql).toContain("UNIQUE");
        expect(idx?.sql).toContain("tool_owner_message_id");
        expect(idx?.sql.toLowerCase()).toContain("type = 'tool'");
        expect(idx?.sql.toLowerCase()).toContain("tool_owner_message_id is not null");

        closeQuietly(db);
    });

    test("creates partial lookup index for NULL-owner lazy adoption", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);

        const idx = db
            .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
            .get("idx_tags_tool_null_owner") as { sql: string } | undefined;
        expect(idx).toBeDefined();
        expect(idx?.sql.toLowerCase()).toContain("type = 'tool'");
        expect(idx?.sql.toLowerCase()).toContain("tool_owner_message_id is null");

        closeQuietly(db);
    });

    test("partial UNIQUE prevents duplicate composite identity", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);

        // First insert with composite identity (callId='read:32', owner='msg-A').
        insertTag(db, "ses-1", "read:32", "tool", 100, 1, 0, "read", 0, "msg-A");

        // Second insert with the SAME composite identity must fail with
        // a UNIQUE constraint error.
        expect(() =>
            insertTag(db, "ses-1", "read:32", "tool", 100, 2, 0, "read", 0, "msg-A"),
        ).toThrow();

        closeQuietly(db);
    });

    test("partial UNIQUE allows different owners for same callId", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);

        // Two tools with the SAME callID but DIFFERENT owners must both
        // succeed — that's exactly the case the v10 fix exists to support.
        insertTag(db, "ses-1", "read:32", "tool", 100, 1, 0, "read", 0, "msg-A");
        insertTag(db, "ses-1", "read:32", "tool", 100, 2, 0, "read", 0, "msg-B");

        const tags = getTagsBySession(db, "ses-1");
        expect(tags).toHaveLength(2);
        expect(tags.map((t) => t.toolOwnerMessageId).sort()).toEqual(["msg-A", "msg-B"]);

        closeQuietly(db);
    });

    test("partial UNIQUE does not match NULL-owner rows", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);

        // Two NULL-owner rows for the same callID must be allowed —
        // they're legacy orphans from before v10. The partial UNIQUE
        // explicitly excludes NULL-owner rows so a fresh insert never
        // collides with them.
        insertTag(db, "ses-1", "read:32", "tool", 100, 1);
        insertTag(db, "ses-1", "read:32", "tool", 100, 2);

        const tags = getTagsBySession(db, "ses-1");
        expect(tags).toHaveLength(2);
        expect(tags.every((t) => t.toolOwnerMessageId === null)).toBe(true);

        closeQuietly(db);
    });

    test("idempotent: re-running migration does not rebuild column or indexes", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);

        const initial = db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as {
            v: number;
        };
        expect(initial.v).toBeGreaterThanOrEqual(10);

        // Second run is a no-op (no pending migrations).
        runMigrations(db);
        const after = db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as {
            v: number;
        };
        expect(after.v).toBe(initial.v);

        closeQuietly(db);
    });

    test("v9 → v10 upgrade path: existing rows remain readable", () => {
        // Simulate an upgrade from v9 to v10. Stand up a DB at v9 with a
        // tool tag, then run migrations to bring it to v10 and verify the
        // existing row is still readable and reports tool_owner_message_id
        // as null.
        const db = new Database(":memory:");
        initializeDatabase(db);
        // Roll forward only to v9, then preinsert a tag and run the
        // remaining migrations.
        db.exec(`
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            )
        `);
        for (let v = 1; v <= 9; v++) {
            db.prepare(
                "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
            ).run(v, `pre-v10 baseline v${v}`, Date.now());
        }
        // Insert via raw SQL — simulating an old plugin version's INSERT
        // shape (no tool_owner_message_id column yet, which is the
        // pre-v10 reality).
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, ?, ?, ?)",
        ).run("ses-old", "read:5", "tool", 100, 5);

        runMigrations(db);

        const tags = getTagsBySession(db, "ses-old");
        expect(tags).toHaveLength(1);
        expect(tags[0].toolOwnerMessageId).toBeNull();

        closeQuietly(db);
    });
});

describe("storage-tags v10 helpers", () => {
    function freshDb(): Database {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        return db;
    }

    test("getToolTagNumberByOwner returns the tag with matching composite identity", () => {
        const db = freshDb();
        insertTag(db, "ses-1", "read:32", "tool", 100, 1, 0, "read", 0, "msg-A");
        insertTag(db, "ses-1", "read:32", "tool", 100, 2, 0, "read", 0, "msg-B");

        expect(getToolTagNumberByOwner(db, "ses-1", "read:32", "msg-A")).toBe(1);
        expect(getToolTagNumberByOwner(db, "ses-1", "read:32", "msg-B")).toBe(2);
        expect(getToolTagNumberByOwner(db, "ses-1", "read:32", "msg-C")).toBeNull();

        closeQuietly(db);
    });

    test("getNullOwnerToolTag finds a NULL-owner row and skips owned ones", () => {
        const db = freshDb();
        insertTag(db, "ses-1", "read:32", "tool", 100, 1); // NULL owner
        insertTag(db, "ses-1", "read:32", "tool", 100, 2, 0, "read", 0, "msg-B"); // has owner

        const orphan = getNullOwnerToolTag(db, "ses-1", "read:32");
        expect(orphan).not.toBeNull();
        expect(orphan?.tagNumber).toBe(1);
        // Sanity: only the NULL-owner row was selected.
        const tags = getTagsBySession(db, "ses-1");
        const ownedTag = tags.find((t) => t.tagNumber === 2);
        expect(ownedTag?.toolOwnerMessageId).toBe("msg-B");

        closeQuietly(db);
    });

    test("getNullOwnerToolTag returns null when no orphan exists", () => {
        const db = freshDb();
        insertTag(db, "ses-1", "read:32", "tool", 100, 1, 0, "read", 0, "msg-A");

        expect(getNullOwnerToolTag(db, "ses-1", "read:32")).toBeNull();
        expect(getNullOwnerToolTag(db, "ses-1", "missing-callid")).toBeNull();

        closeQuietly(db);
    });

    test("adoptNullOwnerToolTag: first claim wins, NULL guard rejects second", () => {
        const db = freshDb();
        insertTag(db, "ses-1", "read:32", "tool", 100, 1); // NULL owner
        const orphan = getNullOwnerToolTag(db, "ses-1", "read:32");
        expect(orphan).not.toBeNull();

        // First adoption succeeds.
        const won = adoptNullOwnerToolTag(db, orphan!.id, "msg-A");
        expect(won).toBe(true);

        // Second adoption on the same row must fail (NULL guard).
        const lost = adoptNullOwnerToolTag(db, orphan!.id, "msg-B");
        expect(lost).toBe(false);

        // Owner is now msg-A.
        const tags = getTagsBySession(db, "ses-1");
        expect(tags[0].toolOwnerMessageId).toBe("msg-A");

        closeQuietly(db);
    });

    test("deleteToolTagsByOwner removes only owner-scoped rows", () => {
        const db = freshDb();
        insertTag(db, "ses-1", "read:32", "tool", 100, 1, 0, "read", 0, "msg-A");
        insertTag(db, "ses-1", "read:32", "tool", 100, 2, 0, "read", 0, "msg-B");
        insertTag(db, "ses-1", "grep:5", "tool", 100, 3, 0, "grep", 0, "msg-A");
        insertTag(db, "ses-1", "msg-A", "message", 100, 4); // not a tool tag

        const removed = deleteToolTagsByOwner(db, "ses-1", "msg-A");
        expect(removed).toBe(2); // read:32@msg-A and grep:5@msg-A

        const remaining = getTagsBySession(db, "ses-1");
        expect(remaining).toHaveLength(2);
        // The msg-B tool tag and the message tag survive.
        expect(remaining.find((t) => t.tagNumber === 2)?.toolOwnerMessageId).toBe("msg-B");
        expect(remaining.find((t) => t.tagNumber === 4)?.type).toBe("message");

        closeQuietly(db);
    });

    test("deleteToolTagsByOwner does not match NULL-owner legacy rows", () => {
        const db = freshDb();
        insertTag(db, "ses-1", "read:32", "tool", 100, 1); // NULL owner
        insertTag(db, "ses-1", "read:32", "tool", 100, 2, 0, "read", 0, "msg-A");

        const removed = deleteToolTagsByOwner(db, "ses-1", "msg-A");
        expect(removed).toBe(1);

        // NULL-owner orphan survives — owner-scoped deletion intentionally
        // skips it. Legacy paths (deleteTagsByMessageId) cover the orphan
        // case until backfill or lazy adoption populates owner.
        const remaining = getTagsBySession(db, "ses-1");
        expect(remaining).toHaveLength(1);
        expect(remaining[0].tagNumber).toBe(1);
        expect(remaining[0].toolOwnerMessageId).toBeNull();

        closeQuietly(db);
    });

    test("getTagsBySession returns toolOwnerMessageId on every TagEntry", () => {
        const db = freshDb();
        insertTag(db, "ses-1", "msg-1:p0", "message", 32, 1);
        insertTag(db, "ses-1", "read:32", "tool", 100, 2, 0, "read", 0, "msg-A");
        insertTag(db, "ses-1", "msg-1:file0", "file", 48, 3);
        insertTag(db, "ses-1", "read:33", "tool", 100, 4); // legacy NULL owner

        const tags = getTagsBySession(db, "ses-1");
        expect(tags).toHaveLength(4);
        const byNumber = new Map(tags.map((t) => [t.tagNumber, t]));
        expect(byNumber.get(1)?.toolOwnerMessageId).toBeNull();
        expect(byNumber.get(2)?.toolOwnerMessageId).toBe("msg-A");
        expect(byNumber.get(3)?.toolOwnerMessageId).toBeNull();
        expect(byNumber.get(4)?.toolOwnerMessageId).toBeNull();

        closeQuietly(db);
    });

    /**
     * v3.3.1 Layer C — `message.removed` cleanup must cascade to tool
     * tags owned by the removed message. Pre-fix `deleteTagsByMessageId`
     * scanned only `messageId` / `messageId:p%` / `messageId:file%`,
     * which never matched tool tags (their `messageId` is the callId,
     * not the assistant message id). Post-fix the function also scopes
     * by `tool_owner_message_id == messageId`.
     */
    test("deleteTagsByMessageId cascades to tool tags by tool_owner_message_id (Layer C)", async () => {
        const { deleteTagsByMessageId } = await import("./storage-tags");
        const db = freshDb();
        // Text + file tags directly on m-asst-removed.
        insertTag(db, "ses-1", "m-asst-removed:p0", "message", 32, 1);
        insertTag(db, "ses-1", "m-asst-removed:file0", "file", 48, 2);
        // Tool tags owned by m-asst-removed (composite identity).
        insertTag(db, "ses-1", "read:32", "tool", 100, 3, 0, "read", 0, "m-asst-removed");
        insertTag(db, "ses-1", "grep:1", "tool", 200, 4, 0, "grep", 0, "m-asst-removed");
        // Tool tag owned by a DIFFERENT message — must survive.
        insertTag(db, "ses-1", "read:99", "tool", 50, 5, 0, "read", 0, "m-asst-other");
        // Legacy NULL-owner tool tag — survives (lazy adoption + Layer
        // B backfill cover this case explicitly).
        insertTag(db, "ses-1", "read:legacy", "tool", 25, 6);

        const removed = deleteTagsByMessageId(db, "ses-1", "m-asst-removed");

        // Tags 1, 2 (message + file on the removed msg) and 3, 4 (tool
        // tags owned by it) all deleted; 5 + 6 survive.
        expect(removed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
        const remaining = getTagsBySession(db, "ses-1");
        expect(remaining.map((t) => t.tagNumber).sort((a, b) => a - b)).toEqual([5, 6]);

        closeQuietly(db);
    });

    test("deleteTagsByMessageId rolls back if owner-scoped tool delete fails", () => {
        const db = freshDb();
        insertTag(db, "ses-1", "m-asst-removed:p0", "message", 32, 1);
        insertTag(db, "ses-1", "read:32", "tool", 100, 2, 0, "read", 0, "m-asst-removed");
        db.exec(`
            CREATE TRIGGER fail_owned_tool_tag_delete
            BEFORE DELETE ON tags
            WHEN OLD.session_id = 'ses-1'
              AND OLD.type = 'tool'
              AND OLD.tool_owner_message_id = 'm-asst-removed'
            BEGIN
                SELECT RAISE(ABORT, 'owned tool delete failed');
            END;
        `);

        expect(() => deleteTagsByMessageId(db, "ses-1", "m-asst-removed")).toThrow(
            "owned tool delete failed",
        );
        expect(getTagsBySession(db, "ses-1").map((t) => t.tagNumber)).toEqual([1, 2]);

        db.exec("DROP TRIGGER fail_owned_tool_tag_delete");
        expect(deleteTagsByMessageId(db, "ses-1", "m-asst-removed")).toEqual([1, 2]);
        expect(getTagsBySession(db, "ses-1")).toEqual([]);

        closeQuietly(db);
    });
});
