import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedReclamationCode,
  buildDesktopHostExitReason,
  DESKTOP_HOST_CHILD_WILL_NOT_STOP_FAILURE,
  DESKTOP_HOST_CLOSE_STEP_FAILED,
  DESKTOP_HOST_DRAIN_TIMEOUT_FAILURE,
  DESKTOP_HOST_DRAIN_TIMEOUT_MS,
  DESKTOP_HOST_RECLAMATION_STEP_KIND,
  DESKTOP_HOST_RECLAMATION_STEPS,
  DESKTOP_HOST_RESOURCE_STILL_HELD_FAILURE,
  nameDesktopHostReclamationFailure,
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

test("the step kinds are the frozen declaration of what each step is trying to give up", () => {
  // A step that did not name itself is named by its kind, so an owner that
  // reclassifies one changes what an operator reads after a failed exit. Pin the
  // exact map and the fact that it is frozen.
  assert.deepEqual(DESKTOP_HOST_RECLAMATION_STEP_KIND, {
    stop_admission: "resource",
    drain_chat_runtime: "child",
    drain_game_lifecycle: "child",
    reflect_session: "other",
    release_shared_authority: "other",
    release_guardian_session: "resource",
    release_voice_client: "resource",
    release_termination_watchers: "other",
  });
  assert.equal(Object.isFrozen(DESKTOP_HOST_RECLAMATION_STEP_KIND), true);
});

test("the naming decision is pure: each way a step can fail gets its own name, and a completed step gets none", () => {
  assert.equal(nameDesktopHostReclamationFailure("drain_game_lifecycle", { outcome: "completed" }), null);
  // A step that never settled is a drain timeout whatever it owned: the budget,
  // not the resource, is the fact.
  assert.equal(
    nameDesktopHostReclamationFailure("drain_game_lifecycle", { outcome: "timed_out" }),
    DESKTOP_HOST_DRAIN_TIMEOUT_FAILURE,
  );
  assert.equal(
    nameDesktopHostReclamationFailure("stop_admission", { outcome: "timed_out" }),
    DESKTOP_HOST_DRAIN_TIMEOUT_FAILURE,
  );
  // A child that will not stop, and a port/pipe that is still held, are named by
  // what the step owned - and only when the step did not name itself.
  assert.equal(
    nameDesktopHostReclamationFailure("drain_game_lifecycle", { outcome: "rejected", error: new Error("E:\\secret\\path") }),
    DESKTOP_HOST_CHILD_WILL_NOT_STOP_FAILURE,
  );
  assert.equal(
    nameDesktopHostReclamationFailure("drain_chat_runtime", { outcome: "rejected", error: undefined }),
    DESKTOP_HOST_CHILD_WILL_NOT_STOP_FAILURE,
  );
  assert.equal(
    nameDesktopHostReclamationFailure("stop_admission", { outcome: "rejected", error: new Error("C:\\x") }),
    DESKTOP_HOST_RESOURCE_STILL_HELD_FAILURE,
  );
  assert.equal(
    nameDesktopHostReclamationFailure("release_guardian_session", { outcome: "rejected", error: undefined }),
    DESKTOP_HOST_RESOURCE_STILL_HELD_FAILURE,
  );
  // A step with neither a child nor a held resource keeps the generic code: the
  // naming adds facts, it never invents one.
  assert.equal(
    nameDesktopHostReclamationFailure("release_shared_authority", { outcome: "rejected", error: new Error("something went wrong") }),
    DESKTOP_HOST_CLOSE_STEP_FAILED,
  );
  // A step's own bounded code is preserved whatever it owned: an operator
  // matches on those codes, so the naming must never overwrite one.
  assert.equal(
    nameDesktopHostReclamationFailure("stop_admission", { outcome: "rejected", error: new Error("bridge_session_unavailable") }),
    "bridge_session_unavailable",
  );
  assert.equal(
    nameDesktopHostReclamationFailure("drain_game_lifecycle", {
      outcome: "rejected",
      error: new Error("stardew_lifecycle_close_incomplete"),
    }),
    "stardew_lifecycle_close_incomplete",
  );
});

test("a step that cannot give up its child or its port is named on that step, never left silent", async () => {
  const outcomes = await runDesktopHostReclamation(
    [
      {
        step: "stop_admission",
        close: async () => {
          throw new Error("E:\\projects\\ai-game-companion\\secret-port-binding");
        },
      },
      {
        step: "drain_game_lifecycle",
        close: async () => {
          throw new Error("Unhandled failure out of the contain attempt");
        },
      },
      { step: "release_guardian_session", close: async () => {} },
    ],
    DESKTOP_HOST_DRAIN_TIMEOUT_MS,
  );

  assert.deepEqual(
    outcomes.map((outcome) => [outcome.step, outcome.status, outcome.failure]),
    [
      ["stop_admission", "failed", "desktop_host_resource_still_held"],
      ["drain_game_lifecycle", "failed", "desktop_host_child_will_not_stop"],
      ["release_guardian_session", "completed", null],
    ],
  );

  // The report an operator reads names the first failure, and that name is the
  // step's own - never the path the step happened to throw.
  const report = buildDesktopHostExitReason(outcomes);
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.reason, DESKTOP_HOST_RESOURCE_STILL_HELD_FAILURE);
  assert.equal(JSON.stringify(report).includes("secret-port-binding"), false);
});

test("a port that is still held when its drain budget expires is named a timeout, not a held resource", async () => {
  let releaseAbandonedStep!: () => void;
  const neverSettles = new Promise<void>((resolve) => {
    releaseAbandonedStep = resolve;
  });
  const outcomes = await runDesktopHostReclamation(
    [{ step: "stop_admission", close: () => neverSettles }],
    TEST_DRAIN_TIMEOUT_MS,
  );

  assert.deepEqual(outcomes, [
    { step: "stop_admission", status: "failed", failure: DESKTOP_HOST_DRAIN_TIMEOUT_FAILURE },
  ]);

  releaseAbandonedStep();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
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
