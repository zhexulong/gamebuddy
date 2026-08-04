import path from "node:path";

import type { Database } from "../../../shared/sqlite";
import {
    getMemoriesByProject,
    getMemoryVerifications,
    readGitChangedFilesSince,
    readGitFileChangeTimesSince,
    readGitHead,
    resolveGitTopLevel,
    verificationFileExists,
} from "../memory";
import type { VerifyPromptMemory } from "./verify-prompt";

/**
 * Per-memory verify scope (DreamerV2 rework).
 *
 * Replaces the old GLOBAL commit-watermark + all-or-nothing coverage gate. Now
 * each memory carries its own `verified_at` (set by the verify apply), so:
 *  - partial progress STICKS: a timed-out verify banks the memories it checked;
 *    the next run skips them and continues (the cold-start trap is gone).
 *  - there is no watermark to advance and no coverage check.
 *
 * Scope = active memories that have a REAL backing-file mapping (recorded by the
 * map-memories backfill). Excluded:
 *  - file-independent memories (no-file sentinel) — they describe external
 *    behavior and cannot be checked against local code; curate + age decay own
 *    them.
 *  - unmapped memories — map-memories maps them first; once mapped they enter
 *    verify scope as never-verified (verified_at = 0).
 *
 * Modes:
 *  - `verify` (incremental, default): a candidate is in scope if it was never
 *    content-verified (verified_at = 0) OR any mapped file changed since THAT
 *    memory's verified_at (committed change-time newer, an uncommitted edit, or
 *    the file was deleted).
 *  - `verify-broad` (`forceBroad`): every candidate, regardless of change time —
 *    full-pool drift catching over the file-mapped memories.
 */

export interface VerifyGateResult {
    runStartedAt: number;
    mode: "non-git" | "full" | "broad" | "incremental";
    inScope: VerifyPromptMemory[];
    inScopeIds: number[];
    skippedIds: number[];
    reason: string;
}

/** Min of a numeric list without spread (avoids RangeError on large pools). */
function minOf(values: readonly number[]): number {
    return values.reduce((acc, v) => (v < acc ? v : acc), Number.POSITIVE_INFINITY);
}

export async function partitionVerifyScope(args: {
    db: Database;
    projectIdentity: string;
    projectDirectory: string;
    forceBroad?: boolean;
    now?: number;
}): Promise<VerifyGateResult> {
    const runStartedAt = args.now ?? Date.now();
    const active = getMemoriesByProject(args.db, args.projectIdentity);
    const verById = getMemoryVerifications(
        args.db,
        active.map((m) => m.id),
    );

    // Candidates: active memories WITH a real backing-file mapping. A memory with
    // only the no-file sentinel (file-independent) or no mapping row at all is
    // excluded — see the doc comment.
    const candidates = active.filter((m) => (verById.get(m.id)?.files.length ?? 0) > 0);

    const toPrompt = (m: (typeof active)[number]): VerifyPromptMemory => ({
        id: m.id,
        category: m.category,
        content: m.content,
        mappedFiles: verById.get(m.id)?.files ?? [],
    });

    if (candidates.length === 0) {
        return {
            runStartedAt,
            mode: "incremental",
            inScope: [],
            inScopeIds: [],
            skippedIds: [],
            reason: "no file-mapped memories in scope",
        };
    }

    // verify-broad: the whole file-mapped pool, regardless of change time.
    if (args.forceBroad) {
        return {
            runStartedAt,
            mode: "broad",
            inScope: candidates.map(toPrompt),
            inScopeIds: candidates.map((m) => m.id),
            skippedIds: [],
            reason: "broad full-pool verification of file-mapped memories",
        };
    }

    const allInScope = (mode: VerifyGateResult["mode"], reason: string): VerifyGateResult => ({
        runStartedAt,
        mode,
        inScope: candidates.map(toPrompt),
        inScopeIds: candidates.map((m) => m.id),
        skippedIds: [],
        reason,
    });

    const gitRoot =
        (await resolveGitTopLevel(args.projectDirectory)) ?? path.resolve(args.projectDirectory);

    // Oldest verified time among already-verified candidates bounds the git-log
    // window. Never-verified candidates (verified_at = 0) are always in scope.
    const verifiedTimes = candidates
        .map((m) => verById.get(m.id)?.verifiedAt ?? 0)
        .filter((t) => t > 0);
    const sinceMs = verifiedTimes.length > 0 ? minOf(verifiedTimes) : runStartedAt;

    const changeTimes = await readGitFileChangeTimesSince(args.projectDirectory, sinceMs);
    if (changeTimes === null) {
        // git unavailable → verify everything (safe direction: re-check vs skip).
        return allInScope("full", "git change-times unavailable; full verification");
    }
    // Also catch uncommitted working-tree edits (committed change-times miss them):
    // a mapped file with a pending edit is "changed now" → re-verify.
    const head = await readGitHead(args.projectDirectory);
    const uncommitted = head
        ? ((await readGitChangedFilesSince(args.projectDirectory, head)) ?? new Set<string>())
        : new Set<string>();

    const inScope: VerifyPromptMemory[] = [];
    const skippedIds: number[] = [];
    for (const m of candidates) {
        const v = verById.get(m.id);
        const verifiedAt = v?.verifiedAt ?? 0;
        if (verifiedAt === 0) {
            inScope.push(toPrompt(m)); // never content-verified
            continue;
        }
        const files = v?.files ?? [];
        const needs = files.some(
            (file) =>
                !verificationFileExists(gitRoot, file) || // deleted → re-check
                uncommitted.has(file) || // pending working-tree edit
                (changeTimes.get(file) ?? 0) >= verifiedAt - 1_000, // git commit times are second-granular
        );
        if (needs) inScope.push(toPrompt(m));
        else skippedIds.push(m.id);
    }

    return {
        runStartedAt,
        mode: "incremental",
        inScope,
        inScopeIds: inScope.map((m) => m.id),
        skippedIds,
        reason: `incremental verification (${inScope.length} changed of ${candidates.length} mapped)`,
    };
}
