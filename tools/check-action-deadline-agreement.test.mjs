import assert from "node:assert/strict";
import test from "node:test";

import {
  checkActionDeadlineAgreement,
  declaredDispatchWindows,
  deriveDeadlineAgreement,
  EXIT,
  formatDeadlineAgreement,
} from "./check-action-deadline-agreement.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

/**
 * A surface + producer export pair over the actions the tests name, so the derivation can be falsified on a
 * population this file controls instead of on the shipped tree.
 */
function world({ actions = ["fish_here"], windows, runners = {} } = {}) {
  return {
    surface: {
      schema: "gamebuddy-action-descriptors/v1",
      catalogRevision: 1,
      actions: actions.map((id) => ({ actionId: id })),
    },
    windows: {
      schema: "gamebuddy-action-deadline-windows/v1",
      catalogRevision: 1,
      windows: actions.map((id) => ({ actionId: id, admittedMs: windows?.[id] ?? 60_000 })),
    },
    readRunnerFile: (file) => (file in runners ? runners[file] : null),
  };
}

const FISH_RUNNER = STARDEW_PUBLISHED_ACTION_GATES.find((entry) => entry.actionId === "fish_here").runner;

test("a runner that writes the action's own window agrees", () => {
  const report = deriveDeadlineAgreement(
    world({ runners: { [FISH_RUNNER]: `executeFresh(client, {\n  action: "fish_here",\n  timeoutMs: 60_000,\n});` } }),
  );
  assert.equal(report.examined, 1);
  assert.equal(report.agree, 1);
  assert.equal(report.disagree, 0);
});

test("a runner that writes a wider window is red, and the line names both numbers", () => {
  // The measured defect: `fish_here` publishes 60 s, its runner wrote 120 s, and the live slice came back
  // `bridge_rejected:invalid_deadline` after a game launch.
  const report = deriveDeadlineAgreement(
    world({ runners: { [FISH_RUNNER]: `executeFresh(client, {\n  action: "fish_here",\n  timeoutMs: 120_000,\n});` } }),
  );
  assert.equal(report.disagree, 1);
  assert.deepEqual(formatDeadlineAgreement(report).slice(0, 3), [
    "actions examined 1 · agree 0 · disagree 1",
    "actions dispatched by a gate runner 1 of 1 · runner-declared windows read 1",
    "action_deadline_disagreement:fish_here:sender=120000:receiver=60000",
  ]);
});

test("a runner that names no window writes the published one, so it agrees by construction", () => {
  const report = deriveDeadlineAgreement(
    world({ runners: { [FISH_RUNNER]: `executeFresh(client, {\n  action: "fish_here",\n  args: {},\n});` } }),
  );
  assert.equal(report.agree, 1);
  assert.equal(report.declaredWindowsRead, 0);
  assert.equal(report.dispatchedByARunner, 1);
});

test("a longer LOCAL wait is not a wider request", () => {
  // `waitForTerminal(..., 90_000)` polls the receipt buffer; the request it waits on is not held for 90 s. Only the
  // dispatch's own `timeoutMs` is the deadline under test, or every runner with a generous poll would be red.
  const source = [
    "const accepted = await executeFresh(client, {",
    '  action: "fish_here",',
    "  timeoutMs: 30_000,",
    "});",
    "await waitForTerminal(receipts, accepted, { timeoutMs: 90_000 });",
  ].join("\n");
  const report = deriveDeadlineAgreement(world({ runners: { [FISH_RUNNER]: source } }));
  assert.equal(report.declaredWindowsRead, 1);
  assert.equal(report.agree, 1);
});

test("the scan reads a dispatch's own call, not a nested object literal's key", () => {
  const source = `executeFresh(client, { action: "fish_here", args: { nested: { timeoutMs: 600_000 } } });`;
  assert.deepEqual(declaredDispatchWindows(source), [{ line: 1, value: 600_000 }]);
  assert.deepEqual(declaredDispatchWindows(`waitForActionable(client, snapshot, 60_000);`), []);
});

test("an action with no gate runner is counted, and says why it cannot disagree", () => {
  const report = deriveDeadlineAgreement(
    world({ actions: ["fish_here", "inspect_world_map"], runners: { [FISH_RUNNER]: "executeFresh(client, {});" } }),
  );
  assert.equal(report.examined, 2);
  assert.equal(report.agree, 2);
  assert.equal(report.dispatchedByARunner, 1);
});

test("an empty population is blocked rather than green", () => {
  assert.throws(
    () =>
      deriveDeadlineAgreement({
        surface: { actions: [] },
        windows: { windows: [{ actionId: "fish_here", admittedMs: 60_000 }] },
        readRunnerFile: () => null,
      }),
    /action_deadline_population_empty/u,
  );
  assert.throws(
    () =>
      deriveDeadlineAgreement({
        surface: { actions: [{ actionId: "fish_here" }] },
        windows: { windows: [] },
        readRunnerFile: () => null,
      }),
    /action_deadline_windows_unreadable/u,
  );
});

test("a runner file that cannot be read is blocked, and named", () => {
  assert.throws(
    () => deriveDeadlineAgreement(world({ runners: {} })),
    (error) => {
      assert.match(error.message, /action_deadline_runner_unreadable/u);
      assert.match(error.message, new RegExp(FISH_RUNNER.replaceAll(".", "\\."), "u"));
      return true;
    },
  );
});

test("an action the producer's export never names is blocked, not silently agreed", () => {
  const inputs = world({ actions: ["fish_here"], runners: { [FISH_RUNNER]: "executeFresh(client, {});" } });
  assert.throws(
    () =>
      deriveDeadlineAgreement({
        surface: inputs.surface,
        windows: { windows: [{ actionId: "move_to_tile", admittedMs: 60_000 }] },
        readRunnerFile: inputs.readRunnerFile,
      }),
    /action_deadline_window_missing:fish_here/u,
  );
});

test("the shipped tree agrees, and the exit codes separate green from red from blocked", () => {
  const report = checkActionDeadlineAgreement();
  assert.ok(report.examined > 0, "the population comes from the generated surface");
  assert.equal(report.disagree, 0, formatDeadlineAgreement(report).join("\n"));
  assert.equal(report.agree, report.examined);
  assert.deepEqual(EXIT, { agreed: 0, disagreement: 1, blocked: 2 });
});
