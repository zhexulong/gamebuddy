# Stardew Operational Gate Product Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the production operational Game gate from caller-selected operator bridge configuration to a one-shot, headless consumer of the same product-owned Stardew lifecycle, installation registration, and task-ingress authority used by the shipped Game product.

**Architecture:** The production child loads a verified deployment-manifest reference and receives an operational nonce only. A coordinator-private headless admission consumes one fresh `AdmittedStardewInstallation` through the completed Design 101 registration owner, then follows the existing Player Host launch/attestation → AI attach → Design 99 materializer → durable `runEnter()` → committed ingress sequence. Existing `production-game-task-ingress` remains the only ready/dispatch/evidence channel. The runner never supplies a bridge, process, installation, profile, or capability fact.

**Tech Stack:** TypeScript/Node ESM, `StardewProductionLifecycleCoordinator`, Design 99 materializer, Design 101 registration owner, Design 102 guardian containment, deployment-manifest verifier, production artifact wrapper, existing private task ingress and Node `node:test` compiled artifacts.

**Spec:** `design/100_STARDEW_OPERATIONAL_GATE_PRODUCT_COMPOSITION_DESIGN.md`

## Entry Gate — Do Not Begin Implementation Earlier

Before any file outside this plan is edited, record all of the following:

1. independently reviewed Design 102 containment/recovery closure, including two-role recovery and guardian-lease race evidence;
2. independently reviewed **Design 101 registration closure** as defined in `design/101_STARDEW_PRODUCT_INSTALLATION_REGISTRATION_IMPLEMENTATION_PLAN.md`;
3. current immutable Host artifact verification for the exact guardian/registration generation;
4. an exact target product runtime partition with no active/quarantined registration fence; and
5. a fresh review confirming the production artifact's `main.ts` branch cannot fall back to operator-selected bridge construction; and
6. explicit claim scope: Game operational/live evidence only, or Desktop Player Release. The latter additionally requires Design 103/104 closure; this plan cannot supply that evidence.

If any entry condition is absent, report the existing redacted composition blocker. Do not manufacture a config, re-use Preview state, call a browser endpoint, or perform a Task 11 mutation.

## Global Constraints

- This plan is the only authorized home for operational-gate migration. Design 101 stops at registration closure.
- The coordinator remains the only lifecycle owner: Stage C/D, Player Host attestation, AI attachment, Design 99 materialization, Game enter, STOP, disconnect, quarantine, and reverse teardown stay unchanged in ownership.
- The headless operation is private and one-shot. It shares one coordinator-private core with the shipped-browser flow; it does not construct `ComposedReferenceGameBrowserLifecycleActivationAdmission`, browser cookies, CSRF, or browser DTOs.
- The headless caller never receives a locator, `AdmittedStardewInstallation`, process/PID, profile/session directory, pipe, token, launch generation, Job/guardian fact, materializer, raw facade, or capability.
- `createKnownSemanticGameFacadeFromOperatorConfig`, `LocalStardewBridgeClient`, legacy operator selection, Preview, Portfolio, browser composition, and generic launchers are forbidden imports in the gate child branch.
- Remove, rather than retain, `gameOperatorConfigPath` and raw bridge fallback for this production route. No compatibility path, config conversion, discovery, VDF/registry/Steam/GOG lookup, or caller override.
- Runner reads the task fixture locally and sends its natural-language task only after authenticated ready IPC. Task text is not stored in manifests, operator descriptors, or readiness evidence.
- Preserve the existing content-free, source-owned operational evidence and external harness timeout. A harness timeout is not a Game cancellation, success, completion, or retry authority.
- This plan has no target-version live Game mutation. Task 11 requires a separate post-implementation authorization after deterministic closure and review.
- Designs 103/104 may consume the same lifecycle for public desktop/player journeys, but they cannot call this headless seam or private operational IPC. Conversely, this plan does not implement installer, tray, WebView2, onboarding, discovery, or browser UI.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `host/src/stardew-production-lifecycle-coordinator.internal.ts` | Add a non-exported composition-only headless admission that consumes the Design 101 owner and calls the same private lifecycle core. |
| `host/src/stardew-production-lifecycle-coordinator.internal.test.ts` | Exact-once headless lifecycle/replay/close/quarantine law tests. |
| `host/src/main.ts` | Replace operational mode's raw operator-facade construction with verified deployment-manifest → product headless composition → existing ingress flow. |
| `host/src/main.test.ts` or existing exact production-entry tests | Assert headless branch has no operator bridge imports/fallback and ready barrier ordering. |
| `host/src/production-game-task-ingress.internal.ts` | Remains the sole private nonce-bound ready/dispatch/evidence authority; only focused regressions if needed. |
| `host/src/production-game-task-ingress.internal.test.ts` | Verify headless lease preserves existing nonce/session/dispatch/terminal behavior. |
| `tools/run-game-operational-gate.mjs` | Remove `gameOperatorConfigPath`; launch artifact with manifest reference and nonce only. |
| `tools/run-game-operational-gate.test.mjs` | Strict gate config/argv/IPC/redaction tests. |
| `fixtures/stardew/game-operational-task.example.json` | Task fixture only; no lifecycle/bridge/operator facts. |

## Task 1: Add coordinator-private one-shot headless admission

**Files:**
- Modify: `host/src/stardew-production-lifecycle-coordinator.internal.ts`
- Modify: `host/src/stardew-production-lifecycle-coordinator.internal.test.ts`
- Modify only if exact type ownership requires it: `host/src/stardew-production-lifecycle-coordinator.types.ts`

**Interfaces:**

- The production-only composer receives a verified deployment manifest, a completed Design 101 registration owner, and the coordinator dependencies it already owns.
- It returns a private lease shape sufficient only for the existing `production-game-task-ingress` composition:

```ts
type HeadlessOperationalGameLease = Readonly<{
  activateCommittedIngress(): void;
  close(): Promise<void>;
}>;
```

- It does not export `AdmittedStardewInstallation`, a facade, lifecycle snapshot, bridge/process facts, or a browser activation shape.

- [ ] **Step 1: Write failing headless lifecycle law tests**

```ts
test("headless admission consumes one fresh registered installation through the existing lifecycle core", async () => {
  const lease = await fixture.activateHeadlessOperationalGame(fixture.manifest);
  assert.equal(fixture.freshRegistrationAdmissionCalls, 1);
  assert.equal(fixture.playerHostLaunches, 1);
  assert.equal(fixture.aiAttachCalls, 1);
  assert.equal(fixture.materializeCalls, 1);
  assert.equal(fixture.runEnterCalls, 1);
  await lease.close();
});

test("duplicate or payload-drift headless admission cannot rematerialize or launch", async () => {
  const first = fixture.activateHeadlessOperationalGame(fixture.manifest);
  await assert.rejects(() => fixture.activateHeadlessOperationalGame(fixture.driftedManifest), /conflict|unavailable/);
  await first;
  assert.equal(fixture.materializeCalls, 1);
});
```

Also cover: no registration/active fence/closed coordinator/guardian quarantine → zero Stage C/D/attach/materialize/enter calls; uncertain Stage C/D/attach preserves existing quarantine with no retry; close before Stage C causes zero spawn; same exact admission replay preserves one promise/one lifecycle.

- [ ] **Step 2: Run and confirm failure before adding the headless seam**

```bash
cd host
pnpm build:test
node --test --test-concurrency=1 dist-test/stardew-production-lifecycle-coordinator.internal.test.js
```

Expected: private headless composer is absent.

- [ ] **Step 3: Extract/reuse one private core without browser admission forgery**

Implement a non-exported coordinator operation which:

```text
verify deployment-manifest identity in product composition
→ acquire Design 101 registration consume lease
→ fresh admit private locator
→ invoke the same coordinator-private stage/launch/attestation/attach/materialize/enter core
→ activate committed ingress only when caller asks after ingress composition arms
→ preserve existing close/quarantine reverse order
```

The browser path remains its existing authenticated admission wrapper over the same core. Do not give the headless path browser request values, idempotency keys, cookies, CSRF, or public commands. Do not implement a second materializer, direct bridge connect, or a generic lifecycle executor.

- [ ] **Step 4: Add static topology and ordering assertions**

Assert the headless module/path does not import Preview, Portfolio, dialogue-web browser composition, `LocalStardewBridgeClient`, the Design 99 materializer directly, or operator-selection facade code. Assert source ordering/law by fakes: no ready callback before fresh registration admission, Player Host attestation, AI attach, materialize, `runEnter`, and committed-ingress arm.

- [ ] **Step 5: Run focused coordinator closure**

```bash
cd host
pnpm build:test
node --test --test-concurrency=1 \
  dist-test/stardew-production-lifecycle-coordinator.internal.test.js \
  dist-test/stardew-installation-registration.private.test.js \
  dist-test/stardew-bootstrap-guardian.private.test.js
pnpm exec tsc -p tsconfig.production.json --noEmit
pnpm exec tsc -p tsconfig.test.json --noEmit
```

Expected: all pass with no process/game launch beyond test doubles.

- [ ] **Step 6: Fresh lifecycle authority review and exact commit**

Trace registration consume → guardian fence → coordinator Stage C/D → attestation → attachment → Design 99 materializer → enter → ingress → reverse close. Commit only Task 1 files after `git diff --check`.

## Task 2: Replace `main.ts` operational mode with product composition

**Files:**
- Modify: `host/src/main.ts`
- Modify: exact `host/src/main*.test.ts` production-entry suite
- Modify only when required by injection: the existing production composition module that already builds `StardewProductionLifecycleCoordinator`

- [ ] **Step 1: Write failing production-entry tests**

```ts
test("operational mode accepts only a verified deployment-manifest reference and nonce", async () => {
  await runOperationalChild({ manifestReference: fixture.manifestRef, nonce: fixture.nonce });
  assert.equal(fixture.headlessActivationCalls, 1);
  assert.equal(fixture.operatorFacadeCalls, 0);
});

test("operational mode rejects raw operator and bridge fields before product composition", async () => {
  await assert.rejects(() => runOperationalChild({
    manifestReference: fixture.manifestRef,
    nonce: fixture.nonce,
    gameOperatorConfigPath: "sentinel",
  } as never), /invalid/);
  assert.equal(fixture.headlessActivationCalls, 0);
});
```

Include missing/foreign/tampered/reparse manifest references, missing/wrong nonce, registration unavailable, and ingress-arm failure. Every public outcome is fixed/redacted and includes no sentinel path/pipe/token/profile/PID/generation.

- [ ] **Step 2: Run and confirm failure**

```bash
cd host
pnpm build:test
node --test dist-test/main.test.js
```

Expected: old raw operator configuration route remains.

- [ ] **Step 3: Replace operational branch, do not retain a fallback**

`main.ts` operational branch must:

```text
strict parse manifest-reference + nonce only
→ re-load/verify product deployment manifest
→ create existing production Game composition
→ invoke coordinator-private headless admission
→ construct existing production-game-task-ingress with exact headless lease
→ arm durable enter/ingress
→ send ready IPC
→ accept one nonce-bound dispatch
→ close ingress then coordinator lease in existing reverse order
```

Delete the branch's call/import path to `createKnownSemanticGameFacadeFromOperatorConfig()`. Do not load any config that could identify a bridge or installation. Production mode must fail closed if headless lifecycle prerequisites are unavailable.

- [ ] **Step 4: Regression-test ingress and shutdown evidence**

Run existing tests for dispatch-before-ready, wrong/foreign nonce, duplicate dispatch, stdout-forged evidence, worker failure, disconnect and close. Add an assertion that `ready` follows durable Game enter plus committed ingress arm, not merely deployment-manifest validation or coordinator construction.

- [ ] **Step 5: Run scoped tests and static source boundary checks**

```bash
cd host
pnpm build:test
node --test --test-concurrency=1 \
  dist-test/main.test.js \
  dist-test/production-game-task-ingress.internal.test.js \
  dist-test/stardew-production-lifecycle-coordinator.internal.test.js
pnpm exec tsc -p tsconfig.production.json --noEmit
pnpm exec tsc -p tsconfig.test.json --noEmit
```

Expected: all pass without an operator bridge/facade fallback.

- [ ] **Step 6: Fresh operational authority review and exact commit**

Review manifest re-verification, no raw config, coordinator ownership, nonce/ready/dispatch ordering, evidence redaction, and reverse close. Commit only Task 2 files after `git diff --check`.

## Task 3: Remove raw operational gate configuration from the runner

**Files:**
- Modify: `tools/run-game-operational-gate.mjs`
- Modify: `tools/run-game-operational-gate.test.mjs`
- Modify only if fixture schema is currently polluted: `fixtures/stardew/game-operational-task.example.json`

- [ ] **Step 1: Write failing strict config and artifact argv tests**

```js
test("gate config rejects gameOperatorConfigPath and any bridge/process/installation field", async () => {
  await assert.rejects(() => loadGateConfig({
    ...fixture.validConfig,
    gameOperatorConfigPath: "C:\\sentinel.json",
  }), /invalid/);
});

test("production child argv contains only manifest reference and one nonce", async () => {
  const spawn = await captureProductionChildSpawn(fixture.validConfig);
  assert.deepEqual(spawn.operationalArguments, ["--deployment-manifest-ref", fixture.manifestRef, "--operational-nonce", spawn.nonce]);
  assertNoSensitiveStardewFacts(spawn);
});
```

Include parser rejection for `pipeName`, `bridgeToken`, `launchGeneration`, locator/path/profile/session/PID/job/guardian fields and unknown keys. Assert fixture task content is dispatched only after ready IPC and never placed in child argv or report metadata.

- [ ] **Step 2: Run and confirm failure**

```bash
node --test tools/run-game-operational-gate.test.mjs
```

Expected: old config schema still accepts operator config.

- [ ] **Step 3: Narrow the runner schema and spawn contract**

Delete `gameOperatorConfigPath` from config loading, environment setup, report schema, and child argv. Retain only exact harness-owned artifact/run references, manifest reference, external timeout, nonce, and task fixture reference. The runner must validate references as references, not trust projected lifecycle facts, and must not open registration storage, guardian records, bridge data, or product session state.

- [ ] **Step 4: Preserve evidence/timeout semantics**

Assert runner accepts only authenticated source-owned ready and terminal evidence; child stdout does not mint either. An external timeout emits a harness gate failure and triggers owned child cleanup, but never injects a Game task cancellation/retry/success state.

- [ ] **Step 5: Run runner and production-artifact deterministic closure**

```bash
node --test tools/run-game-operational-gate.test.mjs
cd host
pnpm build:test
node --test --test-concurrency=1 \
  dist-test/main.test.js \
  dist-test/production-game-task-ingress.internal.test.js \
  dist-test/scripts/production-artifact.test.js
pnpm exec tsc -p tsconfig.production.json --noEmit
pnpm exec tsc -p tsconfig.test.json --noEmit
```

Expected: no raw operator configuration or sensitive lifecycle facts reach the child; no live game process is launched.

- [ ] **Step 6: Two-stage review and exact commit**

First review runner input/IPC/evidence redaction; second review main/coordinator authority topology. Stage only Task 3 files after `git diff --check`.

## Task 4: Deterministic release preflight and separate live authorization decision

**Files:**
- Modify only evidence documentation or test configuration if deterministic findings require it; do not mutate Game runtime data.

- [ ] **Step 1: Run non-mutation production preflight**

Verify current artifact generation, Design 101 registration readiness/fence state, Design 102 recovery state, manifest reference, strict runner schema, and source-boundary scans. A missing registration or unresolved quarantine produces the fixed composition blocker.

- [ ] **Step 2: Obtain fresh independent review**

Review the complete chain:

```text
runner reference + nonce
→ verified artifact/main branch
→ verified deployment manifest
→ coordinator-private headless admission
→ Design 101 fresh registration admission
→ Design 102 guardian fence
→ Stage C/D + attestation + attach
→ Design 99 materializer + runEnter
→ committed ingress/ready
→ one dispatch/evidence
→ STOP/teardown
```

- [ ] **Step 3: Stop before Task 11**

If every deterministic gate passes, record that Task 11 is eligible for its **separate** target-version live authorization. Do not automatically start or retry a live mutation from this plan.

## Spec Coverage Self-Review

- Same coordinator/private core, no browser forgery: Task 1.
- One-shot ready only after attach/materialize/enter/ingress: Tasks 1–2.
- No raw operator config or bridge facts: Tasks 2–3.
- Existing nonce-bound ingress and content-free evidence: Task 2.
- Runner as harness, not session owner: Task 3.
- No live mutation without separate authorization: Task 4.
