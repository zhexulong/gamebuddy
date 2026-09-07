# Lifecycle

## Owns
Stardew bootstrap guardian records, lifecycle owner, private composer, and Stardew-specific process-owner implementations/results.

## Does not know
Fixed desktop entry and bootstrap wire ownership.

## Dependency direction
Lifecycle consumes narrow generic auth/session and containment contracts and is consumed by composition. It must not import raw generic Windows platform implementations; generic layers must not import Stardew.

## Placement and move rule
Keep Stardew-specific process-owner implementations/results here. The staged move of `stardew-process-implementations.ts` from `containment/windows` is intentional relocation, not deletion; generic Windows primitives remain under containment.

## Required verification
Guardian and composer direct tests plus Host typecheck must pass with no old-path references.
