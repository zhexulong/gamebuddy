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
 * red-proof: inject  the world claim removed from in front of the launch press (the driver pressing
 *                   `game-launch` without claiming its world): `✖ a lifecycle the product has not activated is
 *                   still activated through its own control` fails, because the launch then enters whatever
 *                   world the previous run left behind and the step that says so is gone.
 *
 * THE STOP'S WAIT is the fourth property here, and it exists because a wait can be wrong about what an
 * operation even produces. Driver W pressed 停止游戏 on two HEAD runs (`E:\gb-lanes\launchorphan-r1`,
 * `firstjoin-r1`) and both printed `settled: false, elapsedMs 120000, last
 * instance=running/attachment=attached`: the predicate was `instance=stopped|none` with the attachment gone,
 * which is what a game's DEATH leaves. An ordinary stop keeps the world running (project rule #3023/#506),
 * so that predicate is false for every stop that works and the number in the report was the budget, not the
 * stop. The tests below drive a scripted page whose stop settles at 3 s and assert the reading BOTH ways:
 * the product's own phase plus the Host's `game/stop` answer settles it, the old endgame shape never does,
 * and a refusal ends the wait at once instead of at the budget.
 * red-proof: inject  `attachmentActionsStopped`'s body reverted to `attachmentStatus !== "attached"` (driver
 *                   W's old predicate): `✖ a stop that settles in seconds is settled...` fails with
 *                   `settled: false` after the full budget, and the verdict suite's first stop assertion
 *                   fails with the settled shape. Measured readings in `.tmp/lane-stopwait.md`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { activateAndLaunch, pressStop, runBoundary, waitForState, waitForStop } from "./game-surface-states.cjs";

/**
 * A run whose world this process claims: the launch state every driver reads, the staged `WorldCreation`
 * request the composer writes, and one save folder carrying the world name the product asked for.
 *
 * The launch is the moment a run decides which world it enters (`capture/fixture-world.cjs`), so the shape a
 * driver sees here is the real one and the third test below can hold the claim against the press order.
 */
function runWorld() {
  const root = mkdtempSync(join(tmpdir(), "game-surface-states-"));
  const appData = join(root, "appdata");
  const saves = join(appData, "StardewValley", "Saves", "GameBuddyFarm_451234657");
  const mods = join(
    root,
    "run",
    "GameBuddy",
    "data",
    "stardew-private-bootstrap",
    "b1",
    "player-host",
    "Mods",
    "GameBuddy",
  );
  const stateDirectory = join(root, "run", "state");
  mkdirSync(saves, { recursive: true });
  mkdirSync(mods, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(join(saves, "SaveGameInfo"), "<Farmer><farmName>GameBuddy Farm</farmName></Farmer>", "utf8");
  writeFileSync(join(saves, "GameBuddyFarm_451234657"), "<SaveGame />", "utf8");
  writeFileSync(
    join(mods, "config.json"),
    JSON.stringify({ WorldCreation: { Enable: true, FarmName: "GameBuddy Farm" } }),
    "utf8",
  );
  const launchState = join(stateDirectory, "launch.json");
  writeFileSync(
    launchState,
    JSON.stringify({
      kind: "mounted",
      runRoot: join(root, "run"),
      declaredDataRoot: join(root, "run", "GameBuddy", "data"),
    }),
    "utf8",
  );
  process.env.APPDATA = appData;
  process.env.GB_SHOTS_LAUNCH_STATE = launchState;
  return { root, appData, runRoot: join(root, "run"), launchState };
}

const RUN_WORLD = runWorld();

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
      if (pageFunction.name === "readInstallationPanel")
        return page.installationPanel ?? { present: false, surfacePresent: true, candidates: [] };
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

test("a run root with no registered installation registers it rather than refusing the scenario", async () => {
  // The shape a lifecycle driver's OWN run meets: `frontend--r24` measured x, y and z as
  // `game_process_not_found` because they ran behind driver W's launch, and a run that starts one of them
  // alone has no registration at all - the refusal that made one-driver-per-run impossible. The press and
  // its budgets live in `capture/installation-registration.cjs`; what this holds is that the state driver
  // reaches it instead of naming a prerequisite nobody offered it.
  const page = scriptedGamePage({ state: { ...INSTALLED, prerequisites: "none" } });
  const { reading, steps } = await drive(page);
  assert.equal(reading.kind, "not_measured");
  assert.equal(reading.reason, "no_installation_panel", "the panel's own missing prerequisite, not a scenario refusal");
  assert.equal(
    steps.some((entry) => entry.step === "installation panel"),
    true,
    "the registration step ran and recorded what the panel said",
  );
  assert.deepEqual(page.pressed, [], "nothing is pressed when there is no control to press");
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
  const { reading, steps } = await drive(page);
  assert.equal(reading.kind, "ready");
  assert.deepEqual(
    page.pressed,
    ["game-activate", "game-launch"],
    "the two staging presses, in the product's own order",
  );
  // The launch press happens only after this run has claimed the world it is about to enter: a run that
  // pressed first would enter the world its predecessors filled, which is the r25 refusal.
  const claim = steps.find((entry) => entry.step === "fixture world");
  assert.equal(claim?.value.kind, "moved");
  assert.deepEqual(
    claim.value.moved.map((entry) => entry.slot),
    ["GameBuddyFarm_451234657"],
  );
  assert.equal(existsSync(join(RUN_WORLD.runRoot, "fixture-worlds", "GameBuddyFarm_451234657", "SaveGameInfo")), true);
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

/*
 * `5ac1ab92`'s contract: a lifecycle driver's game is the one THIS RUN launched, not only the one this driver
 * started.
 *
 * The red this replaces, measured 2026-11-21 on `frontend--r24`: driver x ran behind driver w's launch, the
 * instance was already up (`settleInFlightInstance` reported it `ready`, correctly - it is this run's game), and
 * the driver then looked for a process created after ITS OWN start, which by construction cannot exist:
 *
 *   GAME-STATES x: not_measured game_process_not_found
 *     - no process under D:\Steam\steamapps\common\Stardew Valley was created by this run (371 processes examined)
 *
 * while the run's own attached game was alive. The boundary is the run's Host child, and the reading says which
 * boundary it used.
 */
/*
 * ---- the Stop press ----
 *
 * The two shapes a stop can leave, in the product's own words: `connected_idle` is attached-and-steady
 * (what the panel draws a Stop button in), and `attached_stopped` is the same attachment held with the
 * coordinator's `stopped`. The instance word is `running` in BOTH - that is the promise the press keeps.
 */
const ATTACHED_AND_STEADY = Object.freeze({
  ok: true,
  prerequisites: "met",
  instanceStatus: "running",
  instanceGeneration: 0,
  attachmentStatus: "attached",
  attachmentGeneration: 1,
  connectionStatus: "connected_idle",
});
const ATTACHED_AND_STOPPED = Object.freeze({ ...ATTACHED_AND_STEADY, connectionStatus: "stopped" });

/**
 * A page whose state read is a function of the clock, so a stop can settle mid-wait.
 *
 * The wait reads `/state` once per second; this page answers the same facts the product would at that
 * moment, and `elapsed()` is the page's own clock, which is also what the wire receipt below is timed by.
 */
function clockedStatePage(stateAt) {
  const began = Date.now();
  const reads = [];
  const pressed = [];
  return {
    reads,
    pressed,
    elapsed: () => Date.now() - began,
    async evaluate(pageFunction) {
      if (pageFunction.name !== "readGameState") throw new Error(`unexpected_evaluate:${String(pageFunction.name)}`);
      reads.push(Date.now() - began);
      return stateAt(Date.now() - began);
    },
    locator(selector) {
      const testId = /data-testid="([^"]+)"/u.exec(selector)?.[1] ?? selector;
      return { first: () => ({ click: async () => pressed.push(testId) }) };
    },
  };
}

/** Driver W's predicate before this lane: the ENDGAME/death shape, which a stop never produces. */
const ENDED_GAME = (reading) =>
  reading.ok === true &&
  (reading.instanceStatus === "stopped" || reading.instanceStatus === "none") &&
  reading.attachmentStatus !== "attached";

test("a stop that settles in seconds is settled, and the endgame shape it used to wait for never is", async () => {
  const settledAtMs = 3_000;
  const page = clockedStatePage((ms) => (ms < settledAtMs ? ATTACHED_AND_STEADY : ATTACHED_AND_STOPPED));
  const settled = await waitForStop(page, {
    budgetMs: 9_000,
    stopAnswer: () => (page.elapsed() >= settledAtMs ? { route: "game/stop", status: 200, atMs: Date.now() } : null),
  });
  assert.equal(settled.settled, true, "the phase and the Host's answer are both there, so the stop settled");
  assert.ok(
    settled.elapsedMs >= settledAtMs - 1_000 && settled.elapsedMs <= settledAtMs + 2_000,
    `the wait ends when the stop settles (${String(settled.elapsedMs)}ms), not when its budget runs out`,
  );
  assert.equal(settled.answer.status, 200, "the wire's own receipt travels with the reading");
  assert.equal(settled.state.connectionStatus, "stopped");
  assert.equal(
    settled.state.instanceStatus,
    "running",
    "the world is still running after a successful stop: that is what the product promises, not a failure",
  );

  // The SAME page under the predicate this wait replaced: a stop that settled at 3 s reads as nothing at all
  // for the whole budget. This is the defect, held as a reading rather than described in a comment.
  const ended = await waitForState(page, ENDED_GAME, 6_000);
  assert.equal(ended.settled, false, "an ordinary stop never produces the endgame shape, however long it is waited");
  assert.equal(ended.state.instanceStatus, "running");
});

test("the phase alone is not the receipt: a stop nobody answered has not settled", async () => {
  // The state says `stopped` from 2 s, but the Host never answers the route. The reading stays unsettled
  // rather than calling a half-published fact a finished stop - the phase is the coordinator's word and the
  // answer is the same fact on the wire, and this wait requires both.
  const page = clockedStatePage((ms) => (ms < 2_000 ? ATTACHED_AND_STEADY : ATTACHED_AND_STOPPED));
  const reading = await waitForStop(page, { budgetMs: 4_000 });
  assert.equal(reading.settled, false);
  assert.equal(reading.answer, null);
  assert.equal(reading.state.connectionStatus, "stopped", "the phase it did read is still reported");
});

test("a stop the Host refused ends the wait at once, with the Host's own code", async () => {
  const page = clockedStatePage(() => ATTACHED_AND_STEADY);
  const began = Date.now();
  const reading = await waitForStop(page, {
    budgetMs: 120_000,
    stopAnswer: () => ({ route: "game/stop", status: 409, code: "stardew_game_runtime_unavailable", atMs: Date.now() }),
  });
  assert.equal(reading.settled, false);
  assert.equal(reading.refused.code, "stardew_game_runtime_unavailable");
  assert.ok(Date.now() - began < 5_000, "a refusal is an answer, so no budget is spent waiting for a phase");
});

test("the Stop press is the panel's own control, and the sentence after it names the receipt", async () => {
  // The unit a driver calls, not just the predicate: `pressStop` takes `{ page, say, record, … }`, and a driver
  // that passed the page positionally would throw before pressing anything - measured live on
  // `E:\gb-lanes\stopwait-r1` (`DRIVER W FAILED: TypeError: Cannot read properties of undefined (reading
  // 'locator')`, after a full 9/9 attach). The assertion below cannot pass without the press and the sentence.
  const settledAtMs = 2_000;
  const page = clockedStatePage((ms) => (ms < settledAtMs ? ATTACHED_AND_STEADY : ATTACHED_AND_STOPPED));
  const said = [];
  const steps = [];
  const reading = await pressStop({
    page,
    say: (line) => said.push(line),
    record: (step, value) => steps.push({ step, value }),
    budgetMs: 8_000,
    stopAnswer: () => (page.elapsed() >= settledAtMs ? { route: "game/stop", status: 200, atMs: Date.now() } : null),
  });
  assert.deepEqual(page.pressed, ["game-stop"], "the press is the product's own control, by its test id");
  assert.equal(reading.settled, true);
  assert.equal(steps.find((entry) => entry.step === "stop")?.value.settled, true, "the facts file carries the reading");
  assert.match(
    said.join("\n"),
    /stop settled in [\d.]+s: answer=HTTP 200 .* connection=stopped instance=running/u,
    "and the report says so, with the receipt and the world still running",
  );
});

test("the game boundary is the run's Host child, and a launch state without one keeps the driver's start", () => {
  const hostChild = runBoundary({
    driverStartedMs: Date.parse("2026-11-21T12:00:00.000Z"),
    childStartTime: "2026-11-21T11:52:00.000Z",
  });
  assert.equal(hostChild.sinceWhat, "run_host_child");
  assert.equal(
    hostChild.sinceMs,
    Date.parse("2026-11-21T11:52:00.000Z"),
    "the boundary must reach back to the Host child, so a game another driver launched is still this run's",
  );
  // A driver that started BEFORE the Host child: the earlier of the two wins, so nothing this run caused is lost.
  const driverFirst = runBoundary({
    driverStartedMs: Date.parse("2026-11-21T11:50:00.000Z"),
    childStartTime: "2026-11-21T11:52:00.000Z",
  });
  assert.equal(driverFirst.sinceMs, Date.parse("2026-11-21T11:50:00.000Z"));
  // No readable child start: the driver's own start, named as such rather than silently presented as the run's.
  for (const childStartTime of [null, undefined, "", "not-a-time"]) {
    const fallback = runBoundary({ driverStartedMs: 777, childStartTime });
    assert.equal(fallback.sinceWhat, "driver_start", `childStartTime=${JSON.stringify(childStartTime)}`);
    assert.equal(fallback.sinceMs, 777);
  }
});
