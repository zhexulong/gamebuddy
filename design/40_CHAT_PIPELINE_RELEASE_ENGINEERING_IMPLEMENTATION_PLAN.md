# 40 Chat Pipeline Release Engineering Implementation Plan

> **Status: Retired as execution authority.** This document records the former evidence-first pipeline, including its completed bounded slices. Its phase gates and final release predicate must not block current Chat/Memory work. `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md` is the current execution authority and retains ordinary application reliability without marker/nonce/receipt/attestation/fresh-root proof gates.
>
> **Historical status:** proposed implementation authority for the production browser ↔ Host ↔ Tavern Chat ↔ Pi/Magic Context ↔ explicit presentation pipeline. No phase or route in this document is released merely because it is specified here. The current production entry remains **not release-grade** until the phase gates and final release predicate pass.
>
> **Decision requested:** approve the authority model, `tavern_browser_api/v1` contract direction, data-flow invariants, phase order, independently releasable Chat Core checkpoint, and mandatory Tavern-management completion boundary defined below.
>
> **Scope:** Chat surface only, including production static UI delivery, authenticated browser API, exact Chat startup/resume and multi-Chat lifecycle, draft/send/stop/reconnect, Companion and Tavern-artifact management, connection/model management, durable transcript/turn state, Pi/provider invocation, Magic Context stable source/Memory consumption and player-visible management, explicit companion presentation, player-safe projection, and Chat/Tavern release evidence. `chat_core_v1` is an independently releasable intermediate milestone; it is not completion of this plan. This plan continues through the approved `design/28` Tavern-management lifecycle and clean-root player journey. Game is referenced only for independent-surface isolation, shared long-term Memory boundaries and explicitly approved read-only projection; Game workflow/control remains out of scope.

---

## 1. Why this plan exists

The repository currently has four partially overlapping descriptions of the Chat product:

1. Tavern domain and lifecycle services under `host/src/tavern/**`;
2. route declarations under several `selected-*.v1.ts` files;
3. a narrow production `host/src/dialogue-web.ts` mount;
4. a broad React application whose Playwright tests mostly use mocked routes.

Those surfaces disagree. Examples include:

- React calls `/refresh`, `/stop`, `/chat-draft`, `/library`, `/open-chat`, `/new-chat`, World Info and management routes that the production server does not mount;
- the Host bootstrap and React `Bootstrap` type have incompatible required fields and different Memory capability semantics;
- the current production server returns an empty transcript and publishes presentation text directly to SSE instead of first committing it to the exact Tavern conversation;
- `selected_l3_v1` calls itself runtime authority but does not currently drive the production mount;
- the production Host does not serve the Vite application it claims is ready.

This is not solved by choosing the larger frontend DTO or the smaller current Host DTO. Both are incomplete implementations. The solution is a contract-first production pipeline whose browser projection is derived from the established domain owners and whose mounted profile is the only current capability authority.

### 1.1 Quality-audit dispositions owned by this plan

`design/review/CODEBASE_QUALITY_AND_ARCHITECTURE_AUDIT.md` is an input, not a replacement architecture authority. This plan accepts two concrete Chat Core findings, frozen in `design/67_CHAT_CORE_REFERENCE_PIPELINE_AUDIT_REMEDIATION.md`:

1. the P3 browser decoder must validate the required P3 projection it renders without rejecting compatible additive safe snapshot data it does not consume;
2. `ChatThreadStore` must have explicit, write-before-read artifact budgets and a bounded transcript envelope, rather than becoming unreadable through the generic strict JSON reader's 64 KiB default ceiling;
3. because every Chat durable mutation uses shared `path-lock`, its malformed/zero-byte crash residue requires the Windows handle-bound recovery primitive plus native trusted-root/liveness closure in `design/70` and `design/72`; path-based identity check then `rm`, leaf-only no-follow, or Host-only owner-dead proof is not an acceptable stale-only recovery rule.

`design/68_CHAT_CORE_ARCHITECTURE_AND_DIGEST_GOVERNANCE.md` also freezes the related architecture/digest disposition: retain SHA-256 only for explicit artifact integrity, canonical source binding, runtime binding consistency and current opaque path partitioning; do not extend root-derived management IDs; defer their fresh-only P9 replacement and direct-file WorldBook adapter deletion to the management phase.

The plan does **not** accept an unscoped replacement of the one-owner P4 journal with a general SQLite/Saga rewrite or a broad continuity-semantic flattening. Those proposals have no demonstrated Chat Core correctness failure and would reopen accepted P4 authority boundaries. They require separate owner-preserving designs and evidence.

---

## 2. Frozen standards decision

### 2.1 Which side wins when frontend and backend disagree

Use two different decisions for two different questions:

1. **What should the product mean?**
   The owning design/domain contract wins. Existing React behavior and current transport code do not redefine product semantics.

2. **What is available and true in the running product now?**
   The actual mounted Host's versioned contract, safe projection, and durable read-back win. The browser may only consume and restrict that surface. It may not infer a missing field, operation, state, success, or fallback.

Therefore:

- the current frontend DTO is **not** the standard;
- the current narrow Host DTO is **not** the standard;
- Playwright fixtures are **not** the standard;
- Tavern domain contracts are semantic authorities but are **not** exposed directly as browser DTOs;
- the new Host-owned `tavern_browser_api/v1` contract is the browser wire standard and must be derived from safe domain projections.

### 2.2 Mandatory source of truth

Create `host/src/tavern/browser-contract/v1.ts` as the unique source of truth for:

- route IDs and exact methods/paths;
- strict request/response/event/problem schemas;
- `apiVersion: 1` discriminators;
- route authentication and CSRF requirements;
- operation/capability projection identifiers;
- contract fixture builders containing SFW synthetic content only.

`host/src/tavern/conversation-contract.ts`, named by `design/24`, may be the public barrel for this module. Do not create an OpenAPI file or another parallel registry in v1. TypeBox is already a Host dependency; use it for shared runtime schemas and TypeScript types rather than introducing a second schema library. The frontend may consume a browser-safe workspace package or generated declaration/data artifact derived from this owner; it must not import Host runtime/domain code.

The contract must drive or be statically checked against all four consumers:

```text
composed mounted profile
  → Host route mount
  → bootstrap operations/navigation projection
  → frontend route client and control visibility
  → release prerequisite mapping
```

A route missing from the composed mounted profile is not registered and has no player control. A profile entry without a Host handler is a build failure. A frontend route reference absent from the contract is a type/build failure.

### 2.3 Standards basis

Adopt the patterns in [`research/release-grade-web-chat-pipeline-patterns.md`](research/release-grade-web-chat-pipeline-patterns.md):

- RFC 9110 resource/precondition semantics;
- RFC 9457 `application/problem+json`;
- WHATWG SSE event ID/reconnect primitives without exactly-once claims;
- a locally frozen and tested Idempotency-Key-style contract;
- durable ordering, snapshot reconciliation, privacy-safe structured evidence, and static asset/API release-tuple identity.

---

## 3. Ownership and non-duplication map

This plan owns **composition, browser wire protocol, transaction ordering across existing ports, production mount, and pipeline-level release selection**. It must not absorb the authorities it composes.

| Concern | Existing unique owner | This plan consumes | This plan must not create |
|---|---|---|---|
| Target Tavern product scope and audited capability matrix | `design/28_TAVERN_MANAGEMENT_CAPABILITY_MATRIX.md` | target profile and player-complete expectations | a second product feature matrix |
| Tavern artifacts, import semantics, ChatThread/message/opening model | `design/24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md`, `host/src/tavern/**` | typed domain ports and safe projections | a new Tavern schema/repository/importer |
| Chat title/lifecycle/draft semantics | `design/29_TAVERN_CHAT_LIFECYCLE_V1.md` | exact commands, revisions and projections | alternate transition or draft rules |
| Continuity, exact Chat lifecycle, independent Chat/Game authority | `design/30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md` | mounted Chat facade and S6 consumer record | a continuity DB, mutex, recovery or legacy route |
| Context/Memory semantics, SQLite, selection, `m[0]/m[1]`, mutation evidence | `design/04_CONTEXT_MEMORY.md`, `design/32_PLAYER_MANAGED_INTERACTION_MEMORY_IMPLEMENTATION_PLAN.md`, Magic Context fork | stable source and evidence-bound facade ports | a Host prompt assembler, Memory DB/filter/cursor, ordinary mutation fallback |
| Player information architecture, localization, responsive and a11y behavior | `design/26_TAVERN_FRONTEND_DESIGN_SPEC.md` | UI vocabulary/states and presentation rules | another visual/UX system |
| Test layering and evidence taxonomy | `design/27_TAVERN_TEST_ENGINEERING_STANDARD.md`, `design/33_TEST_ENGINEERING_AND_EVIDENCE_STANDARD.md` | risk IDs, suites and evidence classes | a replacement test strategy or evidence hierarchy |
| Legacy deletion, Memory single-mount, secure file/repository remediation and shared build-file integration | `design/39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md` | P2/P3/P5/P8 deliverables where applicable and serial integration ownership | compatibility wrappers, duplicate infrastructure or parallel writes to shared build/CI owners |

### 3.1 Capability status is cumulative, not an enum

Every capability is reported as independent facts:

```ts
type CapabilityClosure = Readonly<{
  target: boolean;
  implemented: boolean;
  mounted: boolean;
  released: boolean;
  blockedReasons: readonly string[];
}>;
```

Required implication:

```text
released ⇒ mounted ⇒ implemented
target-only = target && !implemented
```

`implemented` must never be described as player-available. Only `mounted` operations enter bootstrap. Only `released` operations enter release claims.

### 3.2 Independent surface correction

This plan follows `design/29` and `design/30`: Chat and Game are independent concurrent surfaces. No pipeline state contains `GameOrigin`, suspended Chat, return target, or automatic Chat restoration. A future UI navigation from Game information to Chat is presentation navigation, not an authority transition.

Before implementation begins, stale origin/return wording in `design/24`, `design/26`, `design/28`, affected BDD clauses, route manifests and UI copy must be corrected to this model without changing Game owners. In particular, Tavern-only stable sources are isolated by independent surface materialization; Game does not tombstone the concurrently live Chat session, and returning to a Chat view is not an authority restore.

---

## 4. Scoped release profile

### 4.1 Independently releasable milestone: Chat Core

`chat_core_v1` is intentionally narrower than the full `design/28` Tavern-management target. It closes one stable end-to-end pipeline before mounting every management service, and may be released as an intermediate product milestone, but reaching it does **not** complete this implementation plan.

`chat_core_v1` contains only:

1. production static shell and allowlisted assets;
2. one-time bootstrap and authenticated state refresh;
3. startup/restart of one exact already-authoritative active Chat; no browser Chat switch;
4. durable transcript and exact Host-owned draft;
5. durable/idempotent player submit and a recoverable single active turn;
6. Pi/provider invocation with exact Tavern stable context and Magic Context-owned governed long-term Memory materialization;
7. runtime-owned, turn-bound typed companion presentation admission;
8. durable companion commit and terminal turn state;
9. authenticated idempotent stop/cancel;
10. live SSE projection with same-process bounded replay and authoritative snapshot resynchronization after any gap/restart;
11. en/zh-CN, accessibility and responsive states for this slice.

Player-visible Memory management is not a Chat Core prerequisite, but it is mandatory for the final Tavern-management completion claim. Chat Core still requires the exact runtime to consume Magic Context-owned stable source and long-term Memory materialization without Host prompt assembly or a second store.

Chat Core does not silently create a Character or Chat, and it does not switch Chats while running. No-character and no-active-chat are valid truthful states. Its clean-root deterministic process/browser gate and live gate consume a separately reviewed, release-external `TavernLiveFixtureProvisioner`: it uses the canonical Tavern and Continuity owners to explicitly create a synthetic SFW Companion, exact Chat and active binding in a fresh GameBuddy-owned root, emits only a redacted fixture receipt/artifact digest, is excluded from production browser routes, and cannot prove New Companion/New Chat product capability. This fixture is acceptable only for the intermediate Chat Core claim.

### 4.1a Reference-pipeline engineering checkpoint

Before the full Chat Core release predicate, the implementation prioritizes one bounded player-realizable pipeline:

```text
fresh GameBuddy-owned root
  -> exact mounted Chat
  -> browser submit
  -> durable acceptance and one provider attempt
  -> durable typed companion presentation and terminal read-back
  -> authoritative browser state
  -> reload/restart recovery of that same result
```

`chat_core_reference_pipeline_v1 complete` is an engineering checkpoint, not a release claim. It requires P3.5, P4c, P5, the minimum state-delivery/recovery work from P7, and a fresh-root production journey on one immutable artifact. It may defer P9 Tavern-management capabilities and non-blocking SSE ergonomics only when they do not weaken the authoritative state/recovery proof. It may not defer security, provider-start uncertainty classification, durable presentation/terminalization, reload/restart recovery, or a directly relevant release blocker. `design/67_CHAT_CORE_REFERENCE_PIPELINE_AUDIT_REMEDIATION.md` owns its audit-remediation entry gate.

Every deferred capability must be recorded as a scoped follow-up issue with its owning phase/design and must remain absent from profile, UI, release claim, and reference-pipeline evidence. It cannot be silently left half-mounted.

### 4.2 Mandatory plan completion: Tavern management

After Chat Core is stable, this plan continues. The following independently closable capability slices are mandatory before the plan can be marked complete or the `tavern_management_v1` tier can be released:

- library/character detail, explicit New Companion and the approved Character lifecycle;
- exact Chat list/create/open/switch/title/draft/archive/trash/restore lifecycle;
- Persona/Scenario/Greeting selection and approved management lifecycle;
- World Info catalog/manage/bind and approved conflict/recovery lifecycle;
- candidate-first import/export/interchange;
- player-visible evidence-bound Memory read/mutation management;
- approved connection/provider/model/credential/test/activate lifecycle and player preferences;
- effect-aware response operation only if the final target taxonomy retains it and it has a real durable operation, not a guard-only receipt;
- read-only settings/Game facts only when their actual Host projection is mounted.

“Mandatory” means every in-scope `design/28` target row must either be fully released by this plan or be explicitly removed from the approved `tavern_management_v1` target in a reviewed taxonomy revision before implementation—not deferred silently, left fixture-only, or reported complete from a Host-only seam. Explicitly unsupported capabilities and Game workflow/control remain outside this plan.

The final management gate must start from a fresh GameBuddy-owned root and use only player-visible production routes to configure a connection/model, create the first Companion and Chat, select/bind approved artifacts, converse, recover/reopen, switch/manage Chats and exercise retention/export/Memory flows. It may receive an ephemeral real-provider credential through the same write-only player setup contract, but it may not use the `TavernLiveFixtureProvisioner`, operator-created Tavern state, mocked routes or hidden setup APIs.

### 4.3 Release claims and plan status

The only allowed claims are cumulative:

| Claim | Meaning | Does it complete this plan? |
|---|---|---|
| `chat_core_reference_pipeline_v1 complete` | One exact mounted Chat completes the bounded fresh-root send/provider/presentation/state/restart journey. This is an engineering checkpoint and has no release status. | **No** |
| `chat_core_v1 released` | One pre-existing exact Chat has release-grade send/context/presentation/stop/reconnect/restart behavior. Management may still be absent. | **No** |
| `tavern_management_v1 released` | Chat Core plus every approved in-scope `design/28` management lifecycle, including connection/model and player-visible Memory management, passes its production route/UI/evidence gates and clean-root player journey. | **Yes** |
| `player_complete_tavern_chat_v1 released` | Alias permitted only when `tavern_management_v1` is released and the final approved target mapping contains no unclosed in-scope must capability. It makes no Game workflow or unsupported advanced-feature claim. | **Yes** |

After `chat_core_v1` release, the truthful overall status remains: **Chat Core released; Tavern management implementation in progress; plan incomplete.**

### 4.4 Destructive profile decision

`selected_l3_v1` must stop claiming mounted/runtime authority. Rename or replace it as a target taxonomy only. The unique `ComposedTavernProfile` becomes the sole production mount/visibility authority and contains named approved capability slices plus an explicit `releaseTier` (`chat_core` or `tavern_management`).

The browser contract registry defines wire shapes, not capability availability. Release mapping references the composed mounted profile and tier. `design/24`, the release checker and fixtures must be updated in P0/P1 so no target-only manifest can be interpreted as mounted or released. There is exactly one route-shape registry and exactly one mounted capability composition.

---

## 5. Architecture and one-way authority graph

```text
deployment manifest + composed mounted profile + static asset manifest
  ↓ Host-owned construction
loopback HTTP/SSE transport (auth, CSRF, strict parse, problem mapping)
  ↓ typed browser command
ChatPipelineService
  ├─ exact Continuity Chat facade             [design/30 authority]
  ├─ Tavern conversation/lifecycle/draft      [design/24 + 29 authority]
  ├─ stable source + Memory facades            [Magic Context/design/32 authority]
  ├─ DialogueController/Pi runtime             [runtime execution]
  └─ typed presentation ingress                [player-visible expression]
  ↓ durable read-back + event append
player-safe snapshot/event projection
  ↓ HTTP/SSE
frontend reducer and UI
```

Arrows are one-way. The browser, SSE connection, model text, provider completion, frontend fixture, or current React state cannot publish authority back into the graph.

### 5.1 Required deep modules

#### `TavernBrowserContractV1`

Owns browser schemas and route registry only. It does not call services or store state.

#### `ComposedTavernProfile`

Consumes approved domain profile slices and produces one immutable mounted route/operation/navigation set. It can only restrict; browser input and environment strings cannot add operations.

#### `ChatPipelineService`

A narrow orchestration module that hides cross-port ordering for the already-mounted exact Chat. Chat Core interface:

```ts
type ChatPipelineService = Readonly<{
  readState(): Promise<TavernStateSnapshotV1>;
  readDraft(): Promise<BrowserDraftV1>;
  saveDraft(command: SaveDraftCommandV1): Promise<BrowserDraftV1>;
  discardDraft(command: DiscardDraftCommandV1): Promise<BrowserDraftV1>;
  submitMessage(command: SubmitMessageCommandV1): Promise<SubmitMessageResultV1>;
  readMessageSubmissionStatus(query: MessageSubmissionStatusQueryV1): Promise<MessageSubmissionStatusV1>;
  cancelTurn(command: CancelTurnCommandV1): Promise<CancelTurnResultV1>;
  close(): Promise<void>;
}>;
```

It must not expose stores, SQLite, paths, Pi sessions, source markers, continuity IDs, receipts, or raw provider data. It does not own exact Chat switching. Transport extracts cookies/headers and constructs typed commands; repositories never see HTTP headers. Every mounted Chat Core domain query/command route—excluding static assets, bootstrap/session establishment, SSE subscription transport and separately owned optional capability slices—maps to exactly one service operation. All draft mutations/status lookup execute exact authenticated scope, selection generation and repository read-back through this service; `dialogue-web.ts` cannot import any domain repository/store.

Route ownership is closed:

| Route family | Owner |
|---|---|
| static shell/assets | artifact/static server |
| bootstrap | browser-session/bootstrap composer, then `ChatPipelineService.readState()` |
| state/draft/messages/submission-status/cancel | `ChatPipelineService` |
| events | `LiveChatEventProjection` subscription transport |
| Memory management (unmounted at Chat Core; mandatory by Tavern management) | evidence-bound Magic Context facade |

#### `TurnLedgerV1`

A versioned record inside the existing `host/src/tavern/chat-thread-store.ts` journaled response transaction for one exact selected Chat. It extends, rather than competes with, `design/24`'s owner of player append, response preparation/commit/recovery and response-run terminal state. `chat-thread-store.ts` owns the only revision/CAS, journal, companion commit, terminal read-back and restart reconciler; `ChatPipelineService` calls one typed turn port and never coordinates a second store/repository. The record binds player-message acceptance, idempotency, provider attempt generation, runtime-owned presentation admission, cancellation arbitration, companion commit and terminal recovery. It is not Pi history or Continuity authority.

Frozen states:

```text
accepted_queued
  → attempt_starting
  → running
  → presentation_committed
  → completion_claimed
  → completed

accepted_queued | attempt_starting | running | presentation_committed
  → cancel_claimed
  → cancelled

accepted_queued | attempt_starting | running | presentation_committed | completion_claimed
  → failed
```

`completion_claimed` and `cancel_claimed` are mutually exclusive durable CAS winners. A presentation alone is visible content but is not terminal completion. If cancel wins after a presentation commit but before completion claim, the committed bubble remains historical and the turn terminalizes `cancelled`; late completion/presentation is rejected. If completion claim wins, cancel returns the existing completion-in-progress/final representation while runtime drain finishes; terminal `completed` is projected only after drain and read-back.

Restart policy is fail-closed and does not automatically prompt again:

- `accepted_queued` may start exactly one attempt only when the ledger proves no attempt generation was minted;
- ambiguous `attempt_starting` or `running` becomes `failed/interrupted` after exact runtime-owner death/reopen proof; it is never automatically re-prompted;
- `presentation_committed` without a winner is reconciled by the same arbitration rules; it is never silently completed;
- `completion_claimed` with committed presentation is read back/drained when provable, otherwise terminalizes `failed/interrupted`; no new provider attempt;
- `cancel_claimed` completes revocation/abort idempotently and terminalizes `cancelled`;
- the durable player message and any already committed presentation remain; retry is a future separate command/new idempotency key.

Every crash window has a typed record and process-reopen test. Player append, draft-clear prepared intent, turn transition, presentation commit and terminal state are journal phases/read-backs under this one owner. If a draft record remains physically separate, its mutation is referenced by the same stable Tavern journal mutation ID and reconciled by the existing owner-approved prepared protocol; no independent turn ledger repository is created.

#### `LiveChatEventProjection`

Chat Core does **not** create a standalone durable event database. SSE projects only state already committed and read back from owning repositories. It uses a per-process opaque `streamEpoch` and monotonic live sequence for dedupe and a bounded in-memory replay window within that epoch. Any gap, replay-window miss, subscriber uncertainty or Host restart emits `stream.resync_required` and closes; the browser fetches `/state`, atomically replaces its projection, then reconnects at the returned live cursor.

The snapshot is the recovery authority. Cross-process durable SSE replay is a later optimization only if a real need is demonstrated. It must then be transaction-local to the repository that owns each mutation or use an owner-approved prepared/reconciliation protocol; this plan forbids a parallel general event store and does not claim exactly-once event delivery.

#### Frontend `TavernApiClient` + reducer

The frontend imports browser contract types/data, owns transport mechanics and rendering only, and reduces authoritative snapshots/events. It must not define production DTOs in `main.tsx`.

---

## 6. `tavern_browser_api/v1`

### 6.1 Paths and versioning

- static shell: `GET /`
- static assets: `GET /assets/<allowlisted-hashed-name>`
- JSON/SSE API prefix: `/api/tavern/v1`
- every JSON request, response and SSE data envelope: `apiVersion: 1`
- incompatible required-field, enum, identity, auth, cursor or lifecycle semantics require `/v2`; v1 permits only compatible additive optional fields.

Legacy unversioned production routes are deleted after the new slice is mounted and tested. No forwarding aliases or dual mount remain.

### 6.2 Normative Chat Core route table

P1 implements this frozen contract; it does not choose route semantics ad hoc. Every body and response uses `Content-Type: application/json` except SSE/static assets. JSON bodies reject unknown keys, duplicate semantic fields, non-finite numbers and invalid UTF-8; default maximum JSON body is 64 KiB and player message/draft text is Unicode NFC, 1–16,384 UTF-8 bytes after normalization. Opaque handles/cursors are ASCII base64url without padding, 128-bit minimum entropy, 22–128 chars; the idempotency key is exactly 22 base64url chars representing 128 bits. All collections reject more than 500 transcript messages, 100 operations, 100 navigation items or 200 Memory summaries per response; larger durable resources use a future explicit page contract rather than truncation disguised as completeness. All success responses include `apiVersion: 1`; all failures use the problem schema in §6.11.

| Route | Auth / CSRF | Request contract | Success contract | Principal failures |
|---|---|---|---|---|
| `GET /` + allowlisted assets | none before bootstrap; exact static allowlist | no body/query except declared asset path | HTML `200 no-store`; hashed assets `200 immutable` | `404`; no SPA fallback for unknown dotted path |
| `POST /api/tavern/v1/bootstrap` | exact one-time fragment token, exact Origin; no cookie yet | `{ apiVersion: 1, bootstrapToken: string }`; body ≤4 KiB | `200 TavernStateSnapshotV1`; mints HttpOnly cookie and rotates CSRF | unauthorized/expired/replayed/origin failure |
| `GET /api/tavern/v1/state` | cookie + exact Origin; no CSRF | no body/query; optional `If-None-Match` | `200 TavernStateSnapshotV1` with strong opaque ETag, or `304` with same cache/security headers and no body | auth, reconciliation/storage unavailable |
| `GET /api/tavern/v1/draft` | cookie + exact Origin; no CSRF | no body/query | `200 { apiVersion, revision, text }` | auth, exact-scope unavailable |
| `PUT /api/tavern/v1/draft` | cookie + Origin + CSRF | `{ apiVersion, selectionGeneration, expectedRevision, text }` | `200 { apiVersion, revision, text }` after read-back | draft conflict, selection conflict, invalid body |
| `DELETE /api/tavern/v1/draft` | cookie + Origin + CSRF | `{ apiVersion, selectionGeneration, expectedRevision }` | `200 { apiVersion, revision, text: null }` after read-back | draft/selection conflict |
| `POST /api/tavern/v1/messages` | cookie + Origin + CSRF + `Idempotency-Key` | exact `SubmitMessageCommandV1`; text ≤16 KiB | `202 SubmitMessageResultV1`; same-key settled replay may return the same `202` representation with duplicate disposition | idempotency conflict/in-progress/expired, turn busy, draft/selection conflict |
| `POST /api/tavern/v1/message-submission-status` | cookie + exact Origin; read-only, no CSRF | `{ apiVersion, idempotencyKey, selectionGeneration }` | `200 MessageSubmissionStatusV1` | auth; foreign scope returns non-disclosing `unknown` |
| `POST /api/tavern/v1/turns/<turnHandle>/cancel` | cookie + Origin + CSRF + `Idempotency-Key` | `{ apiVersion, selectionGeneration }` | `200 CancelTurnResultV1` for the durable race winner/prior result | turn mismatch/terminal, idempotency conflict/in-progress/expired |
| `GET /api/tavern/v1/events?cursor=<opaque>` | cookie + exact Origin; no CSRF | one opaque query cursor; valid browser `Last-Event-ID` takes precedence on automatic reconnect under the rules below | `200 text/event-stream`; typed events below | auth as HTTP before stream; cursor uncertainty becomes in-stream resync event then close |

Frozen safe projection/response shapes (authored message text is never a localization key):

```ts
type LocalizedTextKeyV1 =
  | "tavern.nav.chat"
  | "tavern.nav.memory"
  | "tavern.operation.submit"
  | "tavern.operation.cancel"
  | "tavern.operation.draft.save"
  | "tavern.operation.draft.discard"
  | "tavern.operation.memory.read"
  | "tavern.operation.memory.mutate";

type BrowserMessageV1 = Readonly<{
  handle: string;
  role: "player" | "companion";
  text: string;
  locale: "en" | "zh-CN" | "und";
  order: number;
  revision: number;
}>;

type BrowserTurnV1 = Readonly<{
  handle: string;
  state: "queued" | "running" | "response_visible" | "stopping" | "completed" | "cancelled" | "failed";
  projectionRevision: number;
  canCancel: boolean;
  problemCode?: "interrupted" | "no_visible_presentation" | "runtime_unavailable" | "storage_unavailable";
}>;

type BrowserDraftV1 = Readonly<{ apiVersion: 1; revision: number; text: string | null }>;

type BrowserWorldInfoSelectionV1 = Readonly<{
  state: "none" | "selected" | "locked" | "unavailable";
  items: readonly Readonly<{ handle: string; title: string; summary: string | null }>[];
}>;

type BrowserMemoryStateV1 = Readonly<{
  readAvailable: boolean;
  mutationAvailable: boolean;
  revision: number | null;
  summaries: readonly Readonly<{ handle: string; title: string; pinned: boolean }>[];
  lastOutcome?: "committed" | "conflict" | "unavailable";
}>;

type TavernBrowserOperationV1 = Readonly<{
  operationId: "chat.submit" | "chat.cancel" | "draft.save" | "draft.discard" | "memory.read" | "memory.mutate";
  labelKey: LocalizedTextKeyV1;
  availability: "available" | "busy" | "unavailable";
  routeId: string;
}>;

type TavernNavigationItemV1 = Readonly<{
  itemId: "chat" | "memory";
  labelKey: LocalizedTextKeyV1;
  availability: "available" | "unavailable";
}>;

type SubmitMessageResultV1 = Readonly<{
  apiVersion: 1;
  disposition: "accepted" | "duplicate";
  message: BrowserMessageV1;
  turn: BrowserTurnV1;
}>;

type MessageSubmissionStatusV1 = Readonly<{
  apiVersion: 1;
  disposition: "unknown" | "pending" | "accepted" | "terminal" | "expired";
  committedResult?: SubmitMessageResultV1;
}>;

type CancelTurnResultV1 = Readonly<{
  apiVersion: 1;
  disposition: "cancelled" | "completion_won" | "already_terminal";
  turn: BrowserTurnV1;
}>;
```

`SubmitMessageCommandV1` is exactly `{ apiVersion: 1, selectionGeneration: positive safe integer, text: normalized bounded string, locale: "en" | "zh-CN", expectedDraftRevision?: nonnegative safe integer, memoryDelegation?: approved bounded enum }`. `GET /state` ETag binds the complete safe snapshot bytes and is never a mutation precondition. CSRF uses `X-GameBuddy-CSRF` and never appears in URL/body/logs.

SSE event type is exactly:

```ts
type BrowserEventV1 =
  | Readonly<{ apiVersion: 1; eventType: "message.committed"; epoch: string; sequence: number; selectionGeneration: number; payload: BrowserMessageV1 }>
  | Readonly<{ apiVersion: 1; eventType: "draft.changed"; epoch: string; sequence: number; selectionGeneration: number; payload: { revision: number; present: boolean } }>
  | Readonly<{ apiVersion: 1; eventType: "turn.state_changed"; epoch: string; sequence: number; selectionGeneration: number; payload: BrowserTurnV1 }>
  | Readonly<{ apiVersion: 1; eventType: "memory.changed"; epoch: string; sequence: number; selectionGeneration: number; payload: BrowserMemoryStateV1 }>
  | Readonly<{ apiVersion: 1; eventType: "stream.resync_required"; epoch: string; sequence: number; selectionGeneration: number; payload: { reason: "gap" | "epoch_changed" | "restart" | "ambiguous_cursor" } }>;
```

For domain events, SSE `id` is the opaque encoding of `(epoch, sequence)` and the `event:` line equals `eventType`. `stream.resync_required` has no reusable id, is flushed, and the server closes only after the write callback or a bounded 1-second deadline. Heartbeats are comments only. A selection-generation mismatch is never reduced into current state.

### 6.3 Static application contract

At Host startup:

1. load the production Vite manifest from an artifact-build-owned fixed path;
2. validate regular-file/no-reparse containment, exact allowlist, MIME type, size and SHA-256;
3. verify the browser contract/profile build identity expected by the Host artifact;
4. fail startup on missing, extra, stale, mismatched or source-map assets.

Serving rules:

- `/` returns the fixed HTML shell with `Cache-Control: no-store`;
- hashed assets may use `public, max-age=31536000, immutable`;
- API/SSE/problem responses use `no-store`;
- no directory listing, arbitrary SPA path fallback, runtime-root path, source map, dotfile or unmanifested asset;
- CSP permits only same-origin allowlisted assets and connections.

The Host production artifact builder must include and hash the frontend build. `pnpm build` producing two unrelated directories is not release composition.

### 6.4 Bootstrap and state

```text
POST /api/tavern/v1/bootstrap
GET  /api/tavern/v1/state
```

Bootstrap consumes a short-lived single-use fragment capability, mints an HttpOnly/SameSite browser session and CSRF token, and returns an authoritative snapshot. It does not create/select a Chat or infer latest content.

`TavernStateSnapshotV1` contains only safe projections:

```ts
type TavernStateSnapshotV1 = Readonly<{
  apiVersion: 1;
  build: { browserContract: "tavern_browser_api/v1"; profileId: string };
  csrfToken: string;
  browserSession: { expiresAtMs: number };
  operations: readonly TavernBrowserOperationV1[];
  navigation: readonly TavernNavigationItemV1[];
  selection: null | {
    chatHandle: string;
    generation: number;
    stateRevision: string;
  };
  chat: null | {
    companion: { name: string };
    title: string | null;
    transcript: readonly BrowserMessageV1[];
    draft: { revision: number; present: boolean };
    turn: BrowserTurnV1 | null;
    worldInfo: BrowserWorldInfoSelectionV1 | null;
  };
  memory: {
    readAvailable: boolean;
    mutationAvailable: boolean;
    projectionRevision: string | null;
  };
  eventStream: { epoch: string; cursor: string };
}>;
```

Opaque handles are scoped capabilities and are never rendered as names. Internal ChatThread/surface/continuity/Pi/Memory IDs and hashes stay server-side.

`GET /state` is the only authoritative full refresh. It is used after bootstrap, restart, stream gap and later selection change. It may support ETag, but 304 does not replace durable server validation. The HttpOnly cookie is the only browser-session credential; no session handle is returned or accepted in JSON.

### 6.5 Exact Chat selection — post-Core mandatory slice

Chat Core exposes no Chat list/switch route. It starts or reopens only the exact active binding materialized by the mounted `design/30` Chat facade. This avoids pretending the current one-shot `MountedChatRuntimeLease` can rebind. The final `tavern_management_v1` scope, however, requires list/create/exact-open/switch once that authority seam exists.

P9 must add:

```text
GET /api/tavern/v1/chats?state=active|archived|trashed
PUT /api/tavern/v1/selection
```

only after `design/30` owns and provides a narrow receipt-backed `MountedChatReplacementCapability` that exclusively implements selection prepare/commit/recovery and old/new runtime lease swap. Tavern content/stable-source I/O occurs outside the semantic mutex; the old lease remains valid until commit; commit success revokes it; crash/reopen deterministically chooses old, new or `recovery_required` from durable intent. Browser pipeline code never compensates or guesses.

The management-v1 switch rule is simple: any `accepted_queued`, `attempt_starting`, `running`, `presentation_committed`, `completion_claimed` or `cancel_claimed` turn makes selection mutation fail with `selection_busy`. Switch never auto-cancels; the player must explicitly cancel and await a durable terminal state. Failure preserves the old selection, transcript, draft, SSE state and visible UI. There is no latest, title/name matching, resume-or-create, legacy, or frontend fallback.

### 6.6 Draft

```text
GET    /api/tavern/v1/draft
PUT    /api/tavern/v1/draft
DELETE /api/tavern/v1/draft
```

Every operation is bound to the exact selected Chat and uses draft-specific CAS/read-back from `design/29`. `/state` reports only draft revision/presence; `GET /draft` is the sole response containing text. Draft text never enters transcript, SSE, model context, export, logs or evidence except that authenticated exact draft response. `design/29` must clarify that failure before durable message acceptance preserves the draft; successful durable acceptance may clear that exact draft even if the later provider attempt fails, and does not restore the old draft.

### 6.7 Player submit

```text
POST /api/tavern/v1/messages
Idempotency-Key: <browser-stable opaque key>
```

Request fields:

- `apiVersion`;
- `selectionGeneration`;
- player text and message locale;
- `expectedDraftRevision` when clearing a Host draft;
- optional explicit per-turn Memory delegation;
- the idempotency key is supplied once and retained across uncertain retries.

The key is 128 bits of browser-generated randomness encoded in a strict bounded format. Its durable scope is `(authenticated principal, route ID, exact chat binding, selection generation)`; cancel additionally binds the exact turn. The canonical fingerprint uses contract-owned deterministic JSON bytes and includes normalized text bytes, locale, exact draft revision and Memory delegation. The `chat-thread-store.ts` response transaction persists `pending | accepted | terminal`, fingerprint, exact message/turn association and prior safe result.

Same key/same payload returns the prior durable result. Same key/different payload, different route, Chat, generation or turn is `409 idempotency_conflict`. A concurrent same-key request returns `409 idempotency_in_progress` with bounded retry guidance. A known key whose retention expired returns `410 idempotency_expired`; it is never executed as a new command.

Before the first network write, the frontend stores the pending key and a non-content binding to the current selection/draft in `sessionStorage`. Page reload calls the authenticated non-mutating `POST /api/tavern/v1/message-submission-status` with `{ apiVersion: 1, idempotencyKey, selectionGeneration }` before allowing a new submit. The safe response disposition is exactly `unknown | pending | accepted | terminal | expired`, with `committedResult` only for accepted/terminal. `unknown` permits retry with the same key after exact Host draft read; `pending` forbids a new key; accepted/terminal reuse the prior result; expired never executes the old command and requires explicit player resubmission. The status route requires the authenticated cookie and exact Origin; it does not mutate and therefore does not require CSRF, and it discloses nothing for foreign principal/Chat/generation. Only durable terminal/read-back or explicit expired disposition clears browser bookkeeping. Browser storage remains retry bookkeeping, never acceptance authority.

Creation of `accepted_queued` performs a single exact-Chat CAS that also proves no non-terminal turn exists. The non-terminal set is `accepted_queued | attempt_starting | running | presentation_committed | completion_claimed | cancel_claimed`. A different key arriving while one exists returns stable `409 turn_busy` without appending a player message, clearing a draft, or creating an accepted idempotency record. A same-key retry returns its existing result before the busy check. Concurrent different keys have exactly one winner. An accepted response always returns the same durable projection. No success depends on frontend optimism.

### 6.8 Turn and cancel

```text
POST /api/tavern/v1/turns/<turnHandle>/cancel
Idempotency-Key: <browser-stable opaque key>
```

Browser-safe turn states are projections of `TurnLedgerV1`:

```text
queued | running | response_visible | stopping | completed | cancelled | failed
```

`response_visible` means a typed presentation committed but terminal arbitration/provider drain is incomplete. `completed` requires a committed presentation, a durable `completion_claimed` winner, provider drain and terminal read-back. `session.prompt()` resolution, `agent_end`, ordinary assistant text and provider acceptance are not completion.

Cancellation binds exact selection generation and exact turn handle. A durable `cancel_claimed` CAS/epoch linearizes before revocation and provider abort. If `completion_claimed` already won, cancel returns the existing response/terminal state. If cancel wins, all later presentation/completion admissions fail closed; an already committed response remains visible history while terminal state becomes `cancelled`. Repeating cancel returns the same durable projection.

### 6.9 SSE

```text
GET /api/tavern/v1/events?cursor=<opaque>
```

The query cursor is the cursor explicitly controlled by application JavaScript. On an initial connection without `Last-Event-ID`, it is the replay anchor. On native automatic reconnect, a valid `Last-Event-ID` takes precedence when both cursors resolve to the same live epoch and its sequence is greater than or equal to the original query sequence; the query may be older because EventSource reuses its original URL, but it may not point to the future. The server replays after the effective `Last-Event-ID`. Invalid cursors, epoch disagreement, `Last-Event-ID` regression/future sequence, replay-window miss or unprovable stream identity produce `stream.resync_required` and close.

The event stream emits only the exact `BrowserEventV1` union in §6.2: `message.committed`, `draft.changed`, `turn.state_changed`, `memory.changed`, and `stream.resync_required`. A companion presentation is `message.committed`; `response_visible`, stopping and every terminal state are `turn.state_changed`. There is no separate `presentation.committed`, `turn.changed` or `turn.terminal` wire event. Chat Core has no selection event; a future Chat-switch slice requires a new contract version unless this exact union is explicitly revised before release.

Rules:

- an event is emitted only after its owning durable record was read back;
- replay within the same live epoch may use the bounded in-memory window; this is not durable delivery;
- duplicate events are safe and frontend-deduplicated;
- generation mismatch is discarded;
- replay-window miss, epoch mismatch, ambiguous reconnect or Host restart yields `stream.resync_required`, then the server closes; the client disables automatic reconnect for that instance, fetches `/state`, atomically replaces state, and creates a new `EventSource` with the returned cursor;
- transport errors use bounded exponential backoff; auth/session expiry stops reconnect and enters explicit re-bootstrap UI rather than minting a session;
- real Chromium coverage must receive multiple events, force a TCP disconnect, observe native automatic reconnect with a newer `Last-Event-ID`, and prove same-epoch replay does not spuriously resync; separate cases prove epoch mismatch and replay-window miss do resync;
- comments/heartbeats may keep the connection alive but are not domain events;
- disconnect or subscriber replacement never cancels a turn, changes selection, creates a session, or deletes state.

### 6.10 Memory

Memory routes remain browser adapters over the evidence-bound Magic Context facade. The state snapshot reports `readAvailable` and `mutationAvailable` separately. When mutation is unavailable, mutation controls are absent and writes return a stable fail-closed problem if directly attempted.

A successful Memory write means only that the approved mutation committed and safe read-back succeeded. It does not claim the next provider invocation materialized it. Provider-bound next-round evidence remains owned by `design/32` and never enters the normal browser payload.

### 6.11 Problems

All API failures use `application/problem+json` with:

```ts
type TavernProblemV1 = Readonly<{
  type: string;
  title: string;
  status: number;
  code: string;
  requestId: string;
  retryable: boolean;
}>;
```

Initial stable codes include:

- `unauthorized`, `csrf_failed`, `invalid_request`, `unsupported_api_version`;
- `profile_operation_unavailable`, `selection_conflict`, `draft_conflict`;
- `idempotency_conflict`, `idempotency_in_progress`, `idempotency_expired`, `turn_busy`, `stream_resync_required`, `selection_busy`;
- `turn_not_active`, `turn_already_terminal`, `runtime_unavailable`;
- `presentation_unavailable`, `memory_mutation_pending`, `memory_mutation_unavailable`;
- `storage_unavailable`, `state_reconciliation_required`.

Internal exception text is never copied into a problem response.

---

## 7. Normative data flows

### 7.1 Startup and bootstrap

```text
immutable Host artifact
  → validate deployment manifest/profile/static asset manifest
  → mount fresh semantic Chat facade
  → exact reconcile active Chat binding, if one exists
  → resume exact Tavern conversation
  → publish stable Tavern source snapshot to exact Pi session
  → start loopback server
  → serve HTML/assets
  → consume one-time bootstrap capability
  → durable state read-back
  → return snapshot + cursor
  → connect SSE after cursor
```

Any mismatch fails startup or returns a safe blocked state. Bootstrap does not mutate product state.

### 7.2 Submit — durable before provider

```text
browser submit + stable Idempotency-Key
  → auth / Origin / CSRF / schema / bounds
  → exact selected generation and draft CAS validation
  → durable idempotency intent + player message append + exact draft clear
  → durable read-back
  → durable message/turn queued events
  → construct and hand the opaque HTTP 202 accepted representation to the response path
  → response reaches server-side `finish` (response `error` or premature `close` stops here)
  → acquire exact provider/Memory admission
  → canonical player envelope to Pi
  → running state/event
```

The player bubble is rendered only from the returned committed representation or committed event. The frontend never fabricates it.

Cross-store atomicity rule: if draft and transcript cannot be one native transaction, implement a typed prepared intent/reconciliation protocol owned by the Tavern content layer. The stable mutation ID binds idempotency record, player append and exact draft clear; recovery can only complete or expose one prior result. A crash may leave a recoverable prepared state, never a visible message with an uncleared contradictory draft or an accepted request with no durable outcome. Do not add a generic distributed-transaction framework.

Transport ordering rule: the service owns the continuation from durable acceptance/read-back through the response commit callback. Only the callback's server-side `finish` may permit the exact P4b claim/provider admission; the HTTP dispatcher does not receive a provider-start permit, raw turn/attempt/store authority, or a start API. A failed or prematurely closed 202 response leaves the durable turn `accepted_queued`; only a same-key retry that successfully finishes its 202 may race the one durable claim. Restart/status never starts it automatically.

Provider attempt rule: after durable acceptance, the `chat-thread-store.ts` turn transaction mints exactly one attempt generation. `accepted_queued` can start it; ambiguous `attempt_starting/running` after proven owner death becomes `failed/interrupted` and is never automatically prompted again. Every transition is read back before the next external effect.

### 7.3 Companion presentation — durable before visible

```text
Pi/provider turn
  → runtime-owned presentation admission mints opaque exact turn/attempt/cancel-epoch binding per invocation
  → typed companion_text callback
  → revalidate exact Chat, turn, attempt and cancel epoch immediately before commit
  → commit companion response to exact Tavern conversation
  → durable read-back + TurnLedger presentation_committed
  → SSE response_visible projection
  → provider settles/drains
  → completion_claimed CAS
  → durable terminal completed read-back
  → terminal SSE projection
```

A callback that cannot be durably committed is not published. Ordinary assistant output remains private.

### 7.4 Stop/cancel

```text
browser cancel exact turn
  → auth / Origin / CSRF / generation / idempotency
  → TurnLedger cancel_claimed CAS + epoch
  → revoke current-turn presentation/provider capabilities
  → provider abort/drain idempotently
  → durable terminal commit/read-back
  → terminal event + HTTP representation
```

Late callbacks observe the cancelled epoch and fail closed. Browser state changes only from the returned/read-back terminal projection.

### 7.5 Reconnect/restart

```text
SSE disconnect
  → no domain mutation
  → reconnect within same live epoch with cursor
  → bounded replay of already committed projections
  → on gap/epoch change/restart: stream.resync_required + close
  → GET /state
  → atomically replace frontend state
  → create new EventSource at returned cursor
```

After Host restart, the production entry consumes the same manifest generation, exact active Chat authority and durable Tavern records. It must not create a new Chat, guess latest, replay greeting, duplicate messages, or adopt legacy Dialogue state.

### 7.6 Exact Chat switch — later owner-provided flow

Chat Core has no switch command. After `MountedChatReplacementCapability` exists and the exact Chat has no non-terminal turn:

```text
save exact old draft/read-back
  → replacement capability prepares exact target and durable operation
  → unlocked exact Tavern conversation/stable-source/new-runtime construction
  → replacement capability commits new selection/generation
  → durable read-back
  → revoke old lease
  → return complete snapshot
  → old events rejected by generation
```

Crash recovery belongs to the replacement capability/`design/30`; browser code never chooses old/new. Failure before commit leaves the previous lease/snapshot untouched. `recovery_required` is explicit.

---

## 8. Global invariants

1. Fresh semantic SQLite remains the sole Continuity authority; no legacy/fallback/read-repair path returns.
2. Tavern repositories remain the sole Chat artifact/transcript/draft/lifecycle authorities; there is no unified Chat database.
3. Magic Context remains the sole stable-context and long-term Memory materialization/storage authority.
4. The mounted Host contract is the sole browser capability and current-fact authority.
5. The frontend never publishes capability, durable success, ordering, selection, completion or Memory facts.
6. A committed player bubble exists durably before provider invocation.
7. A committed companion bubble exists durably before SSE projection.
8. A completed turn has a correlated durable explicit presentation; provider settlement alone is insufficient.
9. Submit/cancel/presentation are linearized within one exact selection and turn generation.
10. Idempotency survives page reload and process restart for its declared retention window.
11. SSE is a live, duplicate-tolerant projection, never persistence or completion authority; Chat Core promises snapshot recovery, not cross-process event replay.
12. Snapshot + owning durable stores can reconstruct the whole UI without an SSE connection.
13. No latest/name/title/index/DOM/client timestamp fallback identifies a Chat or operation.
14. No Browser field supplies player/companion/continuity/Pi/path/provider/receipt authority.
15. Every mutation validates auth, scope, exact binding, expected revision/generation, operation legality and durable read-back.
16. All error, log, trace and evidence paths obey the privacy denylist.
17. Chat operations never select, suspend, close, restore or derive origin/return for Game.
18. An absent mounted operation is absent from UI; a direct request fails safely.
19. No compatibility alias, dual route family, dual DTO, dual read/write or migration fallback remains after cutover.
20. The browser asset hash, Host artifact hash, contract version and mounted profile identity are one release tuple.

---

## 9. Security, privacy and operational requirements

### 9.1 Browser boundary

Retain and test:

- exact `127.0.0.1` bind and exact Host/port validation;
- short-lived single-use bootstrap capability in the URL fragment, removed after use;
- HttpOnly, SameSite=Strict browser session cookie;
- exact Origin plus CSRF on every mutation;
- no CORS;
- strict JSON content type, body size, depth/key/schema and unknown-field rejection;
- session expiry and teardown;
- CSP, `nosniff`, no referrer and framing denial;
- API/SSE no-store.

The bootstrap POST itself must validate exact Origin. Browser session rotation and expiration must have explicit UI recovery; refresh may not mint a new authority from a missing cookie.

### 9.2 Bootstrap handoff protocol

The production launcher owns one exact private handoff. It creates a 256-bit random bootstrap capability with a 30-second deadline and single-use `issued → consumed | expired` state held only in Host memory. The Host passes an inherited anonymous pipe/read handle to the launcher-owned browser opener through OS handle inheritance; the handle value may appear only in the direct child environment long enough to open the inherited handle and is deleted before any unrelated runtime/provider process is created. The handoff payload is one bounded UTF-8 JSON record `{ origin, fragmentCapability, expiresAtMs }`; it contains no cookie or CSRF value. The launcher validates that the pipe peer is the exact child it created, writes once, closes both handles and never supports attach/replay.

The browser opener launches the managed/default browser with the fragment URL only after consuming the private record, then zeroizes/discards the record. The fragment never reaches HTTP request targets or Referer; bootstrap consumes it once, rotates to cookie+CSRF, and immediately removes it with `history.replaceState`. Browser-launch failure expires the capability and requires a fresh Host launch; the same capability is never retried. Host or launcher crash closes the pipe and invalidates memory-only state.

Forbidden carriers are stdout/stderr, command-line arguments, stable environment/config, temporary files, named/public pipes, Continuity/store, run manifest, telemetry, crash diagnostics, clipboard, browser local/session storage and IPC inspection output. Negative tests capture process output, argv, inherited environment after browser launch, temp roots, diagnostics and child-process inheritance. This handoff is not a browser API, session-minting fallback, stable identity or reconnect authority. Windows production implementation must use a current-user-only anonymous/inherited handle or an equivalently proven private launcher channel; token-only public named-pipe schemes are insufficient.

### 9.3 Privacy denylist

Do not emit to browser problems, ordinary logs, Playwright artifacts, run evidence or stdout:

- transcript or draft text;
- Persona/Scenario/Greeting/World Info/Memory content;
- system prompt or `m[0]/m[1]` bytes;
- provider request/response, reasoning or raw error;
- credentials, cookies, CSRF/bootstrap/control tokens, including the bootstrap URL fragment;
- Pi JSONL/session IDs, SQLite paths/IDs, filesystem paths;
- raw source markers, mutation correlations or receipts;
- Game capabilities, snapshot data or action receipts outside their separate approved projection.

Production browser responses necessarily contain the authenticated player's requested transcript/draft/safe artifact content; the denylist applies to diagnostics/evidence and unrelated projections, not the product response that explicitly owns that content.

### 9.4 Structured lifecycle telemetry

Telemetry may carry only opaque, scoped identifiers and categories:

```text
build/profile/contract identity
request/idempotency/message/turn/event opaque IDs
generation/cursor category
accepted/committed/projected/replayed/cancelled/failed/terminal transition
duration/count/error code
```

Hashing message content is not automatically safe evidence and is unnecessary unless a separately reviewed equality proof requires a bounded keyed digest.

### 9.5 Shutdown

Stop accepting new HTTP/SSE requests, close browser subscribers, stop queue admission, terminalize/reconcile owned Chat operations through the `chat-thread-store.ts` `TurnLedgerV1` transaction owner, revoke prompt/presentation capabilities, close the exact Pi runtime, then close Chat facade/broker in reverse construction order. Shutdown must not mutate Game lifecycle or shared authority root. The full bootstrap URL/token must never be written to stdout/stderr or ordinary logs; launcher-to-browser handoff follows §9.2, and process-output/carrier tests enforce the denylist.

---

## 10. Implementation phases

Every phase starts test-first for newly frozen behavior. Do not mount controls before their lower-layer contract and negative matrix pass.

### P0 — Baseline, contradiction cleanup and target profile freeze

**Work**

1. Record commit, tracked diff identity, allowed untracked sources, Node/pnpm/Chromium versions and current command results.
2. Inventory every frontend route, current Host route, selected profile route, domain service and test fixture.
3. Record cumulative `target/implemented/mounted/released/blockedReasons` facts for each capability.
4. Freeze `chat_core_v1`, the external Chat-Core-only live-fixture provisioner, the mandatory `tavern_management_v1` target mapping, and the distinction between intermediate release and plan completion.
5. Correct `design/24`, `design/26`, `design/28`, affected BDD/manifests/UI copy from Chat-origin/return to independent surfaces; add a production-contract denylist for origin/return/suspension fields.
6. Clarify `design/29` draft semantics: pre-acceptance failure retains draft; durable acceptance may clear it; provider failure does not resurrect it.
7. Make `selected_l3_v1` target-only and update `design/24`/checker ownership pointers to the unique composed mounted profile.
8. Freeze Chat Core decisions: no Chat switch, one active turn, fail-interrupted ambiguous restart, snapshot-based reconnect.
9. Mark historical “currently available” claims that are only service/UI fixture evidence as implemented but unmounted.

**Exit**

- one reviewed route/capability inventory;
- no ambiguity about target versus mounted profile;
- no implementation starts from generated output or unclassified WIP.

### P1 — Shared browser contract and composed profile

**Work**

1. Implement TypeBox `tavern_browser_api/v1` schemas, types, problem registry and safe fixture builders.
2. Implement the unique composed mounted profile from approved capability slices.
3. Make production route registration consume it.
4. Make bootstrap operations/navigation consume it.
5. Move frontend production types/routes out of `main.tsx` into the browser-safe contract consumer.
6. Add drift checks: profile-without-handler, handler-without-profile, UI route/control-without-operation, release-flow-without-route all fail.
7. Add static/contract checks that every mounted Chat Core domain query/command route maps to exactly one `ChatPipelineService` operation, route families match the closed owner table in §5.1, `dialogue-web.ts` imports no domain repository/store, and event emitters plus frontend reducer switches exactly match the `BrowserEventV1` union.
8. Delete unversioned duplicated DTOs/routes after the vertical slice uses v1.

**Exit**

- Host parser and frontend compile against one contract;
- bootstrap/Memory shape drift is impossible at type and contract-test level;
- selected profile actually controls production mount;
- no alias/fallback route family.

### P2 — Production static asset composition

**Ownership:** this plan owns the browser submanifest and static-serving contract. `design/30` S0.5 remains the single outer production-artifact closure owner. Shared builder/config/CI edits are integrated serially by the `design/39` integration owner; there is no second top-level manifest or release tuple.

**Work**

1. Build the Vite app into an immutable staging root consumed by the existing Host artifact builder.
2. Generate and validate one browser submanifest containing hashed HTML/assets and contract/profile identity.
3. Declare that submanifest/resources to the existing outer artifact closure.
4. Implement safe static serving and cache/CSP behavior.
5. Implement the frozen §9.2 inherited-handle launcher-to-browser handoff; do not invent another carrier.
6. Start the actual production artifact and prove `/` loads the shipped app without Vite.

**Exit**

- production URL is a usable UI, not an API-only endpoint;
- path traversal, extra/missing/stale/reparse/source-map assets fail closed;
- browser hashes/submanifest identity are bound by the single outer artifact manifest;
- stdout/stderr/log capture contains no bootstrap URL fragment or token.

### P3 — Exact snapshot/bootstrap vertical slice

**Dependencies:** P1–P2 and mounted Chat facade from `design/30`.

**Work**

1. Compose the exact active Chat content port; no latest or create fallback.
2. Read exact durable transcript, draft, current turn and safe source projections.
3. Implement `/bootstrap` and `/state` v1 snapshots.
4. Split Memory read/mutation availability.
5. Refactor frontend startup to render truthful no-character/no-chat/active-chat states solely from snapshot.

**Exit**

- production bootstrap renders exact durable state;
- refresh does not create/replay/guess;
- corrupt/missing/mismatched exact state is a safe blocked/problem state;
- browser has no required field not supplied by the contract;
- the P3 decoder validates its required rendered fields and contract identity but does not reject compatible additive safe fields solely because P3 does not render them.

### P3.5 — Audit-remediation capacity gate

**Dependency:** `design/67_CHAT_CORE_REFERENCE_PIPELINE_AUDIT_REMEDIATION.md`, `design/68_CHAT_CORE_ARCHITECTURE_AND_DIGEST_GOVERNANCE.md`, `design/70_CHAT_PIPELINE_P35_HANDLE_BOUND_LOCK_RECLAIM.md`, `design/72_CHAT_PIPELINE_P35_NATIVE_ROOT_AND_LIVENESS_CLOSURE.md`, and `design/73_CHAT_PIPELINE_P35_PUBLISHED_HELPER_PROVENANCE_AND_PUBLICATION_CLOSURE.md`. This gate is serially complete before P4c provider-start work; it does not reopen accepted P4a/P4b authority behavior.

**Work**

1. Preserve strict JSON stable-file, duplicate-key, UTF-8, and reparse protections while allowing the ChatThread owner to request a named finite artifact budget above the generic small-config default.
2. Freeze a store-level maximum of 500 total transcript entries, including an opening when present, and enforce the complete legal persisted-state budget before every append/accept/response journal mutation.
3. Align persisted opening/player/response text validation with the P4 NFC/control/UTF-8-byte constraints.
4. Reject malformed, over-count, or over-budget artifacts before any recovery repair write, and prove byte-for-byte no-repair behavior.
5. Repair `path-lock` malformed/zero-byte crash residue only through the fixed Windows handle-bound primitive: from the trusted drive-root HANDLE, every ancestor must be opened as a retained no-follow directory HANDLE; the leaf remains the same no-follow HANDLE across observation and disposition; native code revalidates a valid owner PID as dead immediately before disposition; reparse/mutation/path-substitution/unavailable-platform paths fail closed. No Chat caller may delete its own `.lock` file.
6. Keep the initial full P3 snapshot bounded to the same 500-total-entry envelope and a separately enforced finite response budget; the 64 KiB request-body limit does not apply to a complete bootstrap/state response. Larger history requires a separately versioned page/cursor contract, never silent truncation.

**Exit**

- a legal 500-total-entry thread, with or without an opening, and its prepared transaction reopen safely;
- a 501st total entry has a stable zero-mutation capacity failure;
- normal durable growth never crosses an implicit generic-reader cliff;
- an eligible malformed-lock crash residue is recovered only by the shared lock owner through the emitted Windows handle-bound helper, while fresh/valid/reparse/mutation/swap, published-helper provenance/publication races, and non-Windows paths remain fail closed;
- a larger transcript or bootstrap/state response cannot be silently truncated or treated as a complete snapshot.

### P4 — Durable submit, draft, idempotency and turn recovery substrate

**Work**

1. Characterize current thread/draft transaction and every pre-provider crash point.
2. Extend `chat-thread-store.ts`'s existing journaled response transaction with versioned `TurnLedgerV1` phases, one revision/CAS, attempt generation and one restart reconciler test-first; do not create a second repository.
3. Add minimal prepared/reconciliation record if transcript/draft native atomicity is unavailable.
4. Persist scoped idempotency fingerprint/`pending | accepted | terminal` result for the declared retention window.
5. Implement the frozen `message-submission-status` contract and browser pending-key reload reconciliation without making browser storage authoritative.
6. Implement durable player append + exact draft clear + `accepted_queued` read-back.
7. Only after commit mint one attempt generation and invoke `DialogueController`/Pi.
8. Remove optimistic player bubble and local success inference from React.
9. Before P4c calls Pi/provider, pass the P3.5 audit-remediation capacity gate and freeze the provider-start observation/reopen classification in its own card.

**Exit**

- retry after lost HTTP response, page reload, browser crash and Host restart returns one durable player message/result;
- key reuse with changed payload/scope fails and a known expired key never executes;
- concurrent different keys have exactly one accepted winner; losers return `turn_busy` without append/draft clear/idempotency acceptance;
- draft conflict causes no message acceptance;
- provider is never invoked before durable player commit;
- each crash boundary before/during attempt start has one deterministic reopen result;
- ambiguous started provider attempt becomes `failed/interrupted`, never an automatic duplicate prompt;
- no accepted command lacks a reconciliable durable outcome.

### P5 — Runtime-owned presentation admission, commit and terminalization

**Dependency:** the existing runtime/presentation composition owner must add an invocation-fresh, unforgeable admission binding `{turn, attemptGeneration, cancelEpoch}` and a narrow revalidation/commit callback. Assistant-message-level `sourceEventId` provenance is deferred as audit-only in `design/74_CHAT_PIPELINE_P5_SOURCE_LINEAGE_PREREQUISITE.md` and does not block P5. `ChatPipelineService` consumes this capability; it does not mint or expose the binding.

**Work**

1. Bind every prompt to an opaque exact turn/attempt generation.
2. Replace the global/fixed visible-presentation boolean with exact per-turn ledger read-back.
3. Revalidate typed presentation source, surface, turn, attempt and cancel epoch immediately before commit.
4. Commit response/read-back and `presentation_committed` before publishing `response_visible`.
5. Arbitrate `completion_claimed` versus `cancel_claimed`, drain provider and persist terminal outcome.
6. Classify provider settlement without a committed presentation as failed/no-visible-presentation.
7. Reject forged, replayed, late, duplicate and mismatched presentation admissions.
8. Exercise every presentation/settle/crash/reopen permutation.

**Exit**

- no ordinary Pi output or `agent_end` becomes a bubble/completion;
- durable response and terminal state survive restart;
- commit failure publishes neither bubble nor completion;
- each completed turn has an exact durable presentation binding to its turn/attempt/invocation/cancel authority; assistant-message-level provenance is not claimed.

### P6 — Stop/cancel linearization

**Work**

1. Add exact turn cancel route with durable idempotency.
2. Persist cancel intent/epoch before revocation and abort.
3. Reconcile completion-versus-cancel race deterministically.
4. Make frontend update only from returned/read-back terminal state.
5. Prove queued-turn cancellation and current-turn cancellation separately.

**Exit**

- repeat cancel is stable;
- cancel-first rejects late response;
- completion-first remains completed;
- browser/SSE disconnect never cancels;
- no queued/current turn capability survives terminalization.

### P7 — Live SSE and authoritative snapshot reconnect

**Work**

1. Project only state already committed/read back by owning repositories.
2. Implement per-process stream epoch, monotonic live sequence, bounded replay window and heartbeat.
3. Implement browser-realizable `stream.resync_required` event/close behavior for gap, epoch mismatch and restart.
4. Add frontend reducer dedupe, bounded backoff, atomic `/state` replacement and generation rejection; test native EventSource query/`Last-Event-ID` precedence after a real same-epoch disconnect.
5. Prove multiple read subscribers do not own lifecycle; freeze the supported v1 model as one interactive browser session, with any additional same-cookie tab treated as a stale read projection whose mutations fail on generation/revision conflict and resync.
6. Add real Chromium EventSource tests; do not rely on reading JSON error bodies from failed EventSource connections.

**Exit**

- disconnect/reconnect within a live replay window loses no projection;
- duplicate replay is harmless;
- old Chat/turn events cannot enter current generation;
- gaps and Host restart recover atomically from durable `/state`;
- no cross-process durable event replay or exactly-once claim is made;
- two-tab stale mutation cannot target the wrong Chat/turn, and concurrent different-key submits have exactly one winner.

### P8 — Context composition and staged Memory management

**Dependencies:** stable source contracts owned by `design/24`/Magic Context. Player-visible Memory management additionally depends on `design/39` P2 single-mount remediation and applicable `design/32` evidence capability.

**Chat Core work**

1. Publish the canonical immutable active Tavern artifact snapshot to the exact Pi session.
2. Prove Persona/Scenario/DialogueExamples/World Info source isolation and restart/fold behavior under their owner.
3. Consume Magic Context-owned governed long-term Memory materialization; Host does not assemble prompts or access SQLite.

**Mandatory Tavern-management work**

4. Mount Memory read independently.
5. Mount mutation only with runtime-owned evidence coordinator/facade; no ordinary fallback.
6. Serialize Memory mutation versus active/draining provider turn according to `design/32`.
7. Project only safe capability/outcome; no marker or provider evidence to browser.
8. Close the player-visible read/mutate/revision/conflict/reopen journey in P9/P10; test-only evidence injection does not satisfy it.

**Exit**

- production provider boundary consumes exact stable source and governed Memory path;
- surface isolation and no Host prompt assembly hold;
- Chat Core may release without player Memory-management UI and does not claim Game Operational or auto-promotion closure;
- this plan and `tavern_management_v1` cannot complete until Memory read/mutation management is mounted, missing mutation evidence truthfully leaves mutation absent, and its player-visible gates pass.

### P9 — Mandatory mounted Tavern-management slices

P9 is mandatory plan work after the independently releasable Chat Core checkpoint. The plan must not be closed, archived or reported complete while an approved in-scope `design/28` target remains unmounted or unreleased.

For each slice, use the same micro-pipeline:

```text
profile operation
  → browser schema
  → Host auth/scope parser
  → exact domain command
  → durable read-back
  → safe snapshot/event projection
  → frontend control and recovery state
  → Host contract + browser journey + release mapping
```

No batch may mount every existing service at once. Close in this order unless dependencies justify a reviewed change:

1. title/draft management already compatible with Chat Core, then Chat list/exact open/switch only after the `design/30` replacement capability exists;
2. explicit New Chat with Persona/Scenario/Greeting/message 0;
3. library/character detail/New Companion and approved Character lifecycle;
4. Persona/Scenario/Greeting list/update/retention/revision lifecycle required by the approved target;
5. World Info catalog/manage/bind/conflict/recovery lifecycle;
6. candidate/import/export/interchange and player-readable loss reporting;
7. Chat archive/trash/restore after required `design/30` evidence;
8. player-visible Memory read/mutation management from P8;
9. connection/provider/model management: approved catalog, write-only credential vault, test/save/activate/remove, persisted Chat-model/reasoning selection and safe readiness projection;
10. Host-owned language/player preferences required by the target;
11. eligible response operation only after it causes a real durable operation and remains in the approved target;
12. settings/Game safe read-only projections, without adding Game workflow authority.

**Exit per slice**

- route/profile/UI/evidence agree;
- failure preserves prior authoritative UI;
- safe projection exposes no internal identity;
- operation is marked released only after its own gates.

**P9 aggregate exit**

- every in-scope `design/28` row has an approved target mapping and is `released`, not merely implemented or mounted;
- no Host-only seam, mock journey, fixture provisioner or read-only projection is counted as a management lifecycle;
- any removed target is backed by a reviewed taxonomy revision and absent from profile, UI and release claims;
- a player can reach a configured first Chat from a fresh root without operator-created Tavern state.

### P10 — Process, browser and cumulative release closure

**Reference-pipeline predicate**

`chat_core_reference_pipeline_v1 complete` may be recorded only when:

- P3.5 and P4a/P4b/P4c pass with a real embedded provider-start observation, no duplicate attempt after crash/reopen, and no Host prompt assembly;
- P5 persists a typed companion presentation and a terminal outcome before any browser success projection;
- the minimum P7 state delivery/recovery implementation provides a browser-authoritative state after submit and reload/restart, without claiming unsupported cross-process replay;
- a fresh GameBuddy-owned root runs the shipped Host/browser artifact through the exact bounded journey without mock routes or hidden product setup APIs;
- every deferred operation is absent from the mounted profile/UI and is linked to a scoped follow-up issue; and
- no directly relevant security, durability, provider, capacity, or recovery blocker remains.

This checkpoint is deliberately weaker than `chat_core_v1 released`: the P2 Windows arbitrary-reparse live-evidence gate and any remaining Chat Core release predicate item still block release.

**Shared work**

1. Register risk/suite entries under `design/27` and `design/33` rather than creating a new evidence class.
2. Add real production Host + shipped-browser black-box journeys without `page.route()`.
3. Complete `design/30` S6 consumer record.
4. Run no-retry browser release suites on the immutable artifact.
5. Run controlled live charters with real GameBuddy-owned Host/SDK/provider data roots.
6. Produce privacy-safe records with artifact/profile/contract/static hashes and per-flow verdicts.

**Intermediate `chat_core_v1` release predicate**

`chat_core_v1` may be released only when:

- P0–P8 Chat Core portions pass, including the P3.5 capacity gate; player-visible Memory management and Chat switching may remain unmounted at this checkpoint;
- production artifact/static closure passes;
- Host contract/security/race/restart suites pass;
- production black-box browser journey passes first attempt;
- required responsive/locale/a11y review passes;
- `design/30` S6 consumer record passes;
- selected Magic Context stable-source gates pass;
- the canonical external fixture provisioner passes and the controlled Chat Core live run passes;
- no blocker finding or unclassified Chat Core operation remains.

This predicate permits only the claim `chat_core_v1 released`; it does not satisfy plan completion or a Tavern-management/player-complete claim.

**Final `tavern_management_v1` and plan-completion predicate**

The plan is complete only when:

- the exact immutable release tuple already satisfies the Chat Core predicate;
- P9 aggregate exit passes and every approved in-scope `design/28` capability is released;
- player-visible Memory and connection/model management pass their owner-specific security, persistence, conflict, restart and browser gates;
- a fresh-root production browser journey, without fixture provisioning or hidden/operator-created Tavern state, configures a connection/model, creates the first Companion and Chat, selects/binds approved artifacts, sends and receives through the real provider, stops/reconnects/restarts/reopens, creates and switches another Chat, performs approved lifecycle/retention/import-export/Memory operations, and reads back durable results;
- the full en/zh-CN, responsive, accessibility, security/privacy and failure/recovery matrix passes for all mounted management slices;
- final profile, browser contract, static assets, provider/runtime and evidence all share one immutable release tuple;
- no blocker, unclassified in-scope target or target→mounted→route→evidence gap remains.

A management capability becomes individually released only when its P9 slice and profile-specific flow pass; individual slice release does not complete the plan before the aggregate predicate passes.

---

## 11. Test and evidence matrix

Use existing evidence classes. Add these Chat pipeline risk IDs:

| Risk ID | Failure mode | Primary evidence |
|---|---|---|
| `TCP-CON-001` | Host/profile/frontend contract drift | static contract/profile drift test |
| `TCP-SEC-001` | bootstrap/auth/Origin/CSRF/version bypass | Host black-box HTTP contract |
| `TCP-AST-001` | stale/missing/unmanifested frontend asset | production artifact/static security test |
| `TCP-MSG-001` | provider invoked before player message commit | deterministic Tavern/Host contract barrier |
| `TCP-MSG-002` | uncertain retry duplicates message or turn | process restart black-box test |
| `TCP-DRF-001` | message accepted while exact draft CAS conflicts | domain/Host transaction test |
| `TCP-PRS-001` | uncommitted/ordinary output becomes bubble | presentation/Host contract test |
| `TCP-TRN-001` | turn completion lacks correlated presentation | terminal-ledger contract test |
| `TCP-CAN-001` | cancel/presentation race fabricates outcome | deterministic permutation + process test |
| `TCP-EVT-001` | reconnect loses/duplicates/misroutes projection or fails to resync | live-epoch contract + real EventSource snapshot-recovery journey |
| `TCP-SEL-001` | late old-Chat event corrupts new Chat | generation race contract + browser journey |
| `TCP-SEL-002` | Chat switch races with a non-terminal turn | replacement-capability contract + deterministic/process race |
| `TCP-REC-001` | restart guesses latest/replays greeting/creates Chat | production process reopen test |
| `TCP-MEM-001` | Memory mutation bypasses evidence or hides read | Host/Magic Context contract owned with `design/32` |
| `TCP-PRV-001` | logs/problems/evidence leak private content | denylist mutation/black-box test |
| `TCP-REL-001` | deterministic fixture is promoted to release evidence | release prerequisite/evidence-kind checker |

### 11.1 Required layers

- **Pure/domain/Host contract:** schema, scope, idempotency, revision, durable ordering, transactions, cancellation race, privacy.
- **Process black-box:** production artifact, restart, port/session teardown, static assets, idempotency persistence, turn recovery and snapshot resynchronization.
- **Browser fixture:** DOM/focus/locale/viewport and controlled client recovery; fixtures are validated against v1.
- **Production browser integration:** actual Host/static app/EventSource, no route interception, synthetic SFW data and controlled provider adapter for deterministic pipeline mechanics.
- **Final live gate:** immutable Host/browser artifact plus real GameBuddy-owned SDK/provider path and human operation. It does not replace lower-layer negative tests.

### 11.2 Release anti-substitution rules

- mocked Playwright cannot prove Host persistence or production route mount;
- process tests cannot prove human-visible browser behavior;
- provider fixture cannot prove real provider composition;
- provider answer text cannot prove Context/Memory materialization;
- S6 cannot prove Tavern Chat release;
- Chat release cannot prove Game, Stardew action, voice or companion-experience release;
- retries after flaky browser failure remain `flaky`, not release pass.

---

## 12. File plan

Expected primary additions/changes; exact names may be refined while preserving ownership:

```text
host/src/tavern/browser-contract/v1.ts
host/src/tavern/browser-contract/v1.test.ts
host/src/tavern/conversation-contract.ts          # browser-safe barrel
host/src/tavern/composed-profile.ts
host/src/tavern/chat-pipeline-service.ts
host/src/tavern/chat-pipeline-service.test.ts
host/src/tavern/chat-thread-store.ts                    # extend existing journal/turn owner
host/src/tavern/chat-thread-store.test.ts
host/src/dialogue-web.ts                          # thin transport only
host/src/dialogue-web-main.ts                     # production composition
dialogue-web/src/api/v1.ts
dialogue-web/src/state/tavern-reducer.ts
dialogue-web/src/main.tsx                         # UI composition, no DTO authority
host/scripts/build-production-artifact.mjs            # serial integration owner only
dialogue-web/vite.config.ts
.ci/test-portfolio-manifest.v1.json                    # serial integration owner only
```

Do not create:

- a second continuity or Memory database;
- a standalone durable Chat event log or general event-sourcing framework;
- a generic distributed transaction manager;
- an OpenAPI/generator stack in addition to TypeBox for v1;
- legacy route/DTO adapters;
- direct frontend imports from Host runtime modules;
- a second Tavern artifact/revision repository;
- a second Chat release gate taxonomy.

---

## 13. Migration and destructive cutover

This product is pre-release. Use a destructive protocol cutover:

1. implement v1 alongside tests, but do not expose two route families in a release artifact;
2. switch production entry, static app and composed profile in one artifact generation;
3. delete unversioned Host routes, frontend DTOs and fixture shapes they replace;
4. do not import/adopt archived Dialogue authority or legacy continuity;
5. do not use read-repair, fallback or compatibility aliases;
6. retain unrelated Tavern content only through its current canonical owners and explicit candidate/import rules;
7. a stale browser bundle/profile mismatch gets an explicit incompatibility state, not silent downgrade.

Rollback before release means deploying the previous immutable artifact to a fresh approved test root. It does not mean reintroducing old production authority or dual write.

---

## 14. Definition of done and allowed completion claims

### 14.1 Chat Core milestone done

The independently releasable Chat Core milestone is done only when all of the following are true:

- one composed mounted `chat_core` profile controls its routes, bootstrap operations, frontend visibility and release mapping;
- one versioned browser contract controls all Chat Core production DTOs/events/problems;
- the production Host serves the exact tested application assets;
- bootstrap/state restores one exact durable Chat state without guessing;
- player send is durable/idempotent before provider invocation;
- every supported durable ChatThread artifact has an explicit enforced capacity budget, and a full snapshot is complete within its declared transcript envelope;
- draft clear and message acceptance are reconciled atomically;
- companion presentation is durable before visibility;
- terminal completion is correlated to exact committed presentation;
- cancel is durable/idempotent and rejects late callbacks when it wins;
- SSE live cursor/generation/dedupe and snapshot recovery survive disconnect/restart without exactly-once or cross-process replay claims;
- Context and long-term Memory materialization owners are consumed without Host duplication or fallback;
- frontend shows only mounted Chat Core operations and never fabricates success;
- privacy, auth, CSRF, static path and problem-contract negatives pass;
- production process/browser, Chat-Core-only canonical fixture provisioning, S6 dependency and controlled live records all pass on the same immutable release tuple;
- no required Chat Core manual or real-environment gate is omitted from the milestone report.

Passing §14.1 permits only: **`chat_core_v1 released`**. The overall plan remains in progress.

### 14.2 Tavern-management plan done

This implementation plan is complete only when §14.1 and all of the following are true:

- the composed profile is the exact approved `tavern_management` tier and no target-only taxonomy mounts or advertises operations;
- every approved in-scope `design/28` target has a versioned route/schema, authenticated Host owner path, durable read-back, safe browser projection, complete frontend lifecycle/recovery state and release evidence;
- Companion/Character, Chat list/create/open/switch/title/draft/archive/trash/restore, Persona/Scenario/Greeting, World Info, candidate/import/export/interchange, player-visible Memory, connection/provider/model/credential and player-preference lifecycles are released to the extent required by the approved target revision;
- connection secrets are write-only, never read back, and test/save/activate/remove plus selected Chat model/reasoning state survive restart without leaking credentials or accepting arbitrary endpoints/code;
- a player starting from a fresh GameBuddy-owned root can configure Chat, create the first Companion and Chat, converse, recover/reopen, create and switch another Chat, and complete the approved management/retention/export/Memory flows using only shipped production UI/routes;
- the final journey uses no `TavernLiveFixtureProvisioner`, operator-created Tavern state, mocked route, hidden setup endpoint, legacy authority, fallback or read-repair;
- complete en/zh-CN, responsive, accessibility, conflict/concurrency, restart, security/privacy and player-readable failure matrices pass for every mounted slice;
- implemented/mounted/released facts are truthful, and no Host-only seam or read-only projection is counted as a completed mutation lifecycle;
- the exact artifact/profile/contract/static/provider/runtime tuple passes the final process/browser/live gates and contains no blocker, unclassified in-scope must or target→mounted→route→evidence gap;
- no required manual or real-environment gate is omitted from the final report.

Passing §14.2 permits: **`tavern_management_v1 released`** and, when the approved target mapping has no remaining in-scope must capability, **`player_complete_tavern_chat_v1 released`**. Neither claim includes Game workflow/control or explicitly unsupported advanced features.

### 14.3 Truthful status wording

Use exactly one of these statuses:

- before reference-pipeline closure: **Chat pipeline implementation in progress; not released.**
- after the reference pipeline but before Chat Core release: **Chat Core reference pipeline complete; Chat Core release evidence in progress; not released.**
- after Chat Core but before §14.2: **Chat Core released; Tavern management implementation in progress; plan incomplete.**
- after §14.2: **Tavern management v1 released; implementation plan complete for the approved Tavern Chat target.**


# --- CONSOLIDATED EARLY BATCH CONTRACTS (BATCH 01-04) ---


## From 40_CHAT_PIPELINE_BATCH_01_P0_P1.md

## User-visible result

The codebase has a single, testable distinction between target scope and production mount scope: `selected_l3_v1` can describe only the approved target taxonomy, while an immutable `ComposedTavernProfile` is the only object that can describe mounted Chat Core browser operations. A pure, versioned `tavern_browser_api/v1` registry validates the first Chat Core wire shapes before any Host route or browser UI uses them.

## In scope

- Destructively downgrade `selected_l3_v1` from route/mount authority to target taxonomy; no runtime mount or browser bootstrap model is exported from it.
- Add a TypeBox-based pure `TavernBrowserContractV1` for the unmounted Chat Core route/operation/schema/problem/event registry.
- Add a pure immutable `ComposedTavernProfile` that only restricts contract operations, has explicit `chat_core` / `tavern_management` tiers, and rejects target taxonomy as a mount input.
- Add focused unit and release-prerequisite drift tests that prove target-only data cannot be treated as mounted/released.

## Explicit non-goals

- No `dialogue-web.ts`, `dialogue-web-main.ts`, React, Vite/static artifact, semantic runtime, ChatThread journal, Draft store, Pi/provider, SSE, Memory, connection/model, or release gate behavior changes.
- No `/api/tavern/v1` Host route registration, aliases, compatibility adapter, fallback, fixture provisioning, or claim that Chat Core is mounted/released.
- No changes to shared package/lockfile, CI, production artifact, or unclassified WIP.

## Authority and topology

```text
approved domain target taxonomy (`selected_l3_v1`)
                 ↓ descriptive only; never mount input
TavernBrowserContractV1 (wire declarations only)
                 ↓ approved operation identifiers only
ComposedTavernProfile (sole future mount/visibility projection)
                 ↓ later Host route parser/handler composition
browser
```

The browser, tests, fixture builders, target taxonomy and environment never grant operations. `ComposedTavernProfile` is pure and unmounted in this batch.

## Acceptance scenario

**Given** the approved `selected_l3_v1` target taxonomy and an approved set of Chat Core contract operation IDs,

**When** code composes a `chat_core` profile,

**Then** the result exposes only immutable approved Chat Core operations and no target-only operation;

**And** unknown/duplicate/incompatible operation IDs or a target-taxonomy object used as a mount input fail closed;

**And** strict TypeBox schemas accept bounded valid bodies and reject unknown/malformed bodies;

**And** neither Host runtime routes nor browser UI is changed or can use the new declarations to claim mounted/released behavior.

## Producer → consumer → verifier

- Producer: pure TypeBox contract registry + composed-profile constructor.
- Consumer: focused unit/drift tests; future Host mounting is deliberately absent.
- Verifier: contract/profile test suite, existing selected-L3/checker tests, Host typecheck, and diff boundary check.

## Mutation lanes

| Lane | Owned paths | Shared decisions | Cheapest check |
|---|---|---|---|
| A — target taxonomy | `host/src/tavern/selected-l3.v1.ts`, `host/src/tavern/selected-l3.v1.test.ts`, `tools/check-tavern-release-prerequisites.mjs`, `tools/check-tavern-release-prerequisites.test.mjs` | destructive target-only downgrade; must/later/unsupported sets retained | focused Node tests/checker test |
| B — contract/profile | new `host/src/tavern/browser-contract/**` only | contract identity, Chat Core operation names/schemas, restrictive profile semantics | focused TypeScript unit tests |

No lane may edit any existing staged Chat runtime, frontend, build/CI, root dependency, continuity, ChatThread, Draft, Magic Context or artifact file. Lanes share no files. A fresh reviewer evaluates the combined diff only after both lanes finish.

## Launch budget

Two parallel writers, one validation/review wave, no real provider/game/live mutation, and no release claim.

## Stop/escalation

Stop if exact Chat Core wire schema requires a new product/authority/topology decision; if implementation would require touching an excluded shared/staged file; if a selected-L3 consumer requires runtime authority semantics; or if a worker needs a compatibility alias/fallback. Report the smallest blocker rather than widening the batch.


## From 41_CHAT_PIPELINE_BATCH_02_P2_STATIC_ARTIFACT.md

## User-visible result

A Host-owned static artifact server can serve only a verified Vite production shell and manifest-listed hashed assets. The server has no Tavern API, no session/bootstrap token, no SPA fallback, and no relation to an active Chat runtime. `dialogue-web` can build a production artifact with an explicit browser contract/profile build identity, which the static server verifies before listening.

## Scope

- Add a browser-owned Vite artifact manifest/build identity and deterministic production build output.
- Add a Host-owned static artifact verifier/server that validates a configured artifact root before it listens and allows only `/` and exact manifest-listed asset paths.
- Enforce regular-file/no-reparse containment, size/SHA-256/MIME checks, missing/extra/stale/source-map rejection, no-store HTML, immutable hashed assets, security headers, and no unknown-path fallback.
- Add focused artifact/server tests, including traversal, dotted unknown path, stale/mismatched asset, extra asset, missing manifest and mismatched contract/profile identity.

## Explicit non-goals

- Do not edit `host/src/dialogue-web.ts`, `host/src/dialogue-web-main.ts`, `dialogue-web/src/main.tsx`, `dialogue-web/src/style.css`, ChatThread/Draft/Memory/semantic runtime, or register any `/api/tavern/v1` route.
- No browser bootstrap/session cookies/tokens, Host runtime startup, SSE, Chat state or provider invocation.
- No root package/lockfile, CI, release script or existing staged-file edits. Do not migrate or preserve legacy unversioned HTTP paths.

## Authority / topology

```text
Vite browser artifact builder
  → immutable browser artifact manifest (contract/profile identity + exact asset hashes)
  → Host StaticTavernArtifactServer verifier
  → GET / and exact allowlisted hashed asset only
```

`TavernBrowserContractV1` and `ComposedTavernProfile` provide declared identity only. This batch must not treat their existence as a mounted browser API or release status.

## Required artifact shape

The browser build emits a fixed manifest JSON named exactly `tavern-browser-artifact-manifest.json` in the artifact root with exactly:

```ts
{
  schemaVersion: 1,
  browserContract: "tavern_browser_api/v1",
  profileId: "<build-owned non-empty identifier>",
  entryHtml: "index.html",
  assets: readonly {
    path: "assets/<hashed file name>",
    sha256: "<lowercase 64 hex>",
    bytes: positive safe integer,
    mime: "text/javascript" | "text/css" | "image/svg+xml" | "image/png" | "image/webp" | "font/woff2"
  }[]
}
```

The HTML shell is the sole non-hashed served file. The verifier requires exactly `tavern-browser-artifact-manifest.json` at the configured root and never discovers, globs, accepts an alternative filename, or falls back. The manifest and source maps are never served. Asset paths are canonical POSIX relative paths beneath `assets/`, have no query/fragment, no `.` / `..`, no backslash, no duplicate path and no unlisted file. The implementation must choose an ownership-safe way to provide `browserContract/profileId` to Vite without operator mutable configuration. If the existing Vite output cannot meet this exact shape without changing the frontend runtime, stop and report; do not make the Host guess the identity.

## Acceptance

Given a synthetic complete production artifact with a matching build identity, the static server starts and:

- `GET /` returns exactly the HTML shell, `Cache-Control: no-store`, restrictive security headers and no secret;
- exact listed asset returns matching MIME and `Cache-Control: public, max-age=31536000, immutable`;
- unknown, traversal-encoded, dotted, source-map, manifest, directory, query-altered or unlisted path receives `404` and never falls back to HTML;
- malformed/missing/duplicate/extra/stale/reparse/mismatched-hash/mismatched-size/mismatched-identity artifact fails before listening;
- no API/session/bootstrap/Chat semantics exist in this server.

### Windows reparse enforcement blocker

The Node-only Batch 02 implementation currently rejects links/junctions that Node exposes as symbolic links and guards directory identities, but cannot inspect arbitrary `FILE_ATTRIBUTE_REPARSE_POINT` tags. That does **not** meet the acceptance requirement above. `design/42_WINDOWS_REPARSE_ENFORCEMENT_DECISION.md` is binding: until its version-locked helper and real Windows probes are implemented, this batch is not release-eligible and every prerequisite/release gate must remain blocked with `windows_arbitrary_reparse_enforcement_not_implemented`.

## Lanes

| Lane | Owned files | Responsibility |
|---|---|---|
| A: browser artifact | `dialogue-web/vite.config.ts`, new `dialogue-web/scripts/**`, new/updated artifact-focused test under `dialogue-web/tests/**` | emit deterministic manifest identity/hashes and assert artifact boundary; no React source edits |
| B: Host static server | new `host/src/tavern/static-artifact/**` | validate and serve artifact with focused tests; do not edit existing Host entry/HTTP files |

Lanes do not share files. They may agree only on the frozen manifest schema above. A reviewer validates combined output. If the artifact-generated manifest cannot be directly consumed by the static server without runtime guessing, stop.

## Verify

Each lane runs focused tests plus typecheck/build appropriate to its own package. The integrator additionally runs both package typechecks, `dialogue-web` build + artifact test, Host `build:test` + static-server test, and a diff-boundary audit. No live/provider/game gate is run in this batch.


## From 43_CHAT_PIPELINE_BATCH_03_P2_OUTER_ARTIFACT_COMPOSITION.md

## Objective

Make the existing Host production artifact builder the **sole outer release artifact owner** for the already-built Vite browser artifact.

The output is one immutable Host production generation containing a verified browser subtree. It is not two independently published directories and does not make the static server reachable yet.

```text
private Vite build staging root
  → exact tavern-browser-artifact-manifest.json identity/hash validation
  → copy only verified browser subtree into private Host closure
  → existing reachable Host entrypoint closure
  → existing publishProductionArtifact
  → one published Host generation containing browser artifact subtree
```

## Preconditions

- Batch 01 contract identity is `tavern_browser_api/v1`.
- Browser identity is exactly `gamebuddy.tavern.browser.v1`.
- Browser manifest is exactly `tavern-browser-artifact-manifest.json`.
- Browser generator and Host static verifier remain unmounted assets-only modules.
- `design/42_WINDOWS_REPARSE_ENFORCEMENT_DECISION.md` remains a hard release blocker. This batch does not fake, weaken, or clear it.

## Ownership

**One serial writer owns only:**

- `host/scripts/build-production-artifact.mjs`
- new/update focused tests under `host/scripts/**` for this builder
- new narrow build-only helper(s) under `host/scripts/**`, if unavoidable.

The writer may invoke existing `dialogue-web` scripts but must not edit `dialogue-web/**`, `host/src/dialogue-web*.ts`, HTTP/static server modules, production artifact primitives, package manifests, lockfiles, CI, or runtime code.

## Frozen artifact layout

Within the private Host closure, the browser root is exactly:

```text
browser/tavern/v1/
  index.html
  tavern-browser-artifact-manifest.json
  assets/<manifest-listed hashed files>
```

No browser file exists outside this subtree. The outer Host artifact publisher remains the only top-level inventory/identity publisher. Do **not** introduce another published root or a second outer manifest/release tuple.

## Required implementation behavior

1. Build `dialogue-web` into a per-run private staging root—not its normal persistent `dialogue-web/dist`, and never a cwd-derived/operator-provided root.
2. Verify the Vite staging output with the browser-owned manifest verifier and exact fixed identity before copying.
3. Re-verify the copied closure subtree using the Host static artifact verifier's `verifyTavernStaticArtifact()` with the exact fixed identity before `publishProductionArtifact()`.
4. Copy the exact verified browser files into `browser/tavern/v1`; no globbing, discovery, extra files, source maps, symlinks/reparse entries, or fallback copied files.
5. If browser build, verification, copy, copied-tree verification, Host TypeScript closure, or publication fails: clean private staging/closure roots and leave the existing published generation untouched.
6. The builder must not call `createStaticTavernArtifactServer`, bind a port, launch a browser, create/bootstrap a session, or construct a Chat runtime.
7. Browser identity is build-owned and checked at both boundaries; it may not come from environment, manifest input, CLI, model output, or Host runtime guesswork.
8. Production launch must not yet be modified to discover/mount this subtree. That is a later, separately owned runtime composition slice after layout evidence exists.

## Required focused evidence

A fresh test fixture must prove:

- the browser build is invoked into a private requested output location;
- the published Host artifact has exactly one retained browser subtree at `browser/tavern/v1`;
- the subtree passes Host `verifyTavernStaticArtifact()` with `{ browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.tavern.browser.v1" }`;
- no browser asset/root exists outside that subtree;
- malformed, wrong-identity, stale/hash-mismatched, source-map, extra, or reparse browser staging artifact aborts before publication;
- a failed browser composition does not replace the pre-existing published generation;
- no HTTP listener, browser child, Pi runtime, API route, secret or bootstrap handoff appears in the test boundary.

The test may use a reviewed build process seam/fixture but must not replace the manifest verifier or Host publisher with a synthetic assertion. Tests must validate the **actual copied tree**.

## Exit and non-claim

This batch passes only as a build-composition increment: a published Host artifact can contain a verified browser subtree. It does **not** mean:

- browser assets are served;
- the old legacy dialogue web server is acceptable;
- `/api/tavern/v1` exists;
- Chat Core is mounted, functional, or released;
- the Windows arbitrary-reparse blocker is closed.


## From 46_CHAT_PIPELINE_BATCH_04_P3_EXACT_SNAPSHOT_BOOTSTRAP.md

## User-visible result

For the one already-mounted, exact Chat runtime, the shipped browser can exchange its one-time bootstrap handoff for a durable, contract-valid `tavern_browser_api/v1` snapshot; later reads return the same exact durable Chat/draft projection without creating, selecting, replaying, or guessing a Chat.

## Scope

- one exact mounted `ChatThread` / `chatSurfaceSessionId` / companion / continuity binding only;
- durable transcript from `ChatThreadStore` and draft from `ChatDraftStore`;
- `POST /api/tavern/v1/bootstrap`, `GET /api/tavern/v1/state`, and `GET /api/tavern/v1/draft` only;
- one mounted `ComposedTavernProfile` defining the operation/navigation projection;
- frontend startup may consume only the v1 snapshot and render explicit `no selection`, `blocked/problem`, or exact active-Chat state;
- tests for source-to-snapshot projection, one-time bootstrap, authenticated exact state/draft reads, corrupt/mismatched durable state, and contract validation.

## Explicit non-goals

- static-server mounting, browser artifact launch, release evidence, or P2 closure;
- Chat create/switch/list, management, provider submission, TurnLedger, cancel, SSE/replay, Memory mutation, or any legacy route/DTO/fallback;
- a `latest` read, implicit creation, selector mutation, runtime restart, browser-local state authority, mock production route, or compatibility alias.

## Authority and topology

`ComposedTavernProfile` is the sole operation/navigation availability authority. The P3 read facade receives the full current `MountedChatRuntimeLease` and first passes it through the coordinator-owned WeakMap-backed current-lease predicate; structural copies are rejected. It retains the real lease only privately, uses its `browserProjection.projectMessageHandle` for every durable message, and returns only browser-safe chat handle, selection generation, state revision, and message handles. It resolves the canonical identity profile binding at `resolveRuntimePaths(..., lease.chatSurfaceSessionId)`, never the root binding. It never receives or exposes a store root, selector, lifecycle mutation, create operation, durable IDs, or Pi runtime control.

`POST /bootstrap` accepts only the inherited private bootstrap token, mints browser session/CSRF, then returns a snapshot built from a fresh exact durable read. `GET /state` and `GET /draft` require that browser session. Every successful payload passes `TavernBrowserValidatorsV1`; a malformed, missing, or binding-mismatched durable source produces a v1 Problem Details response and no partial snapshot.

### P3-local BrowserMessageV1 projection semantics

The P3 facade projects each durable message as browser-safe `{ handle, role, text, locale, order, revision }`, with `handle` minted only through the mounted lease projection. `ChatThreadStore` has no language metadata, so `locale` is literally `"und"`; it does not claim the source language. Transcript storage is append-only, so `order` is the zero-based durable array index. P3 supports no edit, swipe, or message mutation, so each exact durable record is immutable and `revision` is literally `1`; it does not claim a source revision. The facade rejects non-safe-integer order/revision values and emits no raw durable ID.

## Acceptance scenario

**Given** an exact mounted lease and a durable thread containing an opening/player transcript plus a draft whose four-part scope matches the lease,

**When** the browser redeems the one-time bootstrap token through `/api/tavern/v1/bootstrap`,

**Then** it receives one contract-valid v1 snapshot containing that durable transcript, draft presence/revision, exact selection generation, and only profile-authorized operations.

**And** a later authenticated `/api/tavern/v1/state` and `/api/tavern/v1/draft` re-read the same durable sources without changing thread selection, creating messages/drafts, or starting/replaying a provider turn.

**And** a missing/corrupt/mismatched binding produces a safe typed problem without a substitute Chat or partial payload.

Producer → consumer → verifier: `ChatThreadStore` / `ChatDraftStore` durable read → narrow P3 exact projection facade → v1 HTTP serialization → `TavernBrowserValidatorsV1` plus focused HTTP tests.

## Mutation lanes

### Lane A — exact P3 projection facade

**Owned paths:** `host/src/tavern/p3-exact-chat-state.ts`, `host/src/tavern/p3-exact-chat-state.test.ts`

Build a narrow, constructor-validated read facade from an exact identity-bound `ChatThreadStore` + `ChatDraftStore` only. It must expose no store/root or mutation authority. It must reject missing/corrupt/mismatched state rather than falling back.

### Lane B — v1 HTTP bootstrap/state/draft adapter

**Owned paths:** `host/src/dialogue-web.ts`, `host/src/dialogue-web.test.ts`

Replace the old bootstrap response and introduce only the three P3 v1 GET/POST routes. The lane consumes Lane A’s facade and a mounted profile supplied by composition. It must not modify submit/events/Memory behavior except removal of stale bootstrap response assumptions.

### Lane C — production composition and startup client

**Owned paths:** `host/src/dialogue-web-main.ts`, `dialogue-web/src/main.tsx`, `dialogue-web/src/p3-browser-api.ts`, frontend focused tests if required.

Compose exact read sources using manifest-derived identity and the mounted lease; freeze the Chat Core profile. Refactor startup transport to v1 snapshot only. Do not implement management UI or v1 submit/draft mutation yet.

## Validation order

1. Lane A unit tests and Host typecheck.
2. Lane B HTTP/contract tests against a real temporary durable thread/draft.
3. Lane C typecheck/build and UI startup tests.
4. Combined Host test compilation and all owned focused tests.
5. `git diff --check`.
6. One independent final reviewer reads post-write diff and evidence.

## Stop conditions

Stop and return a design decision if implementation needs a selector/create/runtime switch, an unapproved operation in the mounted profile, a compatibility route, a second durable authority, or a change to P2 static/release-gate work. P2’s missing real Windows non-link reparse evidence remains a named release blocker and must not be absorbed by this batch.
