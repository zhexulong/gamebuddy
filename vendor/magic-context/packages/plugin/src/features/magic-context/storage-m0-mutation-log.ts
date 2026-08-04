import type { Database } from "../../shared/sqlite";

export type M0MutationType =
    | "compartment_delete"
    | "compartment_merge"
    | "recomp_boundary_change"
    | "compartment_upgrade";

const M0_MUTATION_TYPES = new Set<string>([
    "compartment_delete",
    "compartment_merge",
    "recomp_boundary_change",
    "compartment_upgrade",
]);

export interface M0MutationLogRow {
    id: number;
    sessionId: string;
    mutationType: M0MutationType;
    targetId: number | null;
    queuedAt: number;
}

interface M0MutationLogDbRow {
    id: number;
    session_id: string;
    mutation_type: M0MutationType;
    target_id: number | null;
    queued_at: number;
}

function assertMutationType(mutationType: string): asserts mutationType is M0MutationType {
    if (!M0_MUTATION_TYPES.has(mutationType)) {
        throw new Error(`Invalid m0 mutation type: ${mutationType}`);
    }
}

function toM0Mutation(row: M0MutationLogDbRow): M0MutationLogRow {
    return {
        id: row.id,
        sessionId: row.session_id,
        mutationType: row.mutation_type,
        targetId: row.target_id,
        queuedAt: row.queued_at,
    };
}

export function queueM0Mutation(
    db: Database,
    input: {
        sessionId: string;
        mutationType: M0MutationType;
        targetId?: number | null;
        queuedAt?: number;
    },
): M0MutationLogRow {
    assertMutationType(input.mutationType);
    const result = db
        .prepare(
            `INSERT INTO m0_mutation_log (session_id, mutation_type, target_id, queued_at)
             VALUES (?, ?, ?, ?)`,
        )
        .run(
            input.sessionId,
            input.mutationType,
            input.targetId ?? null,
            input.queuedAt ?? Date.now(),
        ) as {
        lastInsertRowid?: number | bigint;
    };
    const row = getM0Mutation(db, Number(result.lastInsertRowid));
    if (!row) {
        throw new Error("Failed to load queued m0 mutation");
    }
    return row;
}

export function getM0Mutation(db: Database, id: number): M0MutationLogRow | null {
    const row = db
        .prepare(
            `SELECT id, session_id, mutation_type, target_id, queued_at
             FROM m0_mutation_log
             WHERE id = ?`,
        )
        .get(id) as M0MutationLogDbRow | undefined;
    return row ? toM0Mutation(row) : null;
}

export function getM0MutationsBySession(db: Database, sessionId: string): M0MutationLogRow[] {
    const rows = db
        .prepare(
            `SELECT id, session_id, mutation_type, target_id, queued_at
             FROM m0_mutation_log
             WHERE session_id = ?
             ORDER BY id ASC`,
        )
        .all(sessionId) as M0MutationLogDbRow[];
    return rows.map(toM0Mutation);
}

export function getM0MutationsAfterId(
    db: Database,
    sessionId: string,
    afterId: number,
): M0MutationLogRow[] {
    const rows = db
        .prepare(
            `SELECT id, session_id, mutation_type, target_id, queued_at
             FROM m0_mutation_log
             WHERE session_id = ? AND id > ?
             ORDER BY id ASC`,
        )
        .all(sessionId, afterId) as M0MutationLogDbRow[];
    return rows.map(toM0Mutation);
}

export function getMaxM0MutationId(db: Database, sessionId: string): number | null {
    const row = db
        .prepare("SELECT MAX(id) AS max_id FROM m0_mutation_log WHERE session_id = ?")
        .get(sessionId) as { max_id: number | null } | undefined;
    return row?.max_id ?? null;
}

export function deleteM0Mutation(db: Database, id: number): boolean {
    const result = db.prepare("DELETE FROM m0_mutation_log WHERE id = ?").run(id) as {
        changes?: number;
    };
    return (result.changes ?? 0) > 0;
}

export function clearM0MutationsForSession(db: Database, sessionId: string): number {
    const result = db
        .prepare("DELETE FROM m0_mutation_log WHERE session_id = ?")
        .run(sessionId) as {
        changes?: number;
    };
    return result.changes ?? 0;
}
