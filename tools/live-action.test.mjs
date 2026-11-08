/**
 * `tools/live-action.mjs` - the one-action live checker, tested without a game.
 *
 * Everything that can decide a run BEFORE a game exists is a pure function over the tree, a file or a directory: the
 * CLI, the plan and its refusals, the target and held-state vocabulary, the executor resolution and the answer a
 * held-state perturbation ended in. Those are falsified here. The live half (prepare, launch, attach, execute, restore)
 * is not touched: a suite that spawned the game would not be a suite.
 *
 * TWO GATES ARE IN THIS FILE, and neither is a happy-path test:
 *
 *  - the EXECUTOR GATE walks the whole action population the gate descriptors publish and demands that each action
 *    either resolves to exactly one callable executor of a recognised shape, or is refused BY NAME. The refused set is
 *    pinned: a new action that cannot be executed, or a runner that loses its `run*Smoke` export, makes this red.
 *  - the TRANSACTION GATE drives the real fixture lock and asserts the tool refuses while naming the owner, and that
 *    it did not touch the other lane's transaction - "never delete another transaction" is the claim, so it is
 *    measured on the directory.
 *
 * red-proof: fixture  the executor gate's population is the registry's own (127 action ids at the time of writing);
 * a runner renamed without its export, or a second `run*Smoke` added to a module, changes the refused set and fails
 * here. The transaction gate builds a real lock directory and asserts both the refusal code and that the lock survives.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureNativeLocalPlayer,
  verifyNativeLocalPlayerFixture,
} from "./lib/stardew-native-local-player-fixture.mjs";
import { GATE_EXEMPT_PUBLISHED_ACTIONS } from "./lib/stardew-published-action-registry.mjs";
import {
  buildBlock,
  chooseTargetRow,
  describeExercise,
  describeHeldAnswer,
  describeHeldState,
  describePlan,
  describeRecovery,
  EXECUTOR_CALL_SHAPES,
  heldToolCategories,
  parseLiveActionArguments,
  planLiveAction,
  planRecovery,
  readFixtureTransaction,
  reclaimGame,
  recoverFixture,
  refusalNote,
  resolveActionExecutor,
  restoreEnding,
  runOneAction,
  targetFieldFor,
  targetRows,
  teardown,
} from "./live-action.mjs";
import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "./stardew-action-gate-descriptors.mjs";

const SLOT = "GameBuddyFixtureTest_123456789";

function refusalOf(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  return null;
}

async function withFixtureRoot(run, { binding = true, template = true, lock = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-live-action-"));
  try {
    if (binding)
      writeFileSync(
        join(root, `${SLOT}.native-local-binding.json`),
        `${JSON.stringify({
          version: 1,
          logicalSaveName: "GameBuddyFixtureTest",
          observedSaveSlot: SLOT,
          saveId: "123456789",
          worldId: "123456789",
          playerId: "123456789",
          companionId: "companion_native_local",
        })}\n`,
      );
    if (template) mkdirSync(join(root, "templates", SLOT), { recursive: true });
    if (lock !== null) {
      const lockDirectory = join(root, ".stardew-native-local-player-fixture.lock");
      mkdirSync(lockDirectory, { recursive: true });
      writeFileSync(join(lockDirectory, "transaction.json"), `${JSON.stringify(lock)}\n`);
    }
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PLAN_ENV = Object.freeze({
  APPDATA: join(tmpdir(), "gamebuddy-live-action-appdata"),
  LOCALAPPDATA: join(tmpdir(), "gamebuddy-live-action-localappdata"),
});

/** The four fields `describeSaveAt` reads, in the shape the native save writes them. */
function saveXml(gameId, { season = "spring", year = 1, dayOfMonth = 1, daysPlayed = 1 } = {}) {
  return `<SaveGame>
  <player><farmName>GameBuddyFixtureTest</farmName></player>
  <uniqueIDForThisGame>${gameId}</uniqueIDForThisGame>
  <currentSeason>${season}</currentSeason>
  <year>${year}</year>
  <dayOfMonth>${dayOfMonth}</dayOfMonth>
  <playerStats><values><item><key><string>daysPlayed</string></key><value><unsignedInt>${daysPlayed}</unsignedInt></value></item></values></playerStats>
</SaveGame>`;
}

/** A fixture root whose template carries a real native save, which is what the pre-launch line describes. */
function writeTemplateSave(root, xml = saveXml("453048112"), saveName = SLOT) {
  mkdirSync(join(root, "templates", saveName), { recursive: true });
  writeFileSync(join(root, "templates", saveName, saveName), xml);
}

/** A profile whose save root this test owns, so "an earlier run left a working save" can be arranged. */
async function withSaveRoot(run) {
  const appData = mkdtempSync(join(tmpdir(), "gamebuddy-live-action-appdata-"));
  try {
    return await run({
      appData,
      saveRoot: join(appData, "StardewValley", "Saves"),
      env: { APPDATA: appData, LOCALAPPDATA: join(appData, "localappdata") },
    });
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
}

test("the CLI takes the action as an argument and defaults every knob it can", () => {
  const minimal = parseLiveActionArguments(["--action", "pet_animal"]);
  assert.equal(minimal.action, "pet_animal");
  assert.equal(minimal.target, "nearest");
  assert.equal(minimal.targetRequested, false, "the default is not a request, so it cannot demand a target field");
  assert.equal(minimal.held, null);
  assert.equal(minimal.windowMode, "hidden");
  assert.equal(minimal.timeoutSeconds, 180);
  assert.equal(minimal.terminalTimeoutMs, 30_000);
  assert.equal(minimal.dryRun, false);
  assert.equal(minimal.keepLog, false);

  const full = parseLiveActionArguments([
    "--action",
    "till_soil",
    "--held",
    "hoe",
    "--target",
    "first",
    "--keep-log",
    "--dry-run",
    "--fixture-root",
    "E:/tmp/fixtures",
    "--mods-path",
    "E:/tmp/mods",
    "--release-dir",
    "E:/tmp/release",
    "--game-path",
    "E:/tmp/game",
    "--save-name",
    SLOT,
    "--window-mode",
    "background",
    "--timeout-seconds",
    "90",
    "--terminal-timeout-ms",
    "5000",
  ]);
  assert.equal(full.held, "hoe");
  assert.equal(full.target, "first");
  assert.equal(full.targetRequested, true);
  assert.equal(full.keepLog, true);
  assert.equal(full.dryRun, true);
  assert.equal(full.windowMode, "background");
  assert.equal(full.timeoutSeconds, 90);
  assert.equal(full.terminalTimeoutMs, 5_000);

  assert.equal(parseLiveActionArguments(["--help"]).help, true);
  assert.equal(parseLiveActionArguments(["-h"]).help, true);
});

test("the CLI refuses by name, and a refusal is the code a caller branches on", () => {
  const cases = [
    [[], "missing_action"],
    [["--action"], "invalid_argument_value:--action"],
    [["--action", "Pet_Animal"], "invalid_action:Pet_Animal"],
    [["--action", "pet_animal", "--target", "furthest"], "invalid_target_policy:furthest"],
    [["--action", "pet_animal", "--window-mode", "tiny"], "invalid_window_mode:tiny"],
    [["--action", "pet_animal", "--timeout-seconds", "5"], "invalid_timeout_seconds:5"],
    [["--action", "pet_animal", "--terminal-timeout-ms", "10"], "invalid_terminal_timeout_ms:10"],
    [["--action", "pet_animal", "--action", "till_soil"], "duplicated_argument:--action"],
    [["--action", "pet_animal", "--wat"], "invalid_argument:--wat"],
    [["--action", "pet_animal", "--dry-run", "--dry-run"], "duplicated_argument:--dry-run"],
  ];
  for (const [argv, code] of cases) {
    const error = refusalOf(() => parseLiveActionArguments(argv));
    assert.ok(error !== null, `${argv.join(" ") || "(no arguments)"} must be refused`);
    assert.equal(error.message, code);
  }
});

test("--recover is its own mode: no action, no game, and an action it cannot honour is refused", () => {
  const recovery = parseLiveActionArguments(["--recover"]);
  assert.equal(recovery.recover, true);
  assert.equal(recovery.action, null);
  assert.equal(recovery.dryRun, false);
  assert.equal(parseLiveActionArguments(["--recover", "--dry-run"]).dryRun, true);
  const error = refusalOf(() => parseLiveActionArguments(["--recover", "--action", "pet_animal"]));
  assert.equal(error?.message, "recover_takes_no_action");
  assert.equal(parseLiveActionArguments(["--help"]).recover, false, "one mode does not imply the other");
});

test("recovery names the transaction a dead run left and releases it through the teardown's own restore", async () => {
  const lock = {
    version: 1,
    backupName: "native-local-pet-animal-fixture-backup",
    ownerId: "owner-dead-run",
    startedAtUnixMs: 1,
  };
  await withSaveRoot(async ({ saveRoot, env }) => {
    mkdirSync(join(saveRoot, SLOT), { recursive: true });
    writeFileSync(join(saveRoot, SLOT, SLOT), saveXml("777123"));
    await withFixtureRoot(
      async (root) => {
        const options = parseLiveActionArguments(["--recover", "--fixture-root", root]);
        const recovery = await planRecovery(options, { env });
        // The lock is the authority for WHICH transaction: the backup name and the dead owner are read from it.
        assert.deepEqual({ ...recovery.transaction }, { backupName: lock.backupName, ownerId: lock.ownerId });
        assert.equal(recovery.workingSave.path, join(saveRoot, SLOT));
        const described = describeRecovery(recovery);
        assert.equal(described.state, "recoverable");
        assert.equal(described.backupName, lock.backupName);
        assert.equal(described.ownerId, "owner-dead-run");
        // Describing it touched nothing.
        assert.equal(existsSync(join(root, ".stardew-native-local-player-fixture.lock", "transaction.json")), true);

        const calls = [];
        const facts = await recoverFixture(recovery, {
          listPids: () => [],
          release: (plan) => calls.push(`release:${plan.backupName}`),
          runHarness: ({ cleanup }) => calls.push(`harness:${String(cleanup)}`),
        });
        assert.deepEqual(
          calls,
          ["harness:true", `release:${lock.backupName}`],
          "the working save goes first, then the transaction",
        );
        assert.equal(facts.state, "recovered");
        assert.equal(facts.saveRestored, true);
        assert.equal(facts.fixtureRestored, true);
        assert.equal(facts.ownerId, "owner-dead-run");
        assert.deepEqual(facts.problems, []);
      },
      { lock },
    );
  });
});

test("recovery refuses under a running game, and a restore that refused is a blocked recovery", async () => {
  const recovery = {
    fixtureRoot: "E:/tmp/root",
    modsPath: "E:/tmp/root/mods",
    releaseDir: "E:/tmp/release",
    stardewSaveRoot: "E:/tmp/saves",
    saveName: SLOT,
    bindingProblem: null,
    transaction: { backupName: "native-local-pet-animal-fixture-backup", ownerId: "owner-dead-run" },
    workingSave: { path: "E:/tmp/saves/slot", present: true },
  };
  const running = await refusalOfAsync(() =>
    recoverFixture(recovery, { listPids: () => [10040], release: () => {}, runHarness: () => {} }),
  );
  assert.equal(running?.message, "live_action_game_already_running:10040");

  const facts = await recoverFixture(recovery, {
    listPids: () => [],
    runHarness: () => {},
    release: () => {
      throw new Error("live_action_fixture_restore_failed:1:restore_refused:owner_mismatch");
    },
  });
  assert.equal(facts.fixtureRestored, false);
  assert.equal(facts.saveRestored, true);
  assert.equal(facts.state, "blocked", "a release that refused is never reported as a recovery");
  assert.match(facts.problems.join("\n"), /live_action_fixture_restore_failed:1/u);
});

test("the held vocabulary is the surface's own enum, and an ordinary item id is pointed at its own flag", async () => {
  const categories = heldToolCategories();
  assert.ok(categories.length >= 10, `equip_tool publishes ${categories.length} tool categories`);
  assert.ok(categories.includes("axe") && categories.includes("hoe") && categories.includes("watering_can"));
  for (const category of categories) assert.match(category, /^[a-z][a-z0-9_]{0,31}$/u);

  await withFixtureRoot(async (root) => {
    // An item id through `--held` is not a bad argument: it is the OTHER flag's job, and the code says which one.
    const item = parseLiveActionArguments(["--action", "pet_animal", "--held", "(O)72", "--fixture-root", root]);
    const itemError = await refusalOfAsync(() => planLiveAction(item, { env: PLAN_ENV }));
    assert.equal(itemError?.message, "invalid_held_selector:(O)72:use_--held-item");

    // Anything else is still an argument fact.
    const nonsense = parseLiveActionArguments(["--action", "pet_animal", "--held", "wat", "--fixture-root", root]);
    const nonsenseError = await refusalOfAsync(() => planLiveAction(nonsense, { env: PLAN_ENV }));
    assert.equal(nonsenseError?.message, "invalid_held_selector:wat");

    // And a tool category still plans exactly as it did: the perturbation publishes equip_tool beside the action.
    const tool = await planLiveAction(
      parseLiveActionArguments(["--action", "pet_animal", "--held", "axe", "--fixture-root", root]),
      { env: PLAN_ENV },
    );
    assert.equal(tool.held, "axe");
    assert.equal(tool.heldItem, null);
    assert.equal(tool.heldRunnerFile, "run-stardew-native-local-player-equip-tool-smoke.mjs");
    assert.deepEqual(tool.heldExtra, ["equip_tool"]);

    // The declared hand is a FIXTURE Given: it must not widen the action set with equip_tool, and it must reach the
    // config the harness writes under exactly the field the Mod reads.
    const declared = await planLiveAction(
      parseLiveActionArguments(["--action", "pet_animal", "--held-item", "(O)72", "--fixture-root", root]),
      { env: PLAN_ENV },
    );
    assert.equal(declared.heldItem, "(O)72");
    assert.equal(declared.held, null);
    assert.deepEqual(declared.heldExtra, [], "a declared hand needs no action: the fixture mints it");
    assert.deepEqual(declared.actions, ["pet_animal"]);
    assert.equal(declared.scenario, "native_pet_animal_v1");
    assert.deepEqual(describePlan(declared).heldItem, {
      qualifiedItemId: "(O)72",
      appliedBy: "NativeLocalPlayerFixture.HeldItemQualifiedId",
    });
    assert.match(describeExercise(declared), /held=item:\(O\)72 \(fixture HeldItemQualifiedId\)/u);
  });
});

test("the declared hand reaches the written config, and a config that lost it is refused on the read-back", () => {
  const binding = {
    version: 1,
    logicalSaveName: "GameBuddyFixtureTest",
    observedSaveSlot: SLOT,
    saveId: "123456789",
    worldId: "123456789",
    playerId: "123456789",
    companionId: "companion_native_local",
  };
  const withHand = configureNativeLocalPlayer(null, SLOT, 180, ["pet_animal"], binding, "pet_animal", [], "(O)72");
  assert.equal(withHand.NativeLocalPlayerFixture.HeldItemQualifiedId, "(O)72");
  assert.equal(withHand.NativeLocalPlayerFixture.FixtureScenario, "native_pet_animal_v1");
  // Every run that declares no hand keeps the empty statement the Mod reads as "this scenario declares none".
  const plain = configureNativeLocalPlayer(null, SLOT, 180, ["pet_animal"], binding, "pet_animal", []);
  assert.equal(plain.NativeLocalPlayerFixture.HeldItemQualifiedId, "");
  // A run that replaces a config that had a hand must not inherit it: the field is the fixture's, not the file's.
  const inherited = configureNativeLocalPlayer(withHand, SLOT, 180, ["pet_animal"], binding, "pet_animal", []);
  assert.equal(inherited.NativeLocalPlayerFixture.HeldItemQualifiedId, "");
});

test("a config that lost the declared hand is refused when the fixture reads it back", async () => {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-live-action-verify-"));
  try {
    const modsPath = join(root, "mods");
    const releaseDir = join(root, "release");
    const modRoot = join(modsPath, "GameBuddy");
    mkdirSync(modRoot, { recursive: true });
    mkdirSync(releaseDir, { recursive: true });
    for (const name of [
      "GameBuddy.Stardew.dll",
      "GameBuddy.Stardew.Core.dll",
      "manifest.json",
      "GameBuddy.Stardew.deps.json",
    ])
      writeFileSync(join(modRoot, name), "");
    const binding = {
      version: 1,
      logicalSaveName: "GameBuddyFixtureTest",
      observedSaveSlot: SLOT,
      saveId: "123456789",
      worldId: "123456789",
      playerId: "123456789",
      companionId: "companion_native_local",
    };
    writeFileSync(
      join(modRoot, "config.json"),
      JSON.stringify(configureNativeLocalPlayer(null, SLOT, 180, ["pet_animal"], binding, "pet_animal", [], "(O)72")),
    );
    const options = {
      root,
      modsPath,
      releaseDir,
      saveName: SLOT,
      action: "pet_animal",
      heldItemQualifiedId: "(O)72",
    };
    const verified = await verifyNativeLocalPlayerFixture(options);
    assert.equal(verified.state, "verified");
    // A writer that forgot the field would leave a world with the wrong hand, and nothing downstream could tell: the
    // read-back is the only place the loss is visible, so it refuses instead of verifying.
    const lost = await refusalOfAsync(() => verifyNativeLocalPlayerFixture({ ...options, heldItemQualifiedId: "" }));
    assert.equal(lost?.message, "native_local_fixture_config_invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the two held flags name one hand each, and both together are refused by name", () => {
  const error = refusalOf(() =>
    parseLiveActionArguments(["--action", "pet_animal", "--held", "axe", "--held-item", "(O)72"]),
  );
  assert.equal(error?.message, "live_action_held_conflict");
  const malformed = refusalOf(() => parseLiveActionArguments(["--action", "pet_animal", "--held-item", "72"]));
  assert.equal(malformed?.message, "invalid_held_item:72");
  assert.equal(parseLiveActionArguments(["--action", "pet_animal", "--held-item", "(H)0"]).heldItem, "(H)0");
});

test("a declared hand the world does not show is refused before the action, and the hand is reported by id", async () => {
  // The world disagrees: the fixture named `(O)72` and the selected slot holds something else (here: nothing).
  const { plan, config } = await planForStub({ held: null, heldItem: "(O)72" });
  const wrong = stubBridgeSession({ holding: null, holdingItem: null });
  const error = await refusalOfAsync(() => runOneAction({ plan, session: wrong, config }));
  assert.equal(error?.message, "live_action_held_item_not_in_hand:(O)72");
  assert.deepEqual(error.detail, {
    declared: "(O)72",
    observed: { tool: null, slot: 0, item: null },
  });
  assert.deepEqual(wrong.executed, [], "nothing may be executed against a hand nobody declared");
  assert.match(refusalNote(error.message), /not measured/u);

  // The world agrees: the hand is the declared id, and it is still there after the action.
  const agreeing = stubBridgeSession({ holding: null, holdingItem: "(O)72" });
  const outcome = await runOneAction({ plan, session: agreeing, config });
  assert.deepEqual(outcome.heldItem, {
    qualifiedItemId: "(O)72",
    slotBefore: 2,
    inHandBefore: true,
    inHandAfter: true,
  });
  assert.deepEqual(agreeing.executed, ["pet_animal"], "no equip_tool: a declared hand needs no action");

  const block = buildBlock({
    plan,
    verdict: "passed",
    reasonCode: outcome.executorResult.reasonCode,
    target: outcome.target,
    held: { before: outcome.heldBefore, after: describeHeldState(outcome.snapshotReread) },
    heldItem: outcome.heldItem,
    receipts: agreeing.receipts,
    reread: outcome.snapshotReread,
    perturbation: null,
    restore: { fixtureRestored: true, saveRestored: true, process: { stillRunning: [] } },
    startedAt: Date.now(),
  });
  process.stdout.write(
    `live_action_held_item_block: ${JSON.stringify({ held: block.held, heldItem: block.heldItem })}\n`,
  );
  assert.equal(block.held.before.item, "(O)72");
  assert.equal(block.held.after.item, "(O)72");
});

test("a leftover working save refuses the launch before any fixture mutation, naming its mtime and identity", async () => {
  await withSaveRoot(async ({ saveRoot, env }) => {
    mkdirSync(join(saveRoot, SLOT), { recursive: true });
    const saveFile = join(saveRoot, SLOT, SLOT);
    writeFileSync(saveFile, saveXml("777123", { dayOfMonth: 3, daysPlayed: 3 }));
    const mtime = statSync(saveFile).mtime.toISOString();

    await withFixtureRoot(async (root) => {
      writeTemplateSave(root);
      const before = readdirSync(root).sort();
      const error = await refusalOfAsync(() =>
        planLiveAction(parseLiveActionArguments(["--action", "pet_animal", "--fixture-root", root]), { env }),
      );
      assert.equal(error?.message, `live_action_working_save_present:${join(saveRoot, SLOT)}`);
      // The numbers a reader needs to recognise the world: when it was written, which game it is, and its calendar.
      assert.equal(error.detail.mtime, mtime);
      assert.equal(error.detail.gameId, "777123");
      assert.deepEqual(error.detail.calendar, { season: "spring", year: 1, dayOfMonth: 3, daysPlayed: 3 });
      // Before any fixture mutation: the root is byte-identical, with no lock and no backup.
      assert.deepEqual(readdirSync(root).sort(), before);
      assert.equal(existsSync(join(root, ".stardew-native-local-player-fixture.lock")), false);
      assert.equal(existsSync(join(root, "native-local-pet-animal-fixture-backup")), false);
    });
  });
});

test("the pre-launch line names what will be exercised, and the world it will be loaded from", async () => {
  await withFixtureRoot(async (root) => {
    writeTemplateSave(root);
    const templateSave = join(root, "templates", SLOT, SLOT);
    const mtime = statSync(templateSave).mtime.toISOString();
    const plan = await planLiveAction(
      parseLiveActionArguments(["--action", "pet_animal", "--held", "axe", "--fixture-root", root]),
      { env: PLAN_ENV },
    );
    const line = describeExercise(plan);
    assert.match(line, /action=pet_animal/u);
    assert.match(line, /family=petTargets/u);
    // Never a predicted count: the population is read at attach, so a number here would be a guess.
    assert.match(line, /targets=counted-at-attach/u);
    assert.match(line, /held=tool:axe \(via equip_tool\)/u);
    assert.match(line, /scenario=native_pet_animal_v1/u);
    assert.ok(line.includes(`save=${join(PLAN_ENV.APPDATA, "StardewValley", "Saves", SLOT)}(absent)`));
    // A reader must be able to tell a pristine template from one that has been played.
    assert.ok(line.includes(`mtime=${mtime}`));
    assert.ok(line.includes("gameId=453048112"));
    assert.ok(line.includes("spring 1 Y1 (dayOfMonth=1, daysPlayed=1)"));
    process.stdout.write(`live_action_exercise_line: ${line}\n`);

    // `--dry-run` prints the same two records rather than a promise.
    const printed = describePlan(plan);
    assert.equal(printed.workingSave.present, false);
    assert.equal(printed.template.gameId, "453048112");
  });
});

test("a held perturbation publishes equip_tool beside the action only when the scenario does not", async () => {
  await withFixtureRoot(async (root) => {
    const plain = await planLiveAction(parseLiveActionArguments(["--action", "pet_animal", "--fixture-root", root]), {
      env: PLAN_ENV,
    });
    assert.deepEqual(plain.actions, ["pet_animal"]);
    assert.deepEqual(plain.heldExtra, []);
    assert.equal(plain.scenario, "native_pet_animal_v1");

    const held = await planLiveAction(
      parseLiveActionArguments(["--action", "pet_animal", "--held", "axe", "--fixture-root", root]),
      { env: PLAN_ENV },
    );
    assert.deepEqual(held.heldExtra, ["equip_tool"]);
    assert.deepEqual(held.actions, ["pet_animal", "equip_tool"]);
    assert.equal(held.scenario, "native_pet_animal_v1", "the perturbation must not change the world it runs in");

    // till_soil already publishes equip_tool as its own tool-selection prerequisite: nothing is widened.
    const already = await planLiveAction(
      parseLiveActionArguments(["--action", "till_soil", "--held", "hoe", "--fixture-root", root]),
      { env: PLAN_ENV },
    );
    assert.deepEqual(already.heldExtra, []);
    assert.ok(already.actions.includes("equip_tool"));
  });
});

test("the plan resolves the roots, the client config and the executor that the live form will use", async () => {
  await withFixtureRoot(async (root) => {
    const plan = await planLiveAction(parseLiveActionArguments(["--action", "pet_animal", "--fixture-root", root]), {
      env: PLAN_ENV,
    });
    assert.equal(plan.saveName, SLOT, "the root's single binding names the observed slot");
    assert.equal(plan.clientConfigPath, join(root, "mods", "GameBuddy", "config.json"));
    assert.equal(plan.modsPath, join(root, "mods"));
    assert.equal(plan.backupName, "native-local-pet-animal-fixture-backup");
    assert.equal(plan.executor.runnerFile, "run-stardew-native-local-player-pet-animal-smoke.mjs");
    assert.equal(plan.executor.export, "runPetAnimalSmoke");
    assert.equal(plan.executor.shape, "receipts-second");
    assert.equal(plan.stardewSaveRoot, join(PLAN_ENV.APPDATA, "StardewValley", "Saves"));
    assert.equal(plan.targetField, "petTargets");

    const printed = describePlan(plan);
    assert.equal(printed.state, "planned");
    for (const key of ["fixtureRoot", "modsPath", "releaseDir", "clientConfigPath", "action", "held", "target"]) {
      assert.ok(key in printed, `--dry-run must print ${key}`);
    }
    assert.equal(printed.target.policy, "nearest");
    assert.equal(printed.held, null);
  });
});

test("the plan refuses what a live run would pay for after a boot", async () => {
  await withFixtureRoot(async (root) => {
    const transaction = await refusalOfAsync(() =>
      planLiveAction(parseLiveActionArguments(["--action", "pet_animal", "--fixture-root", root]), { env: PLAN_ENV }),
    );
    assert.equal(transaction, null, "a free root plans");

    const unknown = await refusalOfAsync(() =>
      planLiveAction(parseLiveActionArguments(["--action", "not_an_action", "--fixture-root", root]), {
        env: PLAN_ENV,
      }),
    );
    assert.equal(unknown?.message, "unknown_stardew_action_id");
  });

  await withFixtureRoot(
    async (root) => {
      const options = parseLiveActionArguments(["--action", "pet_animal", "--fixture-root", root]);
      const error = await refusalOfAsync(() => planLiveAction(options, { env: PLAN_ENV }));
      assert.equal(error?.message, "live_action_binding_missing:" + root);
    },
    { binding: false },
  );

  await withFixtureRoot(
    async (root) => {
      const options = parseLiveActionArguments(["--action", "pet_animal", "--fixture-root", root]);
      const error = await refusalOfAsync(() => planLiveAction(options, { env: PLAN_ENV }));
      assert.equal(error?.message, `live_action_template_missing:${join(root, "templates", SLOT)}`);
    },
    { template: false },
  );

  await withFixtureRoot(async (root) => {
    const options = parseLiveActionArguments([
      "--action",
      "move_to_tile",
      "--target",
      "nearest",
      "--fixture-root",
      root,
    ]);
    const error = await refusalOfAsync(() => planLiveAction(options, { env: PLAN_ENV }));
    assert.equal(error?.message, "target_policy_unavailable:move_to_tile:no_declared_target_field");
  });
});

test("a live fixture transaction is refused with its owner named, and left exactly where it is", async () => {
  const lock = {
    version: 1,
    backupName: "native-local-pet-animal-fixture-backup",
    ownerId: "owner-lane-b",
    startedAtUnixMs: 1,
  };
  const recorded = { backupName: lock.backupName, ownerId: lock.ownerId };
  await withFixtureRoot(
    async (root) => {
      const before = statSync(join(root, ".stardew-native-local-player-fixture.lock", "transaction.json")).mtimeMs;
      const transaction = readFixtureTransaction(root);
      assert.deepEqual({ ...transaction }, recorded);

      const options = parseLiveActionArguments(["--action", "pet_animal", "--fixture-root", root]);
      const error = await refusalOfAsync(() => planLiveAction(options, { env: PLAN_ENV }));
      assert.equal(error?.message, "live_action_transaction_live:native-local-pet-animal-fixture-backup:owner-lane-b");
      assert.equal(error.code, error.message);

      // Never delete another transaction: the refusal is the whole effect.
      const after = statSync(join(root, ".stardew-native-local-player-fixture.lock", "transaction.json")).mtimeMs;
      assert.equal(after, before);
      assert.deepEqual({ ...readFixtureTransaction(root) }, recorded);
    },
    { lock },
  );
});

test("the executor population is the registry's, and every member either resolves or refuses by name", async () => {
  const population = new Set();
  for (const gate of STARDEW_PUBLISHED_ACTION_GATES) population.add(gate.actionId);
  for (const actionId of Object.keys(STARDEW_EXPERIMENTAL_ACTION_RUNNERS)) population.add(actionId);
  for (const exempt of GATE_EXEMPT_PUBLISHED_ACTIONS) population.add(exempt.actionId);
  assert.ok(population.size >= 100, `examined ${population.size} action ids`);

  // Measured 2026-11-09. These six predate the `run<X>Smoke(client, receipts, config)` convention; the tool refuses
  // them BY NAME rather than guessing a call shape, and a seventh (or a fixed one) must move this list deliberately.
  const knownUnavailable = Object.freeze({
    dismiss_modal: "action_executor_missing:run-stardew-native-local-player-wia-modal-dismiss-chain-smoke.mjs",
    move_stall_probe_npc: "action_executor_missing:run-stardew-native-local-player-move-stall-probe-smoke.mjs",
    move_stall_probe_pet: "action_executor_missing:run-stardew-native-local-player-move-stall-probe-smoke.mjs",
    respond_level_up:
      "action_executor_ambiguous:run-stardew-native-local-player-respond-level-up-smoke.mjs:runRespondLevelUpBranchSmoke+runRespondLevelUpSmoke",
    scene_reachable_probe: "action_executor_missing:run-stardew-native-local-player-scene-reachable-probe-smoke.mjs",
    wia_modal_dismiss_chain:
      "action_executor_missing:run-stardew-native-local-player-wia-modal-dismiss-chain-smoke.mjs",
  });

  const unavailable = {};
  let executable = 0;
  for (const actionId of [...population].sort()) {
    try {
      const executor = await resolveActionExecutor(actionId);
      executable += 1;
      assert.match(executor.export, /^run[A-Za-z0-9]*Smoke$/u, `${actionId} resolves to a smoke executor`);
      assert.ok(
        Object.hasOwn(EXECUTOR_CALL_SHAPES, executor.shape),
        `${actionId} resolved to the recognised call shape ${executor.shape}`,
      );
    } catch (error) {
      assert.match(
        error.message,
        /^action_executor_(?:missing|ambiguous|signature_unrecognised):/u,
        `${actionId} was refused by a code this tool does not publish: ${error.message}`,
      );
      unavailable[actionId] = error.message;
    }
  }
  assert.ok(executable > 0, "an examinable population of zero agrees with itself");
  assert.deepEqual(unavailable, { ...knownUnavailable });
  process.stdout.write(
    `live_action_executor_gate: examined ${population.size}; executable ${executable}; refused ${Object.keys(unavailable).length}\n`,
  );
});

test("the target policy reads the declared field, and nearest is the closest row", () => {
  assert.equal(targetFieldFor("pet_animal"), "petTargets");
  assert.equal(targetFieldFor("water_crop"), "cropTargets");
  assert.equal(targetFieldFor("move_to_tile"), null);

  const rows = targetRows(
    {
      petTargets: [
        { targetId: "pet_far", x: 9, y: 9 },
        { targetId: "pet_near", x: 4, y: 4 },
        { targetId: "pet_edge", x: 6, y: 4 },
      ],
    },
    "petTargets",
  );
  assert.equal(rows.length, 3);
  assert.equal(chooseTargetRow(rows, "nearest", { x: 4, y: 5 }).targetId, "pet_near");
  assert.equal(chooseTargetRow(rows, "first", { x: 4, y: 5 }).targetId, "pet_far");
  // A row with no tile cannot be ranked; it never displaces a ranked one, and it is not dropped either.
  const mixed = [...rows, { targetId: "pet_untiled", x: null, y: null }];
  assert.equal(chooseTargetRow(mixed, "nearest", { x: 100, y: 100 }).targetId, "pet_far");
  assert.equal(chooseTargetRow([], "nearest", { x: 0, y: 0 }), null);
  assert.deepEqual(targetRows({}, "petTargets"), []);
  assert.ok(targetRows({ petTargets: new Array(20).fill({ targetId: "t", x: 1, y: 1 }) }, "petTargets").length <= 5);
});

test("the held state is read off the projection, and every declared perturbation ending is classified", () => {
  assert.deepEqual(describeHeldState({ currentTool: "(T)Axe", currentToolSlot: 2, currentToolSlotItem: "(T)Axe" }), {
    tool: "(T)Axe",
    slot: 2,
    item: "(T)Axe",
  });
  assert.deepEqual(describeHeldState({}), { tool: null, slot: null, item: null });

  const held = { tool: "(T)Axe", slot: 2, item: "(T)Axe" };
  // Ending 1: it selected what it needed and put the hand back.
  assert.deepEqual(
    describeHeldAnswer({
      receipt: {
        state: "succeeded",
        reasonCode: "soil_tilled",
        evidence: { detail: "tool_selected=hoe;tool_restored=axe" },
      },
      heldBefore: held,
      heldAfter: held,
    }),
    { answer: "selected_and_restored", ok: true, selected: "hoe", restored: "axe" },
  );
  // Ending 1 without a selection: the action never needed the hand (the Pet case).
  assert.deepEqual(
    describeHeldAnswer({
      receipt: {
        state: "succeeded",
        reasonCode: "pet_completed",
        evidence: { detail: "target=pet_x;friendship_after=12" },
      },
      heldBefore: held,
      heldAfter: held,
    }),
    { answer: "ran_without_selecting", ok: true },
  );
  // Ending 2: it refused by name.
  assert.deepEqual(
    describeHeldAnswer({
      receipt: { state: "rejected", reasonCode: "hands_not_empty", evidence: null },
      heldBefore: held,
      heldAfter: held,
    }),
    { answer: "refused_by_name:hands_not_empty", ok: true, reasonCode: "hands_not_empty" },
  );
  // A selection that did not put the hand back is named, not accepted.
  assert.equal(
    describeHeldAnswer({
      receipt: { state: "succeeded", reasonCode: "soil_tilled", evidence: { detail: "tool_selected=hoe" } },
      heldBefore: held,
      heldAfter: held,
    }).ok,
    false,
  );
  // Silence: no receipt at all, or one with no reason code, is the failure the rule names.
  assert.deepEqual(describeHeldAnswer({ receipt: null, heldBefore: held, heldAfter: held }), {
    answer: "no_answer",
    ok: false,
  });
  assert.deepEqual(
    describeHeldAnswer({ receipt: { state: "succeeded", reasonCode: "" }, heldBefore: held, heldAfter: held }),
    { answer: "no_answer", ok: false },
  );
});

test("one action runs end to end over a stub bridge: perturbation, executor, receipt, then the engine's re-read", async () => {
  const { plan, config } = await planForStub();
  const session = stubBridgeSession({ holding: null });
  const outcome = await runOneAction({ plan, session, config });

  // The perturbation ran FIRST, through equip_tool's own gate runner, and the hand it put in place is what the
  // action under test started with.
  assert.equal(outcome.perturbation.state, "passed");
  assert.equal(outcome.perturbation.receipt.reasonCode, "tool_equipped");
  assert.equal(outcome.perturbation.receipt.evidence, "tool=axe;before=none;expected=(T)Axe;after=(T)Axe");
  assert.deepEqual(outcome.heldBefore, { tool: "(T)Axe", slot: 2, item: "(T)Axe" });

  // The executor is the real pet-animal contract, and its verdict is the run's verdict.
  assert.equal(outcome.executorResult.state, "passed", outcome.executorResult.reasonCode);
  assert.equal(outcome.executorResult.reasonCode, "pet_completed");

  // The target this run was pointed at came from the snapshot's own declared field, not from a guess.
  assert.equal(outcome.target.chosen.targetId, "pet_0123456789abcdef");
  assert.equal(outcome.target.rows.length, 1);

  // The hand the Pet action started with was the one the perturbation left, and it came back untouched: an action
  // that needed no tool is an ANSWER (HeldStatePerturbationTests ending 1), not a silence.
  assert.deepEqual(outcome.perturbation.answer, { answer: "ran_without_selecting", ok: true });

  // The re-read is the ENGINE's post-state: the Pet is gone from the projection the Mod publishes.
  assert.deepEqual(outcome.snapshotReread.petTargets, []);
  assert.ok(outcome.snapshotReread.revision > outcome.snapshotBefore.revision);
});

test("an empty target family is refused at the first observation, naming the family and the armed scenario", async () => {
  const { plan, config } = await planForStub({ held: null });
  const session = stubBridgeSession({ pets: [] });
  const error = await refusalOfAsync(() => runOneAction({ plan, session, config }));

  assert.equal(error?.message, "live_action_target_family_empty:petTargets:native_pet_animal_v1");
  // The whole point: the executor never ran, so there is no action and no receipt to mistake for a measurement.
  assert.deepEqual(session.executed, []);
  assert.deepEqual(session.receipts, []);

  const block = buildBlock({
    plan,
    verdict: "blocked",
    reasonCode: error.message,
    target: null,
    held: { before: describeHeldState(session.client.state.snapshot), after: null },
    receipts: session.receipts,
    reread: null,
    perturbation: null,
    restore: { fixtureRestored: true, saveRestored: true, process: { stillRunning: [] } },
    startedAt: Date.now(),
  });
  process.stdout.write(`live_action_empty_family_block: ${JSON.stringify(block)}\n`);
  assert.equal(block.state, "blocked");
  assert.equal(block.receipt, null);
  // `measured: false` with `count: null` is what keeps "nobody looked" from printing as "the world had none".
  assert.deepEqual(block.target, {
    policy: "nearest",
    field: "petTargets",
    scenario: "native_pet_animal_v1",
    measured: false,
    count: null,
    chosen: null,
    matchesReceipt: null,
  });
});

test("a process the run started that is still alive is a blocked ending naming the pid", async () => {
  const killed = [];
  const launch = await reclaimGame({
    handle: { pid: 10040, close: async () => ({ outcome: "killed" }) },
    listPids: () => [10040],
    kill: (pid) => {
      killed.push(pid);
      return "killed";
    },
    sleep: async () => {},
    attempts: 3,
    pollMs: 0,
  });
  assert.equal(launch.pid, 10040);
  assert.equal(launch.killOutcome, "killed");
  assert.deepEqual(launch.stillRunning, [10040]);
  assert.deepEqual(killed, [10040, 10040, 10040], "every retry kills the exact pid, never an image name");
  assert.equal(
    restoreEnding({ fixtureRestored: false, saveRestored: false, process: launch }),
    "live_action_process_still_running:10040",
  );

  // A run whose process survived has not restored anything it can vouch for, and it does not say it did.
  const stage = {
    prepared: true,
    saveRestored: true,
    handle: { pid: 10040, close: async () => ({ outcome: "killed" }) },
    session: null,
    logPath: null,
    keepLog: false,
  };
  const facts = await teardown({
    plan: {},
    stage,
    trap: null,
    reclaim: async () => launch,
    runHarness: () => {
      throw new Error("live_action_save_harness_must_not_run_while_the_game_is_alive");
    },
    release: () => {
      throw new Error("live_action_fixture_must_not_be_released_while_the_game_is_alive");
    },
  });
  assert.equal(facts.fixtureRestored, false);
  assert.equal(facts.saveRestored, false);
  assert.deepEqual(facts.process.stillRunning, [10040]);
  assert.equal(stage.handle, null, "the handle is consumed exactly once");
  assert.equal(restoreEnding(facts), "live_action_process_still_running:10040");
});

test("a game that exits inside the budget is reclaimed, and the save is cleaned before the transaction is released", async () => {
  const answers = [[10040], []];
  const launch = await reclaimGame({
    handle: { pid: 10040, close: async () => ({ outcome: "already_exited" }) },
    listPids: () => answers.shift() ?? [],
    kill: () => "killed",
    sleep: async () => {},
  });
  assert.deepEqual(launch.stillRunning, []);

  const calls = [];
  const stage = {
    prepared: true,
    saveRestored: true,
    handle: { pid: 10040, close: async () => ({ outcome: "already_exited" }) },
    session: null,
    logPath: null,
    keepLog: false,
  };
  const facts = await teardown({
    plan: {},
    stage,
    trap: null,
    reclaim: async () => launch,
    runHarness: ({ cleanup }) => calls.push(`harness:${String(cleanup)}`),
    release: () => calls.push("release"),
  });
  assert.deepEqual(calls, ["harness:true", "release"], "the save is cleared before the transaction is released");
  assert.equal(facts.saveRestored, true);
  assert.equal(facts.fixtureRestored, true);
  assert.equal(restoreEnding(facts), null);
});

test("a restore that refused, and a save that could not be cleaned, are blocked endings rather than restore claims", async () => {
  const baseStage = () => ({
    prepared: true,
    saveRestored: true,
    handle: { pid: 4242, close: async () => ({ outcome: "already_exited" }) },
    session: null,
    logPath: null,
    keepLog: false,
  });
  const reclaimed = { pid: 4242, killOutcome: "already_exited", killError: null, stillRunning: [] };

  const releaseRefused = await teardown({
    plan: {},
    stage: baseStage(),
    trap: null,
    reclaim: async () => reclaimed,
    runHarness: () => {},
    release: () => {
      throw new Error(
        "live_action_fixture_restore_failed:1:restore_refused:native_local_fixture_transaction_owner_mismatch",
      );
    },
  });
  assert.equal(releaseRefused.fixtureRestored, false, "a child that refused is never reported as a restore");
  assert.equal(releaseRefused.saveRestored, true);
  assert.equal(restoreEnding(releaseRefused), "live_action_fixture_not_restored");

  const cleanupRefused = await teardown({
    plan: {},
    stage: baseStage(),
    trap: null,
    reclaim: async () => reclaimed,
    runHarness: () => {
      throw new Error("working_save_cleanup_failed:1:Refusing fixture file operation while Stardew/SMAPI is running");
    },
    release: () => {},
  });
  assert.equal(cleanupRefused.saveRestored, false);
  assert.equal(cleanupRefused.fixtureRestored, true);
  // The next slice reads this save, so a dirty one is an ending, not a footnote.
  assert.equal(restoreEnding(cleanupRefused), "live_action_working_save_not_restored");
});

test("a fixture release whose child refused is reported as a failed restore, not as a restored one", async () => {
  await withFixtureRoot(async (root) => {
    const modsPath = join(root, "mods");
    const releaseDir = join(root, "release");
    mkdirSync(join(modsPath, "GameBuddy"), { recursive: true });
    mkdirSync(releaseDir, { recursive: true });
    // No transaction was ever opened in this root, so the real restore child refuses and exits non-zero — which is
    // exactly the shape the old code discarded while printing `fixtureRestored: true`.
    const facts = await teardown({
      plan: { fixtureRoot: root, modsPath, releaseDir, backupName: "native-local-pet-animal-fixture-backup" },
      stage: { prepared: true, saveRestored: false, handle: null, session: null, logPath: null, keepLog: false },
      trap: null,
      reclaim: async () => ({ pid: null, killOutcome: null, killError: null, stillRunning: [] }),
      runHarness: () => {},
    });
    assert.equal(facts.fixtureRestored, false);
    assert.match(facts.problems.join("\n"), /live_action_fixture_restore_failed:1/u);
    assert.equal(restoreEnding(facts), "live_action_fixture_not_restored");
  });
});

async function planForStub({ held = "axe", heldItem = null } = {}) {
  const plan = await withFixtureRoot((root) =>
    planLiveAction(
      parseLiveActionArguments([
        "--action",
        "pet_animal",
        ...(held === null ? [] : ["--held", held]),
        ...(heldItem === null ? [] : ["--held-item", heldItem]),
        "--fixture-root",
        root,
      ]),
      { env: PLAN_ENV },
    ),
  );
  return { plan, config: stubClientConfig(plan) };
}

function stubClientConfig(plan) {
  return {
    PipeName: "gamebuddy-stardew",
    BridgeToken: "0123456789abcdef0123456789abcdef",
    SaveId: plan.binding.saveId,
    WorldId: plan.binding.worldId,
    PlayerId: plan.binding.playerId,
    CompanionId: plan.binding.companionId,
    NativeLocalPlayerFixture: {
      Enable: true,
      Bootstrap: { Enable: false },
      LogicalSaveName: "GameBuddyFixtureTest",
      ObservedSaveSlot: SLOT,
      TimeoutSeconds: 180,
      FixtureScenario: plan.scenario,
    },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: [],
  };
}

/**
 * A stub bridge: the boundary this tool does not own. It answers the two calls the contract makes (`observe`,
 * `execute`) and pushes the terminal receipt the way the real Mod's fact stream does, so the code under test reads a
 * receipt from the session's own buffer exactly as it will live.
 *
 * `pets` is the world's published target family: an empty array is the armed scenario that publishes nothing, which is
 * the case this suite has to be able to arrange without a game. `executed` is the call log, so "the executor never ran"
 * is asserted rather than inferred from a missing receipt.
 */
function stubBridgeSession({ holding = null, holdingItem = null, pets = null }) {
  const pet = {
    targetId: "pet_0123456789abcdef",
    x: 6,
    y: 5,
    petType: "Dog",
    friendship: 0,
    pettedToday: false,
    stationary: true,
  };
  let revision = 10;
  // `holding` is what the projection calls a TOOL (`currentTool`, e.g. `(T)Axe`); `holdingItem` is the qualified id of
  // whatever occupies the selected slot, which for an ordinary item is the item and `currentTool` is null.
  let currentTool = holding;
  let currentItem = holdingItem ?? holding;
  let ownSlot = currentItem === null ? 0 : 2;
  let petTargets = pets === null ? [pet] : [...pets];
  const executed = [];
  const snapshot = () => ({
    revision,
    location: "Farm",
    tile: { x: 5, y: 5 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "inspect_self", "pet_animal", "equip_tool"],
    currentTool,
    currentToolSlot: ownSlot,
    currentToolSlotItem: currentItem,
    petTargets: petTargets.map((row) => ({ ...row })),
  });
  const receipts = [];
  const client = {
    state: { snapshot: null },
    async observe() {
      const value = snapshot();
      client.state.snapshot = value;
      return value;
    },
    async execute(request) {
      executed.push(request.action);
      revision += 1;
      const executionId = `exec_${revision}`;
      const terminal = {
        requestId: request.requestId,
        executionId,
        actionId: request.action,
        state: "succeeded",
        revision,
        ...(request.action === "equip_tool"
          ? { reasonCode: "tool_equipped", evidence: { detail: "tool=axe;before=none;expected=(T)Axe;after=(T)Axe" } }
          : {
              reasonCode: "pet_completed",
              evidence: {
                detail:
                  "day_recorded=true;friendship_after=12;friendship_before=0;friendship_callback=true;" +
                  "location=Farm;pet_day=1;target=pet_0123456789abcdef;tile=6,5",
              },
            }),
      };
      if (request.action === "equip_tool") {
        currentTool = "(T)Axe";
        currentItem = "(T)Axe";
        ownSlot = 2;
      } else petTargets = [];
      receipts.push(terminal);
      return { requestId: request.requestId, executionId, state: "accepted" };
    },
  };
  return { client, receipts, executed, async close() {} };
}

async function refusalOfAsync(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return null;
}
