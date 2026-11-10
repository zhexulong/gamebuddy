#!/usr/bin/env node
/**
 * One plan FORM, live: prepare the fixture world, launch the game, attach, submit exactly one script through the bridge
 * the way `stardew_plan_work` does, wait for it to settle, and print what became of every node beside a fresh
 * observation. Tens of seconds per subject instead of a whole run.
 *
 * WHY. An ACTION had a slice (`tools/live-action.mjs`, 26 s for `enter_exit`) and a plan FORM had none, so `for_each`
 * could only ever be exercised inside a multi-day run. Measured 2026-11-10 (`round42`, day 6): its row identity was wrong
 * for the entire run and surfaced only after 21 minutes, as eight identical rows. The fix (`3d249ff1`) is two words -
 * `row_target_identity_unavailable` (a family this pass cannot name a tile for) versus `row_target_absent` (the tile is
 * bare and the action is fine) - and a 40-second slice would have named the wrong one on the first submission. That is
 * the hole this closes: here the SUBJECT IS THE PROGRAM, and `--action` does not exist.
 *
 * IT OWNS NO MECHANISM OF ITS OWN. Every piece already exists and is used as it is:
 *   - `lib/stardew-native-local-player-fixture.mjs` - the fixture transaction: the world a fixture key selects, its
 *     action set, the deploy and the restore;
 *   - `lib/stardew-live-run.mjs` - the SMAPI launch, the pipe wait and the lane log;
 *   - `lib/stardew-native-smoke-harness-v1.mjs` - one connected session, the receipt buffer and the fresh re-read;
 *   - `live-action.mjs` - the plan/teardown half of the same slice (`teardown`, `restoreEnding`, `describeSaveAt`,
 *     `singleBinding`, `runFixtureSaveHarness`). Those facts are the FIXTURE's, not one action's, so they keep the one
 *     spelling they already had;
 *   - the Host's own compiled artifacts, `host/dist-test` - `compilePlanScript` + `planProgramId` (the compiler
 *     `stardew_plan_work` calls), `planBatchAnswer` + `waitForTerminalProgramStatus` (the readers that tool waits with),
 *     `bodyProgramPreflightRefusal` (the one implementation of "may this node be submitted") and the request validators.
 *     Nothing is re-implemented here, and the artifact-freshness gate refuses a stale build before a game is spawned.
 *
 * THE SUBMISSION IS THE PRODUCT'S OWN. `stardew_plan_work` does four things the tool reproduces in order, and each is a
 * place a slice can stop with a name instead of a surprise:
 *   1. compile the script against THIS world's snapshot and THIS connection's plan vocabulary
 *      (`planActionsFromRegistrations` over the live registrations, which include the Mod's plan forms);
 *   2. refuse a form the attached Mod does not publish, BEFORE the wire (`for_each_execution_unavailable`);
 *   3. refuse nodes the live catalogue does not offer (`bodyProgramPreflightRefusal` - `row_action_not_enabled` is the
 *      Mod's own word for a loop whose row names an action the policy does not offer);
 *   4. submit `{ programId, nodes }` and read the answer back through `program_status`.
 * The one thing it does NOT reproduce is the materializer's policy-identity assertion: that compares a mounted Host
 * policy to the connection, and a slice has no mount. It says so here rather than pretending to be a Host.
 *
 * A LOOP THAT CANNOT MATCH IS A MEASURED ANSWER, NOT A FAILED SLICE. The two shapes this exists for are `passed` (every
 * node succeeded) and `refused` (the program settled and a node ended with the Mod's own code, e.g.
 * `row_target_absent:water_crop:croptargets=2`). Both exit 0, because both measured something; the block carries the
 * population it measured (`population.families[].publishedBefore/publishedAfter` and the rows themselves), so
 * "the family published nothing" and "the family was never read" cannot print the same number. `blocked` - nothing
 * settled or nothing was submitted - exits 2.
 *
 * THE SETTLE IS BOUNDED, AND THE BOUND IS PRINTED. `--settle-ms` (default 120 s, at most 10 min) is THIS tool's budget;
 * each wait inside it is the Host's own `waitForTerminalProgramStatus` window (at most 30 s, its answer budget for a
 * model turn). A program still running when the budget is spent is `live_program_not_settled:<budget>` with every node's
 * live state beside it - never a pass, and never a silent extra minute.
 *
 * THE POST-STATE IS AN OBSERVATION. The block's `observation` is taken AFTER settlement, from the bridge, never from the
 * status payload's claim.
 *
 * USAGE
 *   node tools/live-program.mjs --scenario <fixture key> --script <path|inline> [options]
 *   node tools/live-program.mjs --scenario <fixture key> --script <path> --dry-run   # resolve and refuse; no game
 *   node tools/live-program.mjs --help
 *
 * REFUSES before any mutation (the fixture/root facts keep `live_action_*`, see above):
 *   live_action_transaction_live:<backupName>:<ownerId>   another fixture transaction holds this root
 *   live_action_game_already_running:<pids>               a Stardew/SMAPI process would share the one bridge pipe name
 *   live_action_working_save_present:<path>               an earlier run left this save behind; the game would load it
 *   live_action_binding_missing / _binding_ambiguous       the observed save slot cannot be derived from the root
 *   live_action_template_missing:<path>                   the read-only save template the working save is copied from
 *   live_program_no_fixture_scenario:<key>                no fixture world is armed by that key
 *   live_program_script_missing / _script_unreadable       no script was given, or the named file could not be read
 *
 * ENDINGS that are blocked rather than passed, because nothing was measured or the world would be left dirty:
 *   live_program_script_not_compiled:<reason>             the compiler refused the script; no plan exists to submit
 *   live_program_script_action_unavailable:<forms>        a plan form the attached Mod does not publish
 *   live_program_script_not_admitted:<refusal>            the live catalogue refuses a node (or a loop's row action)
 *   live_program_submit_refused:<code>                    the Mod refused the candidate; nothing of it is in the world
 *   live_program_protocol_invalid:<validator>             the wire answered something that is not a submit result
 *   live_program_world_not_actionable:<scenario>          a target exists and the actor still cannot act
 *   live_program_not_settled:<budgetMs>                   the program was still running when this tool's bound expired
 *   live_action_process_still_running:<pids>              a Stardew process this run started is still alive
 *   live_action_fixture_not_restored / _working_save_not_restored   the unwind could not finish
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadHostTestModule } from "./lib/host-test-module.mjs";
import { evidenceDetail } from "./lib/level-up-evidence.mjs";
import { installLiveRunInterrupt } from "./lib/live-run-teardown.mjs";
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
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { parseReceiptFields } from "./lib/stardew-receipt-evidence.mjs";
import { listStardewProcessIds } from "./lib/windows-process-tree.mjs";
import {
  describeSaveAt,
  readFixtureTransaction,
  reclaimGame,
  refusal,
  releaseFixture,
  requireAbsolute,
  restoreEnding,
  runFixtureSaveHarness,
  singleBinding,
  targetFieldFor,
  teardown,
} from "./live-action.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(TOOLS, "..");
const DEFAULT_GAME_INSTALL = "D:/Steam/steamapps/common/Stardew Valley";
const DEFAULT_RELEASE_DIR = "integrations/stardew/bin/Release/net6.0";
const WINDOW_MODES = Object.freeze(["visible", "foreground", "minimized", "hidden", "background"]);
/** The Host modules this slice reads: the compiler, its readers, the one admission decision and the wire validators. */
const HOST_MODULES = Object.freeze({
  script: "body-program-script.js",
  forEach: "body-program-for-each.js",
  status: "program-status-wait.js",
  preflight: "body-program-preflight.js",
  protocol: "protocol.js",
  bridge: "local-stardew-bridge.js",
  adapter: "stardew-game-integration-adapter.js",
});
/** How the Host bounds ONE program-status window (`program-status-wait.ts` MAX_PROGRAM_STATUS_WAIT_MS). */
const HOST_STATUS_WINDOW_MS = 30_000;
const DEFAULT_SETTLE_MS = 120_000;
const MAX_SETTLE_MS = 600_000;
const MAX_SCRIPT_CHARS_REPORTED = 2_000;
const MAX_ARGUMENT_CHARS_REPORTED = 400;
const MAX_EVIDENCE_CHARS = 300;
const MAX_ROWS_REPORTED = 16;
const MAX_REASON_CHARS_REPORTED = 600;
const NODE_SUCCEEDED = "succeeded";

export const USAGE = `usage: node tools/live-program.mjs --scenario <fixture key> --script <path|inline> [options]

  The subject is a PROGRAM, not an action: the script is compiled by the same compiler 'stardew_plan_work' calls and
  submitted through the same bridge request, then read back node by node.

  --scenario <key>           the fixture world to arm: the key 'fixtureActions'/'fixtureScenario' select from.
                             'water_crop' arms native_water_crop_v1 and its action set
  --script <path|inline>     the plan script. A value naming an existing file is read from disk; anything else is the
                             script itself
  --settle-ms <n>            how long the settled program gets, 1000..${String(MAX_SETTLE_MS)} (default ${String(DEFAULT_SETTLE_MS)}).
                             Each wait inside it is the Host's own ${String(HOST_STATUS_WINDOW_MS / 1_000)} s window
  --keep-log                 keep this run's SMAPI console log even when the run passes
  --dry-run                  resolve everything and refuse; print the plan; never spawn the game
  --fixture-root <dir>       fixture root (default: the lane's resolved stardew-fixtures root)
  --mods-path <dir>          mods root the game is launched against (default: <fixture-root>/mods)
  --release-dir <dir>        staged Mod bundle (default: ${DEFAULT_RELEASE_DIR})
  --game-path <dir>          game install (default: GAMEBUDDY_STARDEW_GAME_DIR or ${DEFAULT_GAME_INSTALL})
  --save-name <slot>         observed save slot (default: the fixture root's single binding)
  --window-mode <mode>       ${WINDOW_MODES.join("|")} (default: hidden)
  --timeout-seconds <n>      bridge pipe budget, 30..300 (default: 180)
  --help                     print this text

One bounded JSON block goes to stdout; progress and paths go to stderr.
Exit 0 when the program settled and every node answered (passed or refused by name), 2 when nothing was measured.`;

const FLAGS = Object.freeze(["--help", "-h", "--keep-log", "--dry-run"]);
const VALUE_FLAGS = Object.freeze([
  "--scenario",
  "--script",
  "--settle-ms",
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
 * Parse the CLI. Pure: every refusal here is an argument fact, so nothing is touched and no game is spawned.
 *
 * The dispatch is one named subject and not a boolean soup: this tool has no `--action` flag at all, and one passed by
 * habit is answered `invalid_argument:--action` rather than silently ignored.
 */
export function parseLiveProgramArguments(argv) {
  const options = {
    help: false,
    keepLog: false,
    dryRun: false,
    scenario: null,
    script: null,
    settleMs: DEFAULT_SETTLE_MS,
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
    if (!VALUE_FLAGS.includes(token)) throw refusal(`invalid_argument:${String(token)}`);
    if (seen.has(token)) throw refusal(`duplicated_argument:${token}`);
    seen.add(token);
    const value = argv[index + 1];
    if (value === undefined || (value.startsWith("--") && !value.includes(" ")))
      throw refusal(`invalid_argument_value:${token}`);
    index += 1;
    switch (token) {
      case "--scenario":
        if (!/^[a-z][a-z0-9_]{1,63}$/u.test(value)) throw refusal(`invalid_scenario:${value}`);
        options.scenario = value;
        break;
      case "--script":
        options.script = value;
        break;
      case "--settle-ms":
        options.settleMs = boundedInteger(value, 1_000, MAX_SETTLE_MS, "invalid_settle_ms");
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
        throw refusal(`invalid_argument:${token}`);
    }
  }
  if (options.help) return Object.freeze(options);
  if (options.scenario === null) throw refusal("missing_scenario");
  if (options.script === null) throw refusal("missing_script");
  return Object.freeze(options);
}

/**
 * The script, from a file or from the argument itself.
 *
 * ONE RULE, and the block says which arm produced it: a value that names a file which exists is a path, everything else
 * is the script. A value that is BOTH - a one-line script that happens to name a file - is read from the file, because
 * that is the case a caller is pointing at something with, and `script.path` in the block makes the choice visible.
 */
export function readProgramScript(value, { readFileSync: read = readFileSync } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) throw refusal("live_program_script_missing");
  const resolved = resolve(value);
  const isFile = !value.includes("\n") && existsSync(resolved) && statSync(resolved).isFile();
  if (!isFile) return Object.freeze({ source: value, path: null });
  let source;
  try {
    source = read(resolved, "utf8");
  } catch (error) {
    throw refusal(`live_program_script_unreadable:${resolved}`, error);
  }
  if (source.trim().length === 0) throw refusal(`live_program_script_unreadable:${resolved}:empty`);
  return Object.freeze({ source, path: resolved });
}

/**
 * Resolve and validate everything the run needs, touching the filesystem read-only.
 *
 * This is the whole of `--dry-run` and the guard the live form runs before its first mutation: a live transaction, a
 * running game, a missing binding, a world no fixture arms or a working save an earlier run left behind is refused HERE,
 * naming the fact, instead of after a 40-second boot.
 */
export async function planLiveProgram(options, { env = process.env, roots = null } = {}) {
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

  // The world this subject runs in, from the fixture's own key. `fixtureActions` throws for a key it has no world for,
  // and that name is the refusal - a caller told "no fixture" without the key they typed has to read the fixture module.
  let actions;
  try {
    actions = fixtureActionSet({ action: options.scenario });
  } catch (error) {
    throw refusal(`live_program_no_fixture_scenario:${options.scenario}`, error, { key: options.scenario });
  }
  const scenario = fixtureScenario(actions, options.scenario);
  const script = readProgramScript(options.script);

  const templatePath = join(fixtureRoot, "templates", saveName);
  if (!existsSync(templatePath)) throw refusal(`live_action_template_missing:${templatePath}`);

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
    template: describeSaveAt({ directory: templatePath, saveName }),
    workingSave,
    bindingPath,
    binding,
    stardewSaveRoot,
    clientConfigPath: join(modsPath, STARDEW_MOD_FOLDER, "config.json"),
    backupName: `native-local-program-${options.scenario.replaceAll("_", "-")}-fixture-backup`,
    scenarioKey: options.scenario,
    scenario,
    actions,
    script: script.source,
    scriptPath: script.path,
    settleMs: options.settleMs,
    windowMode: options.windowMode,
    timeoutSeconds: options.timeoutSeconds,
    keepLog: options.keepLog,
  });
}

/** What `--dry-run` prints: what the live form would do, where, and with what. */
export function describeProgramPlan(plan) {
  return {
    state: "planned",
    subject: "program",
    scenario: { key: plan.scenarioKey, scenario: plan.scenario, actions: plan.actions },
    script: { path: plan.scriptPath, chars: plan.script.length, source: bound(plan.script, MAX_SCRIPT_CHARS_REPORTED) },
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
    settleMs: plan.settleMs,
    windowMode: plan.windowMode,
    timeoutSeconds: plan.timeoutSeconds,
  };
}

function bound(text, limit) {
  if (typeof text !== "string") return null;
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * The Host modules this tool reads, loaded from the compiled test artifact.
 *
 * `loadHostTestModule` refuses an artifact older than the sources it was compiled from, which is the one thing that keeps
 * a slice from measuring the wrong compiler: a stale `body-program-script.js` would answer about a loop form this tree
 * no longer writes.
 */
export async function loadProgramHostModules({ load = loadHostTestModule } = {}) {
  const [script, forEach, status, preflight, protocol, bridge, adapter] = await Promise.all([
    load(HOST_MODULES.script),
    load(HOST_MODULES.forEach),
    load(HOST_MODULES.status),
    load(HOST_MODULES.preflight),
    load(HOST_MODULES.protocol),
    load(HOST_MODULES.bridge),
    load(HOST_MODULES.adapter),
  ]);
  return Object.freeze({ script, forEach, status, preflight, protocol, bridge, adapter });
}

/** The plan vocabulary this connection offers - the Host's own projection, not a list written here. */
export function planVocabulary(client) {
  return client.state?.catalogRegistrations ?? [];
}

/**
 * The actions this connection OFFERS, in one spelling: the adapter's own projection over the live registrations and the
 * policy's enabled ids - the same call the Host's preflight and its admission validator both make. A second derivation
 * here (say, the snapshot's `capabilities`) would let the slice refuse a node the Mod would have admitted.
 */
export function visibleActionIds(client, modules) {
  const state = client.state ?? {};
  return modules.adapter.STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog
    .visibleActions(state.catalogRegistrations ?? [], state.enabledActionIds ?? [])
    .map((action) => action.actionId);
}

/**
 * The Host's answer to ONE node's admission challenge, against the connection as it is now.
 *
 * THIS IS NOT OPTIONAL BOOKKEEPING. A program node is admitted by the Mod only after it challenges the Host, and the
 * bridge CLOSES when a challenge arrives with no handler bound (`local-stardew-bridge.ts` line 956 ->
 * `transport.close("body_node_admission_unavailable")`). Measured 2026-11-11, the first run of this tool: the loop was
 * submitted, the Mod sent the `n01` challenge, and 11 seconds later the block said `bridge_not_authenticated` with no
 * program answer at all.
 *
 * WHAT IS THE HOST'S, AND WHAT IS A SLICE'S. The decision itself is `bodyProgramNodeAdmissionRefusal`, the same function
 * the submission preflight asks - a form is admitted as a form and its ROW actions answer to the live policy. The
 * catalogue it judges against is the adapter's own projection over this connection's registrations and enabled ids. Three
 * things a mounted Host does are NOT done here, and each is stated instead of faked:
 *   - the policy identity is compared against the connection's own current identity, not against a retained mount policy
 *     (a slice has no mount);
 *   - the grant is minted in this process rather than durably journaled (`HostNodeAdmissionService` writes the exact
 *     tuple to the recovery journal before issuing it) - a slice runs one program and then unwinds, so it has no recovery
 *     to owe, and a journal written by a measurement tool would become authority it is not;
 *   - `executionBinding` is `null`, which is what the Host writes when a node's binding is unconditional.
 */
export function decideNodeAdmission({ client, modules, challenge, mintGrantId = () => `grant_${randomUUID()}` }) {
  const state = client.state ?? {};
  if (state.connected !== true)
    return Object.freeze({ ...challenge, result: "unavailable", code: "admission_unavailable:not_connected" });
  if (challenge.deadlineMs <= Date.now())
    return Object.freeze({ ...challenge, result: "rejected", code: "deadline_expired" });
  const registrations = state.catalogRegistrations ?? [];
  if (registrations.length === 0)
    return Object.freeze({ ...challenge, result: "unavailable", code: "admission_unavailable:no_registrations" });
  const refusal = modules.preflight.bodyProgramNodeAdmissionRefusal(challenge, {
    visibleActionIds: visibleActionIds(client, modules),
    registeredActionIds: registrations.map((registration) => registration.actionId),
  });
  if (refusal !== null) return Object.freeze({ ...challenge, result: "rejected", code: refusal });
  if (challenge.catalogRevision !== state.catalogRevision)
    return Object.freeze({ ...challenge, result: "rejected", code: "catalog_stale" });
  const identity = state.policyIdentity;
  if (
    identity === undefined ||
    challenge.policyIdentity?.value !== identity.value ||
    challenge.policyIdentity?.capabilityRevision !== identity.capabilityRevision
  )
    return Object.freeze({ ...challenge, result: "rejected", code: "policy_identity_mismatch" });
  return Object.freeze({
    ...challenge,
    result: "granted",
    grantId: mintGrantId(),
    attachmentGeneration: state.sessionId ?? "",
    policyRevision: identity.value,
    executionBinding: null,
  });
}

/** The handler the bridge is bound with, and the record of every answer it gave - the block prints them. */
export function createNodeAdmissionHandler({ client, modules, answers, mintGrantId }) {
  return (challenge) => {
    const result = decideNodeAdmission({ client, modules, challenge, mintGrantId });
    answers.push(
      Object.freeze({
        programId: challenge?.programId ?? null,
        nodeId: challenge?.nodeId ?? null,
        actionId: challenge?.actionId ?? null,
        result: result.result,
        ...(result.code === undefined ? {} : { code: result.code }),
      }),
    );
    return Promise.resolve(result);
  };
}

/**
 * Wait for the world to be able to act, then take the one observation the program is compiled against and judged after.
 *
 * The wait is the part every native-local runner already has: the bridge opens while the fixture's own `warpFarmer` fade
 * is still in flight, and a snapshot that reports `actionable: false` mid-transition is not a world that cannot act.
 */
export async function observeForProgram(client, { timeoutMs }) {
  const first = await observeFresh(client);
  try {
    return await waitForActionable(client, first, timeoutMs);
  } catch (error) {
    if (!(error instanceof Error && /^native_snapshot_not_actionable/u.test(error.message))) throw error;
    return first;
  }
}

/**
 * The whole of one submission, over ONE connected session: observe, compile, refuse what cannot be sent, submit, settle,
 * then read the world again.
 *
 * Split out of `runLiveProgram` because this is the half that can be driven without a game: the bridge is a boundary this
 * tool does not own, so a stub session and stub modules prove the order (compile against the observation, refuse a form
 * the Mod does not publish, submit once, judge on a read taken after it) without spawning SMAPI.
 */
export async function runOneProgram({ plan, session, modules, context = emptyContext() }) {
  const snapshotBefore = await observeForProgram(session.client, { timeoutMs: plan.settleMs });
  context.snapshotBefore = snapshotBefore;
  process.stderr.write(
    `[live-program] observed revision=${String(snapshotBefore.revision)} location=${String(snapshotBefore.location)} tile=${tileOf(snapshotBefore) ?? "?"} actionables=${String(snapshotBefore.actionable === true)}\n`,
  );
  const actions = modules.script.planActionsFromRegistrations(planVocabulary(session.client));
  const compiled = modules.script.compilePlanScript({ script: plan.script }, { snapshot: snapshotBefore, actions });
  context.compiled = compiled;
  if (!compiled.ok)
    throw refusal(`live_program_script_not_compiled:${compiled.reasonCode}`, undefined, {
      script: { path: plan.scriptPath, chars: plan.script.length },
      dropped: compiled.dropped,
      droppedCount: compiled.droppedCount,
      rejected: compiled.rejected,
      ...(compiled.threw === undefined ? {} : { threw: compiled.threw }),
      ...(compiled.reasonCode.startsWith("plan_script_unknown_action:")
        ? { legalActionIds: modules.script.legalPlanActionIds(actions) }
        : {}),
    });

  const nodes = compiled.program.nodes;
  const programId = modules.script.planProgramId(compiled.snapshotRevision, nodes);
  context.nodes = nodes;
  context.programId = programId;
  // A HOST PLAN FORM THE ATTACHED MOD DOES NOT PUBLISH CANNOT BE EXECUTED, and the Host says so before the wire. Derived
  // from `PLAN_FORM_ACTION_IDS` and the Mod's own registrations, so the day the Mod publishes the form this answers empty.
  const published = new Set(actions.map((action) => action.actionId));
  const unavailable = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => modules.script.PLAN_FORM_ACTION_IDS.includes(node.actionId) && !published.has(node.actionId))
    .map(({ node, index }) => ({
      index,
      actionId: node.actionId,
      reasonCode: modules.forEach.planFormExecutionUnavailableReason(node.actionId),
    }));
  if (unavailable.length > 0)
    throw refusal(`live_program_script_action_unavailable:${unavailable[0].reasonCode}`, undefined, {
      programId,
      unavailable,
    });

  // ONE admission decision, the Host's own implementation of it: `row_action_not_enabled` is the Mod's word for a loop
  // whose row names an action the live policy does not offer, which is exactly "this world cannot carry this script".
  const offered = visibleActionIds(session.client, modules);
  const refusalText = modules.preflight.bodyProgramPreflightRefusal(nodes, {
    visibleActionIds: offered,
    registeredActionIds: planVocabulary(session.client).map((registration) => registration.actionId),
  });
  if (refusalText !== null)
    throw refusal(`live_program_script_not_admitted:${refusalText}`, undefined, {
      programId,
      publishedActions: plan.actions,
      offeredActions: offered,
    });

  if (snapshotBefore.actionable !== true || snapshotBefore.activeExecution != null)
    throw refusal(`live_program_world_not_actionable:${plan.scenario}`, undefined, {
      revision: snapshotBefore.revision,
      activeExecution: snapshotBefore.activeExecution ?? null,
    });

  const request = { programId, nodes };
  const invalid = modules.protocol.validateBodyProgramCandidateRequest(request);
  if (invalid !== null) throw refusal(`live_program_protocol_invalid:candidate:${invalid}`, undefined, { programId });
  // BOUND BEFORE THE SUBMISSION, because the Mod challenges the Host the moment it starts admitting the first node and
  // closes the pipe when nothing answers (see `decideNodeAdmission`).
  const answers = context.admission;
  modules.bridge.bindLocalStardewBridgeBodyNodeAdmission(
    session.client,
    createNodeAdmissionHandler({ client: session.client, modules, answers }),
  );
  const submitted = await session.client.programSubmit(request);
  context.submitted = submitted;
  const invalidResult = modules.protocol.validateBodyProgramSubmitResult(submitted);
  if (invalidResult !== null)
    throw refusal(`live_program_protocol_invalid:submit_result:${invalidResult}`, undefined, { programId });
  const code = submitted.code;
  if (code !== "accepted" && code !== "idempotent")
    throw refusal(`live_program_submit_refused:${code}`, undefined, {
      programId,
      verification: submitted.verification,
      compiler: compilerAccount(compiled),
    });

  const readStatus = () => session.client.programStatus({ programId });
  const settled = await awaitProgramSettlement({
    readStatus,
    first: submitted,
    budgetMs: plan.settleMs,
    isTerminal: modules.status.isTerminalProgramStatus,
    waitForTerminal: modules.status.waitForTerminalProgramStatus,
  });
  // An observation, never the status payload's claim: the bridge is asked what the world looks like NOW.
  const observation = await observeFresh(session.client);
  context.observation = observation;
  context.settled = settled;
  context.receipts = [...session.receipts];
  return context;
}

/** The facts a run collects as it goes, so a refusal half-way still prints the world it refused in. */
export function emptyContext() {
  return {
    snapshotBefore: null,
    observation: null,
    compiled: null,
    nodes: null,
    programId: null,
    submitted: null,
    settled: null,
    receipts: [],
    admission: [],
  };
}

/**
 * The compiler's account of the author's own calls - what became of each one.
 *
 * The four lists PARTITION the calls she wrote (`acceptedSteps`, `merged`, `noStepNeeded`, `dropped`), and their counts
 * are unbounded while the lists are not. `inserted` is the fifth, opposite fact: nodes the compiler wrote that she did
 * not. A slice that printed only the node list would show a program disagreeing with the script for no stated reason.
 */
export function compilerAccount(compiled) {
  if (compiled?.ok !== true) {
    return {
      accepted: false,
      reasonCode: compiled?.reasonCode ?? null,
      dropped: compiled?.dropped ?? [],
      droppedCount: compiled?.droppedCount ?? 0,
      rejected: compiled?.rejected ?? [],
      acceptedSteps: compiled?.acceptedSteps ?? [],
      acceptedStepsCount: compiled?.acceptedStepsCount ?? 0,
      merged: compiled?.merged ?? [],
      mergedCount: compiled?.mergedCount ?? 0,
      noStepNeeded: compiled?.noStepNeeded ?? [],
      noStepNeededCount: compiled?.noStepNeededCount ?? 0,
    };
  }
  return {
    accepted: true,
    snapshotRevision: compiled.snapshotRevision,
    inserted: compiled.inserted,
    insertedCount: compiled.insertedCount,
    acceptedSteps: compiled.acceptedSteps,
    acceptedStepsCount: compiled.acceptedStepsCount,
    merged: compiled.merged,
    mergedCount: compiled.mergedCount,
    noStepNeeded: compiled.noStepNeeded,
    noStepNeededCount: compiled.noStepNeededCount,
    dropped: compiled.dropped,
    droppedCount: compiled.droppedCount,
    droppedTruncated: compiled.droppedCount > compiled.dropped.length,
    layoutFactsAbsent: compiled.layoutFactsAbsent,
    layoutFactsAbsentCount: compiled.layoutFactsAbsentCount,
  };
}

/**
 * Wait for the program to stop, in the Host's own windows, until THIS tool's budget is spent.
 *
 * Why a loop and not one call: `waitForTerminalProgramStatus` bounds each window at `MAX_PROGRAM_STATUS_WAIT_MS` (30 s,
 * the Host's answer budget for a model turn) while a slice's subject may legitimately be a pass over 30 tiles. The
 * budget here is the slice's; each read inside it is still the Host's own reader, so a slice cannot learn anything a
 * `stardew_action_program_status` call would not have told it.
 *
 * A window that saw NO change and has nothing in flight ends the wait early - that is the Host's own rule for "news that
 * cannot arrive", and re-entering the loop after it would spend the rest of the budget on silence.
 */
export async function awaitProgramSettlement({
  readStatus,
  first,
  budgetMs,
  isTerminal,
  waitForTerminal,
  windowMs = HOST_STATUS_WINDOW_MS,
}) {
  const startedAt = Date.now();
  const spent = () => Date.now() - startedAt;
  let latest = first;
  let reachedTerminal = isTerminal(latest) === true;
  let windows = 0;
  let unchanged = false;
  while (!reachedTerminal) {
    const remaining = budgetMs - spent();
    if (remaining <= 0) break;
    windows += 1;
    const waited = await waitForTerminal(readStatus, latest, Math.min(windowMs, remaining));
    latest = waited.result;
    reachedTerminal = waited.waited.terminality === "terminal" || isTerminal(latest) === true;
    unchanged = waited.waited.snapshotChanged !== true;
    if (!reachedTerminal && unchanged) break;
  }
  return Object.freeze({ result: latest, reachedTerminal, unchanged, windows, elapsedMs: spent(), budgetMs });
}

/** The fields a node is identified by, bounded: what ran, and the arguments it was compiled with. */
export function programNodes(nodes) {
  if (!Array.isArray(nodes)) return null;
  return nodes.map((node) => ({
    nodeId: node.nodeId,
    actionId: node.actionId,
    arguments: bound(JSON.stringify(node.arguments ?? {}), MAX_ARGUMENT_CHARS_REPORTED),
  }));
}

/**
 * The families this program's loops read, as the SNAPSHOT spells them.
 *
 * Derived from the compiled nodes, never from the script's text: a `for_each` source that names a family is that family,
 * and a row action's target family is what `cropTargets` publishes (the same map `live-action` asks for its own target
 * question). Two spellings of one family is how a reader ends up comparing `croptargets` to `cropTargets`.
 */
export function programFamilies(nodes, planFormActionIds) {
  const families = new Map();
  const record = (field, actionId) => {
    if (typeof field !== "string" || field.length === 0) return;
    const existing = families.get(field);
    if (existing === undefined) families.set(field, { field, actionIds: actionId === null ? [] : [actionId] });
    else if (actionId !== null && !existing.actionIds.includes(actionId)) existing.actionIds.push(actionId);
  };
  for (const node of nodes) {
    if (!planFormActionIds.includes(node.actionId)) continue;
    const loop = node.arguments?.loop;
    const source = loop?.source;
    if (source !== undefined && typeof source.family === "string") record(source.family, null);
    // Both spellings of a loop's rules, as `forEachRules` reads them: a single `do`, or a `then` list.
    const rules = [];
    if (Array.isArray(loop?.then)) rules.push(...loop.then);
    else if (loop?.do !== undefined) rules.push({ do: loop.do });
    for (const rule of rules) {
      const actionId = rule?.do?.action;
      if (typeof actionId === "string") record(targetFieldFor(actionId), actionId);
    }
  }
  return [...families.values()];
}

/** What one observation says about the families this program reads: the population it measured. */
export function familyPopulation(snapshot, families) {
  if (snapshot === null || snapshot === undefined) return null;
  return families.map((entry) => {
    const rows = snapshot[entry.field];
    return {
      field: entry.field,
      actionIds: entry.actionIds,
      measured: Array.isArray(rows),
      published: Array.isArray(rows) ? rows.length : null,
      rows: Array.isArray(rows)
        ? rows.slice(0, 5).map((row) => ({
            targetId: typeof row?.targetId === "string" ? row.targetId : null,
            x: Number.isInteger(row?.x) ? row.x : null,
            y: Number.isInteger(row?.y) ? row.y : null,
          }))
        : [],
    };
  });
}

/**
 * THE ROW RECEIPTS: what each row of a loop actually did, from the engine's own terminal receipts.
 *
 * This is the half a successful pass cannot answer any other way. The Mod keeps a pass's aggregate in the node's
 * EVIDENCE and its counts in the node's HINT, and `OpenBodyProgramJournalAuthority` writes BOTH as null on a Succeeded
 * node (`Hint = result.Outcome is Failed or Cancelled ? result.Hint : null`, with the same rule for the reason detail),
 * while `BridgeSession.NodeStatus` does not project the evidence at all. So `program_status` can say a loop succeeded
 * but never how many rows it ran - measured 2026-11-11 on the matching shape below, where every node was `succeeded` and
 * the wire carried no count anywhere.
 *
 * The receipts do carry it, one per dispatched row, in the same buffer `live-action` reads: a row that RAN minted a
 * receipt for the row's action id, and a row refused before dispatch (the `row_target_absent` shape) minted none. The
 * two shapes are therefore complementary and both measured, never assumed.
 */
export function describeRowReceipts({ receipts, actionIds }) {
  const wanted = new Set(actionIds);
  const rows = receipts.filter((receipt) => wanted.has(receipt?.actionId));
  const terminal = rows.filter((receipt) => TERMINAL_STATES.has(receipt.state));
  const byState = {};
  for (const receipt of terminal) byState[receipt.state] = (byState[receipt.state] ?? 0) + 1;
  return {
    actionIds: [...wanted],
    terminal: terminal.length,
    dispatched: rows.length,
    byState,
    receipts: terminal.slice(0, MAX_ROWS_REPORTED).map((receipt) => {
      const fields = parseReceiptFields(evidenceDetail(receipt.evidence));
      return {
        actionId: receipt.actionId,
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        revision: Number.isInteger(receipt.revision) ? receipt.revision : null,
        target: fields?.get("target") ?? fields?.get("target_id") ?? null,
        tile: fields?.get("tile") ?? null,
        evidence: bound(evidenceDetail(receipt.evidence), MAX_EVIDENCE_CHARS),
      };
    }),
  };
}

/** The engine's own post-state: an observation, never the status payload's claim. */
function tileOf(snapshot) {
  return Number.isInteger(snapshot?.tile?.x) && Number.isInteger(snapshot?.tile?.y)
    ? `${snapshot.tile.x},${snapshot.tile.y}`
    : null;
}

function observationProjection(snapshot) {
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
    // The doors this location has, because a form run from inside a building cannot reach the world the loop names:
    // `travel` takes the warp's SOURCE tile, and this is where that tile comes from.
    warps: Array.isArray(snapshot.warps)
      ? snapshot.warps.slice(0, 8).map((warp) => ({
          sourceX: Number.isInteger(warp?.sourceX) ? warp.sourceX : null,
          sourceY: Number.isInteger(warp?.sourceY) ? warp.sourceY : null,
          targetLocation: typeof warp?.targetLocation === "string" ? warp.targetLocation : null,
        }))
      : null,
  };
}

/**
 * The verdict, from the statements the Mod made about THIS program's nodes.
 *
 * Three states, and the difference is what a reader has to act on: `passed` (every node succeeded), `refused` (the
 * program settled and a node ended with the Mod's own code - a measured answer, which is the whole point of a slice) and
 * `blocked` (nothing settled, or nothing was submitted at all). Exit 0 covers the first two; only `blocked` is a failed
 * slice.
 */
export function programVerdict({ answer, settled }) {
  const blockers = [];
  if (settled?.reachedTerminal !== true) blockers.push(`live_program_not_settled:${String(settled?.budgetMs ?? 0)}`);
  const rows = answer?.nodes ?? [];
  const undecided = rows.filter((row) => typeof row.state !== "string" || row.state === "unknown");
  for (const row of undecided) blockers.push(`node_state_unreadable:${row.actionId}:${String(row.index)}`);
  const stopped = rows.filter((row) => row.state !== NODE_SUCCEEDED && row.state !== "unknown");
  let state = "passed";
  if (blockers.length > 0) state = "blocked";
  else if (stopped.length > 0) state = "refused";
  return { state, blockers, stopped };
}

/**
 * One bounded block: the verdict plus every fact the slice owes, in one object.
 *
 * Exported because the block IS the tool's product: a refusal's shape is as much a contract as `USAGE`, and what a
 * reader needs beside a refusal is the population it measured - `published: 0` for a family that really published
 * nothing, `null` for a family nobody read.
 */
export function buildProgramBlock({
  plan,
  state,
  reasonCode,
  detail,
  compiled,
  nodes,
  programId,
  submitted,
  settled,
  answer,
  admission,
  families,
  rows,
  snapshotBefore,
  observation,
  restore,
  blockers,
  startedAt,
}) {
  return {
    state,
    reasonCode,
    ...(detail === undefined ? {} : { detail }),
    subject: "program",
    scenario: { key: plan.scenarioKey, scenario: plan.scenario, actions: plan.actions },
    script: { path: plan.scriptPath, chars: plan.script.length, source: bound(plan.script, MAX_SCRIPT_CHARS_REPORTED) },
    program: { programId: programId ?? null, nodes: programNodes(nodes) },
    compiler: compiled === undefined || compiled === null ? null : compilerAccount(compiled),
    submit:
      submitted === undefined || submitted === null
        ? null
        : {
            code: submitted.code ?? null,
            verification: submitted.verification ?? null,
            snapshotState: submitted.snapshot?.state ?? null,
          },
    settle:
      settled === undefined || settled === null
        ? null
        : {
            budgetMs: settled.budgetMs,
            elapsedMs: settled.elapsedMs,
            windows: settled.windows,
            reachedTerminal: settled.reachedTerminal,
            unchangedWhileWaiting: settled.unchanged,
          },
    answer: answer ?? null,
    // Every admission challenge this run ANSWERED. A program node cannot start without one, so an empty list beside a
    // running program is itself a fact - it would mean the Mod admitted the node without asking the Host.
    admission: { answered: admission ?? [] },
    rows: rows ?? null,
    // WHAT THE WORLDS SAID, before and after: the count is null unless an observation was read, so an empty family
    // cannot be reported as `0` by a run that never looked.
    population: {
      measured: snapshotBefore !== null && snapshotBefore !== undefined,
      families:
        families.length === 0
          ? []
          : families.map((entry) => ({
              field: entry.field,
              actionIds: entry.actionIds,
              before: familyPopulation(snapshotBefore, [entry])?.[0] ?? null,
              after: familyPopulation(observation, [entry])?.[0] ?? null,
            })),
    },
    observation: observationProjection(observation),
    restore,
    blockers: blockers ?? [],
    durationMs: Date.now() - startedAt,
  };
}

/**
 * The sentence a refusal block owes for the codes whose meaning is "not measured, and here is why".
 *
 * A bare code invites the next reader to read its absence as a pass, and these four are exactly the cases where nothing
 * was exercised.
 */
export function refusalNote(reasonCode) {
  if (reasonCode.startsWith("live_program_script_not_compiled:"))
    return "not measured: the compiler refused the script, so no program existed to submit. `compiler.dropped` names every call that will not run and `compiler.rejected` names the arguments each one omitted";
  if (reasonCode.startsWith("live_program_script_action_unavailable:"))
    return "not measured: this script carries a plan form the attached Mod does not publish, so the Host would never send it. `detail.unavailable` names the node and the reason; the fix is the Mod's catalogue, not the script";
  if (reasonCode.startsWith("live_program_script_not_admitted:"))
    return "not measured: the live catalogue refuses a node of this script - for a loop, `row_action_not_enabled` is the Mod's own word for a row whose action this world's policy does not offer. `detail.observedCapabilities` is what the world DOES offer";
  if (reasonCode.startsWith("live_program_submit_refused:"))
    return "not measured: the Mod refused the candidate as a whole, so nothing of it is in the world. `detail.verification` is the Mod's own diagnostic list";
  if (reasonCode.startsWith("live_program_not_settled:"))
    return "measured only in part: the program was still running when this tool's bound expired, so `answer.nodes` is what the journal said at that moment, not a settlement. Re-run with a larger --settle-ms";
  if (reasonCode.startsWith("live_action_working_save_present:"))
    return "not measured: an earlier run left this working save behind, and the game would load that world instead of the fixture's. Nothing was mutated and no game was launched. Clear it with `node tools/live-action.mjs --recover` (which refuses while a game is running)";
  return undefined;
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
 * The whole live transaction. A run-time failure does not throw: it still owes its teardown and its block, and `restore`
 * says what the teardown actually managed.
 */
export async function runLiveProgram(plan, { modules = null } = {}) {
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

  const loaded = modules ?? (await loadProgramHostModules());
  let outcome = emptyContext();
  let failure = null;
  let trap = null;
  let restore = { fixtureRestored: false, saveRestored: false };

  try {
    // The fixture's own gate first: it MOVES a leftover working save aside rather than deleting it, asserts the template
    // and the calendar, and refuses a live transaction - before anything here has been written.
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

    const config = JSON.parse(await readFile(plan.clientConfigPath, "utf8"));
    stage.logPath = join(plan.fixtureRoot, "logs", `live-program-${plan.scenarioKey}-${startedAt}.log`);
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
    outcome = await runOneProgram({ plan, session: stage.session, modules: loaded, context: outcome });
  } catch (error) {
    failure = error;
  } finally {
    restore = await teardown({ plan, stage, trap });
  }

  const families = programFamilies(outcome.nodes ?? [], loaded.script.PLAN_FORM_ACTION_IDS);
  const rowActions = families.flatMap((family) => family.actionIds);
  const rows = describeRowReceipts({ receipts: outcome.receipts, actionIds: rowActions });
  // A teardown that could not finish OUTRANKS the program's own verdict: a live process or a dirty save is what the next
  // slice meets, whatever this one achieved inside it.
  const ending = restoreEnding(restore);
  if (failure !== null) {
    const block = buildProgramBlock({
      plan,
      state: "blocked",
      reasonCode: ending ?? String(failure?.message ?? failure).slice(0, MAX_REASON_CHARS_REPORTED),
      ...(failure?.detail === undefined ? {} : { detail: failure.detail }),
      compiled: outcome.compiled,
      nodes: outcome.nodes,
      programId: outcome.programId,
      submitted: outcome.submitted,
      settled: outcome.settled,
      answer: null,
      admission: outcome.admission,
      families,
      rows,
      snapshotBefore: outcome.snapshotBefore,
      observation: outcome.observation ?? outcome.snapshotBefore,
      restore,
      startedAt,
    });
    return { block, failure };
  }

  const { submitted, settled, compiled, nodes, programId, snapshotBefore, observation, admission } = outcome;
  // The batch statement AND every node's own row, from the readers `stardew_plan_work` answers with: a slice that
  // invented its own node table would be a second authority for what a node state means.
  const answer = loaded.status.planBatchAnswer(nodes, settled.result.snapshot, []);
  const verdict = programVerdict({ answer, settled });
  const stopped = verdict.stopped[0];
  // The reason the block names: the teardown's own ending outranks everything, then the first node that did not succeed,
  // and only then the batch statement.
  let reasonCode = `live_program_node_state:${stopped?.state ?? "settled"}`;
  if (verdict.state === "passed") reasonCode = "live_program_settled:every_node_succeeded";
  else if (verdict.state === "blocked") reasonCode = verdict.blockers[0];
  else if (stopped?.reasonCode !== undefined) reasonCode = stopped.reasonCode;
  if (ending !== null) reasonCode = ending;
  const block = buildProgramBlock({
    plan,
    state: ending === null ? verdict.state : "blocked",
    reasonCode,
    ...(stopped === undefined || stopped.reasonDetail === undefined
      ? {}
      : { detail: { node: stopped.actionId, index: stopped.index, reasonDetail: stopped.reasonDetail } }),
    compiled,
    nodes,
    programId,
    submitted,
    settled,
    answer,
    admission,
    families,
    rows,
    snapshotBefore,
    observation,
    restore,
    blockers: ending === null ? verdict.blockers : [...verdict.blockers, ending],
    startedAt,
  });
  return { block, failure: null };
}

function printBlock(block) {
  process.stdout.write(`${JSON.stringify(block, null, 2)}\n`);
}

/** The block a refusal prints: the code, whatever measured state came with it, and the sentence that code owes. */
function refusedBlock({ plan, reasonCode, detail, startedAt }) {
  const note = refusalNote(reasonCode);
  return {
    state: "blocked",
    reasonCode,
    ...(detail === undefined ? {} : { detail }),
    subject: "program",
    scenario: plan === null ? null : { key: plan.scenarioKey, scenario: plan.scenario, actions: plan.actions },
    ...(note === undefined ? {} : { note }),
    restore: {
      fixtureRestored: false,
      saveRestored: false,
      note: "nothing was mutated: the plan refused before any fixture operation",
    },
    durationMs: Date.now() - startedAt,
  };
}

function printRefusal({ plan, error, startedAt }) {
  printBlock(
    refusedBlock({
      plan: plan ?? null,
      reasonCode: String(error?.message ?? error).slice(0, MAX_REASON_CHARS_REPORTED),
      detail: error?.detail,
      startedAt,
    }),
  );
  process.exitCode = 2;
}

/** The one line printed before a launch: what this run will exercise, and which world it will be loaded from. */
function describeExercise(plan) {
  return [
    "exercising",
    "subject=program",
    `scenario=${plan.scenarioKey}(${plan.scenario.length === 0 ? "(ordinary-world)" : plan.scenario})`,
    `actions=${plan.actions.join(",")}`,
    `script=${plan.scriptPath === null ? `inline(${String(plan.script.length)} chars)` : `${plan.scriptPath}(${String(plan.script.length)} chars)`}`,
    `settle=${String(plan.settleMs)}ms`,
    `save=${plan.workingSave.path}(${plan.workingSave.present ? "present" : "absent"})`,
    `template=${plan.templatePath}(mtime=${String(plan.template.mtime)})`,
  ].join(" ");
}

async function main(argv) {
  const startedAt = Date.now();
  let options;
  try {
    options = parseLiveProgramArguments(argv);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  let plan;
  try {
    plan = await planLiveProgram(options);
  } catch (error) {
    printRefusal({ plan: null, error, startedAt });
    return;
  }
  if (options.dryRun) {
    printBlock(describeProgramPlan(plan));
    return;
  }
  announceStardewFixtureRoots(resolveStardewFixtureRoots({ env: process.env }));
  process.stderr.write(`[live-program] ${describeExercise(plan)}\n`);
  let outcome;
  try {
    outcome = await runLiveProgram(plan);
  } catch (error) {
    printRefusal({ plan, error, startedAt });
    return;
  }
  printBlock(outcome.block);
  if (outcome.failure !== null) {
    process.stderr.write(`[live-program] refused: ${String(outcome.failure?.message ?? outcome.failure)}\n`);
    process.exitCode = 2;
    return;
  }
  if (outcome.block.state === "blocked") process.exitCode = 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
