---
name: game-action-implement
description: "Implement one frozen game action through its named game-owned authority. Use after a boundary card names the native seam, ownership, checks, and completion policy."
---

# Game Action Implement

Consume a frozen action card. The game adapter owns gameplay semantics,
game-thread admission, native commit, receipt, postcondition, and
uncertain-side-effect behavior. Shared devkit tooling owns only
process/evidence mechanics.

## 1. Reconcile before editing

Read the frozen card, current implementation, named owner, action tests, and
dirty paths. Stop if the native seam, authority, required check, or owned path
has drifted.

## 2. Deliver one connected scenario

One writer owns the connected producer → consumer → correlation → verifier path:

```text
request → game-thread admission → native commit → terminal receipt → fresh postcondition
```

Reuse the named owner. Keep selectors and action facts typed. If a fact is
missing, return the named non-success outcome; do not create a fallback
dispatcher or a second authority.

A native seam may complete in more than one step — the purchase that leaves the
goods on the cursor, the menu that ignores a same-frame click. Perform every step
the human performs, in the order the human performs them: the first step's success
is not the action's result.

## 3. Check progressively

Run the cheapest relevant check after each changed seam, then the frozen focused
suite, affected build/typecheck, and scoped diff check. Use the owning project's
canonical deterministic contract/check command from its `ACTION_RUNBOOK.md`.
Static code or a fixture setup is not live evidence.

## 4. A repeated failure is a diagnosis problem

When the same check fails again after a fix, the signal itself is the suspect —
switch to the `diagnosing-bugs` skill and build its **red-capable** command: one
that drives the real behaviour and goes red on this symptom. That command is the
diagnosis. A signal that names something other than the cause (a connection drop
reported while the payload was refused) grants a repair attempt indefinitely.

## Handoff

Report changed owned paths, exact commands/outcomes, the scenario assertion made
checkable, producer→consumer→verifier evidence, residual risk, and the next
gate. A runtime mutation requires `game-action-close` preflight and its game's
authorization. This skill cannot publish, select a new boundary, or infer live
authorization from a brief or static result.
