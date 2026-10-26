# Iteration loop: make `multiday_routine` pass

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
