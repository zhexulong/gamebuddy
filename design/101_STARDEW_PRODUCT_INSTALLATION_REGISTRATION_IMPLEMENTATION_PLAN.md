# Stardew Product Installation Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Host-private, deployment-bound installation-locator registration that re-admits a locator into a fresh opaque installation capability within the existing product coordinator, without creating a second launch authority.

**Architecture:** The registration store persists only a private, untrusted Windows installation-root locator and Design 101 stable deployment binding. Every use strict-re-reads and re-admits the locator inside one coordinator-private callback. A durable attempt fence and the Design 102 guardian/recovery authority prevent a stale Node lock from authorizing a second attempt after a crash; the coordinator remains sole owner of Stage C/D, attach, Game enter, STOP, and teardown.

**Tech Stack:** TypeScript/Node ESM, existing strict `admitStardewInstallation()` capability, runtime-root-contained atomic files and `withPathLock`, Design 102 native containment guardian, Node `node:test` compiled artifacts.

**Spec:** `design/101_STARDEW_PRODUCT_INSTALLATION_REGISTRATION_DESIGN.md`

## Global Constraints

- **Hard predecessor:** Do not implement any task in this plan until Design 102 containment/recovery is independently verified. Generic stale-lock recovery alone can never clear an active attempt fence or permit consume.
- Persist only the exact Design 101 locator record; never serialize, clone, structuralize, or rehydrate `AdmittedStardewInstallation`.
- Raw locator data stays in a Host-private user-selection callback. The currently implemented source is the native picker; Design 104 may later supply an explicitly confirmed bounded discovery candidate through the same private interface. Browser commands, DTOs, state, logs, telemetry, IPC, manifests, reports, and exception serialization never contain locator/executable data.
- The store is not a launcher: it must not spawn processes, form bridge connections, attach Farmhand, materialize a facade, enter Game, publish ingress, or own STOP.
- Preview, Portfolio, generic launchers, legacy `main.ts` operator selection, operator config, run manifests, operational runner, and browser DTO layers must not import the registration core or storage adapter.
- Stable binding is exactly canonical runtime root, three-part principal, and authority generation. `bootstrapOperationId` is deliberately not a registration binding field.
- This plan implements no installation discovery. Design 104 may later supply bounded candidates through this exact publication interface; no discovery fallback, migration, read repair, operator override, compatibility conversion, or raw-path round trip is permitted.
- No Task 11 game launch/mutation or Task 12 claim occurs in any registration task.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `host/src/stardew-installation-registration.private.ts` | Strict private record/fence parsing, binding validation, registration publication, fresh-admission callback, redacted readiness. |
| `host/src/stardew-installation-registration.private.test.ts` | Direct schema, redaction, binding, fresh admission, lock/fence, recovery-integration tests. |
| `host/src/stardew-production-lifecycle-coordinator.internal.ts` | Later private picker producer and coordinator-private consume integration; no public raw-path API. |
| `host/src/stardew-production-lifecycle-coordinator.internal.test.ts` | Existing lifecycle regression additions for exact-once registration consumption and close/quarantine semantics. |
| `host/src/game-browser/game-browser-state-provider.ts` | Later redacted registration readiness projection only. |
| `host/src/game-browser/game-browser-state-provider.test.ts` | Projection isolation tests; registration is never launch/attachment readiness. |
| `host/src/stardew-bootstrap-guardian.private.ts` | Design 102 predecessor used to arm/recover the durable attempt fence; modified only after Design 102 closes. |

## Task 1: Implement the private record/store core after Design 102 closure

**Files:**
- Create: `host/src/stardew-installation-registration.private.ts`
- Create: `host/src/stardew-installation-registration.private.test.ts`
- Modify: `host/src/stardew-bootstrap-guardian.private.ts`

**Interfaces:**

- Consumes validated `HostDeploymentManifest` stable facts, a safe runtime-root-contained private storage root, strict file/lock dependencies, `admitStardewInstallation`, and the Design 102 guardian/fence adapter.
- Produces composition-only `StardewInstallationRegistrationOwner`:

```ts
type StardewInstallationRegistrationOwner = Readonly<{
  readReadiness(): Promise<StardewInstallationRegistrationReadiness>;
  registerAdmittedLocator(locator: string): Promise<RegistrationOutcome>;
  withFreshRegisteredInstallation<T>(
    callback: (installation: AdmittedStardewInstallation) => Promise<T>,
  ): Promise<T>;
}>;
```

- `withFreshRegisteredInstallation` never exposes a locator or record to its callback. It holds the exact registration lock and durable Design 102 attempt fence through callback settlement.

- [ ] **Step 1: Write the failing strict-record and capability-negative tests**

```ts
test("a structural clone of an admitted installation is rejected before the consume callback", async () => {
  const admitted = await fixture.admit("C:\\fixture-stardew");
  const clone = JSON.parse(JSON.stringify(admitted));
  await assert.rejects(() => fixture.consumeStructuralClone(clone), /invalid/);
  assert.equal(fixture.callbackCalls, 0);
});

test("strict private record parsing rejects capability-shaped and secret-bearing fields", async () => {
  await assert.rejects(() => fixture.readRecord({
    ...fixture.readyRecord,
    bridgeToken: "sentinel",
  }), /invalid/);
});
```

- [ ] **Step 2: Run and confirm failure before implementation**

```bash
cd host
pnpm build:test
node --test dist-test/stardew-installation-registration.private.test.js
```

Expected: missing registration module/export.

- [ ] **Step 3: Implement exact v1 parsing and private atomic publication**

Implement the Design 101 exact record:

```ts
type StardewInstallationRegistrationRecordV1 = Readonly<{
  schemaVersion: 1;
  binding: StableDeploymentBinding;
  revision: number;
  state: "ready" | "invalid";
  locator: string | null;
}>;
```

Reject duplicate/unknown keys, invalid state pairings, unsafe numbers, oversize input, malformed binding, invalid Windows absolute roots, prototype pollution, and every forbidden bridge/process/capability field. Publish a canonical record only after strict native admission succeeded. Use the existing safe runtime-root and atomic-write conventions. No caller-visible error includes a locator-derived string.

- [ ] **Step 4: Implement redacted read and registration operations**

`readReadiness()` returns only `{ status, revision }`. `registerAdmittedLocator(locator)` calls `admitStardewInstallation()` before acquiring publication success; cancellation remains outside this API. It binds exactly canonical runtime root, continuity/companion/player principal, and authority generation. It does not bind `bootstrapOperationId`.

- [ ] **Step 5: Run direct core tests and scoped type checks**

```bash
cd host
pnpm build:test
node --test dist-test/stardew-installation-registration.private.test.js
pnpm exec tsc -p tsconfig.production.json --noEmit
pnpm exec tsc -p tsconfig.test.json --noEmit
```

Expected: all pass without process launch, bridge, picker, or production runner.

- [ ] **Step 6: Fresh review and exact commit**

Review strict parsing, redaction, stable binding, and proof that no capability is persisted. Commit only Task 1 files after `git diff --check`.

## Task 2: Add fresh-admission consume with Design 102 fence integration

**Files:**
- Modify: `host/src/stardew-installation-registration.private.ts`
- Modify: `host/src/stardew-installation-registration.private.test.ts`
- Modify: `host/src/stardew-bootstrap-guardian.private.ts`
- Modify: `host/src/stardew-bootstrap-guardian.private.test.ts`

**Interfaces:**

- `withFreshRegisteredInstallation` starts an exact guardian-correlated attempt fence before coordinator-private effects and can proceed only after an unquarantined Design 102 recovery state.
- A callback receives one fresh `AdmittedStardewInstallation`; it cannot recover raw locator data.

- [ ] **Step 1: Write failing lease/crash/recovery tests**

```ts
test("a stale generic lock result leaves an active fence unavailable until two-role recovery contains both jobs", async () => {
  await fixture.persistDeadHostActiveFence();
  await assert.rejects(() => fixture.consume(), /unavailable/);
  assert.equal(fixture.admitCalls, 0);
  await fixture.guardianRecoverBothRoles();
  await fixture.consume();
  assert.equal(fixture.callbackCalls, 1);
});

test("a competing consume never reaches admission or callback while the lease is held", async () => {
  const first = fixture.consumeAndPauseCallback();
  await fixture.waitForFence();
  await assert.rejects(() => fixture.consume(), /busy/);
  assert.equal(fixture.secondAdmitCalls, 0);
  await fixture.resumeCallback();
  await first;
});
```

- [ ] **Step 2: Run and confirm failure before fencing integration**

```bash
cd host
pnpm build:test
node --test dist-test/stardew-installation-registration.private.test.js \
  dist-test/stardew-bootstrap-guardian.private.test.js
```

Expected: missing consume/fence state transition.

- [ ] **Step 3: Implement consume ordering exactly**

```text
acquire fixed registration path lock
→ reject/resolve exact active fence through Design 102 recovery only
→ reread strict record and validate stable binding
→ fresh admitStardewInstallation(locator)
→ persist guardian-correlated active fence for same revision
→ verify same current record/revision
→ invoke private callback with fresh capability while lock stays held
→ callback reverse teardown/quarantine settles
→ guardian-recognized contained/quarantined fence transition
→ release lock
```

Map lock contention and unresolved recovery to fixed redacted `busy`/`unavailable` outcomes. Do not infer dead ownership from timeout or elapsed time. On parsing, binding, fresh-admission, record/fence persistence, or recovery failure, callback/spawn calls remain zero. Fresh admission never refreshes a future registration record.

- [ ] **Step 4: Add revocation and topology tests**

```ts
test("replacement and revocation are rejected while the exact active fence exists", async () => {
  const active = fixture.consumeAndPauseCallback();
  await fixture.waitForFence();
  await assert.rejects(() => fixture.register("C:\\replacement"), /busy|unavailable/);
  await assert.rejects(() => fixture.revoke(), /busy|unavailable/);
  await fixture.resumeCallback();
  await active;
});
```

Add source-boundary assertions that Preview, Portfolio, browser DTO, run manifest, operational runner, generic launcher, and legacy operator selection have no import path to the registration module.

- [ ] **Step 5: Run direct suite and independent recovery review**

```bash
cd host
pnpm build:test
node --test --test-concurrency=1 \
  dist-test/stardew-installation-registration.private.test.js \
  dist-test/stardew-bootstrap-guardian.private.test.js
```

Expected: no stale-lock-only successor can reach fresh admission/callback; all public outcomes redacted.

- [ ] **Step 6: Commit Task 2 only**

Commit only registration/guardian ownership files after an independent authority/recovery/redaction review and `git diff --check`.

## Task 3: Wire the native-picker producer and coordinator-private consumer

**Files:**
- Modify: `host/src/stardew-production-lifecycle-coordinator.internal.ts`
- Modify: `host/src/stardew-production-lifecycle-coordinator.internal.test.ts`
- Modify: `host/src/game-browser/game-browser-state-provider.ts`
- Modify: `host/src/game-browser/game-browser-state-provider.test.ts`
- Modify: `host/src/game-browser/*` only where an existing authenticated no-path setup completion requires the redacted registration reader.

**Interfaces:**

- Browser keeps its existing no-path setup request; its Host-native picker callback is this plan's sole `registerAdmittedLocator` producer. Design 104 may later add an explicitly confirmed discovery producer through the same private interface, not storage.
- The coordinator gets a non-exported registration consume operation that feeds the existing Stage C/D and Design 99 materializer path.
- State projection exposes only registration readiness; it does not claim process/attachment/task readiness.

- [ ] **Step 1: Write failing picker/redaction and coordinator exact-once tests**

```ts
test("same-key coordinator replay materializes once from one fresh registered capability", async () => {
  await fixture.registerViaNativePicker("C:\\sentinel-stardew");
  const first = fixture.confirmCabinChoice(fixture.request);
  const replay = fixture.confirmCabinChoice(fixture.request);
  assert.strictEqual(first, replay);
  await first;
  assert.equal(fixture.freshAdmissionCalls, 1);
  assert.equal(fixture.materializeCalls, 1);
  assert.equal(fixture.runEnterCalls, 1);
});

test("sentinel locator never crosses setup completion, state, error, log, or IPC boundaries", async () => {
  await fixture.registerViaNativePicker("C:\\SENTINEL-STARDew");
  assertNoSentinel(fixture.publicCaptures());
});
```

- [ ] **Step 2: Run and confirm failure before wiring**

```bash
cd host
pnpm build:test
node --test dist-test/stardew-production-lifecycle-coordinator.internal.test.js \
  dist-test/game-browser/game-browser-state-provider.test.js
```

Expected: registration producer/consumer wiring absent.

- [ ] **Step 3: Wire native picker to private registration and coordinator consume**

Keep the selected locator inside the existing authenticated native-picker closure. Strict-admit then atomically register it; return the existing redacted cancelled/terminal semantics. On consume, invoke only the existing coordinator private core; do not manufacture browser admission, create a second launcher, or alter Stage C/D/attestation/attachment/materializer authority.

- [ ] **Step 4: Add truthful redacted state projection**

Project only Design 101 registration readiness. Ensure `ready` alone cannot produce `prerequisites: met`, `instance: launching/running`, attach/catalog/task availability, or a browser-controlled claim/retry token.

- [ ] **Step 5: Run lifecycle and state regressions**

```bash
cd host
pnpm build:test
node --test --test-concurrency=1 \
  dist-test/stardew-production-lifecycle-coordinator.internal.test.js \
  dist-test/game-browser/game-browser-state-provider.test.js \
  dist-test/stardew-installation-registration.private.test.js
```

Expected: picker cancellation preserves a ready record; invalid/reparse locator gives zero spawn; close/quarantine keeps the fence unavailable until guarded containment; existing exact-once/replay and STOP/disconnect behavior remains green.

- [ ] **Step 6: Fresh review and exact commit**

Trace user selection (native picker in this task) → strict admission → registration → fresh capability → coordinator Stage C/D → materializer → enter/STOP/teardown. Commit only this integration slice after review, scoped TypeScript, and `git diff --check`.

## Design 101 registration closure

Design 101 closes only when all of the following exist and pass independent authority/recovery/topology review:

1. Design 102 verified containment/recovery closure, including the guardian-exclusive lease race and two-role recovery matrix;
2. Tasks 1–3 above with their direct deterministic evidence;
3. current production artifact verification for the registration/guardian generation; and
4. no unresolved registration attempt fence or guardian quarantine for the selected product runtime partition.

Design 101 does **not** authorize `main.ts`, `tools/run-game-operational-gate.mjs`, browser headless activation, or any raw operator-config change. Those belong exclusively to a successor Design 100 implementation plan after this registration closure.

## Spec Coverage Self-Review

- Capability opacity and exact schema: Task 1.
- Stable binding and bootstrap-operation exclusion: Task 1.
- Cross-process crash containment / stale lock prohibition: Task 2 through verified Design 102 recovery.
- Fresh admission and no discovery fallback: Tasks 1–3.
- Native-picker producer/no-path redaction: Task 3; Design 104 owns any later bounded discovery producer and must reuse the same private publication operation.
- Coordinator-only lifecycle consumption and exact-once replay: Task 3.
- Operational-gate raw-config removal: explicitly outside this plan; it belongs to the successor Design 100 implementation plan after Design 101 registration closure.
- Placeholder scan: each task names concrete modules, interfaces, tests, commands, and authorization boundaries.
