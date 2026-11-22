// WHICH DRIVER RUNS IN WHICH INVOCATION, derived from the roster's own two flags.
//
// The roster (`phases/drivers.mjs`) already states both facts this decision needs:
//
//   `requiresGame`  the driver opens the game at all, so it is part of the game chain
//                   (`lib/chain-steps.mjs` builds its population from exactly this flag).
//   `ownWorld`      the driver's own scenario ENDS or OCCUPIES the world it is measured on, so it cannot
//                   share a mounted Host with another driver that does the same.
//
// ONE MOUNTED HOST CARRIES ONE WORLD. The product draws neither the launch nor the activation control while an
// instance exists (`dialogue-web/src/game-lifecycle-controls.ts:93-101`), and its step out of a world it has
// ended is `restart_gamebuddy`, outside the surface (`:426-430`). So a state driver that arrives at a world a
// previous one consumed can only report what it found. Measured 2026-11-22 in the round before this module
// existed (`.tmp/livenow-r29.log:161,5328,5395`): `y-game-endgame` and `z-game-disconnect` found
// `instance=crashed/attachment=attached` - the world driver `x-game-death` had just killed - and the run's own
// `DONE-CAPTURE` read `not-measured=2`.
//
// SO EACH WORLD-OWNING DRIVER GETS AN INVOCATION OF ITS OWN, and the population comes from the roster: a state
// driver added tomorrow gets its own mount without anybody editing a list here.
//
// A WORLD-OWNING DRIVER CANNOT BRING UP THE WORLD ITSELF, measured 2026-11-22 (lane YZOWN, `.tmp/lane-yzown.md`
// § "A state driver CANNOT launch a world of its own"): alone on a fresh mounted Host, `x-game-death` pressed
// the product's own launch control and the launch settled at `instance=running/attachment=none` after 307 s and
// never reached `attachment=attached`, because the cabin handoff - the only path from a launched Player Host to
// an attachment (`capture/w-game-launch.cjs` `driveCabinHandoff`) - is not a step the state drivers' shared
// prelude drives. The LAUNCH-CHAIN driver is the one that drives it: a roster driver that opens the game and
// does not own its world (`w-game-launch` today, and the only one). So every world invocation runs the
// launch-chain drivers first, then the one world-owning driver, on the same mount.
//
// WHAT THAT COSTS is a whole mount and a whole world per state driver: `phases/run.mjs` pays it in the full
// round (measured in this lane's own round, see `.tmp/lane-yzlaunch.md`).
export function worldInvocations(roster) {
  const rows = Array.isArray(roster)
    ? roster.filter((driver) => typeof driver?.key === "string" && driver.key.length > 0)
    : [];
  const bringers = rows
    .filter((driver) => driver.requiresGame === true && driver.ownWorld !== true)
    .map((driver) => driver.key);
  const owners = rows.filter((driver) => driver.ownWorld === true).map((driver) => driver.key);
  const invocations = owners.map((key) =>
    Object.freeze({ driver: key, drivers: Object.freeze([...new Set([...bringers, key])]) }),
  );
  const problems = owners
    .filter(() => bringers.length === 0)
    .map((key) => ({
      code: "world_owner_without_launch_chain",
      detail: `${key} is measured on a world it ends or occupies, and the roster names no launch-chain driver (requiresGame without ownWorld) to bring one up: a mount of its own would settle at attachment=none and measure nothing`,
    }));
  return Object.freeze({
    /** The drivers the first invocation runs: everything that does not end or occupy a world. */
    shared: Object.freeze(rows.filter((driver) => driver.ownWorld !== true).map((driver) => driver.key)),
    bringers: Object.freeze(bringers),
    invocations: Object.freeze(invocations),
    problems: Object.freeze(problems),
  });
}

/** The aligned sentence a runner prints before it pays for the mounts, so the cost is never a surprise. */
export function describeWorldInvocations(reading) {
  const owners = reading.invocations.map((invocation) => invocation.driver);
  if (owners.length === 0)
    return `WORLDS: no roster driver owns a world, so every driver runs in the one shared invocation (${String(reading.shared.length)} driver(s))`;
  return `WORLDS: ${String(owners.length)} world invocation(s) after the shared one (${String(reading.shared.length)} driver(s)) - ${owners
    .map((owner) => `${owner} after ${reading.bringers.join("+")}`)
    .join(", ")}: each needs its own mounted Host, and no two of them can share a world`;
}
