# regenerate-polling-progress

Task: fix `handleRegenerate` never injecting a pending submission, so the polling
fallback it starts dies on `startPolling`'s first tick guard.

## Command log

- `git status/log` — HEAD moved to `3b7cdc2d` mid-lane; the AppBar lane's
  400px-strip test (`acf4c1e2`) is already committed, so the spec file's only
  outstanding diff is mine.
- `dialogue-web: ./node_modules/.bin/tsc.cmd --noEmit` — 0 errors.
- `playwright test tests/composed-reference-game-browser.spec.ts -g "regeneration settles through the polling fallback"` (fix applied) — **1 passed (5.7s)**.
- `playwright test ... -g "an idle conversation with nothing pending"` (fix applied) — **1 passed (4.5s)**.
- Reverted `ComposedReferenceGameApp.tsx` to HEAD, re-ran the regeneration
  journey — **1 failed**: `expect(locator).toContainText("The projection is a
  reading, not the valley itself.")` timed out at 5000ms (received the
  pre-regenerate variant). The `data-pending="regenerate"` assertions passed
  even unfixed: that attribute is the in-flight *mutation* projection, not the
  turn's, so the transcript assertion is the honest regression pin.
- Restored the fixed component (diff back to `+42/-11`).

## Fix

`beginTurnMutation(idempotencyKey, current)` is the one path both turn-starting
mutations (send, regenerate) take: it requires an available `chat.submit` (the
store admits one turn at a time) and publishes `session.withPending(...)` before
the wire call. `handleSend` and `handleRegenerate` both call it; `handleSwipe`
and `handleStop` start no turn and call neither (neither starts polling).
