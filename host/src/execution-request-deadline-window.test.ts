import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  declaredDeadlineWindow,
  EXECUTION_REQUEST_ARGUMENT_RULES,
  EXECUTION_REQUEST_DEADLINE_WINDOWS,
  EXECUTION_REQUEST_REQUIREMENTS,
  type ExecutionRequest,
  type ExecutionRequestRequirement,
  executionRequestReading,
  firstExecutionRequestRefusal,
  type Snapshot,
  validateExecutionRequest,
} from "./protocol.js";

/**
 * THE CEILING IS THE WINDOW THE MOD DECLARES, AND AN ACTION NOBODY DECLARED IS REFUSED.
 *
 * <p>
 * The deadline ceiling was chosen by NAME - `action === "navigate_to_destination" || action === "sleep" ? 600_000 :
 * 60_000` - while `game-tools.ts` sizes the same request from the watchdog the Mod publishes for that action, clamped to
 * the bridge's 600 s maximum. So every action outside those two literals was capped at 60 s by a validator, whatever
 * window the Mod admitted: an action whose declared window is longer was refused `invalid_deadline` before the game saw
 * it, and the pair of ids that agreed with the Mod's declaration today agreed by coincidence. `wia-modal-dismiss-chain`
 * measured the same shape one layer up (the Host refused a held body the Mod was the authority on), and the answer here
 * is the same one: read the declaration.
 * </p>
 *
 * <p>
 * THE POPULATION COMES FROM THE PRODUCER. The windows are
 * `integrations/stardew/action-development/contracts/generated/action-deadline-windows.v1.json`, printed by the Mod's own
 * `FarmhandActionDeadlineWindowExport` from the rule `FarmhandActionDeadlineAdmission.WindowMs` bounds a request with.
 * This suite reads that file rather than a list it wrote itself, holds `EXECUTION_REQUEST_DEADLINE_WINDOWS` against it in
 * both directions (a window the Mod lengthens, shortens, adds or retires without the Host following is named here), and
 * then walks every action through the `deadlineMs` row itself, which is where the number is enforced.
 * </p>
 *
 * <p>
 * WHAT THIS SUITE CANNOT SEE, said rather than implied. It reads the artifact as text, so it proves the Host table equals
 * the file in the tree - not that the file equals the C# it was exported from; `action-surface-export-drift.test.mjs`
 * regenerates it from the producer and is the one that would catch that. It also does not prove the row is reached on a
 * live dispatch: `validateExecutionRequest` walks the same row (asserted below with one action end to end), and
 * `execution-request-declaration.test.ts` walks every row through it.
 * </p>
 *
 * red-proof: inject  the ceiling row back to its name list (`action === "navigate_to_destination" || action === "sleep" ?
 *                   600_000 : 60_000`) -> `a window the artifact declares beyond 60 s is admitted to that window:
 *                   move_to_tile: declared 300 s ... ` fails with `invalid_deadline`.
 * red-proof: inject  the absent-window branch replaced by `?? 60_000` -> `an action the declaration does not carry is
 *                   refused: travel: 60 s ...` fails, because the row admits it.
 */

/** The clock every reading is judged at; the deadline windows are relative to it, never to the wall clock. */
const NOW = 1_000_000;

const SNAPSHOT: Snapshot = {
  revision: 7,
  location: "Farm",
  tile: { x: 10, y: 11 },
  stamina: 270,
  exhausted: false,
  health: 100,
  actionable: true,
  capabilities: Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES),
  catalogRevision: 1,
  enabledActionIds: [],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  activeExecution: null,
};

/** The repository root, found by walking up to the directory that holds `integrations`. */
function repoRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

const ROOT = repoRoot(dirname(fileURLToPath(import.meta.url)));
const WINDOWS = JSON.parse(
  readFileSync(
    join(ROOT, "integrations/stardew/action-development/contracts/generated/action-deadline-windows.v1.json"),
    "utf8",
  ),
) as { schema?: string; windows?: readonly { actionId: string; admittedMs: number }[] };
const SURFACE = JSON.parse(
  readFileSync(
    join(ROOT, "integrations/stardew/action-development/contracts/generated/action-surface.v1.json"),
    "utf8",
  ),
) as { actions?: readonly { actionId: string; kind?: string }[] };

/** The `deadlineMs` row: the one place the number is enforced, found by the field it decides. */
function deadlineRow(): ExecutionRequestRequirement {
  const row = EXECUTION_REQUEST_REQUIREMENTS.find((requirement) => requirement.field === "deadlineMs");
  assert.ok(row !== undefined, "the execution-request declaration must carry a `deadlineMs` row");
  return row;
}

/**
 * The row's verdict for one action and one deadline, read the way `validateExecutionRequest` reads it.
 *
 * `args` is empty on purpose: the row is an envelope row, decided before any argument row, and what is under test is the
 * number rather than the payload shape.
 */
function verdictFor(
  action: string,
  deadlineMs: number,
  windows: Readonly<Record<string, number>> = EXECUTION_REQUEST_DEADLINE_WINDOWS,
): string | null {
  const request = {
    requestId: "request_1",
    idempotencyKey: "idempotency_1",
    action,
    args: {},
    expectedRevision: SNAPSHOT.revision,
    deadlineMs,
  };
  return firstExecutionRequestRefusal([deadlineRow()], executionRequestReading(request, SNAPSHOT, NOW, windows));
}

/** `move_to_tile`'s own argument set, so one case can run the WHOLE validator with no other row in the way. */
const MOVE = { x: 10, y: 11 };

function moveRequest(
  deadlineMs: number,
  windows: Readonly<Record<string, number>> = EXECUTION_REQUEST_DEADLINE_WINDOWS,
) {
  return validateExecutionRequest(
    {
      requestId: "request_1",
      idempotencyKey: "idempotency_1",
      action: "move_to_tile" as const,
      args: MOVE,
      expectedRevision: SNAPSHOT.revision,
      deadlineMs,
    },
    SNAPSHOT,
    NOW,
    windows,
  );
}

test("the Host's per-action windows are the Mod's declared windows, both ways", () => {
  const published = new Map<string, number>();
  for (const window of WINDOWS.windows ?? [])
    if (typeof window.actionId === "string" && Number.isSafeInteger(window.admittedMs) && window.admittedMs > 0)
      published.set(window.actionId, window.admittedMs);

  assert.equal(WINDOWS.schema, "gamebuddy-action-deadline-windows/v1");
  assert.ok(published.size > 50, `the Mod's artifact must have been read (found ${published.size} windows)`);
  assert.ok(
    Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES).length > 50,
    "the Host's action declaration must have been read",
  );

  const disagreements: string[] = [];
  for (const [actionId, admittedMs] of published) {
    const declared = EXECUTION_REQUEST_DEADLINE_WINDOWS[actionId as ExecutionRequest["action"]] as number | undefined;
    if (declared === undefined) continue; // not a dispatchable action on this side; asserted separately below
    if (declared !== admittedMs)
      disagreements.push(`${actionId}: the Mod declares ${admittedMs} ms, the Host ${declared}`);
  }
  for (const actionId of Object.keys(EXECUTION_REQUEST_DEADLINE_WINDOWS)) {
    if (!published.has(actionId))
      disagreements.push(`${actionId}: the Host declares a window the Mod's artifact does not publish`);
  }
  assert.deepEqual(
    disagreements,
    [],
    "one deadline window, two parties: a Host table that disagrees with the Mod's own export caps a request the game\n" +
      `would have admitted, or admits one it refuses - neither is visible from the refusal it produces.\n${disagreements.join("\n")}`,
  );
});

test("every action the Host dispatches carries a declared window, and every window is admitted to exactly its value", () => {
  const actions = Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES) as readonly ExecutionRequest["action"][];
  assert.ok(actions.length > 50, `the walk must have a population (found ${actions.length} actions)`);

  for (const action of actions) {
    const window = EXECUTION_REQUEST_DEADLINE_WINDOWS[action];
    assert.ok(
      Number.isSafeInteger(window) && window > 0,
      `${action}: the declaration must carry a window for every action the Host can dispatch`,
    );
    assert.equal(verdictFor(action, NOW), null, `${action}: a deadline of "now" must be admitted`);
    assert.equal(verdictFor(action, NOW + window), null, `${action}: the declared window itself must be admitted`);
    assert.equal(
      verdictFor(action, NOW + window + 1),
      "invalid_deadline",
      `${action}: one millisecond past the declared window must be refused`,
    );
  }
});

test("the artifact's actions this Host does not dispatch are the published read-only ones", () => {
  const surface = new Map((SURFACE.actions ?? []).map((action) => [action.actionId, action.kind]));
  assert.ok(surface.size > 50, `the published surface must have been read (found ${surface.size} actions)`);
  const notDispatched = (WINDOWS.windows ?? [])
    .map((window) => window.actionId)
    .filter((actionId) => EXECUTION_REQUEST_DEADLINE_WINDOWS[actionId as ExecutionRequest["action"]] === undefined);
  for (const actionId of notDispatched)
    assert.equal(
      surface.get(actionId),
      "read_only",
      `${actionId}: publishes no execution_request, so it has no dispatch deadline to bound - but the surface does not say it is read_only either, which makes it an action the Host cannot dispatch by mistake`,
    );
});

test("falsifier: a declared window of 300 s is admitted to 300 s, not to 60", () => {
  const threeHundred = { ...EXECUTION_REQUEST_DEADLINE_WINDOWS, move_to_tile: 300_000 };
  assert.equal(declaredDeadlineWindow(threeHundred, "move_to_tile"), 300_000);
  assert.equal(
    verdictFor("move_to_tile", NOW + 60_001, threeHundred),
    null,
    "60 s + 1 ms must be inside a 300 s window",
  );
  assert.equal(
    verdictFor("move_to_tile", NOW + 300_000, threeHundred),
    null,
    "the declared 300 s itself must be admitted",
  );
  assert.equal(
    verdictFor("move_to_tile", NOW + 300_001, threeHundred),
    "invalid_deadline",
    "past the declared 300 s must be refused",
  );
  // The same number through the whole validator, so the row is proven to be the one a dispatch meets.
  assert.equal(moveRequest(NOW + 300_000, threeHundred), null);
  assert.equal(moveRequest(NOW + 300_001, threeHundred), "invalid_deadline");
});

test("falsifier: an action the declaration does not carry is refused, never capped at 60 s", () => {
  const { travel: _travel, ...withoutTravel } = EXECUTION_REQUEST_DEADLINE_WINDOWS;
  assert.equal(declaredDeadlineWindow(withoutTravel, "travel"), null, "an undeclared action has no window");
  assert.equal(
    verdictFor("travel", NOW + 60_000, withoutTravel),
    "invalid_deadline",
    "60 s is exactly the ordinary window, and an undeclared action must not be admitted to it by inheritance",
  );
  assert.equal(verdictFor("travel", NOW, withoutTravel), "invalid_deadline", "not even a deadline of \u201cnow\u201d");
  assert.equal(
    verdictFor("travel", NOW, EXECUTION_REQUEST_DEADLINE_WINDOWS),
    null,
    "and the same request under the real declaration is admitted, so the refusal above is the absent window",
  );
});

test("falsifier: the row refuses a deadline before now and a non-number, whatever the declaration says", () => {
  assert.equal(verdictFor("move_to_tile", NOW - 1), "invalid_deadline");
  assert.equal(verdictFor("move_to_tile", NOW + 1_000), null);
  assert.equal(declaredDeadlineWindow({ move_to_tile: 0 }, "move_to_tile"), null, "a zero window is no window");
  assert.equal(declaredDeadlineWindow({ move_to_tile: Number.POSITIVE_INFINITY }, "move_to_tile"), null);
  assert.equal(
    declaredDeadlineWindow({ move_to_tile: 60_000 }, "__proto__"),
    null,
    "an inherited key is not a declared one",
  );
});
