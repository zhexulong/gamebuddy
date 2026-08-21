import { join } from "node:path";
import {
    type MemoryCommandFacade,
    MemoryCommandFacade as MemoryFacade,
} from "@magic-context/core/features/magic-context/memory";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";
import {
    createGameBuddyPlayerMemoryReadProjection,
    resolveGameBuddyMemoryProjectPath,
    type GameBuddyPlayerMemoryReadProjection,
    type GameBuddyPlayerMemoryReadView,
} from "./gamebuddy-player-memory-read-projection";

/**
 * Browser-management CRUD boundary for player-owned Memory. It is bound only
 * to the supplied continuity and runtime project; it is neither a Pi tool nor
 * a provider/runtime callback capability.
 */
export type GameBuddyPlayerMemoryCrudFacade =
    GameBuddyPlayerMemoryReadProjection &
    Readonly<{
        create(
            input: Readonly<{ continuityId: string; content: string }>,
        ): Promise<GameBuddyPlayerMemoryReadView>;
        update(
            input: Readonly<{
                continuityId: string;
                stateToken: string;
                content: string;
            }>,
        ): Promise<GameBuddyPlayerMemoryReadView>;
        archive(
            input: Readonly<{ continuityId: string; stateToken: string }>,
        ): Promise<void>;
    }>;

export function createGameBuddyPlayerMemoryCrudFacade(
    args: Readonly<{ continuityId: string; runtimeCwd: string }>,
): GameBuddyPlayerMemoryCrudFacade {
    const projectPath = resolveGameBuddyMemoryProjectPath(args.runtimeCwd, args.continuityId);
    const read = createGameBuddyPlayerMemoryReadProjection(args);
    const assertContinuity = (continuityId: string): void => {
        if (continuityId !== args.continuityId)
            throw new Error("gamebuddy_memory_continuity_mismatch");
    };
    const open = async (): Promise<MemoryCommandFacade> => {
        const db = await openDatabaseAsync(
            join(args.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"),
        );
        if (!db) throw new Error("gamebuddy_memory_storage_unavailable");
        return new MemoryFacade(db);
    };
    const player = Object.freeze({ principal: "player_direct" as const, delegated: false });

    return Object.freeze({
        ...read,
        async create(input) {
            assertContinuity(input.continuityId);
            const result = (await open()).create({
                projectPath,
                category: "SEMANTIC_MEMORY",
                content: input.content,
                sourceType: "user",
                actor: player,
            });
            return (await read.getMemory({ continuityId: args.continuityId, stateToken: result.stateToken }));
        },
        async update(input) {
            assertContinuity(input.continuityId);
            // Resolve and compare the opaque token inside the vendor's
            // BEGIN IMMEDIATE transaction so two browser writes cannot both
            // succeed from one stale read-back.
            const result = (await open()).updateByStateToken({
                projectPath,
                stateToken: input.stateToken,
                content: input.content,
                actor: player,
            });
            return (await read.getMemory({ continuityId: args.continuityId, stateToken: result.stateToken }));
        },
        async archive(input) {
            assertContinuity(input.continuityId);
            (await open()).archiveByStateToken(
                {
                    projectPath,
                    stateToken: input.stateToken,
                    actor: player,
                },
                "Archived by player management",
            );
        },
    });
}
