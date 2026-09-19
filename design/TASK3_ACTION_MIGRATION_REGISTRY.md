# Task 3: Action Migration Registry (tracking)

> Current-owner companion to `design/NN_WIRE_ADMISSION_AUTHORITY_IMPLEMENTATION_PLAN.md` Task 3.
> **Unified-interface decision:** Agent-facing action invocation is isomorphic — the Agent issues standard Tool Calls (single, or a Turn-multiple batch); Host maps them to one typed Action envelope (single or ordered sequence); Mod executes both on one game-thread action executor via the shared `FarmhandActionDescriptor`. There is **no second Agent-facing channel**: the legacy RPC form (execution_request / cancel_request / execution_receipt_query + FarmhandActionRouter) is retired, not a permanent lane. The **single-action ability is first-class** in the uniform envelope — it is not forced through a DAG; **declared dependency-bound continuation** (typed RuntimeFact + RFC 6901 binding, the inspect→load pair) is the only DAG lane, for true cross-action dependencies. No compatibility shim after retirement (AGENTS.md). Live/native mutation stays behind the single authorized live gate (open-gameplay-release Task 6).
>
> **How to update:** one row per registered actionId; flip `migrated` when its boundary card (game-action-boundary skill format, descriptor cited as single source) + executor + parity tests + (mutating) live-gate evidence are complete and reviewed. Keep the table the single visible progress source for Task 3; do not let it drift from code.

## Batch order (frozen)

1. **Read-only** actions (synchronous, no live mutation gate).
2. **Synchronous bounded-mutating** actions (single-node native mutation with exact-tuple admission + durable-before-mutation + postcondition projection; irreversible ones keep the formal live gate).
3. **Asynchronous** actions (move_to_tile and any multi-tick native) — after Task 3P continuation seam.
4. **Dependency-bound continuation** pair (machine_inspect → machine_load) — the frozen live-gate A→B.
5. **Experimental / lifecycle** actions — last or stay withdrawn; live-withdrawn actions (navigate_to_destination) are not migrated.

**Live run rule (no second live-run invented):** a mutating row is `migrated` only after its executor/parity work **and** a real live run executed through the single authorized production live gate (`open-gameplay-release` Task 6 — one serial gate, frozen target version/save/topology, real player request + real Main Pi Agent, harness never submits/edits/replaces, post-dispatch unknown = same-tuple recovery + gate failure). Task 3 adds no separate live-run channel, script, topology, or gate; it only widens which registered action the one Task 6 gate exercises per batch. Any live run outside the Task 6 gate is a blocker, never Task 3 evidence.

## Registry

| ActionId | Family | Group | Kind | Output facts | Mutating? | Live-gate? | Sub-task | Boundary card ref | Executor | Parity tests | Migrated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| machine_inspect | machines_processing | MachinesAndAnimals | Execution | machine_target_id | no (read) | no | T3.5 | card-a-frozen (scout d77b6da3) | RouteReenteringBodyProgramExecutor (done) | 6/6 executor tests | [x] |
| navigate_to_destination | world_navigation | Movement | Execution | arrived_at_destination | no (nav) | no | withdrawn | card-d-frozen: live-withdrawn per Task 5, no executor | n/a (withdrawn) | n/a | [x] |
| npc_relationship | npc_social | MachinesAndAnimals | Execution | (none) | no (read) | no | T3.5 (after lifecycle) | card-c-frozen: lifecycle=Experimental blocks catalog; advance-to-Published decision required before executor | (pending) | (pending) | [ ] |
| move_to_tile | movement_navigation | Movement | Execution | (none) | no (movement) | no | T3.4→T3.5 | card-b-frozen: multi-tick traversal; continuation seam (T3.4) done, executor route pending | (pending) | (pending) | [ ] |
| machine_load | machines_processing | MachinesAndAnimals | Execution | (none) | yes (irreversible) | yes (T3.6) | T3.6 | (pending) | (pending) | (pending) | [ ] |
| machine_collect_output | machines_processing | MachinesAndAnimals | Execution | (none) | yes (bounded) | yes | T3.5→T3.6 | (pending) | (pending) | (pending) | [ ] |
| enter_exit | movement_navigation | Movement | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| face_direction | movement_navigation | Movement | Execution | (none) | yes (bounded) | yes | 3 | (pending) | (pending) | (pending) | [ ] |
| travel | transport_warps | Movement | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| equip_tool | body_tools | ResourceTools | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| till_soil | farming_crops | Farming | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| water_crop | farming_crops | Farming | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| plant_seed | farming_crops | Farming | Execution | (none) | yes (irreversible) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| fertilize_tile | farming_crops | Farming | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| harvest_crop | farming_crops | Farming | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| clear_hoedirt | farming_crops | Farming | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| refill_watering_can | farming_crops | Farming | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| pickup_forage | resource_gathering | Gathering | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| pickup_item | inventory_items | Gathering | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| chop_tree_source | resource_gathering | ResourceTools | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| break_rock_source | resource_gathering | ResourceTools | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| dig_artifact_spot | resource_gathering | ResourceTools | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| use_item | inventory_items | MachinesAndAnimals | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| collect_animal_product | animals_pets | MachinesAndAnimals | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| feed_animal | animals_pets | MachinesAndAnimals | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| pet_animal | animals_pets | MachinesAndAnimals | Execution | (none) | yes (bounded) | yes | 3 | (pending) | (pending) | (pending) | [ ] |
| place_wood_fence | buildings_farm_management | ResourceTools | Execution | (none) | yes (irreversible) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| place_crab_pot | buildings_farm_management | ResourceTools | Execution | (none) | yes (irreversible) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| bait_crab_pot | buildings_farm_management | ResourceTools | Execution | (none) | yes (bounded) | yes | 2 | (pending) | (pending) | (pending) | [ ] |
| clear_debris | resource_gathering | ResourceTools | Execution | (none) | yes (bounded) | yes | 3 | (pending) | (pending) | (pending) | [ ] |
| express_emote | expression | Expression | Execution | (none) | yes (bounded) | yes | 3 | (pending) | (pending) | (pending) | [ ] |

## Retirement gate

**Portfolio envelope retired (T3.7, user-approved):** the entire stardew-portfolio envelope is removed — host `portfolio-*.ts` transport + tests, `tools/` m1-m10 source-audit / profile / p0b / p3 / run-* runners / lib helpers, the 40 `package.json` scripts, `host/tsconfig.portfolio.json`, `fixtures/stardew/PORTFOLIO_ENVIRONMENT_RUNBOOK.md` and portfolio fixtures. `action-development/portfolio.json` and the `Portfolio` config field (a different portfolio mechanism: action-check collection / capability-config) are retained. Any future action that needs a "portfolio" notion must mint a new, non-overlapping mechanism; the name is reserved against revival.

All 31 rows `migrated = [x]` **and** every mutating row has its live-gate evidence
**before** retiring the legacy pipeline. Retirement is one explicit contract
decision naming: the exact retired message names (execution_request,
cancel_request, execution_receipt_query), the schema version bump, and the grep
evidence that no legacy type/message name remains in production code (history-only is fine).

## T3 closure status (2026-09-16)

- **T3.1, T3.2, T3.3, T3.4, T3.5 committed** (`f3c0532` [T3.1+T3.4+T3.5], `03a6dcc` [T3.2], `18a9522` [T3.3]): Core 398/398, Integration 190/190, production build 0 warnings/0 errors. T3.5 accepted on parent audit (independent reviewer infra failed 3x; audit verified no second dispatch switch, binding gate, fact honesty, evidence passthrough).
- **T3.7 portfolio retired and removed** (`b5d1bb6`, 181 files).
- **T3.6 (A→B live gate) NOT started:** it is the separately-authorized target-version serial gate (open-gameplay-release Task 6). Code-side A→B readiness is audited below; the frozen live run itself requires explicit live authorization (frozen target version/save/topology, real Main Pi Agent authorship, harness never edits, same-tuple recovery).

### T3.6 code-side readiness (machine_inspect → machine_load)

- **A = machine_inspect**: read-only; typed output fact `machine_target_id` declared (`FarmhandActionDefinitions.cs` MachineInspect); executor routes through the single FarmhandActionRouter (T3.5); facts produced from action-validated canonical arg with exact {ProgramId,NodeId,NodeAttempt} provenance; evidence = native live-state passthrough.
- **B = machine_load**: real native mutation (keg coffee `(O)433`); registered in the catalog with Acceptance facts (T3.1); routed through the same single router via the executor; irreversible → keeps formal live-mutation gate.
- **A→B binding**: RFC 6901 `expectedTargetId` ← A's exact `machine_target_id` RuntimeFact; journal validates fact provenance + descriptor binding (ValidFactSet / TryComplete); continuation seam (T3.4) available for any multi-tick path.
- **Remaining for T3.6**: the Task 6 serial gate run itself (authorized separately), plus confirmation that B's live dispatch sits behind the approved live gate (no offline harness dispatch of irreversible mutation).

## Notes

- Rows are classified from current registrations (`FarmhandActionDefinitions.cs`) and
  handler coverage; per-action boundary cards will validate/correct this table
  before each implementation batch (scout `fc8e482e` audit is the machine pair source).
- `navigate_to_destination` (navigation) and `express_emote`/`face_direction` are
  lifecycle-sensitive: confirm current publish/withdraw status at its batch start.
- Recovery semantics: durability is audit + no-dup-side-effect + fenced non-terminal,
  never process-level auto-resume (product rule #2678).