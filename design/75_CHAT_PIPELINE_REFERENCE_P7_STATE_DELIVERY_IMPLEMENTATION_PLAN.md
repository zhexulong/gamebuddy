# Chat Reference-Pipeline P7 State Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the bounded `chat_core_reference_pipeline_v1` browser path: one already-mounted exact Chat can durably accept one message, execute the sole P4c/P5 provider path, render only durable read-backs, and recover the same terminal result after reload or Host restart.

**Architecture:** Keep `ChatThreadStore` as the only durable owner. Add a reference-pipeline state/service composition that consumes the existing P4a → P4b → P4c/P5 facades; it returns safe browser projections and launches the one provider runner only after the durable acceptance representation has reached the HTTP response path's server-side `finish`. The reference dispatcher is independent from the frozen P3 diagnostic dispatcher; a profile-selecting static composer uses exactly one dispatcher on one verified listener. Replace the P3-only production listener/browser wiring with this composed service, using bounded `GET /state` polling and no SSE.

**Tech Stack:** TypeScript 5.9, Node HTTP, TypeBox/Compile, React 19, Vite 8, Playwright, existing Windows handle-bound `path-lock` storage infrastructure.

**Spec:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` §§4.1a, 5–7, 10, P7/P10; `design/72_CHAT_PIPELINE_BATCH_08_P7_REFERENCE_PIPELINE_STATE_DELIVERY.md`; `design/69_CHAT_PIPELINE_BATCH_07_P4C_PROVIDER_START_OBSERVATION.md`; `design/71_CHAT_PIPELINE_BATCH_08_P5_PRESENTATION_COMMIT_AND_TERMINALIZATION.md`.

## Global Constraints

- This is the **reference-pipeline checkpoint**, not `chat_core_v1 released` and not a Tavern-management implementation.
- The composed profile is exactly `gamebuddy.chat-core.reference-pipeline` with `bootstrap`, `state.read`, `draft.read`, `chat.submit`, and `chat.submission_status`; it mounts no `chat.cancel`, draft-mutation or `events` route.
- `eventStream` is always `null`; do not create SSE, an `EventSource`, a stream epoch, a replay cursor, a poll-derived event, or a synthetic completion fact.
- Browser-visible state may change only from a validated `202 SubmitResultV1`, a validated `message-submission-status` response, or a validated complete `/state` snapshot. Never optimistically append a bubble or infer terminal state from timing.
- `ChatThreadStore` remains the sole durable writer. No new repository, event log, SQLite database, browser storage authority, raw transition import, post-hoc P5 start, second `session.prompt()`, prompt retry, or generation 2 is permitted.
- The service/transport/browser must preserve the exact mounted lease and selection generation; browser input may never select a root, thread, runtime, session, turn, attempt, binding, or provider.
- The provider attempt starts only after the `202` durable acceptance representation has been written and observed at the HTTP response path's server-side `finish`; response `error` or premature `close` leaves the turn accepted but unstarted. The service owns this one-shot continuation, retains/drains its commit/start work in `close()`, and the lease is released only after that drain succeeds.
- Poll complete snapshots at most once in flight: initial delay 250 ms, then 1 s, retryable error backoff 1/2/4/5 s; stop at terminal/null turn, identity mismatch, `401`, profile mismatch, or non-retryable problem.
- Reload uses the existing browser session cookie and never redeems bootstrap. Host restart uses one fresh launcher bootstrap token, re-reads the same durable thread, and never submits again automatically.
- `sessionStorage` can contain only `{ idempotencyKey, selectionGeneration, stateRevision, expectedDraftRevision }`; never persist player text, transcript text, CSRF/session tokens, raw IDs, provider data, prompt bytes, or source markers.
- Existing P6 browser cancel is intentionally unmounted by `design/72`; do not turn the coordinator-private P5 STOP seam into an HTTP route in this plan.
- All tests use synthetic/SFW data. A successful focused test does not authorize a release claim or substitute for the final fresh-root embedded runtime/browser journey.

---

## File Structure

| File | Responsibility |
|---|---|
| `host/src/tavern/reference-pipeline-state.ts` | Exact mounted durable read facade and safe `BrowserTurnV1`/message/operation projection. |
| `host/src/tavern/reference-pipeline-state.test.ts` | Projection matrix, post-await lease revocation, opaque turn handles, and reopen read-backs. |
| `host/src/tavern/chat-pipeline-service.ts` | Deep module that owns safe state/draft/submit/status composition and post-202 background P4c/P5 trigger/drain. |
| `host/src/tavern/chat-pipeline-service.test.ts` | Acceptance/idempotency/status/order/reopen behavior using real temporary `ChatThreadStore` and scripted runtime. |
| `host/src/dialogue-web.ts` | Frozen P3 diagnostic HTTP dispatcher; it does not accept reference service options. |
| `host/src/reference-pipeline-dialogue-web.ts` | Closed reference-profile HTTP dispatcher: session/auth/CSRF/strict body validation, validated service DTOs, and one service operation per domain route. |
| `host/src/reference-pipeline-dialogue-web.test.ts` | Reference HTTP profile/auth/CSRF/request/202/status mapping and no-direct-store boundary regressions. |
| `host/src/tavern/reference-pipeline-static-shell-composition.ts` | One verified static artifact plus one reference API listener; it owns no Tavern service logic. |
| `host/src/dialogue-web-main.ts` | Production composition: reference profile, current mounted lease, state facade/service, verified static artifact and listener. |
| `dialogue-web/src/reference-pipeline-api.ts` | Browser-only DTO validators/client. It imports no Host package or runtime code. |
| `dialogue-web/src/reference-pipeline-session.ts` | Pure identity-bound atomic snapshot/session-storage state reducer. |
| `dialogue-web/src/components/App.tsx` | Remove all mock management/message simulation and drive Chat UI only through the reference API/session state. |
| `dialogue-web/tests/reference-pipeline*.{mjs,ts}` | Browser reducer and composed real-listener journeys; no `page.route()` response mocks. |

### Public interfaces produced by the plan

```ts
export type ReferencePipelineStateFacade = Readonly<{
  read(): Promise<ReferencePipelineState>;
  readDraft(): Promise<BrowserDraftV1>;
}>;

export type ChatPipelineService = Readonly<{
  readState(): Promise<TavernStateSnapshotV1>;
  readDraft(): Promise<BrowserDraftV1>;
  submitMessage(command: SubmitMessageCommandV1): Promise<SubmitResultV1>;
  readMessageSubmissionStatus(query: MessageSubmissionStatusQueryV1): Promise<MessageSubmissionStatusV1>;
  close(): Promise<void>;
}>;

export type ReferencePipelineSession = Readonly<{
  snapshot: TavernStateSnapshotV1;
  pending: PendingSubmission | null;
  applySnapshot(snapshot: TavernStateSnapshotV1): ReferencePipelineSession;
}>;
```

`PendingSubmission` is exactly `{ idempotencyKey, selectionGeneration, stateRevision, expectedDraftRevision }`; it has no text field.

### Task 1: Safe reference-pipeline state projection

**Files:**
- Create: `host/src/tavern/reference-pipeline-state.ts`
- Create: `host/src/tavern/reference-pipeline-state.test.ts`
- Modify: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts` only to add `projectTurnHandle(turnId: string): string` to the already opaque `MountedChatBrowserProjection`.
- Test: `host/src/tavern/reference-pipeline-state.test.ts`

**Consumes:** Current coordinator-branded `MountedChatRuntimeLease`, `createChatThreadStore()`, `P3ExactChatStateFacade` read safeguards, and the complete `ChatTurnLedger` union.

**Produces:** `createReferencePipelineStateFacade(manifest, lease, profile)`; its `read()` result contains a complete safe transcript, draft, turn projection, and mounted operation projection. It never exposes durable IDs or a mutable store.

- [ ] **Step 1: Write failing ledger-projection tests**

```ts
test("reference state maps every durable ledger state through one opaque turn handle", async () => {
  const cases = [
    ["accepted_queued", "queued"], ["attempt_starting", "queued"], ["running", "running"],
    ["presentation_committed", "response_visible"], ["cancel_claimed", "stopping"],
    ["completed", "completed"], ["cancelled", "cancelled"], ["failed", "failed"],
  ] as const;
  for (const [durable, projected] of cases) {
    const state = await fixture.withLedger(durable).facade.read();
    assert.equal(state.turn?.state, projected);
    assert.equal(state.turn?.handle, fixture.lease.browserProjection.projectTurnHandle("turn_fixture"));
  }
});

test("reference state rechecks the coordinator lease after the durable read", async () => {
  await assert.rejects(fixture.readThenRevokeLease(), /reference_pipeline_state_unavailable/);
});
```

- [ ] **Step 2: Run the focused test to verify failure**

Run: `pnpm --dir host exec tsx --test src/tavern/reference-pipeline-state.test.ts`

Expected: module/function missing or assertions fail because P3 projects `turn: null`.

- [ ] **Step 3: Implement the minimal projection**

```ts
function projectTurn(lease: MountedChatRuntimeLease, ledger: ChatTurnLedger | null): BrowserTurnV1 | null {
  if (ledger === null) return null;
  const state = ledger.status === "accepted_queued" || ledger.status === "attempt_starting" ? "queued"
    : ledger.status === "presentation_committed" ? "response_visible"
    : ledger.status === "cancel_claimed" ? "stopping"
    : ledger.status;
  return Object.freeze({
    handle: lease.browserProjection.projectTurnHandle(ledger.turnId),
    state,
    projectionRevision: 1,
    canCancel: false,
    ...(ledger.status === "failed" ? { problemCode: ledger.reasonCode } : {}),
  });
}
```

Validate the entire returned browser projection with `TavernBrowserValidatorsV1`, read through `resumeThread`, verify the exact durable thread/binding, then recheck `isCurrentMountedChatRuntimeLease(lease)` after every await. Project `chat.submit` as `available` only when `turnLedger === null`; otherwise `busy`.

- [ ] **Step 4: Add projection/reopen/privacy negatives**

Add tests that verify: no ledger produces `turn: null`; a reopened store projects the same terminal message/turn; turn/message handles are not raw IDs; profile without `chat.submit` exposes no submit operation; a forged or closed lease causes no disk projection; and a failed projection emits no partial snapshot.

- [ ] **Step 5: Run the focused suite and typecheck**

Run:

```bash
pnpm --dir host exec tsc --project tsconfig.production.json --noEmit
pnpm --dir host exec tsx --test src/tavern/reference-pipeline-state.test.ts
```

Expected: both exit 0.

### Task 2: Deep `ChatPipelineService` acceptance/status composition

**Files:**
- Create: `host/src/tavern/chat-pipeline-service.ts`
- Create: `host/src/tavern/chat-pipeline-service.test.ts`
- Modify: `host/src/tavern/browser-contract/index.ts` only for missing exported static types; do not change route/schema shapes.
- Test: `host/src/tavern/chat-pipeline-service.test.ts`

**Consumes:** Task 1 state facade, `createP4DurableTurnAcceptanceFacade()`, `createP4ProviderAttemptFacade()`, `createP5PresentationCommitFacade()`, current lease and manifest.

**Produces:** `createChatPipelineService({ manifest, lease, profile, stateFacade })` with no repository/path/runtime fields in its public API.

- [ ] **Step 1: Write failing acceptance ordering tests**

```ts
test("submit returns the durable 202 projection before the sole provider start begins", async () => {
  const result = await service.submitMessage(command("ABEiM0RVZneImaq7zN3u_w"));
  assert.equal(result.disposition, "accepted");
  assert.equal(promptCalls, 0);
  await flushBackgroundAttempt();
  assert.equal(promptCalls, 1);
});

test("same key returns the immutable accepted result and starts no second provider attempt", async () => {
  const first = await service.submitMessage(command(key));
  const duplicate = await service.submitMessage(command(key));
  assert.deepEqual(duplicate, { ...first, disposition: "duplicate" });
  assert.equal(promptCalls, 1);
});
```

- [ ] **Step 2: Run the focused test to verify failure**

Run: `pnpm --dir host exec tsx --test src/tavern/chat-pipeline-service.test.ts`

Expected: missing module/service.

- [ ] **Step 3: Implement one service-owned submission sequence**

```ts
async submitMessage(command) {
  assertReferenceProfile(profile);
  assertSelectionGeneration(command.selectionGeneration);
  const accepted = await acceptance.accept({
    text: command.text,
    locale: command.locale,
    idempotencyKey: currentIdempotencyKey(),
    expectedDraftRevision: command.expectedDraftRevision ?? currentDraftRevision(),
  });
  const result = await stateFacade.projectAccepted(accepted, "accepted");
  void startAttemptAfterResult(accepted.turnId);
  return result;
}
```

Use the HTTP-derived idempotency key only at the transport-to-service boundary; the service must receive it in a private typed wrapper rather than read headers. `startAttemptAfterResult()` claims and invokes P5’s connected facade once for that exact accepted turn, stores its promise in a private set, never throws into the HTTP response, and `close()` waits for all settled promises. Existing durable read-back decides replay, busy, terminal, and failure semantics; do not keep a parallel in-memory turn authority.

- [ ] **Step 4: Implement durable status read-back**

Map only current exact-binding idempotency/ledger facts:

```ts
no matching durable key -> { apiVersion: 1, disposition: "unknown" }
matching key + nonterminal ledger -> { apiVersion: 1, disposition: "accepted", committedResult }
matching key + terminal ledger -> { apiVersion: 1, disposition: "terminal", committedResult }
```

Do not emit `expired` until its durable retention owner exists. A foreign/wrong-generation key is non-disclosing `unknown`. A same-key changed command uses the existing durable fingerprint conflict; it must not append, clear the draft, or invoke the provider.

- [ ] **Step 5: Add real-store acceptance/status/reopen tests**

Use a real temporary store and a scripted `RuntimeSession`; assert: wrong generation has zero mutation; concurrent other key gets turn-busy with zero append; terminal completion is read after reopen and has the same projected result; no raw IDs, provider data, prompt envelope or player text occurs in problems/log assertions; and `service.close()` drains an already admitted start.

- [ ] **Step 6: Run focused service checks**

Run:

```bash
pnpm --dir host exec tsc --project tsconfig.production.json --noEmit
pnpm --dir host exec tsx --test src/tavern/chat-pipeline-service.test.ts
```

Expected: both exit 0.

### Task 3: Reference HTTP profile and production composition

**Files:**
- Create: `host/src/reference-pipeline-dialogue-web.ts`
- Create: `host/src/reference-pipeline-dialogue-web.test.ts`
- Create: `host/src/tavern/reference-pipeline-static-shell-composition.ts`
- Modify: `host/src/dialogue-web-main.ts`
- Preserve: `host/src/dialogue-web.ts` and its P3 diagnostics unchanged
- Test: focused reference-dialogue-web/static-composition tests

**Consumes:** Task 2 `ChatPipelineService` and the existing one-time bootstrap/cookie/CSRF mechanisms.

**Produces:** A closed `gamebuddy.chat-core.reference-pipeline` listener. Each domain route maps to exactly one service call; the dispatcher imports no store, coordinator internal module, P4/P5 facade, or provider runtime.

- [ ] **Step 1: Write failing route/profile tests**

```ts
test("reference profile accepts a CSRF/idempotency protected message and returns exactly its 202 service result", async () => {
  const { cookie, csrf } = await bootstrap(server);
  const response = await postMessage(server, cookie, csrf, validCommand, validKey);
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, service.submitResult);
});

test("reference profile leaves cancel, events, and draft mutation unmounted", async () => {
  for (const request of [cancelRequest(), eventsRequest(), draftSaveRequest()])
    assertProblem(await request, 404, "profile_operation_unavailable");
});
```

- [ ] **Step 2: Run route tests to verify failure**

Run: `pnpm --dir host exec tsx --test src/dialogue-web.test.ts src/tavern/p3-static-shell-composition.test.ts`

Expected: P3 profile rejects `chat.submit` and service option is absent.

- [ ] **Step 3: Implement closed routing**

Create a separate `createReferencePipelineDialogueWebRequestHandler` rather than widening the P3 handler’s optional parameters. It must:

1. require the exact reference profile ordering;
2. preserve one-time bootstrap, HttpOnly Strict cookie, exact loopback Host/origin and response security headers;
3. require same-origin + session + CSRF + canonical `Idempotency-Key` for `POST /messages`;
4. validate body with contract validators before service invocation;
5. require session/same-origin and validate body for submission status (no CSRF);
6. return only contract-validated service results; and
7. map known service errors to their existing non-disclosing problem codes (all other failures become `runtime_unavailable`).

The dispatcher supplies a callback that resolves only when the 202 response reaches server-side `finish`; response `error` or premature `close` rejects it. The service invokes this callback once and retains the P4b/P5 start authority privately; the dispatcher does not call `start()`. The static composer must call the reference handler on the same verified listener and close its handler/service before releasing the mounted lease. A failed drain retains the lease for controlled retry.

- [ ] **Step 4: Replace production P3 wiring**

In `dialogue-web-main.ts`, compose the exact five-route profile, create the Task 1 state facade and Task 2 service after mounting the current lease, and launch the verified static artifact using the reference composition. Keep `P3` helpers/test-only P3 diagnostics intact; do not leave P3 as the production entry.

- [ ] **Step 5: Add HTTP security/recovery regressions**

Assert missing/foreign cookie, bad Origin, bad/missing CSRF, malformed/duplicate-key JSON, malformed idempotency key, wrong content type, invalid generation, and replayed bootstrap all fail before the service. Assert page reload uses `/state`/`/draft` and never bootstrap; a route body cannot select a turn/attempt/thread/root; handler close rejects new work and drains admitted service calls before lease close.

- [ ] **Step 6: Run focused Host checks**

Run:

```bash
pnpm --dir host exec tsc --project tsconfig.production.json --noEmit
pnpm --dir host exec tsx --test src/dialogue-web.test.ts src/tavern/p3-static-shell-composition.test.ts
node tools/check-host-production-import-boundary.mjs
```

Expected: all exit 0; production import boundary confirms HTTP code has no raw durable/provider ingress.

### Task 4: Browser-only validated state, submit, polling, and reload

**Files:**
- Create: `dialogue-web/src/reference-pipeline-api.ts`
- Create: `dialogue-web/src/reference-pipeline-session.ts`
- Create: `dialogue-web/tests/reference-pipeline-session.test.mjs`
- Modify: `dialogue-web/src/components/App.tsx`
- Modify: `dialogue-web/src/main.tsx` only if needed to install the reference entry
- Test: `dialogue-web/tests/reference-pipeline-session.test.mjs`, `dialogue-web/tests/reference-pipeline-browser.spec.ts`

**Consumes:** Browser wire shapes only. It must not import anything from `host/`.

**Produces:** A browser that renders one actual mounted Chat and has no mock conversations, local companion simulation, fake IDs, management drawers, fake persistence, or console-only operations.

- [ ] **Step 1: Write failing pure reducer tests**

```ts
test("applySnapshot atomically replaces only the same mounted identity", () => {
  const session = createReferencePipelineSession(snapshotA);
  assert.deepEqual(session.applySnapshot(snapshotA2).snapshot, snapshotA2);
  assert.throws(() => session.applySnapshot(snapshotOtherGeneration), /state_reconciliation_required/);
});

test("pending storage is content-free and only terminal read-back clears it", () => {
  const pending = pendingSubmission(key, snapshotA);
  assert.deepEqual(Object.keys(pending).sort(), ["expectedDraftRevision", "idempotencyKey", "selectionGeneration", "stateRevision"]);
  assert.equal(applyStatus(pending, acceptedStatus).pending, pending);
  assert.equal(applyStatus(pending, terminalStatus).pending, null);
});
```

- [ ] **Step 2: Run reducer tests to verify failure**

Run: `pnpm --dir dialogue-web exec node --test tests/reference-pipeline-session.test.mjs`

Expected: module/functions absent.

- [ ] **Step 3: Implement browser API and session reducer**

`reference-pipeline-api.ts` must validate exact reference-profile snapshots, drafts, submit results, statuses and RFC-9457-style problem containers before returning them. `reference-pipeline-session.ts` records the bootstrap identity fingerprint once, performs complete atomic snapshot replacement, rejects mismatch without clearing retry data, and exposes no mutable transcript merge operation.

The submit handler order is fixed:

```text
validated available snapshot -> write content-free pending key -> disable composer
-> POST /messages -> render accepted message/turn only from 202
-> start one bounded state poll -> terminal snapshot/status clears pending
```

Network failure keeps the key and calls status; it never creates a new key or locally appends text. `unknown` permits the same-key retry only after exact draft-read/revision reconciliation; terminal/expired/conflict outcomes follow `design/72` §6 exactly.

- [ ] **Step 4: Replace mock UI behavior**

Remove `setTimeout` companion responses, `Date.now()` browser message handles, mock conversation/companion/memory management state, local chat creation/switch/export/rename, and fake STOP. Render only the snapshot transcript and accepted response. Show the composer only if snapshot operations contains mounted `chat.submit` with `available`; otherwise render it disabled/absent. `isGenerating` derives only from nonterminal `chat.turn` and never uses a timer.

- [ ] **Step 5: Add real-listener browser tests**

Against the composed Host listener and shipped browser artifact (no `page.route()`): assert no optimistic player bubble before `202`; `queued → running → response_visible → completed` comes only from `/state`; no `EventSource` and no `/events`; polling stops after terminal; reload mid-turn resumes status/polling and reload terminal shows the same transcript without bootstrap; identity mismatch stops polling and submission.

- [ ] **Step 6: Build and run browser checks**

Run:

```bash
pnpm --dir dialogue-web run typecheck
pnpm --dir dialogue-web run build
pnpm --dir dialogue-web exec node --test tests/reference-pipeline-session.test.mjs
pnpm --dir dialogue-web exec playwright test tests/reference-pipeline-browser.spec.ts
```

Expected: all exit 0.

### Task 5: Fresh-root process closure and final reference-pipeline evidence

**Files:**
- Create: only an existing-test-style, non-production fixture/process test under `host/src/tavern/` or `host/tests/`; do not add a product route or test-only production facade.
- Modify: `host/production-artifact.config.json`, `host/scripts/production-artifact.mjs`, and tests only if the new reference facade needs a mandatory verification root.
- Test: production artifact, source boundary, Host/browser composed process journey.

**Consumes:** Tasks 1–4 and a synthetic fixture provisioner that uses canonical production owners only.

**Produces:** Evidence for the bounded P10 predicate, not a release claim.

- [ ] **Step 1: Write the failing fresh-root journey**

```ts
test("fresh owned root submits once, commits a companion result, reloads, restarts, and re-reads one terminal result", async () => {
  const first = await launchFreshReferencePipeline({ scriptedProvider: "one-response" });
  await first.browser.submit("Synthetic player request");
  await first.browser.expectTerminalTranscript();
  const beforeRestart = await first.browser.readVisibleState();
  await first.browser.reloadAndExpect(beforeRestart);
  const restarted = await first.restartWithFreshBootstrap();
  await restarted.browser.expectVisibleState(beforeRestart);
  assert.equal(restarted.provider.promptCalls, 1);
});
```

- [ ] **Step 2: Run the process test to verify failure**

Run the exact new test through the repository’s verified test-artifact builder and serial Windows runner.

Expected: failure before reference profile/service/browser composition exists.

- [ ] **Step 3: Implement only fixture wiring required by the journey**

The fixture may provision a synthetic Companion/exact selected Chat through canonical owners, start the embedded Host/SDK runtime with a scripted provider, and expose browser-observable redacted assertions. It must not write through a product-hidden setup endpoint, shell into an existing user Pi installation, use mock HTTP routes, or call raw store/P4/P5 transitions directly after setup.

- [ ] **Step 4: Prove artifact and static closure**

If any reference facade is public production composition, add it as an ordered mandatory verification root and add missing/extra/order-drift negative tests. Rebuild the immutable artifact; verify the static asset manifest and production import boundary. Do not treat a source-only module as shipped proof.

- [ ] **Step 5: Run the final verification set**

Run, serially where Windows helper/mutex fixtures require it:

```bash
node tools/check-host-production-import-boundary.mjs
pnpm --dir host exec tsc --project tsconfig.production.json --noEmit
pnpm --dir host run build:production-artifact
pnpm --dir host run test:reference-pipeline -- --test-concurrency=1
pnpm --dir dialogue-web run typecheck
pnpm --dir dialogue-web run build
pnpm --dir dialogue-web exec playwright test tests/reference-pipeline-browser.spec.ts
pnpm exec prettier --check host/src/tavern/reference-pipeline-state.ts host/src/tavern/chat-pipeline-service.ts host/src/dialogue-web.ts dialogue-web/src/reference-pipeline-api.ts dialogue-web/src/reference-pipeline-session.ts
git diff --check
```

Expected: every required command exits 0. If a broader project typecheck fails due to independent concurrent work, record exact unrelated files/errors and preserve the focused source/project evidence; do not suppress, cast around, or modify unrelated code to manufacture green.

- [ ] **Step 6: Perform one independent final review**

The review must inspect the actual diff and command output for: second provider invocation, post-hoc presentation path, browser optimistic render, browser-stored player text/tokens/raw IDs, profile-route mismatch, bypass of service/store authority, reload/restart duplicate submit, and an implicit SSE claim. A review cannot replace any failed or missing test.

## Self-Review

- **Spec coverage:** Task 1 covers P7 durable state/turn/operation projection; Task 2 covers post-202 provider ordering and idempotent/status recovery; Task 3 covers the exact mounted HTTP capability profile; Task 4 covers browser validation, no optimistic rendering, polling, reload and identity rejection; Task 5 covers fresh-root/restart/artifact closure. SSE, P6 browser cancel, draft mutation and management remain explicitly absent as required by design/72.
- **No placeholders:** Each task identifies exact files, interfaces, commands, assertions, and prohibited authority expansion. No task asks a worker to invent a route or second durable owner.
- **Type consistency:** The service retains the contract names `SubmitMessageCommandV1`, `SubmitResultV1`, `MessageSubmissionStatusQueryV1`, `MessageSubmissionStatusV1`, and `BrowserDraftV1`; all use `TavernStateSnapshotV1` and the existing mounted lease rather than duplicate DTOs.

## Execution Handoff

Plan complete and saved to `design/75_CHAT_PIPELINE_REFERENCE_P7_STATE_DELIVERY_IMPLEMENTATION_PLAN.md`.

Execution is already authorized by the ongoing reference-pipeline objective. Use `subagent-driven-development` task-by-task: one connected writer owns Tasks 1–3 (Host producer→consumer chain), a separate writer may own Task 4 only after Task 3’s exact wire contract is green, and one fresh read-only reviewer gates Task 5. Do not start P6 browser cancel or P8/P9 management in this plan.
