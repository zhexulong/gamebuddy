# M8 Enter Mine Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `enter_mine` 正式纳入 Portfolio M8，作为 Mine exterior 到 `MineShaft` floor 1 的独立 action，并保持 `use_mine_ladder` 与 `select_mine_elevator_floor` 的独立 closure。

**Architecture:** 复用现有 Portfolio `enter_mine` 的 target-version protocol、game-thread coordinator、semantic adapter、scope/binding、receipt/evidence、fresh floor reread、single-SMAPI launcher、profile transaction 和 restore pipeline。`enter_mine` 不负责 Farm 到 Mine exterior 的 Navigation；Navigation 是独立后续 action。组合 runner 只能编排已经独立关闭的 action，不能替代 action-specific live closure。

**Tech Stack:** C# target-bound Stardew Mod (`net6.0`), TypeScript Host protocol/bridge, Node.js ESM runners/tests, JSON/Markdown design artifacts.

**Spec:** `design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md`, `design/15_STARDEW_CAPABILITY_SET.md`, `design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md`, and the revised M8 section of `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`.

## Global Constraints

- Target version is Stardew Valley `1.6.15`, build `24356`.
- Portfolio topology is `single_player_native_companion`; Farmhand and native-local evidence cannot close Portfolio.
- M8 actions are independent: each requires its own typed request, terminal receipt, non-empty evidence, fresh action-specific postcondition, teardown/restore, and review.
- `enter_mine` Given is a fresh Mine-exterior location observation; this action does not perform Farm-to-Mine Navigation, require a UI interaction pose, or move the player.
- No UI, keyboard/mouse/XInput injection, direct action save edit, generic dispatcher, raw coordinates, or arbitrary native fallback. A launcher-owned staged-save Given fixture may prepare an isolated validation slot only under `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`; it is not callable by this action, cannot alter canonical saves, and cannot provide action evidence or results.
- M8 launcher starts one `StardewModdingAPI.exe` root; SMAPI owns the game child and shared teardown performs residual-process checks before restore.
- P0b signed evidence and attestation are not an M8 admission or exit gate.

---

### Task 1: Reconcile M8 authority and descriptions

**Files:**
- Modify: `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md` at M8 action-set sections and completion predicate
- Modify: `design/37_STARDEW_ACTION_DEVELOPMENT_ENGINEERING_BOTTLENECK_HANDOFF.md` at the current M8 roadmap and removed-tracer disposition
- Modify: `design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md` only where wording incorrectly makes entry future/removed
- Modify: `design/15_STARDEW_CAPABILITY_SET.md` M1-M10 action-selection table if needed for exact wording
- Modify: `design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md` only if it contradicts the three-action decomposition

**Interfaces:**
- Produces the authoritative three-action M8 set: `enter_mine`, `use_mine_ladder`, `select_mine_elevator_floor`.
- Preserves Navigation as a separate action set and defines `enter_mine` Given as Mine exterior.

- [ ] Replace every current-M8 statement that says only ladder/elevator are in scope with the three-action list.
- [ ] Replace “removed enter_mine” statements with the new independent-action rule and reference this plan.
- [ ] Keep the explicit rule that Navigation reaches Mine exterior and does not call M8 actions.
- [ ] Run `rg -n 'M8|enter_mine|已移除'` over the affected design files and inspect every remaining result.

### Task 2: Make launcher/profile action selection independent

**Files:**
- Modify: `tools/launch-stardew-portfolio-m8-action-live.mjs`
- Modify: `tools/launch-stardew-portfolio-m8-action-live.test.mjs`
- Verify: `tools/lib/stardew-portfolio-profile.mjs`

**Interfaces:**
- `ACTION_RUNNERS.enter_mine` becomes an entry-only runner.
- `ACTION_ENABLED_SETS.enter_mine` becomes `['enter_mine']`; the runner must not silently enable ladder.
- `verifyPreparedM8Profile()` remains exact and default-deny.

- [ ] Add `tools/run-stardew-portfolio-m8-entry-action.mjs`, with the existing entry probe/start/terminal/fresh-floor sequence and no ladder request.
- [ ] Add source tests asserting entry runner never references ladder/elevator route requests.
- [ ] Change launcher tests from composite route mapping to entry-only mapping and reject an entry profile that also enables ladder.
- [ ] Run the focused launcher and entry-runner tests.

### Task 3: Static, target-bound, and contract closure

**Files:**
- Verify affected C# and Host protocol files; modify only if the independent action contract exposes a real mismatch.
- Test: existing Portfolio coordinator/protocol/interop contracts and new entry-runner tests.

**Interfaces:**
- `enter_mine` retains its independent receipt/evidence/postcondition contract: after fresh Mine-exterior and game-thread policy/state revalidation, it arms and directly calls the fixed native default-entry seam `Game1.enterMine(1)`. The Agent cannot select a floor or layout, and the action does not require a `checkAction`/`GetGrabTile` UI-ingress pose.

- [ ] Run the target-bound Mod build for Stardew `1.6.15` build `24356`.
- [ ] Run Portfolio Host protocol/interop and M8 focused tests.
- [ ] Run `git diff --check`.
- [ ] Keep the missing aggregate structural contract and stale provenance document as explicit residual blockers if they still fail; do not create placeholders.

### Task 4: Serial live gates

**Files:**
- Use the existing M8 profile preparation and launcher plus, only when a declared Given requires it, the isolated staged-save validation fixture from `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`; no action-owned live infrastructure.

- [ ] Complete independent non-mutating preflight for `enter_mine` with a real Mine-exterior Given.
- [ ] Run one target-version `enter_mine` mutation and verify its own receipt/evidence/floor-1 reread.
- [ ] Re-prepare or reuse only according to the transaction contract, then run one independent ladder/elevator mutation.
- [x] The M8 action set is complete: `enter_mine`, `use_mine_ladder`, and `select_mine_elevator_floor` each have independent target-version closure records. Elevator's accepted successor journal is `.tmp/m8-live-runs/m8-elevator-staged-action-v2.json`; its older v1 journal remains evidence-incomplete and rejected.
- [ ] If a future product Goal needs to claim one end-to-end mine-depth outcome, design `reach_mine_floor` as a separate read-only aggregate evaluator. It is not an M8 action, capability, bridge route, tool, or M8 completion gate; it may not send requests, move/warp the player, mint receipts, or consume fixture-owned temporary unlocks as persisted-progress proof.

Stop if Mine-exterior Given is absent, binding topology is not single-player, a second Stardew process appears, profile restore cannot be verified, or any action lacks independent evidence/postcondition.
