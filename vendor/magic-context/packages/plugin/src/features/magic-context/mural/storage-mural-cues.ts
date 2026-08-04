import { createHash } from "node:crypto";

import { type Database, withPrivilegedWriter } from "../../../shared/sqlite";

/**
 * Per-memory mural cue storage (v65). The compress-cues dreamer task writes one
 * compressed pidgin cue per memory content version onto the `memories` table
 * (columns mural_cue / mural_cue_hash / mural_cue_at); resolveMural reads the
 * hash-current ones and packs them deterministically at inject time.
 *
 * These are a LOCAL render cache derived from memory content — not a
 * module-mirrored authority column. Authority triggers still guard every update
 * to a managed memory row, so the narrow cache writer below uses an explicit
 * privilege bracket without granting callers access to authoritative content.
 */

/**
 * The staleness key: sha256 of the RAW memory content the cue was compressed
 * FROM. Any edit to the content changes this hash, so a stored cue whose hash no
 * longer matches the current content is detected as stale — re-selected by the
 * compress-cues gate and excluded by resolveMural until recompressed. This is
 * deliberately distinct from `normalizedHash` (md5 of normalized text used for
 * dedup): cue staleness must react to every content change, including
 * whitespace/case edits that normalization would erase.
 */
export function computeCueContentHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

const muralCueColumnCache = new WeakMap<Database, boolean>();

/** Column-guard for pre-v65 databases so cue reads/writes degrade to a no-op
 *  rather than throwing "no such column" on an un-migrated DB. */
export function hasMuralCueColumns(db: Database): boolean {
    const cached = muralCueColumnCache.get(db);
    if (cached !== undefined) return cached;
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name?: string }>;
    const present = columns.some((column) => column.name === "mural_cue");
    muralCueColumnCache.set(db, present);
    return present;
}

export interface MuralCueState {
    /** The stored compressed cue, or null when never compressed. */
    cue: string | null;
    /** sha256 of the content the stored cue was compressed from, or null. */
    hash: string | null;
}

/**
 * Read the stored cue state for a set of memory ids. Ids absent from the map
 * have no row (or the column set is missing on a pre-v65 DB). Used by the
 * compress-cues gate and by resolveMural's hash-current filter.
 */
export function getMuralCueState(
    db: Database,
    memoryIds: readonly number[],
): Map<number, MuralCueState> {
    const out = new Map<number, MuralCueState>();
    if (!hasMuralCueColumns(db)) return out;
    const ids = Array.from(new Set(memoryIds.filter(Number.isInteger)));
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
        .prepare<number[], { id: number; mural_cue: string | null; mural_cue_hash: string | null }>(
            `SELECT id, mural_cue, mural_cue_hash FROM memories WHERE id IN (${placeholders})`,
        )
        .all(...ids);
    for (const row of rows) {
        out.set(row.id, { cue: row.mural_cue ?? null, hash: row.mural_cue_hash ?? null });
    }
    return out;
}

/**
 * True when a memory needs (re)compression: it has no cue yet, or the stored cue
 * was computed from different content (hash mismatch). Callers pass the memory's
 * CURRENT content so the check reacts to edits.
 */
export function memoryNeedsCue(state: MuralCueState | undefined, currentContent: string): boolean {
    if (!state || state.cue === null || state.hash === null) return true;
    return state.hash !== computeCueContentHash(currentContent);
}

/**
 * Write a compressed cue as a column-only update. `contentHash` MUST be the
 * hash of the content that was actually compressed (not a re-hash of the row's
 * current content): if the memory was edited mid-run, storing the prompt-time
 * hash leaves mural_cue_hash != sha256(current content), so resolveMural
 * excludes the now-stale cue and the compress-cues gate re-selects the memory
 * next run. Cache-neutral: the mural is rendered on demand from these columns,
 * not injected as part of the m[0] baseline bytes.
 */
export function setMuralCue(
    db: Database,
    projectPath: string,
    id: number,
    cue: string,
    contentHash: string,
): void {
    if (!hasMuralCueColumns(db)) return;
    withPrivilegedWriter(db, () => {
        const owned = db
            .prepare("SELECT 1 FROM memories WHERE id = ? AND project_path = ?")
            .get(id, projectPath);
        if (!owned) {
            throw new Error(`Memory ${id} does not belong to project ${projectPath}`);
        }
        // Privilege is safe here because only derived cache columns are changed;
        // authoritative memory content and identity fields are never writable here.
        db.prepare(
            "UPDATE memories SET mural_cue = ?, mural_cue_hash = ?, mural_cue_at = ? WHERE id = ? AND project_path = ?",
        ).run(cue, contentHash, Date.now(), id, projectPath);
    });
}
