# Stardew Action Development Runbook

This directory is the Stardew-owned action-development boundary. It depends on the game-agnostic devkit but owns Stardew action scenarios, profiles, fixtures, target-runtime gates, and publication evidence.

## Current commands

```bash
pnpm test
pnpm action:inventory
pnpm action:check:equip-tool
pnpm action:ci
pnpm action:extraction-audit
pnpm action:root-ci-disposition-audit
```

`inventory` validates the migration map; it is not an executable registry. `action:check:equip-tool` is a deterministic generated-contract check, and `action:ci` runs only that check plus package-local deterministic tests. `action:extraction-audit` reports current standalone blockers without copying root files or using a fallback. `action:root-ci-disposition-audit` lists the root CI/portfolio edges that must remain until package-owned parity exists; it does not authorize a CI cutover. `preflight`, `run-live`, and `status` remain fail-closed: no package command starts Stardew, uses a fixture, connects a pipe, or performs a mutation.

## Development flow

1. Use `game-action-boundary` to freeze a Stardew action card from game-owned sources.
2. Use `game-action-implement` for one connected implementation path.
3. Use `game-action-close` for deterministic closure, non-mutating preflight, and the serial live gate if authorized.
4. Use `game-action-publish` only for the Mod-owned catalog/policy change and restrictive projections.

A development-only descriptor or frozen brief validates local tooling mechanics only. It grants no Stardew runtime, fixture, bridge, catalog, policy, publication, or live-mutation authority.

## Project boundary

- Keep new Stardew action-development tooling in this package.
- Treat `tool-inventory.json` as the migration map for existing root tooling; it is not an executable registry.
- Preserve game-specific selector, native admission, receipt, fresh postcondition, cleanup, and uncertain-side-effect semantics in Stardew-owned code.
- Devkit evidence status (`complete`/`incomplete`) is distinct from game verdict (`passed`/`blocked`/`failed`/`uncertain`).

## Live gates

Ordinary local/package tests never launch Stardew or mutate game state. Any live action requires its action-specific non-mutating preflight, aggregate independent review, exclusive target-runtime lease, transaction-owned fixture/profile cleanup, fresh postcondition, and durable complete evidence. A failed harness is repaired offline before another mutation is attempted.
