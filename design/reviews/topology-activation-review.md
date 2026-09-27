---
reviewId: TOPOLOGY-ACTIVATION-REVIEW-2026-09-27
scope: >
  Independent activation review of design/tasks/active/stardew-product-launch-topology-consolidation.md.
  Single question: does the current evidence establish activation facts 1-4 (owner no longer states
  installation registration incomplete; owner no longer states bootstrap containment incomplete; the
  production tests and platform-specific verification named by that owner pass; an independent reviewer
  confirms those current facts permit this topology consolidation)? Read-only except this report file.
verdict: GRANTED
date: 2026-09-27
reviewer: worker-subagent (independent activation review)
reviewerModel: worker-subagent (model identifier not exposed to the reviewing agent)
---

# Topology Consolidation Activation Review

## Commands actually run (real output)

```text
node tools/check-host-game-physical-seam.mjs
  -> "host game physical seam: passed (200 production files)"        exit 0
node --test tools/check-host-game-physical-seam.test.mjs
  -> tests 20 | pass 20 | fail 0 | skipped 0                         exit 0
npm run check:host-module-graph
  -> no dependency violations found (141 modules, 285 dependencies)  exit 0
node --test tools/run-game-operational-gate.test.mjs   (worktree file)
  -> tests 11 | pass 11 | fail 0 | skipped 0                         exit 0
<HEAD version of tools/run-game-operational-gate.test.mjs, import paths repointed at this tree>
  -> tests 11 | pass 10 | fail 1 | skipped 0                         exit 1
     failing: "Task 0 current owner keeps the transitional direct route blocked on both predecessors"
node host/dist-test/stardew-installation-registration.internal.test.js
  -> tests 12 | pass 11 | fail 0 | skipped 1 (symlink privilege)      exit 0
node host/dist-test/games/stardew/lifecycle/stardew-installation-registration-lock.test.js
  -> tests 3  | pass 3  | fail 0 | skipped 0                         exit 0
node host/dist-test/games/stardew/lifecycle/stardew-private-bootstrap-composer.test.js
  -> tests 108 | pass 108 | fail 0 | skipped 0                       exit 0
node host/dist-test/stardew-production-lifecycle-coordinator.internal.test.js
     host/dist-test/composition/stardew/stardew-guardian-platform.test.js
  -> tests 95 | pass 95 | fail 0 | skipped 0                         exit 0
node --test --test-concurrency=1 native/windows-bootstrap-guardian/guardian-live.test.mjs
  -> tests 65 | pass 65 | fail 0 | skipped 0                         exit 0
node -e "console.log(process.platform)"
  -> win32  (node v24.13.0)
```

All test runs above executed on Windows (verified `win32`), against prebuilt `host/dist-test`
artifacts. Sources were confirmed older than their artifacts for every suite I ran
(`stardew-private-bootstrap-composer.core.ts` 09-27 04:04 / `.test.ts` 04:25 /
`stardew-guardian-platform.ts` 06:05 / `stardew-production-lifecycle-coordinator.internal.ts` 06:12
vs. artifact 09-27 15:45), so no suite was run against stale output. I did **not** run a strict fresh
`pnpm run build:test`; see LOW-3.

---

## Question 1 — Facts 1 and 2: does `integration.md` still state installation registration

or bootstrap containment incomplete? **No.**

Every "unclosed" statement that HEAD's own status test pinned is gone. I extracted HEAD's eleven
`assert.match(owner, …)` patterns from `git show HEAD:tools/run-game-operational-gate.test.mjs` and
evaluated them against the current owner — 6 no longer match, and all 6 are the incompleteness
assertions:

| # | HEAD assertion pattern (abridged) | vs. current owner |
|---|---|---|
| 1 | 直接 `pipeName`/`bridgeToken` attach 是待移除的过渡 operator 路径 | MATCH |
| 2 | 安装 registration 与 bootstrap containment 闭合前…blocked-state characterization | MATCH (conditional — see NOTE-2) |
| 3 | 闭合后必须从正式 semantic Game composition 删除… | MATCH |
| 4 | installation registration 尚未实现/未闭合：durable Host-private … 尚不存在 | **NOMATCH** |
| 5 | owner 与 registration `activeAttempt` 的 exact joint prepare-bind/settlement-release 尚未闭合 | **NOMATCH** |
| 6 | bootstrap containment 尚未闭合：exact Desktop Host bootstrap… | **NOMATCH** |
| 7 | 这两项都是 predecessor blockers；Task 0 test、fixture… 均不能解除它们 | **NOMATCH** |
| 8 | `StardewProductionLifecycleCoordinator` 仍是唯一产品 owner，native-local direct route… | **NOMATCH** |
| 10 | guardian containment、onboarding 和 target-version live open-gameplay gate 均未闭合 | **NOMATCH** |
| 9, 11 | action platform 局部 closure；ordinary Navigation 已发布 | MATCH |

(Assertion 8's NOMATCH is textual drift, not an incompleteness claim: `integration.md:193` still
states the same single-owner fact with different wording — "`StardewProductionLifecycleCoordinator`
仍是唯一产品 owner,native-local direct route 仍只作待移除的 characterization".)

What the owner now says instead:

- **Fact 1** — `design/domains/stardew/integration.md:186`: "installation registration **已闭合**(2026-09-27)".
  Also `:191` "因此 registration **已闭合**,`TASK-STARDEW-PRODUCT-LAUNCH-TOPOLOGY-CONSOLIDATION`
  的激活条件不再被 registration 阻塞" and `:193` "installation registration 也已于 2026-09-27 闭合".
- **Fact 2** — `design/domains/stardew/integration.md:192`: "bootstrap containment 已闭合(2026-09-26,…)".
  Also `:193` "bootstrap containment 已闭合;installation registration 也已于 2026-09-27 闭合".
  The closure was recorded by the containment task itself: `design/tasks/active/stardew-bootstrap-containment-recovery.md:558`
  "**Closed 2026-09-26 (`58a4970`).** `integration.md` now states bootstrap containment closed…".

No line in `integration.md` currently asserts that either capability is unclosed. The surviving
`未闭合` occurrences at `:16`, `:138`, `:152` are about the transitional direct route's *precondition*,
the `observe_scene` binding gate, and the `piggybackedScene` publication gate respectively — none is
an installation-registration or bootstrap-containment incompleteness statement.

- NOTE-2 (LOW, does not bar activation): `integration.md:16` still reads "安装 registration 与
  bootstrap containment 闭合前，它只能作为 blocked-state characterization 保留". Read as a temporal
  conditional ("before closure") this is now vacuous rather than false, but it should have been
  rewritten alongside `:186`/`:192`. It is not a current incompleteness claim.

## Question 2 — Fact 3: do the named production tests and the Windows verification pass?

**Yes, for every item the owner actually names.** Skipped tests cannot let non-Windows output
masquerade here, for two independent reasons stated below.

`integration.md:186-189` names, and I measured:

| Owner-named evidence | Owner claim | Measured |
|---|---|---|
| 12 focused registration tests (`integration.md:186`) | "11 pass,1 skip:本机不允许符号链接" | `tests 12 / pass 11 / skip 1` — **exact match** |
| Gate 6 Windows two-process matrix, "无 skip" (`:189`) | no skips | `stardew-installation-registration-lock.test.js` `3/3, skipped 0` |
| Gate 10 seam checker covers all non-test `host/src` (16 → 200 files) (`:189`) | 200 files | `passed (200 production files)` — **exact match** |
| Containment 12-item Windows security matrix (`:192`) | evidenced | `guardian-live.test.mjs` `65/65, skipped 0` |
| Registration settlement / endgame production path (`:187`, `:190`) | focused evidence | composer `108/108, skipped 0`; coordinator+guardian-platform `95/95, skipped 0` |

On the skip: the single registration skip is **disclosed by the owner itself** at
`integration.md:186` ("11 pass,1 skip:本机不允许符号链接"), and its source is a privilege probe, not a
platform branch — `host/src/stardew-installation-registration.internal.test.ts:224` creates the link
and `:227` does `t.skip("symbolic links are not permitted in this environment")`. It is a
filesystem-privilege skip under an elevated-shell-required Win32 feature, so non-Windows output
cannot hide behind it, and the suite was run on a verified `win32` host. The two suites whose
skips would matter for the platform claim — the two-process lock matrix (gate 6) and
`guardian-live.test.mjs` (the 12-item Windows matrix) — report **0 skips**.

Mixed-worktree caution, distinguished from a real failure: the worktree is heavily dirty
(`git status --porcelain` shows ~40 modified tracked files across several lanes plus hundreds of
untracked scratch files). None of the suites named by the owner failed for unrelated reasons here;
they all pass (`guardian-live` 65/65, composer 108/108, coordinator+platform 95/95, registration
11/1, lock 3/3). The unrelated-WIP failure the owner waived is documented at
`stardew-bootstrap-containment-recovery.md:515`: `pnpm run build:test` is a strict `tsc` that fails
on "85 pre-existing type errors spread across 21 test files owned by other in-flight lanes". That is
a build-time failure in folders this activation does not touch, not a failure of the named
verification; the owner waived it explicitly (`:518`).

- LOW-3: I verified the named suites against the existing `dist-test` artifacts, not against a fresh
  strict compile. The artifacts are newer than all relevant sources, so the measurements are valid
  for the current source, but a from-scratch `pnpm run build:test` is still not green — by the
  owner's own recorded waiver, for reasons outside this lane.
- HIGH-1: the word "recovery" in `integration.md:192` ("lease/EOF/recovery…均有证据") is **not**
  backed by any passing test of the *Host recovery orchestration*, because that layer does not
  exist. `stardew-bootstrap-containment-recovery.md:463` records the Host orchestration row as
  "**absent**", and `:470` states the system is "**fail-closed but not recoverable**". Neither
  required review covers it: I counted 0 occurrences of `beginRecovery`, `orchestration`,
  `crash recovery`/`crash-recovery`, `RuntimeSupervisor`, `StartRecovery`, or `RelayRecovery` in
  `design/reviews/registration-authority-review.md`, and 0 of `beginRecovery`/`orchestration` in
  `design/reviews/registration-topology-review.md`. Consequence: fact 3 is established for
  **containment** and for **registration**, which is what the activation rule actually needs;
  it is *not* established for a claim of working crash recovery. This does not make fact 2 false —
  containment (Player survives, AI drained, Job containment, ordinary close) is genuinely closed —
  and it does not block this plan, because removing a direct operator attach does not touch crash
  recovery. See "Out-of-scope residual" below.

## Question 3 — Fact 4: do these facts permit the topology consolidation to start?

**Yes. I confirm they do.** This is my judgement, evidenced:

1. Both required independent reviews exist on disk, are dated 2026-09-27, and are returned with no
   open blocker:
   - `design/reviews/registration-authority-review.md:14-21` — "**NO BLOCKER** on the reviewed
     invariant… F5 is dismissed as over-reporting… **Nothing in this review remains open.**"
   - `design/reviews/registration-topology-review.md:15` — "verdict: **NO BLOCKER**";
     `:550` — "## VERDICT: NO BLOCKER".
2. I re-verified the one BLOCKER that review had raised, myself, rather than trusting the verdict
   text. B1 applied only to an uncommitted worktree revert of the a601ea1 vacuity guard
   (`registration-authority-review.md:52-55, 177-182`). The guard is present in the current tree:
   `host/src/containment/runtime/core/contained-game-runtime.ts:186` contains
   `if (roleStates.size === 0) rejected("no role ever reached launch");`, and its regression test
   `host/src/containment/runtime/contained-game-runtime.internal.test.ts:270` is
   "an armed attempt that recorded no launched role is not settled" (:283 asserts rejection
   `/no role ever reached launch/`). `git status --porcelain -- host/src/containment` is empty, so
   the reversal is gone. The correcting commit `13dcb5a` ("restore the empty-role settlement guard
   that 9d3d7b5 wrongly removed") is an ancestor of HEAD (verified with `git merge-base
   --is-ancestor`).
3. All twelve fix/review commits the owner cites are ancestors of HEAD: `d746de4`, `a601ea1`,
   `e483234`, `ec81ee2`, `13dcb5a`, `2a34f2d`, `624a657`, `0504f65`, `dc2e0d1`, `3485dbf`,
   `e61e6d0`, `89d488f` — all verified, none dangling.
4. The owner's closure statements are consistent with what I independently measured, except the
   single "recovery" nuance at HIGH-1.
5. Both reviews are scoped to exactly the two predecessor capabilities the activation rule names —
   registration settlement/topology (`registration-topology-review.md:3-14`) and the
   containment/redaction seam (`registration-authority-review.md:29-40`) — plus the settlement
   invariant the route-removal plan depends on.

**Out-of-scope residual (does not change the verdict):** the missing crash-recovery Host
orchestration (HIGH-1) is a real, already-recorded gap, but it is orthogonal to route removal.
Tasks 1–2 of this plan delete a direct `PRODUCT_INTEGRATION_CATALOG → STARDEW_INTEGRATION_LAUNCHER
→ createKnownSemanticGameFacadeFromOperatorConfig()` attach and change nothing about guardian
recovery. Activation should not be withheld for it; it should be tracked by its own owner. I record
it here because a later reader of the activation record must not read "containment closed" as
"recovery works".

## Question 4 — does the task's acceptance criterion "the current Stardew domain owner records

installation registration and bootstrap containment as closed" now hold? **Yes, with stale

neighbouring text.**

The owner document satisfies it: `integration.md:186` (registration closed), `:191` (activation no
longer registration-blocked), `:192` (containment closed), `:193` (both closed). The acceptance
checkbox at `design/tasks/active/stardew-product-launch-topology-consolidation.md:376` can be
truthfully checked.

But the surrounding record is internally inconsistent and should be corrected as part of activation,
not left to mislead a worker:

- MEDIUM-4: the task's own prose still asserts the opposite. `:49` — "the current Stardew domain
  owner states that installation registration and bootstrap containment remain incomplete" — and
  `:87` — "The current document says the lawful installation-registration and bootstrap-containment
  authorities do not yet exist" — are now **factually false**. `:128` (Task 0 Step 2) still requires
  asserting that both "remain incomplete", which is no longer implementable and which the sibling
  lane has already deleted from the test (see Q5). `:30`, `:188` and `:391` correctly state the
  *rule* ("while…states that…unclosed"), so they remain true as conditionals; the problem is
  limited to `:49`, `:87` and `:128`.
- MEDIUM-5: the task index is stale — `design/tasks/active/README.md:10` says of the containment
  task "Task 3/4 remain blocked/partial", contradicting `integration.md:192` and
  `stardew-bootstrap-containment-recovery.md:558`. The containment task file itself still carries
  `status: active` (`:4`), consistent with Task 3's predecessor note but not with the owner's
  closure statement.
- LOW-6: Task 0's own checkboxes at `:122`, `:126`, `:130`, `:134` are still `- [ ]` although its
  four steps are demonstrably done (its status test was rewritten and passes — see Q5).

## Question 5 — the operational-gate test: expected change or real defect?

**Expected change (the predecessor facts moved), not a defect in the task or the owner.**

The premise I was given was "expect one failure". Measured precisely:

- The **worktree** file `tools/run-game-operational-gate.test.mjs` **passes 11/11**.
- The **HEAD** version of that same file, with only its relative import specifiers repointed at the
  current tree, **fails exactly one test**: "Task 0 current owner keeps the transitional direct
  route blocked on both predecessors".

The failing assertion is
`assert.match(owner, /installation registration 尚未实现\/未闭合：durable Host-private installation registration record\/selector 尚不存在/)`
against the current `integration.md`, and it is failing because the owner no longer says that — the
same 6-of-11 mismatch table in Q1. So the failure is *the test detecting that the owner's status
text changed*: the test is a documentation-status pin, it has no product-behavior surface, and it
was written (Task 0) specifically to hold the blocked state open. Its failure is the designed
signal that fact 1 has flipped, i.e. **evidence the predecessor facts changed (expected)**.

It is **not** evidence of a real defect: no production module changed, the assertion is over
Markdown, and the repo already contains the follow-up in the uncommitted worktree diff
(`git diff -- tools/run-game-operational-gate.test.mjs`): the test is renamed to
"Task 0 current owner records **both predecessors as closed** and keeps the direct route
transitional" and its four incompleteness assertions are replaced with closure assertions
(`installation registration \*\*已闭合\*\*`, `bootstrap containment 已闭合`, `不再被 registration 阻塞`,
plus non-vacuity pins on `gamebuddy-stardew-installation-registration/v1`,
`registration-authority-review.md`, `registration-topology-review.md`). That version passes 11/11.

- LOW-7: that update is **uncommitted** (`M tools/run-game-operational-gate.test.mjs`; the runner
  `tools/run-game-operational-gate.mjs` itself is unmodified). On a clean checkout of HEAD the
  status suite therefore still fails. A worker activating Tasks 1–6 must ensure that sibling
  update lands in the same commit as any other Task 0 closure, or HEAD will keep failing.

---

## Findings summary

| Severity | Finding | Site |
|---|---|---|
| BLOCKER | none | — |
| HIGH | `integration.md:192` lists "recovery" among evidenced containment items, but the Host recovery-orchestration producer is recorded absent and neither required review covers it; the system is fail-closed but not recoverable. Orthogonal to route removal, so it does not bar activation. | `stardew-bootstrap-containment-recovery.md:463,470`; both review files (0 keyword hits) |
| MEDIUM | The task's own prose still asserts the owner states both predecessors incomplete — now false as written; Task 0 Step 2 is no longer implementable. | task `:49`, `:87`, `:128` |
| MEDIUM | Task index still says the containment task's Task 3/4 "remain blocked/partial". | `design/tasks/active/README.md:10` |
| LOW | `integration.md:16`'s "闭合前…blocked-state characterization" is now vacuous and should be rewritten with `:186`/`:192`. | `integration.md:16` |
| LOW | Task 0's four step checkboxes are unchecked although its work is complete and passing. | task `:122`, `:126`, `:130`, `:134` |
| LOW | The operational-gate status-test update is uncommitted; HEAD still fails that one assertion on a clean checkout. | `git status` `M tools/run-game-operational-gate.test.mjs` |
| LOW | The named suites were verified against existing `dist-test` artifacts (newer than sources) rather than a strict fresh `build:test`, which the owner waived for 85 unrelated type errors. | `stardew-bootstrap-containment-recovery.md:515,518` |
| NOTE | The single registration skip is owner-disclosed and is a symlink-privilege skip at source; the two platform-critical suites report 0 skips on a verified `win32` host. | `integration.md:186`; registration test `:224,:227` |
| NOTE | Only the owner document matters for facts 1–2; the task plan, a checkbox, a fixture or an archived design cannot activate Tasks 1–6 (task `:39`). I did not treat any of them as authority. | task `:39` |

## Verdict

- Fact 1 — established: `integration.md:186`, `:191`, `:193`.
- Fact 2 — established: `integration.md:192`, `:193`; `stardew-bootstrap-containment-recovery.md:558`.
- Fact 3 — established for containment and registration (all named suites pass, measured, win32,
  0 skips on the platform-critical suites; the one skip is disclosed and privilege-scoped). Not
  established for a working-recovery claim (HIGH-1), which is out of scope here.
- Fact 4 — established: both required reviews returned no open blocker; I independently re-verified
  the sole prior BLOCKER is fixed at HEAD, and every cited fix commit is an ancestor of HEAD.

**ACTIVATION: GRANTED**

Recommended handoff (non-blocking): before Tasks 1–6 mutate the product route, correct
`design/tasks/active/stardew-product-launch-topology-consolidation.md:49`, `:87`, `:128` and
`design/tasks/active/README.md:10` so the record stops contradicting itself, and land the
uncommitted `tools/run-game-operational-gate.test.mjs` closure rewrite.
