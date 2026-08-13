import { checkM1RouteBlockerFixture, validateM1RouteBlocker } from "./stardew-portfolio-m1-route-action-contract.mjs";

/**
 * Non-mutating M1 preflight. It validates only the source-audit blocker
 * handoff; it cannot attach to Stardew, read or write a save, execute a route,
 * or turn a static receipt-shaped value into native evidence.
 */
export async function runM1RoutePreflight(input = {}) {
  const fixture = await checkM1RouteBlockerFixture();
  const handoff = validateM1RouteBlocker(input);
  if (handoff.code !== "m1_route_source_projection_blocked")
    return Object.freeze({ state: "BLOCKED", fixture, handoff });
  return Object.freeze({
    state: "BLOCKED",
    code: "m1_route_source_projection_blocked",
    producer: handoff.producer,
    consumer: handoff.consumer,
    verifier: handoff.verifier,
    fixture,
    handoff,
    nativeMutation: false,
    liveClosure: "not_performed",
  });
}
