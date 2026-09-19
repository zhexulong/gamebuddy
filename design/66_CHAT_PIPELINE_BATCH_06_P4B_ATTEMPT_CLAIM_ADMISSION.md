# Chat Pipeline Batch 06 — P4b Durable Attempt Claim and Private Invocation Admission

**Status:** frozen implementation slice  
**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` §5.5, §7.2, §12 P4  
**Predecessor:** P4a durable acceptance, including P4a production-composition closure (`design/64`–`65`)  
**Release status:** non-release foundation. P2 Windows arbitrary-reparse live evidence remains a separate release blocker.

## 1. Truthful result

For a genuine currently mounted exact Chat with one P4a-durable `accepted_queued` turn, the Host can atomically claim **generation 1** of that exact turn, persist and read it back as `attempt_starting`, and create one private callback-scoped invocation admission for its current embedded runtime.

The result is deliberately narrower than a provider attempt:

- no `AgentSession.prompt()` call occurs;
- no `running` state is written;
- no provider effect, model acceptance, response, presentation, completion, cancellation, SSE, or browser operation is claimed.

The demonstrated P4b assertion is:

> Given a genuine active mounted lease and one durable `accepted_queued` turn, when P4b claims it, then exactly one durable `attempt_starting` record with generation `1` is read back and exactly one private, non-replayable runtime invocation admission is made available only during the approved callback. A restart or second claimant cannot mint generation `2` or invoke a provider.

The producer is the sole `ChatThreadStore` journal transaction; the consumer is the coordinator-owned callback admission; the verifier is exact state/journal read-back plus production-emitted import/artifact closure checks.

## 2. Scope

### In scope

1. Extend the sole `ChatThreadStore` TurnLedger from its P4a accepted form to a versioned discriminated union:

   ```text
   accepted_queued
     -- durable CAS + read-back --> attempt_starting (generation 1)
   ```

2. Store exactly one immutable attempt claim:

   ```ts
   type AttemptClaimV1 = Readonly<{
     generation: 1;
     attemptId: string;                 // store-minted opaque durable identifier
     claimedAtMs: number;
     selectionGeneration: number;
     runtimeBindingDigest: string;      // fixed SHA-256 binding digest
     runtimeOwner: Readonly<{
       ownerToken: string;
       runtimeInstanceId: string;
       ownerPid: number;
       ownerProcessStartIdentity: string;
     }>;
   }>;
   ```

   `attemptId` is an opaque durable audit/binding identifier. It is never projected to a browser and is not a reusable runtime capability. The existing accepted idempotency result remains its immutable P4a `AcceptedQueuedTurn` projection; it is not rewritten into provider status.

3. Add a separate P4b Host-internal facade and a single private bridge, shaped like P4a:

   ```text
   P4b facade
     → P4b private bridge
     → coordinator exact mounted-claim admission
     → sole ChatThreadStore claim transaction
   ```

4. Remove mutable `AgentSession` from the public `MountedChatRuntimeLease` surface. The public lease may retain only immutable, non-controlling runtime projection required by existing consumers (currently `piSessionId` and profile metadata if they pass their existing safe-use audit). The materializer/coordinator alone retain the actual session.

5. After durable claim read-back, have the coordinator mint a **process-local invocation admission** only inside a callback controlled by the private P4b bridge. It binds the same exact runtime and durable claim, is fieldless/opaque outside coordinator internals, one-shot, non-reentrant, non-replayable, revoked by lease close, and never persisted.

6. Retain the P4b facade/private bridge in the emitted Host artifact as additional non-launchable verification roots. The v2 production descriptor evolves from the P4a one-root list to the exact frozen ordered list:

   ```json
   [
     "tavern/p4-durable-turn-acceptance.js",
     "tavern/p4-provider-attempt.js"
   ]
   ```

   Both roots are included in closure, inventory, recheck, external-runtime scan, and emitted import-boundary inspection. Neither is a permitted launch entry.

### Explicit non-goals

- no `session.prompt`, `DialogueController.submit`, `DialogueController.stop`, direct Pi queue mutation, provider request, provider start receipt, `running` state, provider retry, or automatic resume;
- no provider/model/credential selection, endpoint configuration, prompt assembly, Memory materialization/delegation, player text reserialization, system/user Pi input, or legacy session use;
- no response/presentation tool admission, durable companion response, completion, cancellation command/CAS/abort, terminalization, SSE, HTTP, browser contract/UI, or submission-status route;
- no Chat selection/switch/lifecycle/management authority and no Chat↔Game origin, pause, stop, recovery, or state dependency;
- no second turn repository, event ledger, migration, compatibility layer, fallback, adoption, or read-repair;
- no owner-death recovery transition. An observed `attempt_starting` remains ambiguous and blocks automatic re-prompt.

## 3. Authority model

### 3.1 Durable authority

`ChatThreadStore` remains the only durable owner of transcript, draft, TurnLedger, idempotency, journal and recovery. It alone generates `attemptId`, writes `attempt_starting`, and validates the complete state after journal recovery.

The durable claim input is not browser- or arbitrary-caller-controlled. The private store ingress receives only coordinator-derived facts:

```text
runtimeRoot + full principal + exact Chat surface + selectionGeneration
+ runtimeBindingDigest + full runtime owner tuple
```

It validates all current P4a exact-thread/lifecycle invariants and requires the ledger to be exactly `accepted_queued`. It writes the full prepared state through the existing `transaction.json`, reads every owned artifact back, and only then returns the claimed record.

A second caller, concurrent claimant, saved callback, or restart cannot change the durable claim. The stable failure/result rule is:

- exact `accepted_queued`: one caller commits generation `1`;
- exact already-claimed state: fail `attempt_already_claimed` without minting a capability;
- any other/malformed state: fail closed;
- an accepted idempotency replay remains the original P4a acceptance receipt, never a route to a new claim.

### 3.2 Runtime authority

The coordinator owns the live materialized runtime/session and its construction facts. A mounted lease proves only the current exact mount to its approved consumers; it is not a prompt handle.

A P4b coordinator admission:

1. recognizes the WeakMap-branded active lease;
2. checks deployment `runtimeRoot` and every principal field before store I/O;
3. enters existing close-drained `begin()`;
4. derives runtime binding digest and complete owner tuple from the coordinator's current live runtime record, not from the lease, facade, bridge, browser, model, or store caller;
5. invokes the private bridge with a callback-scoped claim admission;
6. permits the bridge to consume the claim admission once and run the durable claim;
7. only after exact durable read-back mints a distinct callback-scoped invocation admission bound to the returned `{turnId, messageId, attemptId, generation, selectionGeneration, runtimeBindingDigest, runtimeOwner}`.

The invocation admission is intentionally not consumed by a provider in P4b. Its sole P4b consumer is a testable private no-effect callback that proves binding/lifecycle mechanics without accessing `AgentSession`. P4c may add the exclusive private session consumer only after it freezes source-owned provider-start semantics.

### 3.3 Lifecycle rules

- Forged, closed, stale, mismatched-root, mismatched-player, mismatched-companion, or mismatched-continuity leases fail before callback/store ingress.
- Claim and invocation admissions are opaque WeakMap-branded objects with no observable authority fields. They reject direct construction, saved replay, recursive/reentrant consumption, double consume, wrong callback scope, and post-close use.
- Lease/authority close revokes both unconsumed admissions before runtime resource close. A claim already admitted to `begin()` drains through durable read-back; close then completes. An unconsumed invocation admission cannot be used after close.
- The attempt record contains immutable audit/binding facts, never a reconstructible admission token. A new process reads `attempt_starting` but cannot mint an equivalent token or start a provider.
- P4b does not classify a runtime owner as dead. PID absence, in-memory state, timeout, a local WeakMap, or a new UUID never authorizes recovery. A later card must use an approved cross-process owner-death proof for any durable `failed`/`interrupted` reconciliation.

## 4. Durable schema and recovery contract

The TurnLedger and idempotency schemas must distinguish the immutable P4a accepted projection from the mutable live ledger:

```ts
type TurnLedgerV1 =
  | AcceptedQueuedTurn
  | Readonly<{
      turnId: string;
      status: "attempt_starting";
      idempotencyKey: string;
      messageId: string;
      acceptedAtMs: number;
      attempt: AttemptClaimV1;
    }>;
```

All existing turn integrity checks must compare the common immutable accepted projection (`turnId`, idempotency key, message ID, acceptance timestamp) rather than requiring the entire live ledger to equal the accepted idempotency result.

Prepared-journal recovery has only two valid outcomes for a claim crash boundary:

```text
pre-commit / rejected journal  → exact accepted_queued
post-commit prepared journal   → exact attempt_starting generation 1
```

It must never yield a partial attempt record, altered accepted idempotency receipt, duplicate player message, generation `2`, or an automatically launched prompt. Foreign/transplanted/malformed journals and attempt records fail before repair writes, preserving all artifacts byte-for-byte under the existing P4a no-write rule.

## 5. Mutation ownership

This is one connected authority/persistence/composition chain. It has **one writer** and no parallel source writers.

Owned production paths:

- `host/src/tavern/chat-thread-store.ts` and focused tests;
- new `host/src/tavern/p4-provider-attempt.ts`, `.internal.ts`, and focused tests;
- `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts` and focused tests;
- coordinator public type exports/tests only as necessary to remove public session control, never to add prompt control;
- `tools/check-host-production-import-boundary.{mjs,test.mjs}`;
- `host/tsconfig.production.json`;
- `host/production-artifact.config.json`;
- `host/scripts/production-artifact.{mjs,test.mjs}` and `host/scripts/build-production-artifact.test.mjs`.

No P4b writer may edit `dialogue-controller.ts`, browser files, routes, P3 composition, provider settings, Memory, Game files, or release-gate logic.

## 6. Required acceptance evidence

### A. Exact claim and reopen

**Given** an active genuine mounted exact Chat with one P4a durable `accepted_queued` turn.  
**When** P4b claims the queued turn.  
**Then** the sole journal commits and reads back exactly one `attempt_starting` ledger with generation `1`, one store-minted attempt ID, the exact current selection generation, runtime binding digest, and full immutable runtime owner tuple.  
**And** a fresh store/reopen sees the identical claimed ledger, the original one player message/draft/idempotency receipt, and no provider effect.

### B. One winner and no reissue

**Given** the scenario-A queued turn and concurrent P4b calls.  
**When** they race.  
**Then** exactly one claim commits and only that path receives a one-shot invocation admission. Every other call returns `attempt_already_claimed` (or the exact frozen equivalent) with no write and no capability mint.  
**And** a restart, replayed facade call, callback replay, or abandoned token cannot create generation `2` or invoke a provider.

### C. Binding and close

**Given** a genuine mounted lease.  
**When** root or any principal field differs, the lease is forged/closed, or close wins before admission.  
**Then** the coordinator callback count and raw-store ingress count are zero.  
**When** close begins after a claim has entered `begin()`.  
**Then** it waits for the durable claim read-back, revokes unconsumed invocation admission, and only then releases runtime resources.

### D. Transaction integrity

**Given** every prepared-journal interruption point, a foreign journal, malformed attempt fields, or a mismatched thread/surface/selection/turn/message/key.  
**When** recovery or claim runs.  
**Then** state is exactly queued or exactly claimed as appropriate; invalid input has no durable mutation; the P4a idempotency receipt remains the original accepted projection; no second repository or legacy draft path is consulted.

### E. Public and emitted authority closure

**Given** built source and published production artifact.  
**When** the source and emitted import/artifact guards inspect P4a and P4b.  
**Then** public mounted leases expose no mutable `AgentSession`; raw claim/store/coordinator minters/runtime session cannot be reached from a public facade except through the fixed private bridge/coordinator callback shape; both P4 roots are emitted/inventoried/rechecked; and neither P4 root is launchable.

## 7. Verification order

1. Add negative and recovery tests for the revised TurnLedger schema and store claim transaction.
2. Add coordinator capability/lease tests, including public `AgentSession` removal and close-drain behavior.
3. Add P4b facade/bridge topology tests and source/emitted import-boundary negative fixtures.
4. Update strict production descriptor/root tests before changing production config.
5. Run focused emitted tests serially after a fresh `host build:test`; cross-process coordinator tests remain serial to avoid artifact and mutex contention.
6. Run production artifact/build tests, actual import-boundary check, Host typecheck/build-test, a fresh production build and artifact recheck, then `git diff --check`.
7. Obtain one fresh independent read-only review of actual diff and evidence. A review cannot substitute for a failed/missing check.

## 8. Stop conditions and next decision

Stop this card and return a new prerequisite if a real provider call requires one of the following unresolved facts:

1. a source-owned invocation-start observation that distinguishes a provable pre-effect rejection from a request that may have escaped;
2. a complete cross-process runtime-owner-death/reopen adjudicator for the stored owner tuple;
3. a safe reason to expose, persist, reconstruct, or otherwise widen an `AgentSession`/provider control capability;
4. any prompt, response/presentation, cancellation, Memory, HTTP/browser, Game, or terminal-state behavior.

P4c, not P4b, must select the provider-start observation and define the `attempt_starting → running` transition. It may call the embedded session only through a new private, runtime-owned consumer of the P4b invocation admission. It must not use `DialogueController` as turn authority or treat `prompt()` promise settlement as provider-start evidence.
