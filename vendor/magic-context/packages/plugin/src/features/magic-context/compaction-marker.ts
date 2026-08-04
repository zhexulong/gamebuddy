/**
 * Compaction Marker Injection
 *
 * Injects compaction boundaries into OpenCode's SQLite DB so that
 * `filterCompacted` stops at the historian boundary. After injection,
 * the transform hook receives only post-boundary messages instead
 * of the full session history.
 *
 * Always-on as of v0.21.4. Previously gated behind `compaction_markers`
 * config (default true since v0.9.0); the knob was removed because the
 * feature is required for sane transform performance.
 *
 * ## What gets injected (3 rows):
 * 1. A `compaction` part on the boundary user message
 * 2. A summary assistant message with `parentID` → boundary user message
 * 3. A text part on that summary message containing a static placeholder
 *
 * The real `<session-history>` is injected by the transform pipeline via
 * inject-compartments.ts. The marker exists solely to make filterCompacted
 * stop at the boundary.
 *
 * ## How OpenCode's filterCompacted works:
 * - Iterates newest→oldest
 * - Stops when it finds a user message that:
 *   (a) has a part with type: "compaction"
 *   (b) has a completed summary assistant response (summary: true, finish: "stop")
 *       whose parentID matches that user message's id
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../../shared/data-path";
import { log } from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";

// ── ID Generation ────────────────────────────────────────────────

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_PREFIX_HEX_LENGTH = 12;
const ID_SUFFIX_LENGTH = 14;
const ID_PREFIX_MASK = (1n << BigInt(ID_PREFIX_HEX_LENGTH * 4)) - 1n;

function deterministicBase62(seed: string, length: number): string {
    let value = BigInt(`0x${createHash("sha256").update(seed).digest("hex")}`);
    const chars = Array<string>(length);
    for (let index = length - 1; index >= 0; index -= 1) {
        chars[index] = BASE62_CHARS[Number(value % 62n)];
        value /= 62n;
    }
    return chars.join("");
}

/**
 * Generate an OpenCode-compatible ascending ID.
 * Format: `prefix_[12-hex-chars][14-deterministic-base62]`.
 * The time prefix preserves OpenCode's lexicographic ordering, while the hash
 * suffix makes retries for the same marker identity converge on the same rows.
 */
function generateId(
    prefix: string,
    timestampMs: number,
    counter: bigint,
    identity: string,
): string {
    const encoded =
        (BigInt(Math.max(0, Math.floor(timestampMs))) * 0x1000n + counter) & ID_PREFIX_MASK;
    const hex = encoded.toString(16).padStart(ID_PREFIX_HEX_LENGTH, "0");
    return `${prefix}_${hex}${deterministicBase62(`${prefix}\0${identity}`, ID_SUFFIX_LENGTH)}`;
}

export function generateMessageId(timestampMs: number, counter = 0n, identity = ""): string {
    return generateId("msg", timestampMs, counter, identity);
}

export function generatePartId(timestampMs: number, counter = 0n, identity = ""): string {
    return generateId("prt", timestampMs, counter, identity);
}

// ── DB Access ────────────────────────────────────────────────────

export function getOpenCodeDbPath(): string {
    return join(getDataDir(), "opencode", "opencode.db");
}

let cachedWriteDb: { path: string; db: Database } | null = null;

// Columns we INSERT into OpenCode's `message` and `part` tables. Kept in sync
// with the INSERT statements in injectCompactionMarker() below. If OpenCode
// ever renames/drops any of these columns, our INSERTs will fail at runtime —
// the schema probe below detects that BEFORE we try to write, so we fail
// cleanly instead of leaving half-written marker state in OpenCode's DB.
const REQUIRED_MESSAGE_COLUMNS = ["id", "session_id", "time_created", "time_updated", "data"];
const REQUIRED_PART_COLUMNS = [
    "id",
    "message_id",
    "session_id",
    "time_created",
    "time_updated",
    "data",
];

/**
 * Cache of schema-compatibility probe results per DB path.
 * null = not yet probed, true = compatible, false = incompatible (bail).
 */
let cachedSchemaCompatible: { path: string; compatible: boolean } | null = null;

/**
 * Probe OpenCode's `message` and `part` tables to verify they have the exact
 * columns our INSERTs reference. OpenCode uses Drizzle migrations and has
 * already shipped several schema updates; any future rename or column drop
 * would make our write silently fail at runtime. Probing once per cached-db
 * lifetime (startup + process restart) keeps the hot path cost at zero after
 * the first call.
 */
function isOpenCodeSchemaCompatible(db: Database, dbPath: string): boolean {
    if (cachedSchemaCompatible?.path === dbPath) {
        return cachedSchemaCompatible.compatible;
    }

    try {
        const messageCols = new Set(
            (db.prepare("PRAGMA table_info(message)").all() as Array<{ name?: string }>)
                .map((r) => r.name ?? "")
                .filter((n) => n.length > 0),
        );
        const partCols = new Set(
            (db.prepare("PRAGMA table_info(part)").all() as Array<{ name?: string }>)
                .map((r) => r.name ?? "")
                .filter((n) => n.length > 0),
        );

        const missingMessage = REQUIRED_MESSAGE_COLUMNS.filter((c) => !messageCols.has(c));
        const missingPart = REQUIRED_PART_COLUMNS.filter((c) => !partCols.has(c));

        if (missingMessage.length > 0 || missingPart.length > 0) {
            log(
                `[magic-context] compaction-marker: OpenCode DB schema missing required columns ` +
                    `(message: [${missingMessage.join(", ")}], part: [${missingPart.join(", ")}]). ` +
                    `Marker injection disabled for this process. ` +
                    `This usually means OpenCode was updated and magic-context is out of date.`,
            );
            cachedSchemaCompatible = { path: dbPath, compatible: false };
            return false;
        }

        cachedSchemaCompatible = { path: dbPath, compatible: true };
        return true;
    } catch (error) {
        log(
            `[magic-context] compaction-marker: schema probe failed: ${error instanceof Error ? error.message : String(error)}. ` +
                `Marker injection disabled until next process restart.`,
        );
        cachedSchemaCompatible = { path: dbPath, compatible: false };
        return false;
    }
}

function getWritableOpenCodeDb(): Database {
    const dbPath = getOpenCodeDbPath();
    if (cachedWriteDb?.path === dbPath) {
        return cachedWriteDb.db;
    }
    if (cachedWriteDb) {
        try {
            closeQuietly(cachedWriteDb.db);
        } catch {
            // ignore
        }
    }
    // Fail with a diagnosable message instead of SQLite's bare `unable to open
    // database file`, and NEVER create the file: the default open mode creates
    // missing files, so on a machine without OpenCode (e.g. Pi-only installs)
    // a stray `~/.local/share/opencode/` directory would get a junk empty
    // opencode.db here and every later query would throw `no such table`.
    // Callers on such installs must not reach this at all (harness-gated);
    // this guard keeps the failure loud and side-effect-free if one does.
    if (!existsSync(dbPath)) {
        throw new Error(`OpenCode database not found at ${dbPath} (is OpenCode installed?)`);
    }
    const db = new Database(dbPath);
    // busy_timeout BEFORE journal_mode=WAL: setting WAL can need the file lock, so
    // with the timeout installed first a cold-open while OpenCode holds the lock
    // waits up to 5s instead of throwing SQLITE_BUSY immediately.
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA journal_mode=WAL");
    cachedWriteDb = { path: dbPath, db };
    return db;
}

export function closeCompactionMarkerDb(): void {
    if (cachedWriteDb) {
        try {
            closeQuietly(cachedWriteDb.db);
        } catch {
            // ignore
        }
        cachedWriteDb = null;
    }
    // Reset the schema-probe cache too — next open may be a different process
    // or a different opencode.db path (e.g. test isolation via XDG_DATA_HOME).
    cachedSchemaCompatible = null;
}

// ── Boundary User Message Resolution ─────────────────────────────

export interface BoundaryUserMessage {
    id: string;
    timeCreated: number;
}

interface NonSummaryMessageSortKey {
    id: string;
    timeCreated: number;
}

function getNonSummaryMessageSortKey(
    sessionId: string,
    messageId: string,
): NonSummaryMessageSortKey | null {
    const db = getWritableOpenCodeDb();
    const row = db
        .prepare(
            `SELECT time_created, id
             FROM message
             WHERE session_id = ?
               AND id = ?
               AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                        AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
             LIMIT 1`,
        )
        .get(sessionId, messageId) as { time_created?: unknown; id?: unknown } | undefined;
    if (typeof row?.time_created !== "number" || typeof row.id !== "string") {
        return null;
    }
    return { id: row.id, timeCreated: row.time_created };
}

/**
 * Find the nearest user message at or before the given end message id.
 * The boundary must be a user message for filterCompacted to work.
 *
 * Filters out compaction summary messages (summary=true, finish="stop")
 * so ordinals stay consistent with readRawSessionMessagesFromDb.
 */
export function findBoundaryUserMessage(
    sessionId: string,
    endMessageId: string,
): BoundaryUserMessage | null {
    const db = getWritableOpenCodeDb();

    // Resolve the target's canonical sort key first, using the same summary
    // exclusion as readRawSessionMessagesFromDb. If the stored endMessageId is
    // gone (or is itself one of our injected summaries), the pending/direct
    // marker update is stale and must not move the boundary.
    const target = getNonSummaryMessageSortKey(sessionId, endMessageId);
    if (!target) return null;

    // Match the raw-message reader's canonical ASC order
    // (time_created ASC, id ASC). "At or before target" is therefore
    // time_created < target.time_created OR the same timestamp with id <= target.id.
    // Push role='user' into SQL so a long assistant/tool span before the target
    // cannot exhaust a JS scan window and miss the prior user.
    const boundary = db
        .prepare(
            `SELECT id, time_created, data
             FROM message
             WHERE session_id = ?
               AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                        AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
               AND COALESCE(json_extract(data, '$.role'), '') = 'user'
               AND (time_created < ? OR (time_created = ? AND id <= ?))
             ORDER BY time_created DESC, id DESC
             LIMIT 1`,
        )
        .get(sessionId, target.timeCreated, target.timeCreated, target.id) as
        | { id?: unknown; time_created?: unknown; data?: unknown }
        | undefined;

    if (typeof boundary?.id !== "string" || typeof boundary.time_created !== "number") {
        return null;
    }

    return { id: boundary.id, timeCreated: boundary.time_created };
}

export function compareOpenCodeMessagesByCanonicalOrder(
    sessionId: string,
    leftMessageId: string,
    rightMessageId: string,
): number | null {
    const left = getNonSummaryMessageSortKey(sessionId, leftMessageId);
    const right = getNonSummaryMessageSortKey(sessionId, rightMessageId);
    if (!left || !right) return null;
    if (left.timeCreated < right.timeCreated) return -1;
    if (left.timeCreated > right.timeCreated) return 1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
}

/**
 * Check whether an OpenCode message ID still exists for a given session.
 *
 * Used by plan v6's deferred marker drain to validate that a deferred
 * compaction-marker target hasn't been wiped by recomp / revert / partial
 * recomp between publication and the consuming pass. Errors propagate
 * (unlike the swallow-and-return-empty helpers in `read-session-db.ts`):
 * the marker-manager wraps this call in its own try/catch so missing or
 * locked OpenCode DBs become `retryable-failure` outcomes, not silent skips.
 *
 * Note: returns `{ id }` rather than a richer row shape because the only
 * thing the caller needs is existence. If a future caller needs role or
 * timestamps, widen the return type but keep the throw-on-failure contract.
 */
export function getOpenCodeMessageById(
    sessionId: string,
    messageId: string,
): { id: string } | null {
    const db = getWritableOpenCodeDb();
    const row = db
        .prepare(`SELECT id FROM message WHERE session_id = ? AND id = ? LIMIT 1`)
        .get(sessionId, messageId) as { id: string } | null | undefined;
    return row ?? null;
}

// ── Marker State ─────────────────────────────────────────────────

interface CompactionMarkerState {
    /** The user message ID that has the compaction part */
    boundaryMessageId: string;
    /** The summary assistant message ID we injected */
    summaryMessageId: string;
    /** The compaction part ID on the user message */
    compactionPartId: string;
    /** The text part ID on the summary message */
    summaryPartId: string;
}

// ── Injection ────────────────────────────────────────────────────

export interface InjectCompactionMarkerArgs {
    sessionId: string;
    /** Raw ordinal of the last compartmentalized message */
    endOrdinal: number;
    /** OpenCode message id of the last compartmentalized message */
    endMessageId: string;
    /** Summary text for the compaction summary message (static placeholder) */
    summaryText: string;
    /** Working directory for the session */
    directory: string;
    /** Boundary resolved before removing the old marker (prevents null-boundary cache busts). */
    resolvedBoundary?: BoundaryUserMessage;
}

function removeLegacyMarkerLineageRows(
    db: Database,
    args: {
        sessionId: string;
        boundaryMessageId: string;
        summaryText: string;
        summaryMessageId: string;
        compactionPartId: string;
    },
): void {
    const legacySummaries = db
        .prepare(
            `SELECT m.id
             FROM message m
             WHERE m.session_id = ?
               AND m.id <> ?
               AND COALESCE(json_extract(m.data, '$.summary'), 0) = 1
               AND COALESCE(json_extract(m.data, '$.finish'), '') = 'stop'
               AND COALESCE(json_extract(m.data, '$.parentID'), '') = ?
               AND EXISTS (
                   SELECT 1
                   FROM part p
                   WHERE p.session_id = m.session_id
                     AND p.message_id = m.id
                     AND COALESCE(json_extract(p.data, '$.type'), '') = 'text'
                     AND COALESCE(json_extract(p.data, '$.text'), '') = ?
               )`,
        )
        .all(
            args.sessionId,
            args.summaryMessageId,
            args.boundaryMessageId,
            args.summaryText,
        ) as Array<{ id?: unknown }>;
    const legacySummaryIds = legacySummaries.flatMap((row) =>
        typeof row.id === "string" ? [row.id] : [],
    );
    if (legacySummaryIds.length === 0) return;

    const deleteSummaryParts = db.prepare(
        "DELETE FROM part WHERE session_id = ? AND message_id = ?",
    );
    const deleteSummary = db.prepare("DELETE FROM message WHERE session_id = ? AND id = ?");
    for (const summaryMessageId of legacySummaryIds) {
        deleteSummaryParts.run(args.sessionId, summaryMessageId);
        deleteSummary.run(args.sessionId, summaryMessageId);
    }

    // A stale marker lineage can carry its own compaction part. Once the
    // lineage is identified, retain only the deterministic boundary part.
    db.prepare(
        `DELETE FROM part
         WHERE session_id = ?
           AND message_id = ?
           AND id <> ?
           AND COALESCE(json_extract(data, '$.type'), '') = 'compaction'
           AND COALESCE(json_extract(data, '$.auto'), 0) = 1`,
    ).run(args.sessionId, args.boundaryMessageId, args.compactionPartId);
}

/**
 * Inject a compaction marker into OpenCode's DB.
 * Returns the marker state if successful, null if boundary couldn't be found.
 */
export function injectCompactionMarker(
    args: InjectCompactionMarkerArgs,
): CompactionMarkerState | null {
    // Verify OpenCode's schema still matches what our INSERTs expect BEFORE we
    // try to write. If OpenCode shipped a breaking schema change, bail cleanly
    // instead of half-writing marker state that'd leave the session's history
    // in an inconsistent state.
    const db = getWritableOpenCodeDb();
    if (!isOpenCodeSchemaCompatible(db, getOpenCodeDbPath())) {
        return null;
    }

    const boundary =
        args.resolvedBoundary ?? findBoundaryUserMessage(args.sessionId, args.endMessageId);
    if (!boundary) {
        log(
            `[magic-context] compaction-marker: no user message found at or before endMessageId ${args.endMessageId} (ordinal ${args.endOrdinal})`,
        );
        return null;
    }
    // Use timestamps relative to the boundary so OpenCode's time/id ordering
    // places the marker immediately after the boundary.
    const boundaryTime = boundary.timeCreated;
    const markerIdentity = `${args.sessionId}\0${args.endMessageId}`;
    const summaryMsgId = generateMessageId(
        boundaryTime + 1,
        1n,
        `${markerIdentity}\0summary-message`,
    );
    const compactionPartId = generatePartId(boundaryTime, 1n, `${markerIdentity}\0compaction-part`);
    const summaryPartId = generatePartId(boundaryTime + 1, 2n, `${markerIdentity}\0summary-part`);

    const summaryMsgData = JSON.stringify({
        role: "assistant",
        parentID: boundary.id,
        summary: true,
        finish: "stop",
        mode: "compaction",
        agent: "compaction",
        path: { cwd: args.directory, root: args.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "magic-context",
        providerID: "magic-context",
        time: { created: boundaryTime + 1 },
    });

    try {
        db.transaction(() => {
            // A committed insert can outlive a failed context-state write. Remove
            // any stale lineage in the transaction that writes the canonical rows.
            removeLegacyMarkerLineageRows(db, {
                sessionId: args.sessionId,
                boundaryMessageId: boundary.id,
                summaryText: args.summaryText,
                summaryMessageId: summaryMsgId,
                compactionPartId,
            });

            // Deterministic IDs make this transaction an upsert on retry. Rewriting
            // the exact canonical row also repairs a partial or stale prior write.
            db.prepare(
                `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                     message_id = excluded.message_id,
                     session_id = excluded.session_id,
                     time_created = excluded.time_created,
                     time_updated = excluded.time_updated,
                     data = excluded.data`,
            ).run(
                compactionPartId,
                boundary.id,
                args.sessionId,
                boundaryTime,
                boundaryTime,
                '{"type":"compaction","auto":true}',
            );

            db.prepare(
                `INSERT INTO message (id, session_id, time_created, time_updated, data)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                     session_id = excluded.session_id,
                     time_created = excluded.time_created,
                     time_updated = excluded.time_updated,
                     data = excluded.data`,
            ).run(summaryMsgId, args.sessionId, boundaryTime + 1, boundaryTime + 1, summaryMsgData);

            db.prepare(
                `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                     message_id = excluded.message_id,
                     session_id = excluded.session_id,
                     time_created = excluded.time_created,
                     time_updated = excluded.time_updated,
                     data = excluded.data`,
            ).run(
                summaryPartId,
                summaryMsgId,
                args.sessionId,
                boundaryTime + 1,
                boundaryTime + 1,
                JSON.stringify({ type: "text", text: args.summaryText }),
            );
        })();

        log(
            `[magic-context] compaction-marker: injected boundary at user msg ${boundary.id} (ordinal ~${args.endOrdinal}), summary msg ${summaryMsgId}`,
        );

        return {
            boundaryMessageId: boundary.id,
            summaryMessageId: summaryMsgId,
            compactionPartId,
            summaryPartId,
        };
    } catch (error) {
        log(
            `[magic-context] compaction-marker: injection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
    }
}

// ── Removal ──────────────────────────────────────────────────────

/**
 * Remove an existing compaction marker (all 3 rows).
 * Used when moving the boundary forward or on session cleanup.
 */
export function removeCompactionMarker(state: CompactionMarkerState): boolean {
    try {
        const db = getWritableOpenCodeDb();
        db.transaction(() => {
            // Delete in reverse order of dependencies
            db.prepare("DELETE FROM part WHERE id = ?").run(state.summaryPartId);
            db.prepare("DELETE FROM message WHERE id = ?").run(state.summaryMessageId);
            db.prepare("DELETE FROM part WHERE id = ?").run(state.compactionPartId);
        })();
        return true;
    } catch (error) {
        log(
            `[magic-context] compaction-marker: removal failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
}
