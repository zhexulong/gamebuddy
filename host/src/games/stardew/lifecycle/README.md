# Lifecycle

## Owns
Stardew bootstrap guardian records, lifecycle owner, private composer, Stardew-specific process-owner implementations/results, and the game's own lifecycle: the state table every transition is refused against (`stardew-game-lifecycle-state.internal.ts`) and the redacted role projection derived from it (`stardew-role-lifecycle-projection.internal.ts`).

## Does not know
Fixed desktop entry and bootstrap wire ownership.

## Dependency direction
Lifecycle consumes the narrow generic containment contract and is consumed by composition. It must not import `containment/runtime/core`, the auth transport, raw generic Windows platform implementations, or the Windows folder picker — composition admits those and injects them as opaque capabilities. `bootstrap` and `containment` must never import Stardew.

## Placement and move rule
Keep Stardew-specific process-owner implementations/results here, and keep the game's own lifecycle here rather than flat in `host/src`: `tools/check-host-source-directories.mjs` names a game lifecycle module left flat. The production lifecycle coordinator is the one module of that family that does NOT belong here — it assembles the guardian platform and the desktop/native seams, which `tools/check-host-game-physical-seam.mjs` forbids under `host/src/games/`, so it stays flat with a stated reason the gate re-reads. The staged move of `stardew-process-implementations.ts` from `containment/windows` is intentional relocation, not deletion; generic Windows primitives remain under containment. Platform-frame encoding is not placed here: the module that turns typed game facts into native Guardian bytes lives at `composition/stardew/stardew-guardian-platform.ts`, because ADR-0007 Shape B keeps `Uint8Array` and every other platform-frame representation out of the game layer.

## Required verification
Guardian and composer direct tests plus Host typecheck must pass with no old-path references.
