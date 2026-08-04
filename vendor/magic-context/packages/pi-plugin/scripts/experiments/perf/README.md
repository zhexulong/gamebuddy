# Pi context-transform performance harness

This directory drives the same `registerPiContextHandler()` callback that Pi registers in production. It reconstructs Pi's `ContextEvent.messages` with `buildSessionContext()`, supplies the matching branch entries by reference, and uses a temporary on-disk `context.db` under `MAGIC_CONTEXT_TEST_DATA_DIR`. It never opens the production Magic Context database.

## Benchmark

```bash
cd packages/pi-plugin
bun scripts/experiments/perf/benchmark.ts --synthetic --messages 4000 --step 500
bun scripts/experiments/perf/benchmark.ts --fixture ~/.pi/agent/sessions/<project>/<session>.jsonl --step 500
```

Without `--fixture` or `--synthetic`, `benchmark.ts` selects the largest JSONL file under `MC_PI_PERF_FIXTURES`. The default directory is `~/.pi/agent/sessions`. Pass `--all` to benchmark every JSONL fixture. Private session data is only read at runtime and is never copied into the repository.

Use `--points 500,1000,2000,4000,5725` for fixed checkpoints. Add `--repeat-final 1` to measure a steady-state pass over a fresh clone of the final message projection after all caches are warm. The synthetic generator includes text, thinking, images, tool-call/result arcs, and call IDs deliberately reused across turns.

The phase table reports transform phases plus DB I/O. DB time is cross-cutting and therefore overlaps the phase that issued each query. Per-part timing is activated only while the harness observer is installed; production does not pay those timers.

Use `--lane` to exercise hot paths that the default cache-stable pass does not reach:

```bash
bun scripts/experiments/perf/benchmark.ts --synthetic --points 1000,3000,5725 --lane historian-low
bun scripts/experiments/perf/benchmark.ts --synthetic --points 1000,3000,5725 --lane historian-high
bun scripts/experiments/perf/benchmark.ts --synthetic --points 1000,3000,5725 --lane execute-compacted
bun scripts/experiments/perf/benchmark.ts --synthetic --points 1000,3000,5725 --lane auto-search-sticky
```

Each pass measures output serialization and then waits 150 ms before sampling deferred DB work. Historian lanes use a fail-soft local runner so trigger and scheduling costs are measured without making a model request. The execute lane marks all but the newest tag window compacted between accumulation passes; the auto-search lane persists a no-hint decision on the first pass and measures sticky replay afterward.

## Byte-identity comparison

Commit the harness before the optimization so the baseline revision contains `run.ts`, then run:

```bash
bun scripts/experiments/perf/compare.ts --fixture <path>
```

Passing a directory to `--fixture` recursively compares every JSONL fixture and fails on the first mismatch. The default baseline is the first commit containing this harness; override it with `--baseline <git-ref>`. `compare.ts` archives that revision into a temporary directory, runs both real handlers against independently initialized copies of the same empty DB seed, and compares canonical-JSON SHA-256 hashes for every output message array and every persisted behavioral tag row on every accumulation pass. Timing/creation columns are excluded from the tag-row comparison. Any mismatch exits non-zero.
