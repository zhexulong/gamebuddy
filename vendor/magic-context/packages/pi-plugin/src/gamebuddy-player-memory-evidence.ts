import { join } from "node:path";
import {
    createMemoryStateToken,
    type Memory,
    MemoryCommandFacade,
    type MemoryCommandMutationInput,
} from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { validateMemorySourceRef } from "@magic-context/core/features/magic-context/memory/source-exclusion";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";
import {
    activatePlayerMemoryNextRoundEvidence,
    type PlayerMemoryNextRoundProviderBinding,
    reservePlayerMemoryNextRoundEvidence,
} from "./player-memory-next-round-marker";

export type GameBuddyPlayerMemoryCategory = "semantic" | "interaction";
export interface GameBuddyPlayerMemoryEvidence {
    operationCorrelation: string;
}
export interface GameBuddyPlayerMemoryCommitReceipt {
    operationCorrelation: string;
    committedMemoryMutationId: number;
}
export type GameBuddyPlayerMemoryMutationResult<T> = Readonly<{
    value: T;
    commitReceipt: GameBuddyPlayerMemoryCommitReceipt;
}>;
export interface GameBuddyPlayerMemoryEvidenceView {
    stateToken: string;
    content: string;
    category: GameBuddyPlayerMemoryCategory;
    status: "active" | "permanent" | "archived";
}
export interface GameBuddyPlayerMemoryEvidenceFacade {
    createMemory(
        input: Readonly<{
            continuityId: string;
            content: string;
            category: GameBuddyPlayerMemoryCategory;
            evidence: GameBuddyPlayerMemoryEvidence;
        }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyPlayerMemoryEvidenceView>>;
    updateMemory(
        input: Readonly<{
            continuityId: string;
            stateToken: string;
            expectedStateToken: string;
            content: string;
            evidence: GameBuddyPlayerMemoryEvidence;
        }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyPlayerMemoryEvidenceView>>;
    archiveMemory(
        input: Readonly<{
            continuityId: string;
            stateToken: string;
            expectedStateToken: string;
            reason?: string;
            evidence: GameBuddyPlayerMemoryEvidence;
        }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyPlayerMemoryEvidenceView>>;
    restoreMemory(
        input: Readonly<{
            continuityId: string;
            stateToken: string;
            expectedStateToken: string;
            evidence: GameBuddyPlayerMemoryEvidence;
        }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyPlayerMemoryEvidenceView>>;
    pinMemory(
        input: Readonly<{
            continuityId: string;
            stateToken: string;
            expectedStateToken: string;
            evidence: GameBuddyPlayerMemoryEvidence;
        }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyPlayerMemoryEvidenceView>>;
    unpinMemory(
        input: Readonly<{
            continuityId: string;
            stateToken: string;
            expectedStateToken: string;
            evidence: GameBuddyPlayerMemoryEvidence;
        }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyPlayerMemoryEvidenceView>>;
    mergeMemory(
        input: Readonly<{
            continuityId: string;
            stateToken: string;
            expectedStateToken: string;
            targetStateToken: string;
            evidence: GameBuddyPlayerMemoryEvidence;
        }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyPlayerMemoryEvidenceView>>;
    deleteEntry(
        input: Readonly<{
            continuityId: string;
            stateToken: string;
            expectedStateToken: string;
            evidence: GameBuddyPlayerMemoryEvidence;
        }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<void>>;
    excludeSource(
        input: Readonly<{
            continuityId: string;
            stateToken: string;
            expectedStateToken: string;
            sourceRef?: string;
            evidence: GameBuddyPlayerMemoryEvidence;
        }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<void>>;
    close(): void;
}

function assertPlayerMemoryCategory(
    category: Memory["category"],
): asserts category is "SEMANTIC_MEMORY" | "INTERACTION_EPISODE" {
    if (category !== "SEMANTIC_MEMORY" && category !== "INTERACTION_EPISODE")
        throw new Error("gamebuddy_memory_category_invalid");
}

function view(memory: Memory): GameBuddyPlayerMemoryEvidenceView {
    assertPlayerMemoryCategory(memory.category);
    return Object.freeze({
        stateToken: createMemoryStateToken(memory),
        content: memory.content,
        category: memory.category === "INTERACTION_EPISODE" ? "interaction" : "semantic",
        status: memory.status,
    });
}

/** Strict, unmounted source-owned API. The existing ordinary facade cannot arm evidence. */
export function createGameBuddyPlayerMemoryEvidenceFacade(
    args: Readonly<{
        continuityId: string;
        runtimeCwd: string;
        providerBinding: PlayerMemoryNextRoundProviderBinding;
    }>,
): GameBuddyPlayerMemoryEvidenceFacade {
    const projectPath = resolveProjectIdentityForSession(args.runtimeCwd);
    if (!projectPath) throw new Error("gamebuddy_memory_project_identity_unavailable");
    const providerBinding = Object.freeze({ ...args.providerBinding });
    // Registration belongs to runtime construction, before Pi starts. This
    // facade can only arm that already-bound exact session; it cannot receive
    // or replace the private source callback after runtime construction.
    const clear = () => undefined;
    const actor = { principal: "player_direct" as const, delegated: false };
    const open = async () => {
        const db = await openDatabaseAsync(
            join(args.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"),
        );
        if (!db) throw new Error("gamebuddy_memory_storage_unavailable");
        return new MemoryCommandFacade(db);
    };
    const sourceRefsFor = (memory: Memory): readonly string[] | undefined => {
        try {
            const metadata: unknown =
                memory.metadataJson === null ? undefined : JSON.parse(memory.metadataJson);
            const sourceRefs =
                metadata && typeof metadata === "object" && !Array.isArray(metadata)
                    ? (metadata as Record<string, unknown>).source_refs
                    : undefined;
            return Array.isArray(sourceRefs) &&
                sourceRefs.every((value) => typeof value === "string")
                ? sourceRefs
                : undefined;
        } catch {
            return undefined;
        }
    };
    const prepare = async (
        input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>,
    ): Promise<
        Readonly<{
            facade: MemoryCommandFacade;
            command: MemoryCommandMutationInput;
            memory: Memory;
        }>
    > => {
        if (input.continuityId !== args.continuityId)
            throw new Error("gamebuddy_memory_continuity_mismatch");
        if (input.stateToken !== input.expectedStateToken)
            throw new Error("gamebuddy_memory_stale_state");
        const facade = await open();
        const memory = facade
            .list(projectPath)
            .find((candidate) => candidate.stateToken === input.stateToken)?.memory;
        if (!memory) throw new Error("gamebuddy_memory_not_found");
        assertPlayerMemoryCategory(memory.category);
        return {
            facade,
            command: { projectPath, id: memory.id, stateToken: input.expectedStateToken, actor },
            memory,
        };
    };
    const execute = async <T>(
        evidence: GameBuddyPlayerMemoryEvidence,
        operation: () => Promise<
            Readonly<{
                value: T;
                committedMemoryMutationId: number;
                targetMemoryId: number;
            }>
        >,
    ): Promise<GameBuddyPlayerMemoryMutationResult<T>> => {
        const cancel = reservePlayerMemoryNextRoundEvidence(
            providerBinding,
            evidence.operationCorrelation,
        );
        try {
            const committed = await operation();
            activatePlayerMemoryNextRoundEvidence(
                providerBinding,
                {
                    operationCorrelation: evidence.operationCorrelation,
                    committedMemoryMutationId: committed.committedMemoryMutationId,
                },
                committed.targetMemoryId,
            );
            return Object.freeze({
                value: committed.value,
                commitReceipt: Object.freeze({
                    operationCorrelation: evidence.operationCorrelation,
                    committedMemoryMutationId: committed.committedMemoryMutationId,
                }),
            });
        } catch (error) {
            cancel();
            throw error;
        }
    };
    const executeExisting = async <T>(
        input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>,
        evidence: GameBuddyPlayerMemoryEvidence,
        operation: (
            prepared: Readonly<{
                facade: MemoryCommandFacade;
                command: MemoryCommandMutationInput;
            }>,
        ) => Readonly<{ value: T; committedMemoryMutationId: number }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<T>> => {
        const prepared = await prepare(input);
        return execute(evidence, async () => ({
            ...operation(prepared),
            targetMemoryId: prepared.command.id,
        }));
    };
    return Object.freeze({
        async createMemory(
            input: Parameters<GameBuddyPlayerMemoryEvidenceFacade["createMemory"]>[0],
        ) {
            if (input.continuityId !== args.continuityId)
                throw new Error("gamebuddy_memory_continuity_mismatch");
            if (input.category !== "semantic" && input.category !== "interaction")
                throw new Error("gamebuddy_memory_category_invalid");
            return execute(input.evidence, async () => {
                const result = (await open()).createWithCommitReceipt({
                    actor,
                    projectPath,
                    category:
                        input.category === "interaction"
                            ? "INTERACTION_EPISODE"
                            : "SEMANTIC_MEMORY",
                    content: input.content,
                    sourceType: "user",
                });
                return {
                    value: view(result.value.memory),
                    committedMemoryMutationId: result.committedMemoryMutationId,
                    targetMemoryId: result.value.memory.id,
                };
            });
        },
        async updateMemory(
            input: Parameters<GameBuddyPlayerMemoryEvidenceFacade["updateMemory"]>[0],
        ) {
            return executeExisting(input, input.evidence, ({ facade, command }) => {
                const result = facade.updateWithCommitReceipt({
                    ...command,
                    content: input.content,
                });
                return {
                    value: view(result.value.memory),
                    committedMemoryMutationId: result.committedMemoryMutationId,
                };
            });
        },
        async archiveMemory(
            input: Parameters<GameBuddyPlayerMemoryEvidenceFacade["archiveMemory"]>[0],
        ) {
            return executeExisting(input, input.evidence, ({ facade, command }) => {
                const result = facade.archiveWithCommitReceipt(command, input.reason);
                return {
                    value: view(result.value.memory),
                    committedMemoryMutationId: result.committedMemoryMutationId,
                };
            });
        },
        async restoreMemory(
            input: Parameters<GameBuddyPlayerMemoryEvidenceFacade["restoreMemory"]>[0],
        ) {
            return executeExisting(input, input.evidence, ({ facade, command }) => {
                const result = facade.restoreWithCommitReceipt(command);
                return {
                    value: view(result.value.memory),
                    committedMemoryMutationId: result.committedMemoryMutationId,
                };
            });
        },
        async pinMemory(input: Parameters<GameBuddyPlayerMemoryEvidenceFacade["pinMemory"]>[0]) {
            return executeExisting(input, input.evidence, ({ facade, command }) => {
                const result = facade.pinWithCommitReceipt(command);
                return {
                    value: view(result.value.memory),
                    committedMemoryMutationId: result.committedMemoryMutationId,
                };
            });
        },
        async unpinMemory(
            input: Parameters<GameBuddyPlayerMemoryEvidenceFacade["unpinMemory"]>[0],
        ) {
            return executeExisting(input, input.evidence, ({ facade, command }) => {
                const result = facade.unpinWithCommitReceipt(command);
                return {
                    value: view(result.value.memory),
                    committedMemoryMutationId: result.committedMemoryMutationId,
                };
            });
        },
        async mergeMemory(
            input: Parameters<GameBuddyPlayerMemoryEvidenceFacade["mergeMemory"]>[0],
        ) {
            const prepared = await prepare(input);
            const target = prepared.facade
                .list(projectPath)
                .find((candidate) => candidate.stateToken === input.targetStateToken)?.memory;
            if (!target || target.id === prepared.command.id)
                throw new Error("gamebuddy_memory_merge_target_not_found");
            assertPlayerMemoryCategory(target.category);
            return execute(input.evidence, async () => {
                const result = prepared.facade.mergeWithCommitReceipt({
                    ...prepared.command,
                    targetStateToken: input.targetStateToken,
                });
                return {
                    value: view(result.value.memory),
                    committedMemoryMutationId: result.committedMemoryMutationId,
                    targetMemoryId: prepared.command.id,
                };
            });
        },
        async deleteEntry(
            input: Parameters<GameBuddyPlayerMemoryEvidenceFacade["deleteEntry"]>[0],
        ) {
            return executeExisting(input, input.evidence, ({ facade, command }) => {
                const result = facade.deleteEntryWithCommitReceipt(command);
                return {
                    value: undefined,
                    committedMemoryMutationId: result.committedMemoryMutationId,
                };
            });
        },
        async excludeSource(
            input: Parameters<GameBuddyPlayerMemoryEvidenceFacade["excludeSource"]>[0],
        ) {
            const prepared = await prepare(input);
            const sourceRefs =
                input.sourceRef === undefined ? sourceRefsFor(prepared.memory) : [input.sourceRef];
            if (!sourceRefs || sourceRefs.length === 0)
                throw new Error("gamebuddy_memory_source_ref_required");
            for (const sourceRef of sourceRefs) validateMemorySourceRef(sourceRef);
            return execute(input.evidence, async () => {
                const result = prepared.facade.excludeSourcesWithCommitReceipt({
                    ...prepared.command,
                    sourceRefs,
                });
                return {
                    value: undefined,
                    committedMemoryMutationId: result.committedMemoryMutationId,
                    targetMemoryId: prepared.command.id,
                };
            });
        },
        close: clear,
    });
}
