# Stardew

## Owns
Stardew-specific lifecycle, launch, and bridge integration boundaries.

## Does not know
Desktop entry selection or generic bootstrap framing.

## Dependency direction
Stardew depends on generic containment/auth contracts and domain modules.

## Placement and move rule
Place Stardew guardian/composer under lifecycle; use launch or bridge only when concrete modules exist.

## Required verification
No bootstrap/containment import points back into Stardew; focused lifecycle tests pass.
