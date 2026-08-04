/**
 * Cross-runtime helpers that smooth over the small bun:sqlite ↔ node:sqlite
 * API differences without leaking either backend into call sites.
 */

import type { Database } from "./sqlite";

/**
 * Close a database, ignoring errors.
 *
 * bun:sqlite supports `db.close(throwOnError = false)`. node:sqlite has only
 * `db.close()` and throws ("database is not open") on an already-closed
 * handle. This helper mirrors the bun "swallow errors" semantics for both
 * runtimes — useful in test teardown and `finally` blocks where the caller
 * doesn't care whether the close succeeded.
 */
export function closeQuietly(db: Database | null | undefined): void {
    if (!db) return;
    // Just attempt close and swallow errors. bun:sqlite has no `open` property,
    // and node:sqlite throws on an already-closed handle — both are handled by
    // the bare try/catch.
    try {
        // Bun's SQLite close defaults to throwing while statements are still
        // finalizing. Test fixtures legitimately close sibling WAL handles in
        // rapid succession; request its documented quiet-close mode while
        // node:sqlite simply ignores the optional argument at runtime.
        (db.close as unknown as (throwOnError?: boolean) => void)(false);
    } catch {
        // intentional: caller wants quiet close
    }
}
