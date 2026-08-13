import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { connectLocalCompanion } = await loadHostProductionModule("local-bootstrap.js");

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
const runtimeRoot = process.argv.includes("--runtime-root")
  ? option("--runtime-root")
  : await mkdtemp(join(tmpdir(), "gamebuddy-stardew-context-reentry-"));
const keepRuntime = process.argv.includes("--keep-runtime");
const firstPrompt = option(
  "--first-prompt",
  "Observe the current live Farmhand snapshot and keep a short todo recording only the current location and tool. Do not perform a Game Action.",
);
const secondPrompt = option(
  "--second-prompt",
  "You have re-entered the same Stardew world. Observe the new live snapshot, compare it with the prior context without treating old facts as current, and update the todo. Do not perform a Game Action.",
);

const config = JSON.parse(await readFile(clientConfigPath, "utf8"));
const required = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
if (required.some((key) => typeof config[key] !== "string" || config[key].length === 0))
  throw new Error("invalid_client_config");
const identity = {
  playerId: config.PlayerId,
  saveId: config.SaveId,
  worldId: config.WorldId,
  companionId: config.CompanionId,
};

const phases = [];
let connected;
try {
  connected = await connectLocalCompanion({
    identity,
    pipeName: config.PipeName,
    bridgeToken: config.BridgeToken,
    runtimeRoot,
    modelConfig: { provider: "cpa-oai", modelId: "deepseek-v4-flash", thinkingLevel: "high" },
  });
  await waitForBootstrap(connected.runtime.session, 120_000);
  phases.push(await runTurn(connected, firstPrompt, "initial"));
  await connected.close();
  connected = undefined;

  connected = await connectWithRetry(
    {
      identity,
      pipeName: config.PipeName,
      bridgeToken: config.BridgeToken,
      runtimeRoot,
      modelConfig: { provider: "cpa-oai", modelId: "deepseek-v4-flash", thinkingLevel: "high" },
    },
    30_000,
  );
  await waitForBootstrap(connected.runtime.session, 120_000);
  phases.push(await runTurn(connected, secondPrompt, "reentry"));

  const first = phases[0];
  const second = phases[1];
  const sameSessionFile = first.sessionFile !== null && first.sessionFile === second.sessionFile;
  const resumedPriorMessages = second.messagesBefore >= first.messagesAfter;
  const currentSnapshotAvailable = second.snapshotRevision !== null;
  const passed =
    sameSessionFile && resumedPriorMessages && currentSnapshotAvailable && phases.every((phase) => phase.settled);
  console.log(
    JSON.stringify({
      state: passed ? "passed" : "blocked",
      provider: "cpa-oai",
      model: "deepseek-v4-flash",
      thinkingLevel: "high",
      identity: {
        saveId: identity.saveId,
        worldId: identity.worldId,
        playerId: identity.playerId,
        companionId: identity.companionId,
      },
      runtimeRoot,
      sameSessionFile,
      resumedPriorMessages,
      currentSnapshotAvailable,
      phases,
      note: "This proves same-identity session re-entry and fresh live snapshot delivery. Save partition isolation remains covered by Host runtime tests; it does not claim a second live save was joined.",
    }),
  );
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode: redact(error instanceof Error ? error.message : String(error)),
      provider: "cpa-oai",
      model: "deepseek-v4-flash",
      thinkingLevel: "high",
      phases,
    }),
  );
  process.exitCode = 2;
} finally {
  if (connected !== undefined) await connected.close();
  if (!keepRuntime) await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function waitForBootstrap(session, timeoutMs) {
  if (session.isIdle && session.messages.length > 0) return;
  let settled = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_settled") settled = true;
  });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (settled && session.isIdle) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  } finally {
    unsubscribe();
  }
  throw new Error("bootstrap_agent_turn_timeout");
}

async function connectWithRetry(connection, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await connectLocalCompanion(connection);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("context_reentry_connect_timeout");
}

async function runTurn(connected, prompt, phase) {
  const agentTools = [];
  const agentEnds = [];
  let settled = false;
  let settledCount = 0;
  const messagesBefore = connected.runtime.session.messages.length;
  const unsubscribe = connected.runtime.session.subscribe((event) => {
    if (event.type === "tool_execution_start") agentTools.push(event.toolName);
    if (event.type === "agent_end") {
      const assistant = [...event.messages]
        .reverse()
        .find(
          (message) =>
            typeof message === "object" && message !== null && "role" in message && message.role === "assistant",
        );
      const record = assistant && typeof assistant === "object" ? assistant : undefined;
      agentEnds.push({
        stopReason: typeof record?.stopReason === "string" ? record.stopReason : null,
        errorMessage: typeof record?.errorMessage === "string" ? redact(record.errorMessage) : null,
      });
    }
    if (event.type === "agent_settled") {
      settledCount += 1;
      settled = connected.runtime.session.isIdle;
    }
  });
  try {
    await withTimeout(connected.host.acceptPlayerText(prompt), 90_000, `${phase}_enqueue_timeout`);
    await waitForSettled(connected.runtime.session, () => settledCount > 0 && settled, 120_000);
  } finally {
    unsubscribe();
  }
  return {
    phase,
    sessionFile: connected.runtime.session.sessionFile ?? null,
    messagesBefore,
    messagesAfter: connected.runtime.session.messages.length,
    snapshotRevision: connected.bridge.state.snapshot?.revision ?? null,
    agentTools,
    agentEnds,
    settled,
  };
}

async function waitForSettled(session, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate() && session.isIdle) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("agent_turn_timeout");
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

function redact(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/api[_-]?key[=: ]+\S+/gi, "api_key=<redacted>")
    .replace(/\s+/g, " ")
    .slice(0, 512);
}
