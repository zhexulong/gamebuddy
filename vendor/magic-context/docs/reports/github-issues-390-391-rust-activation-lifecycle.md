# GitHub issues #390 and #391 — Rust activation lifecycle

Date: 2026-08-29

## Contributor register

- Reporter: [@iceteaSA](https://github.com/iceteaSA)
- Surface: OpenCode `transform_mode: "rust"`, module store and TypeScript mirror drain
- Shared reproduction: activate Rust authority, return to TypeScript, then reactivate Rust
- Outcome: both independent defects were confirmed at the cited source locations and fixed

**STORE MIGRATION: NONE.** The fix derives snapshot vintage from existing `updated_at`, `classified_at`, and the retained full snapshot. It adds no table, column, or module-store schema version.

## #390 — idempotent authority workspace activation

`replace_workspace_tx` inserted the deterministic authority workspace name and then trusted `last_insert_rowid()`. A second activation found the first activation's row, failed the unique name constraint, and never reached module transform dispatch.

The replacement now uses the same transaction-local get-or-create style as the store's test seed helper:

1. upsert the workspace by name;
2. select its durable id by that unique name;
3. replace that id's member projection; and
4. upsert members by their unique `project_path` slot.

The pre-delete also resolves both route spellings. Authority workspaces store the bound domain identity as the owner member, while state sync addresses the filesystem route. A same-name workspace is retained so reactivation reuses its id; a genuinely replaced or explicitly cleared workspace is removed through either spelling.

No SQLite `RETURNING` dependency was introduced. The bundled SQLite already supports the upsert syntax used elsewhere in this crate, and selecting by the unique name in the same fenced transaction avoids the stale `last_insert_rowid()` problem on every supported runtime.

### Activation insert sweep

| State-sync/activation write | Unique key behavior | Adjudication |
| --- | --- | --- |
| `mc_authority` begin-prepare row | `(context_store_uuid, project, domain)` | Existing `ON CONFLICT ... DO NOTHING`, followed by a keyed read and state transition. |
| Authority seed memories/notes | source identity and natural memory identity | Existing keyed adoption/upsert; seed ledger rows, pending references, and mappings all upsert. |
| `mc_compartments` state-sync seed | `(session_id, sequence)` | Existing overwrite-on-first-seed or do-nothing-on-retained-seed policy. |
| Pending drops and user hints | session/block natural keys | Existing `DO NOTHING`; no generated id is consumed afterward. |
| `mc_workspaces` | unique `name` | **Fixed:** upsert plus keyed select returns the existing id. |
| `mc_workspace_members` | primary workspace/member key plus unique `project_path` | **Fixed:** same-workspace rows are replaced and project slots upsert, so repeated member projection is idempotent. |
| `mc_memories` and `mc_memory_mutation_log` state-sync sections | source identity/id and memory natural key | Existing conflict updates; module-owned memory pools are fenced out of host state sync. |
| `mc_user_memories` | replacement projection | Delete/reinsert in the same transaction; no conflicting retained row. |
| `mc_cache_state` | unique `session_id` | Existing conflict update. |

No second bare activation insert requiring a generated id remains in the audited path.

### Non-retryable failure propagation

A workspace constraint raised inside state sync is now preserved as `ModuleStateSyncError::NonRetryableStoreConstraint`. The module emits the typed wire code `state_sync_non_retryable` with `retryable:false`. The Rust adapter recognizes that code, immediately enters its existing parked state, and uses the existing five-pass probe cadence instead of paying full state-sync cost on the next passes. The ordinary retryable failure threshold is unchanged. The pass line now carries `reason=state_sync_non_retryable`, so the primary telemetry line names the failure class.

## #391 — stale mirror snapshots cannot roll back newer host rows

Two mechanisms were present:

1. Sparse mapping snapshots could explicitly project `importance=NULL` and `source_type=NULL`. `repairNullClobberedMemoryRows` then copied both values from an older retained full snapshot, even replacing a non-null sibling field.
2. `applyMemoryRow` selected `status` directly from any present module snapshot. A retained pre-archive full row therefore changed a newer host `archived` row back to `active`. This unconditional full-row apply was the isolated status sibling.

The mirror page already had an outer privileged `BEGIN IMMEDIATE` transaction. Regression coverage now pins that the sparse null projection, retained-snapshot repair, reference translation, cursor update, and any failure all commit or roll back together. A forced repair failure leaves neither NULL placeholder nor advanced cursor visible.

The recency belt is applied before the row update:

- row-wide mutable fields preserve the host value when host `updated_at` is newer than the retained/full snapshot's `updated_at`;
- classification fields also preserve the host value when host `classified_at` is newer;
- complete verification and mural snapshots use the same row vintage guard;
- sparse verification/mapping feed records remain ordered by `feed_seq`, preserving legitimate explicit clears that do not carry a row timestamp;
- repair fills only a currently NULL `source_type` or `importance`, never replaces a non-null field, and repeats the `updated_at`/`classified_at` vintage predicate in SQL at the write boundary.

### Mirror projection column sweep

| Columns | Projection behavior | Protection/adjudication |
| --- | --- | --- |
| `id`, `context_store_uuid`, `context_row_id` | Used to resolve mirror identity; not written by the memory update statement. | Identity-only. Matching local store ids may adopt the mapped context row; foreign ids allocate separately. |
| `project_path` | Present in snapshots and used for routing. | Existing cross-project ownership check remains fail-closed; an already-mapped row keeps its project. |
| `first_seen_at`, `created_at` | Present in full snapshots. | Genuinely immutable after context-row adoption; existing values always win. |
| `category`, `content`, `normalized_hash`, `source_session_id` | Full or sparse row projection. | Sparse absence means unchanged; a complete/stamped stale snapshot cannot overwrite a newer host row. Hash changes still invalidate embeddings only when actually applied. |
| `seen_count`, `retrieval_count`, `last_seen_at`, `last_retrieved_at` | Mutable counters/times in the row projection. | Guarded by snapshot versus host `updated_at`. |
| `status`, `expires_at` | Mutable lifecycle fields in the same apply statement. | Guarded by `updated_at`. This is the archived-to-active sibling isolated from the report. |
| `importance`, `scope`, `shareable`, `source_type`, `classified_at` | Classification projection; sparse legacy rows can carry explicit NULL metadata. | Guarded by both `classified_at` and `updated_at`. Repair is transaction-contained, NULL-only, and independently vintage-checked. |
| `verification_status`, `verified_at` | Memory-row verification projection. | Complete snapshots are `updated_at` guarded. Sparse feed updates use monotone `feed_seq` so explicit module clears remain possible. |
| `mapping`, `mapping_origin` | Replaces the `memory_verifications` side-table projection; null clears, empty array installs the sentinel. | Same transaction as memory apply and cursor. Complete stale rows are `updated_at` guarded; sparse feed order remains authoritative. |
| `superseded_by_memory_id` | Direct or deferred identity translation. | A stale row-wide snapshot cannot replace the pointer or mutate pending-reference state; ordinary translation remains atomic with the page. |
| `merged_from`, `metadata_json` | Mutable provenance payloads. | Guarded by snapshot versus host `updated_at`. |
| `mural_cue`, `mural_cue_hash`, `mural_cue_at`, `mural_cue_rejection_count` | Derived cue projection. | Complete snapshots are guarded by row `updated_at`; all writes remain in the page transaction. |
| `updated_at` | Snapshot audit timestamp. | Never moved backwards by an older snapshot. A legitimate NULL repair advances it only when a missing value is actually filled. |

## Regression and executed mutation evidence

The activation regression uses a file-backed `mc-store` fixture with a route binding whose workspace owner is the authority identity. It performs activation, a TypeScript-mode pass that omits module workspace state, and reactivation. The second activation succeeds and returns the exact first workspace id.

The mirror regressions establish an old full snapshot, apply newer host classification/archive state, replay sparse and full stale rows as a drain, and assert `importance`, `scope`, `shareable`, `source_type`, `status`, `classified_at`, and `updated_at` are byte-for-byte unchanged. Separate coverage pins the status sibling, every guarded projection group, the newer-snapshot direction, immutable source times, verification mappings, and transaction rollback.

Every deliberate mutation used the exact `NON-VACUITY BREAK` marker and was restored immediately:

| Deliberate break | Red evidence |
| --- | --- |
| Revert workspace get-or-create to the original bare insert | `mc-store/src/lib.rs:23780` failed with `NonRetryableStoreConstraint { detail: "UNIQUE constraint failed: mc_workspaces.name" }`. |
| Disable typed immediate parking | `rust-mode-transform.test.ts:2662` observed `parked=false` after the first non-retryable state-sync error. |
| Disable row/classification recency selection | `context-authority.test.ts:986` showed all seven protected values rolled back: importance `91→60`, status `archived→active`, and both timestamps `300→100`. |
| Remove both mirror transaction boundaries while retaining write privilege | `context-authority.test.ts:1276` observed persisted `importance=NULL` and `source_type=NULL` after the forced repair failure. |

The restored source contains no mutation marker.

## Verification

- `cargo test -p mc-store` — passed, 132 tests.
- `cargo test -p mc-module` — passed, 1,000 passed and 4 ignored, plus integration/doc gates.
- Focused authority and Rust adapter regressions — passed.
- `bun run typecheck` in `packages/plugin` — passed.
- `bun run test` in `packages/plugin` exercised all 4,223 tests: 4,222 passed and the unrelated `tail-hygiene-walk` wall-clock p95 check measured 40.5 ms against its 30 ms shared-runner ceiling. That file passed 18/18 immediately in isolation.
- A serial full-suite confirmation again completed all 4,223 tests but hit unrelated timing ceilings, including `message-index-async`'s 10-second scheduler wait; that file passed 14/14 immediately in isolation.
- `cargo fmt --check` and changed TypeScript Biome checks — passed. The untouched Rust all-target lint baseline still reports one mc-store test initializer warning and three mc-module transform warnings; `mc-store --lib` passed with warnings denied, and `mc-module --lib` passed with only those three baseline lints allowed.

## Reply draft for #390

Thanks @iceteaSA — confirmed exactly at the cited state-sync workspace insert. The deterministic authority workspace survived the first Rust activation, and the next activation tried a bare insert before reading `last_insert_rowid()`, so every pass failed before module dispatch. The workspace path is now a real get-or-create: it upserts by name, selects the durable id in the same fenced transaction, and replaces/upserts that id's members. The activate → TypeScript → reactivate regression succeeds and verifies that the second activation reuses the same workspace id; restoring the bare insert reproduces the unique-name failure.

We also audited the neighboring activation inserts. Authority rows, seeds, compartments, pending rows, memories, mutations, and cache state already have keyed update/do-nothing or transactional replacement semantics; the workspace member projection was the sibling needing idempotent handling. If a workspace constraint still occurs, the module now reports typed `state_sync_non_retryable` (`retryable:false`). The adapter immediately enters its existing parked/probe cadence, and the pass line reports `reason=state_sync_non_retryable`, rather than spending the full state-sync cost on every pass. No schema migration or SQLite `RETURNING` dependency was needed.

## Reply draft for #391

Thanks @iceteaSA — confirmed both the 46-row classification rollback and the 4-row archived-to-active class. Your retained-snapshot join identified the first mechanism: a sparse mapping projection could write NULL metadata and the repair then trusted an older `full_row_snapshot`. The status sibling was the ordinary `applyMemoryRow` full-row branch: a present stale `status` was selected unconditionally, so the pre-archive module snapshot replaced the newer host lifecycle state even though no transform succeeded.

Mirror projection plus repair is now pinned inside one write transaction, so a failed repair cannot expose a NULL placeholder or advance the cursor. A second recency belt compares the retained/full snapshot with host `updated_at` and `classified_at`; newer host classification and lifecycle fields win. The repair now fills only NULL fields and repeats the vintage predicate in SQL. We also swept every projected memory column: immutable identity/source-time fields stay immutable, row/classification fields are recency guarded, complete verification/mural snapshots are guarded, and sparse mapping records retain feed-sequence semantics for legitimate explicit clears. The regression reproduces classify-newer → failed Rust passes → drain and keeps importance, status, `classified_at`, and `updated_at` unchanged; the archived-status branch is pinned separately.

Credit also to your paired count+hash fingerprint instrument. Counts and ordinary timestamp audits structurally could not reveal this rollback: row counts stayed stable, `classified_at` did not move in the incident, and repair bumped `updated_at` without identifying which value moved backward. The classification hash exposed exactly what those audits cannot, and the 46/4 split made the two source mechanisms isolatable. No store migration was required.
