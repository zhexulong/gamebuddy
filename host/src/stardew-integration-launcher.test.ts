import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { TERMINAL_EXECUTION_STATES } from "./execution-correlation-ledger.js";
import { type MoveCapableIntegration } from "./game-tools.js";
import { type ExecutionWake } from "./integration-launcher.js";
import { type BridgeMessage, type ExecutionState, type Scope } from "./protocol.js";
import { parseStardewLauncherConfig, STARDEW_INTEGRATION_LAUNCHER } from "./stardew-integration-launcher.js";

const base = { pipeName: "gamebuddy_fixture", bridgeToken: "a".repeat(32) };
const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "farmhand_01",
  companionId: "companion_01",
};
const token = "launcher_test_token_123456";
const identity = {
  playerId: scope.playerId,
  companionId: scope.companionId,
  saveId: scope.saveId,
  worldId: scope.worldId,
};

test("Stardew launcher config accepts only a bounded BCP-47 expected presentation locale", () => {
  assert.equal(
    parseStardewLauncherConfig({ ...base, expectedPresentationLocale: "zh-CN" }).expectedPresentationLocale,
    "zh-CN",
  );
  assert.throws(
    () => parseStardewLauncherConfig({ ...base, expectedPresentationLocale: "zh CN" }),
    /invalid_stardew_launcher_config/,
  );
  assert.throws(
    () => parseStardewLauncherConfig({ ...base, expectedPresentationLocale: 1 }),
    /invalid_stardew_launcher_config/,
  );
});

test("Stardew launcher config rejects malformed knowledge before any bridge connection", () => {
  assert.throws(
    () => parseStardewLauncherConfig({ ...base, gameVersion: "1.6.15", knowledge: { bundleVersion: 1 } }),
    /invalid_knowledge_bundle/,
  );
  assert.throws(
    () => parseStardewLauncherConfig({ ...base, knowledge: { bundleVersion: 1 } }),
    /invalid_stardew_launcher_config/,
  );
  assert.throws(() => parseStardewLauncherConfig({ ...base, unexpected: true }), /invalid_stardew_launcher_config/);
});

test("Stardew launcher config keeps a version-bound validated knowledge bundle", () => {
  const config = parseStardewLauncherConfig({
    ...base,
    gameVersion: "1.6.15",
    knowledge: {
      bundleVersion: 1,
      integrationId: "stardew",
      gameVersion: "1.6.15",
      rules: [
        {
          id: "fixture_rule",
          integrationId: "stardew",
          gameVersion: "1.6.15",
          capability: "move_to_tile",
          text: "Use the current authoritative snapshot.",
        },
      ],
    },
  });
  assert.equal(config.knowledge?.rules.length, 1);
  assert.equal(config.knowledge?.gameVersion, "1.6.15");
});

test("Stardew launcher publishes one bounded terminal wake for every terminal receipt state", async () => {
  for (const state of TERMINAL_EXECUTION_STATES) {
    if (state === "invalidated") continue;
    const { launch, mod } = await launchWithFakeMod();
    try {
      assert.ok(launch.events.onExecutionWake);
      const wake = nextWake(launch.events.onExecutionWake);
      mod.sendInbound(receiptMessage(state));
      assert.deepEqual(await wake, {
        kind: "terminal",
        requestId: "request_1",
        executionId: "execution_1",
        state,
        reasonCode: `reason_${state}`,
      });
    } finally {
      launch.close();
      await mod.stop();
    }
  }
});

test("Stardew launcher never publishes an execution wake for progress receipts", async () => {
  for (const state of ["accepted", "running", "meaningful_progress"] as const) {
    const { launch, mod } = await launchWithFakeMod();
    try {
      assert.ok(launch.events.onExecutionWake);
      const wakes: ExecutionWake[] = [];
      launch.events.onExecutionWake((wake) => wakes.push(wake));
      mod.sendInbound(receiptMessage(state));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      assert.deepEqual(wakes, [], `${state} receipt must not publish a wake`);
    } finally {
      launch.close();
      await mod.stop();
    }
  }
});

test("Stardew launcher freezes the execution gate and publishes an invalidated wake on an invalidated receipt", async () => {
  const { launch, mod } = await launchWithFakeMod();
  try {
    assert.ok(launch.events.onExecutionWake);
    const wake = nextWake(launch.events.onExecutionWake);
    mod.sendInbound(receiptMessage("invalidated"));
    assert.deepEqual(await wake, { kind: "invalidated", reasonCode: "reason_invalidated" });
    assert.ok(launch.connection.executionGate);
    assert.equal(launch.connection.executionGate.executable, false);
    const connection = launch.connection as MoveCapableIntegration;
    await assert.rejects(
      () =>
        connection.execute({
          requestId: "request_2",
          idempotencyKey: "idem_2",
          action: "move_to_tile",
          args: {},
          expectedRevision: 1,
          deadlineMs: Date.now() + 5_000,
        }),
      /integration_not_ready/,
    );
  } finally {
    launch.close();
    await mod.stop();
  }
});

test("terminal receipts buffered before the Host listener mounts are replayed exactly once", async () => {
  const pipeName = `gamebuddy_launcher_buffered_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let peer: Socket | undefined;
  let sendInbound: ((message: unknown) => void) | undefined;
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(4 + length);
        if (message.type === "hello") {
          socket.write(
            frame({
              ...message,
              messageId: "mod_hello_buffered",
              type: "hello_ack",
              payload: { sessionId: "session_buffered", capabilities: [], presentationLocale: "en-US" },
            }),
          );
          // The terminal receipt is already on the wire before the Host can
          // mount its fact listener; the launcher must buffer and replay it.
          socket.write(frame(receiptMessage("blocked")));
        } else if (message.type === "observe_request") {
          socket.write(
            frame({
              ...message,
              messageId: "mod_snapshot_buffered",
              type: "snapshot",
              payload: snapshotPayload(1),
            }),
          );
        }
      }
    });
    sendInbound = (message: unknown) => socket.write(frame(message));
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  let launch: Awaited<ReturnType<typeof STARDEW_INTEGRATION_LAUNCHER.launch>> | undefined;
  try {
    launch = await connectAfterPipeListen(pipeName, () =>
      STARDEW_INTEGRATION_LAUNCHER.launch({ identity, config: { pipeName, bridgeToken: token } }),
    );
    const facts: string[] = [];
    launch.events.onFact((fact) => facts.push(`${fact.kind}:${fact.payload.state}`));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    assert.deepEqual(
      facts,
      ["execution_receipt:blocked"],
      "the buffered terminal receipt must be replayed exactly once",
    );
    // Receipts arriving after the mount flow directly and stay single-delivery.
    assert.ok(launch.events.onExecutionWake);
    const wake = nextWake(launch.events.onExecutionWake);
    sendInbound!(receiptMessage("failed"));
    assert.deepEqual(await wake, {
      kind: "terminal",
      requestId: "request_1",
      executionId: "execution_1",
      state: "failed",
      reasonCode: "reason_failed",
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    assert.deepEqual(facts, ["execution_receipt:blocked", "execution_receipt:failed"]);
  } finally {
    launch?.close();
    peer?.destroy();
    await close(server);
  }
});

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

function snapshotPayload(revision: number) {
  return {
    revision,
    location: "Farm",
    tile: { x: 5, y: 8 },
    stamina: 250,
    health: 100,
    actionable: true,
    capabilities: ["inspect_self"],
    presentationLocale: "en-US",
    activeExecution: null,
  };
}

let receiptSequence = 0;

/** A validated Mod-originated receipt frame; reasonCode is derived per state. */
function receiptMessage(state: ExecutionState): BridgeMessage {
  receiptSequence += 1;
  return {
    protocolVersion: 1,
    messageId: `mod_receipt_${receiptSequence}`,
    correlationId: `receipt_corr_${receiptSequence}`,
    timestampMs: Date.now(),
    scope,
    type: "execution_receipt",
    payload: {
      executionId: "execution_1",
      requestId: "request_1",
      state,
      reasonCode: `reason_${state}`,
      revision: 2,
      evidence: null,
    },
  };
}

type FakeMod = Readonly<{
  sendInbound(message: unknown): void;
  stop(): Promise<void>;
}>;

async function launchWithFakeMod(): Promise<{
  launch: Awaited<ReturnType<typeof STARDEW_INTEGRATION_LAUNCHER.launch>>;
  mod: FakeMod;
}> {
  const pipeName = `gamebuddy_launcher_wake_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let sendInbound: ((message: unknown) => void) | undefined;
  let peer: Socket | undefined;
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(4 + length);
        if (message.type === "hello")
          socket.write(
            frame({
              ...message,
              messageId: "mod_hello_wake",
              type: "hello_ack",
              payload: { sessionId: "session_wake", capabilities: ["inspect_self"], presentationLocale: "en-US" },
            }),
          );
        else if (message.type === "observe_request")
          socket.write(
            frame({
              ...message,
              messageId: "mod_snapshot_wake",
              type: "snapshot",
              payload: snapshotPayload(1),
            }),
          );
      }
    });
    sendInbound = (message: unknown) => socket.write(frame(message));
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  const launch = await connectAfterPipeListen(pipeName, () =>
    STARDEW_INTEGRATION_LAUNCHER.launch({ identity, config: { pipeName, bridgeToken: token } }),
  );
  return {
    launch,
    mod: Object.freeze({
      sendInbound: (message: unknown) => sendInbound!(message),
      stop: async () => {
        peer?.destroy();
        await close(server);
      },
    }),
  };
}

function isPipeListenerNotReady(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function connectAfterPipeListen<T>(pipeName: string, connect: () => Promise<T>): Promise<T> {
  const deadlineMs = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadlineMs) {
    try {
      return await connect();
    } catch (error) {
      lastError = error;
      if (!isPipeListenerNotReady(error)) throw error;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw lastError;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
}

function nextWake(onExecutionWake: (listener: (wake: ExecutionWake) => void) => () => void): Promise<ExecutionWake> {
  return new Promise<ExecutionWake>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("execution_wake_timeout")), 2_000);
    const unsubscribe = onExecutionWake((wake) => {
      clearTimeout(timer);
      unsubscribe();
      resolvePromise(wake);
    });
  });
}