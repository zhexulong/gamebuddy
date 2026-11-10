#!/usr/bin/env node
/**
 * One action, live: prepare the fixture, launch the game, attach, run exactly that action, capture the receipt,
 * restore everything. Seconds of setup per subject instead of a whole launcher run.
 *
 * WHY. Every single-action live check in this tree was stranded behind a multi-day launcher: `prelive.mjs` has the
 * right shape at the STATIC level (one action id in, one verdict out, no game), but the LIVE level only existed inside
 * long runs. Measured 2026-11-09: `node tools/run-stardew-native-local-player-pet-animal-smoke.mjs` refuses with
 * `invalid_native_client_config` (it is a contract, not a driver), and `tools/live-run/game/run-single-step.mjs` needs a
 * recorded day plus a copy of its client config — so verifying one action cost a 48-minute run instead of 40 seconds.
 *
 * IT OWNS NO MECHANISM OF ITS OWN. Five pieces already exist and are used here as they are:
 *   - `lib/stardew-native-local-player-fixture.mjs` — the fixture transaction (profile, policy, bundle deploy, restore);
 *   - `lib/stardew-live-run.mjs` — the SMAPI launch, the pipe wait, the fresh-artifact refusal and the lane log;
 *   - `lib/stardew-native-smoke-harness-v1.mjs` — one connected session, the receipt buffer and the fresh re-read;
 *   - the action's own gate runner (resolved from the published/experimental registry), invoked in-process through the
 *     same `run<X>Smoke(client, receipts, config)` convention its CLI drives;
 *   - `lib/live-run-teardown.mjs` + `lib/windows-process-tree.mjs` — the restore a killed run owes, and the exact-PID kill.
 *
 * THE RECEIPT BLOCK is one bounded JSON object on stdout: the executor's `state`/`reasonCode`, the target this run was
 * pointed at, the hand before and after, the Mod's own evidence words, the engine's fresh RE-READ (a projection taken
 * after the receipt, never the receipt's claim), the held-state perturbation's answer, and what the teardown actually
 * managed. Progress and paths go to stderr, so stdout stays one parseable object.
 *
 * A RUN THAT MEASURED NOTHING MUST NOT LOOK LIKE ONE. Measured 2026-11-08: 98 seconds and one game launch ended with
 * `target: { count: 0 }` — and no observation had happened at all. The held-tool perturbation was refused first
 * (`equip_tool` answered `tool_not_found`), so `target` was still null and the block printed the count of nothing. What
 * this tool owes for that is a block that cannot say `count: 0` about a family nobody read (`target.measured` is false
 * and the count is null), and one line printed BEFORE the launch that names what the run will exercise.
 *
 * AND A LEFT-OVER WORLD REFUSES THE LAUNCH. A working save an earlier run could not clean is a world that has already
 * been played, and a day-scoped family answers differently in it: a `pet_animal` whose pet was petted today publishes an
 * EMPTY `petTargets`, because the Mod filters `PettedToday`. So the plan refuses
 * `live_action_working_save_present:<path>` before any mutation, carrying the save's own mtime, game id and calendar so
 * a reader can see which world it is instead of taking "dirty" on faith.
 *
 * AND THE TARGET QUESTION IS ANSWERED BY NAME, FROM ONE OBSERVATION. Four outcomes are four different facts, and a
 * run that cannot tell them apart costs a whole game launch to re-learn: `live_action_action_not_advertised:<action>`
 * (this world never published the action), `live_action_family_absent:<family>` (it did, and the snapshot does not
 * carry the family at all), `live_action_family_empty:<family>` (the family is there with no rows), and
 * `live_action_target_chosen:<targetId>` (there is a row, and this run carries it forward). Measured 2026-11-09:
 * `--action feed_animal` refused `native_snapshot_not_actionable` with `target.count: null` and could not say whether
 * the fixture had armed a trough, because the target question was never asked. The snapshot revision travels beside
 * every one of them.
 *
 * AND THE FIRST OBSERVATION IS TAKEN WHEN THE WORLD CAN ACT. The bridge opens while the fixture's own `warpFarmer`
 * fade is still in flight, so the snapshot that arrives first reports `actionable: false` — the same fact every
 * native-local runner already waits out (`waitForActionable`, measured on the geode and pet-farm-animal lanes at
 * ~300 ms). A transition in flight is not a world that cannot act, and it must not be mistaken for a missing family.
 * *
 * HELD-STATE PERTURBATION (`--held <tool>`). `integrations/stardew/tests/.../HeldStatePerturbationTests.cs` states the
 * rule this repeats: with the wrong thing in hand an action must still END IN AN ANSWER — it selects what it needs and
 * succeeds, or it refuses BY NAME. Silence is the failure. A hand can only be filled on the wire by the published
 * `equip_tool` action, so `--held` drives that action first (its own gate runner; the accepted words are `equip_tool`'s
 * own argument enum from the generated action surface) and the fixture publishes it beside the action under test.
 *
 * THE DECLARED HAND (`--held-item <qualifiedItemId>`) is the other half, and it is a FIXTURE Given rather than an action:
 * `NativeLocalPlayerFixture.HeldItemQualifiedId` makes the Mod mint the id into a free slot and select it before bridge
 * attachment, which is the only way a run can start with an ORDINARY item in hand — `equip_tool` selects tools only. That
 * is the world the old blanket `hands_not_empty` guard refused: `Pet.checkAction` branches only on a `Hat` and on
 * `(O)ButterflyPowder` and pets through everything else. Because the Mod's own initializer can refuse (`_unknown`,
 * `_no_room`), the tool does not take the config's word for it: the FIRST snapshot is checked for the declared id and a
 * world that disagrees is `live_action_held_item_not_in_hand:<id>` rather than a receipt that describes some other hand.
 *
 * The two flags are mutually exclusive (`live_action_held_conflict`): one puts a tool there through an action, the other
 * declares a fixture Given, and a run that asked for both would have no single hand to report.
 *
 * AND THE RUN IS JUDGED ON THE RECEIPT ITS EXECUTOR NAMED. A runner may dispatch the same action twice on purpose:
 * `pet_farm_animal` re-attempts its own pet from a fresh observation to prove the engine refuses the second one BY NAME,
 * and that refusal is a FALSIFIER, not a vote. Judging "the last terminal for this action" therefore read a passing run
 * as `blocked` / `receipt_state:rejected` (measured 2026-11-09). The executor's own reason code says which execution the
 * run was, so the terminal carrying it is the answer; a run whose executor names something no terminal carries is
 * `no_terminal_receipt_matching_executor:<reason>` beside `terminals:<reason:state,...>`, and every terminal is printed
 * in the block either way so a reader sees the probe next to the execution it was judged on.
 *
 * THE TEARDOWN IS MEASURED, NOT ASSUMED. The game is stopped by the EXACT pid the launcher created, and the survivors are
 * read back until the budget is spent; a process that is still alive is the run's ending
 * (`live_action_process_still_running:<pids>`), not a line in a list of problems, and nothing is restored while it runs.
 * The restore of the fixture transaction checks its child's exit status, so `fixtureRestored: true` cannot be printed for
 * a restore that refused, and a working save that could not be cleaned is `live_action_working_save_not_restored` — a
 * blocked ending, because the next slice reads that save.
 *
 * USAGE
 *   node tools/live-action.mjs --action <actionId> [--held <tool>] [--target nearest|first] [--keep-log]
 *   node tools/live-action.mjs --action <actionId> --dry-run     # resolve and refuse; never spawns the game
 *   node tools/live-action.mjs --help
 *
 * REFUSES before any mutation, each naming its own fact:
 *   live_action_transaction_live:<backupName>:<ownerId>   another fixture transaction holds this root; never deleted here
 *   live_action_game_already_running:<pids>               a Stardew/SMAPI process would share the one bridge pipe name
 *   live_action_working_save_present:<path>               an earlier run left this save behind; the game would load it
 *   live_action_binding_missing / _binding_ambiguous      the observed save slot cannot be derived from the root
 *   live_action_template_missing:<path>                   the read-only save template the working save is copied from
 *   live_action_no_fixture_scenario:<action>              no fixture scenario arms this action
 *   live_action_held_conflict                             `--held` and `--held-item` name two different hands
 *   live_action_fixture_root_invalid / _mods_path_invalid / _release_dir_invalid / _game_path_invalid
 *   target_policy_unavailable:<action>                    `--target` was given for an action with no declared target
 *   invalid_held_selector:<value>                         not a tool category `equip_tool` can select
 *   invalid_held_item:<value>                             not a qualified item id (`(O)72`, `(H)0`, ...)
 *
 * ENDINGS that are blocked rather than passed, because the world or the process would otherwise be left dirty:
 *   live_action_action_not_advertised:<action>            this world never published the action under test
 *   live_action_family_absent:<family>                    it did, and the snapshot carries no such family
 *   live_action_family_empty:<family>                     the family is published with no rows in it
 *   live_action_world_not_actionable:<action>             a target exists, and the actor still cannot act
 *   live_action_held_item_not_in_hand:<id>                the fixture declared a hand the world did not show
 *   live_action_process_still_running:<pids>              a Stardew process this run started is still alive
 *   live_action_fixture_not_restored / live_action_working_save_not_restored   the unwind could not finish
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TARGET_FIELD } from "./audit-stardew-discovery-channels.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";
import { evidenceDetail } from "./lib/level-up-evidence.mjs";
import { installLiveRunInterrupt, restoreFixtureTransaction } from "./lib/live-run-teardown.mjs";
import { announceStardewFixtureRoots, resolveStardewFixtureRoots } from "./lib/stardew-fixture-roots.mjs";
import { gameStardewSaveRoot } from "./lib/stardew-lane-scope.mjs";
import { launchStardewLiveRun, normalizeLiveRunWindowMode } from "./lib/stardew-live-run.mjs";
import { STARDEW_MOD_FOLDER } from "./lib/stardew-mod-folder.mjs";
import {
  fixtureActionSet,
  fixtureScenario,
  prepareNativeLocalPlayerFixture,
  validateNativeLocalPlayerFixturePreparation,
} from "./lib/stardew-native-local-player-fixture.mjs";
import {
  connectNativeLocalClient,
  observeFresh,
  TERMINAL_STATES,
  waitForActionable,
  waitForFreshSnapshot,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { parseReceiptFields } from "./lib/stardew-receipt-evidence.mjs";
import { killProcessTree, listStardewProcessIds } from "./lib/windows-process-tree.mjs";
import { resolveStardewActionGateRunner } from "./resolve-stardew-action-gate-runner.mjs";
import { runEquipToolSmoke } from "./run-stardew-native-local-player-equip-tool-smoke.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(TOOLS, "..");
const DEFAULT_GAME_INSTALL = "D:/Steam/steamapps/common/Stardew Valley";
const DEFAULT_RELEASE_DIR = "integrations/stardew/bin/Release/net6.0";
const SURFACE = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
const FIXTURE_SAVE_HARNESS = "tools/prepare-stardew-action-fixture.ps1";
const HELD_ACTION = "equip_tool";
const TARGET_POLICIES = Object.freeze(["nearest", "first"]);
const WINDOW_MODES = Object.freeze(["visible", "foreground", "minimized", "hidden", "background"]);
const MAX_EVIDENCE_CHARS = 1_024;
const MAX_TARGET_ROWS = 5;
/** How long a stopped launch gets to disappear: 20 reads at 250 ms each. */
const RECLAIM_ATTEMPTS = 20;
const RECLAIM_POLL_MS = 250;

export const USAGE = `usage: node tools/live-action.mjs --action <actionId> [options]
       node tools/live-action.mjs --recover [--dry-run]   # clear a dead run's fixture transaction

  --action <id>              one published or experimental action id (the subject is the argument)
  --recover                  take back the fixture transaction a dead run left behind, and its leftover
                             working save. Takes no action; refuses while a Stardew process is running
  --held <tool>              fill the actor's hand first, through the published ${HELD_ACTION} action
  --held-item <itemId>       declare a hand the fixture mints before attachment, e.g. (O)72;
                             refused together with --held (one hand per run)
  --target nearest|first     which published target row this run is pointed at (default: nearest)
  --keep-log                 keep this run's SMAPI console log even when the run passes
  --dry-run                  resolve everything and refuse; print the plan; never spawn the game
  --fixture-root <dir>       fixture root (default: the lane's resolved stardew-fixtures root)
  --mods-path <dir>          mods root the game is launched against (default: <fixture-root>/mods)
  --release-dir <dir>        staged Mod bundle (default: ${DEFAULT_RELEASE_DIR})
  --game-path <dir>          game install (default: GAMEBUDDY_STARDEW_GAME_DIR or ${DEFAULT_GAME_INSTALL})
  --save-name <slot>         observed save slot (default: the fixture root's single binding)
  --window-mode <mode>       ${WINDOW_MODES.join("|")} (default: hidden)
  --timeout-seconds <n>      bridge pipe budget, 30..300 (default: 180)
  --terminal-timeout-ms <n>  budget for the post-action re-read, 1000..600000 (default: 30000)
  --help                     print this text

One bounded JSON receipt block goes to stdout; progress and paths go to stderr.
Exit 0 only when the action passed, every requested perturbation answered, and the teardown finished.`;

/**
 * A refusal: the message IS the code a caller branches on.
 *
 * `detail` is the measured state behind the code (a save's identity and mtime, for instance). It travels to the block
 * because a reader deciding whether a world is fresh needs the numbers, and a code alone sends them to the filesystem.
 */
export function refusal(code, cause, detail) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** A qualified item id (`(O)72`, `(H)0`, ...): something the hand cannot be filled with here. */
const QUALIFIED_ITEM_ID = /^\([A-Z]{1,3}\)[A-Za-z0-9_]+$/u;

const FLAGS = Object.freeze(["--help", "-h", "--keep-log", "--dry-run", "--recover"]);
const VALUE_FLAGS = Object.freeze([
  "--action",
  "--held",
  "--held-item",
  "--target",
  "--fixture-root",
  "--mods-path",
  "--release-dir",
  "--game-path",
  "--save-name",
  "--window-mode",
  "--timeout-seconds",
  "--terminal-timeout-ms",
]);

/** Parse the CLI. Pure: every refusal here is an argument fact, so nothing is touched and no game is spawned. */
export function parseLiveActionArguments(argv) {
  const options = {
    help: false,
    keepLog: false,
    dryRun: false,
    recover: false,
    action: null,
    held: null,
    heldItem: null,
    target: "nearest",
    targetRequested: false,
    fixtureRoot: null,
    modsPath: null,
    releaseDir: null,
    gamePath: null,
    saveName: null,
    windowMode: "hidden",
    timeoutSeconds: 180,
    terminalTimeoutMs: 30_000,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (FLAGS.includes(token)) {
      if (seen.has(token)) throw refusal(`duplicated_argument:${token}`);
      seen.add(token);
      if (token === "-h" || token === "--help") options.help = true;
      else if (token === "--keep-log") options.keepLog = true;
      else if (token === "--recover") options.recover = true;
      else options.dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(token)) throw refusal(`invalid_argument:${String(token)}`);
    if (seen.has(token)) throw refusal(`duplicated_argument:${token}`);
    seen.add(token);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw refusal(`invalid_argument_value:${token}`);
    index += 1;
    switch (token) {
      case "--action":
        options.action = value;
        break;
      case "--held":
        options.held = value;
        break;
      case "--held-item":
        if (!QUALIFIED_ITEM_ID.test(value)) throw refusal(`invalid_held_item:${value}`);
        options.heldItem = value;
        break;
      case "--target":
        if (!TARGET_POLICIES.includes(value)) throw refusal(`invalid_target_policy:${value}`);
        options.target = value;
        options.targetRequested = true;
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
      case "--terminal-timeout-ms":
        options.terminalTimeoutMs = boundedInteger(value, 1_000, 600_000, "invalid_terminal_timeout_ms");
        break;
      default:
        throw refusal(`invalid_argument:${token}`);
    }
  }
  if (options.help) return Object.freeze(options);
  // One hand per run: `--held` puts a tool there through an action, `--held-item` declares a fixture Given. A run that
  // asked for both would have two answers to "what was in the hand" and only one slot to put them in.
  if (options.held !== null && options.heldItem !== null) throw refusal("live_action_held_conflict");
  // Recovery is a different job — it takes back a transaction rather than starting one — so it stands alone instead of
  // quietly ignoring an action the caller also asked for.
  if (options.recover) {
    if (options.action !== null) throw refusal("recover_takes_no_action");
    return Object.freeze(options);
  }
  if (options.action === null) throw refusal("missing_action");
  if (!/^[a-z][a-z0-9_]{1,63}$/u.test(options.action)) throw refusal(`invalid_action:${options.action}`);
  return Object.freeze(options);
}

function boundedInteger(value, minimum, maximum, code) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw refusal(`${code}:${value}`);
  return number;
}

/** Every tool category `equip_tool` can select, from the generated surface's own argument enum. */
export function heldToolCategories({ surfacePath = join(REPO, SURFACE) } = {}) {
  const surface = JSON.parse(readFileSync(surfacePath, "utf8"));
  const entry = surface.actions.find((candidate) => candidate.actionId === HELD_ACTION);
  const values = entry?.argumentSchema?.tool?.enum;
  if (!Array.isArray(values) || values.length === 0)
    throw refusal(`held_vocabulary_missing:${HELD_ACTION}:argumentSchema.tool.enum`);
  return Object.freeze([...values]);
}

/**
 * The snapshot field one action's targets are published under (`PetTargets` -> `petTargets`), or null when the action
 * declares no target at all. The discovery audit's `TARGET_FIELD` is the authority: it is the map the promotion gate
 * already requires every target-bearing action to appear in.
 */
export function targetFieldFor(actionId) {
  const field = TARGET_FIELD[actionId];
  return typeof field === "string" && field.length > 0 ? `${field[0].toLowerCase()}${field.slice(1)}` : null;
}

/** The rows one snapshot publishes for `field`, bounded, with the fields a caller can act on. */
export function targetRows(snapshot, field) {
  const rows = snapshot?.[field];
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, MAX_TARGET_ROWS).map((row) => ({
    targetId: typeof row?.targetId === "string" ? row.targetId : null,
    x: Number.isInteger(row?.x) ? row.x : null,
    y: Number.isInteger(row?.y) ? row.y : null,
  }));
}

/**
 * Which of four outcomes one snapshot is, by NAME.
 *
 * The four are different facts and each one sends a reader somewhere else: the action is not advertised here (the
 * fixture armed a world this Mod does not publish the action for), it is advertised and the snapshot does not carry
 * the family at all (the capability was published with no discovery behind it), it carries the family with no rows
 * (the family ran and found nothing), or there is a row to name. A single "no target" answer served none of them —
 * measured 2026-11-09 on `feed_animal`, where `target.count: null` was read as every one of the first three.
 *
 * Pure over the snapshot so every branch can be pinned without a game.
 */
export function describeTargetOutcome(snapshot, { action, targetField, policy = "nearest" }) {
  const revision = Number.isInteger(snapshot?.revision) ? snapshot.revision : null;
  const actionAdvertised = Array.isArray(snapshot?.capabilities) && snapshot.capabilities.includes(action);
  if (!actionAdvertised)
    return { code: `live_action_action_not_advertised:${action}`, ok: false, revision, rows: [], chosen: null };
  if (targetField !== null && !Array.isArray(snapshot?.[targetField]))
    return { code: `live_action_family_absent:${targetField}`, ok: false, revision, rows: [], chosen: null };
  const rows = targetField === null ? [] : targetRows(snapshot, targetField);
  if (targetField !== null && rows.length === 0)
    return { code: `live_action_family_empty:${targetField}`, ok: false, revision, rows, chosen: null };
  const chosen = chooseTargetRow(rows, policy, snapshot?.tile);
  return {
    code: `live_action_target_chosen:${chosen?.targetId ?? "(no-target)"}`,
    ok: true,
    revision,
    rows,
    chosen,
  };
}

/**
 * The one observation this run makes before the executor: wait for a world that can act, then name what it offers.
 *
 * The wait is the part every other native-local runner already has, and its absence here was the whole of the 2026-11-09
 * `feed_animal` refusal: the fixture warps the actor into the barn, `nativeLocalPlayerFixtureInitialized` becomes true
 * inside the warp's own `OnWarped`, the bridge opens, and the first snapshot therefore reads `actionable: false` while
 * a fade is still running. A world that never settles still fails closed, and it fails closed with the target question
 * answered beside it — which is what tells a reader whether the fixture armed anything at all.
 */
export async function observeForTarget(client, { plan, timeoutMs }) {
  const first = await observeFresh(client);
  let snapshot = first;
  try {
    snapshot = await waitForActionable(client, first, timeoutMs);
  } catch (error) {
    if (!(error instanceof Error) || !/^native_snapshot_not_actionable/u.test(error.message)) throw error;
  }
  return {
    snapshot,
    outcome: describeTargetOutcome(snapshot, {
      action: plan.action,
      targetField: plan.targetField,
      policy: plan.target,
    }),
  };
}

/**
 * Which published target this run is pointed at.
 *
 * `first` is the Mod's own order; `nearest` is the row closest to the actor by Chebyshev distance, the same distance
 * `pet_animal` admits a Pet through (radius 1 around the actor). A row with no tile cannot be ranked, so unrankable rows
 * keep their published order behind the ranked ones instead of being dropped.
 */
export function chooseTargetRow(rows, policy, tile) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (policy === "first") return rows[0];
  if (policy !== "nearest") throw refusal(`invalid_target_policy:${policy}`);
  const actorX = Number.isInteger(tile?.x) ? tile.x : null;
  const actorY = Number.isInteger(tile?.y) ? tile.y : null;
  const ranked = rows.map((row, index) => ({
    row,
    index,
    distance:
      actorX !== null && actorY !== null && Number.isInteger(row.x) && Number.isInteger(row.y)
        ? Math.max(Math.abs(row.x - actorX), Math.abs(row.y - actorY))
        : Number.POSITIVE_INFINITY,
  }));
  ranked.sort((left, right) =>
    left.distance === right.distance ? left.index - right.index : left.distance - right.distance,
  );
  return ranked[0].row;
}

/**
 * A save directory as a reader has to see it before a launch: does it exist, when was its save file written, which world
 * is it, and which calendar does it claim.
 *
 * This exists because "the working save is dirty" is not a fact a reader can check against anything, and the numbers are
 * what decide it: a pristine fixture is `spring 1 Y1, dayOfMonth=1, daysPlayed=1` carrying the template's own mtime (the
 * copy preserves it), while a world that has been played carries a later mtime and a calendar that has moved. So both
 * the refusal and the pre-launch line print these fields instead of an adjective.
 *
 * `present` is the DIRECTORY, because that is what the game loads; the other fields are null when the save file cannot
 * be read, which is itself a fact worth printing.
 */
export function describeSaveAt({ directory, saveName }) {
  if (!existsSync(directory))
    return Object.freeze({
      path: directory,
      present: false,
      mtime: null,
      gameId: null,
      farmName: null,
      calendar: null,
    });
  const saveFile = join(directory, saveName);
  let mtime = null;
  let gameId = null;
  let farmName = null;
  let calendar = null;
  try {
    mtime = statSync(saveFile).mtime.toISOString();
    const xml = readFileSync(saveFile, "utf8");
    gameId = firstGroup(xml, /<uniqueIDForThisGame>(\d+)<\/uniqueIDForThisGame>/u);
    farmName = firstGroup(xml, /<farmName>([^<]{0,64})<\/farmName>/u);
    calendar = {
      season: firstGroup(xml, /<currentSeason>([A-Za-z]+)<\/currentSeason>/u),
      year: numberOrNull(firstGroup(xml, /<year>(\d+)<\/year>/u)),
      dayOfMonth: numberOrNull(firstGroup(xml, /<dayOfMonth>(\d+)<\/dayOfMonth>/u)),
      daysPlayed: numberOrNull(
        firstGroup(xml, /<string>daysPlayed<\/string>\s*<\/key>\s*<value>\s*<unsignedInt>(\d+)<\/unsignedInt>/u),
      ),
    };
  } catch (_error) {
    /* An unreadable save file keeps every field null: the reader sees that it could not be read. */
  }
  return Object.freeze({ path: directory, present: true, mtime, gameId, farmName, calendar });
}

function firstGroup(text, pattern) {
  return pattern.exec(text)?.[1] ?? null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function describeCalendar(calendar) {
  if (calendar === null || typeof calendar !== "object") return "calendar=unreadable";
  const where =
    calendar.season === null
      ? "unknown season"
      : `${calendar.season} ${String(calendar.dayOfMonth)} Y${String(calendar.year)}`;
  return `calendar=${where} (dayOfMonth=${String(calendar.dayOfMonth)}, daysPlayed=${String(calendar.daysPlayed)})`;
}

/**
 * The one line printed before a launch: what this run will exercise, and which world it will be loaded from.
 *
 * A run that measures nothing must be visible as such BEFORE it spends 90 seconds. The target count is deliberately not
 * printed as a number: it is read from the first snapshot, and a number here would be a prediction wearing a
 * measurement's clothes. The save half is the part a reader needs to tell a fresh fixture from a leftover one — the
 * working save must be absent to get this far, so what it names is the template the world will be copied from.
 */
export function describeExercise(plan) {
  const save = plan.workingSave;
  const template = plan.template;
  const held = plan.held === null ? "none" : `tool:${plan.held} (via ${HELD_ACTION})`;
  const heldItem = plan.heldItem === null ? null : `item:${plan.heldItem} (fixture HeldItemQualifiedId)`;
  const working = save.present ? `present mtime=${String(save.mtime)}` : "absent";
  return [
    "exercising",
    `action=${plan.action}`,
    `family=${plan.targetField ?? "none"}`,
    "targets=counted-at-attach",
    `held=${heldItem ?? held}`,
    `scenario=${plan.scenario.length === 0 ? "(ordinary-world)" : plan.scenario}`,
    `save=${save.path}(${working})`,
    `template=${template.path}(mtime=${String(template.mtime)}, gameId=${String(template.gameId)}, farm=${String(template.farmName)}, ${describeCalendar(template.calendar)})`,
  ].join(" ");
}

/**
 * The sentence a refusal block owes for the codes whose meaning is "not measured, and here is why".
 *
 * A bare code invites the next reader to read its absence as a pass, and these three are exactly the cases where nothing
 * was exercised: a declared hand the world did not show, and a leftover world the launch never touched.
 */
export function refusalNote(reasonCode) {
  if (reasonCode.startsWith("live_action_held_item_not_in_hand:"))
    return "not measured: the fixture declared this hand and the first snapshot does not show it in the selected slot, so no action ran. The Mod refuses a hand it cannot mint by name (`fixture_held_item_unknown`, `fixture_held_item_no_room`) — read its log for that code before looking anywhere else";
  if (reasonCode.startsWith("live_action_working_save_present:"))
    return "not measured: an earlier run left this working save behind, and the game would load that world instead of the fixture's. Nothing was mutated and no game was launched. Clear it with `node tools/live-action.mjs --recover` (which refuses while a game is running)";
  return undefined;
}

/** The held state exactly as the Mod projects it: the tool in hand, its slot, and whatever occupies that slot. */
export function describeHeldState(snapshot) {
  return {
    tool: typeof snapshot?.currentTool === "string" && snapshot.currentTool.length > 0 ? snapshot.currentTool : null,
    slot: Number.isInteger(snapshot?.currentToolSlot) ? snapshot.currentToolSlot : null,
    item:
      typeof snapshot?.currentToolSlotItem === "string" && snapshot.currentToolSlotItem.length > 0
        ? snapshot.currentToolSlotItem
        : null,
  };
}

function sameHeldState(left, right) {
  return left.tool === right.tool && left.slot === right.slot && left.item === right.item;
}

/**
 * The answer a held-state perturbation ended in, or `no_answer`.
 *
 * The three accepted endings are `HeldStatePerturbationTests`': it selected what it needed and the hand came back
 * (`selected_and_restored`), it never needed the hand (`ran_without_selecting`), or it refused BY NAME. A hand left
 * somewhere else (`selected_hand_not_restored`, `ran_with_hand_changed`) is NAMED rather than accepted, because "and the
 * hand was restored" is part of the ending the rule allows; a terminal with no reason code is `no_answer`.
 */
export function describeHeldAnswer({ receipt, heldBefore, heldAfter }) {
  if (receipt === null || receipt === undefined) return { answer: "no_answer", ok: false };
  const reasonCode = typeof receipt.reasonCode === "string" ? receipt.reasonCode : "";
  if (reasonCode.length === 0) return { answer: "no_answer", ok: false };
  const succeeded = receipt.state === "succeeded" || receipt.state === "partially_succeeded";
  if (!succeeded) return { answer: `refused_by_name:${reasonCode}`, ok: true, reasonCode };
  const fields = parseReceiptFields(evidenceDetail(receipt.evidence));
  const selected = fields?.get("tool_selected") ?? null;
  const restored = fields?.get("tool_restored") ?? null;
  const unchanged = sameHeldState(heldBefore, heldAfter);
  if (selected !== null) {
    if (restored !== null && unchanged) return { answer: "selected_and_restored", ok: true, selected, restored };
    return { answer: "selected_hand_not_restored", ok: false, selected, restored };
  }
  if (unchanged) return { answer: "ran_without_selecting", ok: true };
  return { answer: "ran_with_hand_changed", ok: false };
}

/** The parameter names one executor declares, read from its own source so the call shape is not guessed. */
function declaredParameterNames(fn) {
  const source = Function.prototype.toString.call(fn);
  const open = source.indexOf("(");
  if (open < 0) return [];
  let depth = 0;
  let close = -1;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) return [];
  return source
    .slice(open + 1, close)
    .split(",")
    .map((parameter) =>
      parameter
        .trim()
        .replace(/^\.\.\./u, "")
        .split("=")[0]
        .trim(),
    )
    .filter((name) => name.length > 0);
}

/** How to call one executor. This tree has exactly two shapes; anything else is refused by name. */
export const EXECUTOR_CALL_SHAPES = Object.freeze({
  "receipts-second": "run<X>Smoke(client, receipts, config) - the harness convention",
  "config-second": "run<X>Smoke(client, config) - the two-parameter variant",
});

/**
 * Resolve the action's gate runner and the one function in it that executes the action.
 *
 * The runner is the registry's own answer (`resolveStardewActionGateRunner`), so this tool can never drive an action
 * through a runner the gate tables do not name. The function is the module's single `run*Smoke` export, and its call
 * shape is read from its declared parameters: six modules in this tree predate the convention (four export no such
 * function, and the level-up runner exports two for two worlds), and those refuse by name instead of being guessed at.
 */
export async function resolveActionExecutor(actionId, { toolsRoot = TOOLS } = {}) {
  let runnerFile;
  try {
    runnerFile = resolveStardewActionGateRunner(actionId);
  } catch (error) {
    throw refusal(String(error?.message ?? error), error);
  }
  const module = await import(pathToFileURL(join(toolsRoot, runnerFile)).href);
  const candidates = Object.entries(module).filter(
    ([name, value]) => /^run[A-Za-z0-9]*Smoke$/u.test(name) && typeof value === "function",
  );
  if (candidates.length === 0) throw refusal(`action_executor_missing:${runnerFile}`);
  if (candidates.length > 1)
    throw refusal(`action_executor_ambiguous:${runnerFile}:${candidates.map(([name]) => name).join("+")}`);
  const [name, fn] = candidates[0];
  const parameters = declaredParameterNames(fn);
  if (parameters[0] !== "client")
    throw refusal(`action_executor_signature_unrecognised:${runnerFile}:first=${parameters[0] ?? "none"}`);
  const shape = parameters[1] === "receipts" ? "receipts-second" : parameters[1] === "config" ? "config-second" : null;
  if (shape === null)
    throw refusal(`action_executor_signature_unrecognised:${runnerFile}:second=${parameters[1] ?? "none"}`);
  return Object.freeze({
    runnerFile,
    export: name,
    shape,
    invoke: (client, receipts, config) =>
      shape === "config-second" ? fn(client, config) : fn(client, receipts, config),
  });
}

/** The live transaction behind the fixture root, as its owner recorded it, or null when the root is free. */
export function readFixtureTransaction(fixtureRoot) {
  const lock = join(fixtureRoot, ".stardew-native-local-player-fixture.lock");
  if (!existsSync(lock)) return null;
  try {
    const owner = JSON.parse(readFileSync(join(lock, "transaction.json"), "utf8"));
    return Object.freeze({
      ownerId: typeof owner?.ownerId === "string" ? owner.ownerId : null,
      backupName: typeof owner?.backupName === "string" ? owner.backupName : null,
    });
  } catch (_error) {
    return Object.freeze({ ownerId: null, backupName: null });
  }
}

export function requireAbsolute(value, code) {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) throw refusal(`${code}:${value}`);
  return resolve(value);
}

/** The root's one bootstrap-captured binding, or a refusal that names what it found instead. */
export function singleBinding(fixtureRoot) {
  if (!existsSync(fixtureRoot)) throw refusal(`live_action_fixture_root_missing:${fixtureRoot}`);
  const names = readdirSync(fixtureRoot).filter((name) => name.endsWith(".native-local-binding.json"));
  if (names.length === 0) throw refusal(`live_action_binding_missing:${fixtureRoot}`);
  if (names.length > 1) throw refusal(`live_action_binding_ambiguous:${names.sort().join(",")}`);
  const bindingPath = join(fixtureRoot, names[0]);
  const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
  if (typeof binding?.observedSaveSlot !== "string" || binding.observedSaveSlot.length === 0)
    throw refusal(`live_action_binding_invalid:${bindingPath}`);
  return { bindingPath, binding };
}

/**
 * Resolve and validate everything the run needs, touching the filesystem read-only.
 *
 * This is the whole of `--dry-run`, and the guard the live form runs before its first mutation: a live transaction, a
 * running game, a missing binding or an action no fixture can arm is refused HERE, naming the fact, instead of after a
 * 40-second boot.
 */
export async function planLiveAction(options, { env = process.env, roots = null, surfacePath = undefined } = {}) {
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
    if (!existsSync(bindingPath)) throw refusal(`live_action_binding_missing:${bindingPath}`);
    binding = JSON.parse(readFileSync(bindingPath, "utf8"));
  }
  if (!/^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$/u.test(String(saveName)))
    throw refusal(`invalid_fixture_observed_save_slot:${String(saveName)}`);

  // The registry answers "is this an action at all" before anything asks what world it needs: an id no authority
  // publishes is refused by that name, not as a missing fixture scenario.
  const executor = await resolveActionExecutor(options.action);

  let declared;
  try {
    declared = fixtureActionSet({ action: options.action });
  } catch (error) {
    throw refusal(`live_action_no_fixture_scenario:${options.action}`, error);
  }

  if (options.held !== null && !heldToolCategories({ surfacePath }).includes(options.held)) {
    // A qualified item id here is a different flag's job, and saying so is the whole point of naming it: `--held-item`
    // declares the hand as a fixture Given, while `--held` can only drive `equip_tool`, which selects tools.
    if (QUALIFIED_ITEM_ID.test(options.held)) throw refusal(`invalid_held_selector:${options.held}:use_--held-item`);
    throw refusal(`invalid_held_selector:${options.held}`);
  }
  // A held tool can only be put in the hand by the published `equip_tool` action, so the fixture publishes it beside
  // the action under test unless its own scenario already does.
  const heldRunnerFile = options.held === null ? null : resolveStardewActionGateRunner(HELD_ACTION);
  const heldExtra = options.held === null || declared.includes(HELD_ACTION) ? [] : [HELD_ACTION];

  const targetField = targetFieldFor(options.action);
  if (options.targetRequested && targetField === null)
    throw refusal(`target_policy_unavailable:${options.action}:no_declared_target_field`);

  const templatePath = join(fixtureRoot, "templates", saveName);
  if (!existsSync(templatePath)) throw refusal(`live_action_template_missing:${templatePath}`);

  // A working save an earlier run left behind is not a fixture: the game would load a world that has already been
  // played, and every later fact of the run would describe that world instead of the one this plan named. The plan
  // mutates nothing, so the refusal is free — and it is what stops a launch from measuring a dirty save.
  const stardewSaveRoot = gameStardewSaveRoot({ appData: env.APPDATA });
  const workingSave = describeSaveAt({ directory: join(stardewSaveRoot, saveName), saveName });
  if (workingSave.present)
    throw refusal(`live_action_working_save_present:${workingSave.path}`, undefined, workingSave);

  const actions = fixtureActionSet({ action: options.action, extraActions: heldExtra });
  return Object.freeze({
    fixtureRoot,
    modsPath,
    releaseDir,
    gamePath,
    saveName,
    templatePath,
    template: describeSaveAt({ directory: templatePath, saveName }),
    workingSave,
    bindingPath,
    binding,
    stardewSaveRoot,
    clientConfigPath: join(modsPath, STARDEW_MOD_FOLDER, "config.json"),
    backupName: `native-local-${options.action.replaceAll("_", "-")}-fixture-backup`,
    action: options.action,
    scenario: fixtureScenario(actions, options.action),
    actions,
    heldExtra,
    held: options.held,
    heldItem: options.heldItem,
    heldRunnerFile,
    target: options.target,
    targetField,
    executor,
    windowMode: options.windowMode,
    timeoutSeconds: options.timeoutSeconds,
    terminalTimeoutMs: options.terminalTimeoutMs,
    keepLog: options.keepLog,
  });
}

/** What `--dry-run` prints: what the live form would do, where, and with what. */
export function describePlan(plan) {
  return {
    state: "planned",
    action: plan.action,
    fixtureScenario: plan.scenario,
    fixtureActions: plan.actions,
    held:
      plan.held === null
        ? null
        : {
            category: plan.held,
            dispatchedBy: plan.heldRunnerFile,
            widensFixture: plan.heldExtra.length > 0,
          },
    heldItem:
      plan.heldItem === null
        ? null
        : { qualifiedItemId: plan.heldItem, appliedBy: "NativeLocalPlayerFixture.HeldItemQualifiedId" },
    target: { policy: plan.target, field: plan.targetField },
    executor: { runnerFile: plan.executor.runnerFile, export: plan.executor.export, shape: plan.executor.shape },
    fixtureRoot: plan.fixtureRoot,
    modsPath: plan.modsPath,
    releaseDir: plan.releaseDir,
    gamePath: plan.gamePath,
    clientConfigPath: plan.clientConfigPath,
    saveName: plan.saveName,
    stardewSaveRoot: plan.stardewSaveRoot,
    templatePath: plan.templatePath,
    template: plan.template,
    workingSave: plan.workingSave,
    bindingPath: plan.bindingPath,
    backupName: plan.backupName,
    windowMode: plan.windowMode,
    timeoutSeconds: plan.timeoutSeconds,
  };
}

/**
 * The fixture transaction a dead run left behind, described without touching anything.
 *
 * Recovery exists because this tool can STRAND an operator: a run killed between prepare and teardown leaves the lock and
 * its backup in the root, and from then on every slice refuses `live_action_transaction_live:<backup>:<owner>` — the
 * operator is told a fact and sent to read four modules to learn how to clear it (measured 2026-11-08: the refusing run's
 * own transaction survived its teardown, and the restore entry had no help text and needed five arguments).
 *
 * The lock is the authority for WHICH transaction to take back: `backupName` is recorded there by the run that opened it,
 * so recovery never guesses. The save slot is not required — a transaction can be released without naming a world, and
 * demanding one would block the case this exists for.
 */
export async function planRecovery(options, { env = process.env, roots = null } = {}) {
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
  const stardewSaveRoot = gameStardewSaveRoot({ appData: env.APPDATA });
  let saveName = options.saveName;
  let bindingProblem = null;
  if (saveName === null) {
    try {
      saveName = singleBinding(fixtureRoot).binding.observedSaveSlot;
    } catch (error) {
      bindingProblem = String(error?.message ?? error).slice(0, 200);
    }
  }
  return Object.freeze({
    fixtureRoot,
    modsPath,
    releaseDir,
    stardewSaveRoot,
    saveName,
    bindingProblem,
    transaction: readFixtureTransaction(fixtureRoot),
    workingSave: saveName === null ? null : describeSaveAt({ directory: join(stardewSaveRoot, saveName), saveName }),
  });
}

/** What `--recover --dry-run` prints: which transaction and which save recovery would take back. */
export function describeRecovery(recovery) {
  return {
    state: recovery.transaction === null ? "clear" : "recoverable",
    fixtureRoot: recovery.fixtureRoot,
    modsPath: recovery.modsPath,
    releaseDir: recovery.releaseDir,
    backupName: recovery.transaction?.backupName ?? null,
    ownerId: recovery.transaction?.ownerId ?? null,
    workingSave: recovery.workingSave,
    bindingProblem: recovery.bindingProblem,
    note:
      recovery.transaction === null
        ? "no fixture transaction is live in this root"
        : "a dead run left this transaction behind; --recover releases it through the same restore the teardown uses",
  };
}

/**
 * Take back what a dead run left: its fixture transaction, and the working save its slice was copied into.
 *
 * Both steps go through the SAME paths the teardown uses (`release` is `releaseFixture`, `runHarness` is
 * `runFixtureSaveHarness`), so recovery cannot succeed in a way the teardown would not, and it cannot claim a restore the
 * teardown would call a failure. A Stardew process is refused first: the save harness will not touch files under a
 * running game, and a transaction whose owner is mid-run is not dead.
 */
export async function recoverFixture(
  recovery,
  { release = releaseFixture, runHarness = runFixtureSaveHarness, listPids = listStardewProcessIds } = {},
) {
  const runningPids = listPids();
  if (runningPids.length > 0) throw refusal(`live_action_game_already_running:${runningPids.join(",")}`);
  const facts = {
    state: "clear",
    fixtureRestored: false,
    saveRestored: false,
    backupName: recovery.transaction?.backupName ?? null,
    ownerId: recovery.transaction?.ownerId ?? null,
    workingSavePath: recovery.workingSave?.path ?? null,
    problems: [],
  };
  if (recovery.workingSave?.present === true && recovery.saveName !== null) {
    try {
      runHarness({
        plan: {
          fixtureRoot: recovery.fixtureRoot,
          saveName: recovery.saveName,
          stardewSaveRoot: recovery.stardewSaveRoot,
        },
        cleanup: true,
      });
      facts.saveRestored = true;
    } catch (error) {
      facts.problems.push(String(error?.message ?? error).slice(0, 300));
    }
  }
  if (recovery.transaction !== null) {
    if (recovery.transaction.backupName === null)
      facts.problems.push(`live_action_recovery_backup_unnamed:${recovery.fixtureRoot}`);
    else {
      try {
        release({
          fixtureRoot: recovery.fixtureRoot,
          modsPath: recovery.modsPath,
          releaseDir: recovery.releaseDir,
          backupName: recovery.transaction.backupName,
        });
        facts.fixtureRestored = true;
      } catch (error) {
        facts.problems.push(String(error?.message ?? error).slice(0, 300));
      }
    }
  }
  // The state is the outcome, never an intention: a step that refused makes this blocked, and a root with nothing to take
  // back says so instead of reporting a recovery that never had to happen.
  if (facts.problems.length > 0) facts.state = "blocked";
  else if (recovery.transaction !== null) facts.state = "recovered";
  return Object.freeze(facts);
}

function bound(text, limit) {
  if (typeof text !== "string") return null;
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Every blocker a run has to clear, from the executor's verdict, the receipt it named, and the ending.
 *
 * Exported because the LIST is the verdict: "the action passed" is `blockers.length === 0`, and a caller that cannot
 * drive a live game still has to be able to ask whether a run the executor called passed would read as blocked.
 */
export function describeBlockers({ action, executorState, executorReason, receipts, held, perturbation, ending }) {
  const blockers = [];
  if (executorState !== "passed") blockers.push(`executor_state:${executorState}`);
  if (held !== null && perturbation?.answer?.ok !== true)
    blockers.push(`held_perturbation:${perturbation?.answer?.answer ?? "no_answer"}`);
  const judged = judgedReceipt({ receipts, action, executorReason });
  if (judged.mismatch !== null)
    blockers.push(judged.mismatch, `terminals:${judged.seen.length === 0 ? "(none)" : judged.seen.join(",")}`);
  else if (judged.receipt === null) blockers.push("no_terminal_receipt");
  else if (judged.receipt.state !== "succeeded" && judged.receipt.state !== "partially_succeeded")
    blockers.push(`receipt_state:${judged.receipt.state}`);
  if (ending !== null && ending !== undefined) blockers.push(ending);
  return blockers;
}

function terminalReceiptFor(receipts, actionId) {
  const matching = terminalReceiptsFor(receipts, actionId);
  return matching.length === 0 ? null : matching[matching.length - 1];
}

/** Every terminal one action minted, in arrival order. */
export function terminalReceiptsFor(receipts, actionId) {
  return receipts.filter(
    (receipt) =>
      receipt?.actionId === actionId && TERMINAL_STATES.has(receipt.state) && typeof receipt.requestId === "string",
  );
}

/**
 * The terminal receipt this run is JUDGED on: the one the executor itself named.
 *
 * A runner may dispatch the same action twice on purpose. `pet_farm_animal` re-attempts its own pet from a fresh
 * observation to prove the engine refuses the second one BY NAME, so "the last terminal for this action" is the probe,
 * not the action - measured 2026-11-09, where a passing run read `blocked` / `receipt_state:rejected` because the
 * deliberate refusal had arrived last. The executor's reason code is the one statement of WHICH execution this run was,
 * so a terminal carrying it is the answer.
 *
 * A run whose executor names something no terminal carries fails closed and says so with the candidates it did see:
 * "there were no terminals" and "none of them is the answer I was given" are different facts. When nothing named a
 * reason at all (a failure before or during the action), the last terminal is used, exactly as before.
 */
export function judgedReceipt({ receipts, action, executorReason }) {
  const terminals = terminalReceiptsFor(receipts, action);
  const seen = terminals.map((receipt) => `${String(receipt.reasonCode)}:${String(receipt.state)}`);
  if (typeof executorReason !== "string" || executorReason.length === 0)
    return {
      receipt: terminals.length === 0 ? null : terminals[terminals.length - 1],
      terminals,
      seen,
      mismatch: null,
    };
  const matching = terminals.filter((receipt) => receipt.reasonCode === executorReason);
  if (matching.length === 0)
    return { receipt: null, terminals, seen, mismatch: `no_terminal_receipt_matching_executor:${executorReason}` };
  return { receipt: matching[matching.length - 1], terminals, seen, mismatch: null };
}

function summarizeReceipt(receipt) {
  if (receipt === null) return null;
  const fields = parseReceiptFields(evidenceDetail(receipt.evidence));
  return {
    actionId: receipt.actionId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    evidence: bound(evidenceDetail(receipt.evidence), MAX_EVIDENCE_CHARS),
    target: fields?.get("target") ?? fields?.get("target_id") ?? null,
    tile: fields?.get("tile") ?? null,
  };
}

/** The target's own tile, in the `x,y` form a receipt writes it. */
function chosenTile(chosen) {
  return Number.isInteger(chosen?.x) && Number.isInteger(chosen?.y) ? `${chosen.x},${chosen.y}` : null;
}

function tileOf(snapshot) {
  return Number.isInteger(snapshot?.tile?.x) && Number.isInteger(snapshot?.tile?.y)
    ? `${snapshot.tile.x},${snapshot.tile.y}`
    : null;
}

/** The engine's own post-state: an observation, never the receipt's claim. */
function snapshotProjection(snapshot, targetField) {
  if (snapshot === null || snapshot === undefined) return null;
  return {
    revision: Number.isInteger(snapshot.revision) ? snapshot.revision : null,
    location: typeof snapshot.location === "string" ? snapshot.location : null,
    tile: tileOf(snapshot),
    actionable: snapshot.actionable === true,
    activeExecution:
      snapshot.activeExecution === null || snapshot.activeExecution === undefined
        ? null
        : { state: snapshot.activeExecution.state ?? null, reasonCode: snapshot.activeExecution.reasonCode ?? null },
    held: describeHeldState(snapshot),
    // What the pack actually holds, so a perturbation refused as `tool_not_found` explains itself instead of costing a
    // second run to look.
    tools: Array.isArray(snapshot.toolSlots)
      ? snapshot.toolSlots.slice(0, 8).map((row) => ({ slot: row?.slot ?? null, label: row?.label ?? null }))
      : null,
    targets: targetField === null ? null : targetRows(snapshot, targetField),
  };
}

/**
 * One bounded block: the run's verdict plus every fact the receipt block owes, in one object.
 *
 * Exported because the block IS the tool's product: a refusal's shape is as much a contract as `USAGE`, and the tests
 * that pin what a reader is told (`target.measured` false for a family nobody read) have to build the same object the
 * live form prints.
 */
export function buildBlock({
  plan,
  verdict,
  reasonCode,
  detail,
  target,
  held,
  heldItem = null,
  receipts,
  reread,
  perturbation,
  restore,
  startedAt,
  blockers = [],
  executorReason = "",
}) {
  const judged = judgedReceipt({ receipts, action: plan.action, executorReason });
  const actionReceipt = summarizeReceipt(judged.receipt);
  const chosen = target?.chosen ?? null;
  const receiptTarget = actionReceipt?.target ?? null;
  return {
    state: verdict,
    reasonCode,
    ...(detail === undefined ? {} : { detail }),
    action: plan.action,
    fixture: { scenario: plan.scenario, actions: plan.actions, saveName: plan.saveName, backupName: plan.backupName },
    // `measured` is the difference between "the world published no target" and "nothing ever looked": the count is
    // null unless a snapshot was read, so an empty family cannot be reported as `0` by a run that never observed.
    target:
      plan.targetField === null
        ? null
        : {
            policy: plan.target,
            field: plan.targetField,
            scenario: plan.scenario,
            measured: target !== null,
            count: target === null ? null : target.rows.length,
            chosen,
            matchesReceipt:
              chosen !== null && chosen.targetId !== null && receiptTarget !== null
                ? chosen.targetId === receiptTarget
                : null,
          },
    targetId: actionReceipt?.target ?? null,
    tile: actionReceipt?.tile ?? chosenTile(chosen),
    held,
    // The declared hand, as the WORLD showed it: `inHandBefore` is the fixture's Given verified against the first
    // snapshot, and `inHandAfter` is the same id against the engine's re-read.
    heldItem,
    evidence: actionReceipt?.evidence ?? null,
    receipt: actionReceipt,
    // EVERY terminal this action minted, so a reader sees the probe a runner dispatched on purpose beside the execution
    // the run was judged on.
    terminals: judged.terminals.map((receipt) => summarizeReceipt(receipt)),
    reread: snapshotProjection(reread, plan.targetField),
    perturbation,
    executor: { runnerFile: plan.executor.runnerFile, export: plan.executor.export, shape: plan.executor.shape },
    restore,
    blockers,
    durationMs: Date.now() - startedAt,
  };
}

export function runFixtureSaveHarness({ plan, cleanup }) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(REPO, FIXTURE_SAVE_HARNESS),
    "-FixtureRoot",
    plan.fixtureRoot,
    "-TemplateName",
    plan.saveName,
    "-SaveName",
    plan.saveName,
    "-StardewSaveRoot",
    plan.stardewSaveRoot,
  ];
  if (cleanup) args.push("-Cleanup");
  const { status, stderr } = spawnSync("powershell.exe", args, { cwd: REPO, encoding: "utf8", windowsHide: true });
  if (status !== 0)
    throw refusal(
      `${cleanup ? "working_save_cleanup_failed" : "working_save_restore_failed"}:${status}:${String(stderr ?? "")
        .trim()
        .slice(-300)}`,
    );
}

/**
 * Release the fixture transaction, and refuse if the child refused.
 *
 * `restoreFixtureTransaction` runs the restore as a child process and the child reports its own refusal with a non-zero
 * exit; ignoring that status is how a run printed `fixtureRestored: true` beside a transaction lock it had never
 * released (measured 2026-11-08: the lock, the backup and the fixture's own config were all still in place after a run
 * that claimed this step had succeeded).
 */
export function releaseFixture(plan) {
  restoreFixtureTransaction({
    run: (argv) => {
      const { status, stderr } = spawnSync(process.execPath, argv, { cwd: REPO, encoding: "utf8", windowsHide: true });
      if (status !== 0)
        throw refusal(
          `live_action_fixture_restore_failed:${String(status)}:${String(stderr ?? "")
            .trim()
            .slice(-300)}`,
        );
    },
    fixtureRoot: plan.fixtureRoot,
    modsPath: plan.modsPath,
    releaseDir: plan.releaseDir,
    backupName: plan.backupName,
    evidenceDir: join(plan.fixtureRoot, "logs"),
  });
}

async function closeSession(stage) {
  if (stage.session === null) return;
  try {
    await stage.session.close();
  } catch (_error) {
    /* a bridge that is already gone owes no unsubscribe */
  }
  stage.session = null;
}

/**
 * Stop exactly the process this run launched, and say whether it actually stopped.
 *
 * The kill is by the EXACT pid the launcher created, through the launch handle's own `close` (a tree kill: killing only
 * the SMAPI child leaves the game behind). The wait is the part that was missing: `taskkill` returns before the process
 * is gone, and a run that reports its restore while the game still holds the fixture is the defect this replaces —
 * measured 2026-11-08, a survivor pid printed in a `problems` list beside `fixtureRestored: true`.
 *
 * Every survivor after the wait is this run's, and the reason is a fact rather than an inference: `runLiveAction`
 * refuses to start while any Stardew image is running, so a Stardew process that is alive now was started here. Nothing
 * is matched by image name — the survivors are read (read-only) and then each is killed by its own pid.
 *
 * With no handle there is nothing to stop: a launch that failed before returning one reclaimed its own tree (`launchStardewLiveRun`
 * kills by pid on its refusal path), and a process this run did not launch is never this run's to kill.
 */
export async function reclaimGame({
  handle,
  listPids = listStardewProcessIds,
  kill = killProcessTree,
  sleep = (ms) => new Promise((wake) => setTimeout(wake, ms)),
  attempts = RECLAIM_ATTEMPTS,
  pollMs = RECLAIM_POLL_MS,
}) {
  const facts = { pid: null, killOutcome: null, killError: null, stillRunning: [] };
  if (handle === null || handle === undefined) return Object.freeze(facts);
  facts.pid = handle.pid ?? null;
  try {
    const closed = await handle.close();
    facts.killOutcome = typeof closed?.outcome === "string" ? closed.outcome : null;
  } catch (error) {
    facts.killError = String(error?.message ?? error).slice(0, 300);
  }
  let survivors = listPids();
  for (let attempt = 1; survivors.length > 0 && attempt <= attempts; attempt += 1) {
    for (const pid of survivors) {
      try {
        kill(pid);
      } catch (error) {
        facts.killError ??= String(error?.message ?? error).slice(0, 300);
      }
    }
    await sleep(pollMs);
    survivors = listPids();
  }
  facts.stillRunning = [...survivors];
  return Object.freeze(facts);
}

/**
 * The ending a finished run's teardown forces, in the order the facts outrank each other, or null when the unwind owes
 * nothing and the action's own verdict stands.
 *
 * A live process outranks everything: while something this run started is still running, no restore claim is true and
 * the next slice would meet a busy fixture root. A dirty save outranks the action's receipt for the same reason from the
 * other side: the next run loads that world, so this one did not finish, whatever the action achieved inside it.
 */
export function restoreEnding(restore) {
  const running = restore?.process?.stillRunning ?? [];
  if (running.length > 0) return `live_action_process_still_running:${running.join(",")}`;
  if (restore?.fixtureRestored !== true) return "live_action_fixture_not_restored";
  if (restore?.saveRestored !== true) return "live_action_working_save_not_restored";
  return null;
}

/**
 * Everything this run owes on the way down, in the order the game needs it: detach, stop, clean the working save,
 * release the transaction.
 *
 * Nothing is restored while a process this run started is alive — the save harness refuses to touch files under a
 * running game anyway, and an unwind that fights a live game is not an unwind. In that case both restore claims stay
 * false and `process.stillRunning` is the fact that explains them; `restoreEnding` turns it into the run's ending.
 */
export async function teardown({
  plan,
  stage,
  trap,
  reclaim = reclaimGame,
  runHarness = runFixtureSaveHarness,
  release = releaseFixture,
}) {
  trap?.dispose();
  await closeSession(stage);
  const launch = await reclaim({ handle: stage.handle });
  stage.handle = null;
  const facts = {
    fixtureRestored: false,
    saveRestored: false,
    logPath: stage.logPath,
    logKept: false,
    process: launch,
    problems: [],
  };
  if (launch.stillRunning.length > 0) {
    facts.logKept = stage.logPath !== null && existsSync(stage.logPath);
    return facts;
  }
  if (stage.saveRestored) {
    try {
      runHarness({ plan, cleanup: true });
      facts.saveRestored = true;
    } catch (error) {
      facts.problems.push(String(error?.message ?? error).slice(0, 300));
    }
  }
  if (stage.prepared) {
    try {
      release(plan);
      facts.fixtureRestored = true;
    } catch (error) {
      facts.problems.push(String(error?.message ?? error).slice(0, 300));
    }
  }
  const keep = stage.keepLog || facts.problems.length > 0 || stage.logPath === null;
  if (!keep && existsSync(stage.logPath)) {
    try {
      rmSync(stage.logPath, { force: true });
    } catch (_error) {
      facts.problems.push(`live_action_lane_log_not_removed:${stage.logPath}`);
    }
  }
  facts.logKept = stage.logPath !== null && existsSync(stage.logPath);
  return facts;
}

/**
 * The one action, over ONE connected session: perturb the hand, pick the target, execute, then re-read the engine.
 *
 * Split out of `runLiveAction` because this is the half that can be driven without a game: the bridge is a boundary
 * the harness does not own, so a stub session proves the orchestration (perturbation first, one executor call, the
 * receipt captured from the session's own buffer, a projection taken AFTER it) without spawning SMAPI.
 */
export async function runOneAction({ plan, session, config }) {
  const receipts = session.receipts;
  let perturbation = null;
  if (plan.held !== null) {
    const equip = await runEquipToolSmoke(session.client, receipts, config, { toolCategory: plan.held });
    perturbation = {
      tool: plan.held,
      state: typeof equip?.state === "string" ? equip.state : "blocked",
      reasonCode: typeof equip?.reasonCode === "string" ? equip.reasonCode : null,
      receipt: summarizeReceipt(terminalReceiptFor(receipts, HELD_ACTION)),
    };
    if (perturbation.state !== "passed") {
      perturbation.answer = { answer: `held_perturbation_refused:${perturbation.reasonCode ?? "unknown"}`, ok: false };
      throw refusal(`held_perturbation_refused:${perturbation.reasonCode ?? "unknown"}`);
    }
  }

  const observed = await observeForTarget(session.client, { plan, timeoutMs: plan.terminalTimeoutMs });
  const snapshotBefore = observed.snapshot;
  const heldBefore = describeHeldState(snapshotBefore);
  // The declared hand is a fixture Given, so the FIRST snapshot is what decides whether it was honoured. The Mod's own
  // initializer can refuse (`fixture_held_item_unknown`, `_no_room`) without the config saying anything, and a world that
  // disagrees would otherwise produce a receipt describing a hand nobody declared. Nothing has been executed yet, so this
  // refusal costs one observation.
  if (plan.heldItem !== null && heldBefore.item !== plan.heldItem)
    throw refusal(`live_action_held_item_not_in_hand:${plan.heldItem}`, undefined, {
      declared: plan.heldItem,
      observed: heldBefore,
    });
  // The target question is answered here, before the executor is invoked, so the run cannot spend an action on a world
  // with nothing to name. The refusal is one of three NAMED facts (see `describeTargetOutcome`), never a bare "no
  // target", and the snapshot revision travels with it.
  if (!observed.outcome.ok)
    throw refusal(observed.outcome.code, undefined, {
      revision: observed.outcome.revision,
      actionable: snapshotBefore.actionable === true,
      activeExecution: snapshotBefore.activeExecution ?? null,
      family: plan.targetField,
      rows: observed.outcome.rows.length,
    });
  // A target this run can name, on an actor that still cannot act: the transition the wait above gave up on is the
  // run's ending, named, rather than an action spent against a world mid-fade.
  if (snapshotBefore.actionable !== true || snapshotBefore.activeExecution != null)
    throw refusal(`live_action_world_not_actionable:${plan.action}`, undefined, {
      revision: observed.outcome.revision,
      target: observed.outcome.chosen?.targetId ?? null,
      activeExecution: snapshotBefore.activeExecution ?? null,
    });
  const target = plan.targetField === null ? null : { rows: observed.outcome.rows, chosen: observed.outcome.chosen };
  process.stderr.write(
    `[live-action] ${observed.outcome.code} revision=${String(observed.outcome.revision)} location=${String(snapshotBefore.location)}\n`,
  );

  const executorResult = await plan.executor.invoke(session.client, receipts, config);

  const actionReceipt = terminalReceiptFor(receipts, plan.action);
  const snapshotReread = await waitForFreshSnapshot(session.client, {
    minRevision: Number.isInteger(actionReceipt?.revision) ? actionReceipt.revision : 0,
    timeoutMs: plan.terminalTimeoutMs,
  });
  if (plan.held !== null) {
    perturbation.answer = describeHeldAnswer({
      receipt: actionReceipt,
      heldBefore,
      heldAfter: describeHeldState(snapshotReread),
    });
  }
  const heldItem =
    plan.heldItem === null
      ? null
      : {
          qualifiedItemId: plan.heldItem,
          slotBefore: heldBefore.slot,
          inHandBefore: heldBefore.item === plan.heldItem,
          inHandAfter: describeHeldState(snapshotReread).item === plan.heldItem,
        };
  return { snapshotBefore, snapshotReread, heldBefore, heldItem, target, executorResult, perturbation };
}

/**
 * The whole live transaction. A run-time failure does not throw: it still owes its teardown and its block, and
 * `restore` says what the teardown actually managed.
 */
export async function runLiveAction(plan) {
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

  let receipts = [];
  let snapshotBefore = null;
  let snapshotReread = null;
  let heldBefore = null;
  let heldItem = null;
  let target = null;
  let perturbation = null;
  let executorResult = null;
  let failure = null;
  let trap = null;
  let restore = { fixtureRestored: false, saveRestored: false };

  try {
    // The fixture's own gate first, because it is the one that MOVES a leftover working save aside rather than
    // deleting it (`validateNativeLocalPlayerFixturePreparation`), asserts the template and the calendar, and refuses
    // a live transaction. It runs before any mutation here, so a root this run should not touch is refused while
    // nothing has been written yet.
    const fixtureOptions = {
      root: plan.fixtureRoot,
      modsPath: plan.modsPath,
      releaseDir: plan.releaseDir,
      saveName: plan.saveName,
      backupName: plan.backupName,
      timeoutSeconds: plan.timeoutSeconds,
      action: plan.action,
      extraActions: plan.heldExtra,
      binding: plan.binding,
      stardewSaveRoot: plan.stardewSaveRoot,
      // The declared hand: the Mod mints this id into a free slot and selects it before bridge attachment, and the
      // fixture reads the written config back to prove the field travelled.
      heldItemQualifiedId: plan.heldItem ?? "",
    };
    await validateNativeLocalPlayerFixturePreparation(fixtureOptions);
    await prepareNativeLocalPlayerFixture(fixtureOptions);
    stage.prepared = true;
    runFixtureSaveHarness({ plan, cleanup: false });
    stage.saveRestored = true;

    const config = JSON.parse(await readFile(plan.clientConfigPath, "utf8"));
    stage.logPath = join(plan.fixtureRoot, "logs", `live-action-${plan.action}-${startedAt}.log`);
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
    receipts = stage.session.receipts;

    const outcome = await runOneAction({ plan, session: stage.session, config });
    snapshotBefore = outcome.snapshotBefore;
    snapshotReread = outcome.snapshotReread;
    heldBefore = outcome.heldBefore;
    heldItem = outcome.heldItem;
    target = outcome.target;
    executorResult = outcome.executorResult;
    perturbation = outcome.perturbation;
  } catch (error) {
    failure = error;
  } finally {
    restore = await teardown({ plan, stage, trap });
  }

  const held = { before: heldBefore, after: snapshotReread === null ? null : describeHeldState(snapshotReread) };
  // A teardown that could not finish OUTRANKS the action's own verdict: a live process or a dirty save is what the next
  // slice meets, whatever the action achieved inside this one.
  const ending = restoreEnding(restore);
  if (failure !== null) {
    const block = buildBlock({
      plan,
      verdict: "blocked",
      reasonCode: ending ?? String(failure?.message ?? failure).slice(0, 300),
      ...(failure?.detail === undefined ? {} : { detail: failure.detail }),
      target,
      held,
      heldItem,
      receipts,
      reread: snapshotReread ?? snapshotBefore,
      perturbation,
      restore,
      startedAt,
    });
    return { block, failure, executorResult };
  }

  const executorState = typeof executorResult?.state === "string" ? executorResult.state : "blocked";
  const executorReason = typeof executorResult?.reasonCode === "string" ? executorResult.reasonCode : "";
  // Stepwise, and every absence is a NAMED blocker rather than a silent pass: an executor that reports success the
  // Mod never minted a receipt for is the one thing this tool must not call a pass.
  const blockers = describeBlockers({
    action: plan.action,
    executorState,
    executorReason,
    receipts,
    held: plan.held,
    perturbation,
    ending,
  });
  const passed = blockers.length === 0;
  const judged = judgedReceipt({ receipts, action: plan.action, executorReason });
  const block = buildBlock({
    plan,
    verdict: passed ? "passed" : "blocked",
    reasonCode:
      ending ??
      (typeof executorResult?.reasonCode === "string" && executorResult.reasonCode.length > 0
        ? executorResult.reasonCode
        : (judged.receipt?.reasonCode ?? "no_terminal_receipt")),
    target,
    held,
    heldItem,
    receipts,
    reread: snapshotReread,
    perturbation,
    restore,
    startedAt,
    blockers,
    executorReason,
  });
  return { block, failure: null, executorResult };
}

function printBlock(block) {
  process.stdout.write(`${JSON.stringify(block, null, 2)}\n`);
}

/**
 * The block a refusal prints: the code, whatever measured state came with it, and the sentence that code owes.
 *
 * `note` is why the block carries prose at all: two of these codes mean "not measured", and a bare code is read as a
 * pass by the next reader.
 */
function refusedBlock({ action, reasonCode, detail, startedAt }) {
  const note = refusalNote(reasonCode);
  return {
    state: "blocked",
    reasonCode,
    ...(detail === undefined ? {} : { detail }),
    action: action ?? null,
    ...(note === undefined ? {} : { note }),
    restore: {
      fixtureRestored: false,
      saveRestored: false,
      note: "nothing was mutated: the plan refused before any fixture operation",
    },
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Print a refusal block and set the exit status. Both refusal exits answer in the block shape — the block is what a
 * caller branches on, so a stack trace is never the answer.
 */
function printRefusal({ action, error, startedAt }) {
  printBlock(
    refusedBlock({
      action,
      reasonCode: String(error?.message ?? error).slice(0, 300),
      detail: error?.detail,
      startedAt,
    }),
  );
  process.exitCode = 2;
}

/**
 * The recovery mode: one block, no launch, no kill. Split out of `main` so the argument/plan exits and this one stay
 * legible, and so "recovery never starts anything" is checkable by reading one function.
 */
async function runRecovery(options, startedAt) {
  let recovery;
  try {
    recovery = await planRecovery(options);
  } catch (error) {
    printRefusal({ action: null, error, startedAt });
    return;
  }
  if (options.dryRun) {
    printBlock(describeRecovery(recovery));
    return;
  }
  let facts;
  try {
    facts = await recoverFixture(recovery);
  } catch (error) {
    printRefusal({ action: null, error, startedAt });
    return;
  }
  printBlock(facts);
  if (facts.problems.length > 0) process.exitCode = 2;
}

async function main(argv) {
  const startedAt = Date.now();
  let options;
  try {
    options = parseLiveActionArguments(argv);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (options.recover) {
    await runRecovery(options, startedAt);
    return;
  }
  let plan;
  try {
    plan = await planLiveAction(options);
  } catch (error) {
    printBlock(
      refusedBlock({
        action: options.action,
        reasonCode: String(error?.message ?? error).slice(0, 300),
        detail: error?.detail,
        startedAt,
      }),
    );
    process.exitCode = 2;
    return;
  }
  if (options.dryRun) {
    printBlock(describePlan(plan));
    return;
  }
  announceStardewFixtureRoots(resolveStardewFixtureRoots({ env: process.env }));
  // Before the launch, not after: a reader has to be able to see what this run will exercise — and which world it will
  // be loaded from — while refusing it would still cost nothing.
  process.stderr.write(`[live-action] ${describeExercise(plan)} executor=${plan.executor.runnerFile}\n`);
  let outcome;
  try {
    outcome = await runLiveAction(plan);
  } catch (error) {
    // The pre-mutation guard (a game already running) refuses OUTSIDE the teardown, because there is nothing yet to
    // tear down. It still answers in the block shape rather than as a stack trace.
    printBlock(
      refusedBlock({
        action: plan.action,
        reasonCode: String(error?.message ?? error).slice(0, 300),
        detail: error?.detail,
        startedAt,
      }),
    );
    process.exitCode = 2;
    return;
  }
  const { block, failure } = outcome;
  printBlock(block);
  if (failure !== null) {
    process.stderr.write(`[live-action] refused: ${String(failure?.message ?? failure).slice(0, 300)}\n`);
    process.exitCode = 2;
    return;
  }
  if (block.state !== "passed") process.exitCode = 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
