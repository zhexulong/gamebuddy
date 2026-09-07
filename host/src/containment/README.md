# Containment

## Owns
Generic authenticated containment contracts and receipt-facing seams.

## Does not know
Stardew game rules, maps, actions, lifecycle policy, or Stardew-specific process owners/results.

## Dependency direction
Containment contracts are consumed by bootstrap and game-specific adapters.

## Placement and move rule
Place reusable guardian/session contracts here; keep game implementations and results under games. A game may consume a narrow generic containment contract, but generic containment must never import a game.

## Required verification
Containment modules have no game imports and reject invalid protocol state.
