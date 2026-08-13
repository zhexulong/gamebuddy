---
name: stardew-action-closure-batching
description: "Close a batch of existing Stardew typed actions efficiently: classify fixture readiness, prepare lawful preconditions, parallelize static work, and run target-game gates serially. Use when advancing several unclosed shared Stardew actions or when an action closure backlog is slow."
---

# Stardew Action Closure Batching

Use this SOP only for the **shared typed Stardew bridge** and the bounded
`native_local_player_fixture` mechanics lane. Portfolio work is currently
parked and outside this SOP's active scope. For cross-cutting or multi-agent
execution, apply `subagent-driven-development` as the parent orchestration
policy; this skill owns the action/fixture/live-evidence rules.

**Portfolio boundary:** do not select or advance a Portfolio capability from
this SOP while Portfolio remains parked. Record any discovered Portfolio
requirement as out of scope rather than creating Portfolio protocol,
coordinator, fixture, or static-core work.

**Fixture boundary:** a disposable working-save fixture may establish the
player-visible **starting state**. Production alone causes and proves the
requested result.

## 1. Start with the closure board

Read the current action registry, relevant design row, current fixture
profiles, production request/completion code, runner, tests, and working-tree
diff. For each candidate put one concise row in exactly one column:

| Column | Meaning | Next work |
|---|---|---|
| `ready_for_live` | Typed action and lawful starting-state recipe exist | static verify, review, then serial live gate |
| `fixture_needed` | Typed action exists; starting-state recipe is not frozen | source/contract proof for fixture only |
| `implementation_needed` | No typed production slice exists | group it with its native lifecycle family |
| `dependency_blocked` | Needs unresolved content, topology, day/save, or safety proof | record exact reason; do not churn |

Do not treat the full capability-set document as the immediate action queue.
Distinguish throughout:

```text
shared native-local mechanics closure
≠ formal Farmhand closure
≠ Portfolio / release closure
```

## 2. Classify the action before changing it

Use this order:

1. **Reuse:** an existing published typed action already has the same player
   result, native lifecycle, and postcondition.
2. **Existing unclosed action:** production request/receipt exists; determine
   its fixture recipe and runner only.
3. **Family implementation:** if protocol/Host/Mod/target discovery are absent,
   design the shared family seam before an individual action.
4. **Composite:** if the requested outcome spans independent native lifecycles,
   keep primitives separate and define receipt-linked composition later.
5. **Blocked:** name the missing target-version fact or prerequisite.

Never create a generic dispatcher, raw UI/input path, console/debug execution
surface, arbitrary native invocation, or save-edit production fallback.

## 3. Write the fixture acceptance scenario first

For every `ready_for_live` or `fixture_needed` action, freeze one compact BDD
scenario before writing setup code. Its **Given** facts are the fixture
contract; its **When** is the production ingress; its **Then** facts are the
same-execution result proof:

```text
Scenario: <action> from a lawful nonterminal starting state
  Given capability profile, allowed initial world/inventory facts,
        native pre-attachment validation, and forbidden outcome facts
  When the typed production request is accepted for the fresh target
  Then the matching execution has its terminal receipt and fresh postcondition
```

A scenario is not ready when its target, native result, receipt predicate, or
fresh postcondition remains unnamed. It is also not ready until every asserted
fact has a complete **BDD evidence pipeline**:

```text
producer → consumer/correlation → verifier
```

For example, fixture setup produces a fresh starting fact; the typed request
consumes its opaque target and scope; the native edge produces an attributable
completion fact; the runner correlates that fact to the same execution; and a
fresh reader verifies the player-visible result. Record a missing producer,
consumer/correlation, or verifier as a concrete board blocker; do not fill the
gap by creating a generic protocol surface.

### Starting state versus outcome

A fixture is valid when it establishes a target that a normal player could now
act upon, while leaving the action's claimed result untouched.

| Allowed starting-state setup | Production-only outcome |
|---|---|
| place an intact tree, rock, ResourceClump, empty trough, ready machine, or unpetted pet | damage/remove the target or collect its drops |
| provide an appropriate tool, Hay, seed, or inventory capacity | consume the action input or add its output |
| create/load an adult ready-product animal | clear product or add its product to inventory |
| establish nearby NPC/pet/entity and read facts | change friendship, daily interaction flags, or relationship facts |
| establish legal water source and partially filled can | refill the can |

The setup must be constrained to the disposable working save, finish before
bridge attachment, and validate its facts through target-version APIs or a
fresh snapshot. It must not create a receipt or declare action success.

If a reviewer questions fixture validity, answer with this test:

> Did fixture setup already cause **the player-visible result claimed by this
> action**, or call an equivalent ingress that did? If no, it is a candidate
> starting state; document the native provenance and keep production evidence
> independent.

## 4. Dispatch bounded fresh-context work

Every batch child starts with `context: "fresh"`; never use an inherited/forked parent
conversation for scout, reviewer, worker, or oracle work in this lane. The parent supplies a
compact task contract naming only the relevant action, source seams, authoritative docs, and
specific decision or owned files. A child discovers current code from the working tree rather
than receiving session history, broad diffs, old reports, or a copy of this SOP.

Keep a child to one deliverable and one bounded read surface. Reviewers and scouts return a
short evidence-backed report; they do not run broad `git status`/whole-worktree diffs in this
dirty repository. A single implementation owner may span the action's shared Mod/Host/fixture
files, but must work in checkpoints: inspect only assigned paths → make the narrow change → run
targeted checks → report. On a source/design pass, stop once ingress, fixture boundary, and
postcondition are decided; do not repeatedly reread the same files or re-audit the full action
universe.

If a child times out or reports `context_too_large`, preserve any artifact, classify the failure
as **dispatch/process evidence** (not action evidence), and retry only from a new fresh child
with a narrower seam and explicit read budget. Do not resume a bloated child session or add more
context to it.

Run these lanes in parallel only when their writes do not overlap and each
lane closes a named part of the same acceptance scenario:

1. **Given lane:** scenario/config/setup/fixture regression and refusal cases.
2. **When lane:** protocol, Host validation, and the bounded production ingress.
3. **Then lane:** strict receipt parser, exact accepted/terminal identity, fresh
   reread, and cleanup trace.
4. **Review lane:** read-only review of the landed scenario path.

Do not parallelize an undefined native ingress, result predicate, persistence
requirement, or producer→consumer→verifier link. Those are scenario-pipeline
gaps to resolve before a writer is dispatched, not independent static lanes.

One writer owns each shared file (`ModEntry.cs`, `ExecutionManager.cs`,
protocol/schema, fixture helper, fixture test). Merge or sequence shared-file
changes; do not have parallel writers race them.

For actions in the same family, reuse a common target DTO, opaque-ID rule,
strict argument/evidence helper, fixture transaction, and runner receipt wait.
Only the native ingress, guards, and action-specific postcondition should vary.

## 5. Fixed verification ladder

Before any game launch:

1. action-specific fixture regression;
2. runner/parser syntax checks;
3. affected Host/schema tests and build, when touched;
4. Stardew Release build;
5. scoped `git diff --check`;
6. independent read-only review.

A reviewer finding changes the board state to `fixture_needed`,
`implementation_needed`, or `dependency_blocked`; it does not authorize a
live run. A follow-up change is valid only when it cites a new source fact,
failed check, failed preflight item, or an unproven **Given**/**When**/**Then**
assertion. After each change, run the smallest check for that assertion. Do
not reread or re-review a settled scenario path without a new falsifier.

## 6. Freeze the live-mutation preflight

A target-game mutation is unavailable until one non-mutating, action-specific
preflight record has all of the following: runner/parser replay against a
recorded real-shaped receipt or protocol payload; current schema/contract
checks; validated fixture/profile start facts and forbidden outcome facts;
target-version build, game/SMAPI attachment, and published capability check;
exact request/receipt identity predicate; action-specific fresh reread; and
profile transaction/teardown steps. A previous static pass, successful launch,
or old environment log does not substitute for a current preflight.

The parent records the preflight verdict and obtains the independent review in
section 5 before the formal gate. A failed item returns the row to its concrete
board column; fix it first. It never spends, repeats, or relabels the mutation
as a formal closure attempt.

## 7. Serialize target-game gates

Static lanes may run in parallel. **Target-game mutation gates never do.**
For one action at a time:

1. prepare a disposable profile transaction and verify no game/SMAPI process;
2. start target-version game and wait for valid native-local attachment;
3. observe fresh eligible opaque target;
4. submit the typed production request;
5. retain both accepted and matching terminal receipt using exact
   `executionId` + `requestId`;
6. perform a fresh action-specific reread;
7. restore transaction and verify no working save, lock, backup, or processes
   remain.

A pass requires:

```text
same-execution succeeded receipt
+ nonempty action-specific evidence
+ fresh declared postcondition
+ verified teardown
```

A target/path/precondition failure is a truthful result. Record the concrete
reason code and return the row to the proper board column; never manufacture a
replacement target or reinterpret fixture setup as success.

## 8. Record only the correct claim

After a native-local pass, update the action runbook/fixture documentation with
its precise starting state, production receipt, fresh postcondition, and
non-guarantees. State explicitly that it is shared mechanics evidence only.

Portfolio, Farmhand, publication, persistence/reopen, recovery, and release
evidence are outside this skill's active scope while Portfolio is parked.
Record such work as out of scope rather than treating it as shared-mechanics
closure.

## Completion

A batch iteration is complete when every selected row is either:

- passed in a serial target-version mechanics gate with verified teardown;
- has one fully named acceptance scenario and is ready for its next serial
  gate after the scenario's static checks and review pass; or
- recorded once with a concrete blocker and moved out of the active lane.

Do not report a static slice, fixture setup, source audit, or successful launch
as an action closure. Report which **Given**, **When**, or **Then** assertion
is proven, pending, or blocked, and identify any missing
producer→consumer→verifier link instead.
