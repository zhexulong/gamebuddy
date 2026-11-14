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
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAUNCH_PLATEAU_MS,
  LAUNCH_STEPS,
  VERDICTS,
  classifyLaunchRefusal,
  classifySilentLaunch,
  describeGameState,
  describeLaunchPlateau,
  describeLaunchProgress,
  guardianCanArm,
  notMeasuredLine,
  readinessOf,
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
