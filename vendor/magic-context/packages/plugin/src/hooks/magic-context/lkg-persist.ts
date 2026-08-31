import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import type { LkgPersistenceBackend, LkgSlot } from "./lkg-slot";

/**
 * Durable persistence for last-known-good (LKG) transform snapshots.
 *
 * The in-memory slot map in lkg-slot.ts dies with the process. When the plugin
 * restarts while the Rust module is reconnecting, the recovery ladder used to
 * have nothing to replay and the turn fell all the way down to the raw-fallback
 * size gate. Persisting the slot an applied pass captured lets a fresh process
 * serve the same replay — subject to exactly the same validity fences a live
 * process applies (hydration only restores the slot; replay validation is
 * unchanged).
 *
 * Write discipline follows the single-stringify precedent: `jsonPrefix` is the
 * exact string captured by the applied pass and is stored as-is — never
 * re-serialized here. Only the small metadata arrays are serialized.
 */

interface LkgSlotRow {
    session_id?: unknown;
    json_prefix?: unknown;
    input_id_seq?: unknown;
    input_content_digests?: unknown;
    input_content_signatures?: unknown;
    last_input_message_id?: unknown;
    model_key?: unknown;
    provider_key?: unknown;
    captured_at?: unknown;
    row_version?: unknown;
    capture_sequence?: unknown;
}

function parseStringArray(value: unknown): string[] | null {
    if (typeof value !== "string") return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    const result: string[] = [];
    for (const entry of parsed) {
        if (typeof entry !== "string" || entry.length === 0) return null;
        result.push(entry);
    }
    return result;
}

function parseNullableString(value: unknown): string | null | undefined {
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : undefined;
}

function parseNullableInteger(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Parse a stored row into a slot; returns undefined (and reasons to delete) on any malformation. */
export function parsePersistedLkgSlot(row: unknown): LkgSlot | undefined {
    if (!row || typeof row !== "object") return undefined;
    const record = row as LkgSlotRow;
    const jsonPrefix = record.json_prefix;
    const lastInputMessageId = record.last_input_message_id;
    const capturedAt = record.captured_at;
    const inputIdSeq = parseStringArray(record.input_id_seq);
    const inputContentDigests = parseStringArray(record.input_content_digests);
    const modelKey = parseNullableString(record.model_key);
    const providerKey = parseNullableString(record.provider_key);
    if (
        typeof jsonPrefix !== "string" ||
        typeof lastInputMessageId !== "string" ||
        lastInputMessageId.length === 0 ||
        typeof capturedAt !== "number" ||
        !Number.isFinite(capturedAt) ||
        inputIdSeq === null ||
        inputContentDigests === null ||
        inputContentDigests.length !== inputIdSeq.length ||
        modelKey === undefined ||
        providerKey === undefined
    ) {
        return undefined;
    }
    let inputContentSignatures: string[] | undefined;
    if (record.input_content_signatures !== null && record.input_content_signatures !== undefined) {
        const parsed = parseStringArray(record.input_content_signatures);
        if (parsed === null || parsed.length !== inputIdSeq.length) return undefined;
        inputContentSignatures = parsed;
    }
    const slot: LkgSlot = {
        jsonPrefix,
        inputIdSeq,
        inputContentDigests,
        lastInputMessageId,
        modelKey,
        providerKey,
        capturedAt,
    };
    if (inputContentSignatures) slot.inputContentSignatures = inputContentSignatures;
    const rowVersion = parseNullableInteger(record.row_version);
    if (rowVersion !== undefined) slot.rowVersion = rowVersion;
    const captureSequence = parseNullableInteger(record.capture_sequence);
    if (captureSequence !== undefined) slot.captureSequence = captureSequence;
    return slot;
}

/**
 * Persist a slot for the session, replacing any prior row. Best-effort: callers
 * treat a failure as "this process still has the in-memory slot" and log.
 */
export function saveLkgSlotToDb(db: Database, sessionId: string, slot: LkgSlot): boolean {
    try {
        db.prepare(
            `INSERT INTO lkg_slots (
                session_id, json_prefix, input_id_seq, input_content_digests,
                input_content_signatures, last_input_message_id, model_key, provider_key,
                captured_at, row_version, capture_sequence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                json_prefix = excluded.json_prefix,
                input_id_seq = excluded.input_id_seq,
                input_content_digests = excluded.input_content_digests,
                input_content_signatures = excluded.input_content_signatures,
                last_input_message_id = excluded.last_input_message_id,
                model_key = excluded.model_key,
                provider_key = excluded.provider_key,
                captured_at = excluded.captured_at,
                row_version = excluded.row_version,
                capture_sequence = excluded.capture_sequence`,
        ).run(
            sessionId,
            slot.jsonPrefix,
            JSON.stringify(slot.inputIdSeq),
            JSON.stringify(slot.inputContentDigests),
            slot.inputContentSignatures ? JSON.stringify(slot.inputContentSignatures) : null,
            slot.lastInputMessageId,
            slot.modelKey,
            slot.providerKey,
            slot.capturedAt,
            slot.rowVersion ?? null,
            slot.captureSequence ?? null,
        );
        return true;
    } catch (error) {
        sessionLog(sessionId, "LKG snapshot persistence failed (in-memory slot retained):", error);
        return false;
    }
}

export function clearPersistedLkgSlot(db: Database, sessionId: string): void {
    try {
        db.prepare("DELETE FROM lkg_slots WHERE session_id = ?").run(sessionId);
    } catch (error) {
        sessionLog(sessionId, "LKG snapshot durable clear failed:", error);
    }
}

export function loadPersistedLkgSlot(db: Database, sessionId: string): LkgSlot | undefined {
    let row: unknown;
    try {
        row = db.prepare("SELECT * FROM lkg_slots WHERE session_id = ?").get(sessionId);
    } catch (error) {
        sessionLog(sessionId, "LKG snapshot durable load failed:", error);
        return undefined;
    }
    if (!row) return undefined;
    const slot = parsePersistedLkgSlot(row);
    if (!slot) {
        // A malformed row can never become replayable; remove it so later
        // captures start clean instead of tripping the same parse failure.
        clearPersistedLkgSlot(db, sessionId);
        return undefined;
    }
    // Size admission is enforced by the slot store's own bound when the loaded
    // slot is installed; an oversized row simply declines to hydrate.
    return slot;
}

/** Backend bound to one database handle, for registration with the slot store. */
export function createDbLkgPersistence(db: Database): LkgPersistenceBackend {
    return {
        load: (sessionId) => loadPersistedLkgSlot(db, sessionId),
        clear: (sessionId) => clearPersistedLkgSlot(db, sessionId),
    };
}
