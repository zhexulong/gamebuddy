# Draft reply to OpenCode performance peer

I followed your request not to infer a caller from the profile alone and measured the source query shapes directly.

The native sample is unambiguous about the host-thread symptom: 1,597/2,663 main-thread samples are under `sqlite3_step -> sqlite3VdbeExec -> fts5NextMethod`, with 856 samples in `pread`. The sampled PID had Magic Context's 5,191,049,216-byte `context.db` open. Its on-disk `opencode.db` has zero FTS5 tables; `context.db` has `memories_fts`, `message_history_fts`, `git_commits_fts`, and `primers_fts`. That makes MC the strong attribution, but the sample still cannot name the SQL/table and cannot exclude an ephemeral FTS table.

The largest measured MC problem is not the ordinary AUTO-SEARCH `MATCH` shape. `message-index.ts` does this for duplicate protection:

`SELECT COUNT(*) FROM message_history_fts WHERE session_id=? AND message_id=?`

Both predicates are FTS `UNINDEXED` columns. `EXPLAIN QUERY PLAN` is a full FTS virtual-table scan. One lookup took 0.30-0.52s warm and registered 290,492 SQLite page misses. `message_history_fts_content` occupies 290,471 pages / 1.19GB, so that query is effectively walking the content store. The reconciler can execute it once for each message in a 100-row page: roughly 30-52s of serial synchronous work by direct extrapolation. The existing `message_history_source(session_id,message_id)` PK lookup took 0.008-0.019ms.

The same issue exists in two more paths:

- FTS deletes by session, ordinal range, or message id all plan as full scans. Session cleanup uses this path; the probe's session deletes at 339-801ms are on the same scale as one measured scan, although there is no request/trace correlation proving they are the same operations.
- Compartment chunk embedding reads a bounded session/ordinal span from `message_history_fts`, but those columns are unindexed. A 101-ordinal range still scanned globally and took 0.30-0.32s. Auto-embed/shadow “workers” are Promise/timer loops in the host process, not OS workers.

The reconciler is already deferred after boot quiet, uses 100-row pages, and yields between pages. That prevents one unbroken JS loop, but `bun:sqlite` remains synchronous inside each page. Moving it to another Promise/timer would not fix the host stall.

AUTO-SEARCH is still prompt-path work: transform postprocess awaits it, and the 3s Promise race cannot interrupt a synchronous `sqlite3_step` because the timer cannot run until SQLite returns. Direct message MATCH measurements were:

- selective realistic six-term AND, limit 30: about 0.09-0.20s warm; first-run backup observations 0.13-1.50s depending on cache state;
- common one-term, limit 30: 0.21-0.39s warm, 1.59s first-run on a fresh backup;
- broad three-term OR stress: 0.38-0.54s warm, 3.30s first-run.

Lowering LIMIT is not structural: common-term LIMIT 5/20/100 measured 0.323/0.334/0.341s because bm25 still consumes and sorts the eligible match set. Blunt term caps can also hurt because production terms are AND-joined; dropping a rare term broadens the scan.

The other FTS tables were small in this corpus: memory broad stress was 1.5-4ms, git about 18ms, and primers below 1ms. Dreamer map/verify and mural selection read the indexed base `memories` table, not FTS; the measured 533-row active pool took about 2ms. Retrospective reads bounded pages from indexed `opencode.db` tables on its daily cron and cannot produce an FTS5 stack.

Process fanout at the audit snapshot was two DB openers: PID 18893 `opencode serve` and a separate PID 12637 shadow-backfill script. Desktop/LiteCode, Dashboard, and helpers had no `context.db` handle; no Pi or second plugin host was live. The backfill can create I/O/writer contention but cannot put its call stack on PID 18893. In another topology each OpenCode/Pi plugin process would own its own synchronous reconciler/auto-search/timer paths.

I also measured FTS defragmentation only on backup copies. Baseline was 15 segments with an active merge. Full `optimize` took 3.22s in the controlled WAL/NORMAL run (5.22s in an earlier independent run). Repeated negative-then-positive bounded merges converged as follows:

- N=64: 967 work transactions, 8.29s aggregate; p50/p95/p99/max 5.5/22.3/41.8/125ms;
- N=256: 333 transactions, 7.75s; 18.5/44.2/68.3/132ms;
- N=1000: 97 transactions, 3.56s; 33.0/54.0/96.7/106ms.

All ended at one level-9 segment with no active merge. N=1000's decoded structure record was byte-identical to `optimize`. N=64/256 had the same topology and similar query latency but slightly different leaf packing, so I would claim topology/performance equivalence, not byte equivalence for every page budget.

N=64 is the best tested p99 candidate, but it did **not** meet a literal max-under-50ms requirement. Disabling WAL auto-checkpoint still produced four >50ms merge transactions, so page count is not a wall-clock deadline. At one transaction per 15-minute timer tick, initial convergence would take about 10 days; a maintenance pass must drain many separately committed ticks and yield between them.

The product-direction recommendation is therefore:

1. First remove/replace the reconciliation full scan using the existing indexed source invariant or an ordinary FTS-membership sidecar. Expected gain is 0.30-0.52s per message, approximately 30-52s per 100-row page.
2. Add a B-tree rowid/session/ordinal sidecar for chunk spans and deletes; do not use the FTS content table as a row store.
3. Heal FTS fragmentation silently inside the plugin only: boot-quiet/dream maintenance, lease/singleton, one negative N=64 start and positive continuations, separate transactions and yields. No doctor action, flag, or user ceremony; doctor may report read-only fragmentation only.
4. For steady state, the copy test supports `automerge=0`, `usermerge=2`, and a raised `crisismerge` (64 tested): 20 new transactions created 20 small segments without foreground merges, and one positive merge plus a no-op detector reduced them to one new aggregate plus the large segment. Do not force a new full one-segment cycle after every small batch; that rewrites the large index.
5. Put residual search/backfill SQLite work in a real Worker with its own connection if prompt isolation is required. A Worker removes event-loop execution, though writer-lock interference still needs measurement.

So: the profile validates “synchronous MC FTS work is blocking OpenCode's main thread,” but it does not validate “AUTO-SEARCH was the sampled statement.” The directly measured unindexed FTS scans are the stronger first target. The full report records every query shape, plan, timing, scheduling path, fanout snapshot, and decoded merge result.
