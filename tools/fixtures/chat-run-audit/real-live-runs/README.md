# Real Chat live runs

Traces produced by the real audit harness against a published, self-contained
generation — not fixtures. Kept as evidence and as a comparison baseline.

| File | What it is |
|---|---|
| `run-01-clean.json` + `run-01-audit-report.txt` | First real run. 2 turns, `exit 0`, `Verdict passed`. |
| `run-02-probe-confused.json` + `run-02-audit-report.txt` | Probe-manifest run (7 turns). Scored `distractor.confused`. |
| `run-03-fixed-clean.json` + `run-03-audit-report.txt` | After the cursor/resync fix. 2 turns, `exit 0`, **no finding**. |
| `run-04-probe-complete.json` + `run-04-audit-report.txt` | Probe-manifest run AFTER the cursor fix: **completed for the first time** (81 s, 7 turns, `distractor.confused`, `no finding`). |
| `run-01-vs-03-comparison.json` | `compare-chat-live-runs` output: 2 improvements, 0 regressions. |

## What run-01 and run-02 reported, and what it actually was

Both reports attributed `stream_gap_churn` and a ~180 s `idle_stall` to
`host/src/tavern/chat-event-stream.ts`. An independent audit review falsified
that attribution, and the source confirms the review:

- the harness reconnected every turn **without a cursor**, so the host — which
  serves a bounded 64-event replay window and does accept `cursor` /
  `Last-Event-ID` — correctly answered `gap` once the window rolled;
- the host closes a resync response, but `awaitTerminal` had no branch for that
  and always waited the full 180 s `TURN_TIMEOUT_MS`.

So the observer manufactured the gap and then reported its own wait as a product
stall. After carrying the cursor and settling on resync:

```
stream.resync   1 -> 0
turn[1]       180095 ms -> 128 ms      (the "stall")
verdict       idle_stall + stream_gap_churn -> no finding
```

`run-01-vs-03-comparison.json` records this as 2 improvements, 0 regressions.

## Honest boundaries

- **No process exit code is in a trace.** `run.finished.status=collected` is what
  the trace proves; the `exit 0` above is from the harness process result.
- **A probe verdict is not recomputable from a trace.** The reply text and the
  matched keyword counts are deliberately excluded, so `distractor.confused` is
  verifiable only by construction (the harness guards it in tests).
- **`reload.settled: consistent`** means the harness predicate passed (handle,
  terminal state, transcript/committed counts, selection generation) — not a
  byte-for-byte comparison of all durable content.
- **These runs use `provider.embedded`** and the generation published by the
  sanctioned test publisher; the production release path obtains its runtime from
  protected CI.
