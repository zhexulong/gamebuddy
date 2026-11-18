# Composition

## Owns
Generic Host composition lifetimes: the authenticated desktop session's owner, the browser-presentation admission and its domain services, and the composition root that wires generic platform infrastructure to exactly one selected game adapter.

Two of those lifetimes are worth naming because they look like someone else's:

- **The browser-presentation admission** (`desktop-presentation-admission-owner.ts`) is a child of this root, like the game owner: it decides when a presentation is admitted, tears it down in one order, and builds the Tavern management services behind it (`createTavernManagementDomains`). What it holds is the lifetime, not the transport.
- **The management route advertisement** is a composition decision, and it is made here: `composeTavernManagementProfile().routeIds` is published from this directory as the one production statement of what the mounted surface offers, and `management-profile-route-census.private.test.ts` pins it in both directions against what the surface really answers and what the dispatcher really branches on.

## Does not know
Operator configuration, or public game APIs.

## Does not do
Listen. Nothing under `composition/**` creates a server, hosts a file, or dispatches a request: `createServer`, `.listen(` and `node:http` appear nowhere here. The listeners are Tavern's (`tavern/composed-reference-game-static-shell-composition.ts` for the presentation shell, `tavern-management-dialogue-web.ts` for the management routes, `tavern/static-artifact/index.ts` for the artifact listener), the route table they dispatch is `tavern/browser-contract`, and the dispatcher is Tavern's too. Advertisement and dispatch are different facts with different owners: this layer says which routes exist, Tavern answers them.

It also does not render: the presentation-admission file imports the renderers (`renderCompanionVoiceText`, `renderCompanionExamples`, `projectRenderedCompanionWorldBook`, `chatListPreviewText`) from their owning modules and calls them; the rendering lives where the data does.

## Open follow-up: the presentation root's directory
`desktop-presentation-admission-owner.ts` (1,450 lines) and `companion-library-list.ts` are presentation composition sitting in a directory that is otherwise generic. They belong here on the current reading - the admission decision is a Host-lifetime child of this root exactly as the game owner is, and moving it would put the lifetime next to the transport it does not own - but the honest alternative is to move both under `tavern/**`, where the listeners they feed live. That is a 1,450-line relocation with its own verification, so it is recorded here as the open follow-up rather than done in passing. Nothing in this file may drift from that: if the move happens, this section goes with it.

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

The launch preparation is one of those bindings: `prepareDesktopHostLaunch` brings the player's installation to what this generation ships, and it lives here because this layer is the one that knows which adapter a launch selects. Bootstrap wire publishes the stage and the outcome it returns as two opaque tokens (`bootstrap/** ─/→ any game, Mod, action or game recipe` above), so the wire that must stay game-free never names the game it prepares.

## Required verification
Bootstrap wire imports only this generic seam, `bootstrap` and `containment` have no game imports, the game side imports only the containment contract, and composition remains unreachable from public entry APIs. `node tools/check-host-game-physical-seam.mjs` enforces all of it.
