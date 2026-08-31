# Armed-store migration replay coverage report

**Scope:** `packages/plugin` and the authority schema in `crates/mc-store`
**Repository state inspected:** latest plugin migration v78; v71 is the durable authority-trigger rebuild
**Verdict:** **GAP** — there is one replay test with the plugin-side managed marker armed, but no replay leg executes a guarded-table DML operation while armed. No fixture seeds a real `MODULE` authority row in the migration replay harness.

## Terminology and schema boundary

The repository has two different pieces of authority state:

- The plugin's `context_privilege_state` is **not** a `MODULE` authority table. It is a singleton writer bracket: `id = 1`, `enabled` is `0` or `1` (created by migration v54 at [`migrations.ts:2199-2202`](../packages/plugin/src/features/magic-context/migrations.ts#L2199-L2202)). `withPrivilegedWriter` opens `BEGIN IMMEDIATE`, sets `enabled = 1`, performs the operation, resets it to `0`, and commits ([`shared/sqlite.ts:287-319`](../packages/plugin/src/shared/sqlite.ts#L287-L319)).
- The plugin-side marker that arms the authority guards is `authority_managed` (or the fail-closed `authority_repair_pending` marker), not a `context_privilege_state` row. The trigger predicates check those marker tables ([`migrations.ts:146-160`](../packages/plugin/src/features/magic-context/migrations.ts#L146-L160)).
- The Rust store's actual authority state is `mc_authority.state`, whose CHECK constraint includes `MODULE` ([`crates/mc-store/src/lib.rs:950-972`](../crates/mc-store/src/lib.rs#L950-L972)). The plugin migration tests do not open or seed that table. The crate source has no `context_privilege_state` authority fence and no separate test fixture that seeds `mc_authority.state = 'MODULE'`.

Therefore, “armed” in the plugin replay harness can only mean: a real `authority_managed` marker exists, the v71 triggers are installed, and `context_privilege_state.enabled = 0` outside a writer bracket. `enabled = 1` means the opposite of an unprivileged armed write: it is the temporary privileged escape hatch.

## 1. Test inventory: armed or unarmed stores

### Direct `context_privilege_state` evidence

A test search finds direct `context_privilege_state` references only in:

- [`migrations-v54.test.ts:98-109`](../packages/plugin/src/features/magic-context/migrations-v54.test.ts#L98-L109), which checks the durable predicate in trigger SQL and that the old UDF is absent.
- [`migrations-v54.test.ts:111-125`](../packages/plugin/src/features/magic-context/migrations-v54.test.ts#L111-L125), which checks that a completed privilege bracket leaves `enabled = 0`.
- [`migrations-v71.test.ts:14-18`](../packages/plugin/src/features/magic-context/migrations-v71.test.ts#L14-L18), which defines the expected predicate, and [`:184-189`](../packages/plugin/src/features/magic-context/migrations-v71.test.ts#L184-L189), which checks the flag is cleared after a second connection's bracket.

None of those tests directly seeds a persistent `MODULE` authority row. The only `enabled = 1` writes are transient `withPrivilegedWriter` brackets.

### Migration replay tests

| Test | Store state during replay | What it proves | Gap remaining |
|---|---|---|---|
| [`migrations-v54.test.ts:206-234`](../packages/plugin/src/features/magic-context/migrations-v54.test.ts#L206-L234), “reinstalls the latest authority triggers after replaying a legacy batch” | **Marker armed.** It installs `authority_managed` at `:208-210`, deliberately replaces one trigger, removes migration rows `>= 61`, then calls `runMigrations` at `:224`. | v71/latest trigger installation restores the normal refusal; the post-replay unprivileged session-note insert is rejected at `:226-232`. | No migration body in this leg performs an `INSERT`, `UPDATE`, or `DELETE` on a guarded memory/note row. The replay exercises trigger DDL and a postcondition write, not a guarded migration DML path. |
| [`migrations-v71.test.ts:126-159`](../packages/plugin/src/features/magic-context/migrations-v71.test.ts#L126-L159) | **Unarmed during replay.** It resets v71 and replays with no managed marker. | Legacy UDF triggers are rebuilt to the durable state-table predicate and the rebuild is idempotent. | No armed marker is present while `runMigrations` runs. |
| [`migrations-v71.test.ts:161-190`](../packages/plugin/src/features/magic-context/migrations-v71.test.ts#L161-L190) | Marker is installed only after migration at `:170`; the second connection is explicitly put through `withPrivilegedWriter` at `:175`. | A privileged second connection can write without the old `no such function` failure and the flag is cleared. | This is a connection/guard test, not an armed replay. |
| The remaining `migrations-v*.test.ts` fixtures | **Unarmed.** They use `new Database`, `initializeDatabase`, `runMigrations`, or sparse `schema_migrations` fixtures without `installAuthorityManagedMarker` or a `MODULE` seed. | Individual schema changes, convergence/idempotence, and sparse-schema tolerance. | They do not exercise v71 guards against managed rows. |

The v54 replay leg is important partial coverage: the incident's “armed marker absent during replay” shape is not completely absent here. It still does not catch a migration that writes a managed `memories` or `notes` row, because no current replayed migration makes that write.

### Schema-convergence/schema-fence tests

The schema-fence probe is [`schema-fence-probe.test.ts:16-24`](../packages/plugin/src/features/magic-context/schema-fence-probe.test.ts#L16-L24) and [`:87-97`](../packages/plugin/src/features/magic-context/schema-fence-probe.test.ts#L87-L97): it creates a fresh migrated database and adds a future `schema_migrations` row. There is no authority marker or privilege-state setup. It tests version visibility, not guarded writes.

`openDatabase` follows `initializeDatabase` → `runMigrations` → `ensureContextStoreUuid` ([`storage-db.ts:2118-2130`](../packages/plugin/src/features/magic-context/storage-db.ts#L2118-L2130)); it does not arm a module marker before migrations. This is the setup used by the storage-db schema tests.

### `clearSession` coverage

The structural clear-session test is [`storage-db.test.ts:331-398`](../packages/plugin/src/features/magic-context/storage-db.test.ts#L331-L398). It opens an ordinary `openDatabase()` store, discovers every table with a `session_id`, and seeds rows generically. It never installs `authority_managed`, seeds module authority, or establishes a managed project.

`clearSession` itself uses a plain transaction and deletes `session_projects` before session notes ([`storage-meta-session.ts:215-248`](../packages/plugin/src/features/magic-context/storage-meta-session.ts#L215-L248).) Thus the current structural coverage does not prove that clearing a managed project is allowed/refused under the authority triggers. The dedicated v67/v73 clear-session tests likewise use ordinary fresh migrated databases rather than an armed fixture.

### Storage-layer tests that do have the closest armed equivalent

These tests install `authority_managed` or create the marker table, so the real plugin guards are active when they use the normal schema:

- [`migrations-v54.test.ts:32-109`](../packages/plugin/src/features/magic-context/migrations-v54.test.ts#L32-L109): direct memory/smart-note refusal, privileged writes, and durable predicate checks.
- [`migrations-v54.test.ts:155-204`](../packages/plugin/src/features/magic-context/migrations-v54.test.ts#L155-L204): raw second-connection refusal and no privilege leakage.
- [`migrations-v71.test.ts:192-226`](../packages/plugin/src/features/magic-context/migrations-v71.test.ts#L192-L226): unprivileged memory INSERT/UPDATE/DELETE refusal and privileged seed.
- [`context-authority.test.ts:137-153`](../packages/plugin/src/features/magic-context/context-authority.test.ts#L137-L153) and other marker-backed mirror/drain cases: the module client stub reports `MODULE`, while the local DB uses the marker and privileged mirror writes. These are protocol tests, not migration replay tests.
- [`mural/compress-cues.test.ts:532-560`](../packages/plugin/src/features/magic-context/mural/compress-cues.test.ts#L532-L560): derived cue-column update passes through `withPrivilegedWriter`; a direct content update is refused.
- [`storage-identity-merge.test.ts:257-273`](../packages/plugin/src/features/magic-context/storage-identity-merge.test.ts#L257-L273): marker-backed identity merge refusal.
- [`hooks/magic-context/transform-authority-flip-back.test.ts:32-47`](../packages/plugin/src/hooks/magic-context/transform-authority-flip-back.test.ts#L32-L47) and [`:118-139`](../packages/plugin/src/hooks/magic-context/transform-authority-flip-back.test.ts#L118-L139): marker plus a stubbed module status map, but no migration replay.

The `ctx-memory` and `ctx-note` tool tests create a minimal `authority_managed` table ([`ctx-memory/tools.test.ts:35-44`](../packages/plugin/src/tools/ctx-memory/tools.test.ts#L35-L44), [`ctx-note/tools.test.ts:10-18`](../packages/plugin/src/tools/ctx-note/tools.test.ts#L10-L18)). Those are mock schemas without v71 triggers or `context_privilege_state`; they are not armed-store coverage.

## 2. Guarded-table write paths a migration can touch

Migration v71 rebuilds exactly six authority triggers via `installLatestAuthorityTriggers` ([`migrations.ts:163-214`](../packages/plugin/src/features/magic-context/migrations.ts#L163-L214)):

| Trigger | Operation | Refusal text | Guarded row condition |
|---|---|---|---|
| `memories_authority_guard_insert` | `BEFORE INSERT ON memories` | `context.db memory writes are managed by the Rust module` | New project is in `authority_managed` or `authority_repair_pending`. |
| `memories_authority_guard_update` | `BEFORE UPDATE ON memories` | same memory text | Old or new project is managed or repair-pending. |
| `memories_authority_guard_delete` | `BEFORE DELETE ON memories` | same memory text | Old project is managed or repair-pending. |
| `notes_authority_guard_insert` | `BEFORE INSERT ON notes` | `context.db note writes are managed by the Rust module` | `managedAuthorityNoteRow(NEW)` is true. This includes a managed project marker, repair-pending marker, or a session linked through `session_projects`. |
| `notes_authority_guard_update` | `BEFORE UPDATE ON notes` | same note text | Old or new note ownership is managed. |
| `notes_authority_guard_delete` | `BEFORE DELETE ON notes` | same note text | Old note ownership is managed. |

Every trigger adds the durable predicate

```sql
COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
```

and raises `ABORT` when that predicate is true. The v71 migration itself is only trigger DDL (`installLatestAuthorityTriggers(db)` at [`migrations.ts:2691-2705`](../packages/plugin/src/features/magic-context/migrations.ts#L2691-L2705)). It does not update a memory or note row.

The only migration DML that directly inserts into the guarded `notes` table is the v1 migration of legacy `session_notes`/`smart_notes` ([`migrations.ts:246-271`](../packages/plugin/src/features/magic-context/migrations.ts#L246-L271)). In normal sequential replay, v1 runs before v54 creates the authority tables/triggers. Later migrations add columns or indexes to `notes`/`memories`, and migration v61 updates `mirror_resnapshot_state`, not `memories`. There is no current migration `UPDATE`, `DELETE`, or later `INSERT` against a guarded managed memory/note row.

## 3. Plain replay connection versus privilege bracket

`runMigrations` applies each migration body inside `db.transaction().immediate()` ([`migrations.ts:2891-2952`](../packages/plugin/src/features/magic-context/migrations.ts#L2891-L2952)). It does **not** call `withPrivilegedWriter` and does not set `context_privilege_state.enabled = 1`.

Consequences for a hypothetical migration DML statement:

1. On a store with an `authority_managed`/repair-pending row and v71 triggers installed, the migration statement runs through the trigger on the same plain connection.
2. The state-table predicate reads `enabled = 0` (or no row, which coalesces to `0`), so a qualifying memory/note INSERT, UPDATE, or DELETE is refused with the trigger's managed-write text.
3. A statement inside `withPrivilegedWriter` is different: the helper starts/joins the transaction, sets `enabled = 1`, performs the write, resets to `0`, and then commits. The v71 trigger sees the temporary privilege and allows it. Existing tests demonstrate this exact contrast: raw writes throw while `withPrivilegedWriter` writes pass ([`migrations-v71.test.ts:192-225`](../packages/plugin/src/features/magic-context/migrations-v71.test.ts#L192-L225)).
4. The current v54 armed replay leg therefore exercises the correct **connection mode** for a future migration (plain), but it has no guarded-table DML for the trigger to reject. Its post-replay assertion is a direct unprivileged write, not a write from a migration body.

## Proposed step-through fixture (not implemented)

The minimal fixture must be a **step-through migration replay**, not an all-but-the-last replay. Replaying only the final migration leaves data-moving migrations blind: a backfill can run against empty tables and pass without exercising its write path. Do not change production migrations for this probe.

Use one fixture with the product of two axes:

- **Populated data:** after each migration creates a schema that can hold a relevant row, a version-keyed helper populates that row before the next migration runs.
- **Armed authority:** at v71, when the durable privilege-state fence exists, arm MODULE ownership and leave the store refusing unprivileged managed writes for every subsequent step.

Proposed sequence:

1. Start from the smallest supported pre-migration schema and migration ledger. For each migration `N` in order:
   - apply exactly migration `N`;
   - call `populateForVersion(N, db)` before applying `N + 1`;
   - then apply `N + 1` to the now-populated store.
   This must exercise every migration against rows made possible by its immediately preceding schema, including data-moving migrations such as v45/v70-shaped backfills.
2. Implement `populateForVersion` as a **version-keyed exhaustive helper**. It must throw/panic on an unknown version; an omitted case is a coverage failure, not a no-op. Each known case must write rows only through the public storage APIs for that schema version (for example, the public memory/note/session APIs), never through hand-built raw SQL rows. The fence is specifically meant to stop the test from trusting an incomplete hand-written schema belief.
3. When a public writer first depends on a later-arriving table or privilege mechanism, leave that version's populate arm empty and add a comment stating exactly which claim is narrowed and why. An empty arm is permitted only for that explicit boundary; silently skipping an unknown version is not.
4. At v71, after applying the migration that creates/rebuilds `context_privilege_state` and the durable guards, use public authority APIs to:
   - establish the context store identity;
   - arm MODULE ownership for both `memories` and `notes` (the plugin-side `authority_managed` markers; an integration fixture also seeds Rust `mc_authority.state = 'MODULE'`);
   - create/verify the privilege-state row with `enabled = 0` outside a writer bracket;
   - verify all six v71 triggers contain the durable predicate.
   From v72 onward, each migration lands on stores that are both populated and armed.
5. For each later version whose public writer touches a guarded table, populate through the public API inside `withPrivilegedWriter` only where that API requires it, then assert the unprivileged path is refused. The positive path must succeed through the public privileged API and leave `enabled = 0`; the negative path must be a plain connection and must preserve the exact trigger text:
   - memory: `context.db memory writes are managed by the Rust module`;
   - notes: `context.db note writes are managed by the Rust module`.
6. Include a discriminating mutation test: append a **data-mover migration** to the end of the migration list (do not insert one in the middle, which changes version bookkeeping and can perturb the wrong property). The mutation must copy/update a populated row using the public API. Both mutation halves must be exercised: the mutant compiles, and the test's populated-data assertion is perturbed while unrelated authority assertions remain unchanged. A passing fence that does not fail this appended data-mover mutant is not evidence of coverage.

This preserves the existing v54 armed replay test but closes its blind spot: every migration meets real populated data, v71 arms the trigger axis at the point the fence arrives, and later migrations are checked across both privileged-success and unprivileged-refusal directions.
