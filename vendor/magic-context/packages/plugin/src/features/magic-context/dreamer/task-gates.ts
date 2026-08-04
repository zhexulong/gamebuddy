import type { Database } from "../../../shared/sqlite";
import {
    getSmartNotesNeedingCompilation,
    getStaleCompiledSmartNotes,
} from "../smart-notes/storage";
import { getPendingSmartNotes } from "../storage-notes";
import { countPrimerCandidatesForProject, getActivePrimers } from "../storage-primers";
import { getUserMemoryCandidates } from "../user-memory/storage-user-memory";
import type { DreamTaskName } from "./task-registry";

/**
 * Per-task activity gates (Dreamer v2 A+B). A due task runs ONLY if its gate
 * passes, so cron cadence never burns a 60-turn agentic loop on an unchanged
 * pool. Gates are conservative — allow when uncertain — and cheap (count
 * queries, no full-row loads, no LLM).
 *
 * `lastRunAt` is the task's own `task_schedule_state.last_run_at` (null = never
 * run → treat "changed since" gates as "is there anything at all").
 */

export interface TaskGateContext {
    db: Database;
    projectIdentity: string;
    lastRunAt: number | null;
    /** retrospective content watermark (max message ts scanned). Distinct from
     *  lastRunAt: a session updated mid-run is newer than its scanned content but
     *  older than the run-completion time, so gating on lastRunAt would skip it. */
    retrospectiveWatermarkMs?: number | null;
    /** review-user-memories: min candidate observations before a review is worthwhile. */
    promotionThreshold: number;
}

function countActiveMemories(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            "SELECT COUNT(*) AS cnt FROM memories WHERE project_path = ? AND status IN ('active','permanent')",
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

/** Active/permanent memories with NO mapping row yet — the map-memories scope. */
function countUnmappedActiveMemories(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM memories m
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND NOT EXISTS (
                    SELECT 1 FROM memory_verifications v WHERE v.memory_id = m.id
                )`,
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

function countCompartmentsSince(db: Database, projectPath: string, since: number): number {
    // Compartments are keyed by session_id; map to project via session_projects.
    const row = db
        .prepare<[string, number], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM compartments c
               JOIN session_projects sp ON sp.session_id = c.session_id
              WHERE sp.project_path = ? AND c.created_at > ?`,
        )
        .get(projectPath, since);
    return row?.cnt ?? 0;
}

function countProjectSessionsSince(
    db: Database,
    projectPath: string,
    since: number | null,
): number {
    const row =
        since === null
            ? db
                  .prepare<[string], { cnt: number }>(
                      "SELECT COUNT(*) AS cnt FROM session_projects WHERE project_path = ?",
                  )
                  .get(projectPath)
            : db
                  .prepare<[string, number], { cnt: number }>(
                      "SELECT COUNT(*) AS cnt FROM session_projects WHERE project_path = ? AND updated_at > ?",
                  )
                  .get(projectPath, since);
    return row?.cnt ?? 0;
}

/**
 * Evaluate a task's activity gate. Returns true if the task has work to do.
 * Throwing DB errors propagate to the caller (a gate that can't read is a real
 * problem, not silently "no work").
 */
export function evaluateTaskGate(task: DreamTaskName, ctx: TaskGateContext): boolean {
    const { db, projectIdentity: project, lastRunAt } = ctx;
    switch (task) {
        case "map-memories":
            // Runs only while UNMAPPED active memories exist — the one-time-style
            // backfill that drains the pool then no-ops. Cheap: a single NOT-IN
            // count against the verification side-table.
            return countUnmappedActiveMemories(db, project) > 0;

        case "verify":
            // The executor's file gate does the precise incremental partition; the
            // scheduler only avoids taking the memory lease when there is no pool.
            return countActiveMemories(db, project) > 0;

        case "verify-broad":
            // Broad re-verifies the WHOLE pool (incl. file-independent memories the
            // incremental gate skips) — only needs a non-empty pool to run.
            return countActiveMemories(db, project) > 0;

        case "curate":
            // Curate is whole-pool hygiene, but still needs an active pool before
            // taking the shared memory lease.
            return countActiveMemories(db, project) > 0;

        case "compress-cues":
            // Cheap pre-gate: only take the memory lease when a pool exists. The
            // executor's selectCandidates does the precise NULL/stale-hash cue
            // partition and no-ops when everything is already compressed.
            return countActiveMemories(db, project) > 0;

        case "classify-memories":
            // Classification scores the active project memory pool directly. It has
            // no file gate, watermark, or completeness prerequisites.
            return countActiveMemories(db, project) > 0;

        case "retrospective":
            // Cheap pre-gate: any project session updated since the CONTENT
            // watermark (max message ts actually scanned), not lastRunAt — a
            // session updated mid-run would otherwise be skipped. The executor's
            // raw provider does the precise typed-user-message scan and bails
            // before any child session if empty. Never-run → "sessions exist".
            return countProjectSessionsSince(db, project, ctx.retrospectiveWatermarkMs ?? null) > 0;

        case "maintain-docs":
            // New compartments since the last maintain-docs run. Never-run → any exist.
            return countCompartmentsSince(db, project, lastRunAt ?? 0) > 0;

        case "evaluate-smart-notes":
            return (
                getSmartNotesNeedingCompilation(db, project, Date.now(), 1).length > 0 ||
                getStaleCompiledSmartNotes(db, project, Date.now(), 1).length > 0 ||
                getPendingSmartNotes(db, project).some((note) => note.checkStatus === "fallback")
            );

        case "review-user-memories":
            // Candidate observations are GLOBAL (cross-project user profile).
            return getUserMemoryCandidates(db).length >= ctx.promotionThreshold;

        case "promote-primers":
            return countPrimerCandidatesForProject(db, project) >= (ctx.promotionThreshold ?? 2);

        case "refresh-primers":
            return getActivePrimers(db, project).some(
                (primer) =>
                    !primer.answer.trim() ||
                    primer.answerRefreshedAt == null ||
                    (primer.lastObservedAt ?? 0) > primer.answerRefreshedAt,
            );

        default: {
            const _exhaustive: never = task;
            return Boolean(_exhaustive);
        }
    }
}
