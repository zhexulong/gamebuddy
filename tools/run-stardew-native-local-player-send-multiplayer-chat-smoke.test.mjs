import assert from "node:assert/strict";
import test from "node:test";

import { assertSendMultiplayerChatPostconditions } from "./run-stardew-native-local-player-send-multiplayer-chat-smoke.mjs";

/**
 * The send_multiplayer_chat live judgement, tested DIRECTLY.
 *
 * This suite tests the pure postcondition function with no transport at all, so
 * each case is a way the LIVE run could lie. It is a companion to the runner that
 * actually drives a Farmhand bridge.
 *
 * THIS DEED MUST RUN ON THE FARMHAND SIDE: the action's SUCCESS terminal requires
 * a true client (or server) of a live LAN lobby, so on a single-player native-local
 * fixture it can only ever be refused (`chat_multiplayer_only`) - a green receipt
 * there would be a false green. Run the runner against the A-ai-client instance of
 * the two-process lane that `tools/start-farmhand-launcher.ps1` starts; the offline
 * tests below only judge the same facts the live runner feeds them.
 */

const TERMINAL = {
  state: "succeeded",
  reasonCode: "chat_message_sent",
  revision: 3,
};

const EVIDENCE = {
  recipient: "all_players",
  length: "31",
  role: "client",
  sent: "true",
};

const RATE_LIMIT_TERMINAL = {
  state: "rejected",
  reasonCode: "chat_rate_limited",
  revision: 3,
};

const RATE_LIMIT_EVIDENCE = {
  retry_after_ms: "1942",
  minimum_interval_ms: "2000",
};

test("the honest happy path passes every check", () => {
  const checks = assertSendMultiplayerChatPostconditions({
    terminal: TERMINAL,
    evidence: EVIDENCE,
    rateLimitTerminal: RATE_LIMIT_TERMINAL,
    rateLimitEvidence: RATE_LIMIT_EVIDENCE,
  });
  assert.deepEqual(checks, {
    terminalSucceeded: true,
    recipientAllPlayers: true,
    sentTrue: true,
    lengthPositive: true,
    roleIsClientOrServer: true,
    rateLimitRefusedByName: true,
    rateLimitCarriesRetryAfterMs: true,
  });
});

test("a terminal that was refused is never a green receipt", () => {
  const checks = assertSendMultiplayerChatPostconditions({
    terminal: { ...TERMINAL, state: "rejected", reasonCode: "chat_multiplayer_only" },
    evidence: { ...EVIDENCE, role: "none" },
    rateLimitTerminal: RATE_LIMIT_TERMINAL,
    rateLimitEvidence: RATE_LIMIT_EVIDENCE,
  });
  assert.equal(checks.terminalSucceeded, false);
  assert.equal(checks.roleIsClientOrServer, false);
});

test("evidence missing a key fails closed", () => {
  const checks = assertSendMultiplayerChatPostconditions({
    terminal: TERMINAL,
    evidence: { recipient: "all_players", length: "31", role: "client" },
    rateLimitTerminal: RATE_LIMIT_TERMINAL,
    rateLimitEvidence: RATE_LIMIT_EVIDENCE,
  });
  assert.equal(checks.sentTrue, false);
});

test("a recipient other than the whole lobby fails", () => {
  const checks = assertSendMultiplayerChatPostconditions({
    terminal: TERMINAL,
    evidence: { ...EVIDENCE, recipient: "player_42" },
    rateLimitTerminal: RATE_LIMIT_TERMINAL,
    rateLimitEvidence: RATE_LIMIT_EVIDENCE,
  });
  assert.equal(checks.recipientAllPlayers, false);
});

test("a receipt claiming `sent=false` fails even with a green state", () => {
  const checks = assertSendMultiplayerChatPostconditions({
    terminal: TERMINAL,
    evidence: { ...EVIDENCE, sent: "false" },
    rateLimitTerminal: RATE_LIMIT_TERMINAL,
    rateLimitEvidence: RATE_LIMIT_EVIDENCE,
  });
  assert.equal(checks.sentTrue, false);
});

test("a zero-length line fails: the Mod would have refused it as invalid", () => {
  const checks = assertSendMultiplayerChatPostconditions({
    terminal: TERMINAL,
    evidence: { ...EVIDENCE, length: "0" },
    rateLimitTerminal: RATE_LIMIT_TERMINAL,
    rateLimitEvidence: RATE_LIMIT_EVIDENCE,
  });
  assert.equal(checks.lengthPositive, false);
});

test("a third role - not client and not server - fails", () => {
  const checks = assertSendMultiplayerChatPostconditions({
    terminal: TERMINAL,
    evidence: { ...EVIDENCE, role: "observer" },
    rateLimitTerminal: RATE_LIMIT_TERMINAL,
    rateLimitEvidence: RATE_LIMIT_EVIDENCE,
  });
  assert.equal(checks.roleIsClientOrServer, false);
});

test("a second send that is NOT refused fails the negative check", () => {
  const checks = assertSendMultiplayerChatPostconditions({
    terminal: TERMINAL,
    evidence: EVIDENCE,
    rateLimitTerminal: { ...TERMINAL, state: "succeeded", reasonCode: "chat_message_sent" },
    rateLimitEvidence: { minimum_interval_ms: "2000" },
  });
  assert.equal(checks.rateLimitRefusedByName, false);
  assert.equal(checks.rateLimitCarriesRetryAfterMs, false);
});

test("a rate-limit refusal without a retry_after_ms fails the negative check", () => {
  const checks = assertSendMultiplayerChatPostconditions({
    terminal: TERMINAL,
    evidence: EVIDENCE,
    rateLimitTerminal: RATE_LIMIT_TERMINAL,
    rateLimitEvidence: { minimum_interval_ms: "2000" },
  });
  assert.equal(checks.rateLimitRefusedByName, true);
  assert.equal(checks.rateLimitCarriesRetryAfterMs, false);
});