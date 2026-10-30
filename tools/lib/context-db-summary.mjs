import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What the Magic Context store can say about one run, read from the store itself.
 *
 * <p>
 * The store has always been on disk - `runtime-root/contexts/<id>/data/cortexkit/magic-context/context.db` inside the
 * run directory - but nothing read it, so a whole layer of a live run was invisible. Measured 2026-10-29 (`round7`):
 * the run ended `stopReason: "length"` at 139,899 tokens, and `result.json` carried zero `tokensBefore`,
 * `firstKeptEntryId`, `compaction` or `fold` fields. The cause of that run was found only by opening this file by hand
 * afterwards.
 * </p>
 * <p>
 * Every number below is a column that already exists: `tags.status` and `tags.drop_mode` say whether a result was
 * reclaimed; `tags.token_count` says how much; `compartments` says where the fold boundary stood. Nothing here infers
 * a fact the store does not record.
 * </p>
 *
 * <p>
 * A db holds EVERY session the runtime root ever used - 61 of them in that run - so the summary is filtered by the
 * run's own session id. Summing the table without the filter reports another run's work.
 * </p>
 */
export function collectContextSummary({ runDir, contextsRoot, sessionId }) {
  const dbPath = findContextDb(runDir, contextsRoot);
  if (dbPath === null) return Object.freeze({ observed: false, reasonCode: "context_db_not_found" });
  if (typeof sessionId !== "string" || sessionId.length === 0)
    return Object.freeze({ observed: false, reasonCode: "session_id_missing", dbPath });

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    return Object.freeze({ observed: false, reasonCode: "context_db_unreadable", detail: String(error), dbPath });
  }

  try {
    const tagTotals = db
      .prepare(
        `SELECT status, drop_mode, COUNT(*) AS tags,
                COALESCE(SUM(token_count), 0) AS tokens,
                COALESCE(SUM(byte_size), 0) AS bytes
           FROM tags WHERE session_id = ? GROUP BY status, drop_mode`,
      )
      .all(sessionId);
    const observed = tagTotals.reduce((sum, row) => sum + row.tags, 0);
    if (observed === 0) return Object.freeze({ observed: false, reasonCode: "session_not_in_store", dbPath });

    const perTool = db
      .prepare(
        `SELECT tool_name, status, COUNT(*) AS tags, COALESCE(SUM(token_count), 0) AS tokens
           FROM tags WHERE session_id = ? AND tool_name IS NOT NULL
          GROUP BY tool_name, status ORDER BY tokens DESC`,
      )
      .all(sessionId);

    const largestToolResult = db
      .prepare(
        `SELECT tool_name, MAX(token_count) AS tokens, MAX(byte_size) AS bytes
           FROM tags WHERE session_id = ? AND tool_name IS NOT NULL`,
      )
      .get(sessionId);

    // The fold boundary: the highest compartment end is the newest message the historian has already summarised.
    const boundary = db
      .prepare(`SELECT COUNT(*) AS compartments, MAX(end_message) AS endMessage FROM compartments WHERE session_id = ?`)
      .get(sessionId);
    const messageCount = db
      .prepare(`SELECT COUNT(*) AS messages FROM tags WHERE session_id = ? AND type = 'message'`)
      .get(sessionId);

    return Object.freeze({
      observed: true,
      dbPath,
      sessionId,
      // The two halves that decide whether reclamation is keeping up.
      activeTokens: sum(tagTotals, "tokens", (row) => row.status === "active"),
      droppedTokens: sum(tagTotals, "tokens", (row) => row.status !== "active"),
      activeTags: sum(tagTotals, "tags", (row) => row.status === "active"),
      droppedTags: sum(tagTotals, "tags", (row) => row.status !== "active"),
      // A skeleton drop keeps the tag row and empties its content; a full drop removes it. Both are reclamation, but
      // only `skeleton_real` proves the byte budget was actually reclaimed rather than the row deleted outright.
      dropModes: Object.freeze(
        tagTotals
          .filter((row) => row.status !== "active")
          .map((row) => Object.freeze({ dropMode: row.drop_mode ?? "none", tags: row.tags, tokens: row.tokens })),
      ),
      perTool: Object.freeze(
        perTool.map((row) =>
          Object.freeze({ tool: row.tool_name, status: row.status, tags: row.tags, tokens: row.tokens }),
        ),
      ),
      largestToolResult: largestToolResult
        ? Object.freeze({
            tool: largestToolResult.tool_name,
            tokens: largestToolResult.tokens,
            bytes: largestToolResult.bytes,
          })
        : null,
      compartments: boundary.compartments,
      foldBoundaryMessage: boundary.endMessage ?? null,
      messageTags: messageCount.messages,
    });
  } catch (error) {
    return Object.freeze({ observed: false, reasonCode: "context_db_query_failed", detail: String(error), dbPath });
  } finally {
    db.close();
  }
}

/**
 * The run's own store, found rather than guessed.
 *
 * <p>
 * One runtime root can hold several contexts (the `round7` run had two, 78 MB and 1.7 MB), so the search returns the
 * LARGEST store: the companion's own conversation is the one that grew, and the other is a harness root that carried a
 * handful of tags. An empty or absent tree returns null rather than a fabricated path.
 * </p>
 */
function findContextDb(runDir, contextsRoot) {
  // Two layouts, and the caller says which one it holds: a CAPTURE keeps the runtime root nested
  // (`<run>/runtime-root/contexts`), while a LIVE root has `contexts` directly. Guessing produced
  // `context_db_not_found` for a store that existed.
  const roots =
    typeof contextsRoot === "string"
      ? contextsRoot
      : typeof runDir === "string" && existsSync(runDir)
        ? join(runDir, "runtime-root", "contexts")
        : null;
  if (roots === null || !existsSync(roots)) return null;
  let best = null;
  for (const contextEntry of safeReadDir(roots)) {
    const candidate = join(roots, contextEntry, "data", "cortexkit", "magic-context", "context.db");
    if (!existsSync(candidate)) continue;
    const size = statSync(candidate).size;
    if (best === null || size > best.size) best = { path: candidate, size };
  }
  return best?.path ?? null;
}

function safeReadDir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function sum(rows, field, predicate) {
  return rows.reduce((total, row) => (predicate(row) ? total + row[field] : total), 0);
}
