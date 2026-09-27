---
id: TASK-STARDEW-PRODUCT-LAUNCH-TOPOLOGY-CONSOLIDATION
type: task
status: active
owner: stardew-integration
---

# Stardew Product Launch Topology Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unintended direct operator-config Stardew attachment from the shipped semantic Game composition so the production Game surface reaches Stardew only through the coordinator-owned installation, process, attachment, and teardown topology while preserving intentional Preview and Portfolio isolation.

**Architecture:** Keep `StardewProductionLifecycleCoordinator` as the sole shipped Stardew Game lifecycle owner. Keep `STARDEW_INTEGRATION_LAUNCHER` and the adapter-neutral launcher types only where the coordinator's private materializer needs them; remove their direct operator-config product selection/launch route rather than adding a fallback or compatibility layer. Do not merge Preview or Portfolio, and do not introduce a second launcher/session abstraction.

**Tech Stack:** TypeScript, Node.js ESM, `node:test`, existing Host composition and lifecycle tests, Biome, TypeScript compiler.

**Current authority:** `design/domains/stardew/integration.md`, `design/architecture/system-overview.md`, `design/architecture/product-surfaces.md`, `design/architecture/release-model.md`, and `AGENTS.md`. Numbered Design 100 and archived Design 99/101/102 materials are historical diagnosis/background only and do not authorize implementation.

## Status and activation rule

**Current composition-root decision (implementation pending):** formal Desktop bootstrap is the single Host product composition root. It authenticates `DesktopGuardianSession`, initializes/holds the long-lived Host composition, and transfers the session only through a private composition-owned typed capability to the selected Stardew lifecycle. Bootstrap performs only Phase 1 runtime admission/composition handoff: it does not choose `principal`, `authorityGeneration`, `fresh`/`known`, GameSession, activation, selected integration or world binding, and this plan does not add `ProductInputProducer`. `HostDeploymentManifest` remains Host-owned complete deployment/composition input; Desktop `dataRoot` is only a storage partition, not product identity or complete authority. Missing deployment-level semantic authority cannot create `local_default`; known startup does not automatically increment `authorityGeneration`, and fresh initialization remains governed by the existing authority owner/contract. Stardew remains lifecycle owner and creates an invocation-specific `RoleLaunchOperation` deadline/budget only after fresh admission, reservation, and launch preconditions; no bootstrap/browser/owner/attempt expiry or game lifetime is reused.

**Four contract boundaries:** (1) bootstrap/composition initializes and carries long-lived composition only; (2) semantic authority and GameSession owner retain identity, authority, session, activation and `fresh`/`known` decisions; (3) published artifact/picker reuse existing generation admission, Host publisher/published capability and native folder-picker strict-admission seams—`programRoot` is not unconditionally a published artifact root; (4) presentation startup/close remains composition-owned and uses the existing one-loopback-listener and typed narrow projection, with close failure propagated after best-effort drain. No WebSocket, fixed `127.0.0.1`, random-port or second-listener contract is introduced. Normal GameBuddy close does not default STOP or terminate Player/world; `End Game` is independent authenticated operation.

**Final migration:** after Phase 1 runtime admission/composition and Phase 2 UI-driven GameSession Create/Resume are implemented and verified, use solution A: move browser/presentation wiring into the formal composition-owned startup and delete `host/src/dialogue-web-main.ts` and its entry/imports. Do not retain a wrapper, alias, second entry, registry, or fallback.

**Exact next slice / owned files (pending):** Desktop bootstrap/session handoff is owned by `desktop/GameBuddy.Desktop/Program.cs`, `RuntimeSupervisor.cs`, `DesktopHostBootstrapBroker.cs`, `GuardianSupervisor.cs` and focused Desktop tests. Host composition/lifecycle handoff is owned by `host/src/bootstrap/entry/desktop-host-entry.internal.ts`, `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts`, `host/src/composition/desktop-host-composition.ts`, `host/src/stardew-production-lifecycle-coordinator.internal.ts`, `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts`, `host/src/dialogue-web-main.ts` and focused tests. This does not activate the blocked Tasks 1–6 or alter the installation/containment predecessor gate.

This task is **active**. Tasks 0–5 are complete. Task 6's independent review is the remaining gate.

**Status note 2026-09-27:** the route removal is implemented and locally verified. The plan's "Final migration" clause (`dialogue-web-main.ts` browser/presentation consolidation) is already satisfied independently — that file does not exist and `host/scripts/test-artifact-protocol.test.mjs` asserts its absence from the test artifact — so it is not pending work under this plan.

Activation requires all of the following ordinary, reviewable project facts—no new hash, signature, attestation chain, or plan-local authority is introduced:

1. the current Stardew domain owner no longer states that installation registration is incomplete;
2. the current Stardew domain owner no longer states that bootstrap containment is incomplete;
3. the corresponding production tests and platform-specific verification named by that current owner pass;
4. an independent reviewer confirms that those current facts permit this current-owner topology consolidation.

A worker must read the current owner at task start. If either incomplete statement remains, the worker must stop after Task 0. Tests, fixtures, checkboxes, this plan, or archived Design 101/102 documents cannot activate Tasks 1–6.

**Activation record 2026-09-27:** all four facts were independently verified by `design/reviews/topology-activation-review.md`, which returned `ACTIVATION: GRANTED` after re-running the named suites on a confirmed `win32` host (registration 12/11+1 skip, registration lock 3/3, composer 108/108, coordinator+platform 95/95, guardian-live 65/65, seam checker 20/20 over 200 files, module graph clean). It also re-verified that the authority review's sole prior BLOCKER was corrected at HEAD and that every cited fix commit is an ancestor.

The same review recorded a HIGH finding that is worth keeping visible here: that reviewer confirmed the containment closure must **not** be read as "guardian crash recovery works". The Host-side producer that would drive crash recovery is absent (recorded as a residual by the containment task), so the system is fail-closed but not recoverable. That gap is orthogonal to this plan's route removal and does not bar activation, but it is the reason the domain owner now says so explicitly.

## Global Constraints

- Do not optimize for backward compatibility: remove the unintended direct operator attach route; do not retain a fallback, alias, migration, or compatibility mode.
- Keep Preview and Portfolio as separate topologies; do not make either consume the production coordinator or materializer.
- `StardewProductionLifecycleCoordinator` remains the only shipped Stardew Game owner of installation admission, Player Host/AI Client lifecycle, Farmhand attachment, Game enter, STOP, disconnect, quarantine, and teardown.
- `STARDEW_INTEGRATION_LAUNCHER` may remain an internal adapter construction dependency for the coordinator-owned materializer, but no shipped product caller may use it to consume raw `pipeName`/`bridgeToken` operator configuration.
- Do not add a new launcher registry, cross-topology interface, generic gameplay DSL, second materializer, generic dispatcher, or raw bridge/session API.
- Do not modify Stardew action semantics, Mod capability authority, bridge protocol fields, receipts, postconditions, installation-registration design, or bootstrap-containment design.
- Do not claim the operational gate or full player launch is unblocked beyond what the current Stardew domain owner records. As of 2026-09-27 that owner records installation registration and bootstrap containment as closed, so Tasks 1-6 are activated; the gate remains a harness and this plan still does not authorize a live launch.
- Do not discard or overwrite unrelated dirty-worktree changes.
- No live Stardew launch, mutation, fixture preparation, or target lease acquisition is authorized by this plan; use deterministic composition tests only.

---

## Current diagnosis and intended end state

**Outcome (2026-09-27):** the direct operator route is **removed**, and the plan's original diagnosis turned out to be partly stale. Tracing every production caller showed the shipped entry (`host/src/main.ts`) and `host/src/semantic-main-config.ts` already consumed only the manifest reference and the coordinator-owned composition; they never reached the operator-selection route. That route had **zero production importers** — only its own test — and one live consumer of `PRODUCT_INTEGRATION_CATALOG.select()`: itself. It was therefore deleted outright rather than migrated, per the no-backward-compatibility rule.

**One correction worth recording:** the operator-selection facade constructed its **own** `SemanticGameProductionAuthority` (`createKnownSemanticGameProductionAuthorityFromDeploymentManifest`), whereas the coordinator-owned materializer requires the shared authority to be **injected**. The old route was not a harmless alternate wiring; if it had ever been reached in production it would have created a second Game authority. That is the substantive reason removal is correct, and it is why the retained path is asserted positively rather than assumed.

The direct operator path this plan removed:

```text
operator config
  → PRODUCT_INTEGRATION_CATALOG.get(integrationId)
  → STARDEW_INTEGRATION_LAUNCHER.launch()
  → LocalStardewBridgeClient.connect(pipeName, bridgeToken)
  → semantic Game facade
```

It is now unreachable: `PRODUCT_INTEGRATION_CATALOG` registers no launchers at all, so `select()` cannot be made to yield operator-supplied pipe/token launch facts.

The intended shipped Game path is:

```text
product-owned installation registration
  → StardewProductionLifecycleCoordinator
  → owned Player Host / AI Client
  → launch-generation-bound Farmhand attachment
  → Stardew-owned Farmhand session materializer
  → semantic Game facade
```

Preview remains separate:

```text
farmhand-companion-preview.ts
  → Preview-owned launcher/runtime/presentation boundary
```

Portfolio remains separate and is not part of this plan.

This plan is predecessor-gated by the current Stardew domain owner. **As of 2026-09-27 that owner records both predecessors as closed** (`design/domains/stardew/integration.md`: installation registration closed at :186, bootstrap containment closed at :192), and an independent activation reviewer confirmed the four activation facts and returned `ACTIVATION: GRANTED` (`design/reviews/topology-activation-review.md`). Tasks 1-6 are therefore executable. Before that closure was recorded this plan permitted only characterization of the unwanted route and fail-closed blocked-state evidence; that phase is complete. The product composition must have no import/selection path that can create a direct Stardew attachment.

---

## File and responsibility map

| File | Responsibility in this plan |
|---|---|
| `host/src/integration-catalog-product.ts` | After the current-owner activation gate, remove the product catalog if it has no remaining consumer; otherwise remove only the direct raw-attach entry. Do not remove the launcher while Preview or the private materializer still consume it. |
| `host/src/continuity-semantic-game-operator-selection/continuity-semantic-game-operator-selection.internal.ts` | After the predecessor gate, remove the legacy operator selection used for normal semantic Game entry and migrate normal/recovery manifest input to the lawful product composition; before that gate, retain only blocked characterization. |
| `host/src/main.ts`, `host/src/semantic-main-config.ts`, and operational composition callers | After the predecessor gate, migrate normal and recovery entry contracts from operator-selected Stardew attach facts to the manifest/coordinator-owned composition. Preserve unrelated Chat, Preview, Portfolio, and dead-owner recovery semantics. |
| `host/src/stardew-integration-launcher.ts` | Retain the launcher because Preview and the coordinator-owned private materializer still use it. Remove only a direct product-facing export/config consumer with no remaining lawful owner; never delete the private authenticated-bridge conversion seam. |
| `host/src/stardew-owned-farmhand-game-session-materializer.internal.ts` | Continue consuming only the private generation-bound Farmhand connection supplied by the coordinator; no raw operator config is added. |
| `host/src/stardew-production-lifecycle-coordinator.internal.ts` | Remains the sole production owner. Later migration may add only the private activation/registration consumption authorized by the current Stardew domain and product-composition documents. Do not include the separate attachment projection issue or split/redesign the coordinator in this plan. |
| `host/src/farmhand-companion-preview.ts` | No production change; add/retain isolation coverage only if needed to show Preview remains intentionally separate. |
| `host/src/*test.ts` relevant to catalog/operator/materializer/coordinator | Prove the removed path, retained private materializer path, Preview isolation, and no raw bridge facts in product composition. |
| `tools/run-game-operational-gate.mjs` and `tools/run-game-operational-gate.test.mjs` | Characterize the current direct route now; after current-owner activation, remove that route while keeping the runner a harness. The numbered Design 100 document is historical diagnosis only. |
| `design/domains/stardew/integration.md` | Current architectural owner for the intentional Preview/Portfolio distinction, coordinator-only materializer ownership, unintended direct operator route, activation status, and no-fallback rule. |

No new production module is required by this plan.

---

## Task 0: Predecessor-gated current-state characterization (authorized now)

**Files:**
- Modify: `host/src/integration-catalog-product.test.ts`
- Modify: `host/src/continuity-semantic-game-operator-selection/continuity-semantic-game-operator-selection.test.ts`
- Modify: `host/src/semantic-main-config.test.ts` only for explicit blocked-state characterization
- Modify: `tools/run-game-operational-gate.test.mjs` only for explicit blocked-state characterization

**Interfaces:**
- Consumes: current product catalog, operator-selection composition, and the current Stardew domain blocked-state contract.
- Produces: deterministic evidence that direct operator attach is transitional/unwanted while no route-removal implementation is authorized before the current owner closes both predecessor capabilities.

- [x] **Step 1: Record the current direct route as a characterization**

Use the existing `node:test` Host style to show that the current operator selection can reach the direct route. This is characterization evidence, not acceptance of the route.

- [x] **Step 2: Add the current-owner status characterization**

Assert, through a documentation/status characterization test or equivalent deterministic current-owner check, that the current owner records **both** predecessor capabilities as closed and names the evidence for each, so this plan's activation stays tied to observable facts rather than to a checkbox. Do not claim that the current runtime gate itself rejects `PASSED`: the existing runner can still mechanically pass correlated terminal evidence through the transitional direct route. Task 0 records that contradiction without changing production behavior.

**Status 2026-09-27:** this step is implemented, but its original wording ("remain incomplete") was inverted by the closure it was written to detect. `tools/run-game-operational-gate.test.mjs` now asserts the closure wording and is mutation-verified (breaking the owner's closure sentence makes it fail); its four step checkboxes below are complete.

- [x] **Step 3: Run the actual Host test build and runner**

Use the existing Host `node:test` build/test scripts from `host/package.json` and `host/scripts/run-test-suite.mjs`. Run the root operational-gate test separately with `node --test tools/run-game-operational-gate.test.mjs`, because it is outside Host test discovery. Do not invoke Vitest; it is not a repository dependency.

- [x] **Step 4: Stop at the predecessor boundary**

Do not remove catalog entries, change `main.ts`, delete `gameOperatorConfigPath`, or add headless activation in this task. Finish with the blocker explicit and reproducible.

---

## Task 1: Freeze the post-predecessor product-route decision in tests

**Files:**
- Modify: `host/src/integration-catalog-product.test.ts`
- Modify: `host/src/integration-catalog.test.ts` only for generic catalog/parser behavior
- Modify: `host/src/continuity-semantic-game-operator-selection/continuity-semantic-game-operator-selection.test.ts`
- Modify: `host/src/semantic-main-config.test.ts`
- Modify: `host/src/stardew-owned-farmhand-game-session-materializer.internal.test.ts` to inventory production importers and preserve coordinator-only ownership

**Interfaces:**
- Consumes: `PRODUCT_INTEGRATION_CATALOG`, `createKnownSemanticGameFacadeFromOperatorConfig`, and the current Stardew domain topology/status contract.
- Produces: deterministic assertions that direct Stardew operator attach is not a shipped product route and that Preview/Portfolio are not affected.

- [x] **Step 1: Add a post-predecessor failing test for direct product selection**

Activate this assertion only after the current Stardew owner records installation registration and bootstrap containment as closed with their named production verification and independent review. Put shipped product catalog assertions in `host/src/integration-catalog-product.test.ts`; keep generic catalog/parser assertions in `host/src/integration-catalog.test.ts`. Assert through the product boundary that raw `pipeName`/`bridgeToken` configuration cannot create a shipped Stardew attachment, without claiming that the adapter launcher itself cannot exist for Preview/private materializer use.

- [x] **Step 2: Run the actual Host test build and runner**

Use the existing Host `node:test` build/test scripts and `host/scripts/run-test-suite.mjs`. Expected failure before Task 2 is the direct-route characterization.

- [x] **Step 3: Add isolation assertions**

Assert that Preview's production dependency composition remains Preview-owned and that Portfolio imports/uses are not changed by the product catalog consolidation. Do not assert that Preview becomes coordinator-backed.

- [x] **Step 4: Run the focused tests again**

The new isolation assertions may pass before implementation; the direct-route assertion must remain the failing red test until Task 2.

---

## Task 2: Remove the direct Stardew product selection path (post-current-owner activation only)

**Files:**
- Modify: `host/src/integration-catalog-product.ts`
- Modify: `host/src/continuity-semantic-game-operator-selection/continuity-semantic-game-operator-selection.internal.ts`
- Modify: `host/src/main.ts`
- Modify: `host/src/semantic-main-config.ts`
- Modify: normal-entry and dead-owner recovery composition tests
- Modify: `host/src/stardew-integration-launcher.ts` only if required to remove a direct product-facing config consumer; retain Preview/private materializer uses
- Delete: no file unless the implementation proves a file has no remaining private/materializer consumer and the deletion is covered by tests

**Interfaces:**
- Consumes: Task 1 failing route test; coordinator-owned private materializer; current operator-selection API.
- Produces: semantic Game product composition with no direct raw Stardew attach route, while retaining the private adapter seam required by the coordinator materializer.

- [x] **Step 1: Verify the current-owner activation gate before editing**

Do not begin this task while `design/domains/stardew/integration.md` states that installation registration or bootstrap containment is incomplete. Activation also requires the production verification and independent review named by the current owner. Numbered or archived design text, this plan, a checkbox, or a test fixture cannot satisfy the condition.

- [x] **Step 2: Trace all production callers before editing**

Search for:

```bash
rg "PRODUCT_INTEGRATION_CATALOG|createKnownSemanticGameFacadeFromOperatorConfig|createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig|STARDEW_INTEGRATION_LAUNCHER|parseStardewLauncherConfig|gameOperatorConfigPath" host/src tools
```

Classify every match as one of:

```text
coordinator/materializer-private
Preview
Portfolio
operational harness
shipped semantic Game product
```

Do not remove a private materializer dependency merely because it shares the launcher module.

- [x] **Step 3: Remove the shipped direct selection**

After the predecessor gate, remove Stardew from the directly selectable product catalog if that catalog has no remaining lawful consumer, or remove only the direct raw-attach selection if another lawful product consumer remains. Migrate normal and recovery entry callers to the coordinator-owned composition required by the current Stardew owner. Dead-owner recovery must accept only the deployment-manifest reference and operation identity required by the current recovery contract; it must not parse `integrationId` or opaque `integration` payload. The result must not accept `pipeName`, `bridgeToken`, installation path, profile path, PID, endpoint, or launch generation from operator config as a product Game launch fact.

Do not add a second launcher entry to hide the old behavior. Do not serialize or rehydrate `AdmittedStardewInstallation`.

- [x] **Step 4: Preserve the private materializer seam**

Keep `createStardewIntegrationLaunchHandleFromAuthenticatedBridge()` and the materializer because they consume the exact private Farmhand connection used by the coordinator-owned composition. Preserve `createKnownSemanticGameFacadeFromReceiptBackedBinding()` as private construction machinery; if operator-selection removal leaves it in the wrong module, move it to an existing internal composition module rather than exposing a new public API. Remove a symbol only if the implementation proves it has no Preview or private-materializer consumer; update its tests rather than retaining a compatibility export.

- [x] **Step 5: Run Task 1 tests**

Expected: direct-route test passes; Preview and Portfolio isolation tests pass.

---

## Task 3: Prove the retained production path is coordinator-owned (post-current-owner activation only)

**Files:**
- Modify: `host/src/stardew-owned-farmhand-game-session-materializer.internal.test.ts` or the current exact test file
- Modify: `host/src/stardew-production-lifecycle-coordinator.internal.test.ts`
- Modify: `host/src/local-stardew-bridge-attestation.test.ts` if needed
- Modify: `host/src/continuity-semantic-game-runtime-binding/` tests only if the existing composition contract requires it

**Interfaces:**
- Consumes: private Farmhand bridge connection, launch generation, manifest binding, materializer, coordinator lifecycle readers.
- Produces: deterministic proof that the only retained product construction path is private, generation-bound, receipt-backed, and coordinator-owned.

- [x] **Step 1: Add a failing assertion for raw-config absence**

Test the production materializer/composition boundary with a private connection and assert that no function in that path accepts structural Stardew operator configuration. The test must exercise the public typed boundary, not rely solely on source-text scanning.

- [x] **Step 2: Add coordinator ownership and import-inventory assertions**

Prove that product construction requires the coordinator-produced private Farmhand connection and that the coordinator remains the component invoking the existing enter/STOP/attachment/close sequence. Add the smallest static production TypeScript import-inventory assertion, excluding `*.test.ts` and approved `*.test-support-internal.ts`, showing that only the coordinator imports the private materializer; explicitly reject imports from `main.ts`, semantic operator selection, product catalog, Preview, Portfolio, and operational runner. Pair this with the runtime private-connection test; do not treat TypeScript structural typing alone as ownership proof. Preserve existing exact-once and uncertain/quarantine tests.

- [x] **Step 3: Run focused coordinator/materializer tests**

Expected: all retained private-path tests pass, including failure and teardown cases.

---

## Task 4: Remove stale operational-gate direct-route assumptions (post-current-owner activation only)

**Files:**
- Modify: `tools/run-game-operational-gate.mjs` only if it still supplies the removed direct route
- Modify: `tools/run-game-operational-gate.test.mjs`
- Do not modify numbered migration/background designs as implementation authority

**Interfaces:**
- Consumes: the current Stardew domain blocked composition contract and Host product composition.
- Produces: operational gate that remains a harness consumer and fails closed until the current owner closes installation registration and bootstrap containment; it never becomes a direct Stardew launcher.

- [x] **Step 1: Add or update a failing assertion**

Assert that the operational runner does not pass raw Stardew pipe/token facts to the product child and returns the exact source-owned composition blocker defined by the current Stardew domain/product composition, rather than a generic failure or an attempted direct bridge attachment.

- [x] **Step 2: Remove the direct-route input**

Delete `gameOperatorConfigPath` or equivalent raw Stardew launch input from the operational-gate path if it is still present, following the current Stardew domain topology contract. Retain only harness preflight references, deployment-manifest reference, per-run nonce, and task input allowed by that design.

- [x] **Step 3: Run the gate's deterministic tests**

No real game process or mutation is permitted. Expected: the gate remains explicitly blocked and does not report `passed` or `ready` from the removed route.

---

## Task 5: Record only the necessary owner clarification

**Files:**
- Modify: `design/domains/stardew/integration.md` only if final implementation changes its factual status
- Do not modify numbered migration/background designs as implementation authority

**Interfaces:**
- Consumes: final import/selection topology from Tasks 2–4.
- Produces: a minimal factual owner clarification in the existing current document; it does not create a new source-level architecture map.

- [x] **Step 1: Correct only factual owner/status wording if needed**

Do not duplicate a source-level path map into multiple architecture documents. Update the Stardew domain owner only if the final implementation changes the stated distinction: shipped Game is coordinator-owned, Preview and Portfolio remain separate, and direct operator attach is removed after the predecessor gate.

- [x] **Step 2: Run documentation checks**

Run:

```bash
git diff --check -- design/domains/stardew/integration.md design/tasks/active/stardew-product-launch-topology-consolidation.md
npm --prefix design run check
```

`npm --prefix design run check` validates documentation structure and links; it does not prove implementation or release acceptance.

---

## Task 6: Final verification and review gate

**Files:**
- No intended production changes; update only direct tests or docs required by Tasks 1–5.

- [ ] **Step 1: Search for forbidden direct product inputs**

Run:

```bash
rg "pipeName|bridgeToken|gameOperatorConfigPath|createKnownSemanticGameFacadeFromOperatorConfig|STARDEW_INTEGRATION_LAUNCHER" host/src tools
```

Review every remaining match. Remaining matches are acceptable only when they are Preview, Portfolio, tests of rejection, or coordinator/materializer-private construction; no shipped product caller may use raw operator attach.

- [ ] **Step 2: Run focused Host tests**

Run the repository's existing Host test command for:

```text
integration-catalog
semantic-game-operator-selection
stardew-integration-launcher rejection/private-boundary tests
stardew materializer
stardew production lifecycle coordinator
operational gate
Preview isolation
root command: node --test tools/run-game-operational-gate.test.mjs
```

- [ ] **Step 3: Run typecheck/lint for changed packages**

Use the existing root and Host commands from `package.json`; do not invent a new check script. A type or lint failure is a blocker.

- [ ] **Step 4: Run diff hygiene**

```bash
git diff --check
git status --short
```

Do not stage or delete unrelated worktree changes.

- [ ] **Step 5: Obtain independent review**

A fresh `reviewer` must review the completed implementation against:

```text
AGENTS.md
 design/domains/stardew/integration.md
 design/architecture/system-overview.md
 design/architecture/product-surfaces.md
 design/architecture/release-model.md
```

The reviewer must explicitly answer:

1. Was the direct operator attach path actually removed rather than hidden behind a fallback?
2. Is Preview still intentionally separate?
3. Is Portfolio untouched and isolated?
4. Is the coordinator still the sole shipped Stardew Game lifecycle owner?
5. Did the change avoid a new registry, compatibility layer, or over-engineered abstraction?
6. Are the current-owner installation-registration and bootstrap-containment blockers still represented correctly?
7. Do tests prove both rejection of the old path and preservation of the private materializer path?
8. Are there remaining direct product callers or ambiguous imports?

Implementation is not complete until the reviewer finds no blocking issue, or every finding is resolved and re-reviewed.

---

## Acceptance criteria

- [ ] The current Stardew domain owner records installation registration and bootstrap containment as closed, with their named production verification and independent review, before Tasks 1–6 mutate the product route.
- [ ] The shipped semantic Game composition cannot select or consume Stardew through raw operator-config `pipeName`/`bridgeToken` attachment.
- [ ] No fallback, compatibility alias, migration path, or alternate direct product topology remains.
- [ ] `StardewProductionLifecycleCoordinator` remains the sole shipped Stardew Game lifecycle owner.
- [ ] The private generation-bound Farmhand materializer path remains available only from the coordinator-owned composition.
- [ ] Preview remains a separate Preview-owned topology.
- [ ] Portfolio remains unchanged and isolated.
- [ ] The operational gate remains a harness and remains fail-closed on the current-owner predecessor blockers.
- [ ] Focused deterministic tests, changed-package typecheck/lint, and diff hygiene pass.
- [ ] A fresh `reviewer` approves the implementation against `AGENTS.md` and all listed current design documents.

## Stop conditions

Stop and request a design decision instead of adding a fallback if:

- the current Stardew domain owner still states that installation registration or bootstrap containment is incomplete when a worker reaches Task 1–6;
- the current owner does not name passing production verification and independent review for both predecessor capabilities;

- removing the direct route would require Preview or Portfolio to consume the production coordinator;
- the coordinator cannot receive a lawful fresh installation admission under the current Stardew domain contract;
- the private materializer requires raw operator config or a new public attach API;
- an existing caller cannot be classified as Preview, Portfolio, harness, coordinator-private, or shipped product;
- the proposed fix needs a new registry, universal launcher, compatibility layer, or second lifecycle authority;
- deterministic tests cannot distinguish rejection of direct attach from preservation of the private generation-bound path.
