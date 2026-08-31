import type { PluginContext } from "../../../plugin/types";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import type { DreamTaskName } from "./task-registry";

type OpencodeClient = PluginContext["client"];

/**
 * Age-gated backstop for internal children that carry raw user or project text.
 *
 * Historian children deliberately remain after prompt completion because OpenCode
 * can still have detached writers persisting their final parts. Dreamer children
 * normally delete themselves in `finally`, but a hard SIGKILL/OOM can orphan them.
 * This sweep is the safe retirement path for both cases.
 *
 * CONCURRENCY: `session.delete` has no cross-process "active session" lease (OC
 * peer confirmed), so the ONLY safe filter is AGE — a child older than any
 * legitimate run cannot belong to a live run on another OpenCode process.
 * OpenCode sets `title` + `time_created` immediately at create (not lazily), so
 * the age gate is airtight. 404 on delete = already-swept = success.
 */
export const HISTORIAN_CHILD_TITLE = "magic-context-compartment";
export const RETROSPECTIVE_CHILD_TITLE = "magic-context-dream-retrospective";
export const USER_MEMORIES_CHILD_TITLE = "magic-context-dream-user-memories";
export const CURATE_CHILD_TITLE = "magic-context-dream-curate";
export const MAINTAIN_DOCS_CHILD_TITLE = "magic-context-dream-maintain-docs";
export const REFRESH_PRIMERS_CHILD_TITLE = "magic-context-dream-refresh-primers";
export const SMART_NOTE_COMPILE_CHILD_TITLE_PREFIX = "magic-context-smart-note-compile-";
export const SMART_NOTE_CONFIRM_CHILD_TITLE_PREFIX = "magic-context-smart-note-confirm-";

export const PRIVACY_SENSITIVE_CHILD_TASKS = [
    "retrospective",
    "review-user-memories",
    "curate",
    "maintain-docs",
    "refresh-primers",
    "evaluate-smart-notes",
] as const satisfies readonly DreamTaskName[];

export interface PrivacySensitiveChildTitleMatches {
    exact: readonly string[];
    prefixes: readonly string[];
}

export const PRIVACY_SENSITIVE_CHILD_TITLE_MATCHES: PrivacySensitiveChildTitleMatches = {
    exact: [
        RETROSPECTIVE_CHILD_TITLE,
        USER_MEMORIES_CHILD_TITLE,
        CURATE_CHILD_TITLE,
        MAINTAIN_DOCS_CHILD_TITLE,
        REFRESH_PRIMERS_CHILD_TITLE,
    ],
    prefixes: [SMART_NOTE_COMPILE_CHILD_TITLE_PREFIX, SMART_NOTE_CONFIRM_CHILD_TITLE_PREFIX],
};

export const HISTORIAN_CHILD_TITLE_MATCHES: PrivacySensitiveChildTitleMatches = {
    exact: [HISTORIAN_CHILD_TITLE],
    prefixes: [],
};

export const INTERNAL_CHILD_TITLE_MATCHES: PrivacySensitiveChildTitleMatches = {
    exact: [HISTORIAN_CHILD_TITLE, ...PRIVACY_SENSITIVE_CHILD_TITLE_MATCHES.exact],
    prefixes: PRIVACY_SENSITIVE_CHILD_TITLE_MATCHES.prefixes,
};

/** Stale threshold from task timeout(s): max(60min, maxTimeout×3) — comfortably
 *  past every swept child type so a live child is never swept. */
export function retrospectiveOrphanStaleMs(
    taskTimeoutMinutes: number | undefined | readonly (number | undefined)[],
): number {
    const timeoutCandidates = Array.isArray(taskTimeoutMinutes)
        ? taskTimeoutMinutes
        : [taskTimeoutMinutes];
    const maxTimeoutMinutes = Math.max(
        ...timeoutCandidates.map((minutes) => Math.max(1, minutes ?? 20)),
        20,
    );
    const timeoutMs = maxTimeoutMinutes * 60_000;
    return Math.max(60 * 60_000, timeoutMs * 3);
}

const HISTORIAN_OUTER_ATTEMPTS = 3;
const HISTORIAN_MODEL_SUGGESTION_ATTEMPTS = 2;
const HISTORIAN_MAX_RETRY_BACKOFF_MS = 11_000;
const HISTORIAN_DETACHED_WRITER_GRACE_MS = 15 * 60_000;

/**
 * Keep a historian child past its worst-case prompt budget. Each outer attempt
 * may traverse the primary plus every configured fallback, and every model can
 * consume a second timeout while following OpenCode's model-name suggestion.
 */
export function historianOrphanStaleMs(timeoutMs: number, fallbackModelCount: number): number {
    const timeout = Math.max(60_000, timeoutMs);
    const fallbackCount = Math.max(0, Math.floor(fallbackModelCount));
    const fullAttemptBudget =
        timeout *
        HISTORIAN_OUTER_ATTEMPTS *
        HISTORIAN_MODEL_SUGGESTION_ATTEMPTS *
        (fallbackCount + 1);
    return Math.max(
        60 * 60_000,
        fullAttemptBudget + HISTORIAN_MAX_RETRY_BACKOFF_MS + HISTORIAN_DETACHED_WRITER_GRACE_MS,
    );
}

interface OrphanRow {
    id: string;
    time_created: number;
}

/**
 * Delete stale internal children for THIS project directory when they are older
 * than `staleMs`. Best-effort + fail-open: any
 * DB/schema/API error is logged and skipped (never throws into the caller's
 * sweep). Returns the count deleted.
 */
export async function sweepOrphanedRetrospectiveChildren(args: {
    opencodeDb: Database | null;
    client: OpencodeClient;
    sessionDirectory: string;
    staleMs: number;
    titleMatches?: PrivacySensitiveChildTitleMatches;
    now?: number;
    keepSubagents?: boolean;
}): Promise<number> {
    const { opencodeDb, client, sessionDirectory, staleMs } = args;
    const titleMatches = args.titleMatches ?? INTERNAL_CHILD_TITLE_MATCHES;
    if (!opencodeDb || args.keepSubagents === true) return 0;
    const now = args.now ?? Date.now();
    const cutoff = now - staleMs;

    const exactClauses = titleMatches.exact.length
        ? [`title IN (${titleMatches.exact.map(() => "?").join(", ")})`]
        : [];
    const prefixClauses = titleMatches.prefixes.map(() => "title LIKE ?");
    const titleClauses = [...exactClauses, ...prefixClauses];
    if (titleClauses.length === 0) return 0;
    const titleParams = [
        ...titleMatches.exact,
        ...titleMatches.prefixes.map((prefix) => `${prefix}%`),
    ];

    let rows: OrphanRow[];
    try {
        rows = opencodeDb
            .prepare(
                `SELECT id, time_created
                   FROM session
                  WHERE (${titleClauses.join(" OR ")})
                    AND directory = ?
                    AND time_created < ?
                  ORDER BY time_created ASC
                  LIMIT 200`,
            )
            .all(...titleParams, sessionDirectory, cutoff) as OrphanRow[];
    } catch (error) {
        // `session` table absent / schema drift / locked → skip silently.
        log(`[magic-context] internal child orphan sweep: read skipped (${String(error)})`);
        return 0;
    }
    if (rows.length === 0) return 0;

    let deleted = 0;
    for (const row of rows) {
        try {
            await client.session.delete({ path: { id: row.id } });
            deleted += 1;
        } catch {
            // 404 / already removed by another sweeper / transient → treat as done.
            deleted += 1;
        }
    }
    if (deleted > 0) {
        log(`[magic-context] swept ${deleted} stale internal child session(s)`);
    }
    return deleted;
}
