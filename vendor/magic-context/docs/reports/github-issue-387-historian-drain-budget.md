# GitHub issue #387 — historian internal drain budget recovery

## Contributor register

- Reporter: [@tenshiak](https://github.com/tenshiak)
- Surface: Pi, Magic Context v0.40.1
- Correlation: same reporter and session as #385

## Finding

The logged limit is not provider quota. Both Pi and OpenCode call `reserveProtectedTailDrainTokens` before invoking a historian model. The limiter is stored on the session's own `session_meta` row and every read/write includes `WHERE session_id = ?`; there is no shared process-wide counter or cross-session key.

The budget counts reserved **true-raw protected-tail tokens**. Each admitted run reserves the smaller of:

1. all true-raw eligible tokens in the trigger snapshot;
2. the pressure-dependent per-run cap; and
3. the remaining ten-minute window budget.

A successful publish keeps that charge. A genuine historian/model failure also keeps it as retry throttling and arms a short failure backoff. Pre-model no-ops, empty chunks, stale/no-progress paths, and other non-attempt exits roll their reservations back. It therefore counts neither provider requests nor publications directly; it accounts for the amount of raw history an admitted drain is allowed to process.

The v0.40.1 reset was already checked before reservation, including on a skipped attempt. It was not reset-on-success-only, and skipped runs did not prevent the ordinary `now - windowStartedAt > 10 minutes` check. The persisted keys were session-scoped, epoch-millisecond arithmetic was timezone-independent, and no source write path copied another session's timestamp.

That explains the reporter's observation that compartments still formed. Below the force band, the first eligible trigger after a ten-minute boundary is admitted and can spend the fresh budget; rapid subsequent triggers in that window print the skip. At force pressure, the emergency catch-up latch may bypass the normal window budget except during failure backoff. Manual wrapup also bypasses this pressure-window quota. The two 09:58 excerpts are only eleven seconds apart, so both naturally observe the same spent window. A minute-by-minute simulation over the reported 17 hours admits one budget-sized drain at every ten-minute boundary rather than remaining wedged.

The old expiry predicate did have two clock robustness gaps: it waited an extra instant at the exact boundary, and a persisted start timestamp ahead of the current wall clock could remain active until the clock caught up. There is no identified normal v0.40.1 write path that creates a future timestamp, but clock correction or externally damaged persisted state could produce it. The fix treats zero, future, and expired starts as a fresh clock-armed window before evaluating spend. This heals an already-poisoned row organically on its next eligible trigger, without a migration.

## Relationship to #385

The two reports are one symptom chain, but not one state bug. The #385 Pi factor computes the first #387 specimen exactly:

```text
165,241 / (247,424 × 0.85) = 78.57%
```

The honest pressure was 66.78%. The inflated 78.6% crossed the 78% proactive floor and caused the `projected_headroom` trigger at 16:41. That made Pi attempt drains much more often, so a legitimately spent internal budget produced a skip on nearly every transform pass. The #385 fix removes that false trigger pressure; this fix independently makes the budget's clock recovery explicit and diagnosable. The 09:58 `commit_clusters` trigger is separate from pressure and remains a legitimate trigger.

## Why a ~102-token chunk could spend the budget

The `~102 tokens` in the invocation log is the historian's filtered, TC-formatted narration. The budget uses `boundarySnapshot.trueRawEligibleTokens`, which includes raw tool-result occupancy that the compact narration omits. The proactive substance gate likewise accepts either at least 6,000 true-raw tokens, a saturated chunk scan, or at least 12 messages. Pi's TypeScript lane has no configurable `min_chunk_tokens` gate; that name belongs to the Rust historian chunk policy.

Consequently, five tool-heavy messages can produce only ~102 prompt tokens while representing enough raw provider context to consume a per-run cap or the remaining window budget. A genuinely 102-true-raw-token reservation charges exactly 102 tokens and does not spend an entire normal window; the new regression pins that distinction. The pasted line alone cannot recover the prior persisted spend or true-raw estimate, but the new skip log exposes the current spend directly.

## Fix

- Window validity is now clock-armed: a reservation attempt starts a fresh ten-minute window when the stored start is absent, in the future, or at/past expiry.
- A future failure timestamp no longer suppresses emergency catch-up indefinitely after a wall-clock correction.
- Reservation results carry the window start, reset time, remaining delay, current spend, and limit.
- The misleading line is removed from both historian lanes. Pi now emits, for example:

  ```text
  historian skip: internal drain budget spent (9000/9000 tokens; resets in 10m)
  ```

- The legitimate rapid-spawn protection, failure backoff, emergency catch-up, and per-session storage remain intact. No schema migration or fence movement is required.

## Regression and mutation evidence

`protected-tail-drain-budget.test.ts` covers the 16:41 publish / 57-second skip / 17-hour timeline, exact-boundary replenishment, rapid-fire rejection, future-timestamp organic healing, cross-session isolation, and the 102-token accounting distinction. `pi-historian-runner.test.ts` asserts the replacement user-facing log.

Executed mutations used the exact `NON-VACUITY BREAK` marker and were restored immediately:

- Disabling time expiry failed the 17-hour and exact-expiry assertions at `protected-tail-drain-budget.test.ts:54` and `:86`.
- Disabling spend subtraction admitted rapid-fire attempts and failed at `:45`, `:69`, and `:113`.
- Disabling future-timestamp healing reproduced the persisted wedge and failed at `:103`.

The restored focused suite passed 51/51. Full verification passed 4,204 plugin tests, 879 Pi tests, and both package typechecks. The first full Pi run also exposed an unrelated #383 test flake: assertions expected the first animated in-progress glyph while production intentionally selects a wall-clock spin frame. The test now freezes its own clock, preserving the expected first frame and making the full gate deterministic. No mutation marker remains in source or tests.

## Reply draft for #387

Thanks @tenshiak — the exact timestamps and the tiny first chunk made the mechanism traceable. `historian rate-limit skip: quota exhausted` was a misleading Magic Context log: it happened before any model call and referred to the session's internal protected-tail drain budget, not your model provider quota.

That budget accounts for true-raw history being drained, not the small filtered prompt shown in the invocation line. Your five-message, ~102-token historian prompt could still cover a large raw tool-result payload and spend the remaining internal window allowance. The budget is per session and normally admits the first eligible drain after each ten-minute reset; that matches your observation that compartments continued to appear between repeated skips. Rapid triggers inside the same window remain blocked to prevent runaway historian spawns.

This is entangled with #385 in the observed behavior: v0.40.1 inflated Pi pressure with the `0.85` divisor, so `165,241 / 247,424` was treated as 78.6% instead of 66.8% and the historian fired on far too many passes. The #385 pressure fix reduces those false triggers. This change separately hardens the internal budget so its window always recovers by clock time (including exact expiry and damaged future timestamps), while retaining the legitimate loop protection.

We also replaced the misleading message. It now names the internal limiter and reports its state and reset delay, for example: `historian skip: internal drain budget spent (9000/9000 tokens; resets in 10m)`. Provider quota failures still occur later, after spawn, and log as historian/model failures instead.
