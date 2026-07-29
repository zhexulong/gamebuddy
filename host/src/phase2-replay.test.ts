import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { type BridgeMessage, validateBridgeMessage } from "./protocol.js";
import { ReceiptReplayLedger } from "./receipt-replay.js";

test("Phase 2 terminal replay covers blocked/cancelled, failed, and evidence-backed success", async () => {
  const fixture = JSON.parse(await readFile(fileURLToPath(new URL("../../fixtures/bridge-v1/phase2-terminal-replay.json", import.meta.url)), "utf8")) as {
    nowMs: number; scope: BridgeMessage["scope"]; messages: BridgeMessage[];
  };
  const ledger = new ReceiptReplayLedger();
  for (const message of fixture.messages) {
    assert.equal(validateBridgeMessage(message, fixture.scope, fixture.nowMs), null);
    assert.equal(message.type, "execution_receipt");
    if (message.type === "execution_receipt") assert.equal(ledger.apply(message.payload), null);
  }
  assert.equal(ledger.receipt("exec_cancel")?.state, "cancelled");
  assert.equal(ledger.receipt("exec_fail")?.state, "failed");
  assert.equal(ledger.receipt("exec_success")?.state, "succeeded");
});
