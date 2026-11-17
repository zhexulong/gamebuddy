# Containment

## Owns
Generic authenticated containment contracts and receipt-facing seams.

## Does not know
Stardew game rules, maps, actions, lifecycle policy, or Stardew-specific process owners/results.

## Dependency direction
Containment contracts are consumed by bootstrap and game-specific adapters.

## Placement and move rule
Place reusable guardian/session contracts here; keep game implementations and results under games. A game may consume a narrow generic containment contract, but generic containment must never import a game.

Physical Windows primitives are not contained here, and there is no `windows/` directory in this layer to look in: the path-identity inspector is `../windows-reparse-inspector/index.ts`, the broker and its mutex are `../windows-named-mutex-broker.ts` and `../windows-partition-mutex.ts`, and each game's own process owners live under `../games/<game>/lifecycle/` (`../games/stardew/lifecycle/stardew-process-implementations.ts`). `containment/windows/` held only a README claiming those adapters after the code moved, so it was removed rather than kept as a tombstone: a directory that carries a claim and no module tells the next reader that something lives there that does not.

## Required verification
Containment modules have no game imports and reject invalid protocol state.
