# 30 Cross-Process Continuity Surface Foundation

> **Status:** destructive fresh semantic authority **is mounted in the production entrypoints** and has passed focused deterministic, Host typecheck, production artifact, source-boundary, and immutable-generation checks. `main.ts` mounts the independent Game facade; `dialogue-web-main.ts` mounts the independent Chat facade. This is implementation/S0–S5 engineering evidence only: independent-process recovery evidence (including a real Windows owner-death query) and all Tavern/Game live gates remain pending. It is not a UI, Tavern, Game, or release proof.
>
> **Applies to:** one `CompanionContinuity` partition's independent Chat lifecycle, independent Game lifecycle/lease/recovery, and Chat archive lifecycle CAS. It grants neither a Tavern/UI release nor a Game/live release.

## 1. Frozen pre-release decision and boundary

GameBuddy is unreleased. Production will make a **destructive pre-release replacement**, not an in-place migration:

- a fresh, production-identified semantic SQLite store is the sole production continuity authority;
- production never imports, adopts, upgrades, parses, reconciles with, dual-reads, dual-writes, read-repairs, or falls back to legacy `companion-continuity.json`, legacy surface sessions, legacy lease files, or a test-only semantic database;
- production has no `LEGACY` route, compatibility route, authority-selection fallback, migration/adoption state, or legacy ACL/DACL seal;
- historical Dialogue roots are externally archived data, never a production authority input. Operator disposition is explicit and never an automatic runtime migration;
- unknown schema/store identity, a test fixture store, partial bootstrap, legacy artifact in an admitted candidate root, or ambiguous/live owner state fails closed.

This replacement concerns continuity authority only. It does not authorize deletion, import, or ownership changes for Character/Profile, ST Card candidates, World Info, player-visible transcripts, Pi/Magic Context histories, credentials, prompts, Stardew fixtures, or other mixed runtime-root contents.

The semantic authority holds coordinator state, independent surface lifecycle state, Game lease/recovery state, and Chat archive lifecycle CAS. Drafts, transcripts/messages, Pi/Magic Context artifacts, content imports/exports, credentials, and Tavern artifacts remain outside its transactions and cannot become a second writer or fallback.

Chat and Game are **independent concurrent surfaces**. They share only the manifest-derived principal/continuity partition; they do not form a Chat → Game → Chat mode transition. A Chat open/close/recovery never selects, suspends, closes, restores, or otherwise mutates Game. A Game enter/close/recovery never selects, suspends, closes, restores, or otherwise mutates Chat. No production schema, request, receipt, permit, or runtime contract contains `GameOrigin`, selected Chat, a Chat suspension, a return target, or a Chat restore operation.

## 2. Required authority semantics

Every mutation validates schema, authenticated principal, partition, exact bindings, expected revision/fence, legal state transition, `operationId`, and deadline before effect and terminal commit. Under a Windows partition mutex, a short SQLite transaction revalidates durable state, advances a monotonic fence, and persists a typed pending intent with canonical payload digest. Neither mutex nor transaction spans runtime construction, browser/SSE work, content I/O, or another external/asynchronous effect. Terminal commit reacquires the mutex, accepts only the pending intent's exact binding/digest/fence, and requires durable read-back. Stale callback, cancellation, ambiguity, mismatch, or receipt-less effect failure fails closed; an effect failure becomes `effect_failed → recovery_required`, never fabricated success.

| Command family | Required exact behavior before mount |
|---|---|
| Fresh provision | Creates only a new production store/partition with explicit schema/store identities, manifest principal, bootstrap `operationId`, initial revision/fence, and durable read-back. It never derives facts from legacy artifacts. |
| Chat lifecycle | Creates, opens, closes, and recovers only the exact Chat surface session using Chat-owned lifecycle state. It never reads or mutates Game state as a precondition or effect. |
| Archive lifecycle CAS | Archives, trashes, or restores only the exact scoped Chat metadata record with `expectedManagementRevision`; atomically persists and reads back the legal transition and revision. It has no implicit selection, Game, draft, transcript, or Memory effect. |
| Game enter | Binds only the manifest principal, exact Game session, authorized world, binding digest, exact owner tuple, revision/fence, and deadline. It creates/advances only Game-owned intent/session/lease state. A second active Game for the same permitted scope is rejected by durable exact-owner CAS; it never suspends another surface. |
| Game close | Performs only the exact Game `prepare → unlocked runtime disposal → terminal commit/failure` lifecycle. Successful close ends that Game session and removes its live lease; it never restores or selects Chat. |
| Game recovery and lease | Acquires, advances, releases, and explicitly recovers only the exact Game lease. It rejects stale owner/callback, ambiguity, owner/binding mismatch, deadline failure, and competing unresolved Game sessions. Recovery requires an explicit request and a durable prior owner proven dead. |

Browser handles, integration payloads, Tavern artifacts, and model text never grant or supply principal, world, binding digest, owner, lease, revision, fence, deadline, or authority identity. Game recovery has no inferred peer-surface state: live, missing, stale, ambiguous, or binding-mismatched ownership fails closed.

## 3. Fresh-store bootstrap and topology schema v2

The production route record has exact continuity/schema/store identities, bootstrap `operationId`, monotonic route revision, and one of these paired states only:

| Authority state | Route | Meaning |
|---|---|---|
| `UNINITIALIZED` | `NONE` | No admissible production store/partition exists; no command may route. |
| `INITIALIZING` | `NONE` | The bounded fresh bootstrap is durable but not read back; no command may route. |
| `ACTIVE` | `SEMANTIC` | The fresh semantic store is the sole reader/writer for all authority commands. |
| `QUARANTINED` | `NONE` | Bootstrap, schema, ownership, or read-back cannot be proved; no command may route. |

There is no `LEGACY`, `QUIESCING`, `LEGACY_SEALED`, `SEMANTIC_STAGED`, or dual-route state.

Fresh bootstrap is idempotent and bounded: admission inventories the configured Host-owned root and requires an explicit operator disposition receipt for discovered legacy continuity artifacts; under the partition mutex it persists a canonical bootstrap intent; a bounded SQLite transaction creates only the production-only schema and empty canonical records; reopen/read-back then atomically activates `ACTIVE/SEMANTIC`. A crash before activation leaves commands unroutable. Only the same byte-identical bootstrap identity/payload may continue; inconsistent partial state is quarantined. Bootstrap neither creates a Chat nor projects a legacy transcript, profile, ledger, or Pi session.

`main.ts` and `dialogue-web-main.ts` remain separate OS processes and must not share an in-memory authority instance. Both consume one Host-owned, versioned deployment manifest with canonical absolute `runtimeRoot`, exact authenticated `{continuityId, companionId, playerId}`, stable manifest-bound `bootstrapOperationId`, `authorityGeneration`, and required topology literal:

```text
schemaVersion: 2
topology: independent_chat_and_game_surfaces
```

No browser, model, integration, or Tavern input can provide or override those fields. Each entrypoint owns a separate SQLite connection, mutex broker/partition adapter, and semantic-authority instance for the same durable partition, with entry-owned startup failure and teardown. The Host construction zone projects only narrow independent Chat or Game facades; neither entry consumer receives raw store, path/ID, broker, provisioner, mutex, permit, binding token, or authority-construction callback.

## 4. Production boundary and independent surface lifecycle

The production artifact and source graph must be cleanly split from tests. Production builds start from an empty output directory, emit only approved production roots/dependencies, copy only allowlisted runtime resources after reparse validation, and verify an inventory/hash manifest. Test outputs are distinct. The production import gate runs from actual entry roots plus the named composition root, rejects unresolved/dynamic ingress, test support, fixtures, orphaned output, legacy authority/adoption/fallback reachability, and production imports of legacy `continuity.ts`, `game-surface-lease.ts`, legacy recovery/origin modules, `continuity-production-migration/`, `adoptLegacyPartition`, or legacy transition helpers. This source-graph rule is an engineering gate, not a claim against arbitrary hostile same-process code.

Production physical-signature admission validates the fixed Host schema and exact approved tables, columns/order/types/defaults/keys/checks/indexes/receipts; it rejects unknown tables/views/triggers, partial indexes, integrity/foreign-key failure, and materialization inconsistency. The production schema and reachable production graph contain no legacy snapshot/adoption fields, `adopted` state, schema-upgrade path, `GameOrigin`, Chat-return mapping, or Chat/Game handoff state.

Chat lifecycle is independently materialized from exact Chat records and its own Host-owned runtime facts. It may not use Game session/lease status as lifecycle authority. Game lifecycle is independently materialized from the exact manifest principal, Game session, world, binding digest, exact owner tuple, revision/fence, deadline, and its own receipt-backed runtime facts. It may not use a Chat thread/session/selection/origin as lifecycle authority. The two surfaces may be active concurrently; their only shared continuity effect is access to their separately governed long-term Memory partition.

Close is entry-owned and ordered. Dialogue stops HTTP/SSE acceptance and drains its Chat controller, presentation, lifecycle work, runtime, authority, adapter, and broker. Game Host stops Game requests, drains/terminalizes only Game work while Game authority and mutex remain live, then disposes its Game runtime, consumer, authority, adapter, and broker. Closing either process never removes/mutates the shared authority root or peer process connection, and never gates or mutates the peer surface.

## 5. Implementation dependencies and TDD slices

A slice is not a release gate. The destructive cutover is mounted after S0–S5 implementation and deterministic production-artifact evidence: actual entry roots consume the v2 deployment manifest, and the immutable artifact is entry-reachable-only. S6 independent-process evidence and S7 player/release gates remain separate blockers; an isolated foundation test or a build alone does not pass either.

| Slice | Dependencies and implementation boundary | Required TDD/evidence |
|---|---|---|
| S0 — inventory/disposition | Host-owned configured-root discovery and read-only explicit operator disposition; historical archives remain external. | Default/configured roots; unknown/mixed roots fail closed; no implicit deletion/import or content/credential read. |
| S0.5 — production artifact/graph | Fresh production/test outputs, allowlisted resources/inventory, one audited construction zone, and entry-reachable static production graph. | Stale/orphan output rejection; no tests/fixtures/test-support/legacy helpers in production; reparse/unallowlisted resource failure; no dynamic, CommonJS, `node:module`/`createRequire`, bypassing, or legacy ingress. |
| S1 — fresh authority substrate | Fresh-only physical schema, topology schema v2 manifest validation, partition mutex, exact SQLite CAS, and durable abandoned-owner quarantine. | Bootstrap replay/conflict/read-back; legacy/test-only/unknown/partial root rejection without mutation; topology/principal/generation mismatch rejection; no legacy file access. |
| S2 — role-bound composition | Separate per-process connection/authority/broker ownership from one v2 manifest, with narrow Chat and Game facades and reverse teardown. | No file-probe/fallback role selection; close/drain; construction-zone isolation; no production legacy imports. |
| S3 — independent Chat lifecycle | Chat-only durable lifecycle/runtime materialization and archive CAS. It does not create a Game dependency, origin, suspension, handoff, or return behavior. | Exact Chat CAS/replay/conflict; crash/reopen/materialization; no Game mutation from any Chat operation; durable read-back. |
| S4 — independent Game lifecycle/lease | Fresh-only Game state machine for `prepare enter → unlocked effect → commit/fail/recovery` and `prepare close → unlocked disposal → commit/fail/recovery`. Every persisted Game intent validates canonical request/payload digest, manifest principal, Game session, world, binding digest, exact owner tuple, revision/fence/deadline, permit, receipt, and transition-local committed vector. A terminal history row is non-live; only a unique live Game chain tip owns a Game session/lease. Recovery terminalization requires module-owned exact prior-owner-proven-dead evidence. A successful physical close receipt remains in the owning facade until its exact durable commit succeeds; a crash in `close_pending` is explicitly recoverable only after durable exact-owner death verification, without re-running teardown or fabricating its lost receipt. No Game state, request, receipt, validator, or facade reads/writes Chat selection/thread/session/origin/suspension/return. | Fresh-only schema generation rejects older/malformed/cross-state roots byte-preserving; operation replay/conflict and vector CAS; world/binding/owner/deadline/fence/receipt validation; one live Game lease; receipt-less `effect_failed → recovery_required`; explicit owner-dead recovery including `close_pending`; effect-unlocked contender; close drain; direct assertions that enter/close/recovery leave active or inactive Chat unchanged. |
| S4b — Host-TCB runtime binding | Host TCB prepares a receipt-backed adapter, derives adapter-owned world scope, proves exact Windows process-owner identity, and mints a one-shot opaque binding owning launch/revoke/close. | Identity/world drift, missing owner proof, forged capability, injection, double close, and launch failure fail closed with reverse closure. |
| S4c — unmounted Game materialization | A private construction-zone effect port consumes S4b binding and executes `prepare → unlocked materialize/dispose → terminal commit/fail`; it remains non-entrypoint-reachable. | One-shot/close-drain; permit/receipt equality; no effect under mutex; Game-only enter/close/recovery; no public constructor or Chat-origin/return ingress. |
| S5 — destructive enforcement | Remove production legacy authority reachability only after S0.5–S4 replacement coverage exists. | Clean-artifact denylist; no fallback/dual-read/dual-write/read-repair; physical persistence/reopen between prepare/effect/commit. |
| S6 — cross-process evidence | Independently launched Dialogue and Game processes use short mutex sections; Game effects and Chat content I/O are unlocked. | Independent-process admission/catalog serialization, abandoned-owner durable quarantine visibility, Game contender/reopen/retry/read-back, and proof that peer-surface lifecycle state remains unchanged. Same-process mocks/manual process killing are insufficient. |
| S7 — player/release gates | Only after S0–S6 mount and compatible Tavern contracts. | Browser auth/CSRF, accessible state, failure journeys, controlled Tavern live run, and separate Game/live evidence. Foundation passage alone releases neither surface. |

## 6. Relationship to Tavern, Memory, and release status

### Consumer dependency passage

Downstream plans consume this foundation only through a re-runnable `S6` + production-entry evidence record identifying the immutable artifact/manifest generation, result (`passed` | `failed` | `blocked` | `inconclusive`), and durable read-back. A passing record establishes only these facts for consumers:

- a manifest-bound independent Chat facade and independent Game facade may coexist for one partition without peer-surface lifecycle mutation;
- the admitted Game facade has a receipt-backed binding, post-commit lease state, and entry-owned shutdown boundary;
- no legacy continuity authority is reachable from the admitted production entrypoints.

Consumers do not receive the store, path, mutex broker, owner proof, recovery permit, or lifecycle mutation capability. Their provider, Memory, STOP, presentation, body, or harness evidence cannot substitute for this record; conversely this record does not pass any downstream live or experience gate.

[`29_TAVERN_CHAT_LIFECYCLE_V1.md`](29_TAVERN_CHAT_LIFECYCLE_V1.md) remains the Chat lifecycle contract. [`28_TAVERN_MANAGEMENT_CAPABILITY_MATRIX.md`](28_TAVERN_MANAGEMENT_CAPABILITY_MATRIX.md) remains the release matrix. This document is the sole owner of S0–S6 Continuity authority semantics, implementation, and cross-process/production-entry evidence. [`32_PLAYER_MANAGED_INTERACTION_MEMORY_IMPLEMENTATION_PLAN.md`](32_PLAYER_MANAGED_INTERACTION_MEMORY_IMPLEMENTATION_PLAN.md) consumes its S6/production-entry passage as a dependency and solely owns the Memory-specific Game Operational Gate: independent Chat/Game provider invocations, `m[1]` materialization visibility, Game bridge/receipt priority, and foreign-Continuity evidence. Tavern and Historian evidence remains separately scoped there; `MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED` remains `false` and no evidence here promotes it.

[`34_REALTIME_COMPANION_COORDINATION_AND_LIVE_RUN_DESIGN.md`](34_REALTIME_COMPANION_COORDINATION_AND_LIVE_RUN_DESIGN.md) and [`35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md`](35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md) consume only narrow independent Game runtime facts through production composition. Their STOP epoch, execution-correlation ledger, presentation/body traces, Farmhand harness, and Preview/live verdicts neither implement nor prove this authority, and S6 evidence does not prove their companion-experience gate.

This plan preserves the destructive fresh/no-migration boundary. It claims the mounted S0–S5 engineering cutover only; it does not claim S6 cross-process evidence, live evidence, UI release, Tavern release, Game release, or companion-experience gate passage.
