/**
 * The shared half of the boundary slices: one fixture world, one game launch, one connected session, one unwind.
 *
 * WHY THIS EXISTS. `tools/live-action.mjs` proves ONE action and `tools/live-program.mjs` proves ONE plan form, and both
 * pay a game launch to do it. What they cannot express is a SEAM: two submissions whose order is the property
 * (`orphaned-sleep`, `double-navigate`), or one submission whose FALSIFICATION is the property (`outdoor-sleep`,
 * `patch-3x20`). `round93` (2026-11-22) spent 35 minutes re-discovering four of those seams live; each of them
 * reproduces, from a launched world, in tens of seconds, and none of them needs a model.
 *
 * IT OWNS NO MECHANISM. Every step is a module this tree already drives a game with, imported rather than copied:
 *   - `lib/stardew-native-local-player-fixture.mjs` - the fixture transaction: the world a fixture key selects, its
 *     action set, the deploy and the restore;
 *   - `lib/stardew-live-run.mjs` - the SMAPI launch and the lane log;
 *   - `lib/stardew-native-smoke-harness-v1.mjs` - one connected session, the receipt buffer, the fresh observation;
 *   - `live-action.mjs` - the plan/teardown half (`teardown`, `restoreEnding`, `describeSaveAt`, `singleBinding`,
 *     `readFixtureTransaction`, `releaseFixture`, `runFixtureSaveHarness`, `requireAbsolute`, `refusal`). Those facts
 *     are the FIXTURE's, not one action's, so they keep the one spelling they already had.
 *
 * A SLICE ANSWERS ONE QUESTION AND PRINTS ONE LINE. `slice=<name> status=passed|failed|blocked detail=<code>`, exit 0
 * only for `passed`. `failed` is a MEASURED answer - the seam is broken and the detail names how - while `blocked` means
 * the slice could not measure (no world, a fixture refused, a process left running) and must never read as either.
 *
 * THE BOUND IS THE SLICE'S AND IT IS PRINTED. Every wait below is bounded by `--budget-ms`, and a wait that expires is
 * reported with the elapsed milliseconds beside it: "the terminal never arrived" and "it arrived at 41 s" are different
 * findings and the second is the one a reader needs before deciding whether 2 s was too tight.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadHostTestModule } from "../../lib/host-test-module.mjs";
import { installLiveRunInterrupt } from "../../lib/live-run-teardown.mjs";
import { announceStardewFixtureRoots, resolveStardewFixtureRoots } from "../../lib/stardew-fixture-roots.mjs";
import { gameStardewSaveRoot } from "../../lib/stardew-lane-scope.mjs";
import { launchStardewLiveRun, normalizeLiveRunWindowMode } from "../../lib/stardew-live-run.mjs";
import { STARDEW_MOD_FOLDER } from "../../lib/stardew-mod-folder.mjs";
import {
  fixtureActionSet,
  fixtureScenario,
  prepareNativeLocalPlayerFixture,
  validateNativeLocalPlayerFixturePreparation,
} from "../../lib/stardew-native-local-player-fixture.mjs";
import {
  closeSession,
  connectNativeLocalClient,
  delay,
  observeFresh,
} from "../../lib/stardew-native-smoke-harness-v1.mjs";
import { listStardewProcessIds } from "../../lib/windows-process-tree.mjs";
import {
  describeSaveAt,
  readFixtureTransaction,
  reclaimGame,
  refusal,
  releaseFixture,
  requireAbsolute,
  runFixtureSaveHarness,
  singleBinding,
  teardown,
} from "../../live-action.mjs";

const SLICES = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(SLICES, "../..");
const REPO = resolve(TOOLS, "..");
const DEFAULT_GAME_INSTALL = "D:/Steam/steamapps/common/Stardew Valley";
const DEFAULT_RELEASE_DIR = "integrations/stardew/bin/Release/net6.0";
const WINDOW_MODES = Object.freeze(["visible", "foreground", "minimized", "hidden", "background"]);
const MAX_BUDGET_MS = 900_000;

export const USAGE_COMMON = `  --budget-ms <n>            this slice's own bound on every wait, 500..${String(MAX_BUDGET_MS)}
  --keep-log                 keep this run's SMAPI console log even when the slice passes
  --dry-run                  resolve everything and refuse; print the plan; never spawn the game
  --fixture-root <dir>       fixture root (default: the lane's resolved stardew-fixtures root)
  --mods-path <dir>          mods root the game is launched against (default: <fixture-root>/mods)
  --release-dir <dir>        staged Mod bundle (default: ${DEFAULT_RELEASE_DIR})
  --game-path <dir>          game install (default: GAMEBUDDY_STARDEW_GAME_DIR or ${DEFAULT_GAME_INSTALL})
  --save-name <slot>         observed save slot (default: the fixture root's single binding)
  --window-mode <mode>       ${WINDOW_MODES.join("|")} (default: hidden)
  --timeout-seconds <n>      bridge pipe budget, 30..300 (default: 180)
  --help                     print this text`;

const FLAGS = Object.freeze(["--help", "-h", "--keep-log", "--dry-run"]);
const VALUE_FLAGS = Object.freeze([
  "--budget-ms",
  "--fixture-root",
  "--mods-path",
  "--release-dir",
  "--game-path",
  "--save-name",
  "--window-mode",
  "--timeout-seconds",
]);

function boundedInteger(value, minimum, maximum, code) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw refusal(`${code}:${value}`);
  return number;
}

/**
 * The CLI every slice shares. Pure: each refusal is an argument fact, so nothing is touched and no game is spawned.
 *
 * `subjectFlags` is the slice's own vocabulary (`--rectangle`, `--destination`, ...) and is validated by the caller, so
 * an option one slice understands and another does not is refused BY NAME here instead of being silently ignored.
 */
export function parseSliceArguments(argv, { budgetMs, subjectFlags = [] } = {}) {
  const options = {
    help: false,
    keepLog: false,
    dryRun: false,
    budgetMs,
    subject: {},
    fixtureRoot: null,
    modsPath: null,
    releaseDir: null,
    gamePath: null,
    saveName: null,
    windowMode: "hidden",
    timeoutSeconds: 180,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (FLAGS.includes(token)) {
      if (seen.has(token)) throw refusal(`duplicated_argument:${token}`);
      seen.add(token);
      if (token === "-h" || token === "--help") options.help = true;
      else if (token === "--keep-log") options.keepLog = true;
      else options.dryRun = true;
      continue;
    }
    if (!(VALUE_FLAGS.includes(token) || subjectFlags.includes(token)))
      throw refusal(`invalid_argument:${String(token)}`);
    if (seen.has(token)) throw refusal(`duplicated_argument:${token}`);
    seen.add(token);
    const value = argv[index + 1];
    if (value === undefined || (value.startsWith("--") && !value.includes(" ")))
      throw refusal(`invalid_argument_value:${token}`);
    index += 1;
    switch (token) {
      case "--budget-ms":
        options.budgetMs = boundedInteger(value, 500, MAX_BUDGET_MS, "invalid_budget_ms");
        break;
      case "--fixture-root":
        options.fixtureRoot = value;
        break;
      case "--mods-path":
        options.modsPath = value;
        break;
      case "--release-dir":
        options.releaseDir = value;
        break;
      case "--game-path":
        options.gamePath = value;
        break;
      case "--save-name":
        options.saveName = value;
        break;
      case "--window-mode":
        if (!WINDOW_MODES.includes(value)) throw refusal(`invalid_window_mode:${value}`);
        options.windowMode = normalizeLiveRunWindowMode(value);
        break;
      case "--timeout-seconds":
        options.timeoutSeconds = boundedInteger(value, 30, 300, "invalid_timeout_seconds");
        break;
      default:
        options.subject[token.slice(2)] = value;
    }
  }
  if (options.help) return Object.freeze(options);
  return Object.freeze(options);
}

/**
 * Resolve and validate everything a slice needs, touching the filesystem read-only.
 *
 * This is the whole of `--dry-run` and the guard the live form runs before its first mutation: a live transaction, a
 * running game, a missing binding, a world no fixture arms or a working save an earlier run left behind is refused HERE,
 * naming the fact, instead of after a forty-second boot. The three facts that are not the slice's own - the transaction,
 * the binding and the working save - keep the `live_action_*` codes `tools/live-action.mjs` already publishes for them.
 */
export async function planSlice({ scenarioKey, options, env = process.env, roots = null }) {
  const resolvedRoots = roots ?? resolveStardewFixtureRoots({ env });
  const fixtureRoot = requireAbsolute(
    options.fixtureRoot ?? resolvedRoots.fixturesRoot,
    "live_action_fixture_root_invalid",
  );
  const modsPath = requireAbsolute(options.modsPath ?? join(fixtureRoot, "mods"), "live_action_mods_path_invalid");
  const releaseDir = requireAbsolute(
    options.releaseDir ?? join(REPO, DEFAULT_RELEASE_DIR),
    "live_action_release_dir_invalid",
  );
  const gamePath = requireAbsolute(
    options.gamePath ?? (env.GAMEBUDDY_STARDEW_GAME_DIR || DEFAULT_GAME_INSTALL),
    "live_action_game_path_invalid",
  );
  const transaction = readFixtureTransaction(fixtureRoot);
  if (transaction !== null)
    throw refusal(
      `live_action_transaction_live:${transaction.backupName ?? "unknown"}:${transaction.ownerId ?? "unknown"}`,
    );

  let saveName = options.saveName;
  let bindingPath;
  let binding;
  if (saveName === null) {
    ({ binding, bindingPath } = singleBinding(fixtureRoot));
    saveName = binding.observedSaveSlot;
  } else {
    bindingPath = join(fixtureRoot, `${saveName}.native-local-binding.json`);
    binding = JSON.parse(await readFile(bindingPath, "utf8"));
  }
  if (!/^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$/u.test(String(saveName)))
    throw refusal(`invalid_fixture_observed_save_slot:${String(saveName)}`);

  let actions;
  try {
    actions = fixtureActionSet({ action: scenarioKey });
  } catch (error) {
    throw refusal(`slice_no_fixture_scenario:${scenarioKey}`, error);
  }
  const scenario = fixtureScenario(actions, scenarioKey);

  const templatePath = join(fixtureRoot, "templates", saveName);
  const stardewSaveRoot = gameStardewSaveRoot({ appData: env.APPDATA });
  const workingSave = describeSaveAt({ directory: join(stardewSaveRoot, saveName), saveName });
  if (workingSave.present)
    throw refusal(`live_action_working_save_present:${workingSave.path}`, undefined, workingSave);

  return Object.freeze({
    fixtureRoot,
    modsPath,
    releaseDir,
    gamePath,
    saveName,
    templatePath,
    workingSave,
    bindingPath,
    binding,
    stardewSaveRoot,
    clientConfigPath: join(modsPath, STARDEW_MOD_FOLDER, "config.json"),
    backupName: `slice-${scenarioKey.replaceAll("_", "-")}-fixture-backup`,
    scenarioKey,
    scenario,
    actions,
    windowMode: options.windowMode,
    timeoutSeconds: options.timeoutSeconds,
    keepLog: options.keepLog,
  });
}

/**
 * The prologue every slice's `main` opens with: read the arguments, answer `--help`, plan the scenario - each refusal
 * rendered the one way a slice reports it, so a slice states only what it does after the world is planned.
 *
 * `null` means the run is over: the usage was answered, or the argument/plan refusal was already printed as this
 * slice's terminal. Returning `null` rather than calling `process.exit` keeps the caller's own `await` shape.
 */
export async function startSlice({ name, argv, usage, scenarioKey, budgetMs, subjectFlags }) {
  let options;
  try {
    options = parseSliceArguments(argv, { budgetMs, subjectFlags });
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n\n${usage}\n`);
    process.exitCode = 2;
    return null;
  }
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return null;
  }
  try {
    return { options, plan: await planSlice({ scenarioKey, options }) };
  } catch (error) {
    finishSlice({ name, status: "blocked", detail: String(error?.message ?? error), facts: { detail: error?.detail } });
    return null;
  }
}

/** What `--dry-run` prints: the world this slice would arm and the calls it would make. */
export function describeSlicePlan({ name, plan, calls }) {
  return {
    slice: name,
    state: "planned",
    scenario: { key: plan.scenarioKey, scenario: plan.scenario, actions: plan.actions },
    calls,
    fixtureRoot: plan.fixtureRoot,
    modsPath: plan.modsPath,
    releaseDir: plan.releaseDir,
    gamePath: plan.gamePath,
    saveName: plan.saveName,
    stardewSaveRoot: plan.stardewSaveRoot,
    templatePath: plan.templatePath,
    workingSave: plan.workingSave,
    windowMode: plan.windowMode,
    timeoutSeconds: plan.timeoutSeconds,
  };
}

/**
 * The whole live transaction: the fixture's own gate, the launch, one connected session, the body, the unwind.
 *
 * A body that throws does not lose the run: the teardown still owes its restore, and `restore` says what it managed. The
 * body's own answer is returned beside it, so a slice can print the world it measured even when it failed.
 */
export async function runSliceWorld({ plan, body }) {
  const startedAt = Date.now();
  const stage = {
    prepared: false,
    saveRestored: false,
    handle: null,
    session: null,
    logPath: null,
    keepLog: plan.keepLog,
  };
  const runningPids = listStardewProcessIds();
  if (runningPids.length > 0) throw refusal(`live_action_game_already_running:${runningPids.join(",")}`);

  let result = null;
  let failure = null;
  let trap = null;
  let restore = { fixtureRestored: false, saveRestored: false };
  let config = null;
  try {
    const fixtureOptions = {
      root: plan.fixtureRoot,
      modsPath: plan.modsPath,
      releaseDir: plan.releaseDir,
      saveName: plan.saveName,
      backupName: plan.backupName,
      timeoutSeconds: plan.timeoutSeconds,
      action: plan.scenarioKey,
      extraActions: [],
      binding: plan.binding,
      stardewSaveRoot: plan.stardewSaveRoot,
      heldItemQualifiedId: "",
    };
    await validateNativeLocalPlayerFixturePreparation(fixtureOptions);
    await prepareNativeLocalPlayerFixture(fixtureOptions);
    stage.prepared = true;
    runFixtureSaveHarness({ plan, cleanup: false });
    stage.saveRestored = true;

    config = JSON.parse(await readFile(plan.clientConfigPath, "utf8"));
    stage.logPath = join(plan.fixtureRoot, "logs", `slice-${plan.scenarioKey}-${startedAt}.log`);
    stage.handle = await launchStardewLiveRun({
      gamePath: plan.gamePath,
      modsPath: plan.modsPath,
      windowMode: plan.windowMode,
      pipeName: config.PipeName,
      logPath: stage.logPath,
      timeoutMs: plan.timeoutSeconds * 1_000,
    });
    trap = installLiveRunInterrupt({
      onInterrupt: async () => {
        await closeSession(stage);
        await reclaimGame({ handle: stage.handle });
        stage.handle = null;
        if (stage.prepared) {
          try {
            releaseFixture(plan);
          } catch (_error) {
            /* the second signal exits without a second unwind */
          }
        }
      },
    });

    stage.session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
    result = await body({ client: stage.session.client, receipts: stage.session.receipts, config, plan });
  } catch (error) {
    failure = error;
  } finally {
    restore = await teardown({ plan, stage, trap });
  }
  return Object.freeze({ result, failure, restore, config, elapsedMs: Date.now() - startedAt });
}

/**
 * The world as the slice found it: one observation, waited for `actionable` because the bridge opens while the fixture's
 * own warp fade is still in flight. A transition in flight is not a world that cannot act, and treating it as one would
 * fail every slice on the first read.
 */
export async function observeReadyWorld(client, { budgetMs }) {
  const deadline = Date.now() + budgetMs;
  let latest = await observeFresh(client);
  while (latest?.actionable !== true || latest.activeExecution != null) {
    if (Date.now() >= deadline) throw refusal(`slice_world_not_actionable:${String(budgetMs)}`);
    await delay(100);
    try {
      latest = await observeFresh(client);
    } catch (error) {
      const cached = client.state?.snapshot;
      if (cached === null || cached === undefined) throw error;
      latest = cached;
    }
  }
  return latest;
}

/**
 * Whether the body is free again, read as the Mod publishes it: the world accepts an action and nothing is in flight.
 *
 * A hold that survives the night is a real ending and it is NAMED - the Mod's own hold evidence carries
 * `admissible_actions=`, and this prints it rather than reporting a bare boolean a reader cannot act on.
 */
export function describeBodyFreedom(snapshot, receipts) {
  const hold = [...receipts]
    .reverse()
    .find((receipt) => typeof receipt?.evidence === "string" && receipt.evidence.includes("admissible_actions="));
  return {
    actionable: snapshot?.actionable === true,
    activeExecution: snapshot?.activeExecution ?? null,
    hold: hold === undefined ? null : { actionId: hold.actionId, evidence: hold.evidence.slice(0, 400) },
  };
}

/** `slice=<name> status=<status> detail=<code>`, the one line every slice prints, and the exit status it implies. */
export function printVerdict({ name, status, detail }) {
  const line = `slice=${name} status=${status} detail=${detail}`;
  process.stdout.write(`${line}\n`);
  return line;
}

/**
 * One slice's exit: the verdict line, the facts behind it on stderr, and the status code a CI step branches on.
 *
 * `passed` is 0 and everything else is non-zero, because a slice is a gate: `failed` measured a broken seam, `blocked`
 * could not measure one, and neither may be silently green in a pipeline.
 */
export function finishSlice({ name, status, detail, facts }) {
  process.stderr.write(`${JSON.stringify({ slice: name, status, detail, ...facts }, null, 2)}\n`);
  printVerdict({ name, status, detail });
  process.exitCode = status === "passed" ? 0 : 2;
}

/** The one-line pre-launch announcement, so a slice that spends a boot says what it will do before it spends it. */
export function announceSlice({ name, plan, calls }) {
  announceStardewFixtureRoots(resolveStardewFixtureRoots({ env: process.env }));
  process.stderr.write(
    `[slice] ${name} scenario=${plan.scenario}(${plan.scenarioKey}) calls=${calls.join(",")} save=${plan.workingSave.path}(absent) window=${plan.windowMode}\n`,
  );
}
