import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MULTIPLAYER_GATE_ACTIONS,
  armGateProfiles,
  classifyMultiplayerGateOutcome,
  parseDriverResult,
  parseGateArgs,
  resolveMultiplayerGatePlan,
} from "./run-stardew-multiplayer-gate.mjs";

/**
 * The multiplayer entry's judgement, tested DIRECTLY with no transport and no
 * game process. The live half (starting the two-process topology) is exercised
 * only by a real run; these cases pin the plan and the outcome vocabulary so a
 * live failure can never be reported as a success.
 */

test("send_multiplayer_chat resolves to its Host fixture scenario and its experimental opt-in", () => {
  const plan = resolveMultiplayerGatePlan({ action: "send_multiplayer_chat" });
  // The chat deed's Host Given is the LOBBY itself; the scenario adds no world
  // mutation (ModEntry.Fixtures.cs: `native_farmhand_chat_v1` only asserts the
  // Cabin exists and logs "lobby present; no world mutation").
  assert.equal(plan.scenario, "native_farmhand_chat_v1");
  // Experimental in the Mod catalog, so the AI profile must opt in explicitly.
  assert.equal(plan.experimental, true);
  assert.equal(plan.runner, "run-stardew-native-local-player-send-multiplayer-chat-smoke.mjs");
});

test("talk_to_npc resolves to the shared-world Given its register demands", () => {
  const plan = resolveMultiplayerGatePlan({ action: "talk_to_npc" });
  // The scenario is the Host Given, not a native-local fixture: the action is
  // mp-semantic, so only a two-process run can clear it. The scenario name comes
  // from STARDEW_SHARED_WORLD_ACTION_SCENARIOS, never from a literal here.
  assert.equal(plan.scenario, "native_farmhand_talk_to_npc_v1");
  assert.equal(plan.experimental, true);
  assert.equal(plan.runner, "run-stardew-native-local-player-talk-to-npc-smoke.mjs");
  assert.equal(Object.hasOwn(MULTIPLAYER_GATE_ACTIONS, "talk_to_npc"), true);
});

test("an unwired gate is refused by name rather than started on a guessed topology", () => {
  assert.throws(
    () => resolveMultiplayerGatePlan({ action: "npc_relationship" }),
    /unknown_multiplayer_gate_action:npc_relationship/,
  );
  assert.equal(Object.hasOwn(MULTIPLAYER_GATE_ACTIONS, "npc_relationship"), false);
});

test("a caller-supplied runner may only replace the runner, never the topology", () => {
  const plan = resolveMultiplayerGatePlan({ action: "send_multiplayer_chat", runner: "probe.mjs" });
  assert.equal(plan.runner, "probe.mjs");
  assert.equal(plan.scenario, "native_farmhand_chat_v1");
});

test("the driver result is read from the last parseable record, not the first line", () => {
  const stdout = [
    "WARNING: something PowerShell printed first",
    '{"state":"action_passed","action":"send_multiplayer_chat"}',
    "",
  ].join("\n");
  assert.deepEqual(parseDriverResult(stdout), { state: "action_passed", action: "send_multiplayer_chat" });
  assert.equal(parseDriverResult("no json here\n"), null);
  // A JSON object without a `state` is not the driver's record.
  assert.equal(parseDriverResult('{"other":1}\n'), null);
});

test("only the driver's own action_passed AND a zero exit is a pass", () => {
  assert.deepEqual(classifyMultiplayerGateOutcome({ exitCode: 0, result: { state: "action_passed" } }), {
    state: "passed",
    reasonCode: "multiplayer_gate_passed",
  });
});

test("every non-pass is a distinct named failure", () => {
  // The driver's own catch record carries the topology phase that failed.
  assert.deepEqual(
    classifyMultiplayerGateOutcome({ exitCode: 1, result: { state: "blocked", phase: "attachment_request" } }),
    {
      state: "blocked",
      reasonCode: "multiplayer_gate_topology_failed:attachment_request",
    },
  );
  // The runner ran against a live lobby and failed its contract.
  assert.deepEqual(classifyMultiplayerGateOutcome({ exitCode: 2, result: { state: "action_failed" } }), {
    state: "failed",
    reasonCode: "multiplayer_gate_action_failed",
  });
  // A green record with a non-zero exit is NOT a pass.
  assert.deepEqual(classifyMultiplayerGateOutcome({ exitCode: 2, result: { state: "action_passed" } }), {
    state: "blocked",
    reasonCode: "multiplayer_gate_driver_failed:2",
  });
  // The driver exited without a result at all.
  assert.deepEqual(classifyMultiplayerGateOutcome({ exitCode: 1, result: null }), {
    state: "blocked",
    reasonCode: "multiplayer_gate_driver_output_missing",
  });
  // A topology-only run is not a gate pass.
  assert.deepEqual(classifyMultiplayerGateOutcome({ exitCode: 0, result: { state: "attached" } }), {
    state: "blocked",
    reasonCode: "multiplayer_gate_runner_not_invoked",
  });
});

test("the three parameters the topology cannot be started without are required", () => {
  const complete = [
    "--game-path",
    "C:/game",
    "--expected-farmhand-id",
    "123456789",
    "--save-name",
    "GameBuddyFixture_Example",
  ];
  const parsed = parseGateArgs(complete);
  assert.equal(parsed.gamePath, "C:/game");
  assert.equal(parsed.expectedFarmhandId, "123456789");
  assert.equal(parsed.saveName, "GameBuddyFixture_Example");
  // The chat gate is the default, and the timeout is bounded.
  assert.equal(parsed.action, "send_multiplayer_chat");
  assert.equal(parsed.timeoutSeconds, 300);

  assert.throws(() => parseGateArgs(complete.slice(0, 4)), /missing_multiplayer_gate_argument:save-name/);
  assert.throws(() => parseGateArgs([...complete, "--game-path", "C:/other"]), /invalid_multiplayer_gate_argument/);
  assert.throws(
    () =>
      parseGateArgs([
        "--game-path",
        "relative/game",
        "--expected-farmhand-id",
        "123456789",
        "--save-name",
        "GameBuddyFixture_X",
      ]),
    /invalid_multiplayer_gate_game_path/,
  );
  assert.throws(
    () =>
      parseGateArgs(["--game-path", "C:/game", "--expected-farmhand-id", "abc", "--save-name", "GameBuddyFixture_X"]),
    /invalid_multiplayer_gate_expected_farmhand_id/,
  );
  assert.throws(
    () =>
      parseGateArgs(["--game-path", "C:/game", "--expected-farmhand-id", "123456789", "--save-name", "NotAFixture"]),
    /invalid_multiplayer_gate_save_name/,
  );
  assert.throws(
    () =>
      parseGateArgs([
        "--game-path",
        "C:/game",
        "--expected-farmhand-id",
        "123456789",
        "--save-name",
        "GameBuddyFixture_X",
        "--timeout-seconds",
        "5",
      ]),
    /invalid_multiplayer_gate_timeout_seconds/,
  );
});

test("the private profile copies are armed, and the shared profiles are never written", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-multiplayer-gate-"));
  try {
    const profilesDir = join(root, "stardew-profiles");
    const formalHost = {
      HostFarmhandProvisioning: { Enable: true },
      HostAutomation: { Enable: true, FixtureScenario: "native_pickup_item_v1", SaveName: "GameBuddyFixture_X" },
      SaveId: "445094166",
      WorldId: "11",
      PlayerId: "123456789",
      CompanionId: "companion_01",
    };
    const formalAi = { FarmhandProvisioner: { Enable: true }, ExperimentalActions: [] };
    for (const [profile, config] of [
      ["A-host", formalHost],
      ["A-ai-client", formalAi],
    ]) {
      for (const relative of ["GameBuddy", "Mods/GameBuddy"]) {
        const directory = join(profilesDir, profile, relative);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
      }
    }

    const armed = await armGateProfiles({
      fixtureRoots: { profilesDir },
      runRoot: join(root, "run"),
      plan: resolveMultiplayerGatePlan({ action: "send_multiplayer_chat" }),
      expectedFarmhandId: "123456789",
    });

    // The AI copy opts into the Experimental action; the Host copy carries the
    // fixture scenario the chat lobby needs.
    const armedAi = JSON.parse(await readFile(join(armed.aiRoot, "Mods/GameBuddy/config.json"), "utf8"));
    assert.deepEqual(armedAi.ExperimentalActions, ["send_multiplayer_chat"]);
    const armedHost = JSON.parse(await readFile(join(armed.hostRoot, "Mods/GameBuddy/config.json"), "utf8"));
    assert.equal(armedHost.HostAutomation.FixtureScenario, "native_farmhand_chat_v1");
    assert.equal(armedHost.HostAutomation.SaveName, "GameBuddyFixture_X");
    // The scope the driver copies into the AI config is surfaced, so a profile
    // whose PlayerId is not this run's farmhand is visible before the run.
    assert.deepEqual(armed.hostScope, {
      saveId: true,
      worldId: true,
      playerIdMatchesExpectedFarmhandId: true,
      companionId: true,
    });

    // The SHARED profiles the lane was handed are untouched.
    const original = JSON.parse(await readFile(join(profilesDir, "A-host/Mods/GameBuddy/config.json"), "utf8"));
    assert.equal(original.HostAutomation.FixtureScenario, "native_pickup_item_v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a profile that is not in the formal attachment shape is refused by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-multiplayer-gate-"));
  try {
    const profilesDir = join(root, "stardew-profiles");
    for (const profile of ["A-host", "A-ai-client"]) {
      for (const relative of ["GameBuddy", "Mods/GameBuddy"]) {
        const directory = join(profilesDir, profile, relative);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "config.json"), "{}\n");
      }
    }
    await assert.rejects(
      armGateProfiles({
        fixtureRoots: { profilesDir },
        runRoot: join(root, "run"),
        plan: resolveMultiplayerGatePlan({ action: "send_multiplayer_chat" }),
        expectedFarmhandId: "123456789",
      }),
      /multiplayer_gate_profile_not_formal:A-host/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
