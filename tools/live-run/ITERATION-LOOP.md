# Iteration loop: make `multiday_routine` pass

> **Read this first if you are about to fix something a run printed.** A long run measures; it does not discover the
> same defect twice. Every named failure code becomes a 40-second slice (`node tools/live-action.mjs --action <id>`,
> or `node tools/live-program.mjs` for a plan form) before it becomes a fix — and every fix lands with the **gate that
> catches its whole class**, because the fix buys one instance and the class stays alive without one.
> The loop below (and the skill `.agents/skills/stardew-live-loop/SKILL.md`) is the run-level view of that rule.

**Purpose.** Replace "run once, report, ask" with a bounded loop that keeps going until the scenario passes or the
recorded blocker is a decision rather than a defect.

## The loop, in order. No step may be skipped.

```
1  BUILD      dotnet build integrations/stardew -c Release          → must be 0 errors
2  DEPLOY     node .tmp/deploy-mod.cjs                              → 3 files
3  PREPARE    move the fixture save aside; stop stray game processes
4  RUN        launch-ladder-live.mjs --label <n>
5  VERDICT    read result.json + the SMAPI log, and write the three answers below
6  DECIDE     if pass → done.  if a NAMED defect → fix it, go to 1.
                        if the defect is a CONTRACT decision → stop and say so.
```

## The three answers every iteration must produce, before touching code

```
what the companion tried     tool calls + program submission ids from its session record
where it stopped             the exact node state and reason code, quoted
what it cost                 wall clock, submissions, in-game time reached
```

A guess is not an answer. If an artifact does not say, the next step is a probe, not a change.

## Probes are allowed and preferred over reasoning

Tonight's expensive mistakes were all "I reasoned about the predicate instead of running it". A probe that prints the
predicate's inputs costs one run and settles the question; reading four files and inferring costs four turns and was
wrong three times.

## When to stop

- The scenario passes.
- The blocker is a **contract** — a missing frame type, a missing outcome, a decision only the owner can make. Say
  which decision and what the two options cost.
- A run fails for a reason **outside the product**: provider, credentials, sandbox. Retry once, then record it and stop.

Anything else is a defect, and the loop continues.

## What counts as passing

`crossings >= 2` with `dayRecords[i].cause` naming `sleep` or `pass_out`, and `terminal` reached through the engine -
not a harness verdict, not a timeout. The run's own `result.json` must say so.

## Clear the debris a killed run leaves

A killed run does not just cost a run. It leaves four things that make the NEXT run fail for reasons unrelated to any
code change, and each of them reports as something else:

- **a fixture lock** - a *directory*, not a file, beside the fixture root. The next `prepare` refuses, the launcher says
  `no_launch`, and that reads like a launch failure.
- **`*.orphaned-*` backups** - the next `restore` finds more than one candidate and refuses.
- **the recovery journal**, which is cumulative per scope. Admission records are never evicted; when it passes its budget
  every later write throws `recovery_journal_budget_exceeded`, which surfaces as an admission that waits for ever. Clear it
  when admission starts failing with no visible cause - 811 records had accumulated this way.
- **a `host/dist-test` older than `host/src`**, which the runner refuses with `live_run_artifact_stale`. Correct, but it
  reads like a harness bug until you have seen it once.

So step 3 of the loop is not "stop stray processes", it is **make the fixture and the journal clean**, and step 1 is not
"build the Mod" but **build both what the game loads and what the runner imports**.

## A diagnostic is not an answer until it has run

The three answers above have to come from executing something, not from reading the code and reasoning about it. The most
expensive mistake of 2026-10-26 was three diagnostics in a row that paraphrased the logic instead of calling it; all three
were confidently wrong, and one sent thirty rounds of work to a layer where the defect was not.

Cheapest form that works, and it needs no game:

    node .tmp/probe.mjs   # import the deployed module, feed it the real inputs, print the result

And every gate added to keep a defect out gets a falsifier before it is trusted: reintroduce the defect, watch it go red,
revert. An unobserved failure is decoration, not a check.

## The accounting discipline

Most of the mistakes in this loop have not been wrong logic. They have been **numbers about the wrong thing**, stated
confidently. Four in one day: a count of log lines reported as a count of nights; `input` reported as context; a token estimate
compared across two different trees; a `Where-Object -match` over strings reported as a measurement.

So before quoting a number, answer three questions in the same sentence:

1. **Which file did it come from?** A counter must read one file. Mixing a harness field with a session field is how two
true numbers become one false claim.
2. **What exactly does it count?** `day_advanced` appearing twice in a log is one night recorded by two components, not two
nights. State the unit, not the event name.
3. **Is it a peak, a sum, or a sample?** `inputMax` is the `Math.max` of `input + cacheRead` across turns; `totalTokens` in
`result.json` is the second-to-last assistant message. They differ by two orders of magnitude and both are honest.

`node tools/perf/report-run-cost.mjs` exists because of this: it prints the source file beside every number, so a reader can
disagree with a claim without re-deriving it.

## PASS, FAIL, and NOT EXERCISED are three answers

"Not falsified" is not "confirmed". A run that never triggered a path cannot support a verdict about it, and a gate that
reports green because the thing it watched was absent is a gate that has stopped working.

Write the verdict down **before** the run, with the condition for each outcome. Include the row that says what would make
this run unable to answer at all - a provider failure, a bridge that closed before the interesting part, a fixture that never
produced the target. `round14` and `round15` both died in the first minutes; reading either as evidence about the product
would have been reading a broken instrument.

When a run cannot answer, say so in those words. A `NOT EXERCISED` that is honestly labelled is worth more than a `PASS`
that was never at risk of failing.

## Measure the run, not its description of itself

Every number below was wrong at least once today, and each time in the same way: the tool read a *description* of the
thing instead of the thing.

- **Plan size comes from `result.json`'s `programSubmissions[].nodes`**, never from counting `builder.` in the script
  text. A `for` loop over twelve targets is ONE `builder.` occurrence and twelve nodes. Measured 2026-11-03: script-text
  counting said `round30` averaged 1.59 nodes and was "mostly single-step"; the submissions say **88 programs / 212 nodes
  / mean 2.41**, with real 16- and 27-node programs.
- **Coverage comes from canonical action ids.** `0ed75c19` renamed `break_rock_source` → `break_rock` and friends, so a
  tool that reads history literally reported 177 real successes as "never succeeded". `check-action-coverage.mjs` now
  carries `RENAMED_ACTION_IDS` and validates it in both directions.
- **Context size is `input + cacheRead`, not `input`.** `input` alone is the uncached remainder; a run with 74% cache
  hits looks tiny and is not. Read the `usage` object of the assistant entries.
- **A summary field's name is not its meaning.** `tokensBefore` on a compaction record is that compartment's token
  estimate, not "how much the fold removed".

When a number is going to decide a design, print where it came from (`file`, JSON path) next to it. That one habit
caught a wrong-session analysis, a wrong-plan-size analysis, and a renamed-action false negative in a single day.

## Replay a real defect, not an imagined one

Injecting the defect you had in mind proves you can turn your own gate red. The stronger test, and the one to prefer: check
out the commit **before** a defect that actually shipped and confirm the gate fires there. `round17`'s
`observation_binding_malformed` is a worked example - replay `eb617d05^` and the compiler gate goes red on the real tree that
produced it.

When no real defect exists to replay, say so rather than substituting a synthetic one. A gate whose only falsifier is a
synthetic edit has demonstrated nothing about the defect class it claims to cover.

