import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedReclamationCode,
  buildDesktopHostExitReason,
  DESKTOP_HOST_RECLAMATION_STEPS,
  runDesktopHostReclamation,
  type DesktopHostReclamationStepOutcome,
} from "./desktop-host-reclamation.js";

test("the reclamation step list is the frozen reverse-teardown order", () => {
  // The names are the report's whole vocabulary: an owner that renames one, or
  // adds one, changes what an operator reads after a failed exit, so the exact
  // list and order are pinned here.
  assert.deepEqual([...DESKTOP_HOST_RECLAMATION_STEPS], [
    "stop_admission",
    "drain_chat_runtime",
    "drain_game_lifecycle",
    "release_shared_authority",
    "release_guardian_session",
    "release_voice_client",
    "release_termination_watchers",
  ]);
  assert.equal(Object.isFrozen(DESKTOP_HOST_RECLAMATION_STEPS), true);
});

test("the reclamation attempts every step in order and names a declared absence instead of skipping it", async () => {
  const attempted: string[] = [];
  const outcomes = await runDesktopHostReclamation([
    { step: "stop_admission", close: async () => { attempted.push("stop_admission"); } },
    { step: "drain_chat_runtime" },
    { step: "release_voice_client", close: async () => { attempted.push("release_voice_client"); } },
  ]);

  assert.deepEqual(attempted, ["stop_admission", "release_voice_client"]);
  assert.deepEqual(outcomes, [
    { step: "stop_admission", status: "completed", failure: null },
    { step: "drain_chat_runtime", status: "not_applicable", failure: null },
    { step: "release_voice_client", status: "completed", failure: null },
  ]);
});

test("a failed step does not stop the reclamation, and the report names the first failure as the exit reason", async () => {
  const attempted: string[] = [];
  const outcomes = await runDesktopHostReclamation([
    { step: "stop_admission", close: async () => { attempted.push("stop_admission"); throw new Error("bridge_session_unavailable"); } },
    { step: "drain_chat_runtime", close: async () => { attempted.push("drain_chat_runtime"); } },
    { step: "release_guardian_session", close: async () => { attempted.push("release_guardian_session"); throw new Error("guardian_pipe_unavailable"); } },
  ]);

  // Every step is still attempted: one surface failing to drain must never leave
  // the step after it - the one that releases the Guardian pipe - unattempted.
  assert.deepEqual(attempted, ["stop_admission", "drain_chat_runtime", "release_guardian_session"]);
  assert.deepEqual(outcomes.map((outcome) => [outcome.step, outcome.status, outcome.failure]), [
    ["stop_admission", "failed", "bridge_session_unavailable"],
    ["drain_chat_runtime", "completed", null],
    ["release_guardian_session", "failed", "guardian_pipe_unavailable"],
  ]);

  const report = buildDesktopHostExitReason(outcomes);
  assert.equal(report.schema, "gamebuddy-desktop-host-exit/v1");
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.reason, "bridge_session_unavailable");
  assert.deepEqual(report.steps, outcomes);
});

test("a clean reclamation reports the clean_exit reason and is the only clean outcome", async () => {
  const clean = buildDesktopHostExitReason(await runDesktopHostReclamation([
    { step: "stop_admission", close: async () => {} },
    { step: "release_termination_watchers", close: async () => {} },
  ]));
  assert.equal(clean.outcome, "clean");
  assert.equal(clean.reason, "clean_exit");

  // An absent resource is not a failure and does not make the exit incomplete.
  const declaredAbsence = buildDesktopHostExitReason(await runDesktopHostReclamation([
    { step: "release_voice_client" },
    { step: "release_termination_watchers", close: async () => {} },
  ]));
  assert.equal(declaredAbsence.outcome, "clean");
  assert.equal(declaredAbsence.reason, "clean_exit");
});

test("only a bounded lowercase code survives as a failure; anything else is replaced, never copied", async () => {
  const outcomes: readonly DesktopHostReclamationStepOutcome[] = [
    { step: "drain_game_lifecycle", status: "failed", failure: boundedReclamationCode(new Error("E:\\projects\\ai-game-companion\\secret.json")) },
  ];
  const report = buildDesktopHostExitReason(outcomes);
  assert.equal(report.reason, "desktop_host_close_step_failed");
  assert.equal(report.reason.includes("secret.json"), false);

  // The codes the project already speaks are kept verbatim, because an operator
  // matches on them.
  assert.equal(boundedReclamationCode(new Error("desktop_runtime_bootstrap_unavailable")), "desktop_runtime_bootstrap_unavailable");
  assert.equal(boundedReclamationCode(new Error("bridge_disconnected:pipe_gone")), "bridge_disconnected:pipe_gone");
  assert.equal(boundedReclamationCode(new Error("at Object.<anonymous>")), "desktop_host_close_step_failed");
  assert.equal(boundedReclamationCode(undefined), "desktop_host_close_step_failed");
});
