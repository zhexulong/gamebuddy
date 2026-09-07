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
pnpm --dir integrations/stardew/action-development action:check
pnpm --dir integrations/stardew/action-development action:ci
pnpm --dir integrations/stardew/action-development action:extraction-rehearsal
pnpm --dir integrations/stardew/action-development action:publish-release-bundle -- --source <absolute-source-dir> --destination <absolute-destination-dir>
```

`test` runs the package's deterministic test suite. `action:inventory` validates
the migration map; it is not an executable registry. `action:check`
is the deterministic generated-contract check. `action:ci` runs the package's
owned deterministic portfolio. `action:extraction-rehearsal` performs the
fresh-root frozen-install rehearsal. The release-bundle command publishes only
the exact bundle requested by its explicit source and destination arguments;
it does not publish an action capability.

## Current control-live status

`equip_tool` remains published, but its Action Development Platform control route is
currently **BLOCKED** with `host_runner_not_registered`. Do not supply a target
profile, invoke `action:preflight`, or invoke `action:run-live` as a way to launch
or mutate a target.

The former `gamebuddy-action-target-profile/v1` route is native-local candidate
wiring. It is not a product installation authority and cannot create, seed, or
bypass the Host-private installation registration. The replacement control route
will be profile-free: bounded control intent enters the same private lifecycle core
as the browser flow, which consumes a previously ready registration and performs
request-local admission. No replacement command exists until the coordinator-owned
runner, fixture boundary, registration/containment prerequisites, and route cutover
are implemented and accepted.

`action:check`, `action:inventory`, `action:ci`, and extraction rehearsal remain
deterministic/offline package commands. They do not prove a target is ready or
authorize a live action.

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

## Future `equip_tool` control gate

After the approved Host-owned control route is implemented, the authoritative
runbook will name its profile-free command and the factual preflight it requires.
Until then, do not invent a substitute command, revive the old native-local route,
or treat a profile-based preflight as readiness.

The future gate remains subject to: a ready registration; guardian/bootstrap
containment and settlement facts; coordinator-owned fixture preparation and restore;
a fresh target admission; aggregate independent review; and explicit authorization.
It will still accept only one serial action with the same logical action's succeeded
receipt, non-empty evidence, fresh action-specific postcondition, accepted cleanup,
and no uncertain retry.

If a command is not listed in this runbook or in the package's `scripts` map, stop
and resolve the source-of-truth discrepancy; do not invent a replacement command or
infer live/publication authorization.
