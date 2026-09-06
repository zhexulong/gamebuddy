# Windows containment

## Owns
Private Windows process spawn, identity probing, and process handle adapters.

## Does not know
Stardew lifecycle state machines, action semantics, or game protocol.

## Dependency direction
Generic lifecycle contracts may be consumed by this physical Windows seam; game lifecycle consumes this seam.

## Placement and move rule
Keep raw Windows process implementations here; move only when a broader generic containment owner exists.

## Required verification
Physical-seam source checks, Host typecheck, and direct lifecycle tests must pass.
