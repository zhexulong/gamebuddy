import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCommandFacade } from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
    closeDatabase,
    openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createGameBuddyPlayerMemoryEvidenceFacade } from "./gamebuddy-player-memory-evidence";
import { resetPlayerMemoryNextRoundMarkersForTest } from "./player-memory-next-round-marker";

const binding = Object.freeze({
    sessionId: "player_memory_category_test",
    surface: "chat" as const,
    nonceSha256: "a".repeat(64),
});
let cwd: string;
let openedDatabase: Awaited<ReturnType<typeof openDatabaseAsync>>;

beforeEach(() => {
    resetPlayerMemoryNextRoundMarkersForTest();
    cwd = mkdtempSync(join(tmpdir(), "gamebuddy-player-memory-category-"));
});
afterEach(() => {
    closeQuietly(openedDatabase);
    closeDatabase();
    resetPlayerMemoryNextRoundMarkersForTest();
    // SQLite's Windows worker can retain the temporary database directory briefly.
});

function evidence(index: number) {
    return { operationCorrelation: `category_rejection_${index.toString().padStart(2, "0")}` };
}

async function setup() {
    const projectPath = resolveProjectIdentityForSession(cwd);
    if (!projectPath) throw new Error("test_project_identity_unavailable");
    const db = await openDatabaseAsync(
        join(cwd, "data", "cortexkit", "magic-context", "context.db"),
    );
    if (!db) throw new Error("test_database_unavailable");
    openedDatabase = db;
    const direct = new MemoryCommandFacade(db);
    const unsupported = direct.create({
        actor: { principal: "player_direct", delegated: false },
        projectPath,
        category: "ARCHITECTURE",
        content: "Unsupported category must remain intact.",
        sourceType: "user",
    });
    const player = direct.create({
        actor: { principal: "player_direct", delegated: false },
        projectPath,
        category: "SEMANTIC_MEMORY",
        content: "Supported source.",
        sourceType: "user",
    });
    const api = createGameBuddyPlayerMemoryEvidenceFacade({
        continuityId: "continuity",
        runtimeCwd: cwd,
        providerBinding: binding,
    });
    return { api, direct, projectPath, unsupported, player, db };
}

function mutationCount(db: { prepare(sql: string): { get(): { count: number } } }): number {
    return db.prepare("SELECT COUNT(*) AS count FROM memory_mutation_log").get().count;
}

describe("GameBuddy player-memory evidence category boundary", () => {
    it("rejects every existing-token operation on a non-player category before reservation or mutation", async () => {
        const { api, direct, projectPath, unsupported, db } = await setup();
        const operations = [
            () =>
                api.updateMemory({
                    continuityId: "continuity",
                    stateToken: unsupported.stateToken,
                    expectedStateToken: unsupported.stateToken,
                    content: "must not update",
                    evidence: evidence(1),
                }),
            () =>
                api.archiveMemory({
                    continuityId: "continuity",
                    stateToken: unsupported.stateToken,
                    expectedStateToken: unsupported.stateToken,
                    evidence: evidence(2),
                }),
            () =>
                api.restoreMemory({
                    continuityId: "continuity",
                    stateToken: unsupported.stateToken,
                    expectedStateToken: unsupported.stateToken,
                    evidence: evidence(3),
                }),
            () =>
                api.pinMemory({
                    continuityId: "continuity",
                    stateToken: unsupported.stateToken,
                    expectedStateToken: unsupported.stateToken,
                    evidence: evidence(4),
                }),
            () =>
                api.unpinMemory({
                    continuityId: "continuity",
                    stateToken: unsupported.stateToken,
                    expectedStateToken: unsupported.stateToken,
                    evidence: evidence(5),
                }),
            () =>
                api.mergeMemory({
                    continuityId: "continuity",
                    stateToken: unsupported.stateToken,
                    expectedStateToken: unsupported.stateToken,
                    targetStateToken: unsupported.stateToken,
                    evidence: evidence(6),
                }),
            () =>
                api.deleteEntry({
                    continuityId: "continuity",
                    stateToken: unsupported.stateToken,
                    expectedStateToken: unsupported.stateToken,
                    evidence: evidence(7),
                }),
        ];
        const before = mutationCount(db);
        for (const operation of operations)
            await expect(operation()).rejects.toThrow("gamebuddy_memory_category_invalid");
        expect(mutationCount(db)).toBe(before);
        const unchanged = direct
            .list(projectPath)
            .find((entry) => entry.memory.id === unsupported.memory.id)?.memory;
        expect(unchanged).toMatchObject({
            category: "ARCHITECTURE",
            content: "Unsupported category must remain intact.",
            status: "active",
        });
        api.close();
    });

    it("validates an unsupported merge target before mutating the supported source", async () => {
        const { api, direct, projectPath, unsupported, player, db } = await setup();
        const before = mutationCount(db);
        await expect(
            api.mergeMemory({
                continuityId: "continuity",
                stateToken: player.stateToken,
                expectedStateToken: player.stateToken,
                targetStateToken: unsupported.stateToken,
                evidence: evidence(8),
            }),
        ).rejects.toThrow("gamebuddy_memory_category_invalid");
        expect(mutationCount(db)).toBe(before);
        const memories = direct.list(projectPath);
        expect(
            memories.find((entry) => entry.memory.id === player.memory.id)?.memory
                .supersededByMemoryId,
        ).toBeNull();
        expect(
            memories.find((entry) => entry.memory.id === unsupported.memory.id)?.memory.category,
        ).toBe("ARCHITECTURE");
        api.close();
    });
});
