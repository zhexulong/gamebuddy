# `tools/`

Operational scripts, live-run drivers, benchmarks, fixtures, and shared gate/runner libraries.

## Layout

- `lib/` — Shared libraries imported by gates, runners, and audits.
- `live-run/` — Multi-day and surface live-run orchestration, verdict evaluation, and analysis.
- `scripts/` — Build, CI, and workspace maintenance scripts.
- `perf/` — Performance benchmarks and profiling harnesses.
- `conformance/`, `assertions/`, `ast-grep/`, `baselines/`, `fixtures/` — Shared test/conformance inputs and baselines.
- `prelive.mjs`, `live-action.mjs`, `live-program.mjs` — Primary pre-live and single-slice entrypoints.

> Note: Domain gates (`check-*.mjs`, `audit-*.mjs`) belong in [`gates/`](../gates/README.md) rather than `tools/`.
