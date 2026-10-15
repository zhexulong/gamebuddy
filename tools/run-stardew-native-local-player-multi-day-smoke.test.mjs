import assert from "node:assert/strict";
import test from "node:test";
import {
  ROLLOVER_DISMISSIBLE_MENUS,
  ROLLOVER_WAIT_MENUS,
  classifyActorHold,
  classifyRollover,
  decideRolloverMenu,
  parseRolloverEvidence,
  readRolloverMenu,
  runMultiDaySmoke,
} from "./run-stardew-native-local-player-multi-day-smoke.mjs";

const CAPABILITIES = ["advance_day", "dismiss_modal"];

function fixtureConfig(scenario, overrides = {}) {
  return {
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: scenario,
      LogicalSaveName: "GameBuddyFixture",
      ObservedSaveSlot: "GameBuddyFixture_445094166",
    },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: [],
    SaveId: "save",
    WorldId: "world",
    PlayerId: "445094166",
    CompanionId: "companion",
    ...overrides,
  };
}

const ADVANCE_EVIDENCE_1 = [
  "state=passed",
  "reason=day_advanced",
  "topology=single_player",
  "entered_via=native_sleep_prompt",
  "saving_observed=true",
  "saved_observed=true",
  "day_started_observed=true",
  "day_before=4",
  "days_before=4",
  "day_after=5",
  "days_after=5",
].join(";");

/**
 * A bridge that scripts a night's rollover.
 *
 * `plan[i]` describes night i+1, which is exactly what the live world does:
 *   - `"ShippingMenu"` appears mid-night and only a real dismiss releases the night,
 *     so the terminal cannot arrive until the dismiss receipt has been minted;
 *   - `"SaveGameMenu"` appears mid-night and releases itself one observation later
 *     (no decision, no dismiss);
 *   - `"LevelUpMenu"` appears mid-night and NEVER releases the night, which is the
 *     stall the runner must report by name.
 */
function createFake({ scenario = "native_multi_day_v1", plan = [] } = {}) {
  const listeners = new Set();
  let revision = 10;
  let dayOfMonth = 5;
  let totalDays = 4;
  let modal = null;
  let night = null;
  let nightsStarted = 0;

  const snapshotOf = () => ({
    revision,
    location: "FarmHouse",
    tile: { x: 4, y: 8 },
    actionable: modal === null && night === null,
    activeExecution: null,
    capabilities: CAPABILITIES,
    dayOfMonth,
    timeOfDay: 600,
    seasonIndex: 0,
    year: 1,
    actorDispositionKind: modal === null ? "idle" : "modal",
    actorDispositionDetail: modal,
    actorDispositionActionOwned: false,
  });
  const client = { state: { snapshot: snapshotOf() } };
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  /** The night's own settlement: the DONE terminal, the world's new day, a free actor. */
  const completeNight = () => {
    const before = totalDays;
    totalDays += 1;
    dayOfMonth = (totalDays % 28) + 1;
    modal = null;
    const terminal = {
      requestId: night.requestId,
      executionId: night.executionId,
      state: "succeeded",
      reasonCode: "day_advanced",
      revision: (revision += 1),
      evidence: `state=passed;reason=day_advanced;saved_observed=true;day_started_observed=true;day_before=${before};days_before=${before};day_after=${totalDays};days_after=${totalDays}`,
    };
    night = null;
    publish(terminal);
    return terminal;
  };

  client.observe = async () => {
    if (night !== null) {
      if (!night.sawModal) {
        // The rollover's own menu appears while the night is still in flight.
        modal = plan[night.index];
        night.sawModal = true;
      } else if (modal === "SaveGameMenu") {
        // Engine-owned save progress: it releases itself with no action at all.
        completeNight();
      }
    }
    const snapshot = snapshotOf();
    client.state.snapshot = snapshot;
    return snapshot;
  };
  client.execute = async ({ requestId, action }) => {
    const executionId = `exec-${requestId}`;
    revision += 1;
    if (action === "advance_day") {
      night = { index: nightsStarted, requestId, executionId, sawModal: false };
      nightsStarted += 1;
      const accepted = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      publish(accepted);
      return accepted;
    }
    assert.equal(action, "dismiss_modal", "the runner may only send the product's own dismiss");
    assert.equal(modal, "ShippingMenu", "the runner may only dismiss the audited operation menu");
    const dismissed = {
      requestId,
      executionId,
      state: "succeeded",
      reasonCode: "modal_dismissed",
      revision,
      evidence: "modal_type=ShippingMenu;dismissed=true;cleared_modal=ShippingMenu;close_effect=pure_cancel",
    };
    publish(dismissed);
    completeNight();
    return dismissed;
  };
  client.onFact = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  client.receipts = receipts;
  client.nightsStarted = () => nightsStarted;
  return client;
}

test("the rollover's menu is read from the Mod's own disposition projection", () => {
  assert.equal(readRolloverMenu({ actorDispositionKind: "idle" }), null);
  assert.equal(
    readRolloverMenu({ actorDispositionKind: "modal", actorDispositionDetail: "ShippingMenu" }),
    "ShippingMenu",
  );
  assert.equal(
    readRolloverMenu({ actorDispositionKind: "modal", actorDispositionDetail: null }),
    "unknown",
    "a modal the Mod could not name is still a hold, never an idle actor",
  );
  assert.equal(readRolloverMenu(null), null);
});

test("the decision table names every outcome, and LevelUpMenu is NEVER dismissible", () => {
  assert.equal(decideRolloverMenu(null).kind, "none");
  for (const menu of ROLLOVER_WAIT_MENUS)
    assert.equal(decideRolloverMenu(menu).kind, "wait", `${menu} is engine-owned`);
  for (const menu of ROLLOVER_DISMISSIBLE_MENUS)
    assert.equal(decideRolloverMenu(menu).kind, "dismiss", `${menu} is the audited operation menu`);

  const levelUp = decideRolloverMenu("LevelUpMenu");
  assert.equal(levelUp.kind, "blocked");
  assert.equal(
    levelUp.reasonCode,
    "actor_held_by_unclosable_menu:LevelUpMenu",
    "the stop must name the menu type; its close hook writes saved state (LevelUpMenu.cs:629-643)",
  );
  assert.equal(
    decideRolloverMenu("SomeFutureMenu").kind,
    "blocked",
    "anything unaudited is named rather than guessed at",
  );
});

test("a non-menu hold is named from the Mod's own disposition vocabulary", () => {
  assert.equal(classifyActorHold({ actorDispositionKind: "event" }).reasonCode, "actor_held_by_cutscene");
  assert.equal(classifyActorHold({ actorDispositionKind: "pass_out" }).reasonCode, "actor_passed_out");
  assert.equal(classifyActorHold({ actorDispositionKind: "idle" }).reasonCode, null);
});

test("the receipt's own day claim is cross-checked against the world, never trusted alone", () => {
  const evidence = parseRolloverEvidence(ADVANCE_EVIDENCE_1);
  assert.equal(evidence.day_before, "4");
  assert.equal(evidence.saved_observed, "true");
  assert.deepEqual(parseRolloverEvidence("").day_before, undefined);

  const terminal = { state: "succeeded", reasonCode: "day_advanced" };
  // Spring day 5 of Y1 is TotalDays 4, and the calendar day that total implies is 5 -> 6.
  assert.equal(classifyRollover({ terminal, evidence, snapshot: { dayOfMonth: 6 } }).advanced, true);
  assert.equal(
    classifyRollover({ terminal, evidence, snapshot: { dayOfMonth: 7 } }).reasonCode,
    "rollover_world_day_mismatch:7:expected=6",
  );
  assert.equal(
    classifyRollover({
      terminal,
      evidence: parseRolloverEvidence(ADVANCE_EVIDENCE_1.replace("day_after=5", "day_after=7")),
      snapshot: { dayOfMonth: 6 },
    }).reasonCode,
    "rollover_day_counter_mismatch:4->7",
  );
  assert.equal(
    classifyRollover({ terminal: { state: "blocked", reasonCode: "day_start_not_observed" }, evidence, snapshot: {} })
      .reasonCode,
    "night_not_completed:blocked/day_start_not_observed",
  );
});

test("three days are crossed, the ShippingMenu is cleared mid-night, and every receipt is recorded", async () => {
  const client = createFake({ plan: ["ShippingMenu", "SaveGameMenu", "SaveGameMenu"] });
  const result = await runMultiDaySmoke(client, client.receipts, fixtureConfig("native_multi_day_v1"), {
    days: 3,
    nightTimeoutMs: 30_000,
    dismissTimeoutMs: 5_000,
  });
  assert.equal(result.state, "passed", JSON.stringify(result.dayRecords));
  assert.equal(result.reasonCode, "days_crossed");
  assert.equal(result.daysCrossed, 3);
  assert.equal(result.dayRecords.length, 3);

  const first = result.dayRecords[0];
  assert.equal(first.menus.length, 1, "the first rollover pushes exactly the ShippingMenu");
  assert.equal(first.menus[0].menuType, "ShippingMenu");
  assert.equal(first.menus[0].decision, "dismiss");
  assert.equal(first.menus[0].dismissReceipt.reasonCode, "modal_dismissed");
  assert.equal(first.rollover.advanced, true);
  assert.equal(first.evidence.day_after, "5");
  assert.equal(first.after.dayOfMonth, 6, "the recorded world day is the day after the rollover");
  assert.equal(first.after.timeOfDay, 600);
  assert.equal(first.after.location, "FarmHouse");

  // Nights 2 and 3 roll over with the engine's own save modal and no dismiss at all.
  const dismissals = result.dayRecords.flatMap((record) =>
    record.menus.filter((menu) => menu.dismissReceipt !== undefined),
  );
  assert.equal(dismissals.length, 1, "exactly one menu needed the product's dismiss");
  assert.equal(result.dayRecords[1].menus.map((menu) => menu.menuType).join(","), "SaveGameMenu");
  const actions = result.trace.map((entry) => `${entry.day}:${entry.action}`);
  assert.deepEqual(actions, ["1:advance_day", "2:advance_day", "3:advance_day"]);
});

test("a LevelUpMenu stops the run BY NAME, and never by timeout", async () => {
  const client = createFake({ plan: ["LevelUpMenu", "SaveGameMenu"] });
  const result = await runMultiDaySmoke(client, client.receipts, fixtureConfig("native_multi_day_v1"), {
    days: 3,
    nightTimeoutMs: 30_000,
    dismissTimeoutMs: 5_000,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "actor_held_by_unclosable_menu:LevelUpMenu");
  assert.equal(result.daysCrossed, 0);
  assert.equal(result.dayRecords.length, 1);
  assert.equal(result.dayRecords[0].menus[0].menuType, "LevelUpMenu");
  assert.equal(
    result.dayRecords[0].menus[0].dismissReceipt,
    undefined,
    "the runner must not ask the product to close a menu whose close writes saved state",
  );
});

test("a night that never completes is reported with the hold it is under", async () => {
  const client = createFake({ plan: ["ShippingMenu"] });
  // A dismissable menu that is never actually cleared: the fake refuses every dismiss,
  // so the run must name the persisting menu instead of waiting out the night budget.
  client.execute = async ({ requestId, action }) => {
    const executionId = `exec-${requestId}`;
    if (action === "advance_day")
      return { requestId, executionId, state: "accepted", reasonCode: "accepted", revision: 11 };
    return {
      requestId,
      executionId,
      state: "rejected",
      reasonCode: "modal_not_dismissible",
      revision: 12,
      evidence: "modal_type=ShippingMenu;dismissible=false",
    };
  };
  client.observe = async () => {
    const snapshot = {
      revision: 10,
      location: "FarmHouse",
      tile: { x: 4, y: 8 },
      actionable: false,
      activeExecution: null,
      capabilities: CAPABILITIES,
      dayOfMonth: 5,
      timeOfDay: 600,
      seasonIndex: 0,
      year: 1,
      actorDispositionKind: "modal",
      actorDispositionDetail: "ShippingMenu",
      actorDispositionActionOwned: false,
    };
    client.state.snapshot = snapshot;
    return snapshot;
  };
  const result = await runMultiDaySmoke(client, client.receipts, fixtureConfig("native_multi_day_v1"), {
    days: 2,
    nightTimeoutMs: 30_000,
    dismissTimeoutMs: 5_000,
  });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^rollover_menu_not_dismissed:ShippingMenu:rejected\/modal_not_dismissible$/);
});

test("a wrong scenario is refused before any execution", async () => {
  const client = createFake();
  await assert.rejects(
    () => runMultiDaySmoke(client, client.receipts, fixtureConfig("native_unknown_v1"), { days: 3 }),
    /native_local_fixture_invalid_scenario/,
  );
});

test("the day count is bounded to the honest minimum and a sane ceiling", async () => {
  const client = createFake({ plan: ["ShippingMenu", "SaveGameMenu", "SaveGameMenu"] });
  const result = await runMultiDaySmoke(client, client.receipts, fixtureConfig("native_multi_day_v1"), {
    days: 1,
    nightTimeoutMs: 30_000,
    dismissTimeoutMs: 5_000,
  });
  assert.equal(result.daysRequested, 2, "a CROSS-day claim cannot be made with fewer than two days");
  assert.equal(result.daysCrossed, 2);
});
