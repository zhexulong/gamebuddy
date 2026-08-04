import { cleanUserText } from "../../../hooks/magic-context/read-session-chunk";
import { hasMeaningfulUserText } from "../../../hooks/magic-context/read-session-formatting";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { openOpenCodeDb } from "./open-opencode-db";

export const RETROSPECTIVE_MAX_MESSAGES_PER_SESSION = 80;
export const RETROSPECTIVE_MAX_MESSAGES_PER_RUN = 240;
// Cap the number of oldest eligible sessions scanned per run. The first run
// (watermark=0) would otherwise fan out over the project's entire session
// history; this bounds the scan/IO regardless of how many sessions exist.
export const RETROSPECTIVE_MAX_SESSIONS_PER_RUN = 20;

export type RetrospectiveMessageRole = "user" | "assistant" | "tool";

export interface RetrospectiveProjectSession {
    sessionId: string;
    path?: string;
    updatedAt?: number;
}

export interface RetrospectiveRawMessage {
    sessionId: string;
    ordinal: number;
    role: RetrospectiveMessageRole;
    text: string;
    toolName?: string;
    isError?: boolean;
    ts: number;
}

/** A per-session since-read. `truncated` is the EXACT saturation signal (the
 *  underlying read hit `capPerSession` with more rows available) — never inferred
 *  from `messages.length`, because normalization both drops rows (assistant/empty)
 *  and adds rows (one assistant message → many tool rows), so a length-based guess
 *  can false-NEGATIVE and lose data. */
export interface RetrospectiveSinceRead {
    messages: RetrospectiveRawMessage[];
    truncated: boolean;
}

export interface RetrospectiveRawProvider {
    listProjectSessions(
        projectIdentity: string,
    ): RetrospectiveProjectSession[] | Promise<RetrospectiveProjectSession[]>;
    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveSinceRead | Promise<RetrospectiveSinceRead>;
    /** Oldest raw message timestamp still pending per session. Providers with an
     *  indexed store use this to order the bounded session scan by true backlog
     *  frontier, not by coarse session updated_at. */
    readOldestMessageTimesSince?(
        sessionIds: readonly string[],
        sinceMs: number,
    ): Map<string, number> | Promise<Map<string, number>>;
    /** The ~`count` most recent typed USER messages at or before `beforeMs` — the
     *  run-boundary overlap so friction spanning two runs isn't missed. */
    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] | Promise<RetrospectiveRawMessage[]>;
    /** Release any reused resources (e.g. a pooled DB handle) after a run. */
    dispose?(): void;
}

interface OpenCodeRetrospectiveRawProviderDeps {
    contextDb: Database;
    openOpenCodeDb?: () => Database | null;
    /** Test-only shortcut: when provided, this connection is not closed by the provider. */
    opencodeDb?: Database;
}

interface SessionProjectRow {
    session_id: string;
    updated_at?: number | null;
}

interface OpenCodeMessageRow {
    id: string;
    data: string;
    time_created: number;
}

interface OpenCodePartRow {
    message_id: string;
    data: string;
}

export class OpenCodeRetrospectiveRawProvider implements RetrospectiveRawProvider {
    private readonly openDb: () => Database | null;
    // One read-only opencode.db handle reused across the run's per-session reads
    // (opened lazily on the first read, closed via dispose()). Avoids opening +
    // closing the DB once per session, which on a large project meant many
    // open/close cycles per scheduled run.
    private sharedDb: Database | null = null;
    private sharedDbOpened = false;

    constructor(private readonly deps: OpenCodeRetrospectiveRawProviderDeps) {
        this.openDb = deps.openOpenCodeDb ?? openOpenCodeDb;
    }

    listProjectSessions(projectIdentity: string): RetrospectiveProjectSession[] {
        // ROOT sessions only. The retrospective learns from USER friction, but a
        // subagent child (oracle / mason / historian / dreamer) has no user — its
        // "user messages" are agent-authored task prompts whose audit/spec wording
        // ("fail", "error", "wrong", "no padding") trips the frustration regex and
        // whose tool fan-out trips repeated-tool-call. In a delegation-heavy period
        // children also outnumber roots ~30:1, so a bounded session scan can be
        // entirely consumed by them and the real user session is never scanned.
        // is_subagent lives in session_meta (same DB); missing meta → treat as root.
        const rows = this.deps.contextDb
            .prepare<[string], SessionProjectRow>(
                `SELECT sp.session_id, sp.updated_at
                   FROM session_projects sp
                   LEFT JOIN session_meta m ON m.session_id = sp.session_id
                  WHERE sp.project_path = ? AND sp.harness = 'opencode'
                    AND COALESCE(m.is_subagent, 0) = 0
                  ORDER BY sp.updated_at ASC, sp.session_id ASC`,
            )
            .all(projectIdentity);
        return rows.map((row) => ({
            sessionId: row.session_id,
            updatedAt: typeof row.updated_at === "number" ? row.updated_at : undefined,
        }));
    }

    private resolveDb(): Database | null {
        if (this.deps.opencodeDb) return this.deps.opencodeDb;
        if (!this.sharedDbOpened) {
            this.sharedDbOpened = true;
            this.sharedDb = this.openDb();
        }
        return this.sharedDb;
    }

    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveSinceRead {
        const db = this.resolveDb();
        if (!db) return { messages: [], truncated: false };
        try {
            return readOpenCodeMessagesSince(db, sessionId, sinceMs, capPerSession);
        } catch {
            return { messages: [], truncated: false };
        }
    }

    readOldestMessageTimesSince(
        sessionIds: readonly string[],
        sinceMs: number,
    ): Map<string, number> {
        const db = this.resolveDb();
        if (!db || sessionIds.length === 0) return new Map();
        return readOpenCodeOldestMessageTimesSince(db, sessionIds, sinceMs);
    }

    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] {
        const db = this.resolveDb();
        if (!db) return [];
        try {
            return readOpenCodeUserMessagesBefore(db, sessionId, beforeMs, count);
        } catch {
            return [];
        }
    }

    /** Close the reused read-only handle. Safe to call multiple times. */
    dispose(): void {
        if (this.sharedDb && !this.deps.opencodeDb) {
            closeQuietly(this.sharedDb);
        }
        this.sharedDb = null;
        this.sharedDbOpened = false;
    }
}

export interface RetrospectiveScanWindow {
    /** All scanned messages (user rows + tool metadata), oldest→newest, ordinals
     *  reassigned globally. Includes the pre-watermark overlap (user-only). */
    messages: RetrospectiveRawMessage[];
    /** The max message ts ACTUALLY scanned this run (the content watermark to
     *  persist on completion). Never less than `watermarkMs` (overlap rows are
     *  ≤ watermark and cannot pull it back). */
    maxScannedTs: number;
}

/**
 * The retrospective scan window for one run: everything new since the content
 * watermark, PLUS the ~`overlapUserCount` user lines immediately before the
 * watermark for sessions that have kept new rows (so friction straddling a run
 * boundary isn't missed).
 * The since portion carries user rows + tool metadata (the deepen context); the
 * overlap portion is user-only (gate context). Ordinals are reassigned globally.
 */
export async function readRetrospectiveScanWindow(
    provider: RetrospectiveRawProvider,
    projectIdentity: string,
    watermarkMs: number,
    overlapUserCount: number,
    options?: {
        maxMessagesPerRun?: number;
        capPerSession?: number;
        maxSessionsPerRun?: number;
    },
): Promise<RetrospectiveScanWindow> {
    const maxMessages = options?.maxMessagesPerRun ?? RETROSPECTIVE_MAX_MESSAGES_PER_RUN;
    const capPerSession = options?.capPerSession ?? RETROSPECTIVE_MAX_MESSAGES_PER_SESSION;
    const sessionLimit = Math.max(
        1,
        Math.floor(options?.maxSessionsPerRun ?? RETROSPECTIVE_MAX_SESSIONS_PER_RUN),
    );
    try {
        const allSessions = await provider.listProjectSessions(projectIdentity);
        const eligibleSessions = allSessions
            .map((session, index) => ({ session, index }))
            .filter(({ session }) => (session.updatedAt ?? Number.POSITIVE_INFINITY) > watermarkMs);
        const oldestBySession = provider.readOldestMessageTimesSince
            ? await provider.readOldestMessageTimesSince(
                  eligibleSessions.map(({ session }) => session.sessionId),
                  watermarkMs,
              )
            : null;
        const sessions = (
            oldestBySession
                ? eligibleSessions.filter(({ session }) => oldestBySession.has(session.sessionId))
                : eligibleSessions
        ).sort((a, b) => {
            const aFrontier = oldestBySession?.get(a.session.sessionId);
            const bFrontier = oldestBySession?.get(b.session.sessionId);
            if (aFrontier !== undefined || bFrontier !== undefined) {
                return (
                    (aFrontier ?? Number.POSITIVE_INFINITY) -
                        (bFrontier ?? Number.POSITIVE_INFINITY) || a.index - b.index
                );
            }
            const aUpdated = a.session.updatedAt ?? Number.POSITIVE_INFINITY;
            const bUpdated = b.session.updatedAt ?? Number.POSITIVE_INFINITY;
            const byUpdated = aUpdated - bUpdated;
            return byUpdated || a.index - b.index;
        });
        const sessionsToRead = sessions.slice(0, sessionLimit).map(({ session }) => session);
        const firstExcludedSession = sessions[sessionLimit]?.session;
        const firstExcludedPendingTs = firstExcludedSession
            ? oldestBySession?.get(firstExcludedSession.sessionId)
            : undefined;
        const sinceReads: RetrospectiveSinceRead[] = [];
        if (sessionsToRead.length > 0) {
            sinceReads.push(
                ...(await Promise.all(
                    sessionsToRead.map((session) =>
                        provider.readUserMessagesSince(
                            session.sessionId,
                            watermarkMs,
                            capPerSession,
                        ),
                    ),
                )),
            );
        }

        // A TRUNCATED session read hit its per-session cap with more rows
        // available — it may hold newer (unseen) messages beyond what we got.
        // Each batch is oldest-first, so everything ≤ its last-kept ts is seen;
        // advancing the watermark past that ts would skip the unseen tail. Record
        // a safe frontier (lastKept.ts − 1, so same-ms siblings re-read next run).
        // `truncated` is the EXACT SQL-level signal — never inferred from
        // messages.length, which normalization distorts in both directions.
        let saturatedFrontier = Number.POSITIVE_INFINITY;
        for (const read of sinceReads) {
            const lastKept = read.truncated ? read.messages[read.messages.length - 1] : undefined;
            if (lastKept) {
                saturatedFrontier = Math.min(saturatedFrontier, lastKept.ts - 1);
            }
        }
        // Cap the SINCE portion OLDEST-first (so a backlog drains from the front,
        // one bounded chunk per run). Reading/capping newest-first dropped the
        // oldest friction while the watermark jumped to the newest → permanent
        // loss of the gap.
        const allSince = sinceReads
            .flatMap((read) => read.messages)
            .sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
        const keptSince = allSince.slice(0, maxMessages);
        const droppedSince = allSince.slice(maxMessages);

        // Watermark = newest KEPT ts, clamped below any INCOMPLETELY-scanned
        // frontier so the exclusive `> watermark` next-run filter can never skip
        // pending work. Three truncation sources can split the eligible backlog:
        //   • global maxMessages cap → never advance into the FIRST dropped row's
        //     ts (droppedSince[0].ts − 1); if it's strictly newer than newestKept
        //     the min() is a no-op (clean boundary).
        //   • per-session saturation → saturatedFrontier (computed above).
        //   • session cap → first excluded session's oldest pending message − 1
        //     (falling back to updated_at when a provider has no indexed frontier).
        //     The scan is oldest-frontier first, so clamping cannot starve the
        //     excluded session on the next run.
        // Take the tightest; never move backward.
        let maxScannedTs = watermarkMs;
        for (const row of keptSince) {
            if (row.ts > maxScannedTs) maxScannedTs = row.ts;
        }
        let frontier = saturatedFrontier;
        const firstDropped = droppedSince[0];
        if (firstDropped) {
            frontier = Math.min(frontier, firstDropped.ts - 1);
        }
        if (typeof firstExcludedPendingTs === "number") {
            frontier = Math.min(frontier, firstExcludedPendingTs - 1);
        } else if (typeof firstExcludedSession?.updatedAt === "number") {
            frontier = Math.min(frontier, firstExcludedSession.updatedAt - 1);
        }
        maxScannedTs = Math.max(watermarkMs, Math.min(maxScannedTs, frontier));

        const keptSessionIds = new Set(keptSince.map((message) => message.sessionId));
        const overlapSessions = sessionsToRead.filter((session) =>
            keptSessionIds.has(session.sessionId),
        );
        const overlapBatches =
            overlapUserCount > 0 && watermarkMs > 0
                ? await Promise.all(
                      overlapSessions.map((session) =>
                          provider.readUserMessagesBefore(
                              session.sessionId,
                              watermarkMs,
                              overlapUserCount,
                          ),
                      ),
                  )
                : [];

        // Merge kept-since + overlap (context only, bounded by sessions with kept
        // messages × overlapUserCount), dedupe by stable identity, oldest-first.
        // Overlap rows are ≤ watermark so they never affect maxScannedTs.
        const seen = new Set<string>();
        const merged: RetrospectiveRawMessage[] = [];
        for (const row of [...keptSince, ...overlapBatches.flat()]) {
            const key = `${row.sessionId}\u0000${row.ts}\u0000${row.role}\u0000${row.toolName ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(row);
        }
        merged.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
        return { messages: merged, maxScannedTs };
    } finally {
        provider.dispose?.();
    }
}

function readOpenCodeMessagesSince(
    db: Database,
    sessionId: string,
    sinceMs: number,
    capPerSession: number,
): RetrospectiveSinceRead {
    const limit = Math.max(1, Math.floor(capPerSession));
    // OLDEST-first: the cap must keep the OLDEST post-watermark messages so the
    // watermark advances forward through a backlog one bounded chunk per run.
    // Reading newest-first (the old behavior) dropped the oldest friction while
    // the watermark jumped to the newest → permanent loss of the gap.
    // Read limit+1 so a FULL limit is distinguishable from "exactly limit rows
    // exist" — the (limit+1)th row's existence is the exact truncation signal.
    const rows = db
        .prepare<[string, number, number], OpenCodeMessageRow>(
            `SELECT id, data, time_created
               FROM message
              WHERE session_id = ? AND time_created > ?
              ORDER BY time_created ASC, id ASC
              LIMIT ?`,
        )
        .all(sessionId, sinceMs, limit + 1);
    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;
    return { messages: normalizeOpenCodeRows(db, sessionId, kept), truncated };
}

function readOpenCodeOldestMessageTimesSince(
    db: Database,
    sessionIds: readonly string[],
    sinceMs: number,
): Map<string, number> {
    const result = new Map<string, number>();
    const uniqueIds = Array.from(new Set(sessionIds.filter((id) => id.length > 0)));
    const chunkSize = 500;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const chunk = uniqueIds.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = db
            .prepare<unknown[], { session_id: string; oldest_ts: number }>(
                `SELECT session_id, MIN(time_created) AS oldest_ts
                   FROM message
                  WHERE time_created > ? AND session_id IN (${placeholders})
                  GROUP BY session_id`,
            )
            .all(sinceMs, ...chunk);
        for (const row of rows) {
            if (typeof row.oldest_ts === "number") result.set(row.session_id, row.oldest_ts);
        }
    }
    return result;
}

/**
 * The ~N most recent typed USER messages at or before `beforeMs` (the run
 * overlap). Lets the next run re-see friction that straddles the watermark
 * boundary. Over-reads a window of mixed rows (user/assistant/tool) then keeps
 * the newest `count` USER rows. Returns user-only — it feeds the gate's U-line
 * overlap, nothing else.
 */
function readOpenCodeUserMessagesBefore(
    db: Database,
    sessionId: string,
    beforeMs: number,
    count: number,
): RetrospectiveRawMessage[] {
    const want = Math.max(1, Math.floor(count));
    const window = Math.max(want * 5, 32);
    const rows = db
        .prepare<[string, number, number], OpenCodeMessageRow>(
            `SELECT id, data, time_created
               FROM message
              WHERE session_id = ? AND time_created <= ?
              ORDER BY time_created DESC, id DESC
              LIMIT ?`,
        )
        .all(sessionId, beforeMs, window)
        .reverse();
    const userRows = normalizeOpenCodeRows(db, sessionId, rows).filter((r) => r.role === "user");
    return userRows.slice(-want);
}

function normalizeOpenCodeRows(
    db: Database,
    sessionId: string,
    rows: OpenCodeMessageRow[],
): RetrospectiveRawMessage[] {
    if (rows.length === 0) return [];

    // Restrict the part read to the capped message ids we actually kept, rather
    // than every part in the session — a long session has far more parts than
    // the newest-`capPerSession` messages we render.
    const messageIds = rows.map((row) => row.id);
    const placeholders = messageIds.map(() => "?").join(", ");
    const partRows = db
        .prepare<string[], OpenCodePartRow>(
            `SELECT message_id, data
               FROM part
              WHERE session_id = ? AND message_id IN (${placeholders})
              ORDER BY time_created ASC, id ASC`,
        )
        .all(sessionId, ...messageIds);
    const partsByMessageId = new Map<string, unknown[]>();
    for (const row of partRows) {
        const parts = partsByMessageId.get(row.message_id) ?? [];
        const parsed = parseJson(row.data);
        if (parsed !== null) parts.push(parsed);
        partsByMessageId.set(row.message_id, parts);
    }

    return rows.flatMap((row, index) => {
        const messageData = parseJsonRecord(row.data);
        if (!messageData) return [];
        if (messageData.summary === true && messageData.finish === "stop") return [];
        const role = typeof messageData.role === "string" ? messageData.role : "unknown";
        const parts = partsByMessageId.get(row.id) ?? [];
        const ordinal = index + 1;
        return normalizeOpenCodeMessage({
            sessionId,
            ordinal,
            role,
            parts,
            ts: row.time_created,
        });
    });
}

function normalizeOpenCodeMessage(args: {
    sessionId: string;
    ordinal: number;
    role: string;
    parts: unknown[];
    ts: number;
}): RetrospectiveRawMessage[] {
    const rows: RetrospectiveRawMessage[] = [];
    // PRIVACY: retrospective reads OTHER sessions' raw history. Only genuine
    // typed USER text may carry its content into the friction window — that is
    // the friction the user expressed. Assistant text and raw tool OUTPUT can
    // contain file contents / secrets / paths from prior sessions, so we never
    // emit them. Tool rows carry metadata ONLY (name + error flag), which is all
    // the friction detectors need (repeated-call / error-burst); their `text`
    // stays empty so no raw output can reach the prompt. (Pi already returns
    // user-only — this keeps the two providers aligned.)
    if (args.role === "user") {
        const text = extractGenuineUserText(args.parts);
        if (text) {
            rows.push({
                sessionId: args.sessionId,
                ordinal: args.ordinal,
                role: "user",
                text,
                ts: args.ts,
            });
        }
    }

    for (const tool of extractToolRows(args.parts)) {
        rows.push({
            sessionId: args.sessionId,
            ordinal: args.ordinal,
            role: "tool",
            text: "",
            toolName: tool.toolName,
            isError: tool.isError,
            ts: args.ts,
        });
    }

    return rows;
}

function extractGenuineUserText(parts: unknown[]): string {
    const nonSyntheticParts = parts.filter((part) => {
        if (part === null || typeof part !== "object" || Array.isArray(part)) return true;
        const record = part as Record<string, unknown>;
        return record.synthetic !== true;
    });
    if (!hasMeaningfulUserText(nonSyntheticParts)) return "";
    return extractPlainText(nonSyntheticParts)
        .map((text) => cleanUserText(text))
        .filter((text) => text.length > 0)
        .join("\n")
        .trim();
}

function extractPlainText(parts: unknown[]): string[] {
    const texts: string[] = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "text") continue;
        if (record.ignored === true || record.synthetic === true) continue;
        if (typeof record.text === "string" && record.text.trim().length > 0) {
            texts.push(record.text.trim());
        }
    }
    return texts;
}

function extractToolRows(parts: unknown[]): Array<{
    toolName: string;
    text: string;
    isError: boolean;
}> {
    const rows: Array<{ toolName: string; text: string; isError: boolean }> = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "tool" || typeof record.tool !== "string") continue;
        const state = record.state;
        const stateRecord =
            state && typeof state === "object" ? (state as Record<string, unknown>) : {};
        const output = stringifyToolOutput(stateRecord.output);
        const errorText = stringifyToolOutput(stateRecord.error);
        const status = typeof stateRecord.status === "string" ? stateRecord.status : "";
        const isError =
            stateRecord.isError === true ||
            status.toLowerCase() === "error" ||
            errorText.length > 0 ||
            /\b(error|failed|exception|traceback)\b/i.test(output);
        rows.push({
            toolName: record.tool,
            text: output || errorText || `tool ${record.tool}`,
            isError,
        });
    }
    return rows;
}

function stringifyToolOutput(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (value === null || value === undefined) return "";
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function parseJson(value: string): unknown | null {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
    const parsed = parseJson(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
}
