# `gates/`

Repository-wide invariant gates (`check-*.mjs` / `audit-*.mjs`), organized by the closed domain taxonomy in [`directories.mjs`](./directories.mjs) and registered by [`registry.mjs`](./registry.mjs).

## Structure

- [`meta/`](./meta/) — Gate-system self-checks (registry, falsifiers, spec reachability, harness conformance, diff hygiene).
- [`product/`](./product/) — Product-surface, UI, and companion-experience gates (`domain: "product"`).
- [`data/`](./data/) — Data-integrity, artifact reproducibility, baseline, and measurement-shape gates (`domain: "data"`).
- [`arch/`](./arch/) — Architecture boundary, dependency, complexity, and cross-language wire parity gates (`domain: "arch"`).
- [`stardew/`](./stardew/) — Stardew integration, action catalog, fixture, and live-runner contract gates (`domain: "stardew"`).

## Rules

- Every gate file must export `gateDeclaration = { id, domain, tier, kind }` matching [`registry.mjs`](./registry.mjs).
- Sibling falsifiers (`*.test.mjs`, `*.test.ts`, `*.mutation.mjs`) live beside their gate in the same domain directory.
- Shared helpers and non-gate utilities remain in [`tools/lib/`](../tools/lib/).
