/*
 * The lifecycle reading the three state drivers start with, held against a page whose answers are scripted.
 *
 * WHY THIS EXISTS (measured 2026-11-15, frontend run pin 3625acb4): a real game launched, the Host projected
 * `instance=launching/attachment=none` for the rest of the run (`PRODUCT_GAPS.instanceStatusNeverRunning`), and
 * every state driver failed with
 *
 *   game_lifecycle_not_activated: no usable activation control within 30000ms at instance=launching/attachment=none
 *
 * The state was read as "activation never happened", so the driver went looking for the activate control - a
 * control the product forbids for an instance that exists (`dialogue-web/src/game-lifecycle-controls.ts:89-99`)
 * - waited its whole budget, and named the lifecycle instead of what it read. Two properties hold here:
 *
 *   the state model     an existing instance is a lifecycle that was activated; the driver presses nothing and
 *                       asks for no second launch, because the product draws neither control for that shape.
 *   the classification  that state leaves through the run's ONE classification (`classifyChainStop` /
 *                       `PRODUCT_GAPS`), so the reading is `not_measured` with the gap's own name and the
 *                       observed state in its detail - never a pass, never a failure.
 *
 * red-proof: inject  with `activateAndLaunch` reverted to HEAD's predicate
 *                   (`instanceStatus === "none" && generation >= 1` = "activated"), the first test below reads
 *                   `{ kind: 'not_measured', reason: 'game_lifecycle_not_activated' }` for a page whose state is
 *                   `instantiated` at instance=launching/attachment=none, and the assertion that fails names
 *                   `instance_status_never_running`. The quoted red/green readings are in `.tmp/lane-driverstate.md`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { activateAndLaunch } from "./game-surface-states.cjs";

/** A control the product has drawn: visible, pressable, and named the way the panel names it. */
const DRAWN = (name) => Object.freeze({ disabled: false, visible: true, name });

/** No controls drawn at all - the shape a lifecycle in flight paints, because there is no step to press. */
const NO_CONTROLS = Object.freeze({
  launch: null,
  activate: null,
  stop: null,
  disconnect: null,
  endgame: null,
  endgameConfirm: null,
  reopen: null,
  resume: null,
});

/**
 * A page whose reads are scripted and whose presses are counted.
 *
 * `readGameState` and `readGameFacts` are dispatched by the in-page function's own name, so a scripted page
 * answers the two reads the driver really makes, and `pressed` is the population of controls the driver
 * touched - which is the whole question for a state whose controls the product does not draw.
 */
function scriptedGamePage({ state, controls = NO_CONTROLS, onPress = () => ({}) }) {
  const asked = [];
  const pressed = [];
  const page = {
    asked,
    pressed,
    current: state,
    controls,
    async evaluate(pageFunction) {
      asked.push(pageFunction.name);
      if (pageFunction.name === "readGameState") return { ...page.current };
      if (pageFunction.name === "readGameFacts")
        return { surfacePresent: true, state: null, facts: {}, controls: page.controls };
      throw new Error(`unexpected_evaluate:${String(pageFunction.name)}`);
    },
    locator(selector) {
      const testId = /data-testid="([^"]+)"/u.exec(selector)?.[1] ?? selector;
      return {
        first: () => ({
          click: async () => {
            pressed.push(testId);
            const next = onPress(testId, page.current) ?? {};
            if (next.state !== undefined) page.current = next.state;
            if (next.controls !== undefined) page.controls = next.controls;
          },
        }),
      };
    },
  };
  return page;
}

const INSTALLED = { ok: true, prerequisites: "met", attachmentStatus: "none", attachmentGeneration: null };

/** The driver's own budgets, shortened: the wait lengths are not what these tests measure. */
const FAST = Object.freeze({ controlMs: 40, activationMs: 40, launchMs: 2_000, plateauMs: 50 });

/** Nothing bound in the pipe namespace: the guardian reading a launch refusal would be classified against. */
const NOTHING_BOUND = Object.freeze({ examined: 0, endpoints: [], unreadable: null, onlyRunOwnGatePeer: false });

async function drive(page) {
  const said = [];
  const steps = [];
  return {
    said,
    steps,
    reading: await activateAndLaunch({
      page,
      say: (line) => said.push(line),
      record: (step, value) => steps.push({ step, value }),
      guardian: NOTHING_BOUND,
      problems: new Map(),
      budget: FAST,
    }),
  };
}

test("an instance that already exists is read as the product's own gap, not as a lifecycle nobody activated", async () => {
  // Measured 2026-11-15: the game really launched, the Host kept projecting `launching`, and the panel drew
  // no activate control because a launch was already in flight.
  const page = scriptedGamePage({ state: { ...INSTALLED, instanceStatus: "launching", instanceGeneration: 2 } });
  const { reading, steps } = await drive(page);
  assert.equal(reading.kind, "not_measured");
  assert.equal(reading.reason, "instance_status_never_running", "the gap's own name, from PRODUCT_GAPS");
  assert.equal(reading.gap, "instance_status_never_running", "and the harness's blocked-by-product path gets it");
  assert.match(reading.detail, /instance=launching\/attachment=none/u, "the detail keeps the state it read");
  assert.match(reading.detail, /ownership=player_external/u, "and the reason the word cannot change");
  assert.deepEqual(page.pressed, [], "the product draws no lifecycle control for this shape, so none is pressed");
  assert.deepEqual(
    page.asked.filter((name) => name === "readGameFacts"),
    [],
    "the activation control is not even looked for: finding it is impossible by construction here",
  );
  const recorded = steps.find((entry) => entry.step === "activation");
  assert.equal(recorded.value.needed, false, "the driver states that no activation was needed, instead of waiting");
});

test("an instance that is already up is used as it is: no activation, and no second launch", async () => {
  const page = scriptedGamePage({ state: { ...INSTALLED, instanceStatus: "running", attachmentStatus: "attached" } });
  const { reading } = await drive(page);
  assert.equal(reading.kind, "ready");
  assert.equal(reading.state.instanceStatus, "running");
  assert.deepEqual(page.pressed, [], "pressing launch here would ask the product for a second Player Host");
});

test("a lifecycle the product has not activated is still activated through its own control", async () => {
  // The shape the probe was written for: nothing running, no generation, and the activate control drawn.
  const page = scriptedGamePage({
    state: { ...INSTALLED, instanceStatus: "none", instanceGeneration: 0 },
    controls: { ...NO_CONTROLS, activate: DRAWN("启用同伴陪玩") },
    onPress: (testId) =>
      testId === "game-activate"
        ? {
            state: { ...INSTALLED, instanceStatus: "none", instanceGeneration: 1 },
            controls: { ...NO_CONTROLS, launch: DRAWN("启动游戏") },
          }
        : {
            state: { ...INSTALLED, instanceStatus: "running", attachmentStatus: "attached", instanceGeneration: 1 },
          },
  });
  const { reading } = await drive(page);
  assert.equal(reading.kind, "ready");
  assert.deepEqual(
    page.pressed,
    ["game-activate", "game-launch"],
    "the two staging presses, in the product's own order",
  );
});

test("a lifecycle with no generational activation and no control is still named as never activated", async () => {
  // The other direction: a state the product forbids nothing in, and no control drawn for it either. This
  // reading keeps its own name, so the gap above cannot quietly absorb the genuine failure.
  const page = scriptedGamePage({ state: { ...INSTALLED, instanceStatus: "none", instanceGeneration: 0 } });
  const { reading } = await drive(page);
  assert.equal(reading.reason, "game_lifecycle_not_activated");
  assert.match(reading.detail, /instance=none\/attachment=none/u);
  assert.deepEqual(page.pressed, []);
});

test("a Host that holds no reading of the game asks for the reread step, not the staging controls", async () => {
  // `instance.status: "unread"` is the product's own word for "no reading yet"
  // (`dialogue-web/src/game-lifecycle-controls.ts:388-408`), and neither staging control exists for it.
  const page = scriptedGamePage({ state: { ...INSTALLED, instanceStatus: "unread" } });
  const { reading } = await drive(page);
  assert.equal(reading.kind, "not_measured");
  assert.equal(reading.reason, "game_state_not_read");
  assert.match(reading.detail, /instance=unread/u);
  assert.deepEqual(page.pressed, []);
});
