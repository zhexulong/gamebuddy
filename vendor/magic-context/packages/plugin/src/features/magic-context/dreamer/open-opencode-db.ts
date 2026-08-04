import { existsSync } from "node:fs";
import { getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { getOpenCodeDbPath } from "../compaction-marker";

/**
 * Open OpenCode's DB read-only (used by dreamer tasks that scan raw OpenCode
 * history, e.g. the retrospective scanner and the orphaned-child sweep).
 * Returns null when absent or unopenable — callers degrade gracefully.
 * Absence is normal on Pi-only installs, so it is not logged as an error.
 */
export function openOpenCodeDb(): Database | null {
    const dbPath = getOpenCodeDbPath();
    if (!existsSync(dbPath)) {
        log(`[dreamer] OpenCode DB not found at ${dbPath} — skipping OpenCode history scan`);
        return null;
    }
    try {
        const db = new Database(dbPath, { readonly: true });
        db.exec("PRAGMA busy_timeout = 5000");
        return db;
    } catch (error) {
        log(`[dreamer] failed to open OpenCode DB at ${dbPath}: ${getErrorMessage(error)}`);
        return null;
    }
}
