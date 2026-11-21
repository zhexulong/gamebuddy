/*
 * The classification the game-launch driver and the run's totals share.
 *
 * What these assertions protect: a driver that could not measure the product's launch path must
 * never be counted as a pass, and a launch the product actually refused must never be excused as
 * "this machine has no game". Both directions are here, because a one-sided suite would pass a
 * classification that answers `not_measured` for everything.
 *
 * red-proof: inject  measured 2026-11-15: narrowing `GUARDIAN_CAUSE_PATTERN` to a pattern nothing matches and
 *                   inverting the generic-launch rule (`guardianCanArm` instead of `!guardianCanArm`) turned
 *                   three of the eight assertions red - "a guardian-family cause is a missing prerequisite,
 *                   whatever link refused it", "a cause that names no guardian is never excused, even with the
 *                   gate peer bound" and "the generic launch refusal is the guardian prerequisite only when no
 *                   endpoint can arm" - and the suite returned `pass 5 fail 3`, which is the shape a driver
 *                   that excused every launch refusal as "no guardian here" would leave behind.
 *
 * red-proof: inject  measured 2026-11-15 again, for the third verdict: making the attachment branch
 *                   unreachable (`if (false)` instead of the attached-and-not-running test) and dropping the
 *                   confirmation-freshness guard turned exactly two assertions red - "an attachment that
 *                   landed proves the instance-word gap" and "the save gap needs the Mod's own fresh word for
 *                   THIS run's confirmation" - and the suite returned `pass 15 fail 2`. That is the shape a
 *                   classifier would leave behind if it reported `blocked_by_product` for a state it had not
 *                   proved, which is the one thing this vocabulary must never do.
 *
 * red-proof: inject  measured 2026-11-15, for the farmhand gap, twice: deleting the gap from `PRODUCT_GAPS`
 *                   turned the gap assertion red with `actual: 'BLOCKED-BY-PRODUCT: undefined: x'` against
 *                   `expected: 'BLOCKED-BY-PRODUCT: farmhand_not_initialized: x'` (the assertion pins the
 *                   literal name for exactly that reason: comparing against the same object stayed green at
 *                   first, which is the shape a self-referential test leaves behind), and short-circuiting
 *                   `farmhandNotInitializedReading` turned it red with `TypeError: Cannot read properties of
 *                   null (reading 'verdict')`. The suite returned `pass 21 fail 1` both times. Driving the same
 *                   classifier with `.live-runs/runconfirm`'s recorded facts returned
 *                   `blocked_by_product/farmhand_not_initialized`; with either half stripped from that copy it
 *                   returned `null`, which is the run reading `failed
 *                   cabin_handoff_did_not_attach:instance=launching/attachment=none`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blockedByProductLine,
  CHAIN_RUNGS,
  CHAIN_STEP_NAMES,
  CHAIN_STEPS,
  chainStepsLine,
  classifyChainStop,
  classifyLaunchRefusal,
  classifySilentLaunch,
  describeChain,
  describeGameState,
  describeLaunchPlateau,
  describeLaunchProgress,
  gameLocaleMismatch,
  guardianCanArm,
  LAUNCH_PLATEAU_MS,
  LAUNCH_STEPS,
  LIFECYCLE_SHAPES,
  lifecycleShapeOf,
  liveGameLocaleOf,
  notMeasuredLine,
  PRODUCT_GAPS,
  readBlockedByProduct,
  readinessOf,
  readNotMeasured,
  responseStampForPress,
  VERDICTS,
} from "./game-launch-verdict.mjs";

const GATE_PEER = Object.freeze({
  endpoints: Object.freeze(["GameBuddy.HostGuardian.0123456789abcdef"]),
  examined: 203,
  onlyRunOwnGatePeer: true,
  runGatePeerMode: "hello_only",
});
// The same peer, once the generation publishes a Guardian and the launcher runs it: still one
// endpoint, still this run's own, but now a real server of the arm/launch/contain frames.
const GATE_PEER_ARMABLE = Object.freeze({ ...GATE_PEER, runGatePeerMode: "armable" });
const REAL_SUPERVISOR = Object.freeze({
  endpoints: Object.freeze(["GameBuddy.HostGuardian.0123456789abcdef", "GameBuddy.HostGuardian.fedcba9876543210"]),
  examined: 204,
  onlyRunOwnGatePeer: false,
});
const NOTHING_BOUND = Object.freeze({ endpoints: Object.freeze([]), examined: 203, onlyRunOwnGatePeer: false });

test("a guardian-family cause is a missing prerequisite, whatever link refused it", () => {
  const reading = classifyLaunchRefusal({
    step: LAUNCH_STEPS.launch,
    code: "game_unavailable",
    cause: "stardew_bootstrap_guardian_owner_binding_unavailable",
    guardian: GATE_PEER,
  });
  assert.equal(reading.verdict, VERDICTS.notMeasured);
  assert.equal(reading.reason, "guardian_pipe_unreachable");
  assert.match(reading.detail, /stardew_bootstrap_guardian_owner_binding_unavailable/u);
  assert.match(reading.detail, /203 named pipe/u);
});

test("a cause that names no guardian is never excused, even with the gate peer bound", () => {
  const reading = classifyLaunchRefusal({
    step: LAUNCH_STEPS.launch,
    code: "game_unavailable",
    cause: "stardew_player_host_launch_failed",
    guardian: REAL_SUPERVISOR,
  });
  assert.equal(reading.verdict, VERDICTS.failed);
  assert.equal(reading.reason, "game_launch_unavailable:game_unavailable/stardew_player_host_launch_failed");
});

test("the generic launch refusal is the guardian prerequisite only when no endpoint can arm", () => {
  for (const guardian of [GATE_PEER, NOTHING_BOUND]) {
    const reading = classifyLaunchRefusal({ step: LAUNCH_STEPS.launch, code: "game_unavailable", guardian });
    assert.equal(reading.verdict, VERDICTS.notMeasured);
    assert.equal(reading.reason, "guardian_pipe_unreachable");
  }
  // One extra endpoint and the driver can no longer tell the gate peer from a supervisor, so the
  // refusal is the product's to answer for. So is the same refusal when this run's own peer CAN arm.
  for (const guardian of [REAL_SUPERVISOR, GATE_PEER_ARMABLE]) {
    const ambiguous = classifyLaunchRefusal({ step: LAUNCH_STEPS.launch, code: "game_unavailable", guardian });
    assert.equal(ambiguous.verdict, VERDICTS.failed);
  }
});

test("guardianCanArm reads the population and the peer's own armability, not a flag", () => {
  assert.equal(guardianCanArm(GATE_PEER), false);
  assert.equal(guardianCanArm(GATE_PEER_ARMABLE), true);
  assert.equal(guardianCanArm(NOTHING_BOUND), false);
  assert.equal(guardianCanArm(REAL_SUPERVISOR), true);
  assert.equal(guardianCanArm({ endpoints: undefined, onlyRunOwnGatePeer: false }), false);
  // A caller that does not say which peer it bound cannot claim the peer is unable to arm.
  assert.equal(
    guardianCanArm({ endpoints: ["GameBuddy.HostGuardian.0123456789abcdef"], onlyRunOwnGatePeer: true }),
    false,
  );
});

test("the earlier links of the chain name themselves", () => {
  const registration = classifyLaunchRefusal({
    step: LAUNCH_STEPS.installation,
    code: "state_unavailable",
    guardian: GATE_PEER,
  });
  assert.equal(registration.verdict, VERDICTS.notMeasured);
  assert.equal(registration.reason, "installation_registration_refused");

  const activation = classifyLaunchRefusal({
    step: LAUNCH_STEPS.activation,
    code: "state_unavailable",
    guardian: GATE_PEER,
  });
  assert.equal(activation.reason, "lifecycle_activation_refused");

  const notStaged = classifyLaunchRefusal({
    step: LAUNCH_STEPS.launch,
    code: "game_prerequisites_missing",
    guardian: GATE_PEER,
  });
  assert.equal(notStaged.verdict, VERDICTS.notMeasured);
  assert.equal(notStaged.reason, "game_prerequisites_missing");
});

test("a launch refused for any other reason is the product's failure, with its own code in the name", () => {
  const reading = classifyLaunchRefusal({
    step: LAUNCH_STEPS.launch,
    code: "state_unavailable",
    guardian: REAL_SUPERVISOR,
  });
  assert.equal(reading.verdict, VERDICTS.failed);
  assert.equal(reading.reason, "game_launch_unavailable:state_unavailable");
});

test("a launch that got no answer at all is the same prerequisite, reached through the transport", () => {
  const silenced = classifySilentLaunch({
    guardian: GATE_PEER,
    detail: "the page's own state route answered net::ERR_CONNECTION_REFUSED and the Host stops answering its port",
  });
  assert.equal(silenced.verdict, VERDICTS.notMeasured);
  assert.equal(silenced.reason, "guardian_pipe_unreachable");
  assert.match(silenced.detail, /ERR_CONNECTION_REFUSED/u);
  assert.match(silenced.detail, /gate peer \(hello-only: the generation publishes no resident Guardian\)/u);
  // With an endpoint that can arm bound, the same silence is the Host's own failure - including when
  // that endpoint is this run's OWN peer, now that it brokers arm/launch/contain for real.
  const fatal = classifySilentLaunch({ guardian: REAL_SUPERVISOR, detail: "the Host stopped answering its port" });
  assert.equal(fatal.verdict, VERDICTS.failed);
  assert.equal(fatal.reason, "game_never_reached_ready:host_silent_on_launch");
  const ownPeerSilenced = classifySilentLaunch({
    guardian: GATE_PEER_ARMABLE,
    detail: "the page's own state route answered net::ERR_CONNECTION_REFUSED",
  });
  assert.equal(ownPeerSilenced.verdict, VERDICTS.failed);
  assert.equal(ownPeerSilenced.reason, "game_never_reached_ready:host_silent_on_launch");
  assert.match(ownPeerSilenced.detail, /armable: it runs the generation's resident Guardian/u);
});

/**
 * The lifecycle shapes, in the words the product's own derivation uses
 * (`dialogue-web/src/game-lifecycle-controls.ts:89-99,388-408`): activation exists for `none` with no
 * generation, the launch control for `none` with one, and neither for an instance that exists.
 *
 * Measured 2026-11-15: the state drivers answered this question by hand as `instanceStatus === "none"`, which
 * reads an instance that EXISTS as a lifecycle nobody activated - so a probe that was handed a real
 * `launching` instance hunted an activation control the product forbids in that shape for 30 s and then named
 * the whole lifecycle `game_lifecycle_not_activated`.
 */
test("an existing instance is a lifecycle that was activated, whatever word it carries", () => {
  assert.equal(lifecycleShapeOf({ instanceStatus: "launching", instanceGeneration: 2 }), LIFECYCLE_SHAPES.instantiated);
  assert.equal(lifecycleShapeOf({ instanceStatus: "running", instanceGeneration: 2 }), LIFECYCLE_SHAPES.instantiated);
  assert.equal(lifecycleShapeOf({ instanceStatus: "stopped", instanceGeneration: 2 }), LIFECYCLE_SHAPES.instantiated);
  assert.equal(lifecycleShapeOf({ instanceStatus: "crashed", instanceGeneration: 2 }), LIFECYCLE_SHAPES.instantiated);
  // Nothing running: the generation is what separates the shape activation belongs to from the launch's.
  assert.equal(lifecycleShapeOf({ instanceStatus: "none", instanceGeneration: 0 }), LIFECYCLE_SHAPES.unactivated);
  assert.equal(lifecycleShapeOf({ instanceStatus: "none", instanceGeneration: 1 }), LIFECYCLE_SHAPES.activated);
  // `unread` is the product's own word for "no reading of the game", and a route that carried no word is the
  // same absence: neither is evidence that an instance exists or that activation is due.
  assert.equal(lifecycleShapeOf({ instanceStatus: "unread", instanceGeneration: 3 }), LIFECYCLE_SHAPES.unread);
  assert.equal(lifecycleShapeOf({ instanceStatus: null, instanceGeneration: null }), LIFECYCLE_SHAPES.unread);
  assert.equal(lifecycleShapeOf({}), LIFECYCLE_SHAPES.unread);
});

test("an instance stuck at launching is the instance-word gap, and only a plateau proves it", () => {
  const stuck = { ok: true, instanceStatus: "launching", attachmentStatus: "none" };
  const proved = classifyChainStop({ state: stuck, unchangedForMs: LAUNCH_PLATEAU_MS });
  assert.equal(proved.verdict, VERDICTS.blockedByProduct);
  assert.equal(proved.gap, PRODUCT_GAPS.instanceStatusNeverRunning);
  assert.match(proved.detail, /stayed instance=launching\/attachment=none for 120s/u, "the plateau it read");
  assert.match(proved.detail, /ownership=player_external/u, "and why the word cannot move");
  // One millisecond short of the plateau is a launch that may still be moving: no proof, no verdict.
  assert.equal(classifyChainStop({ state: stuck, unchangedForMs: LAUNCH_PLATEAU_MS - 1 }), null);
  // A window the caller declares shorter is the caller's own plateau: the state drivers pass their budget.
  assert.equal(
    classifyChainStop({ state: stuck, unchangedForMs: 50, plateauMs: 50 }).gap,
    PRODUCT_GAPS.instanceStatusNeverRunning,
  );
  // And an attachment that landed is the OTHER side of the same gap, proved without a plateau at all.
  assert.equal(
    classifyChainStop({ state: { ...stuck, attachmentStatus: "attached" } }).gap,
    PRODUCT_GAPS.instanceStatusNeverRunning,
  );
  // An instance that is moving, or whose attachment failed, is not this gap.
  assert.equal(
    classifyChainStop({
      state: { ok: true, instanceStatus: "launching", attachmentStatus: "failed" },
      unchangedForMs: LAUNCH_PLATEAU_MS,
    }),
    null,
  );
  assert.equal(
    classifyChainStop({
      state: { ok: true, instanceStatus: "running", attachmentStatus: "none" },
      unchangedForMs: LAUNCH_PLATEAU_MS,
    }),
    null,
  );
  assert.equal(
    classifyChainStop({ state: { ...stuck, ok: false, status: 409 }, unchangedForMs: LAUNCH_PLATEAU_MS }),
    null,
  );
});

test("readiness is one exact pair; a dead instance is a failure rather than a wait", () => {
  assert.equal(readinessOf({ instanceStatus: "running", attachmentStatus: "attached" }), "ready");
  assert.equal(readinessOf({ instanceStatus: "launching", attachmentStatus: "pending" }), "pending");
  assert.equal(readinessOf({ instanceStatus: "none", attachmentStatus: "none" }), "pending");
  assert.equal(readinessOf({ instanceStatus: "crashed", attachmentStatus: "none" }), "failed");
  assert.equal(readinessOf({ instanceStatus: "stopped", attachmentStatus: "none" }), "failed");
  assert.equal(readinessOf({ instanceStatus: "running", attachmentStatus: "failed" }), "failed");
  assert.match(
    describeGameState({ instanceStatus: "launching", attachmentStatus: "pending" }),
    /instance=launching\/attachment=pending/u,
  );
  assert.match(describeGameState({}), /unobserved/u);
});

test("the not-measured line round-trips, and a driver that measured reads as null", () => {
  const line = notMeasuredLine("guardian_pipe_unreachable", "launch refused with game_unavailable");
  assert.equal(line, "NOT-MEASURED: guardian_pipe_unreachable: launch refused with game_unavailable");
  assert.deepEqual(readNotMeasured(`noise\n${line}\nmore`), {
    reason: "guardian_pipe_unreachable",
    detail: "launch refused with game_unavailable",
  });
  assert.equal(readNotMeasured("GAME-LAUNCH w: measured"), null);
  assert.equal(readNotMeasured(null), null);
  // A line with no detail still carries its reason: the code is the part a totals line counts.
  assert.deepEqual(readNotMeasured("NOT-MEASURED: guardian_pipe_unreachable"), {
    reason: "guardian_pipe_unreachable",
    detail: "",
  });
});

test("a launch wait prints the state, the refusals, and the launched game's own last line", () => {
  const line = describeLaunchProgress({
    elapsedMs: 45_400,
    state: { ok: true, instanceStatus: "launching", attachmentStatus: "none" },
    problems: [["game/launch", { status: 409, code: "game_prerequisites_missing" }]],
    game: { line: "[06:59:53 TRACE GameBuddy] GameBuddy observed the created Player Host world slot", writtenAtMs: 0 },
  });
  assert.match(line, /elapsed=45s/u);
  assert.match(line, /instance=launching\/attachment=none/u);
  assert.match(line, /game\/launch=game_prerequisites_missing/u);
  assert.match(line, /world slot/u);
  // A route that answered with no bounded code is still named, and an absent log is a fact, not a blank.
  assert.match(
    describeLaunchProgress({
      elapsedMs: 1000,
      state: { ok: false, status: "unreachable:ECONNREFUSED" },
      problems: [["game/stardew/cabins", { status: 404 }]],
      game: null,
    }),
    /state_unreadable:unreachable:ECONNREFUSED .*cabins=404 .*no SMAPI log read/u,
  );
});

test("a plateau names the unchanged tuple, its age, and the game's last word", () => {
  const line = describeLaunchPlateau({
    elapsedMs: 130_000,
    unchangedForMs: 120_000,
    state: { ok: true, instanceStatus: "launching", attachmentStatus: "none" },
    game: { line: "salient event TimeMilestone skipped: bridge session unavailable.", writtenAtMs: 0 },
  });
  assert.match(line, /^PLATEAU: instance=launching\/attachment=none unchanged for 120s \(elapsed=130s\)/u);
  assert.match(line, /bridge session unavailable/u);
  assert.equal(LAUNCH_PLATEAU_MS >= 60_000, true);
});

test("the chain prints every rung, the elapsed each took, and every rung it never reached", () => {
  const chain = [
    { name: CHAIN_STEPS.launchAdmitted, atMs: 4_000, proof: "the launch route answered HTTP 200" },
    { name: CHAIN_STEPS.guardianArmed, atMs: 5_500, proof: "this run's own broker started the Guardian" },
    { name: CHAIN_STEPS.processStarted, atMs: 9_000, proof: "StardewModdingAPI pid 1856" },
    { name: CHAIN_STEPS.saveLoaded, atMs: 9_400, proof: "loaded save 'GameBuddyFarm_451234657'" },
    { name: CHAIN_STEPS.cabinBuilt, atMs: 13_000, proof: "cabins_now=1" },
    { name: CHAIN_STEPS.cabinReadAuto, atMs: 14_000, proof: "7 request(s), none pressed by this driver" },
    { name: CHAIN_STEPS.cabinConfirm, atMs: 74_000, proof: "the confirm route answered HTTP 409" },
  ];
  const lines = describeChain(chain);
  assert.equal(lines.length, CHAIN_RUNGS.length);
  assert.match(lines[0], /^CHAIN 1\/9 launch admitted @4s - the launch route answered HTTP 200$/u);
  assert.match(lines[5], /^CHAIN 6\/9 cabin read\(auto\) @14s - /u);
  // The rungs the run never reached are printed BY NAME: a reader must not have to infer the stop, and
  // "the confirmation went out" is not the same fact as "the game took it".
  assert.equal(lines[7], "CHAIN 8/9 cabin confirm accepted - not reached");
  assert.equal(lines[8], "CHAIN 9/9 attach - not reached");
  assert.deepEqual(
    chain.filter((entry) => entry.name === CHAIN_STEPS.cabinReadAuto).map((entry) => entry.name),
    ["cabin read(auto)"],
  );
  // The two spellings of the read rung are one rung, so a pressed read is not an extra step.
  const pressed = describeChain([
    { name: CHAIN_STEPS.launchAdmitted, atMs: 1_000, proof: "admitted" },
    { name: CHAIN_STEPS.cabinReadPressed, atMs: 2_000, proof: "after this driver pressed the refresh control" },
  ]);
  assert.match(pressed[5], /^CHAIN 6\/9 cabin read\(pressed\) @2s - /u);
  assert.equal(pressed[6], "CHAIN 7/9 cabin confirm - not reached");
  assert.equal(pressed[7], "CHAIN 8/9 cabin confirm accepted - not reached");
  assert.equal(describeChain([])[0], "CHAIN: no rung of the launch chain was reached");
});

test("the chain is one field on the report's line, and an empty one says so", () => {
  assert.equal(
    chainStepsLine([
      { name: CHAIN_STEPS.launchAdmitted },
      { name: CHAIN_STEPS.guardianArmed },
      { name: CHAIN_STEPS.cabinReadAuto },
    ]),
    "launch admitted>guardian armed>cabin read(auto)",
  );
  assert.equal(chainStepsLine([]), "none");
  assert.equal(CHAIN_STEP_NAMES.length, CHAIN_RUNGS.length + 1);
  assert.equal(CHAIN_STEP_NAMES.includes(CHAIN_STEPS.cabinReadPressed), true);
});

test("a product gap is a third verdict with its own line, and it round-trips", () => {
  const line = blockedByProductLine(PRODUCT_GAPS.cabinOfferExpiresBeforeAnyUiCanAnswer, "two reads of one beat");
  assert.equal(line, "BLOCKED-BY-PRODUCT: cabin_offer_expires_before_any_ui_can_answer: two reads of one beat");
  assert.deepEqual(readBlockedByProduct(`noise\n${line}\nmore`), {
    gap: "cabin_offer_expires_before_any_ui_can_answer",
    detail: "two reads of one beat",
  });
  // A driver that measured, and one that measured nothing, carry neither word.
  assert.equal(readBlockedByProduct("GAME-LAUNCH w: measured launch=ready"), null);
  assert.equal(readBlockedByProduct(notMeasuredLine("game_install_absent", "nowhere")), null);
  assert.equal(readBlockedByProduct(null), null);
});

test("an attachment that landed proves the instance-word gap, and says nothing about anything else", () => {
  const reading = classifyChainStop({
    state: { ok: true, instanceStatus: "launching", attachmentStatus: "attached" },
    attachmentResponse: {
      state: "ready",
      reasonCode: "manifest_issued",
      manifestPath: "stardew-farmhand-manifest.json",
      updatedAtUnixMs: 5_000,
    },
    confirmPressedAtMs: 4_000,
  });
  assert.equal(reading.verdict, VERDICTS.blockedByProduct);
  assert.equal(reading.gap, PRODUCT_GAPS.instanceStatusNeverRunning);
  assert.match(reading.detail, /ownership=player_external/u);
});

test("a state this Mod cannot answer proves no gap, however fresh the file holding it", () => {
  const state = { ok: true, instanceStatus: "launching", attachmentStatus: "none" };
  // `awaiting_save` is not a state the Mod answers: `HostFarmhandProvisioner.HandleRequest` mints the manifest
  // from the binding it just verified (`state=ready`/`manifest_issued`) and owes the write to the engine's next
  // `Saving`. A file that still says `awaiting_save` is a write from an older Mod, so it proves nothing about
  // this run and names no product gap.
  assert.equal(
    classifyChainStop({
      state,
      attachmentResponse: { state: "awaiting_save", reasonCode: "binding_persist_pending", updatedAtUnixMs: 1_000_000 },
      confirmPressedAtMs: 999_000,
    }),
    null,
  );
  // And an answer that is not the gap's own proof proves nothing either: the Mod's `farmhand_not_initialized`
  // word needs the Host's own 409 beside it (the test below holds that half), a ready answer needs an instance
  // word that moved, and a response this run did not cause is a reading about an earlier run.
  for (const attachmentResponse of [
    null,
    { state: "ready", reasonCode: "none", updatedAtUnixMs: 1_000_000 },
    { state: "rejected", reasonCode: "farmhand_not_initialized", updatedAtUnixMs: 1_000_000 },
    { state: "ready", reasonCode: "none", updatedAtUnixMs: 1_000 },
  ])
    assert.equal(classifyChainStop({ state, attachmentResponse, confirmPressedAtMs: 999_000 }), null);
  assert.equal(
    classifyChainStop({
      state,
      attachmentResponse: { state: "rejected", reasonCode: "farmhand_not_initialized", updatedAtUnixMs: 1_000_000 },
      confirmPressedAtMs: null,
    }),
    null,
  );
});

test("a ready pair proves no gap, and neither does a launch that never produced an attachment", () => {
  assert.equal(
    classifyChainStop({ state: { ok: true, instanceStatus: "running", attachmentStatus: "attached" } }),
    null,
  );
  assert.equal(classifyChainStop({ state: { ok: false, status: "unreachable:ECONNREFUSED" } }), null);
  assert.equal(classifyChainStop({ state: { ok: true, instanceStatus: "launching", attachmentStatus: "none" } }), null);
});

test("a confirmation the game refused as stale, against offers of one beat, proves the offer's window", () => {
  const state = { ok: true, instanceStatus: "launching", attachmentStatus: "none" };
  const reading = classifyChainStop({
    state,
    confirmPressedAtMs: 1_000_000,
    cabinConfirm: {
      requested: 3,
      refusals: [{ status: 409, code: "stardew_cabin_choice_stale" }],
      offers: [
        { readAtMs: 990_000, expiresAtMs: 992_871 },
        { readAtMs: 991_000, expiresAtMs: 993_902 },
      ],
    },
  });
  assert.equal(reading.verdict, VERDICTS.blockedByProduct);
  assert.equal(reading.gap, PRODUCT_GAPS.cabinOfferExpiresBeforeAnyUiCanAnswer);
  // Both sides are quoted: the game's refusal by name, and two consecutive windows side by side.
  assert.match(reading.detail, /HTTP 409 stardew_cabin_choice_stale/u);
  assert.match(reading.detail, /expiresAtMs=992871 .*\(2871ms left\) then expiresAtMs=993902 .*\(2902ms left\)/u);
  assert.match(reading.detail, /HostFarmhandProvisioner\.cs/u);
});

test("the offer's window is proved by the run, so a refusal alone or a long window proves nothing", () => {
  const state = { ok: true, instanceStatus: "launching", attachmentStatus: "none" };
  const refused = { status: 409, code: "stardew_cabin_choice_stale" };
  const shortOffers = [
    { readAtMs: 990_000, expiresAtMs: 992_871 },
    { readAtMs: 991_000, expiresAtMs: 993_902 },
  ];
  const classify = (cabinConfirm) => classifyChainStop({ state, confirmPressedAtMs: 1_000_000, cabinConfirm });
  // The page answered its own press: no confirmation ever reached the game, so no window was tested.
  assert.equal(classify({ requested: 0, refusals: [refused], offers: shortOffers }), null);
  // A confirmation went out and was accepted or refused for some other reason: not this gap.
  assert.equal(classify({ requested: 1, refusals: [], offers: shortOffers }), null);
  assert.equal(
    classify({ requested: 1, refusals: [{ status: 409, code: "stardew_cabin_choice_expired" }], offers: shortOffers }),
    null,
  );
  // One reading cannot tell a re-minted window from a fixed one, and a long window is not this gap.
  assert.equal(classify({ requested: 1, refusals: [refused], offers: [shortOffers[0]] }), null);
  assert.equal(
    classify({
      requested: 1,
      refusals: [refused],
      offers: [
        { readAtMs: 990_000, expiresAtMs: 1_290_000 },
        { readAtMs: 991_000, expiresAtMs: 1_291_000 },
      ],
    }),
    null,
  );
});

/*
 * The run the farmhand gap is named after (2026-11-15, `.live-runs/runconfirm/w-game-launch.txt`): the
 * choice was pressed at 1794705319241, the Mod answered `rejected`/`farmhand_not_initialized` at
 * 1794705319293 (52 ms), and the Host answered the SAME confirmation 409 at 1794705319403.
 */
const FARMHAND_RUN = Object.freeze({
  state: Object.freeze({ ok: true, instanceStatus: "launching", attachmentStatus: "none" }),
  confirmPressedAtMs: 1_794_705_319_241,
  attachmentResponse: Object.freeze({
    file: "56d27312-f52b-401f-bd6a-eb10a60e85ad",
    schemaVersion: 1,
    requestId: "37c8454b589b4b0eaf858d9a910dafad",
    state: "rejected",
    reasonCode: "farmhand_not_initialized",
    updatedAtUnixMs: 1_794_705_319_293,
    signature: "cMSpz5fKHFbZOoaFun9DJtkZO4PvLmE40Wz_TUAwMRE",
  }),
  cabinConfirm: Object.freeze({
    requested: 1,
    refusals: Object.freeze([{ status: 409, code: "stardew_manifest_handoff_uncertain" }]),
    offers: Object.freeze([{ readAtMs: 1_794_705_318_314, expiresAtMs: 1_794_705_320_401 }]),
  }),
});
const farmhandReading = (overrides = {}) => classifyChainStop({ ...FARMHAND_RUN, ...overrides });

test("a farmhand the Mod created and rolled back proves its own gap, with both sides quoted", () => {
  const reading = farmhandReading();
  assert.equal(reading.verdict, VERDICTS.blockedByProduct);
  assert.equal(reading.gap, PRODUCT_GAPS.farmhandNotInitialized);
  // The word the report and the run's totals print, as a LITERAL: a comparison against the same object
  // would stay green if the gap left `PRODUCT_GAPS`, and the driver would then print a gap with no name.
  assert.equal(blockedByProductLine(reading.gap, "x"), "BLOCKED-BY-PRODUCT: farmhand_not_initialized: x");
  // The Mod's side: its own word, its own stamp, and the latency the press caused.
  assert.match(reading.detail, /state=rejected\/reason=farmhand_not_initialized/u);
  assert.match(reading.detail, /52ms after the press/u);
  // The Host's side: the code it answered the same confirmation with.
  assert.match(reading.detail, /HTTP 409 stardew_manifest_handoff_uncertain/u);
  assert.match(reading.detail, /HostFarmhandProvisioner\.cs/u);
});

/**
 * THE GATE `every_gap_declared_is_a_gap_produced`: the gap names are one fact, and this file holds both
 * spellings of it - `PRODUCT_GAPS`, and the classifier that returns one of its members. A member whose
 * producer is deleted stays in the object and is printed by the driver as a gap nothing can prove: that
 * is exactly how `attach_needs_native_save` outlived the `awaiting_save` answer it named, and why the
 * population below is derived from the object rather than written out a second time.
 */
test("every gap the verdict declares is a gap some chain stop can still produce", () => {
  const stops = [
    classifyChainStop({ state: { ok: true, instanceStatus: "launching", attachmentStatus: "attached" } }),
    classifyChainStop({
      state: { ok: true, instanceStatus: "launching", attachmentStatus: "none" },
      confirmPressedAtMs: 1_000_000,
      cabinConfirm: {
        requested: 3,
        refusals: [{ status: 409, code: "stardew_cabin_choice_stale" }],
        offers: [
          { readAtMs: 990_000, expiresAtMs: 992_871 },
          { readAtMs: 991_000, expiresAtMs: 993_902 },
        ],
      },
    }),
    farmhandReading(),
  ];
  const declared = Object.values(PRODUCT_GAPS);
  const produced = new Set(stops.map((reading) => reading?.gap).filter(Boolean));
  for (const gap of declared)
    assert.ok(
      produced.has(gap),
      `${gap} is declared in PRODUCT_GAPS and no chain stop here produces it, so the driver would print a gap nothing can prove`,
    );
  for (const gap of produced)
    assert.ok(declared.includes(gap), `${String(gap)} was produced and is not declared in PRODUCT_GAPS`);
  assert.equal(produced.size, declared.length);
});

test("one side of the farmhand gap is not the gap, so a run holding one stays failed", () => {
  // The Host's 409 without the Mod's file is an uncertainty with no named cause.
  assert.equal(farmhandReading({ attachmentResponse: null }), null);
  // The Mod's file without the Host's answer is a write this run cannot tie to its own confirmation.
  assert.equal(farmhandReading({ cabinConfirm: { ...FARMHAND_RUN.cabinConfirm, refusals: [] } }), null);
  // A different Host code is a different answer, whatever the Mod wrote.
  assert.equal(
    farmhandReading({
      cabinConfirm: { ...FARMHAND_RUN.cabinConfirm, refusals: [{ status: 409, code: "stardew_cabin_choice_stale" }] },
    }),
    null,
  );
  assert.equal(
    farmhandReading({
      cabinConfirm: {
        ...FARMHAND_RUN.cabinConfirm,
        refusals: [{ status: 400, code: "stardew_manifest_handoff_uncertain" }],
      },
    }),
    null,
  );
  // A different reason code is a different cause, whatever the Host answered.
  assert.equal(
    farmhandReading({ attachmentResponse: { ...FARMHAND_RUN.attachmentResponse, reasonCode: "binding_conflict" } }),
    null,
  );
  assert.equal(
    farmhandReading({ attachmentResponse: { ...FARMHAND_RUN.attachmentResponse, state: "uncertain" } }),
    null,
  );
  // A stamp from an earlier launch, or a confirmation this run never sent, proves nothing about this run.
  assert.equal(
    farmhandReading({ attachmentResponse: { ...FARMHAND_RUN.attachmentResponse, updatedAtUnixMs: 1_000 } }),
    null,
  );
  assert.equal(farmhandReading({ confirmPressedAtMs: null }), null);
  assert.equal(farmhandReading({ cabinConfirm: { ...FARMHAND_RUN.cabinConfirm, requested: 0 } }), null);
});

test("the Mod's stamp belongs to the press only within the freshness window, and the driver reads the same rule", () => {
  assert.equal(
    responseStampForPress(FARMHAND_RUN.attachmentResponse, FARMHAND_RUN.confirmPressedAtMs),
    1_794_705_319_293,
  );
  // A response the press did not cause is not this run's: too old to belong to it, or no press at all.
  assert.equal(responseStampForPress(FARMHAND_RUN.attachmentResponse, 1_794_705_400_000), null);
  assert.equal(responseStampForPress(FARMHAND_RUN.attachmentResponse, null), null);
  assert.equal(responseStampForPress(null, FARMHAND_RUN.confirmPressedAtMs), null);
});

/*
 * ---- the launched game's own language ----
 *
 * The lines below are the ones this machine really wrote: the frontend live run's game (English,
 * 2026-11-16 16:27 and `.live-runs/gamewait2`, 2026-11-14) and the game live run's (Chinese, the same
 * machine and the same `startup_preferences`). The verdict is red-proofed against the first of them.
 */
const SAVE_LINE_ENGLISH =
  "[16:27:27 TRACE SMAPI] Context: loaded save 'GameBuddyFarm_451234657', starting summer 1 Y1, locale set to . Main player with 1 player online.";
const SAVE_LINE_CHINESE =
  "[18:30:15 TRACE SMAPI] Context: loaded save 'GameBuddyFixtureStable2_451844707', starting spring 1 Y1, locale set to zh-CN. Single-player.";

test("the game's own locale line reads as the product spells it, both ways", () => {
  assert.equal(liveGameLocaleOf(SAVE_LINE_ENGLISH), "en-US", "the empty suffix is English and nothing else");
  assert.equal(liveGameLocaleOf(SAVE_LINE_CHINESE), "zh-CN");
  // The bare form SMAPI writes when it applies the language, before any save is loaded.
  assert.equal(liveGameLocaleOf("[18:30:15 TRACE SMAPI] Context: locale set to zh (zh-CN)."), "zh-CN");
  // Nothing measured is not English: a line with no locale at all answers null.
  assert.equal(liveGameLocaleOf("[16:27:27 TRACE SMAPI] Context: loaded save 'x'."), null);
  assert.equal(liveGameLocaleOf(null), null);
});

test("a game in another language than the run's is red by name, and agreement is silent", () => {
  const mismatch = gameLocaleMismatch({ expected: "zh-CN", saveLoadedLine: SAVE_LINE_ENGLISH });
  assert.equal(mismatch.code, "game_locale_mismatch:expected zh-CN, saw 'en-US'");
  assert.equal(mismatch.saw, "en-US");
  assert.equal(mismatch.line, SAVE_LINE_ENGLISH);

  assert.equal(gameLocaleMismatch({ expected: "zh-CN", saveLoadedLine: SAVE_LINE_CHINESE }), null);
  // The run seeded no expectation: the game's own preference is the authority and nothing is claimed.
  assert.equal(gameLocaleMismatch({ expected: null, saveLoadedLine: SAVE_LINE_ENGLISH }), null);
  // No save line: nothing was measured, so nothing is failed.
  assert.equal(gameLocaleMismatch({ expected: "zh-CN", saveLoadedLine: null }), null);
});
