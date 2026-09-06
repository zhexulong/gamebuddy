# Entry

## Owns
The single fixed Host production entry module.

## Does not know
Wire implementation details beyond its bootstrap function.

## Dependency direction
Entry calls bootstrap wire only.

## Placement and move rule
Keep exactly one physical entry; do not add aliases or fallback entries.

## Required verification
Assert one `import.meta.main` and no public exports.
