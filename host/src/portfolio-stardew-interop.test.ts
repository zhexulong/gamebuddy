import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Readable } from "node:stream";
import test from "node:test";

import { PortfolioStardewBridgeClient } from "./portfolio-stardew-bridge.js";
import {
  computePortfolioBindingHash,
  PORTFOLIO_INTEGRATION_ID,
  PORTFOLIO_TOPOLOGY,
  type PortfolioBootstrapIdentity,
  type PortfolioScope,
} from "./portfolio-protocol.js";

// Standalone compiled C# Portfolio peer contract (supplied by the C# lane;
// this file is its Node-side consumer and exercises the real Host client):
//
// - Binary: GAMEBUDDY_PORTFOLIO_INTEROP_PEER_DLL (full path) when set,
//   otherwise integrations/stardew/tests/bin/Release/net6.0/
//   PortfolioStardewInterop.Contract.dll. A path ending in ".exe" is executed
//   directly; any other path is run with `dotnet <path>`.
// - Invocation: <peer> <pipe-name> <mode> with mode "success" or "cancel";
//   cwd is the repository root; stdin is ignored; stdout carries only the two
//   contract lines below; stderr must stay empty; exit code 0 after the
//   strict session disconnects.
// - The peer must create a Windows named-pipe server for <pipe-name> and
//   print exactly one stdout line "portfolio_stardew_interop_ready" once it
//   is listening.
// - Framing: the same 4-byte little-endian length + JSON envelope framing
//   used by PortfolioStardewBridgeClient (see portfolio-transport.ts);
//   envelope timestamps within five minutes, opaque messageId/correlationId,
//   camelCase JSON, scope equality on every non-bootstrap envelope.
// - Fixed fixture: token "portfolio_stardew_interop_token_1234", identity
//   save_01/world_01/player_01/companion_01, binding generation 1 with the
//   real binding hash (ComputeBindingHash over the documented canonical
//   string with game 1.6.15 build 24356), initial world revision 1, snapshot
//   state "ready" (worldReady/singlePlayer/currentLocalPlayerMatches true).
// - Shared sequence over two sequential client connections:
//   1. bootstrap connection: bootstrap_hello (bootstrap scope, generation 0)
//      -> bootstrap_hello_ack {sessionId, bindingGeneration:1, bindingHash}
//      whose envelope scope is the full generation-1 scope with the real
//      binding hash; the client then closes this socket.
//   2. strict successor connection: hello -> hello_ack (payload generation
//      and hash must equal the full scope); observe_request -> snapshot
//      (revision 1); mine_elevator_request (selectedCheckpoint 10,
//      expectedRevision 1, deadline within 30 minutes, cancellation token
//      "cancel_interop_mine_elevator_1") -> exactly one mine_elevator_phase
//      "accepted" (revision 1, reason "accepted") echoing the request
//      correlationId. The client fails closed if any phase other than
//      "accepted" precedes the receipt or if the receipt arrives before
//      acceptance; therefore transition_started/postcondition/terminal are
//      never separate wire frames.
// - Scenario "success" (terminal drain): the peer drives the pure
//   state-machine transition/postcondition observations to a succeeded
//   terminal and delivers mine_elevator_receipt (state "succeeded", revision
//   3, reason "mine_elevator_floor_selected", same correlationId/executionId)
//   through the exact private compiled
//   ModEntry.DrainPortfolioMineElevatorTerminalDeliveries over the real pipe;
//   the first drain arms the generation-bound completion and the second drain
//   dequeues the delivery (the ack). evidence.phaseTrace is exactly
//   fresh_observed(1)/accepted(1)/transition_started(2)/postcondition(3)/
//   terminal(3) with entryObserved/nativeElevatorTransitionObserved/
//   lowestMineLevelObserved true, currentFloorBefore 0, lowestMineLevelBefore
//   10, opaqueElevatorTarget "elevator_target_01", currentFloorAfter 10,
//   lowestMineLevelAfter 10, postcondition
//   selectedCheckpoint/actualCurrentFloor/observedLowestMineLevel 10,
//   freshObservation true, sameExecution true.
// - Scenario "cancel" (accepted-then-cancel): the real Host calls
//   cancelMineElevator with the exact accepted execution identity and the
//   same cancellation token. The peer feeds the raw frame to the exact
//   compiled private ModEntry.HandlePortfolioMineElevatorCancel handler
//   (compiled PortfolioBridgeSession.TryCancelMineElevator -> compiled
//   coordinator.Cancel); the compiled coordinator fail-closes the cancel as a
//   direct mine_elevator_receipt (state "uncertain", reasonCode
//   "native_operation_uncertain", revision 1, evidence.phaseTrace exactly
//   fresh_observed(1)/accepted(1)/terminal(1) with entryObserved true,
//   nativeElevatorTransitionObserved false, currentFloorBefore 0,
//   lowestMineLevelBefore 10, opaqueElevatorTarget "elevator_target_01",
//   currentFloorAfter 0, lowestMineLevelAfter 0, lowestMineLevelObserved
//   false, postcondition selectedCheckpoint 10 / actualCurrentFloor 0 /
//   observedLowestMineLevel 0 / freshObservation false / sameExecution
//   false). The client settles the cancel promise AND the original terminal
//   exactly once with the same cancelled lifecycle identity (structurally
//   equal receipts).
// - Delivery proof: after the scenario receipt frame write has completed the
//   peer prints exactly one scenario stdout line
//   "portfolio_stardew_interop_success_receipt_delivered" (success, only
//   after the second drain dequeued the delivery) or
//   "portfolio_stardew_interop_cancel_receipt_delivered" (cancel), then keeps
//   the strict connection open until the client disconnects and exits 0.
//   Protocol violations or timeouts exit nonzero with a stderr diagnostic.
//   No other stdout/stderr content.

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const defaultPeerPath = resolve(
  repositoryRoot,
  "integrations/stardew/tests/bin/Release/net6.0/PortfolioStardewInterop.Contract.dll",
);
const attestedMode = process.env.GAMEBUDDY_PORTFOLIO_INTEROP_ATTESTED === "1";
const peerPath = process.env.GAMEBUDDY_PORTFOLIO_INTEROP_PEER_DLL ?? defaultPeerPath;
const peerAvailable = existsSync(peerPath);

async function assertAttestedPeerBinding(): Promise<void> {
  if (!attestedMode) return;
  assert.equal(process.platform, "win32", "attested interop contract requires Windows named pipes");
  assert.equal(
    process.env.GAMEBUDDY_PORTFOLIO_INTEROP_PEER_DLL,
    undefined,
    "attested interop contract must use the freshly built default peer",
  );
  assert.equal(peerPath, defaultPeerPath, "attested interop contract peer path must be canonical");
  const expectedHash = process.env.GAMEBUDDY_PORTFOLIO_INTEROP_PEER_SHA256;
  assert.match(expectedHash ?? "", /^[a-f0-9]{64}$/, "attested interop peer digest must be supplied");
  const actualHash = createHash("sha256").update(await readFile(peerPath)).digest("hex");
  assert.equal(actualHash, expectedHash, "attested interop peer digest mismatch");
}

const identity: PortfolioBootstrapIdentity = {
  saveId: "save_01",
  worldId: "world_01",
  localPlayerId: "player_01",
  companionId: "companion_01",
};
const bindingGeneration = 1;
const bindingHash = computePortfolioBindingHash({ ...identity, bindingGeneration });
const scope: PortfolioScope = {
  integrationId: PORTFOLIO_INTEGRATION_ID,
  topology: PORTFOLIO_TOPOLOGY,
  ...identity,
  bindingGeneration,
  bindingHash,
};
const token = "portfolio_stardew_interop_token_1234";
const requestId = "request_interop_mine_elevator";
const traceId = "trace_interop_mine_elevator";
const cancellationToken = "cancel_interop_mine_elevator_1";

type InteropScenario = "success" | "cancel" | "ladder_success";

const scenarioReadyMarker = "portfolio_stardew_interop_ready";
const scenarioDeliveryMarkers: Record<InteropScenario, string> = {
  success: "portfolio_stardew_interop_success_receipt_delivered",
  cancel: "portfolio_stardew_interop_cancel_receipt_delivered",
  ladder_success: "portfolio_stardew_interop_ladder_success_receipt_delivered",
};

type InteropProcess = ChildProcessByStdio<null, Readable, Readable>;

function spawnPeer(pipeName: string, mode: InteropScenario): InteropProcess {
  const directExecutable = peerPath.toLowerCase().endsWith(".exe");
  const command = directExecutable ? peerPath : "dotnet";
  const args = directExecutable ? [pipeName, mode] : [peerPath, pipeName, mode];
  return spawn(command, args, {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as InteropProcess;
}

async function waitForLine(
  process: InteropProcess,
  expected: string,
  observed: string[],
  stderr?: Buffer[],
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let poll: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            `interop_helper_ready_timeout:${observed.join(",")} stderr=${stderr ? Buffer.concat(stderr).toString("utf8") : ""}`,
          ),
        ),
      10_000,
    );
    const onClose = (code: number | null) =>
      finish(
        new Error(
          `interop_helper_exited_before_ready:${code ?? "signal"} stderr=${stderr ? Buffer.concat(stderr).toString("utf8") : ""}`,
        ),
      );
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      if (poll !== undefined) clearInterval(poll);
      process.off("close", onClose);
      if (error === undefined) resolvePromise();
      else reject(error);
    };
    if (observed.includes(expected)) {
      finish();
      return;
    }
    if (process.exitCode !== null) {
      finish(
        new Error(
          `interop_helper_exited_before_ready:${process.exitCode} stderr=${stderr ? Buffer.concat(stderr).toString("utf8") : ""}`,
        ),
      );
      return;
    }
    process.once("close", onClose);
    poll = setInterval(() => {
      if (observed.includes(expected)) finish();
    }, 5);
  });
}

async function beforeDeadline<T>(
  work: Promise<T>,
  label: string,
  observed: readonly string[],
  timeoutMs = 10_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolvePromise, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label}_timeout:${observed.join(",")}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function exit(process: InteropProcess): Promise<void> {
  if (process.exitCode !== null) return;
  const closed = once(process, "close");
  process.kill();
  await closed;
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

/** Shared bootstrap/hello/observe prelude; each action keeps its own typed start. */
async function connectThroughAccepted(pipeName: string, mode: "success" | "cancel") {
  const peer = spawnPeer(pipeName, mode);
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  peer.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  peer.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let client: PortfolioStardewBridgeClient | undefined;

  try {
    await waitForLine(peer, scenarioReadyMarker, observed, stderr);
    client = await beforeDeadline(
      connectAfterPipeListen(pipeName, () => PortfolioStardewBridgeClient.connectBootstrap(identity, pipeName, token)),
      "interop_portfolio_bootstrap_connect",
      observed,
    );
    assert.equal(client.state.connected, true);
    assert.equal(client.state.authenticated, true);
    assert.equal(client.scope.bindingGeneration, bindingGeneration);
    assert.equal(client.scope.bindingHash, bindingHash);
    assert.deepEqual(client.scope, scope);
    const closeReasons: string[] = [];
    client.onClose((reason) => closeReasons.push(reason));

    const snapshot = await beforeDeadline(client.observe(), "interop_portfolio_observe", observed);
    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.worldReady, true);
    assert.equal(snapshot.singlePlayer, true);
    assert.equal(snapshot.currentLocalPlayerMatches, true);
    assert.equal(snapshot.bindingGeneration, bindingGeneration);
    assert.equal(snapshot.bindingHash, bindingHash);
    assert.deepEqual(client.state.snapshot, snapshot);

    const started = await beforeDeadline(
      client.startMineElevator({
        action: "select_mine_elevator_floor",
        requestId,
        traceId,
        idempotencyKey: "idem_interop_mine_elevator",
        selectedCheckpoint: 10,
        expectedRevision: snapshot.revision,
        deadlineMs: Date.now() + 30_000,
        cancellationToken,
        scope,
      }),
      "interop_portfolio_mine_elevator_start",
      observed,
    );
    return { peer, client, observed, stderr, closeReasons, started };
  } catch (error) {
    client?.close();
    await exit(peer);
    throw error;
  }
}

async function connectThroughAcceptedLadder(pipeName: string) {
  const mode = "ladder_success" as const;
  const peer = spawnPeer(pipeName, mode);
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  peer.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  peer.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let client: PortfolioStardewBridgeClient | undefined;

  try {
    await waitForLine(peer, scenarioReadyMarker, observed, stderr);
    client = await beforeDeadline(
      connectAfterPipeListen(pipeName, () => PortfolioStardewBridgeClient.connectBootstrap(identity, pipeName, token)),
      "interop_portfolio_bootstrap_connect",
      observed,
    );
    const closeReasons: string[] = [];
    client.onClose((reason) => closeReasons.push(reason));
    const snapshot = await beforeDeadline(client.observe(), "interop_portfolio_observe", observed);
    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.revision, 1);

    const started = await beforeDeadline(
      client.startMineLadder({
        action: "use_mine_ladder",
        requestId: "request_interop_mine_ladder",
        traceId: "trace_interop_mine_ladder",
        idempotencyKey: "idem_interop_mine_ladder",
        expectedRevision: snapshot.revision,
        deadlineMs: Date.now() + 30_000,
        cancellationToken: "cancel_interop_mine_ladder_1",
        scope,
      }),
      "interop_portfolio_mine_ladder_start",
      observed,
    );
    return { peer, client, observed, stderr, closeReasons, started };
  } catch (error) {
    client?.close();
    await exit(peer);
    throw error;
  }
}

test(
  "Portfolio C# peer success terminal-drain scenario: exact private ModEntry drain -> real pipe -> real client succeeded receipt + second-drain dequeue",
  {
    timeout: 60_000,
    skip: peerAvailable
      ? false
      : `Portfolio C# interop peer is not built; expected ${peerPath} or set GAMEBUDDY_PORTFOLIO_INTEROP_PEER_DLL`,
  },
  async () => {
    await assertAttestedPeerBinding();
    const mode: InteropScenario = "success";
    const deliveredMarker = scenarioDeliveryMarkers[mode];
    const pipeName = `gamebuddy-stardew-portfolio-interop_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    const { peer, client, observed, stderr, closeReasons, started } = await connectThroughAccepted(pipeName, mode);

    try {
      // The peer drives the pure state-machine terminal and delivers the
      // receipt through the exact private compiled ModEntry drain; the real
      // Host start request settles exactly once with the succeeded receipt.
      let terminalSettlements = 0;
      const terminal = started.terminal.then((receipt) => {
        terminalSettlements += 1;
        return receipt;
      });
      const receipt = await beforeDeadline(terminal, "interop_portfolio_mine_elevator_terminal", observed, 25_000);

      // The peer's delivery-completion proof: the receipt frame write
      // finished on its side and the second exact drain dequeued the delivery
      // before any quiet-window or teardown check.
      await beforeDeadline(waitForLine(peer, deliveredMarker, observed, stderr), "interop_portfolio_receipt_delivered", observed);

      // The pending request resolves to the exact expected terminal receipt
      // exactly once: no duplicate delivery, no fail-closed close, no extra
      // frame or diagnostic while the peer keeps the session open.
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200));
      assert.equal(terminalSettlements, 1);
      assert.equal(client.state.connected, true);
      assert.equal(client.state.authenticated, true);
      assert.equal(client.state.latestReasonCode, null);
      assert.deepEqual(closeReasons, []);

      // Exact succeeded receipt/fact for the pending mine_elevator execution:
      // the compiled coordinator's postcondition terminal with the full
      // fresh_observed/accepted/transition_started/postcondition/terminal
      // trace and the structural adapter's floors.
      assert.equal(receipt.state, "succeeded");
      assert.equal(receipt.reasonCode, "mine_elevator_floor_selected");
      assert.equal(receipt.requestId, requestId);
      assert.equal(receipt.traceId, traceId);
      assert.equal(receipt.executionId, started.executionId);
      assert.equal(receipt.revision, 3);
      assert.deepEqual(receipt.evidence.scope, scope);
      assert.deepEqual(receipt.evidence.phaseTrace, [
        { requestId, traceId, executionId: started.executionId, phase: "fresh_observed", revision: 1, reasonCode: "fresh_observed" },
        { requestId, traceId, executionId: started.executionId, phase: "accepted", revision: 1, reasonCode: "accepted" },
        { requestId, traceId, executionId: started.executionId, phase: "transition_started", revision: 2, reasonCode: "mine_elevator_transition_started" },
        { requestId, traceId, executionId: started.executionId, phase: "postcondition", revision: 3, reasonCode: "postcondition_observed" },
        { requestId, traceId, executionId: started.executionId, phase: "terminal", revision: 3, reasonCode: "mine_elevator_floor_selected" },
      ]);
      assert.equal(receipt.evidence.entryObserved, true);
      assert.equal(receipt.evidence.currentFloorBefore, 0);
      assert.equal(receipt.evidence.lowestMineLevelBefore, 10);
      assert.equal(receipt.evidence.opaqueElevatorTarget, "elevator_target_01");
      assert.equal(receipt.evidence.nativeElevatorTransitionObserved, true);
      assert.equal(receipt.evidence.currentFloorAfter, 10);
      assert.equal(receipt.evidence.lowestMineLevelAfter, 10);
      assert.equal(receipt.evidence.lowestMineLevelObserved, true);
      assert.equal(receipt.postcondition.selectedCheckpoint, 10);
      assert.equal(receipt.postcondition.actualCurrentFloor, 10);
      assert.equal(receipt.postcondition.observedLowestMineLevel, 10);
      assert.equal(receipt.postcondition.opaqueElevatorTarget, "elevator_target_01");
      assert.equal(receipt.postcondition.freshObservation, true);
      assert.equal(receipt.postcondition.sameExecution, true);

      // Cleanup: close the client, then await the peer's own exit (0) after
      // it observed the strict-session disconnect. The stdout contract lines
      // must be exactly the readiness and the success delivery markers - no
      // extra facts or diagnostics.
      client.close("interop_portfolio_test_complete");
      const [code] = await beforeDeadline(once(peer, "close"), "interop_portfolio_peer_close", observed, 10_000);
      assert.equal(code, 0);
      assert.deepEqual(observed, [scenarioReadyMarker, deliveredMarker]);
    } finally {
      client.close();
      await exit(peer);
    }

    assert.equal(Buffer.concat(stderr).toString("utf8"), "");
  },
);

test(
  "Portfolio C# peer accepted-then-cancel scenario: exact private ModEntry.HandlePortfolioMineElevatorCancel -> compiled session/coordinator -> real pipe -> real client cancelled receipt",
  {
    timeout: 60_000,
    skip: peerAvailable
      ? false
      : `Portfolio C# interop peer is not built; expected ${peerPath} or set GAMEBUDDY_PORTFOLIO_INTEROP_PEER_DLL`,
  },
  async () => {
    await assertAttestedPeerBinding();
    const mode: InteropScenario = "cancel";
    const deliveredMarker = scenarioDeliveryMarkers[mode];
    const pipeName = `gamebuddy-stardew-portfolio-interop_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    const { peer, client, observed, stderr, closeReasons, started } = await connectThroughAccepted(pipeName, mode);

    try {
      // Frozen P1 slice: the real Host cancels the exact accepted execution
      // with the exact accepted cancellation token. The peer feeds the raw
      // frame to the exact compiled private
      // ModEntry.HandlePortfolioMineElevatorCancel handler; both the cancel
      // promise and the original terminal must resolve exactly once with the
      // same structurally terminal cancelled receipt.
      let terminalSettlements = 0;
      const terminal = started.terminal.then((receipt) => {
        terminalSettlements += 1;
        return receipt;
      });
      const cancelReceipt = await beforeDeadline(
        client.cancelMineElevator({
          action: "select_mine_elevator_floor",
          requestId,
          traceId,
          executionId: started.executionId,
          cancellationToken,
          scope,
        }),
        "interop_portfolio_mine_elevator_cancel",
        observed,
      );
      const terminalReceipt = await beforeDeadline(terminal, "interop_portfolio_mine_elevator_terminal", observed, 25_000);

      // The peer's delivery-completion proof: the cancel receipt frame write
      // finished on its side before any quiet-window or teardown check.
      await beforeDeadline(waitForLine(peer, deliveredMarker, observed, stderr), "interop_portfolio_receipt_delivered", observed);

      // The cancel promise and the original terminal settle exactly once with
      // the SAME cancelled lifecycle identity (the client materializes a fresh
      // frozen copy per call surface, so compare structurally): no duplicate
      // delivery, no fail-closed close, no extra frame or diagnostic while
      // the peer keeps the session open.
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200));
      assert.equal(terminalSettlements, 1);
      assert.deepEqual(cancelReceipt, terminalReceipt);
      assert.equal(client.state.connected, true);
      assert.equal(client.state.authenticated, true);
      assert.equal(client.state.latestReasonCode, null);
      assert.deepEqual(closeReasons, []);

      // Exact cancelled receipt/fact for the accepted mine_elevator execution:
      // the compiled coordinator fail-closes the post-adapter-boundary cancel
      // as uncertain/native_operation_uncertain at the accepted revision with
      // the short fresh_observed/accepted/terminal trace.
      assert.equal(cancelReceipt.state, "uncertain");
      assert.equal(cancelReceipt.reasonCode, "native_operation_uncertain");
      assert.equal(cancelReceipt.requestId, requestId);
      assert.equal(cancelReceipt.traceId, traceId);
      assert.equal(cancelReceipt.executionId, started.executionId);
      assert.equal(cancelReceipt.revision, 1);
      assert.deepEqual(cancelReceipt.evidence.scope, scope);
      assert.deepEqual(cancelReceipt.evidence.phaseTrace, [
        { requestId, traceId, executionId: started.executionId, phase: "fresh_observed", revision: 1, reasonCode: "fresh_observed" },
        { requestId, traceId, executionId: started.executionId, phase: "accepted", revision: 1, reasonCode: "accepted" },
        { requestId, traceId, executionId: started.executionId, phase: "terminal", revision: 1, reasonCode: "native_operation_uncertain" },
      ]);
      assert.equal(cancelReceipt.evidence.entryObserved, true);
      assert.equal(cancelReceipt.evidence.currentFloorBefore, 0);
      assert.equal(cancelReceipt.evidence.lowestMineLevelBefore, 10);
      assert.equal(cancelReceipt.evidence.opaqueElevatorTarget, "elevator_target_01");
      assert.equal(cancelReceipt.evidence.nativeElevatorTransitionObserved, false);
      assert.equal(cancelReceipt.evidence.currentFloorAfter, 0);
      assert.equal(cancelReceipt.evidence.lowestMineLevelAfter, 0);
      assert.equal(cancelReceipt.evidence.lowestMineLevelObserved, false);
      assert.equal(cancelReceipt.postcondition.selectedCheckpoint, 10);
      assert.equal(cancelReceipt.postcondition.actualCurrentFloor, 0);
      assert.equal(cancelReceipt.postcondition.observedLowestMineLevel, 0);
      assert.equal(cancelReceipt.postcondition.opaqueElevatorTarget, "elevator_target_01");
      assert.equal(cancelReceipt.postcondition.freshObservation, false);
      assert.equal(cancelReceipt.postcondition.sameExecution, false);

      // Exactly-once at the API level: the accepted lifecycle is no longer
      // pending, so a second cancel of the same identity rejects locally
      // without writing any wire frame.
      const activeClient = client;
      await assert.rejects(
        () =>
          activeClient.cancelMineElevator({
            action: "select_mine_elevator_floor",
            requestId,
            traceId,
            executionId: started.executionId,
            cancellationToken,
            scope,
          }),
        /portfolio_mine_elevator_cancel_not_pending/,
      );

      // Cleanup: close the client, then await the peer's own exit (0) after
      // it observed the strict-session disconnect. The stdout contract lines
      // must be exactly the readiness and the cancel delivery markers - no
      // extra facts or diagnostics.
      client.close("interop_portfolio_test_complete");
      const [code] = await beforeDeadline(once(peer, "close"), "interop_portfolio_peer_close", observed, 10_000);
      assert.equal(code, 0);
      assert.deepEqual(observed, [scenarioReadyMarker, deliveredMarker]);
    } finally {
      client.close();
      await exit(peer);
    }

    assert.equal(Buffer.concat(stderr).toString("utf8"), "");
  },
);

test(
  "Portfolio C# peer ladder terminal-drain scenario: exact private ModEntry drain -> real pipe -> real client succeeded receipt + second-drain dequeue",
  {
    timeout: 60_000,
    skip: peerAvailable
      ? false
      : `Portfolio C# interop peer is not built; expected ${peerPath} or set GAMEBUDDY_PORTFOLIO_INTEROP_PEER_DLL`,
  },
  async () => {
    await assertAttestedPeerBinding();
    const mode = "ladder_success" as const;
    const deliveredMarker = scenarioDeliveryMarkers[mode];
    const pipeName = `gamebuddy-stardew-portfolio-ladder-interop_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    const { peer, client, observed, stderr, closeReasons, started } = await connectThroughAcceptedLadder(pipeName);

    try {
      let terminalSettlements = 0;
      const terminal = started.terminal.then((receipt) => {
        terminalSettlements += 1;
        return receipt;
      });
      const receipt = await beforeDeadline(terminal, "interop_portfolio_mine_ladder_terminal", observed, 25_000);
      await beforeDeadline(waitForLine(peer, deliveredMarker, observed, stderr), "interop_portfolio_receipt_delivered", observed);

      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200));
      assert.equal(terminalSettlements, 1);
      assert.equal(client.state.connected, true);
      assert.equal(client.state.authenticated, true);
      assert.equal(client.state.latestReasonCode, null);
      assert.deepEqual(closeReasons, []);

      assert.equal(receipt.state, "succeeded");
      assert.equal(receipt.reasonCode, "mine_ladder_floor_used");
      assert.equal(receipt.requestId, "request_interop_mine_ladder");
      assert.equal(receipt.traceId, "trace_interop_mine_ladder");
      assert.equal(receipt.executionId, started.executionId);
      assert.equal(receipt.revision, 3);
      assert.deepEqual(receipt.evidence.scope, scope);
      assert.deepEqual(receipt.evidence.phaseTrace, [
        { requestId: "request_interop_mine_ladder", traceId: "trace_interop_mine_ladder", executionId: started.executionId, phase: "fresh_observed", revision: 1, reasonCode: "fresh_observed" },
        { requestId: "request_interop_mine_ladder", traceId: "trace_interop_mine_ladder", executionId: started.executionId, phase: "accepted", revision: 1, reasonCode: "accepted" },
        { requestId: "request_interop_mine_ladder", traceId: "trace_interop_mine_ladder", executionId: started.executionId, phase: "transition_started", revision: 2, reasonCode: "mine_ladder_transition_started" },
        { requestId: "request_interop_mine_ladder", traceId: "trace_interop_mine_ladder", executionId: started.executionId, phase: "postcondition", revision: 3, reasonCode: "postcondition_observed" },
        { requestId: "request_interop_mine_ladder", traceId: "trace_interop_mine_ladder", executionId: started.executionId, phase: "terminal", revision: 3, reasonCode: "mine_ladder_floor_used" },
      ]);
      assert.equal(receipt.evidence.entryObserved, true);
      assert.equal(receipt.evidence.currentFloorBefore, 1);
      assert.equal(receipt.evidence.lowestMineLevelBefore, 10);
      assert.equal(receipt.evidence.opaqueLadderTarget, "ladder_target_01");
      assert.equal(receipt.evidence.nativeLadderTransitionObserved, true);
      assert.equal(receipt.evidence.currentFloorAfter, 2);
      assert.equal(receipt.evidence.lowestMineLevelAfter, 10);
      assert.equal(receipt.evidence.lowestMineLevelObserved, true);
      assert.equal(receipt.postcondition.targetFloor, 2);
      assert.equal(receipt.postcondition.actualCurrentFloor, 2);
      assert.equal(receipt.postcondition.observedLowestMineLevel, 10);
      assert.equal(receipt.postcondition.opaqueLadderTarget, "ladder_target_01");
      assert.equal(receipt.postcondition.freshObservation, true);
      assert.equal(receipt.postcondition.sameExecution, true);

      client.close("interop_portfolio_test_complete");
      const [code] = await beforeDeadline(once(peer, "close"), "interop_portfolio_peer_close", observed, 10_000);
      assert.equal(code, 0);
      assert.deepEqual(observed, [scenarioReadyMarker, deliveredMarker]);
    } finally {
      client.close();
      await exit(peer);
    }

    assert.equal(Buffer.concat(stderr).toString("utf8"), "");
  },
);
