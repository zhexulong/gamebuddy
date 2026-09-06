# Games

## Owns
Game-specific lifecycle and native integration modules.

## Does not know
Fixed desktop entry ownership or generic bootstrap wire parsing.

## Dependency direction
Games consume generic containment seams and are assembled privately.

## Placement and move rule
Place game implementations below the game name; do not expose them from bootstrap.

## Required verification
Game modules use only intended generic seams and preserve lifecycle tests.
