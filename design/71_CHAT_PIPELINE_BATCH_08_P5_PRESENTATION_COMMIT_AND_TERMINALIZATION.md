# Chat Pipeline Batch 08 — P5 Runtime-Owned Presentation Commit and Terminalization

**Status:** frozen reference-pipeline boundary; P5 implementation topology correction is frozen (the earlier standalone post-P4 `startMountedP5Presentation()` draft is invalid and must not be wired).
**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` §5.1 TurnLedgerV1 frozen states, §7.3 companion presentation flow, §12 P5 work items 1–8, §6.8 browser turn projections
**Predecessors:** P4a durable acceptance (`design/49`–`65`), P4b durable attempt claim (`design/66`), P3.5 audit-remediation entry gate (`design/67`), architecture/digest governance (`design/68`), P4c provider-start observation and reopen classification (`design/69`), P3.5 handle-bound stale lock reclaim plus native root/liveness closure (`design/70`, `design/72`)
**P4c dependency:** this card is **drafted now** but declares the `design/69` P4c implementation gate a **hard implementation precondition** (see §12). P4c itself is still a frozen boundary card whose implementation is gated on the `design/67`+`design/70` P3.5 gate; no P5 code may start until P4c implementation passes its own gate.
**Release status:** non-release foundation. P2 Windows arbitrary-reparse live evidence remains a separate release blocker. `chat_core_reference_pipeline_v1 complete` is not reached by this card.

## 1. Truthful result

For one genuine currently mounted exact Chat with one P4a-durable `accepted_queued` turn, one P4b-durable `attempt_starting` generation-1 claim, and one P4c-durable `running` ledger (source-owned `after_provider_response` observation), the Host can:

1. mint one invocation-fresh, unforgeable presentation admission binding `{ turn, attemptGeneration, cancelEpoch }` inside the exact private session-consumer callback scope;
2. register the Chat `companion_text` presentation tool only because that admission-backed provider is wired (today the Chat `PresentationRuntime` has a text sink but **no** `admissionProvider`, so `createCompanionPresentationTools` registers nothing — a fail-closed unbound state);
3. on the single typed `companion_text` callback, revalidate exact Chat, turn, attempt and cancel epoch immediately before commit;
4. append exactly one companion message and transition the sole `ChatThreadStore` TurnLedger to `presentation_committed` in **one** prepared-journal transaction, read it back, and only then deliver the expression to the construction-owned presentation sink listeners;
5. after prompt settlement, durably arbitrate `completion_claimed` versus `cancel_claimed` as mutually exclusive CAS winners, drain, and terminalize to exactly one of `completed | cancelled | failed` with full read-back;
6. on any crash or close, reopen the ledger into exactly one deterministic classification with **no automatic Host re-prompt, no generation 2, no duplicate message, and no second Host prompt invocation** in every path. Pi-owned transport retries and later agent-loop requests are not counted or suppressed by this boundary.

The demonstrated P5 assertion is:

> Given a genuine mounted lease, one durable `running` generation-1 ledger, and the private presentation admission, when the embedded session produces exactly one typed `companion_text` callback, then either the sole journal reads back exactly one `completed` ledger whose committed presentation is bound to the exact turn/attempt/cancel-epoch/invocation scope, or the turn terminalizes to exactly one of `cancelled`/`failed` with no second Host prompt invocation, no uncommitted bubble, and no browser/SSE projection in any crash, close, or cancel window.

## 2. Scope

### In scope

1. `ChatThreadStore` TurnLedger extension to the full frozen `design/40` §5.1 state set (`presentation_committed`, `completion_claimed`, `completed`, `cancel_claimed`, `cancelled`, `failed`), with the same prepared-journal/write-before-read/read-back discipline and the same one-writer rule.
2. A new private runtime-owned presentation admission (`MountedP5PresentationAdmission`) minted only by the coordinator inside the exact invocation callback scope, following the P4b/P4c WeakMap-branded one-shot pattern; the P4c consumer in `host/src/tavern/p4-provider-attempt.internal.ts` is replaced by the P5 consumer as the **exclusive private session consumer** (`design/69` §6).
3. A Chat-owned in-process presentation epoch built on the existing generic `createCompanionInterruption` primitive; the admission binds `cancelEpoch` and commit revalidates it. The epoch is the P5 cancel-arbitration authority; the HTTP cancel **route** remains P6.
4. No assistant-message-level source lineage is required for the Chat Core reference pipeline. Assistant-message provenance is deferred to `design/74_CHAT_PIPELINE_P5_SOURCE_LINEAGE_PREREQUISITE.md` and is not a P5 functional authority.
5. Wiring of the Chat `PresentationRuntime.admissionProvider` (currently absent in `prepareExactChatRuntimeConstruction`) through the coordinator-backed per-invocation provider, so `companion_text` is registered only while a live admission exists and fails closed otherwise.
6. Durable completion/cancel arbitration CAS, provider drain, terminal persistence and read-back for `completed | cancelled | failed`, plus the frozen reopen decision table for every new crash window.
7. The emitted production artifact gains a fourth non-launchable P4/P5 verification root (`tavern/p5-presentation-commit.js`) behind the same facade → private bridge → coordinator admission → store chain.

### Explicit non-goals

- no HTTP/browser route, SSE event emission, `dialogue-web.ts` change, or browser-contract change (`dialogue-web.ts` remains P3-only: bootstrap/state/draft; `BrowserTurnV1` states and `BrowserEventV1` shapes in `host/src/tavern/browser-contract/index.ts` are already frozen and remain unmounted);
- no cancel **route** with idempotency (P6), no queued-turn cancellation route behavior (P6), no frontend projection (P7);
- no `DialogueController` turn authority (queue/dedupe/`submit`/`stop`), no prompt assembly, no `m[0]`/`m[1]`/Memory/stable-source republish, no provider/model/credential selection;
- no second attempt generation, no automatic re-prompt on any reopen state, no retry of the same attempt;
- no cross-process runtime-owner-death adjudicator: P5 supplies the *classification input* for the later adjudication card (`design/66` §3.3, `design/69` §12-2) and never auto-terminalizes an ambiguous owner;
- no reuse of `TavernConversation.commitResponse` (`host/src/tavern/conversation.ts:19,210-212`) for presentation commits — it appends a message without any TurnLedger state and is not the P5 seam;
- no new repository, event log, artifact, or budget beyond the frozen `design/67` budgets (the presentation sub-record must fit `turn-ledger.json`'s frozen 16 KiB budget, `chat-thread-store.ts:38`);
- no Chat switch, draft mutation, transcript pruning, retention, or Game surface interaction.

## 3. Source-owned authority and the exact seams

### 3.1 Where P5 starts: the P4c boundary

P5 is an invocation-time continuation of P4c, not a successor endpoint. The sole journal starts with `attempt_starting` (gen 1, immutable `AttemptClaimV1`) and P4c still owns `armed` → `running` from the source-owned `after_provider_response` observation. The same one-shot P4 invocation callback, inside the coordinator's close-drained `begin()` scope, activates P5 **before** `session.prompt()` and keeps that activation alive until the prompt settles and active presentation work drains. `companion_text` may occur only inside that already-running prompt; it waits for P4c's exact durable `running` read-back barrier before its P5 store transition. P5 adds **no** provider call and **no** observation evidence; `after_provider_response` remains the only accepted provider-start fact. A post-hoc API that first requires a returned `running` ledger and then mints P5 admission cannot authorize a callback that already occurred and is prohibited.

### 3.2 Presentation admission (runtime-owned, invocation-fresh)

The coordinator (`host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts`) already mints opaque WeakMap-branded one-shot admissions (`MountedP4Admission`, `MountedP4AttemptAdmission`, `MountedP4AttemptInvocationAdmission`, lines 119-152, claimed/consumed at lines 196-320). P5 adds an invocation-bound private activation and a one-shot per-callback admission:

```ts
type MountedP5PresentationActivation = Readonly<{ readonly __mountedP5PresentationActivation: unique symbol }>;
type MountedP5PresentationAdmission = Readonly<{ readonly __mountedP5PresentationAdmission: unique symbol }>;
// activation: { lease, P4 exact attempt binding, cancelEpoch, active, runningBarrier }
// admission:  { activation, active, consuming }
```

The activation is minted by the coordinator from its private record **before** the unique `session.prompt()` call. The construction-time gate starts unbound; while the activation is live it may mint exactly one callback admission. Frozen binding facts are minted by the coordinator only (never from facade/lease/browser/store/model):

```text
turnId, messageId, attemptId, attemptGeneration (1), selectionGeneration,
runtimeBindingDigest, runtimeOwner, cancelEpoch
```

Rules are identical to P4b/P4c: fieldless opaque token outside coordinator internals; activation and callback admissions are non-replayable, close-revoked and never persisted. The activation covers one prompt lifetime; the callback admission is one-shot and non-reentrant. `capture()` fails closed when no activation is current. The callback consumer must await the exact P4c `running` durable read-back barrier, then synchronously reserve the still-current activation/lease/cancel epoch as the commit linearization point before the sole P5 store transition. A stop that wins before reservation rejects with zero mutation; a stop after reservation is ordered after the presentation commit and must drain/terminalize only after that commit completes. The reservation is released after durable transition/read-back. The public lease remains a projection and never exposes the runtime session, store, activation, callback admission, or gate capability.

### 3.3 Chat presentation identity and verification boundary

The Chat `companion_text` callback is authorized by the exact private invocation admission, not by an assistant-message-level `sourceEventId`. The Chat runtime remains fail-closed while `admissionProvider` is absent. P5 replaces the shared presentation route with a narrow discriminated surface contract: the `chat` branch captures only the private `{ turn, attempt, cancelEpoch }` admission and produces a Chat expression with no `sourceEventId`; the existing `game` branch continues to require and project its source-owned `sourceEventId` unchanged. The common tool factory must reject an unsupported branch rather than treating an omitted ID as an implicit Chat capability; Chat speech remains absent and the existing voice/Game source-event contract is untouched.

This requires a P5-owned change to `host/src/presentation.ts` and its focused tests, plus an explicit source-event guard in `host/src/farmhand-companion-presentation.ts` before its native bridge write. The Chat P5 port accepts the Chat-only expression/admission shape; no UUID, timestamp, hash, `toolCallId`, browser key, ordering inference, or optional-field fallback may manufacture a source event. The locked Pi 0.84.1 `message_start`/`tool_call` surface has no stable assistant-message ID before the callback. That is no longer a P5 blocker because assistant-message provenance is not a functional requirement for this reference pipeline. The rejected premise and the strict production-versus-verification separation are recorded in `design/74_CHAT_PIPELINE_P5_SOURCE_LINEAGE_PREREQUISITE.md`.

### 3.4 Cancel epoch

The Chat runtime has no interruption epoch today (`createCompanionInterruption` is used only by the Game/action `RuntimeDispatchController`, `host/src/runtime.ts:353-413`). P5 freezes: the coordinator creates **one** Chat-owned in-process presentation epoch with the existing generic primitive (`host/src/companion-interruption.ts:46`), stored privately in the mounted-lease record; `cancelEpoch` in the admission is the epoch value at invocation; commit uses a synchronous epoch reservation as the commit linearization point immediately before the store transaction. The coordinator's private cancel seam (epoch `close`/`stop`) is the only P5 cancel ingress and is consumed by the P6 route later. Stops racing the reservation are ordered deterministically: pre-reservation stops reject the presentation; post-reservation stops wait for/drain the reserved commit before terminalization. The epoch is in-process memory only and is never the durable cancel authority — the ledger CAS is.

### 3.5 Where the durable commit lands

`ChatThreadStore` remains the sole durable writer. The store already provides the exact transaction machinery: `withPathLock` + prepared `transaction.json` full-state journal + `writeStateFiles` + `readArtifacts` + `removeOwnedSafeFile` (`commitState`, `chat-thread-store.ts:933-948`), private WeakMap ports for P4a/P4b (`p4AcceptanceByStore`, `p4AttemptClaimByStore`, lines 296-307), and the private Host ingress wrappers (`acceptP4MountedPlayerMessage`, `claimP4MountedAttempt`, lines 314-359). P5 reuses the existing same-shaped private P5 transition port only inside the already-exclusive P4c prompt-consumer callback: it never creates a second provider entry or a separately callable P5 start facade. The consumer issues `commit_presentation`, `claim_completion`, `complete`, `claim_cancel`, `cancel`, or `fail` only against the exact mounted attempt after its relevant admission/drain boundary.

## 4. Durable schema and recovery contract

### 4.1 Ledger extension (sole `ChatThreadStore` owner)

```ts
type PresentationCommitV1 = Readonly<{
  expressionId: string;   // equals the durable companion messageId (append uses expression.expressionId)
  messageId: string;
  cancelEpoch: number;    // bound at admission; synchronously reserved as the commit linearization point
  committedAtMs: number;
}>;

type RunningTurn = /* P4c frozen */ Readonly<{ ...; status: "running"; observation: { phase: "running"; ... } }>;

type PresentationCommittedTurn = RunningTurn & Readonly<{ status: "presentation_committed"; presentation: PresentationCommitV1 }>;
type CompletionClaimedTurn   = PresentationCommittedTurn & Readonly<{ status: "completion_claimed";   completionClaimedAtMs: number }>;
type CompletedTurn           = CompletionClaimedTurn   & Readonly<{ status: "completed";              completedAtMs: number }>;
type CancelClaimedTurn       = RunningTurn & Readonly<{ status: "cancel_claimed"; presentation: PresentationCommitV1 | null; cancelClaimedAtMs: number }>;
type CancelledTurn           = CancelClaimedTurn & Readonly<{ status: "cancelled"; cancelledAtMs: number }>;
type FailedTurn              = RunningTurn & Readonly<{
  status: "failed";
  presentation: PresentationCommitV1 | null;
  reasonCode: "interrupted" | "no_visible_presentation" | "runtime_unavailable" | "storage_unavailable";
  failedAtMs: number;
}>;

type ChatTurnLedger = AcceptedQueuedTurn | AttemptStartingTurn | RunningTurn
  | PresentationCommittedTurn | CompletionClaimedTurn | CompletedTurn
  | CancelClaimedTurn | CancelledTurn | FailedTurn;
```

All existing turn-integrity checks keep comparing the common immutable accepted projection (`turnId`, idempotency key, message ID, acceptance timestamp) and the immutable attempt claim; `presentation`/`observation` are bounded sub-records (≤ ~400 JSON bytes together, comfortably inside the frozen 16 KiB `turn-ledger.json` budget, enforced before write and before parse exactly as `design/67` B.3 requires). Malformed, foreign, over-budget or over-count artifacts are rejected before any recovery repair write with byte-for-byte no-repair behavior.

### 4.2 Transition CAS rules (frozen)

- `running` (exact attemptId, P4c observation) + consumed presentation admission (exact turn/attempt/epoch) → `presentation_committed` in **one** store transaction that also appends the single companion message of kind `response` under the frozen message grammar and 500-total-entry budget; read-back required.
- `presentation_committed` (exact) → `completion_claimed` only from the surviving process after prompt settlement; read-back required.
- `completion_claimed` (exact) → `completed` after provider drain and re-read-back of the committed presentation; read-back required.
- `running` | `presentation_committed` (exact) → `cancel_claimed` via the coordinator's private cancel seam (epoch close). The store CAS also accepts `accepted_queued`/`attempt_starting` sources per the frozen `design/40` §5.1 set; queued-turn cancel is exercised by the P6 route, not by P5's owned tests.
- `cancel_claimed` (exact) → `cancelled` after idempotent revocation/abort and drain; read-back required. An already committed presentation remains historical.
- Any pre-terminal state (exact, surviving process) → `failed(reasonCode)`; the P5 consumer writes `no_visible_presentation` when settlement occurs without a committed presentation, and the classification inputs of §4.3 for interrupted/runtime/storage cases.
- `completion_claimed` and `cancel_claimed` are mutually exclusive durable CAS winners. If cancel wins after a presentation commit, the committed bubble remains and the turn terminalizes `cancelled`; late presentation/completion is rejected. If completion claim wins, cancel returns the existing completion-in-progress/final representation while drain finishes.
- Any other source state, foreign/malformed attemptId, mismatched selection generation, mismatched epoch, or replayed transition: fail closed with zero durable mutation.

Every transition uses the existing `withPathLock` + prepared `transaction.json` + full read-back discipline. Prepared-journal recovery keeps the two-outcome rule from `design/66` §4 applied to each new boundary: pre-commit/rejected journal → prior state exactly as committed before this transition; post-commit prepared journal → this transition's exact committed state. It never yields a partial message, an altered accepted receipt, a duplicate message, a presentation without a ledger state, or a generation 2.

### 4.3 Reopen classification (crash decision table, extending `design/69` §4.3 W0–W4)

| Durable ledger at reopen | Classification | Permitted action |
|---|---|---|
| `running` gen1 (P4c durable) | **`running`** | No re-prompt, no generation 2, no auto-complete. Continue P5 lifecycle only from a provably alive owner in the same process drain; otherwise the classification is input to the later cross-process owner-death adjudicator. |
| `presentation_committed` (durable, no winner) | **`presentation_committed`** | Never silently completed; never re-prompted; never auto-cancelled. Arbitration only by surviving-process completion claim or authenticated cancel ingress; ambiguity is an adjudicator input. |
| `completion_claimed` (durable) | **completion in progress** | Read back the committed presentation; drain when provable; then `completed`. Runtime owner dead → `failed/interrupted` via the adjudicator; no new provider attempt. |
| `cancel_claimed` (durable) | **cancel in progress** | Complete revocation/abort idempotently; terminalize `cancelled`. Committed bubble (if present) remains. |
| `completed` / `cancelled` / `failed` (durable) | **terminal** | Exact read-back; no transition, no re-prompt, no new idempotency acceptance. |
| `attempt_starting`/`accepted_queued` (pre-running) | unchanged P4b/P4c rules (`design/69` §4.3) | Unchanged. |

### 4.4 Crash and close windows (each with one deterministic reopen result)

| Window | Boundary | Reopen result |
|---|---|---|
| W5 | after durable `running` read-back → before admission consumption / presentation commit | `running` (no interaction possible beyond provider start; no bubble) |
| W6 | during the presentation-commit transaction (journal pre-commit/rejected, or post-commit prepared journal) | exactly prior `running` OR exactly `presentation_committed` with the committed message — never a partial bubble |
| W7 | `presentation_committed` durable → before completion/cancel winner | `presentation_committed`; §4.3 arbitration |
| W8 | `completion_claimed` durable → before `completed` read-back | completion in progress; drain or adjudicated `failed/interrupted` |
| W9 | `cancel_claimed` durable → before `cancelled` read-back | cancel in progress; idempotent revocation completes |
| W10 | any terminal read-back | exact terminal; frozen |

Close race (coordinator `begin()` drain, `internal.ts:630-660`): close that wins before admission consumption → admission rejected (`semantic_chat_runtime_p5_admission_rejected` equivalent), zero commit, zero provider effect; close that begins while the provider call or commit is in flight → the callback drains through durable read-back exactly like the P4b close-drain rule (`design/66` §3.3); unconsumed admissions are revoked before runtime resource close; a durable write failure during close leaves the last durable state, which reopens per §4.3/§4.4.

Cancel race (in-process epoch): epoch close before commit → commit revalidation fails, no message append, no `presentation_committed`; epoch close after `presentation_committed` read-back → bubble remains, `cancel_claimed` → `cancelled`; `completion_claimed` CAS wins first → cancel observes the existing completion-in-progress/final representation; cancel wins → all later presentation/completion admissions fail closed with `stale_chat_presentation_epoch`.

## 5. Invocation sequence and at-most-one presentation effect

### 5.1 Strict ordering (frozen)

```text
consume P4b invocation admission (one-shot, WeakMap-branded)      [P4c consumer replaced by P5 consumer]
  -> revalidate exact lease/principal/runtimeRoot/selectionGeneration/deadline + active scope
  -> derive P5 presentation admission facts from coordinator record:
       { turnId, messageId, attemptId, generation 1, selectionGeneration,
         runtimeBindingDigest, runtimeOwner, cancelEpoch }
  -> activate the construction-time default-unbound Chat presentation gate with exact private attempt/cancel facts
  -> session.prompt(canonicalPlayerEnvelope, { expandPromptTemplates: false, source: "rpc" })   [exactly once per attempt]
  -> source-owned after_provider_response → P4c `running` transaction + durable read-back barrier
  -> typed companion_text tool callback (only while the activation is live):
       capture() -> one-shot private callback admission
       await exact `running` durable read-back barrier
       revalidate exact Chat/surface/turn/attempt/cancel epoch immediately before commit
       ChatThreadStore single transaction: append companion message + presentation_committed + read-back
       then deliver the committed expression to the construction-owned presentation sink listeners
  -> prompt settles and active presentation work drains:
       presentation committed + no cancel winner  -> completion_claimed CAS -> completed read-back
       presentation not committed                 -> failed (no_visible_presentation) read-back
       cancel winner                              -> cancelled read-back (late admission rejected)
  -> revoke the activation before runtime resource close
```

The existing construction-owned sink (`ConstructionOwnedChatPresentationSink`, `continuity-semantic-chat-runtime-construction.internal.ts:106-130` and `attachPresentation` on the lease) is the **delivery** seam only: listeners fire strictly after the durable commit read-back, and P7 later projects these deliveries; P5 emits no SSE.

### 5.2 At-most-one presentation and provider effect

Enforced by: (1) the one-shot invocation admission; (2) the P4c arm/`running` discipline unchanged; (3) no reopen state re-invokes (a reopened process holds no live admission and the ledger CAS rejects every second transition); (4) the presentation admission is one-shot and session-bound, so a Pi tool retry cannot double-commit the message; (5) `presentation_committed` is reachable only from exact `running`; (6) no generation 2 can be minted from any path.

## 6. Interaction with P4c admission and close

- The P5 consumer is the **exclusive private session consumer** of the invocation admission (`design/69` §6); `host/src/tavern/p4-provider-attempt.internal.ts` hands the invocation callback to the P5 bridge instead of the P4c zero-effect/no-op observer. No other caller may receive or consume the admission.
- The P5 consumer runs inside the coordinator's existing close-drained `begin()` scope; close semantics are frozen in §4.4.
- Unconsumed presentation admissions are revoked before runtime resource close; a presentation admission can never be used after close.
- The mounted-lease record keeps the private `RuntimeSession` reference per `design/69` §6, used only to serve the P5 consumer inside the invocation admission scope.

## 7. Provider/Pi surface limits

- Exactly one `session.prompt()` call per attempt, unchanged from P4c (§3.1); P5 adds no second call, no abort (abort is P6), no `DialogueController`, no system-prompt assembly, no `m[0]`/`m[1]`/Memory/stable-source access, no provider/model/credential selection, no browser/HTTP/SSE/presentation-projection/cancel-route surface.
- The presentation tool's `text` is validated by the existing `validatePlayerLine` grammar (`presentation.ts:145-172`) and the durable append re-validates under the frozen NFC/control/UTF-8-byte policy and the 500-total-entry budget.
- The admission facts are bounded and privacy-safe: `{ sessionId, cancelEpoch }` plus private turn/attempt binding; never payload, headers, prompt bytes, model output, tool args, raw provider error, or assistant-message provenance. `turnId`/`attemptId`/`presentation` facts are never projected to a browser (`design/66` §2.2).
- The consumer cannot obtain, persist, or reconstruct an `AgentSession`/provider control capability beyond the existing single prompt scope.

## 8. Mutation ownership

One connected authority/persistence/composition chain with **one durable writer** (`ChatThreadStore`) and no parallel writers.

Owned production paths (implementation card):

- `host/src/tavern/chat-thread-store.ts` + focused tests — P5 ledger states, `commitP5Presentation`/`claimP5Completion`/`claimP5Cancel`/`terminalizeP5Failed` private ports, recovery, budgets;
- new `host/src/tavern/p5-presentation-commit.ts`, `.internal.ts`, + focused tests — facade/private bridge (P4b pattern);
- `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts` + focused tests — `MountedP5PresentationAdmission` mint/consume, Chat presentation epoch (`createCompanionInterruption`), private `RuntimeSession` binding, close-drain/revocation, private cancel seam;
- `host/src/presentation.ts` + focused tests — discriminated Chat/Game text-expression and admission-provider contract: Chat carries no `sourceEventId`; Game remains source-event required; speech remains unchanged;
- `host/src/farmhand-companion-presentation.ts` + focused tests — reject a missing source event immediately before the native Game bridge write;
- `host/src/continuity-semantic-chat-runtime-construction/continuity-semantic-chat-runtime-construction.internal.ts` + tests — wire the Chat `PresentationRuntime.admissionProvider` through the coordinator-backed per-invocation provider (fail-closed unbound until then);
- no vendored Pi lineage observer is required by P5; any future assistant-message provenance enhancement is owned by `design/74`;
- `host/production-artifact.config.json`, `host/tsconfig.production.json`, `tools/check-host-production-import-boundary.mjs`, `host/scripts/production-artifact.{mjs,test.mjs}` — the frozen v2 descriptor root list becomes `["tavern/p4-durable-turn-acceptance.js", "tavern/p4-provider-attempt.js", "tavern/p4-provider-start.js", "tavern/p5-presentation-commit.js"]`; all roots stay in closure/inventory/recheck and are not launchable.

No P5 writer may edit `dialogue-web.ts`, browser files/routes, `browser-contract/index.ts`, SSE, `dialogue-controller.ts`, cancel routes, Memory, provider settings, `conversation.ts`, Game files, or release-gate logic.

## 9. Required acceptance evidence

### A. Exact presentation commit and terminal read-back

**Given** an active mounted Chat with one durable `running` gen-1 ledger and the private presentation admission. **When** the embedded session produces exactly one typed `companion_text` callback. **Then** the sole journal reads back exactly one `presentation_committed` ledger whose message is the single appended companion bubble, then exactly one `completed` ledger after settlement/drain, and a fresh store/reopen sees the identical terminal state, the original player message/draft/idempotency receipt, and no second Host prompt invocation (the fake provider asserts this Host-call boundary).

### B. Forbidden-evidence negatives

Ordinary assistant text, `agent_end`, `message_start` alone, any audit/live attestation, an unbound/absent admissionProvider, and provider answer content must leave the ledger exactly at `running` — never `presentation_committed`, never `completed`. In contrast, once an exact `running` ledger exists and the one Host `prompt()` invocation settles after presentation work drains without a committed callback, the private P5 consumer must terminalize exactly once as `failed(no_visible_presentation)`. A settlement without `after_provider_response` remains P4c `armed`/uncertain and never derives this failure.

### C. Every crash window and reopen classification

Deterministic interruption at W5–W10 plus the close race: each produces exactly the §4.3/§4.4 classification, no generation 2, no automatic re-prompt, no duplicate message, and at most one provider request.

### D. Cancel/completion arbitration

Cancel-first (epoch close before commit): zero append, `cancelled` terminal, late presentation rejected. Cancel-after-commit: bubble remains historical, `cancelled` terminal. Completion-first: `completed`, repeat cancel returns the existing final representation. Repeat cancel is idempotent. `completion_claimed` and `cancel_claimed` can never both be durable.

### E. Transaction integrity and budget

Every prepared-journal interruption point for the P5 transitions, a foreign journal, malformed presentation/observation fields, mismatched thread/surface/selection/turn/message/key/epoch, a 501st-entry presentation commit, and an over-budget `turn-ledger.json`: state is exactly the prior committed state or exactly the transition state; invalid input has zero durable mutation; near-limit and over-budget fixtures from `design/67` B.7 continue to pass; a full legal 500-entry thread with a committed presentation reopens inside the frozen envelope.

### F. Surface and emitted closure

Source scans prove: the P5 facade/bridge never imports `DialogueController`, `AgentSession`, browser/HTTP/SSE, cancel routes, Memory, or `conversation.ts`; public leases expose no mutable session; the Chat admissionProvider is fail-closed when unbound; audit/live evidence cannot mint or widen production authority; all P4/P5 roots are emitted/inventoried/rechecked and none is launchable.

## 10. Verification order

1. Store transition/recovery/budget tests (all P5 states, journal interruption points, capacity, arbitration CAS).
3. Coordinator capability tests (exclusive consumer, private session/epoch binding, close-drain, revocation, cancel seam, admission negatives).
4. Facade/bridge and source/emitted import-boundary negative fixtures.
5. Focused emitted tests serially after a fresh `host build:test`; cross-process coordinator tests remain serial.
6. Process-level reopen tests at W5–W10 with a scripted fake provider counting requests.
7. Production artifact/build tests, actual import-boundary check, Host typecheck/build-test, fresh production build and artifact recheck, `git diff --check`.
8. One fresh independent read-only review of the actual diff and evidence. A review cannot substitute for a failed/missing check.

## 11. Completion wording

Passing this card permits only:

```text
P5 runtime-owned presentation commit and terminalization frozen; implementation may begin after the P4c implementation gate passes, without assistant-message-level source provenance.
```

It does not permit `chat_core_reference_pipeline_v1 complete`, `chat_core_v1 released`, any Tavern-management claim, or any claim that cancel routes, SSE projection, or browser state delivery are handled (P6/P7 remain required).

## 12. P4c/P3.5 hard implementation precondition

This design is authored now, in a read-only authoring lane, without depending on P4c having passed. P5 **implementation** is hard-gated: no P5 code may start until the `design/69` P4c implementation gate passes (which itself requires the `design/67`, `design/70`, and `design/72` P3.5 gate: ChatThread artifact budgets/500-entry capacity and handle-bound Windows stale-lock reclaim with native root/liveness closure). P5 may not bypass a stuck durable owner with any local cleanup path. Tests, live attestation, artifact inventories, and review evidence cannot mint a presentation capability or weaken a failed production check.

## 13. Stop conditions and next decision

Assistant-message provenance is deferred to `design/74_CHAT_PIPELINE_P5_SOURCE_LINEAGE_PREREQUISITE.md` and must not become an implicit P5 dependency. Stop this card and return to a new scoped prerequisite only if a future product requirement makes that provenance functional rather than audit-only:

1. a complete cross-process runtime-owner-death/reopen adjudicator for the stored owner tuple (a later card; P5 only supplies classification input);
2. any prompt assembly, Memory access, HTTP/browser/SSE route, cancel route with idempotency, provider/model/credential changes, or `DialogueController` behavior (P6/P7/P8 owners);
3. a second attempt generation, an automatic re-prompt, or any durable writer other than `ChatThreadStore`.
