---
name: stardew-live-loop
description: How to iterate on the Stardew game path — turn a live failure into a 40-second slice, land the fix together with the gate that catches the whole class, and only then spend a long run. Use before starting any live run, when a run prints a failure code, when a fix needs a guard, or when a gate went green while the product is broken.
---

# The Stardew live loop

One loop, in order. Skipping a step has always cost more than the step.

```
named failure → slice (≤60 s) → fix with a red proof → gate for the class → ladder → long run (measures her, not the action)
```

## 1. A failure code in a long run is a slice you did not write

The first occurrence of a named code is information. The second is a defect in *your process*.

Measured 2026-11-10 (one 21-minute run, stopped): `door_not_available` ×6, `row_target_identity_unavailable` ×6,
`plan_script_action_after_body_yield` ×4, `insufficient_money` ×2 — every one reproducible outside the run, three of
them without a game at all. The run produced no new verdict after minute 10.

Stop the run (exact PID, then teardown), write the reproducer, fix it there, and only then run long again. Before you
do, write down **which question the run exists to answer**; a run that answers none is a random sample.

## 2. The slice is 40 seconds, not 40 minutes

```bash
node tools/live-action.mjs  --action <actionId>      # one action, real world, restore, one JSON block
node tools/live-program.mjs --scenario <scenario> --script <file>   # one plan FORM (for_each etc.)
node tools/live-action.mjs  --action <id> --dry-run  # resolve the plan, spawn nothing
node tools/live-action.mjs  --recover [--dry-run]    # take back a dead run's fixture transaction
```

Both print `state`, the executor's `reasonCode`, the chosen target, the hand before/after, a **fresh re-read** of the
world after the receipt, and `problems: []`. A refusal that measured something is a successful slice: exit 0 with the
population it saw. `--action for_each` is refused by name — forms go through `live-program.mjs`.

Measured today: `enter_exit` 26 s passed, `shop_purchase` 11 s passed, `for_each` over `water_crop` 15.7 s passed,
`fish_here` 14 s blocked on a deadline that two parties disagreed about — found in one slice, fixed once.

## 3. Fix the owning layer, then prove it red first

- The fix goes where the fact is produced, not at the call site (one mapper, not twenty-four).
- Every assertion is seen red on a real injected violation *before* it is green. Paste both readings into the report.
- If a premise of yours turns out wrong, say so and keep the evidence: three lanes today disproved my hypothesis and
  that was worth more than the fix.

## 4. The gate is the deliverable; the fix is the side effect

This is the part that people skip, and it is the only part that keeps paying.

**A fix without a gate buys one instance and leaves the class alive.**

A gate is not a test with a wider name:

- **Population from the authority.** The set of things checked comes from a declaration the product already owns —
  a union type, a registry, a generated artifact, a directory scan. A hand-written list can only catch what its author
  remembered, and it fails open the first time someone adds a member.
- **Assert a property, not a member.** `every optional key is published by its record or carries a stated reason` is a
  gate. `isWarp is the only optional key` is a test.
- **Name the drifting member.** The failure message says which action, field or file broke, and what would have to change.
- **Prove it red on real history.** Prefer checking out the commit before a defect that actually shipped and watching
  the gate fire, over injecting the defect you had in mind.
- **Print the population, and refuse to pass on zero.** `"0 violations"` means nothing without `"examined N"`.
  Zero population is `blocked` with the reason, never green.
- **Report the rules it can red on.** `prelive` l0 runs `checkGateFalsifiers`: a `tools/check-*.mjs` must print a
  self-verification report (one entry per rule) in its own default run, or be declared in `GATES_WITHOUT_FALSIFIER`
  with a reason. A gate nobody can audit is a gate nobody should trust.
- **An exemption must expire**, and a gate nobody calls is not a gate: it is reachable from `node tools/prelive.mjs`.

Gates that exist because of one defect today: `check-plan-legal-fixpoint` (a permitted pair must actually run both
steps), `check-stardew-invented-gates` (a radius that gates admission must be the engine's number or say why),
`check-action-deadline-agreement` (what a sender writes must fit what the receiver admits),
`check-planner-guidance-observation-tools` (an observation tool the planner's text never names is one nobody calls),
plus the drift gates for the modal-clearing projection and the loop family ids.

## 5. The ladder, before any long run

```bash
dotnet build integrations/stardew/GameBuddy.Stardew.csproj -c Release     # 0 warnings 0 errors
pnpm --dir host build:test                                              # dist-test must be newer than src
node tools/prelive.mjs --no-game                                        # l0 gates, then the static ladder
```

A build is not 0/0 only because `GameBuddy.Setup` needs a signing certificate — for a solution-wide build that is
expected; build the Mod project.

The freshness gate refusing you (`live_run_artifact_stale`, `live_run_mod_stale`) is the gate working: build, then run.

## 6. The long run measures her decisions, not the machinery

A multi-day run is the only instrument for: what she chose across a day (breadth), whether a night crossed, whether the
settlement that tells her what happened actually arrived, how long a silence lasted, what she forgot and could not
recall. It is the wrong instrument for "does this action work".

Freeze the criteria **before** the run, write what each number must be, and list explicitly what may not be read as a
pass afterwards (second-launch willingness, human blind rating, a second session ≥24 h apart).

## 7. Never
- Never print a number without its population, its source, its method and its window. `26 of 26 toolCall parts (session.jsonl, structured parse, 09:01–09:21)` is a reading; `26 calls` is a rumour. The constructor is `tools/lib/reading.mjs` and the gate is `tools/audit-run-reading-shape.mjs`.
- Never resolve two disagreeing methods by preference: a `disagree` reading blocks the verdict.
- Never explain behaviour before proving the mechanism was available — count the refusals beside the calls (AGENTS.md, attribution discipline).
- Never report a point-in-time reading as a whole-run verdict, and never a parallel-run test count as the suite's state: say which mode produced it.

- Never kill a run you did not start by exact PID; never `killall`/`Get-Process -Name node`.
- Never rebuild or redeploy into the game's Mod folder during a run.
- Never let a long run's absence of evidence read as a pass: `not_measured` is a third answer.
- Never accept a receipt's claim where a fresh re-read is available.

Deeper operational detail lives in the private handbook: `design/handbook/live-run-patterns.md` (§ rung rule, § "a
named failure code is a slice that was not written") and `tools/live-run/ITERATION-LOOP.md`.
