import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  assessMemoryPollution,
  CACHE_READ_SHARE_FLOOR,
  cacheReadShare,
  collectMemoryCacheLedger,
  compactionDistribution,
  countToolCalls,
  describeMemoryCacheLedger,
  MEASURED_ROWS,
  NOT_MEASURED,
  pollutionShapesIn,
  probeContinuityIsolation,
  resolveLedgerScope,
} from "./memory-cache-ledger.mjs";

/**
 * The ledger is only worth having if each of its numbers can be pointed at a file, so every case below builds the FILE
 * and asserts the number the file implies. Nothing is mocked: a real `context.db` is opened through `node:sqlite` and a
 * real session `.jsonl` is parsed, because the two defects this module exists to survive - a reader that threw and a
 * counter that was never published - are both invisible to a test double.
 *
 * The fixture DDL below carries the columns the READER touches, under the names the vendor store really uses
 * (`storage-db.ts` `memories` / `memory_fts` / `session_projects` / `historian_runs`, `migrations.ts` `notes` /
 * `chapters`). It is the reader's contract, not a second copy of the store's schema.
 */

const SESSION_ID = "01a20cfb-0000-4000-8000-000000000001";
const OWN_SCOPE = "gamebuddy:runtime:continuity:continuity_new";
const PRIOR_SCOPE = "gamebuddy:runtime:continuity:continuity_old";

const DDL = Object.freeze({
  memories: `CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'active'
  )`,
  // The real index is external-content over `memories`, which is what makes `memories_fts.rowid = memories.id`.
  memories_fts: `CREATE VIRTUAL TABLE memories_fts USING fts5(
    content, category, content='memories', content_rowid='id', tokenize='porter unicode61'
  )`,
  session_projects: `CREATE TABLE session_projects (
    session_id TEXT NOT NULL, harness TEXT NOT NULL, project_path TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`,
  historian_runs: `CREATE TABLE historian_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, status TEXT NOT NULL,
    failure_reason TEXT, facts_emitted INTEGER NOT NULL DEFAULT 0
  )`,
  chapters: `CREATE TABLE chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project_path TEXT NOT NULL,
    title TEXT NOT NULL, content TEXT NOT NULL
  )`,
  notes: `CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, session_id TEXT, project_path TEXT
  )`,
  primers: `CREATE TABLE primers (id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL, question TEXT NOT NULL)`,
  dream_runs: `CREATE TABLE dream_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL)`,
});

function withStore(dir, tables, write) {
  const dbPath = join(dir, "context.db");
  const db = new DatabaseSync(dbPath);
  try {
    for (const table of tables) db.exec(DDL[table]);
    write(db);
  } finally {
    db.close();
  }
  return dbPath;
}

function memoryFtsMirror(db, id, content, category) {
  db.prepare("INSERT INTO memories_fts(rowid, content, category) VALUES (?, ?, ?)").run(id, content, category);
}

/** The layout `findContextDb` reads for a CAPTURE: `<run>/runtime-root/contexts/<ctx>/data/cortexkit/magic-context/`. */
function storeInRunLayout(runDir) {
  return join(runDir, "runtime-root", "contexts", "ctx", "data", "cortexkit", "magic-context");
}

function writeSession(path, lines) {
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return path;
}

const assistantToolCall = (name, usage) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", name, arguments: {} }],
    usage: usage ?? { input: 10, cacheRead: 90 },
  },
});

const fold = (tokensBefore, source) => ({
  type: "compaction",
  tokensBefore,
  ...(source === undefined ? {} : { details: { source } }),
});

let scratch = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-cache-ledger-"));
  scratch.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

// ----------------------------------------------------------------------------------------------------------------
// Proof 1: a constructed run directory yields the ledger with exactly the values it was built with.
// ----------------------------------------------------------------------------------------------------------------

test("a constructed run yields every row with the value its own artifact carries", () => {
  const runDir = tempDir();
  mkdirSync(storeInRunLayout(runDir), { recursive: true });
  withStore(
    storeInRunLayout(runDir),
    ["memories", "memories_fts", "session_projects", "historian_runs", "chapters", "notes", "primers", "dream_runs"],
    (db) => {
      db.prepare("INSERT INTO session_projects VALUES (?, 'pi', ?, 1)").run(SESSION_ID, OWN_SCOPE);
      // Two candidates emitted, one historian run in fault: the funnel the design asks for, from the run's session.
      db.prepare(
        "INSERT INTO historian_runs (session_id, status, failure_reason, facts_emitted) VALUES (?, ?, ?, ?)",
      ).run(SESSION_ID, "success", null, 2);
      db.prepare(
        "INSERT INTO historian_runs (session_id, status, failure_reason, facts_emitted) VALUES (?, ?, ?, ?)",
      ).run(SESSION_ID, "failed", "length", 0);
      db.prepare("INSERT INTO chapters (session_id, project_path, title, content) VALUES (?, ?, ?, ?)").run(
        SESSION_ID,
        OWN_SCOPE,
        "春耕开荒",
        "chapter body",
      );
      db.prepare("INSERT INTO notes (content, session_id, project_path) VALUES ('a note she keeps', ?, ?)").run(
        SESSION_ID,
        OWN_SCOPE,
      );
      db.prepare("INSERT INTO primers (project_path, question) VALUES (?, 'where is the oak')").run(OWN_SCOPE);
      db.prepare("INSERT INTO dream_runs (project_path) VALUES (?)").run(OWN_SCOPE);
      const memory = db.prepare("INSERT INTO memories (project_path, category, content) VALUES (?, ?, ?)");
      memory.run(OWN_SCOPE, "SEMANTIC_MEMORY", "她说东边的橡树先别动，等她回来一起看。");
      memoryFtsMirror(db, 1, "她说东边的橡树先别动，等她回来一起看。", "SEMANTIC_MEMORY");
      memory.run(OWN_SCOPE, "INTERACTION_EPISODE", "她答应过春天一起去看矿洞。");
      memoryFtsMirror(db, 2, "她答应过春天一起去看矿洞。", "INTERACTION_EPISODE");
    },
  );
  // A second continuity's memories sit in the same store: they must never be summed into this run's scope.
  withStore(storeInRunLayout(runDir), [], (db) => {
    db.prepare("INSERT INTO memories (project_path, category, content) VALUES (?, 'SEMANTIC_MEMORY', 'theirs')").run(
      PRIOR_SCOPE,
    );
  });

  const sessionPath = writeSession(join(runDir, "session.jsonl"), [
    assistantToolCall("ctx_reduce"),
    assistantToolCall("ctx_reduce"),
    assistantToolCall("ctx_reduce"),
    assistantToolCall("ctx_reduce"),
    assistantToolCall("ctx_reduce"),
    assistantToolCall("ctx_search"),
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "好。" }], usage: { input: 90, cacheRead: 810 } },
    },
    fold(24, "magic-context"),
    fold(6_048, "magic-context"),
  ]);

  const ledger = collectMemoryCacheLedger({ runDir, sessionPath, sessionId: SESSION_ID });

  assert.equal(ledger.dbReason, null);
  assert.equal(ledger.scope.kind, "store_session_projects");
  assert.equal(ledger.scope.projectPath, OWN_SCOPE, "the store's own mapping decides the project scope");

  const row = (id) => ledger.rows.find((entry) => entry.id === id);
  // Six tool-call turns at `{input: 10, cacheRead: 90}` plus one reply at `{input: 90, cacheRead: 810}`: the share is
  // cacheRead 1,350 of input+cacheRead 1,500, which is the arithmetic the artifact itself carries.
  assert.equal(row("cache_read_share").value, 0.9);
  assert.equal(row("cache_read_share").status, "measured", "0.909 is above the 0.80 floor");
  // One of two Magic Context folds was 24 tokens: the band §WP-B wants under 5 %.
  assert.equal(row("micro_fold_share").value, 0.5);
  assert.equal(row("micro_fold_share").status, "finding");
  assert.deepEqual(row("micro_fold_share").violation.code, "micro_fold_share_above_threshold");
  assert.equal(row("micro_fold_below_100_tokens").value, 1);
  assert.equal(row("micro_fold_below_100_tokens").status, "finding");
  assert.equal(row("manual_ctx_reduce_calls").value, 5);
  assert.equal(row("manual_ctx_reduce_calls").status, "finding", "5 calls is above the 2 §WP-E allows");
  assert.equal(row("reader_calls").value, 1);
  assert.equal(row("reader_calls").status, "measured");
  assert.equal(row("historian_runs").value, 2);
  assert.equal(row("historian_faults").value, 1);
  assert.equal(row("candidate_facts_emitted").value, 2);
  assert.equal(row("memories_promoted").value, 2, "the prior continuity's row is not in this scope");
  assert.equal(row("chapters_sealed").value, 1);
  assert.equal(row("notes").value, 1);
  assert.equal(row("primers").value, 1);
  assert.equal(row("dream_runs").value, 1);

  // The distribution travels beside the share, because the design's baseline IS a distribution.
  assert.deepEqual(ledger.compactions.tokensBefore, [24, 6_048]);
  assert.equal(ledger.compactions.magicContextEntries, 2);
  assert.equal(ledger.compactions.emptyFolds, 1);

  // Every row names the artifact it came from, and every row is recorded rather than blocking.
  for (const entry of ledger.rows) assert.equal(typeof entry.artifact, "string");
  assert.equal(ledger.blocking, false);
  assert.equal(ledger.state, "findings");
  assert.match(describeMemoryCacheLedger(ledger), /scope gamebuddy:runtime:continuity:continuity_new/u);
  assert.match(describeMemoryCacheLedger(ledger), /cache_read_share=0\.9000/u);
});

// ----------------------------------------------------------------------------------------------------------------
// Proof 2: a missing artifact is `not_measured` with its reason - never a zero.
// ----------------------------------------------------------------------------------------------------------------

test("a run with no store and no session record reports not_measured for every row and no zero anywhere", () => {
  const runDir = tempDir();
  const ledger = collectMemoryCacheLedger({ runDir, sessionId: SESSION_ID });

  assert.equal(ledger.dbPath, null);
  assert.equal(ledger.dbReason, "context_db_not_found");
  for (const entry of ledger.rows) {
    assert.equal(entry.status, NOT_MEASURED, `${entry.id} must not read as measured`);
    assert.equal(entry.value, null, `${entry.id} must be null, never a fabricated 0`);
    assert.notEqual(entry.notMeasured, null, `${entry.id} must name why it is missing`);
  }
  const reason = (id) => ledger.rows.find((entry) => entry.id === id).notMeasured;
  assert.equal(reason("cache_read_share"), "no_session_record");
  assert.equal(reason("historian_runs"), "context_db_not_found");
  assert.equal(reason("memories_promoted"), "context_db_not_found");
  // The admission counter has no producer in the product at all, and says so rather than borrowing the store's reason.
  assert.equal(reason("admission_refusals"), "parser_refusals_are_not_persisted");
  assert.match(describeMemoryCacheLedger(ledger), /cache_read_share=not_measured:no_session_record/u);
});

test("a store missing one table leaves that row not_measured and keeps the other nine", () => {
  const runDir = tempDir();
  mkdirSync(storeInRunLayout(runDir), { recursive: true });
  // No `dream_runs` table: a store that predates it must not take the ledger down with it.
  withStore(storeInRunLayout(runDir), ["memories", "memories_fts", "session_projects"], (db) => {
    db.prepare("INSERT INTO session_projects VALUES (?, 'pi', ?, 1)").run(SESSION_ID, OWN_SCOPE);
  });
  const ledger = collectMemoryCacheLedger({ runDir, sessionId: SESSION_ID });
  const row = (id) => ledger.rows.find((entry) => entry.id === id);
  assert.equal(row("dream_runs").notMeasured, "context_table_unreadable:dream_runs");
  assert.equal(row("memories_promoted").value, 0, "a real, measured zero: the table exists and is empty");
  assert.equal(row("memories_promoted").notMeasured, null);
  assert.equal(row("dream_runs").value, null);
});

test("a session whose project the store cannot name reports not_measured instead of reading every scope", () => {
  const runDir = tempDir();
  mkdirSync(storeInRunLayout(runDir), { recursive: true });
  withStore(storeInRunLayout(runDir), ["memories", "memories_fts", "session_projects"], (db) => {
    // Two project paths claim this session: a question, not an answer.
    const insert = db.prepare("INSERT INTO session_projects VALUES (?, 'pi', ?, 1)");
    insert.run(SESSION_ID, OWN_SCOPE);
    insert.run(SESSION_ID, PRIOR_SCOPE);
    db.prepare("INSERT INTO memories (project_path, category, content) VALUES (?, 'SEMANTIC_MEMORY', 'x')").run(
      PRIOR_SCOPE,
    );
  });
  const ledger = collectMemoryCacheLedger({ runDir, sessionId: SESSION_ID });
  assert.equal(ledger.scope.kind, "undetermined");
  assert.equal(ledger.scope.reason, "session_project_ambiguous:2");
  const promotes = ledger.rows.find((entry) => entry.id === "memories_promoted");
  assert.equal(promotes.value, null, "an ambiguous scope must not fall back to a global read");
  assert.equal(promotes.notMeasured, "project_scope_undetermined");

  const noSession = tempDir();
  assert.equal(
    resolveLedgerScope({ db: null, sessionId: null, projectPath: null, continuityId: null }).reason,
    "continuity_scope_undetermined",
  );
  assert.equal(collectMemoryCacheLedger({ runDir: noSession }).scope.reason, "context_db_not_found");
});

// ----------------------------------------------------------------------------------------------------------------
// Proof 3: a polluted memory trips red line (a), and the population is always printed.
// ----------------------------------------------------------------------------------------------------------------

test("a memory whose text is a machine ledger trips the pollution red line, named by shape", () => {
  const runDir = tempDir();
  mkdirSync(storeInRunLayout(runDir), { recursive: true });
  withStore(storeInRunLayout(runDir), ["memories", "memories_fts", "session_projects"], (db) => {
    db.prepare("INSERT INTO session_projects VALUES (?, 'pi', ?, 1)").run(SESSION_ID, OWN_SCOPE);
    const insert = db.prepare("INSERT INTO memories (project_path, category, content) VALUES (?, ?, ?)");
    insert.run(OWN_SCOPE, "INTERACTION_EPISODE", "她答应过春天一起去看矿洞。");
    insert.run(
      OWN_SCOPE,
      "SEMANTIC_MEMORY",
      "stardew_plan_work plan_9f3ab21c accepted; chest_retrieve receipt state=succeeded actionId=stardew_chest_retrieve requestId=7f2a",
    );
  });
  const ledger = collectMemoryCacheLedger({ runDir, sessionId: SESSION_ID });
  const pollution = ledger.redLines.find((line) => line.id === "memory_pollution");
  assert.equal(pollution.status, "finding");
  assert.equal(pollution.examined, 2, "the population examined is part of the answer");
  assert.deepEqual(pollution.polluted, [
    { id: 2, shapes: ["plan_identifier", "key_value_chain", "tool_log_sentence"] },
  ]);
  assert.match(pollution.detail, /1 of 2 memories/u);
  assert.ok(ledger.findings.some((entry) => entry.code === "redline_memory_pollution"));
});

test("the pollution check measures shape: a receipt word in a sentence about her life is not pollution", () => {
  // A word list would fail the first line and a bare shape test would miss the second. Both directions are asserted.
  assert.deepEqual(pollutionShapesIn("她把收据夹在账簿里，说这是镇上最好的种子钱。"), []);
  assert.deepEqual(pollutionShapesIn("她说东边那棵树先别动，等我回来一起看。"), []);
  assert.deepEqual(pollutionShapesIn("revision 7"), ["revision_marker"]);
  assert.deepEqual(pollutionShapesIn("plan_9f3ab21c"), ["plan_identifier"]);
  assert.deepEqual(pollutionShapesIn("a=1 b=2 c=3"), ["key_value_chain"]);
  // `receipt` alone carries no code identifier, so it is not the tool-log shape; beside two it is.
  assert.deepEqual(pollutionShapesIn("the receipt is on the table"), []);
  assert.deepEqual(pollutionShapesIn("chest_retrieve receipt rejected: not_accepted"), ["tool_log_sentence"]);
  assert.deepEqual(pollutionShapesIn(""), []);
});

test("the pollution red line reports a measured zero population as not_measured, never as a pass", () => {
  // The design's own baseline: `memories = 0`. A clean-looking empty set proves nothing, so it must not read as clean.
  const assessed = assessMemoryPollution([]);
  assert.equal(assessed.status, NOT_MEASURED);
  assert.equal(assessed.notMeasured, "no_memories_in_the_continuity_scope");
  assert.equal(assessed.examined, 0);
  const clean = assessMemoryPollution([{ id: 1, content: "她答应过春天一起去看矿洞。" }]);
  assert.equal(clean.status, "measured");
  assert.equal(clean.examined, 1);
});

// ----------------------------------------------------------------------------------------------------------------
// Proof 4: a second continuity that sees the first's covenant trips red line (b) - and a blind probe says so.
// ----------------------------------------------------------------------------------------------------------------

test("a fresh continuity that reaches the prior continuity's covenant through FTS5 trips the isolation red line", () => {
  const dir = tempDir();
  const covenant = "keep the oak by the east fence until I get back";
  const dbPath = withStore(dir, ["memories", "memories_fts"], (db) => {
    const insert = db.prepare(
      "INSERT INTO memories (project_path, category, content) VALUES (?, 'SEMANTIC_MEMORY', ?)",
    );
    insert.run(PRIOR_SCOPE, covenant);
    memoryFtsMirror(db, 1, covenant, "SEMANTIC_MEMORY");
    // The leak: the same fact, under the fresh continuity's project path.
    insert.run(OWN_SCOPE, covenant);
    memoryFtsMirror(db, 2, covenant, "SEMANTIC_MEMORY");
  });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const leak = probeContinuityIsolation({
      db,
      priorProjectPath: PRIOR_SCOPE,
      freshProjectPath: OWN_SCOPE,
      terms: ["oak", "east", "fence"],
    });
    assert.equal(leak.status, "finding");
    assert.equal(leak.priorHits, 1);
    assert.equal(leak.freshHits, 1);
    assert.deepEqual(leak.freshMemoryIds, [2]);
    assert.equal(leak.tokenizer, "porter unicode61");
    assert.match(leak.query, /"oak" OR "east" OR "fence"/u);

    const isolated = probeContinuityIsolation({
      db,
      priorProjectPath: PRIOR_SCOPE,
      freshProjectPath: "gamebuddy:runtime:continuity:a_third_one",
      terms: ["oak", "east", "fence"],
    });
    assert.equal(isolated.status, "measured");
    assert.equal(isolated.freshHits, 0);
    assert.equal(isolated.priorHits, 1, "non-vacuity: the query does find the covenant where it lives");
  } finally {
    db.close();
  }
});

test("a probe that finds nothing in the scope that HOLDS the covenant is not_measured, not a pass", () => {
  const dir = tempDir();
  // A CJK covenant, which `unicode61` indexes as one token per contiguous run: the query cannot reach it at all.
  const dbPath = withStore(dir, ["memories", "memories_fts"], (db) => {
    db.prepare("INSERT INTO memories (project_path, category, content) VALUES (?, 'SEMANTIC_MEMORY', ?)").run(
      PRIOR_SCOPE,
      "东边那棵树先别动",
    );
    memoryFtsMirror(db, 1, "东边那棵树先别动", "SEMANTIC_MEMORY");
  });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const vacuous = probeContinuityIsolation({
      db,
      priorProjectPath: PRIOR_SCOPE,
      freshProjectPath: OWN_SCOPE,
      terms: ["东边", "树"],
    });
    assert.equal(vacuous.status, NOT_MEASURED);
    assert.match(vacuous.notMeasured, /^probe_vacuous:/u);
    assert.equal(vacuous.priorHits, 0, "the scope that holds the covenant was reached by nothing");
    assert.equal(vacuous.freshHits, 0, "and a fresh zero beside it would have read as isolation");
  } finally {
    db.close();
  }
});

test("a run with no prior scope reports the isolation red line not_measured with the scope it would need", () => {
  const runDir = tempDir();
  mkdirSync(storeInRunLayout(runDir), { recursive: true });
  withStore(storeInRunLayout(runDir), ["memories", "memories_fts", "session_projects"], (db) => {
    db.prepare("INSERT INTO session_projects VALUES (?, 'pi', ?, 1)").run(SESSION_ID, OWN_SCOPE);
  });
  const ledger = collectMemoryCacheLedger({ runDir, sessionId: SESSION_ID });
  const isolation = ledger.redLines.find((line) => line.id === "continuity_isolation");
  assert.equal(isolation.status, NOT_MEASURED);
  assert.equal(isolation.notMeasured, "prior_scope_unknown");
  // The red line states what turns it into a failure, so "recorded" is not "forgotten".
  assert.match(isolation.becomesBlocking, /WP-C/u);
});

// ----------------------------------------------------------------------------------------------------------------
// The cache red line, and the pieces the ledger shares with the modules that already own them.
// ----------------------------------------------------------------------------------------------------------------

test("a cacheRead share below 80 % is a finding printed with both of its numbers", () => {
  const runDir = tempDir();
  const sessionPath = writeSession(join(runDir, "session.jsonl"), [
    { type: "message", message: { role: "assistant", content: [], usage: { input: 800, cacheRead: 200 } } },
  ]);
  const ledger = collectMemoryCacheLedger({ runDir, sessionPath, sessionId: SESSION_ID });
  const cache = ledger.redLines.find((line) => line.id === "cache_read");
  assert.equal(cache.status, "finding");
  assert.equal(cache.cacheRead, 200);
  assert.equal(cache.input, 800);
  assert.equal(cache.share, 0.2);
  assert.match(cache.detail, /cacheRead 200 of input\+cacheRead 1000 = 20\.0 %/u);
  assert.match(cache.detail, new RegExp(`below the ${String(CACHE_READ_SHARE_FLOOR * 100)} %`, "u"));

  // Above the floor is measured, and the share is the one both halves imply.
  const healthy = cacheReadShare([
    { input: 100, cacheRead: 900 },
    { input: 0, cacheRead: 0 },
  ]);
  assert.equal(healthy.share, 0.9);
  assert.equal(cacheReadShare([]).notMeasured, "no_provider_usage_records");
  assert.equal(cacheReadShare([{ input: 0, cacheRead: 0 }]).notMeasured, "no_billable_tokens");
});

test("a session that never folded reports no micro-fold share rather than a zero share", () => {
  assert.equal(compactionDistribution([]).notMeasured, "no_compaction_entries_in_session");
  assert.equal(compactionDistribution([fold(24)]).notMeasured, "no_compaction_entry_names_magic_context");
  const mixed = compactionDistribution([fold(24, "magic-context"), fold(6_048), fold(600, "magic-context")]);
  assert.equal(mixed.examined, 3, "every fold the record carried is counted");
  assert.equal(mixed.magicContextEntries, 2, "the share is over the folds Magic Context caused");
  assert.equal(mixed.microFolds, 1);
  assert.deepEqual(mixed.tokensBefore, [24, 600]);
  assert.deepEqual(countToolCalls([], ["ctx_reduce"]), 0);
  assert.deepEqual(
    countToolCalls([assistantToolCall("ctx_reduce"), assistantToolCall("ctx_expand")], ["ctx_expand"]),
    1,
  );
});

test("every row in the artifact table is a declared row, so no metric can be dropped silently", () => {
  const ledger = collectMemoryCacheLedger({});
  assert.equal(ledger.rows.length, MEASURED_ROWS.length);
  assert.deepEqual(
    ledger.rows.map((row) => row.id),
    MEASURED_ROWS.map((row) => row.id),
  );
  for (const row of ledger.rows) {
    assert.equal(row.blocking, false, `${row.id} is recorded, not blocking, in this first state`);
    assert.equal(typeof row.wp, "string");
    // "Recorded now" is only honest beside the obligation that changes it, so every row names one.
    assert.equal(typeof row.becomesBlocking, "string", `${row.id} must name how it becomes blocking`);
  }
  for (const line of ledger.redLines) assert.equal(typeof line.becomesBlocking, "string");
  assert.equal(ledger.counts.examined, MEASURED_ROWS.length);
});
