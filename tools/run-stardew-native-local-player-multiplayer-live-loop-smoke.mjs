import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
 * The multiplayer live-run loop: one long-lived session in the two-process shared world, driven by an allocation and
 * RECORDED so a reviewer can reconstruct it.
 *
 * THE PLAN NAMES THE AGENT'S ACTIONS. THERE IS NO PILOT VOCABULARY.
 * ----------------------------------------------------------------
 * The farmhand's action surface is the Mod's published set -- dozens of actions (`harvest_crop`, `chest_store`,
 * `chest_retrieve`, `chop_stump`, `plant_sapling`, `cut_weeds`, `scythe_crop`, `npc_relationship`, `use_item`,
 * `equip_tool`, `move_to_tile`, `send_multiplayer_chat`, ...). A step names ONE of them with its typed args and is
 * dispatched over the same bridge protocol the Agent itself uses:
 *
 *     { "atSeconds": 90, "action": "harvest_crop", "args": { "targetRef": "sr1_..." } }
 *
 * An earlier version offered `say` / `move` / `observe` instead. Those were hand-picked aliases for two of the
 * dozens (`send_multiplayer_chat`, `move_to_tile`) plus a read that is not an action at all, so they made the plan
 * look like a three-verb script when the real subject is the whole action surface. They are gone; the loop observes
 * continuously by construction, so it needs no `observe` step.
 *
 * The pilot cannot expand the surface: a name the live publication did not advertise is refused BY NAME into
 * `plan.jsonl` (`reason: "not_advertised"`), never silently dropped and never disguised as a native failure.
 *
 * WHAT IT RECORDS (all of it before teardown, because the driver stops both games)
 * -------------------------------------------------------------------------------
 * `timeline.jsonl` (every bridge fact with a wall clock, so a reviewer can see what the companion reacted to),
 * `positions.jsonl` (both farmers), `plan.jsonl` (the allocation, its dispatches, and anything the host player said
 * in game), `smapi/host.log` + `smapi/ai-client.log` (both processes' full output; SMAPI re-creates them on every
 * launch), and the rubric verdict.
 *
 * The host's tile is a NAMED GAP, never faked: the bridge carries only the bound farmhand
 * (`BridgeProtocolModels.cs:396-397`), and the host's tile exists only in the Mod's own `farmhands` line
 * (`ModEntry.cs:641-647`). When that line is absent the record says `host_position_not_emitted`; the farmhand's tile
 * is never substituted for it.
 */

/**
 * Read the allocation. An absent file means "observe only", which is the default posture.
 *
 * Every step is `{ atSeconds, action, args? }`; the action id is shape-checked HERE so a typo fails before a game
 * launch instead of becoming an unknown-action round trip in the middle of a session. Whether the name is actually
 * advertised is decided at dispatch time against the live snapshot -- that answer only exists in a running world.
 */
export function readLoopPlan(planPath) {
  if (typeof planPath !== "string" || planPath.length === 0)
    return Object.freeze({ durationSeconds: 0, steps: Object.freeze([]) });
  const raw = JSON.parse(readFileSync(planPath, "utf8").replace(/^\uFEFF/u, ""));
  const durationSeconds =
    Number.isSafeInteger(raw?.durationSeconds) && raw.durationSeconds > 0 ? raw.durationSeconds : 0;
  const steps = Array.isArray(raw?.steps) ? raw.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error("loop_plan_step_invalid");
    if (typeof step.action !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(step.action))
      throw new Error("loop_plan_action_id_invalid");
    if (step.args !== undefined && (typeof step.args !== "object" || step.args === null || Array.isArray(step.args)))
      throw new Error("loop_plan_action_args_invalid");
    if (!Number.isSafeInteger(step.atSeconds) || step.atSeconds < 0)
      throw new Error("loop_plan_step_at_seconds_invalid");
  }
  return Object.freeze({
    durationSeconds,
    steps: Object.freeze([...steps].sort((left, right) => left.atSeconds - right.atSeconds)),
  });
}

/** Append-only writer for one JSONL record. */
function jsonlWriter(path) {
  return (record) => appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/**
 * The host player's tile, if the world ever reported it.
 *
 * The ONLY source is the Mod's own `farmhands` line; there is no bridge field for another player. Returns `null`
 * with a reason instead of guessing.
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
    const match =
      /GameBuddy farmer: role=host, player_id=[^,]*, name=[^,]*, location=([^,]*), tile=([0-9]+),([0-9]+)/u.exec(
        lines[index],
      );
    if (match !== null) return { tile: { x: Number(match[2]), y: Number(match[3]) }, location: match[1], reason: null };
  }
  return { tile: null, reason: "host_position_not_emitted" };
}

/**
 * Archives both SMAPI logs. They are re-created on every launch, so a loop that does not copy them before teardown
 * loses the Mod's narration entirely.
 */
export function archiveGameLogs({ hostLogPath, aiLogPath, targetDir }) {
  mkdirSync(targetDir, { recursive: true });
  const archived = [];
  for (const [label, source] of [
    ["host", hostLogPath],
    ["ai-client", aiLogPath],
  ]) {
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
 * The companion's own spoken turns, read from the Agent runtime's session transcript.
 *
 * This is the only source of companion speech this harness accepts: what the AGENT said, never what the plan asked
 * for. Absent or unreadable transcript yields an empty list, and the rubric then reports `unmeasured` for every
 * obligation rather than passing vacuously.
 */
export function readAgentTurnsFromSession(sessionPath) {
  if (typeof sessionPath !== "string" || sessionPath.length === 0) return [];
  let text;
  try {
    text = readFileSync(sessionPath, "utf8");
  } catch {
    return [];
  }
  const turns = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "message" || record?.role !== "assistant") continue;
    const parts = Array.isArray(record.content) ? record.content : [];
    const spoken = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text.trim())
      .filter((part) => part.length > 0)
      .join(" ");
    if (spoken.length === 0) continue;
    const raw = `agent_${record.id ?? turns.length + 1}`;
    turns.push({ turnId: raw.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120), text: spoken });
  }
  return turns;
}

/** The loop body, against an already-connected session. Exported so it can be contract-tested without a game. */
export async function runMultiplayerLiveLoop(client, receipts, config, options) {
  const topology = classifyTopology(config);
  if (topology !== "shared_world_farmhand")
    throw new Error(`multiplayer_live_loop_requires_farmhand_topology:${topology}`);
  const {
    plan,
    traceDir,
    durationSeconds,
    sampleMs = 2_000,
    stopFile = null,
    now = () => Date.now(),
    hostLogPath = null,
    aiLogPath = null,
    agentSessionJsonl = null,
  } = options;
  mkdirSync(traceDir, { recursive: true });
  const timeline = jsonlWriter(join(traceDir, "timeline.jsonl"));
  const positions = jsonlWriter(join(traceDir, "positions.jsonl"));
  const planLog = jsonlWriter(join(traceDir, "plan.jsonl"));

  const startedAtMs = now();
  const factsByType = new Map();
  const dispatches = [];

  // Every fact the Mod emits, not only receipts: the point of the trace is that a reviewer can see what the
  // companion was reacting to, not only what it did.
  const unsubscribe = client.onFact((fact) => {
    factsByType.set(fact.type, (factsByType.get(fact.type) ?? 0) + 1);
    timeline({
      atMs: now() - startedAtMs,
      type: fact.type,
      revision: client.state?.snapshot?.revision ?? null,
      payload: fact.payload,
    });
    if (
      fact.type === "semantic_event" &&
      fact.payload?.playerControl?.kind === "player_input" &&
      typeof fact.payload.playerControl.text === "string"
    )
      planLog({ atMs: now() - startedAtMs, kind: "player_input", text: fact.payload.playerControl.text });
  });

  let nextStep = 0;
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
        timeline({
          atMs: now() - startedAtMs,
          type: "loop_observation_failed",
          detail: String(error?.message ?? error),
        });
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
        if (snapshot === null) {
          planLog({
            atMs: now() - startedAtMs,
            kind: "action",
            action: step.action,
            executed: false,
            reason: "no_snapshot",
          });
          continue;
        }
        // The pilot cannot expand the surface: the live publication's own capability list decides, and an
        // unadvertised name is refused BY NAME here rather than looking like a native failure.
        const advertised = Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [];
        if (!advertised.includes(step.action)) {
          planLog({
            atMs: now() - startedAtMs,
            kind: "action",
            action: step.action,
            executed: false,
            reason: "not_advertised",
          });
          continue;
        }
        const result = await dispatch(client, receipts, {
          action: step.action,
          args: step.args ?? {},
          snapshot,
          sequence: nextStep,
        });
        dispatches.push(result);
        planLog({
          atMs: now() - startedAtMs,
          kind: "action",
          action: step.action,
          requestId: result.requestId,
          executed: true,
          state: result.state,
          reason: result.reason,
        });
      }

      await delay(sampleMs);
    }
  } finally {
    unsubscribe();
  }

  const agentTurns = readAgentTurnsFromSession(agentSessionJsonl);
  const rubric = assessCompanionBehaviourRubric({ turns: agentTurns });
  // Archived here, before the driver's `finally` stops both games: SMAPI re-creates these files on every launch.
  const archivedLogs =
    hostLogPath !== null || aiLogPath !== null
      ? archiveGameLogs({ hostLogPath, aiLogPath, targetDir: join(traceDir, "smapi") })
      : [];
  return Object.freeze({
    durationSeconds: (now() - startedAtMs) / 1_000,
    steps: plan.steps.length,
    dispatched: Object.freeze([...dispatches]),
    agentTurns: agentTurns.length,
    factsByType: Object.freeze(Object.fromEntries(factsByType)),
    archivedLogs: Object.freeze([...archivedLogs]),
    rubric,
  });
}

async function dispatch(client, receipts, { action, args, snapshot, sequence }) {
  // The harness binds every request to an EXPLICIT identity: `executeFresh` validates both the request id and the
  // idempotency key (`stardew-native-smoke-harness-v1.mjs:108-109`) and refuses the request without them. The first
  // real loop run dispatched three actions and the Mod answered `invalid_native_request_id` for each -- that code comes
  // from the harness, not the game, because this call site omitted them. Names follow the per-action runners
  // (`native_local_<action>_<sequence>_<nonce>`), so the trace can be read the same way everywhere.
  const nonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const requestId = `native_local_${action}_loop_${sequence}_${nonce}`.slice(0, 200);
  try {
    const accepted = await executeFreshAfterReobserve(client, {
      action,
      args,
      snapshot,
      requestId,
      idempotencyKey: `${requestId}_idem`,
    });
    if (accepted?.state !== "accepted")
      return { action, requestId, state: accepted?.state ?? "unknown", reason: accepted?.reasonCode ?? "not_accepted" };
    const terminal = await waitForTerminal(receipts, accepted, 15_000);
    return { action, requestId, state: terminal?.state ?? "unknown", reason: terminal?.receipt?.reasonCode ?? null };
  } catch (error) {
    return { action, requestId, state: "failed", reason: String(error?.message ?? error) };
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
      agentSessionJsonl: process.env.GAMEBUDDY_LOOP_AGENT_SESSION ?? null,
    });
    writeFileSync(join(traceDir, "loop-report.json"), JSON.stringify(result, null, 2));
    console.log(`LOOP_RESULT ${JSON.stringify({ state: "passed", ...result })}`);
    process.exitCode = 0;
  } finally {
    await session.close();
  }
}
