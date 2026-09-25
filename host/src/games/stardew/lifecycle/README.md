# Lifecycle

## Owns
Stardew bootstrap guardian records, lifecycle owner, private composer, and Stardew-specific process-owner implementations/results.

## Does not know
Fixed desktop entry and bootstrap wire ownership.

## Dependency direction
Lifecycle consumes the narrow generic containment contract and is consumed by composition. It must not import `containment/runtime/core`, the auth transport, raw generic Windows platform implementations, or the Windows folder picker — composition admits those and injects them as opaque capabilities. `bootstrap` and `containment` must never import Stardew.

## Placement and move rule
Keep Stardew-specific process-owner implementations/results here. The staged move of `stardew-process-implementations.ts` from `containment/windows` is intentional relocation, not deletion; generic Windows primitives remain under containment. Platform-frame encoding is not placed here: the module that turns typed game facts into native Guardian bytes lives at `composition/stardew/stardew-guardian-platform.ts`, because ADR-0007 Shape B keeps `Uint8Array` and every other platform-frame representation out of the game layer.

## Required verification
Guardian and composer direct tests plus Host typecheck must pass with no old-path references.
