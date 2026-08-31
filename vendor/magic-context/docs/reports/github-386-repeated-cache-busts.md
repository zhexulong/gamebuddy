# GitHub issue #386 — repeated cache busts under compaction pressure

Date: 2026-08-29

## Scope and evidence

I read the complete issue body and the complete raw gist before inspecting the implementation:

```text
/opt/zerobrew/bin/gh issue view 386 --json body -q .body
curl -L https://gist.github.com/manorit2001/677be6b1746a084b76c8c77050955f1c/raw
```

The report is from plugin v0.40.1, OpenCode 1.17.16, Linux x64, OpenCode TUI. The relevant configuration is preserved in the regression fixture: `execute_threshold_percentage=50`, `smart_drops=true`, `protected_tags=12`, `clear_reasoning_age=30`, caveman enabled with `min_chars=300`, and a `5m` cache TTL. At a 50% threshold every logged pass at 80–92% is scheduler-execute eligible; the force band remains 85%.

The provider telemetry has one stable lower breakpoint: every full prefix rebuild falls back to `cache.read=57,224`. Growing-tail serves instead read the prior total minus the two uncached input tokens. I therefore classify a bust only when the read falls back to 57,224, not merely when `cache.write` is non-zero.

## Log-evidence adjudication

The gist contains 28 distinct provider samples after duplicate `message.updated` deliveries are collapsed. Twelve are full prefix rebuilds:

| Charged at (UTC) | Provider sample | Producer pass and evidence | Classification |
|---|---:|---|---|
| 08:40:24 | read 57,224 / write 74,143 / total 131,369 | 08:40:11 historian completion queued 13 drops; 18 pending ops applied; marker advanced to ordinal 516 | Expected historian materialization. It reduced the preceding 96.7% context to 87.6%. |
| 08:41:08 | 57,224 / 70,818 / 128,044 | 08:40:57 `emergency tiered drop`: one tag, estimated reclaim 8,620 tokens | Pressure cleanup with substantial benefit, but first member of a repeated force-level sequence. |
| 08:41:17 | 57,224 / 65,065 / 122,291 | 08:41:08 another `emergency tiered drop`: one tag, estimated reclaim 4,387 tokens | **Self-caused force-level trickle.** Fresh usage released the old sample latch while pressure never exited. |
| 08:41:26 | 57,224 / 65,124 / 122,350 | 08:41:17 historian publication applied two pending ops and advanced the marker to 518 | Deferred historian work riding the next execute pass. Net total rose by 59 tokens, so the fold had no visible net reclaim after tail growth. |
| 08:42:29 | 57,224 / 72,687 / 129,913 | 08:42:21 applied no pending ops (`compartment agent in progress`), ran no heuristics, and finalized with zero cleared/merged parts | **Silent known-class candidate.** See the resolution limit below. |
| 08:42:40 | 57,224 / 72,684 / 129,910 | 08:42:29 applied four pending ops, advanced the marker to 521, and emergency-dropped one tag for only ~603 tokens | Mixed historian fold + force cleanup; effectively zero net benefit (−3 tokens). |
| 08:42:49 | 57,224 / 74,114 / 131,340 | 08:42:40 emergency-dropped two tags for ~1,253 tokens, with no pending historian drain | **Self-caused force-level trickle.** The total still grew by 1,430 tokens. |
| 08:42:58 | 57,224 / 66,197 / 123,423 | 08:42:49 applied four newly published drops and advanced the marker to 527 | Expected deferred historian materialization; substantial net reduction. |
| 08:43:27 | 57,224 / 67,809 / 125,035 | 08:43:17 applied 11 pending ops and advanced the marker to 530 | Expected deferred historian materialization; small net reduction after tail growth. |
| 08:44:13 | 57,224 / 63,977 / 121,203 | 08:44:01 applied six pending ops, advanced the marker to 531, and emergency-dropped two tags for ~2,377 tokens | Mixed historian fold + pressure cleanup; substantial net reduction. |
| 08:44:37 | 57,224 / 70,295 / 127,521 | 08:44:27 deferred pending ops because the historian was running, ran no heuristics, and finalized with zero cleared/merged parts | **Silent known-class candidate.** See the resolution limit below. |
| 08:44:50 | 57,224 / 70,651 / 127,877 | 08:44:37 applied two pending ops, advanced the marker to 535, and emergency-dropped one tag for only ~757 tokens | Mixed historian fold + pressure cleanup; no net benefit after tail growth (+356 tokens). |

The two silent rebuilds at 08:42:29 and 08:44:37 cannot be uniquely assigned from this gist. Both follow a transform-array contraction around a marker/historian window (26→22 and 30→24 messages), which is the exact shape fixed by f7ece3d2: an assistant temporarily absent from one projection had its frozen sentinel id pruned, then reappeared one pass later and split the cached role group. The same v0.40.1 log does not contain per-message wire hashes or trailing-blank decision telemetry, however, so fca2695a's trailing-blank keep-loop cannot be excluded. The honest classification is **sentinel-absence favored, sentinel-vs-trailing-blank unresolved**. Both candidate defects are fixed on master.

No observed bust can be attributed to supersession, the two-pass age lane, caveman, or reasoning clearing:

- there is no `tool reclaim auto-drop` line in the gist;
- every logged heuristic timing reports `compressedTextTags=0` and `mutatedTextTags=0`;
- `clearOldReasoning` is always 0.0 ms and there is no `reasoning cleanup` mutation line.

That negative evidence does not make the TS scheduling shape safe; source inspection found open opportunities that the incident configuration can exercise in a slightly different tail.

## TS lane adjudication

### Supersession (`smart_drops`)

v0.40.1 and master already require an execute pass plus a confirmed mutation from pending ops or heuristics before supersession applies. A quiet scheduler-execute level therefore cannot originate supersession. This is already the ride-only half of Rust 9e763517.

The missing twin was the module lane's newest-20 owner-message floor. TS previously relied only on the configurable tag floor (`protected_tags=12` in the report), which is not the same unit or minimum. TS now computes the newest 20 distinct message ids from the served array and withholds superseded control-plane and edit/write tags whose owner is in that set. A missing legacy owner fails safe while the production floor is active.

### Two-pass age reclaim

Age candidates were already applied only when another mutation had priced an execute pass. The conveyor gap was its watermark: TS advanced `tool_reclaim_watermark` on every execute level, including a zero-mutation pass. It now advances only on an actual application opportunity. An empty riding opportunity still advances to current max, matching Rust f6f047d2, while plain execute residency freezes so candidates accumulate for the next bust.

### Caveman and reasoning age

The ordinary once-per-turn guard was insufficient for this configuration in two ways:

1. force pressure (≥85%) bypassed it within the same user turn; and
2. at a 50% execute threshold, a new user turn made every still-high pass eligible again.

Caveman, reasoning clearing, duplicate cleanup, and system-injection stripping now get one originating application per continuous primary-session execute-pressure episode. A real defer clears the episode. Later execute/force passes first-apply routine cleanup only when pending operations, flushed status, a history rebuild, or an executed hard fold already changed provider-visible bytes. If the episode's one emergency batch originates a bust, routine cleanup drains into that same pass. Subagents retain their deliberate every-execute behavior.

### Force-band emergency reclaim (the class visible in the gist)

The old `last_emergency_input_sample` latch stopped only duplicate transforms over the same stale usage reading. Every assistant response supplied a fresh reading, releasing the latch while pressure remained in the same force band. With `protected_tags=12`, tail growth then moved one or two tools past the floor, and the next pass dropped that trickle as a new bust. The 08:41:08→08:41:17 and 08:42:40→08:42:49 sequences prove this directly.

The existing column is now treated as a pressure-episode latch, with no schema or fence movement:

- one force-pressure episode may originate one emergency batch;
- fresh usage samples do not release it;
- dropping below the force band rearms it for a future pressure event; and
- an independent provider-visible mutation rearms it immediately so all candidates accumulated during the episode ride that already-priced bust.

The emergency selector still batches every currently eligible candidate needed for its target and keeps the existing protected tail, T1/T2 reserve, newest-20 skeleton shaping, ctx_reduce keep count, and 95% fail-closed backstop.

## Regression and mutation evidence

The postprocess fixture pins the reporter's values (`50`, `true`, `12`, `30`, `300`, `5m`) and simulates consecutive 90% scheduler-execute passes with fresh provider samples. It proves:

- caveman bytes remain identical across consecutive execute passes and across a new user turn while the same pressure episode remains active;
- the first force batch drops all currently eligible tools in one pass;
- two more tail tools aging past `protected_tags=12` do not mutate the priced prefix on the next fresh execute sample; and
- after a queued drop creates an independent bust, both that drop and the accumulated emergency candidate apply together.

Selector tests pin the 20-message supersession floor and age-watermark freeze. Focused coverage executes real target mutations and checks persisted statuses/depths, not selector output alone.

Every deliberate mutation used the exact `NON-VACUITY BREAK` marker and was restored immediately:

| Deliberate break | Focused red evidence |
|---|---|
| Restored fresh-sample release of the emergency latch | `transform-postprocess-phase.test.ts:2086`: tag 19 was `dropped`, expected `active` on the consecutive execute pass. |
| Restored once-per-turn caveman admission instead of pressure-episode admission | `transform-postprocess-phase.test.ts:2001`: the exact-config provider bytes changed on the next execute-eligible user turn. |
| Advanced the age watermark on execute residency without a ride | `transform-postprocess-phase.test.ts:1913`: watermark was 1, expected 0. |
| Removed the newest-20 supersession owner floor | `supersession-reclaim.test.ts:161`: received tags 1–22, expected only the two owners outside the recent window. |

No `NON-VACUITY BREAK` remains.

## Draft reply for #386

Thanks, manorit2001 — your comparison with DCP is fair. “One bust, drain all useful work into it, then keep the prefix stable until the next pressure event” is also Magic Context's invariant #1, not a behavior we intend to trade away.

Your v0.40.1 log has 12 full prefix rebuilds at the same 57,224-token breakpoint. Several are real historian folds and some materially reduce context, but the repeated sequence is not all useful work. The log explicitly shows force cleanup dropping one or two newly eligible tools on consecutive high-pressure passes; some of those rebuilds reclaim only ~603–1,253 tokens and have no net benefit after tail growth. Two additional rebuilds have no logged mutator. Their marker-window shape most strongly matches the sentinel-absence bug, although this log cannot distinguish that from the trailing-blank keep-loop without per-message wire hashes.

Two fixes already on master will ride the next release: f7ece3d2 preserves frozen sentinel ids across temporary marker-window absence, and fca2695a stops trailing blank decisions from self-poisoning. We also fixed the remaining TS pressure-lane gaps found from your configuration: emergency reclaim is now one batch per continuous force-pressure episode, accumulated candidates ride the next independent bust, caveman/reasoning routine cleanup cannot reopen on every execute-eligible turn, the two-pass age watermark advances only on a real riding opportunity, and smart-drop supersession now preserves the newest 20 owner messages like the module lane.

The gist does not show caveman, reasoning, age, or supersession actually mutating (`compressedTextTags=0`, no reasoning cleanup, no auto-reclaim line), so we are not attributing your recorded charges to those lanes. We fixed their scheduling because the same 50% configuration exposed real source-level opportunities, while the emergency trickle is directly proven by your log. Exact-config consecutive-pass regressions now pin byte stability and verify that deferred candidates batch into the next already-priced bust.

No GitHub action or master push was performed from this worktree. The cache-safety/adversarial gate remains required before merge.
