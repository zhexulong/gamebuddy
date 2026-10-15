import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedReclamationCode,
  buildDesktopHostExitReason,
  DESKTOP_HOST_DRAIN_TIMEOUT_FAILURE,
  DESKTOP_HOST_DRAIN_TIMEOUT_MS,
  DESKTOP_HOST_RECLAMATION_STEPS,
  runDesktopHostReclamation,
  type DesktopHostReclamationStepOutcome,
} from "./desktop-host-reclamation.js";

/**
 * The budget the drain-timeout tests drive: short enough that a step which never
 * settles is named instead of hanging the suite. The production budget is
 * `DESKTOP_HOST_DRAIN_TIMEOUT_MS` and is passed by every caller, so nothing here
 * asserts against a latency target either way.
 */
const TEST_DRAIN_TIMEOUT_MS = 20;

test("the reclamation step list is the frozen reverse-teardown order", () => {
  // The names are the report's whole vocabulary: an owner that renames one, or
  // adds one, changes what an operator reads after a failed exit, so the exact
  // list and order are pinned here.
  assert.deepEqual(
    [...DESKTOP_HOST_RECLAMATION_STEPS],
    [
      "stop_admission",
      "drain_chat_runtime",
      "drain_game_lifecycle",
      "reflect_session",
      "release_shared_authority",
      "release_guardian_session",
      "release_voice_client",
      "release_termination_watchers",
    ],
  );
  assert.equal(Object.isFrozen(DESKTOP_HOST_RECLAMATION_STEPS), true);
});

test("the reclamation attempts every step in order and names a declared absence instead of skipping it", async () => {
  const attempted: string[] = [];
  const outcomes = await runDesktopHostReclamation(
    [
      {
        step: "stop_admission",
        close: async () => {
          attempted.push("stop_admission");
        },
      },
      { step: "drain_chat_runtime" },
      {
        step: "release_voice_client",
        close: async () => {
          attempted.push("release_voice_client");
        },
      },
    ],
    DESKTOP_HOST_DRAIN_TIMEOUT_MS,
  );

  assert.deepEqual(attempted, ["stop_admission", "release_voice_client"]);
  assert.deepEqual(outcomes, [
    { step: "stop_admission", status: "completed", failure: null },
    { step: "drain_chat_runtime", status: "not_applicable", failure: null },
    { step: "release_voice_client", status: "completed", failure: null },
  ]);
});

test("a failed step does not stop the reclamation, and the report names the first failure as the exit reason", async () => {
  const attempted: string[] = [];
  const outcomes = await runDesktopHostReclamation(
    [
      {
        step: "stop_admission",
        close: async () => {
          attempted.push("stop_admission");
          throw new Error("bridge_session_unavailable");
        },
      },
      {
        step: "drain_chat_runtime",
        close: async () => {
          attempted.push("drain_chat_runtime");
        },
      },
      {
        step: "release_guardian_session",
        close: async () => {
          attempted.push("release_guardian_session");
          throw new Error("guardian_pipe_unavailable");
        },
      },
    ],
    DESKTOP_HOST_DRAIN_TIMEOUT_MS,
  );

  // Every step is still attempted: one surface failing to drain must never leave
  // the step after it - the one that releases the Guardian pipe - unattempted.
  assert.deepEqual(attempted, ["stop_admission", "drain_chat_runtime", "release_guardian_session"]);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.step, outcome.status, outcome.failure]),
    [
      ["stop_admission", "failed", "bridge_session_unavailable"],
      ["drain_chat_runtime", "completed", null],
      ["release_guardian_session", "failed", "guardian_pipe_unavailable"],
    ],
  );

  const report = buildDesktopHostExitReason(outcomes);
  assert.equal(report.schema, "gamebuddy-desktop-host-exit/v1");
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.reason, "bridge_session_unavailable");
  assert.deepEqual(report.steps, outcomes);
});

test("a clean reclamation reports the clean_exit reason and is the only clean outcome", async () => {
  const clean = buildDesktopHostExitReason(
    await runDesktopHostReclamation(
      [
        { step: "stop_admission", close: async () => {} },
        { step: "release_termination_watchers", close: async () => {} },
      ],
      DESKTOP_HOST_DRAIN_TIMEOUT_MS,
    ),
  );
  assert.equal(clean.outcome, "clean");
  assert.equal(clean.reason, "clean_exit");

  // An absent resource is not a failure and does not make the exit incomplete.
  const declaredAbsence = buildDesktopHostExitReason(
    await runDesktopHostReclamation(
      [{ step: "release_voice_client" }, { step: "release_termination_watchers", close: async () => {} }],
      DESKTOP_HOST_DRAIN_TIMEOUT_MS,
    ),
  );
  assert.equal(declaredAbsence.outcome, "clean");
  assert.equal(declaredAbsence.reason, "clean_exit");
});

test("only a bounded lowercase code survives as a failure; anything else is replaced, never copied", async () => {
  const outcomes: readonly DesktopHostReclamationStepOutcome[] = [
    {
      step: "drain_game_lifecycle",
      status: "failed",
      failure: boundedReclamationCode(new Error("E:\\projects\\ai-game-companion\\secret.json")),
    },
  ];
  const report = buildDesktopHostExitReason(outcomes);
  assert.equal(report.reason, "desktop_host_close_step_failed");
  assert.equal(report.reason.includes("secret.json"), false);

  // The codes the project already speaks are kept verbatim, because an operator
  // matches on them.
  assert.equal(
    boundedReclamationCode(new Error("desktop_runtime_bootstrap_unavailable")),
    "desktop_runtime_bootstrap_unavailable",
  );
  assert.equal(boundedReclamationCode(new Error("bridge_disconnected:pipe_gone")), "bridge_disconnected:pipe_gone");
  assert.equal(boundedReclamationCode(new Error("at Object.<anonymous>")), "desktop_host_close_step_failed");
  assert.equal(boundedReclamationCode(undefined), "desktop_host_close_step_failed");
});

test("a step that never settles is named as a failed drain on its own step, and the steps behind it are still attempted", async () => {
  const attempted: string[] = [];
  let releaseAbandonedStep!: () => void;
  const neverSettles = new Promise<void>((resolve) => {
    releaseAbandonedStep = resolve;
  });
  const outcomes = await runDesktopHostReclamation(
    [
      {
        step: "stop_admission",
        close: async () => {
          attempted.push("stop_admission");
        },
      },
      {
        step: "drain_game_lifecycle",
        close: () => {
          attempted.push("drain_game_lifecycle");
          return neverSettles;
        },
      },
      {
        step: "release_guardian_session",
        close: async () => {
          attempted.push("release_guardian_session");
        },
      },
    ],
    TEST_DRAIN_TIMEOUT_MS,
  );

  // The whole point of naming the timeout: a step that cannot finish is a findable
  // fact about THAT step, and it must not leave the steps behind it - the one that
  // releases the Guardian pipe above all - unattempted.
  assert.deepEqual(attempted, ["stop_admission", "drain_game_lifecycle", "release_guardian_session"]);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.step, outcome.status, outcome.failure]),
    [
      ["stop_admission", "completed", null],
      ["drain_game_lifecycle", "failed", "desktop_host_drain_timeout"],
      ["release_guardian_session", "completed", null],
    ],
  );

  const report = buildDesktopHostExitReason(outcomes);
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.reason, DESKTOP_HOST_DRAIN_TIMEOUT_FAILURE);
  assert.equal(DESKTOP_HOST_DRAIN_TIMEOUT_FAILURE, "desktop_host_drain_timeout");

  releaseAbandonedStep();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
});

test("a close that refuses after its drain budget expired is observed, so the abandoned step cannot become an unhandled rejection", async () => {
  let refuseLate!: (error: unknown) => void;
  const refusesAfterTheBudget = new Promise<void>((_resolve, reject) => {
    refuseLate = reject;
  });
  const outcomes = await runDesktopHostReclamation(
    [{ step: "drain_chat_runtime", close: () => refusesAfterTheBudget }],
    TEST_DRAIN_TIMEOUT_MS,
  );

  assert.deepEqual(outcomes, [
    { step: "drain_chat_runtime", status: "failed", failure: DESKTOP_HOST_DRAIN_TIMEOUT_FAILURE },
  ]);

  // The abandoned close refuses after the reclamation has already reported and
  // moved on. An unsaved rejection here would kill this process before the exit
  // record the timeout exists to complete was written, so this turn must be
  // silent: a rejected promise with no observer fails the run that this test is.
  refuseLate(new Error("bridge_disconnected:pipe_gone"));
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
});

test("a close that throws synchronously is one failure of its own step, not a reclamation that stops there", async () => {
  const attempted: string[] = [];
  const outcomes = await runDesktopHostReclamation(
    [
      {
        step: "drain_game_lifecycle",
        close: () => {
          attempted.push("drain_game_lifecycle");
          throw new Error("stardew_lifecycle_close_incomplete");
        },
      },
      {
        step: "release_shared_authority",
        close: async () => {
          attempted.push("release_shared_authority");
        },
      },
    ],
    TEST_DRAIN_TIMEOUT_MS,
  );

  assert.deepEqual(attempted, ["drain_game_lifecycle", "release_shared_authority"]);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.step, outcome.status, outcome.failure]),
    [
      ["drain_game_lifecycle", "failed", "stardew_lifecycle_close_incomplete"],
      ["release_shared_authority", "completed", null],
    ],
  );
});
