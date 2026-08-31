# ctx_search empirical retrieval study

**Study date:** 2026-08-29
**Scope:** investigation and measurement only; no production-source changes
**Primary model:** `qwen/qwen3-embedding-8b` through the configured OpenAI-compatible provider
**Corpus:** live read-only `context.db` plus read-only `opencode.db`; Magic Context, AFT, and Alfonso golds
**Fixture:** `scripts/fixtures/ctx-search-known-answers.json`
**Harness:** `scripts/ctx-search-benchmark.ts`

## Executive summary

The user-visible complaint is real: on 20 verified conversation-finding queries, shipped full `unifiedSearch` recalled the right old conversation only **35% at rank 1, 45% at rank 5, and 50% at rank 10**. The underlying conversation lane was substantially better: **55% / 80% / 80%**. The dominant measured loss is therefore not missing chunk vectors and not memory crowding. It is cross-source score calibration, especially the note lane.

The main findings are:

1. **Notes, not memories, crowd out conversation hits.** Notes occupied **117/200 (58.5%)** of the full top-10 positions for conversation queries and were top-1 on **10/20** queries. Memories occupied only **4/200 (2%)** positions. Nine queries had at least eight notes in the top 10. Six gold chunks that ranked 1-4 in the isolated chunk lane disappeared from the full top 10.
2. **The score domains are mismatched.** A chunk-only semantic result keeps its normalized cosine and the single-source penalty (gold examples scored about 0.39-0.76 before the message-source boost). Notes are re-ranked into a linear **1.0, 0.967, 0.933, ...** band after matching even one query token. That scale beats good chunk cosine before source boosts can help.
3. **Coverage is not the cause for this benchmark snapshot.** Magic Context, AFT, and Alfonso had complete current-Qwen chunk, memory, and commit coverage; both Qwen and Synapse covered every chunk in the three benchmark sessions. Across all 29 compartment-bearing project identities, current-model chunk coverage was **9,270/9,654 (96.0%)**, with all **327 compartments from the last seven days covered**. The 384 holes were old: 378 in a duplicated benchmark corpus from June and six legacy compartments.
4. **The Aug 25-29 Synapse outage was transiently visible but has been repaired.** The Synapse batch ledger was dominated by `partial` rows during that window (chunks 298 partial vs 34 complete; commits 1,342 vs 138; memories 325 vs 42), while the current stores are fully backfilled for the benchmark projects. The ledger status does not encode the cert failure reason, so it corroborates outage sensitivity but does not prove causality by itself.
5. **Natural paraphrases remain hard.** Shared-token keyword/question queries had chunk recall@10 of **14/14**; zero-shared-token paraphrases had **2/6**. One failed natural query rose from raw-chunk rank 34 to rank 2 when reworded toward corpus terminology. This confirms query/corpus phrasing mismatch.
6. **P1-summary vectors are not a blanket fix.** Embedding title + P1 for all 1,655 candidate compartments produced **60% / 75% / 75%**, slightly worse than raw chunks at **60% / 80% / 80%**. It rescued no conversation query that raw chunks missed at rank 10, although it helped a few mixed queries.
7. **Intent-aware fusion has the largest measured upside.** An offline chunk-heavy, conversation-gated weighting raised conversation recall to **55% / 75% / 80%**; a milder +25% conversation boost reached **35% / 55% / 75%**. Global application is unsafe: the same chunk-heavy weights reduced fact/rule recall, so the boost must be intent-aware or source-capped.
8. **The FTS control group exposed a separate exact-SHA defect.** All four full commit-SHA queries failed, and the isolated commit lane was 0/4. `git_commits_fts.sha` is `UNINDEXED`, and the LIKE fallback searches only `message`; full hashes therefore fall into semantic search and return unrelated release commits. This is not a vector-quality problem.

## Study design and fidelity

### Known-answer corpus

The fixture contains 50 manually verified queries:

- 20 conversation-finding queries, including 5 keyword forms, 9 questions, and 6 zero-shared-token paraphrases;
- 10 identifier controls (commit SHAs, issue number, exact error string, function/config identifiers);
- 10 fact/rule queries with memory-row golds, including AFT and Alfonso sibling projects;
- 10 mixed/hard queries, including date anchoring, commit+conversation, memory+conversation, note+conversation, and a live-tail hard-filter control.

Conversation golds span March 18 through August 27. The harness revalidated 28 compartment transcripts using production `buildCanonicalChunkTextFromFts` and checked seven raw message IDs in read-only `opencode.db`. Committed fixtures contain only IDs, ranges, dates, labels/titles, and queries; raw transcript and memory bodies are not committed.

### Production-path execution

For every query the harness calls production `unifiedSearch` with the same options as the explicit `ctx_search` handler:

- the actual project embedding provider and query purpose;
- `explicitSearch: true`;
- the last-compartment ordinal cutoff;
- the session's actual visible-memory ID set;
- memory, git-commit, primer, and note feature gates;
- `countRetrievals: false` and `measurementDisabled: true` only to prevent telemetry writes.

The live DBs are opened with SQLite file URIs using `mode=ro`. Project registrations are created against an in-memory scratch DB, never the live store. Query embeddings are cached per run so every lane sees the same vector.

Lane isolation uses production source gates:

- message FTS: `sources:["message"]`, embeddings disabled;
- conversation: production message source with chunk+message fusion;
- memory hybrid: `sources:["memory"]`;
- commits: `sources:["git_commit"]`;
- notes and primers: their production isolated source paths.

The raw chunk diagnostic uses production chunk-row loading and production cosine, while preserving raw cosine and applying the same normalization and single-source penalty as `searchCompartmentChunks`. This is necessary because the private chunk scorer is not independently exported. Gold raw-chunk ranks are measured to top 50 before cross-source fusion.

### Matching rule

A conversation gold counts when retrieval returns either the gold compartment or a message ordinal inside its verified range. Mixed queries accept any explicitly listed gold target. Ranks are 1-based. Full and production-isolated lanes are measured to top 10; raw chunks are retained to top 50; the P1 probe ranks the full session candidate pool.

## Coverage audit

### Benchmark projects

| Project | Chunks | Memories | Commits | Current-model holes |
|---|---:|---:|---:|---:|
| Magic Context (`git:93ee...`) | 1,655 / 1,655 | 533 / 533 | 2,000 / 2,000 | 0 |
| AFT (`git:3fba...`) | 1,553 / 1,553 | 552 / 552 | 2,000 / 2,000 | 0 |
| Alfonso (`git:1e39...`) | 1,062 / 1,062 | 511 / 511 | 1,909 / 1,909 | 0 |

The Magic Context conversation session's current chunk model and its Synapse shadow model each covered all 1,655 compartments. The same was true for all 1,553 AFT and 1,062 Alfonso compartments. Thus none of the 50 selected golds failed because its current vector was absent.

### All compartment-bearing projects by age

| Age bucket | Compartments | Missing current-model vectors |
|---|---:|---:|
| Last 4 days | 208 | 0 |
| Days 5-7 | 119 | 0 |
| Days 8-30 | 1,875 | 0 |
| Days 31-90 | 6,316 | 378 |
| Older than 90 days | 1,136 | 6 |
| **Total** | **9,654** | **384** |

The 378 middle-aged holes all belong to a duplicated benchmark identity/session pair dated June 6-28; one copy is embedded and the clone is not. Four >90-day holes belong to a small project dated May 30, and two belong to an unregistered legacy project. There is no Aug 25-29 hole band in the current snapshot.

Across registered identities, memory coverage was **5,470/5,470**. Commit coverage was **29,011/29,612 (98.0%)**; 601 missing vectors were confined to two unrelated identities (582/2,000 and 19/19). These holes did not intersect the benchmark query projects.

### Synapse outage evidence

The current corpus reflects successful fallback/backfill, not the transient outage state. The durable ledger still shows the outage window's incomplete work:

| Scope, Aug 25-29 | `partial` | `complete` | Partial share |
|---|---:|---:|---:|
| Chunk | 298 | 34 | 89.8% |
| Commit | 1,342 | 138 | 90.7% |
| Memory | 325 | 42 | 88.6% |

Interpretation: outage sensitivity is confirmed operationally, but **coverage-hole causation for the measured recall failures is refuted**. A future benchmark should snapshot coverage before backfill if it aims to quantify outage-time user impact.

## Aggregate retrieval results

### Recall by class and principal lane

| Class (n=10 except conversation n=20) | Lane | R@1 | R@5 | R@10 |
|---|---|---:|---:|---:|
| Conversation | Full shipped | 35% | 45% | 50% |
| Conversation | Conversation lane | 55% | 80% | 80% |
| Conversation | Raw chunk vector | 60% | 80% | 80% |
| Conversation | Message FTS | 5% | 25% | 25% |
| Conversation | P1 summary | 60% | 75% | 75% |
| Identifier | Full shipped | 10% | 20% | 40% |
| Identifier | Message FTS | 30% | 50% | 50% |
| Identifier | Commit hybrid | 0% | 0% | 0% |
| Fact/rule | Full shipped | 0% | 0% | 30% |
| Fact/rule | Memory hybrid | 80% | 90% | 90% |
| Mixed/hard | Full shipped | 10% | 40% | 60% |
| Mixed/hard | Conversation lane | 10% | 40% | 50% |
| Mixed/hard | Raw chunk vector | 10% | 40% | 40% |

The memory lane was 10/10 at rank 3 or better when the visible-memory filter was disabled. The one shipped-lane miss (`fact-10`) was already in that Alfonso session's visible memory block, so its exclusion is intentional. The broad full search nevertheless retained only 3/10 fact golds at rank 10, showing the same cross-source calibration problem from the opposite direction.

### Conversation cohorts

| Conversation form | n | Full R@10 | Conversation lane R@10 | Raw chunk R@10 |
|---|---:|---:|---:|---:|
| Keyword | 5 | 5/5 | 5/5 | 5/5 |
| Question | 9 | 5/9 | 9/9 | 9/9 |
| Zero-shared-token paraphrase | 6 | 0/6 | 2/6 | 2/6 |

All three last-week conversation golds and the one last-month gold were found by full search; among the 16 older golds, raw chunks found 12 while full fusion found only six. This does not establish a direct age penalty—the scorer has no age term and query style is confounded—but it does show that the complaint is concentrated in old, semantically phrased retrieval rather than recent coverage.

## Why full fusion loses good conversations

For conversation queries, the full top-10 contained:

| Source | Slots | Share |
|---|---:|---:|
| Notes | 117 | 58.5% |
| Compartments | 49 | 24.5% |
| Messages | 22 | 11.0% |
| Git commits | 5 | 2.5% |
| Memories | 4 | 2.0% |
| Primers | 3 | 1.5% |

Notes were top-1 for 10/20 queries. Nine queries had at least eight notes in their top 10. By contrast, memory hits were too rare to explain the crowding hypothesis.

The mechanism is visible in production scoring:

- chunk-only semantic hits retain `(cosine + 1) / 2 × 0.8`, then receive the 1.15 message-source boost;
- note matching accepts an exact substring **or any one shared keyword token**;
- after note matching, the original coverage score is discarded and the selected notes are remapped with linear rank decay: 1.0, 0.967, 0.933, ... for a 30-result tier;
- message+chunk fusion only remaps the conversation lane into a similar 1..0 band when message FTS also returns results. Natural-language queries often have no FTS hit, so their good chunks stay on the cosine scale.

This creates a score-scale bifurcation: exact/lexical conversation queries compete; semantic-only conversation queries are submerged.

### Conversation failure evidence

| Query | Primary class | Gold raw rank / cosine | Evidence; what won |
|---|---|---|---|
| `conv-01` | Fusion ranking | 3 / 0.7486 | Eight notes led by note `#81`; memory `#6271` and primer `#2` filled the rest. |
| `conv-03` | Fusion ranking | 1 / 0.7242 | Ten notes, led by note `#677`, displaced the rank-1 gold chunk. |
| `conv-04` | Fusion ranking | 4 / 0.4931 | Ten notes, led by note `#1780`; P1 would rank the gold first. |
| `conv-06` | Per-lane ranking | 15 / 0.6287 | Gold was below the conversation top-10; message `@92933` and related design compartments won. |
| `conv-07` | Fusion ranking | 1 / 0.7130 | Nine notes led by `#1056`, plus memory `#8313`. |
| `conv-09` | Granularity/representation | >50 | Exact-title control also missed top 50; full winner note `#275`. The verified raw span mixes cutover, allowlist, and doctor work. |
| `conv-11` | Phrasing mismatch | 34 / 0.6311 | Rewording toward the corpus title moved the same gold to raw rank 2; ten notes led by `#1726`. |
| `conv-13` | Granularity/representation | >50 | A 117-row, 42.7k-character implementation span dilutes the compact “Pi command parity” topic; exact control also missed. |
| `conv-14` | Fusion ranking | 1 / 0.7568 | Nine notes led by `#1728`, plus primer `#2`. |
| `conv-16` | Fusion ranking | 3 / 0.6849 | Ten notes led by note `#985`. |

## Failure taxonomy

The taxonomy assigns one primary cause per full-search miss; categories can overlap in reality.

### Conversation failures only (10/20)

| Cause | Count | Share |
|---|---:|---:|
| Ranking/fusion loss | 7 | 70% |
| Phrasing mismatch | 1 | 10% |
| Granularity/representation loss | 2 | 20% |
| Coverage hole | 0 | 0% |
| Hard-filter exclusion | 0 | 0% |
| Genuine absence | 0 | 0% |

Six of the seven ranking failures had the gold raw chunk already at rank 1-4 and were lost only after broad fusion. The seventh was raw rank 15.

### All full-search failures (27/50)

| Primary cause | Count | Share | Examples |
|---|---:|---:|---|
| Ranking/fusion loss | 15 | 55.6% | Six note-crowded conversation golds; six memory golds that were rank 1-3 in isolation; issue `#195`. |
| Searchable-field absence | 5 | 18.5% | Four full commit SHAs plus mixed SHA query; SHA is stored but unindexed/unmatched. |
| Granularity/representation loss | 3 | 11.1% | `conv-09`, `conv-13`, and `hard-06` (P1 rank 1 vs raw rank 30). |
| Phrasing/query mismatch | 2 | 7.4% | `conv-11`; long punctuated unresolved-session error rescued by extracted-keyterm FTS. |
| Hard-filter exclusion | 2 | 7.4% | Visible Alfonso memory `#15706`; live-tail message `@117830`. |
| Coverage hole | 0 | 0% | No selected gold lacked its current vector. |

“Searchable-field absence” is not physical row absence: the commit exists, but neither commit FTS nor its fallback searches SHA columns.

The live-tail control proves the boundary guard is non-vacuous. Query `raw messages compartment chunks` returned gold message `@117830` at unfiltered message-FTS rank 2, while the shipped cutoff at compartment end `116816` excluded it. This is correct behavior because the message remains visible in the live tail.

## Cheap-win probes

### 1. P1-summary vectors

The scratch probe embedded `title + "\n" + P1` for all 1,655 candidate compartments with the same provider and passage purpose.

| Representation | R@1 | R@5 | R@10 |
|---|---:|---:|---:|
| Raw chunk | 12/20 | 16/20 | 16/20 |
| P1 summary | 12/20 | 15/20 | 15/20 |

P1 rescued **zero** raw-chunk misses at rank 10 and badly regressed `conv-01` (raw rank 3, P1 rank 129). It did help isolated mixed cases (`hard-06`: P1 rank 1 vs raw rank 30; `hard-04`: P1 rank 2 vs raw miss). Conclusion: do not replace raw chunks with P1 vectors. A narrowly auxiliary title/summary lane might help mixed or multi-topic failures, but it needs separate gating and more evidence.

### 2. Offline fusion reweighting

The probe re-sorted recorded production lane outputs; it did not change retrieval candidates.

| Conversation fusion | R@1 | R@5 | R@10 | Delta at 10 |
|---|---:|---:|---:|---:|
| Shipped / offline reproduced baseline | 7/20 | 9/20 | 10/20 | — |
| +25% conversation-source weight | 7/20 | 11/20 | 15/20 | +25 pp |
| Class-aware: chunks/messages up, notes/memory down | 10/20 | 15/20 | 15/20 | +25 pp |
| Chunk-heavy class-aware | 11/20 | 15/20 | 16/20 | +30 pp |

The offline baseline reproduced shipped ranks exactly, validating the probe. The best weighting recovered the conversation lane's full recall@10 ceiling. It must not be global: fact/rule recall@10 fell from 3/10 to 0/10 under indiscriminate chunk-heavy weights.

### 3. Extracted-keyterm message FTS

The harness removes conversational stopwords, uses message-corpus document frequency to retain up to four discriminative terms, then either ANDs them or RRF-fuses production message-FTS calls.

| Message FTS form | R@1 | R@5 | R@10 |
|---|---:|---:|---:|
| Original query | 1/20 | 5/20 | 5/20 |
| Extracted terms, AND | 4/20 | 7/20 | 7/20 |
| Extracted terms, per-term RRF | 4/20 | 7/20 | 8/20 |

This is a real but secondary win: +15 percentage points at rank 10 over message FTS, still half the chunk lane. It does not solve semantic zero-token paraphrases; only 1/6 such queries was rescued at rank 10.

## Ranked improvement directions

1. **Calibrate broad fusion for conversation intent; cap or demote note-only matches.**
   **Evidence:** full conversation R@10 50% vs isolated conversation 80%; notes occupy 58.5% of slots; chunk-heavy intent-aware reweighting restores 80%.
   **Work/value:** high value, low-to-medium implementation effort. Start with score-domain normalization and a per-source cap or minimum token-coverage threshold for notes, guarded by a conversation-intent classifier. Preserve note dominance for explicit note/follow-up queries.

2. **Fix semantic-only conversation score normalization before changing embeddings.**
   **Evidence:** six gold chunks at raw rank 1-4 vanish after fusion; their cosine-derived scores remain about 0.39-0.76 while notes are remapped to 1.0..0.7.
   **Work/value:** likely the smallest change that addresses the main complaint. Normalize every lane in rank domain or use RRF across lanes instead of comparing heterogeneous score meanings.

3. **Add cheap query-term extraction as a complementary message lane.**
   **Evidence:** message FTS R@10 improves from 25% to 40%, and R@1 from 5% to 20%.
   **Work/value:** low effort; useful for names and semi-lexical natural queries. It should complement, not replace, chunk vectors.

4. **Add exact SHA/short-SHA lookup to commit search.**
   **Evidence:** 0/4 exact-SHA controls; the commit row exists and is embedded, but SHA is `UNINDEXED` and LIKE searches message only. A query that adds descriptive words (`hard-10`) finds the commit at isolated rank 1.
   **Work/value:** tiny, deterministic win for overall `ctx_search`; not conversation-specific but too cheap and clear to ignore.

5. **Investigate targeted title/P1 augmentation only for multi-topic or raw-miss cases.**
   **Evidence:** broad P1 is worse (75% vs 80% R@10) and rescues no conversation miss, but helps two mixed cases.
   **Work/value:** uncertain. A second vector or late fallback is more defensible than replacing raw chunks. Require a larger benchmark before product work.

6. **Keep outage coverage observability and eager repair, but do not treat backfill as the primary recall fix.**
   **Evidence:** Synapse ledger was heavily partial during Aug 25-29, proving transient risk, yet current recent coverage is 100% and no study failure is a hole.
   **Work/value:** operational resilience rather than ranking quality. Snapshot hole counts before repair and expose age-bucket coverage in diagnostics.

7. **Do not pursue raw-message ANN or wholesale P1 replacement from this evidence.**
   **Evidence:** current chunk coverage is complete for the complaint corpus; chunk isolation already reaches 80% R@10; P1 does not improve it. The largest measured loss happens after retrieval, not before it.

## Limitations and next benchmark steps

- Golds are real and manually verified, but one user's machine and project vocabulary can overfit results. Extend the fixture rather than replacing rows.
- Conversation golds are all from the long Magic Context session; AFT and Alfonso are represented in fact/rule controls. Add 10-20 sibling conversation golds in the next run.
- P1 vectors were measured on one model and one `title + P1` representation. This rejects a blanket P1 replacement, not every possible summary representation.
- Ledger `partial` is an operational signal, not a typed cert-failure record. A future outage study should pair failure diagnostics with point-in-time coverage snapshots.
- Offline reweighting reuses the top 10 from each production lane. That is sufficient for top-10 recombination (a lane's rank 11 cannot enter the global top 10 ahead of its own first ten), but production validation still needs latency and regression tests.
- The benchmark was run while the live corpus continued to grow. All gold identities and boundaries were validated at run start; results record the exact generation timestamp in the ignored JSON snapshot.

## Reproduction

```bash
bun scripts/ctx-search-benchmark.ts \
  --out local-ignore/ctx-search-study/results.json \
  --p1-cache local-ignore/ctx-search-study/p1-cache.sqlite
```

Use `--skip-p1` for a faster lane/fusion run after the P1 conclusion is already established. The output JSON contains content-redacted hit identities, scores, raw cosine values, selected key terms, coverage buckets, and every rank used below.

## Query set and verified golds

| ID | Class / style | Query | Gold (content-redacted) |
|---|---|---|---|
| `conv-01` | conversation / question | Where did we diagnose why note reminders vanished after disabling context reduction? | compartment `152388` — Note nudge subagent gate fix |
| `conv-02` | conversation / keyword | back-to-back prompt cache busts during historian run | compartment `152443` — Back-to-back historian cache busts |
| `conv-03` | conversation / zero-shared-token paraphrase | the installed desktop app stopped loading its neural model until we supplied the browser backend globally | compartment `152718` — Electron ORT_SYMBOL fix |
| `conv-04` | conversation / question | Which conversation investigated why the compressor stopped firing for issue 91? | compartment `152773` — Compressor trigger failure |
| `conv-05` | conversation / keyword | m0 m1 cache materialization taxonomy | compartment `153309` — m0/m1 cache taxonomy |
| `conv-06` | conversation / zero-shared-token paraphrase | when the background knowledge curator's second-generation blueprint was settled | compartment `154702` — Dreamer V2 decisions |
| `conv-07` | conversation / question | Where did we design Claude Code session binding for context tools through the daemon? | compartment `156552` — Claude Code MCP session resolution |
| `conv-08` | conversation / keyword | shadow mode byte compare Rust transform | compartment `156815` — Rust shadow byte comparison |
| `conv-09` | conversation / zero-shared-token paraphrase | when we moved the native compaction engine behind the service boundary | compartment `159653` — Rust-mode SUBC cutover |
| `conv-10` | conversation / question | Why was ctx-status computing the wrong usable context denominator? | compartment `161474` — ctx-status denominator fix |
| `conv-11` | conversation / zero-shared-token paraphrase | when we built utilities to inspect stored conversation state and watch the live stream | compartment `152333` — Context dump and tail viewer |
| `conv-12` | conversation / question | How did we plan one dashboard for both Pi and OpenCode histories? | compartment `152608` — Pi-aware dashboard design |
| `conv-13` | conversation / zero-shared-token paraphrase | when the second chat host acquired every operator action | compartment `152828` — Pi command parity |
| `conv-14` | conversation / question | What did we decide about the Copilot Anthropic and Pi tool issue queue? | compartment `153748` — Copilot and Pi issue triage |
| `conv-15` | conversation / keyword | F2 F3 performance optimization | compartment `154301` — F2/F3 performance work |
| `conv-16` | conversation / zero-shared-token paraphrase | the installed app's semantic encoder could not choose wasm correctly | compartment `155693` — Electron embedding device selection |
| `conv-17` | conversation / question | What happened in the ckdev drive wrapup rollback and reasoning-block investigation? | compartment `157794` — ckdev wrapup drive closure |
| `conv-18` | conversation / question | When did we add per-repository configuration profiles while reviewing MobileMem? | compartment `162196` — Per-repo profiles and MobileMem |
| `conv-19` | conversation / question | Where did the terminal finally ship 0.40.1 after the automated release attempts kept dying? | compartment `162310` — v0.40.1 terminal release |
| `conv-20` | conversation / keyword | Parity Hunt 3 memory-off suppression license PR 367 | compartment `162313` — Parity Hunt 3 |
| `identifier-01` | identifier / commit-sha | fec3f113e00736591aec75c5934b240f4e90dbf7 | git_commit `fec3f113e00736591aec75c5934b240f4e90dbf7` — Historian drain budget clock recovery |
| `identifier-02` | identifier / commit-sha | bfb943eec7733c154e98163448508d9e98e43484 | git_commit `bfb943eec7733c154e98163448508d9e98e43484` — Storage directory override |
| `identifier-03` | identifier / commit-sha | 6150c0ef6ee12890cfc7e4b6cc682bbaf575adc7 | git_commit `6150c0ef6ee12890cfc7e4b6cc682bbaf575adc7` — Migration v82 |
| `identifier-04` | identifier / commit-sha | 666493defa62665f8f636d971db70928b9c71708 | git_commit `666493defa62665f8f636d971db70928b9c71708` — Claude Code ordinal-domain parity revert |
| `identifier-05` | identifier / issue-number | issue #195 | message `msg_f0e202384001EggLcdLnJFOqnl` — Issue 195 discussion |
| `identifier-06` | identifier / error-string | session unresolved; launch Claude Code through the CortexKit wrapper so ctx_* can bind to this conversation | message `msg_f7cbc16de001O7YA34FhXBbgM1` — Claude Code unresolved-session error |
| `identifier-07` | identifier / function-name | getVisibleMemoryIds | message `msg_db4040686001csWtNy24TN2pks` — Visible-memory filter implementation |
| `identifier-08` | identifier / config-key | ctx_reduce_enabled | message `msg_d3be1574500115Tw7HOOBUWhXV` — ctx_reduce wiring diagnosis |
| `identifier-09` | identifier / config-key | cache_ttl | message `msg_d52a9421a001t781ndl1g04PMp` — cache_ttl status mapping |
| `identifier-10` | identifier / identifier | sqlite-vec | message `msg_ebce5c6e0001N7U7BtMmkX5ia9` — sqlite-vec rejection |
| `fact-01` | fact_rule / architecture | Why does ctx_search exclude memories already rendered in session history and raw messages after the compartment boundary? | memory `5028` — Unified-search visibility filters |
| `fact-02` | fact_rule / architecture | How does temporal awareness signal conversation gaps without breaking prompt cache stability? | memory `5159` — Temporal gap comments |
| `fact-03` | fact_rule / rule | What ordering keeps active user memories byte stable? | memory `7838` — Stable user-memory ordering |
| `fact-04` | fact_rule / architecture | What is the ordinal source of truth for shadow-mode comparisons? | memory `8485` — Shadow-mode ordinal source |
| `fact-05` | fact_rule / rule | How should ctx_reduce describe queued discards to models? | memory `6271` — Deferred-discard wording |
| `fact-06` | fact_rule / rule | Which README is canonical when translations differ? | memory `7502` — Canonical README language |
| `fact-07` | fact_rule / rule | How are historian prompts tested against real raw message ranges? | memory `4978` — Historian prompt experiment procedure |
| `fact-08` | fact_rule / constraint | What Anthropic failure can empty text blocks trigger after message mutation? | memory `5061` — Anthropic empty-block failure |
| `fact-09` | fact_rule / rule | Why must Cargo commands run serially in AFT? | memory `6979` — Serial Cargo command rule |
| `fact-10` | fact_rule / rule | How should durable state machines prove crash recovery across every state? | memory `15706` — State-machine totality matrix rule |
| `hard-01` | mixed_hard / cross-class | What did we ship for issue 78 and how was the Electron crash fixed? | compartment `152718` — Issue 78 Electron fix |
| `hard-02` | mixed_hard / decision | Why did we reject sqlite-vec and what storage approach replaced it? | compartment `153787` — sqlite-vec decision |
| `hard-03` | mixed_hard / date-anchored | What happened Wednesday August 26 around the 0.40.1 release? | compartment `162310` — v0.40.1 terminal release |
| `hard-04` | mixed_hard / commit-plus-conversation | What did commit 666493d change and which parity discussion led to it? | git_commit `666493defa62665f8f636d971db70928b9c71708` — Ordinal-domain parity revert; compartment `162314` — Parity Hunt 4 |
| `hard-05` | mixed_hard / memory-plus-conversation | Why are memories already visible in session history filtered from ctx_search? | memory `5028` — Unified-search visibility filters; compartment `152528` — ctx_search scoring and filtering |
| `hard-06` | mixed_hard / cross-class | When Rust mode moved to SUBC, how did Pi subagent allowlisting factor in? | compartment `159653` — Rust-mode SUBC cutover |
| `hard-07` | mixed_hard / memory-plus-conversation | What was decided about the shadow-mode ordinal source of truth? | memory `8485` — Shadow-mode ordinal source; compartment `156815` — Shadow byte comparison design |
| `hard-08` | mixed_hard / note-plus-conversation | What did issue 305 change about context pressure math? | compartment `161474` — ctx-status denominator fix; note `1780` — Context-pressure numerator note |
| `hard-09` | mixed_hard / hard-filter-control | raw messages compartment chunks | message `msg_04d703f3b001qzugB7roa1TOpF` — Live-tail chunk-design explanation |
| `hard-10` | mixed_hard / commit-plus-design | What changed in fec3f11 for the historian drain budget? | git_commit `fec3f113e00736591aec75c5934b240f4e90dbf7` — Historian drain budget clock recovery |

## Full per-query result matrix

Ranks are 1-based; `—` means absent from that lane’s measured depth (top 10 except raw chunks at top 50 and P1 over the full candidate pool). `Conv.` is the shipped message source with chunk+message fusion. `Fusion*` is the best offline probe (`chunk-heavy`).

| ID | Full | Conv. | Raw chunk | Msg FTS | Memory | Commit | P1 | Keyterm RRF | Fusion* |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `conv-01` | — | 3 | 3 | — | — | — | 129 | — | 3 |
| `conv-02` | 4 | 4 | 1 | — | — | — | 1 | 2 | 4 |
| `conv-03` | — | 1 | 1 | — | — | — | 2 | — | 1 |
| `conv-04` | — | 4 | 4 | — | — | — | 1 | 1 | 6 |
| `conv-05` | 1 | 1 | 1 | 3 | — | — | 1 | — | 1 |
| `conv-06` | — | — | 15 | — | — | — | 539 | — | — |
| `conv-07` | — | 1 | 1 | — | — | — | 3 | — | 1 |
| `conv-08` | 1 | 1 | 1 | 2 | — | — | 1 | 5 | 1 |
| `conv-09` | — | — | — | — | — | — | 926 | — | — |
| `conv-10` | 3 | 3 | 1 | — | — | — | 1 | 1 | 2 |
| `conv-11` | — | — | 34 | — | — | — | 232 | — | — |
| `conv-12` | 1 | 1 | 1 | — | — | — | 1 | — | 1 |
| `conv-13` | — | — | — | — | — | — | 326 | — | — |
| `conv-14` | — | 1 | 1 | — | — | — | 1 | — | 1 |
| `conv-15` | 6 | 1 | 1 | — | — | — | 1 | — | 1 |
| `conv-16` | — | 3 | 3 | — | — | — | 2 | 9 | 3 |
| `conv-17` | 1 | 1 | 4 | 5 | — | — | 1 | — | 1 |
| `conv-18` | 1 | 1 | 1 | 2 | — | — | 1 | 3 | 1 |
| `conv-19` | 1 | 1 | 1 | 1 | — | — | 1 | 1 | 1 |
| `conv-20` | 1 | 1 | 1 | — | — | — | 1 | 1 | 1 |
| `identifier-01` | — | — | — | — | — | — | — | — | — |
| `identifier-02` | — | — | — | — | — | — | — | — | — |
| `identifier-03` | — | — | — | — | — | — | — | — | — |
| `identifier-04` | — | — | — | — | — | — | — | — | — |
| `identifier-05` | — | 10 | — | 5 | — | — | 630 | — | 10 |
| `identifier-06` | — | — | — | — | — | — | 882 | — | — |
| `identifier-07` | 1 | 1 | — | 1 | — | — | 124 | 1 | 6 |
| `identifier-08` | 8 | 7 | — | 1 | — | — | 116 | 1 | 8 |
| `identifier-09` | 7 | 5 | — | 1 | — | — | 235 | 1 | 8 |
| `identifier-10` | 5 | 3 | 7 | 4 | — | — | 2 | 4 | 3 |
| `fact-01` | — | — | — | — | 1 | — | — | — | — |
| `fact-02` | 10 | — | — | — | 1 | — | — | — | — |
| `fact-03` | 6 | — | — | — | 1 | — | — | — | — |
| `fact-04` | — | — | — | — | 1 | — | — | — | — |
| `fact-05` | — | — | — | — | 1 | — | — | — | — |
| `fact-06` | — | — | — | — | 1 | — | — | — | — |
| `fact-07` | — | — | — | — | 1 | — | — | — | — |
| `fact-08` | 6 | — | — | — | 1 | — | — | — | — |
| `fact-09` | — | — | — | — | 3 | — | — | — | — |
| `fact-10` | — | — | — | — | — | — | — | — | — |
| `hard-01` | — | — | — | — | — | — | 15 | — | — |
| `hard-02` | 3 | 3 | 2 | 4 | — | — | 1 | — | 3 |
| `hard-03` | 1 | 1 | 1 | 1 | — | — | 5 | 1 | 1 |
| `hard-04` | — | — | — | — | — | — | 2 | — | — |
| `hard-05` | 3 | 3 | 5 | 6 | 1 | — | 8 | — | 3 |
| `hard-06` | — | — | 30 | — | — | — | 1 | — | — |
| `hard-07` | 10 | 7 | — | 1 | 1 | — | 37 | 2 | 8 |
| `hard-08` | 4 | 3 | 3 | — | — | — | 3 | 9 | 3 |
| `hard-09` | — | — | — | — | — | — | — | — | — |
| `hard-10` | 10 | — | — | — | — | 1 | — | — | — |

## Per-project current-model coverage appendix

Only compartment-bearing project identities are shown. `—` means no current registration/model was present for that scope.

| Project identity | Chunks | Missing | Memories | Commits | Missing compartment dates |
|---|---:|---:|---:|---:|---|
| `git:93eea8cd…` | 1655/1655 | 0 | 533/533 | 2000/2000 | — |
| `git:3fba0e3d…` | 1553/1553 | 0 | 552/552 | 2000/2000 | — |
| `git:1e394c24…` | 1062/1062 | 0 | 511/511 | 1909/1909 | — |
| `git:18e126e4…` | 1017/1017 | 0 | 11/11 | 1996/1996 | — |
| `git:9ca367d6…` | 378/756 | 378 | 153/153 | 145/145 | 2026-06-06..2026-06-28 |
| `git:f78f6db5…` | 509/509 | 0 | 96/96 | 279/279 | — |
| `git:4b0ea68d…` | 391/391 | 0 | 139/139 | 2000/2000 | — |
| `git:47b17104…` | 375/375 | 0 | 346/346 | 1039/1039 | — |
| `git:97e4da0a…` | 240/240 | 0 | 258/258 | 826/826 | — |
| `git:3a212fc3…` | 220/220 | 0 | 382/382 | 438/438 | — |
| `git:70ce7f04…` | 208/208 | 0 | 161/161 | 330/330 | — |
| `git:8f518b8d…` | 204/204 | 0 | 0/0 | 505/505 | — |
| `git:e4271beb…` | 202/202 | 0 | 157/157 | 635/635 | — |
| `git:70cb836e…` | 202/202 | 0 | 173/173 | 765/765 | — |
| `git:570d8cd0…` | 194/194 | 0 | 205/205 | 352/352 | — |
| `git:5d229bf4…` | 161/161 | 0 | 66/66 | 714/714 | — |
| `git:aa13a259…` | 134/134 | 0 | 284/284 | 469/469 | — |
| `git:842c2e5e…` | 121/121 | 0 | 123/123 | 326/326 | — |
| `git:8170cb12…` | 121/121 | 0 | 107/107 | 353/353 | — |
| `git:24669ada…` | 99/99 | 0 | 70/70 | 155/155 | — |
| `git:a3cb4e2e…` | 70/70 | 0 | 85/85 | 217/217 | — |
| `git:a295ccbe…` | 53/53 | 0 | 47/47 | 250/250 | — |
| `dir:07a38392e402` | 52/52 | 0 | 36/36 | 0/0 | — |
| `git:fc3c5afc…` | 26/26 | 0 | 23/23 | 176/176 | — |
| `git:a74c5da1…` | 14/14 | 0 | 9/9 | 2000/2000 | — |
| `git:c169c114…` | 5/5 | 0 | 36/36 | 94/94 | — |
| `git:0e973b7d…` | 0/4 | 4 | 4/4 | 8/8 | 2026-05-30..2026-05-30 |
| `git:dd126afa…` | 2/2 | 0 | 9/9 | 2000/2000 | — |
| `git:af4ffa3a…` | 2/2 | 0 | 280/280 | 184/184 | — |
| `git:a430cfa6…` | — | 2 | — | — | — |
