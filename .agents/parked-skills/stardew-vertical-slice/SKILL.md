---
name: stardew-vertical-slice
description: Deliver or revise a Stardew Portfolio capability through one thin typed bridge slice and a real local-game check. Use for a Portfolio action/capability implementation, merge/split decision, or live validation.
---

# Stardew Portfolio Vertical Slice

Use this SOP for `core_valley_milestone_portfolio_v1` only. Its authoritative
scope and release terms are in
[`design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md`](../../../design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md).
The local topology/environment and phase-specific commands are in
[`design/19_STARDEW_PORTFOLIO_IMPLEMENTATION_HANDOFF.md`](../../../design/19_STARDEW_PORTFOLIO_IMPLEMENTATION_HANDOFF.md).
For cross-cutting or multi-agent execution, apply
`subagent-driven-development` as the parent orchestration policy; this SOP
owns Portfolio topology and live-evidence semantics.

**Tracer bullet:** after the source-first basis is closed, deliver one
player-visible result end to end. Express the result as one executable BDD
scenario: **Given** a lawful nonterminal starting state, **When** one typed
request crosses its bounded native edge, **Then** the same execution has a
terminal receipt and fresh player-visible observation, **And** any required
save/reopen proof holds. These are acceptance clauses of **one scenario batch**,
not separately shippable mini-slices or review gates. Do not reopen
action-basis inventories, command-path schemas, source dossiers, or candidate
registries while executing the selected slice.

## 1. Pick the thin seam

1. Select one unclosed Portfolio result or a concrete failure of an existing
   capability. Read the matching requirement in `design/16`, the current
   bridge surface, its tests, and the source-closure/basis attestation that
   covers this native gameplay family.
2. If no approved source-first closure exists, or it classifies any required
   dynamic edge as `unknown_blocking`, stop. The prerequisite is to restore the
   closed Native Gameplay Operation Graph and transition/protocol universe;
   this implementation SOP must not classify actions, design a public contract,
   or choose capability reuse before that prerequisite passes.
3. For a source-closed family only, decide in this order: **reuse**, **bounded
   parameter extension**, **composition**, or **new typed capability**. A new
   capability needs a concrete source-closed reason that the existing interface
   cannot express its target/input, guard, native result, pending lifecycle, or
   evidence.
4. State that reason in the feature test name, implementation comment, or PR
   summary. Do not add a decision schema. If target-version native behavior is
   genuinely unclear, return it as a source-closure blocker rather than coding.

## 2. Freeze one acceptance scenario, then build it

Before changing production code, write one compact behavior test/scenario at
the public typed seam:

```gherkin
Scenario: <player-visible Portfolio result>
  Given <lawful nonterminal fixture facts and fresh observed target>
  When <one bounded typed request is accepted and reaches its native edge>
  Then <same execution has terminal receipt + fresh action-specific observation>
  And <required persistence/reopen proof, if the selected result claims it>
```

Before adding **And**, verify the primitive's declared native effect. Do not
attach aggregate milestone persistence to a primitive that only consumes
already-persisted eligibility and changes transient location/state. The action
that actually produces the persisted field owns the save/reopen clause; a
monitor/aggregate cannot transfer that obligation to a route-selection
primitive.

The scenario is a **BDD pipeline**, not only a readable specification. Every
asserted fact must name its **producer**, the next **consumer/correlation**, and
its **verifier**; the verifier must consume the fact or its exact correlated
successor rather than merely observe a similar world state.

| Clause | Producer → consumer/correlation → verifier required before implementation |
|---|---|
| **Given** | lawful fixture/probe produces nonterminal facts and fresh opaque target → typed request binds target/scope → fixture regression plus fresh observation verifies the same facts and forbidden outcomes |
| **When** | typed ingress produces accepted execution → game-thread guards consume its identity/scope/revision → exact target-version native semantic edge verifies the accepted execution reached the lawful commit boundary |
| **Then** | native edge produces attributable completion fact → same-execution receipt/runner correlates it with `requestId` + `executionId` → fresh player-visible reader verifies the declared result and teardown verifies isolation |
| **And** | native save produces persisted state → reopen binds the same save/world/player and required generation → fresh persisted-field reader verifies the claimed post-reopen fact |

A missing producer, consumer/correlation, or verifier is `scenario_blocked`.
It identifies the next implementation seam, but does **not** turn each clause
into a separate deliverable. Keep one writer on the whole scenario batch until
all known Given/When/Then/And seams are connected or a concrete new blocker
makes the batch inadmissible.

Implement only enough for this complete scenario path:

```text
fresh structured observation → typed request → game-thread revalidation
→ native operation → terminal receipt → fresh action-specific observation
→ native save/reopen reread when the scenario claims persistence
```

Keep the interface narrow: opaque correlation from fresh observation, bounded
parameters, one lifecycle owner, and a receipt tied to the same execution.
The Portfolio topology is always `single_player_native_companion`; do not
reuse preview or Farmhand identity, capability state, requests, receipts, or
live evidence. UI/input, raw coordinates, generic dispatch, debug/console,
and save edits are not implementation options.

Add an automated rejection case only when it protects a named scenario
assertion. Add pending, cancellation, replay, or save/reopen coverage when the
scenario has that lifecycle or claims that behavior.

## 3. Build one scenario batch, then verify it once

During one scenario batch, a writer may make the necessary connected changes
for **Given**, **When**, **Then**, and required **And**. Run the cheapest
targeted test immediately after a changed seam so failures remain attributable,
but do not stop for a separate review or status report after each clause. At
the end of the batch run the affected contract/protocol/isolation tests, build
checks, and `git diff --check`, then perform **one** independent review of the
whole BDD pipeline before any formal live mutation.

Split or pause the batch only when new source/runtime evidence, a failed gate,
or an authority/topology decision proves that the frozen scenario cannot close
as designed. Record the precise producer→consumer→verifier gap and either
repair it within the same batch or return it as the batch blocker. Do not spend
review cycles on wording-only or already-proven intermediate states.

Use the actual scripts from `package.json`; do not make a broad source-audit
checker a prerequisite for a feature. Treat unrelated baseline failures as
baseline failures: identify them clearly, but never turn a partial check into a
pass.

### Four-action cohort

When a Portfolio backlog must advance in parallel, freeze a cohort of at most
**four independently named actions**. Each retains its own complete BDD
pipeline, preflight record, receipt predicate, fresh postcondition, test
result, review verdict, and live-gate verdict; no action passes by association
with another cohort member.

Parallel work is limited to action-owned source, adapters, fixtures, runners,
and tests in isolated worktrees or explicitly non-overlapping paths. One named
integrator serializes edits to shared Portfolio bridge/session/protocol/config
files after the four action lanes have supplied their seam contracts. Target
Stardew mutation gates remain strictly serial because they share one process,
profile transaction, and native local Player. The cohort is useful only when
it reduces independent implementation time without relaxing per-action proof.

## 4. Freeze the local live preflight, then run one formal check

The licensed target game is at:

```powershell
$env:GAMEBUDDY_STARDEW_GAME_PATH = 'D:\Steam\steamapps\common\Stardew Valley'
```

Every Portfolio mutation—whether one agent or many—requires a recorded,
non-mutating, **action-specific** preflight before it can spend the formal live
gate. Run `pnpm check:stardew-portfolio-prerequisites` plus the action's own
preflight command. Run `pnpm check:stardew-portfolio-p0b` only when the frozen
action scenario consumes P0b lifecycle evidence; a blocked unrelated P0b
scenario must not stall an otherwise independent action batch.

After the integrated scenario batch and its single independent review, the
frozen scenario must have a current non-mutating preflight record that shows
every clause is executable:

1. **Given:** current Portfolio profile/fixture start facts and forbidden
   outcome facts;
2. **When:** target-version build, isolated save/start-manifest, valid Host/SDK
   bridge attachment, published capability snapshot, and action-specific typed
   request route;
3. **Then:** action-specific runner/parser replay against a recorded
   real-shaped protocol/receipt payload, current schema and contract checks,
   exact `executionId` + `requestId` accepted/terminal predicate, required
   nonempty evidence, and fresh action-specific reread;
4. **And:** any required save/reopen reader and persisted-fact reread;
5. profile transaction, restoration, process cleanup, and teardown checks.

Use the Portfolio profile/data/save paths only; do not substitute the
Farmhand fixture/profile. A missing or failed item is a **BLOCKED** live
check, not a reason to simulate success. Repair the relevant delivery phase,
repeat the non-mutating preflight from a fresh local game state, and obtain an
independent read-only review before the mutation. An unsuccessful preflight
never spends, repeats, or relabels the formal gate.

For an available action-specific runner, success requires one real target-game
execution with the same execution's terminal `succeeded` receipt, nonempty
action-specific evidence, a fresh native observation proving the player result,
and verified teardown. A receipt alone is not success. Consume the frozen,
topology-isolated Portfolio manifest and evidence schema required by the
attestation chain; do not invent a parallel/ad hoc schema, run manifest, or
local-path index.

## 5. Let evidence shape the interface

After tests and a live result:

- **Keep/merge** when the same typed interface honestly covers the observed
  cases; represent content differences as bounded parameters.
- **Split** only for an observed or contract-level counterexample that changes
  the typed request, guard, native lifecycle, terminal meaning, or required
  observation.
- **Block** when the native route or live environment is not ready; state the
  specific blocker and make no support claim.

A full Portfolio run later checks composition. It never replaces the live
result of a capability that is claimed as supported.

## Completion

A slice is complete when its one BDD pipeline has recorded results and its
real-game state is explicitly **pass** or **blocked/fail**. Report its status
with the scenario clause and producer→consumer→verifier link that is currently
proven or blocked; never use protocol/coordinator presence as a completion
metric. Update
[`design/20_STARDEW_PORTFOLIO_CAPABILITY_SET.md`](../../../design/20_STARDEW_PORTFOLIO_CAPABILITY_SET.md)
with only the selected capability's name, player-visible result, and status.
Call it supported only after the target-game pass; otherwise call it
experimental or blocked.
