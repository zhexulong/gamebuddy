# Chat Same-Selection Successor Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit a fresh Host process to remount one already-selected exact Chat only after that Chat's prior runtime has durably completed terminal teardown, without creating, guessing, switching, or replaying Chat content.

**Architecture:** Keep the semantic SQLite store as the sole durable lifecycle authority. A new coordinator-private, known-root composition consumes one explicit same-selection `select_chat` bridge; the store accepts that bridge only when the currently active exact Chat has one terminal predecessor teardown whose committed vector equals the bridge input. The existing successor admission then consumes that bridge to create the next mounted runtime. Browser, HTTP, provider, and P4/P5 paths only receive the ordinary new mounted lease.

**Tech Stack:** TypeScript 5.9, Node `node:sqlite`, existing semantic production coordinator, canonical Windows authority-root provisioning/mutex, current deployment artifact verification process.

**Spec:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` §§4.1a, P4, P5, P7, P10; `design/75_CHAT_PIPELINE_REFERENCE_P7_STATE_DELIVERY_IMPLEMENTATION_PLAN.md` Task 5; `design/72_CHAT_PIPELINE_BATCH_08_P7_REFERENCE_PIPELINE_STATE_DELIVERY.md`.

## Global Constraints

- The fresh semantic SQLite authority remains the only production authority. No legacy import/adoption, fallback, read-repair, dual root, or migration path may be added.
- A restart must not guess latest/name/title/index, accept caller-supplied raw identities, create a second Chat, re-run opening/content creation, replay player input, or invoke the provider again.
- The resulting runtime must be admitted through the existing `requireChatRuntimeSuccessorAdmission()` chain: terminal predecessor teardown → exact durable `select_chat` bridge → successor bootstrap.
- The same-selection bridge can be produced only under the authority-root mutex by the production coordinator. The browser, HTTP dispatcher, reference service, P4/P5 transition path, and test harness receive no raw store/provision/mutex capability.
- The bridge is legal only for the **current active** Chat and only where the terminal teardown's committed vector exactly equals the bridge's expected vector. Pending/recovery runtime or teardown is fail-closed.
- P7 reference profile stays exactly five routes and remains without `chat.cancel` or SSE. P6, P8, and P9 are out of scope.
- Existing close ordering remains `server → pipeline service drain → mounted lease → authority facade`; failed drain must retain the mounted lease.
- Tests use fresh synthetic GameBuddy-owned roots and existing Windows artifact/mutex protocols. Do not consult or use a system Pi installation, user data, or legacy continuity files.

---

## File Structure

| File | Responsibility |
|---|---|
| `host/src/continuity-semantic-store/continuity-semantic-production-store.ts` | Enforce exact same-selection bridge admission beside existing `select_chat` transaction and successor-chain validation. |
| `host/src/continuity-semantic-store/continuity-semantic-production-store.test.ts` | Store-level legal/illegal same-selection bridge matrix and no-mutation failures. |
| `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts` | Derive current selection internally, mint the bridge under the root mutex, and compose a known-root mounted Chat authority. |
| `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.ts` | Export only the production mounted known-root constructor; do not export bridge/store internals. |
| `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.test.ts` | Verify public surface and known-root construction guardrails. |
| `host/src/continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.ts` | Wrap the known mounted constructor without leaking authority internals. |
| `host/src/continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.test.ts` | Assert the deployment facade delegates only to approved fresh/known production constructors. |
| `host/src/dialogue-web-main.ts` | Select fresh or known-root composition only from a Host launch mode, preserve default fresh behavior and reference five-route profile. |
| `host/src/dialogue-web-main.test.ts` or existing process test boundary | Validate launch-mode parsing/default fail-closed behavior without adding a browser-controlled mode. |
| `host/src/tavern/*` Task-5 process test boundary | Run first terminal journey, cleanly stop, restart known root, read exact same durable terminal state/status, and prove one prompt call. |
| `host/production-artifact.config.json`, `host/scripts/production-artifact*.mjs` | Change only if a public shipped recovery module becomes a mandatory verification root; preserve artifact order and negative checks. |

### Authority flow

```text
first mounted runtime close
  → terminal `chat_runtime_torn_down` receipt/vector
  → fresh known-root Host composition
  → coordinator derives current exact active selection
  → store validates exact terminal-teardown vector and writes one `select_chat` bridge
  → existing successor admission verifies predecessor + bridge
  → existing binding/materializer creates the successor mounted lease
  → reference state/service/browser read durable state only
```

No stage accepts `chatThreadId`, `chatSurfaceSessionId`, vector, raw runtime identity, or provider fact from browser/HTTP input.

## Task 1: Durable same-selection bridge admission

**Files:**
- Modify: `host/src/continuity-semantic-store/continuity-semantic-production-store.ts`
- Modify: `host/src/continuity-semantic-store/continuity-semantic-production-store.test.ts`

**Consumes:** Existing `runChatCommand(..., "select_chat")`, `rejectChatRuntimeTransition()`, `chatRuntimeSuccessorAdmissions()`, and terminal teardown records.

**Produces:** A `select_chat` transaction targeting the current active selection is accepted only as the unique post-teardown successor bridge; all ordinary switching semantics remain unchanged.

- [ ] **Step 1: Write failing store tests for exact reentry admission**

Add fixtures that first establish an initial selected Chat, bootstrap/terminally teardown one runtime, then issue an exact `selectChat()` for that same active `(chatThreadId, chatSurfaceSessionId)` using the teardown committed vector.

```ts
test("same active Chat emits exactly one successor bridge after its terminal teardown", () => {
  const { store, principal, selected, teardown } = terminalTeardownFixture();
  const bridge = store.selectChat({
    operationId: "chat-reselect-successor-01",
    chatThreadId: selected.chatThreadId,
    chatSurfaceSessionId: selected.chatSurfaceSessionId,
    expected: teardown.vector,
  });
  assert.equal(bridge.kind, "select_chat");
  assert.deepEqual(bridge.activeSelection, {
    chatThreadId: selected.chatThreadId,
    chatSurfaceSessionId: selected.chatSurfaceSessionId,
    selectionRevision: teardown.vector.selectionRevision + 1,
  });
  assert.equal(store.prepareChatRuntime(successorRequest(bridge)).outcome, "effect_owned");
});

test("same active Chat bridge rejects absent, pending, recovery, wrong-vector, wrong-thread, and already-consumed predecessor", () => {
  for (const fixture of invalidReentryFixtures()) {
    const before = fixture.readBytes();
    assert.throws(() => fixture.selectCurrent(), /chat_runtime_reentry_selection_invalid|chat_runtime_transition_pending|chat_vector_conflict|chat_exact_binding_conflict/);
    assert.deepEqual(fixture.readBytes(), before);
  }
});
```

- [ ] **Step 2: Run the focused store suite and record the failing case**

Run the repository's supported emitted test-artifact flow, then run the emitted store test serially. Expected initial failure: current `selectChat` path either accepts the invalid same selection or no coordinator can produce it.

- [ ] **Step 3: Add the narrow store admission predicate**

Before `runChatCommand` mutates state for `kind === "select_chat"` and `oldSelection` exactly equals the requested Chat, require all of:

```ts
function requireSameChatRuntimeSuccessorBridge(
  db: DatabaseSync,
  principal: ProductionPrincipal,
  input: ProductionChatCommandInput,
  expected: SagaVector,
): void {
  const predecessors = /* terminal bootstrap rows bound to input's exact Chat */;
  const matches = predecessors.filter((predecessor) => {
    const teardown = /* terminal teardown with bootstrap_operation_id === predecessor.operation_id */;
    return teardown !== null
      && canonical(parse(teardown.committed_vector_json)) === canonical(expected)
      && predecessor.chat_thread_id === input.chatThreadId
      && predecessor.chat_surface_session_id === input.chatSurfaceSessionId;
  });
  if (matches.length !== 1) throw new Error("chat_runtime_reentry_selection_invalid");
}
```

Call it only after `rejectChatRuntimeTransition(db)`, exact principal/thread binding and vector equality have passed. It must not query a caller-provided predecessor ID. Preserve the existing command payload/schema as an ordinary `select_chat`, because that record is the successor chain's durable bridge.

- [ ] **Step 4: Add no-fork and materialization validation tests**

Cover: duplicate operation ID returns only its identical stored receipt; changed duplicate payload fails `chat_operation_conflict`; selecting a different verified Chat continues to work under existing semantics; a second same-selection bridge after the successor has begun is blocked by transition status; corrupt/ambiguous teardown rows fail materialization and create no bridge.

- [ ] **Step 5: Run store typecheck and emitted focused suite**

```bash
pnpm --dir host exec tsc --project tsconfig.test.json --noEmit
pnpm --dir host run build:test
node --test --test-concurrency=1 dist-test/continuity-semantic-store/continuity-semantic-production-store.test.js
```

Expected: all pass. If the artifact lock is held, wait for its legal owner rather than deleting/overriding the lock.

## Task 2: Coordinator-owned known-root mounted constructor

**Files:**
- Modify: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts`
- Modify: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.ts`
- Modify: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.test.ts`

**Consumes:** Task 1's store predicate, `openKnownProductionContinuityFromCanonicalAdmission`, `createChatRuntimeBinding`, and existing `createFreshChatRuntimeAuthority` lifecycle/close implementation.

**Produces:** `createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest, options)` which can mount exactly one successor lease after internally writing the legal bridge.

- [ ] **Step 1: Write failing coordinator surface and lifecycle tests**

```ts
test("known mounted Chat constructor opens only an existing authority, bridges the exact terminal selection, and starts one successor", async () => {
  const first = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest, scriptedOptions);
  const firstLease = await first.startMountedChatRuntime();
  await firstLease.close();
  await first.close();

  const resumed = await createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest, scriptedOptions);
  const secondLease = await resumed.startMountedChatRuntime();
  assert.equal(secondLease.chatThreadId, firstLease.chatThreadId);
  assert.equal(secondLease.chatSurfaceSessionId, firstLease.chatSurfaceSessionId);
  assert.equal(secondLease.selectionGeneration, firstLease.selectionGeneration + 1);
  await secondLease.close();
  await resumed.close();
});

test("known mounted constructor rejects fresh roots, nonterminal teardown, and a second successor", async () => {
  await assert.rejects(createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(freshManifest), /chat_runtime_reentry_selection_invalid/);
  // independent fixtures assert pending/recovery and already-successor paths likewise fail closed
});
```

- [ ] **Step 2: Run the focused test and verify failure before implementation**

Run the test project compilation and emitted coordinator suite. Expected failure: missing constructor and/or missing same-selection bridge admission.

- [ ] **Step 3: Implement coordinator-private bridge production and known opening**

Add an internal semantic-authority method that reads the catalog under `locked`, requires its exact active Chat to be active and content-verified, derives a deterministic `chat-reselect-*` operation ID from the branded holder/current vector/selection, then calls `provision.store.selectChat()` with no caller-supplied identifiers.

```ts
const reselectTerminalChatRuntimeSuccessor = () => begin(() => locked(() => {
  const catalog = provision.store.readChatCatalog();
  const target = catalog.activeSelection;
  const thread = target && catalog.threads.find((candidate) =>
    candidate.chatThreadId === target.chatThreadId &&
    candidate.chatSurfaceSessionId === target.chatSurfaceSessionId &&
    candidate.lifecycle === "active" && candidate.contentState === "verified",
  );
  if (!target || !thread) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_successor_target_unavailable");
  return provision.store.selectChat({
    operationId: nextChatOperation("reselect", catalog, thread),
    chatThreadId: thread.chatThreadId,
    chatSurfaceSessionId: thread.chatSurfaceSessionId,
    expected: { ...catalog.vector },
  });
}));
```

Use it only from `createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest()`:

```ts
const provision = await openProvisionWithAdmission(
  () => openKnownProductionContinuityFromCanonicalAdmission(input, admission),
  admission.authorityRootIdentity,
  mutex,
);
const semantic = create(provision, mutex);
await semantic.reselectTerminalChatRuntimeSuccessor();
const binding = await createChatRuntimeBinding(manifest);
return createFreshChatRuntimeAuthority(provision, semantic, binding, mutex, broker, options);
```

Mirror the existing cleanup behavior exactly. Never call fresh provisioning or initial-chat initialization on this path. Export only the top-level known mounted constructor from the public coordinator module; `reselectTerminalChatRuntimeSuccessor`, `provision`, store, mutex and binding remain internal.

- [ ] **Step 4: Add authority negative tests**

Verify: public coordinator exports no raw bridge producer; forged semantic authority objects cannot produce a bridge; close begins before bridge/start causes no write; binding/materializer failure after bridge leaves the existing runtime failure state and does not mint a lease; repeated known constructor has no second effect due exact durable command/readback rules.

- [ ] **Step 5: Run focused coordinator verification**

```bash
pnpm --dir host exec tsc --project tsconfig.test.json --noEmit
pnpm --dir host run build:test
node --test --test-concurrency=1 dist-test/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.test.js
```

Expected: all pass.

## Task 3: Deployment/production launcher selection

**Files:**
- Modify: `host/src/continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.ts`
- Modify: `host/src/continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.test.ts`
- Modify: `host/src/dialogue-web-main.ts`
- Modify/Create: the existing focused `dialogue-web-main` test boundary

**Consumes:** Task 2's public known mounted constructor and existing reference static-shell lifecycle.

**Produces:** A Host-only explicit launch mode: default fresh mode creates a fresh root; known mode invokes the known-root constructor. No HTTP/browser field can select the mode.

- [ ] **Step 1: Add failing facade and launcher mode tests**

```ts
test("known deployment Chat facade delegates only to the known production mounted constructor", async () => {
  const source = readFileSync(chatFacadeSource, "utf8");
  assert.match(source, /createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest\(manifest, options\)/);
  assert.doesNotMatch(source, /openKnownProductionContinuityFromCanonicalAdmission|\.store|createWindowsAuthorityRootMutex/);
});

test("dialogue launcher defaults to fresh and accepts only Host process known recovery mode", () => {
  assert.equal(parseDialogueLaunchMode([]), "fresh");
  assert.equal(parseDialogueLaunchMode(["--known-root-recovery"]), "known");
  assert.throws(() => parseDialogueLaunchMode(["--known-root-recovery", "--unknown"]), /dialogue_launch_mode_rejected/);
});
```

- [ ] **Step 2: Implement thin facade and strict launch mode parser**

Add `createKnownUnmountedChatSemanticFacade(manifest, options)` which delegates only to Task 2's constructor and returns the same opaque constructed facade type. In `dialogue-web-main.ts`, parse only a fixed process argument (`--known-root-recovery`) before reading the manifest; default is fresh. Choose the constructor once before mounting. Do not put this value in query parameters, fragment, cookies, bootstrap payloads, browser state, manifest, environment fallback, or HTTP routes.

- [ ] **Step 3: Preserve existing runtime close ordering and profile**

Keep `composeTavernProfile` identical: five route IDs, only `chat.submit`, `eventStream: null`, no cancel. Keep the existing `try/finally` and `closeReferencePipelineRuntime` call unchanged except its facade union type.

- [ ] **Step 4: Run source and focused composition tests**

```bash
pnpm --dir host exec tsc --project tsconfig.test.json --noEmit
pnpm --dir host run build:test
node --test --test-concurrency=1 dist-test/continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.test.js
```

Expected: all pass.

## Task 4: Task-5 fresh-root restart verifier

**Files:**
- Modify/Create only at an existing P7 Host process test boundary and its fixture helper.
- Modify production artifact configuration/scripts only if a newly shipped module is actually required as an independent verification root.

**Consumes:** Tasks 1–3, existing mounted scripted-provider fixture, reference state facade/service, immutable artifact and Windows helper publication protocol.

**Produces:** Process evidence for `TCP-REC-001`: exact terminal state survives clean Host restart and the provider start count remains one.

- [ ] **Step 1: Write failing two-process restart journey**

```ts
test("fresh root terminal Chat restarts through known root and re-reads one terminal result without a second prompt", async () => {
  const first = await launchFreshReferencePipelineWithScriptedProvider();
  const accepted = await first.submitOnce();
  const terminal = await first.awaitTerminalState(accepted);
  const exactBefore = await first.readStateAndSubmissionStatus(accepted.idempotencyKey);
  assert.equal(first.promptCalls(), 1);
  await first.close();

  const restarted = await launchReferencePipelineKnownRoot(first.manifestPath);
  const exactAfter = await restarted.readStateAndSubmissionStatus(accepted.idempotencyKey);
  assert.deepEqual(exactAfter, exactBefore);
  assert.equal(restarted.promptCalls(), 1);
  await restarted.close();
});
```

Assert actual opaque state/status projections, not raw store rows. The fixture may use one synthetic embedded provider during initial launch, but the restarted Host must not call it.

- [ ] **Step 2: Add destructive and lifecycle negatives**

Prove: fresh launch against an existing root fails; known restart before clean terminal teardown fails; known restart after teardown failure preserves the first lease (no successor bridge/mount); restart cannot add opening/player/companion messages; duplicate submit/read does not produce a second provider start; legacy artifact roots remain rejected.

- [ ] **Step 3: Rebuild the immutable test artifact and run emitted journey serially**

```bash
pnpm --dir host run build:test
node --test --test-concurrency=1 dist-test/<actual-task-5-emitted-test>.js
```

Use the existing published Windows stale-lock reclaimer and broker sidecar from the generated artifact. Never run competing `build:test` instances or manually remove the artifact lock.

- [ ] **Step 4: Verify production artifact closure only if needed**

If Task 3 only changes already-mandatory `dialogue-web-main.js` and coordinator/facade import closure, do not add a ceremonial verification root. Otherwise add the new actual shipped entry in order to the artifact descriptor plus missing/extra/order negative tests, rebuild, then run:

```bash
pnpm --dir host run check:production-artifact
node tools/check-host-production-import-boundary.mjs
```

- [ ] **Step 5: Run cumulative affected checks**

```bash
pnpm --dir host exec tsc --project tsconfig.test.json --noEmit
pnpm --dir host exec tsc --project tsconfig.production.json --noEmit
pnpm --dir host run build:test
node --test --test-concurrency=1 dist-test/<actual-task-5-emitted-test>.js
pnpm --dir dialogue-web run typecheck
pnpm --dir dialogue-web run build
pnpm --dir dialogue-web exec playwright test tests/reference-pipeline-browser.spec.ts
node tools/check-host-production-import-boundary.mjs
pnpm --dir host run check:production-artifact
git diff --check
```

Record exact unrelated failures rather than changing other dirty files.

## Self-Review

- **Spec coverage:** Task 1 establishes one durable exact same-selection bridge; Task 2 prevents callers from minting it and creates only an existing successor lease; Task 3 makes known-root mount an explicit Host start decision, never a browser input; Task 4 proves terminal restart/state/provider invariants on production-shaped process composition.
- **No placeholders:** Every task names exact owner files, invocation shapes, admission conditions, error behavior, and validation commands. The emitted Task-5 file remains intentionally determined by the existing P7 process-test boundary rather than creating a parallel runner.
- **Type consistency:** `ProductionChatCommandReadback`, `SemanticProductionAuthority`, `SemanticChatRuntimeProductionAuthority`, and `MountedChatRuntimeLease` remain existing types. The proposed `createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest` mirrors the current fresh constructor and returns the same authority type.
- **Non-goals preserved:** No new durable owner, direct store ingress from consumer code, raw identity leakage, P6 cancellation, SSE, legacy support, or Tavern-management operation is introduced.

## Execution Handoff

Plan complete and saved to `design/77_CHAT_SAME_SELECTION_SUCCESSOR_RECOVERY_IMPLEMENTATION_PLAN.md`. Execute it now through a fresh subagent per task, with a read-only review after Tasks 2 and 4. Do not start P6 browser cancel or P8/P9 management in this plan.
