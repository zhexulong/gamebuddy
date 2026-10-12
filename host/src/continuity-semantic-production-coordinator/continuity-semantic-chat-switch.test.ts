/**
 * Turn-level Chat switching over the real production Chat authority.
 *
 * The product ruling is that switching is turn-level, not process-level: the
 * mutex protects a running turn, never the process. These cases drive the real
 * `requestChatSelection` on a real fresh authority in an isolated process (the
 * authority owns a real Windows root mutex, so it cannot share this process with
 * another construction) and read the mounted identity back.
 *
 * - an idle runtime switches the mounted Chat inside the same process: the
 *   previous mount is superseded, the successor lease serves a different thread,
 *   and both threads stay readable through the durable store;
 * - a runtime whose turn is still generating is not refused (ADR-0010):
 *   `chat.select` aborts that turn through the same cancel seam an authenticated
 *   browser Stop uses, keeps the text the interrupted turn had already committed,
 *   and only then releases the old mount and mounts the target;
 * - a durable turn with no attempt at all (the player's message is committed and
 *   nothing was ever scheduled for it) is aborted the same way instead of being
 *   answered with the fail-closed `turn_in_flight`: the mounted authority claims
 *   and arms the turn exactly as its own start would have, the one cancel path
 *   terminalizes it, and the switch happens in this same process.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { before } from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";

before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

const principal = Object.freeze({
  playerId: "player_01",
  companionId: "companion_01",
  continuityId: "continuity_01",
});

function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows SQLite cleanup is best effort */
  }
}

const switchScript = `
  const [coordinatorUrl, manifestUrl, pathLockUrl, reclaimerUrl, storeUrl, runtimeUrl, acceptanceUrl, claimUrl, manifestPath, scenario] =
    process.argv.slice(1);
  const { bindWindowsStaleLockReclaimer } = await import(pathLockUrl);
  const { createBuildWindowsStaleLockReclaimer } = await import(reclaimerUrl);
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const internal = await import(coordinatorUrl);
  const {
    createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
    isCurrentMountedChatRuntimeLease,
  } = internal;
  const { loadHostDeploymentManifest } = await import(manifestUrl);
  const { createChatThreadStore } = await import(storeUrl);
  const { identityKey } = await import(runtimeUrl);
  const { createPlayerTurnAcceptor } = await import(acceptanceUrl);
  const { createProviderAttemptClaimer } = await import(claimUrl);

  const manifest = await loadHostDeploymentManifest(manifestPath);
  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
  const first = await authority.startMountedChatRuntime();
  const firstThread = first.chatThreadId;
  const firstSurface = first.chatSurfaceSessionId;
  const firstGeneration = first.browserProjection.selectionGeneration;
  const firstChatHandle = first.browserProjection.chatHandle;
  const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (await predicate()) return;
      await sleep(25);
    }
    throw new Error("waitFor_timeout");
  };
  const out = { firstThread, firstSurface, firstGeneration, firstChatHandle };

  if (scenario === "in-flight") {
    // A real, durably generating turn: accepted, attempt claimed, armed, running,
    // and with a committed presentation - exactly the state the old refusal
    // answered. The scripted runner then holds the active prompt so the selection
    // has something real to abort.
    const accepted = await createPlayerTurnAcceptor(manifest, first).accept({
      text: "Hello",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
    });
    await createProviderAttemptClaimer(manifest, first).claim();
    const producedText = "Half a thought, kept.";
    let releasePrompt;
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const startTask = internal.startMountedAttempt(manifest, first, (invocation) =>
      internal.consumeMountedAttemptInvocationAdmission(invocation, async (scope) => {
        await scope.transitionStore({ operation: "arm", observedAtMs: Date.now() });
        await sleep(4);
        await scope.transitionStore({ operation: "running", statusClass: "success", observedAtMs: Date.now() });
        await sleep(4);
        const committed = await scope.transitionPresentation({
          operation: "commit_presentation",
          cancelEpoch: 0,
          message: { messageId: "response_01", text: producedText, occurredAtMs: Date.now() },
          committedAtMs: Date.now(),
        });
        if (committed.status !== "presentation_committed") throw new Error("expected_presentation_committed");
        releasePrompt = scope.beginActivePrompt();
        await gate;
        // The aborted turn's own runner settles it: the durable cancel winner was
        // already claimed by the selection's abort, so this only terminalizes it.
        const cancelled = await scope.transitionPresentation({ operation: "cancel", cancelledAtMs: Date.now() });
        releasePrompt();
        return cancelled;
      }),
    );
    await waitFor(() => releasePrompt !== undefined);
    const generating = await store.resumeThread(firstThread, firstSurface);
    out.generatingLedgerStatus = generating.turnLedger === null ? null : generating.turnLedger.status;

    const selection = authority.requestChatSelection({ kind: "create", selectionGeneration: firstGeneration });
    // The abort claims the durable winner before the mount is released; the
    // mount is only released once the interrupted turn has settled.
    await waitFor(async () => (await store.resumeThread(firstThread, firstSurface)).turnLedger?.status === "cancel_claimed");
    out.cancelClaimedWhileGenerating = true;
    releaseGate();
    const outcome = await selection;
    await startTask;

    out.outcomeStatus = outcome.status;
    out.outcomeThread = outcome.chatThreadId;
    out.outcomeSurface = outcome.chatSurfaceSessionId;
    out.firstSuperseded = isCurrentMountedChatRuntimeLease(first);
    const second = await authority.startMountedChatRuntime();
    out.secondThread = second.chatThreadId;
    out.secondSurface = second.chatSurfaceSessionId;
    out.secondCurrent = isCurrentMountedChatRuntimeLease(second);
    out.acceptedTurnId = accepted.turnId;

    // The interrupted turn kept everything it had already produced: the durable
    // companion message and the ledger's own presentation record.
    const interrupted = await store.resumeThread(firstThread, firstSurface);
    out.interruptedLedgerStatus = interrupted.turnLedger === null ? null : interrupted.turnLedger.status;
    out.interruptedLedgerPresentation =
      interrupted.turnLedger !== null && interrupted.turnLedger.status === "cancelled"
        ? interrupted.turnLedger.presentation !== null
        : null;
    out.interruptedProducedTextKept = interrupted.messages.some(
      (message) => message.kind === "response" && message.text === producedText,
    );
    out.interruptedMessageCount = interrupted.messages.length;

    const successor = await store.resumeThread(second.chatThreadId, second.chatSurfaceSessionId);
    out.successorThreadReadable = successor.thread.chatThreadId === second.chatThreadId;
    out.successorIsSelectedChat = successor.thread.chatThreadId === outcome.chatThreadId;
    out.firstThreadStillReadable = interrupted.thread.chatThreadId === firstThread;
  } else if (scenario === "durable-unstarted") {
    // A durable turn with no attempt at all: the player's message is committed
    // and nothing was ever scheduled for it - no claim, no prompt, no start
    // runner. This is the shape the old reading answered turn_in_flight for.
    const accepted = await createPlayerTurnAcceptor(manifest, first).accept({
      text: "Never started.",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
    });
    const unstarted = await store.resumeThread(firstThread, firstSurface);
    out.unstartedLedgerStatus = unstarted.turnLedger === null ? null : unstarted.turnLedger.status;
    out.unstartedHasAttempt = unstarted.turnLedger !== null && "attempt" in unstarted.turnLedger;

    const outcome = await authority.requestChatSelection({ kind: "create", selectionGeneration: firstGeneration });
    out.outcomeStatus = outcome.status;
    out.outcomeThread = outcome.chatThreadId;
    out.outcomeSurface = outcome.chatSurfaceSessionId;
    out.firstSuperseded = isCurrentMountedChatRuntimeLease(first);
    const second = await authority.startMountedChatRuntime();
    out.secondThread = second.chatThreadId;
    out.secondSurface = second.chatSurfaceSessionId;
    out.secondCurrent = isCurrentMountedChatRuntimeLease(second);
    out.acceptedTurnId = accepted.turnId;

    // The turn that never started is terminal in the conversation switched away
    // from: no dangling claim, no non-terminal row the browser could keep
    // waiting on, and the player's own text still there.
    const firstState = await store.resumeThread(firstThread, firstSurface);
    out.firstThreadStillReadable = firstState.thread.chatThreadId === firstThread;
    out.interruptedTurnId = firstState.turnLedger === null ? null : firstState.turnLedger.turnId;
    out.interruptedLedgerStatus = firstState.turnLedger === null ? null : firstState.turnLedger.status;
    out.interruptedLedgerObservation =
      firstState.turnLedger !== null && firstState.turnLedger.status === "cancelled"
        ? firstState.turnLedger.observation.phase
        : null;
    out.interruptedLedgerPresentation =
      firstState.turnLedger !== null && firstState.turnLedger.status === "cancelled"
        ? firstState.turnLedger.presentation !== null
        : null;
    out.interruptedKeptPlayerText = firstState.messages.some(
      (message) => message.kind === "player" && message.text === "Never started.",
    );
    out.interruptedMessageCount = firstState.messages.length;

    const successor = await store.resumeThread(second.chatThreadId, second.chatSurfaceSessionId);
    out.successorIsSelectedChat = successor.thread.chatThreadId === outcome.chatThreadId;
    out.successorThreadReadable = successor.thread.chatThreadId === second.chatThreadId;
  } else {
    const outcome = await authority.requestChatSelection({ kind: "create", selectionGeneration: firstGeneration });
    out.outcomeStatus = outcome.status;
    out.outcomeThread = outcome.chatThreadId;
    out.outcomeSurface = outcome.chatSurfaceSessionId;
    out.firstSuperseded = isCurrentMountedChatRuntimeLease(first);
    const second = await authority.startMountedChatRuntime();
    out.secondThread = second.chatThreadId;
    out.secondSurface = second.chatSurfaceSessionId;
    out.secondGeneration = second.browserProjection.selectionGeneration;
    out.secondChatHandle = second.browserProjection.chatHandle;
    out.secondCurrent = isCurrentMountedChatRuntimeLease(second);
    const firstState = await store.resumeThread(firstThread, firstSurface);
    const secondState = await store.resumeThread(second.chatThreadId, second.chatSurfaceSessionId);
    out.firstThreadStillReadable = firstState.thread.chatThreadId === firstThread;
    out.secondThreadReadable = secondState.thread.chatThreadId === second.chatThreadId;
    out.secondThreadMessageCount = secondState.messages.length;
  }

  store.close?.();
  process.stdout.write(JSON.stringify(out));
  await authority.close();
`;

async function runSwitchScenario(
  root: string,
  scenario: "switch" | "in-flight" | "durable-unstarted",
): Promise<Record<string, unknown>> {
  const manifestPath = join(root, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot: root,
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
  );
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      switchScript,
      new URL("./continuity-semantic-production-coordinator.internal.js", import.meta.url).href,
      new URL("../deployment-manifest.js", import.meta.url).href,
      new URL("../path-lock.js", import.meta.url).href,
      new URL("../windows-stale-lock-reclaimer/index.js", import.meta.url).href,
      new URL("../tavern/chat-thread-store.js", import.meta.url).href,
      new URL("../runtime.js", import.meta.url).href,
      new URL("../tavern/player-turn-acceptance.js", import.meta.url).href,
      new URL("../tavern/provider-attempt-claim.js", import.meta.url).href,
      manifestPath,
      scenario,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const [code] = (await once(child, "exit")) as [number | null];
  assert.equal(code, 0, Buffer.concat(errors).toString("utf8"));
  return JSON.parse(Buffer.concat(output).toString("utf8")) as Record<string, unknown>;
}

test(
  "an idle mounted Chat switches in process without restarting the authority",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-turn-level-switch-");
    try {
      const observed = await runSwitchScenario(root, "switch");
      assert.equal(observed.outcomeStatus, "switched");
      // The successor mount serves the Chat the selection named...
      assert.equal(observed.outcomeThread, observed.secondThread);
      assert.equal(observed.outcomeSurface, observed.secondSurface);
      // ...and it is a different Chat, mounted in this same process.
      assert.notEqual(observed.secondThread, observed.firstThread);
      assert.notEqual(observed.secondSurface, observed.firstSurface);
      // The superseded lease is revoked and the successor is the current one.
      assert.equal(observed.firstSuperseded, false);
      assert.equal(observed.secondCurrent, true);
      // A fresh mount mints a fresh browser projection and advances the
      // selection generation: the browser cannot keep reading the old Chat.
      assert.notEqual(observed.secondChatHandle, observed.firstChatHandle);
      assert.ok(
        Number(observed.secondGeneration) > Number(observed.firstGeneration),
        `expected the successor geometry to advance past ${String(observed.firstGeneration)}`,
      );
      // Both conversations stay durable and readable; switching is not deletion.
      assert.equal(observed.firstThreadStillReadable, true);
      assert.equal(observed.secondThreadReadable, true);
      assert.ok(Number(observed.secondThreadMessageCount) >= 0);
    } finally {
      cleanup(root);
    }
  },
);

test(
  "selecting another Chat while a turn generates aborts that turn and switches",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-turn-level-in-flight-");
    try {
      const observed = await runSwitchScenario(root, "in-flight");
      // The turn really was generating when the selection ran: this is the state
      // the old reading answered `turn_in_flight` for.
      assert.equal(observed.generatingLedgerStatus, "presentation_committed");
      // The abort is the one cancel path: the durable cancel winner is claimed
      // while the turn is still mounted, before anything is released.
      assert.equal(observed.cancelClaimedWhileGenerating, true);
      // The player gets the switch, never a refusal and never a wait.
      assert.equal(observed.outcomeStatus, "switched");
      assert.equal(observed.secondCurrent, true);
      assert.equal(observed.successorIsSelectedChat, true);
      assert.equal(observed.successorThreadReadable, true);
      assert.equal(observed.firstSuperseded, false);
      // The conversation switched away from is still readable, and it is marked
      // as an interrupted turn rather than a completed one.
      assert.equal(observed.firstThreadStillReadable, true);
      assert.equal(observed.interruptedLedgerStatus, "cancelled");
      // Everything the interrupted turn had already produced survived: both the
      // durable companion message and the cancelled ledger's own presentation.
      assert.equal(observed.interruptedProducedTextKept, true);
      assert.equal(observed.interruptedLedgerPresentation, true);
      assert.ok(Number(observed.interruptedMessageCount) >= 2);
    } finally {
      cleanup(root);
    }
  },
);

/**
 * The residual case, and the failure it catches: with the previous reading this
 * same scenario answered `turn_in_flight` and left the durable `accepted_queued`
 * row exactly as it was (non-terminal, no attempt, nothing running), so clicking
 * another conversation did not switch and the player was told the switch would
 * take effect at the next start. The assertions below fail on that reading at
 * `outcomeStatus` and at `interruptedLedgerStatus`.
 */
test(
  "a durable turn that never started is aborted and the switch happens in process",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-turn-level-unstarted-");
    try {
      const observed = await runSwitchScenario(root, "durable-unstarted");
      // The turn really was durable with nothing running: no attempt, no prompt,
      // no start runner.
      assert.equal(observed.unstartedLedgerStatus, "accepted_queued");
      assert.equal(observed.unstartedHasAttempt, false);
      // The player gets the switch, never a refusal and never a promise about a
      // later start.
      assert.equal(observed.outcomeStatus, "switched");
      assert.equal(observed.firstSuperseded, false);
      assert.equal(observed.secondCurrent, true);
      assert.equal(observed.successorIsSelectedChat, true);
      assert.equal(observed.successorThreadReadable, true);
      // The turn that never started is terminal in the conversation switched away
      // from: no dangling claim and no non-terminal row the browser could keep
      // waiting on.
      assert.equal(observed.firstThreadStillReadable, true);
      assert.equal(observed.interruptedTurnId, observed.acceptedTurnId);
      assert.equal(observed.interruptedLedgerStatus, "cancelled");
      assert.equal(observed.interruptedLedgerObservation, "armed");
      assert.equal(observed.interruptedLedgerPresentation, false);
      // Nothing the player wrote was lost, and no companion message was invented
      // for a turn no provider ever saw.
      assert.equal(observed.interruptedKeptPlayerText, true);
      assert.ok(Number(observed.interruptedMessageCount) >= 1);
    } finally {
      cleanup(root);
    }
  },
);
