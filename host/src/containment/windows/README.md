# Windows containment

## Owns
Game-neutral private Windows containment primitives, identity probing, and process handle adapters.

## Does not know
Stardew lifecycle state machines, action semantics, or game protocol.

## Dependency direction
Generic lifecycle contracts may be consumed by this physical Windows seam. Stardew lifecycle may consume only a narrow generic containment contract and must not import this raw platform implementation; generic layers never import Stardew.

## Placement and move rule
Keep only game-neutral Windows containment primitives here. Stardew-specific process-owner implementations/results belong under `games/stardew/lifecycle`; the staged move of `stardew-process-implementations.ts` out of this directory is intentional relocation, not deletion.

## Required verification
Physical-seam source checks, Host typecheck, and direct lifecycle tests must pass.
