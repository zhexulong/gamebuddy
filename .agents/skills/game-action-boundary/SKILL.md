---
name: game-action-boundary
description: "Freeze one game action's public boundary before implementation. Use when selecting, reusing, extending, composing, splitting, or blocking a typed game action."
---

# Game Action Boundary

Use this skill before production implementation. The game's governing design and
its game-owned action/policy authority decide semantics; this skill records one
bounded decision and does not create a cross-game action model.

## 1. Read the owning facts

Read the game's action catalog/policy, governing design, relevant native seam,
current tests, and any frozen brief. Record concrete sources rather than
inferring behavior from sibling actions.

## 2. Decide one boundary

Choose exactly one outcome:

- **Reuse** — an existing action has the same player-visible result, input
  boundary, authority, and completion claim.
- **Extend** — the governing design explicitly permits a finite addition to that
  action without widening its public boundary.
- **Compose** — existing actions already deliver the intended route while
  retaining their own receipts and completion claims.
- **Split/new** — the native operation, authority, result, or completion
  condition differs.
- **Blocked** — a required source fact, owner, valid Given, or evidence
  condition is absent.

Do not create a new public action merely because another game has a similarly
named operation. Freeze the result and claim scope before implementation.

## 3. Freeze a scenario card

Write a compact card for the selected action:

```text
Result:
Frozen public boundary:
Claim scope and completion condition:
Given:
When:
Then:
Native seam and game-thread prerequisite/admission facts:
Pre-commit visible effects (or none):
Receipt, fresh postcondition, and uncertain outcome:
Game-owned authority and shared owners:
Required deterministic checks / preflight / live gate:
Explicit non-goals:
```

Before running deterministic checks, preflight, or publication commands, read the
owning game project's `ACTION_RUNBOOK.md`; it is the canonical command authority.

A staged fixture may establish only the declared Given. It never proves the
action result. Every card field must cite its game-owned source or name a
concrete blocker; do not replace a missing source fact with a sibling-action
assumption.

## Completion

Hand off only when the boundary, claim scope, native prerequisite, ownership,
checks, and completion policy are all source-backed or explicitly blocked. Send
implementation work to `game-action-implement`; do not implement production
code from an unfrozen boundary.
