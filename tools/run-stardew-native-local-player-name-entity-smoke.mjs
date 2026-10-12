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

const ACTION = "name_entity";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/**
 * name_entity live contract.
 *
 * The receipt is not the proof. The terminal of this action is the STORED NAME, and the only place
 * it can be read back is the world: after the call the named horse must be published by the Mod's
 * own horse projection under exactly the requested name. Three things are observed directly, and
 * the first is the one the action exists for:
 *
 *   1. the stored name is read back FROM THE ENTITY — the `horseTargets` projection of a FRESH
 *      snapshot, in which the horse this run just named appears carrying the requested name. An
 *      unnamed horse is never advertised at all (the projection exists for `mount_transport`, which
 *      may only mount a named horse), so the entry appearing at all is itself the change;
 *   2. the receipt's two halves agree with what the world says: `name_before=none` and `name_after`
 *      equal to the requested name, against the value the projection reports;
 *   3. the negative case: SUBMITTING THE SAME REQUEST AGAIN is refused by name
 *      (`name_entity_target_already_named`) and moves nothing. A horse that already carries a name
 *      is exactly what the native prompt's own gate excludes (Horse.cs:622), so an action that
 *      reported a second success there would be renaming an entity the game would not have offered;
 *      and the advertised name must be UNCHANGED after the refusal, so "refused" and "silently
 *      renamed anyway" cannot read the same.
 *
 * The projection field is `horseTargets` — `{ targetId, x, y, name }` (host/src/protocol.ts:586).
 * When the surface does not carry it at all, the read-back is reported as `not_checked`, which the
 * caller treats as a FAILURE: "I could not look" must never read as "the name is there".
 *
 * NOTE ON THE DEPENDENCY: `horseTargets` is published while `mount_transport` is advertised
 * (farmhandexecutioncontroller.cs, the snapshot composition). In a native-local run that action is
 * LiveVerified and therefore on the surface, which is what makes the read-back possible. A policy
 * that denies `mount_transport` would make this runner report `not_checked` rather than pass.
 */
export async function runNameEntitySmoke(client, receipts, _config, { terminalTimeoutMs = 5_000, requestedName = DEFAULT_REQUESTED_NAME } = {}) {
  const trace = [];
  const snapshot = await observeFresh(client, { actionable: true });
  assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);

  const requestId = `native_local_name_entity_${Date.now()}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: { text: requestedName },
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ step: "name", action: ACTION, requested: requestedName, receipt: summarizeReceipt(accepted) });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
    throw new Error("name_entity terminal does not belong to this request");
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "entity_named")
    throw new Error(
      `name_entity did not name the entity: state=${terminal.state};reason=${terminal.reasonCode};evidence=${terminal.evidence ?? ""}`,
    );

  const evidence = parseEvidence(terminal.evidence);
  const after = await observeFresh(client, { actionable: true });
  const targets = horseTargets(after);

  const checks = assertNameEntityPostconditions({ requestedName, evidence, horseTargets: targets });
  trace.push({ step: "observed", advertisedHorses: targets === null ? null : targets.length, evidence, checks });

  // The negative case: the same request again, against a world in which the horse now HAS a name.
  const repeatId = `native_local_name_entity_repeat_${Date.now()}`;
  const repeat = await executeFresh(client, {
    requestId: repeatId,
    idempotencyKey: `${repeatId}_idem`,
    action: ACTION,
    args: { text: requestedName },
    snapshot: after,
    timeoutMs: 30_000,
  });
  const repeatTerminal = await waitForTerminal(receipts, repeat, terminalTimeoutMs);
  trace.push({ step: "repeat", receipt: summarizeReceipt(repeatTerminal) });
  checks.alreadyNamedRefused =
    repeatTerminal.state === "rejected" && repeatTerminal.reasonCode === "name_entity_target_already_named";

  // "Refused" and "renamed anyway" must not read the same: re-read the world after the refusal.
  const afterRepeat = await observeFresh(client, { actionable: true });
  const repeatTargets = horseTargets(afterRepeat);
  checks.refusalMovedNothing =
    repeatTargets === null ? "not_checked" : repeatTargets.some((entry) => entry?.name === requestedName);
  trace.push({ step: "observed_repeat", advertisedHorses: repeatTargets === null ? null : repeatTargets.length, checks });

  const failures = Object.entries(checks)
    .filter(([, ok]) => ok === false || ok === "not_checked")
    .map(([name]) => name);
  if (failures.length > 0)
    throw new Error(`name_entity live contract failed: ${failures.join(",")};trace=${JSON.stringify(trace)}`);

  return { state: "passed", reasonCode: "entity_named", trace, checks, evidence };
}

/** The name a run asks for. Not the game's own default and not any fixture-side name. */
export const DEFAULT_REQUESTED_NAME = "GameBuddyNamedHorse";

/**
 * The live contract's judgement, as a PURE function so it can be tested without a transport: the
 * receipt's evidence and the horse projection of a fresh snapshot.
 *
 * `storedNameReadBackFromEntity` and `advertisedNameAgreesWithReceipt` are `not_checked` — not
 * `true` — when the surface does not carry the projection at all, because "I could not look" and
 * "the entity stores the name" must never read the same, and the caller treats `not_checked` as a
 * failure.
 */
export function assertNameEntityPostconditions({ requestedName, evidence, horseTargets: targets }) {
  const observable = Array.isArray(targets);
  const named = observable ? targets.filter((entry) => entry?.name === requestedName) : null;
  return {
    // The receipt's two halves describe the change the action claims: unnamed before, this name after.
    receiptSaysNamed: evidence.name_before === "none" && evidence.name_after === requestedName,
    // The stored name is read back FROM THE ENTITY, not from the receipt.
    storedNameReadBackFromEntity: observable ? named.length === 1 : "not_checked",
    // And the receipt's after-value is the one the world reports, so the receipt cannot claim a name
    // the world does not hold.
    advertisedNameAgreesWithReceipt: observable ? named.length === 1 && named[0].name === evidence.name_after : "not_checked",
    // The entity's own name field is what the action wrote - the receipt must not be reading a
    // different fact (e.g. the durable per-player horseName) and calling it the entity's.
    evidenceMatchesRequest: evidence.requested === requestedName && evidence.name_matches_requested === "true",
  };
}

/** The horses a fresh snapshot publishes, or null when the surface does not carry them at all. */
function horseTargets(snapshot) {
  const targets = snapshot?.horseTargets;
  return Array.isArray(targets) ? targets : null;
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
    const result = await runNameEntitySmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
