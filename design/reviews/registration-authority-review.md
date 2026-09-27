---
reviewId: REGISTRATION-AUTHORITY-REVIEW-2026-09-27
scope: >
  Guardian settlement / recovery fail-closed semantics for the unified generic
  contained-game runtime. Reviewed commits: 2a34f2d (contract+settle), 624a657
  (named game.endgame), 93da045 (legacy facade removal), a601ea1 (vacuous-guard
  fix), d746de4 (terminal-settlement latch, landed during this review).
  Questions: (1) can ordinary close / AI crash / controller EOF reach protected
  terminal settlement and release the registration pointer; (2) does settle()
  still admit vacuous / empty-set / early-return attempts; (3) does ordinary
  close preserve the Player Host and is the single-session close latch
  race-free; (4) where is "definitely did not dispatch" distinguished from "may
  have produced a native side effect".
verdict: >
  NO BLOCKER on the reviewed invariant. The review's original BLOCKER applied only to
  an uncommitted working tree that temporarily reverted the a601ea1 vacuity guard;
  that revert was corrected in 13dcb5a under this review's own recommendation, and the
  other findings were fixed in ec81ee2, e483234, d746de4 and a601ea1. F5 is dismissed as
  over-reporting by the owner adjudication appended at the end of this file, which
  proves the described interleaving unreachable on four independent lines. F6 and F7
  are acknowledged with no action. Nothing in this review remains open.
date: 2026-09-27
reviewer: claude-sonnet-4-5 (adversarial reviewer subagent)
ownerAdjudication: 2026-09-27 (F5 dismissed; F6/F7 acknowledged)
---

# Registration Authority Review — settlement fail-closed semantics

Scope files (all relative to repo root):

- `host/src/containment/runtime/core/contained-game-runtime.ts`
- `host/src/containment/runtime/contained-game-runtime.internal.test.ts`
- `host/src/composition/stardew/stardew-guardian-platform.ts`
- `host/src/stardew-production-lifecycle-coordinator.internal.ts`
- `design/tasks/active/game-session-survival-and-reconnect-simplification.md`
- Direct neighbours required by the trace:
  `host/src/containment/auth/desktop-guardian-session.internal.ts`,
  `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts`,
  `host/src/stardew-installation-registration.internal.ts`,
  `host/native/windows-bootstrap-guardian/{Program.cs,WindowsJobOwner.cs}`

## Review-integrity note (read first)

The working tree changed **during** this review. Two things happened:

1. Commit `d746de4` ("make settlement terminal so it cannot reach the platform
   twice") landed at 05:55:32, i.e. after the commit list I was given. It adds a
   `settled` latch to `settle()`.
2. The tracked files
   `host/src/containment/runtime/core/contained-game-runtime.ts` and
   `host/src/containment/runtime/contained-game-runtime.internal.test.ts` are
   **modified but uncommitted**, and the modification **deletes the a601ea1
   vacuity guard** (`if (roleStates.size === 0) rejected("no role ever reached
   launch")`) and rewrites the a601ea1 regression test so that it now *asserts the
   vacuous settlement is correct*.

`git diff HEAD` at review time is exactly that reversal. Because the reviewer's
job is to report the artifact as it actually exists, this review separately
reports (a) HEAD `d746de4`, and (b) the uncommitted worktree state. Finding B1
covers the worktree reversal and is the reason for the BLOCKER verdict.

## Answers to the four questions

### Q1 — Can ordinary close, AI-client crash, or controller EOF reach platform settlement and release the registration pointer?

**No, on both HEAD and the worktree.** Verified by call-graph exhaustion.

- The only caller of the runtime's `settle()` is `stardew-guardian-platform.ts:219`
  (collaborator `settle(owner)`).
- That collaborator is bound into the coordinator seam at
  `stardew-production-lifecycle-coordinator.internal.ts:432` and invoked from
  exactly one place: `endgameGame` at `:1238`.
- `endgameGame` (`:1193`) is reachable only via
  `consumeBrowserAdmission(admission, "game_endgame", …)` (`:1196`) with an
  authenticated browser session, plus `isClosing()` (`:1205`),
  `expectedAttachmentGeneration === attachmentGeneration` (`:1206`) and
  `exactOwner !== undefined` (`:1208-1209`).
- The ordinary close path (`closeAttempt`, `:1947-2054`) calls only
  `containAiClient` (`:2030`) and `close` (`:2034`). It never calls `settle`, and it
  never calls `containPlayerHost` (the comment at `:2018-2026` matches the code).
- `settleOwnedPlayerHostContainedRuntimeAttempt` — the function that advances the
  durable owner record and calls `registration.releaseSettledPointer`
  (`stardew-private-bootstrap-composer.core.ts:3771-3777`, `:1247`) — has exactly
  one production caller: `stardew-guardian-platform.ts:221`, which is reached only
  after `requireRuntime(owner).settle()` returned `{status:"settled"}` (`:219-221`).
- Controller EOF / AI crash reduce to `coordinator.close()` → `platform.close()` →
  `DesktopGuardianSession.close()`. The runtime's `close()`
  (`contained-game-runtime.ts:198-202`) has no settlement effect.

Caveat carried into F4: the platform's `settle()` and `close()` are the *same*
operation (`stardew-guardian-platform.ts:246-250`, `:313-318`). The registration
release does not live in the platform at all; it lives in the collaborator at
`:221`. The invariant holds because that collaborator release is gated on the
generic runtime's `settled` result — not because the platform distinguishes settle
from close.

### Q2 — Does `settle()` reject every attempt that must not settle?

**At HEAD `d746de4`: yes for every case in the question. At the current worktree
state: no — see B1.**

HEAD `d746de4` guards (`contained-game-runtime.ts:156-196`):

- `closed` → `rejected("runtime is closed")` (`:158`)
- `!armAttempted || !armed` → `rejected("runtime was never armed")` (`:159`)
- `roleStates.size === 0` → `rejected("no role ever reached launch")` (a601ea1, at
  `:170` in `a601ea1`/`d746de4` lineage)
- any recorded state ≠ `contained` → `rejected("not every launched role is
  contained")` (`:171-173`)
- already settled → `rejected("runtime was already settled")` (`:174-178`, the
  `d746de4` addition)

A role stuck in `launching` / `launched` / `containing` / `launch-failed` /
`contain-failed` fails the loop; only `contained` (`:148`) passes. `settle` after
`close` is rejected by `:158`. A second `settle` is now rejected by `:177` and the
latch is set *before* the platform call, so the platform can never see two
settlements for one attempt.

I probed for further vacuous / empty-set / early-return paths and found no other
one in `settle()`: with `roleStates.size ≥ 1` the loop cannot be vacuous, and the
`launchedRoles` projection at `:186-188` is exactly the set the guard already
proved contained. The remaining holes are lifecycle, not vacuity: F1 (close vs
endgame) and F2 (coordinator idempotency).

The worktree state re-opens the vacuous hole — see B1.

### Q3 — Does ordinary close leave the Player Host alive, and is the close latch race-free?

**Player survival: yes, on all three layers.**

- Coordinator: `closeAttempt` drains only the AI role and never issues
  `contain_role` for `player_host` (`:2018-2040`).
- Runtime: `close()` only calls `platform.close()` (`contained-game-runtime.ts:202`);
  it never contains a role.
- Native Guardian: the Player Job is created non-kill-on-close
  (`Program.cs:66`, `WindowsJobOwner.cs:28,37`) and every ordinary-EOF / `finally`
  path terminates only `aiJob` (`Program.cs:120-122`, `:132`); the Player Job
  handle is disposed at `:134` without `TerminateJobObject`. That matches
  `design/tasks/active/game-session-survival-and-reconnect-simplification.md:14`
  and `:72-73`.

**Latch: no double-close race, but the latch converts a failed close into a fake
success (F3).** `closeSessionOnce` (`stardew-guardian-platform.ts:246-250`) does
its check-and-set synchronously before the first `await`, so on Node's single
thread two concurrent callers cannot both pass. The defect is failure handling,
not racing.

### Q4 — Where is "definitely did not dispatch" distinguished from "may have produced a native side effect"?

Three layers, each pessimistic, and each decided at a different boundary:

1. **Coordinator** — `didStardewOwnedPlayerHostStageCEnterControlledLaunch(error)`
   (`:790`; defined at `stardew-private-bootstrap-composer.core.ts:1906-1911`; set
   on claim entry per `:1977`). This is the *authoritative*
   "did-not-dispatch vs may-have-dispatched" decision: pre-claim failures restore
   `staged` and stay retryable (`:800+`), post-claim failures set
   `launchMayHaveRun` and quarantine the exact owner (`:791-799`).
2. **Generic runtime** — records the role *before* dispatch (`:130`) and treats any
   non-`contained` state as blocking settlement (`:171-173`). Nothing in `settle()`
   ever asserts "we definitely did not dispatch"; the only assertion it makes is
   "every recorded role is contained". At HEAD it additionally refuses to settle at
   all with zero recorded roles.
3. **Native Guardian** — both role Jobs and the exact lease exist before the
   `armed` ack (`Program.cs:62-71`), so an `armed` record implies the Jobs exist; a
   role can only be contained after it launched (`:113`), and a duplicate launch is
   refused (`:78`).

Consequence: a launch that failed *before any native frame was written* (e.g.
`modelNativeRoleLaunchPlan` throws at `stardew-guardian-platform.ts:299`, before
`session.launch`) still records `launch-failed` and permanently blocks settlement.
That over-conservatism is the safe direction and consistent with memory rule #2286,
but it is the mechanism behind the pointer-stays-bound residual already recorded in
commit `40c30e3` (see F5).

## Findings

### B1 — BLOCKER (uncommitted working tree) — The a601ea1 vacuity guard is reverted in the working tree, with no evidence and no test

Files: `host/src/containment/runtime/core/contained-game-runtime.ts`
(worktree `:164-170`), `host/src/containment/runtime/contained-game-runtime.internal.test.ts`
(worktree `:256-284`). Confirmed via `git diff HEAD`, which shows both files as
modified (` M`) and uncommitted.

The worktree deletes:

```ts
if (roleStates.size === 0) rejected("no role ever reached launch");
```

and replaces the a601ea1 comment with:

> An attempt that armed but launched no role is deliberately settlable:
> `arm_attempt` creates BOTH role Jobs natively
> (host/native/windows-bootstrap-guardian/Program.cs), so a role the runtime never
> launched still owns an empty Job with nothing left outside containment. Refusing
> this case would block a legitimate endgame of an armed-but-unlaunched attempt.

The same change rewrites the a601ea1 regression test
(`contained-game-runtime.internal.test.ts`, previously "an armed attempt whose
launch failed before recording a role is not settled") into
"an armed attempt that launched no role is still settlable, with no roles
reported", which now asserts `assert.deepEqual(await runtime.settle(), { status:
"settled" })` and `assert.deepEqual(log, ["arm:player", "settle"])`.

Why this is a blocker rather than a design preference:

1. **It re-opens the exact hole the task asked me to verify was closed.** With the
   guard gone, `settle()` proceeds on an armed attempt with an empty `roleStates`,
   returns `{status:"settled"}`, and calls `platform.settle` with `launchedRoles:
   []`. The collaborator then unconditionally runs
   `settleOwnedPlayerHostContainedRuntimeAttempt(owner, [])`
   (`stardew-guardian-platform.ts:221`), which drives
   `armAcknowledged → (no roleActive) → beginControlledClose →
   controlledRoleContained("playerHost") → controlledRoleContained("aiClient") →
   finalizeControlledContained` and mints the settlement proof that releases the
   registration pointer (`stardew-private-bootstrap-composer.core.ts:3802-3811`,
   `:3776`, `:1247`). That is precisely the "platform mints a containment proof and
   releases the registration pointer for a launch that never happened" outcome
   documented in the a601ea1 commit message and in memory rule #1857's
   fail-closed requirement.
2. **The stated rationale does not establish the runtime-level claim.** "arm_attempt
   creates both Jobs natively" is a *Stardew-native* property. It is used here to
   justify a guard in the **generic** core, whose own contract says the platform
   "never has to invent or guess what to record as contained"
   (`contained-game-runtime.ts:49-51`) and which the suite explicitly pins as
   containing no platform-native knowledge
   (`contained-game-runtime.internal.test.ts:133-143`). The only party that can
   truthfully say "an empty Job counts as contained" is the Stardew composer, which
   already says so at `stardew-private-bootstrap-composer.core.ts:3805-3807`.
3. **The claimed justification — "would block a legitimate endgame of an
   armed-but-unlaunched attempt" — describes a path I could not show to exist, and
   removing the guard buys nothing.** `endgameGame` requires
   `command.expectedAttachmentGeneration === attachmentGeneration` (`:1206`).
   `attachmentGeneration` becomes 1 only at the end of a successful
   activation/handoff (`:1007` in the browser path, `:1887` in the headless path),
   and both of those points are *after* an AI-client role launch succeeded through
   this same runtime (`:979`, `:1860`; `*LaunchThroughRuntime` is set true only on
   success). So whenever the endgame precondition can be satisfied, `roleStates`
   already holds at least `ai_client` and the empty-set guard was never the thing
   blocking the endgame. **I could NOT construct a production-reachable
   empty-set settlement**, and I am not asserting one: this is why B1 is a
   *silent deletion of a deliberately fail-closed guard*, not a demonstrated live
   exploit path.
   What I *can* state is that the two halves contradict each other: in the
   arm-succeeded-then-expired window that a601ea1's test constructs (`:129`), the
   coordinator classifies the failure as pre-claim (`launchCompleted === false`, no
   `didStardewOwnedPlayerHostStageCEnterControlledLaunch` mark, `:790`) and the
   composer restores `playerHostProfileStagingState = staged` for retry
   (`stardew-private-bootstrap-composer.core.ts:2049`, `:1900-1901`) — i.e. that
   attempt is *not* terminal — while the worktree simultaneously makes it durably
   settlable, i.e. `contained`, with the pointer released. Both cannot be true.
4. **No test accompanies the reversal other than the rewritten assertion**, and the
   reversal contradicts a601ea1, the commit the task statement named as having just
   fixed this hole. Inverting a regression test's assertion is not evidence that the
   hazard is gone; it removes the only artifact that could detect its return.

Recommended fix: revert the uncommitted change (restore
`if (roleStates.size === 0) rejected("no role ever reached launch");` and the
a601ea1 test), then, if the "armed-but-unlaunched attempt must be settlable"
product decision is genuinely wanted, implement it **at the composer layer** where
the native Job-creation fact is owned — e.g. an explicit typed precondition on
`settleOwnedPlayerHostContainedRuntimeAttempt` — and land it with a coordinator-level
test that demonstrates the reachable endgame path. Do not weaken the generic
contract to enable a path that cannot be shown to exist.

**Note for the supervisor: I did not modify, reset, clean, or stash this worktree
change** (read-only review, and memory rule #2535 forbids touching another writer's
WIP). It is live and will affect any build or test run started from this tree.

### F1 — HIGH — A concurrent close can destroy an in-flight explicit endgame after the Player is already terminated

`stardew-production-lifecycle-coordinator.internal.ts:1947-2054` vs `:1210-1242`
(unchanged by `d746de4`).

`closeAttempt()` awaits `activation`, `setup`, `launch`, `resume`, `create` and the
cabin confirmation (`:1971-1984`) but **not** the endgame promise, then drives
`containedRuntimeTeardown.containAiClient` + `close` (`:2027-2040`). The endgame
promise (`:1210-1242`) participates in no coordinator-level mutex. The generic
runtime serializes its own calls, but `close` and `settle` are two independent calls
in that serialized chain, so both orders are reachable:

- `runtime.close()` (`contained-game-runtime.ts:198-202`) lands first → `closed =
  true`, so the endgame's `containRole` (`:143`) or `settle()` (`:158`) rejects
  `"runtime is closed"`. The endgame promise rejects with
  `stardew_contained_player_host_contain_failed` /
  `stardew_contained_runtime_settlement_unavailable`
  (`stardew-guardian-platform.ts:220`) **after** `teardownAttachment()` has already
  run and — in the contain-first interleaving — after `containPlayerHost` has
  already killed the Player Job.
- Result: Player terminated, durable owner record still nonterminal, registration
  pointer still `activeAttempt`-bound, `endgameSettled` false, and no path returns
  the attempt to terminality (the only route to `contained` is the explicit
  endgame — the residual recorded in commit `40c30e3`). The browser receives an
  unexplained failure.

`d746de4`'s `settled` latch does not address this: the rejection happens before the
latch is reached.

Recommended fix: make the endgame part of the close authority, exactly as the
existing stop join does at `:1212-1213`. Either (a) `closeAttempt` joins
`Promise.all([...gameEndgames.values()].map((e) => e.promise.catch(() =>
undefined)))` before touching `containedRuntimeTeardown`, or (b) both `endgameGame`
and `closeAttempt` acquire one coordinator-owned settlement/teardown mutex.
Additionally `closeAttempt` must not call `containedRuntimeTeardown.close` for an
attempt that already settled.

### F2 — HIGH — A repeat endgame with a fresh idempotency key throws a raw durable-transition error

`stardew-production-lifecycle-coordinator.internal.ts:1197-1204` +
`stardew-private-bootstrap-composer.core.ts:3802`, `:3530-3533`.

`d746de4` fixed the *runtime* half of this (the `settled` latch at
`contained-game-runtime.ts:174-178` means a second `settle()` now rejects before the
platform call), so the earlier "platform settles twice" concern is closed at HEAD.

The coordinator half remains. `endgameGame`'s only idempotency protection is the
exact-`idempotencyKey` short-circuit (`:1197-1204`). The endgame path never resets
`attachmentGeneration` (only the `endgameSettled` close branch does, `:1955`), so a
second endgame with a **new** key and `expectedAttachmentGeneration: 1` passes
`:1206`, skips both contain calls (`runtimeContained.*` already true,
`:1226-1233`), reaches `settle`, and:
`requireRuntime(owner).settle()` now rejects `"runtime was already settled"`
→ the collaborator throws
`stardew_contained_runtime_settlement_unavailable`
(`stardew-guardian-platform.ts:220`) — an error the browser's known-message mapper
does not cover (`composed-reference-game-browser.ts:393-399`). The UI gets an opaque
failure for a game that is already ended. (If the latch were absent, the next
failure would instead be the raw `stardew_bootstrap_owner_transition_invalid` from
`transitions.arm`, `:3530-3533`.)

Recommended fix: make the coordinator's endgame idempotent per attempt rather than
per key — after a successful settlement the endgame should return the terminal
`{status:"gameended"}` result without re-driving the runtime, e.g. by short-circuiting
on an `endgameSettled`/terminal-attempt fact before `containedRuntimeTeardown.settle`,
and by mapping the "already settled" runtime rejection to the terminal result.

### F3 — HIGH — The single-session close latch converts a failed close into a silent permanent success

`stardew-guardian-platform.ts:245-250` + `contained-game-runtime.ts:198-202`.

`closeSessionOnce` sets `sessionClosed = true` **before** `await session.close()`. If
`session.close()` rejects, the latch is already set, so no later call can retry the
session close. Independently, `runtime.close()` sets `closed = true` before
awaiting, so a second `runtime.close()` returns `operation.then(() => undefined)`
(`:199`) — a **resolved** promise — even though the first close rejected.

This matters because the coordinator retries close: `close()` clears `closePromise`
when the attempt rejected and the lifecycle is not yet `closed` (`:2057-2064`), and
`closeAttempt` reaches `closed` only after the `incomplete` check (`:2041-2053`). So
a second close attempt reports full success (`containedRuntimeTeardown.close`
resolves, `runtimeClosed = true`, `transition("closed")`) while the authenticated
Guardian session may still be open — precisely what
`design/tasks/active/game-session-survival-and-reconnect-simplification.md:41`
forbids ("close/drain 失败必须传播且不得伪造成功").

Recommended fix: latch only on success (`await session.close(); sessionClosed =
true;`) so a failed close stays retryable; in the runtime, only set `closed = true`
after `platform.close()` resolves, or record the close failure and re-drive it on a
repeat `close()`. The endgame path must not rely on this latch as its only
single-release guarantee.

### F4 — MEDIUM — Second and later endgames retain rejected promises in `gameEndgames` forever

`stardew-production-lifecycle-coordinator.internal.ts:1243-1248` vs `:1954-1968` vs
`:2042-2052`.

The `endgameSettled` close branch clears `gameEndgames` (`:1965`); the ordinary close
branch clears `gameResumes`, `gameResumeCancels`, `gameReopens`, `gameSetups`,
`gameStops`, `gameDisconnects` and `gameCreates` (`:2046-2052`) but **not**
`gameEndgames`. Every endgame result — including the rejected promises produced by
F1/F2 — is retained for the coordinator's lifetime, and a later same-key retry
replays the stale rejection (`:1197-1204`).

Recommended fix: clear `gameEndgames` in both branches, or keep rejected attempts out
of the idempotency map and store only settled terminal results.

### F5 — MEDIUM (needs owner confirmation) — The durable settlement declares both roles contained regardless of what the runtime recorded

`stardew-private-bootstrap-composer.core.ts:3808-3809` (both
`controlledRoleContained("playerHost")` and `controlledRoleContained("aiClient")`
unconditional) vs `contained-game-runtime.ts:186-188` (`launchedRoles` = exactly the
recorded roles) and `stardew-production-lifecycle-coordinator.internal.ts:1226-1233`
(only roles whose `*LaunchThroughRuntime` flag is set get contained).

The runtime proves only that *its* recorded roles are contained; the composer then
marks *both* roles durably contained and mints the proof that releases the
registration pointer. The composer's justification (`:3805-3807`: a role the runtime
never launched has an empty Job with nothing outside containment) is true for *this
attempt's* Jobs, which `arm_attempt` created (`Program.cs:66-67`). I could not
confirm from the in-scope files whether a live Player Host launched by a different
owner/attempt can coexist with this attempt's empty Player Job while this attempt
settles. The registration's `bindPreparedPointer` requires `activeAttempt === null`
(`stardew-installation-registration.internal.ts:104`), which argues against overlap,
but the resume / attach-existing topology is out of scope here.

If that coexistence is reachable, the product projects `gameended` and releases the
pointer while a Player world is still running — an over-report, not a fail-closed
outcome. Recommended fix pending confirmation: derive the durably-contained roles
from `launchedRoles`, or require an explicit both-roles-launched precondition, so the
durable record cannot assert containment of a role no runtime observed.

> **Resolved 2026-09-27 — no fix needed, F5 dismissed as over-reporting.**
> The confirmation this asked for is now in the owner adjudication at the end of this
> file: the coexistence is unreachable, so the composer's both-roles-contained step is
> sound for the only reachable reading. See that section for the four lines of proof.

**CANNOT VERIFY**: reachability of the coexisting-live-Player interleaving. Flagged
for the owner rather than asserted.

### F6 — NOTE — `platform.settle()` and `platform.close()` are the identical transport operation

`stardew-guardian-platform.ts:313-318`. The doc comment at `:306-312` describes settle
as "the platform only performs its own terminal transport step", distinct from close,
but both bodies call `closeSessionOnce`. The contract's guarantee ("no ordinary close
… can reach it", `contained-game-runtime.ts:45-52`) is therefore enforced entirely by
the runtime guards plus the collaborator's post-`settled` release, not by the platform
layer. Recommend asserting that (settle is only ever reached with a non-empty,
fully-contained `launchedRoles`) rather than relying on the prose — or dropping the
platform-level `settle` if it carries no distinct obligation.

### F7 — NOTE — Over-conservative settle for pre-dispatch launch failures

`contained-game-runtime.ts:130-138`. A `platform.launch` rejection that occurred
before any native frame (e.g. plan validation at `stardew-guardian-platform.ts:299`)
still records `launch-failed`, permanently blocking settlement (`:171-173`) and
forcing recovery/quarantine even though that role never dispatched. This is the safe
direction and consistent with memory rule #2286, but it is the mechanism behind the
pointer-stays-bound residual already documented in commit `40c30e3`. Recommend stating
it explicitly in the runtime contract so a later reader does not "fix" it into a
dispatch assertion — which is, in effect, what B1 attempts.

### F8 — NOTE — The "settlement is terminal" invariant is not enforced by `launchRole`

`contained-game-runtime.ts:99-104`. The `settled` latch (added by `d746de4`) is
checked only inside `settle()`; `launchRole` checks neither `settled` nor the
post-settlement state, so a role can still be launched (and then never settled, since
the latch is one-way) on a settled attempt. I could not construct a production
reachable interleaving — `endgameGame` requires an attached generation, and a new
activation reserves a new owner whose runtime is a fresh entry in the
`runtimesByOwner` WeakMap (`stardew-guardian-platform.ts:156-186`) — so this is a
hardening note, not an exploit. Recommend `launchRole` reject once `settled` is true,
so the terminal property is enforced by the contract rather than by coordinator
structure.

### Positive verification (no finding)

- `d746de4`'s `settled` latch is correct and placed before the platform call, so the
  platform can never observe two settlements for one attempt. `d746de4`'s claim that
  the composer's proof reservation would independently fail closed is consistent with
  `reserveStardewBootstrapGuardianSettlementProof`'s `state !== "available"` check at
  `stardew-private-bootstrap-composer.core.ts:3852-3855`.
- The a601ea1 guard (at HEAD) is real and appropriately targeted: the deterministic
  clock test at `contained-game-runtime.internal.test.ts:265-283` fails for the right
  reason and asserts the platform is never called.
- `settle()` after `close()` is rejected (`:158`, tested at `:247-254`).
- A `contain-failed` role blocks settlement (`_probe-edges.test.ts:21-28`; untracked
  local probe file — see process note).
- The endgame integration test proves the intended happy path end to end
  (`stardew-production-lifecycle-coordinator.internal.test.ts:1167-1227`): both
  `contain_role` calls, `owner.json` reaching `contained` in all four fields,
  `activeAttempt === null`, and same-key replay idempotency.

### Process note — untracked probe file in the test build

`host/src/containment/runtime/_probe-edges.test.ts` was present earlier in this
review and is untracked. It logs instead of asserting, uses implicit `any`
parameters, and is not excluded from `tsconfig.test.json` (`include: ["src/**/*.ts"]`,
which also sets `noUnusedLocals`/`noUnusedParameters`), so it participates in the
test build. Its EDGE B and EDGE D cases are exactly the second-settle scenario
`d746de4` later fixed, and it only *observed* them. It was removed from the tree
during this review (the file is no longer present), so this is recorded for
traceability, not as an open item.

## Verdict

On **HEAD `d746de4`**: the reviewed invariant holds. An ordinary close, an AI-client
crash, or a controller EOF cannot reach platform settlement, cannot advance the
durable owner record to `contained`, and cannot release the Guardian registration
pointer. Every guard I traced is fail-closed, the a601ea1 vacuity fix is correct, and
`d746de4` makes settlement properly terminal without over-rejecting any legitimate
settlement path (the endgame integration test still drives real settlement through the
real platform). Two HIGH findings remain on HEAD — F1 (a concurrent close can destroy
an in-flight endgame after the Player is already terminated, leaving the pointer bound
forever) and F3 (a failed close is latched into a fake success on retry, contradicting
the survival task's close/drain rule) — plus F2 (repeat endgame surfaces an opaque
error) and F4/F5.

On the **current uncommitted working tree**: the BLOCKER is B1 — the a601ea1 vacuity
guard has been deleted and its regression test rewritten to assert the vacuous
settlement is correct, with no accompanying evidence and with a rationale that
belongs to the composer layer and that does not describe a reachable endgame path.
The tree must not be built, tested as authoritative, or committed in this state.

VERDICT: BLOCKER(S): B1 — uncommitted working-tree reversal of the a601ea1 vacuity guard in host/src/containment/runtime/core/contained-game-runtime.ts (and its rewritten regression test), which lets an armed attempt with zero recorded roles return {status:"settled"} and release the Guardian registration pointer for a launch that never happened. HEAD d746de4 itself is NO BLOCKER on the reviewed invariant, with F1/F2/F3 as HIGH must-fix findings.


---

## Owner adjudication (2026-09-27): F5 dismissed as over-reporting

**Verdict: F5 is NOT reachable. The scenario it describes cannot occur, and the
durable settlement is not over-reporting.**

F5 asked whether "a live Player Host launched by a different owner/attempt can
coexist with this attempt's empty Player Job while this attempt settles". The
reviewer honestly marked this CANNOT VERIFY and flagged it for the owner. It is now
verified, by the three lines the owner named plus one the reviewer's own scope
excluded.

### Line 1 — an active pointer physically locks the registration (Gate 6)

`stardew-installation-registration-lock.test.ts` proves the lock/pointer rules on a
real second OS process (win32, no skips). The decisive case is
`the registration lock is released once the attempt is bound, so the refusal is the
pointer`: once the attempt is bound the lock is gone (asserted `ENOENT`) and a
competing publish is refused with `stardew_installation_registration_busy`
(`:317`), i.e. by the ACTIVE POINTER rather than a lock timeout. So while an attempt
is live, the registration is held by its pointer and cannot be taken over.

### Line 2 — a successor attempt cannot be born

`prepareAndBindOwnedRegistrationAttempt` reads the registration and refuses when an
attempt is already active:
`if (current === null || current.state !== "ready" || current.activeAttempt !== null)
throw new Error("stardew_bootstrap_registration_unavailable")`
(`stardew-private-bootstrap-composer.core.ts:1160-1161`), with a retained marker
refused just above (`:1155-1157`). A successor therefore cannot reach the point where
it would create its own Jobs, let alone settle. There is no interleaving in which two
attempts hold Job sets at once.

### Line 3 — settlement is correlation-bound

`settleOwnedPlayerHostRegistrationAttempt` re-reads the durable record under the
owner path lock and requires all of: same immutable fence, the exact expected owner
record revision, `terminal.bootstrapId === bootstrapCorrelation`, and a terminal
`contained`/`quarantined` state (`:1218-1225`); it then requires
`current.activeAttempt?.bootstrapCorrelation === bootstrapCorrelation`
(`:1227-1233`). Credentials from two different attempts can therefore never be
cross-applied, and the pointer being released is provably the one this attempt owns.

### Line 4 (outside the reviewer's scope) — resume reuses the SAME owner, so there is no second Job set

The reviewer's stated uncertainty was the "resume / attach-existing topology". That
topology does not mint a second attempt: only `activate` (`:711`) and the headless
activation (`:1830`) call `reserveOwnedPlayerHostBootstrapForActivation`. `resume`
does not. `attachResumedWorld` reuses the same `exactOwner` (`:1300`) and relaunches
the AI client through that same owner (`:1314`), i.e. through the same runtime and
the same attempt's Jobs. So "a live Player from a different attempt alongside this
attempt's empty Player Job" has no construction path: a resume is the same attempt,
and a different attempt cannot start (Line 2).

### Conclusion

The empty-role case in `advanceOwnedPlayerHostToContainedAndMintProof` cannot be
reached while a *different* attempt's Player is live, because a different attempt
cannot coexist with this one. The composer's justification at `:3805-3807` ("a role
the runtime never launched still has a Job (empty) with nothing left outside
containment") is therefore sound for the only reachable reading: the empty Job
belongs to *this* attempt, created by `arm_attempt` (`Program.cs:66-67`).

No code change is required for F5. The residual the reviewer correctly connected it
to (a pre-dispatch launch failure permanently blocking settlement, F7) stays
recorded in commit `40c30e3` as a fail-closed boundary.

### F6 / F7 — acknowledged, no action

- **F6** (`platform.settle()` and `platform.close()` are the same transport
  operation): intended. Both go through one latch so settlement and the ordinary
  close that may follow it cannot race two closes onto one authenticated session.
  The contract's guarantee is enforced by the runtime guards plus the collaborator's
  post-`settled` release, and is now additionally pinned by `launchRole`'s settled
  check and by the terminal/retry close tests.
- **F7** (a pre-dispatch launch failure still blocks settlement): the safe
  direction, consistent with the receipt-backed recovery rule. Already recorded as a
  residual in `40c30e3`; the runtime comment now states the boundary explicitly so a
  later reader does not "fix" it into a dispatch assertion.
