---
id: PLAN-STARDEW-ACTION-LIVE-GATE-CONVERGENCE
type: implementation-plan
status: superseded
owner: stardew-integration
superseded_by: ../tasks/active/stardew-action-development-platform-convergence.md
---

# Stardew Action Live Gate Convergence Implementation Plan

> **Status: superseded.** Replaced by [Stardew Action Development Platform Convergence Implementation Plan](../tasks/active/stardew-action-development-platform-convergence.md). This document records the former fail-closed topology only; it is not implementation authority and must not be used to infer a current `production_lifecycle_owner_unavailable` requirement.
>
> **Historical evidence boundary:** The body below is a completed historical record. Preserve it read-only: do not reinterpret it as current behavior, migrate its route, or use it as live evidence. Current work may replace/delete only candidate action-development registry/`runLive`/lifecycle wiring under the active plan. It must preserve the published `equip_tool` production authority and observable behavior (catalog value, Host visibility, action ID, arguments, same-logical-action receipt semantics, and release status).
>
> **Current topology pointer:** The active plan freezes a Devkit-owned generic one-shot control-child supervisor extension/helper, called by the thin Stardew adapter, to supervise a Host-owned one-shot control runner. The adapter validates Stardew inputs and selects an optional generic Devkit profile; it cannot spawn a child or handle its streams, and the new Host route requires no profile or native-local path fields. The helper accepts one bounded stdin start, separates bounded stdout terminal result from stderr diagnostics, maps protocol failures, forwards caller cancellation/close, applies bounded drain/termination, and merges child exit/result using existing Devkit supervisor constants unless T1 records a concrete incident. The start carries `protocolVersion`, `runId`, platform-only `correlationId`, fixed `scenarioId: "equip_tool_control"`, and external deadline/cancellation intent; it carries no action ID, slot/arguments, `admittedRevision`, request identity, or canonical arguments JSON. After fixture preparation and attachment, Host selects the existing published action, derives legal slot/arguments, reads live revision, and mints `requestId`/`idempotencyKey`; `correlationId` is never receipt or recovery identity. A forced exit after a potential write returns indeterminate action/`recovery_incomplete`, with no adapter recovery or retry. Only the next Host-owned fresh lifecycle activation reopens the stable-scope journal and runs the T1-identified exact `StardewExecutionRecoverySupervisor` query; if T1 cannot identify its actual source symbol and caller, T2 is `BLOCKED`. Neither the port nor bridge/admission/journal/recovery authority crosses the process boundary. The active plan, not this historical record, defines the remaining protocol, fixture sequencing, cutover manifest, and validation.

**Goal (historical):** Prevent the native-local action-development topology from projecting a formal Stardew Action live-gate pass, while preserving deterministic action validation and diagnostic tooling until the production lifecycle owner can supply the execution authority.

**Architecture (historical):** `StardewProductionLifecycleCoordinator` remained the only formal Stardew lifecycle owner. The action-development registry kept `equip_tool` contract, status, and verifier mechanics, but its formal preflight and run-live registration failed closed with `production_lifecycle_owner_unavailable`; native-local launch/fixture code was diagnostic-only and unreachable from the formal registry and package runbook. No replacement lifecycle seam was introduced in that historical slice.

**Tech Stack:** Node.js ESM, `node:test`, Game Action Devkit, Markdown current-owner documentation.

**Spec:** `design/domains/stardew/integration.md`, `design/architecture/release-model.md`

## Global Constraints

- Formal Stardew product topology is owned only by `StardewProductionLifecycleCoordinator`.
- Preview, Portfolio, operational harnesses, and native-local diagnostics cannot manufacture production pipe, token, launch generation, session, or lifecycle authority.
- A harness may observe production authority but cannot replace it.
- The current headless operational gate remains blocked until installation registration and guardian containment are closed by the owning design.
- No live game or mutation command is run while implementing this plan.
- Existing historical action evidence remains immutable and untracked.

---

### Task 1: Fail-closed formal action registration

**Files:**
- Create: `integrations/stardew/action-development/src/equip-tool-production-gate.mjs`
- Modify: `integrations/stardew/action-development/src/action-registry.mjs`
- Test: `integrations/stardew/action-development/tests/project-adapter.test.mjs`

**Interfaces:**
- Produces: `preflightEquipToolProductionGate({ invocation })`, returning the exact bounded BLOCKED preflight fact for `equip_tool`.
- Produces: an `equip_tool` registration with no `runLive` handler and `blockedPolicy: { state: "BLOCKED", reasonCode: "production_lifecycle_owner_unavailable" }`.
- Preserves: contract check, status reader, receipt/evidence/postcondition verifier, and cleanup verifier.

- [x] Add a failing test that invokes the real production adapter for `preflight equip_tool` and expects only `production_lifecycle_owner_unavailable`, without touching a supplied native-local profile path.
- [x] Add a failing test that invokes the real production adapter for `run-live equip_tool` and expects the same bounded blocker without calling the former native-local lifecycle or creating evidence.
- [x] Implement the minimal production preflight blocker and remove the native-local `preflight`/`runLive` handlers from the formal registration.
- [x] Run the focused adapter and registration tests and confirm they pass.

### Task 2: Make native-local ownership diagnostic-only

**Files:**
- Modify: `integrations/stardew/action-development/src/equip-tool-preflight.mjs`
- Modify: `integrations/stardew/action-development/src/equip-tool-live.mjs`
- Modify: `integrations/stardew/action-development/tests/equip-tool-preflight.test.mjs`
- Modify: `integrations/stardew/action-development/tests/equip-tool-live.test.mjs`

**Interfaces:**
- Produces: explicitly diagnostic-only exported names for the existing native-local preflight and lifecycle implementation.
- Removes: any exported function named as the formal `runEquipToolLive` or formal `preflightEquipTool` implementation.
- Preserves: test-only dependency composition and historical evidence/verifier parsing.

- [x] Add source-contract tests proving the formal registry does not import a native-local run-live handler and diagnostic exports cannot be mistaken for formal production entrypoints.
- [x] Rename the native-local exports and internal imports to diagnostic terminology without changing their mechanics.
- [x] Run the native-local deterministic tests; they must continue to validate diagnostic behavior only.

### Task 3: Correct the authoritative runbook and current status

**Files:**
- Modify: `integrations/stardew/action-development/ACTION_RUNBOOK.md`
- Modify: `design/domains/stardew/integration.md`
- Test: `integrations/stardew/action-development/tests/project-adapter.test.mjs`

**Interfaces:**
- Documents: `action:run-live` is a generic Devkit command whose current `equip_tool` registration is formally blocked; it is not a native-local mutation instruction.
- Documents: native-local tooling is diagnostic/integration topology only and cannot close or publish an Action live gate.
- Documents: the unblock condition is a coordinator-owned execution capability after installation registration and guardian containment closure, not a new action-development lifecycle owner.

- [x] Replace the runbook's native-local formal live instructions with the fail-closed production blocker and explicit diagnostic boundary.
- [x] Update the current Stardew integration status with the action-live convergence decision and unblock condition.
- [x] Add a test that rejects documentation which advertises native-local `equip_tool` as a formal live gate.

### Task 4: Combined verification and review

**Files:**
- Verify all files above.

**Interfaces:**
- Verifies: formal preflight/run-live blocker producer → registry consumer → Devkit report projection.
- Verifies: no game process, lease, fixture transaction, or evidence writer is reachable from the formal blocked path.

- [x] Run focused project-adapter, registry, preflight, and live deterministic tests.
- [x] Run `pnpm --dir integrations/stardew/action-development action:ci`.
- [x] Run `git diff --check` and inspect the exact diff, excluding `integrations/stardew/action-development/artifacts/`.
- [x] Obtain one fresh independent review for authority, reachability, bounded diagnostics, and documentation correctness.
- [x] Commit the convergence change atomically; do not run a live game command.
