import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";
import { MemoryCommandFacade } from "@magic-context/core/features/magic-context/memory/command-facade";
import { createGameBuddyPlayerMemoryCrudFacade } from "./gamebuddy-player-memory-crud-facade";
import { resolveGameBuddyMemoryProjectPath } from "./gamebuddy-player-memory-read-projection";

const continuityId = "continuity_01";
let root: string | undefined;

afterEach(async () => {
    if (root !== undefined)
        await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => undefined);
    root = undefined;
});

describe("GameBuddy player Memory CRUD facade", () => {
    test("is continuity-bound, writes through vendor ownership, and rereads each mutation", async () => {
        root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-crud-"));
        const facade = createGameBuddyPlayerMemoryCrudFacade({ continuityId, runtimeCwd: root });

        const created = await facade.create({ continuityId, content: "The farmer likes blueberries." });
        expect(created.content).toBe("The farmer likes blueberries.");
        expect(created.category).toBe("semantic");
        expect(created.status).toBe("active");

        const updated = await facade.update({
            continuityId,
            stateToken: created.stateToken,
            content: "The farmer prefers strawberries.",
        });
        expect(updated.content).toBe("The farmer prefers strawberries.");
        expect(updated.stateToken).not.toBe(created.stateToken);

        await facade.archive({ continuityId, stateToken: updated.stateToken });
        const entries = await facade.listMemories({ continuityId });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.content).toBe("The farmer prefers strawberries.");
        expect(entries[0]?.status).toBe("archived");
        await expect(facade.listMemories({ continuityId: "other" })).rejects.toThrow(
            "gamebuddy_memory_continuity_mismatch",
        );
    });

    test("isolates continuities and omits unrelated vendor categories from the player projection", async () => {
        root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-crud-isolation-"));
        const databasePath = join(root, "data", "cortexkit", "magic-context", "context.db");
        const db = await openDatabaseAsync(databasePath);
        expect(db).toBeTruthy();
        const commands = new MemoryCommandFacade(db!);
        const projectPath = resolveGameBuddyMemoryProjectPath(root, continuityId);
        commands.create({
            projectPath,
            category: "PROJECT_RULES",
            content: "This non-player category must not make the safe projection fail.",
            sourceType: "user",
            actor: { principal: "player_direct", delegated: false },
        });
        const first = createGameBuddyPlayerMemoryCrudFacade({ continuityId, runtimeCwd: root });
        const second = createGameBuddyPlayerMemoryCrudFacade({ continuityId: "continuity_02", runtimeCwd: root });

        await first.create({ continuityId, content: "Only the first continuity may see this." });
        expect(await first.listMemories({ continuityId })).toMatchObject([
            { content: "Only the first continuity may see this." },
        ]);
        expect(await second.listMemories({ continuityId: "continuity_02" })).toEqual([]);
    });

    test("rejects a second write using the stale vendor state token", async () => {
        root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-crud-cas-"));
        const facade = createGameBuddyPlayerMemoryCrudFacade({ continuityId, runtimeCwd: root });
        const created = await facade.create({ continuityId, content: "Original" });
        await facade.update({ continuityId, stateToken: created.stateToken, content: "First update" });
        await expect(
            facade.update({ continuityId, stateToken: created.stateToken, content: "Stale second update" }),
        ).rejects.toThrow(/stale|not found/i);
        const rows = await facade.listMemories({ continuityId });
        expect(rows).toMatchObject([{ content: "First update" }]);
    });
});
