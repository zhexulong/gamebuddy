import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { initializeDatabase } from "./storage-db";
import {
    getMaxMemoryMutationId,
    getMemoryMutationsForRender,
    queueMemoryMutation,
} from "./storage-memory-mutation-log";

let db: Database | null = null;

function makeDb(): Database {
    db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

afterEach(() => {
    if (db) {
        closeQuietly(db);
        db = null;
    }
});

describe("storage-memory-mutation-log", () => {
    test("queues project-scoped memory mutations and reports max id", () => {
        const database = makeDb();
        const first = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "archive",
            targetMemoryId: 10,
            queuedAt: 100,
        });
        const second = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "update",
            targetMemoryId: 11,
            category: "PROJECT_RULES",
            newContent: "Updated content",
            queuedAt: 200,
        });
        queueMemoryMutation(database, {
            projectPath: "/repo/b",
            mutationType: "delete",
            targetMemoryId: 10,
            queuedAt: 300,
        });

        expect(first.projectPath).toBe("/repo/a");
        expect(second.newContent).toBe("Updated content");
        expect(getMaxMemoryMutationId(database, "/repo/a")).toBe(second.id);
        expect(getMaxMemoryMutationId(database, "/repo/missing")).toBeNull();
    });

    test("returns newest mutation per rendered target memory", () => {
        const database = makeDb();
        const older = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "update",
            targetMemoryId: 10,
            newContent: "older",
            queuedAt: 100,
        });
        queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "archive",
            targetMemoryId: 99,
            queuedAt: 150,
        });
        const newer = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "delete",
            targetMemoryId: 10,
            queuedAt: 200,
        });
        const superseded = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "superseded",
            targetMemoryId: 11,
            supersededById: 12,
            queuedAt: 300,
        });

        const rows = getMemoryMutationsForRender(database, "/repo/a", older.id - 1, [10, 11]);

        expect(rows).toEqual([newer, superseded]);
    });

    test("filters by cursor, project, and rendered ids", () => {
        const database = makeDb();
        const first = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "archive",
            targetMemoryId: 10,
            queuedAt: 100,
        });
        queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "delete",
            targetMemoryId: 11,
            queuedAt: 200,
        });
        queueMemoryMutation(database, {
            projectPath: "/repo/b",
            mutationType: "update",
            targetMemoryId: 10,
            newContent: "other project",
            queuedAt: 300,
        });

        expect(getMemoryMutationsForRender(database, "/repo/a", first.id, [10])).toEqual([]);
        expect(getMemoryMutationsForRender(database, "/repo/a", 0, [])).toEqual([]);
    });

    // A terminal mutation (archive/delete/superseded) takes precedence over a
    // later non-terminal `update` for the same target, regardless of id order.
    // Without this, archive-then-update would render the memory as
    // present/updated in the m[1] <memory-updates> delta even though it left the
    // active set (an archived row won't reappear in the next m[0] baseline).
    test("a terminal archive outranks a later update for the same target", () => {
        const database = makeDb();
        const archive = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "archive",
            targetMemoryId: 10,
            queuedAt: 100,
        });
        queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "update",
            targetMemoryId: 10,
            category: "PROJECT_RULES",
            newContent: "resurrected content",
            queuedAt: 200,
        });

        const rows = getMemoryMutationsForRender(database, "/repo/a", 0, [10]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual(archive); // terminal wins; update is masked
        expect(rows[0]?.mutationType).toBe("archive");
    });

    test("update-then-archive still resolves to the archive (newest terminal)", () => {
        const database = makeDb();
        queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "update",
            targetMemoryId: 10,
            newContent: "edited",
            queuedAt: 100,
        });
        const archive = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "delete",
            targetMemoryId: 10,
            queuedAt: 200,
        });

        const rows = getMemoryMutationsForRender(database, "/repo/a", 0, [10]);
        expect(rows).toEqual([archive]);
    });

    test("multiple updates with no terminal → newest update wins", () => {
        const database = makeDb();
        queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "update",
            targetMemoryId: 10,
            newContent: "v1",
            queuedAt: 100,
        });
        const newest = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "update",
            targetMemoryId: 10,
            newContent: "v2",
            queuedAt: 200,
        });

        const rows = getMemoryMutationsForRender(database, "/repo/a", 0, [10]);
        expect(rows).toEqual([newest]);
    });
});
