# Stardew Product Session Materialization Design

**Status:** Accepted; implementation is governed by the companion implementation plan.

**Owner:** The Stardew product lifecycle owns this design. `StardewProductionLifecycleCoordinator` remains the only product owner of browser admission, owned Player Host/AI-client process lifecycle, attachment generation, semantic Game entry, STOP, disconnect, and reverse teardown.

**Primary references:** `AGENTS.md`, `design/00_CORE_PRODUCT.md`, `design/09_BDD_VALIDATION_PLAN.md`, `design/35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md`, `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`, `design/99_STARDEW_PRODUCT_SESSION_MATERIALIZATION_IMPLEMENTATION_PLAN.md`.

## 1. Problem

The two-role Stardew product path already has a single coordinator, but its most sensitive terminal construction sequence was represented as an injected callback inside that coordinator:

```text
private owned Farmhand bridge connection
  → authenticated local bridge client
  → receipt-backed integration launch handle
  → runtime binding
  → semantic Game facade
  → exact runtime enter and committed ingress
```

The sequence must remain bound to the exact private bootstrap owner, AI launch generation, scope, manifest identity, and deadline. Keeping that composition anonymous makes the product seam harder to identify and invites incorrect attempts to reuse Preview or Portfolio launch paths.

This design names and deepens that product-only seam without widening any public API.

## 2. Decision

Create a private Stardew-only materializer, `createStardewOwnedFarmhandGameSessionMaterializer()`, whose only operation consumes a private `StardewPrivateFarmhandBridgeConnection` supplied by the exact private bootstrap composition, authenticates it, and returns an unmounted semantic facade.

```text
StardewProductionLifecycleCoordinator
  owns browser admission, exact owner, attachment generation, enter, STOP,
  disconnect, quarantine and reverse teardown

  └─ Stardew-owned Farmhand Game session materializer
       consumes one private authenticated connection + deadline
       connects with exact scope/AI launch generation
       constructs receipt-backed launch → runtime binding → semantic facade
       returns only ConstructedUnmountedGameSemanticFacade
```

The materializer is a private construction-zone component, not a new public Game session interface and not a second launch/attach authority.

## 3. Authority and topology boundaries

### 3.1 Product Farmhand lane — in scope

Only the existing two-role production Stardew topology may use the materializer:

- the private bootstrap composer produces the exact owned Farmhand connection;
- the materializer authenticates that connection using its exact scope, pipe/token and AI launch generation;
- the coordinator alone invokes `runEnter()`, installs its existing STOP adapter, activates committed ingress, publishes attachment generation, and closes the facade;
- browser consumers retain only redacted lifecycle/attachment/readiness readers and the existing browser-admitted commands.

The materializer must not accept structural caller configuration or return bridge credentials, profile paths, PIDs, transaction directories, manifests, raw identities, or launch generations.

### 3.2 Farmhand Preview — explicit non-goal

`farmhand-companion-preview.ts` remains a preview-only presentation and experience/evidence adapter. Its preview runtime, recovery, transaction launcher, native input observation, and hash-only evidence are not semantic Game authority and must not consume the product materializer.

### 3.3 Portfolio — explicit non-goal

Portfolio remains the separate `single_player_native_companion` topology. It owns its own profile, save, binding, pipe/token namespace, native attestation and observe-only runner. Portfolio must not import the materializer or reuse Farmhand credentials, manifests, fixture transaction, receipt, or lifecycle state.

### 3.4 Operational gate — explicit non-goal

`run-game-operational-gate.mjs` remains a harness owner for nonce, private IPC correlation, external timeout, wrapper containment, and redacted report. It does not become a Stardew process/bridge/session owner and it does not infer terminal Game evidence from stdout or Preview markers.

## 4. Invariants

1. One exact private bootstrap owner can supply at most one consumed Farmhand bridge connection; the existing private composer enforces this before the materializer is called.
2. The materializer authenticates only with the supplied connection's scope and AI launch generation, then independently binds that scope to the deployment manifest principal.
3. A returned facade is unmounted. Only the coordinator may enter it, activate committed ingress, publish an attachment, issue STOP, disconnect it, or close it.
4. A transient bridge connection failure remains a coordinator retry concern. Any successful materialization is not retried by a second launch/attach path.
5. Existing close order remains unchanged: task cancellation and STOP settlement → exact facade close → private-owner quarantine → broker close → exact owned AI then Player Host process termination.
6. Preview, Portfolio and generic `IntegrationLauncher` callers never receive the product materializer or raw materializer inputs.
7. Browser-facing contracts stay redacted and unchanged.

## 5. Rejected alternatives

- **A cross-topology `GameSessionLifecycle` interface:** would collapse incompatible preview, Portfolio, product and harness ownership models.
- **Make Preview or Portfolio consumers of the product coordinator:** leaks Farmhand/process/bridge authority and violates documented isolation.
- **Expose `start/attach({ pipeName, token, identity })`:** promotes caller-owned raw bridge facts into product authority and bypasses the private bootstrap owner.
- **A new browser `game.attach` route solely to reach this materializer:** duplicates the existing cabin confirmation/manifest handoff attachment authority.
- **Reuse the operational gate as a product launcher:** turns an external evidence timeout/IPC harness into a lifecycle authority.

## 6. Acceptance evidence

The deterministic acceptance chain is:

```text
private bootstrap connection producer
  → product-owned materializer
  → unmounted semantic facade
  → coordinator exact enter / committed ingress / attachment projection
  → existing STOP, disconnect and close verifier tests
```

Focused tests must prove that the materializer receives only the private connection, production construction delegates to it, existing cabin-confirmation idempotency remains exact-once, semantic-enter failure remains uncertain/quarantined, and teardown behavior remains unchanged. A static boundary test must ensure Preview and Portfolio do not import the materializer.

No live Stardew mutation is authorized by this internal consolidation alone. Task 11 target-live gameplay evidence remains a separate formal gate.
