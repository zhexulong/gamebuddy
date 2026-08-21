import test from "node:test";
import assert from "node:assert/strict";
import { createLifecycleFsm, type LifecycleState } from "./lifecycle-fsm.js";

test("Monoidal Law: Cancel during Starting window immediately transitions to Terminal and aborts native activation", async () => {
  const fsm = createLifecycleFsm();

  let nativeSpawned = false;
  const startPromise = fsm.start(async (signal) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (signal.aborted) return;
    nativeSpawned = true;
  });

  const cancelResult = fsm.cancel("user_cancelled");

  assert.equal(cancelResult.state, "terminal");
  assert.equal(cancelResult.reasonCode, "user_cancelled");

  await startPromise;
  assert.equal(nativeSpawned, false, "Native process MUST NOT spawn after starting-window cancel");
  assert.equal(fsm.currentState, "terminal");
});

test("Normal Lifecycle with Draining: uninitialized -> starting -> active -> draining -> terminal", async () => {
  const fsm = createLifecycleFsm();
  assert.equal(fsm.currentState, "uninitialized");

  await fsm.start(async () => {});
  assert.equal(fsm.currentState, "active");

  const drainResult = fsm.drain("session_draining");
  assert.equal(drainResult.state, "draining");
  assert.equal(fsm.currentState, "draining");

  const completeResult = fsm.complete("session_ended");
  assert.equal(completeResult.state, "terminal");
  assert.equal(fsm.currentState, "terminal");
});

test("Invalid State Guard: Calling start when already starting or active throws error", async () => {
  const fsm = createLifecycleFsm();
  await fsm.start(async () => {});

  await assert.rejects(
    async () => fsm.start(async () => {}),
    /invalid_start_state:active/
  );
});

test("Model-Based Property: Generated command sequences maintain state machine invariants and terminal irreversibility", async () => {
  const commands = ["start", "drain", "complete", "cancel", "invalid_start"] as const;

  for (let seed = 1; seed <= 100; seed++) {
    const fsm = createLifecycleFsm();
    let wasTerminal = false;

    let s = seed;
    const nextRand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
    const stepCount = Math.floor(nextRand() * 6) + 1;

    for (let i = 0; i < stepCount; i++) {
      const cmd = commands[Math.floor(nextRand() * commands.length)]!;

      if (wasTerminal) {
        assert.equal(fsm.currentState, "terminal", "Terminal state must be strictly irreversible");
      }

      switch (cmd) {
        case "start":
          if (fsm.currentState === "uninitialized") {
            await fsm.start(async () => {});
          }
          break;
        case "invalid_start":
          if (fsm.currentState !== "uninitialized") {
            await assert.rejects(async () => fsm.start(async () => {}), /invalid_start_state/);
          }
          break;
        case "drain":
          fsm.drain("test_drain");
          break;
        case "complete":
          fsm.complete("test_complete");
          wasTerminal = true;
          break;
        case "cancel":
          fsm.cancel("test_cancel");
          wasTerminal = true;
          break;
      }

      const validStates: readonly LifecycleState[] = ["uninitialized", "starting", "active", "draining", "terminal"];
      assert.ok(validStates.includes(fsm.currentState));
    }
  }
});

test("Non-abort exception in start action transitions to Terminal and rethrows error", async () => {
  const fsm = createLifecycleFsm();
  await assert.rejects(
    async () =>
      fsm.start(async () => {
        throw new Error("unexpected_native_boot_failure");
      }),
    /unexpected_native_boot_failure/
  );
  assert.equal(fsm.currentState, "terminal");
});

test("Asynchronous Race PBT: Concurrent start and cancel always resolve to terminal with aborted signal", async () => {
  for (let delay = 0; delay <= 20; delay += 5) {
    const fsm = createLifecycleFsm();
    let signalSawAbort = false;

    const startTask = fsm.start(async (signal) => {
      await new Promise((res) => setTimeout(res, 30));
      signalSawAbort = signal.aborted;
    });

    await new Promise((res) => setTimeout(res, delay));
    fsm.cancel("race_cancel");

    await startTask;
    assert.equal(fsm.currentState, "terminal");
    assert.equal(signalSawAbort, true);
  }
});
