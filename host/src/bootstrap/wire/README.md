# Wire

## Owns
Strict bootstrap frame parsing, root admission, and acknowledgement framing.

## Does not know
Stardew modules or game lifecycle policy.

## Dependency direction
Wire consumes generic auth contracts and the private composition seam.

## Placement and move rule
Move fixed protocol validation here; game-specific assembly belongs in composition.

## Required verification
Typecheck and source tests prove no Stardew import and bounded strict framing.
