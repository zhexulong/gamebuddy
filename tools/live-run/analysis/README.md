# Reading a run

Five commands, one question each. They read a finished run's artifacts and nothing else: no game, no build, no model,
no network. Before this folder existed these questions were answered by a dozen `.tmp/*.mjs` scripts that each answered
a slightly different one, so two of them could disagree about the same run and neither number could be checked.

**The rule this folder exists for.** A number about a run is only a measurement beside its population: `26 of 281
toolCall parts`, not `26`. Every command here prints the value with the population it came out of, the file and field it
came from, and the window it covers - and prints `not measured` with the name of the missing field rather than a `0`,
because "we never looked" and "we looked and found none" are different findings and only one of them is about the run.

## One row per question

Where `$RUN` is a run directory such as `.live-runs/game-ladder/2026-11-09T18-26-53-581Z-multiday_routine`.

| Question | Command | What a healthy reading looks like |
| --- | --- | --- |
| Which tools did she actually call, by name? | `node tools/live-run/analysis/session-reading.mjs --run $RUN --question tools` | The population is the `toolCall` parts, so the row total equals the parts the run dispatched. One or two tools hold most calls; if a name you expect is missing, it is missing from the parts, not from the log. A name that appears 97 times in text and 26 times as a part is 26. |
| How did the turns spend their wall clock? | `--question turns` | A turn gap p50 in single-digit seconds, `model time` a large share of the wall clock, `tool time` bounded, and `silence >= 60s` at 0 or each occurrence explained by a status call waiting on the game. `turns 289 of 593 message records` is normal: most records are results, not turns. |
| Why did the node endings end? | `--question codes` | `examined 732 node rows, of which N carry a terminal state`, and `coded terminals` close to N - a terminal row with no code is a gap in the journal. The largest code is a real native precondition, not a blanket refusal, and its `action(s)` list is short. |
| What did the run plan, and what settled? | `--question nodes` | `settled` equals `planned` (every planned node reached an ending), `succeeded of settled` is high, and the per-action rows show breadth rather than one action repeated. |
| What was she thinking when she said X? | `--question thinking <phrase>` | `matches N of M thinking parts` with M in the low hundreds, and each passage readable as the decision it was. A phrase that matches nothing is a finding about the phrase, and the row says how many parts it searched. |
| Did a programme stall or get left behind? | `--question progress` | `nodes settled` equals `planned nodes`, and `superseded 0 of N programmes (every programme settled every node it planned)`. A non-zero superseded count names the programme that still held nodes when the next one was submitted. |
| Where did one action actually work? | `--question shape <action>` | One cluster of tiles inside the groove or field she meant, with a bounding box whose area is close to the tile count (high density). A 16x9 box holding 33 tiles is a strip plus stragglers, and that is visible in `density`. |
| The multiday acceptance, in one pass | `node tools/live-run/analysis/round3-verdict.mjs [runsRoot]` | `ports_not_live` 0 while `invalidated receipts` > 0 (the latch was exercised and held), `waiting lines/program` <= 3 (bounded by programmes, not frames), `context HELD` (`inputMax` < 40000 and no `stopReason length`), `crossings` >= 2. A criterion the run never exercised prints `NOT EXERCISED`, which is not a pass. The argument is the RUNS ROOT (default `.live-runs/game-ladder`); it reads the newest `*multiday_routine*` directory under it, so name the root, not one run. |
| How does the run feel to a player? | `node tools/live-run/analysis/airp-scorecard.mjs $RUN` | Every metric either carries a number from an artifact or `not_measured:<reason>`; nothing is estimated. Healthy: `first visible text` in seconds rather than the 709 s that motivated this file, `plans preceded by a stated intent` a large share of plans, `attempted of addressable` high against the run's own census. Autonomy is not a defect here - legibility and redirectability are what it measures. |
| Did she use the surface she was given? | `node tools/live-run/analysis/action-breadth.mjs --result $RUN/result.json` | Exit 0 and verdict `rich`. `narrow:<reason>` means the run repeated a few safe actions, and `not_measured:<input>` means the bundle could not answer - exit 2, never a pass. The denominator is the run's own `snapshotCensus`, not the 95-action catalog, because a fixture arms one world. |
| The numbers a player would feel | `node tools/live-run/analysis/long-session-metrics.mjs --result $RUN/result.json [--session <path>]` | Each of the seven lines carries a number and its provenance, or `NOT_EXERCISED` with the reason. Healthy: `steers per day` low (she worked without being steered), executions timed and settled, no `uncertain`/`recovery_required`, and every `NOT_EXERCISED` naming an artifact the harness does not produce rather than a metric nobody looked at. |
| The run's verdict rows, and what its seconds cost | see **pending move** below | - |

## What is not in this folder, and why

`tools/check-*.mjs` and `tools/audit-stardew-*.mjs` are **gates**: they run before a live run, in `tools/prelive.mjs` or
in CI, and their population is a directory scan or a declaration. They stay where the scans find them. Nothing here is
a gate - every command in this folder is a per-run reader whose input is one finished run, so none of them runs in a
ladder.

## Where the inputs come from

- `$RUN/result.json`, `manifest.json`, `programTrace.jsonl`, `timeline.jsonl`, `mod-log.txt`, `actionTrace.jsonl`;
- `$RUN/runtime-root/contexts/**/surface-sessions/**/sessions/*.jsonl` - the run's own session, resolved from the
  bundle's `toolTiming.record` when that field is there and from the newest one under the runtime root when it is not;
- `--session <path>` to point at a session that is not under the run (an older run, a hand-stopped launch);
- `tools/action-breadth-baseline.json` and `tools/lib/stardew-published-action-registry.mjs`, which are the published
  action population `action-breadth.mjs` judges against.

A run whose session was never copied beside it can still answer `nodes` and `progress`: those are questions about the
bundle, and the reader says so rather than refusing them for a file it does not need.

## pending move

`tools/live-run/round-verdict.mjs` and its suite `tools/live-run/round-verdict.test.mjs` stay where they are for now:
moving them would carry their uncommitted work into this commit. They move in when the reading seam below lands its
follow-up, and the three `host/src` comment references that name the old path move with them in that same commit.

## The seam, and the follow-up nobody may skip

`tools/lib/reading.mjs` is the shared seam for the four facts (`reading`, `census`, `format`, `formatCensus`,
`crossCheck`). `session-reading.mjs` prints the same four facts by hand and does not import it, so that moving four
readers into one folder and changing how their numbers are built stay two reviewable units:

> **Follow-up, and it is required:** `session-reading.mjs` must switch to `tools/lib/reading.mjs` (`reading`,
> `format`) as a two-line change. `tools/audit-run-reading-shape.mjs` populations every `.mjs` under `tools/live-run/` -
> this folder included - so the switch has to happen before that gate is wired into `tools/prelive.mjs`'s L0 rung.
> Until then the gate reads this file as clean, because it counts `.split(...).length` censuses and this file has none;
> the routing is what makes the four facts structural instead of a convention.
