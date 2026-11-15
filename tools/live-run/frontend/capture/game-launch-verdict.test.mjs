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
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHAIN_RUNGS,
  CHAIN_STEP_NAMES,
  CHAIN_STEPS,
  LAUNCH_PLATEAU_MS,
  LAUNCH_STEPS,
  PRODUCT_GAPS,
  VERDICTS,
  blockedByProductLine,
  chainStepsLine,
  classifyChainStop,
  classifyLaunchRefusal,
  classifySilentLaunch,
  describeChain,
  describeGameState,
  describeLaunchPlateau,
  describeLaunchProgress,
  guardianCanArm,
  notMeasuredLine,
  readinessOf,
  readBlockedByProduct,
  readNotMeasured,
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
  assert.match(lines[0], /^CHAIN 1\/8 launch admitted @4s - the launch route answered HTTP 200$/u);
  assert.match(lines[5], /^CHAIN 6\/8 cabin read\(auto\) @14s - /u);
  // The rung the run never reached is printed BY NAME: a reader must not have to infer the stop.
  assert.equal(lines[7], "CHAIN 8/8 attach - not reached");
  assert.deepEqual(
    chain.filter((entry) => entry.name === CHAIN_STEPS.cabinReadAuto).map((entry) => entry.name),
    ["cabin read(auto)"],
  );
  // The two spellings of the read rung are one rung, so a pressed read is not an extra step.
  const pressed = describeChain([
    { name: CHAIN_STEPS.launchAdmitted, atMs: 1_000, proof: "admitted" },
    { name: CHAIN_STEPS.cabinReadPressed, atMs: 2_000, proof: "after this driver pressed the refresh control" },
  ]);
  assert.match(pressed[5], /^CHAIN 6\/8 cabin read\(pressed\) @2s - /u);
  assert.equal(pressed[6], "CHAIN 7/8 cabin confirm - not reached");
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
  const line = blockedByProductLine(PRODUCT_GAPS.attachNeedsNativeSave, "the Mod answered awaiting_save");
  assert.equal(line, "BLOCKED-BY-PRODUCT: attach_needs_native_save: the Mod answered awaiting_save");
  assert.deepEqual(readBlockedByProduct(`noise\n${line}\nmore`), {
    gap: "attach_needs_native_save",
    detail: "the Mod answered awaiting_save",
  });
  // A driver that measured, and one that measured nothing, carry neither word.
  assert.equal(readBlockedByProduct("GAME-LAUNCH w: measured launch=ready"), null);
  assert.equal(readBlockedByProduct(notMeasuredLine("game_install_absent", "nowhere")), null);
  assert.equal(readBlockedByProduct(null), null);
});

test("an attachment that landed proves the instance-word gap, and says nothing about a save", () => {
  const reading = classifyChainStop({
    state: { ok: true, instanceStatus: "launching", attachmentStatus: "attached" },
    attachmentResponse: { state: "awaiting_save", reasonCode: "binding_persist_pending", updatedAtUnixMs: 5_000 },
    confirmPressedAtMs: 4_000,
  });
  assert.equal(reading.verdict, VERDICTS.blockedByProduct);
  assert.equal(reading.gap, PRODUCT_GAPS.instanceStatusNeverRunning);
  assert.match(reading.detail, /ownership=player_external/u);
});

test("the save gap needs the Mod's own fresh word for THIS run's confirmation", () => {
  const state = { ok: true, instanceStatus: "launching", attachmentStatus: "none" };
  const fresh = classifyChainStop({
    state,
    attachmentResponse: { state: "awaiting_save", reasonCode: "binding_persist_pending", updatedAtUnixMs: 1_000_000 },
    confirmPressedAtMs: 999_000,
  });
  assert.equal(fresh.verdict, VERDICTS.blockedByProduct);
  assert.equal(fresh.gap, PRODUCT_GAPS.attachNeedsNativeSave);
  assert.match(fresh.detail, /awaiting_save\/reason=binding_persist_pending/u);
  // A response written by an EARLIER run is not a reading about this one.
  assert.equal(
    classifyChainStop({
      state,
      attachmentResponse: { state: "awaiting_save", reasonCode: "binding_persist_pending", updatedAtUnixMs: 1_000 },
      confirmPressedAtMs: 999_000,
    }),
    null,
  );
  // Nor is a confirmation this run never sent, or an answer that is not the save wait.
  assert.equal(
    classifyChainStop({
      state,
      attachmentResponse: { state: "awaiting_save", reasonCode: "binding_persist_pending", updatedAtUnixMs: 1_000_000 },
      confirmPressedAtMs: null,
    }),
    null,
  );
  for (const attachmentResponse of [
    null,
    { state: "ready", reasonCode: "none", updatedAtUnixMs: 1_000_000 },
    { state: "rejected", reasonCode: "farmhand_not_initialized", updatedAtUnixMs: 1_000_000 },
  ])
    assert.equal(classifyChainStop({ state, attachmentResponse, confirmPressedAtMs: 999_000 }), null);
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
