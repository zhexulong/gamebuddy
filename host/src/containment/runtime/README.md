# Contained game runtime

## Owns
The Host-private generic `ContainedGameRuntime` owner: one-shot closure-bound authorization, arm-once and serialized role launch/contain ordering, close/EOF cancellation, and redacted outcomes. The game-facing producer supplies typed/private facts only. A composition-private platform adapter alone encodes those facts and consumes native private-frame bytes; the generic core passes typed facts to that adapter and never creates or interprets native bytes.

## Does not know
Game names, game rules, installation or recipe facts, executable details, working directories, arguments, environment, process identifiers, operating-system primitives, pipes, tokens, or paths.

## Dependency direction
This module depends only on the narrow composition-owned platform port. Host private composition and game-owned producers may consume the runtime; the runtime never imports a game, action, installation, browser, lifecycle module, or native frame transport.

## Placement and move rule
Keep the public contract under `containment/runtime/contract` and the implementation under `containment/runtime/core`. Move these files only if the Host containment boundary is renamed or split; never move game-specific launch details here.

## Required verification
Source-bound checks must prove the runtime has no game or raw launch facts and no production mint factory. Unit tests use only a generic fake platform port and prove one-shot producer use, role/deadline/close rejection, arm-before-launch, ordering, and redacted results. A separate composition-private test proves that only the platform adapter creates native frame bytes. Run the focused Node test, Host typecheck when feasible, physical seam check, `node --check`, and scoped `git diff --check`.
