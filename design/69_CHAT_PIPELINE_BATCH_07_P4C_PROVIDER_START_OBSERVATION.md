# Chat Pipeline Batch 07 — P4c Provider-Start Observation and Reopen Classification

**Status:** frozen reference-pipeline boundary (read-only authoring lane; no production source/test file was modified to produce this card)
**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` §5.1 TurnLedgerV1, §7.2 provider attempt rule, P4 work item 9, P10 reference-pipeline predicate
**Predecessors:** P4a durable acceptance (`design/49`–`65`), P4b durable attempt claim (`design/66`), P3.5 audit-remediation entry gate (`design/67`), architecture/digest governance (`design/68`)
**P3.5 dependency:** this card is **drafted now** but declares the `design/67` P3.5 storage gate a **hard implementation precondition** (see §12). It does not depend on P3.5 having already passed to be authored; no P4c code may start until that gate passes.
**Release status:** non-release foundation. P2 Windows arbitrary-reparse live evidence remains a separate release blocker.

## 1. Truthful result

For one genuine currently mounted exact Chat with one P4a-durable `accepted_queued` turn and one P4b-durable `attempt_starting` generation-1 claim, the Host can:

1. consume the P4b one-shot invocation admission exactly once in a new private runtime-owned consumer;
2. arm a source-owned, session-bound, one-shot provider-start observer on the exact embedded Pi session;
3. durably record `armed` in the sole `ChatThreadStore` TurnLedger and read it back **strictly before** the single `session.prompt()` call;
4. observe the provider-boundary event `after_provider_response` from the locked Pi 0.84.1 extension surface;
5. durably transition the ledger to `running` (with the bounded observation fact) and read it back;
6. on any crash, reopen the ledger into exactly one of three precise restart classifications: `provably_not_started`, `uncertain`, or `running` — with **no Host duplicate prompt invocation, no generation 2, and no replay of the logical turn** in every path.

A logical turn is one Host-owned `session.prompt()` invocation. It is not one physical provider HTTP request: locked Pi 0.84.1 may retry transport and continues its agent loop after a tool callback. P4c does not claim to suppress those Pi-owned requests, and P5's `companion_text` tool path can require a subsequent model round. The durable boundary is therefore one exact prompt invocation plus no Host re-invocation after reopen; each observed `after_provider_response` proves one Pi/provider transport response, not model completion or global request cardinality.

The demonstrated P4c assertion is:

> Given a genuine mounted lease, one durable `attempt_starting` generation-1 claim, and the private invocation admission, when P4c invokes the embedded session exactly once, then either the sole journal reads back exactly one `running` ledger whose observation fact proves the provider transport interaction occurred, or the attempt is durably classified as precisely `provably_not_started` (a locally proven pre-invocation revocation, unavailable session, deadline expiry, or pre-arm crash) or `uncertain` (the Host invocation boundary may have been crossed). No reopen state ever re-invokes the provider.

## 2. Scope

### In scope

1. A new private runtime-owned consumer of the exact P4b invocation admission — the only caller of the embedded Pi session for this attempt.
2. A source-owned provider-start observation: the Pi 0.84.1 extension-runner event `after_provider_response` surfaced through the vendored magic-context pi-plugin as an in-process one-shot, session-bound observer.
3. `ChatThreadStore` TurnLedger extension: optional bounded `observation` sub-record (`armed` | `not_started` | `running`) inside the existing versioned ledger, plus the durable `running` ledger status, with the same prepared-journal/write-before-read/read-back discipline as P4a/P4b.
4. Frozen crash-window and reopen classification rules for every boundary between the P4b claim read-back and the durable `running` read-back.
5. The emitted production artifact gains a third non-launchable P4 root (`tavern/p4-provider-start.js`) behind the same facade → private bridge → coordinator admission → store chain.

### Explicit non-goals

- no presentation, completion, terminal `failed`/`cancelled`/`completed` transition, cancellation/abort, SSE, HTTP/browser route, or Memory access;
- no `DialogueController` turn authority (queue, dedupe, `submit`, `stop`), no Host prompt assembly, no system-prompt/`m[0]`/`m[1]`/stable-source republish (stable context is already published at materialization), no provider/model/credential selection;
- no second attempt generation, no automatic re-prompt on any reopen state, no retry of the same attempt;
- no cross-process runtime-owner-death adjudicator: P4c freezes the *classification input*; the existing owner-death/reopen adjudication boundary from `design/40` §5.1 and `design/66` §3.3 consumes it;
- no change to the browser contract, `BrowserTurnV1` states (`running` already exists), or the P4b claim/admission mechanics;
- no new repository, event log, artifact budget, or durable file beyond the frozen `design/67` budgets (the observation sub-record must fit `turn-ledger.json`'s frozen 16 KiB budget).

## 3. Source of provider consumption evidence

### 3.1 The only accepted start evidence: `after_provider_response`

Locked Pi surface (`@earendil-works/pi-coding-agent@0.84.1` in `host/node_modules`, verified against `dist/core/sdk.js` and `dist/core/extensions/types.d.ts`):

- `after_provider_response` is an extension-runner event: **"Fired after a provider response is received and before the response stream is consumed"**, carrying `status` and `headers`. In `dist/core/sdk.js` it is emitted from the model runtime's `onResponse` hook only after the provider HTTP transport interaction completed (a response object was received).
- It is the earliest source-owned event that proves the provider request actually left the Host process **and** the provider produced an HTTP response. Any status (2xx/4xx/5xx) counts: the provider consumed the request at the transport boundary; model acceptance is a P5 concern.
- It is **not** available through `AgentSession.subscribe` (that surface emits `agent_start`, `agent_settled`, `message_start`, `turn_start`, `turn_end`, etc.). It flows only through the extension runner, which the Host reaches exclusively through the vendored magic-context pi-plugin (`vendor/magic-context/packages/pi-plugin`).

### 3.2 Required vendored-bridge extension

`vendor/magic-context/packages/pi-plugin/src/tavern-narrative-gate-marker.ts` currently registers only `before_provider_request` (one-shot IPC marker to the parent) and `session_shutdown`. P4c requires a **new in-process one-shot observer** in the same plugin, following the exact one-shot/session-bound discipline of the existing marker:

```text
registerTavernProviderStartObserver(sessionId, onStart)
  -> validates sessionId (same /^[A-Za-z0-9_-]{1,256}$/ rule)
  -> stores a single callback keyed by sessionId (in-process memory only) and returns an opaque exact-session unregister capability to the Host runtime composer
  -> hook: pi.on("after_provider_response", ...)
       - reads ctx.sessionManager.getSessionId()
       - consumes (deletes) the binding BEFORE invoking, so later Pi agent-loop rounds/retries cannot fire this logical-turn observer twice
       - invokes onStart with ONLY { sessionId, statusClass } (statusClass = 2xx ? "success" : "error")
       - never reads, logs, or retains payload/headers/prompt/model output
  -> explicit unregister clears only that exact session binding; the runtime composer owns it
  -> `session_before_switch` clears the current session binding synchronously
  -> `session_shutdown` clears the binding as process-exit defense in depth

The coordinator close order is frozen: revoke unconsumed invocation admission -> drain the active execution scope -> unregister its provider observer -> dispose/close the exact Pi session. If the session changes or disposal begins before a durable `running` read-back, an existing durable `armed` record remains `uncertain`; the observer must perform zero write after unregister, close, or a foreign/superseding session.
```

The existing `before_provider_request` IPC marker (`gamebuddy-tavern-narrative-gate-marker/v1`) is **untouched**: it remains valid only for its own documented claim (pre-send serialization for the external narrative-gate runner) and is explicitly **not** provider-start evidence.

### 3.3 Forbidden false evidence (explicitly frozen)

None of the following may drive the `attempt_starting → running` transition or a restart classification:

| Forbidden evidence | Why |
|---|---|
| `session.prompt()` promise settlement/resolution | May settle from a pre-send rejection or an unclassified transport error; never proves provider consumption. Explicitly forbidden by `design/66` §8. |
| `before_provider_request` (incl. the existing narrative-gate IPC marker) | Fires **before** the provider HTTP call; a rejection after headers still produces it. Proves only pre-send serialization (its own runner documents this). |
| `before_provider_headers` | Fires before the provider HTTP call. Same defect. |
| `agent_start` / `message_start` / `turn_start` / `agent_settled` | Session/agent-loop lifecycle events; not provider transport confirmation. |
| Host-inferred timing heuristics, socket instrumentation, ping/probe traffic, random IDs | Not source-owned; can fabricate or miss the boundary. |
| Model output text, `agent_end`, "provider accepted" claims from answer content | Post-hoc inference; P5 owns settlement classification. |
| Any HTTP status observed by a Host-side caller | The provider call is Pi-owned; the Host never issues the provider request. |

The observation wrapper retains only the bounded facts in §3.2; it never retains status codes, headers, prompt bytes, or provider data (privacy denylist `design/40` §9.3 applies).

## 4. Durable schema and recovery contract

### 4.1 Ledger extension (sole `ChatThreadStore` owner)

```ts
type AttemptObservationV1 =
  | Readonly<{ phase: "armed"; observedAtMs: number }>
  | Readonly<{
      phase: "not_started";
      reasonCode:
        | "admission_revoked"        // close/termination revoked before send
        | "session_unavailable"      // exact session unavailable before Host invocation
        | "invocation_deadline_expired"; // coordinator deadline elapsed after arm but before Host invocation
      observedAtMs: number;
    }>
  | Readonly<{
      phase: "running";
      source: "after_provider_response";
      statusClass: "success" | "error";
      observedAtMs: number;
    }>;

type AttemptStartingTurn = Readonly<{
  turnId: string;
  status: "attempt_starting";
  idempotencyKey: string;
  messageId: string;
  acceptedAtMs: number;
  attempt: AttemptClaimV1;              // generation 1, immutable (P4b)
  observation?: AttemptObservationV1;   // NEW: "armed" | "not_started"
}>;

type RunningTurn = Readonly<{
  turnId: string;
  status: "running";
  idempotencyKey: string;
  messageId: string;
  acceptedAtMs: number;
  attempt: AttemptClaimV1;              // unchanged immutable claim
  observation: AttemptObservationV1 & { phase: "running" };
}>;

type TurnLedgerV1 = AcceptedQueuedTurn | AttemptStartingTurn | RunningTurn;
```

All existing turn-integrity checks keep comparing the immutable accepted projection (`turnId`, idempotency key, message ID, acceptance timestamp) and the immutable attempt claim; `observation` is a bounded optional sub-record (≤ ~200 JSON bytes, comfortably inside the frozen 16 KiB `turn-ledger.json` budget, which is enforced before write and before parse exactly as `design/67` B.3 requires).

### 4.2 Transition CAS rules

- `accepted_queued` → `attempt_starting` (gen 1): unchanged P4b claim; no observation.
- `attempt_starting` (exact attemptId, no observation or `armed`) → `attempt_starting` with `observation: armed`: the **arm** transition. Read-back required.
- `attempt_starting` (exact attemptId, observation `armed`) → `attempt_starting` with `observation: not_started`: only from a **surviving** process that proves locally, before Host invocation, that close revoked the admission, the exact session is unavailable, or the invocation deadline expired. Read-back required. A `prompt()` settlement can never authorize this transition.
- `attempt_starting` (exact attemptId, observation `armed`) → `running` (with `observation: running`): only after the one-shot `after_provider_response` observation. Read-back required.
- Any other source state, foreign/malformed attemptId, mismatched selection generation, or replayed transition: fail closed with zero durable mutation.

Every transition uses the existing `withPathLock` + prepared `transaction.json` + full read-back discipline. Prepared-journal recovery keeps the two-outcome rule from `design/66` §4 applied to each new boundary: pre-commit/rejected journal → prior state exactly as committed before this transition; post-commit prepared journal → this transition's exact committed state. It never yields a partial observation, an altered accepted receipt, a duplicate player message, or a generation 2.

### 4.3 Reopen classification (crash decision table)

| Durable ledger at reopen | Classification | Permitted action |
|---|---|---|
| `attempt_starting` gen1, no `observation` record (arm-write never committed, or journal pre-commit/rejected) | **`provably_not_started`** | No auto-re-prompt, no generation 2. Terminal reconciliation to `failed` (reason `not_started`) only through the existing owner-death/reopen adjudication; the classification is its input. Player re-submission is a future separate command/new idempotency key. |
| `attempt_starting` gen1, `observation: armed` (durable), no `running` | **`uncertain`** | No auto-re-prompt, no generation 2. Blocked; requires exact cross-process owner-death/reopen proof before `failed`/`interrupted` terminalization (`design/40` §5.1 restart policy; the cross-process adjudicator itself is a later card per `design/66` §3.3). |
| `attempt_starting` gen1, `observation: not_started` (durable, written by the surviving process) | **`provably_not_started`** (already durable) | Same as row 1; no reopen inference needed. |
| `running` gen1 (durable `observation: running`) | **`running`** | Continue the P5 lifecycle. If the runtime owner is dead, the existing adjudicator consumes this classification; never re-prompt, never mint a new generation. |

The classification is exact because the arm-write **strictly precedes** the single `session.prompt()` call and is durably read back before it: absence of `armed` proves the provider call was never reached; presence of `armed` without `running` means the send boundary may have been crossed and fail-closes to `uncertain`.

### 4.4 Coordinator-minted invocation deadline

P4c has one fixed internal start-admission deadline, `P4C_PROVIDER_INVOCATION_ADMISSION_DEADLINE_MS = 120_000`. It is not a browser-session TTL, HTTP deadline, provider timeout, cancellation signal, configurable setting, or durable authority. The coordinator mints `deadlineAtMs = Date.now() + P4C_PROVIDER_INVOCATION_ADMISSION_DEADLINE_MS` exactly once while consuming the one-shot P4b invocation admission and creating the private execution scope. It is immutable only inside that scope and is never caller supplied, serialized, projected, or retained after callback return.

The coordinator/private consumer asserts `Date.now() < deadlineAtMs`, exact active lease, full origin tuple, and live runtime binding immediately before observer arm, immediately before the one Host `session.prompt()` invocation, and immediately before accepting the first observation and writing `running`.

That check is the **transition-admission linearization point** for the following async store transition or Host invocation. A successful check authorizes exactly that immediately invoked transition even if wall-clock time passes while its journal write/read-back is in flight; expiry is never evaluated retroactively against an already-admitted transition. A check that observes expiry authorizes neither the transition nor the prompt. This is an admission bound, not an impossible continuous-clock guarantee across asynchronous persistence.

- Before `armed` commits: an expired arm-admission check rejects with zero store mutation and no Host prompt invocation; reopen is `provably_not_started`.
- After `armed` commits but before `prompt()` begins: an expired invocation check lets the still-live consumer write the existing durable `not_started` observation with reason `invocation_deadline_expired`; it reads back before return. A crash in this interval leaves `armed` and therefore reopens `uncertain`, because that process-local non-invocation proof was lost.
- After `prompt()` begins: expiry never aborts Pi and never creates a second invocation. An expired running-admission check authorizes no `running` transition; the durable `armed` state remains and reopens `uncertain`, even if a response was observed in memory. The deadline never upgrades an uncertain state to `not_started`.
- `running` is written only when the same live scope passes the running-admission check and the first exact-session observation passes every other check. A late/expired observer causes zero durable write.

The fixed 120 s value is an admission bound, not a provider-completion claim. P5 owns prompt settlement and terminalization; P6 owns cancellation. Any requirement to bound or abort an in-flight Pi/provider operation needs a separately proven runtime cancellation surface.

### 4.5 Crash windows (each with one deterministic reopen result)

| Window | Boundary | Reopen result |
|---|---|---|
| W0 | after P4b claim read-back → before invocation-admission consumption | `provably_not_started` (no interaction possible; no armed record) |
| W1 | during/after admission consumption → before arm-write commit (or journal pre-commit/rejected) | `provably_not_started` |
| W2 | after arm-write read-back → before/during the `session.prompt()` send | `uncertain` (request may have left the process) |
| W3 | `after_provider_response` observed in-process → before durable `running` commit | `uncertain` at reopen (observation not durable; a Pi/provider transport response occurred inside the one Host prompt invocation, so nothing re-invokes) |
| W4 | after durable `running` read-back | `running` (provider start durable; P5 continues; owner death → existing adjudicator) |

Every window has a typed record and a process-reopen test (§9).

## 5. Invocation sequence and one Host prompt invocation

### 5.1 Strict ordering (frozen)

```text
consume P4b invocation admission (one-shot, WeakMap-branded, non-replayable)
  -> coordinator-private execution scope supplies exact live session + sole store-writer port + immutable bound facts
  -> revalidate exact lease/principal/runtimeRoot/selectionGeneration/runtime binding + active scope + coordinator-minted deadlineAtMs
  -> arm the source-owned one-shot observer for the exact piSessionId and retain its opaque unregister capability
  -> revalidate deadlineAtMs immediately before durable arm [arm transition-admission linearization point]
  -> ChatThreadStore: write observation { phase: "armed" } + read-back        [strictly before the call]
  -> revalidate deadlineAtMs immediately before the call [Host invocation-admission linearization point]; if expired, durable not_started only while prompt has not begun
  -> session.prompt(canonicalPlayerEnvelope, { expandPromptTemplates: false, source: "rpc" })
       exactly once by Host for this logical attempt; Pi-owned loop/retry requests are neither counted nor retried by Host
  -> on first after_provider_response for this logical turn (one-shot, session-bound):
       revalidate deadlineAtMs [running transition-admission linearization point]; when current, ChatThreadStore writes running + read-back
       when expired, zero durable write; armed remains uncertain
       return the bounded observation fact to the coordinator
  -> on prompt settlement with NO after_provider_response:
       no new durable write; settlement is never negative provider evidence
       (armed already forces uncertain)
```

### 5.2 One Host prompt invocation and no durable replay

Enforced by the conjunction of:

1. the P4b invocation admission is one-shot, callback-scoped, non-reentrant, non-replayable, and revoked by close — unchanged;
2. the arm-write + read-back strictly precedes the Host call, so a crash before it provably never invoked `session.prompt()`;
3. no reopen state re-invokes: the reopened process never holds a live execution scope and the ledger CAS rejects any second transition source (`running`/`armed`/`not_started` are only reachable from the exact prior state);
4. the observer is one-shot and session-bound, so later Pi loop rounds/retries cannot double-fire the durable first-response transition;
5. no generation 2 can be minted from any path (immutable `AttemptClaimV1` + CAS).

Pi transport retries and agent-loop continuations remain Pi-owned behavior inside the one admitted prompt invocation. P4c neither infers their count nor calls `prompt()` again. An implementation that needs a hard physical-request ceiling is out of scope and requires a provider/runtime capability not exposed by locked Pi 0.84.1.

## 6. Interaction with the P4b admission and close

- The P4c consumer is the **exclusive private session consumer** of `consumeMountedP4AttemptInvocationAdmission` (per `design/66` §8). `host/src/tavern/p4-provider-attempt.internal.ts` replaces its zero-effect observer (`async () => undefined`) with the P4c consumer; no other caller may receive or consume the admission.
- The consumer runs inside the coordinator's existing close-drained `begin()` scope:
  - close that wins before admission consumption → `semantic_chat_runtime_authority_closed` / admission rejection → no provider call → classification `provably_not_started` (`admission_revoked`) recorded if the consumer is alive to record it, otherwise W0/W1 reopen rules apply;
  - close that begins while the provider call is in flight → the current callback drains (P4c adds no abort capability; cancellation is P6); the durable transition is attempted before runtime resource close, exactly like the P4b close-drain rule; if the durable write fails during close, the ledger remains `attempt_starting` with `armed` → `uncertain` at reopen, and the existing retryable-ownership rules (`design/66` §3.3, `design/40` §9.5) apply unchanged;
  - unconsumed admissions are revoked before runtime resource close.
- The coordinator's mounted-lease record gains a **private** execution-scope composer. On consumption it supplies exactly: the live materialized `RuntimeSession`; a private, callback-scoped store-writer port bound to the mounted runtime root and full origin tuple; immutable bound facts `{ runtimeRoot, playerId, companionId, continuityId, chatThreadId, chatSurfaceSessionId, selectionGeneration, runtimeBindingDigest, runtimeOwner, deadlineAtMs }`; `deadlineAtMs` is minted only by the coordinator under §4.4; and a close-drained active-state assertion. The consumer cannot retain any of them after callback return. The scope is created only after the mounted record revalidates all facts, and close waits its callback drain before observer unregister and session disposal. The public `MountedChatRuntimeLease.runtimeSession` projection remains `Pick<RuntimeSession, "piSessionId" | "profile">`; no session, binding, store, or minting path crosses the facade.

## 7. Provider/Pi surface limits

- Exactly one `session.prompt()` call per attempt, with the frozen canonical player envelope (`gamebuddy_dialogue_input_v1` shape rendered from the durable accepted message facts: text, locale, idempotency-backed turn correlation), `{ expandPromptTemplates: false, source: "rpc" }`.
- No `DialogueController` (queue/dedupe/submit/stop), no `abort`/`clearQueue`/`waitForIdle` in P4c, no system-prompt assembly, no `m[0]`/`m[1]`/Memory/stable-source access, no provider/model/credential selection, no browser/HTTP/SSE/presentation/cancel surface.
- The observation fact is bounded and privacy-safe: `{ sessionId, statusClass, observedAtMs }` only; never payload, headers, prompt bytes, model output, or raw provider error. `attemptId`/observation facts are never projected to a browser (`design/66` §2.2).
- The consumer cannot obtain, persist, or reconstruct an `AgentSession`/provider control capability; it receives the session only inside the admission scope and only for the single prompt call.

## 8. Mutation ownership

This is one connected authority/persistence/composition chain with **one durable writer** (`ChatThreadStore`) and no parallel writers.

Owned production paths (implementation card):

- `host/src/tavern/chat-thread-store.ts` + focused tests — arm / `not_started` / `running` transitions, recovery, budget;
- new `host/src/tavern/p4-provider-start.ts`, `.internal.ts`, + focused tests — facade/private bridge (P4b pattern);
- `host/src/tavern/p4-provider-attempt.internal.ts` — composition: zero-effect invocation observer replaced by the P4c consumer;
- `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts` + focused tests — private execution-scope composer with exact live session, callback-scoped store port, full immutable origin facts and coordinator-minted `deadlineAtMs`; assert it before arm, prompt, and running write; prove expiry classifications, close-drain, revocation and unregister-before-dispose order;
- `vendor/magic-context/packages/pi-plugin/src/tavern-narrative-gate-marker.ts` (or a sibling module) + tests — in-process one-shot `after_provider_response` observer (schema `gamebuddy-tavern-provider-start-observation/v1`), opaque explicit unregister, synchronous `session_before_switch` cleanup and `session_shutdown` defense; existing `before_provider_request` IPC marker untouched;
- `tools/check-host-production-import-boundary.{mjs,test.mjs}`, `host/tsconfig.production.json`, `host/production-artifact.config.json`, `host/scripts/production-artifact.{mjs,test.mjs}` — the frozen v2 descriptor root list becomes `["tavern/p4-durable-turn-acceptance.js", "tavern/p4-provider-attempt.js", "tavern/p4-provider-start.js"]`; all roots stay in closure/inventory/recheck and are not launchable.

No P4c writer may edit `dialogue-controller.ts`, browser files, routes, P3 composition, presentation, cancel/stop, SSE, Memory, provider settings, Game files, or release-gate logic.

## 9. Required acceptance evidence

### A. Exact start observation and durable running

**Given** an active mounted Chat with one durable `attempt_starting` gen-1 claim and the private invocation admission. **When** P4c invokes the embedded session once with the observer armed. **Then** the sole journal reads back `armed` before the call, the one-shot `after_provider_response` fires (scripted fake runtime), the journal reads back exactly one `running` ledger with the bounded observation fact, and a fresh store/reopen sees the identical `running` ledger, the original player message/draft/idempotency receipt, and no second Host prompt invocation.

### B. Forbidden-evidence negatives

`before_provider_request` only, `before_provider_headers` only, `prompt()` settlement with a pre-send rejection, `agent_start`/`message_start` only, and any Host-inferred heuristic must each leave the ledger at `attempt_starting` (with or without `armed` per the window) — never `running`.

### C. Every crash window, deadline, and reopen classification

Deterministic interruption at W0–W4 plus a scripted live-process `not_started` refusal: each produces exactly the §4.3 classification, no generation 2, no automatic Host re-prompt, and no duplicate Host prompt invocation (fake provider asserts this Host-call boundary). Tests also prove: deadline expiry before arm causes zero write/zero prompt; expiry after arm but before prompt writes durable `not_started` only in the surviving callback; crash in that interval reopens `uncertain`; expiry after prompt or before running leaves `armed`/`uncertain` with zero second invocation; and a late observer after expiry has zero write.

### D. One winner, no replay, no escape

Concurrent P4c consumers: exactly one consumes the admission; every other path fails without a Host prompt invocation. A saved/replayed admission, a forged observer, a foreign-session observer, and a post-close consumer all fail closed with zero writes and zero Host prompt invocations. Close during the in-flight call drains, revokes unconsumed admissions, unregisters the observer, and releases resources only after the durable attempt (or its failure) resolves. Explicit tests cover `session_before_switch`, runtime-disposal unregister, and a late callback after unregister, each with zero durable write.

### E. Transaction integrity and budget

Every prepared-journal interruption point for arm/not_started/running, a foreign journal, malformed observation fields, and a mismatched thread/surface/selection/turn/message/key: state is exactly the prior committed state or exactly the transition state; invalid input has zero durable mutation; `turn-ledger.json` stays within the frozen 16 KiB budget (near-limit and over-budget fixtures from `design/67` B.7 continue to pass).

### F. Surface and emitted closure

Source scans prove: the P4c facade/bridge never imports `DialogueController`, `AgentSession`, browser/HTTP/SSE, presentation, cancel, or Memory surfaces; public leases expose no mutable session; the vendored observer is one-shot and schema-frozen; all three P4 roots are emitted/inventoried/rechecked and none is launchable.

## 10. Verification order

1. Coordinator deadline-scope tests (fixed internal mint only, no caller/browser injection; expiry before arm/prompt/running; no deadline-based re-prompt) plus vendored pi-plugin observer tests (one-shot, session-bound, status-class classification, no payload retention, `before_provider_request` IPC marker untouched).
2. Store transition/recovery/budget tests (arm/not_started/running, journal interruption points).
3. Coordinator capability tests (exclusive consumer, private session binding, close-drain, revocation, admission negatives).
4. Facade/bridge and source/emitted import-boundary negative fixtures.
5. Focused emitted tests serially after a fresh `host build:test`; cross-process coordinator tests remain serial.
6. Process-level reopen tests at W0–W4 with a scripted fake provider counting requests.
7. Production artifact/build tests, actual import-boundary check, Host typecheck/build-test, fresh production build and artifact recheck, `git diff --check`.
8. One fresh independent read-only review of the actual diff and evidence. A review cannot substitute for a failed/missing check.

## 11. Completion wording

Passing this card permits only:

```text
P4c provider-start observation and reopen classification frozen; implementation may begin after the P3.5 gate.
```

It does not permit `chat_core_reference_pipeline_v1 complete`, `chat_core_v1 released`, any Tavern-management claim, or any claim that provider acceptance, presentation, or completion is handled (P5 remains required).

## 12. P3.5 hard implementation precondition

This design is authored now, in a read-only authoring lane, without depending on P3.5 having passed. P4c **implementation** is hard-gated: no P4c code may start until the `design/67` P3.5 storage gate passes, including the `design/70` handle-bound helper and `design/72` native trusted-root/liveness closure, together with focused tests, Host typecheck/build-test, P3 browser typecheck/Playwright coverage, `git diff --check`, and one independent read-only review. P4c may not bypass a stuck durable owner with any local cleanup path.

## 13. Stop conditions and next decision

Stop this card and return a new prerequisite if a real provider invocation requires:

1. any requirement to classify a `prompt()` settlement without `after_provider_response` as provably not started; locked Pi 0.84.1 exposes no source-owned negative provider boundary, so P4c must keep that state `armed` and reopen it as `uncertain`;
2. a complete cross-process runtime-owner-death/reopen adjudicator for the stored owner tuple (a later card; P4c only supplies its classification input);
3. any prompt assembly, Memory access, presentation, cancellation, SSE/HTTP, or terminal-state behavior (P5/P6/P7/P8 owners);
4. a second attempt generation, an automatic re-prompt, or any durable writer other than `ChatThreadStore`.
