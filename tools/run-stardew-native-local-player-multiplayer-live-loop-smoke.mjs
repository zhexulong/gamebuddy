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
import { runAgentDrivenLoop } from "./lib/stardew-multiplayer-agent-runtime.mjs";

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
function jsonlWriter(path, counted) {
  return (record) => {
    if (counted !== undefined) {
      appendFileSync(path, counted(record));
      return;
    }
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  };
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
  // Trace cost is measured, not assumed: which records the bytes went to is what a performance obligation needs, and
  // a reviewer cannot recover it from the finished trace without guessing. `snapshot` is separated because every
  // `*Targets` field repeats in every frame (audit of run loop-1792028924954: 189 frames, ~12.4 KB each, 96.7%).
  const traceBytes = { total: 0, snapshot: 0, byRecord: new Map() };
  const timelineCounted = (record) => {
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line, "utf8");
    traceBytes.total += size;
    if (record.type === "snapshot") traceBytes.snapshot += size;
    traceBytes.byRecord.set(line, (traceBytes.byRecord.get(line) ?? 0) + size);
    return line;
  };
  const timeline = jsonlWriter(join(traceDir, "timeline.jsonl"), timelineCounted);
  const positions = jsonlWriter(join(traceDir, "positions.jsonl"));
  const planLog = jsonlWriter(join(traceDir, "plan.jsonl"));

  const startedAtMs = now();
  const factsByType = new Map();
  const dispatches = [];
  // Observation continuity is MEASURED, never assumed. A run whose tail observed nothing must not be able to report
  // a clean pass: measured on a real session, 107 consecutive observation failures covered the last 216 s of 600 s
  // and the report still said `passed`.
  let observationCycles = 0;
  let observationFailures = 0;
  let firstObservationFailureMs = null;
  let lastObservationFailureMs = null;
  let lastSuccessfulObservationMs = null;

  // Connection state is a SEPARATE channel from the facts (`local-stardew-bridge.ts:571` vs `:575`). Without this
  // subscription the trace cannot say why a session ended: measured, snapshots were healthy at 382049 ms and the
  // next observation at 384054 ms failed `bridge_not_authenticated` for the rest of the run with nothing recorded
  // to explain it, because the disconnect notice went to a listener nobody had registered.
  const unsubscribeConnection =
    typeof client.onConnectionFact === "function"
      ? client.onConnectionFact((fact) => {
          timeline({
            atMs: now() - startedAtMs,
            type: "bridge_connection",
            revision: client.state?.snapshot?.revision ?? null,
            payload: fact,
          });
        })
      : () => {};

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
        observationCycles += 1;
        snapshot = await observeTopologySnapshot(client, topology, { actionable: false, timeoutMs: 5_000 });
        lastSuccessfulObservationMs = now() - startedAtMs;
        positions({
          atMs: now() - startedAtMs,
          revision: snapshot.revision ?? null,
          actor: "farmhand",
          location: snapshot.location ?? null,
          tile: snapshot.tile ?? null,
          actionable: snapshot.actionable ?? null,
        });
      } catch (error) {
        const atMs = now() - startedAtMs;
        observationFailures += 1;
        firstObservationFailureMs ??= atMs;
        lastObservationFailureMs = atMs;
        timeline({ atMs, type: "loop_observation_failed", detail: String(error?.message ?? error) });
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
    unsubscribeConnection();
  }

  const agentTurns = readAgentTurnsFromSession(agentSessionJsonl);
  const largestIdenticalRecordBytes = [...traceBytes.byRecord.values()].reduce((max, value) => Math.max(max, value), 0);
  const runReport = Object.freeze({
    durationSeconds: (now() - startedAtMs) / 1_000,
    observationCycles,
    observationFailures,
    unobservedTailMs,
    traceBytes: Object.freeze({ total: traceBytes.total, snapshot: traceBytes.snapshot, largestIdenticalRecordBytes }),
  });
  // Performance obligations read the RUN's own measurements; speech obligations read the Agent's turns. The rubric
  // names which is which, so a plan-driven run is judged on the run without pretending it judged the companion.
  const rubric = assessCompanionBehaviourRubric({ turns: agentTurns, runReport });
  // Archived here, before the driver's `finally` stops both games: SMAPI re-creates these files on every launch.
  const archivedLogs =
    hostLogPath !== null || aiLogPath !== null
      ? archiveGameLogs({ hostLogPath, aiLogPath, targetDir: join(traceDir, "smapi") })
      : [];
  const endedAtMs = now();
  // How long the run went at the end without a single usable observation. A large value means the tail measured
  // nothing, whatever the verdict says.
  const unobservedTailMs =
    lastSuccessfulObservationMs === null
      ? endedAtMs - startedAtMs
      : endedAtMs - startedAtMs - lastSuccessfulObservationMs;
  return Object.freeze({
    durationSeconds: (endedAtMs - startedAtMs) / 1_000,
    observationCycles,
    observationFailures,
    firstObservationFailureMs,
    lastObservationFailureMs,
    unobservedTailMs,
    steps: plan.steps.length,
    dispatched: Object.freeze([...dispatches]),
    agentTurns: agentTurns.length,
    runReport,
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
      // `executeFresh` derives the request deadline from this and `deadlineAfter` refuses a missing or out-of-range
      // value (`stardew-native-smoke-harness-v1.mjs:51-53`), which the first two educated runs hit as
      // `invalid_native_request_timeout`.
      timeoutMs: 15_000,
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

  // AGENT MODE. The Agent drives the farmhand and the harness only records.
  //
  // It is a separate path rather than a flag inside the loop because the two modes differ in who owns the bridge: the
  // agent path connects its own client (the launch handle needs the integration adapter, which the smoke harness does
  // not pass) and builds the product's Game runtime on top of it -- materializer included, so the card's authored
  // catalog is really published into Magic Context and a failure there fails this run. The plan-driven path keeps the
  // harness client and dispatches the allocation itself, and it can never make a claim about the companion.
  if (process.env.GAMEBUDDY_LOOP_AGENT === "1") {
    const allocation = String(process.env.GAMEBUDDY_LOOP_ALLOCATION ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const timeline = (record) => appendFileSync(join(traceDir, "timeline.jsonl"), `${JSON.stringify(record)}\n`);
    const startedAtMs = Date.now();
    const result = await runAgentDrivenLoop({
      config,
      allocation,
      traceDir,
      onFact: (fact) => timeline({ atMs: Date.now() - startedAtMs, type: fact.type, payload: fact.payload }),
    });
    const rubric = assessCompanionBehaviourRubric({
      turns: result.agentTurns,
      runReport: { durationSeconds: (Date.now() - startedAtMs) / 1_000 },
    });
    const report = Object.freeze({
      durationSeconds: (Date.now() - startedAtMs) / 1_000,
      allocation,
      agentTurns: result.agentTurns.length,
      persona: result.personaMounted,
      settled: result.settled,
      rubric,
    });
    writeFileSync(join(traceDir, "loop-report.json"), JSON.stringify(report, null, 2));
    console.log(`LOOP_RESULT ${JSON.stringify({ state: "passed", ...report })}`);
    process.exitCode = 0;
  } else {
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
}
