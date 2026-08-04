import { describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    getUserMemoryCandidates,
    insertUserMemoryCandidates,
    pruneExpiredUserMemoryCandidates,
    USER_MEMORY_CANDIDATE_TTL_MS,
} from "./storage-user-memory";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("user-memory candidate decay", () => {
    it("prunes candidates older than the TTL, keeps fresher ones", () => {
        const db = freshDb();
        const now = 1_000_000_000_000;
        // Insert two candidates, then back-date one past the TTL via direct UPDATE
        // (insert stamps created_at=Date.now()).
        insertUserMemoryCandidates(db, [
            { content: "stale one-off", sessionId: "s1" },
            { content: "recent observation", sessionId: "s1" },
        ]);
        const [stale, recent] = getUserMemoryCandidates(db);
        db.prepare("UPDATE user_memory_candidates SET created_at = ? WHERE id = ?").run(
            now - USER_MEMORY_CANDIDATE_TTL_MS - 1,
            stale.id,
        );
        db.prepare("UPDATE user_memory_candidates SET created_at = ? WHERE id = ?").run(
            now - 1000,
            recent.id,
        );

        const pruned = pruneExpiredUserMemoryCandidates(db, USER_MEMORY_CANDIDATE_TTL_MS, now);
        expect(pruned).toBe(1);

        const survivors = getUserMemoryCandidates(db);
        expect(survivors).toHaveLength(1);
        expect(survivors[0].content).toBe("recent observation");
        db.close();
    });

    it("prunes nothing when all candidates are within the TTL", () => {
        const db = freshDb();
        insertUserMemoryCandidates(db, [{ content: "fresh", sessionId: "s1" }]);
        const pruned = pruneExpiredUserMemoryCandidates(db, USER_MEMORY_CANDIDATE_TTL_MS);
        expect(pruned).toBe(0);
        expect(getUserMemoryCandidates(db)).toHaveLength(1);
        db.close();
    });
});
