# Bootstrap roots

## Owns
Published Stardew artifact provenance verification and artifact-root dependency construction for bootstrap staging.

## Does not know
Stardew lifecycle state machines or game action semantics.

## Dependency direction
Bootstrap root factories consume published artifact contracts; lifecycle consumes their narrow dependency contract.

## Placement and move rule
Keep published-artifact provenance verification and staging construction here; move only to a narrower generic artifact owner.

## Required verification
Host typecheck, staging tests, and physical-seam source checks must pass.
