import { Database } from "bun:sqlite";

/**
 * Open a SQLite handle for an e2e test with a non-zero `busy_timeout` always set.
 *
 * The e2e suite runs many files in parallel against a per-test shared
 * `context.db` while the plugin under test writes to the same file. A handle
 * opened with the default `busy_timeout = 0` fails immediately with SQLITE_BUSY
 * the instant any other connection holds the write lock, which surfaces as
 * flaky "database is locked" failures under load rather than a real regression.
 * Setting a timeout makes the handle WAIT for the lock instead of failing.
 *
 * Every test that opens the context DB directly (reader or writer) must go
 * through this helper so the timeout can never be forgotten — a bare
 * `new Database(...)` in a test reintroduces the flake.
 */
export function openTestDb(
	path: string,
	options?: { readonly?: boolean; readwrite?: boolean },
): Database {
	const db = new Database(path, options);
	db.exec("PRAGMA busy_timeout=5000");
	return db;
}
