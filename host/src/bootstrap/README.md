# Bootstrap

## Owns
Fixed Host entry, bootstrap wire parsing, and root validation.

## Does not know
Stardew lifecycle policy or game-specific guardian behavior.

## Dependency direction
Bootstrap depends on generic containment contracts and private composition seams.

## Placement and move rule
Place fixed startup and bootstrap validation here; move game assembly to composition.

## Required verification
The fixed entry is the only `import.meta.main`; wire has no game imports.
