# P8 Memory Next-Round Runtime Evidence Bridge Implementation Plan

> **Status: Retired as execution authority.** This document records a proof-oriented next-round marker bridge. It is not a prerequisite for Chat or Memory behavior and must not be extended or used as a release gate. `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md` replaces it with ordinary safe Memory CRUD and standard end-to-end verification.
>
> **For agentic workers:** Do not execute unchecked tasks below; retain this file only as historical context.

**Goal:** Bind the existing player-Memory next-round evidence coordinator to the exact mounted Chat runtime and hold its prompt admission through the actual P4c `session.prompt()` invocation, without exposing a browser mutation route.

**Architecture:** The production Chat authority mints one random nonce before materialization and passes only its private marker callback into `SemanticChatRuntimeMountOptions`. Once materialization returns the actual `RuntimeSession.piSessionId`, the coordinator creates the exact `{ sessionId, nonceSha256 }` binding and is retained only in the coordinator-owned mounted-lease record. The P4c execution scope obtains a callback-scoped prompt permit from that private coordinator immediately before the sole `session.prompt()` call and releases it after settlement; marker payloads, correlation, receipts, nonce, session identity, source provenance, and vendor mutation facade never escape a Host-private boundary.

**Tech Stack:** TypeScript, Node test runner, Host semantic Chat coordinator, P4c/P5 provider execution, `@cortexkit/pi-magic-context` dynamic extension boundary.

**Spec:** `design/78_CHAT_PIPELINE_FULL_PRODUCT_IMPLEMENTATION_PLAN.md` Task 11; `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` P4c/P5; `design/74_CHAT_PIPELINE_P5_SOURCE_LINEAGE_PREREQUISITE.md`.

## Global Constraints

- The browser, browser contract, management dispatcher, React UI, profile route IDs, and deployment manifests are out of scope for this bridge.
- No Host or browser code may open or write Magic Context SQLite; only the existing vendor evidence facade is a future mutation owner.
- The exact provider binding must use the runtime-created `RuntimeSession.piSessionId`, `surface: "chat"`, and a Host-minted 64-hex nonce; no caller, fixture, random UUID, browser handle, or structural clone may supply those facts.
- Source markers stay local to the construction callback. Do not log, project, IPC-forward, persist, or return marker contents, correlations, receipts, session IDs, target memory identifiers, raw Memory content, provenance, or prompt content.
- `admitPrompt()` must be acquired after the final P4c admission recheck and immediately before the unique `session.prompt()` call; its release must run after prompt settlement on success, error, cancellation, observer failure, and close races.
- A missing, closed, invalid, or not-yet-bound evidence coordinator fails closed for any later evidence-backed mutation. Ordinary P4c execution remains valid when no Memory mutation is pending.
- Do not modify P6 cancellation, mounted Chat replacement, Chat creation/switch, Memory HTTP mutation, provider configuration, or fresh-root release gates.
- This repository has an intentionally dirty no-commit worktree: preserve unrelated hunks and do not reset/reformat files outside the owned paths.

---

## Frozen slice card

```text
User-visible result:
No newly visible browser control. The next real provider prompt on an exact mounted Chat becomes a trustworthy evidence settlement point for a future player-Memory mutation.

In scope / explicit non-goals:
In scope: nonce/callback construction, private per-lease coordinator binding to Pi session identity, P4c prompt permit lifecycle, close lifecycle, deterministic Host evidence tests.
Out: Memory mutation endpoint/UI/DTO, raw Memory display, direct SQLite, catalog management, Chat replacement, P6 cancel semantics, live provider gate.

Required topology and authority boundary:
Host production authority mints nonce -> runtime construction registers Magic Context marker callback -> actual runtime Pi session ID binds Host coordinator -> lease-private coordinator reaches P4 invocation scope -> exact P4c prompt holds/revokes permit -> source callback classifies marker locally. No consumer receives the coordinator or callback.

Acceptance scenario:
Given a mounted reference Chat whose runtime is constructed with P8 evidence armed,
When P4c reaches its final pre-prompt admission point,
Then it holds a private prompt permit through one real `session.prompt()` settlement,
And a pending mutation cannot be admitted while that permit is live.
Given source callback delivery with the exact session/nonce/correlation/receipt and a covered fresh round,
When it is collected by the private coordinator,
Then it releases the pending evidence only locally and a second mutation is eligible.
Given close or an invalid/replayed marker,
When a pending evidence operation or subsequent prompt tries to proceed,
Then the bridge fails closed and neither marker facts nor raw memory data escape.

Scenario-batch boundary:
Tasks 1–3 are one Host-only bridge batch. No mutation route may be added until all clauses and end-of-batch checks are green.

Cheapest checks:
Task 1: coordinator/materializer focused emitted tests.
Task 2: P4c execution focused emitted tests.
Task 3: production coordinator mounted-lifecycle focused emitted tests plus Host production/test TypeScript.

Mutation lanes and owned paths:
One connected Host writer owns all listed Host paths; no parallel writer touches these shared authority seams.

Independent read-only lane:
One final reviewer reads only the actual diff and test output to check nonce/session provenance, marker non-disclosure, permit release, and scope drift.

Launch budget:
One writer, one final reviewer, no live provider mutation, no browser mutation.

Stop/escalation condition:
Stop if the bridge requires exposing AgentSession, marker payload, callback registration after runtime construction, a browser-owned correlation, or an additional provider invocation. Record the missing owning-domain seam instead of adding a compatibility/fallback path.
```

## File structure

- Modify: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts` — own nonce allocation, marker-slot callback, post-materialization coordinator binding, lease-private coordinator lifetime, and callback-scoped P4 admission bridge.
- Modify: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.coordinator.test.ts` — deterministic mounted production lifecycle proof using a test materializer/runtime.
- Modify: `host/src/tavern/p4-provider-start-execution.ts` — acquire/release optional private evidence prompt permit around the actual unique `session.prompt()` line.
- Modify: `host/src/tavern/p4-provider-start-execution.test.ts` — assert acquire-before-prompt and release-after-settlement for fulfilled/rejected prompt paths without relying on timers.
- Modify only if direct exported type use requires it: `host/src/player-memory-next-round-evidence.ts` and `host/src/player-memory-next-round-evidence.test.ts` — retain the coordinator as the sole marker validator; do not add a mutation facade or browser API.

## Task 1: Mount a private, exact-session evidence coordinator

**Files:**
- Modify: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts`
- Test: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.coordinator.test.ts`

**Consumes:** `createHostChatRuntimeMaterializer(options)`, `SemanticChatRuntimeMountOptions.playerMemoryNextRoundEvidence`, `RuntimeSession.piSessionId`, and `PlayerMemoryNextRoundEvidenceCoordinator`.

**Produces:** A mounted-lease-private coordinator record and a callback-scoped function named `admitMountedPlayerMemoryNextRoundPrompt(leaseRecord)` (or a private equivalent) that returns `Promise<() => void>`. It is never exported through `MountedChatRuntimeLease`.

- [x] **Step 1: Add a deterministic failing mounted-lifecycle test**

Create a materializer test double that captures `options.playerMemoryNextRoundEvidence`, returns a runtime session with `piSessionId: "pi_p8_exact"`, and starts a mounted authority. Assert all of the following through a narrow test-only observation seam or source behavior, never a public lease field:

```ts
assert.equal(captured.nonceSha256.length, 64);
assert.match(captured.nonceSha256, /^[a-f0-9]{64}$/);
assert.equal(typeof captured.onSourceMarker, "function");
// Binding must use the runtime result, not a deployment or browser value.
assert.equal(observedBinding.sessionId, "pi_p8_exact");
assert.equal(observedBinding.surface, "chat");
```

Add a close test that starts an evidence wait, closes the mounted lease/authority, and proves the wait rejects with `memory_next_round_evidence_closed` rather than retaining a usable coordinator.

- [x] **Step 2: Run the test in red**

Run:

```bash
pnpm --dir host run build:test
node --test host/dist-test/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.coordinator.test.js
```

Expected: the new binding/lifecycle assertion fails because no nonce/coordinator exists in the mounted record.

- [x] **Step 3: Implement the smallest private bridge**

In `createFreshChatRuntimeAuthority` (and its known-runtime equivalent if it shares the same mount construction path):

```ts
const nonceSha256 = randomBytes(32).toString("hex");
let evidenceCoordinator: PlayerMemoryNextRoundEvidenceCoordinator | undefined;
const markerCallback = (marker: unknown): void => {
  evidenceCoordinator?.collectMarkerDecision(marker);
};
```

Pass only `{ nonceSha256, onSourceMarker: markerCallback }` to `createHostChatRuntimeMaterializer`. After `record.runtime.runtimeSession.piSessionId` is available and before minting the mounted lease, create:

```ts
evidenceCoordinator = new PlayerMemoryNextRoundEvidenceCoordinator({
  sessionId: runtimeSession.piSessionId,
  nonceSha256,
});
```

Store it in the private `MountedChatRuntimeLeaseRecord`, never in `MountedChatRuntimeLease`. On lease/authority close, invoke `evidenceCoordinator.close()` before runtime disposal can leave an active marker binding. If construction, binding, or close ordering cannot be proven, reject mount; do not leave a partially armed marker callback.

- [x] **Step 4: Run Task 1 green checks**

Run the command from Step 2 and:

```bash
pnpm --dir host exec tsc --project tsconfig.production.json --noEmit
pnpm --dir host exec tsc --project tsconfig.test.json --noEmit
```

Expected: focused mounted-lifecycle test and both typechecks pass.

## Task 2: Bind the private prompt permit to the unique P4c provider call

**Files:**
- Modify: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts`
- Modify: `host/src/tavern/p4-provider-start-execution.ts`
- Test: `host/src/tavern/p4-provider-start-execution.test.ts`

**Consumes:** Task 1’s lease-private coordinator and P4c’s existing `P4ProviderStartExecutionScope.assertAdmission()` / one `session.prompt()` boundary.

**Produces:** Optional `admitPlayerMemoryNextRoundPrompt(): Promise<() => void>` on the private P4c execution scope. The scope disappears after its callback returns and does not reveal coordinator state, nonce, or markers.

- [x] **Step 1: Add red P4c permit ordering tests**

Build a fake execution scope with a gate event log and a deferred prompt. Assert:

```ts
assert.deepEqual(events, ["assert-final", "memory-permit", "prompt-start"]);
releasePrompt();
await outcome;
assert.deepEqual(events, ["assert-final", "memory-permit", "prompt-start", "prompt-settled", "memory-release"]);
```

Add a rejected-prompt assertion that `memory-release` still occurs exactly once. Add a no-evidence scope assertion proving ordinary P4c behavior still invokes exactly one prompt and does not require a Memory coordinator.

- [x] **Step 2: Run the new test in red**

Run:

```bash
pnpm --dir host run build:test
node --test host/dist-test/tavern/p4-provider-start-execution.test.js
```

Expected: the new tests fail because P4c has no evidence-prompt permit callback.

- [x] **Step 3: Implement exact prompt permit ownership**

Add only this private callback to `P4ProviderStartExecutionScope` when its mounted lease has the coordinator:

```ts
admitPlayerMemoryNextRoundPrompt?: () => Promise<() => void>;
```

Immediately after P4c’s existing final `scope.assertAdmission()` and before assigning/calling `promptFn`, acquire it:

```ts
const releaseEvidencePrompt = await scope.admitPlayerMemoryNextRoundPrompt?.();
try {
  promptPromise = promptFn.call(/* existing arguments */);
  // retain all existing observation, P5, cancellation, and terminal logic
  await promptPromise;
} finally {
  releaseEvidencePrompt?.();
}
```

Preserve the current swallowed prompt rejection semantics and ensure release happens after the settled promise that P4c already awaits, not merely after scheduling it. If permit acquisition rejects due to close/pending uncertainty, execute the existing pre-invocation `not_started` path; do not call `session.prompt()`.

- [x] **Step 4: Run Task 2 green checks**

Run the Step 2 command and the existing connected P4/P5 suites selected by package script. Expected: every P4c/P5 test passes, including one-prompt and cancellation ordering tests.

## Task 3: Verify end-to-end private lifecycle and source-marker containment

**Files:**
- Modify only if tests need it: the files from Tasks 1–2.
- Test: same focused suites.

**Consumes:** Task 1 private marker binding and Task 2 exact prompt permit.

**Produces:** Evidence that marker reception settles a pending exact receipt only locally, reopens next mutation eligibility, rejects bad/replayed/closed marker cases, and no public lease/API includes raw facts.

- [x] **Step 1: Add mounted bridge regression tests**

Using the runtime-construction callback captured in Task 1:

1. Begin an evidence mutation through a test-private coordinator hook; commit the receipt; invoke `onSourceMarker` with a covered exact marker; assert a later mutation can begin.
2. Invoke a nonce-mismatched, replayed, content-bearing, or stale-round marker; assert the pending mutation stays pending and no source payload reaches a public result.
3. Hold the Task 2 prompt permit; assert a mutation admission rejects with `memory_next_round_evidence_chat_active`; release it; assert admission becomes possible.
4. Close before marker delivery; assert no subsequent admission or prompt permit succeeds.

Do not assert raw nonce/correlation/receipt values through HTTP, browser, logs, snapshots, or a public lease field.

- [x] **Step 2: Run focused emission and types**

Run:

```bash
pnpm --dir host run build:test
node --test \
  host/dist-test/player-memory-next-round-evidence.test.js \
  host/dist-test/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.coordinator.test.js \
  host/dist-test/tavern/p4-provider-start-execution.test.js
pnpm --dir host exec tsc --project tsconfig.test.json --noEmit
pnpm --dir host exec tsc --project tsconfig.production.json --noEmit
```

Expected: all targeted emitted tests and both TypeScript projects pass.

- [x] **Step 3: Run source-boundary and diff checks**

Run:

```bash
git diff --check -- \
  host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts \
  host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.coordinator.test.ts \
  host/src/tavern/p4-provider-start-execution.ts \
  host/src/tavern/p4-provider-start-execution.test.ts \
  host/src/player-memory-next-round-evidence.ts \
  host/src/player-memory-next-round-evidence.test.ts
rg -n "createGameBuddyPlayerMemoryEvidenceFacade|context\.db|MemoryCommandFacade|registerPlayerMemoryNextRoundMarker" host/src/tavern host/src/continuity-semantic-production-coordinator
```

Expected: the bridge has no direct vendor mutation facade/SQLite access, no browser ingress, and no public marker-registration bypass outside runtime construction.

## Task 4: Final review and controlled handoff to the later mutation slice

**Files:**
- Modify: `design/78_CHAT_PIPELINE_FULL_PRODUCT_IMPLEMENTATION_PLAN.md` only after all prior tasks are green.

**Consumes:** Tasks 1–3 evidence.

**Produces:** A precise P8 ledger update stating that the runtime-evidence bridge is released internally, while Memory mutation HTTP/UI remains unavailable until a separate service/route/read-back slice is approved.

- [x] **Step 1: Conduct one fresh read-only review**

Review actual diffs and literal command output against these blocking questions:

- Is the binding session ID sourced only from `RuntimeSession.piSessionId`?
- Does marker registration still occur at runtime construction, before Pi starts?
- Does the browser-facing lease expose no coordinator, callback, nonce, receipt, correlation, marker, or raw memory identity?
- Does every P4c prompt settlement release exactly one permit?
- Does close revoke evidence before runtime teardown and make later operations fail closed?
- Did any mutation route/UI, direct SQLite access, additional prompt call, fallback, or P6/P9 scope drift appear?

- [x] **Step 2: Update only the ledger truth**

If and only if the reviewer reports no blocker and all Task 3 commands pass, update P8 in `design/78...` to state: internal exact-next runtime evidence bridge released; player-visible mutation lifecycle remains unavailable/not released. Otherwise leave the ledger unchanged and record the exact failing assertion.

## Self-review

- **Spec coverage:** Task 1 covers exact construction/session/nonce provenance and close; Task 2 covers real P4c prompt admission; Task 3 covers marker correlation/replay/close and non-disclosure; Task 4 prevents a bridge from being misreported as the player-visible Task 11 lifecycle.
- **No placeholders:** Each task names owned files, APIs, exact behavior, and executable commands. No direct SQLite, mock source marker, or browser mutation is accepted as evidence.
- **Type consistency:** `PlayerMemoryNextRoundEvidenceCoordinator`, `SemanticChatRuntimeMountOptions.playerMemoryNextRoundEvidence`, `P4ProviderStartExecutionScope`, and `RuntimeSession.piSessionId` are existing source names; `admitPlayerMemoryNextRoundPrompt` is introduced in Task 2 and is private/callback-scoped thereafter.

## Historical handoff

This proposal is superseded by `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md`. Do not execute these tasks or use the bridge as a Chat/Memory prerequisite.
