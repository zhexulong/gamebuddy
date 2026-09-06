# Containment

## Owns
Generic authenticated containment contracts and receipt-facing seams.

## Does not know
Stardew game rules, maps, actions, or lifecycle policy.

## Dependency direction
Containment contracts are consumed by bootstrap and game-specific adapters.

## Placement and move rule
Place reusable guardian/session contracts here; keep game implementations under games.

## Required verification
Containment modules have no game imports and reject invalid protocol state.
