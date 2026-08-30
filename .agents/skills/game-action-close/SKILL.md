---
name: game-action-close
description: "Close or block one implemented game action with deterministic evidence, preflight, review, and the game project's runtime gate. Use after implementation is locally verified."
---

# Game Action Close

Use this skill after an action's frozen implementation path is locally verified.
The game's project defines evidence and runtime semantics; the devkit may package
evidence but cannot mint action authority. Use the owning project's canonical
deterministic and read-only preflight commands from `ACTION_RUNBOOK.md`; a live
command requires explicit game-project authorization.

## 1. Assemble the claim

Read the frozen boundary, implementation handoff, deterministic checks,
receipt/postcondition verifier, fixture/profile ownership, and current
publication state. State exactly what is proven and what remains blocked.

## 2. Run deterministic closure

Validate the complete scenario pipeline:

```text
request → admission → execution → receipt → fresh postcondition → teardown/evidence
```

Require exact request/execution correlation, one terminal outcome,
action-specific evidence, and cleanup truth. Incomplete evidence never becomes
passing evidence. A static check, setup, source audit, or successful launch does
not close an action.

## 3. Preflight and review

Before a scarce or irreversible game mutation, run the non-mutating preflight
required by the governing design for target identity/version, fixture/profile
setup and teardown, request/parser replay, postcondition reread, evidence
destination, and the frozen effect envelope. Obtain one independent review of
the complete path. A missing item blocks the runtime gate. Run a live gate only
when the game's project explicitly authorizes that exact action and invocation.

## 4. Record outcome

Record `passed`, `blocked`, `failed`, or `uncertain` separately from evidence
`complete`/`incomplete`. Only the game-owned publication process may turn valid
closure evidence into an advertised capability. Keep cleanup and restoration
truth in the claim; never relabel incomplete evidence as a pass.
