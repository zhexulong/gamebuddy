#!/usr/bin/env node
/**
 * Cold-session lifecycle gate: the two ends of the game flow, on a real install.
 *
 * WHY THIS EXISTS (`.pi/tools/game-automation-plan.md` §3 B6 / §5 G2,G3 / §6 slice 2)
 * ---------------------------------------------------------------------------------
 * The middle of the game flow (companion enabled -> an action's native effect) is the
 * strongest live layer in this repo. The HEAD (discovery -> choose -> register) is proven
 * only against injected probes and temp trees, and the TAIL (stop / detach / re-attach)
 * only by offline host suites - neither has ever run against a real install root and a
 * running game. This driver is that missing live gate. It does nothing else:
 *
 *   admission -> deployment -> launch -> attach -> one committed action -> STOP
 *     -> the game survives -> detach -> the world is unchanged -> (optional) endgame
 *
 * ORCHESTRATE ONLY. Every stage calls an authority that already publishes the fact it
 * reads; this driver owns no assertion of its own and re-implements no runner:
 *
 *   | stage      | fact it reads                                  | owning authority |
 *   |------------|------------------------------------------------|------------------|
 *   | admission  | a resolution + an admitted installation root    | `stardew-game-install/discovery.ts` + `stardew-installation-admission.ts` |
 *   | deployment | the Mod deployment decision kind                | `stardew-game-install/deployment.ts` |
 *   | launch     | the launched pid and a listening named pipe     | `tools/lib/stardew-live-run.mjs` (`launchStardewLiveRun`) |
 *   | attach     | an authenticated hello + the admitted snapshot  | `host/src/local-stardew-bridge.ts` (`LocalStardewBridgeClient.connect`) |
 *   | action     | an accepted request + a correlated terminal     | `tools/lib/stardew-native-smoke-harness-v1.mjs` (`executeFreshAfterReobserve`, `waitForTerminal`) |
 *   | stop       | the cancel receipt + the same terminal lineage  | `LocalStardewBridgeClient.cancel` + `waitForTerminal` |
 *   | survives   | the pid this run launched is still in the list  | `tools/lib/windows-process-tree.mjs` (`listStardewProcessIds`) |
 *   | detach     | the bridge's own `state.connected === false`    | `LocalStardewBridgeClient.close` |
 *   | world      | a fresh hello + an admitted observation         | `LocalStardewBridgeClient.connect` + `observe` (the plan's re-attach + observation sync) |
 *
 * The action is NOT a postcondition gate. This driver asserts only that the bridge
 * ACCEPTED the request and published a correlated terminal receipt - which action ran,
 * and whether its native effect happened, is the per-action runner's own business
 * (`.pi/tools/game-automation-plan.md` §4 seam 3). It also does not choose the action's
 * arguments: the request binding is the runner's action-specific knowledge, so the
 * operator supplies it (`--action` / `--action-args`).
 *
 * PRECONDITION (the plan's own words, §3 B2/B3): a real Stardew+SMAPI install, a built
 * generation (so the Host production modules and the Mod package can be read), and an
 * armed native-local fixture for the requested action - the same precondition every
 * native-local runner has. Arming and restoring the fixture is the EXISTING launcher's
 * transaction (`tools/run-stardew-native-local-player-move-fixture.ps1` and its
 * `prepare-`/`restore-` steps); this driver does not duplicate that ordering, so it
 * neither prepares nor restores it.
 *
 * FAIL CLOSED. A stage that produced no evidence, a stage whose implementation is
 * missing, a thrown error, or a harness timeout is never a pass and never retries: the
 * verdict is blocked, the failing stage is named with its own code, and the exit code is
 * non-zero. The one optional stage is `endgame`, and the harness owns no authenticated
 * endgame operation (explicit endgame is the product's own operation), so requesting it
 * here reports that by name rather than pretending to have run it.
 *
 * TEARDOWN. The driver kills exactly the process tree it launched, by that pid, and never
 * by image name - a stray Stardew process the operator is playing is not this driver's to
 * terminate. It runs even when the run failed, after the survival/world stages have had
 * their say.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  connectNativeLocalClient,
  executeFreshAfterReobserve,
  observeFresh,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadSelectedHostProductionModule, selectHostProductionArtifact } from "./lib/host-production-module.mjs";
import { launchStardewLiveRun, normalizeLiveRunWindowMode } from "./lib/stardew-live-run.mjs";
import { listStardewProcessIds } from "./lib/windows-process-tree.mjs";

/** This driver's own verdict contract. */
export const SESSION_SCHEMA = "gamebuddy-stardew-lifecycle-cold-session/v1";
const GAME_PATH_ENV = "GAMEBUDDY_STARDEW_GAME_PATH";
/** The Mod's own config leaf inside its deployed directory. */
const MOD_CONFIG_RELATIVE_PATH = join("GameBuddy.Stardew", "config.json");
/** The bridge fields `connectNativeLocalClient` refuses without; the config carries all six. */
const CLIENT_CONFIG_FIELDS = Object.freeze(["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"]);
const ACTION_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const ARGUMENTS = Object.freeze([
  "--game-path",
  "--mods-path",
  "--client-config",
  "--action",
  "--action-args",
  "--timeout-seconds",
  "--window-mode",
  "--run-dir",
]);

/**
 * The ordered stages and the ONE code each publishes when it fails.
 *
 * The order is load-bearing (an attach cannot precede a launch) and it is what the
 * offline suite pins: a stage whose implementation is missing blocks the run instead of
 * being skipped, so a half-wired driver can never report success.
 */
export const SESSION_STAGES = Object.freeze([
  Object.freeze({ name: "admission", failureCode: "admission_refused" }),
  Object.freeze({ name: "deployment", failureCode: "deployment_undecided" }),
  Object.freeze({ name: "launch", failureCode: "launch_failed" }),
  Object.freeze({ name: "attach", failureCode: "attach_failed" }),
  Object.freeze({ name: "action", failureCode: "action_refused" }),
  Object.freeze({ name: "stop", failureCode: "stop_not_settled" }),
  Object.freeze({ name: "survives", failureCode: "game_did_not_survive" }),
  Object.freeze({ name: "detach", failureCode: "detach_failed" }),
  Object.freeze({ name: "world", failureCode: "world_changed" }),
  Object.freeze({ name: "endgame", failureCode: "endgame_failed", optional: true }),
]);

function passed() {
  return Object.freeze({ ok: true });
}

function refused(reasonCode) {
  return Object.freeze({ ok: false, reasonCode });
}

/** One bounded token from a thrown error. Paths and stacks never reach the rollup. */
function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").slice(0, 240);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One stage's outcome from what its implementation returned.
 *
 * The fail-closed part: anything that is not an explicit `{ ok: boolean }` is missing
 * evidence, and a refusal must carry the stage's own code. A `{ ok: false }` with no code
 * is named with the stage's registered failure code rather than an empty string.
 */
export function classifyStageResult(stage, result) {
  if (!isPlainObject(result) || typeof result.ok !== "boolean")
    return Object.freeze({ state: "blocked", reasonCode: `lifecycle_stage_evidence_missing:${stage.name}` });
  if (result.ok === true) return Object.freeze({ state: "passed", reasonCode: `${stage.name}_passed` });
  return Object.freeze({
    state: "blocked",
    reasonCode:
      typeof result.reasonCode === "string" && result.reasonCode.length > 0 ? result.reasonCode : stage.failureCode,
  });
}

/** The bounded, typed argument set this entry accepts; `--endgame` is the one switch. */
export function parseSessionArgs(argv = [], env = process.env) {
  const values = new Map();
  let endgame = false;
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--endgame") {
      endgame = true;
      continue;
    }
    if (!ARGUMENTS.includes(key)) throw new Error(`invalid_session_argument:${String(key)}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`missing_session_argument_value:${key.slice(2)}`);
    if (values.has(key)) throw new Error(`invalid_session_argument:${key}`);
    values.set(key, value);
    index++;
  }

  const gamePath = values.get("--game-path") ?? env?.[GAME_PATH_ENV];
  if (typeof gamePath !== "string" || gamePath.length === 0) throw new Error(`game_path_required:${GAME_PATH_ENV}`);
  const modsPath = values.get("--mods-path");
  if (modsPath === undefined) throw new Error("mods_path_required");
  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? 120);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 300)
    throw new Error("invalid_timeout_seconds");
  const action = values.get("--action") ?? "move_to_tile";
  if (!ACTION_ID.test(action)) throw new Error("invalid_action");

  const runId = randomUUID();
  const runDir = values.get("--run-dir") ?? join(tmpdir(), `gamebuddy-stardew-lifecycle-cold-session-${runId}`);
  const clientConfigPath = values.get("--client-config") ?? join(modsPath, MOD_CONFIG_RELATIVE_PATH);
  for (const [name, value] of [
    ["game_path", gamePath],
    ["mods_path", modsPath],
    ["client_config", clientConfigPath],
    ["run_dir", runDir],
  ]) {
    if (!isAbsolute(value)) throw new Error(`invalid_${name}`);
  }

  const clientConfig = readClientConfig(clientConfigPath);
  const actionArgs = parseActionArgs(values.get("--action-args"));

  return Object.freeze({
    gamePath,
    modsPath,
    clientConfigPath,
    clientConfig,
    action,
    actionArgs,
    timeoutSeconds,
    windowMode: normalizeLiveRunWindowMode(values.get("--window-mode") ?? "hidden"),
    runId,
    runDir,
    endgame,
  });
}

function readClientConfig(path) {
  if (!existsSync(path)) throw new Error("client_config_missing");
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("client_config_invalid");
  }
  if (
    !isPlainObject(config) ||
    CLIENT_CONFIG_FIELDS.some((field) => typeof config[field] !== "string" || config[field].length === 0)
  )
    throw new Error("client_config_invalid");
  return config;
}

function parseActionArgs(raw) {
  if (raw === undefined) return Object.freeze({});
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid_action_args");
  }
  if (!isPlainObject(value)) throw new Error("invalid_action_args");
  return Object.freeze(value);
}

function countStageStates(stages) {
  const counts = { total: stages.length, passed: 0, blocked: 0, not_run: 0, not_requested: 0 };
  for (const row of stages) counts[row.state] += 1;
  return Object.freeze(counts);
}

/**
 * The whole session: one ordered pass over the stages, one rollup.
 *
 * `stages` is the injection seam this slice's offline suite drives; the CLI never passes
 * it, so the CLI always runs the production authorities. Every field a stage leaves on
 * `session` is shared state between stages (the launched pid, the attached client, the
 * committed action) and is deliberately not part of the rollup.
 */
export async function runColdSession({ argv = [], env = process.env, stages, log = () => {} } = {}) {
  const request = parseSessionArgs(argv, env);
  mkdirSync(request.runDir, { recursive: true });
  log(
    `[stardew-lifecycle-cold-session] runId=${request.runId} action=${request.action} windowMode=${request.windowMode} timeoutSeconds=${request.timeoutSeconds} runDir=${request.runDir}`,
  );

  const session = {
    request,
    installation: null,
    inspector: null,
    launch: null,
    attachment: null,
    action: null,
    priorRevision: null,
    worldProbe: null,
  };
  const provided = stages ?? (await createProductionStages(request));
  const rows = [];
  let failure = null;

  try {
    for (const stage of SESSION_STAGES) {
      if (failure !== null) {
        rows.push(Object.freeze({ stage: stage.name, state: "not_run", reasonCode: "lifecycle_stage_not_run" }));
        continue;
      }
      if (stage.optional === true && request.endgame !== true) {
        rows.push(
          Object.freeze({ stage: stage.name, state: "not_requested", reasonCode: "lifecycle_stage_not_requested" }),
        );
        continue;
      }
      const run = provided?.[stage.name];
      if (typeof run !== "function") {
        failure = Object.freeze({ stage: stage.name, reasonCode: `lifecycle_stage_missing:${stage.name}` });
        rows.push(Object.freeze({ stage: stage.name, state: "blocked", reasonCode: failure.reasonCode }));
        continue;
      }
      let classified;
      try {
        classified = classifyStageResult(stage, await run(session));
      } catch (error) {
        // A stage that threw named nothing: that is this driver's own fault, so it is
        // never read as the stage's product code.
        classified = Object.freeze({
          state: "blocked",
          reasonCode: `lifecycle_stage_threw:${stage.name}:${reasonOf(error)}`,
        });
      }
      rows.push(Object.freeze({ stage: stage.name, state: classified.state, reasonCode: classified.reasonCode }));
      log(`${stage.name}: ${classified.state} (${classified.reasonCode})`);
      if (classified.state !== "passed")
        failure = Object.freeze({ stage: stage.name, reasonCode: classified.reasonCode });
    }
  } finally {
    await disposeSession(session);
  }

  const passedRun = failure === null;
  const rollup = Object.freeze({
    schema: SESSION_SCHEMA,
    state: passedRun ? "passed" : "blocked",
    reasonCode: passedRun ? "cold_session_passed" : `cold_session_blocked:${failure.stage}:${failure.reasonCode}`,
    runId: request.runId,
    runDir: request.runDir,
    action: request.action,
    stages: Object.freeze(rows),
    counts: countStageStates(rows),
    failedStage: failure,
  });
  writeFileSync(join(request.runDir, "rollup.json"), JSON.stringify(rollup), "utf8");
  return { rollup, exitCode: passedRun ? 0 : 2 };
}

/** Reclaim exactly what this run created: the probe bridge, the live bridge, the launched tree. */
async function disposeSession(session) {
  for (const key of ["worldProbe", "attachment"]) {
    const handle = session[key];
    if (handle === null || handle === undefined) continue;
    try {
      await handle.close();
    } catch {
      // Teardown is best-effort: a failed close must not replace the verdict already read.
    }
    session[key] = null;
  }
  if (session.launch !== null) {
    try {
      await session.launch.close();
    } catch {
      // Same: the launched pid is reported by the survival stage, not by this teardown.
    }
    session.launch = null;
  }
}

/**
 * The production stages. Each one calls the owning authority above and maps its outcome
 * onto `{ ok }`; a stage never lets a failure escape as a throw, because the code the
 * rollup publishes has to be the stage's own and not this file's exception text.
 *
 * The Host production generation is loaded lazily, on the first stage that needs it, so a
 * missing or incomplete generation is reported as THAT stage's failure inside the rollup
 * instead of as an unshaped error before the stage machine starts.
 */
async function createProductionStages(request) {
  let authorities;
  const host = async () => (authorities ??= await loadHostAuthorities());
  const attach = async () => {
    const { bridge } = await host();
    return await connectNativeLocalClient(request.clientConfig, { loadModule: async () => bridge });
  };
  const timeoutMs = request.timeoutSeconds * 1_000;

  const stages = {
    admission: async (session) => {
      try {
        const { selected, discovery, admission, inspector } = await host();
        const resolution = await discovery.discoverStardewGameInstallation({ chosenInstallRoot: request.gamePath });
        if (resolution.kind !== "resolved") return refused(`admission_refused:installation_${resolution.kind}`);
        session.inspector ??= await inspector.createPublishedWindowsReparseInspector(selected.artifactRoot);
        await admission.admitStardewInstallation(session.inspector, resolution.installation.installRoot);
        session.installation = Object.freeze({
          installRoot: resolution.installation.installRoot,
          source: resolution.installation.source,
        });
        return passed();
      } catch (error) {
        return refused(`admission_refused:${reasonOf(error)}`);
      }
    },
    deployment: async (session) => {
      try {
        const { selected, deployment } = await host();
        const mod = await deployment.readStardewCompanionModPackage(selected.artifactRoot);
        const result = await deployment.deployStardewCompanionMod({
          installRoot: session.installation.installRoot,
          package: mod,
          allowReplaceDifferentVersion: true,
        });
        if (result.kind === "failed") return refused(`deployment_undecided:${result.failure}`);
        return passed();
      } catch (error) {
        return refused(`deployment_undecided:${reasonOf(error)}`);
      }
    },
    launch: async (session) => {
      try {
        session.launch = await launchStardewLiveRun({
          gamePath: request.gamePath,
          modsPath: request.modsPath,
          windowMode: request.windowMode,
          pipeName: request.clientConfig.PipeName,
          timeoutMs,
        });
        return passed();
      } catch (error) {
        return refused(`launch_failed:${reasonOf(error)}`);
      }
    },
    attach: async (session) => {
      try {
        session.attachment = await attach();
        return passed();
      } catch (error) {
        return refused(`attach_failed:${reasonOf(error)}`);
      }
    },
    action: async (session) => {
      try {
        const requestId = `cold_session_${request.runId}_${request.action}`;
        const accepted = await executeFreshAfterReobserve(session.attachment.client, {
          action: request.action,
          args: request.actionArgs,
          requestId,
          idempotencyKey: `${requestId}_idem`,
          timeoutMs,
          actionable: true,
        });
        const terminal = await waitForTerminal(session.attachment.receipts, accepted, timeoutMs);
        session.action = Object.freeze({
          requestId: accepted.requestId,
          executionId: accepted.executionId,
          terminalState: terminal.state,
          terminalReasonCode: terminal.reasonCode,
        });
        session.priorRevision = session.attachment.client.state?.snapshot?.revision ?? null;
        return passed();
      } catch (error) {
        return refused(`action_refused:${reasonOf(error)}`);
      }
    },
    stop: async (session) => {
      try {
        const { requestId, executionId } = session.action;
        await session.attachment.client.cancel(requestId, executionId, "player_stop");
        // The cancel's own receipt is not the authority; the terminal the SAME identity
        // settles on is, so a STOP that never settled fails here rather than reading a
        // cancel acknowledgement as one.
        await waitForTerminal(session.attachment.receipts, { requestId, executionId }, timeoutMs);
        return passed();
      } catch (error) {
        return refused(`stop_not_settled:${reasonOf(error)}`);
      }
    },
    survives: async (session) => {
      if (!listStardewProcessIds().includes(session.launch.pid))
        return refused("game_did_not_survive:launched_pid_gone");
      return passed();
    },
    detach: async (session) => {
      try {
        const attachment = session.attachment;
        await attachment.close();
        session.attachment = null;
        if (attachment.client.state.connected === true) return refused("detach_failed:bridge_still_connected");
        return passed();
      } catch (error) {
        return refused(`detach_failed:${reasonOf(error)}`);
      }
    },
    world: async (session) => {
      try {
        // The plan's own re-attach: a fresh authenticated hello, then an observation
        // sync. A world that STOP or the detach had terminated cannot answer this.
        const probe = await attach();
        session.worldProbe = probe;
        const snapshot = await observeFresh(probe.client);
        const priorRevision = session.priorRevision;
        if (Number.isSafeInteger(priorRevision) && snapshot.revision < priorRevision)
          return refused(`world_changed:revision_regressed:${snapshot.revision}:${priorRevision}`);
        return passed();
      } catch (error) {
        return refused(`world_changed:${reasonOf(error)}`);
      }
    },
  };

  if (request.endgame === true) {
    // Explicit endgame is the product's own authenticated lifecycle operation
    // (`stardew-production-lifecycle-coordinator.internal.ts`); this harness owns no
    // such authority, so it says so by name instead of reporting a settlement it did
    // not perform.
    stages.endgame = async () => refused("endgame_failed:endgame_requires_the_authenticated_product_operation");
  }

  return Object.freeze(stages);
}

/** The five Host authorities this driver composes, from the one selected generation. */
async function loadHostAuthorities() {
  const selected = await selectHostProductionArtifact();
  const load = (module) => loadSelectedHostProductionModule(selected, module);
  const [discovery, admission, inspector, deployment, bridge] = await Promise.all([
    load("stardew-game-install/discovery.js"),
    load("stardew-installation-admission.js"),
    load("windows-reparse-inspector/index.js"),
    load("stardew-game-install/deployment.js"),
    load("local-stardew-bridge.js"),
  ]);
  return Object.freeze({ selected, discovery, admission, inspector, deployment, bridge });
}

if (import.meta.main) {
  try {
    const { rollup, exitCode } = await runColdSession({
      argv: process.argv.slice(2),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`${JSON.stringify(rollup)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ schema: SESSION_SCHEMA, state: "blocked", reasonCode: String(error?.message ?? error) })}\n`,
    );
    process.exitCode = 1;
  }
}
