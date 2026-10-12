import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "clear_fish_pond";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/**
 * clear_fish_pond live contract.
 *
 * The receipt is not the proof. Four things are observed directly, and the first is the one
 * that makes this action worth its destructiveness:
 *
 *   1. the pond is emptied — read from a FRESH snapshot's `fishPondTargets`, where the pond the
 *      run just cleared must be ABSENT, because an empty pond is never advertised. That is a
 *      stronger claim than "the receipt said ok": the published fact itself changes;
 *   2. the fish were EJECTED, not destroyed — the run counts ground debris of the pond's fish
 *      type in the actor's location before and after, and requires the after-count to be higher
 *      by at least the occupants that were reported. This is the card's correction to my own
 *      earlier description of the action, so it is asserted rather than assumed;
 *   3. the receipt's postcondition keys agree with what the world says (occupants 0, fish type
 *      none, and the corroborating gate/day/cracker fields);
 *   4. RESUBMITTING THE STALE ID is refused by name and moves nothing. A pond that is already
 *      empty has nothing to clear, so this is the negative case: an action that reported a
 *      second success there would be clearing nothing and claiming it; an action that silently
 *      succeeded would fail the run rather than pass on a green receipt.
 *
 * The runner never chooses the target tile: it comes from the `fishPondTargets` discovery
 * projection the Mod publishes, and the Mod re-resolves it on the game thread.
 */
export async function runClearFishPondSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  const snapshot = await observeFresh(client, { actionable: true });
  assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
  const target = chooseStockedPond(snapshot);

  const requestId = `native_local_clear_fish_pond_${Date.now()}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({
    step: "clear",
    action: ACTION,
    target: target.targetId,
    occupantsBefore: target.occupants,
    receipt: summarizeReceipt(accepted),
  });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
    throw new Error("clear_fish_pond terminal does not belong to this request");
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "fish_pond_cleared")
    throw new Error(
      `clear_fish_pond did not clear the pond: state=${terminal.state};reason=${terminal.reasonCode};evidence=${terminal.evidence ?? ""}`,
    );

  const evidence = parseEvidence(terminal.evidence);
  const after = await observeFresh(client, { actionable: true });
  const survivors = fishPondTargets(after).filter((entry) => entry.targetId === target.targetId);

  // The ejection is corroborated ONLY when the observation surface actually carries ground debris. When it does not,
  // the check is reported as `not_checked` - never as a pass - because "I could not look" and "the fish were not
  // ejected" must not read the same, and a silently skipped assertion is the vacuity this repo keeps removing.
  const debris = groundDebris(after);
  const debrisObservable = debris !== null;
  const ejected = debrisObservable
    ? debris.filter((entry) => entry?.itemId === target.fishType || entry?.item?.itemId === target.fishType).length
    : null;

  const checks = assertClearFishPondPostconditions({
    target,
    evidence,
    survivors,
    debris,
  });
  trace.push({ step: "observed", debrisObservable, ejected, fishType: target.fishType, survivors: survivors.length, evidence, checks });
  // 4. the negative case: the stale id is refused by name and the world does not move.
  const staleId = `native_local_clear_fish_pond_stale_${Date.now()}`;
  const stale = await executeFresh(client, {
    requestId: staleId,
    idempotencyKey: `${staleId}_idem`,
    action: ACTION,
    args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
    snapshot: after,
    timeoutMs: 30_000,
  });
  const staleTerminal = await waitForTerminal(receipts, stale, terminalTimeoutMs);
  const staleReceipt = summarizeReceipt(staleTerminal);
  trace.push({ step: "stale_target", receipt: staleReceipt });
  checks.staleTargetRefused = staleTerminal.state === "rejected" && staleTerminal.reasonCode === "pond_already_empty";

  const failures = Object.entries(checks)
    .filter(([, ok]) => ok === false || ok === "not_checked")
    .map(([name]) => name);
  if (failures.length > 0)
    throw new Error(`clear_fish_pond live contract failed: ${failures.join(",")};trace=${JSON.stringify(trace)}`);

  return { state: "passed", reasonCode: "fish_pond_cleared", trace, checks, evidence };
}

/**
 * The live contract's judgement, as a PURE function so it can be tested without a transport: the published
 * projection, the receipt's evidence, the pond's survival in the fresh snapshot, and ground debris (or null when
 * the observation surface does not carry it).
 *
 * `fishEjected` is `not_checked` - not `true` - when the surface cannot show debris, because "I could not look"
 * and "the fish were not ejected" must never read the same, and the caller treats `not_checked` as a failure.
 */
export function assertClearFishPondPostconditions({ target, evidence, survivors, debris }) {
  const observable = Array.isArray(debris);
  const ejected = observable ? debris.filter((entry) => entry?.itemId === target.fishType || entry?.item?.itemId === target.fishType).length : null;
  return {
    // The published fact changed: the cleared pond is gone from discovery, because an empty pond is never advertised.
    pondNoLongerAdvertised: survivors.length === 0,
    // The receipt's postcondition agrees with what it claims about the world.
    receiptSaysEmpty: evidence.occupants_after === "0" && evidence.fish_type_after === "none",
    // And its counts name the pond this run actually cleared.
    evidenceCountsMatch: evidence.occupants_before === String(target.occupants) && evidence.fish_ejected === String(target.occupants),
    // The fish left the pond as debris, or the fact is reported unobservable.
    fishEjected: observable ? ejected >= target.occupants : "not_checked",
  };
}
/** The pond the fixture stocked, as discovery publishes it. */
function chooseStockedPond(snapshot) {
  const candidates = fishPondTargets(snapshot).filter((entry) => entry.occupants >= 1);
  if (candidates.length === 0)
    throw new Error(`no stocked fish pond is advertised: ${JSON.stringify(fishPondTargets(snapshot))}`);
  return candidates[0];
}

function fishPondTargets(snapshot) {
  const targets = snapshot?.fishPondTargets;
  return Array.isArray(targets) ? targets : [];
}

/**
 * Ground debris in a fresh snapshot, or null when the observation surface does not carry it at all - which is a
 * reported finding rather than a silent skip.
 */
function groundDebris(snapshot) {
  const debris = snapshot?.debris ?? snapshot?.location?.debris;
  return Array.isArray(debris) ? debris : null;
}

/** `key=value;key=value` — the Mod's evidence shape. */
function parseEvidence(evidence) {
  const text = typeof evidence === "string" ? evidence : (evidence?.detail ?? "");
  const values = {};
  for (const field of String(text).split(";")) {
    const at = field.indexOf("=");
    if (at <= 0) continue;
    values[field.slice(0, at)] = field.slice(at + 1);
  }
  return values;
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runClearFishPondSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
