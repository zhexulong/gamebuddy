# Stardew Action Development Runbook

This file is the authoritative Stardew-specific runbook for the generic
`game-action-*` skills. It owns target-version, SMAPI, profile, fixture/save,
bridge, scenario, package-CI, publication, and future extraction instructions.
The generic skills own the cross-game boundary, implementation, closure, and
publication handoffs; this runbook supplies Stardew's concrete commands and
authority facts.

## Package commands

Run package commands from the repository root with the package directory
explicitly selected:

```bash
pnpm --dir integrations/stardew/action-development test
pnpm --dir integrations/stardew/action-development action:inventory
pnpm --dir integrations/stardew/action-development action:check:equip-tool
pnpm --dir integrations/stardew/action-development action:ci
pnpm --dir integrations/stardew/action-development action:extraction-rehearsal
pnpm --dir integrations/stardew/action-development action:publish-release-bundle -- --source <absolute-source-dir> --destination <absolute-destination-dir>
```

`test` runs the package's deterministic test suite. `action:inventory` validates
the migration map; it is not an executable registry. `action:check:equip-tool`
is the deterministic generated-contract check. `action:ci` runs the package's
owned deterministic portfolio. `action:extraction-rehearsal` performs the
fresh-root frozen-install rehearsal. The release-bundle command publishes only
the exact bundle requested by its explicit source and destination arguments;
it does not publish an action capability.

## Read-only target preflight

Supply a local, absolute profile path based on `profiles/example.json`. The
committed example is intentionally placeholder-only and cannot become READY:

```bash
pnpm --dir integrations/stardew/action-development action:preflight --action equip_tool --profile <absolute-profile-json>
```

The profile contains no token, credential, pipe name, or endpoint.
`nativeClientConfigFile` is only the fixed locator for the existing
harness-owned ephemeral client configuration. `releaseDir` is the
operator-supplied absolute source directory for the exact GameBuddy Mod bundle;
it must be physically separate from `modsPath/GameBuddy`. Preflight validates
every bundle file as a regular non-link, the GameBuddy manifest identity and
adapter version, and a SHA-256 bundle binding from the real bytes. It also
validates trusted target/fixture/lease paths, exact versions, an idle fixture
transaction, and an unheld runtime lease before connecting for exactly one fresh
observation. It does not acquire the lease, prepare or restore a fixture, launch
Stardew, begin evidence, submit an action, or write runtime state.

## Development flow

1. Use `game-action-boundary` to freeze one Stardew action card from game-owned
   sources, including claim scope and the direct native seam.
2. Use `game-action-implement` for one connected implementation path and the
   package's deterministic check.
3. Use `game-action-close` for deterministic closure, one aggregate independent
   review, the non-mutating preflight above, and the serial live gate only when
   explicitly authorized.
4. Use `game-action-publish` only after closure to make the Mod-owned catalog or
   policy change and then verify restrictive projections.

A development-only descriptor or frozen brief validates local tooling mechanics
only. It grants no Stardew runtime, fixture, bridge, catalog, policy,
publication, or live-mutation authority.

## Stardew ownership and evidence

This directory is the Stardew-owned action-development boundary. It depends on
the game-agnostic devkit but owns Stardew action scenarios, profiles, fixtures,
target-runtime gates, and publication evidence. Preserve game-specific selector,
native admission, receipt, fresh postcondition, cleanup, and uncertain-side-effect
semantics in Stardew-owned code.

For a live action, the complete connected path is request → game-thread
admission → native commit → terminal receipt → fresh postcondition → teardown and
evidence. The Mod owns gameplay authorization and native execution. Host/devkit
registries, schemas, descriptors, reports, and documentation are restrictive
projections and cannot grant capability. Evidence status (`complete` or
`incomplete`) is distinct from game verdict (`passed`, `blocked`, `failed`, or
`uncertain`). A static check, fixture setup, successful launch, or source audit
never substitutes for target-runtime evidence.

## Live `equip_tool` gate

The package adapter exposes the devkit `run-live` project operation, but this
operation is intentionally not a package `scripts` entry. Resolve the exact
private devkit invocation from the package manifest and adapter before use; do
not invent a package script or pass unsupported options.

Before using it, complete the action-specific non-mutating preflight and one
aggregate independent review, then obtain explicit authorization from the
Stardew project owner. The gate runs in strict order: READY preflight, exact
release-bundle revalidation, exclusive target-runtime lease, staged evidence,
fixture preparation, package-owned scenario child, exact private result
validation, fixture restoration, lease release, and only then complete evidence
finalization. It does not retry uncertain mutations. A failed harness is
repaired offline before another mutation is attempted.

If a command is not listed in this runbook or in the package's `scripts` map,
stop and resolve the source-of-truth discrepancy; do not invent a replacement
command or infer live/publication authorization.
