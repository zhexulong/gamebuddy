import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  PRODUCTION_GAME_TASK_INGRESS_SCHEMA,
  createProductionGameTaskIngressController,
  parseProductionGameTaskDispatch,
  parseProductionGameTaskReady,
} from "./production-game-task-ingress.internal.js";

const nonceSha256 = "a".repeat(64);
const readyFields = {
  schema: PRODUCTION_GAME_TASK_INGRESS_SCHEMA,
  kind: "ready" as const,
  surface: "game" as const,
  nonceSha256,
  gameSessionId: "game_session_01",
  piSessionId: "pi_session_01",
};

function transportHarness() {
  const emitter = new EventEmitter();
  let readyMessage: unknown;
  let readyCallback: ((error: Error | null) => void) | undefined;
  let removeMessageCalls = 0;
  let removeDisconnectCalls = 0;
  const transport = {
    sendReady(message: unknown, callback: (error: Error | null) => void) {
      readyMessage = message;
      readyCallback = callback;
      return true;
    },
    onMessage(listener: (message: unknown) => void) {
      emitter.on("message", listener);
      return () => {
        removeMessageCalls += 1;
        emitter.off("message", listener);
      };
    },
    onDisconnect(listener: () => void) {
      emitter.on("disconnect", listener);
      return () => {
        removeDisconnectCalls += 1;
        emitter.off("disconnect", listener);
      };
    },
  };
  return {
    transport,
    get readyMessage() {
      return readyMessage;
    },
    deliverReady(error: Error | null = null) {
      readyCallback?.(error);
    },
    dispatch(message: unknown) {
      emitter.emit("message", message);
    },
    disconnect() {
      emitter.emit("disconnect");
    },
    get removeMessageCalls() {
      return removeMessageCalls;
    },
    get removeDisconnectCalls() {
      return removeDisconnectCalls;
    },
  };
}

function dispatchFields(task: string) {
  return { ...readyFields, kind: "dispatch_task" as const, task };
}

test("child readiness is sealed until the send callback succeeds and preserves the exact task", async () => {
  const h = transportHarness();
  const calls: string[] = [];
  const controller = createProductionGameTaskIngressController({
    ...readyFields,
    transport: h.transport,
    dispatchTask: async (task) => {
      calls.push(task);
    },
  });
  const starting = controller.start();
  assert.deepEqual(h.readyMessage, readyFields);
  assert.equal(controller.state(), "sealed");
  h.dispatch(dispatchFields("too early"));
  await assert.rejects(starting, /before_ready/);
  await assert.rejects(controller.fatal, /before_ready/);
  assert.equal(controller.state(), "closing");
  assert.equal(calls.length, 0);

  const second = transportHarness();
  const task = "走到 🌾 chest — wait 😀";
  const secondController = createProductionGameTaskIngressController({
    ...readyFields,
    transport: second.transport,
    dispatchTask: async (value) => {
      calls.push(value);
    },
  });
  const ready = secondController.start();
  second.deliverReady();
  await ready;
  assert.equal(secondController.state(), "ready");
  second.dispatch(dispatchFields(task));
  await secondController.task;
  assert.deepEqual(calls, [task]);
  assert.equal(secondController.state(), "consumed");
});

test("wrong correlation, malformed records, duplicate delivery, worker failure, and disconnect are fatal", async () => {
  for (const invalid of [
    { ...readyFields, extra: true },
    { ...readyFields, __proto__: { forged: true } },
  ]) assert.equal(parseProductionGameTaskReady(invalid), null);
  assert.equal(parseProductionGameTaskDispatch({ ...dispatchFields("task"), extra: true }), null);
  assert.equal(parseProductionGameTaskDispatch({ ...dispatchFields("\ud800") }), null);

  const h = transportHarness();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const controller = createProductionGameTaskIngressController({
    ...readyFields,
    transport: h.transport,
    dispatchTask: async () => {
      calls += 1;
      await pending;
    },
  });
  const ready = controller.start();
  h.deliverReady();
  await ready;
  h.dispatch({ ...dispatchFields("first"), nonceSha256: "b".repeat(64) });
  await assert.rejects(controller.fatal, /correlation_mismatch/);
  assert.equal(calls, 0);
  assert.equal(h.removeMessageCalls, 1);
  assert.equal(h.removeDisconnectCalls, 1);

  const foreignGame = transportHarness();
  const foreignGameController = createProductionGameTaskIngressController({
    ...readyFields,
    transport: foreignGame.transport,
    dispatchTask: async () => { calls += 1; },
  });
  const foreignGameReady = foreignGameController.start();
  foreignGame.deliverReady();
  await foreignGameReady;
  foreignGame.dispatch({ ...dispatchFields("first"), gameSessionId: "foreign_game" });
  await assert.rejects(foreignGameController.fatal, /correlation_mismatch/);
  assert.equal(calls, 0);

  const foreignPi = transportHarness();
  const foreignPiController = createProductionGameTaskIngressController({
    ...readyFields,
    transport: foreignPi.transport,
    dispatchTask: async () => { calls += 1; },
  });
  const foreignPiReady = foreignPiController.start();
  foreignPi.deliverReady();
  await foreignPiReady;
  foreignPi.dispatch({ ...dispatchFields("first"), piSessionId: "foreign_pi" });
  await assert.rejects(foreignPiController.fatal, /correlation_mismatch/);
  assert.equal(calls, 0);
  assert.equal(h.removeMessageCalls, 1);
  assert.equal(h.removeDisconnectCalls, 1);

  const duplicate = transportHarness();
  const duplicateController = createProductionGameTaskIngressController({
    ...readyFields,
    transport: duplicate.transport,
    dispatchTask: async () => pending,
  });
  const duplicateReady = duplicateController.start();
  duplicate.deliverReady();
  await duplicateReady;
  duplicate.dispatch(dispatchFields("first"));
  duplicate.dispatch(dispatchFields("second"));
  await assert.rejects(duplicateController.fatal, /duplicate/);
  await assert.rejects(duplicateController.task, /duplicate/);
  release();

  const failed = transportHarness();
  const failedController = createProductionGameTaskIngressController({
    ...readyFields,
    transport: failed.transport,
    dispatchTask: async () => {
      throw new Error("worker_failed");
    },
  });
  const failedReady = failedController.start();
  failed.deliverReady();
  await failedReady;
  failed.dispatch(dispatchFields("task"));
  await assert.rejects(failedController.fatal, /worker_failed/);
  await assert.rejects(failedController.task, /worker_failed/);
  failed.dispatch(dispatchFields("replay"));
  assert.equal(failedController.state(), "closing");

  const disconnected = transportHarness();
  const disconnectedController = createProductionGameTaskIngressController({
    ...readyFields,
    transport: disconnected.transport,
    dispatchTask: async () => undefined,
  });
  const disconnectedReady = disconnectedController.start();
  disconnected.deliverReady();
  await disconnectedReady;
  disconnected.disconnect();
  await assert.rejects(disconnectedController.fatal, /disconnect/);
});

test("close races remove both listeners and reject an admitted task without replay", async () => {
  const h = transportHarness();
  let calls = 0;
  const controller = createProductionGameTaskIngressController({
    ...readyFields,
    transport: h.transport,
    dispatchTask: async () => {
      calls += 1;
      await new Promise<void>(() => undefined);
    },
  });
  const ready = controller.start();
  h.deliverReady();
  await ready;
  h.dispatch(dispatchFields("task"));
  controller.close();
  await assert.rejects(controller.task, /closed/);
  assert.equal(calls, 1);
  assert.equal(h.removeMessageCalls, 1);
  assert.equal(h.removeDisconnectCalls, 1);
});
