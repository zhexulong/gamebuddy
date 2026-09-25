# Composition

## Owns
Generic Host composition lifetimes, including authenticated desktop session ownership, and the composition root that wires generic platform infrastructure to exactly one selected game adapter.

## Does not know
Browser presentation, operator configuration, or public game APIs.

## Dependency direction
Composition consumes generic containment runtime/core and auth contracts, the platform capability modules it admits (for example the Windows folder picker), and exactly one selected game adapter; it is consumed by bootstrap wire. A game adapter receives platform capabilities only as opaque injected values and never imports them itself.

Per ADR-0007 the direction is asymmetric, and the asymmetry is the point:

```text
composition    → containment/runtime/core + one selected game adapter + platform modules
bootstrap/**   → composition/private platform assembly only
bootstrap/**, containment/runtime/** ─/→ any game, Mod, action or game recipe
games/**       → containment/runtime/contract/game-runtime only
```

So `composition` is the one generic layer that may reach a game adapter (it is the composition root and must bind the game's typed facts to the platform encoder and the authenticated session), while `bootstrap` and `containment` must stay game-free. The game side may import only the narrow containment contract: it must not import `runtime/core`, the auth transport, bootstrap roots, Desktop, Guardian, Windows or native modules, and it must not see `Uint8Array` or any other platform-frame representation.

## Placement and move rule
Put generic Host lifetime assembly and the platform-binding modules here (for example `composition/stardew/stardew-guardian-platform.ts`, which encodes typed game facts into the native Guardian frame). Do not place reusable protocol or game policy in this directory: a module belongs here only when its job is binding generic infrastructure to a selected adapter.

## Required verification
Bootstrap wire imports only this generic seam, `bootstrap` and `containment` have no game imports, the game side imports only the containment contract, and composition remains unreachable from public entry APIs. `node tools/check-host-game-physical-seam.mjs` enforces all of it.
