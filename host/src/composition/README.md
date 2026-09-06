# Composition

## Owns
Generic Host composition lifetimes, including authenticated desktop session ownership.

## Does not know
Browser presentation, operator configuration, or public game APIs.

## Dependency direction
Composition consumes generic containment/auth contracts and is consumed by bootstrap wire; game lifecycle composition remains game-owned.

## Placement and move rule
Put generic Host lifetime assembly here; do not place reusable protocol or game policy in this directory.

## Required verification
Bootstrap wire imports only this generic seam, composition has no game imports, and composition remains unreachable from public entry APIs.
