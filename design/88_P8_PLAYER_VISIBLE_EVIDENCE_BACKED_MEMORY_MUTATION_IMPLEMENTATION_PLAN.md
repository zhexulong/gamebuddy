# P8 Player-visible Evidence-backed Memory Mutation Implementation Plan

> **Status: Retired as execution authority.** This document records an unimplemented evidence-backed Memory mutation proposal. Do not execute its tasks or make any Chat/Memory feature depend on its marker, nonce, receipt, attestation, or fresh-root gate. `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md` is the active plan and replaces this with ordinary safe Memory CRUD plus immediate read-back.
>
> **For agentic workers:** Do not execute unchecked tasks below; retain this file only as historical context.

**Goal:** Let a player on the mounted reference Chat create, update, archive, restore, pin, or unpin a governed Memory entry and receive only a fresh safe Memory read-back after the vendor commits the mutation under exact-next-provider-round evidence.

**Architecture:** The reference profile is the only current mounted product surface that both owns a real `chat.submit` path and can consequently settle the next provider round required by the vendor evidence facade. After materialization supplies the actual Pi session ID, the coordinator creates the vendor `GameBuddyPlayerMemoryEvidenceFacade` with that ID plus the construction bridge nonce, and stores it only in live/lease-private records keyed by the existing non-forgeable mounted lease. The coordinator owns opaque-handle resolution and raw vendor reads. Its narrowly typed Host mutation facade creates/commits the evidence correlation, invokes the already-bound vendor facade, and never reveals Pi session identity, nonce, marker, correlation, receipt, state token, raw Memory row, or provider facts. The Memory service only calls `mutate(command)` and then `read()` on that facade to produce the safe browser DTO.

**Tech Stack:** TypeScript (Node ESM), TypeBox/TypeBox Compile, existing semantic production coordinator WeakMap authority, Magic Context `@cortexkit/pi-magic-context` facade, React/Vite, Node `node:test`, Playwright/Chromium production-artifact harness.

**Spec:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` P8/P9; `design/78_CHAT_PIPELINE_FULL_PRODUCT_IMPLEMENTATION_PLAN.md` Tasks 6/11; `design/88_P8_PLAYER_VISIBLE_EVIDENCE_BACKED_MEMORY_MUTATION_IMPLEMENTATION_PLAN.md`.

## Global Constraints

- Use the existing `GameBuddyPlayerMemoryEvidenceFacade` exclusively. Host and browser must not read/write Magic Context SQLite or construct provider prompts.
- Use the existing exact mounted `MountedChatRuntimeLease`; a structural clone, stale/revoked lease, wrong profile, foreign continuity, or closed service fails closed before durable mutation.
- Actual Pi session ID, source-marker nonce, operation correlation, vendor receipt, vendor state token, expected state token, source refs, raw vendor Memory content, and provider materialization facts remain inside the coordinator-private lease record. The strict browser mutation command (including opaque handles/category where applicable) crosses into that record; only a safe `MemoryReadV1` projection crosses back out. The Memory service must never receive a raw vendor row, token, receipt, or mutation return value.
- The mutation operation is mounted only on `gamebuddy.chat-core.reference-pipeline`; do not add it to `tavern_management`, create a profile, add Chat open/switch, provider configuration, P6 cancel, or a compatibility/fallback path.
- The browser sends one typed command with same-origin session and CSRF. `memory.mutate` deliberately has no idempotency/replay key in the frozen route schema: after transport uncertainty it must not resend, and both success and failure reread authoritative `/state` then `/memory`.
- A mutation may begin only while the exact Chat has no active/draining turn, no pending Memory evidence, and no message-admission reservation. Task 1 must **add** (not merely claim) exact `admitMessage()` serialization: `acceptMountedP4DurableTurn()` acquires a lease-private message admission before its durable acceptance callback and releases it only after that callback settles. A submitted message waits for committed evidence activation; a rejected/closed mutation makes that submit fail closed before durable acceptance; while acceptance holds the reservation a mutation is rejected. P4c holds its distinct prompt permit through the one `session.prompt()` settlement.
- The final browser release claim requires one formal non-mutating live preflight and one controlled real embedded-provider mutation against a GameBuddy-owned fresh root and fresh immutable artifact. Test seams, injected markers, or direct durable writes cannot substitute for this gate.
- Do not commit, reformat unrelated dirty files, or change existing P8 Memory-read / World Info behavior while implementing this plan.

---

## Slice Card

**User-visible result:** On the reference Chat, a capability-gated Memory panel performs one supported mutation and replaces its Memory list from Host-authoritative durable read-back. The response proves only vendor durable commit plus evidence activation pending the next real provider round; that later round is the only settlement path. Neither evidence fact nor marker is rendered.

**In scope:** The six frozen browser command variants; the reference profile route/operation/state projection; Host-private coordinator facade; safe read-back; React controls; failure recovery; exact provider-evidence live gate.

**Explicit non-goals:** Management-profile mutation, Memory catalog/source-ref UI, merge/delete/exclude operations, direct SQLite, mutation-history/receipt UI, Chat open/switch/New Chat, P6 cancel, provider/model configuration, and full P10 fresh-root release.

**Required topology and authority boundary:**

```text
reference browser command
  -> same-origin + session + CSRF + strict DTO route
  -> MemoryManagementService (strict profile/DTO/read-back boundary only)
  -> coordinator WeakMap facade for the exact active lease
  -> private coordinator handle map (opaque handle -> vendor state token)
  -> PlayerMemoryNextRoundEvidenceCoordinator.beginMutation/commitMutation
  -> vendor GameBuddyPlayerMemoryEvidenceFacade mutation (receipt/value consumed and discarded inside coordinator)
  -> private vendor read projection -> safe MemoryReadV1 -> Memory service -> browser

later exact reference chat.submit
  -> coordinator-owned `acceptMountedP4DurableTurn()` acquires lease-private `admitMessage()` before durable acceptance
  -> activation succeeds: durable acceptance; mutation rejected/closed: fail closed before acceptance
  -> sole P4c `admitPrompt()` -> one session.prompt
  -> Host-private source marker bridge
  -> PlayerMemoryNextRoundEvidenceCoordinator settles / rejects evidence
```

**Acceptance scenario:** Given a fresh immutable reference artifact and one exact mounted Chat with a safe Memory projection, when the player sends a valid CSRF-protected mutation command while no turn is active, then the Host uses the same lease-bound private evidence facade and returns `{ apiVersion: 1, disposition: "committed", read }` only after vendor durable commit, evidence activation, and fresh safe reread. Here `committed` expressly does **not** mean marker evidence has already settled: the next real provider round must emit its valid covered marker for that private settlement. The browser replaces its projection without local mutation. A stale handle, active turn, lease close, vendor failure, conflicting mutation, or invalid/missing marker leaves the browser on a reread authoritative projection and does not expose internal facts.

**Producer → consumer → verifier:** coordinator lease-record authority produces a private mutation facade; Memory service consumes it to produce `MemoryMutationResultV1`; reference HTTP/state and browser consume only safe DTOs; Host contract tests, emitted service/handler tests, and Chromium assert the route/read-back/result without observing private evidence facts. Separately, the production source-marker callback updates a coordinator-private redacted attestation; a formal-gate-only probe created by the reference composition reads it through an internal exact-lease bridge and forwards only marker-decision category, accepted count, and opaque mounted-run reference to its Host-owned recorder. It is not a browser API, a receipt, or a test-marker substitute.

**Launch budget:** One connected Host writer for Tasks 1–3, then one frontend writer for Task 4, one fresh read-only final reviewer, and one formal live-mutation gate only after all non-mutating preflight clauses are green. No parallel writer may edit coordinator, Memory service, reference dispatcher, or browser contract while the connected Host writer owns them.

**Stop condition:** Stop and record a named owner prerequisite if a safe mutation cannot use the same lease/private coordinator as the real `chat.submit` path, if the vendor facade cannot provide a post-commit safe reread, or if real-provider preflight cannot prove the GameBuddy-owned root, artifact, profile, cleanup/retention policy, and exact postcondition.

## File Map

| Path | Responsibility |
|---|---|
| `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts` | Keep private `WeakMap` records authoritative; derive an unforgeable Host-only Memory facade whose `read()` projects safe rows and whose `mutate(browserCommand)` resolves opaque handles privately; create the vendor read/mutation facades only after real materialization; acquire/release message admission inside `acceptMountedP4DurableTurn()` before/after the durable callback; update/read the redacted formal-gate attestation through an internal exact-lease-only bridge. |
| `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.ts` | Export only the narrow `read(): Promise<MemoryReadV1>` / `mutate(command): Promise<void>` facade factory needed by the Memory service, never records, Pi session, marker bridge, nonce, correlation, receipt, state token, or coordinator. |
| `host/src/player-memory-next-round-evidence.ts` | Change `admitMessage()` into a close-aware one-shot reservation returning a release callback; track active message reservations alongside prompt permits so `beginMutation()` rejects both races. |
| `host/src/tavern/p4-durable-turn-acceptance.test.ts` | Mounted race coverage through the real `acceptMountedP4DurableTurn()` ingress: an admitting mutation blocks `chat.submit` before durable acceptance, commit releases exactly one acceptance, and reject/close fails it closed. |
| `host/src/magic-context-memory-facade.d.ts` | Declare only the vendor facade/read types actually loaded from the external runtime. |
| `host/src/tavern/memory-management/memory-management.ts` | For the mutation-capable reference profile, delegate safe `read()` and opaque-command `mutate()` to the coordinator facade; preserve the existing independent read-only implementation for management. It never resolves a raw vendor token. |
| `host/src/tavern/memory-management/memory-management.test.ts` | Mounted regression coverage for authority, handle resolution, active-turn/pending failures, receipt redaction, reread, lease revocation, and close. |
| `host/src/tavern/browser-contract/index.ts` | Give all mutation `content` fields a dedicated NFC UTF-8 4096-byte schema; register and export mutation schemas/types; correct the committed-result comment; and add the frozen `memory.mutate` route descriptor. |
| `host/src/tavern/browser-contract/index.test.ts` | Contract registry/validator regression, exported DTO type compile coverage, and strict 4096-byte mutation-text boundary regression. |
| `host/src/tavern/reference-pipeline-state.ts` | Project `memory.mutate` only when the composed reference profile declares it; do not fabricate Memory availability from browser state. |
| `host/src/reference-pipeline-dialogue-web.ts` | Authenticate/validate/dispatch `PUT /api/tavern/v1/memory`, map safe problem codes, and read the memory capability into `/state` snapshots; own/drain both Chat pipeline and Memory services before returning server close. |
| `host/src/reference-pipeline-dialogue-web.test.ts` | Request-level GET/PUT, CSRF, profile rejection, safe problem mapping, and success-result schema evidence. |
| `host/src/dialogue-web-main.ts` | Add the route/operation/navigation; inject the real Memory service only for the reference composition; and construct the formal-gate-only probe from its local exact lease and recorder callback. The dispatcher drains both services before lease closure. |
| `host/src/tavern/reference-pipeline-memory-mutation-formal-gate.internal.ts` | Formal-gate-only in-process probe created by the reference composition from its exact lease; imports only the coordinator's internal exact-lease attestation reader, forwards its three redacted fields to a Host-owned recorder callback, and never provides a browser/API/lease accessor. |
| `host/src/tavern/reference-pipeline-memory-mutation-formal-gate.test.ts` | Proves forged/revoked probes fail, the probe never leaks a lease/private fact, and only the composition-owned recorder receives the redacted record. |
| `dialogue-web/src/reference-pipeline-api.ts` | Strict browser mirror types/validators and exact GET/PUT Memory client methods. |
| `dialogue-web/src/reference-pipeline-session.ts` | Extend only the structural snapshot/operation mirror and preserve identity-checked atomic replacement. |
| `dialogue-web/src/components/ReferenceApp.tsx` | Capability-gated Memory panel, CSRF mutation dispatch, and mandatory `/state` + `/memory` read-back on all outcomes. |
| `dialogue-web/src/i18n.ts` | Add paired `en` and `zh-CN` labels for supported controls and non-disclosing recovery copy. |
| `dialogue-web/tests/reference-pipeline-api.test.mjs` | Strict DTO/client regression tests for Memory routes and rejection of unsafe shapes. |
| `dialogue-web/tests/reference-pipeline-browser.spec.ts` | Fresh immutable reference-artifact Chromium evidence for success/read-back and failure/read-back. |

## Task 1: Lease-bound private evidence mutation facade

**Files:**
- Modify: `host/src/tavern/browser-contract/index.ts`
- Modify: `host/src/tavern/browser-contract/index.test.ts`
- Modify: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts`
- Modify: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.ts`
- Modify: `host/src/player-memory-next-round-evidence.ts`
- Modify: `host/src/magic-context-memory-facade.d.ts`
- Test: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.coordinator.test.ts`
- Test: `host/src/tavern/p4-durable-turn-acceptance.test.ts`

**Interfaces:**
- Consumes: `MountedChatRuntimeLease`, coordinator-private `MountedChatRuntimeLeaseRecord.playerMemoryNextRoundEvidence`, `p4ProviderStartRuntimeSession`, and `resolveMagicContextExtensionEntry()`.
- Produces: registered/exported `MemoryMutationCommandV1` and `MemoryMutationResultV1`; `createMountedPlayerMemoryMutationFacade(lease: MountedChatRuntimeLease): MountedPlayerMemoryMutationFacade`; and a lease-private `admitMessage()` reservation used by the real P4 durable ingress. The facade accepts a strict browser mutation command, privately resolves only its current opaque handle, performs the vendor mutation, returns `void`, and exposes only safe `MemoryReadV1` from `read()`.
- Does not produce: any lease field, Pi session accessor, bridge/nonce accessor, raw vendor facade, state-token accessor, raw vendor row, marker payload, receipt, correlation, attestation, or browser-readable internal fact.

- [ ] **Step 1: Write failing contract and coordinator tests for exact-lease authority and redaction**

First add the strict contract test: `MemoryMutationCommandV1Schema` accepts exactly 4096 UTF-8 bytes of NFC content, rejects 4097 bytes/decomposed text/extra keys, both mutation schemas appear in `TavernBrowserContractV1.schemas` and `TavernBrowserValidatorsV1`, and exported `MemoryMutationCommandV1` / `MemoryMutationResultV1` type-check. Then add a mounted coordinator test that obtains a real lease, calls the new factory, and asserts these cases:

```ts
assert.throws(() => createMountedPlayerMemoryMutationFacade(forgedLease), /memory_mutation_unavailable/);
assert.throws(() => createMountedPlayerMemoryMutationFacade(closedLease), /memory_mutation_unavailable/);
const read = await mutationFacade.read();
const handle = read.memories[0]!.handle;
assert.equal(await mutationFacade.mutate({ apiVersion: 1, kind: "archive", handle }), undefined);
assert.doesNotMatch(JSON.stringify(observedServiceBoundary), /piSessionId|nonce|operationCorrelation|committedMemoryMutationId|stateToken|sourceRefs|raw vendor content/);
assert.equal("readMountedPlayerMemoryEvidenceAttestation" in publicCoordinatorModule, false);
```

Use injected **test-only vendor mutation/read dependencies inside the coordinator test seam**, not production callback parameters. Verify `beginMutation()` precedes the vendor mutation, its receipt is committed only after the vendor resolves, `vendorResult.value` is discarded in the coordinator, and any vendor rejection calls `rejectMutation()` so the lease-private message admission is not left blocked. The Memory service test must prove that it never receives a raw row/token/receipt. In the mounted P4 test, hold the injected vendor facade in admitting state and prove a concurrent reference `chat.submit` cannot create a durable message until commit; prove vendor rejection and lease close reject that submit without a durable acceptance.

- [ ] **Step 2: Run the focused test red**

Run:

```bash
pnpm --dir host build:test
node --test host/dist/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.coordinator.test.js
```

Expected: the new factory/type is absent and the new tests fail before an implementation exists.

- [ ] **Step 3: Implement the registered DTOs, message reservation, and narrow factory inside the coordinator authority boundary**

In the browser contract, add `MutationText` with the existing NFC/surrogate rules and a separate 4096-byte bound; replace each mutation `content: BoundedText` with it. Add both existing mutation schemas to `TavernBrowserContractV1.schemas`, export `type MemoryMutationCommandV1 = Static<typeof MemoryMutationCommandV1Schema>` and `type MemoryMutationResultV1 = Static<typeof MemoryMutationResultV1Schema>`, and correct the result comment: `committed` means vendor durable commit, evidence activation, and fresh safe reread—not later source-marker settlement.

In `PlayerMemoryNextRoundEvidenceCoordinator`, make `admitMessage(): Promise<() => void>` wait for an admitting mutation, reject on rejected/closed mutation, increment an active message-reservation counter, and return an idempotent release. Make `beginMutation()` reject while either message reservations or prompt permits exist. In `acceptMountedP4DurableTurn()`, after record/lease validation but before calling the durable acceptance callback, await that reservation; release it in `finally` after the callback settles. This is the only production `chat.submit` ingress, so it must be the seam tested—do not add an alternate service callback.

Add an exported Host-facing interface with this exact safe boundary; its arguments are the browser DTO, never Host-private vendor state tokens, and its mutation result is `void`: 

```ts
export type MountedPlayerMemoryMutationFacade = Readonly<{
  read(): Promise<MemoryReadV1>;
  mutate(command: MemoryMutationCommandV1): Promise<void>;
}>;
```

During `startChatRuntime()`, immediately after `bindToActualPiSession(piSessionId)` succeeds and before the live record is stored, dynamically load the already-resolved Magic Context entry and call:

```ts
const vendorFacade = bridge.createGameBuddyPlayerMemoryEvidenceFacade({
  continuityId: provision.principal.continuityId,
  runtimeCwd: provision.runtimeCwd,
  providerBinding: { sessionId: piSessionId, surface: "chat", nonceSha256: playerMemoryNextRoundBridge.nonceSha256 },
});
```

Validate only that this is an object exposing the six frozen methods and `close()`. Store it in `LiveChatRuntimeRecord`, pass it into the private mounted-lease record, and invoke `vendorFacade.close()` exactly once before `record.runtime.close()` on every teardown/failure path. If construction/validation fails after the vendor facade exists, close that facade once, close the bridge, and execute existing `closeAndFailChatRuntime()`; never mount a lease without the facade.

Create a private redacted attestation record before materialization. The production-only `onSourceMarker → collectMarkerDecision()` callback is its **only** updater: it writes the decision enum and increments the accepted count only for `"accepted"`; it retains no marker/prompt/receipt/correlation fact. Attach it to the live mounted-lease record only after actual-session binding succeeds. `createPlayerMemoryNextRoundRuntimeBridgeForTest()` must not wire this record and can never produce a Task 5 attestation. Export only an **internal-module** `readMountedPlayerMemoryEvidenceAttestationFromComposition(lease)` function that validates the exact current lease in the same private `WeakMap`, rejects forged/revoked/closed leases, and returns a frozen `{ mountedRunRef, markerDecision, acceptedMarkerCount }`. Do not export it from the public coordinator module, attach it to a lease, or make it a browser/state/HTTP surface.

For `mutate(command)`: locate the current branded lease record; reject when absent/inactive/closing; validate the registered DTO; resolve every target handle from the coordinator-private current handle map; verify no active/draining Chat turn through the existing durable state authority; call `beginMutation()`; invoke the already-bound private vendor facade with opaque evidence; call `commitMutation()` with its receipt; recheck lease activity after awaits; discard the vendor `value` and receipt; and map all internal/vendor failures to `memory_mutation_unavailable` without retaining an admitting evidence slot. `read()` owns vendor raw-row access, updates the private current handle map only after a successful safe projection, and returns only `MemoryReadV1`. Do not expose `PlayerMemoryNextRoundEvidenceCoordinator` or accept it as an argument.

Do **not** add a generic attestation reader in this task. The formal-gate-only redacted recorder is a Task 5 composition prerequisite because only `runReferenceProfile()` owns the exact lease; no external harness can supply or clone it.

- [ ] **Step 4: Verify the coordinator seam green**

Run:

```bash
pnpm --dir host build:test
node --test host/dist/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.coordinator.test.js
pnpm --dir host typecheck
```

Expected: test evidence proves forged/revoked leases fail closed, every method has begin → vendor receipt → commit ordering, rejection releases the admitting state, and no public lease shape changes.

## Task 2: Evidence-backed Memory service with safe post-commit read-back

**Files:**
- Modify: `host/src/tavern/memory-management/memory-management.ts`
- Test: `host/src/tavern/memory-management/memory-management.test.ts`

**Interfaces:**
- Consumes: Task 1's `createMountedPlayerMemoryMutationFacade`, registered/exported `MemoryMutationCommandV1`/`MemoryMutationResultV1`, and exact reference profile declaration.
- Requires from Task 1: the raw vendor evidence facade was already instantiated after real runtime materialization with `{ sessionId: actualPiSessionId, surface: "chat", nonceSha256: constructionBridgeNonce }`, is private to the exact lease record, and will close before runtime close.
- Produces: `MemoryManagementService.mutate(command: MemoryMutationCommandV1): Promise<MemoryMutationResultV1>`.
- Does not produce: raw state tokens, expected tokens, receipt IDs, evidence correlation, marker outcome, direct database handles, or a queued/pending browser disposition.

- [ ] **Step 1: Add red mounted service tests for each command family and all authority failures**

Extend the existing real mounted-child harness. Seed a test-only read projection with safe rows, but keep mutation authority behind the coordinator seam. Cover:

```ts
const result = await service.mutate({ apiVersion: 1, kind: "archive", handle });
assert.equal(result.disposition, "committed");
assert.equal(result.read.memories.find((m) => m.handle === handle)?.status, "archived");
assert.equal(JSON.stringify(result).includes("stateToken"), false);
```

Also cover create, update, restore, pin, unpin; unknown/stale opaque handle; invalid profile; active turn; existing pending evidence; vendor storage error; vendor conflict; lease revocation after vendor await; service close; and a post-commit `read()` failure. Every non-success must be an opaque `memory_mutation_unavailable` / `memory_mutation_pending` problem source and must not project a partial result.

- [ ] **Step 2: Run the service test red**

Run:

```bash
pnpm --dir host build:test
node --test host/dist/tavern/memory-management/memory-management.test.js
```

Expected: `mutate` does not exist and at least the success and stale-handle cases fail.

- [ ] **Step 3: Implement opaque handle resolution and reread-only mutation results**

The Memory service must not hold a handle→state-token map or raw vendor projection. For the mutation-capable reference profile it validates the registered command and delegates `mutate(command)` to Task 1's coordinator facade, then calls that facade's safe `read()` after it resolves. The facade alone resolves a target handle from its private current map; it rejects an unseen/stale handle and never recomputes a token from browser input. Before delegation require exact active lease, reference mutation profile, and a valid command schema:

```ts
return Object.freeze({
  apiVersion: TAVERN_BROWSER_API_VERSION,
  // "committed" means vendor durable commit plus activated next-round
  // evidence and a fresh safe reread; marker settlement is deliberately
  // private and remains pending until a later real provider round.
  disposition: "committed",
  read: await readFreshProjection(),
});
```

Validate `MemoryMutationResultV1Schema` before returning. Task 1's contract comment already defines this response: `committed` means vendor durable commit, evidence activation, and fresh safe reread; it must not claim marker settlement. Do not return the mutated row directly and do not create an event from unverified local data.

- [ ] **Step 4: Verify the focused Host service gate**

Run:

```bash
pnpm --dir host build:test
node --test host/dist/tavern/memory-management/memory-management.test.js
pnpm --dir host typecheck
```

Expected: all supported commands obtain a fresh safe projection only after commit; all failures preserve no partial browser DTO; source scanning still shows no direct SQLite/HTTP/vendor receipt leakage from the service.

## Task 3: Reference-profile contract, state, route, and composition

**Files:**
- Modify: `host/src/tavern/browser-contract/index.ts` (add route descriptor only; Task 1 owns schema registration/type exports/result-comment correction)
- Modify: `host/src/tavern/reference-pipeline-state.ts`
- Modify: `host/src/reference-pipeline-dialogue-web.ts`
- Modify: `host/src/reference-pipeline-dialogue-web.test.ts`
- Modify: `host/src/dialogue-web-main.ts`
- Modify: `host/src/tavern/reference-pipeline-static-shell-composition.ts`

**Interfaces:**
- Consumes: `MemoryManagementService.read/mutate`, existing `MemoryMutationCommandV1Schema`, current reference session/CSRF implementation, and composed reference profile.
- Produces: `PUT /api/tavern/v1/memory`, `memory.read` plus `memory.mutate` in the reference profile, and `memory` snapshot capability with authoritative read state.
- Does not produce: a management-profile mutation route, an idempotency key/replay policy (the frozen route remains `idempotency: "none"`), raw evidence data, or optimistic snapshot updates.

- [ ] **Step 1: Write handler-level red tests for real request semantics**

Build a reference profile fixture with both `memory.read` and `memory.mutate`, inject a strict fake `MemoryManagementService`, bootstrap a real browser session, and assert:

```ts
const response = await putMemory(validCommand, { origin, cookie, csrf });
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), committedResult);
assert.equal(service.mutateCalls, 1);
```

Add distinct tests for absent profile route/operation, missing Origin/session/CSRF, duplicate or malformed JSON, invalid union member/extra key, stale service problem mapping, and a success result containing a forbidden key. Assert no raw service error text appears in 409/503 bodies. Ensure `/bootstrap` and `/state` show `readAvailable`/`mutationAvailable` from actual successful service reads only, never literal booleans.

- [ ] **Step 2: Run handler tests red**

Run:

```bash
pnpm --dir host build:test
node --test host/dist/reference-pipeline-dialogue-web.test.js
```

Expected: route/profile assertion and `PUT /memory` request cases fail because the reference dispatcher does not mount the operation.

- [ ] **Step 3: Implement the exact route and projections**

Add this contract descriptor using the existing schema and CSRF-only headers:

```ts
route({
  routeId: "memory.mutate",
  method: "PUT",
  path: "/api/tavern/v1/memory",
  operationId: "memory.mutate",
  auth: "browser_session",
  origin: "same-origin",
  csrf: "required",
  idempotency: "none",
  headers: CsrfHeaders,
  pathParams: noPath,
  query: noQuery,
  request: MemoryMutationCommandV1Schema,
  success: { status: 200, contentType: "application/json", schema: MemoryMutationResultV1Schema },
});
```

Require both `memory.read` and `memory.mutate` in the reference profile; compose `MemoryManagementService` in `runReferenceProfile`; and pass it through the static-shell handler. `ReferencePipelineDialogueWebOptions` and its request handler own both `pipelineService` and `memoryService`: after rejecting new work and draining active dispatches, handler `close()` drains the pipeline service and then the Memory service, propagating either failure so the outer lifecycle retains the exact live lease for controlled retry. The static-shell composition continues to drain this one handler before releasing its listener. Extend `ReferencePipelineState` only with the safe Memory capability needed to project `memory.mutate` availability. `sendProjectedSnapshot()` must read service state, validate it, and use its projection revision; it must not derive availability from presence of an HTTP route alone.

At the handler, validate body against the route schema, authenticate Origin/session/CSRF, call `memoryService.mutate()` exactly once, validate `MemoryMutationResultV1Schema`, and map only named safe errors. It must never retry a request after any transport or service uncertainty because this frozen route has no idempotency/replay key:

```ts
memory_mutation_pending -> 409 memory_mutation_pending
memory_mutation_unavailable -> 503 memory_mutation_unavailable
storage-like failures -> 503 storage_unavailable
all other failures -> 409 state_reconciliation_required
```

- [ ] **Step 4: Verify the interlocked Host path**

Run:

```bash
pnpm --dir host build:test
node --test host/dist/tavern/memory-management/memory-management.test.js host/dist/reference-pipeline-dialogue-web.test.js host/dist/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.coordinator.test.js
pnpm --dir host typecheck
pnpm --dir host typecheck:test
```

Expected: the request tests demonstrate strict ingress, reference-only capability, safe result/read-back, and failure mapping; the three focused suites remain green together.

## Task 4: Strict reference browser consumer and artifact-backed journey

**Files:**
- Modify: `dialogue-web/src/reference-pipeline-api.ts`
- Modify: `dialogue-web/src/reference-pipeline-session.ts`
- Modify: `dialogue-web/src/components/ReferenceApp.tsx`
- Modify: `dialogue-web/src/i18n.ts`
- Test: `dialogue-web/tests/reference-pipeline-api.test.mjs`
- Test: `dialogue-web/tests/reference-pipeline-browser.spec.ts`

**Interfaces:**
- Consumes: strict `MemoryReadV1`, `MemoryMutationCommandV1`, `MemoryMutationResultV1`, snapshot `memory` capability, `PUT /api/tavern/v1/memory`, and CSRF token from the validated snapshot.
- Produces: a capability-gated read/mutate panel whose state is replaced only after authority reads.
- Does not produce: raw handles/state tokens/receipts, local Memory result synthesis, mutation retry after transport uncertainty, management UI, or a source-marker/provider status display.

- [ ] **Step 1: Add red strict API/session tests**

Extend the browser API tests with exact local mirrors that reject unknown fields and invalid opaque handles. Test success client transport:

```ts
await api.mutateMemory(command, { csrfToken });
assert.deepEqual(fetch.calls[0], ["/api/tavern/v1/memory", {
  method: "PUT",
  credentials: "same-origin",
  headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
}]);
```

Also test that a result containing vendor receipt/session/marker/state-token keys becomes `TavernProtocolError`, and that the session accepts a snapshot replacement only when its existing identity fingerprint matches.

- [ ] **Step 2: Run frontend tests red**

Run:

```bash
pnpm --dir dialogue-web test -- reference-pipeline-api.test.mjs
pnpm --dir dialogue-web typecheck
```

Expected: Memory types/client methods and the reference panel do not exist yet.

- [ ] **Step 3: Implement strict client, capability gate, and mandatory read-back**

Mirror the Host DTO unions exactly in `reference-pipeline-api.ts`, add `readMemory()` and `mutateMemory(command, { csrfToken })`, and validate every success/problem response. Extend the session types only enough to retain validated `snapshot.memory` and the `memory.mutate` operation.

In `ReferenceApp`, render no Memory control unless both `snapshot.memory.readAvailable`, `snapshot.memory.mutationAvailable`, and a `memory.mutate` operation with `availability: "available"` are present. Disable controls while a request is in flight. On **both** mutation success and caught failure, perform:

```ts
const snapshot = await api.readState();
const memory = await api.readMemory();
const next = current.session.applySnapshot(snapshot);
commit({ kind: "ready", session: next, draft: current.draft, locale: current.locale, memory });
```

If either reread fails, show the existing non-disclosing problem view. Do not mutate selected Memory state locally from command input or response. Add exact `en` and `zh-CN` labels for create/update/archive/restore/pin/unpin and temporary failure; no labels describe evidence or provider state.

- [ ] **Step 4: Add production-artifact Chromium tests, including failure recovery**

Use a fresh immutable artifact and its real reference fixture. First prove the capability is absent before the Host service reports it available. Then perform one supported mutation through the visible UI and assert network order `PUT /memory -> GET /state -> GET /memory`, the refreshed safe title/status/pin projection, and no selector/text exposes `piSessionId`, nonce, correlation, receipt, state token, or raw source refs. Add a content-lock/active-turn or stale-handle failure setup through existing production authority only; assert `409/503 -> GET /state -> GET /memory` and the prior authoritative Memory projection remains visible.

- [ ] **Step 5: Run bounded frontend and end-of-batch non-live gates**

Run serially:

```bash
pnpm --dir dialogue-web typecheck
pnpm --dir dialogue-web build
pnpm --dir dialogue-web test -- reference-pipeline-api.test.mjs
pnpm --dir host build:test
node --test host/dist/tavern/memory-management/memory-management.test.js host/dist/reference-pipeline-dialogue-web.test.js host/dist/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.coordinator.test.js
pnpm check:host-production-artifact
pnpm check:host-production-import-boundary
pnpm test:reference-pipeline-browser -- --grep "Memory mutation"
git diff --check -- host/src/continuity-semantic-production-coordinator host/src/tavern/memory-management host/src/tavern/browser-contract/index.ts host/src/reference-pipeline-dialogue-web.ts host/src/tavern/reference-pipeline-state.ts host/src/dialogue-web-main.ts dialogue-web/src/reference-pipeline-api.ts dialogue-web/src/reference-pipeline-session.ts dialogue-web/src/components/ReferenceApp.tsx dialogue-web/src/i18n.ts dialogue-web/tests/reference-pipeline-api.test.mjs dialogue-web/tests/reference-pipeline-browser.spec.ts
```

Expected: all focused static and browser gates pass against the same fresh artifact. This is still not the real provider mutation release claim.

## Task 5: Formal real-provider mutation preflight and one controlled gate

**Files:**
- Modify only when an executed gate produces a verified source/contract defect: the exact owner seam from Tasks 1–4.
- Modify: `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` and `design/78_CHAT_PIPELINE_FULL_PRODUCT_IMPLEMENTATION_PLAN.md` only after the controlled gate and final review.
- Create only after preflight confirms a canonical GameBuddy-owned fresh-root/provider harness: `host/src/tavern/reference-pipeline-memory-mutation-formal-gate.internal.ts` and its direct test.
- Consume (read-only): a redacted attestation produced only by the production source-marker callback. `runReferenceProfile()` creates the probe from its local exact lease and a formal-gate recorder callback; the probe calls the coordinator **internal** exact-lease reader and emits only `{ mountedRunRef, markerDecision, acceptedMarkerCount }`.
- Test/harness: existing GameBuddy-owned reference profile provider/browser harness; do not create a caller-owned fresh-root factory, externally pass/clone a lease, expose a browser/API reader, or give the test bridge access to the production attestation record.

**Interfaces:**
- Consumes: immutable Host/browser artifact from Task 4; existing production root admission; exact reference profile; embedded provider identity; real browser UI; real source marker; browser-observable safe postcondition.
- Produces: one privacy-safe evidence record stating only target artifact/profile/root admission, the coordinator's redacted marker-decision category/accepted count/opaque mounted-run reference, HTTP status/read-back, provider invocation count, and safe Memory projection postcondition.
- Does not produce: a second mutation to compensate for a failed run, raw prompt/transcript/model response, source marker, Pi session/nonce/correlation/receipt/state token, or cleanup of an unowned root.

- [ ] **Step 1: Record a non-mutating preflight checklist and run it**

Before mutation, record all literal results:

```text
[ ] selected root was created/admitted by an existing GameBuddy-owned fresh-root capability
[ ] root is not a caller-provided directory and no cleanup claim exceeds its ownership proof
[ ] immutable Host/browser generation passed artifact and import-boundary checks
[ ] reference profile declares chat.submit, memory.read, memory.mutate, and their real service composition
[ ] embedded provider fixture/provenance is exact and no user Pi installation/configuration is read
[ ] initial safe /state and /memory read passes contract validation
[ ] source marker producer is registered in the same mounted runtime as chat.submit
[ ] reference composition constructs the formal-gate-only in-process probe from its exact local lease; it invokes the coordinator internal reader, its recorder begins with `{ markerDecision: "none", acceptedMarkerCount: 0 }`, and it exposes no forbidden key or lease accessor
[ ] one exact postcondition is named: committed safe Memory projection is reread and next prompt count is one
[ ] failure retention/quarantine policy is known; no retry mutation is authorized
```

Expected: every item is externally verifiable before the one mutation. Any missing item blocks this task.

- [ ] **Step 2: Obtain one independent read-only review of the complete preflight and diff**

The reviewer must trace: browser command → dispatcher → Memory service → coordinator private facade → vendor commit → evidence activation → exact `chat.submit` P4c prompt → source marker → browser read-back. They must reject direct SQLite, raw authority disclosures, a test-only marker being treated as production evidence, a separate runtime, or a second prompt.

- [ ] **Step 3: Run exactly one controlled mutation and prove postcondition**

Use the UI to submit one supported command, then one legitimate reference chat message to settle the next round. Capture only redacted evidence:

```text
artifact/profile admission: pass
mutation HTTP disposition: committed
safe reread projection: pass
embedded provider prompt calls for the settling turn: 1
composition-owned formal-gate recorder: `{ markerDecision: "accepted", acceptedMarkerCount: 1, mountedRunRef: <opaque> }` (no marker payload or lease retained)
post-settlement safe reread/reload: pass
```

If provider settlement, marker validation, reload, or postcondition is ambiguous, mark the gate failed/uncertain and stop. Do not execute a replacement mutation.

- [ ] **Step 4: Run final review and update bounded ledger only on green evidence**

Run the Task 4 focused gates again serially plus the reviewed live-gate artifact. Update `design/40` and `design/78` to distinguish:

- released reference-profile evidence-backed Memory mutation slice, if and only if all Task 5 evidence is green;
- still incomplete management-profile Memory lifecycle, source/history UI, merge/delete/exclude, P6/P9/P10 and fresh-root full-product release.

## Self-Review

- **Spec coverage:** Task 1 adds the registered 4096-byte command/result DTOs, runtime-owned facade, durable-ingress message serialization, and no-return vendor boundary; Task 2 produces safe reread-only service results; Task 3 mounts the reference-only route/state; Task 4 proves browser recovery; Task 5 creates the formal-gate-only in-process recorder after canonical root/provider preflight. P9 management and full P10 are deliberately excluded and remain ledger items.
- **Placeholder scan:** No task relies on an unnamed route, generic error handling, synthetic evidence, or an unspecified test. Every task names paths, producer/consumer interfaces, focused commands, and assertions.
- **Type consistency:** Host exports only `MountedPlayerMemoryMutationFacade` with `read(): Promise<MemoryReadV1>` and `mutate(command): Promise<void>`; the coordinator owns all raw vendor facts and handle resolution. `MemoryMutationCommandV1`/`MemoryMutationResultV1` are registered/exported in Task 1. Service exports `mutate(command): Promise<MemoryMutationResultV1>`; the route consumes `MemoryMutationCommandV1Schema`; the browser client calls `mutateMemory(command, { csrfToken })`; all successful browser paths consume `MemoryMutationResultV1` and reread `MemoryReadV1`. Task 5's attestation reaches its recorder only from the exact in-process reference composition owner, never from a generic external lease reader.

## Historical Handoff

This proposal is superseded. Do not execute Tasks 1–5 or use its evidence-backed mutation topology. Current Memory work is defined exclusively by `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md`.
