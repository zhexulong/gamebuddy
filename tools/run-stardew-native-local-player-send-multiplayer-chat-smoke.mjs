import {
  assertRequiredCapabilities,
  classifyTopology,
  connectNativeLocalClient,
  delay,
  executeFresh,
  observeTopologySnapshot,
  readNativeClientConfig,
  summarizeReceipt,
  validateNativeLocalFixturePolicy,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "send_multiplayer_chat";
const REQUIRED_CAPABILITIES = [ACTION];

/**
 * send_multiplayer_chat live contract, proven ONLY on the farmhand side of the
 * two-process lane (the A-ai-client game instance, a TRUE CLIENT of the A-host
 * server) that `tools/start-farmhand-launcher.ps1` starts.
 *
 * THIS RUNNER MUST RUN THERE. On a single-player native-local fixture the engine's
 * own topology gate (`Game1.IsClient` / `Game1.IsServer`, farmhandexecutioncontroller.chatactions.cs)
 * can only answer `chat_multiplayer_only`, so on that lane the action is only ever
 * REFUSED and a green receipt would be a false green. Only a process inside a live
 * LAN lobby - the farmhand client - can make the game's own egress accept the send.
 *
 * The terminal proves the SEND and nothing more: the line reached the game's own
 * chat egress (`Multiplayer.sendChatMessage(language, text, AllPlayers)`) without
 * throwing. The receipt never claims anyone READ the line, and this runner asserts
 * exactly that claim - the Mod-authored evidence, verbatim.
 *
 * The checks, each a real fact:
 *   1. the live snapshot advertises `send_multiplayer_chat`;
 *   2. a fresh request dispatches `{ action, args: { text }, timeoutMs: 30000 }`;
 *   3. the terminal is `succeeded` with reason `chat_message_sent`;
 *   4. the evidence says `recipient=all_players`, `sent=true`, a positive `length`,
 *      and a `role` of `client` or `server` - never a third side;
 *   5. NEGATIVE: a second send inside the Mod's own 2000 ms minimum interval is
 *      refused BY NAME (`chat_rate_limited`) and the refusal carries `retry_after_ms`;
 *      the runner then WAITS that interval and proves the same ledger admits again.
 *   6. a passed run returns `{ state: "passed", reasonCode: "chat_message_sent", trace, checks }`.
 *
 * Topology plumbing: the farmhand reads as `shared_world_farmhand` (its config
 * carries `FarmhandProvisioner.Enable`), so the shared-world harness modes are used
 * - `observeTopologySnapshot` tolerates the bridge's deliberate refusal to re-admit
 * a revision it already admitted, and `assertRequiredCapabilities` is the
 * required-subset capability check for a live consented surface. A bare
 * `observeFresh` / strict exact-surface capability mode (the single-player
 * fixtures) is refused here on purpose: this lane cannot pass them and must
 * never be run against them.
 */
export async function runSendMultiplayerChatSmoke(client, receipts, config, { terminalTimeoutMs = 5_000 } = {}) {
  const topology = classifyTopology(config);
  if (topology !== "shared_world_farmhand")
    throw new Error(`send_multiplayer_chat_smoke_requires_farmhand_topology:${topology}`);
  validateNativeLocalFixturePolicy(config, { requiredActions: [] });

  const trace = [];
  const opening = await observeTopologySnapshot(client, topology, { actionable: true });
  assertRequiredCapabilities(opening, REQUIRED_CAPABILITIES);
  trace.push({ step: "capability", topology, action: ACTION });

  const primary = await dispatchChat(client, opening, "primary", "Hello from the senior farmhand.");
  trace.push({ step: "primary", receipt: summarizeReceipt(primary) });
  const primaryTerminal = await waitForTerminal(receipts, primary, terminalTimeoutMs);
  const primaryEvidence = parseChatEvidence(primaryTerminal.evidence);
  trace.push({ step: "primary_terminal", executionId: primaryTerminal.executionId, terminal: summarizeReceipt(primaryTerminal), evidence: primaryEvidence });

  // The negative half: immediately after a send the same Mod-owned ledger refuses
  // another one by NAME, before the game's egress is ever consulted.
  const beforeRateProbe = await observeTopologySnapshot(client, topology, { actionable: true });
  const rateProbe = await dispatchChat(client, beforeRateProbe, "rate_limit_probe", "Second line, expected inside the minimum interval.");
  trace.push({ step: "rate_limit_probe", receipt: summarizeReceipt(rateProbe) });
  const limitedTerminal = await waitForTerminal(receipts, rateProbe, terminalTimeoutMs);
  const limitedEvidence = parseChatEvidence(limitedTerminal.evidence);
  trace.push({ step: "rate_limit_terminal", terminal: summarizeReceipt(limitedTerminal), evidence: limitedEvidence });

  // WAIT the interval the refusal named, then prove the same ledger admits again.
  // The refusal arms the Mod's interval per ACCEPTED attempt only
  // (`this.lastChatSendUnixMs = nowMs` runs after the limiter), so the wait is
  // the refusal's own number plus a clock-safety margin.
  const retryAfterMs = Number(limitedEvidence.retry_after_ms);
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)
    throw new Error(`invalid_send_multiplayer_chat_retry_after:${limitedEvidence.retry_after_ms}`);
  trace.push({ step: "waiting_interval", retryAfterMs });
  await delay(Math.max(retryAfterMs, 1) + 250);

  const beforeAgain = await observeTopologySnapshot(client, topology, { actionable: true });
  const again = await dispatchChat(client, beforeAgain, "after_interval", "Third line, after the interval.");
  trace.push({ step: "after_interval", receipt: summarizeReceipt(again) });
  const againTerminal = await waitForTerminal(receipts, again, terminalTimeoutMs);
  const againEvidence = parseChatEvidence(againTerminal.evidence);
  trace.push({ step: "after_interval_terminal", terminal: summarizeReceipt(againTerminal), evidence: againEvidence });

  const checks = {
    ...assertSendMultiplayerChatPostconditions({
      terminal: primaryTerminal,
      evidence: primaryEvidence,
      rateLimitTerminal: limitedTerminal,
      rateLimitEvidence: limitedEvidence,
    }),
    sendsAgainAfterInterval: againTerminal.state === "succeeded" && againTerminal.reasonCode === "chat_message_sent",
  };

  const failures = Object.entries(checks)
    .filter(([, ok]) => ok === false)
    .map(([name]) => name);
  if (failures.length > 0)
    throw new Error(`send_multiplayer_chat live contract failed: ${failures.join(",")};trace=${JSON.stringify(trace)}`);

  return { state: "passed", reasonCode: "chat_message_sent", trace, checks };
}

/**
 * The live contract's judgement, as a PURE function so it can be tested without a
 * transport: the primary terminal and its parsed evidence, plus the rate-limit
 * terminal and its parsed evidence. It never fakes a bridge; the runner feeds it
 * facts it actually observed and it is exercised directly in the sibling test.
 *
 * `length` and `retry_after_ms` are Mod-authored evidence strings
 * (`length=31`, `retry_after_ms=1984`), so they are compared as positive integers
 * rather than as verbatim strings - a `length` of `"0"` or a `retry_after_ms` of
 * `"0"` fails closed.
 */
export function assertSendMultiplayerChatPostconditions({ terminal, evidence, rateLimitTerminal, rateLimitEvidence }) {
  const length = Number(evidence?.length);
  const retryAfterMs = Number(rateLimitEvidence?.retry_after_ms);
  return {
    terminalSucceeded: terminal?.state === "succeeded" && terminal?.reasonCode === "chat_message_sent",
    recipientAllPlayers: evidence?.recipient === "all_players",
    sentTrue: evidence?.sent === "true",
    lengthPositive: Number.isInteger(length) && length > 0,
    roleIsClientOrServer: evidence?.role === "client" || evidence?.role === "server",
    rateLimitRefusedByName:
      rateLimitTerminal?.state === "rejected" && rateLimitTerminal?.reasonCode === "chat_rate_limited",
    rateLimitCarriesRetryAfterMs: Number.isInteger(retryAfterMs) && retryAfterMs > 0,
  };
}

/** One fresh, revision-bound chat dispatch with a fresh request id. */
async function dispatchChat(client, snapshot, phase, text) {
  const requestId = `native_local_send_multiplayer_chat_${phase}_${Date.now()}`;
  return await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: { text },
    snapshot,
    timeoutMs: 30_000,
  });
}

/** `key=value;key=value` — the Mod's evidence shape (`{"detail": "..."}` on the wire). */
function parseChatEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("send_multiplayer_chat_evidence_empty");
  const values = {};
  for (const field of detail.split(";")) {
    const at = field.indexOf("=");
    if (at <= 0) throw new Error("invalid_send_multiplayer_chat_evidence");
    const key = field.slice(0, at);
    const value = field.slice(at + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(values, key))
      throw new Error("invalid_send_multiplayer_chat_evidence");
    values[key] = value;
  }
  return values;
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runSendMultiplayerChatSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}