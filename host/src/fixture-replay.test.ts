import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { type BridgeMessage, validateBridgeMessage } from "./protocol.js";
import { ReceiptReplayLedger } from "./receipt-replay.js";

test("language-neutral bridge-v1 golden sequence validates deterministically", async () => {
  const fixture = JSON.parse(
    await readFile(fileURLToPath(new URL("../../fixtures/bridge-v1/golden-sequence.json", import.meta.url)), "utf8"),
  ) as {
    nowMs: number;
    scope: BridgeMessage["scope"];
    messages: BridgeMessage[];
  };
  const results = fixture.messages.map((message) => validateBridgeMessage(message, fixture.scope, fixture.nowMs));
  assert.deepEqual(
    results,
    Array.from({ length: 9 }, () => null),
  );
  assert.equal(fixture.messages.filter((message) => message.type === "snapshot").length, 1);
  const states = fixture.messages
    .filter((message) => message.type === "execution_receipt")
    .map((message) => message.payload.state);
  assert.deepEqual(states, ["accepted", "running", "meaningful_progress", "succeeded"]);
  const ledger = new ReceiptReplayLedger();
  for (const message of fixture.messages) {
    if (message.type === "execution_receipt") assert.equal(ledger.apply(message.payload), null);
  }
  assert.equal(ledger.receipt("execution_01")?.state, "succeeded");
  assert.equal(fixture.messages.at(-1)?.type, "execution_receipt");
});
