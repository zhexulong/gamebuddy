# Contained game runtime

## Owns
The Host-private generic `ContainedGameRuntime` owner: one-shot closure-bound authorization, arm-once and serialized role launch/contain ordering, close/EOF cancellation, and redacted outcomes. It binds the requested role into each platform-session launch/contain input; private frame bytes are intentionally opaque here, so any role meaning encoded by those bytes is producer-owned and is not validated by this generic runtime.

## Does not know
Game names, game rules, installation or recipe facts, executable details, working directories, arguments, environment, process identifiers, operating-system primitives, pipes, tokens, or paths.

## Dependency direction
This module depends only on the narrow `DesktopGuardianSession` platform session contract. Host private composition and game-owned producers may consume the runtime; the runtime never imports a game, action, installation, browser, or lifecycle module.

## Placement and move rule
Keep the owner under `containment/runtime`. Move it only if the Host containment boundary is renamed or split; never move game-specific launch details here.

## Required verification
Source-bound checks must prove the runtime has no game or raw launch facts and no production mint factory. Unit tests use only a generic fake platform session and prove one-shot producer use, role/deadline/close rejection, arm-before-launch, ordering, and redacted results. Run the focused Node test, Host typecheck when feasible, physical seam check, `node --check`, and scoped `git diff --check`.
