# Stardew Closure Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the design/95 `equip_tool` pilot's Stardew-owned lifecycle seam so one closure backend owns the fixture-to-SMAPI-to-scenario-to-restore process choreography and returns one bounded terminal result to the action adapter.

**Architecture:** Keep `@gamebuddy/game-action-devkit` game-neutral: it continues to own private-result claims and bounded child supervision. Add a Stardew project-local closure backend that owns only the Windows lifecycle command shape, its deadline containment, and validated bounded terminal lifecycle transport. The `equip_tool` adapter creates the action and lifecycle claims, calls that backend, validates the typed scenario proof only after a completed lifecycle result, then cleans up claims; it no longer assembles PowerShell arguments, reads a phase side-channel, or interprets raw child exit details.

**Tech Stack:** Node.js ESM, `node:test`, existing Game Action Devkit private-result/process-supervisor interfaces, Windows PowerShell lifecycle backend.

**Spec:** `design/95_CROSS_GAME_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md` Task 6 and aggregate acceptance; `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md` P2C/P2D.

## Global Constraints

- Do not modify production Stardew action handlers, Mod policy/catalog, Host protocol/schema/tool semantics, typed native dispatch, equip-tool Given, receipt semantics, or postcondition.
- Do not add Stardew/game/action knowledge to `packages/game-action-devkit`.
- Do not create a generic gameplay DSL, a generic success predicate, a generic native dispatcher, a second closure framework, compatibility reads, or fallback execution paths.
- Keep `tools/run-stardew-native-local-player-move-fixture.ps1` as the initial Windows implementation behind the project-owned backend; do not replace its real fixture semantics.
- Keep the existing `tools/lib/stardew-native-smoke-harness-v1.mjs` and `tools/run-stardew-native-local-player-equip-tool-smoke.mjs` as the action-specific bridge/scenario owners.
- Every public/durable failure must be a finite, content-free code. Do not propagate `cause`, `AggregateError.errors`, paths, command lines, PIDs, stdout, stderr, tokens, save content, or raw dependency messages.
- No live mutation, fixture preparation, save restore, SMAPI launch, bridge connection, or target lease acquisition is authorized while implementing this plan.
- Existing uncertain live evidence and preserved immutable staging are diagnostic records. Do not delete, overwrite, or reinterpret them.
- New/changed tests use the existing bounded iterative cleanup approach; do not introduce recursive deletion.

---

## Slice Card

**User-visible result:** `equip_tool`'s project adapter consumes one deterministic Stardew closure-backend terminal contract instead of independently orchestrating PowerShell arguments, phase claims, child exit taxonomy, and cleanup receipt parsing. A non-live conformance suite proves every modeled backend terminal outcome is bounded and correlated to the exact private lifecycle claim.

**In scope:** project-local backend module and direct tests; lifecycle transport serializer/CLI; PowerShell backend invocation/result publication; `equip_tool` lifecycle adapter cutover and its tests; package-local plan document.

**Explicit non-goals:** target-version live retry; any production action/Mod/Host change; new action; generic cross-game fixture library; migrating unrelated smoke runners; changing source/evidence projection artifacts; removing existing retained live evidence/staging.

**Required topology and authority boundary:**

```text
Devkit: private claim creation/cleanup + process containment
  -> Stardew closure backend: PowerShell argument shape + bounded lifecycle terminal parsing
    -> existing PowerShell transaction: fixture/deploy/save/SMAPI/bridge/scenario/restore
      -> existing equip_tool scenario: typed request + receipt + fresh postcondition
  -> equip_tool adapter: exact scenario-result verification + evidence finalization
```

The backend must not judge action success. The adapter must not know PowerShell argument construction or infer a backend phase from raw child output.

**Acceptance scenario:**

```text
Given an adapter-owned action claim and lifecycle claim for one run identity,
When the closure backend reports a completed lifecycle result and the scenario writes a valid exact proof,
Then the adapter returns the proof and can finalize a complete bundle only after immutable staging and lease cleanup.

Given the backend reports a bounded failed lifecycle phase, child timeout/spawn failure, child nonzero without a lifecycle result, or malformed/missing lifecycle result,
When the adapter invokes the backend,
Then it fails closed with a bounded lifecycle code, emits no raw detail, and does not accept an action proof.

Given the PowerShell backend fails in input validation, runner resolution, fixture preparation, working-save restore, SMAPI launch, pipe readiness, launch identity, live child, teardown, fixture restore, or working-save cleanup,
When its terminal result can be written,
Then it writes exactly one `gamebuddy-stardew-closure-backend-result/v1` lifecycle result bound to the private claim before exiting nonzero.
```

**Producer → consumer → verifier:** PowerShell lifecycle terminal outcome → exclusive private lifecycle result file → `runStardewClosureBackend()` parser → `runEquipToolLifecycle()` scenario admission → `runEquipToolLive()` bounded evidence metadata.

**Cheapest checks:** backend test after transport/runner edits; lifecycle adapter test after its cutover; PowerShell parser-only test after script edit. End-of-batch: focused backend/lifecycle/live tests, Devkit suite, `git diff --check`, fresh review.

**Mutation lanes:** one connected writer owns `integrations/stardew/action-development/src/stardew-closure-backend.mjs`, `src/equip-tool-lifecycle.mjs`, `src/write-lifecycle-result.mjs`, `scenarios/write-lifecycle-result.mjs`, `tools/run-stardew-native-local-player-move-fixture.ps1`, and their direct tests. No parallel writer touches those files.

**Independent read-only lane:** one reviewer checks ownership boundaries, terminal-result coverage, failure redaction, and removal of redundant phase side-channel.

**Launch budget:** one writer, one final reviewer, no live mutation.

**Stop/escalation condition:** stop and request a new design decision if one terminal lifecycle result cannot encode both required cleanup fact and one bounded backend failure without adding action semantics, game-neutral Devkit knowledge, or an execution fallback.

---

## File Structure

| File | Responsibility |
|---|---|
| `integrations/stardew/action-development/src/stardew-closure-backend.mjs` | Stardew-only lifecycle backend interface, strict input validation, PowerShell command construction, bounded supervisor/result classification, exact backend-result parsing. |
| `integrations/stardew/action-development/src/write-lifecycle-result.mjs` | Exact serializer and trusted exclusive writer for one terminal backend result. |
| `integrations/stardew/action-development/scenarios/write-lifecycle-result.mjs` | Thin CLI used by PowerShell to emit exactly one bounded backend result. |
| `tools/run-stardew-native-local-player-move-fixture.ps1` | Existing Windows transaction backend; publishes the one terminal lifecycle result on success or bounded phase failure. |
| `integrations/stardew/action-development/src/equip-tool-lifecycle.mjs` | Adapter-owned action/lifecycle claims, backend invocation, exact scenario proof verification, and claim cleanup only. |
| `integrations/stardew/action-development/tests/stardew-closure-backend.test.mjs` | Deterministic conformance of backend command/result/error taxonomy without PowerShell/game execution. |
| `integrations/stardew/action-development/tests/equip-tool-lifecycle.test.mjs` | Adapter conformance: valid proof after backend completion; failed/missing/invalid backend result blocks proof; claim cleanup stays exact and redacted. |
| `tools/run-stardew-native-local-player-move-fixture.test.mjs` or existing helper tests | Static/parser assertions that the real backend accepts one lifecycle result path and invokes the local writer on every terminal exit branch. |

## Contract

```js
// src/write-lifecycle-result.mjs
export const STARDew_CLOSURE_BACKEND_RESULT_SCHEMA =
  "gamebuddy-stardew-closure-backend-result/v1";

export function serializeStardewClosureBackendResult({ state, phase, code });
export async function writeStardewClosureBackendResult(resultFile, result);

// state === "completed": exact keys { schema, state }
// state === "failed": exact keys { schema, state, phase, code }
// phase is one LIFECYCLE_FAILURE_PHASES member.
// code is "failed" or "child_nonzero".

// src/stardew-closure-backend.mjs
export async function runStardewClosureBackend({
  projectRoot, profile, runId, releaseDir, actionResultFile, lifecycleResultFile,
  runChild = runBoundedChild, readResult = readPrivateResultFile,
  resolvePowerShell = () => "powershell.exe",
});

// Resolves only { state: "completed" }.
// Rejects only `stardew_closure_backend_<bounded_code>` errors.
// On a child terminal failure, consumes the lifecycle result first:
// - valid failed result => `phase_<phase>_<code>`;
// - missing/invalid result => `lifecycle_result_missing` / `lifecycle_result_invalid`;
// - supervisor timeout/spawn before child terminal output => `child_timeout` / `child_spawn_failed`.
```

### Task 1: Introduce the one-result lifecycle transport and backend conformance tests

**Files:**
- Create: `integrations/stardew/action-development/src/stardew-closure-backend.mjs`
- Create: `integrations/stardew/action-development/tests/stardew-closure-backend.test.mjs`
- Modify: `integrations/stardew/action-development/src/write-lifecycle-result.mjs`
- Modify: `integrations/stardew/action-development/scenarios/write-lifecycle-result.mjs`

**Interfaces:**
- Consumes: Devkit `runBoundedChild`, `readPrivateResultFile`; current profile fields and bounded phase list.
- Produces: `runStardewClosureBackend()` and one exact lifecycle terminal result schema for Task 2.

- [ ] **Step 1: Write failing backend conformance tests**

```js
await assert.rejects(
  () => runStardewClosureBackend({ ...input, runChild: async ({ args }) => {
    await writeStardewClosureBackendResult(value(args, "-LifecycleResultFile"), {
      state: "failed", phase: "fixture_prepare", code: "failed",
    });
    return { code: 2, signal: null };
  }}),
  /stardew_closure_backend_phase_fixture_prepare_failed/,
);
```

Add cases for: completed result and child exit `0`; child nonzero with missing result; child nonzero with malformed result; supervisor `test_supervisor_timeout`; supervisor `test_runner_failed:spawn`; child signal; exact flags including `-LifecycleResultFile` and no phase-file flag; `30_001ms` maps to `-TimeoutSeconds 31` and outer `61_000ms`; no `cause`/`errors`/raw PID/path/output reach the error.

- [ ] **Step 2: Run the new test to confirm the missing module/contract fails**

Run:

```bash
node --test tests/stardew-closure-backend.test.mjs
```

Expected: failure because `stardew-closure-backend.mjs` and the one-result transport do not yet exist.

- [ ] **Step 3: Implement exact lifecycle terminal serialization**

```js
export function serializeStardewClosureBackendResult({ state, phase, code }) {
  if (state === "completed" && phase === undefined && code === undefined) {
    return JSON.stringify({ schema: STARDew_CLOSURE_BACKEND_RESULT_SCHEMA, state });
  }
  if (state === "failed" && FAILURE_PHASE_SET.has(phase) && FAILURE_CODE_SET.has(code)) {
    return JSON.stringify({ schema: STARDew_CLOSURE_BACKEND_RESULT_SCHEMA, state, phase, code });
  }
  throw new Error("stardew_closure_backend_result_invalid");
}
```

Keep the existing trusted parent/exclusive `wx` writer. Change the CLI to require exactly `--result-file`, `--state`, and, for `failed`, `--phase`/`--code`; reject extra/missing state-specific arguments.

- [ ] **Step 4: Implement the Stardew-only backend**

The backend must:

1. validate absolute paths, nonempty `runId`, the existing exact profile fields, and `timeoutMs >= 30_000` before spawning;
2. use `Math.ceil(profile.timeoutMs / 1_000) * 1_000` for both `-TimeoutSeconds` and the child deadline, adding `30_000` milliseconds only to outer containment;
3. pass only `-ResultFile` and `-LifecycleResultFile` private paths plus the existing project/fixture/action arguments;
4. never read/parse the action result;
5. parse the terminal lifecycle result on child nonzero/signal before classifying generic child failure;
6. require exact `completed` result after child exit `0`; missing/invalid result fails closed;
7. discard all raw child/supervisor detail and throw only `stardew_closure_backend_<code>`.

- [ ] **Step 5: Run the backend conformance suite**

Run:

```bash
node --test tests/stardew-closure-backend.test.mjs
```

Expected: all backend tests pass; no PowerShell, fixture, SMAPI, bridge, target lease, or live action runs.

### Task 2: Cut the `equip_tool` adapter over to the Stardew closure backend

**Files:**
- Modify: `integrations/stardew/action-development/src/equip-tool-lifecycle.mjs`
- Modify: `integrations/stardew/action-development/tests/equip-tool-lifecycle.test.mjs`
- Modify: `integrations/stardew/action-development/tests/equip-tool-live.test.mjs` only if its real-claim fixture must pass the new backend dependency.

**Interfaces:**
- Consumes: `runStardewClosureBackend()` from Task 1 and the existing scenario-proof parser.
- Produces: existing `runEquipToolLifecycle()` public API with no phase claim/PowerShell construction and bounded adapter codes only.

- [ ] **Step 1: Write failing cutover tests**

```js
const backend = async ({ lifecycleResultFile }) => {
  await writePrivateResultFile(lifecycleResultFile, JSON.stringify({
    schema: "gamebuddy-stardew-closure-backend-result/v1", state: "completed",
  }));
  return Object.freeze({ state: "completed" });
};

const result = await runEquipToolLifecycle({ ...base, runBackend: backend });
assert.deepEqual(result.operationResult, proof);
```

Add a failed backend case asserting no scenario proof is read; a backend raw-error case asserting only `stardew_equip_tool_lifecycle_backend_<suffix>` is exposed without `cause`/`errors`; and assertion that only two claims are created/cleaned once each.

- [ ] **Step 2: Run the focused lifecycle tests to confirm old three-claim implementation fails the new assertions**

Run:

```bash
node --test tests/equip-tool-lifecycle.test.mjs tests/equip-tool-live.test.mjs
```

Expected: failure until the adapter calls the backend and removes the phase claim protocol.

- [ ] **Step 3: Replace adapter-owned process choreography with `runBackend`**

Remove PowerShell resolution, argument construction, `runChild`, phase-result parsing, phase claim creation, and phase claim cleanup from `runEquipToolLifecycle()`. Preserve only:

1. strict public input validation before claims;
2. action and lifecycle private claim creation with exact once-only cleanup;
3. `runBackend({ projectRoot, profile, runId, releaseDir, actionResultFile, lifecycleResultFile })`;
4. exact action proof parsing after backend completion;
5. bounded mapping of backend errors by the exact `stardew_closure_backend_` prefix;
6. current cleanup/result redaction and public `runEquipToolLifecycle()` shape.

Do not add a fallback to the legacy inline PowerShell implementation.

- [ ] **Step 4: Run adapter and outer orchestration tests**

Run:

```bash
node --test tests/equip-tool-lifecycle.test.mjs tests/equip-tool-live.test.mjs
```

Expected: complete bundle, incomplete bundle, backend failure, malformed/missing result, claim creation/cleanup, and proof validation cases pass with exactly two private claims.

### Task 3: Make the existing PowerShell transaction publish the canonical terminal result

**Files:**
- Modify: `tools/run-stardew-native-local-player-move-fixture.ps1`
- Modify: its existing static/helper test file(s) under `tools/`.

**Interfaces:**
- Consumes: Task 1 CLI `write-lifecycle-result.mjs` and `-LifecycleResultFile` private result destination.
- Produces: exactly one lifecycle result per normal PowerShell terminal path: `completed` after all cleanup completes, otherwise `failed` with a bounded phase.

- [ ] **Step 1: Add static failing assertions for canonical result ownership**

Assert that the script:

- declares `LifecycleResultFile`, not `LifecyclePhaseResultFile`;
- calls the package-local writer with `--state failed --phase $failurePhase --code failed` for every caught terminal failure;
- calls it with `--state completed` only after process teardown, fixture restore, and working-save cleanup succeed;
- does not reference `writeLifecycleCleanupResult`, a cleanup JSON schema, or phase side-channel output;
- leaves real fixture/SMAPI/action commands untouched.

- [ ] **Step 2: Run the static helper test and confirm it fails before the script cutover**

Run the existing focused Node/PowerShell parser-only test for `run-stardew-native-local-player-move-fixture.ps1`.

Expected: failure due to old `-LifecyclePhaseResultFile` and split cleanup/phase publication.

- [ ] **Step 3: Cut over the script while preserving transaction behavior**

Replace `Publish-FailurePhaseReceipt()` with a writer invocation that emits the one failed terminal result. Replace successful cleanup publication with the completed terminal result. Keep its existing `try`/`finally`, action scenario invocation, process cleanup, fixture restore, and save cleanup sequence intact. If terminal-result publication itself fails, leave the result absent and exit nonzero; the backend will classify this as `lifecycle_result_missing` without exposing raw error detail.

- [ ] **Step 4: Run parser/static tests**

Run the focused PowerShell parser/static test plus:

```bash
powershell.exe -NoProfile -Command "[void][scriptblock]::Create((Get-Content -Raw 'tools/run-stardew-native-local-player-move-fixture.ps1')); 'parse-ok'"
```

Expected: parser succeeds and static tests prove all terminal branches use the one canonical output path. No script execution occurs.

### Task 4: Verify the end-to-end offline closure contract and record the design cutover

**Files:**
- Modify: `design/98_STARDEW_CLOSURE_BACKEND_IMPLEMENTATION_PLAN.md` checkboxes/verification record.
- Modify direct files only if focused failures reveal a contract gap.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: no new runtime interface; a verified migration record.

- [ ] **Step 1: Run end-to-end deterministic tests**

Run:

```bash
node --test tests/stardew-closure-backend.test.mjs tests/equip-tool-lifecycle.test.mjs tests/equip-tool-live.test.mjs
pnpm --filter @gamebuddy/game-action-devkit test
```

Expected: all non-platform cases pass. Any Windows-only test is reported as an explicit platform skip, not as a success substitute.

- [ ] **Step 2: Run package-owned deterministic suite only if unrelated dirty projection inputs do not block it**

Run:

```bash
pnpm --dir integrations/stardew/action-development test
```

If it fails in a non-owned dirty projection/Host/Navigation path, record the exact independent failure; do not regenerate its artifact or absorb the other lane. Re-run the complete focused backend contract separately and keep this slice's claim scoped to its owned evidence.

- [ ] **Step 3: Run hygiene and independent review**

Run:

```bash
git diff --check
```

Then commission one fresh read-only review of the actual diff, checking: one lifecycle terminal schema, backend-vs-adapter authority boundary, no legacy inline execution fallback, exact private result ownership, bounded error redaction, and no live mutation.

- [ ] **Step 4: Mark completed checks in this plan and make a scoped atomic commit**

After all required checks and review pass, update only the verification record in this plan. Use a path-limited Git commit that contains only the reviewed closure-backend files; preserve existing unrelated index/worktree changes. Push only after the scoped commit is verified.

## Self-Review

- **Spec coverage:** Task 1/2 implement design/95 Task 6's project-adapter→fixture backend→scenario chain, private transport, timeout/crash/missing/invalid behavior, and exact scenario verifier. Task 3 preserves existing runtime semantics while making the fixture backend emit one bounded result. Task 4 covers deterministic acceptance, independent review, and scoped integration verification. design/38 P2C/P2D is met by retaining action-specific typed scenario ownership while consolidating only lifecycle mechanics.
- **No placeholders:** all task files, interface names, failure states, commands, and expected results are explicit.
- **Type consistency:** `runStardewClosureBackend`, `writeStardewClosureBackendResult`, `STARDew_CLOSURE_BACKEND_RESULT_SCHEMA`, `actionResultFile`, and `lifecycleResultFile` use the same names throughout.

## Execution Handoff

User explicitly authorized execution on 2026-08-29. Execute Tasks 1–4 through the project `subagent-driven-development` workflow: one connected writer owns the lifecycle producer→consumer→verifier chain, then one fresh final reviewer gates the actual diff. No live-mutation lane is authorized.


## Cross-Game Architecture Acceptance (added after user review)

This plan is a Stardew pilot implementation of the cross-game boundary, not a proposal for a Stardew-shaped universal runner. The reusable product of the slice is the **role contract** between the game-neutral Devkit, a game-owned closure harness, and an action-owned scenario. The implementation must demonstrate that a future game can provide different launch, fixture, bridge, and restore mechanics without changing the Devkit or importing Stardew concepts.

### Stable cross-game contract

The Devkit consumes only game-neutral facts and mechanics: project invocation, bounded child containment, private result ownership, correlation, evidence finalization, and complete/incomplete admission. It must not know `SMAPI`, `Stardew`, save slots, named pipes, fixture roots, or action success.

Each game project owns a closure harness with this conceptual boundary:

```js
runGameClosure({
  runIdentity,
  targetProfile,
  stagedArtifact,
  scenario,
  privateResults,
  deadline,
}) => Promise<{
  state: "completed" | "incomplete",
  lifecycle: "completed" | "failed",
  failure?: { phase: string, code: string },
  cleanup: { state: "completed" | "uncertain" },
  scenarioResult: "private-result-reference",
}>
```

This is a role contract, not a shared implementation or a universal gameplay schema. `phase` values and profile fields remain game-owned. The Stardew implementation may use PowerShell, SMAPI, save fixtures, and a pipe; another game may use a different loader, snapshot, transport, or restore mechanism.

The action scenario owns only typed invocation, target selection, action receipt/evidence, and fresh action-specific postcondition. The closure harness must not decide whether `equip_tool` succeeded; the Devkit must not decide any game action outcome.

### Architecture proof required by this pilot

The offline conformance tests must prove all of the following from the actual producer → consumer → verifier chain:

- the Devkit-facing backend seam contains no Stardew-specific fields or imports in the Devkit;
- `equip_tool` adapter contains no PowerShell command construction, phase-claim orchestration, or raw child classification;
- Stardew-specific lifecycle details are confined to the project-owned harness/backend and existing Stardew scenario/fixture owners;
- a fake second-game-shaped harness can satisfy the same game-neutral adapter seam using different phase names and transport details without modifying the Devkit or the `equip_tool` scenario verifier;
- action proof remains action-owned and is not synthesized from lifecycle completion;
- lifecycle completion and action success remain independent facts;
- incomplete/uncertain cleanup blocks complete evidence regardless of the action proof;
- no legacy inline execution path remains after cutover.

A test that only proves a Stardew PowerShell command works is insufficient architecture evidence. The required evidence is a game-neutral seam test plus Stardew conformance tests.

### Revised implementation order

1. Define and test the minimal project-owned `GameClosureHarness` role seam using injected harness behavior; first prove completion, bounded failure, incomplete cleanup, and action-proof separation with a fake non-Stardew-shaped harness.
2. Adapt the existing Stardew PowerShell transaction behind that seam without changing its gameplay or fixture authority.
3. Cut `equip_tool` over so its adapter consumes the seam and owns only action proof verification and claim/evidence policy.
4. Run cross-game contract, Stardew lifecycle, adapter, Devkit, and package deterministic gates; independently review the actual diff for abstraction leakage.

The pilot is architecturally complete only when both the behavioral pilot contract and the cross-game role contract pass. A green Stardew-only test suite is not sufficient.

### Plan self-review correction

The original plan's proposed `STARDew_CLOSURE_BACKEND_RESULT_SCHEMA` spelling was corrected to `STARDEW_CLOSURE_BACKEND_RESULT_SCHEMA`. The backend result schema is project-local transport, not a Devkit public schema. The plan does not require a universal lifecycle phase vocabulary, universal fixture API, or a new Devkit game adapter registry.

### Revised stop condition

Stop if the existing `runEquipToolLifecycle()` cannot consume a game-owned harness seam without retaining duplicated PowerShell/phase/child mechanics, or if proving a second-game-shaped injected harness requires Stardew fields in the Devkit. Report the exact authority conflict instead of widening the shared abstraction.

## Revision Record

- **2026-08-29:** Reframed the slice from a Stardew-specific backend refactor into a proof of the cross-game Devkit → game-owned closure harness → action-owned scenario boundary. Added fake second-game-shaped conformance, explicit rejection of universal lifecycle vocabulary, and architecture acceptance independent of live mutation.
- **User approval:** The revised plan is approved for implementation; live mutation remains out of scope.

### Revised Task 0: Prove the cross-game role seam before Stardew wiring

**Files:**
- Create: `integrations/stardew/action-development/src/game-closure-harness.mjs`
- Create: `integrations/stardew/action-development/tests/game-closure-harness.test.mjs`

**Interfaces:**
- Produces a game-neutral orchestration helper that accepts an injected game-owned harness and an action-proof verifier; it contains no Stardew imports, phase vocabulary, or PowerShell mechanics.
- The helper returns lifecycle completion separately from scenario proof and cleanup state, and maps only bounded harness failure categories.

- [ ] **Step 1:** Write a fake harness conformance test with a non-Stardew phase (`account_snapshot`) and a fake action proof. Verify completed lifecycle does not synthesize proof, failed lifecycle does not read/accept proof, and uncertain cleanup yields `incomplete`.
- [ ] **Step 2:** Implement the smallest injected role helper; no Devkit changes and no universal phase enum.
- [ ] **Step 3:** Run `node --test tests/game-closure-harness.test.mjs` and verify the fake second-game-shaped contract passes.

Task 1 then supplies Stardew's concrete backend transport and Task 2 cuts `equip_tool` over to the role helper. If the existing adapter's evidence/claim ownership makes this decomposition impossible without duplicating claims, stop and revise the slice rather than introduce a second owner.

## Updated completion evidence

Before any future live authorization, the final report must separately name:

1. **Cross-game architecture evidence:** fake non-Stardew-shaped harness conformance and proof that Devkit remains game-neutral.
2. **Stardew implementation evidence:** PowerShell parser/static checks, exact lifecycle result transport, fixture/restore result semantics, and adapter tests.
3. **Action evidence:** existing `equip_tool` scenario proof verification and fresh postcondition checks (offline only in this slice).
4. **Safety evidence:** no live mutation, no retained legacy fallback, bounded redaction, scoped diff, and review verdict.

No one of these categories substitutes for another.
