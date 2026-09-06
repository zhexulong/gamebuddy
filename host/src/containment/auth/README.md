# Auth

## Owns
Desktop Guardian session and acknowledgement contracts.

## Does not know
Stardew-specific guardian records or composition.

## Dependency direction
Auth contracts are upstream of game adapters and private composition.

## Placement and move rule
Move generic authenticated session contracts here; never add compatibility re-exports.

## Required verification
Wire and game adapters compile against this path without reverse game dependencies.
