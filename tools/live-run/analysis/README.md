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
| Why did the node endings end? | `--question codes` | `source ... [answered: the bundle]`, `examined 33 settled node(s) over 22 programme(s), of which 17 ended in a non-success state`, and `coded terminals` equal to that 17 - a non-success node with no code is a gap in the journal. The largest code is a real native precondition, not a blanket refusal, and its `action(s)` list is short. The `cross-check` line says what the session held; `[silent]` is the normal state of a run since the batches became prose. |
| What did the run plan, and what settled? | `--question nodes` | `settled` equals `planned` (every planned node reached an ending), `succeeded of settled` is high, and the per-action rows show breadth rather than one action repeated. |
| What was she thinking when she said X? | `--question thinking <phrase>` | `matches N of M thinking parts` with M in the low hundreds, and each passage readable as the decision it was. A phrase that matches nothing is a finding about the phrase, and the row says how many parts it searched. |
| Did a programme stall or get left behind? | `--question progress` | `nodes settled` equals `planned nodes`, and `superseded 0 of N programmes (every programme settled every node it planned)`. A non-zero superseded count names the programme that still held nodes when the next one was submitted. |
| Where did one action actually work? | `--question shape <action>` | `node rows 3 of 289 settled nodes naming plant_seed`, `distinct node ids 3 of 3`, and one cluster of tiles inside the groove or field she meant, with a bounding box whose area is close to the tile count (high density). A 16x9 box holding 33 tiles is a strip plus stragglers, and that is visible in `density`. |
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

- `$RUN/result.json`, `manifest.json`, `launch.json`, `programTrace.jsonl`, `timeline.jsonl`, `mod-log.txt`,
  `actionTrace.jsonl`;
- the run's session, searched in the three roots the launcher can have used, printed as one `root` line each:
  1. `$RUN/runtime-root/contexts` - the capture taken at this run's teardown, so read by its newest record;
  2. `$GAMEBUDDY_RUNTIME_ROOT/contexts` - the root the launcher was given (`tools/live-run/game/launch-ladder-live.mjs`
     passes exactly this);
  3. `%LOCALAPPDATA%/GameBuddy/contexts` - the launcher's default when that variable is unset.

A root that holds every run's sessions is never read by "newest": the record this run wrote was created seconds after
its `startedAtMs` (measured 1.3-3.2 s over 47 runs, next-nearest 181 s), so only a record created within 60 s of that
start is this run's. `result.json toolTiming.record` beats the rule wherever a root holds that exact name. A run with no
session in any root prints `not measured` naming every root it tried - the old reader printed `session (absent)` after
asking only the first one.

- `--session <path>` to point at a session that is not under the run (an older run, a hand-stopped launch);
- `tools/action-breadth-baseline.json` and `tools/lib/stardew-published-action-registry.mjs`, which are the published
  action population `action-breadth.mjs` judges against.

## Which file answers which question

The session stopped carrying node ENDINGS: the model-visible batches are prose, so no node JSON reaches a text part and
the session's node rows are the plans a programme was submitted with (`state: pending`). `result.json` is assembled
from the journal at teardown and carries them, so:

| Question | Answers from | The other source |
| --- | --- | --- |
| `nodes`, `progress` | `result.json` `programSubmissions[]` / `programOutcomes[]` | none - no session payload names a programme's outcome |
| `codes` | `result.json` `programOutcomes[].nodeOutcomes[]`, one row per settled node | the session's node rows, printed on the `cross-check` line as `[agrees]`, `[differs ...]` (and then which code only one of them carries) or `[silent]` |
| `shape` | `result.json` `nodeOutcomes[].tile`, the tiles a node SETTLED on | the session's planned tiles, when the bundle published no node for that action |
| `tools`, `turns`, `thinking` | the session - no bundle carries them | none |

Every one of those lines says `[answered: the bundle]` or `[answered: the session]`, and a `cross-check` line never
decides anything: the bundle does, because a status snapshot is taken before the ending it would show.

## A node is one node

The same node appears once per status snapshot, and the same payload can sit in two places inside one record. So every
question taken over node rows prints three counts before any tally:

```
  node rows           754 node rows
  distinct node ids   283 of 754 node rows  (identity programId/nodeId, one row per node)
  without_node_id     470 of 754 node rows  (no nodeId, so no node to count them as)
```

The identity is `programId/nodeId`, not `nodeId`: on the 2026-11-09 `multiday_routine` run, 283 nodes carry only 20
distinct node ids, because `n01` is the first node of each of its 98 programmes. `shape plant_seed` on that run read
`9 node rows, 3 tiles` as a shape of 9; it now reads `3 of 289 settled nodes naming plant_seed`.

A run whose session was never copied beside it can still answer `nodes`, `progress`, `codes` and `shape`: those read the
bundle, and the reader says which root and which file it read rather than refusing them for a file it does not need.

## The gate: a reading without a source is silent

`session-reading.test.mjs` holds one gate, `reading_without_a_source_is_silent`. Its population is the reader's own
`QUESTIONS` list, so a question kind added tomorrow is checked without anybody remembering to add it, and it prints that
population when it runs. Two properties, one per direction:

- on a run that CARRIES the answer (a captured session with a `toolCall`, a turn, a thinking part, and a bundle with a
  coded ending), every kind must print `source`, `method` and `window`, at least one `N of M <unit>` population, and no
  `not measured` at all - `not measured` means "this run does not carry it", and that run does;
- on a run that carries nothing, every kind must print either those four facts and a population, or `not measured ...
  needs <field>`, and never a bare number and never a label with nothing after it.

The gate was proved red on the reader as shipped: checking out the previous `session-reading.mjs` and running this suite
fails 8 of its 12 tests, the gate among them (`codes printed no population for the run that carries its answer`).

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
