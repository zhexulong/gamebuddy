# Stardew native-local action batching handoff

> **Purpose:** assign independent workers the next bounded `native_local_player_fixture` action work without mixing it with Farmhand, Portfolio, release, or unrelated worktree changes.
>
> **Current status (reconciled 2026-08-11):** every action in the current `STARDEW_ACTION_REGISTRY → PUBLISHED_STARDEW_ACTIONS` projection (**24 published**) and the three current experimental actions has a recorded target-version **shared native-local mechanics** pass in `fixtures/stardew/RUNBOOK.md`. In particular, `pet_animal`, `npc_relationship`, `machine_load`, and `machine_collect_output` are **passed**, not queued or blocked. These records are not Farmhand, Portfolio, publication, release, or save/reopen evidence. `machine_configure` is excluded because the pinned content exposes no normal configuration ingress.
>
> **Status authority:** `design/22_STARDEW_NATIVE_LOCAL_CLOSURE_BOARD.md` is the current action-status ledger. This file assigns current work only; `fixtures/stardew/RUNBOOK.md` records fixture and live-evidence procedures. Historical A–D rationale below is archival whenever it conflicts with the ledger or RUNBOOK, and must not authorize an implementation, a serial gate, or reopening a passed action.

## 1. First read: authoritative rules

Every worker must read these files before editing:

1. [`.agents/skills/stardew-action-closure-batching/SKILL.md`](.agents/skills/stardew-action-closure-batching/SKILL.md) — **required SOP** for this batching lane.
2. [`fixtures/stardew/RUNBOOK.md`](fixtures/stardew/RUNBOOK.md) — native-local harness setup, evidence, and teardown procedure.
3. [`design/15_STARDEW_CAPABILITY_SET.md`](design/15_STARDEW_CAPABILITY_SET.md) — capability semantics; it is not a current implementation queue.
4. [`design/20_STARDEW_PORTFOLIO_CAPABILITY_SET.md`](design/20_STARDEW_PORTFOLIO_CAPABILITY_SET.md) only when changing a statement about capability status.

Do **not** use the `stardew-vertical-slice` SOP for this handoff unless the task is explicitly moved to the separate `single_player_native_companion` Portfolio topology.

### Non-negotiable evidence boundary

```text
fixture creates a player-achievable initial condition
production action alone causes the claimed transition
matching terminal request/execution receipt + fresh postcondition proves closure
```

A fixture in the disposable working save may place an intact target, create an adult ready-product animal, provide a matching tool, establish a nearby NPC/Pet, or set a legal approach position before bridge attachment. It must **not** call the production ingress (or an equivalent native ingress), pre-damage/remove a target, consume input, add output, modify relationship/daily outcome facts, or create a receipt.

Every successful native-local run must be reported only as:

```text
shared native_local_player_fixture mechanics evidence
≠ Farmhand evidence
≠ Portfolio / release / publish evidence
≠ save/reopen evidence
```

## 2. Current environment

All paths below were verified to exist on this Windows machine at handoff time.

| Role | Path / value |
|---|---|
| Repository root | `E:\projects\ai-game-companion` |
| Target-version game/SMAPI launch root | `E:\temp\gamebuddy-stardew-ai-client` |
| Licensed reference game install | `D:\Steam\steamapps\common\Stardew Valley` |
| Native-local SMAPI profile (`--mods-path`) | `C:\Users\27251\AppData\Local\GameBuddy\stardew-profiles\native-local-move` |
| Native-local fixture root | `C:\Users\27251\AppData\Local\GameBuddy\stardew-fixtures` |
| Active Stardew save root | `C:\Users\27251\AppData\Roaming\StardewValley\Saves` |
| Current read-only fixture template | `GameBuddyFixtureStable_445936768` |
| Binding artifact | `C:\Users\27251\AppData\Local\GameBuddy\stardew-fixtures\GameBuddyFixtureStable.native-local-binding.json` |
| Mod profile config | `C:\Users\27251\AppData\Local\GameBuddy\stardew-profiles\native-local-move\GameBuddy\config.json` |

The target game is Stardew Valley **1.6.15.24356**. Use the target-version APIs/source; do not replace behavior with generic save/XML edits, UI automation, raw keyboard/mouse input, debug completion, or arbitrary native dispatch.

### Shared harness entrypoint

```powershell
$repo = 'E:\projects\ai-game-companion'
$game = 'E:\temp\gamebuddy-stardew-ai-client'
$mods = 'C:\Users\27251\AppData\Local\GameBuddy\stardew-profiles\native-local-move'
$fixtures = 'C:\Users\27251\AppData\Local\GameBuddy\stardew-fixtures'
$save = 'GameBuddyFixtureStable_445936768'

Set-Location $repo
powershell -NoProfile -File tools/run-stardew-native-local-player-move-fixture.ps1 `
  -GamePath $game -ModsPath $mods -FixtureRoot $fixtures -SaveName $save `
  -Action <action-id> -TimeoutSeconds 150
```

This script owns the native-local profile transaction, Release bundle deployment, one SMAPI process, runner invocation, profile restoration, and process guard. A mutation live gate must run **serially**: no other worker may edit the profile, fixture template/working save, or launch Stardew while it is running.

`clear_debris`, `npc_relationship`, and `pet_animal` have each completed one serial target-version native-local mechanics gate. Their fixed/pre-attachment fixtures and bounded runners are documented in `fixtures/stardew/RUNBOOK.md`; do not reopen or treat any of these records as Farmhand, Portfolio, release, publish, or save/reopen evidence.

## 3. Workspace discipline

The worktree is intentionally dirty with large, unrelated continuity, Tavern, Portfolio, voice, and gameplay-accounting work. Workers must:

- launch with `context: "fresh"`; the current long-lived parent conversation must never be inherited for this native-local batching lane;
- receive a compact task contract naming one decision/deliverable, exact authoritative docs/source seams, ownership, and stop condition — not copied session history, broad diffs, or a full SOP;
- for read-only scout/review work, inspect only named files and targeted diffs; do not run whole-worktree `git status`/`git diff` in this intentionally dirty repository;
- work in checkpoints (bounded inspection → narrow edit or finding → targeted verification → report), and stop once the contract is decided rather than repeating source reads;
- on `context_too_large` or timeout, preserve any artifact and retry with a **new fresh child** narrowed to one seam; do not resume the saturated session;
- touch only their assignment files;
- inspect the current diff before editing;
- never reset, checkout, reformat, stage, commit, or discard unrelated work;
- report exact changed files and commands run;
- use one writer for each shared file; coordinate before editing `ModEntry.cs`, `ExecutionManager.cs`, `BridgeProtocol.cs`, `ModConfig.cs`, `host/src/protocol.ts`, `protocol/bridge-v1.schema.json`, `tools/lib/stardew-native-local-player-fixture.mjs`, or `tools/stardew-native-local-player-fixture.test.mjs`;
- leave target-game mutation to the designated serial gate owner.

No secrets/tokens from profile config or bridge artifacts belong in source, handoff notes, logs, or chat reports.

## 4. Current work allocation

The following assignments are current. They are deliberately parallel unless an item writes a shared file or enters a target-game mutation gate.

| Lane | Owner | Deliverable / stop condition |
|---|---|---|
| Closure-ledger reconciliation | Integration owner | Keep the closure board complete for the real registry and keep this handoff free of stale queue/blocker claims. Documentation only; no game launch. |
| Production-artifact migration inventory | Independent worker | Read-only inventory of runner import paths and non-overlapping migration waves. It does not change the shared resolver. |
| Async lifecycle audit | Independent worker | Pinned-source start/observe/cancel/recovery decision for one blocked lifecycle (beginning with `use_warp_item`). Stop at a concrete ingress/lifecycle verdict. |
| Shared runner/evidence harness | Integration owner | Design and then sequence a minimal P1.7 typed terminal-evidence seam. Do not erase action-specific guards/postconditions. |
| Target-game mutation gate | Integration owner only | May begin only after its static slice, targeted checks, and independent review pass. Exactly one gate at a time. |

No passed mechanics action is assigned for reimplementation. A new typed action may be assigned only after source, fixture provenance, and exact terminal postcondition make it `implementation_needed` or `fixture_needed`; current `dependency_blocked` rows remain audit-only.

## 5. Closure board and historical assignments

### Board

| Action | State | Assignment | Live-gate owner | Definition of next completed handoff |
|---|---|---|---|---|
| `collect_animal_product` | **passed** native-local mechanics | Documentation-only follow-up, if needed | N/A | Preserve current result; do not reopen unless regression found. |
| `chop_tree_source` | **passed** native-local mechanics | Documentation-only follow-up, if needed | N/A | Preserve current result; do not reopen unless regression found. |
| `clear_debris` | **passed** native-local mechanics | Documentation-only follow-up, if needed | N/A | Preserve the fixed-fixture receipt-plus-fresh-postcondition result; do not reopen unless regression found. |
| `pet_animal` | **passed** native-local mechanics | Documentation-only follow-up, if needed | N/A | `native_pet_animal_v1` established one unpetted native Dog; production alone returned `succeeded/pet_completed` with `grantedFriendshipForPet=false→true` evidence, friendship `0→12`, and fresh target absence. |
| `npc_relationship` | **passed** native-local mechanics | Documentation-only follow-up, if needed | N/A | `native_npc_relationship_v1` establishes bounded Robin `(64,17)` with persisted `250` relationship facts without production mutation; target-version serial run passed `succeeded/npc_relationship_inspected`, evidence matched, and fresh reread was unchanged. |
| `machine_load` | **passed** native-local mechanics | **D1 — normal-ingress slice and target-version receipt verified** | `native_machine_coffee_load_v1` | The finite Keg `(BC)12` / `Default_CoffeeBeans` contract is bound to target `Machines.xnb`. Production revalidates a single adjacent idle Keg and exact 5× `(O)433` slot, then invokes the normal `GameLocation.checkAction` ingress—never `PlaceInMachine` or `performObjectDropInAction`. Serial live run returned same-execution `succeeded/machine_coffee_loaded`; fresh reread proved Coffee `(O)395`, `lastInput=(O)433`, input removed, and `minutesUntilReady=120`. This is mechanics-only, not Farmhand/Portfolio/publish/release/save-reopen evidence. |
| `machine_collect_output` | **passed** native-local mechanics | **D2 — normal collection ingress and full ready lifecycle verified** | `native_machine_coffee_load_v1` | Same target-version serial run first production-loaded the finite Keg and fresh-observed `minutesUntilReady=120`, then waited for real native clock progression to the same target’s fresh `ready=true`, held `(O)395`, `minutesUntilReady=0` state. Production invoked `GameLocation.checkAction` to collect; receipt `succeeded/machine_coffee_collected` proved Coffee inventory `0→1`, held output cleared and native ingress. Fresh reread proved the same Keg idle (`held=null`, `ready=false`, `minutesUntilReady=0`). Fixture never wrote processing/ready/output inventory state; restore and working-save cleanup passed. Mechanics-only, not Farmhand/Portfolio/publish/release/save-reopen. |

The A–D subsections below are **archived evidence only**, including any old `dependency_blocked`, “do not launch”, or proposed-output language. They are not current assignments and must not be used to reopen a passed action. Current assignments are only the table in §4 and the closure board; any later implementation lane still requires non-overlapping file ownership.

### A — `clear_debris`: completed resource-clump mechanics closure

**Closure record:** this route passed its serial target-version native-local mechanics gate. Before bridge attachment, `native_clear_debris_resource_clump_v1` establishes exactly one intact `2×2` `ResourceClump` with `parentSheetIndex=752` at Farm `(62,17)`, health `8`, and one basic Pickaxe; it rejects unavailable fixed geometry or a pre-existing `parent=752` clump, and never hits/removes the clump, collects drops, or emits a receipt. Production uses the fixed finite approaches `(61,17)`, `(64,17)`, `(62,19)`—not a discovery search—then revalidates the fresh opaque target on every hit. Each of the eight typed hit requests retained its own matching request/execution receipt: the first seven were `partially_succeeded/debris_hit` (`8→1`), and the eighth request's terminal receipt was `succeeded/debris_cleared` (`1→0`, `clump_removed=true`); a fresh snapshot confirmed the exact target absent. Fixture transaction restore, working-save cleanup, backup/lock removal, and Stardew/SMAPI process absence were verified. This is shared `native_local_player_fixture` mechanics evidence only; it is not Farmhand, Portfolio, publication, release, or save/reopen evidence.

**Historical implementation references (do not reopen without a regression):**

- `integrations/stardew/ExecutionManager.cs` — `RequestLocalClearDebris`, `DiscoverDebrisTargets`, supported parent/tool/upgrade mapping;
- `tools/run-stardew-native-local-player-clear-debris-probe.mjs`;
- `tools/run-stardew-native-local-player-clear-debris-smoke.mjs`;
- `tools/lib/stardew-native-local-player-fixture.mjs`;
- `integrations/stardew/ModEntry.cs` fixture initialization;
- `tools/stardew-native-local-player-fixture.test.mjs`.

**Frozen contract retained for regression review:**

```text
scenario id
one exact ResourceClump parent ID
one matching tool class and required upgrade
initial clump health / expected finite production hit count
legal player approach and target discovery predicate
production-only prohibition: no tool hit, no health decrement/removal, no drops/collection/receipt
terminal receipt predicate and fresh exact-target absence
```

Use a target-version native setup API in the disposable working save, before bridge attachment. Prefer the smallest frozen clump variant; do not make a generic “spawn anything” mechanism. If target-version APIs cannot lawfully place the selected clump, stop with the exact source/API blocker rather than save editing.

**Closure implementation files:**

```text
integrations/stardew/ModEntry.cs
tools/lib/stardew-native-local-player-fixture.mjs
tools/run-stardew-native-local-player-move-fixture.ps1
tools/run-stardew-native-local-player-clear-debris-smoke.mjs  (new or replacement)
tools/stardew-native-local-player-fixture.test.mjs
fixtures/stardew/RUNBOOK.md                                 (after live closure only)
```

`ExecutionManager.cs` changes only if the frozen receipt/postcondition exposes a real contract gap; do not broaden it casually.

**Recorded verification:** fixture regression (9 pass), runner syntax, Host protocol/schema regression (14 pass), Stardew Release build (0 warnings/errors), scoped diff check, independent review, then the serial target-game gate described above. Re-run only when a regression affects this slice.

### B — `pet_animal` closure record (completed; no current assignment)

`native_pet_animal_v1` is **passed** shared native-local mechanics. Before bridge attachment, the fixture establishes one unpetted native Dog at FarmHouse `(9,10)` with friendship `0`, without `Pet.checkAction`, daily-state mutation, receipt, or outcome production. Production alone returned same-execution `succeeded/pet_completed`; its evidence bound friendship `0→12`, day record, and callback facts, and the fresh snapshot omitted the exact eligible target. The detailed fixture and teardown record is in `fixtures/stardew/RUNBOOK.md`. Do not reopen unless a regression invalidates that evidence boundary.

### C — `npc_relationship` closure record (completed; no current assignment)

`native_npc_relationship_v1` is **passed** shared native-local mechanics. The pre-attachment fixture establishes bounded Robin at Farm `(64,17)` with persisted friendship `250` and does not invoke the production read path or mutate relationship facts. Production traveled/moved to a legal adjacent position, returned same-execution `succeeded/npc_relationship_inspected` with identity and relationship evidence, then a fresh reread matched the same unchanged facts. The detailed fixture and teardown record is in `fixtures/stardew/RUNBOOK.md`. Do not reopen unless a regression invalidates that evidence boundary.

### D — Machine-family closure record (completed/excluded; no current assignment)

`machine_load` and `machine_collect_output` are **passed** shared native-local mechanics for the finite Keg `(BC)12` / `Default_CoffeeBeans` variant: target-bound five `(O)433` inputs produce `(O)395` in `120` minutes, and both production steps use normal `GameLocation.checkAction`, never direct downstream helpers. The serial run proves production load, actual native clock progression to ready output, normal collection, matching receipts, fresh postconditions, and teardown. `machine_configure` is excluded—not unfinished—because the pinned `Machines.xnb` decode has 39 entries and zero nonempty `InteractMethod` values, so there is no normal configuration ingress. The detailed content binding and evidence record remains in the closure board/RUNBOOK. Do not reopen unless a regression or target-version content drift invalidates it.

## 6. Integration owner and serial live-gate owner

One designated integration owner (the primary maintainer) owns all shared-file merges and all target-game runs:

1. review a worker’s contract/proposal;
2. assign exact non-overlapping files for implementation;
3. run the verification ladder from the batching SOP;
4. obtain an independent read-only review;
5. perform **one** target-game mutation gate;
6. verify teardown; then update `fixtures/stardew/RUNBOOK.md`, relevant README/design status, and closure record.

Workers do not launch the game unless explicitly appointed as this serial owner. A passed static test, fixture setup, bridge attach, or accepted receipt is never itself an action closure.

## 7. Required verification and report format

### Static implementation checklist

Run only checks relevant to changed files, plus all of these before asking for a live gate:

```powershell
node --test tools/stardew-native-local-player-fixture.test.mjs
node --check tools/run-stardew-native-local-player-<action>-smoke.mjs
powershell -NoProfile -Command "[void][scriptblock]::Create((Get-Content -Raw 'tools/run-stardew-native-local-player-move-fixture.ps1')); 'runner_parser_ok'"
dotnet build integrations/stardew/GameBuddy.Stardew.csproj -c Release --no-restore
# If Host/schema changed:
pnpm --filter @gamebuddy/companion-host build:test
node --test host/dist-test/protocol.test.js
git diff --check -- <only-assignment-paths>
```

A live-gate report must include:

```text
scenario and capability profile
exact fixture starting facts and explicit non-outcome assertion
fresh target identity before execution
accepted and exact matching terminal receipt: requestId + executionId
nonempty action-specific receipt evidence
fresh action-specific postcondition
commands/checks passed or failed
teardown: no Stardew/SMAPI processes, no profile backup, no lock, no working save
claim boundary: shared native-local mechanics only
```

### Handoff response template

```markdown
## Assignment
<action/family and scope>

## Files read / changed
- ...

## Frozen contract or implementation
- starting facts:
- forbidden fixture outcomes:
- native production ingress:
- terminal receipt:
- fresh postcondition:

## Verification
- command: result

## Board decision
`ready_for_live` | `fixture_needed` | `implementation_needed` | `dependency_blocked`

## Blockers / residual risk
- exact reason code or source fact; no guesswork

## Evidence claim
Shared `native_local_player_fixture` mechanics only; no Farmhand, Portfolio, release, publish, or save/reopen claim.
```

## 7. Known completed shared mechanics (do not reopen)

The native-local lane has recorded receipt-plus-fresh-postcondition mechanics for:

```text
move_to_tile, equip_tool, travel, enter_exit,
till_soil, water_crop, plant_seed, fertilize_tile, harvest_crop,
pickup_forage, pickup_item, machine_inspect, use_item,
tree_first_hit, chop_tree_source, refill_watering_can, feed_animal,
break_rock_source, collect_animal_product
```

The current `collect_animal_product` evidence used the native Farmer tool lifecycle for a ready Sheep product `(O)440`: same-execution terminal receipt recorded `produce_cleared=true`, `inventory_before=0`, `inventory_after=1`, `inventory_gained=true`, `animation_complete=true`; fresh snapshot then showed the same opaque target absent and aggregate `(O)440` inventory `0 -> 1`. Fixture setup only made adult/ready animal, compatible tool, and player approach available before attachment.

The current `chop_tree_source` evidence used one native Axe terminal-fell strike against fresh ordinary mature tree `tree_chop_source_db2e14e373c76083` at Farm `(64,17)`: same-execution `succeeded/tree_source_chopped` receipt recorded `health_before=1`, `health_after=5`, `stump_before=false`, `stump_after=true`, and `source_transformed=true`; a fresh snapshot changed source targets `1 -> 0` and result targets `0 -> 1`, with the same-location/type stump result. Fixture setup only made a health-one, non-stump, non-moss, untapped tree and one Axe available before attachment. Tree-fall drops remain outside this action.

These are reusable mechanics patterns, not transferable topology or release evidence.

## 8. Stop conditions

Stop and report rather than improvising if any of the following occurs:

- another worker owns a shared file needed by the task;
- a Stardew/SMAPI process, transaction lock, backup, or working save already exists;
- required fixture precondition has no reviewed target-version native origin;
- a proposed setup would cause the player-visible outcome claimed by the production action;
- opaque target cannot be freshly and uniquely bound;
- native completion cannot supply receipt evidence plus a fresh postcondition;
- a request would require UI/input automation, save edits, raw dispatcher/native-call fallback, or a different topology.

Record the exact reason, move the action to the appropriate board column, and hand control to the integration owner.
