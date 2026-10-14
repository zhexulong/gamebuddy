import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  connectNativeLocalClient,
  classifyTopology,
  delay,
  executeFreshAfterReobserve,
  observeTopologySnapshot,
  readNativeClientConfig,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";
import { assessCompanionBehaviourRubric } from "./lib/companion-behaviour-rubric.mjs";

/**
 * The multiplayer live-run loop: one long-lived session in the two-process shared
 * world, driven by a FREE plan and recorded so a reviewer can reconstruct it.
 *
 * WHY IT IS A SMOKE RUNNER
 * ------------------------
 * `tools/run-stardew-shared-world-action.ps1` already owns the topology order
 * (host launch -> signed attachment -> AI-client launch -> bridge readiness) and
 * tears both games down in its `finally`. So the loop is not a new driver: it is a
 * long-lived `-SmokeScript`, which is exactly how `send_multiplayer_chat` is gated
 * on the same world. What is new is that the session is measured over TIME rather
 * than reduced to one bit.
 *
 * THE FOUR CONTRACTS THIS FILE HONOURS (design/architecture/stardew-multiplayer-live-run-loop.md)
 * ----------------------------------------------------------------------------------------------
 *  1. **Nothing is hardcoded.** The plan may be empty, in which case the pilot only
 *     observes and records. `say` and `move` use already-published actions
 *     (`send_multiplayer_chat`, `move_to_tile`) and grant no capability.
 *  2. **All runtime information is captured.** Every bridge fact lands in
 *     `timeline.jsonl` with a wall-clock stamp; both farmers' positions land in
 *     `positions.jsonl`; the agent's own transcript is copied by the caller's
 *     capture, and the two SMAPI logs are archived by `archiveGameLogs` BEFORE the
 *     driver tears the processes down (they are overwritten on the next launch).
 *  3. **The Host position is a NAMED GAP, never faked.** The bridge carries only the
 *     bound farmhand (`BridgeProtocolModels.cs:396-397`); the host's tile exists
 *     only in the Mod's `farmhands` command line (`ModEntry.cs:641-647`). When that
 *     line is absent the record says so, and the farmhand's tile is never used as a
 *     stand-in.
 *  4. **A run that spoke nothing cannot pass the rubric vacuously.** The rubric
 *     reports `unmeasured` for every obligation it could not judge.
 */

const CHAT_ACTION = "send_multiplayer_chat";
const MOVE_ACTION = "move_to_tile";
/** The Mod refuses a second chat inside 2000 ms and answers `chat_rate_limited` with `retry_after_ms`. */
const CHAT_MIN_INTERVAL_MS = 2_100;
const DEFAULT_SAMPLE_MS = 2_000;

/** Read the plan, or an empty one: an absent plan means "observe only". */
export function readLoopPlan(planPath) {
  if (typeof planPath !== "string" || planPath.length === 0) return Object.freeze({ durationSeconds: 0, steps: Object.freeze([]) });
  const raw = JSON.parse(readFileSync(planPath, "utf8").replace(/^\uFEFF/u, ""));
  const durationSeconds = Number.isSafeInteger(raw?.durationSeconds) && raw.durationSeconds > 0 ? raw.durationSeconds : 0;
  const steps = Array.isArray(raw?.steps) ? raw.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== "object") throw new Error("loop_plan_step_invalid");
    if (!["say", "move", "observe"].includes(step.kind)) throw new Error(`loop_plan_step_kind_invalid:${step.kind}`);
    if (typeof step.atSeconds !== "number" || step.atSeconds < 0) throw new Error("loop_plan_step_at_seconds_invalid");
    if (step.kind === "say" && (typeof step.text !== "string" || step.text.trim().length === 0))
      throw new Error("loop_plan_say_text_invalid");
    if (step.kind === "move" && (!Number.isSafeInteger(step.tile?.x) || !Number.isSafeInteger(step.tile?.y)))
      throw new Error("loop_plan_move_tile_invalid");
  }
  return Object.freeze({ durationSeconds, steps: Object.freeze([...steps].sort((left, right) => left.atSeconds - right.atSeconds)) });
}

/** Append-only writer for one JSONL record. */
function jsonlWriter(path) {
  return (record) => appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/**
 * The host player's tile, if the world ever reported it.
 *
 * The ONLY source is the Mod's own `farmhands` line; there is no bridge field for
 * another player. Returns `null` with a reason instead of guessing.
 */
export function readHostPositionFromLog(logPath) {
  let text;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return { tile: null, reason: "host_log_unreadable" };
  }
  const lines = text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = /GameBuddy farmer: role=host, player_id=[^,]*, name=[^,]*, location=([^,]*), tile=([0-9]+),([0-9]+)/u.exec(lines[index]);
    if (match !== null) return { tile: { x: Number(match[2]), y: Number(match[3]) }, location: match[1], reason: null };
  }
  return { tile: null, reason: "host_position_not_emitted" };
}

/**
 * Archives both SMAPI logs. They are re-created on every launch (`run-stardew-shared-world-action.ps1:334-335`),
 * so a loop that does not copy them before teardown loses the Mod's narration entirely.
 */
export function archiveGameLogs({ hostLogPath, aiLogPath, targetDir }) {
  mkdirSync(targetDir, { recursive: true });
  const archived = [];
  for (const [label, source] of [["host", hostLogPath], ["ai-client", aiLogPath]]) {
    try {
      const text = readFileSync(source, "utf8");
      const destination = join(targetDir, `${label}.log`);
      writeFileSync(destination, text, "utf8");
      archived.push({ label, destination, bytes: text.length });
    } catch {
      archived.push({ label, destination: null, bytes: 0, reason: "log_unreadable" });
    }
  }
  return archived;
}

/**
 * The loop body, against an already-connected session. Exported so it can be
 * contract-tested without a game.
 */
export async function runMultiplayerLiveLoop(client, receipts, config, options) {
  const topology = classifyTopology(config);
  if (topology !== "shared_world_farmhand")
    throw new Error(`multiplayer_live_loop_requires_farmhand_topology:${topology}`);
  const { plan, traceDir, durationSeconds, sampleMs = DEFAULT_SAMPLE_MS, stopFile = null, now = () => Date.now(), hostLogPath = null, aiLogPath = null } = options;
  mkdirSync(traceDir, { recursive: true });
  const timeline = jsonlWriter(join(traceDir, "timeline.jsonl"));
  const positions = jsonlWriter(join(traceDir, "positions.jsonl"));
  const planLog = jsonlWriter(join(traceDir, "plan.jsonl"));

  const startedAtMs = now();
  const spoken = [];
  const dispatched = [];
  const factsByType = new Map();

  // Every fact the Mod emits, not only receipts: the point of the trace is that a
  // reviewer can see what the companion was reacting to, not only what it did.
  const unsubscribe = client.onFact((fact) => {
    factsByType.set(fact.type, (factsByType.get(fact.type) ?? 0) + 1);
    timeline({ atMs: now() - startedAtMs, type: fact.type, revision: client.state?.snapshot?.revision ?? null, payload: fact.payload });
    if (fact.type === "semantic_event" && fact.payload?.playerControl?.kind === "player_input" && typeof fact.payload.playerControl.text === "string")
      planLog({ atMs: now() - startedAtMs, kind: "player_input", text: fact.payload.playerControl.text });
  });

  let nextStep = 0;
  let lastChatAtMs = Number.NEGATIVE_INFINITY;
  try {
    while (true) {
      const elapsedSeconds = (now() - startedAtMs) / 1_000;
      if (durationSeconds > 0 && elapsedSeconds >= durationSeconds) break;
      if (stopFile !== null && fileExists(stopFile)) break;

      let snapshot = null;
      try {
        snapshot = await observeTopologySnapshot(client, topology, { actionable: false, timeoutMs: 5_000 });
        positions({
          atMs: now() - startedAtMs,
          revision: snapshot.revision ?? null,
          actor: "farmhand",
          location: snapshot.location ?? null,
          tile: snapshot.tile ?? null,
          actionable: snapshot.actionable ?? null,
        });
      } catch (error) {
        timeline({ atMs: now() - startedAtMs, type: "loop_observation_failed", detail: String(error?.message ?? error) });
      }
      // The host's tile has no bridge field; it is read from the Mod's own line when the world printed one, and
      // otherwise recorded as absent WITH the reason. The farmhand's tile is never substituted for it.
      if (hostLogPath !== null) {
        const host = readHostPositionFromLog(hostLogPath);
        positions({
          atMs: now() - startedAtMs,
          revision: snapshot?.revision ?? null,
          actor: "host",
          location: host.location ?? null,
          tile: host.tile,
          reason: host.reason,
        });
      }

      while (nextStep < plan.steps.length && plan.steps[nextStep].atSeconds <= elapsedSeconds) {
        const step = plan.steps[nextStep++];
        if (step.kind === "observe") {
          planLog({ atMs: now() - startedAtMs, kind: "observe", executed: true, reason: "observed_this_cycle" });
          continue;
        }
        if (snapshot === null) {
          planLog({ atMs: now() - startedAtMs, kind: step.kind, executed: false, reason: "no_snapshot" });
          continue;
        }
        if (step.kind === "say") {
          const since = now() - lastChatAtMs;
          if (since < CHAT_MIN_INTERVAL_MS) await delay(CHAT_MIN_INTERVAL_MS - since);
          const result = await dispatch(client, receipts, { action: CHAT_ACTION, args: { text: step.text }, snapshot });
          lastChatAtMs = now();
          dispatched.push(result);
          spoken.push({ turnId: `say_${dispatched.length}`, text: step.text, observedEvents: [] });
          planLog({ atMs: now() - startedAtMs, kind: "say", executed: true, text: step.text, state: result.state, reason: result.reason });
          continue;
        }
        const result = await dispatch(client, receipts, { action: MOVE_ACTION, args: { x: step.tile.x, y: step.tile.y }, snapshot });
        dispatched.push(result);
        planLog({ atMs: now() - startedAtMs, kind: "move", executed: true, tile: step.tile, state: result.state, reason: result.reason });
      }

      await delay(sampleMs);
    }
  } finally {
    unsubscribe();
  }

  const rubric = assessCompanionBehaviourRubric({ turns: spoken });
  // Archived here, before the driver's `finally` stops both games: SMAPI re-creates these files on every launch.
  const archivedLogs = hostLogPath !== null || aiLogPath !== null
    ? archiveGameLogs({ hostLogPath, aiLogPath, targetDir: join(traceDir, "smapi") })
    : [];
  return Object.freeze({
    durationSeconds: (now() - startedAtMs) / 1_000,
    steps: plan.steps.length,
    dispatched: Object.freeze([...dispatched]),
    factsByType: Object.freeze(Object.fromEntries(factsByType)),
    spoken: Object.freeze([...spoken]),
    archivedLogs: Object.freeze([...archivedLogs]),
    rubric,
  });
}

async function dispatch(client, receipts, { action, args, snapshot }) {
  try {
    const accepted = await executeFreshAfterReobserve(client, { action, args, snapshot });
    if (accepted?.state !== "accepted") return { action, state: accepted?.state ?? "unknown", reason: accepted?.reasonCode ?? "not_accepted" };
    const terminal = await waitForTerminal(receipts, accepted, 15_000);
    return { action, state: terminal?.state ?? "unknown", reason: terminal?.receipt?.reasonCode ?? null };
  } catch (error) {
    return { action, state: "failed", reason: String(error?.message ?? error) };
  }
}

function fileExists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const plan = readLoopPlan(process.env.GAMEBUDDY_LOOP_PLAN ?? null);
  const traceDir = process.env.GAMEBUDDY_LOOP_TRACE_DIR;
  if (typeof traceDir !== "string" || traceDir.length === 0) throw new Error("loop_trace_dir_required");
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runMultiplayerLiveLoop(session.client, session.receipts, config, {
      plan,
      traceDir,
      durationSeconds: Number(process.env.GAMEBUDDY_LOOP_DURATION_SECONDS ?? plan.durationSeconds ?? 0),
      stopFile: process.env.GAMEBUDDY_LOOP_STOP_FILE ?? null,
      hostLogPath: process.env.GAMEBUDDY_LOOP_HOST_LOG ?? null,
      aiLogPath: process.env.GAMEBUDDY_LOOP_AI_LOG ?? null,
    });
    writeFileSync(join(traceDir, "loop-report.json"), JSON.stringify(result, null, 2));
    console.log(`LOOP_RESULT ${JSON.stringify({ state: "passed", ...result, dispatched: result.dispatched.length, spoken: result.spoken.length })}`);
    process.exitCode = 0;
  } finally {
    await session.close();
  }
}
