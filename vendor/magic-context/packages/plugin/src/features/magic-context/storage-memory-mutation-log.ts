import type { Database } from "../../shared/sqlite";

export type MemoryMutationType = "archive" | "delete" | "update" | "superseded";

const MEMORY_MUTATION_TYPES = new Set<string>(["archive", "delete", "update", "superseded"]);
const MEMORY_VISIBILITY_MUTATION_CATEGORY = "__mc_visibility__";
const MAX_MEMORY_REPLACEMENT_DEPTH = 8;

// Terminal mutations mean the memory LEFT the active set (renders as
// <removed>/<superseded>). `update` is non-terminal — the memory is still
// present with new content (renders as <updated>). The render fold gives
// terminal states precedence over a later `update` so an update queued after an
// archive/delete cannot resurrect a memory that is gone (archive is deliberate;
// un-archive happens via an epoch-bump full re-materialize, never via the log).
const TERMINAL_MUTATION_TYPES = new Set<MemoryMutationType>(["archive", "delete", "superseded"]);

function isTerminalMutation(row: MemoryMutationLogRow): boolean {
    return TERMINAL_MUTATION_TYPES.has(row.mutationType);
}

export interface MemoryMutationLogRow {
    id: number;
    projectPath: string;
    mutationType: MemoryMutationType;
    targetMemoryId: number;
    supersededById: number | null;
    category: string | null;
    newContent: string | null;
    visibilityChanged: boolean;
    queuedAt: number;
}

interface MemoryMutationLogDbRow {
    id: number;
    project_path: string;
    mutation_type: MemoryMutationType;
    target_memory_id: number;
    superseded_by_id: number | null;
    category: string | null;
    new_content: string | null;
    queued_at: number;
}

function assertMemoryMutationType(
    mutationType: string,
): asserts mutationType is MemoryMutationType {
    if (!MEMORY_MUTATION_TYPES.has(mutationType)) {
        throw new Error(`Invalid memory mutation type: ${mutationType}`);
    }
}

function toMemoryMutation(row: MemoryMutationLogDbRow): MemoryMutationLogRow {
    return {
        id: row.id,
        projectPath: row.project_path,
        mutationType: row.mutation_type,
        targetMemoryId: row.target_memory_id,
        supersededById: row.superseded_by_id,
        category: row.category,
        newContent: row.new_content,
        visibilityChanged: row.category === MEMORY_VISIBILITY_MUTATION_CATEGORY,
        queuedAt: row.queued_at,
    };
}

export function queueMemoryMutation(
    db: Database,
    input: {
        projectPath: string;
        mutationType: MemoryMutationType;
        targetMemoryId: number;
        supersededById?: number | null;
        category?: string | null;
        newContent?: string | null;
        queuedAt?: number;
    },
): MemoryMutationLogRow {
    assertMemoryMutationType(input.mutationType);
    const result = db
        .prepare(
            `INSERT INTO memory_mutation_log
                (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            input.projectPath,
            input.mutationType,
            input.targetMemoryId,
            input.supersededById ?? null,
            input.category ?? null,
            input.newContent ?? null,
            input.queuedAt ?? Date.now(),
        ) as {
        lastInsertRowid?: number | bigint;
    };
    const row = getMemoryMutation(db, Number(result.lastInsertRowid));
    if (!row) {
        throw new Error("Failed to load queued memory mutation");
    }
    return row;
}

export function getMemoryMutation(db: Database, id: number): MemoryMutationLogRow | null {
    const row = db
        .prepare(
            `SELECT id, project_path, mutation_type, target_memory_id,
                    superseded_by_id, category, new_content, queued_at
               FROM memory_mutation_log
              WHERE id = ?`,
        )
        .get(id) as MemoryMutationLogDbRow | undefined;
    return row ? toMemoryMutation(row) : null;
}

function uniqueProjectPaths(projectPaths: readonly string[]): string[] {
    return [...new Set(projectPaths.filter((path) => path.length > 0))];
}

function placeholders(values: readonly unknown[]): string {
    return values.map(() => "?").join(", ");
}

function coalesceMutations(rows: MemoryMutationLogDbRow[]): MemoryMutationLogRow[] {
    const chosenByTarget = new Map<number, MemoryMutationLogRow>();
    for (const dbRow of rows) {
        const candidate = toMemoryMutation(dbRow);
        const current = chosenByTarget.get(candidate.targetMemoryId);
        if (!current) {
            chosenByTarget.set(candidate.targetMemoryId, candidate);
            continue;
        }
        const visibilityChanged = current.visibilityChanged || candidate.visibilityChanged;
        const currentTerminal = isTerminalMutation(current);
        const candidateTerminal = isTerminalMutation(candidate);
        if (currentTerminal && !candidateTerminal) {
            chosenByTarget.set(candidate.targetMemoryId, { ...current, visibilityChanged });
            continue;
        }
        chosenByTarget.set(candidate.targetMemoryId, { ...candidate, visibilityChanged });
    }
    return [...chosenByTarget.values()].sort((left, right) => left.id - right.id);
}

function getMemoryMutationsForRenderByIdentitySet(
    db: Database,
    projectPaths: readonly string[],
    afterId: number | null | undefined,
    renderedMemoryIds: readonly number[],
): MemoryMutationLogRow[] {
    const identities = uniqueProjectPaths(projectPaths);
    if (identities.length === 0) return [];
    const cursor = afterId ?? 0;
    const visibilityTargets = db
        .prepare(
            `SELECT DISTINCT target_memory_id
               FROM memory_mutation_log
              WHERE project_path IN (${placeholders(identities)})
                AND id > ?
                AND category = ?`,
        )
        .all(...identities, cursor, MEMORY_VISIBILITY_MUTATION_CATEGORY) as Array<{
        target_memory_id: number;
    }>;
    const requestedTargets = new Set(renderedMemoryIds);
    for (const row of visibilityTargets) requestedTargets.add(row.target_memory_id);
    if (requestedTargets.size === 0) return [];

    const queried = new Set<number>();
    let frontier = [...requestedTargets].sort((left, right) => left - right);
    const loaded: MemoryMutationLogDbRow[] = [];
    for (let depth = 0; depth <= MAX_MEMORY_REPLACEMENT_DEPTH; depth += 1) {
        frontier = frontier.filter((target) => {
            if (queried.has(target)) return false;
            queried.add(target);
            return true;
        });
        if (frontier.length === 0) break;
        const batch = db
            .prepare(
                `SELECT id, project_path, mutation_type, target_memory_id,
                        superseded_by_id, category, new_content, queued_at
                   FROM memory_mutation_log
                  WHERE project_path IN (${placeholders(identities)})
                    AND id > ?
                    AND target_memory_id IN (${placeholders(frontier)})
                  ORDER BY id ASC`,
            )
            .all(...identities, cursor, ...frontier) as MemoryMutationLogDbRow[];
        loaded.push(...batch);
        frontier = coalesceMutations(batch)
            .filter((mutation) => mutation.mutationType === "superseded")
            .flatMap((mutation) =>
                mutation.supersededById === null ? [] : [mutation.supersededById],
            );
    }

    const byTarget = new Map(
        coalesceMutations(loaded).map((mutation) => [mutation.targetMemoryId, mutation] as const),
    );
    const resolved: MemoryMutationLogRow[] = [];
    for (const target of [...requestedTargets].sort((left, right) => left - right)) {
        const mutation = byTarget.get(target);
        if (!mutation) continue;
        if (mutation.mutationType !== "superseded") {
            resolved.push(mutation);
            continue;
        }
        let terminal = mutation.supersededById;
        const visited = new Set([target]);
        let depth = 0;
        while (terminal !== null) {
            if (visited.has(terminal)) {
                terminal = null;
                break;
            }
            visited.add(terminal);
            const next = byTarget.get(terminal);
            if (next?.mutationType !== "superseded") break;
            if (depth >= MAX_MEMORY_REPLACEMENT_DEPTH - 1) {
                terminal = null;
                break;
            }
            terminal = next.supersededById;
            depth += 1;
        }
        resolved.push({ ...mutation, supersededById: terminal });
    }
    return resolved.sort((left, right) => left.id - right.id);
}

export function getMemoryMutationsForRender(
    db: Database,
    projectPath: string,
    afterId: number | null | undefined,
    renderedMemoryIds: readonly number[],
): MemoryMutationLogRow[] {
    return getMemoryMutationsForRenderByIdentitySet(db, [projectPath], afterId, renderedMemoryIds);
}

export function getMemoryMutationsForRenderByProjects(
    db: Database,
    projectPaths: readonly string[],
    afterId: number | null | undefined,
    renderedMemoryIds: readonly number[],
): MemoryMutationLogRow[] {
    return getMemoryMutationsForRenderByIdentitySet(db, projectPaths, afterId, renderedMemoryIds);
}

export function getMaxMemoryMutationId(db: Database, projectPath: string): number | null {
    const row = db
        .prepare("SELECT MAX(id) AS max_id FROM memory_mutation_log WHERE project_path = ?")
        .get(projectPath) as { max_id: number | null } | undefined;
    return row?.max_id ?? null;
}

export function getMaxMemoryMutationIdForProjects(
    db: Database,
    projectPaths: readonly string[],
): number | null {
    const identities = uniqueProjectPaths(projectPaths);
    if (identities.length === 0) return null;
    if (identities.length === 1) return getMaxMemoryMutationId(db, identities[0]);
    const row = db
        .prepare(
            `SELECT MAX(id) AS max_id
               FROM memory_mutation_log
              WHERE project_path IN (${placeholders(identities)})`,
        )
        .get(...identities) as { max_id: number | null } | undefined;
    return row?.max_id ?? null;
}
