import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSelectedHostProductionModule,
  selectHostProductionArtifact,
} from "./lib/host-production-module.mjs";
import { hasMatchingEquipToolEvidence } from "./lib/stardew-receipt-evidence.mjs";

const selectedProductionArtifact = await selectHostProductionArtifact();
const [{ connectLocalCompanion }, { loadKnowledgeBundle }] = await Promise.all([
  loadSelectedHostProductionModule(selectedProductionArtifact, "local-bootstrap.js"),
  loadSelectedHostProductionModule(selectedProductionArtifact, "knowledge.js"),
]);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing_${name.slice(2)}`);
  }
  if (index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const clientConfigPath = option("--client-config");
const traceOnly = process.argv.includes("--trace-only");
const knowledgeBundlePath = process.argv.includes("--knowledge-bundle") ? option("--knowledge-bundle") : undefined;
const gameVersion = process.argv.includes("--game-version") ? option("--game-version") : undefined;
const runtimeRoot = process.argv.includes("--runtime-root")
  ? option("--runtime-root")
  : await mkdtemp(join(tmpdir(), "gamebuddy-stardew-agent-"));
const modelId = option("--model", "deepseek-v4-flash");
const prompt = option(
  "--prompt",
  "Please help with the current farm situation. Observe the live world and choose one useful safe action from the capabilities the game currently exposes. If the facts support equipping an owned tool, decide which tool is useful, perform it, and verify the authoritative receipt. Do not assume a result and do not claim success without evidence.",
);

let connected;
let cleanupRuntime = !process.argv.includes("--keep-runtime");
const factTypes = [];
const agentTools = [];
const toolResults = [];
const actionReceipts = [];
const authoritativeReceipts = [];
const agentEnds = [];
const agentSettled = [];
let sessionError;
let settledCount = 0;
let eventCount = 0;
try {
  const config = JSON.parse(await readFile(clientConfigPath, "utf8"));
  const required = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
  if (required.some((key) => typeof config[key] !== "string" || config[key].length === 0))
    throw new Error("invalid_client_config");
  if (modelId !== "deepseek-v4-flash") throw new Error("invalid_agent_model");
  if ((knowledgeBundlePath === undefined) !== (gameVersion === undefined))
    throw new Error("knowledge_version_required");
  const knowledge =
    knowledgeBundlePath === undefined
      ? undefined
      : await loadKnowledgeBundle(resolve(knowledgeBundlePath), gameVersion);

  const identity = {
    playerId: config.PlayerId,
    saveId: config.SaveId,
    worldId: config.WorldId,
    companionId: config.CompanionId,
  };
  connected = await connectLocalCompanion({
    identity,
    pipeName: config.PipeName,
    bridgeToken: config.BridgeToken,
    runtimeRoot,
    modelConfig: { provider: "cpa-oai", modelId, thinkingLevel: "high" },
    gameplaySubagent: process.argv.includes("--enable-gameplay-subagent"),
    knowledge,
    gameVersion,
  });

  const unsubscribeFact = connected.bridge.onFact((fact) => {
    factTypes.push(fact.type);
    if (fact.type === "execution_receipt") authoritativeReceipts.push(fact.payload);
  });
  const unsubscribeAgent = connected.runtime.session.subscribe((event) => {
    eventCount += 1;
    if (event.type === "tool_execution_start") agentTools.push(event.toolName);
    if (event.type === "tool_execution_end") {
      const result = event.result;
      const text = Array.isArray(result?.content)
        ? result.content
            .filter((part) => part?.type === "text")
            .map((part) => redactError(part.text))
            .join(" ")
            .slice(0, 512)
        : null;
      toolResults.push({
        toolName: event.toolName,
        isError: Boolean(result?.isError),
        text,
      });
      if (
        event.toolName.startsWith("stardew_") &&
        ![
          "stardew_observe",
          "stardew_execution_status",
          "stardew_interaction_catalog",
          "stardew_search_interactions",
          "stardew_cancel_active_execution",
        ].includes(event.toolName)
      ) {
        const receipt = parseReceipt(result?.details, text);
        if (receipt !== null) actionReceipts.push({ toolName: event.toolName, ...receipt });
      }
    }
    if (event.type === "agent_end") {
      const assistant = [...event.messages]
        .reverse()
        .find(
          (message) =>
            typeof message === "object" && message !== null && "role" in message && message.role === "assistant",
        );
      const record = assistant && typeof assistant === "object" ? assistant : undefined;
      agentEnds.push({
        willRetry: event.willRetry,
        stopReason: typeof record?.stopReason === "string" ? record.stopReason : null,
        errorMessage: typeof record?.errorMessage === "string" ? redactError(record.errorMessage) : null,
      });
    }
    if (event.type === "agent_settled") {
      sessionError = connected.runtime.session.agent.state.errorMessage ?? null;
      settledCount += 1;
      agentSettled.push({
        count: settledCount,
        isIdle: connected.runtime.session.isIdle,
        error: sessionError === null ? null : redactError(sessionError),
      });
    }
  });
  try {
    const settledBeforePrompt = settledCount;
    await withTimeout(connected.host.acceptPlayerText(prompt), 90_000, "agent_turn_enqueue_timeout");
    await waitForAgentSettled(connected.runtime.session, () => settledCount > settledBeforePrompt, 120_000);
    if (
      agentTools.some(
        (toolName) =>
          toolName.startsWith("stardew_") &&
          ![
            "stardew_observe",
            "stardew_execution_status",
            "stardew_interaction_catalog",
            "stardew_search_interactions",
            "stardew_cancel_active_execution",
          ].includes(toolName),
      )
    ) {
      await waitForOwnedReceipt(actionReceipts, authoritativeReceipts, 30_000);
    }
  } finally {
    unsubscribeFact();
    unsubscribeAgent();
  }

  const state = connected.bridge.state;
  const equipEntry = [...actionReceipts].reverse().find((entry) => entry.toolName === "stardew_equip_tool");
  const receipt =
    equipEntry === undefined
      ? null
      : (findTerminalReceipt(authoritativeReceipts, equipEntry.receipt) ?? equipEntry.receipt);
  const evidence = receipt?.evidence;
  const evidenceDetail =
    evidence !== null && evidence !== undefined && typeof evidence === "object" && typeof evidence.detail === "string"
      ? evidence.detail
      : "";
  const evidenceComplete = hasMatchingEquipToolEvidence(evidenceDetail);
  // A trace-only diagnostic must never turn a failed/rejected/uncertain
  // receipt into a zero-exit success. It is allowed to prove only that the
  // expected observation/status/todo path ran and no action receipt claims
  // success; live action acceptance remains a separate gate.
  const traceTerminalReceipt =
    receipt === null || ["blocked", "cancelled", "expired", "failed", "rejected", "uncertain"].includes(receipt.state);
  const tracePassed =
    traceOnly &&
    agentTools.includes("stardew_observe") &&
    agentTools.includes("stardew_execution_status") &&
    agentTools.includes("todowrite") &&
    agentSettled.length > 0 &&
    traceTerminalReceipt;
  const passed = receipt?.state === "succeeded" && receipt.reasonCode === "tool_selected" && evidenceComplete;
  const summary = {
    state: passed ? "passed" : tracePassed ? "trace_passed" : "blocked",
    traceOnly,
    provider: "cpa-oai",
    model: modelId,
    thinkingLevel: "high",
    gameplaySubagent: process.argv.includes("--enable-gameplay-subagent")
      ? { provider: "cpa-oai", model: "gpt-5.6-luna", thinkingLevel: "medium" }
      : null,
    identity: {
      saveId: identity.saveId,
      worldId: identity.worldId,
      playerId: identity.playerId,
      companionId: identity.companionId,
    },
    snapshotRevision: state.snapshot?.revision ?? null,
    capabilities: [...state.capabilities],
    factTypes,
    agentTools,
    toolResults,
    agentEnds,
    agentSettled,
    actionReceipts,
    authoritativeReceipts,
    eventCount,
    sessionError: sessionError === undefined || sessionError === null ? null : redactError(sessionError),
    receipt:
      receipt === null
        ? null
        : {
            state: receipt.state,
            reasonCode: receipt.reasonCode,
            executionId: receipt.executionId,
            requestId: receipt.requestId,
            revision: receipt.revision,
            evidence: receipt.evidence,
          },
    evidenceComplete,
    evidenceDetail,
  };
  console.log(JSON.stringify(summary));
  if (!passed && !tracePassed) process.exitCode = 2;
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode: reason.replace(/\s+/g, " ").slice(0, 256),
      provider: "cpa-oai",
      model: modelId,
      thinkingLevel: "high",
      gameplaySubagent: process.argv.includes("--enable-gameplay-subagent")
        ? { provider: "cpa-oai", model: "gpt-5.6-luna", thinkingLevel: "medium" }
        : null,
      eventCount,
      settledCount,
      factTypes,
      agentTools,
      toolResults,
      agentEnds,
      agentSettled,
      actionReceipts,
      authoritativeReceipts,
      sessionError: sessionError === undefined || sessionError === null ? null : redactError(sessionError),
      bridge: {
        connected: connected?.bridge.state.connected ?? false,
        snapshotRevision: connected?.bridge.state.snapshot?.revision ?? null,
        latestReceipt: connected?.bridge.state.latestReceipt?.state ?? null,
        latestReasonCode: connected?.bridge.state.latestReasonCode ?? null,
      },
    }),
  );
  process.exitCode = 2;
} finally {
  if (connected !== undefined) await connected.close();
  if (cleanupRuntime) await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function waitForAgentSettled(session, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate() && session.isIdle) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("agent_turn_timeout");
}

async function waitForOwnedReceipt(actionReceipts, authoritativeReceipts, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const entry of actionReceipts) {
      const receipt = findTerminalReceipt(authoritativeReceipts, entry.receipt);
      if (receipt !== null) return receipt;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("authoritative_receipt_timeout");
}

function findTerminalReceipt(authoritativeReceipts, ownedReceipt) {
  const receipt = [...authoritativeReceipts]
    .reverse()
    .find(
      (candidate) =>
        candidate.requestId === ownedReceipt.requestId &&
        candidate.executionId === ownedReceipt.executionId &&
        isTerminalReceipt(candidate.state),
    );
  return receipt ?? null;
}

function isTerminalReceipt(state) {
  return [
    "blocked",
    "invalidated",
    "succeeded",
    "partially_succeeded",
    "failed",
    "cancelled",
    "expired",
    "rejected",
    "uncertain",
  ].includes(state);
}

function parseReceipt(details, fallbackText) {
  const raw = details?.receiptJson;
  if (typeof raw === "string") {
    try {
      const value = JSON.parse(raw);
      if (
        value &&
        typeof value === "object" &&
        typeof value.requestId === "string" &&
        typeof value.executionId === "string" &&
        typeof value.state === "string"
      )
        return { receipt: value };
    } catch {}
  }
  if (typeof fallbackText === "string") {
    try {
      const value = JSON.parse(fallbackText);
      if (
        value &&
        typeof value === "object" &&
        typeof value.requestId === "string" &&
        typeof value.executionId === "string" &&
        typeof value.state === "string"
      )
        return { receipt: value };
    } catch {}
  }
  return null;
}

async function withTimeout(promise, timeoutMs, reasonCode) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(reasonCode)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function redactError(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/api[_-]?key[=: ]+\S+/gi, "api_key=<redacted>")
    .replace(/\s+/g, " ")
    .slice(0, 512);
}
