# Stardew Product Session Materialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing production two-role Stardew bridge-to-semantic-session construction an explicit private coordinator dependency, without creating a public lifecycle, a second attach authority, or a cross-topology launcher.

**Architecture:** Extract the authenticated Farmhand bridge → receipt-backed launch handle → Game runtime binding → unmounted semantic facade sequence from `StardewProductionLifecycleCoordinator` into one private Stardew materializer. The coordinator continues to own browser admission, lifecycle state, `runEnter`, committed ingress, attachment generation, STOP/disconnect and close. Preview, Portfolio and the operational gate retain their independent topology/harness owners and do not import the materializer.

**Tech Stack:** TypeScript ESM, Node 24, `node:test`, existing Stardew private bootstrap composition and semantic Game facade.

**Spec:** `design/99_STARDEW_PRODUCT_SESSION_MATERIALIZATION_DESIGN.md`

## Global Constraints

- The materializer is Stardew-private and production-only; it accepts no browser, operator, Preview or Portfolio configuration.
- Never expose pipe names, bridge tokens, session directories, manifests, profile paths, PIDs, save content, raw identities or launch generations across the browser/product boundary.
- Do not add `game.attach`, reconnect, generic dispatcher, generic lifecycle, compatibility path or fallback path.
- Preview remains a separate non-semantic, short-lived evidence/experience surface; Portfolio remains `single_player_native_companion`; the operational gate remains a harness.
- Preserve the coordinator's existing exact STOP/disconnect/close order and attachment/idempotency semantics.
- No live mutation, fixture transaction, Stardew/SMAPI launch or target-live gate is authorized by this plan.

---

## Slice Card

**User-visible result:** The shipped Game product has one explicit private materializer for its owned Farmhand session, while all existing redacted browser behavior remains unchanged.

**In scope / explicit non-goals:** Extract only the product coordinator's authenticated bridge-to-unmounted-facade construction. Do not migrate Farmhand Preview, Portfolio or the operational gate; do not create a browser-facing session API.

**Required topology and authority boundary:**

```text
private bootstrap composition produces exact connection
  → private product materializer constructs unmounted facade
  → coordinator enters/activates/closes it
  → browser receives existing redacted readers only
```

**Acceptance scenario:**

```text
Given a cabin confirmation has admitted the exact owned Farmhand connection,
When the coordinator materializes its semantic Game session,
Then it delegates once to the private materializer, enters that exact facade once,
activates committed ingress, and exposes only the existing attachment projection.

Given materialization or enter fails after manifest admission,
When the same confirmation is replayed,
Then the lifecycle remains uncertain/quarantined and no second materialization occurs.

Given Preview, Portfolio or the operational harness source,
When its imports are inspected,
Then none imports the product materializer.
```

**Producer → consumer → verifier:** private bridge connection → private materializer → coordinator `runEnter`/attachment publication → existing focused coordinator tests plus import-boundary test.

**Cheapest checks:** focused materializer test after extraction; focused coordinator test after integration; TypeScript production check and `git diff --check` at batch end.

**Mutation lanes:** One writer owns `host/src/stardew-owned-farmhand-game-session-materializer.internal.ts`, its direct test, and the production coordinator's construction wiring. No other source file is touched.

**Independent read-only lane:** One final reviewer checks that raw connection facts do not escape, the production coordinator remains the only enter/close owner, and Preview/Portfolio/operational gate are not migrated.

**Launch budget:** one writer, one final review, no live mutation.

**Stop/escalation condition:** Stop if extraction requires exposing a private connection, bootstrap owner, process owner or semantic facade to browser/Preview/Portfolio/operational-gate code, or if coordinator close ordering changes.

---

## File Structure

| File | Responsibility |
|---|---|
| `host/src/stardew-owned-farmhand-game-session-materializer.internal.ts` | Private production factory that consumes an authenticated Farmhand connection and returns one unmounted semantic facade. |
| `host/src/stardew-owned-farmhand-game-session-materializer.internal.test.ts` | Deterministic contract checks for the materializer's private shape and production composition ownership. |
| `host/src/stardew-production-lifecycle-coordinator.internal.ts` | Receives the materializer as an internal dependency; continues to own enter, ingress activation, attachment state, STOP and close. |

## Task 1: Extract the private product materializer

**Files:**
- Create: `host/src/stardew-owned-farmhand-game-session-materializer.internal.ts`
- Modify: `host/src/stardew-production-lifecycle-coordinator.internal.ts:127-166, 554-560, 824-881`
- Test: `host/src/stardew-owned-farmhand-game-session-materializer.internal.test.ts`

**Interfaces:**

```ts
export type StardewOwnedFarmhandGameSessionMaterializer = Readonly<{
  materialize(
    connection: StardewPrivateFarmhandBridgeConnection,
    deadlineMs: number,
  ): Promise<ConstructedUnmountedGameSemanticFacade>;
}>;

export function createStardewOwnedFarmhandGameSessionMaterializer(
  manifest: HostDeploymentManifest,
): StardewOwnedFarmhandGameSessionMaterializer;
```

- [ ] **Step 1: Write a focused failing ownership test**

Assert the production factory exports only `materialize`, its source authenticates with `connectFarmhand` using the connection's exact scope/token/launch generation, binds manifest principal plus exact world scope, and produces a receipt-backed semantic facade. Assert forbidden source consumers (`farmhand-companion-preview.ts`, `portfolio-*.ts`, `run-game-operational-gate.mjs`) do not import the materializer.

- [ ] **Step 2: Run the focused test to verify the module is missing**

Run:

```bash
node --import tsx --test host/src/stardew-owned-farmhand-game-session-materializer.internal.test.ts
```

Expected: failure because the private materializer module does not exist.

- [ ] **Step 3: Implement the materializer**

Move only the current production callback body from `createStardewProductionLifecycleCoordinator()` into the factory. Preserve `LocalStardewBridgeClient.connectFarmhand`, `createStardewIntegrationLaunchHandleFromAuthenticatedBridge`, `createGameRuntimeBindingFromReceiptBackedLaunch`, and `createKnownSemanticGameFacadeFromReceiptBackedBinding` order exactly. The returned object has only `materialize` and no read/close/start/attach method.

- [ ] **Step 4: Wire it into the coordinator**

Replace the anonymous production callback with the factory. Rename the private test injection from `connectFarmhandGameRuntimeFacade` to a materializer operation only if all direct test-support call sites remain local and compiler-clean. Keep `confirmCabinChoice()` as the sole caller of materialization, and keep `runEnter()`/ingress/attachment publication in the coordinator.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
node --import tsx --test host/src/stardew-owned-farmhand-game-session-materializer.internal.test.ts
node --import tsx --test host/src/stardew-production-lifecycle-coordinator.internal.test.ts
npx tsc --project host/tsconfig.production.json --noEmit
```

Expected: all selected tests pass; production typecheck has no diagnostics attributable to this slice.

## Task 2: Verify unchanged coordinator authority flow

**Files:**
- Modify only if a direct regression is absent: `host/src/stardew-production-lifecycle-coordinator.internal.test.ts`

**Interfaces:**
- Consumes Task 1's private materializer.
- Produces focused proof that cabin confirmation still materializes exactly once and that coordinator remains enter/attachment/close owner.

- [ ] **Step 1: Add or sharpen direct regression only if missing**

Use the existing `connectFarmhandGameRuntimeFacade` deterministic override to count construction and `runEnter()` calls. Confirm exact same idempotency-key replay shares the confirmation promise and causes one connection/materialization/enter; payload drift rejects before a second materialization.

- [ ] **Step 2: Run the direct coordinator test**

Run:

```bash
node --import tsx --test host/src/stardew-production-lifecycle-coordinator.internal.test.ts
```

Expected: pass, including existing semantic-enter failure and close-drain tests.

- [ ] **Step 3: Run batch hygiene**

Run:

```bash
npx tsc --project host/tsconfig.production.json --noEmit
git diff --check
```

Expected: no slice-attributable compiler errors and no whitespace errors.

## Task 3: Final boundary review and atomic commit

**Files:**
- Review: the three files from Task 1 and any justified direct test adjustment from Task 2.

- [ ] **Step 1: Fresh review**

Review the actual diff against `design/99_STARDEW_PRODUCT_SESSION_MATERIALIZATION_DESIGN.md`. Reject if it imports the materializer from Preview/Portfolio/harness code, exposes raw connection facts, changes public browser contracts, creates new attach authority, or changes coordinator reverse teardown.

- [ ] **Step 2: Commit only the closed slice**

Stage only the design, plan, materializer, direct materializer test and coordinator integration files. Use `git commit --only` if unrelated lanes occupy the index.

- [ ] **Step 3: Record residual work**

Record that Task 11 target-live gameplay remains a separate gate requiring its own non-mutating preflight, independent review and one source-owned live run; do not claim release closure from this refactor.

## Self-review

- Spec coverage: Task 1 realizes the private materializer and preserves the coordinator as owner; Task 2 proves its authority flow; Task 3 enforces isolation and records the live-gate non-goal.
- Placeholder scan: no task defers an unnamed component or undefined interface.
- Type consistency: `StardewOwnedFarmhandGameSessionMaterializer.materialize()` consumes `StardewPrivateFarmhandBridgeConnection` and returns `ConstructedUnmountedGameSemanticFacade`; only the coordinator owns the returned facade after construction.
