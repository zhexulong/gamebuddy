// Stardew-local withdraw_silo_hay smoke.
//
// The lifecycle - the fixture-config refusal, observe-fresh and the capability check, the requestId mint and the
// execute, the terminal wait and its identity, the evidence parse and the stale reread, the stale re-send, the
// bootstrap and the exit code - is `tools/lib/native-local-runner-scaffold.mjs`. What is left here is what is
// actually about taking Hay out of a Silo.
//
// The receipt is not the proof. Two things are observed directly:
//   1. the declared Given is one Hay in a Farm Silo, so ONE real withdrawal
//      drains it — the run then reads the silo's own `hay` projection and the
//      actor's carried Hay out of a FRESH snapshot, not out of the receipt;
//   2. with the store empty, the same target must be REFUSED with a World that
//      did not move. That is the negative case: an action that reports success
//      without changing anything, or that silently no-ops on an empty silo, fails
//      here rather than passing on a green receipt.
//
// The runner never chooses the target tile or the item: both come from the
// discovery projection the Mod publishes, and the Mod re-resolves them on the
// game thread.

import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";

const ACTION = "withdraw_silo_hay";
/** The action's own success word (`ExecuteWithdrawSiloHay`: one Hay left the silo and arrived in the pack). */
const SUCCESS_CODE = "silo_hay_taken";
/** The one `NativeLocalPlayerFixture.FixtureScenario` this gate arms (gate descriptor `native_withdraw_silo_hay_v1`). */
const FIXTURE_SCENARIO = "native_withdraw_silo_hay_v1";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
const HAY_QUALIFIED_ITEM_ID = "(O)178";

const scenario = defineSmokeScenario({
  action: ACTION,
  fixtureScenario: FIXTURE_SCENARIO,
  successCode: SUCCESS_CODE,
  refusesConfig: false,
  requiredCapabilities: REQUIRED_CAPABILITIES,
  projection: { collections: ["siloTargets", "inventoryItemFacts"] },

  /** Read the advertised silo and the pack's own carried Hay before anything is sent. */
  prepare: ({ snapshot }) => {
    const target = chooseAdjacentSiloTarget(snapshot);
    return { snapshot, plan: { target, carriedBefore: carriedHay(snapshot) } };
  },

  describePlan: ({ target, carriedBefore }) => ({
    target: target.targetId,
    tile: `${target.x},${target.y}`,
    siloHayBefore: target.hay,
    carriedBefore,
  }),

  request: ({ target }) => ({ args: { x: target.x, y: target.y, expectedTargetId: target.targetId } }),

  /**
   * The negative case, declared to the template: the store is empty after the one withdrawal, so the SAME target must
   * be refused and neither half of the transfer may move.
   */
  negative: {
    args: ({ target }) => ({ x: target.x, y: target.y, expectedTargetId: target.targetId }),
    refusedCodes: ["silo_empty"],
    unchanged: ({ before, after }) => {
      const targetId = before.siloTargets?.find((entry) => entry?.targetId)?.targetId ?? null;
      if (targetId === null) return "no_silo_advertised_after_the_refusal";
      const siloBefore = siloHayFor(before, targetId);
      const siloAfter = siloHayFor(after, targetId);
      if (siloAfter !== siloBefore) return `silo_hay:${siloBefore}->${siloAfter}`;
      const carriedBefore = carriedHay(before);
      const carriedAfter = carriedHay(after);
      return carriedAfter === carriedBefore ? null : `carried_hay:${carriedBefore}->${carriedAfter}`;
    },
  },

  /**
   * Both halves of the transfer, each read from the world: the receipt's own numbers must agree with the pack, the
   * silo store must fall by exactly one AND the carried Hay must rise by exactly one. Either half alone is not a
   * transfer — the silo half alone cannot tell a withdrawal from destruction, and the pack half alone cannot tell it
   * from a gift.
   */
  async assertPostcondition({ evidence, plan, after }) {
    const { target, carriedBefore } = plan;
    assertEvidence(evidence, "silo_hay_before", String(target.hay));
    assertEvidence(evidence, "silo_hay_after", String(target.hay - 1));
    assertEvidence(evidence, "silo_hay_decreased", "true");
    assertEvidence(evidence, "carried_before", String(carriedBefore));
    assertEvidence(evidence, "carried_after", String(carriedBefore + 1));
    assertEvidence(evidence, "carried_hay_increased", "true");

    const siloHayAfter = siloHayFor(after, target.targetId);
    const carriedAfter = carriedHay(after);
    if (siloHayAfter !== target.hay - 1)
      throw new Error(`silo_withdraw_world_silo_unchanged:${siloHayAfter}:${target.hay - 1}`);
    if (carriedAfter !== carriedBefore + 1)
      throw new Error(`silo_withdraw_world_carried_unchanged:${carriedAfter}:${carriedBefore + 1}`);

    return {
      target: target.targetId,
      siloHay: { before: target.hay, after: siloHayAfter },
      carriedHay: { before: carriedBefore, after: carriedAfter },
      evidence,
    };
  },
});

export const runWithdrawSiloHaySmoke = (client, receipts, config, options) =>
  scenario.run(client, receipts, config, options);

if (import.meta.main) await runSmokeScenarioMain(scenario);

/** The silo the fixture stands the actor at: an advertised target already in reach. */
function chooseAdjacentSiloTarget(snapshot) {
  const targets = snapshot.siloTargets ?? [];
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("silo_withdraw_no_advertised_target");
  const adjacent = targets.filter(
    (entry) =>
      entry?.targetId &&
      Number.isInteger(entry.x) &&
      Number.isInteger(entry.y) &&
      Math.max(Math.abs(entry.x - snapshot.tile.x), Math.abs(entry.y - snapshot.tile.y)) <= 1,
  );
  if (adjacent.length === 0) throw new Error("silo_withdraw_no_adjacent_target");
  const stocked = adjacent.filter((entry) => Number.isInteger(entry.hay) && entry.hay >= 1);
  if (stocked.length === 0) throw new Error("silo_withdraw_declared_given_absent");
  return stocked[0];
}

/** The actor's carried Hay, summed across every stack, from the live projection. */
function carriedHay(snapshot) {
  return (snapshot.inventoryItemFacts ?? [])
    .filter((entry) => entry?.qualifiedItemId === HAY_QUALIFIED_ITEM_ID && Number.isInteger(entry.stack))
    .reduce((total, entry) => total + entry.stack, 0);
}

/** The named silo's own store, read from a fresh observation. Missing means gone. */
function siloHayFor(snapshot, targetId) {
  const entry = (snapshot.siloTargets ?? []).find((candidate) => candidate?.targetId === targetId);
  if (entry === undefined || !Number.isInteger(entry.hay)) throw new Error(`silo_withdraw_target_gone:${targetId}`);
  return entry.hay;
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`silo_withdraw_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}
