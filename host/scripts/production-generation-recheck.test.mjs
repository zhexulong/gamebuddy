import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { installProductionGenerationRecheckService } from "./production-generation-recheck.mjs";

class FakeChild extends EventEmitter {
  constructor() { super(); this.connected = true; this.sent = []; }
  send(message) { this.sent.push(message); }
}
const schema = "gamebuddy-production-generation-recheck/v1";
const request = (requestId, phase) => ({ schema, kind: "recheck_current_generation", requestId, phase });

async function drain() { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); }

test("generation recheck service serializes exact direct-child PRE/POST requests and redacts replies", async () => {
  const child = new FakeChild();
  const seen = [];
  installProductionGenerationRecheckService({ child, hostRoot: "private", selected: Object.freeze({}), recheck: async ({ hostRoot, selected }) => {
    seen.push({ hostRoot, selected });
  } });
  child.emit("message", request("a", "pre"));
  child.emit("message", request("b", "post"));
  await drain();
  assert.equal(seen.length, 2);
  assert.deepEqual(child.sent, [
    { schema, kind: "recheck_current_generation_result", requestId: "a", phase: "pre", verdict: "verified" },
    { schema, kind: "recheck_current_generation_result", requestId: "b", phase: "post", verdict: "verified" },
  ]);
  for (const response of child.sent) assert.deepEqual(Object.keys(response).sort(), ["kind", "phase", "requestId", "schema", "verdict"]);
});

test("generation recheck service rejects wrong-phase requests without invoking the selected-generation verifier", async () => {
  const child = new FakeChild();
  let calls = 0;
  installProductionGenerationRecheckService({ child, hostRoot: "private", selected: Object.freeze({}), recheck: async () => {
    calls++;
  } });

  child.emit("message", { schema, kind: "recheck_current_generation", requestId: "wrong-phase", phase: "before" });
  await drain();
  assert.equal(calls, 0);
  assert.deepEqual(child.sent, []);
});

test("generation recheck service fails closed for malformed, duplicate, rejected and disconnected requests", async () => {
  const child = new FakeChild();
  let calls = 0;
  installProductionGenerationRecheckService({ child, hostRoot: "private", selected: Object.freeze({}), recheck: async () => {
    calls++;
    throw new Error("details must not cross IPC");
  } });
  child.emit("message", {});
  child.emit("message", request("wrong phase", "before"));
  child.emit("message", request("x", "pre"));
  child.emit("message", request("x", "pre"));
  await drain();
  assert.equal(calls, 1);
  assert.deepEqual(child.sent, [{ schema, kind: "recheck_current_generation_result", requestId: "x", phase: "pre", verdict: "rejected" }]);
  child.connected = false;
  child.emit("disconnect");
  child.emit("message", request("after", "post"));
  await drain();
  assert.equal(child.sent.length, 1);
});
