// Stardew-local name_entity smoke.
//
// The lifecycle - the fixture-config refusal, observe-fresh and the capability check, the requestId mint and the
// execute, the terminal wait and its identity, the evidence parse and the stale reread, the stale re-send, the
// bootstrap and the exit code - is `tools/lib/native-local-runner-scaffold.mjs`. What is left here is what is
// actually about naming an entity.
//
// The receipt is not the proof. The terminal of this action is the STORED NAME, and the only place
// it can be read back is the world: after the call the named horse must be published by the Mod's
// own horse projection under exactly the requested name. Three things are observed directly, and
// the first is the one the action exists for:
//
//   1. the stored name is read back FROM THE ENTITY — the `horseTargets` projection of a FRESH
//      snapshot, in which the horse this run just named appears carrying the requested name. An
//      unnamed horse is never advertised at all (the projection exists for `mount_transport`, which
//      may only mount a named horse), so the entry appearing at all is itself the change;
//   2. the receipt's two halves agree with what the world says: `name_before=none` and `name_after`
//      equal to the requested name, against the value the projection reports;
//   3. the negative case: SUBMITTING THE SAME REQUEST AGAIN is refused by name
//      (`name_entity_target_already_named`) and moves nothing — the world must still advertise the
//      name the first call stored. A horse that already carries a name is exactly what the native
//      prompt's own gate excludes (Horse.cs:622), so an action that reported a second success there
//      would be renaming an entity the game would not have offered.
//
// The projection field is `horseTargets` — `{ targetId, x, y, name }` (host/src/protocol.ts:586).
// When the surface does not carry it at all, the read-back is reported as `not_checked`, which the
// contract treats as a FAILURE: "I could not look" must never read as "the name is there".
//
// NOTE ON THE DEPENDENCY: `horseTargets` is published while `mount_transport` is advertised
// (farmhandexecutioncontroller.cs, the snapshot composition). In a native-local run that action is
// LiveVerified and therefore on the surface, which is what makes the read-back possible. A policy
// that denies `mount_transport` would make this runner report `not_checked` rather than pass.

import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";

const ACTION = "name_entity";
/** The action's own success word (`ExecuteNameEntity`: the horse's name is the requested text). */
const SUCCESS_CODE = "entity_named";
/** The one `NativeLocalPlayerFixture.FixtureScenario` this gate arms (gate descriptor `native_name_entity_v1`). */
const FIXTURE_SCENARIO = "native_name_entity_v1";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** The name a run asks for. Not the game's own default and not any fixture-side name. */
export const DEFAULT_REQUESTED_NAME = "GameBuddyNamedHorse";

const scenario = defineSmokeScenario({
  action: ACTION,
  fixtureScenario: FIXTURE_SCENARIO,
  successCode: SUCCESS_CODE,
  refusesConfig: false,
  requiredCapabilities: REQUIRED_CAPABILITIES,
  projection: { collections: ["horseTargets"] },

  /** Nothing to prepare: the horse is the one the fixture stabled for this action. */
  prepare: ({ snapshot }) => ({ snapshot, plan: { requestedName: DEFAULT_REQUESTED_NAME } }),

  describePlan: ({ requestedName }) => ({ requestedName }),

  request: ({ requestedName }) => ({ args: { text: requestedName } }),

  /**
   * The negative case, declared to the template: the same request again, against a world in which the horse now HAS
   * a name. "Refused" and "renamed anyway" must not read the same, so the settled world must still advertise the name
   * the first call stored.
   */
  negative: {
    args: ({ requestedName }) => ({ text: requestedName }),
    refusedCodes: ["name_entity_target_already_named"],
    unchanged: ({ after }) => {
      const named = horseTargets(after);
      if (named === null) return "horse_targets_not_published";
      return named.some((entry) => entry?.name === DEFAULT_REQUESTED_NAME)
        ? null
        : "the name the first call stored is no longer advertised";
    },
  },

  async assertPostcondition({ evidence, plan, after }) {
    const { requestedName } = plan;
    const targets = horseTargets(after);
    const checks = assertNameEntityPostconditions({ requestedName, evidence, horseTargets: targets });
    const failures = Object.entries(checks)
      .filter(([, ok]) => ok === false || ok === "not_checked")
      .map(([name]) => name);
    if (failures.length > 0)
      throw new Error(`name_entity live contract failed: ${failures.join(",")};checks=${JSON.stringify(checks)}`);
    return { checks, advertisedHorses: targets.length, evidence };
  },
});

export const runNameEntitySmoke = (client, receipts, config, options) =>
  scenario.run(client, receipts, config, options);

if (import.meta.main) await runSmokeScenarioMain(scenario);

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
    advertisedNameAgreesWithReceipt: observable
      ? named.length === 1 && named[0].name === evidence.name_after
      : "not_checked",
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
