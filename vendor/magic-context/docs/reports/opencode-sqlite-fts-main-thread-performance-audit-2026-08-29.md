# OpenCode / Magic Context SQLite FTS main-thread performance audit

Date: 2026-08-29

## Executive result

The 5-second native sample proves that PID 18893 (`opencode serve`) spent 1,597 of 2,663 main-thread samples (60.0%) under `sqlite3_step -> sqlite3VdbeExec -> fts5NextMethod`; 856 samples (32.1% of the whole sample) were stopped in `pread`. It does **not** identify the SQL statement, virtual table, or caller.

The attribution to Magic Context is strong but not absolute. At measurement time the process had `~/.local/share/cortexkit/magic-context/context.db` open, that database contains all four relevant FTS5 tables, and the on-disk `opencode.db` had zero FTS5 tables. The sample alone cannot exclude an ephemeral/in-memory FTS table or identify one Magic Context call site over another.

Direct source and database measurements change the ranking of suspects:

1. **The highest-confidence whale is not a normal `MATCH` query.** `message-index.ts` checks duplicate membership with `SELECT COUNT(*) FROM message_history_fts WHERE session_id=? AND message_id=?`. Both columns are `UNINDEXED`; the plan is a full FTS virtual-table scan. One lookup took 0.30-0.52s warm and missed 290,492 SQLite pages, essentially the 290,471 pages occupied by `message_history_fts_content`. A 100-message reconciliation page can therefore spend roughly 30-52s in 100 serial full scans before insert work. The indexed `message_history_source` primary-key lookup measured 0.008-0.019ms.
2. **Two other non-`MATCH` paths have the same full-scan plan:** session/range/message deletes and compartment chunk text reads. A bounded ordinal chunk read still took 0.30-0.32s because `session_id` and `message_ordinal` are not B-tree indexed. Session cleanup uses the same FTS scan; the HTTP probe's five session-delete calls took 339-801ms, the same scale as one measured scan.
3. **AUTO-SEARCH is synchronous on the host main thread and is prompt-path work, but a realistic selective six-term AND query was smaller:** approximately 0.09-0.20s warm, with first-run copy observations ranging from 0.13s to 1.50s depending on cache state. A common one-term query was 0.21-0.39s warm and 1.59s on a fresh-copy first run. The 3-second Promise race cannot interrupt `bun:sqlite`; its timer cannot fire while `sqlite3_step` blocks the event loop.
4. **The “async” reconciler and embedding drains are scheduled asynchronously, not executed off-thread.** They yield between reconciliation pages or defer with `setTimeout(0)`/`setImmediate`, but every SQLite call within a page runs synchronously in the OpenCode process.
5. **FTS segment healing helps fragmented/index-sensitive queries but does not fix content-table scans.** On copies, bounded negative-then-positive `merge` calls converged to one segment, as documented by SQLite. A 1,000-page budget produced a structure record byte-identical to `optimize`; 64/256-page budgets produced the same one-segment/no-active-merge topology but slightly different leaf packing. Warm query latency after convergence was broadly equivalent. Full scans remained about 0.22-0.24s warm.

No production code or live database was changed. Every live query used a `file:...context.db?mode=ro` URI plus `PRAGMA query_only=ON`. FTS writes and settings experiments were performed only on SQLite backup copies.

## Evidence and methodology

### Canonical evidence read first

- `/tmp/opencode-post-maint-sample.txt`: sample timestamp `2026-08-29 14:54:45.230 +0300`, PID 18893, 2,663 main-thread samples, 1,597 in the FTS5 step path, 856 in `pread`.
- `maintenance-20260829T115347Z/probe-http.csv`:
  - `prompt_async_no_reply`: median 421ms, max 3,002ms;
  - `prompt_message_no_reply`: median 679ms, max 1,023ms;
  - `part_patch`: max 773ms;
  - `session_delete_probe`: 339-801ms for four of five deletions (the fifth was 4ms).

The profile and HTTP probe overlap in time but do not contain a request-to-stack correlation ID. The report does not claim that a particular prompt request caused the sampled SQLite statement.

### Database facts

| Fact | Direct result |
| --- | ---: |
| `context.db` file size | 5,191,049,216 bytes |
| SQLite page size / pages | 4,096 / 1,267,346 |
| `message_history_fts` rows | 315,074 initially; 315,093 in a later backup while the live writer continued |
| distinct indexed sessions | 17,359 |
| largest indexed session | 58,870 rows; ordinal watermark about 117,825 |
| `memories_fts` rows | 12,346 |
| `git_commits_fts` rows | 39,231 |
| `primers_fts` rows | 2 |
| `message_history_fts_content` | 1,189,769,216 bytes / 290,471 pages |
| `message_history_fts_data` | 440,827,904 bytes / 107,624 pages |
| `message_history_source` | 120,627,200 bytes |
| on-disk FTS5 tables in `opencode.db` | 0 |

The FTS5 configuration tables initially contained only `version=4`, so SQLite defaults applied: `automerge=4`, `crisismerge=16`, and `usermerge=4`.

### Timing caveats

The live service and a separate shadow-embedding backfill process were active. No OS-wide cache purge was performed. “Warm” means repeated in the same or immediately following read-only connection. “Cold proxy” means first execution against a newly written SQLite backup copy; it is intentionally reported as a range because first-run cache state varied. Plans and the order-of-magnitude gaps are stable; sub-millisecond differences are not treated as meaningful.

## Complete production FTS call-site inventory

### FTS5 `MATCH` reads

| Source and caller | SQL shape and bound | When / frequency | Thread verdict |
| --- | --- | --- | --- |
| `features/magic-context/search.ts:335-363`, `runMessageFtsQuery` | `message_history_fts WHERE session_id=? AND MATCH ? [AND CAST(message_ordinal)<=?] ORDER BY bm25, ordinal LIMIT ?` | Unified search. AUTO-SEARCH uses one base query and fetch limit 30. Explicit `ctx_search` can use a cutoff and fetch `3 * tier limit`. | Synchronous `bun:sqlite` on OpenCode main thread; `DatabaseSync` on Pi/Node main thread. |
| `search.ts:365-426,804-872,899-1028` | Explicit-search probe count: up to five `COUNT(*) ... MATCH ?` branches joined with `UNION ALL`; result phase: base plus up to five independently ranked MATCH subqueries. | User-invoked `ctx_search` only (`explicitSearch: true` at `tools/ctx-search/tools.ts:263-291`). Literal probes are capped at five. | Same host thread; compound statement does not create parallel workers. |
| `memory/storage-memory-fts.ts:14-48,61-130` via `search.ts:531-731` | `memories_fts JOIN memories ... project/status/expiry AND MATCH ? ORDER BY bm25,... LIMIT ?`; one-project, identity-union, and workspace-sharing variants. | Every unified search when memory is enabled. FTS candidate limit is 50. | Host main thread. |
| `git-commits/search-git-commits.ts:41-56,113-222` | `git_commits_fts JOIN git_commits ... project_path=? AND MATCH ? ORDER BY bm25 LIMIT ?`; fallback is base-table `LIKE`. | Unified search only when git commit search is enabled. AUTO-SEARCH tier 30 leads to fetch limit 90. | Host main thread. |
| `search.ts:1436-1494` | `primers_fts JOIN primers ... MATCH ? AND project/status ORDER BY rank LIMIT 3*limit`. | Explicit unified search only. AUTO-SEARCH excludes primers (`sources` is memory/message/git at `auto-search-runner.ts:323-345`). | Host main thread. |
| `dashboard/src-tauri/src/db.rs:3302-3582` | Memory UI search joins `memories_fts`, uses sanitized AND terms, rank order, caller-supplied `LIMIT/OFFSET` (default 100). | User opens/searches dashboard memory view. | Not OpenCode's main thread: Tauri command is declared `#[tauri::command(async)]` and opens a read-only connection per command (`commands.rs:12-48`). The HTTP dispatch is also outside OpenCode. |

`sanitizeFtsQuery` (`storage-memory-fts.ts:54-59`) quotes every whitespace token and joins with spaces, so normal production text is an implicit AND query. It has no term-count cap. The explicit literal-probe path intentionally creates separate single-probe searches for symbol-like tokens.

### FTS5 scans and writes without `MATCH`

| Source | Shape / bound | When / frequency | Measured implication |
| --- | --- | --- | --- |
| `message-index.ts:143-152`, called at lines 330-333, 464, 579 | `SELECT COUNT(*) FROM message_history_fts WHERE session_id=? AND message_id=?` | Terminal message incremental indexing and every new message in each 100-row reconciliation page. | Full virtual-table scan; 0.30-0.52s each, 290,492 page misses. This is the largest multiplicative defect. |
| `message-index.ts:114-132,206-215,366-385,411-618` | `DELETE` by session, session+ordinal range, or session+message id; inserts one FTS row per indexable message. | Session clear/reindex; dirty-floor rewind once per bounded source page; same-ID edit/redaction; session deletion. | Every DELETE plan is a full FTS scan before write. Dirty-floor work is bounded to 100 source ordinals but not bounded in scanned FTS pages. |
| `storage-session-tables.ts:13-70` | Generic session cleanup includes `DELETE FROM message_history_fts WHERE session_id IN (...)`. | `session.deleted`, pending cleanup retry, and orphan cleanup. Orphan sweep scans at most 200 session ids, with 10-minute cooldown, from the process-wide startup/15-minute timer. | One full FTS scan per cleanup statement. Probe deletion tails are consistent with this cost, but not formally correlated. |
| `compartment-chunk-embedding.ts:126-141,412-457` | `SELECT ... FROM message_history_fts WHERE session_id=? AND message_ordinal BETWEEN ? AND ? ... ORDER BY message_ordinal`. | Publish fallback, automatic/manual session embedding drain, passive project drain, and shadow queue. Range size is bounded by a compartment, but the scan is global. | Plan is full FTS scan plus temp sort; 0.30-0.32s for a 101-ordinal range. |
| `compartment-embedding.ts:49-149` | Calls the preceding scan only when publish-time in-memory chunk text is absent. | Per newly published compartment fallback. | Deferred provider work does not make the SQLite read off-thread. |
| `project-embedding-registry.ts:1510-1675,2178-2358,2440-2621` | Calls the preceding scan per candidate. Shadow tick caps 64 items/512KiB/2s; passive chunk batch is 8; session drain re-queries batches. | Enqueue-driven shadow work, auto-embed once per session until complete, and `/ctx-embed`. | `shadowWorker` is a Promise loop, not a Bun Worker. Eight scans alone measured about 2.4s of synchronous SQLite work. |
| `storage-db.ts:1030-1052,1359-1421,1684-1703` and `migrations.ts:364-415,1863-1882` | FTS maintenance triggers mirror base `memories`, `git_commits`, and `primers` inserts/updates/deletes. | Per corresponding base-row write. | Synchronous write and any automatic merge execute in the writer process. |

The FTS schemas mark identity fields `UNINDEXED`. That prevents them from participating in the text index; it does **not** create a B-tree index. The virtual-table plan for all identity/range-only predicates is `SCAN message_history_fts VIRTUAL TABLE INDEX 0:`.

## Prompt-path timing and scheduling

### AUTO-SEARCH

`transform-postprocess-phase.ts:1985-2016` awaits `runAutoSearchHint` on a fresh live-tail user turn. The runner persists one decision per message, so successful/no-hint turns are not recomputed. It calls unified search with limit 10, sources memory/message/git, and a nominal 3,000ms timeout (`auto-search-runner.ts:43-83,241-409`).

`unifiedSearch` starts the embedding fetch, yields once, and then executes message FTS synchronously (`search.ts:1623-1678`). Source comments explicitly note that a synchronous call blocks event-loop processing. The timeout only races asynchronous completion; it cannot preempt a running `sqlite3_step`.

### Message reconciler and dirty-floor rewind

The reconciler is event-driven and first-touch, not a cron full scan:

- every transform schedules reconciliation (`transform.ts:714-733`);
- every non-delete event schedules it (`hook-handlers.ts:421-427`);
- terminal user/assistant `message.updated` events schedule a 100ms-debounced incremental read (`hook-handlers.ts:340-355`);
- message removal schedules clear-and-reindex (`event-handler.ts:714-740`).

`scheduleReconciliation` waits for boot quiet and defers with `setImmediate`/`setTimeout(0)`. It reads a raw count, processes 100 ordinals, and yields between pages (`message-index-async.ts:101-219`). That is cooperative scheduling, not isolation: the raw page and all FTS checks/writes within one page are synchronous.

The raw OpenCode source is appropriately indexed and is not the main whale:

| Reconciler raw query | Plan | Measured latency on 117,844-message session |
| --- | --- | ---: |
| filtered session count | `message_session_time_created_id_idx(session_id, time_created, id)` | 0.110-0.121s |
| 100 rows at offset 0 | same index | 0.00014s |
| 100 rows at offset 50,000 | same index | 0.040s |
| 100 rows at offset 117,700 | same index | 0.110s |

The dirty-floor rewind is page-bounded, but each page can still issue 100 global FTS duplicate scans plus one global range delete.

### Retrospective raw-provider scans

Retrospective does not query `context.db` FTS. It reads root-session metadata from `session_projects`, then opens `opencode.db` read-only (`dreamer/retrospective-raw-provider.ts:92-184,357-482`). It is daily by default (`0 5 * * *`) or manual, checked by the 15-minute dream timer. Bounds are 20 sessions/run, 80 messages/session, and 240 messages/run. Message pages use the covering `(session_id,time_created,id)` index; measured reads were 0.02-0.23ms for the tested bounded shapes. This path cannot explain an FTS5 stack in the sampled process.

## Memory, primers, dreamer, and mural base-table reads

These reads are synchronous but do not enter FTS5 unless unified search is also requested.

| Consumer group | Source evidence and cadence | Bound / measurement |
| --- | --- | --- |
| M0/M1 memory selection | `inject-compartments.ts:370-415,2190-2233,2584-2625,3055-3089`; legacy render caches after first read, current hard materialization reads active/permanent memories and M1 rechecks the eligible set. | Indexed by project; 533 active rows for the measured project, 1.7-2.1ms. |
| Historian prompt dedup | `compartment-runner-incremental.ts:411-420` | One active memory pool when a historian run begins, not each quiet pass. |
| Unified search semantic pool | `search.ts:655-731` loads all active project/workspace memories before merging FTS/embedding scores. | Same indexed base read; then FTS candidate limit 50. |
| Map memories | `dreamer/map-memories.ts:181-224` | Daily `0 2 * * *` or manual. Reads active pool, then batches mapping inputs by 80. |
| Verify / verify-broad | `dreamer/verify-gate.ts:95-221` | Daily `0 3 * * *` incremental or weekly broad. Reads active pool and verification side table; no FTS. |
| Classify/curate/compress cues | `dreamer/classify.ts:158`, `dreamer/task-executor.ts:183`, `mural/compress-cues.ts:215-259` | Cron/manual. Compress cues chunks 40 after one active-pool read. |
| Mural | `mural/resolve-mural.ts:33-102`, `mural/render-trigger.ts:53-176` | On a natural hard-fold materialization only, when enabled and model supports vision. Coverage and resolve each read the active pool. |
| Primers | `storage-primers.ts:415-424`, callers in search and primer dream tasks | Indexed project/status read; one active row measured in 0.041ms. Primer MATCH is explicit search only. |
| User tools/module sync/status | `tools/ctx-memory/tools.ts:606`, `module-state-sync.ts:1433-1450`, `m0-token-breakdown.ts:119` | User-invoked or synchronization/diagnostic reads; same indexed base shape. |

## Query plans and direct latency summary

| Query shape | Plan | Bound | Observed wall latency |
| --- | --- | --- | ---: |
| message MATCH, selective six-term AND, limit 30 | FTS `M5` scan + temp B-tree rank | Global postings, then unindexed session/cutoff filter | warm 0.09-0.20s; fresh-copy first 0.13-1.50s |
| message MATCH, common one-term, limit 30 | same | LIMIT does not avoid scoring all eligible matches | warm 0.21-0.39s; fresh-copy first 1.59s |
| common term at LIMIT 5 / 20 / 100 | same | output bound only | 0.323 / 0.334 / 0.341s |
| three common OR terms, limit 20 (explicit-stress shape) | same | broad postings | warm 0.38-0.54s; fresh-copy first 3.30s |
| duplicate check by session+message id | full FTS scan | none | 0.30-0.52s; 290,492 page misses |
| source-side PK alternative | ordinary PK index | one row | 0.008-0.019ms |
| compartment ordinal range | full FTS scan + temp sort | result range only | 0.30-0.32s |
| memory MATCH, broad three-term stress | FTS `M2` + rowid join + sort | 20 rows | 1.5-4.0ms |
| git MATCH, broad three-term stress | FTS `M3` + SHA join + sort | 20 rows | about 18ms |
| primer MATCH | FTS + rowid join + sort | corpus 2 rows | 0.15-0.82ms |

The common-term LIMIT experiment rejects “reduce LIMIT” as the primary structural fix: bm25 ordering still consumes the match set. Term capping is also not monotonic: dropping rare AND terms can make a query less selective and slower.

## Duplicate-instance fanout snapshot

At approximately 15:08 local time, `lsof /.../context.db` showed two processes:

| PID | Process | Handles / role |
| ---: | --- | --- |
| 18893 | `opencode serve --hostname 0.0.0.0 --port 9999` | Five live `context.db` descriptors (32, 60, 202, 229, 234), plus `opencode.db`. This is the sampled process and owns active OpenCode plugin sessions. |
| 12637 | `bun packages/plugin/scripts/backfill-embeddings.ts --shadow` | One separate read/write connection. It can add I/O and writer contention but cannot put its SQLite stack on PID 18893's main thread. |

The LiteCode/Desktop Electron process, Magic Context Dashboard process, and their helpers had no `context.db` descriptor in the snapshot. No Pi process and no second OpenCode TUI/plugin host were present. Desktop was a client of the single `opencode serve` host in this topology.

Source fanout rules:

- AUTO-SEARCH and reconciliation run in whichever plugin process serves that session. Here that is PID 18893 only.
- Each independently loaded OpenCode or Pi plugin process would have its own reconciler latches and process-wide dream timer. Pi uses synchronous `node:sqlite` and the shared auto-search/reconciliation code, so it would reproduce main-thread blocking in its own process.
- The dream timer is singleton per process, not machine-global; leases serialize leased maintenance across processes, but non-leased reads and per-process scheduling still fan out.
- Dashboard memory MATCH runs only on an active dashboard request and on its Tauri worker, not in the OpenCode process.

## Bounded FTS5 merge experiment on copies

### Protocol

A read-consistent SQLite backup was copied with APFS copy-on-write into four writable test databases. Each used WAL and `synchronous=NORMAL`, matching the live durability mode. The baseline decoded FTS5 structure record (`message_history_fts_data.id=10`) had 15 segments over levels 0, 1, 4, 5, 6, and 7, with an active four-input merge at level 4.

For each page budget N, the script issued one transaction with `merge,-N`, then separate transactions with `merge,N` until `total_changes` increased by less than 2. A full `optimize` copy was the reference. No command touched the live database.

### Convergence and decoded structures

| Method | Work transactions | Total merge wall | Final decoded topology | Exact packing |
| --- | ---: | ---: | --- | --- |
| `merge` 64 | 967 (+1 no-op detector) | 8.286s | level 9, one segment, no active merge | leaves 1..104,837; 11,977 idx rows |
| `merge` 256 | 333 (+1) | 7.751s | level 9, one segment, no active merge | leaves 1..104,485; 12,157 idx rows |
| `merge` 1000 | 97 (+1) | 3.558s | level 9, one segment, no active merge | leaves 1..104,366; 12,201 idx rows |
| `optimize` | 1 | 3.215s (5.224s in an earlier independent copy run) | level 9, one segment, no active merge | leaves 1..104,366; 12,201 idx rows |

All four ended with the same `nWrite=1,155,673` and the same logical one-segment/no-merge topology. The 1,000-page structure record was byte-for-byte identical to `optimize` (same decoded segment and record hash). The 64/256 records were **not** byte-identical: incremental page packing left 0.45% / 0.11% more leaf pages. Therefore the precise claim supported by measurement is topology and query-performance equivalence, not byte/layout equivalence at every N.

Warm median post-merge latencies were close:

| Shape | Baseline 15 segments | merge 64 | merge 256 | merge 1000 | optimize |
| --- | ---: | ---: | ---: | ---: | ---: |
| selective six-term AND | 94ms | 85ms | 92ms | 95ms | 94ms |
| common `context` term | 210ms | 205ms | 201ms | 220ms | 204ms |
| absent-id full scan | 232ms | 226ms | 220ms | 244ms | 241ms |

The lack of a full-scan gain is expected: merging the inverted index does not reduce the 1.19GB `%_content` scan. An earlier 22-segment copy showed a larger broad-query effect: three-term OR first-run 3.30s and warm 0.44-0.45s before optimize versus first-run 0.684s and warm 0.31-0.38s after optimize. Cold-proxy results are cache-sensitive, but they validate that fragmented broad reads can benefit materially.

### Per-transaction lock-duration candidates

| N pages | p50 | p95 | p99 | max | transactions >=50ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 64 | 5.5ms | 22.3ms | 41.8ms | 125.4ms | 5 / 967 |
| 256 | 18.5ms | 44.2ms | 68.3ms | 132.4ms | 13 / 333 |
| 1000 | 33.0ms | 54.0ms | 96.7ms | 106.2ms | 11 / 97 |
| 16 (additional probe) | 2.7ms | 19.0ms | 42.8ms | 180.5ms | 18 / 2,217 |

A repeat of N=64 with WAL auto-checkpoint disabled still had four >50ms merge transactions (max 105ms); the final tick was 23.8ms and the separate checkpoint took 1.76s. The long outliers are therefore not explained solely by auto-checkpoint. **No tested page budget validates a literal “never over 50ms” guarantee.** N=64 is the best tested candidate by p99, but shipping it requires an idle/boot-quiet gate and contention testing; page count is a work bound, not a wall-clock deadline.

At one 64-page transaction per 15-minute dream tick, initial convergence would take about 10 days. The timer must start a background drain that performs many separately committed ticks, yielding between them, under a singleton/lease; it must not equate “one dream tick” with “one merge transaction.”

### Post-heal settings experiment

The native sample does not expose the live FTS transaction rate, and concurrent reconciliation/backfill prevented a stable rate estimate. The following is therefore a controlled 20-transaction structure test, not a claim that 20 transactions equal one production timer interval.

On an optimized copy:

1. persisted `automerge=0`, `usermerge=2`, `crisismerge=64`;
2. 20 separate tiny document transactions produced 20 level-0 segments plus the large optimized segment (21 total), while avoiding foreground automatic merges;
3. one positive 64-page merge call plus one no-op detector reduced this to two segments;
4. forcing another negative full-convergence cycle rewrote the large index and again required 967 work calls.

This supports the following silent policy:

- **Initial/background repair:** one negative 64-page start, positive 64-page continuations, many separate transactions with a macrotask yield, under boot quiet/idle and a cross-process lease.
- **Steady state:** `automerge=0` keeps merge work out of prompt/event writes; `usermerge=2` lets cheap positive background calls consolidate fresh same-level segments aggressively; raise `crisismerge` from 16 (64 was tested) so a foreground write cannot trigger an early all-at-once crisis merge.
- **Do not repeatedly force one segment:** use positive maintenance for fresh segments and start a negative cycle only when a read-only structure diagnosis crosses a fragmentation threshold. Re-forcing after a small batch rewrites the large segment and defeats bounded maintenance.
- **No user ceremony:** no doctor repair arm, flag, or prompt. An existing doctor check may report a read-only segment diagnosis only. Healing belongs inside plugin boot-quiet/dream maintenance.

Because N=64 missed the strict max-lock target, this is a validated direction, not a zero-risk patch recommendation. A maintenance Worker with its own connection removes event-loop execution, but WAL writer-lock interference still needs measurement. If the product requirement is a hard 50ms lock ceiling, add a cancellable/progress-limited mechanism or reduce the budget further and prove the maximum under concurrent live writers before implementation.

## Ranked structural fixes

### 1. Remove the reconciliation duplicate full scan

**Recommendation:** prove and use the existing transaction/watermark/source invariant instead of scanning `message_history_fts`, or add an ordinary indexed FTS-membership sidecar. The source row lookup already uses `(session_id,message_id)` as a primary key.

**Expected gain:** replace 0.30-0.52s per message with 0.008-0.019ms. For a 100-row reconciliation page, remove approximately 30-52s of serial main-thread work. This is orders of magnitude larger than any measured segment optimization.

**Effort/risk:** small-to-medium. Removing the defensive check is tiny, but crash, dirty-floor, empty-content, edit/redaction, and legacy-drift invariants need focused proof. It was not implemented in this audit.

### 2. Stop using FTS content as a session/range row store

Use an ordinary B-tree sidecar keyed by session/message/ordinal and retain stable FTS rowids. Resolve chunk spans and delete targets through the sidecar, then fetch/delete FTS rows by rowid. This fixes chunk backfill, dirty-range delete, single-message delete, and session cleanup.

**Expected gain:** remove about 0.30s per chunk/span read and about 0.3-0.5s per cleanup scan at this corpus size; avoid linear growth with `%_content` size.

**Effort:** medium/high migration, but structurally correct.

### 3. Add background-silent incremental segment healing

Use the owner-ruled boot-quiet/dream maintenance design above, with N=64 as the current p99 candidate, explicit yields, a lease, steady-state positive merges, and rare threshold-triggered negative cycles. Do not expose a doctor action.

**Expected gain:** little for selective normal queries on the measured 15-segment snapshot; about 3% for the common warm query in the controlled comparison; potentially 17-30% warm and up to about 79% on cold broad-query observations from the earlier 22-segment copy. No gain for full content scans.

**Effort:** medium. Convergence semantics are validated; the <50ms maximum is not.

### 4. Isolate remaining synchronous search/backfill work

A Bun Worker / Node worker with its own read-only connection would keep FTS search and chunk reads off the host event loop. It also makes a timeout real rather than a Promise timer that cannot fire during `sqlite3_step`.

**Expected gain:** remove 0.09-1.59s observed MATCH stalls and 0.30s scan stalls from OpenCode's main thread, although caller-visible AUTO-SEARCH still waits unless it times out/falls back. It does not reduce disk work or SQLite writer contention.

**Effort:** high because the plugin ships across Bun, Node/Pi, and Electron and needs lifecycle/config parity.

### 5. Do not lead with LIMIT or blunt term caps

A common-term query changed only from 0.323s at LIMIT 5 to 0.341s at LIMIT 100. Normal text is AND-joined, so removing terms can increase postings and make the query slower. Prefer discriminative-term selection, corpus-frequency gating, or worker isolation if AUTO-SEARCH itself remains a tail source.

### 6. Scheduling-only changes are insufficient

The reconciler already runs after boot quiet, defers, pages at 100, and yields between pages. Moving the same synchronous page to another Promise or timer does not move SQLite off-thread. Reducing page size can limit multiplicative work per turn, but the underlying 0.30-0.52s per-row scan remains.

## Attribution conclusion

The native stack is consistent with all measured `message_history_fts` paths, including `MATCH`, no-MATCH full scans, and FTS writes/merges. It cannot select among them. Direct evidence makes full-content scans the strongest source-level explanation:

- their plan is exactly an FTS5 virtual-table scan;
- one scan traverses approximately the entire 290,471-page content table;
- measured 0.30-0.52s warm and near-1s first-run latency aligns with several HTTP tails;
- reconciliation can repeat the scan 100 times per source page;
- session cleanup explains deletion latencies on the same scale;
- chunk embedding repeats the scan per candidate in an “async” same-thread loop.

AUTO-SEARCH remains a real prompt-path contributor and can explain common-term/cold tails, but the 5-second profile alone does not justify naming it as the sampled statement. The first implementation target should be the unindexed full-scan call sites, followed by silent segment healing and true isolation for residual synchronous FTS work.
