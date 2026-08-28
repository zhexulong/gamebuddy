# Stardew Action Development Runbook

## Read-only `equip_tool` target preflight

Supply a local, absolute profile path based on `profiles/example.json` (the committed example is intentionally placeholder-only and cannot become READY):

```bash
pnpm --dir integrations/stardew/action-development action:preflight --action equip_tool --profile <absolute-profile-json>
```

The profile contains no token, credential, pipe name, or endpoint. `nativeClientConfigFile` is only the fixed locator for the existing harness-owned ephemeral client configuration. `releaseDir` is the operator-supplied absolute source directory for the exact four-file GameBuddy Mod bundle; it must be physically separate from `modsPath/GameBuddy`. Preflight validates every bundle file as a regular non-link, validates the GameBuddy manifest identity and adapter version, and derives a SHA-256 bundle binding from the real bytes. It also validates trusted target/fixture/lease paths, exact versions, an idle fixture transaction, and an unheld runtime lease before connecting for exactly one fresh observation. It does not acquire the lease, prepare or restore a fixture, launch Stardew, begin evidence, submit an action, or write runtime state.


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

`inventory` validates the migration map; it is not an executable registry. `action:check:equip-tool` is a deterministic generated-contract check, and `action:ci` runs only package-owned deterministic checks. `action:extraction-audit` validates the standalone package closure, while `action:extraction-rehearsal` performs the fresh-root frozen-install rehearsal. `action:root-ci-disposition-audit` verifies the package-owned root CI cutover. `preflight` is the read-only target admission described above. `run-live` composes the admitted `equip_tool` gate in strict order: READY preflight, exact release-bundle revalidation, target lease, staged evidence, fixture preparation, package-owned scenario child, exact private result validation, fixture restoration, lease release, and only then passing evidence finalization. It does not retry uncertain mutations. `status` reads only the Devkit evidence manifest and never observes the game.

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
