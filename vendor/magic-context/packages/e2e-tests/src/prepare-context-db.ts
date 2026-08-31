import { join } from "node:path";
import { openDatabase } from "../../plugin/src/features/magic-context/storage-db";

/**
 * Create the current Magic Context schema before starting an isolated harness.
 *
 * A production migration guard treats every other live Pi process as a possible
 * holder of the user's shared database. No external process can hold an e2e
 * database under a fresh data directory, so initializing it in the test process
 * prevents an unrelated local Pi session from making the extension fail closed.
 */
export function prepareContextDatabase(dataDir: string): void {
  const dbPath = join(dataDir, "cortexkit", "magic-context", "context.db");
  if (!openDatabase(dbPath)) throw new Error(`failed to initialize isolated context database at ${dbPath}`);
}
