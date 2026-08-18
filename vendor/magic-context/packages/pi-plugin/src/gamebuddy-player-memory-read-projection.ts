import { join } from "node:path";
import {
    type Memory,
    MemoryCommandFacade,
} from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";

export type GameBuddyPlayerMemoryReadView = Readonly<{
    stateToken: string;
    content: string;
    category: "semantic" | "interaction";
    status: "active" | "permanent" | "archived";
    sourceRefs?: readonly string[];
}>;

export type GameBuddyPlayerMemoryReadProjection = Readonly<{
    listMemories(
        input: Readonly<{ continuityId: string }>,
    ): Promise<readonly GameBuddyPlayerMemoryReadView[]>;
    getMemory(
        input: Readonly<{ continuityId: string; stateToken: string }>,
    ): Promise<GameBuddyPlayerMemoryReadView>;
}>;

function sourceRefs(memory: Memory): readonly string[] | undefined {
    try {
        const metadata: unknown =
            memory.metadataJson === null ? undefined : JSON.parse(memory.metadataJson);
        const values =
            metadata && typeof metadata === "object" && !Array.isArray(metadata)
                ? (metadata as Record<string, unknown>).source_refs
                : undefined;
        return Array.isArray(values) && values.every((value) => typeof value === "string")
            ? Object.freeze([...values])
            : undefined;
    } catch {
        return undefined;
    }
}

function view(memory: Memory, stateToken: string): GameBuddyPlayerMemoryReadView {
    if (memory.category !== "SEMANTIC_MEMORY" && memory.category !== "INTERACTION_EPISODE")
        throw new Error("gamebuddy_memory_category_invalid");
    return Object.freeze({
        stateToken,
        content: memory.content,
        category: memory.category === "SEMANTIC_MEMORY" ? "semantic" : "interaction",
        status: memory.status,
        ...(sourceRefs(memory) === undefined ? {} : { sourceRefs: sourceRefs(memory) }),
    });
}

/** Bound read-only projection. It deliberately exposes no Memory mutation method. */
export function createGameBuddyPlayerMemoryReadProjection(
    args: Readonly<{ continuityId: string; runtimeCwd: string }>,
): GameBuddyPlayerMemoryReadProjection {
    const projectPath = resolveProjectIdentityForSession(args.runtimeCwd);
    if (!projectPath) throw new Error("gamebuddy_memory_project_identity_unavailable");
    const assertContinuity = (continuityId: string): void => {
        if (continuityId !== args.continuityId)
            throw new Error("gamebuddy_memory_continuity_mismatch");
    };
    const open = async (): Promise<MemoryCommandFacade> => {
        const db = await openDatabaseAsync(
            join(args.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"),
        );
        if (!db) throw new Error("gamebuddy_memory_storage_unavailable");
        return new MemoryCommandFacade(db);
    };
    return Object.freeze({
        async listMemories(input) {
            assertContinuity(input.continuityId);
            return (await open())
                .list(projectPath)
                .map((entry) => view(entry.memory, entry.stateToken));
        },
        async getMemory(input) {
            assertContinuity(input.continuityId);
            const entry = (await open())
                .list(projectPath)
                .find((candidate) => candidate.stateToken === input.stateToken);
            if (!entry) throw new Error("gamebuddy_memory_not_found");
            return view(entry.memory, entry.stateToken);
        },
    });
}
