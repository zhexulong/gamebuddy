# 29 Tavern Chat Lifecycle v1 Contract

> **Status:** proposed executable contract for TDD implementation. The separately selected current `selected_chat_management_v1` Host-only seam provides title metadata and Host-owned draft read/save/discard routes; separately selected `selected_chat_lifecycle_v1` owns the narrow active-list/archive seam. Neither seam constitutes this complete lifecycle, any lifecycle UI control, or release proof. The fresh semantic SQLite single authority under [`30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md`](30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md) is mounted in production entrypoints for the schema-v2 independent-surface foundation, but S6 cross-process evidence and every Tavern/UI/live release gate remain pending. This document declares no released route, legacy migration, UI control, or lifecycle test result beyond current seams. A mounted foundation is not a released feature.
>
> **Version:** `tavern-chat-lifecycle/v1`
>
> **Authority and relationship:** this is the versioned contract for the Chat lifecycle gap identified by [`26_TAVERN_FRONTEND_DESIGN_SPEC.md`](26_TAVERN_FRONTEND_DESIGN_SPEC.md) §8.2(5). It supplies the lifecycle detail required by the Chat row of [`28_TAVERN_MANAGEMENT_CAPABILITY_MATRIX.md`](28_TAVERN_MANAGEMENT_CAPABILITY_MATRIX.md) §§2 and 6; it does not change that matrix's audited `partial` status. It must be implemented as a separately selected management profile, not inferred from the currently selected narrow `selected_chat_management_v1` profile.

## 1. Scope and non-goals

This contract governs a player-visible **ChatThread** lifecycle within an already authoritative `CompanionContinuity`, including player-authored titles, metadata-only discovery, archive/trash state, and a private unsent composer draft.

It does not authorize:

- message editing, deletion, retry, swipe, branch, checkpoint, regeneration, transcript search, or transcript-derived titles;
- deletion of a ChatThread, transcript, draft record, Pi/Magic Context session, continuity, Companion, export, or audit evidence;
- arbitrary prompt, tool, Game-permission, provider, or runtime configuration;
- browser ownership of identities, scope, revisions, Game facts, or return targets.

`New Chat` remains a new `ChatThread` under the same `CompanionContinuity`; `New Companion` remains a separate Companion and continuity. This contract neither changes that model nor makes an archive/trash action a continuity reset.

## 2. Durable lifecycle model

### 2.1 Chat metadata

Every durable ChatThread has Host-controlled lifecycle metadata:

```ts
type ChatLifecycleState = "active" | "archived" | "trashed";

type ChatLifecycleMetadataV1 = Readonly<{
  schemaVersion: 1;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  companionId: string;
  continuityId: string;
  title: string | null;
  lifecycleState: ChatLifecycleState;
  /** Present only while trashed; exact durable state to which restore returns. */
  trashRestoreState: "active" | "archived" | null;
  /** Positive safe integer; initialized to 1 when lifecycle metadata is created. */
  managementRevision: number;
}>;
```

The opaque IDs bind the record to the exact existing ChatThread/surface and its Companion/continuity. They are protocol handles, not player-facing names. `managementRevision` is a positive safe integer, initialized to `1` when lifecycle metadata is created, and owned solely by lifecycle metadata. It is distinct from transcript/message revision, Pi session state, SSE generation, Game snapshot revision, and any artifact revision.

A management mutation must use `expectedManagementRevision`, atomically persist the complete next metadata record, read it back, and return the new player-safe projection only after read-back. A stale value fails closed with `management_revision_conflict`; it must not be retried against a newer record or applied to a different chat.

### 2.2 Only permitted state transitions

The state machine is closed. Its only transitions are:

| Current state | Player-confirmed operation | Next state |
|---|---|---|
| `active` | archive | `archived` |
| `archived` | restore | `active` |
| `active` | move to trash | `trashed` |
| `archived` | move to trash | `trashed` |
| `trashed` | restore | its exact persisted `trashRestoreState` (`active` or `archived`) |

No other transition is permitted. In particular:

- moving an active or archived chat to trash atomically records that exact prior state as `trashRestoreState`; `trashed` is reversible only to this persisted target, and restore clears it;
- an operation that would not change state is rejected as `lifecycle_state_unchanged`;
- an absent, malformed, scope-mismatched, or unrecognized lifecycle record fails closed;
- the Host never selects a "most recent" thread as a substitute for an exact target.

### 2.3 Retention is indefinite

There is **no** purge route, purge worker, TTL, retention timer, garbage collector, permanent-delete confirmation, automatic deletion, or hidden cleanup transition in v1. Neither archive nor trash may cause deletion or alteration of the ChatThread's transcript, durable selection/history, Context/Pi data, draft, or associated player-visible export eligibility.

A product that needs permanent deletion or retention policy requires a later, separately versioned privacy and data-lifecycle decision. It must not be added as an implementation convenience to this contract.

## 3. Player-visible management behavior

### 3.1 Titles and truthful names

A title is optional, player-authored Chat metadata. A null title is rendered using a truthful localized neutral label such as “Untitled chat”; it is not replaced by a model-generated, transcript-derived, guessed, or internal-ID-derived name.

The Host validates and normalizes a submitted title under a declared v1 schema before persistence. A successful rename returns the persisted player-visible title and new `managementRevision`. Rename and lifecycle operations use the same independent `managementRevision` CAS; neither uses transcript revision or timestamps. It never reads, summarizes, classifies, or derives a title from message text. Internal `chatThreadId`, `chatSurfaceSessionId`, `companionId`, `continuityId`, filesystem names, hashes, revisions, and Pi session IDs must not be presented as a chat name.

A player-visible **character/companion name** and a player-visible **player/persona name** remain distinct from a ChatThread title. Export headers and chat labels must use the actual selected player-readable names from their authoritative profile bindings; they must not relabel the player as the Companion, treat a title as either identity, or invent a name when the applicable binding has none.

### 3.2 Metadata-only list and search

List and search operate only on the lifecycle metadata allowed by this contract: the player-visible title, lifecycle state, and safe ordering/paging metadata. They must not inspect, tokenize, embed, match, rank, leak, or return transcript text, message text, draft text, Pi/Magic Context content, prompt/context material, provider data, Game receipts, or opaque internal handles.

The v1 title query is a Unicode NFC-normalized, locale-independent case-insensitive literal substring match against the player-visible title only. An empty query is list-without-filter. A null title does not match a non-empty query. The Host performs the comparison; the browser must not receive extra content in order to search locally.

List/search requires an explicit state view (`active`, `archived`, or `trashed`) and returns an empty list when that state has no matches. It does not silently blend hidden archived/trashed chats into an active-history result. The public service projects only safe player-readable fields. A separately typed Host-internal list/search result carries the exact opaque `(chatThreadId, chatSurfaceSessionId)` binding for an authorized route adapter; that binding is never part of the public service DTO.

### 3.3 Confirmation and exact target binding

Archive, move-to-trash, restore, and rename are mutations. The browser must show the player the action and the target's player-readable title/state before submission. The Host still treats all browser labels and target claims as untrusted.

Each mutation request binds exactly one `chatThreadId`, its `chatSurfaceSessionId`, the caller's authoritative Companion/continuity scope, and `expectedManagementRevision`. The Host resolves and revalidates the binding before mutation. A confirmation for Chat A cannot affect Chat B due to delayed UI, stale list data, forged handles, changed active selection, or a browser race.

## 4. Independent management revision

`managementRevision` protects only lifecycle metadata. A message append, response, SSE reconnect, Game transition, transcript persistence, World Info lock, or runtime restart must not silently invalidate or advance it. Conversely, a title/lifecycle mutation must not rewrite a transcript, message sequence, Context/Pi session, or Game state.

The implementation may store metadata with the ChatThread only if it preserves this logical independence. It must not reuse `updatedAtMs`, transcript revision, message count, or a timestamp with collision-prone semantics as `managementRevision`.

Concurrent title and lifecycle writes serialize on the exact metadata record. A successful mutation advances `managementRevision` by exactly one. The local metadata store provides this per-record serialization. A future management operation that reads independently owned exact active-Chat selection before mutation additionally requires a Host-owned `withExactThreadManagementLock` atomic guard adapter spanning that read/guard/mutate interval. No management operation reads or depends on Game lifecycle, origin, or return state, and the existing archive/title/draft operations gain no Game-derived precondition. This contract defines the optional Chat-owned guard adapter but does not claim that the lifecycle domain itself serializes active selection. Failed validation, failed confirmation, stale revision, scope mismatch, or failed durable read-back advances neither lifecycle state nor revision.

## 5. Host-owned draft contract

A draft is transient unsent composer text, not a message and not a ChatThread title.

1. The Host, not the browser, owns durable draft state and revisioning.
2. A draft is scoped to the exact `(chatThreadId, chatSurfaceSessionId, companionId, continuityId)` tuple. Every read, save, discard, chat switch, and archive/trash operation revalidates that exact scope.
3. Draft text is never appended to the transcript, supplied to the model, injected into Magic Context/Pi, included in exports, emitted in SSE/bootstrap payloads beyond the authorized exact-draft read, indexed by search, or used to create a title.
4. Saving and discarding use a draft-specific optimistic revision and atomic write/read-back. A stale or mismatched scope fails closed and does not merge text.
5. A send failure **before durable message acceptance** retains the draft. After player-message acceptance is durable, the same Tavern content transaction/reconciliation protocol may clear only that exact draft; a later provider/generation/presentation failure does not resurrect the accepted text as a draft and must not clear another ChatThread's draft.
6. Switching chats, archive, trash, restore, reconnect, browser Back, and Host restart do not silently discard a draft. Apart from the exact successful-send clear defined above, explicit discard is the only v1 player operation that clears it.
7. Draft text is private player content. It must not appear in diagnostics, telemetry, evidence, logs, title-search results, browser storage, or any projection not specifically authorized to return the exact scoped draft to its authenticated owner.

The separately selected current `selected_chat_management_v1` profile provides only title metadata and Host-owned draft read/save/discard routes. Separately selected `selected_chat_lifecycle_v1` owns the narrow Host-only active-list/archive seam. Neither profile provides this complete lifecycle or its UI/release proof, and neither explicitly selects trash, restore, search, or this complete lifecycle profile.

### 5.1 Current cross-process release boundary

The current archive implementation is a **Host-only archive seam**, not release-level proof of this lifecycle's cross-process semantics. Its path-lock has a stale-reclaim read/compare/remove gap without atomic CAS reclaim; its advisory filesystem ownership, local PID liveness observation, timeout behavior, and malformed-owner fail-closed behavior retain D-class limitations. It may not promote candidate-only or UI archive/trash/restore controls.

The required Stage 1 foundation is limited to coordinator, semantic continuity state, active selection, and Game lease—not drafts, transcripts, or Tavern artifacts. It must use typed semantic-store commands with durable intents and fencing, rather than hold a database transaction or lock across asynchronous callbacks. The schema-v2 fresh authority has been destructively mounted for independent Chat and Game surfaces; the remaining required evidence is cross-process/Windows recovery and the appropriate Tavern/Game live gates. A Windows named-mutex broker and SQLite semantic store are Windows-only foundations; this contract makes no cross-platform support claim. Production remains unreleased: no legacy compatibility/import/adoption/ACL seal/`LEGACY` route/dual read-write/fallback/read-repair is permitted. The fresh bootstrap, no-dual-write/no-fallback/no-mixed-runtime boundary, real Windows evidence, and independent-surface lifecycle rules are normative in [`30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md`](30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md).

## 6. Chat and Game lifecycle isolation

Chat and Game are independent concurrent surfaces, not two phases of one session. A same-Continuity partition may have one active Chat and one active Game, but neither lifecycle records, selects, suspends, resumes, closes, restores, or derives an origin/return target for the other. Their only shared candidate data is governed long-term Interaction Memory as defined by [`32_PLAYER_MANAGED_INTERACTION_MEMORY_IMPLEMENTATION_PLAN.md`](32_PLAYER_MANAGED_INTERACTION_MEMORY_IMPLEMENTATION_PLAN.md); raw transcript, draft, Pi session, Live World, capabilities, receipts, and action state remain surface-local.

This supersedes the retired Chat → Game → Chat return-origin model and any BDD/matrix clauses that require it. It does not make either surface released: the independent Chat/Game provider, bridge, receipt, and cross-process evidence remains separately required.

## 7. Authentication, scope, and CSRF invariants

All reads require the authenticated loopback session. All mutations—rename, archive, move to trash, restore, draft save, and draft discard—require the authenticated loopback session **and** the Host's CSRF protection. Missing, expired, replayed, malformed, foreign-origin, or mismatched credentials fail before any state read that could disclose protected content and before any mutation.

For every operation, the Host must independently validate:

- exact request schema and opaque-handle format;
- authenticated player ownership;
- `companionId` and `continuityId` scope;
- exact `chatThreadId` ↔ `chatSurfaceSessionId` binding;
- applicable expected management or draft revision;
- state-transition legality, where applicable; and
- durable atomic persistence and read-back before success projection.

The browser cannot grant scope, elevate access by submitting a title or state, or use an old authorized handle outside its original Companion/continuity. Error categories are player-safe and must not disclose transcript content, drafts, secrets, filesystem paths, runtime/Pi IDs, hashes, raw provider errors, or Game facts.

## 8. Required TDD evidence before UI exposure

This contract is implemented only when contract tests cover at least:

1. every permitted transition and every forbidden transition, including archive/trash of active and archived chats and restore to the recorded prior state;
2. absence of purge/TTL/permanent-delete routes or background transitions;
3. independent monotonic management revisions, stale-write rejection, atomic read-back, and no transcript-revision coupling;
4. title validation, truthful fallback naming, and metadata-only title search proving that transcript/draft content cannot match or be returned;
5. exact-target confirmation races and cross-player/companion/continuity/surface rejection;
6. Host-owned draft privacy, exact scope binding, conflict behavior, retained failure behavior, and no export/SSE/search/model/Context leakage;
7. independent Game enter/close/recovery leaves the peer Chat lifecycle, selection, transcript, draft, and runtime untouched; tests reject Chat-origin, return-target, latest-chat fallback, and implicit Chat resume/close ingress; and
8. session/auth/CSRF rejection for each route, including no-write/no-disclosure assertions; and
9. before archive/trash/restore can leave the Host-only seam, every fresh-authority command/mount lane in [`30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md`](30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md): fresh-store provision; exact Chat select/open; independent Game enter/close/recovery/lease; archive lifecycle CAS; static no-legacy-production-import enforcement; real independent child-process contention/one-winner/stale-contender tests; Windows-runner mutex death-release tests; and durable intent/fence recovery/read-back/reopen evidence. No Chat-only mount, legacy compatibility/import, dual-write, dual-read, fallback, read-repair, or mixed runtime version can satisfy this condition.

Browser regression owns the player confirmation, accessible state labels, draft-preserving navigation, and error/recovery journeys. Host contract tests own authorization, schemas, scopes, persistence, privacy, and failure atomicity. This allocation follows [`27_TAVERN_TEST_ENGINEERING_STANDARD.md`](27_TAVERN_TEST_ENGINEERING_STANDARD.md) §§2–5. Cross-layer release-critical examples remain in [`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md); any historical Chat → Game → origin-Chat return example is retired and cannot serve as evidence for the independent-surface contract. This document does not claim those BDD or live gates have passed.

Before any control is shown, the selected management profile must declare the versioned artifact schema, route, safe projection, CSRF/fail-closed test, browser regression, and durable observable postcondition, as required by `28` §6. Unsupported lifecycle controls remain absent rather than disabled or simulated.
