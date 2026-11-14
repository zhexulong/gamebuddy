#!/usr/bin/env node
/**
 * ONE action slice, driven by a contract instead of a file.
 *
 * WHY. `tools/run-stardew-native-local-player-*-smoke.mjs` is 126 files and 5 clone groups: the fixture-config
 * refusal, the `?? []` snapshot projection, the `key=value` evidence parse, the requestId mint and the
 * `import.meta.main` bootstrap are repeated in every one of them, and the part that differs is data - one
 * discovery field, one argument object, one terminal state with a few evidence words, one stale re-send. This CLI is
 * the engine for that data; the contract format and its rules live in
 * `tools/lib/stardew-action-smoke-contract.mjs`.
 *
 * WHAT IT OWNS. Exactly three things: one discovery, one execution frame, one judgement. Everything else is the
 * launcher's, imported rather than re-implemented, so a fixture or a launch cannot drift between the two entry
 * points:
 *   - `lib/stardew-native-local-player-fixture.mjs`   the fixture transaction (prepare, verify, restore);
 *   - `lib/stardew-live-run.mjs`                      the SMAPI launch, the pipe wait and the lane log;
 *   - `lib/stardew-native-smoke-harness-v1.mjs`       one connected session, the receipt buffer, the fresh re-read;
 *   - `tools/live-action.mjs`                         the working-save harness, the teardown and its ending;
 *   - `lib/stardew-action-smoke-contract.mjs`         what a contract may say, and the five facts it may not repeat.
 *
 * USAGE
 *   node tools/run-native-action-slice.mjs --contract contracts/smoke/accept_daily_quest.json [--evidence <path>]
 *   node tools/run-native-action-slice.mjs --action <id> --args '<json>' [--expect <reasonCode>]
 *   node tools/run-native-action-slice.mjs --contract <path> --dry-run     # derive and refuse; never spawns a game
 *   node tools/run-native-action-slice.mjs --client-config <path>          # one frame against a running world
 *
 * `--dry-run` and `--client-config` are the two halves of the live form: the first proves what the contract derives
 * and what it refuses, the second is the same engine driven by a launcher that already owns a world.
 *
 * THE VERDICT IS A CONTRACT'S, NOT A RECEIPT'S. A `succeeded` terminal is one check of several: the reason code must
 * be the one the action's declaration names, every evidence expectation must hold on the receipt's own `key=value`
 * detail, every world-after assertion must hold on a FRESH observation read after the terminal, and - where the
 * contract declares one - the same request re-sent with a target that has just been consumed must be refused by one
 * of the named codes. A check that could not be looked at is `not_checked`, and `not_checked` fails the run.
 *
 * REFUSES before any mutation, each naming its own fact:
 *   slice_fixture_override_disagrees:<given>:<derived>     --fixture names a world the action's declaration does not
 *   slice_contract_missing                                 no --contract and no --action
 *   slice_evidence_path_required                           a live run with no --evidence has nowhere to write its bundle
 *   smoke_contract_*                                       the contract format's own refusals
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHostTestModule } from "./lib/host-test-module.mjs";
import { installLiveRunInterrupt } from "./lib/live-run-teardown.mjs";
import {
  adHocContract,
  deriveActionFacts,
  loadSmokeContractFile,
  readActionSurface,
  readProtocolControls,
  SMOKE_CONTRACT_SCHEMA,
} from "./lib/stardew-action-smoke-contract.mjs";
import { announceStardewFixtureRoots, resolveStardewFixtureRoots } from "./lib/stardew-fixture-roots.mjs";
import { gameStardewSaveRoot } from "./lib/stardew-lane-scope.mjs";
import { launchStardewLiveRun } from "./lib/stardew-live-run.mjs";
import { STARDEW_MOD_FOLDER } from "./lib/stardew-mod-folder.mjs";
import {
  prepareNativeLocalPlayerFixture,
  validateNativeLocalPlayerFixturePreparation,
} from "./lib/stardew-native-local-player-fixture.mjs";
import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  summarizeReceipt,
  waitForActionable,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { parseReceiptFields } from "./lib/stardew-receipt-evidence.mjs";
import {
  readFixtureTransaction,
  releaseFixture,
  requireAbsolute,
  restoreEnding,
  runFixtureSaveHarness,
  singleBinding,
  teardown,
} from "./live-action.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(TOOLS, "..");
const TOPOLOGY = "native_local_player_fixture";
const DEFAULT_GAME_INSTALL = "D:/Steam/steamapps/common/Stardew Valley";
const DEFAULT_RELEASE_DIR = "integrations/stardew/bin/Release/net6.0";
/** The evidence bundle a promoted action carries; this CLI writes the same shape around its own run object. */
const EVIDENCE_SCHEMA = "gamebuddy-stardew-native-local-live-run-evidence/v1";
const MAX_REASON_CHARS = 300;

export const USAGE = `usage: node tools/run-native-action-slice.mjs --contract <path> [options]
       node tools/run-native-action-slice.mjs --action <id> --args '<json>' [--expect <reasonCode>] [options]

  --contract <path>        one stardew-action-smoke-contract/v1 file (the table row for this action)
  --action <id>            ad-hoc slice: the declaration answers the terminal, --args carries the request
  --args <json>            the request arguments (required with --action; overrides a contract's template)
  --expect <reasonCode>    the success word, only where the declaration is generic (native_action_postcondition)
  --fixture <scenario>     assert the scenario the action derives; a disagreement is refused
  --evidence <path>        where the live run's evidence bundle is written
  --client-config <path>   drive one frame against an already-running world instead of launching one
  --terminal-timeout <ms>  how long to wait for the terminal receipt (default 5000)
  --dry-run                derive, validate and print; never spawns the game`;

class SliceRefusal extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.name = "SliceRefusal";
    this.code = code;
  }
}

const refuse = (code, detail) => {
  throw new SliceRefusal(code, detail);
};
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** The CLI's arguments, or a refusal naming the flag. */
export function parseSliceArguments(argv) {
  const options = {
    contractPath: null,
    action: null,
    args: null,
    expectReasonCode: null,
    fixture: null,
    evidencePath: null,
    clientConfig: null,
    terminalTimeoutMs: 5_000,
    dryRun: false,
    keepLog: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) refuse(`slice_argument_value_missing:${flag}`);
      index += 1;
      return next;
    };
    if (flag === "--contract") options.contractPath = value();
    else if (flag === "--action") options.action = value();
    else if (flag === "--args") options.args = value();
    else if (flag === "--expect") options.expectReasonCode = value();
    else if (flag === "--fixture") options.fixture = value();
    else if (flag === "--evidence") options.evidencePath = value();
    else if (flag === "--client-config") options.clientConfig = value();
    else if (flag === "--terminal-timeout") options.terminalTimeoutMs = Number(value());
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--keep-log") options.keepLog = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else refuse(`slice_argument_unknown:${flag}`);
  }
  if (
    !Number.isInteger(options.terminalTimeoutMs) ||
    options.terminalTimeoutMs < 100 ||
    options.terminalTimeoutMs > 600_000
  )
    refuse(`slice_terminal_timeout_invalid:${String(options.terminalTimeoutMs)}`);
  return Object.freeze(options);
}

/**
 * The contract this invocation stands for, from a file or from `--action`, with the `--fixture` assertion applied.
 *
 * The fixture scenario is not a caller's choice: it is `fixtureScenario(fixtureActions(action), action)`, the same
 * selector the launcher uses to arm the world. `--fixture` therefore ASSERTS rather than overrides - a run told to
 * arm one world and deriving another would fail at the fixture's own verifier with a code that names nothing.
 */
export function resolveContract(options, { surface = null, protocolControls = null } = {}) {
  let contract;
  if (options.contractPath !== null) {
    if (options.args !== null) refuse("slice_args_with_contract", "--args belongs to --action mode");
    contract = loadSmokeContractFile(options.contractPath, { surface, protocolControls });
  } else if (options.action !== null) {
    if (options.args === null) refuse("slice_args_required", "--action needs --args");
    let parsed;
    try {
      parsed = JSON.parse(options.args);
    } catch (error) {
      refuse("slice_args_unreadable", String(error?.message ?? error).slice(0, 160));
    }
    if (!isPlainObject(parsed)) refuse("slice_args_not_object");
    if (options.fixture !== null)
      refuse("slice_fixture_override_disagrees:--fixture_is_contract_only", options.fixture);
    contract = adHocContract(
      { action: options.action, args: parsed, expectReasonCode: options.expectReasonCode },
      { surface, protocolControls },
    );
  } else {
    refuse("slice_contract_missing", "pass --contract <path> or --action <id> --args '<json>'");
  }
  if (options.fixture !== null && options.fixture !== contract.derived.fixtureScenario)
    refuse("slice_fixture_override_disagrees", `${options.fixture}:${contract.derived.fixtureScenario}`);
  return contract;
}

/**
 * The one target this contract names, from the one projection the declaration publishes.
 *
 * Four outcomes are four facts and they are named: a surface that does not carry the field at all
 * (`slice_discovery_surface_absent`), a row count the contract did not ask for (`slice_declared_given_absent`), and
 * the chosen row. Selecting among several is only what a contract that says `at_least_one` asked for.
 */
export function chooseTarget(snapshot, contract) {
  if (contract.discovery === null) return { rows: null, chosen: null, source: null };
  const source = contract.discovery.source;
  const published = snapshot?.[source];
  if (!Array.isArray(published)) refuse(`slice_discovery_surface_absent:${source}`);
  const valid = published.filter((row) => {
    if (!isPlainObject(row)) return false;
    for (const field of contract.discovery.requiredFields) {
      if (row[field] === undefined || row[field] === null || row[field] === "") return false;
      if (typeof row[field] === "string" && row[field].length === 0) return false;
    }
    for (const [field, expected] of Object.entries(contract.discovery.require))
      if (row[field] !== expected) return false;
    return true;
  });
  if (contract.discovery.cardinality === "exactly_one" && valid.length !== 1)
    refuse(`slice_declared_given_absent:${source}:${valid.length}:${JSON.stringify(published).slice(0, 200)}`);
  if (valid.length === 0) refuse(`slice_declared_given_absent:${source}:0:${JSON.stringify(published).slice(0, 200)}`);
  return { rows: valid, chosen: valid[0], source };
}

/** `$target.<field>` substitution, or the literal the contract wrote. */
export function buildRequestArgs(contract, target) {
  const built = {};
  for (const [name, declared] of Object.entries(contract.args)) {
    const match = typeof declared === "string" ? /^\$target\.([A-Za-z][A-Za-z0-9_]{0,63})$/u.exec(declared) : null;
    if (match === null) {
      built[name] = declared;
      continue;
    }
    const field = match[1];
    const value = target?.[field];
    if (value === undefined || value === null) refuse(`slice_target_field_missing:${field}`);
    built[name] = value;
  }
  return built;
}

/**
 * The judgement, as a PURE function so it can be driven without a transport.
 *
 * `not_checked` is a distinct value from `false` and from `true`: a surface that does not carry the field, and an
 * absence that reads as "nothing was there", must never look the same. The caller fails on both.
 */
export function judgeSlice({ contract, target, terminal, after, evidence, staleTerminal }) {
  const checks = {};
  checks.terminalStateExpected = terminal?.state === contract.expectedState;
  checks.terminalReasonExpected = terminal?.reasonCode === contract.expectedReasonCode;
  checks.evidenceParsed = evidence !== null;
  for (const [key, expectation] of Object.entries(contract.evidence)) {
    checks[`evidence.${key}`] = judgeEvidence(key, expectation, evidence, target);
  }
  for (const assertion of contract.worldAfter) {
    checks[`world.${assertion.field}.${assertion.form}`] = judgeWorldAfter(assertion, after, target);
  }
  if (contract.stale !== null) {
    checks.staleRefused =
      staleTerminal?.state === "rejected" && contract.stale.refusedWith.includes(staleTerminal?.reasonCode);
  }
  return checks;
}

function judgeEvidence(key, expectation, evidence, target) {
  if (evidence === null) return "not_checked";
  const actual = evidence.get(key);
  if (actual === undefined) return false;
  if (expectation.equalsTarget !== undefined) {
    const wanted = target?.[expectation.equalsTarget];
    if (wanted === undefined) return "not_checked";
    return actual === String(wanted);
  }
  return actual === expectation.equals;
}

function judgeWorldAfter(assertion, after, target) {
  const published = after?.[assertion.field];
  if (assertion.form === "equals") {
    if (published === undefined || published === null) return "not_checked";
    return published === assertion.value;
  }
  if (!Array.isArray(published)) return "not_checked";
  if (target === null) return "not_checked";
  if (assertion.form === "excludesTarget") return published.every((row) => row?.targetId !== target.targetId);
  if (assertion.form === "size") return published.length === assertion.value;
  if (assertion.form === "includesTargetField") {
    const wanted = target[assertion.value];
    if (wanted === undefined) return "not_checked";
    return published.includes(wanted);
  }
  // rowAtTargetTile: the row standing on the target's own tile, compared field by field.
  const row = published.find((candidate) => candidate?.x === target.x && candidate?.y === target.y);
  if (row === undefined) return "not_checked";
  return Object.entries(assertion.value).every(([field, expected]) => row[field] === expected);
}

/** `key=value` receipt evidence, parsed by the one parser this tree has. */
export function receiptEvidence(terminal) {
  const detail = typeof terminal?.evidence === "string" ? terminal.evidence : terminal?.evidence?.detail;
  return parseReceiptFields(detail);
}

/**
 * One slice over ONE connected session: discover, dispatch a single frame, wait for its receipt, re-read the world,
 * re-send the stale target, judge. No second action is ever dispatched except the contract's own stale re-send.
 */
export async function runActionSlice({
  client,
  receipts,
  contract,
  terminalTimeoutMs = 5_000,
  actionableTimeoutMs = 15_000,
  argsOverride = null,
}) {
  const trace = [];
  const timings = { fixtureMs: 0, dispatchMs: 0, settleMs: 0, totalMs: 0 };
  const startedAt = Date.now();
  try {
    // THE FIRST OBSERVATION IS TAKEN WHEN THE WORLD CAN ACT. The bridge opens while the fixture's own
    // `warpFarmer` fade is still in flight, so the snapshot that arrives first reports `actionable: false` -
    // measured live 2026-11-14, `toggle_animal_door` refused `native_snapshot_not_actionable` with the fixture
    // freshly armed. A transition in flight is not a world that cannot act, and every native-local runner already
    // waits it out (`waitForActionable`), so this does too rather than spending a game launch on the race.
    const first = await observeFresh(client);
    const snapshot = await waitForActionable(client, first, actionableTimeoutMs);
    if (contract.derived.requiredCapabilities.length > 0)
      assertRequiredCapabilities(snapshot, contract.derived.requiredCapabilities);

    const dispatchStartedAt = Date.now();
    const discovery = chooseTarget(snapshot, contract);
    const args = argsOverride ?? buildRequestArgs(contract, discovery.chosen);
    trace.push({ step: "discovered", source: discovery.source, target: discovery.chosen, args });

    const requestId = `native_action_slice_${contract.action}_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: contract.action,
      args,
      snapshot,
    });
    trace.push({ step: "dispatched", requestId, action: contract.action, receipt: summarizeReceipt(accepted) });
    timings.dispatchMs = Date.now() - dispatchStartedAt;

    const settleStartedAt = Date.now();
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
      refuse(`slice_terminal_identity_mismatch:${terminal.requestId}:${requestId}`);
    const evidence = receiptEvidence(terminal);
    const after = await waitForFreshSnapshot(client, {
      minRevision: Number.isInteger(terminal.revision) ? terminal.revision : 0,
      timeoutMs: terminalTimeoutMs,
    });

    let staleTerminal = null;
    if (contract.stale !== null) {
      const staleArgs = { ...args, ...buildStaleArgs(contract, discovery.chosen) };
      const staleRequestId = `native_action_slice_${contract.action}_stale_${Date.now()}`;
      const staleAccepted = await executeFresh(client, {
        requestId: staleRequestId,
        idempotencyKey: `${staleRequestId}_idem`,
        action: contract.action,
        args: staleArgs,
        snapshot: after,
      });
      staleTerminal = await waitForTerminal(receipts, staleAccepted, terminalTimeoutMs);
      trace.push({ step: "stale_target", args: staleArgs, receipt: summarizeReceipt(staleTerminal) });
    }
    timings.settleMs = Date.now() - settleStartedAt;

    const checks = judgeSlice({ contract, target: discovery.chosen, terminal, after, evidence, staleTerminal });
    trace.push({ step: "observed", checks, evidence: evidence === null ? null : Object.fromEntries(evidence) });
    const failed = Object.keys(checks).filter((name) => checks[name] === false || checks[name] === "not_checked");
    const unassertedEvidence =
      evidence === null ? [] : [...evidence.keys()].filter((key) => contract.evidence[key] === undefined).sort();
    timings.totalMs = Date.now() - startedAt;
    const base = {
      topology: TOPOLOGY,
      action: contract.action,
      target: discovery.chosen,
      discovery: { source: discovery.source, rows: discovery.rows === null ? null : discovery.rows.length },
      args,
      checks,
      evidence: evidence === null ? null : Object.fromEntries(evidence),
      receipt: summarizeReceipt(terminal),
      stale: staleTerminal === null ? null : { receipt: summarizeReceipt(staleTerminal) },
      unassertedEvidence,
      timings,
      trace,
    };
    if (failed.length === 0) return { ...base, state: "passed", reasonCode: contract.expectedReasonCode };
    return { ...base, state: "blocked", reasonCode: failureReason(failed[0], terminal, checks, evidence, contract) };
  } catch (error) {
    timings.totalMs = Date.now() - startedAt;
    return {
      state: "blocked",
      topology: TOPOLOGY,
      action: contract.action,
      reasonCode: String(error?.message ?? error).slice(0, MAX_REASON_CHARS),
      timings,
      trace,
    };
  }
}

function buildStaleArgs(contract, target) {
  if (contract.stale === null || contract.stale.args === contract.args) return {};
  return buildRequestArgs({ args: contract.stale.args }, target);
}

/**
 * The blocked run's reason, naming the first check that failed and what the world actually said.
 *
 * A terminal that was not the expected one carries the Mod's own words, because that is the diagnosis: a
 * `rejected/not_tillable` is the action answering, and a reason code that only said `terminalStateExpected` would
 * send the reader to the run's own code instead of the game's.
 */
function failureReason(name, terminal, checks, evidence, contract) {
  if (name === "terminalStateExpected" || name === "terminalReasonExpected")
    return `slice_terminal_not_expected:${String(terminal?.state)}:${String(terminal?.reasonCode)}`;
  if (name === "evidenceParsed")
    return `slice_evidence_unreadable:${String(terminal?.evidence?.detail ?? terminal?.evidence ?? "none").slice(0, 160)}`;
  if (name.startsWith("evidence.")) {
    const key = name.slice("evidence.".length);
    const expectation = contract.evidence[key];
    const expected =
      expectation?.equalsTarget === undefined ? expectation?.equals : `$target.${expectation.equalsTarget}`;
    return `slice_evidence_mismatch:${key}:expected=${String(expected)}:actual=${String(evidence?.get(key))}`;
  }
  return `slice_world_unmet:${name}:${checks[name] === "not_checked" ? "not_checked" : "false"}`;
}

/** One frame against a world a launcher already prepared (`--client-config`). */
export async function runSliceOnClient(contract, { clientConfigPath, terminalTimeoutMs = 5_000 }) {
  const config = JSON.parse(await readFile(clientConfigPath, "utf8"));
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    return await runActionSlice({
      client: session.client,
      receipts: session.receipts,
      contract,
      terminalTimeoutMs,
    });
  } finally {
    await session.close();
  }
}

/**
 * The live transaction: the fixture, the launch, one slice, and the unwind - every step the launcher's own.
 *
 * The plan object is the shape `runFixtureSaveHarness`, `releaseFixture`, `teardown` and `restoreEnding` already
 * consume; it is built here rather than taken from `planLiveAction` because that function resolves the action's
 * gate runner, which is exactly the thing this CLI exists to stop needing.
 */
export function buildSlicePlan({
  fixtureRoot,
  modsPath,
  releaseDir,
  gamePath,
  saveName,
  binding,
  bindingPath,
  stardewSaveRoot,
  action,
  contract,
  keepLog,
  windowMode = "hidden",
  timeoutSeconds = 180,
}) {
  return Object.freeze({
    fixtureRoot,
    modsPath,
    releaseDir,
    gamePath,
    saveName,
    binding,
    bindingPath,
    stardewSaveRoot,
    clientConfigPath: join(modsPath, STARDEW_MOD_FOLDER, "config.json"),
    backupName: `native-action-slice-${action.replaceAll("_", "-")}-fixture-backup`,
    action,
    scenario: contract.derived.fixtureScenario,
    keepLog,
    windowMode,
    timeoutSeconds,
  });
}

export async function planSlice({ env = process.env, roots = null, contract, keepLog = false } = {}) {
  const resolvedRoots = roots ?? resolveStardewFixtureRoots({ env });
  const fixtureRoot = requireAbsolute(resolvedRoots.fixturesRoot, "slice_fixture_root_invalid");
  const modsPath = requireAbsolute(join(fixtureRoot, "mods"), "slice_mods_path_invalid");
  const releaseDir = requireAbsolute(join(REPO, DEFAULT_RELEASE_DIR), "slice_release_dir_invalid");
  const gamePath = requireAbsolute(env.GAMEBUDDY_STARDEW_GAME_DIR || DEFAULT_GAME_INSTALL, "slice_game_path_invalid");
  const transaction = readFixtureTransaction(fixtureRoot);
  if (transaction !== null)
    refuse(`slice_transaction_live:${transaction.backupName ?? "unknown"}:${transaction.ownerId ?? "unknown"}`);
  const { binding, bindingPath } = singleBinding(fixtureRoot);
  const saveName = binding.observedSaveSlot;
  if (!/^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$/u.test(String(saveName)))
    refuse(`invalid_fixture_observed_save_slot:${String(saveName)}`);
  const templatePath = join(fixtureRoot, "templates", saveName);
  if (!existsSync(templatePath)) refuse(`slice_template_missing:${templatePath}`);
  return buildSlicePlan({
    fixtureRoot,
    modsPath,
    releaseDir,
    gamePath,
    saveName,
    binding,
    bindingPath,
    stardewSaveRoot: gameStardewSaveRoot({ appData: env.APPDATA }),
    action: contract.action,
    contract,
    keepLog,
  });
}

/** The whole live run: fixture, launch, one slice, measured unwind. Never throws for a slice that failed. */
export async function runSliceLive({ contract, plan, evidencePath = null }) {
  const startedAt = Date.now();
  const stage = {
    prepared: false,
    saveRestored: false,
    handle: null,
    session: null,
    logPath: null,
    keepLog: plan.keepLog,
  };
  const timings = { fixtureMs: 0, dispatchMs: 0, settleMs: 0, totalMs: 0 };
  let result = null;
  let failure = null;
  let trap = null;
  let restore = { fixtureRestored: false, saveRestored: false };
  const fixtureStartedAt = Date.now();
  try {
    const fixtureOptions = {
      root: plan.fixtureRoot,
      modsPath: plan.modsPath,
      releaseDir: plan.releaseDir,
      saveName: plan.saveName,
      backupName: plan.backupName,
      timeoutSeconds: plan.timeoutSeconds,
      action: plan.action,
      binding: plan.binding,
      stardewSaveRoot: plan.stardewSaveRoot,
      heldItemQualifiedId: "",
    };
    await validateNativeLocalPlayerFixturePreparation(fixtureOptions);
    await prepareNativeLocalPlayerFixture(fixtureOptions);
    stage.prepared = true;
    runFixtureSaveHarness({ plan, cleanup: false });
    stage.saveRestored = true;

    const config = JSON.parse(readFileSync(plan.clientConfigPath, "utf8"));
    stage.logPath = join(plan.fixtureRoot, "logs", `native-action-slice-${plan.action}-${startedAt}.log`);
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
        await stage.session?.close().catch(() => {});
        stage.session = null;
        if (stage.prepared) {
          try {
            releaseFixture(plan);
          } catch (_error) {
            /* a second signal exits without a second unwind */
          }
        }
      },
    });
    stage.session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
    timings.fixtureMs = Date.now() - fixtureStartedAt;

    result = await runActionSlice({ client: stage.session.client, receipts: stage.session.receipts, contract });
    timings.dispatchMs = result.timings?.dispatchMs ?? 0;
    timings.settleMs = result.timings?.settleMs ?? 0;
  } catch (error) {
    failure = error;
  } finally {
    restore = await teardown({ plan, stage, trap });
  }
  timings.totalMs = Date.now() - startedAt;
  const ending = restoreEnding(restore);
  const run =
    result === null
      ? {
          state: "blocked",
          topology: TOPOLOGY,
          action: contract.action,
          reasonCode: ending ?? String(failure?.message ?? failure ?? "no_slice_result").slice(0, MAX_REASON_CHARS),
        }
      : { ...result, timings: { ...timings } };
  // A teardown that could not finish OUTRANKS the slice's own verdict: a live process or a dirty save is what the
  // next slice meets, whatever the action achieved inside this one.
  if (ending !== null) Object.assign(run, { state: "blocked", reasonCode: ending });
  const bundle = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    action: contract.action,
    fixtureScenario: contract.derived.fixtureScenario,
    resolvedRunner: "tools/run-native-action-slice.mjs",
    contract: Object.freeze({
      path: contract.path,
      schema: SMOKE_CONTRACT_SCHEMA,
      derived: contract.derived,
      asserted: Object.freeze({
        discovery: contract.discovery,
        args: contract.args,
        evidence: contract.evidence,
        worldAfter: contract.worldAfter,
        stale: contract.stale,
      }),
    }),
    fixture: Object.freeze({
      saveName: plan.saveName,
      scenario: contract.derived.fixtureScenario,
      windowMode: plan.windowMode,
    }),
    restore,
    run,
  });
  if (evidencePath !== null) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const absolute = isAbsolute(evidencePath) ? evidencePath : resolve(process.cwd(), evidencePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  }
  return bundle;
}

/** What `--dry-run` prints: the derived facts, the contract's own opinion, and the scenario it will arm. */
export function describeSlice(contract) {
  return {
    state: "planned",
    action: contract.action,
    contractPath: contract.path,
    derived: contract.derived,
    asserted: {
      discovery: contract.discovery,
      args: contract.args,
      evidence: contract.evidence,
      worldAfter: contract.worldAfter,
      stale: contract.stale,
    },
    expected: { state: contract.expectedState, reasonCode: contract.expectedReasonCode },
  };
}

function printLine(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv) {
  let options;
  try {
    options = parseSliceArguments(argv);
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const surface = readActionSurface();
    const protocolControls = readProtocolControls();
    const contract = resolveContract(options, { surface, protocolControls });
    if (options.dryRun) {
      printLine(describeSlice(contract));
      return;
    }
    if (options.clientConfig !== null) {
      const result = await runSliceOnClient(contract, {
        clientConfigPath: options.clientConfig,
        terminalTimeoutMs: options.terminalTimeoutMs,
      });
      printLine(result);
      if (result.state !== "passed") process.exitCode = 2;
      return;
    }
    if (options.evidencePath === null)
      refuse("slice_evidence_path_required", "a live run must write --evidence <path>");
    const roots = resolveStardewFixtureRoots({ env: process.env });
    announceStardewFixtureRoots(roots, process.stderr);
    const plan = await planSlice({ contract, roots, keepLog: options.keepLog });
    process.stderr.write(
      `[slice] ${contract.action} scenario=${contract.derived.fixtureScenario} save=${plan.saveName} window=${plan.windowMode}\n`,
    );
    const bundle = await runSliceLive({ contract, plan, evidencePath: options.evidencePath });
    printLine(bundle.run);
    process.stderr.write(
      `[slice] fixture=${bundle.run.timings.fixtureMs}ms dispatch=${bundle.run.timings.dispatchMs}ms settle=${bundle.run.timings.settleMs}ms total=${bundle.run.timings.totalMs}ms evidence=${options.evidencePath}\n`,
    );
    if (bundle.run.state !== "passed") process.exitCode = 2;
  } catch (error) {
    const code = String(error?.message ?? error).slice(0, MAX_REASON_CHARS);
    process.stderr.write(`${code}\n`);
    if (error instanceof SliceRefusal || error?.name === "SmokeContractError") {
      printLine({ state: "blocked", topology: TOPOLOGY, reasonCode: code });
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

/** `derived` facts for one action, used by `--dry-run` on an ad-hoc invocation and by the tests. */
export function derivedFactsFor(actionId) {
  return deriveActionFacts(actionId);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
