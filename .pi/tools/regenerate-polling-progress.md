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

## Final gates (commit a5816280)

The shared working tree carries four other lanes' in-flight edits (including the
`draftActions` prop site in the same component), so the gates were run against a
pristine throwaway worktree of `a5816280` (`.pi/verify-head`, node_modules
junctioned, vite moved to port 4273 so it could never reuse another lane's
server), then the worktree and its junctions were removed.

- `dialogue-web: tsc.cmd --noEmit` (worktree @ a5816280) — **exit 0**.
- `./node_modules/.bin/playwright.cmd test tests/composed-reference-game-browser.spec.ts tests/stardew-installation-discovery.spec.ts --project=chromium --workers=1` (worktree @ a5816280) — **49 passed, 1 skipped (52.5s)**.
- `node tools/check-host-production-import-boundary.mjs` — **blocked**, one
  violation: `unresolved_dynamic_require` at `host/src/runtime-core.internal.ts:1436`.
  The same verdict and the same single violation reproduce at my parent commit
  `446866d3`, and neither commit touches that file — pre-existing, not from this
  change.
- `node tools/check-head-typecheck.mjs --rev a5816280` — **`head_typecheck_ok rev=a5816280d213 projects=tsconfig.json`**.

In the shared tree the same two-spec command is currently red on two *other*
lanes' assertions (`the conversation column is the transcript and the composer`
and their new `a chat with no durable draft lets the player save the first one`);
both mine pass there too (48 passed / 2 failed / 1 skipped, the 2 being theirs).

## Shared-tree result (after the lanes settled)

`./node_modules/.bin/playwright.cmd test tests/composed-reference-game-browser.spec.ts tests/stardew-installation-discovery.spec.ts --project=chromium --workers=1`
on the shared working tree — **50 passed, 1 skipped (44.4s), exit 0**, both of my
journeys included. (An earlier concurrent invocation of the same command, run at
the same time as this one and as another lane's edits, produced a 24-failure
run: two Playwright runs on one `reuseExistingServer` port, with source files
changing under the dev server. That run is not a signal and was superseded by the
green one; the third invocation was killed because it was stuck behind the same
port collision.)

Two commits carry this lane: `a5816280` (the fix + two journeys + this log) and
`1b32c824` (this log only, but see the note below). `1b32c824` was created with a
bare `git commit` and therefore also swept two files another lane had already
staged - the deletions of `handoff.md` and `handoff-action-nav.md`. No content was
lost (that lane had deleted them from the tree and staged the deletions; the
blobs remain at `0228dc13`), but the attribution of those deletions belongs to
that lane, not to this one. The commit that follows this line uses an explicit
pathspec.
