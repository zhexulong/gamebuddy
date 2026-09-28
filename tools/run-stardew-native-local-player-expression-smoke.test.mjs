import assert from "node:assert/strict";
import test from "node:test";
import { runExpressionSmoke } from "./run-stardew-native-local-player-expression-smoke.mjs";

const config = {
  NativeLocalPlayerFixture: { Enable: true },
  Portfolio: { Enable: false },
  HostAutomation: { Enable: false },
  HostFarmhandProvisioning: { Enable: false },
  FarmhandProvisioner: { Enable: false },
};

function capabilitySnapshot(revision) {
  return {
    revision,
    location: "Farm",
    tile: { x: 3, y: 3 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "express_emote", "face_direction"],
    catalogRevision: 1,
  };
}

/**
 * Both actions are exercised in one turn. The fake client advances the revision
 * per execution so the monotonic-revision proof is real, and the receipts buffer
 * carries the Mod-owned terminal for each request exactly as production does.
 */
function expressionClient({ nativeDispatched = "true", emoteReason = "emote_started", immediateTerminal = false } = {}) {
  let revision = 10;
  const client = {
    state: { snapshot: capabilitySnapshot(revision), latestReceipt: undefined },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      revision += 1;
      // Production returns the immediate acceptance, then the terminal arrives
      // on the receipts stream. The fake must keep that shape or it would not
      // exercise the same wait-for-terminal path the runner uses.
      const accepted = {
        requestId: request.requestId,
        executionId: request.action === "express_emote" ? "exec-emote" : "exec-facing",
        state: "accepted",
        reasonCode: "accepted",
        revision,
      };
      client.state.snapshot = capabilitySnapshot(revision);
      const terminal = {
        ...accepted,
        state: "succeeded",
        reasonCode: request.action === "express_emote" ? emoteReason : "actor_facing_matches",
        evidence: {
          detail:
            request.action === "express_emote"
              ? `emote=${request.args.emote};native_dispatched=${nativeDispatched}`
              : `direction=${request.args.direction}`,
        },
      };
      client.state.latestReceipt = accepted;
      client.terminals.push(terminal);
      // A synchronous action may return its terminal receipt as the immediate
      // bridge response rather than an interim acceptance.
      return immediateTerminal ? terminal : accepted;
    },
    terminals: [],
  };
  return client;
}

test("expression runner proves both native receipts and monotonic revisions", async () => {
  const client = expressionClient();
  const result = await runExpressionSmoke(client, client.terminals, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "emote_started");
  assert.equal(result.emote.requested, "happy");
  assert.equal(result.emote.evidence.nativeDispatched, true);
  assert.equal(result.facing.reasonCode, "actor_facing_matches");
  assert.equal(result.facing.requested, "left");
  // Two distinct executions, one per action.
  assert.equal(result.executions.emote, "exec-emote");
  assert.equal(result.executions.facing, "exec-facing");
  assert.notEqual(result.executions.emote, result.executions.facing);
  assert.equal(result.trace.length, 2);
  assert.ok(result.facingReceipt.revision > result.receipt.revision);
});

test("expression runner blocks when the Mod did not dispatch the emote natively", async () => {
  // An emote that did not arm natively must not be accepted as evidence.
  const client = expressionClient({ nativeDispatched: "false" });
  const result = await runExpressionSmoke(client, client.terminals, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "express_emote_native_not_dispatched");
});

test("expression runner blocks on an unexpected emote terminal reason", async () => {
  const client = expressionClient({ emoteReason: "emote_busy" });
  const result = await runExpressionSmoke(client, client.terminals, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "express_emote_failed:emote_busy");
});

test("expression runner blocks when the capability face omits an expression action", async () => {
  const client = expressionClient();
  client.observe = async () => ({ ...capabilitySnapshot(10), capabilities: ["express_emote"] });
  const result = await runExpressionSmoke(client, client.terminals, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_local_face_direction_capability_missing");
});

test("expression runner refuses a non-isolated fixture topology", async () => {
  const client = expressionClient();
  const result = await runExpressionSmoke(client, client.terminals, {
    ...config,
    Portfolio: { Enable: true },
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_local_fixture_topology_not_isolated");
});

test("expression runner accepts a bridge that answers with the terminal receipt directly", async () => {
  // Observed on a real run: a native emote arms synchronously, so the bridge
  // answered `succeeded/emote_started` as the immediate response instead of an
  // interim `accepted`. The runner originally required `accepted` and reported
  // `express_emote_not_accepted:emote_started` even though the Mod had already
  // performed the native mutation successfully. Both shapes must pass.
  const client = expressionClient({ immediateTerminal: true });
  const result = await runExpressionSmoke(client, client.terminals, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "emote_started");
  assert.equal(result.receipt.reasonCode, "emote_started");
});

test("expression runner blocks on malformed Mod evidence", async () => {
  const client = expressionClient();
  const original = client.execute;
  client.execute = async (request) => {
    const accepted = await original(request);
    if (request.action === "express_emote") {
      const terminal = client.terminals[client.terminals.length - 1];
      terminal.evidence = { detail: "emote=happy" };
    }
    return accepted;
  };
  const result = await runExpressionSmoke(client, client.terminals, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "invalid_express_emote_evidence");
});
