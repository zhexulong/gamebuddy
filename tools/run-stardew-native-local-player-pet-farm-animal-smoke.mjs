// Stardew-local `pet_farm_animal` smoke.
//
// One coop animal petted through the game's own `FarmAnimal.pet`, end to end. The action owns the whole native
// lifecycle (re-resolve the animal from its live tile, the position-independent refusals, the reach, the seam call
// and the synchronously read postcondition); this runner's job is to prove the four facts a receipt cannot supply on
// its own:
//
//   1. the terminal is the action's own `succeeded/farm_animal_petted`, correlated by the exact request/execution
//      pair;
//   2. the WORLD agrees afterwards, read from a FRESH snapshot and never from the receipt's claim: the engine's own
//      `wasPet` marker is now set for that animal, which the Mod projects as "this opaque target left the published
//      family" - the same day filter `petTargets` uses. The friendship amount is the engine's branch arithmetic,
//      recomputed here from the evidence rather than copied from it;
//   3. a SECOND request on the same animal is refused BY NAME with `farm_animal_already_petted_today`. That is the
//      branch that would otherwise open `AnimalQueryMenu` and change no friendship at all, and a caller holding only
//      a receipt would believe the animal had been petted twice;
//   4. the animal is still there and still reachable: `observe_scene` publishes every animal in the location
//      independently of the `wasPet` day filter, so the single animal this fixture adopted must still appear, with
//      the same name and `reachable: true`, after the pet.
//
// The world is a Given, not a coordinate this runner invents: the fixture places one coop on the Farm, adopts
// exactly one animal into it, and leaves the actor standing in the ring around that animal. Nothing here walks,
// equips or observes a map the fixture did not hand it.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  delay,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  validateNativeLocalFixturePolicy,
  waitForActionable,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "pet_farm_animal";
/** The action's own success word (`ExecutePetFarmAnimal`: succeeded only when the seam set `wasPet` and the floor was met). */
const SUCCESS_CODE = "farm_animal_petted";
/**
 * The no-op branch the action refuses rather than takes: `FarmAnimal.pet` mounts `AnimalQueryMenu` for an animal
 * already petted today (FarmAnimal.cs:791-794) and changes no friendship at all.
 */
const ALREADY_PETTED_CODE = "farm_animal_already_petted_today";

/** The Given this slice arms: one coop on the Farm, exactly one adopted animal, the actor in its ring. */
const FIXTURE_SCENARIO = "native_pet_farm_animal_v1";

/**
 * The closed set the surface must carry.
 *
 * `inspect_self`/`cancel_active_execution` are the two fixed protocol controls (`FarmhandCapabilitySet.ProtocolControls`),
 * `pet_farm_animal` is the registration under test, and `observe_scene` is how this runner proves the animal survived
 * the pet: every other animal channel (`farmAnimalPetTargets`, `animalProductTargets`) is filtered by a fact the pet
 * itself changes, so the scene projection is the only un-filtered witness that the animal is still in the location.
 */
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "observe_scene", ACTION];

/** The engine's two manual-pet branch amounts (`FarmAnimal.pet`, :751-:763): 15, or 7 when auto-petted that morning. */
const FRIENDSHIP_GAIN = 15;
const FRIENDSHIP_GAIN_WHEN_AUTO_PETTED = 7;
/** The seam's own cap (`Math.Min(1000, ...)` on every branch). */
const FRIENDSHIP_CAP = 1000;
/** The friendship-boost profession branch (:772-:775) adds this much ON TOP of the branch amount. */
const FRIENDSHIP_PROFESSION_BONUS = 15;
/** `FarmAnimal.pet` (:703) answers a stationary animal with a dialogue at and after this time instead of petting. */
const LATE_DAY_START = 1900;

export async function runPetFarmAnimalSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 10_000, postconditionTimeoutMs = 10_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  let lastSnapshot = null;
  try {
    validateConfig(config);
    // The fixture warps the actor into the coop with `warpFarmer`, and that warp is ASYNC: the bridge opens while the
    // fade is still in flight, so an immediate observation reads `can_move=False` and the run dies with
    // `native_snapshot_not_actionable` (the geode lane measured exactly this at ~300 ms). A warp in flight is not a
    // world that cannot act, so wait for the ability to act - bounded, and still fail-closed with the same named code
    // when the world never settles.
    const snapshot = await waitForActionable(client, await observeFresh(client), 30_000).catch(() =>
      observeFresh(client, { actionable: true }),
    );
    lastSnapshot = snapshot;
    // Record what was observed before any assertion can throw: an empty trace with a bare reasonCode cannot tell a
    // missing capability from a dead pipe.
    trace.push({
      phase: "observed",
      revision: snapshot.revision,
      location: snapshot.location,
      tile: snapshot.tile ?? null,
      actionable: snapshot.actionable,
      actorDispositionKind: snapshot.actorDispositionKind ?? null,
      capabilities: Array.isArray(snapshot.capabilities) ? [...snapshot.capabilities] : null,
      farmAnimalPetTargetCount: farmAnimalPetTargets(snapshot).length,
    });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);

    const target = chooseOnlyAnimalTarget(snapshot);
    const sceneBefore = await observeAnimals(client);
    trace.push({ phase: "observed_scene_before", animals: sceneBefore });
    assertSingleReachableAnimal(sceneBefore, "before");

    const requestId = `native_local_pet_farm_animal_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      // No slot, no tool: `FarmAnimal.pet` is reached by standing next to the animal, and the Mod re-resolves it from
      // the actor's CURRENT location and measures reach against its live tile.
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({ phase: ACTION, action: ACTION, target, receipt: summarizeReceipt(accepted) });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("pet_farm_animal_terminal_identity_mismatch");

    const evidence = parseStrictEvidence(terminal.evidence);
    trace.push({
      phase: "observed_evidence",
      action: ACTION,
      state: terminal.state,
      reasonCode: terminal.reasonCode,
      evidence,
    });

    // The receipt is judged AFTER its evidence is on the trace, so a refusal reports what the animal actually did
    // instead of only its reasonCode.
    if (terminal.state !== "succeeded" || terminal.reasonCode !== SUCCESS_CODE) {
      throw new Error(
        `pet_farm_animal_terminal_mismatch:state=${terminal.state};reason=${terminal.reasonCode}` +
          `;evidence=${terminal.evidence?.detail ?? "(none)"}`,
      );
    }

    // The clock the pet happened at: `FarmAnimal.pet` answers a STATIONARY animal with the `TryingToSleep` dialogue at
    // and after 19:00 (:703) instead of petting, so a receipt claiming a pet at that hour is one this runner does not
    // trust even if the friendship looks right.
    const timeOfDay = integerField(evidence, "time_of_day");
    if (timeOfDay >= LATE_DAY_START) throw new Error(`pet_farm_animal_late_day_evidence:time_of_day=${timeOfDay}`);

    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
    });
    lastSnapshot = after;
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);

    // The engine's own mutation, recomputed rather than copied.
    const friendship = friendshipVerdict(evidence);
    // `wasPet` is projected as a day filter, not as a field: an animal this farmer petted today is ABSENT from the
    // published family (`DiscoverFarmAnimalPetTargets`). The fixture adopts exactly one animal, so the family must
    // now be empty and the petted id must be the reason.
    const afterTargets = farmAnimalPetTargets(after);
    const pettedTargetGone = afterTargets.every((entry) => entry.targetId !== target.targetId);
    const familyEmptied = afterTargets.length === 0;
    const worldAgrees = pettedTargetGone && familyEmptied;

    // The second attempt: the same animal, the same opaque id, from a fresh observation. `ResolveFarmAnimalPetTarget`
    // deliberately has NO day filter, so an animal petted after the snapshot still RESOLVES - which is what makes this
    // refusal about `wasPet` instead of about the animal having vanished.
    const secondSnapshot = await observeFresh(client, { actionable: true });
    const secondRequestId = `native_local_pet_farm_animal_second_${Date.now()}`;
    const secondAccepted = await executeFresh(client, {
      requestId: secondRequestId,
      idempotencyKey: `${secondRequestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot: secondSnapshot,
      timeoutMs: 30_000,
    });
    const secondTerminal = await waitForTerminal(receipts, secondAccepted, terminalTimeoutMs);
    trace.push({
      phase: "second_attempt",
      action: ACTION,
      target: target.targetId,
      receipt: summarizeReceipt(secondTerminal),
      evidence: parseStrictEvidence(secondTerminal.evidence),
    });
    if (secondTerminal.executionId !== secondAccepted.executionId || secondTerminal.requestId !== secondRequestId)
      throw new Error("pet_farm_animal_second_terminal_identity_mismatch");
    const alreadyPettedRefused =
      secondTerminal.state === "rejected" &&
      secondTerminal.reasonCode === ALREADY_PETTED_CODE &&
      // The refusal names the SAME native animal, so the code cannot be satisfied by an animal that merely resembles it.
      parseStrictEvidence(secondTerminal.evidence).animal === evidence.animal;
    if (!alreadyPettedRefused)
      throw new Error(
        `pet_farm_animal_second_attempt_not_refused_by_name:state=${secondTerminal.state}` +
          `;reason=${secondTerminal.reasonCode};evidence=${secondTerminal.evidence?.detail ?? "(none)"}`,
      );

    // 4. The animal is still in the location and still reachable. `observe_scene` publishes animals independently of
    // the `wasPet` day filter, so it is the one channel that can answer this after the pet.
    const sceneAfter = await observeAnimals(client);
    trace.push({ phase: "observed_scene_after", animals: sceneAfter });
    const survived = assertSingleReachableAnimal(sceneAfter, "after");
    const sameAnimal = survived.name === sceneBefore[0].name && survived.kind === sceneBefore[0].kind;

    const passed =
      after.revision >= terminal.revision &&
      friendship.applied &&
      worldAgrees &&
      alreadyPettedRefused &&
      sameAnimal &&
      survived.reachable === true;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed
        ? SUCCESS_CODE
        : postconditionReason({ friendship, worldAgrees, alreadyPettedRefused, sameAnimal, survived }),
      target,
      receipt: summarizeReceipt(terminal),
      evidence,
      friendship,
      freshPostcondition: {
        revision: after.revision,
        location: after.location,
        tile: after.tile,
        actionable: after.actionable,
        actorDispositionKind: after.actorDispositionKind ?? null,
        pettedTargetGone,
        familyEmptied,
        worldAgrees,
      },
      secondAttempt: {
        state: secondTerminal.state,
        reasonCode: secondTerminal.reasonCode,
        alreadyPettedRefused,
      },
      animalAfterPet: { before: sceneBefore, after: sceneAfter, sameAnimal },
      trace,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 512),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      lastSnapshot: lastSnapshot
        ? {
            revision: lastSnapshot.revision,
            location: lastSnapshot.location,
            tile: lastSnapshot.tile,
            actionable: lastSnapshot.actionable,
            actorDispositionKind: lastSnapshot.actorDispositionKind ?? null,
            capabilities: lastSnapshot.capabilities,
            farmAnimalPetTargets: farmAnimalPetTargets(lastSnapshot),
          }
        : null,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectWithRetry(config, 15_000);
  try {
    const result = await runPetFarmAnimalSmoke(session.client, session.receipts, config);
    if (result.state === "passed") console.log(JSON.stringify(result));
    else console.error(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

/** The game creates its named pipe asynchronously after launch; retry ENOENT within a bounded window. */
async function connectWithRetry(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
    } catch (error) {
      lastError = error;
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      await delay(250);
    }
  }
  throw lastError ?? new Error("native_local_bridge_connect_timeout");
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== FIXTURE_SCENARIO)
    throw new Error("native_local_pet_farm_animal_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_pet_farm_animal_action_policy_invalid");
  // `pet_farm_animal` is an Experimental registration, so the fixture's derived policy legitimately opts it in - and
  // nothing else.
  validateNativeLocalFixturePolicy(value, {
    requiredActions: ["observe_scene", ACTION],
    experimentalActions: [ACTION],
  });
}

/** The published family, validated rather than trusted: each row is one animal this farmer has not petted today. */
function farmAnimalPetTargets(snapshot) {
  const raw = snapshot?.farmAnimalPetTargets;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("native_local_farm_animal_pet_targets_invalid");
  return raw.filter(
    (entry) =>
      typeof entry?.targetId === "string" &&
      /^farm_animal_[a-f0-9]{16}$/.test(entry.targetId) &&
      Number.isInteger(entry.x) &&
      Number.isInteger(entry.y) &&
      typeof entry.animalType === "string" &&
      entry.animalType.length > 0 &&
      Number.isInteger(entry.friendship) &&
      entry.friendship >= 0 &&
      entry.friendship <= FRIENDSHIP_CAP,
  );
}

/**
 * The one animal the fixture adopted, named by the id the request must use.
 *
 * "Exactly one" is the fixture's contract (a coop holding one animal), and it is also what makes the post-pet
 * observation unambiguous: an animal that is absent from a family of one can only be absent because it was petted,
 * while an absence from a family of twelve says nothing about which one.
 */
function chooseOnlyAnimalTarget(snapshot) {
  const targets = farmAnimalPetTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(
      `pet_farm_animal_target_count_expected_1_got_${targets.length}:` +
        (targets.map((entry) => `${entry.targetId}@${entry.x},${entry.y}`).join(",") || "none"),
    );
  return {
    targetId: targets[0].targetId,
    x: targets[0].x,
    y: targets[0].y,
    animalType: targets[0].animalType,
    friendship: targets[0].friendship,
  };
}

/** Every `animal` affordance the scene projection publishes for the actor's current location. */
async function observeAnimals(client) {
  if (typeof client.observeScene !== "function") throw new Error("native_local_observe_scene_unavailable");
  const scene = await client.observeScene({});
  const affordances = Array.isArray(scene?.affordances) ? scene.affordances : [];
  return affordances
    .filter((affordance) => affordance?.kind === "animal")
    .map((affordance) => ({
      name: affordance.name,
      kind: affordance.kind,
      distance: affordance.distance,
      direction: affordance.direction,
      reachable: affordance.reachable,
      actionHint: affordance.actionHint ?? null,
    }));
}

/**
 * The scene's own view of the coop: one animal, and the actor can reach it.
 *
 * `reachable` is `StardewBodyController.BuildSceneActionability`'s answer - the animal's tile is in the actor's bounded
 * walkable component or next to it - and `undefined` is "undecided", which is NOT "reachable": a run that cannot
 * decide must report that rather than claim the animal was still within reach.
 */
function assertSingleReachableAnimal(animals, phase) {
  if (animals.length !== 1)
    throw new Error(`pet_farm_animal_scene_animal_count_${phase}_expected_1_got_${animals.length}`);
  if (animals[0].reachable !== true)
    throw new Error(`pet_farm_animal_scene_animal_not_reachable_${phase}:${String(animals[0].reachable)}`);
  return animals[0];
}

/**
 * The friendship the engine applied, recomputed from its own branch arithmetic.
 *
 * `FarmAnimal.pet` (:745-:789) raises friendship by 15 for a manual pet, by 7 when the animal was already auto-petted
 * that morning, and by a further 15 when the player has the happiness-boost profession - always capped at 1000. The
 * Mod reports the floor it derived (`friendship_floor`) from the same branch, so the two must agree: a receipt whose
 * floor is not this arithmetic is a receipt this runner does not recognise.
 */
function friendshipVerdict(evidence) {
  const before = integerField(evidence, "friendship_before");
  const after = integerField(evidence, "friendship_after");
  const floor = integerField(evidence, "friendship_floor");
  if (evidence.was_auto_pet_before !== "true" && evidence.was_auto_pet_before !== "false")
    throw new Error(`pet_farm_animal_evidence_was_auto_pet_before_invalid:${String(evidence.was_auto_pet_before)}`);
  const autoPettedBefore = evidence.was_auto_pet_before === "true";
  const branch = autoPettedBefore ? FRIENDSHIP_GAIN_WHEN_AUTO_PETTED : FRIENDSHIP_GAIN;
  const expected = Math.min(FRIENDSHIP_CAP, before + branch);
  const expectedWithProfession = Math.min(FRIENDSHIP_CAP, expected + FRIENDSHIP_PROFESSION_BONUS);
  if (floor !== expected)
    throw new Error(`pet_farm_animal_friendship_floor_disagrees:reported=${floor};engine=${expected};before=${before}`);
  if (after !== expected && after !== expectedWithProfession)
    throw new Error(
      `pet_farm_animal_friendship_after_disagrees:after=${after};branch=${expected};profession=${expectedWithProfession}`,
    );
  if (after > FRIENDSHIP_CAP) throw new Error(`pet_farm_animal_friendship_above_cap:${after}`);
  const applied = after > before || before >= FRIENDSHIP_CAP;
  if (!applied) throw new Error(`pet_farm_animal_friendship_did_not_rise:before=${before};after=${after}`);
  return {
    before,
    after,
    floor,
    autoPettedBefore,
    branch,
    professorBoost: after === expectedWithProfession && after !== expected,
    applied,
  };
}

function integerField(evidence, key) {
  const raw = evidence[key];
  if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw))
    throw new Error(`pet_farm_animal_evidence_${key}_invalid:${String(raw)}`);
  return Number(raw);
}

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

function postconditionReason({ friendship, worldAgrees, alreadyPettedRefused, sameAnimal, survived }) {
  if (!friendship.applied) return "pet_farm_animal_postcondition_friendship_not_applied";
  if (!worldAgrees) return "pet_farm_animal_postcondition_animal_still_published";
  if (!alreadyPettedRefused) return "pet_farm_animal_second_attempt_not_refused_by_name";
  if (!sameAnimal) return "pet_farm_animal_postcondition_animal_replaced";
  if (survived.reachable !== true) return "pet_farm_animal_postcondition_animal_not_reachable";
  return "pet_farm_animal_postcondition_mismatch";
}
