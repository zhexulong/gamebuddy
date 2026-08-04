import { describe, expect, mock, test } from "bun:test";

import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { reviewUserMemories } from "./review-user-memories";
import { insertUserMemoryCandidates } from "./storage-user-memory";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("reviewUserMemories", () => {
    test("deletes its child session when the review run fails", async () => {
        const db = freshDb();
        insertUserMemoryCandidates(db, [
            { content: "User prefers concise updates", sessionId: "s1" },
        ]);
        const deleted: string[] = [];
        const client = {
            session: {
                create: mock(async () => ({ id: "child-user-memories" })),
                prompt: mock(async () => {
                    throw new Error("model unavailable");
                }),
                delete: mock(async ({ path }: { path: { id: string } }) => {
                    deleted.push(path.id);
                    return {};
                }),
            },
        } as never;

        await expect(
            reviewUserMemories({
                db,
                client,
                parentSessionId: undefined,
                sessionDirectory: "/repo/project",
                holderId: "holder",
                leaseKey: "review-user-memories",
                deadline: Date.now() + 60_000,
                promotionThreshold: 1,
            }),
        ).rejects.toThrow("model unavailable");

        expect(deleted).toEqual(["child-user-memories"]);
        db.close();
    });
});
