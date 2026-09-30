# Real Chat live runs

Traces produced by the real audit harness against a published, self-contained
generation — not fixtures. Kept as evidence and as a comparison baseline.

| File | What it is |
|---|---|
| `run-01-clean.json` + `run-01-audit-report.txt` | First real run. 2 turns, `exit 0`, `Verdict passed`. |
| `run-02-probe-confused.json` + `run-02-audit-report.txt` | Probe-manifest run (7 turns). Scored `distractor.confused`. |
| `run-03-fixed-clean.json` + `run-03-audit-report.txt` | After the cursor/resync fix. 2 turns, `exit 0`, **no finding**. |
| `run-04-probe-complete.json` + `run-04-audit-report.txt` | Probe-manifest run AFTER the cursor fix: **completed for the first time** (81 s, 7 turns, `distractor.confused`, `no finding`). |
| `run-05-probe-durable-gate.json` + `run-05-audit-report.txt` | Probe-manifest run AFTER the durable-commit gate fix: 7 turns, `distractor.confused`, `no finding`. Same generation and manifest digest as run-04. |
| `run-06-probe-reproduced.json` | Probe-manifest run on a **later** generation (2026-09-30), reproducing `distractor.confused` on the same manifest: the verdict is stable across generations, not an artifact of one build. |
| `run-07-probe-cause.json` | Probe-manifest run that records the **cause** of `distractor.confused`. It reports `reason: needle_only` - the companion DID recall the needle and a forbidden word merely co-occurred in the same reply. This settles the question the five earlier runs could not: the verdict is not a memory failure. |
| `memory-loop-01.json` | The first run of the **memory loop** (`tools/run-memory-live-loop.mjs`, the third live-run loop). It seeds a fact through the real management surface, confirms durability from that route's OWN readback (`durable: true`, `projectionChanged: true`), then asks for it in a real chat turn under the SAME continuity. Funnel: `L1_write passed`, `L2_assembly observability_gap`, `L4_expression observability_gap` - and **zero findings**, because with L2 unobserved a miss cannot honestly be blamed on the model. That run is also what exposed the funnel's own layer-skipping mis-attribution bug. |
| `run-01-vs-03-comparison.json` | `compare-chat-live-runs` output: 2 improvements, 0 regressions. |
| `run-04-vs-05-comparison.json` | The first apples-to-apples probe pair (same 7-turn topology, generation and manifest digest): 0 improvements, **0 regressions**, 17 neutral. |

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

## The probe committed-presentation gate

An independent audit review found that the probe's "was there a reply for THIS
 turn" gate used the Class B stderr marker count, which also counts admission
**rejections** and is not the durable fact. A turn whose presentation was
rejected or never committed could therefore read older transcript text and score
a distractor/needle verdict against it.

The gate now uses the durable `committedCompanionDelta` from the same `/state`
read that produces `presentation.committed`; a turn without a positive delta is
an `observability_gap`, never a keyword score. `run-05` was run with that gate in
place (that claim is supported by the harness commit history and the run log —
see below, the trace itself cannot prove which gate version ran);
`run-04-vs-05-comparison.json` shows the two probe runs are comparable (same
generation, same manifest digest, same 7-turn topology) and drift-free (17
neutral rows).

> **Evidence-pending caveat (auditing-runs review):** the trace schema has no
> harness-version field, and in run-05 all 7 turns carry BOTH a stderr marker
> and a durable commit — so the old marker gate and the new durable gate would
> have produced the identical verdict on this data. run-05 is *consistent with*
> the new gate; it is not *discriminating* evidence for it. What discriminates
> is the routing test (`probeVerdict` short-circuits a failed gate before any
> keyword read) and the negative gate test, both in committed harness tests.

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
- **The current pointer is restored to its baseline generation after each run.**
  The baseline generation predates the publisher closure fix and carries no
  `node_modules`, so a real run temporarily points at the self-contained
  generation; the pointer is restored afterwards.
- **Memory evidence is absent from every run so far, and the report now says so
  plainly.** The frozen vocabulary has no `memory.observability_gap` row, so an
  unavailable Memory projection is not distinguishable from an idle one in a
  trace; the report line no longer renders that as three measured zeros.
- **The comparator does NOT gate on generation.** Its comparability gate covers
  `provider.embedded` and probe `manifestDigest` only; `run-04-vs-05` is
  comparable because the two runs coincidentally share a generation, not because
  the tool guarantees it. A cross-generation pair is now *made visible* (an
  `artifact.generation` / `artifact.inventoryDigest` neutral row appears) but
  still allowed — the tool's purpose is comparing across a system change.
