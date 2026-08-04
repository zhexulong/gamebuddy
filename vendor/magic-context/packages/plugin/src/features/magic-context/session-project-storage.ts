import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { isUserHomeDirectory } from "./memory/project-identity";

const SESSION_CHUNK_REPAIR_BATCH_SIZE = 100;

const upsertSessionProjectStatements = new WeakMap<Database, PreparedStatement>();
const repairSessionChunkProjectStatements = new WeakMap<Database, PreparedStatement>();
const repairProjectChunkProjectStatements = new WeakMap<Database, PreparedStatement>();

function getUpsertSessionProjectStatement(db: Database): PreparedStatement {
    let stmt = upsertSessionProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id, harness) DO UPDATE SET
                 project_path = excluded.project_path,
                 updated_at = excluded.updated_at
             WHERE session_projects.project_path <> excluded.project_path`,
        );
        upsertSessionProjectStatements.set(db, stmt);
    }
    return stmt;
}

function getRepairSessionChunkProjectStatement(db: Database): PreparedStatement {
    let stmt = repairSessionChunkProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `UPDATE compartment_chunk_embeddings
             SET project_path = ?
             WHERE id IN (
                 SELECT id
                 FROM compartment_chunk_embeddings
                 WHERE session_id = ?
                   AND harness = ?
                   AND project_path <> ?
                 LIMIT ?
             )`,
        );
        repairSessionChunkProjectStatements.set(db, stmt);
    }
    return stmt;
}

function getRepairProjectChunkProjectStatement(db: Database): PreparedStatement {
    let stmt = repairProjectChunkProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `UPDATE compartment_chunk_embeddings
             SET project_path = (
                 SELECT sp.project_path
                 FROM session_projects sp
                 WHERE sp.session_id = compartment_chunk_embeddings.session_id
                   AND sp.harness = compartment_chunk_embeddings.harness
                 LIMIT 1
             )
             WHERE EXISTS (
                 SELECT 1
                 FROM session_projects sp
                 WHERE sp.session_id = compartment_chunk_embeddings.session_id
                   AND sp.harness = compartment_chunk_embeddings.harness
                   AND sp.project_path <> compartment_chunk_embeddings.project_path
                   AND (
                       sp.project_path = ?
                       OR compartment_chunk_embeddings.project_path = ?
                   )
             )`,
        );
        repairProjectChunkProjectStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Persist the immutable session→project binding resolved from the host session.
 * Chunk backfills use this mapping as the project-scope authority: without it, a
 * project-wide drain cannot safely distinguish same-process sessions from other
 * projects and must not stamp arbitrary compartments with its own identity.
 */
export function recordSessionProjectIdentity(
    db: Database,
    sessionId: string,
    projectPath: string | undefined,
): void {
    if (!sessionId || !projectPath) return;
    // A session started exactly at the user's home directory is not a project.
    // The guard is repeated here because background backfills can call this
    // function without passing through the transform resolver.
    if (
        !projectPath.startsWith("git:") &&
        !projectPath.startsWith("dir:") &&
        isUserHomeDirectory(projectPath)
    )
        return;
    const harness = getHarness();
    const now = Date.now();
    db.transaction(() => {
        getUpsertSessionProjectStatement(db).run(sessionId, harness, projectPath, now);
        // Repair a bounded slice of chunks stamped with a project other than the
        // session's recorded owner. Repeated observations resume the repair
        // without making transform wait on an unbounded update.
        getRepairSessionChunkProjectStatement(db).run(
            projectPath,
            sessionId,
            harness,
            projectPath,
            SESSION_CHUNK_REPAIR_BATCH_SIZE,
        );
    })();
}

/**
 * Idempotent project-scoped heal for historical chunk rows whose stored project
 * stamp disagrees with the recorded owner. The WHERE clause is scoped to rows
 * that either currently sit under this project or truly belong to it, so normal
 * registration/backfill paths can run it cheaply without scanning unrelated
 * project partitions for every tick.
 */
export function repairMisScopedCompartmentChunkEmbeddingsForProject(
    db: Database,
    projectPath: string,
): number {
    if (!projectPath) return 0;
    return getRepairProjectChunkProjectStatement(db).run(projectPath, projectPath).changes;
}
