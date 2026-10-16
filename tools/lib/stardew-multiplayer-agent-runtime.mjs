/**
 * The AGENT-driven multiplayer live loop: the product's own Game runtime, materialized on the ONE bridge
 * consumer, with a human player's own Stardew on the other side of the same world.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The plan-driven loop proved the world, the pipe and the recording, and it never ran the Agent: `agentTurns: 0`,
 * every dispatch written by the harness. An independent audit said so plainly (and the audit was right), and it named
 * the consequence: a plan-driven run cannot support any claim about the companion's behaviour OR about the machinery
 * that decides it -- including our own authored-context (Magic Context) publication, which a plan-driven run never
 * touches and therefore can never fail.
 *
 * This module closes that gap by doing exactly what the single-process ladder does, in the multiplayer topology:
 *
 *   authenticated bridge client  ->  launch handle  ->  persona provisioning  ->  deployment manifest  ->
 *   game runtime binding  ->  materializer (`materializeEnter`)  ->  `runtime.connected.host` tools  ->  Agent turn
 *
 * The order and the call shapes are the ladder's (`run-stardew-native-local-agent-ab-live.mjs:1046-1198`), because
 * that is the only path on this machine that is PROVEN to end in a live Agent turn -- `connectLocalCompanion` is not a
 * candidate: it loads `local-bootstrap.js`, which exists in neither `host/dist-test` nor the installed generation.
 *
 * Two properties are inherited deliberately rather than re-implemented:
 *   * the materializer PUBLISHES the card's authored catalog into Magic Context
 *     (`continuity-semantic-game-runtime-materializer.ts:804-835`) and DISPOSES the runtime if that publication
 *     fails, so an authored-context regression fails this loop loudly instead of passing it;
 *   * persona mounting is ASSERTED, not assumed (`assertLiveRunPersonaMounted`), including "the compiled profile's
 *     name is the card's" -- the check that catches a run presenting as the placeholder "GameBuddy Companion".
 *
 * The allocation stays free-form and optional: tasks are handed to the Agent, never dispatched by the harness, and an
 * empty allocation means "do whatever you think is worth doing".
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertLiveRunPersonaMounted, provisionLiveRunPersona } from "../live-run/core/persona.mjs";
import { submitPlayerPrompt } from "../live-run/core/player-input-admission.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The build whose modules the live loops use; the ladder's own choice, proven by a real Agent turn. */
const HOST_BUILD = join(REPOSITORY_ROOT, "host", "dist-test");

async function loadHostBuild() {
  const base = new URL(`file://${HOST_BUILD.replace(/\\/gu, "/")}/`);
  const [
    { LocalStardewBridgeClient },
    { STARDEW_GAME_INTEGRATION_ADAPTER },
    { createStardewIntegrationLaunchHandleFromAuthenticatedBridge, STARDEW_INTEGRATION_LAUNCHER },
    { createGameRuntimeBindingFromReceiptBackedLaunch },
    { reserveGameRuntimeMaterialization, withConsumedBindingExecution },
    { createHostGameRuntimeMaterializer },
    { loadHostDeploymentManifest },
    { resolveRuntimePaths, identityKey },
    { bindWindowsStaleLockReclaimer },
    { createBuildWindowsStaleLockReclaimer },
  ] = await Promise.all([
    import(new URL("local-stardew-bridge.js", base)),
    import(new URL("stardew-game-integration-adapter.js", base)),
    import(new URL("stardew-integration-launcher.js", base)),
    import(new URL("continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js", base)),
    import(
      new URL("continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js", base)
    ),
    import(
      new URL("continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js", base)
    ),
    import(new URL("deployment-manifest.js", base)),
    import(new URL("runtime-identity.js", base)),
    import(new URL("path-lock.js", base)),
    import(new URL("windows-stale-lock-reclaimer/index.js", base)),
  ]);
  return Object.freeze({
    LocalStardewBridgeClient,
    STARDEW_GAME_INTEGRATION_ADAPTER,
    createStardewIntegrationLaunchHandleFromAuthenticatedBridge,
    STARDEW_INTEGRATION_LAUNCHER,
    createGameRuntimeBindingFromReceiptBackedLaunch,
    reserveGameRuntimeMaterialization,
    withConsumedBindingExecution,
    createHostGameRuntimeMaterializer,
    loadHostDeploymentManifest,
    resolveRuntimePaths,
    identityKey,
    bindWindowsStaleLockReclaimer,
    createBuildWindowsStaleLockReclaimer,
  });
}

/**
 * The runtime root this run uses, with its principal already decided.
 *
 * ONE runtime root = ONE deployment identity, and the product's authority marker binds the `bootstrapOperationId`
 * that provisioned it: a SECOND run on an existing root must reuse the stored manifest instead of minting a fresh id,
 * and a stored manifest for a different principal is refused by name rather than silently re-provisioned
 * (the ladder learned both at `:1082-1106`).
 */
export async function prepareRuntimeRoot({ root, runtimeRoot, identity }) {
  await mkdir(join(runtimeRoot, "settings"), { recursive: true });
  const manifestPath = join(root, "manifest.json");
  const stored = await readFile(manifestPath, "utf8").then(
    (text) => JSON.parse(text),
    () => null,
  );
  if (stored === null) {
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        topology: "independent_chat_and_game_surfaces",
        runtimeRoot,
        principal: {
          continuityId: identity.continuityId,
          companionId: identity.companionId,
          playerId: identity.playerId,
        },
        bootstrapOperationId: `multiplayer-loop-${Date.now()}`,
        authorityGeneration: 1,
      }),
      "utf8",
    );
  } else {
    const principal = stored?.principal;
    const same =
      principal?.continuityId === identity.continuityId &&
      principal?.companionId === identity.companionId &&
      principal?.playerId === identity.playerId;
    if (!same)
      throw new Error(
        `runtime_root_principal_mismatch: the root was provisioned for continuity ${String(principal?.continuityId)} / companion ${String(principal?.companionId)} / player ${String(principal?.playerId)}; refusing to reuse it for ${identity.continuityId}`,
      );
  }
  return manifestPath;
}

/** The model profile a DISPOSABLE root needs before an Agent turn can run at all. */
export async function writeDisposableModelProfile(runtimeRoot) {
  const path = join(runtimeRoot, "settings", "model-profiles.json");
  if (existsSync(path)) return false;
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      chat: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
      game: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
    }),
    "utf8",
  );
  return true;
}

/** The provider credential the runtime reads from its agent dir; absent is a named refusal, never a silent degrade. */
export async function writeAgentCredential(runtimePaths) {
  const key = process.env.CPA_OAI_API_KEY;
  if (typeof key !== "string" || key.length === 0) throw new Error("CPA_OAI_API_KEY_missing");
  await mkdir(runtimePaths.agentDir, { recursive: true });
  await writeFile(
    join(runtimePaths.agentDir, "auth.json"),
    JSON.stringify({ "cpa-oai": { type: "api_key", key } }),
    "utf8",
  );
}

/** A prompt built from the free allocation; an empty allocation means "do whatever you think is worth doing". */
export function allocationPrompt(allocation) {
  const tasks = Array.isArray(allocation)
    ? allocation.filter((task) => typeof task === "string" && task.trim() !== "")
    : [];
  const footer =
    "你是陪玩家一起玩的伙伴，不是任务播报员——不要每一步都插旁白，也不要用清单式汇报。说话的台词之外可以用括号写情绪（同伴会演成语气而非念出来）；身体动作请调用 express_emote / face_direction 等游戏内动作，不要写星号动作。";
  if (tasks.length === 0)
    return `现在是星露谷的一天，你独自在农场里。今天没有人给你派活——你自己看看周围，想做什么就做什么，能做几件做几件（地里的农活、农场上的杂物、屋里的箱子和机器都算）。做完之后用两三句话跟玩家说说：哪些做成了、哪些做不了或者卡住了、卡在哪里（总共控制在 120 字以内）。${footer}`;
  return `现在是星露谷的一天。玩家交给你的任务是：\n- ${tasks.join("\n- ")}\n用游戏工具一步步按真实结果完成；做完后用两三句话跟玩家说说结果与卡住的地方（总共控制在 120 字以内）。${footer}`;
}

/**
 * The whole agent-driven run, against an already-armed shared world.
 *
 * Why it connects its OWN client instead of the smoke harness's: the launch handle needs a client that was connected
 * WITH the integration adapter, and the harness calls `LocalStardewBridgeClient.connect(scope, pipe, token)` with three
 * arguments (`stardew-native-smoke-harness-v1.mjs:438`) while the ladder passes the adapter as the fourth. Reusing the
 * harness's client here would fail at launch-handle creation, so this path connects exactly as the ladder does.
 */
export async function runAgentDrivenLoop({
  config,
  allocation,
  traceDir,
  onFact,
  runtimeRoot: configuredRuntimeRoot = process.env.GAMEBUDDY_LOOP_RUNTIME_ROOT ?? undefined,
  companionLocale = "zh-CN",
  turnTimeoutMs = 600_000,
}) {
  const host = await loadHostBuild();
  const scope = Object.freeze({
    integrationId: "stardew",
    saveId: config.SaveId,
    worldId: config.WorldId,
    playerId: config.PlayerId,
    companionId: config.CompanionId,
  });
  const client = await host.LocalStardewBridgeClient.connect(
    scope,
    config.PipeName,
    config.BridgeToken,
    host.STARDEW_GAME_INTEGRATION_ADAPTER,
  );
  const unsubscribeFact = typeof onFact === "function" ? client.onFact(onFact) : () => {};
  try {
    const disposable = typeof configuredRuntimeRoot !== "string" || configuredRuntimeRoot.length === 0;
    const root = disposable ? await mkdtemp(join(tmpdir(), "gamebuddy-multiplayer-agent-")) : configuredRuntimeRoot;
    const runtimeRoot = disposable ? join(root, "runtime") : root;
    await mkdir(join(runtimeRoot, "settings"), { recursive: true });
    const identity = Object.freeze({
      playerId: config.PlayerId,
      companionId: config.CompanionId,
      continuityId: `multiplayer-loop-${Date.now()}`,
      saveId: config.SaveId,
      worldId: config.WorldId,
    });
    const manifestPath = await prepareRuntimeRoot({ root, runtimeRoot, identity });
    if (disposable) await writeDisposableModelProfile(runtimeRoot);
    // The context directory is `contexts/<identityKey>` — the product's own derivation, NOT the raw continuity id.
    // Measured: using `continuityId` directly made `provisionLiveRunPersona` refuse with
    // `live_run_persona_runtime_cwd_mismatch` (`persona.mjs:220`), because that module resolves the path itself and
    // compares it with the cwd it was handed. The ladder does the same thing at its own call site.
    const personaCwd = join(runtimeRoot, "contexts", host.identityKey(identity));
    await mkdir(personaCwd, { recursive: true });
    await provisionLiveRunPersona(personaCwd, { identity, root: runtimeRoot });
    const personaMounted = await assertLiveRunPersonaMounted(personaCwd, { identity, root: runtimeRoot });
    if (!personaMounted.ok) throw new Error(`live_run_persona_not_mounted:${personaMounted.problems.join(",")}`);

    const materialized = await materializeGameRuntime({
      client,
      identity,
      config,
      runtimeRoot,
      manifestPath,
      companionLocale,
      loadHostBuild: async () => host,
      hostBuild: host,
    });
    const prompt = allocationPrompt(allocation);
    const turn = await runAgentTurnWithTools(materialized.runtime, prompt, {
      runtimeRoot,
      identity: host.identityKey(identity),
      timeoutMs: turnTimeoutMs,
    });
    const agentTurns = turn.turns;
    return Object.freeze({
      agentTurns: Object.freeze(agentTurns),
      personaMounted: Object.freeze({
        name: personaMounted.name,
        worldBookEntries: personaMounted.worldBookEntries,
        macroTokens: personaMounted.macroTokens,
      }),
      prompt,
      admitted: turn.admitted,
      settled: turn.settled,
    });
  } finally {
    unsubscribeFact();
  }
}

/** The Agent's own spoken lines, in the rubric's shape. Only assistant text counts; tool calls are not speech. */
export function turnsFromAgentMessages(messages) {
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "assistant") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const spoken = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text.trim())
      .filter((part) => part.length > 0)
      .join(" ");
    if (spoken === "") continue;
    turns.push({ turnId: `agent_${turns.length + 1}`, text: spoken });
  }
  return turns;
}
export async function materializeGameRuntime({
  client,
  identity,
  config,
  runtimeRoot,
  manifestPath,
  companionLocale,
  onCompanionTextPresented,
  loadHostBuild: injectedHostBuild,
  hostBuild,
  deadlineMs = Date.now() + 600_000,
}) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0)
    throw new Error("agent_runtime_manifest_path_required");
  // `hostBuild` is the LOADED module object; `loadHostBuild` is the loader. An earlier version injected the loader
  // under a name it then used as the object, which surfaced as `host.createBuildWindowsStaleLockReclaimer is not a
  // function` on the first real Agent run.
  const host = hostBuild ?? injectedHostBuild ?? (await loadHostBuild());
  host.bindWindowsStaleLockReclaimer(await host.createBuildWindowsStaleLockReclaimer());

  const launch = await host.createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, identity, {
    module: host.STARDEW_GAME_INTEGRATION_ADAPTER,
  });
  const deploymentManifest = await host.loadHostDeploymentManifest(manifestPath);
  const gameSessionId = `game-${Date.now()}`;
  const runtimePaths = host.resolveRuntimePaths(identity, runtimeRoot, gameSessionId);
  await mkdir(runtimePaths.agentDir, { recursive: true });
  await writeAgentCredential(runtimePaths);

  const binding = await host.createGameRuntimeBindingFromReceiptBackedLaunch({
    manifest: deploymentManifest,
    launcher: host.STARDEW_INTEGRATION_LAUNCHER,
    launch,
    expectedWorld: Object.freeze({ saveId: config.SaveId, worldId: config.WorldId }),
  });

  const runtime = await binding.executeWithBinding((bindingToken) =>
    host.withConsumedBindingExecution(bindingToken, (execution) => {
      const permit = Object.freeze({
        principal: execution.principal,
        operationId: `op-${Date.now()}`,
        requestId: `req-${Date.now()}`,
        kind: "enter",
        gameSessionId,
        world: execution.world,
        bindingDigest: execution.bindingFacts.bindingDigest,
        owner: execution.bindingFacts.owner,
        deadlineAtMs: deadlineMs,
        expected: Object.freeze({ partitionRevision: 1, gameRevision: 0, leaseRevision: 0, fenceEpoch: 1 }),
        payloadDigest: "a".repeat(64),
        fenceToken: `fence-${Date.now()}`,
        prepared: Object.freeze({ partitionRevision: 2, gameRevision: 0, leaseRevision: 1, fenceEpoch: 2 }),
      });
      return host
        .createHostGameRuntimeMaterializer({
          gameOperationalGateNonceSha256: "a".repeat(64),
          companionLocale,
          onCompanionTextPresented,
        })
        .materializeEnter(host.reserveGameRuntimeMaterialization(execution), permit);
    }),
  );
  if (runtime.connected === undefined) throw new Error("agent_runtime_not_connected");
  // `materializeEnter` may hand back either the runtime itself or a `{ runtime, turnTracker, clearAuthoredContext }`
  // envelope. Measured on a real run: assuming the envelope made `runtime.session.subscribe` throw while the pipe
  // handshake had ALREADY completed, so the failure looked like a connection problem when it was a shape assumption.
  // Unwrapping tolerantly is the honest fix; guessing one shape is what produced the bug.
  const connectedRuntime =
    runtime.connected === undefined && runtime.runtime?.connected !== undefined ? runtime.runtime : runtime;
  if (connectedRuntime.connected === undefined) throw new Error("agent_runtime_not_connected");
  return Object.freeze({ runtime: connectedRuntime, envelope: runtime, binding, gameSessionId, launch });
}

/**
 * One Agent turn, through the runtime's OWN input channel.
 *
 * The channel is `tools.acceptPlayerText(text, locale)` -- the same entry a human player's chat reaches
 * (`run-stardew-native-local-agent-ab-live.mjs:680-685`) -- NOT a session subscription. Measured: assuming a
 * `runtime.session` cost three live runs, because the materialized runtime's real keys are `receipt, piSessionId,
 * connected, teardownClose, close` (memory #4325). The transcript is read from the Pi session file the runtime
 * wrote, so what the rubric grades is what the Agent actually said.
 */
export async function runAgentTurnWithTools(
  runtime,
  prompt,
  { runtimeRoot, identity, locale = "zh-CN", timeoutMs = 900_000, quietMs = 20_000 } = {},
) {
  const tools = runtime.connected?.host;
  if (tools === undefined) throw new Error(`agent_runtime_tools_missing:keys=${Object.keys(runtime).join(",")}`);
  const admission = await submitPlayerPrompt({
    accept: (text, promptLocale) => tools.acceptPlayerText(text, promptLocale),
    text: prompt,
    locale,
    timeoutMs: Math.min(timeoutMs, 90_000),
  });
  if (admission.accepted !== true)
    return Object.freeze({ admitted: false, refusal: admission.lastRefusal ?? "unknown", turns: Object.freeze([]) });
  // Wait for the turn to settle and then for the session to go QUIET: a terminal receipt can make the Agent act
  // again (the ladder learned this at `:723-729`), so stopping at the first activity would cut a recovering turn
  // short. The quiet test is the transcript growing, which is the only Agent-authored signal available here.
  const startedAtMs = Date.now();
  let lastGrowthAtMs = startedAtMs;
  let seen = 0;
  while (Date.now() - startedAtMs < timeoutMs) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    const turns = readAgentTurns({ runtimeRoot, identity, piSessionId: runtime.piSessionId });
    if (turns.length !== seen) {
      seen = turns.length;
      lastGrowthAtMs = Date.now();
      continue;
    }
    if (Date.now() - lastGrowthAtMs >= quietMs) break;
  }
  const turns = readAgentTurns({ runtimeRoot, identity, piSessionId: runtime.piSessionId });
  return Object.freeze({ admitted: true, turns: Object.freeze(turns), settled: turns.length > 0, prompt });
}

/**
 * The Agent's own spoken lines, read from the Pi session files under the runtime cwd
 * (recursive .jsonl files under surface-sessions; the ladder's `findAgentSessionJsonl` does the same lookup).
 */
export function readAgentTurns({ runtimeRoot, identity, piSessionId }) {
  const candidates = [];
  const collect = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith(".jsonl")) candidates.push(path);
    }
  };
  for (const base of [join(runtimeRoot, "surface-sessions"), join(runtimeRoot, "contexts")]) {
    if (existsSync(base)) collect(base);
  }
  const scoped =
    typeof piSessionId === "string" && piSessionId.length > 0
      ? candidates.filter((path) => path.includes(piSessionId))
      : [];
  const pool = scoped.length > 0 ? scoped : candidates;
  const turns = [];
  for (const path of pool) {
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/u)) {
      if (line.trim() === "") continue;
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
      if (spoken === "") continue;
      turns.push({ turnId: `agent_${turns.length + 1}`, text: spoken });
    }
  }
  return turns;
}
