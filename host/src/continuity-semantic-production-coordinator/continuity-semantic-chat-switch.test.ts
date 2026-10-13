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
 * - a durable attempt that recorded its own pre-invocation `not_started` proof
 *   (admission revoked or deadline expired before the single Host invocation) is
 *   terminalized by the same ordinary turn-level cancel directly, without
 *   fabricating an `armed` observation, and the switch still happens.
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
  const [coordinatorUrl, manifestUrl, pathLockUrl, reclaimerUrl, storeUrl, runtimeUrl, acceptanceUrl, claimUrl, contentPortUrl, manifestPath, scenario] =
    process.argv.slice(1);
  const { bindWindowsStaleLockReclaimer } = await import(pathLockUrl);
  const { createBuildWindowsStaleLockReclaimer } = await import(reclaimerUrl);
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const internal = await import(coordinatorUrl);
  const {
    createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
    createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
    isCurrentMountedChatRuntimeLease,
  } = internal;
  const { loadHostDeploymentManifest } = await import(manifestUrl);
  const { createChatThreadStore } = await import(storeUrl);
  const { identityKey } = await import(runtimeUrl);
  const { createPlayerTurnAcceptor } = await import(acceptanceUrl);
  const { createProviderAttemptClaimer } = await import(claimUrl);
  const { createManifestDerivedInitialChatExactContentPort } = await import(contentPortUrl);
  const { DatabaseSync } = await import("node:sqlite");
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  const manifest = await loadHostDeploymentManifest(manifestPath);
  // The restart scenario is a second process over a root the first one already
  // provisioned: it opens the known authority (and reconciles the terminal
  // teardown the first process left) instead of provisioning a fresh one.
  const authority =
    scenario === "select-created-after-restart"
      ? await createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest)
      : await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
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

  /**
   * What the durable semantic authority actually holds, read from the file with a
   * separate read-only connection: the assertion is about committed state, not
   * about anything the authority reports about itself.
   */
  const semanticDbPath = (() => {
    const stack = [manifest.runtimeRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) stack.push(join(current, entry.name));
        else if (entry.name === "gamebuddy-continuity-v1.sqlite") return join(current, entry.name);
      }
    }
    throw new Error("semantic_db_not_found");
  })();
  const readDurable = () => {
    const db = new DatabaseSync(semanticDbPath, { readOnly: true });
    const threads = db
      .prepare(
        "SELECT chat_surface_session_id, chat_thread_id, lifecycle, content_receipt_json IS NOT NULL AS verified FROM production_continuity_thread ORDER BY chat_surface_session_id",
      )
      .all();
    const active = db
      .prepare(
        "SELECT chat_thread_id, chat_surface_session_id, expected_selection_json FROM production_active_selection WHERE singleton=1",
      )
      .get();
    db.close();
    return { threads, active };
  };
  /** The bounded refusal a request answers, or the fact that it was accepted. */
  const refusal = async (work) => {
    try {
      await work();
      return "accepted";
    } catch (error) {
      return error?.message ?? String(error);
    }
  };
  /**
   * The product's New Chat, reduced to its durable effect: a brand-new
   * (thread, surface-session) pair whose Tavern content is written by the content
   * port the settlement will register it from, with nothing registered in the
   * semantic authority. That is exactly the state the installed authority was in.
   */
  const createSecondChat = async () => {
    const target = Object.freeze({
      chatThreadId: "chat-" + "9".repeat(16),
      chatSurfaceSessionId: "surface-" + "9".repeat(16),
    });
    const content = createManifestDerivedInitialChatExactContentPort(manifest);
    try {
      await content.port.createExplicit(
        Object.freeze({
          chatThreadId: target.chatThreadId,
          companionId: manifest.principal.companionId,
          continuityId: manifest.principal.continuityId,
          chatSurfaceSessionId: target.chatSurfaceSessionId,
          opening: "blank",
        }),
      );
    } finally {
      content.close();
    }
    const state = await store.resumeThread(target.chatThreadId, target.chatSurfaceSessionId);
    out.createdThreadReadableBeforeSelection = state.thread.chatThreadId === target.chatThreadId;
    return target;
  };
  /** Selects the target through the authority and mints its successor mount. */
  const selectAndMount = async (target) => {
    const outcome = await authority.requestChatSelection({
      kind: "select",
      selectionGeneration: firstGeneration,
      chatThreadId: target.chatThreadId,
      chatSurfaceSessionId: target.chatSurfaceSessionId,
    });
    const firstSuperseded = isCurrentMountedChatRuntimeLease(first);
    const successor = await authority.startMountedChatRuntime();
    return Object.freeze({
      status: outcome.status,
      outcomeThread: outcome.chatThreadId,
      outcomeSurface: outcome.chatSurfaceSessionId,
      firstSuperseded,
      successorThread: successor.chatThreadId,
      successorSurface: successor.chatSurfaceSessionId,
      successorCurrent: isCurrentMountedChatRuntimeLease(successor),
    });
  };

  if (scenario === "select-created" || scenario === "select-created-create-only") {
    const target = await createSecondChat();
    const before = readDurable();
    out.createdThread = target.chatThreadId;
    out.createdSurface = target.chatSurfaceSessionId;
    out.beforeThreads = before.threads;
    out.beforeActive = before.active;

    if (scenario === "select-created") {
      // A target with no Tavern content behind it is still refused, and the
      // refusal lands before anything is released: the mounted Chat stays current
      // and no expectation is recorded for a Chat that could never be mounted.
      out.absentOutcome = await refusal(() =>
        authority.requestChatSelection({
          kind: "select",
          selectionGeneration: firstGeneration,
          chatThreadId: "chat-absent",
          chatSurfaceSessionId: "surface-absent",
        }),
      );
      out.absentKeptMount = isCurrentMountedChatRuntimeLease(first);
      out.absentKeptSelection = readDurable().active.chat_thread_id === firstThread;

      // The exact thread named with another Chat's surface session is refused: a
      // thread belongs to the surface talking to it.
      out.foreignPairOutcome = await refusal(() =>
        authority.requestChatSelection({
          kind: "select",
          selectionGeneration: firstGeneration,
          chatThreadId: target.chatThreadId,
          chatSurfaceSessionId: firstSurface,
        }),
      );
      out.foreignPairKeptMount = isCurrentMountedChatRuntimeLease(first);
      out.foreignPairKeptSelection = readDurable().active.chat_thread_id === firstThread;

      // A stale generation is the bounded refusal, not a switch.
      out.staleOutcome = await refusal(() =>
        authority.requestChatSelection({
          kind: "select",
          selectionGeneration: firstGeneration + 7,
          chatThreadId: target.chatThreadId,
          chatSurfaceSessionId: target.chatSurfaceSessionId,
        }),
      );
      out.staleKeptMount = isCurrentMountedChatRuntimeLease(first);
      out.staleKeptSelection = readDurable().active.chat_thread_id === firstThread;

      out.switch = await selectAndMount(target);
      const after = readDurable();
      out.afterThreads = after.threads;
      out.afterActive = after.active;
      const createdState = await store.resumeThread(target.chatThreadId, target.chatSurfaceSessionId);
      out.createdMessageCount = createdState.messages.length;
      const initialState = await store.resumeThread(firstThread, firstSurface);
      out.firstThreadStillReadable = initialState.thread.chatThreadId === firstThread;
    }
  } else if (scenario === "select-created-after-restart") {
    // A fresh process over the same root: the Chat the previous run created was
    // never selected and never registered. This is the durable check that a
    // create-then-restart does not strand it.
    const target = Object.freeze({
      chatThreadId: "chat-" + "9".repeat(16),
      chatSurfaceSessionId: "surface-" + "9".repeat(16),
    });
    const before = readDurable();
    out.createdThread = target.chatThreadId;
    out.beforeThreads = before.threads;
    out.beforeActive = before.active;
    out.switch = await selectAndMount(target);
    const after = readDurable();
    out.afterThreads = after.threads;
    out.afterActive = after.active;
    const createdState = await store.resumeThread(target.chatThreadId, target.chatSurfaceSessionId);
    out.createdMessageCount = createdState.messages.length;
  } else if (scenario === "in-flight" || scenario === "in-flight-created") {
    // In the created variant the target is a Chat the product's New Chat wrote and
    // the authority never registered. It is created before the turn starts, so
    // this scenario differs from the existing one only in what is selected.
    const createdTarget = scenario === "in-flight-created" ? await createSecondChat() : undefined;
    out.createdThread = createdTarget === undefined ? null : createdTarget.chatThreadId;
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

    // In the created variant the target above is the Chat the product's New Chat
    // wrote and the authority never registered: the same switch, driven for real.
    const selection = authority.requestChatSelection(
      createdTarget === undefined
        ? { kind: "create", selectionGeneration: firstGeneration }
        : {
            kind: "select",
            selectionGeneration: firstGeneration,
            chatThreadId: createdTarget.chatThreadId,
            chatSurfaceSessionId: createdTarget.chatSurfaceSessionId,
          },
    );
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
  } else if (scenario === "durable-not-started") {
    // A durable attempt that recorded its own pre-invocation not_started proof:
    // the admission was revoked before the single Host invocation, so nothing is
    // generating and no prompt is held. This is the shape with no outgoing store
    // transition before the turn-level cancel exit was added.
    const accepted = await createPlayerTurnAcceptor(manifest, first).accept({
      text: "Never began.",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
    });
    await createProviderAttemptClaimer(manifest, first).claim();
    const startTask = internal.startMountedAttempt(manifest, first, (invocation) =>
      internal.consumeMountedAttemptInvocationAdmission(invocation, async (scope) => {
        await scope.transitionStore({ operation: "arm", observedAtMs: Date.now() });
        await sleep(4);
        return scope.transitionStore({
          operation: "not_started",
          reasonCode: "admission_revoked",
          observedAtMs: Date.now(),
        });
      }),
    );
    await startTask;
    const notStarted = await store.resumeThread(firstThread, firstSurface);
    out.notStartedLedgerStatus = notStarted.turnLedger === null ? null : notStarted.turnLedger.status;
    out.notStartedLedgerObservation =
      notStarted.turnLedger !== null &&
      "observation" in notStarted.turnLedger &&
      notStarted.turnLedger.observation !== undefined
        ? notStarted.turnLedger.observation.phase
        : null;

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

    // The pre-invocation turn is terminal in the conversation switched away
    // from, keeping its own observation; nothing a poll could keep waiting on.
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
      (message) => message.kind === "player" && message.text === "Never began.",
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
  scenario:
    | "switch"
    | "in-flight"
    | "in-flight-created"
    | "durable-unstarted"
    | "durable-not-started"
    | "select-created"
    | "select-created-create-only"
    | "select-created-after-restart",
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
      new URL("../tavern/initial-chat-exact-content-port.js", import.meta.url).href,
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

/**
 * The last residual of the same ruling: a durable attempt that recorded its own
 * pre-invocation `not_started` proof. Before this edge existed the shape had no
 * outgoing store transition at all - `arm` conflicted with the recorded
 * observation, and `cancel`/`fail` required a durable `armed` one - so the same
 * chat switch answered `turn_in_flight` and left an `attempt_starting` row
 * nothing could terminalize. The fix reuses the ordinary `cancelled` terminal the
 * armed-cancel path writes, so this test fails on the old reading at
 * `outcomeStatus` and at `interruptedLedgerStatus`/`interruptedLedgerObservation`.
 */
test(
  "a durable pre-invocation not_started attempt is aborted and the switch happens in process",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-turn-level-not-started-");
    try {
      const observed = await runSwitchScenario(root, "durable-not-started");
      // The turn really was durable with nothing running: an attempt whose own
      // observation proves the prompt never began.
      assert.equal(observed.notStartedLedgerStatus, "attempt_starting");
      assert.equal(observed.notStartedLedgerObservation, "not_started");
      // The player gets the switch, never a refusal and never a wait.
      assert.equal(observed.outcomeStatus, "switched");
      assert.equal(observed.firstSuperseded, false);
      assert.equal(observed.secondCurrent, true);
      assert.equal(observed.successorIsSelectedChat, true);
      assert.equal(observed.successorThreadReadable, true);
      // The pre-invocation turn is terminal in the conversation switched away
      // from, keeping its own observation and no dangling claim.
      assert.equal(observed.firstThreadStillReadable, true);
      assert.equal(observed.interruptedTurnId, observed.acceptedTurnId);
      assert.equal(observed.interruptedLedgerStatus, "cancelled");
      assert.equal(observed.interruptedLedgerObservation, "not_started");
      assert.equal(observed.interruptedLedgerPresentation, false);
      // Nothing the player wrote was lost, and no companion message was invented
      // for a prompt the provider never saw.
      assert.equal(observed.interruptedKeptPlayerText, true);
      assert.ok(Number(observed.interruptedMessageCount) >= 1);
    } finally {
      cleanup(root);
    }
  },
);

type DurableThreadRow = Readonly<{
  chat_thread_id: string;
  chat_surface_session_id: string;
  lifecycle: string;
  verified: number | boolean;
}>;
type DurableActiveRow = Readonly<{
  chat_thread_id: string;
  chat_surface_session_id: string;
  expected_selection_json: string | null;
}>;

const durableThread = (rows: unknown, threadId: string): DurableThreadRow | undefined =>
  (rows as DurableThreadRow[]).find((row) => row.chat_thread_id === threadId);

/**
 * The defect this covers: a Chat the product's New Chat creates is written to the
 * Tavern store and registered nowhere, and the select route could therefore never
 * select it (409 `selection_conflict`, idle or generating). The assertions below
 * fail on the pre-fix authority at:
 * - `beforeThreads`: it must show the created pair absent from
 *   `production_continuity_thread` - that absence IS the defect state, so a
 *   passing run cannot be one where the pair happened to already be registered;
 * - `absent*`: an unregistered AND unverifiable target must still be refused, and
 *   the refusal must land before the mounted runtime is released - the hole a
 *   bare "admit unregistered targets" change opens, where the mount is torn down
 *   and the settlement then fails, leaving the player with no mounted Chat;
 * - `foreignPair*`: naming the real thread with another Chat's surface session
 *   must still be refused - the invariant that a thread belongs to the surface
 *   talking to it, which loosening that same guard would destroy;
 * - `switch.*` / `after*`: the created Chat must become the mounted conversation
 *   AND be registered and content-verified for its own pair, so the switch is a
 *   durable fact rather than a mount the authority does not record.
 */
test(
  "a Chat created through the product is selectable, and the refusal still fires for what it is not for",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-created-chat-selection-");
    try {
      const observed = await runSwitchScenario(root, "select-created");
      const createdThread = String(observed.createdThread);
      const createdSurface = String(observed.createdSurface);
      const before = observed.beforeThreads as readonly DurableThreadRow[];

      // The Tavern content exists (the create landed) and the semantic authority
      // has never heard of it: exactly the shape the installed authority was in.
      assert.equal(observed.createdThreadReadableBeforeSelection, true);
      assert.equal(before.length, 1);
      assert.equal(durableThread(before, createdThread), undefined);
      assert.equal(durableThread(before, String(observed.firstThread))?.verified, 1);

      // An unregistered and unverifiable target: refused, and nothing is released.
      assert.equal(observed.absentOutcome, "semantic_chat_selection_conflict");
      assert.equal(observed.absentKeptMount, true);
      assert.equal(observed.absentKeptSelection, true);

      // The right thread with another Chat's surface session: refused.
      assert.equal(observed.foreignPairOutcome, "semantic_chat_selection_conflict");
      assert.equal(observed.foreignPairKeptMount, true);
      assert.equal(observed.foreignPairKeptSelection, true);

      // A stale generation: the bounded refusal, and nothing is released.
      assert.equal(observed.staleOutcome, "semantic_chat_selection_generation_conflict");
      assert.equal(observed.staleKeptMount, true);
      assert.equal(observed.staleKeptSelection, true);

      // The switch: the first time this Chat could ever be selected.
      const switched = observed.switch as Record<string, unknown>;
      assert.equal(switched.status, "switched");
      assert.equal(switched.outcomeThread, createdThread);
      assert.equal(switched.outcomeSurface, createdSurface);
      assert.equal(switched.firstSuperseded, false);
      assert.equal(switched.successorThread, createdThread);
      assert.equal(switched.successorSurface, createdSurface);
      assert.equal(switched.successorCurrent, true);

      // The registration landed durably for the created Chat's OWN pair, with its
      // Tavern content verified and no expectation left behind.
      const after = observed.afterThreads as readonly DurableThreadRow[];
      const registered = durableThread(after, createdThread);
      assert.equal(after.length, 2);
      assert.equal(registered?.chat_surface_session_id, createdSurface);
      assert.equal(registered?.lifecycle, "active");
      assert.equal(registered?.verified, 1);
      const active = observed.afterActive as DurableActiveRow;
      assert.equal(active.chat_thread_id, createdThread);
      assert.equal(active.chat_surface_session_id, createdSurface);
      assert.equal(active.expected_selection_json, null);

      // Switching is not deletion: the conversation switched away from stays.
      assert.equal(observed.firstThreadStillReadable, true);
      assert.equal(durableThread(after, String(observed.firstThread))?.lifecycle, "active");
      assert.ok(Number(observed.createdMessageCount) >= 0);
    } finally {
      cleanup(root);
    }
  },
);

/**
 * The stranded-record question, answered durably: a Chat created and NEVER
 * selected, then the product restarted. Two real processes over one root - the
 * first creates the pair and exits, the second starts fresh and selects it. It
 * fails on a pre-fix authority at the second process's `switch.status`, and it
 * would fail after the fix if the registration only happened at first selection
 * and a restart in between stranded the pair.
 */
test(
  "a Chat created and never selected is still selectable after the product restarts",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-created-chat-restart-");
    try {
      const created = await runSwitchScenario(root, "select-created-create-only");
      const createdThread = String(created.createdThread);
      const createdSurface = String(created.createdSurface);
      const createdRunThreads = created.beforeThreads as readonly DurableThreadRow[];
      assert.equal(createdRunThreads.length, 1);
      assert.equal(durableThread(createdRunThreads, createdThread), undefined);
      // Nothing was selected: the recorded expectation was never used.
      assert.equal((created.beforeActive as DurableActiveRow).chat_thread_id, String(created.firstThread));

      const restarted = await runSwitchScenario(root, "select-created-after-restart");
      // The restart alone registers nothing: the pair is still only in the Tavern
      // store, so this is genuinely the select that follows a restart.
      const beforeSelect = restarted.beforeThreads as readonly DurableThreadRow[];
      assert.equal(beforeSelect.length, 1);
      assert.equal(durableThread(beforeSelect, createdThread), undefined);

      const switched = restarted.switch as Record<string, unknown>;
      assert.equal(switched.status, "switched");
      assert.equal(switched.outcomeThread, createdThread);
      assert.equal(switched.successorThread, createdThread);
      assert.equal(switched.successorSurface, createdSurface);
      assert.equal(switched.successorCurrent, true);

      const after = restarted.afterThreads as readonly DurableThreadRow[];
      const registered = durableThread(after, createdThread);
      assert.equal(registered?.chat_surface_session_id, createdSurface);
      assert.equal(registered?.verified, 1);
      assert.equal((restarted.afterActive as DurableActiveRow).chat_thread_id, createdThread);
    } finally {
      cleanup(root);
    }
  },
);

/**
 * Class A over a Chat the product created: the focus transfer must cut the
 * generating turn and switch, never refuse. Before the fix no second row was
 * selectable at all, so this shape could not be driven on real hardware: the
 * scenario fails pre-fix at `switch`/`outcomeStatus` (the selection was refused
 * while idle too), and it fails on a regression to a refusal at
 * `cancelClaimedWhileGenerating` and `interruptedLedgerStatus`.
 */
test(
  "selecting a Chat the product created while a turn generates aborts that turn and switches",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-created-chat-in-flight-");
    try {
      const observed = await runSwitchScenario(root, "in-flight-created");
      const createdThread = String(observed.createdThread);
      assert.equal(observed.createdThreadReadableBeforeSelection, true);
      // The turn really was generating when the selection ran.
      assert.equal(observed.generatingLedgerStatus, "presentation_committed");
      // The abort is the one cancel path, claimed while the turn is still mounted.
      assert.equal(observed.cancelClaimedWhileGenerating, true);
      // The player gets the switch to the created Chat, never a refusal.
      assert.equal(observed.outcomeStatus, "switched");
      assert.equal(observed.outcomeThread, createdThread);
      assert.equal(observed.secondThread, createdThread);
      assert.equal(observed.secondCurrent, true);
      assert.equal(observed.firstSuperseded, false);
      assert.equal(observed.successorIsSelectedChat, true);
      assert.equal(observed.successorThreadReadable, true);
      // The interrupted conversation is terminal and kept everything it produced.
      assert.equal(observed.firstThreadStillReadable, true);
      assert.equal(observed.interruptedLedgerStatus, "cancelled");
      assert.equal(observed.interruptedProducedTextKept, true);
      assert.equal(observed.interruptedLedgerPresentation, true);
      assert.ok(Number(observed.interruptedMessageCount) >= 2);
    } finally {
      cleanup(root);
    }
  },
);
