/**
 * `tools/live-program.mjs` - the one-plan-form live checker, tested without a game.
 *
 * Everything that can decide a run BEFORE a game exists is a pure function over the tree, a file or a directory: the CLI
 * and its two subjects, the script reader, the plan and its refusals, the loop families a program reads, the admission
 * answer a node challenge gets, the row receipts a loop minted, and the three-word verdict. Those are falsified here. The
 * live half (prepare, launch, attach, submit, settle, restore) is not touched: a suite that spawned the game would not be
 * a suite.
 *
 * THREE GATES ARE IN THIS FILE, and none is a happy-path test:
 *
 *  - the SUBJECT GATE drives the CLI: `--action` - the OTHER subject's flag - is refused by name rather than quietly
 *    accepted, so `live-program` and `live-action` stay two named subjects instead of one tool with a mode boolean.
 *  - the BOUND GATE drives `awaitProgramSettlement` with a fake `program_status` reader, one that never settles and one
 *    that settles on the second read, so "the wait is bounded" and "a settled program is not waited on" are both measured
 *    rather than asserted in prose. It uses the Host's OWN `waitForTerminalProgramStatus`, not a stand-in for it.
 *  - the ROW GATE drives `describeRowReceipts` from receipts shaped exactly as the bridge pushes them, and asserts that a
 *    loop whose rows were refused BEFORE dispatch reports zero of them - the difference between "two rows ran" and "two
 *    rows were named as absent" that `3d249ff1` had to teach the Mod.
 *
 * red-proof: inject  raising the bound gate's loop budget to `Number.MAX_SAFE_INTEGER` makes a reader that never settles
 * halt instead of answering `reachedTerminal: false`, which is the defect (a slice waiting out the game's day instead of its
 * own bound); the subject gate fails the moment `--action` is accepted.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  awaitProgramSettlement,
  buildProgramBlock,
  compilerAccount,
  decideNodeAdmission,
  describeRowReceipts,
  emptyContext,
  parseLiveProgramArguments,
  planLiveProgram,
  programFamilies,
  programVerdict,
  readProgramScript,
} from "./live-program.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_STATUS_MODULE = join(repositoryRoot, "host", "dist-test", "program-status-wait.js");
const REQUIRES_HOST_BUILD = existsSync(HOST_STATUS_MODULE)
  ? false
  : "requires a built Host (host/dist-test); run `pnpm --dir host build:test`";

const SLOT = "GameBuddyFixtureTest_123456789";

function refusalOf(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

async function refusalOfAsync(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

async function withFixtureRoot(run, { binding = true, template = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-live-program-"));
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
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A profile whose save root this test owns, so "an earlier run left a working save" can be arranged. */
async function withSaveRoot(run) {
  const appData = mkdtempSync(join(tmpdir(), "gamebuddy-live-program-appdata-"));
  try {
    return await run({ appData, env: { APPDATA: appData, LOCALAPPDATA: join(appData, "localappdata") } });
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
}

test("the CLI takes a fixture key and a script, and defaults every knob it can", () => {
  const minimal = parseLiveProgramArguments(["--scenario", "water_crop", "--script", "builder.move_to_tile({});"]);
  assert.equal(minimal.scenario, "water_crop");
  assert.equal(minimal.script, "builder.move_to_tile({});");
  assert.equal(minimal.settleMs, 120_000);
  assert.equal(minimal.windowMode, "hidden");
  assert.equal(minimal.timeoutSeconds, 180);
  assert.equal(minimal.dryRun, false);
  assert.equal(minimal.keepLog, false);
  assert.equal(minimal.help, false);

  const full = parseLiveProgramArguments([
    "--scenario",
    "water_crop",
    "--script",
    "E:/tmp/loop.js",
    "--settle-ms",
    "3000",
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
  ]);
  assert.equal(full.settleMs, 3_000);
  assert.equal(full.keepLog, true);
  assert.equal(full.dryRun, true);
  assert.equal(full.windowMode, "background");
  assert.equal(full.timeoutSeconds, 90);
  assert.equal(full.saveName, SLOT);

  assert.equal(parseLiveProgramArguments(["--help"]).help, true);
  assert.equal(parseLiveProgramArguments(["-h"]).help, true);
});

test("the CLI refuses by name, and the OTHER subject's flag is not a mode here", () => {
  const cases = [
    [[], "missing_scenario"],
    [["--scenario", "water_crop"], "missing_script"],
    [["--script", "x();"], "missing_scenario"],
    [["--action", "water_crop", "--script", "x();"], "invalid_argument:--action"],
    [["--scenario"], "invalid_argument_value:--scenario"],
    [["--scenario", "Water_Crop", "--script", "x();"], "invalid_scenario:Water_Crop"],
    [["--scenario", "water_crop", "--script", "x();", "--settle-ms", "500"], "invalid_settle_ms:500"],
    [["--scenario", "water_crop", "--script", "x();", "--settle-ms", "600001"], "invalid_settle_ms:600001"],
    [["--scenario", "water_crop", "--script", "x();", "--window-mode", "tiny"], "invalid_window_mode:tiny"],
    [["--scenario", "water_crop", "--script", "x();", "--timeout-seconds", "5"], "invalid_timeout_seconds:5"],
    [["--scenario", "water_crop", "--script", "x();", "--scenario", "water_crop"], "duplicated_argument:--scenario"],
    [["--scenario", "water_crop", "--script", "x();", "--wat"], "invalid_argument:--wat"],
    [["--scenario", "water_crop", "--script", "x();", "--dry-run", "--dry-run"], "duplicated_argument:--dry-run"],
  ];
  for (const [argv, code] of cases) {
    const error = refusalOf(() => parseLiveProgramArguments(argv));
    assert.ok(error !== null, `${argv.join(" ") || "(no arguments)"} must be refused`);
    assert.equal(error.message, code);
  }
});

test("the script is one value with ONE rule: an existing file is read, anything else is the script", () => {
  const directory = mkdtempSync(join(tmpdir(), "gamebuddy-live-program-script-"));
  try {
    const path = join(directory, "loop.js");
    writeFileSync(path, "builder.for_each({ source: { area: { x: 0, y: 0, w: 1, h: 1 } }, do: null });\n");
    const fromFile = readProgramScript(path);
    assert.equal(fromFile.path, path, "the block says which arm produced the source");
    assert.match(fromFile.source, /builder\.for_each/u);

    const inline = readProgramScript("builder.move_to_tile({ x: 1, y: 2 });");
    assert.equal(inline.path, null);
    assert.equal(inline.source, "builder.move_to_tile({ x: 1, y: 2 });");

    assert.equal(refusalOf(() => readProgramScript("   "))?.message, "live_program_script_missing");
    const empty = join(directory, "empty.js");
    writeFileSync(empty, "\n");
    assert.match(readProgramScriptOrThrow(empty), /live_program_script_unreadable/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readProgramScriptOrThrow(value) {
  try {
    readProgramScript(value);
  } catch (error) {
    return String(error?.message ?? error);
  }
  return "";
}

test("the plan names the world a fixture key arms, and refuses a key no fixture has", async () => {
  await withSaveRoot(async ({ env }) => {
    await withFixtureRoot(async (root) => {
      const plan = await planLiveProgram(
        parseLiveProgramArguments(["--scenario", "water_crop", "--script", "x();", "--fixture-root", root]),
        { env },
      );
      assert.equal(plan.scenario, "native_water_crop_v1", "the key selects the world the Mod arms");
      assert.deepEqual([...plan.actions], ["move_to_tile", "travel", "equip_tool", "water_crop"]);
      assert.equal(plan.saveName, SLOT);
      assert.equal(plan.backupName, "native-local-program-water-crop-fixture-backup");
      assert.equal(plan.settleMs, 120_000);

      const unknown = await refusalOfAsync(() =>
        planLiveProgram(
          parseLiveProgramArguments(["--scenario", "not_a_fixture", "--script", "x();", "--fixture-root", root]),
          { env },
        ),
      );
      assert.equal(unknown?.message, "live_program_no_fixture_scenario:not_a_fixture");
      assert.deepEqual(unknown?.detail, { key: "not_a_fixture" });
    });
  });
});

test("a working save an earlier run left behind is refused BEFORE the launch, with the world it names", async () => {
  await withSaveRoot(async ({ appData, env }) => {
    const saveRoot = join(appData, "StardewValley", "Saves");
    mkdirSync(join(saveRoot, SLOT), { recursive: true });
    writeFileSync(join(saveRoot, SLOT, SLOT), "<SaveGame><currentSeason>spring</currentSeason></SaveGame>");
    await withFixtureRoot(async (root) => {
      const error = await refusalOfAsync(() =>
        planLiveProgram(
          parseLiveProgramArguments(["--scenario", "water_crop", "--script", "x();", "--fixture-root", root]),
          {
            env,
          },
        ),
      );
      assert.match(String(error?.message), /^live_action_working_save_present:/u);
      assert.equal(error?.detail?.present, true, "the refusal carries the save it measured");
    });
  });
});

test("a plan refused before any mutation cannot claim a restore", async () => {
  await withSaveRoot(async ({ env }) => {
    await withFixtureRoot(
      async (root) => {
        const error = await refusalOfAsync(() =>
          planLiveProgram(
            parseLiveProgramArguments(["--scenario", "water_crop", "--script", "x();", "--fixture-root", root]),
            {
              env,
            },
          ),
        );
        assert.equal(error?.message, `live_action_binding_missing:${root}`);
      },
      { binding: false },
    );
  });
});

test("the loop's families come from the compiled nodes, in the snapshot's own spelling", () => {
  const nodes = [
    { nodeId: "n01", actionId: "move_to_tile", arguments: { x: { type: "integer", canonicalValue: "1" } } },
    {
      nodeId: "n02",
      actionId: "for_each",
      arguments: {
        loop: {
          type: "loop",
          source: { area: { x: 10, y: 10, w: 2, h: 1 } },
          do: { action: "water_crop" },
        },
      },
    },
    {
      nodeId: "n03",
      actionId: "for_each",
      arguments: {
        loop: {
          type: "loop",
          source: { family: "cropTargets" },
          then: [{ do: { action: "water_crop" } }, { do: { action: "pickup_forage" } }],
        },
      },
    },
  ];
  const families = programFamilies(nodes, ["for_each"]);
  assert.deepEqual(
    families.map((family) => family.field).sort(),
    ["cropTargets", "forageTargets"],
    "a row action's family is the field the snapshot publishes, never the action id",
  );
  const crop = families.find((family) => family.field === "cropTargets");
  assert.deepEqual([...crop.actionIds], ["water_crop"]);
  const forage = families.find((family) => family.field === "forageTargets");
  assert.deepEqual(
    [...forage.actionIds],
    ["pickup_forage"],
    "a family-sourced loop names the family, its rows name the action",
  );
  assert.deepEqual(programFamilies([nodes[0]], ["for_each"]), [], "an ordinary node reads no loop family");
});

test("the row receipts are the count a successful pass cannot report any other way", () => {
  const receipt = (actionId, state, tile) => ({
    actionId,
    state,
    reasonCode: "crop_watered",
    revision: 21,
    requestId: `req_${tile}`,
    executionId: `exe_${tile}`,
    evidence: `location=Farm;target=crop_${tile};tile=${tile};after_watered=true`,
  });
  const ran = describeRowReceipts({
    receipts: [
      receipt("move_to_tile", "succeeded", "3,12"),
      receipt("water_crop", "succeeded", "62,18"),
      receipt("water_crop", "succeeded", "63,18"),
    ],
    actionIds: ["water_crop"],
  });
  assert.equal(ran.terminal, 2, "two rows ran, and the walk is not one of them");
  assert.deepEqual(ran.byState, { succeeded: 2 });
  assert.deepEqual(
    ran.receipts.map((row) => row.tile),
    ["62,18", "63,18"],
  );
  assert.equal(ran.receipts[0].target, "crop_62,18", "the row's own identity rides the receipt it minted");

  // The shape `3d249ff1` is about: rows the world refused are NAMED by the node and mint no receipt at all.
  const refused = describeRowReceipts({
    receipts: [receipt("travel", "succeeded", "3,12")],
    actionIds: ["water_crop"],
  });
  assert.equal(refused.terminal, 0);
  assert.deepEqual(refused.receipts, []);
});

test("the verdict is three words, and only two of them are a successful slice", () => {
  const answer = (states) => ({
    nodes: states.map((state, index) => ({ index, actionId: "for_each", state })),
    settled: true,
    remaining: 0,
  });
  const settled = { reachedTerminal: true, budgetMs: 120_000 };

  assert.equal(programVerdict({ answer: answer(["succeeded"]), settled }).state, "passed");
  const refused = programVerdict({ answer: answer(["succeeded", "failed"]), settled });
  assert.equal(refused.state, "refused", "a settled pass that refused a row MEASURED something");
  assert.deepEqual(refused.blockers, [], "a named refusal is not a blocker");
  assert.equal(refused.stopped[0].actionId, "for_each");

  const unsettled = programVerdict({
    answer: answer(["succeeded", "running"]),
    settled: { ...settled, reachedTerminal: false },
  });
  assert.equal(unsettled.state, "blocked");
  assert.deepEqual(unsettled.blockers, ["live_program_not_settled:120000"]);

  const unreadable = programVerdict({ answer: answer(["unknown"]), settled });
  assert.equal(unreadable.state, "blocked", "a node the journal never listed has not been shown to be anything");
  assert.deepEqual(unreadable.blockers, ["node_state_unreadable:for_each:0"]);
});

test("the compiler's account keeps the four lists AND the insertions, so a slice never hides a step", () => {
  const accepted = compilerAccount({
    ok: true,
    snapshotRevision: 4,
    program: { nodes: [] },
    inserted: ["inserted=move_to_tile;before=n02"],
    insertedCount: 1,
    acceptedSteps: ["n01"],
    acceptedStepsCount: 1,
    merged: [],
    mergedCount: 0,
    noStepNeeded: ["n03:equip_for:already_held"],
    noStepNeededCount: 1,
    dropped: ["n04:plan_script_tool_not_owned"],
    droppedCount: 2,
    layoutFactsAbsent: [],
    layoutFactsAbsentCount: 0,
  });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.inserted, ["inserted=move_to_tile;before=n02"]);
  assert.equal(accepted.droppedTruncated, true, "a bounded list says how many it left out");
  assert.equal(accepted.noStepNeededCount, 1);

  const refused = compilerAccount({
    ok: false,
    reasonCode: "plan_script_unknown_action:water_the_crops",
    acceptedSteps: [],
    acceptedStepsCount: 0,
    merged: [],
    mergedCount: 0,
    noStepNeeded: [],
    noStepNeededCount: 0,
    dropped: ["n01:plan_script_unknown_action:water_the_crops"],
    droppedCount: 1,
    rejected: [],
    rejectedCount: 1,
  });
  assert.equal(refused.accepted, false);
  assert.equal(refused.reasonCode, "plan_script_unknown_action:water_the_crops");
  assert.deepEqual(refused.dropped, ["n01:plan_script_unknown_action:water_the_crops"]);
});

test("the context a run collects is empty until each step measured it", () => {
  const context = emptyContext();
  assert.deepEqual(context, {
    snapshotBefore: null,
    observation: null,
    compiled: null,
    nodes: null,
    programId: null,
    submitted: null,
    settled: null,
    receipts: [],
    admission: [],
  });
  assert.notEqual(context.receipts, emptyContext().receipts, "two runs never share one receipt buffer");
});

test(
  "the wait is bounded by THIS tool's budget, and a settled program is not waited on",
  { skip: REQUIRES_HOST_BUILD },
  async () => {
    const { isTerminalProgramStatus, waitForTerminalProgramStatus } = await import(
      pathToFileURL(HOST_STATUS_MODULE).href
    );
    const running = Object.freeze({
      code: "found",
      snapshot: Object.freeze({
        state: "active",
        nodes: Object.freeze([{ nodeId: "n01", state: "running" }]),
      }),
    });
    const answered = (state) =>
      Object.freeze({
        code: "found",
        snapshot: Object.freeze({ state, nodes: Object.freeze([{ nodeId: "n01", state }]) }),
      });

    let polls = 0;
    const stuck = await awaitProgramSettlement({
      readStatus: async () => {
        polls += 1;
        return running;
      },
      first: running,
      budgetMs: 400,
      isTerminal: isTerminalProgramStatus,
      waitForTerminal: waitForTerminalProgramStatus,
    });
    assert.equal(stuck.reachedTerminal, false, "a program that never settles is never reported as settled");
    assert.equal(stuck.result.snapshot.state, "active", "the last read is what the caller is handed");
    assert.ok(stuck.elapsedMs >= 350 && stuck.elapsedMs < 5_000, `the budget bounds the wait (${stuck.elapsedMs} ms)`);
    assert.ok(polls >= 2, "the wait polls inside its budget instead of reading once");

    const terminalFirst = await awaitProgramSettlement({
      readStatus: async () => {
        throw new Error("a settled program must not be read again");
      },
      first: answered("succeeded"),
      budgetMs: 400,
      isTerminal: isTerminalProgramStatus,
      waitForTerminal: waitForTerminalProgramStatus,
    });
    assert.equal(terminalFirst.reachedTerminal, true);
    assert.equal(terminalFirst.windows, 0, "one read that is already terminal costs no window");
    assert.equal(terminalFirst.elapsedMs, 0);
  },
);

test("a node challenge is answered by the Host's own decision, and the grant is not a formality", () => {
  const challenge = Object.freeze({
    programId: "plan_0_abc",
    nodeId: "n01",
    nodeAttempt: 1,
    admissionAttempt: 1,
    stopEpoch: 0,
    catalogRevision: 7,
    policyIdentity: Object.freeze({ value: "policy_1", capabilityRevision: 3 }),
    actionId: "for_each",
    canonicalBoundArgs: Object.freeze({}),
    derivedResourceClaims: Object.freeze({}),
    deadlineMs: Date.now() + 60_000,
  });
  const client = {
    state: {
      connected: true,
      sessionId: "session_1",
      catalogRevision: 7,
      policyIdentity: { value: "policy_1", capabilityRevision: 3 },
      catalogRegistrations: [
        { actionId: "water_crop", familyId: "farming", identityVersion: 1, lifecycle: "published", kind: "execution" },
      ],
      enabledActionIds: ["water_crop"],
    },
  };
  const grantOf = (admitted) =>
    decideNodeAdmission({
      client,
      modules: {
        adapter: {
          STARDEW_GAME_INTEGRATION_ADAPTER: {
            actionCatalog: { visibleActions: (_r, capabilities) => capabilities.map((actionId) => ({ actionId })) },
          },
        },
        preflight: {
          bodyProgramNodeAdmissionRefusal: (_challenge, catalogue) =>
            catalogue.visibleActionIds.includes("water_crop") ? null : "policy_denied",
        },
      },
      challenge,
      mintGrantId: () => "grant_fixed",
    }) ?? admitted;

  const granted = grantOf(null);
  assert.equal(granted.result, "granted");
  assert.equal(granted.grantId, "grant_fixed");
  assert.equal(granted.attachmentGeneration, "session_1");
  assert.equal(granted.policyRevision, "policy_1");
  assert.equal(granted.executionBinding, null);
  assert.equal(granted.nodeId, "n01", "the grant carries the whole challenge, not a subset of it");

  const stale = decideNodeAdmission({
    client,
    modules: {
      adapter: {
        STARDEW_GAME_INTEGRATION_ADAPTER: {
          actionCatalog: { visibleActions: (_r, capabilities) => capabilities.map((actionId) => ({ actionId })) },
        },
      },
      preflight: { bodyProgramNodeAdmissionRefusal: () => null },
    },
    challenge: { ...challenge, catalogRevision: 6 },
  });
  assert.equal(stale.result, "rejected");
  assert.equal(stale.code, "catalog_stale");

  const mismatch = decideNodeAdmission({
    client,
    modules: {
      adapter: { STARDEW_GAME_INTEGRATION_ADAPTER: { actionCatalog: { visibleActions: () => [] } } },
      preflight: { bodyProgramNodeAdmissionRefusal: () => null },
    },
    challenge: { ...challenge, policyIdentity: { value: "policy_2", capabilityRevision: 3 } },
  });
  assert.equal(mismatch.result, "rejected");
  assert.equal(mismatch.code, "policy_identity_mismatch");

  const expired = decideNodeAdmission({
    client,
    modules: { adapter: {}, preflight: {} },
    challenge: { ...challenge, deadlineMs: Date.now() - 1 },
  });
  assert.equal(expired.result, "rejected");
  assert.equal(expired.code, "deadline_expired");
});

test("a refusal half-way still prints the world it refused in, and a null node list is not a crash", () => {
  // Measured 2026-11-11, on this tool's own failure path: a script that named a file which was not there compiled to a
  // refusal, the context's `nodes` was still null, and the block builder threw `Cannot read properties of null (reading
  // 'map')` - a stack trace where the run's one answer should be. The subject gate cannot see that; this does.
  const block = buildProgramBlock({
    plan: {
      scenarioKey: "water_crop",
      scenario: "native_water_crop_v1",
      actions: ["water_crop"],
      script: "scratch/loop.js",
      scriptPath: null,
    },
    state: "blocked",
    reasonCode: "live_program_script_not_compiled:plan_script_threw:SyntaxError",
    compiled: null,
    nodes: null,
    programId: null,
    submitted: null,
    settled: null,
    answer: null,
    admission: [],
    families: [],
    rows: describeRowReceipts({ receipts: [], actionIds: [] }),
    snapshotBefore: { revision: 0, tile: { x: 9, y: 9 }, location: "FarmHouse", actionable: true },
    observation: null,
    restore: { fixtureRestored: true, saveRestored: true, problems: [] },
    blockers: [],
    startedAt: Date.now(),
  });
  assert.equal(block.state, "blocked");
  assert.deepEqual(block.program, { programId: null, nodes: null });
  assert.equal(block.compiler, null);
  assert.equal(block.observation, null);
  assert.equal(
    block.population.measured,
    true,
    "the world it refused in is still reported: the observation happened before the refusal",
  );
  assert.equal(block.rows.terminal, 0);
});

test("the package never touches stdout for anything but the block", () => {
  // The tools' contract: one parseable object on stdout, everything else on stderr. This reads the SOURCE rather than
  // running the tool, because the defect it prevents was a shared teardown writing one line of progress to stdout before
  // the block - measured 2026-11-11, `JSON.parse` of a real run's stdout failed on `fixture transaction restored`.
  const source = readFileSync(new URL("./live-program.mjs", import.meta.url), "utf8");
  const writes = source.match(/console\.log\(/gu) ?? [];
  assert.deepEqual(writes, [], "progress goes to stderr; stdout carries the block");
  const teardown = readFileSync(new URL("./lib/live-run-teardown.mjs", import.meta.url), "utf8");
  assert.match(teardown, /process\.stderr\.write\("fixture transaction restored\\n"\);/u);
});
