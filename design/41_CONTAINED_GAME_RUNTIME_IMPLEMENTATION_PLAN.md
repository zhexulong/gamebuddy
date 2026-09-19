# Contained Game Runtime and Trusted Game Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the reusable Desktop/Host/Guardian containment path and connect game-owned lifecycle authorization without changing any game action implementation.

**Architecture:** Desktop owns exact admitted child supervision, Guardian process containment, raw handles, EOF, and redacted protocol validation. Host composition owns one generic `ContainedGameRuntime`; its only narrow game-facing contract is `host/src/containment/runtime/contract/game-runtime.ts`, while implementation-private `host/src/containment/runtime/core/contained-game-runtime.ts` is imported only by `host/src/composition`. Each game lifecycle owns installation admission, role recipe, reservation, attestation, STOP, recovery, and product state; Stardew may import only the contract, never runtime/core, auth transport, bootstrap roots, Desktop/Guardian/Windows/native. Game runtime duration is lifecycle termination/STOP/crash, not a timeout. The only joint assembly point is `host/src/composition/`; composition may import and assemble one selected game adapter, while public/browser/runner may not import composition. Only generic `bootstrap/**` and `containment/runtime/**` must not import games; a game adapter must never import raw Desktop/Guardian/Win32 code. The lifecycle receives only a narrow private seam: no raw session/pipe/PID/Job/token/path, no global registry/daemon/browser handoff, and no fallback.

**Tech Stack:** TypeScript/Node, C#/.NET Windows Desktop, native C# Guardian, existing TypeScript AST/source-bound checker, existing Windows disposable fixtures, existing Host/Guardian protocol tests, Knip for orphan discovery only.

**Spec:** `design/adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md`; `design/architecture/system-overview.md`; `design/architecture/architecture-governance-and-anti-erosion.md`; `design/tasks/active/windows-desktop-runtime-supervisor-guardian-broker.md`; `design/tasks/active/stardew-bootstrap-containment-recovery.md`; `handoff-action-nav.md`.

## Frozen Shape B seam

The game-facing contract exposes a typed/private game-facts producer capability and never `Uint8Array` or native private-frame bytes. Host composition privately binds the selected game producer to a platform encoder/private launch transport and authenticated session. The generic runtime core owns one-shot authorization, role/deadline binding, serialization, terminal states, and redacted outcomes, but does not know game facts. Platform/auth modules alone handle native frame bytes. Chat and Game lifecycles remain independent; no global registry, daemon, browser handoff, fallback, hash, signature, or redundant gate is introduced.

The old `Uint8Array` producer and deferred launch plan are migration-before material only and must be removed before Shape B implementation acceptance; they are not compatibility or parallel production paths.

## Global Constraints

- `equip_tool`, `till_soil`, and every existing game action definition/handler/protocol remain unchanged by this plan.
- Do not add hashes, signatures, retry locks, self-attestation chains, or redundant gates. Every retained revision/fence/quarantine check must name the stale-writer, overlapping-attempt, identity-substitution, or failed-durable-write incident it prevents; remove any check that cannot name one.
- Generic containment must not know Stardew, SMAPI, Farmhand, action IDs, installation locators, game recipes, or game lifecycle state. Native private-frame derivation and encoding remain inside generic runtime/platform implementation.
- Game lifecycle may use only the narrow generic containment seam; it may not use raw pipe, token, PID, Job, handle, Win32, `node:child_process`, or native Guardian transport, except the explicitly owned Stardew process-owner file until its direct-spawn replacement task is complete.
- No public, serializable, replayable, or caller-mintable launch authorization; the game-facing producer supplies only a typed/private capability whose game-owned facts remain inside the composition closure. It never supplies native private-frame bytes. Runtime authorization is private, one-shot, role-bound, attempt-bound, and bound to one per-invocation `RoleLaunchOperation` deadline. Only `launch_role` carries that deadline. `arm`, `contain_role`, and `recover_attempt` use transport/operation wait budgets only where their wire requires them; those budgets are not the launch deadline or game lifetime. Create the launch operation only after lifecycle fresh admission and launch preconditions have passed and lifecycle has decided to launch. Bootstrap timeout, browser admission expiry, and owner/attempt expiry must not be reused. Every non-launch budget has a distinct owner and failure model.
- No compatibility alias, re-export, fallback, PATH/CWD/CLI/environment root selection, or parallel production lifecycle path.
- Every mutation lane has one writer and exact owned paths; unrelated dirty/staged changes are preserved and never reset, stashed, or committed by workers.
- Knip is reachability/orphan inventory only; it is not architecture proof.
- No live game mutation is allowed until the formal non-mutating preflight, target/version checks, cleanup path, and independent review all pass.
- Full-repository health is owned by other worktrees; this plan closes and verifies only the named seams and their dedicated gates.

---

## Parallel execution model

The following lanes may start together because their owned paths and acceptance scenarios are disjoint:

| Lane | Owner | Can start | Must wait for |
|---|---|---:|---|
| A. Desktop/Guardian EOF closure | Desktop C# | immediately | none |
| B. Generic runtime hardening | Host containment runtime | immediately | existing physical seam gate |
| C. Generic boundary gate | tools and gate tests | immediately | current directory contract only |
| D. Stardew handoff design | read-only first, then Stardew owner | immediately for design | generic interface card before implementation |
| E. Registration fresh-admission | Stardew coordinator/registration | immediately for inventory/tests; implementation after D | no shared files with A/B/C |
| F. Profile route removal inventory | action-development package | immediately | registration/control replacement contract |
| G. Action gate preparation | action contract/evidence docs/tests | immediately, no live mutation | published capability inventory |
| H. Final integration/release evidence | release/test owner | after A–G | all required lane gates |

No lane may edit another lane's owned files. A new writer is launched only when a failed check or new source fact changes the hypothesis.

---

### Task 1: Close the Desktop ↔ Guardian EOF and cleanup behavior

**Files:**
- Modify: `desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs`
- Modify: `desktop/GameBuddy.Desktop/GuardianSupervisor.cs`
- Test: `desktop/GameBuddy.Desktop.Tests/GuardianBrokerTests.cs`
- Test: `desktop/GameBuddy.Desktop.Tests/RuntimeSupervisorGuardianResidentIntegrationTests.cs`
- Test: `desktop/GameBuddy.Desktop.Tests/HostBootstrapSupervisorTests.cs`

**Produces:** A production broker that arbitrates Host pipe EOF against an in-flight or queued resident command; EOF cancels relay before native launch/success acknowledgement, closes Guardian control, waits bounded clean exit, drains ownership, and releases broker/Host/Guardian resources exactly once.

- [ ] Add the real cross-process test using the source-bound admitted Host fixture: attach resident Guardian, submit a command behind a barrier, close Host pipe, and assert no role activation/success acknowledgement and clean Guardian `ControlClosed` exit without timeout kill.
- [ ] Add attach failure cases for broker closed, Host exited, duplicate attach, and cancellation before attach; assert no residual relay and bounded cleanup.
- [ ] Run focused Desktop broker/Guardian tests and the exact fixture integration test.

**Acceptance:** `attach → queued command → Host EOF → no native launch/success ack → Guardian clean exit → resource settlement` is demonstrated by a real fixture, not only source assertions.

**Stop:** If fixture authentication, Guardian barrier, or process identity cannot be proven, report the exact prerequisite; do not weaken authentication or replace the E2E test with a passing fake.

---

### Task 2: Finish the generic `ContainedGameRuntime` contract and production owner

**Files:**
- Modify: `host/src/containment/runtime/core/contained-game-runtime.ts`
- Test: `host/src/containment/runtime/contained-game-runtime.internal.test.ts`
- Modify: `host/src/containment/runtime/README.md` (contract/core placement and migration rules)
- Modify: `host/src/composition/desktop-host-composition.ts` only when the generic owner is actually assembled

**Consumes:** Existing typed `DesktopGuardianSession`, current one-shot authorization tests, and the physical-seam gate.

**Produces:** A Host-private runtime that snapshots binding facts, serializes operations, arms once, binds role, consumes a private authorization once, rejects forge/replay/stale/wrong-role/expired/duplicate/failed-terminal operations, and returns only redacted outcomes.

- [ ] Keep authorization minting inside the private launch invocation; never export a mint factory.
- [ ] Preserve terminal state after arm, launch, and containment failure.
- [ ] Add/retain concurrent operation tests and source-bound public-surface assertions.
- [ ] Assemble it only through `host/src/composition/`; do not connect Stardew in this task.
- [ ] Run emitted focused runtime tests, Host typecheck for owned diagnostics, physical-seam gate, and scoped diff check.

**Acceptance:** The generic fixture passes without importing or naming any game-specific module and can be consumed by a future game adapter without modifying this runtime.

**Stop:** A requirement to add game-specific fields or raw executable/path/process facts to this interface is an architecture blocker.

---

### Task 3: Make the physical separation gate a permanent hard failure

**Files:**
- Modify: `tools/check-host-game-physical-seam.mjs`
- Test: `tools/check-host-game-physical-seam.test.mjs`
- Modify: `package.json` only if the existing focused scripts need correction
- Modify: `.github/workflows/ci.yml` only to add the already-green focused command at the agreed Host quality position

**Produces:** A bounded architecture gate proving directory ownership and dependency direction.

Rules:

- Only generic `bootstrap/**` and `containment/runtime/**` cannot import `games/**`; composition may import and assemble one selected game adapter, while public/browser/runner cannot import composition.
- A game adapter may import only `host/src/containment/runtime/contract/game-runtime.ts`. The implementation `host/src/containment/runtime/core/contained-game-runtime.ts` is imported only by `host/src/composition`; Stardew must not import `runtime/core`, `containment/auth`, `containment/windows`, bootstrap roots, Desktop/Guardian transport, Win32, or native modules.
- Raw Desktop/Guardian/Win32/native/process modules are forbidden from game adapters, except the explicitly named Stardew process-owner file until its replacement task closes.
- Test, fixture, and generated trees are excluded by both directory and filename policy.
- Static import, export, require, import-equals, dynamic import/require, missing/ambiguous/escaped/canonical path, bare builtin, and stale placement cases fail closed.
- The known Stardew-specific process owner must be physically under `games/stardew/lifecycle/`, never under generic `containment/windows/`.

- [ ] Keep exact-owner exceptions explicit and test them with a non-owner sibling and a second-game fixture.
- [ ] Run `pnpm test:host-game-physical-seam` and `pnpm check:host-game-physical-seam`.

**Acceptance:** A deliberate violation in a generic layer, Stardew sibling, or second-game fixture fails the command; the current relocated graph passes.

---

### Task 4: Implement the generic/game-owned authorization handoff and its exact gate edge

**Files:**
- Modify: `host/src/containment/runtime/{contract,core}/**` private runtime implementation and sole game-facing contract
- Create: `host/src/games/stardew/launch/**` authorization producer seam
- Modify: `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts` only for the final semantic launch consumer replacement
- Modify: `tools/check-host-game-physical-seam.mjs` and its test to allow only Stardew → `containment/runtime/contract/game-runtime.ts`; only `host/src/composition` may import `containment/runtime/core/contained-game-runtime.ts`
- Test: generic runtime tests and Stardew adapter tests

**Consumes:** Existing `OwnedPlayerHostBootstrapFacts`, request-local fresh `AdmittedStardewInstallation`, role recipe, registration attempt, a newly created private per-invocation `RoleLaunchOperation` (created after fresh admission/preconditions and the launch decision; only `launch_role` carries its deadline; not bootstrap/browser/owner/attempt expiry), Guardian binding, and native `launch_role` decoder. `player_host` and `ai_client` identify OS process roles only, not in-game NPCs or an AI companion.

**Produces:** One private callback boundary conceptually shaped as:

```ts
type RoleLaunchOperation = private per-invocation operation created by the game lifecycle
  after fresh admission/preconditions and the launch decision; only launch_role carries its deadline.

type TypedPrivateGameAuthorizationProducer = private producer of typed game facts/capability
  (never accepts or returns Uint8Array native frame bytes).

ContainedGameRuntime.launchRole(
  role: ContainmentRole,
  operation: RoleLaunchOperation,
  produceAuthorization: TypedPrivateGameAuthorizationProducer,
): Promise<RedactedRoleLaunchOutcome>
```

Host composition privately binds the producer to the platform encoder/private launch transport. Arm,
contain, and recover retain distinct transport/operation wait budgets with their existing owners and
failure outcomes; none supplies the role-launch deadline.

The callback is invoked only inside the existing **launch staged Player Host** / **launch materialized AI Client** fresh-admission and one-shot reservation scope. Stardew supplies a typed/private authorization producer capability containing game-owned facts; the generic runtime privately derives, encodes, and consumes the native frame. The resulting opaque authorization remains an internal runtime capability. Stardew does not expose paths, args, environment, native private frame bytes, or plan bytes as runtime interface fields or public data.

- [ ] Write the failing adapter tests first: fresh-admission failure, expired deadline, cross-composition binding, wrong role, replay, uncertain acknowledgement, and reservation terminalization.
- [ ] Locate and record the lifecycle-owned derivation of the per-invocation `RoleLaunchOperation` deadline; create it only after fresh admission/preconditions and the launch decision. Do not use bootstrap timeout, browser admission expiry, or owner/attempt expiry; record a distinct owner and failure model for every remaining deadline.
- [ ] Replace direct Node spawn consumption for **launch staged Player Host** with Guardian runtime launch only after the authorization producer and native verifier are connected.
- [ ] Replace direct Node spawn consumption for **launch materialized AI Client** while preserving its config reread, fresh per-invocation `RoleLaunchOperation` deadline creation after preconditions/launch decision, and reservation ordering.
- [ ] Delete the production direct Node role-spawn path; preserve only typed test seams where required by the current test architecture.
- [ ] Prove Guardian native creation uses suspended `CreateProcessW`, creation-time exact Job membership, membership verification, then resume.

**Acceptance:** The same generic runtime executes both `player_host` and `ai_client` roles; no action-specific code changes; direct Node role spawn is absent from production.

**Stop:** Missing authoritative deadline, installation capability, recipe, reservation, or native frame schema blocks implementation. Never add a fake/default producer.

---

### Task 5: Complete registration-backed lifecycle integration without topology relocation

**Files:**
- `host/src/stardew-installation-registration.internal.ts` (current authority path)
- `host/src/stardew-installation-admission.core.ts` (current authority path)
- `host/src/stardew-production-lifecycle-coordinator.internal.ts` (current authority path; do not relocate it in this task)

The process-owner files already moved under `host/src/games/stardew/lifecycle/` are not targets of this task and must not be restored to their former root paths.
- focused registration/coordinator tests

**Produces:** Setup persists only the minimal installation locator registration; every **launch staged Player Host** / **launch materialized AI Client** native effect fresh-admits from registration in a request-local callback; no retained `AdmittedStardewInstallation` crosses requests or launches.

- [ ] Preserve the existing registration revision and active-attempt fence only where they prevent a concrete stale writer or overlapping-attempt incident; do not add hashes, signatures, retries, locks, or derived identities.
- [ ] Make **launch staged Player Host** and **launch materialized AI Client** each independently fresh-admit immediately before their native effect.
- [ ] Prove the concrete failures that matter: malformed/foreign registration binding, locator identity substitution between selection and effect, and failed durable registration write. Each must stop the attempt rather than fall back.
- [ ] Prove no legacy profile fields are accepted by registration records.
- [ ] Do not move the coordinator, introduce a `StardewGameAdapter` proxy, or change its public caller graph here. A coordinator relocation is a later atomic topology task after a complete caller map and independent acceptance card.

**Acceptance:** Product/control start uses registration plus fresh admission only; no target profile, fixture path, lease root, release bundle, or client config enters the registration authority. The task does not claim a coordinator path relocation.

**Dependency:** Task 4's generic launch boundary and the lifecycle-owned per-invocation `RoleLaunchOperation` contract must be available before replacing the native role effect; inventory/tests may run earlier. Only `launch_role` receives that deadline. Desktop bootstrap/Guardian arm/contain/recover transport or operation wait budgets remain separate, each with its own owner/failure model, and cannot supply the role-launch deadline.

---

### Task 6: Remove the legacy profile/native-local route

**Files:**
- `integrations/stardew/action-development/src/profile.mjs`
- `integrations/stardew/action-development/src/equip-tool-preflight.mjs`
- `integrations/stardew/action-development/src/equip-tool-live.mjs`
- `integrations/stardew/action-development/src/equip-tool-lifecycle.mjs`
- `integrations/stardew/action-development/src/stardew-closure-backend.mjs`
- `tools/run-stardew-native-local-player-move-fixture.ps1`
- `packages/game-action-devkit/src/cli.mjs`
- `packages/game-action-devkit/src/project-runner.mjs`
- associated legacy tests and package scripts

**Produces:** No product/control consumer can use `gamebuddy-action-target-profile/v1`, `--profile`, native-local PowerShell launch, or action-specific live wrapper. The generic control runner uses registration-backed Host lifecycle instead.

- [ ] Inventory consumers and classify each as product, test-only, migration, or documentation before deleting.
- [ ] Add negative boundary tests proving the legacy route is absent/unreachable from product/control entrypoints.
- [ ] Delete the last implementation consumers atomically; do not add a compatibility migration.
- [ ] Use Knip after deletion only to identify remaining orphan files/exports; do not use it as the separation proof.

**Dependency:** Task 5 control/lifecycle entry must exist. This task can prepare inventory and tests in parallel.

---

### Task 7: Validate published actions without action-specific optimization

**Files:**
- existing action contract/evidence tests and manifests only;
- no generic runtime or Mod action implementation changes permitted

**Produces:** Final action-gate preparation for two already-published actions:

```text
equip_tool  — body_tools
 till_soil  — farming_crops
```

- [ ] Verify both actions remain published in the Mod-owned capability catalog and live advertisement.
- [ ] Define action-specific arguments and postconditions only in their existing action owners.
- [ ] Prove the generic runner/lifecycle changes only action identity, arguments, and action-owned oracle.
- [ ] Add/execute offline contract, cancellation, failure, uncertain receipt, replay/recovery, cleanup, and evidence checks.
- [ ] Do not run live mutation until Tasks 1–6 and formal preflight are closed.

**Acceptance:** Both published actions traverse the same generic lifecycle with zero action-runtime modifications; any required generic special case is a blocker.

---

### Task 8: Final closure and release evidence

**Files:**
- `handoff-action-nav.md`
- current task documents and release evidence files only

- [ ] Run the complete scoped Desktop/Host/Guardian matrix: build, focused tests, typechecks, physical seam gate, artifact check, and Windows fixture tests.
- [ ] Run fresh independent standards/security/spec reviews.
- [ ] Record every skipped prerequisite separately; a skipped release/runtime acquisition is not a pass.
- [ ] Confirm no second entry, legacy fallback, direct Node role spawn, or action-specific runner remains.
- [ ] Update handoff with exact commands, counts, skipped items, residual risks, and next owner.

**Acceptance:** Only after all required producer → consumer → correlation → verifier chains pass may the full Desktop↔Guardian↔Host task be marked complete.

---

## Fresh-subagent launch policy

For every task execution:

1. Launch a fresh scout or writer with one question, exact owned paths, acceptance scenario, and stop condition.
2. Use separate writers for A, B, C, D/E/F/G only when their files and authority are disjoint.
3. Run the cheapest check after each seam, then one combined focused check at lane end.
4. Launch one fresh reviewer after the writer's complete evidence is available.
5. If a worker times out/fails, inspect partial changes; do not resume it into a new architectural task unless required by the supervisor policy. Freeze a smaller successor slice.
6. Do not claim a lane complete when a required command is unavailable; record it as evidence pending.

## Current execution order

- [ ] Launch fresh scouts for Tasks 1, 4, 5, 6, and 7 in parallel.
- [ ] Keep Tasks 2 and 3 implementation-ready and preserve their already-green evidence.
- [ ] After Task 1 and Task 2 reviews pass, launch Task 4 implementation.
- [ ] After Task 4's handoff is proven, launch Task 5 implementation and Task 6 deletion in parallel where callers are disjoint.
- [ ] Run Task 7 offline evidence in parallel with Task 6; no live mutation.
- [ ] Run Task 8 only after all required gates and independent reviews pass.
