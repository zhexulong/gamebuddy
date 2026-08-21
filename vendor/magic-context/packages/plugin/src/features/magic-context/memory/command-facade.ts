import type { Database } from "../../../shared/sqlite";
import { queueMemoryMutation } from "../storage-memory-mutation-log";
import { computeNormalizedHash } from "./normalize-hash";
import { excludeMemorySource, validateMemorySourceRef } from "./source-exclusion";
import {
    archiveMemory,
    deleteMemory,
    getMemoryById,
    getMemoriesByProject,
    insertMemoryIdempotent,
    supersededMemory,
    updateMemoryContent,
    updateMemoryStatus,
} from "./storage-memory";
import type { Memory, MemoryInput, MemoryStatus } from "./types";

export type MemoryCommandPrincipal = "player_direct" | "companion_agent";

export interface MemoryCommandActor {
    principal: MemoryCommandPrincipal;
    delegated: boolean;
}

export interface MemoryCommandCreateInput extends MemoryInput {
    actor: MemoryCommandActor;
}

export interface MemoryCommandMutationInput {
    /** Canonical project/continuity storage identity that owns this memory. */
    projectPath: string;
    id: number;
    stateToken: string;
    actor: MemoryCommandActor;
}

export interface MemoryCommandUpdateInput extends MemoryCommandMutationInput {
    content: string;
}

export interface MemoryCommandMergeInput extends MemoryCommandMutationInput {
    /** Opaque target token in the same project; neither caller sees a numeric ID. */
    targetStateToken: string;
}

export interface MemoryCommandExcludeSourceInput extends MemoryCommandMutationInput {
    /** Validated opaque provenance references to exclude atomically with the receipt. */
    sourceRefs: readonly string[];
}

export interface MemoryCommandResult {
    memory: Memory;
    stateToken: string;
}

/** Internal transaction receipt for callers that need to bind one mutation to its log row. */
export interface MemoryCommandCommitResult<T> {
    value: T;
    committedMemoryMutationId: number;
}

interface MemoryGovernance {
    authority?: unknown;
}

function metadataObject(metadataJson: string | null): Record<string, unknown> {
    if (!metadataJson) return {};
    try {
        const parsed: unknown = JSON.parse(metadataJson);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function governanceFor(memory: Memory): MemoryGovernance {
    const governance = metadataObject(memory.metadataJson).governance;
    return governance && typeof governance === "object" && !Array.isArray(governance)
        ? (governance as MemoryGovernance)
        : {};
}

function playerGovernedMetadata(metadataJson: string | null): string {
    const metadata = metadataObject(metadataJson);
    const governance = metadata.governance;
    metadata.governance = {
        ...(governance && typeof governance === "object" && !Array.isArray(governance)
            ? governance
            : {}),
        authority: "player",
    };
    return JSON.stringify(metadata);
}

/** A deterministic opaque token for optimistic concurrency at the command boundary. */
export function createMemoryStateToken(memory: Memory): string {
    const state = JSON.stringify({
        id: memory.id,
        updatedAt: memory.updatedAt,
        normalizedHash: memory.normalizedHash,
        status: memory.status,
        supersededByMemoryId: memory.supersededByMemoryId,
        governance: governanceFor(memory),
    });
    return Buffer.from(state, "utf8").toString("base64url");
}

function isCurrentState(memory: Memory, stateToken: string): boolean {
    return createMemoryStateToken(memory) === stateToken;
}

function assertMutationAuthorized(memory: Memory, actor: MemoryCommandActor): void {
    if (
        actor.principal === "companion_agent" &&
        !actor.delegated &&
        (governanceFor(memory).authority === "player" || memory.status === "permanent")
    ) {
        throw new Error(
            "Companion mutation requires delegation for player-authority or permanent memory",
        );
    }
}

function requireProjectPath(projectPath: string): void {
    if (!projectPath) throw new Error("Memory command requires a project path");
}

function requireCurrentMutableMemory(db: Database, input: MemoryCommandMutationInput): Memory {
    requireProjectPath(input.projectPath);
    const memory = getMemoryById(db, input.id);
    if (!memory) throw new Error(`Memory ${input.id} was not found`);
    if (memory.projectPath !== input.projectPath)
        throw new Error(`Memory ${input.id} does not belong to this project`);
    if (!isCurrentState(memory, input.stateToken))
        throw new Error(`Memory ${input.id} has stale state`);
    assertMutationAuthorized(memory, input.actor);
    return memory;
}

function result(db: Database, projectPath: string, id: number): MemoryCommandResult {
    requireProjectPath(projectPath);
    const memory = getMemoryById(db, id);
    if (!memory) throw new Error(`Memory ${id} was not found after mutation`);
    if (memory.projectPath !== projectPath)
        throw new Error(`Memory ${id} does not belong to this project`);
    return { memory, stateToken: createMemoryStateToken(memory) };
}

function setMetadata(db: Database, id: number, metadataJson: string): void {
    db.prepare("UPDATE memories SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
        metadataJson,
        Date.now(),
        id,
    );
}

function runMutation<T>(db: Database, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const value = fn();
        db.exec("COMMIT");
        return value;
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

export class MemoryCommandFacade {
    constructor(private readonly db: Database) {}

    /** Read views remain project-bound at the facade boundary; callers never query arbitrary IDs. */
    list(projectPath: string): MemoryCommandResult[] {
        requireProjectPath(projectPath);
        return getMemoriesByProject(this.db, projectPath, ["active", "permanent", "archived"])
            .map((memory) => ({ memory, stateToken: createMemoryStateToken(memory) }));
    }

    create(input: MemoryCommandCreateInput): MemoryCommandResult {
        return this.createWithCommitReceipt(input).value;
    }

    createWithCommitReceipt(input: MemoryCommandCreateInput): MemoryCommandCommitResult<MemoryCommandResult> {
        requireProjectPath(input.projectPath);
        return runMutation(this.db, () => {
            const { memory } = insertMemoryIdempotent(this.db, {
                ...input,
                metadataJson:
                    input.actor.principal === "player_direct"
                        ? playerGovernedMetadata(input.metadataJson ?? null)
                        : (input.metadataJson ?? null),
            });
            const mutation = queueMemoryMutation(this.db, {
                projectPath: memory.projectPath, mutationType: "update", targetMemoryId: memory.id,
                category: memory.category, newContent: memory.content,
            });
            return { value: result(this.db, input.projectPath, memory.id), committedMemoryMutationId: mutation.id };
        });
    }

    /**
     * Resolve an opaque state token and perform the update in one immediate
     * transaction.  This is for external management surfaces that deliberately
     * never retain numeric storage ids between their safe reread and write.
     */
    updateByStateToken(input: Omit<MemoryCommandUpdateInput, "id">): MemoryCommandResult {
        const content = input.content.trim();
        if (!content) throw new Error("Memory content must not be empty");
        return runMutation(this.db, () => {
            const memory = this.requireMemoryByStateToken(input);
            updateMemoryContent(this.db, memory.id, content, computeNormalizedHash(content));
            if (input.actor.principal === "player_direct") {
                const updated = getMemoryById(this.db, memory.id);
                if (!updated) throw new Error(`Memory ${memory.id} was not found after update`);
                setMetadata(this.db, updated.id, playerGovernedMetadata(updated.metadataJson));
            }
            queueMemoryMutation(this.db, {
                projectPath: memory.projectPath,
                mutationType: "update",
                targetMemoryId: memory.id,
                category: memory.category,
                newContent: content,
            });
            return result(this.db, input.projectPath, memory.id);
        });
    }

    update(input: MemoryCommandUpdateInput): MemoryCommandResult {
        return this.updateWithCommitReceipt(input).value;
    }

    updateWithCommitReceipt(input: MemoryCommandUpdateInput): MemoryCommandCommitResult<MemoryCommandResult> {
        const content = input.content.trim();
        if (!content) throw new Error("Memory content must not be empty");
        return runMutation(this.db, () => {
            const memory = requireCurrentMutableMemory(this.db, input);
            updateMemoryContent(this.db, memory.id, content, computeNormalizedHash(content));
            if (input.actor.principal === "player_direct") {
                const updated = getMemoryById(this.db, memory.id);
                if (!updated) throw new Error(`Memory ${memory.id} was not found after update`);
                setMetadata(this.db, updated.id, playerGovernedMetadata(updated.metadataJson));
            }
            const mutation = queueMemoryMutation(this.db, {
                projectPath: memory.projectPath, mutationType: "update", targetMemoryId: memory.id,
                category: memory.category, newContent: content,
            });
            return { value: result(this.db, input.projectPath, memory.id), committedMemoryMutationId: mutation.id };
        });
    }

    archiveByStateToken(input: Omit<MemoryCommandMutationInput, "id">, reason?: string): MemoryCommandResult {
        return runMutation(this.db, () => {
            const memory = this.requireMemoryByStateToken(input);
            if (reason === undefined) updateMemoryStatus(this.db, memory.id, "archived");
            else archiveMemory(this.db, memory.id, reason);
            queueMemoryMutation(this.db, {
                projectPath: memory.projectPath,
                mutationType: "archive",
                targetMemoryId: memory.id,
            });
            return result(this.db, input.projectPath, memory.id);
        });
    }

    archive(input: MemoryCommandMutationInput, reason?: string): MemoryCommandResult { return this.archiveWithCommitReceipt(input, reason).value; }
    archiveWithCommitReceipt(input: MemoryCommandMutationInput, reason?: string): MemoryCommandCommitResult<MemoryCommandResult> { return this.transitionWithCommitReceipt(input, "archived", "archive", reason); }
    restore(input: MemoryCommandMutationInput): MemoryCommandResult { return this.restoreWithCommitReceipt(input).value; }
    restoreWithCommitReceipt(input: MemoryCommandMutationInput): MemoryCommandCommitResult<MemoryCommandResult> { return this.transitionWithCommitReceipt(input, "active"); }
    pin(input: MemoryCommandMutationInput): MemoryCommandResult { return this.pinWithCommitReceipt(input).value; }
    pinWithCommitReceipt(input: MemoryCommandMutationInput): MemoryCommandCommitResult<MemoryCommandResult> { return this.transitionWithCommitReceipt(input, "permanent"); }
    unpin(input: MemoryCommandMutationInput): MemoryCommandResult { return this.unpinWithCommitReceipt(input).value; }
    unpinWithCommitReceipt(input: MemoryCommandMutationInput): MemoryCommandCommitResult<MemoryCommandResult> { return this.transitionWithCommitReceipt(input, "active"); }

    deleteEntry(input: MemoryCommandMutationInput): void { this.deleteEntryWithCommitReceipt(input); }
    deleteEntryWithCommitReceipt(input: MemoryCommandMutationInput): MemoryCommandCommitResult<void> {
        return runMutation(this.db, () => {
            const memory = requireCurrentMutableMemory(this.db, input);
            deleteMemory(this.db, memory.id);
            const mutation = queueMemoryMutation(this.db, { projectPath: memory.projectPath, mutationType: "delete", targetMemoryId: memory.id });
            return { value: undefined, committedMemoryMutationId: mutation.id };
        });
    }

    excludeSourcesWithCommitReceipt(input: MemoryCommandExcludeSourceInput): MemoryCommandCommitResult<void> {
        return runMutation(this.db, () => {
            const memory = requireCurrentMutableMemory(this.db, input);
            if (input.sourceRefs.length === 0) throw new Error("Memory source reference is required");
            for (const sourceRef of input.sourceRefs) {
                validateMemorySourceRef(sourceRef);
                excludeMemorySource(this.db, { projectPath: memory.projectPath, sourceRef });
            }
            // The source policy changes the effective Memory context. Emit a normal
            // revision-bound update row so the exact selected entry can prove the
            // evidence-bound exclusion at the next provider round.
            const mutation = queueMemoryMutation(this.db, {
                projectPath: memory.projectPath,
                mutationType: "update",
                targetMemoryId: memory.id,
                category: memory.category,
                newContent: memory.content,
            });
            return { value: undefined, committedMemoryMutationId: mutation.id };
        });
    }

    merge(input: MemoryCommandMergeInput): MemoryCommandResult { return this.mergeWithCommitReceipt(input).value; }
    mergeWithCommitReceipt(input: MemoryCommandMergeInput): MemoryCommandCommitResult<MemoryCommandResult> {
        return runMutation(this.db, () => {
            const source = requireCurrentMutableMemory(this.db, input);
            const target = getMemoriesByProject(this.db, source.projectPath, ["active", "permanent", "archived"])
                .find((memory) => createMemoryStateToken(memory) === input.targetStateToken);
            if (!target || target.id === source.id) throw new Error("Memory merge target was not found");
            assertMutationAuthorized(target, input.actor);
            supersededMemory(this.db, source.id, target.id);
            const mutation = queueMemoryMutation(this.db, { projectPath: source.projectPath, mutationType: "superseded", targetMemoryId: source.id, supersededById: target.id });
            return { value: result(this.db, source.projectPath, target.id), committedMemoryMutationId: mutation.id };
        });
    }

    private requireMemoryByStateToken(
        input: Omit<MemoryCommandMutationInput, "id">,
    ): Memory {
        requireProjectPath(input.projectPath);
        const memory = getMemoriesByProject(this.db, input.projectPath, ["active", "permanent", "archived"])
            .find((candidate) => createMemoryStateToken(candidate) === input.stateToken);
        if (!memory) throw new Error("Memory state token was not found or is stale");
        assertMutationAuthorized(memory, input.actor);
        return memory;
    }

    private transitionWithCommitReceipt(
        input: MemoryCommandMutationInput,
        status: MemoryStatus,
        mutationType?: "archive",
        reason?: string,
    ): MemoryCommandCommitResult<MemoryCommandResult> {
        return runMutation(this.db, () => {
            const memory = requireCurrentMutableMemory(this.db, input);
            if (mutationType === "archive") archiveMemory(this.db, memory.id, reason);
            else updateMemoryStatus(this.db, memory.id, status);
            const mutation = queueMemoryMutation(this.db, {
                projectPath: memory.projectPath, mutationType: mutationType ?? "update", targetMemoryId: memory.id,
                category: mutationType ? undefined : "__mc_visibility__",
            });
            return { value: result(this.db, input.projectPath, memory.id), committedMemoryMutationId: mutation.id };
        });
    }
}
