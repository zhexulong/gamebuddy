/**
 * Every live run ends with one ledger of its memory and prompt-cache behaviour, produced from the run's own artifacts.
 *
 * WHY THIS EXISTS. `design/architecture/magic-context-airp-adaptation.md` §4 states six acceptance metrics with a
 * baseline, a threshold and a named artifact each - `cacheRead` share 80.3~85.2 %, the micro-fold share of
 * `compaction.tokensBefore`, the manual `ctx_reduce` count, and the historian / admission / promotion / dream / reader
 * funnel. Nothing produced them: the table lived in prose, so no run could regress against it and no reader could tell
 * a run that never folded from a reader that could not see. This module is the single producer of all of them.
 *
 * ONE PRODUCER, NAMED PER FIELD. Each row below carries the artifact it came from, so a number that disagrees with
 * another tool's number can be traced to a file rather than argued about:
 *
 *   metric                      artifact
 *   cache_read_share            session `*.jsonl` `message.usage.cacheRead / (input + cacheRead)`
 *   micro_fold_share            session `*.jsonl` `compaction.tokensBefore` of entries whose `details.source` is
 *                               `magic-context`
 *   micro_fold_below_100_tokens the same entries, at the `100` ceiling §WP-B requires to be empty
 *   manual_ctx_reduce_calls     session `*.jsonl` assistant `toolCall` parts named `ctx_reduce`
 *   reader_calls                session `*.jsonl` assistant `toolCall` parts named `ctx_search` / `ctx_expand` /
 *                               `ctx_memory` / `ctx_note`
 *   historian_runs              `context.db` `historian_runs` for this run's session
 *   admission_refusals          none - see below
 *   memories_promoted           `context.db` `memories` in this continuity's project scope
 *   chapters_sealed             `context.db` `chapters` for this run's session
 *   notes / primers / dream_runs `context.db` tables of those names, same project scope
 *
 * THE THREE ZEROES STAY APART, because this repository has already been burned twice by a zero that was not one: a
 * reader that threw (a store that existed read as `context_db_not_found`) and a counter that was never published (a
 * `result.json` carrying zero `tokensBefore` on every run). So a metric with no artifact is
 * `not_measured:<metric>:<why>` - never `0` - every table read is wrapped so a missing table names itself instead of
 * taking the run down, and a genuine zero is printed as `0` with its population beside it.
 *
 * SCOPE. A store holds every session the runtime root ever used, so nothing here is summed across the file. Session
 * tables are read `WHERE session_id = ?`; project tables `WHERE project_path = ?`, and that path is taken from the
 * store's own `session_projects` mapping for this run's session or from the project path the Host materialised - never
 * re-derived from the vendor's path format, and never guessed. When the scope cannot be determined the answer is
 * `not_measured:<metric>:<reason>` with no query at all: a global read would report another continuity's memories as
 * this run's, which is the one mistake a memory ledger must not make.
 *
 * THREE RED LINES, all `blocking: false` in this first state (design §5 puts the regression gates before the code):
 *   (a) memory pollution - no `memories` row whose text is a machine ledger rather than a fact about the companion's
 *       life. Judged on SHAPE (`plan_<hex>`, `key=value` chains, `revision N`, `receipt`/`rejected` inside a sentence
 *       that is otherwise a tool log), never on a word list, and the population examined is always printed.
 *   (b) continuity isolation - a fresh continuity cannot recall the previous one's covenant through FTS5. A probe that
 *       can fail two ways, not a hope: a leak is a finding, and a query that hits nothing even in the scope that is
 *       KNOWN to hold the covenant is `not_measured:probe_vacuous` rather than a pass.
 *   (c) cache - a `cacheRead` share below 80 % is a finding, printed with both numbers.
 *
 * HOW EACH BECOMES BLOCKING is stated on its own row (`becomesBlocking`), because "recorded now" is only honest if
 * the threshold and the work package that turns it into a failure are named at the same moment.
 */
import { DatabaseSync } from "node:sqlite";

import { readUsages, sumOf } from "../perf/run-cost-usage.mjs";
import { findContextDb } from "./context-db-summary.mjs";
import { readSessionEntries } from "./session-jsonl.mjs";

/** The value every unreadable metric carries; the reason travels beside it in `notMeasured`. */
export const NOT_MEASURED = "not_measured";

/** The band §WP-B measured at 34.2 % of 12,619 compactions and asks to fall to <= 5 %. */
export const MICRO_FOLD_TOKEN_CEILING = 250;
export const MICRO_FOLD_SHARE_CEILING = 0.05;
/** A fold below this is not a summary of anything: §WP-B requires the count to be zero, not merely rare. */
export const MICRO_FOLD_EMPTY_CEILING = 100;
/** §WP-E: the prefix cache this product already holds, which no reclaim may spend. */
export const CACHE_READ_SHARE_FLOOR = 0.8;
/** §WP-E: 5~8 hand `ctx_reduce` calls per run is the tax; the target is half of it. */
export const MANUAL_CTX_REDUCE_BUDGET = 2;

/** The tool calls that only exist because a reader did not: the tax §WP-E halves. */
const MANUAL_RECLAIM_TOOL = "ctx_reduce";
/** The tools a reader reaches durable memory through (§WP-A/C reader call rate). */
export const READER_TOOLS = Object.freeze(["ctx_search", "ctx_expand", "ctx_memory", "ctx_note"]);

/** How many `tokensBefore` readings an artifact carries. A long run folds more times than a reader will read. */
export const TOKENS_BEFORE_CAP = 60;

/**
 * The `receipt`/`rejected` words that make a sentence a candidate for the tool-log shape.
 *
 * These are not a blacklist: a word alone decides nothing, and the shape test below is what refuses a row. A companion
 * writing 「她把收据夹在账簿里」 is writing about her life; the sentence carries no code identifier, so it is not
 * pollution however the word is spelled.
 */
const LEDGER_WORDS = /\b(?:receipt|rejected)\b|回执|收据/iu;

/** A snake_case identifier is what a machine ledger is made of and what a sentence about a farm is not. */
const CODE_IDENTIFIER = /(?<![\w])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w])/gu;

/** The `key=value` pair a receipt is spelled with. Keys are camelCase in every receipt this product mints. */
const KEY_VALUE_PAIR = /(?<![\w])[A-Za-z][A-Za-z0-9_]*=\S+/gu;

/** A character long enough to be a program identity rather than a word. `plan_` plus 8 hex is the measured shape. */
const PLAN_IDENTIFIER = /(?<![\w])plan_[0-9a-f]{8,}(?![\w])/iu;

/** The revision counter a chapter or memory row carries. `revision N` is how §WP-B's audit spelled it. */
const REVISION_MARKER = /(?<![\w])revision\s*(?:[:=#]\s*)?\d+(?![\w])/iu;

/**
 * The shapes that make a `memories` row a machine ledger rather than a fact about the companion.
 *
 * SHAPE, NOT A WORD LIST: every test below is structural - an identifier, a pair count, a counter - so a new tool name
 * or a new "noise word" cannot slip a log row into durable memory, and a companion writing 「她说东边那棵树先别动」 in
 * any phrasing stays admissible. `detail` names what was found, so a finding is actionable without re-reading the row.
 */
export const POLLUTION_SHAPES = Object.freeze([
  Object.freeze({
    code: "plan_identifier",
    detail: "a `plan_<hex>` program identifier",
    matches: (text) => PLAN_IDENTIFIER.test(text),
  }),
  Object.freeze({
    code: "key_value_chain",
    detail: "a receipt-shaped `key=value` chain (three or more pairs)",
    matches: (text) => new Set(text.match(KEY_VALUE_PAIR) ?? []).size >= 3,
  }),
  Object.freeze({
    code: "revision_marker",
    detail: "a `revision N` counter",
    matches: (text) => REVISION_MARKER.test(text),
  }),
  Object.freeze({
    code: "tool_log_sentence",
    detail: "`receipt`/`rejected` inside a sentence that is otherwise a tool log",
    // The conjunct is the whole rule: the ledger WORD must sit in a sentence carrying two or more code identifiers.
    // One word alone is a companion talking about a receipt; two identifiers beside it is a log.
    matches: (text) =>
      text
        .split(/(?<=[.!?。！？])\s*|\n+/u)
        .some((sentence) => LEDGER_WORDS.test(sentence) && new Set(sentence.match(CODE_IDENTIFIER) ?? []).size >= 2),
  }),
]);

/**
 * The metric rows, in the design's own order. `threshold` is `null` where §4 states no number: a funnel count is
 * reported and compared across runs rather than passed or failed, and inventing a bound for it here would make this
 * module a second authority for a number the design owns.
 */
export const MEASURED_ROWS = Object.freeze([
  Object.freeze({
    id: "cache_read_share",
    wp: "WP-E",
    artifact: "session `*.jsonl` message.usage: cacheRead / (input + cacheRead)",
    threshold: Object.freeze({ kind: "at_least", value: CACHE_READ_SHARE_FLOOR }),
    becomesBlocking:
      "WP-E's reclaim gate: fails a run whose share is below 0.80 once the safe reclaim window is wired (§WP-E Step E0 decides where that window is)",
  }),
  Object.freeze({
    id: "micro_fold_share",
    wp: "WP-B",
    artifact: `session \`*.jsonl\` compaction.tokensBefore <= ${MICRO_FOLD_TOKEN_CEILING}, of the compactions Magic Context sourced`,
    threshold: Object.freeze({ kind: "at_most", value: MICRO_FOLD_SHARE_CEILING }),
    becomesBlocking:
      "WP-B's fragment gate: fails a run whose <= 250-token share is above 0.05 once `coalesce_min_tokens` lands in the historian's fold eligibility",
  }),
  Object.freeze({
    id: "micro_fold_below_100_tokens",
    wp: "WP-B",
    artifact: `session \`*.jsonl\` compaction.tokensBefore < ${MICRO_FOLD_EMPTY_CEILING}`,
    threshold: Object.freeze({ kind: "at_most", value: 0 }),
    becomesBlocking:
      "WP-B's fragment gate: ANY fold below 100 tokens fails the run outright - no share to hide in, which is the number the design's own audit called out",
  }),
  Object.freeze({
    id: "manual_ctx_reduce_calls",
    wp: "WP-E",
    artifact: "session `*.jsonl` assistant `toolCall` parts named `ctx_reduce`",
    threshold: Object.freeze({ kind: "at_most", value: MANUAL_CTX_REDUCE_BUDGET }),
    becomesBlocking:
      "WP-E's reclaim gate: fails a run above 2 hand `ctx_reduce` calls once the safe reclaim window ships and `GAMEBUDDY_PROTECTED_TOOLS` owns the game tools' frames",
  }),
  Object.freeze({
    id: "reader_calls",
    wp: "WP-A/C",
    artifact: `session \`*.jsonl\` assistant \`toolCall\` parts named ${READER_TOOLS.join(" / ")}`,
    threshold: Object.freeze({ kind: "at_least", value: 1 }),
    becomesBlocking:
      "WP-A/C's reader gate: fails a task whose turns made no reader call once the archive prose is projected; paired with the `s4_memory` slice, which decides whether the call reached the fact",
  }),
  Object.freeze({
    id: "historian_runs",
    wp: "WP-B",
    artifact: "context.db `historian_runs` WHERE session_id = <this run's session>",
    threshold: null,
    becomesBlocking:
      "WP-B's admission replay gate: compared across runs against a recorded baseline rather than thresholded alone, because a run may legitimately never fold",
  }),
  Object.freeze({
    id: "historian_faults",
    wp: "WP-B",
    artifact: "context.db `historian_runs.failure_reason` for this run's session",
    threshold: null,
    becomesBlocking:
      "WP-B's admission replay gate: any non-success historian run in a multi-day run blocks, with the failure reason read off the row",
  }),
  Object.freeze({
    id: "candidate_facts_emitted",
    wp: "WP-B/C",
    artifact: "context.db `historian_runs.facts_emitted` for this run's session",
    threshold: null,
    becomesBlocking:
      "WP-B/C's admission replay gate: read against `memories_promoted` to size the admission gap; blocks when the fixed sample corpus sets the floor",
  }),
  Object.freeze({
    id: "admission_refusals",
    wp: "WP-B",
    artifact: "context.db - the parser refuses a candidate before any row exists, so this counter has no producer yet",
    threshold: null,
    becomesBlocking:
      "WP-B's Spike Gate: becomes measurable when `compartment-parser.ts` records refused candidates, and blocks the admission change from that moment",
  }),
  Object.freeze({
    id: "memories_promoted",
    wp: "WP-C",
    artifact: "context.db `memories` WHERE project_path = <this continuity's project>",
    threshold: null,
    becomesBlocking:
      "WP-C's promotion gate: fails a multi-day run that ended with 0 memories in scope once `auto_promote` is switched on for the ongoing-interaction domain",
  }),
  Object.freeze({
    id: "chapters_sealed",
    wp: "WP-B",
    artifact: "context.db `chapters` WHERE session_id = <this run's session>",
    threshold: null,
    becomesBlocking:
      "WP-B's fragment gate: read beside `micro_fold_share` - a fold that sealed no chapter is what a 24-token fold is, and blocks with it",
  }),
  Object.freeze({
    id: "notes",
    wp: "WP-C/D",
    artifact: "context.db `notes` WHERE project_path = <this continuity's project>",
    threshold: null,
    becomesBlocking:
      "WP-D's dream gate: compared across a multi-day run with `dream_runs`, so a note panel nobody wrote to cannot read as a healthy run",
  }),
  Object.freeze({
    id: "primers",
    wp: "WP-D",
    artifact: "context.db `primers` WHERE project_path = <this continuity's project>",
    threshold: null,
    becomesBlocking:
      "WP-D's dream gate: fails a multi-day run whose `promote-primers`/`refresh-primers` tasks stayed empty once they are whitelisted",
  }),
  Object.freeze({
    id: "dream_runs",
    wp: "WP-D",
    artifact: "context.db `dream_runs` WHERE project_path = <this continuity's project>",
    threshold: null,
    becomesBlocking:
      "WP-D's dream gate: fails a multi-day run that crossed a sleep with 0 `dream_runs` once `reflect` joins `dreamer.tasks`",
  }),
]);

/**
 * The three red lines. Every one is recorded and none blocks: §5 of the design puts the regression gates ahead of the
 * code they guard, so a run that tripped one must publish the fact while the gate that fails it does not exist yet.
 * `becomesBlocking` is the obligation that changes that, said on the row so it cannot be forgotten.
 */
export const RED_LINE_ROWS = Object.freeze([
  Object.freeze({
    id: "memory_pollution",
    wp: "WP-B",
    artifact: "context.db `memories.content` in this continuity's project scope",
    becomesBlocking:
      "WP-B's admission replay gate: once `ongoing-interaction-admission.ts` records its refusals, this row fails any run whose live scope holds a machine-ledger row, and joins the fixed sample corpus as the negative cases",
  }),
  Object.freeze({
    id: "continuity_isolation",
    wp: "WP-C",
    artifact: "context.db `memories_fts` MATCH, read in two project scopes",
    becomesBlocking:
      "WP-C's promotion gate: once `auto_promote` is on, this row fails any run where a fresh continuity's FTS5 reaches a prior continuity's covenant, and refuses to pass while its probe is vacuous",
  }),
  Object.freeze({
    id: "cache_read",
    wp: "WP-E",
    artifact: "session `*.jsonl` message.usage: cacheRead / (input + cacheRead)",
    becomesBlocking:
      "WP-E's reclaim gate: this row fails any run whose share falls below 0.80, printed with both numbers, as soon as the safe-reclaim window is wired",
  }),
]);

/**
 * Which shapes make this text a machine ledger rather than a memory. Pure, so a finding can be argued about without a
 * database: `[]` means the text is not pollution.
 */
export function pollutionShapesIn(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  return POLLUTION_SHAPES.filter((shape) => shape.matches(text)).map((shape) => shape.code);
}

/**
 * The pollution red line over the rows a scope holds.
 *
 * `examined` is printed whatever the answer, because this check's population is the whole point: the design's own
 * baseline is `memories = 0`, so today the honest report is "examined 0 memories in scope", which is `not_measured`
 * with that reason - never a pass, and never a zero that reads as "every row is clean".
 */
export function assessMemoryPollution(rows) {
  const examined = Array.isArray(rows) ? rows : [];
  const polluted = [];
  for (const row of examined) {
    const shapes = pollutionShapesIn(row?.content);
    if (shapes.length === 0) continue;
    polluted.push(Object.freeze({ id: row.id, shapes: Object.freeze(shapes) }));
  }
  if (examined.length === 0) {
    return Object.freeze({
      status: NOT_MEASURED,
      notMeasured: "no_memories_in_the_continuity_scope",
      examined: 0,
      polluted: Object.freeze([]),
    });
  }
  return Object.freeze({
    status: polluted.length === 0 ? "measured" : "finding",
    notMeasured: null,
    examined: examined.length,
    polluted: Object.freeze(polluted),
  });
}

/** `cacheRead` as a share of everything the provider was charged to read, with both halves. */
export function cacheReadShare(usages) {
  if (!Array.isArray(usages) || usages.length === 0)
    return Object.freeze({ share: null, notMeasured: "no_provider_usage_records", input: null, cacheRead: null });
  const input = sumOf(usages, "input");
  const cacheRead = sumOf(usages, "cacheRead");
  const billable = input + cacheRead;
  if (billable <= 0) return Object.freeze({ share: null, notMeasured: "no_billable_tokens", input, cacheRead });
  return Object.freeze({ share: cacheRead / billable, notMeasured: null, input, cacheRead });
}

/**
 * The `compaction.tokensBefore` distribution of a session, split by whether Magic Context caused the fold.
 *
 * `examined` counts EVERY compaction the record carried - a Host- or Pi-initiated fold is still a fold this run paid for -
 * while the share the design's threshold is about, and the `tokensBefore` list, are the `magic-context` ones only, because
 * those are the micro-folds §WP-B is fixing. A record with no compaction entry at all is
 * `not_measured:no_compaction_entries_in_session` rather than a zero share that reads as "no folds, all good".
 */
export function compactionDistribution(entries) {
  const folds = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.type !== "compaction") continue;
    if (!Number.isFinite(entry.tokensBefore)) continue;
    folds.push({ tokensBefore: entry.tokensBefore, magicContext: entry.details?.source === "magic-context" });
  }
  if (folds.length === 0)
    return Object.freeze({ notMeasured: "no_compaction_entries_in_session", folds: Object.freeze([]) });
  const magicContext = folds.filter((fold) => fold.magicContext);
  const kept = magicContext.slice(-TOKENS_BEFORE_CAP).map((fold) => fold.tokensBefore);
  return Object.freeze({
    notMeasured: magicContext.length === 0 ? "no_compaction_entry_names_magic_context" : null,
    examined: folds.length,
    magicContextEntries: magicContext.length,
    microFolds: magicContext.filter((fold) => fold.tokensBefore <= MICRO_FOLD_TOKEN_CEILING).length,
    emptyFolds: magicContext.filter((fold) => fold.tokensBefore < MICRO_FOLD_EMPTY_CEILING).length,
    tokensBefore: Object.freeze(kept),
    omitted: Math.max(0, magicContext.length - kept.length),
  });
}

/** How many times the session's assistant turns called one tool. A parse failure is the caller's `not_measured`. */
export function countToolCalls(entries, names) {
  const wanted = new Set(names);
  let count = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
    for (const part of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (part?.type === "toolCall" && wanted.has(part.name)) count += 1;
    }
  }
  return count;
}

/**
 * This continuity's project scope, resolved from the store's own mapping - never re-derived from the vendor's path
 * format, which is why a store that cannot answer produced the double-wrapped identity the memory loop measured.
 *
 * Three tiers, each reported by `kind` so a reader knows which one answered:
 *   1. the project path the Host materialised, when the caller recorded one;
 *   2. `session_projects` for this run's own session - the store's statement about which project a session belongs to;
 *   3. the project path ending in `continuity:<continuityId>`, for a caller holding only the continuity identity.
 * Tier 3 is an exact suffix comparison, not a wildcard, and it refuses when more than one project path matches: two
 * scopes sharing an identity is a question, not an answer.
 */
export function resolveLedgerScope({ db, sessionId = null, projectPath = null, continuityId = null }) {
  const usable = (value) => typeof value === "string" && value.length > 0;
  if (usable(projectPath))
    return Object.freeze({
      kind: "recorded_project_path",
      projectPath,
      sessionId: usable(sessionId) ? sessionId : null,
    });
  if (usable(sessionId)) {
    const rows = readTable(db, "session_projects", (handle) =>
      handle.prepare("SELECT DISTINCT project_path FROM session_projects WHERE session_id = ?").all(sessionId),
    );
    if (!rows.ok) return Object.freeze({ kind: "undetermined", reason: rows.reason });
    const paths = rows.rows.map((row) => row.project_path).filter(usable);
    if (paths.length === 0) return Object.freeze({ kind: "undetermined", reason: "session_project_unbound" });
    if (paths.length > 1)
      return Object.freeze({ kind: "undetermined", reason: `session_project_ambiguous:${String(paths.length)}` });
    return Object.freeze({ kind: "store_session_projects", projectPath: paths[0], sessionId });
  }
  if (usable(continuityId)) {
    const suffix = `continuity:${continuityId}`;
    const rows = readTable(db, "session_projects", (handle) =>
      handle
        .prepare("SELECT DISTINCT project_path FROM session_projects WHERE substr(project_path, -length(?)) = ?")
        .all(suffix, suffix),
    );
    if (!rows.ok) return Object.freeze({ kind: "undetermined", reason: rows.reason });
    const paths = rows.rows.map((row) => row.project_path).filter(usable);
    if (paths.length === 1) return Object.freeze({ kind: "continuity_suffix", projectPath: paths[0], sessionId: null });
    if (paths.length === 0) return Object.freeze({ kind: "undetermined", reason: "continuity_project_unbound" });
    return Object.freeze({ kind: "undetermined", reason: `continuity_project_ambiguous:${String(paths.length)}` });
  }
  return Object.freeze({ kind: "undetermined", reason: "continuity_scope_undetermined" });
}

/**
 * One table read, wrapped.
 *
 * A store that predates a table, a column this fork renamed, or a lock taken by another process must leave only that
 * metric `not_measured` and keep the rest - the alternative is a ledger that cannot be produced on exactly the runs
 * worth reading it for.
 */
function readTable(db, table, read) {
  if (db === null || db === undefined) return { ok: false, reason: `context_db_unavailable` };
  try {
    return { ok: true, rows: read(db) };
  } catch (error) {
    return { ok: false, reason: `context_table_unreadable:${table}`, detail: String(error?.message ?? error) };
  }
}

/** A count over one scoped table, or the reason the scope itself could not be applied. */
function scopedCount(db, table, scopeColumn, scopeValue, unknownReason) {
  const refused = requireScope(unknownReason, scopeValue);
  if (refused !== null) return refused;
  return readTable(db, table, (handle) =>
    handle.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${scopeColumn} = ?`).get(scopeValue),
  );
}

/**
 * A scope refusal must not be reported as an unreadable table.
 *
 * Both leave a metric `not_measured`, and they have different owners: a missing scope is the caller's or the store's
 * silence about which project this run belongs to, while an unreadable table is a store this fork cannot query. The
 * first names the scope, and nothing queries anything - a fallback to the whole table would report another
 * continuity's rows as this run's.
 */
function requireScope(reason, value) {
  return typeof value === "string" && value.length > 0 ? null : { ok: false, reason };
}

/**
 * The continuity-isolation probe: can `freshProjectPath` reach a covenant that `priorProjectPath` holds, through FTS5?
 *
 * A PROBE, NOT A HOPE, which is why it has three outcomes and not two. A query that returns nothing in the FRESH scope
 * proves isolation only if the same query returns something in the scope that is known to hold the covenant; when it
 * returns nothing there either, the probe measured its own blindness, and `not_measured:probe_vacuous` names that
 * instead of reporting a pass. Today's `memories_fts` is `tokenize='porter unicode61'`, which cannot split a run of
 * CJK into words - so a Chinese covenant is exactly the case that comes back vacuous, and `tokenizer` is published
 * beside the verdict so that reading is available from the artifact.
 */
export function probeContinuityIsolation({ db, priorProjectPath, freshProjectPath, terms }) {
  const usable = (value) => typeof value === "string" && value.length > 0;
  if (!usable(priorProjectPath)) return Object.freeze({ status: NOT_MEASURED, notMeasured: "prior_scope_unknown" });
  if (!usable(freshProjectPath)) return Object.freeze({ status: NOT_MEASURED, notMeasured: "fresh_scope_unknown" });
  if (!Array.isArray(terms) || terms.length === 0)
    return Object.freeze({ status: NOT_MEASURED, notMeasured: "covenant_terms_unknown" });
  const query = terms.map((term) => `"${String(term).replace(/"/gu, '""')}"`).join(" OR ");
  const hits = (projectPath) =>
    readTable(db, "memories_fts", (handle) =>
      handle
        .prepare(
          `SELECT m.id AS id FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
            WHERE memories_fts MATCH ? AND m.project_path = ? LIMIT 8`,
        )
        .all(query, projectPath),
    );
  const prior = hits(priorProjectPath);
  if (!prior.ok) return Object.freeze({ status: NOT_MEASURED, notMeasured: prior.reason });
  const fresh = hits(freshProjectPath);
  if (!fresh.ok) return Object.freeze({ status: NOT_MEASURED, notMeasured: fresh.reason });
  const tokenizer = readTable(db, "memories_fts", (handle) =>
    handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get(),
  );
  const reading = Object.freeze({
    query,
    priorHits: prior.rows.length,
    freshHits: fresh.rows.length,
    freshMemoryIds: Object.freeze(fresh.rows.map((row) => row.id)),
    tokenizer: tokenizer.ok ? (/tokenize\s*=\s*'([^']+)'/u.exec(tokenizer.rows?.sql ?? "")?.[1] ?? null) : null,
  });
  if (prior.rows.length === 0)
    return Object.freeze({
      status: NOT_MEASURED,
      notMeasured: "probe_vacuous:the_covenant_is_not_fts5_findable_in_the_scope_that_holds_it",
      ...reading,
    });
  return Object.freeze({ status: fresh.rows.length === 0 ? "measured" : "finding", notMeasured: null, ...reading });
}

/** The funnel rows of one run, each from its own table and its own scope, each able to be `not_measured` alone. */
function collectFunnel({ db, scope }) {
  const sessionId = scope.sessionId;
  const projectPath = scope.projectPath ?? null;
  const sessionScopeMissing = requireScope("session_id_unknown", sessionId);
  const projectScopeMissing = requireScope("project_scope_undetermined", projectPath);
  const out = {};

  const runs = scopedCount(db, "historian_runs", "session_id", sessionId, "session_id_unknown");
  out.historian_runs = runs.ok
    ? { value: runs.rows.count, notMeasured: null }
    : { value: null, notMeasured: runs.reason };

  const faults =
    sessionScopeMissing ??
    readTable(db, "historian_runs", (handle) =>
      handle
        .prepare("SELECT COUNT(*) AS count FROM historian_runs WHERE session_id = ? AND status <> 'success'")
        .get(sessionId),
    );
  out.historian_faults = faults.ok
    ? { value: faults.rows.count, notMeasured: null }
    : { value: null, notMeasured: faults.reason };

  const facts =
    sessionScopeMissing ??
    readTable(db, "historian_runs", (handle) =>
      handle
        .prepare("SELECT COALESCE(SUM(facts_emitted), 0) AS facts FROM historian_runs WHERE session_id = ?")
        .get(sessionId),
    );
  out.candidate_facts_emitted = facts.ok
    ? { value: facts.rows.facts, notMeasured: null }
    : { value: null, notMeasured: facts.reason };

  const memories =
    projectScopeMissing ??
    readTable(db, "memories", (handle) =>
      handle
        .prepare("SELECT id, content, category, status FROM memories WHERE project_path = ? ORDER BY id")
        .all(projectPath),
    );
  out.memories_promoted = memories.ok
    ? { value: memories.rows.length, notMeasured: null }
    : { value: null, notMeasured: memories.reason };

  const chapters = scopedCount(db, "chapters", "session_id", sessionId, "session_id_unknown");
  out.chapters_sealed = chapters.ok
    ? { value: chapters.rows.count, notMeasured: null }
    : { value: null, notMeasured: chapters.reason };

  for (const table of ["notes", "primers", "dream_runs"]) {
    const counted = scopedCount(db, table, "project_path", projectPath, "project_scope_undetermined");
    out[table] = counted.ok
      ? { value: counted.rows.count, notMeasured: null }
      : { value: null, notMeasured: counted.reason };
  }

  return { values: out, memoryRows: memories.ok ? memories.rows : null };
}

/**
 * ADMISSION REFUSALS HAVE NO PRODUCER, and that is a fact about the product rather than about this run.
 *
 * `ongoing-interaction-admission.ts` refuses a candidate during PARSING, before any row exists, so "how many were
 * refused, and why" cannot be read out of any table (§WP-B states the same gap). The two numbers that ARE recorded - `candidate_facts_emitted` and `memories_promoted` - travel beside it, so the gap has a size instead of being
 * invisible.
 */
const ADMISSION_REFUSALS = Object.freeze({ value: null, notMeasured: "parser_refusals_are_not_persisted" });

/** The comparison one row's threshold makes, or a named violation. */
function judge(row, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (row.threshold === null) return null;
  const failed = row.threshold.kind === "at_least" ? value < row.threshold.value : value > row.threshold.value;
  if (!failed) return null;
  const comparator = row.threshold.kind === "at_least" ? "below" : "above";
  return Object.freeze({
    code: `${row.id}_${comparator}_threshold`,
    detail: `${row.id} = ${String(value)} is ${comparator} the ${String(row.threshold.value)} ${row.wp} allows`,
  });
}

/**
 * The ledger: every metric row with the artifact it came from, every red line with its population, and the scope the
 * store was read through.
 *
 * `contextDbPath` may be omitted and will be found under `runDir`/`contextsRoot`; a store that is not found leaves the
 * funnel `not_measured:context_db_not_found` and still produces the session half, because a run whose store was not
 * written can still have spent its cache.
 */
export function collectMemoryCacheLedger({
  runDir = null,
  contextsRoot = null,
  contextDbPath = null,
  sessionPath = null,
  sessionId = null,
  projectPath = null,
  continuityId = null,
  priorScope = null,
  covenantTerms = [],
} = {}) {
  const dbPath =
    typeof contextDbPath === "string" && contextDbPath.length > 0 ? contextDbPath : findContextDb(runDir, contextsRoot);
  let db = null;
  let dbReason = null;
  if (dbPath === null) dbReason = "context_db_not_found";
  else {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      dbReason = "context_db_unreadable";
    }
  }

  try {
    const scope =
      db === null
        ? Object.freeze({ kind: "undetermined", reason: dbReason, projectPath: null, sessionId })
        : resolveLedgerScope({ db, sessionId, projectPath, continuityId });
    const baseValues = db === null ? { values: emptyFunnel(dbReason), memoryRows: null } : collectFunnel({ db, scope });
    const funnel = {
      values: { ...baseValues.values, admission_refusals: ADMISSION_REFUSALS },
      memoryRows: baseValues.memoryRows,
    };

    const session =
      typeof sessionPath === "string" && sessionPath.length > 0
        ? readSession(sessionPath)
        : { ok: false, reason: "no_session_record" };

    const values = { ...funnel.values, ...sessionValues(session) };

    const rows = MEASURED_ROWS.map((spec) => {
      const reading = values[spec.id] ?? { value: null, notMeasured: "no_producer_for_this_row" };
      const measured = reading.notMeasured === null;
      const violation = measured ? judge(spec, reading.value) : null;
      return Object.freeze({
        ...spec,
        value: measured ? reading.value : null,
        notMeasured: reading.notMeasured,
        status: measured ? (violation === null ? "measured" : "finding") : NOT_MEASURED,
        violation,
        // RECORDED FIRST, BLOCK LATER (design §5): no row here can fail a run yet, and each names the obligation that
        // will make it - the work package, the threshold and what the gate reads.
        blocking: false,
        becomesBlocking: spec.becomesBlocking,
      });
    });

    const redLines = RED_LINE_ROWS.map((spec) => {
      const reading = redLineReading(spec.id, { db, scope, values, funnel, priorScope, covenantTerms });
      return Object.freeze({ ...spec, ...reading, blocking: false });
    });

    const findings = [
      ...rows.filter((row) => row.violation !== null).map((row) => row.violation),
      ...redLines
        .filter((line) => line.status === "finding")
        .map((line) => ({
          code: `redline_${line.id}`,
          detail: line.detail ?? `${line.id} tripped`,
        })),
    ];

    return Object.freeze({
      state: findings.length === 0 ? "recorded" : "findings",
      dbPath,
      dbReason,
      scope,
      sessionPath,
      rows: Object.freeze(rows),
      redLines: Object.freeze(redLines),
      findings: Object.freeze(findings),
      blocking: false,
      // The distribution behind `micro_fold_share`, published because the design's baseline IS a distribution (the
      // 34.2 % band below 250 tokens) and a share alone cannot show where a run's folds sat.
      compactions: values._compactions ?? null,
      // The artifact table itself travels with every ledger, so a reader of one run's JSON can see which file each
      // number came from without opening this module.
      artifacts: Object.freeze(Object.fromEntries(rows.map((row) => [row.id, row.artifact]))),
      counts: Object.freeze({
        examined: rows.length,
        measured: rows.filter((row) => row.status !== NOT_MEASURED).length,
        notMeasured: rows.filter((row) => row.status === NOT_MEASURED).length,
        findings: findings.length,
      }),
    });
  } finally {
    if (db !== null) db.close();
  }
}

/** The session half of the ledger: cache, folds and the two tool-call counts, or why none of them could be read. */
function sessionValues(session) {
  if (!session.ok) {
    const reason = session.reason;
    return {
      cache_read_share: { value: null, notMeasured: reason },
      micro_fold_share: { value: null, notMeasured: reason },
      micro_fold_below_100_tokens: { value: null, notMeasured: reason },
      manual_ctx_reduce_calls: { value: null, notMeasured: reason },
      reader_calls: { value: null, notMeasured: reason },
      _cacheReadShare: null,
      _compactions: null,
    };
  }
  const share = cacheReadShare(session.usages);
  const compactions = compactionDistribution(session.entries);
  const microShare =
    compactions.notMeasured !== null || compactions.magicContextEntries === 0
      ? null
      : compactions.microFolds / compactions.magicContextEntries;
  return {
    cache_read_share: { value: share.share, notMeasured: share.notMeasured },
    micro_fold_share: {
      // A session that folded nothing has no micro-fold SHARE: the ratio would be 0/0, and printing 0 would say the run
      // folded cheaply when it never folded. `compactionDistribution` already calls that case `not_measured`.
      value: microShare,
      notMeasured: compactions.notMeasured,
    },
    micro_fold_below_100_tokens:
      compactions.notMeasured === null
        ? { value: compactions.emptyFolds, notMeasured: null }
        : { value: null, notMeasured: compactions.notMeasured },
    manual_ctx_reduce_calls: { value: countToolCalls(session.entries, [MANUAL_RECLAIM_TOOL]), notMeasured: null },
    reader_calls: { value: countToolCalls(session.entries, READER_TOOLS), notMeasured: null },
    _cacheReadShare: share,
    _compactions: compactions,
  };
}

/** The funnel's `not_measured` shape when the store itself could not be opened. */
function emptyFunnel(reason) {
  return Object.fromEntries(
    MEASURED_ROWS.filter((row) => row.artifact.startsWith("context.db")).map((row) => [
      row.id,
      { value: null, notMeasured: reason },
    ]),
  );
}

/** One red line's reading. Each answers a different artifact, so each is asked here rather than in the row table. */
function redLineReading(id, { db, scope, values, funnel, priorScope, covenantTerms }) {
  if (id === "memory_pollution") {
    if (funnel.memoryRows === null)
      return {
        status: NOT_MEASURED,
        notMeasured: values.memories_promoted.notMeasured,
        examined: 0,
        polluted: Object.freeze([]),
      };
    const assessed = assessMemoryPollution(funnel.memoryRows);
    return {
      status: assessed.status,
      notMeasured: assessed.notMeasured,
      examined: assessed.examined,
      polluted: assessed.polluted,
      detail:
        assessed.status === "finding"
          ? `${String(assessed.polluted.length)} of ${String(assessed.examined)} memories in scope are machine ledgers: ${assessed.polluted.map((row) => `#${String(row.id)} ${row.shapes.join("+")}`).join(", ")}`
          : null,
    };
  }
  if (id === "continuity_isolation") {
    const probe = probeContinuityIsolation({
      db,
      priorProjectPath: priorScope?.projectPath ?? null,
      freshProjectPath: scope.projectPath ?? null,
      terms: covenantTerms,
    });
    return {
      status: probe.status,
      notMeasured: probe.notMeasured,
      ...probe,
      detail:
        probe.status === "finding"
          ? `the fresh scope reached ${String(probe.freshHits)} memory row(s) holding the prior continuity's covenant (${probe.query})`
          : null,
    };
  }
  const share = values._cacheReadShare;
  if (share === null || share === undefined || share.notMeasured !== null)
    return {
      status: NOT_MEASURED,
      notMeasured: share?.notMeasured ?? "no_session_record",
      cacheRead: null,
      input: null,
      share: null,
    };
  const below = share.share < CACHE_READ_SHARE_FLOOR;
  return {
    status: below ? "finding" : "measured",
    notMeasured: null,
    cacheRead: share.cacheRead,
    input: share.input,
    share: share.share,
    detail: below
      ? `cacheRead ${String(share.cacheRead)} of input+cacheRead ${String(share.cacheRead + share.input)} = ${(share.share * 100).toFixed(1)} %, below the ${String(CACHE_READ_SHARE_FLOOR * 100)} % the prefix cache already holds`
      : null,
  };
}

/** The session record, read once: usages through the module that owns them, entries through the one that skips. */
function readSession(sessionPath) {
  let usages;
  let entries;
  try {
    usages = readUsages(sessionPath).usages;
    entries = readSessionEntries(sessionPath);
  } catch {
    return { ok: false, reason: "session_record_unreadable" };
  }
  return { ok: true, usages, entries };
}

/** One line a reader can grep, plus the population and what was not measurable. */
export function describeMemoryCacheLedger(ledger) {
  const scope = ledger.scope.projectPath ?? `${NOT_MEASURED}:${ledger.scope.reason}`;
  const parts = ledger.rows.map((row) => {
    if (row.status === NOT_MEASURED) return `${row.id}=${NOT_MEASURED}:${row.notMeasured}`;
    return `${row.id}=${formatValue(row.value)}${row.status === "finding" ? "(!)" : ""}`;
  });
  for (const line of ledger.redLines) {
    const population = Number.isInteger(line.examined) ? ` (examined ${String(line.examined)})` : "";
    parts.push(
      line.status === NOT_MEASURED
        ? `redline_${line.id}=${NOT_MEASURED}:${line.notMeasured}`
        : `redline_${line.id}=${line.status}${population}`,
    );
  }
  return `scope ${scope} · ${parts.join(" · ")}`;
}

function formatValue(value) {
  if (typeof value !== "number") return String(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}
