---
name: stardew-action-closure-batching
description: "Plan and close a bounded batch of typed game actions. Use for action selection, reuse/extend/compose/split decisions, implementation reuse, frozen briefs, required checks, runtime gates, or closure-backlog triage."
---

# Game Action Closure Batching

Use this upstream SOP to select, shape, implement, and formally close a bounded
batch of typed game actions. It owns the **action boundary**: reuse, bounded
extension, composition, split, new action, or blocker. The governing design
supplies the project's context, authority, evidence, and completion policy; this
skill does not assume that different games or contexts share implementation,
setup, evidence, or runtime facts.

Implementation work consumes a Frozen Implementation Brief and may implement or
block its frozen path; it may not change action boundaries. Keep file ownership,
review scope, and escalation paths explicit whenever work crosses modules or
writers.

## Reuse before addition

Read the project's current design, source, and frozen brief before issuing an
implementation brief. When they identify an approved implementation that covers
the requested behavior, make the action use it through its named owner. When
reuse, extension, or a new implementation is unclear, record the concrete source
fact and return the decision to the owning task. Do not infer a new boundary or
second implementation from sibling-action similarity.

## Closure truth

A formally closed action must satisfy the completion conditions defined by the
governing design and frozen brief, with the evidence and independent checks they
require. Static source evidence, code, or setup do not replace a required
runtime or product-level check.

## 1. Start from the closure board

Read the selected action's governing design row, current source, tests, records,
and relevant working-tree changes. Use the states and materials named by that
design; do not impose a universal board, artifact, setup, or runtime arrangement.
For each candidate, record one current state, its exact meaning, and its next
prerequisite.

Do not make a complete action universe or release roadmap the immediate queue. A
batch is complete only when every selected action is formally passed, ready for
its next required check, or recorded once with its concrete blocker.

## 2. Decide the action boundary before implementation

Establish the relevant operation and player-visible result from the project's
source and design, then decide in this order:

1. **Reuse** an existing action only when its declared result, input boundary,
   operation, conditions, ownership, and completion meaning match.
2. **Bounded extension** only when the governing design says the existing
   implementation may accept the additional finite behavior without widening
   its boundary.
3. **Composition** when independent already-defined actions form a route or
   outcome. Preserve their separately defined results and completion claims; do
   not hide them in an unapproved public action.
4. **Split / new action** only when source or scenario facts show a different
   result, operation, authority, ownership, or completion condition.
5. **Block** when a source fact, valid starting state, required evidence,
   authority decision, or completion condition is not yet proven.

Only this SOP can change an action boundary. A worker discovering that its brief
needs one of these decisions returns the exact fact to this step; it does not
create an unapproved public action, alternate authority, or fallback merely to
make the brief implementable.

## 3. Freeze the action scenario and required facts

For each action selected for implementation or closure, write one compact
scenario using the form required by the governing design:

```text
Scenario: <player-visible action result>
  Given <starting facts and required conditions>
  When <the bounded action request is applied>
  Then <the declared result and completion conditions are satisfied>
  And <any additional claim explicitly owned by this action>
```

For every asserted fact, name the source and check required by the project. A
setup mechanism may establish starting facts, but it may not silently cause the
result claimed by the action. A follow-on claim belongs to the action or
composition that the governing design assigns it to.

An unknown required source, check, or owner is a board blocker. It is not
permission to create a broad implementation or divide one action into
unapproved public actions.

## 4. Issue a Frozen Implementation Brief

Once the boundary and scenario are frozen, give a single action writer an
inlined brief. It is a concise handoff, not a new file, registry, or schema. The
governing design, existing source, tests, and records remain authoritative.

```text
Result
- Observable action result delivered or repaired by this implementation.

Frozen boundary
- Public contract and behavior that must not change.

Scenario
- The scenario form required by the governing design.

Required facts and integration point
- The sources, checks, and integration point named by the governing design, or
  the exact source blocker.

Reuse and ownership
- The existing implementation and owner this action will use; or the concrete
  source fact requiring an owner decision about extension or new implementation.

Owned scope
- Editable paths, shared-file owner, tests, and explicit non-goals.

Scope boundary
- Existing behavior left with its current owner and behavior this brief may add.

Cost evidence
- Current baseline and expected files, handwritten work, and time delta.

Checks and handoff
- Focused commands, outcomes, proven or blocked assertion, and residual risk.
```

A brief must name the requested behavior, integration point, completion
condition, ownership/context boundary, required facts, reuse decision, scope
boundary, and cost evidence required by the governing design. Otherwise keep the
row unresolved and record the exact missing fact.

When the selected work changes an approved common implementation rather than
consuming it, follow that project's entry gates, evidence requirements, and
shared-file ownership rules. Without those facts, keep the work blocked before
production edits.

## 5. Execute one integrated scenario batch

Given, When, Then, and required And are acceptance assertions of **one
scenario**. A single writer owns the bounded path named by the brief and runs
focused checks as it changes that path. Do not spend a separate review wave on
each scenario clause.

Parallelize only action-owned, disjoint work with frozen independent contracts.
One owner serializes shared files. Static validation, source research for a
named unknown, and independent reviews may run in parallel when their questions
and write surfaces do not overlap. If delegated work cannot establish its
assigned fact, record that as a process failure and return the affected row to
its concrete board state.

Use each approved implementation through the owner named by the project's
current design. Sibling-action similarity does not by itself justify a new
implementation or a change to an existing boundary. When the required
implementation is absent or its ownership is unclear, record the source fact and
return to the owning task or design decision instead of hiding the gap in
action-local work.

At batch end run the action-owned checks, affected build or equivalent
validation, scoped `git diff --check`, and one independent review of the
complete scenario path. A review finding returns the row to the appropriate
board state; it never authorizes an irreversible runtime check.

## 6. Freeze and run required runtime checks

Before any destructive or otherwise irreversible runtime check, create the
current non-mutating preflight required by the governing design. It must cover
the declared starting facts, exact invocation boundary, expected result and
checks, required evidence, and cleanup or restoration obligations.

A failed or missing item yields a precise blocked preflight; it does not spend or
relabel the runtime check. After the complete static path and final review pass,
run the required runtime check according to the project's own serial or parallel
policy.

Record a pass only when every completion condition in the governing design and
brief has evidence. A truthful operation or precondition failure returns the row
to its concrete board state; do not manufacture another target or reinterpret
setup as product success.

## 7. Record the correct outcome

For every selected action record its current scenario, proven or blocked
assertion, the required facts and their checks, check/review verdict,
preflight/runtime verdict, evidence location, cleanup result, non-guarantees, and
next ready prerequisite.

A batch or aggregate scenario validates composition only. It never grants formal
closure to an individual action by association.

## Completion

A batch iteration is complete when every selected row is one of:

- formally passed in the required runtime or product-level check with the
  cleanup or restoration required by its governing design;
- statically integrated, reviewed, and ready for its next required check; or
- moved out of the active batch with one exact blocker and prerequisite.

Report actual state, not code volume: which assertion is proven or blocked and
which evidence link is missing. Never describe a static implementation, setup,
source audit, successful launch, or unverified result as action closure.
