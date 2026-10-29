import type { GameBrowserStateV1 } from "./composed-reference-game-browser-api";

/**
 * The single derivation of the three lifecycle controls the player sees
 * (activation, setup, launch), so the buttons a player is offered and the
 * meanings the Host publishes cannot drift apart in two places.
 *
 * The frozen `game_browser_api/v1` vocabulary these gates read means:
 *
 * - `instance.status: "none"` + no expected generation is the pre-activation
 *   shape: nothing is running and no launch can be started, whether or not the
 *   player has already registered an installation. This is where activation and
 *   setup belong - activation is what stages the attempt they precede.
 * - `prerequisites: "met"` + `instance.status: "none"` + the exact expected
 *   generation >= 1 is the activated-but-not-launched shape: the lifecycle is
 *   ready to start a Player Host and nothing is running. This is where the
 *   launch control belongs.
 * - `instance.status: "launching"` means a launch is actually in flight (and
 *   `"running"`/`"crashed"` mean a Player Host is attached/failed), so neither
 *   is a state from which a launch may be started.
 *
 * What separates the first two shapes is the expected generation, not
 * `prerequisites`: that flag turns `met` as soon as the Host holds a ready
 * installation registration, which the player produces by confirming their game
 * folder - before any activation. Reading `prerequisites: "unknown"` as the
 * test for "not activated yet" therefore retired both staging controls at the
 * exact moment a first-run player confirmed their installation, and the surface
 * offered no control at all.
 *
 * A client-side guard must not add a further condition of its own here: these
 * three flags are exactly what the Host's projection distinguishes, and the
 * cross-boundary test in `tests/game-lifecycle-launch-gate.test.mjs` feeds a
 * real Host projection through this function.
 */
export type GameLifecycleControlAvailability = Readonly<{
  activationAvailable: boolean;
  setupAvailable: boolean;
  launchAvailable: boolean;
  /**
   * The exact expected Player Host instance generation the launch command must
   * bind, present exactly when `launchAvailable` is true.
   */
  launchGeneration: number | null;
}>;

const NO_CONTROLS: GameLifecycleControlAvailability = Object.freeze({
  activationAvailable: false,
  setupAvailable: false,
  launchAvailable: false,
  launchGeneration: null,
});

export function deriveGameLifecycleControlAvailability(
  view: Readonly<{ ready: boolean; game: GameBrowserStateV1 | null }>,
): GameLifecycleControlAvailability {
  if (!view.ready || view.game === null) return NO_CONTROLS;
  const { instance, prerequisites } = view.game.game;
  const nothingRunning = instance.status === "none";
  const launchable = nothingRunning && prerequisites.status === "met" && instance.generation >= 1;
  const preActivation = nothingRunning && !launchable;
  return Object.freeze({
    activationAvailable: preActivation && instance.generation < 1,
    setupAvailable: preActivation,
    launchAvailable: launchable,
    launchGeneration: launchable ? instance.generation : null,
  });
}
