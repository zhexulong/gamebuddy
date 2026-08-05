#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDeterministicBridgePair } from "../host/dist/bridge.js";
import { CompanionIntegrationClient } from "../host/dist/integration.js";
import { STARDEW_INTEGRATION_MODULE } from "../host/dist/stardew-integration-module.js";
import { newEnvelope } from "../host/dist/protocol.js";
import { createCompanionRuntime } from "../host/dist/runtime.js";

const repoRoot = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const root = await mkdtemp(join(tmpdir(), "gamebuddy-gameplay-subagent-model-trace-"));
const scope = Object.freeze({ integrationId: "stardew", saveId: "save_trace", worldId: "world_trace", playerId: "farmhand_trace", companionId: "companion_trace" });
const identity = Object.freeze({ playerId: scope.playerId, saveId: scope.saveId, worldId: scope.worldId, companionId: scope.companionId });
const [host, mod] = createDeterministicBridgePair(scope);
const integration = new CompanionIntegrationClient(scope, host, STARDEW_INTEGRATION_MODULE);
const observedBridgeRequests = [];
let revision = 12;
let currentTool = "(T)Axe";

function snapshot() {
  return {
    revision,
    location: "Farm",
    tile: { x: 10, y: 12 },
    stamina: 250,
    health: 100,
    actionable: true,
    currentTool,
    inventorySlots: 12,
    capabilities: ["equip_tool"],
    activeExecution: null,
  };
}

mod.onMessage((message) => {
  const now = Date.now();
  if (message.type === "hello") {
    mod.send(newEnvelope("hello_ack", scope, { sessionId: "subagent_trace_session", capabilities: ["equip_tool"] }, message.correlationId, now), now);
    return;
  }
  if (message.type === "observe_request") {
    mod.send(newEnvelope("snapshot", scope, snapshot(), message.correlationId, now), now);
    return;
  }
  if (message.type === "execution_request") {
    observedBridgeRequests.push({ action: message.payload.action, expectedRevision: message.payload.expectedRevision });
    const selected = message.payload.action === "equip_tool" && message.payload.args.slot === 3;
    const before = currentTool;
    if (selected) currentTool = "(T)Pickaxe";
    revision += 1;
    mod.send(newEnvelope("execution_receipt", scope, {
      executionId: "subagent_trace_execution",
      requestId: message.payload.requestId,
      state: selected ? "succeeded" : "failed",
      reasonCode: selected ? "tool_selected" : "tool_not_owned_in_slot",
      revision,
      evidence: { before, expected: selected ? "(T)Pickaxe" : null, after: currentTool },
    }, message.correlationId, now), now);
    mod.send(newEnvelope("snapshot", scope, snapshot(), message.correlationId, now), now);
  }
});

let runtime;
try {
  integration.hello("a".repeat(16));
  integration.observe();
  runtime = await createCompanionRuntime(
    identity,
    root,
    integration,
    { provider: "cpa-oai", modelId: "deepseek-v4-flash", thinkingLevel: "high" },
    undefined,
    undefined,
    true,
  );
  const parentTools = runtime.session.agent.state.tools.map((tool) => tool.name).sort();
  const child = runtime.gameplaySubagent;
  if (child === undefined) throw new Error("gameplay_subagent_not_materialized");
  const result = await child.run([
    "Privately perform one bounded task.",
    "First call stardew_observe.",
    "Then select slot 3 with stardew_equip_tool and verify its authoritative receipt.",
    "Finally call report_to_parent with state completed only if the receipt succeeded and its before, expected, and after evidence is complete.",
    "Do not speak to a player.",
  ].join(" "));
  const receipt = integration.state.latestReceipt;
  const report = result.report;
  const resultSummary = {
    state: result.state,
    reportState: typeof report?.state === "string" ? report.state : null,
    reportReasonCode: typeof report?.reasonCode === "string" ? report.reasonCode : null,
  };
  const passed = runtime.session.agent.state.model?.provider === "cpa-oai"
    && runtime.session.agent.state.model?.id === "deepseek-v4-flash"
    && runtime.session.agent.state.thinkingLevel === "high"
    && child.modelConfig.provider === "cpa-oai"
    && child.modelConfig.modelId === "gpt-5.6-luna"
    && child.modelConfig.thinkingLevel === "medium"
    && parentTools.includes("delegate_game_task")
    && !parentTools.some((name) => name === "companion_speak" || name === "companion_text")
    && observedBridgeRequests.some((request) => request.action === "equip_tool")
    && receipt?.state === "succeeded"
    && receipt.reasonCode === "tool_selected"
    && result.state === "completed"
    && resultSummary.reportState === "completed";
  console.log(JSON.stringify({
    state: passed ? "passed" : "blocked",
    parentModel: { provider: runtime.session.agent.state.model?.provider ?? null, model: runtime.session.agent.state.model?.id ?? null, thinkingLevel: runtime.session.agent.state.thinkingLevel },
    gameplaySubagentModel: child.modelConfig,
    parentTools,
    childPresentationToolsExposedToParent: parentTools.filter((name) => name === "companion_speak" || name === "companion_text"),
    observedBridgeRequests,
    receipt: receipt === null ? null : { state: receipt.state, reasonCode: receipt.reasonCode, evidenceComplete: receipt.evidence !== null && ["before", "expected", "after"].every((key) => typeof receipt.evidence?.[key] === "string" && receipt.evidence[key].length > 0) },
    result: resultSummary,
  }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 256) : "gameplay_subagent_trace_failed" }));
  process.exitCode = 1;
} finally {
  runtime?.gameplaySubagent?.dispose();
  runtime?.session.dispose();
  integration.dispose();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
