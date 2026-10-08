import type { GameBrowserStateV1 } from "./composed-reference-game-browser-api";

/**
 * The single derivation of the three lifecycle controls the player sees
 * (activation, setup, launch), so the buttons a player is offered and the
 * meanings the Host publishes cannot drift apart in two places.
 *
 * The frozen `game_browser_api/v1` vocabulary these gates read means:
 *
 * - `prerequisites: "unknown"` + `instance.status: "none"` + no generation is
 *   the pre-activation shape: nothing detected, nothing launched, no expected
 *   Player Host instance.
 * - `prerequisites: "met"` + `instance.status: "none"` + the exact expected
 *   generation is the activated-but-not-launched shape: the lifecycle is ready
 *   to start a Player Host and nothing is running. This is where the launch
 *   control belongs.
 * - `instance.status: "launching"` means a launch is actually in flight (and
 *   `"running"`/`"crashed"` mean a Player Host is attached/failed), so neither
 *   is a state from which a launch may be started.
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
}>;

const NO_CONTROLS: GameLifecycleControlAvailability = Object.freeze({
  activationAvailable: false,
  setupAvailable: false,
  launchAvailable: false,
});

export function deriveGameLifecycleControlAvailability(
  view: Readonly<{ ready: boolean; game: GameBrowserStateV1 | null }>,
): GameLifecycleControlAvailability {
  if (!view.ready || view.game === null) return NO_CONTROLS;
  const { instance, prerequisites } = view.game.game;
  const nothingRunning = instance.status === "none";
  return Object.freeze({
    activationAvailable: nothingRunning && prerequisites.status === "unknown" && instance.generation < 1,
    setupAvailable: nothingRunning && prerequisites.status === "unknown",
    launchAvailable: nothingRunning && prerequisites.status === "met" && instance.generation >= 1,
  });
}
