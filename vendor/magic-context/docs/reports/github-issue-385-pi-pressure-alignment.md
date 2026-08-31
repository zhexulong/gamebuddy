# GitHub issue #385 — Pi pressure-pair alignment

## Finding

The reporter's `output_reserve` geometry was correct. A raw 272,000-token window minus the configured 24,576-token reserve produces `usableSoft = 247,424`:

- `packages/pi-plugin/src/pi-context-limit.ts:66-89` resolves the user reserve and sends it through the shared geometry path.
- `packages/plugin/src/shared/window-geometry.ts:499-518` makes an explicit `output_reserve` own the carve and computes `usableSoft = reserveWindow - softReserve` exactly once.

The persisted numerator was also correct. `packages/pi-plugin/src/index.ts:551-628` persists pressure from the assistant usage row, and `packages/pi-plugin/src/pi-pressure.ts:81-92` defines prompt tokens as `input + cacheRead + cacheWrite`, excluding output. For the first specimen that numerator was 192,162.

The divergence was a Pi-only forward-pressure safety factor, not an output-reserve addition. In v0.40.1, `packages/pi-plugin/src/context-handler.ts:257-264` declared `FORWARD_PRESSURE_LIMIT_FACTOR = 0.85`, and the former expression at lines 300-301 computed:

```text
forwardPercentage = forwardTokens / (usageContextLimit × 0.85) × 100
```

That expression was applied independently in the main scheduler and historian paths. It then printed the unscaled `usageContextLimit`, creating an impossible log pair. The two report specimens fingerprint it exactly:

| Prompt tokens | Printed usable limit | Honest usage | v0.40.1 usage | Scaled denominator |
|---:|---:|---:|---:|---:|
| 192,162 | 247,424 | 77.665% | 91.4% | 210,310.4 |
| 196,210 | 247,424 | 79.301% | 93.3% | 210,310.4 |

The second inflated value crossed the threshold-relative force band (`max(85, T+2) = 92` for `T=90`), so `force=true` opened the drop/heuristic gates while the honest display still showed 79.3%. OpenCode does not use this Pi-only estimate compensation.

The 0.85 factor was introduced to compensate for a char-based live estimate that had undercounted a prior long, tool-heavy turn. That safety compensation cannot be called context usage or compared directly with a user threshold: threshold semantics are prompt tokens divided by `usableSoft`, as documented by the message-end pressure path and the output-reserve geometry. The scheduler side was therefore ruled wrong; repainting the display to show the safety-adjusted value would have changed the public meaning of `execute_threshold_percentage`.

## Fix

`packages/pi-plugin/src/pi-pressure.ts:116-156` now resolves and formats one pressure snapshot:

1. choose the larger of the provider-reported persisted prompt numerator and Pi's live forward prompt estimate, preserving mid-turn growth protection;
2. divide that chosen numerator by the real `usableSoft` once;
3. carry the resulting numerator, denominator, and percentage together.

The same snapshot now feeds:

- scheduler decisions (`packages/pi-plugin/src/context-handler.ts:2471-2529`);
- historian evaluation (`packages/pi-plugin/src/context-handler.ts:3853-3861`);
- transform log formatting (`packages/pi-plugin/src/context-handler.ts:2798`);
- `/ctx-status` UI and no-UI paths (`packages/pi-plugin/src/dialogs/status-dialog.ts:441-456`, `packages/pi-plugin/src/commands/ctx-status.ts:124-160`, and `packages/plugin/src/hooks/magic-context/execute-status.ts:118-195`);
- the Pi footer (`packages/pi-plugin/src/status-line.ts:100-126`).

A stale persisted percentage is ignored whenever the real numerator and usable denominator are available, making the old ~34k implied-numerator delta impossible.

The shared trigger formatter now renders an absent projection as `projected post-drop=none`, not `none%` (`packages/plugin/src/hooks/magic-context/compartment-trigger.ts:417-419,642,769`).

## Regression and mutation evidence

`packages/pi-plugin/src/pi-pressure-alignment.test.ts` pins both reporter specimens with a 272k window and 24,576 reserve. It asserts the exact pressure ratio, status-dialog pair, footer percentage, log pair, defer below 90%, execute immediately above 90%, and that 196,210 remains below the 92% force band.

An executed non-vacuity mutation marked `NON-VACUITY BREAK` restored division by `contextLimit × 0.85`. The focused command failed at:

- `packages/pi-plugin/src/pi-pressure-alignment.test.ts:86`: expected 77.6650607863%, received 91.3706597486%;
- `packages/pi-plugin/src/pi-pressure-alignment.test.ts:123`: expected 79.3011187274%, received 93.2954337969%.

The mutation was restored immediately. The same focused file then passed 2/2. No `NON-VACUITY BREAK` remains.

## Operational note: historian quota skips

This is separate from the pressure bug. In the pasted log, every trigger reaches `historian rate-limit skip: quota exhausted`, so no historian run publishes a fold. The exact line comes from `packages/pi-plugin/src/pi-historian-runner.ts:622-642` before the model is called: it is Magic Context's per-session protected-tail drain budget, not a provider API quota. That internal budget resets on a ten-minute window (`packages/plugin/src/features/magic-context/storage-meta-persisted.ts:427,755-829`), with force-band catch-up behavior and failure backoff. Changing models does not clear that specific skip.

Separately, once the internal reservation permits a run, verify that `historian.pi.model` and any `historian.pi.fallback_models` in `~/.config/cortexkit/magic-context.jsonc` point to models/accounts with available provider quota. A provider-quota failure would occur after spawn and produce a different historian failure log; the reported `rate-limit skip: quota exhausted` alone is not evidence that the configured model account is exhausted.

## Reply draft for #385

Thanks for the exact log and screenshot numbers — they exposed the mismatch cleanly. We found the Pi-only mechanism: v0.40.1 divided Pi's live forward token estimate by `0.85 × usableSoft`, but the log printed the unscaled `usableSoft`. That is why `192,162 / 247,424` was shown as 91.4% instead of 77.7%, and why `196,210 / 247,424` became 93.3% and crossed the 92% force band while `/ctx-status` correctly showed 79.3%. Your 24,576-token `output_reserve` was honored correctly and was not being subtracted twice.

The fix removes the 0.85 term from threshold usage and carries one prompt-token/usable-window pair through the scheduler, historian trigger, transform logs, `/ctx-status`, and footer. Pi still uses its live forward token estimate to catch growth during tool-heavy turns, but that numerator is now divided by the same 247,424-token usable window shown to you. We also fixed the cosmetic `projected post-drop=none%` log to print `none`. Exact fixtures cover both reported pairs plus defer-below/execute-above 90%, including an executed mutation that restored the old 0.85 divisor and failed with 91.37%/93.30%.

Operationally, the repeated `historian rate-limit skip: quota exhausted` is separate: that particular message is Magic Context's internal protected-tail drain budget skipping before any historian model call, and its accounting window resets after ten minutes. Also check `historian.pi.model` and `historian.pi.fallback_models` in your user config and make sure those provider accounts have quota for the eventual run; provider quota failures happen later and log differently. Until a historian run is admitted and succeeds, no new fold can publish, so the session can continue accumulating pressure.

This fix is queued for the next patch release after v0.40.1 (v0.40.2).
