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
 * - a Chat the player archived while it was selected, before the shell could move
 *   the selection, is not re-selected by the next start: the durable transcript
 *   authority owns "is this Chat live", so the mount lands on the Chat it still
 *   holds (ADR-0011's 2026-11-16 mediation);
 * - archiving the selected Chat through the management route leaves the semantic
 *   catalog saying `active` while the transcript authority says `archived`, and the
 *   selection request for that Chat is therefore still admitted while no list offers
 *   it (the divergence ADR-0011 pins, read from both files).
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
  const [coordinatorUrl, manifestUrl, pathLockUrl, reclaimerUrl, storeUrl, runtimeUrl, acceptanceUrl, claimUrl, contentPortUrl, providerStartUrl, managementUrl, contractUrl, manifestPath, scenario] =
    process.argv.slice(2);
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
  // The production runner's one settlement authority for a published cancel claim:
  // the gate drives the real function, not a copy of it.
  const { settlePublishedCancellation } = await import(providerStartUrl);
  const { DatabaseSync } = await import("node:sqlite");
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  const manifest = await loadHostDeploymentManifest(manifestPath);
  // The restart scenario is a second process over a root the first one already
  // provisioned: it opens the known authority (and reconciles the terminal
  // teardown the first process left) instead of provisioning a fresh one.
  const authority =
    scenario === "select-created-after-restart" || scenario === "archive-selected-after-restart"
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
        "SELECT t.chat_surface_session_id, t.chat_thread_id, t.lifecycle, t.content_receipt_json IS NOT NULL AS verified, m.management_revision FROM production_continuity_thread t LEFT JOIN production_chat_lifecycle_metadata m ON m.chat_surface_session_id = t.chat_surface_session_id ORDER BY t.chat_surface_session_id",
      )
      .all();
    const active = db
      .prepare(
        "SELECT chat_thread_id, chat_surface_session_id, selection_revision, expected_selection_json FROM production_active_selection WHERE singleton=1",
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
  /** The status a selection answered, or the refusal it raised - never a bare "did not throw". */
  const selectionOutcome = async (work) => {
    try {
      return (await work()).status;
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

  /**
   * The durable terminal shape of the conversation switched away from, read from
   * the store: one class at every phase, and never a failure for a turn whose
   * provider answered. companionMessages is the text ADR-0010:62 keeps (committed
   * presentation content) or legitimately discards (volatile preview deltas that
   * were never durable).
   */
  const readInterruptedTerminal = (state) => {
    const ledger = state.turnLedger;
    return {
      turnId: ledger === null ? null : ledger.turnId,
      status: ledger === null ? null : ledger.status,
      observation:
        ledger !== null && "observation" in ledger && ledger.observation !== undefined
          ? ledger.observation.phase
          : null,
      presentation: ledger !== null && ledger.status === "cancelled" ? ledger.presentation !== null : null,
      cancelClaimedAtMs: ledger !== null && ledger.status === "cancelled" ? ledger.cancelClaimedAtMs : null,
      cancelledAtMs: ledger !== null && ledger.status === "cancelled" ? ledger.cancelledAtMs : null,
      reasonCode: ledger !== null && ledger.status === "failed" ? ledger.reasonCode : null,
      failedAtMs: ledger !== null && ledger.status === "failed" ? ledger.failedAtMs : null,
      companionMessages: state.messages.filter((message) => message.kind === "response").length,
    };
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
  } else if (scenario === "archive-selected-create-only") {
    // The player lands in a new Chat and then archives it through the durable management
    // call, and this process ends before the shell's own selection migration runs: the
    // crash/refusal shape where the semantic catalog still names the archived Chat.
    const target = await createSecondChat();
    const mounted = await selectAndMount(target);
    out.createdThread = target.chatThreadId;
    out.createdSurface = target.chatSurfaceSessionId;
    out.mountedThread = mounted.successorThread;
    out.mountedSurface = mounted.successorSurface;
    const archived = await store.transitionLifecycle({
      chatThreadId: target.chatThreadId,
      chatSurfaceSessionId: target.chatSurfaceSessionId,
      companionId: manifest.principal.companionId,
      continuityId: manifest.principal.continuityId,
      expectedManagementRevision: 1,
      operation: "archive",
    });
    out.archivedStatus = archived.lifecycleStatus;
    const durable = readDurable();
    out.archivedSemanticLifecycle = durable.threads.find(
      (thread) => thread.chat_thread_id === target.chatThreadId,
    )?.lifecycle;
    out.selectionAfterArchive = durable.active.chat_thread_id;
  } else if (scenario === "archive-selected-after-restart") {
    // Same root, next process, no shell to migrate the selection. The mount at the top of
    // this script already had to land on a Chat the durable authority still holds - before
    // the reconciliation it landed on the archived one and the materializer refused it.
    out.mountedThread = firstThread;
    out.mountedSurface = firstSurface;
    const after = readDurable();
    out.afterThreads = after.threads;
    out.afterActive = after.active;
  } else if (scenario === "archive-selected-through-route") {
    // Item 1 of the double-authority settlement: the production management route's own
    // service archives the Chat the player is looking at, and both authorities are then
    // read from their own files and reported side by side. The Chat is created and
    // selected for real first, so this is the mounted-and-selected shape the panel's own
    // archive button produces, not an idle one.
    const target = await createSecondChat();
    const selection = await authority.requestChatSelection({
      kind: "select",
      selectionGeneration: firstGeneration,
      chatThreadId: target.chatThreadId,
      chatSurfaceSessionId: target.chatSurfaceSessionId,
    });
    const mounted = await authority.startMountedChatRuntime();
    out.selectionStatus = selection.status;
    out.mountedThread = mounted.chatThreadId;
    out.mountedSurface = mounted.chatSurfaceSessionId;
    out.mountedIsTarget = mounted.chatThreadId === target.chatThreadId;
    out.createdThread = target.chatThreadId;
    out.createdSurface = target.chatSurfaceSessionId;
    const { createChatManagementService } = await import(managementUrl);
    const { composeTavernProfile, TAVERN_BROWSER_API_VERSION } = await import(contractUrl);
    const profile = composeTavernProfile({
      profileId: "gamebuddy.tavern-management.chat-list-title",
      releaseTier: "tavern_management",
      routeIds: ["bootstrap", "chat.list", "chat.rename", "draft.read", "draft.save", "draft.discard"],
      operationIds: ["draft.save", "draft.discard", "chat.rename"],
      navigationItemIds: ["chat", "characters"],
    });
    const service = createChatManagementService({ manifest, lease: mounted, profile });
    const handle = mounted.browserProjection.projectChatHandle(target.chatThreadId, target.chatSurfaceSessionId);
    out.listedBeforeArchive = (await service.listChats({ apiVersion: TAVERN_BROWSER_API_VERSION })).chats.map(
      (chat) => chat.handle,
    );
    out.archived = await service.transitionLifecycle({
      apiVersion: TAVERN_BROWSER_API_VERSION,
      chatHandle: handle,
      expectedManagementRevision: 1,
      operation: "archive",
    });
    out.targetHandle = handle;
    // (c) The panel's own report: the list the player was reading no longer offers it.
    // Read on the same lease, before any migration - this service is bound to the lease it
    // was constructed with, and a superseded lease answers chat_management_service_unavailable.
    out.listedAfterArchive = (await service.listChats({ apiVersion: TAVERN_BROWSER_API_VERSION })).chats.map(
      (chat) => chat.handle,
    );
    // Side by side. The transcript row comes from the durable authority's own readback;
    // the semantic rows come from a separate read-only connection to its own file, so
    // neither number is what the other authority reports about itself.
    const durableRow = (await store.resumeThread(target.chatThreadId, target.chatSurfaceSessionId)).thread;
    out.transcriptAfterArchive = {
      lifecycleStatus: durableRow.lifecycleStatus,
      managementRevision: durableRow.managementRevision,
    };
    const semantic = readDurable();
    const semanticRow = semantic.threads.find((row) => row.chat_thread_id === target.chatThreadId);
    out.semanticAfterArchive = {
      lifecycle: semanticRow.lifecycle,
      managementRevision: semanticRow.management_revision,
      selectedThreadId: semantic.active.chat_thread_id,
      selectionRevision: semantic.active.selection_revision,
    };
    // (a) The Shell's own migration from ADR-0011: the selection moves to the Chat the
    // durable authority still holds, and the mount succeeds there.
    out.shellMigration = await selectionOutcome(() =>
      authority.requestChatSelection({
        kind: "select",
        selectionGeneration: mounted.browserProjection.selectionGeneration,
        chatThreadId: firstThread,
        chatSurfaceSessionId: firstSurface,
      }),
    );
    const migrated = await authority.startMountedChatRuntime();
    out.afterMigrationMountedThread = migrated.chatThreadId;
    // (a)/(b) The player's next request for the archived Chat, after the migration moved the
    // selection away. One call shows both halves of the divergence: the pre-mount settlement
    // admits the target (its semantic row still reads active) and commits its select_chat,
    // and then the mount refuses the conversation the settlement just selected.
    out.selectionOfArchived = await selectionOutcome(() =>
      authority.requestChatSelection({
        kind: "select",
        selectionGeneration: migrated.browserProjection.selectionGeneration,
        chatThreadId: target.chatThreadId,
        chatSurfaceSessionId: target.chatSurfaceSessionId,
      }),
    );
    const refused = readDurable();
    out.semanticAfterRefusedSelection = {
      selectedThreadId: refused.active.chat_thread_id,
      selectionRevision: refused.active.selection_revision,
      expectedSelection: refused.active.expected_selection_json,
    };
    service.close();
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
        // The aborted turn's own runner settles it through the production
        // settlement authority: the durable cancel winner was already published by
        // the selection's abort, so this only terminalizes it - the stop's own
        // abort is never reported as this turn's failure.
        const settled = await settlePublishedCancellation(scope);
        releasePrompt();
        if (settled === undefined || settled.outcome !== "cancelled")
          throw new Error("expected_published_cancel_winner");
        return settled.ledger;
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
    out.interruptedTerminal = readInterruptedTerminal(interrupted);
    // The terminal shape every phase must share: cancelled, claimed, never failed.
    out.interruptedCancelClaimedAtMs =
      interrupted.turnLedger !== null && interrupted.turnLedger.status === "cancelled"
        ? interrupted.turnLedger.cancelClaimedAtMs
        : null;
    out.interruptedCancelledAtMs =
      interrupted.turnLedger !== null && interrupted.turnLedger.status === "cancelled"
        ? interrupted.turnLedger.cancelledAtMs
        : null;
    out.interruptedReasonCode =
      interrupted.turnLedger !== null && interrupted.turnLedger.status === "failed"
        ? interrupted.turnLedger.reasonCode
        : null;
    out.interruptedFailedAtMs =
      interrupted.turnLedger !== null && interrupted.turnLedger.status === "failed"
        ? interrupted.turnLedger.failedAtMs
        : null;

    const successor = await store.resumeThread(second.chatThreadId, second.chatSurfaceSessionId);
    out.successorThreadReadable = successor.thread.chatThreadId === second.chatThreadId;
    out.successorIsSelectedChat = successor.thread.chatThreadId === outcome.chatThreadId;
    out.firstThreadStillReadable = interrupted.thread.chatThreadId === firstThread;
  } else if (scenario === "in-flight-armed" || scenario === "in-flight-running") {
    // The two phases a switch reaches through the mounted cancel seam before any
    // presentation exists: a durable pre-invocation armed observation, and a turn
    // whose provider has already answered (durable running observation). The real
    // admission scope is consumed here, so the published claim's own settlement
    // authority is the production code under test, not a copy of it.
    const accepted = await createPlayerTurnAcceptor(manifest, first).accept({
      text: "Hello",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
    });
    await createProviderAttemptClaimer(manifest, first).claim();
    let releasePrompt;
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const startTask = internal.startMountedAttempt(manifest, first, (invocation) =>
      internal.consumeMountedAttemptInvocationAdmission(invocation, async (scope) => {
        await scope.transitionStore({ operation: "arm", observedAtMs: Date.now() });
        if (scenario === "in-flight-running") {
          await sleep(4);
          await scope.transitionStore({ operation: "running", statusClass: "success", observedAtMs: Date.now() });
        }
        releasePrompt = scope.beginActivePrompt();
        await gate;
        const settled = await settlePublishedCancellation(scope);
        releasePrompt();
        if (settled === undefined || settled.outcome !== "cancelled")
          throw new Error("expected_published_cancel_winner");
        return settled.ledger;
      }),
    );
    await waitFor(() => releasePrompt !== undefined);
    const generating = await store.resumeThread(firstThread, firstSurface);
    out.generatingLedgerStatus = generating.turnLedger === null ? null : generating.turnLedger.status;
    out.generatingObservation =
      generating.turnLedger !== null && "observation" in generating.turnLedger && generating.turnLedger.observation !== undefined
        ? generating.turnLedger.observation.phase
        : null;

    const selection = authority.requestChatSelection({ kind: "create", selectionGeneration: firstGeneration });
    // The abort publishes its durable winner before it aborts anything: armed is
    // terminalized by the seam in one step, while running gets the non-terminal
    // claim the turn's own runner has to finish.
    const wonStatus = scenario === "in-flight-armed" ? "cancelled" : "cancel_claimed";
    await waitFor(async () => (await store.resumeThread(firstThread, firstSurface)).turnLedger?.status === wonStatus);
    out.cancelWonWhileGenerating = true;
    releaseGate();
    const outcome = await selection;
    await startTask;

    out.outcomeStatus = outcome.status;
    out.outcomeThread = outcome.chatThreadId;
    out.firstSuperseded = isCurrentMountedChatRuntimeLease(first);
    const second = await authority.startMountedChatRuntime();
    out.secondThread = second.chatThreadId;
    out.secondSurface = second.chatSurfaceSessionId;
    out.secondCurrent = isCurrentMountedChatRuntimeLease(second);
    out.successorIsSelectedChat = second.chatThreadId === outcome.chatThreadId;
    out.successorThreadReadable = true;
    out.acceptedTurnId = accepted.turnId;

    const interrupted = await store.resumeThread(firstThread, firstSurface);
    out.firstThreadStillReadable = interrupted.thread.chatThreadId === firstThread;
    out.interruptedTurnId = interrupted.turnLedger === null ? null : interrupted.turnLedger.turnId;
    out.interruptedKeptPlayerText = interrupted.messages.some(
      (message) => message.kind === "player" && message.text === "Hello",
    );
    out.interruptedMessageCount = interrupted.messages.length;
    out.interruptedTerminal = readInterruptedTerminal(interrupted);

    const successor = await store.resumeThread(second.chatThreadId, second.chatSurfaceSessionId);
    out.successorThreadReadable = successor.thread.chatThreadId === second.chatThreadId;
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
    out.interruptedTerminal = readInterruptedTerminal(firstState);

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
    out.interruptedTerminal = readInterruptedTerminal(firstState);

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
    | "in-flight-armed"
    | "in-flight-running"
    | "durable-unstarted"
    | "durable-not-started"
    | "select-created"
    | "select-created-create-only"
    | "select-created-after-restart"
    | "archive-selected-create-only"
    | "archive-selected-after-restart"
    | "archive-selected-through-route",
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
  // The scenario script is handed to the child as a FILE, not through `--eval`: with eleven
  // module URLs after it the command line sat within ~10% of Windows' 32767-character limit,
  // and one more scenario crossed it (`spawn ENAMETOOLONG`). A file has no such ceiling.
  const scriptPath = join(root, "switch-scenario.mjs");
  await writeFile(scriptPath, switchScript);
  const child = spawn(
    process.execPath,
    [
      scriptPath,
      new URL("./continuity-semantic-production-coordinator.internal.js", import.meta.url).href,
      new URL("../deployment-manifest.js", import.meta.url).href,
      new URL("../path-lock.js", import.meta.url).href,
      new URL("../windows-stale-lock-reclaimer/index.js", import.meta.url).href,
      new URL("../tavern/chat-thread-store.js", import.meta.url).href,
      new URL("../runtime.js", import.meta.url).href,
      new URL("../tavern/player-turn-acceptance.js", import.meta.url).href,
      new URL("../tavern/provider-attempt-claim.js", import.meta.url).href,
      new URL("../tavern/initial-chat-exact-content-port.js", import.meta.url).href,
      new URL("../tavern/p4-provider-start-execution.js", import.meta.url).href,
      new URL("../tavern/chat-management/chat-management-service.js", import.meta.url).href,
      new URL("../tavern/browser-contract/index.js", import.meta.url).href,
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
      // ...and the terminal it settled on is the cancel, not a failure: the row is
      // cancelled, it carries both cancel timestamps, and it names no reason.
      const terminal = observed.interruptedTerminal as Readonly<Record<string, unknown>>;
      assert.equal(terminal.status, "cancelled");
      assert.equal(terminal.presentation, true);
      assert.equal(terminal.companionMessages, 1);
      assert.equal(terminal.reasonCode, null);
      assert.equal(terminal.failedAtMs, null);
      assert.ok(Number(terminal.cancelClaimedAtMs) > 0);
      assert.ok(Number(terminal.cancelledAtMs) >= Number(terminal.cancelClaimedAtMs));
    } finally {
      cleanup(root);
    }
  },
);

/**
 * The rule this file gates, phase by phase: the same gesture must have the same
 * outcome at every phase of a turn. A switch that lands after the provider has
 * already answered is the phase the real run got wrong - the store read back
 * `failed`/`runtime_unavailable` with `cancel_claimed_at_ms` null and no text,
 * because the cancel the switch had already published was never consumed and the
 * stop's own abort was reported as this turn's failure. The phase below asserts
 * the honest terminal instead: the published claim wins, the runner finishes it as
 * `cancelled`, and the surface has no failure to report.
 */
test(
  "a switch after the provider answered settles the turn as the cancel it published",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-turn-level-in-flight-running-");
    try {
      const observed = await runSwitchScenario(root, "in-flight-running");
      // The turn really had crossed its provider boundary: durable running with the
      // provider's own success observation, and no presentation yet.
      assert.equal(observed.generatingLedgerStatus, "running");
      assert.equal(observed.generatingObservation, "running");
      // The abort is the one cancel path, and its durable winner is claimed while
      // the turn is still mounted.
      assert.equal(observed.cancelWonWhileGenerating, true);
      // The player gets the switch, never a refusal and never a wait.
      assert.equal(observed.outcomeStatus, "switched");
      assert.equal(observed.firstSuperseded, false);
      assert.equal(observed.secondCurrent, true);
      assert.equal(observed.successorIsSelectedChat, true);
      assert.equal(observed.successorThreadReadable, true);
      assert.equal(observed.firstThreadStillReadable, true);
      // One class at every phase: cancelled, never failed, no reason code, no
      // failed timestamp - the player is not told to retry something that did not
      // fail, and the surface reads chatStopped rather than chatFailed.
      const terminal = observed.interruptedTerminal as Readonly<Record<string, unknown>>;
      assert.equal(terminal.status, "cancelled");
      assert.equal(terminal.observation, "running");
      assert.equal(terminal.reasonCode, null);
      assert.equal(terminal.failedAtMs, null);
      assert.ok(Number(terminal.cancelClaimedAtMs) > 0);
      assert.ok(Number(terminal.cancelledAtMs) >= Number(terminal.cancelClaimedAtMs));
      // ADR-0010:62: only never-durable volatile preview deltas are discarded, so a
      // turn interrupted before its presentation commit holds no reply and no
      // presentation - asserted as intended, not as an accident.
      assert.equal(terminal.presentation, false);
      assert.equal(terminal.companionMessages, 0);
      assert.equal(observed.interruptedKeptPlayerText, true);
    } finally {
      cleanup(root);
    }
  },
);

/**
 * The same gesture at the phase before the provider answers. The seam terminalizes
 * this one in a single step, so the assertion is that both phases land on the SAME
 * class of terminal: this is the pair that makes the rule a rule rather than a
 * single-case fix.
 */
test(
  "a switch while the turn is armed settles the turn as the same cancel",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-turn-level-in-flight-armed-");
    try {
      const observed = await runSwitchScenario(root, "in-flight-armed");
      assert.equal(observed.generatingLedgerStatus, "attempt_starting");
      assert.equal(observed.generatingObservation, "armed");
      assert.equal(observed.cancelWonWhileGenerating, true);
      assert.equal(observed.outcomeStatus, "switched");
      assert.equal(observed.firstSuperseded, false);
      assert.equal(observed.secondCurrent, true);
      assert.equal(observed.successorIsSelectedChat, true);
      assert.equal(observed.firstThreadStillReadable, true);
      const terminal = observed.interruptedTerminal as Readonly<Record<string, unknown>>;
      assert.equal(terminal.status, "cancelled");
      assert.equal(terminal.observation, "armed");
      assert.equal(terminal.reasonCode, null);
      assert.equal(terminal.failedAtMs, null);
      // The armed phase terminalizes claim and cancel in one transition.
      assert.equal(terminal.cancelClaimedAtMs, terminal.cancelledAtMs);
      assert.equal(terminal.presentation, false);
      assert.equal(terminal.companionMessages, 0);
      assert.equal(observed.interruptedKeptPlayerText, true);
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
      // The accepted phase joins the same class as every other phase, with no
      // failure recorded for a turn nothing ever failed at.
      const terminal = observed.interruptedTerminal as Readonly<Record<string, unknown>>;
      assert.equal(terminal.status, "cancelled");
      assert.equal(terminal.reasonCode, null);
      assert.equal(terminal.failedAtMs, null);
      assert.ok(Number(terminal.cancelClaimedAtMs) > 0);
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
      const terminal = observed.interruptedTerminal as Readonly<Record<string, unknown>>;
      assert.equal(terminal.status, "cancelled");
      assert.equal(terminal.reasonCode, null);
      assert.equal(terminal.failedAtMs, null);
      assert.ok(Number(terminal.cancelClaimedAtMs) > 0);
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
  management_revision: number;
}>;
type DurableActiveRow = Readonly<{
  chat_thread_id: string;
  chat_surface_session_id: string;
  selection_revision: number;
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

/**
 * The other half of ADR-0011: migrating the selection is the shell's job, and the shell
 * can die or refuse between the durable archive and that move. The next start must
 * therefore answer "which Chat is mounted" from the durable transcript authority, not
 * from a catalog that still calls the archived Chat active.
 *
 * Red before the reconciliation: the restart re-selected the archived Chat and the
 * materializer refused it, so the process exited non-zero instead of mounting. Green
 * now: the mount lands on the Chat the durable store still holds, and the archived one
 * is mirrored instead of re-selected.
 */
test(
  "a selected Chat archived before the shell could migrate the selection is not re-selected on the next start",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-archive-selected-");
    try {
      const archived = await runSwitchScenario(root, "archive-selected-create-only");
      const archivedThread = String(archived.createdThread);
      // The crash window this reconciliation exists for: the durable archive committed,
      // and the catalog still called that Chat active and still named it the selection.
      assert.equal(archived.archivedStatus, "archived");
      assert.equal(archived.archivedSemanticLifecycle, "active");
      assert.equal(archived.selectionAfterArchive, archivedThread);

      const restarted = await runSwitchScenario(root, "archive-selected-after-restart");
      // The mount landed on the Chat the durable authority still holds ...
      assert.equal(restarted.mountedThread, String(archived.firstThread));
      assert.notEqual(restarted.mountedThread, archivedThread);
      // ... and the selection no longer names the archived Chat: no dangling cursor is left
      // behind. The archived row itself keeps its registration-time lifecycle, because a
      // start may write exactly one Chat command - the settling select the mount is proved
      // against - and the store refuses to transition the Chat it selects (ADR-0011's
      // 2026-11-16 mediation records that bound and why it is harmless here).
      assert.equal((restarted.afterActive as DurableActiveRow).chat_thread_id, String(archived.firstThread));
    } finally {
      cleanup(root);
    }
  },
);

/**
 * Item 1 of the double-authority settlement, driven on a real archive: the production
 * management route's own service archives the Chat the player is looking at, and both
 * authorities are read from their own files afterwards.
 *
 * The two rows disagree, and the test says so rather than asserting them into agreement:
 * - `tavern.sqlite` `tavern_threads.lifecycle_status` = `archived`, `management_revision` = 2
 *   (the route's own CAS advanced once);
 * - `gamebuddy-continuity-v1.sqlite` `production_continuity_thread.lifecycle` = `active`,
 *   `production_chat_lifecycle_metadata.management_revision` = 1 (write-once, at registration).
 *
 * With that in hand the three questions the ADR's mediation rests on are answered by
 * driving the real Host, not by reading the store:
 * (a) the semantic store still ACCEPTS `select_chat` for the archived Chat: its admission
 *     is the lifecycle row, which still reads `active`, so the settlement commits the
 *     selection onto the archived Chat (asserted from the file afterwards, revision 3);
 * (b) the mount REFUSES it: the same `requestChatSelection` call answers
 *     `chat_runtime_exact_content_unavailable`, because `prepareExactChatRuntimeConstruction`
 *     reads the transcript authority's `lifecycle_status` and nothing else
 *     (`continuity-semantic-chat-runtime-construction.private.test.ts` gates that refusal
 *     on its own real archive);
 * (c) no player-pressable affordance offers the archived Chat at all: `chat.list` drops it
 *     (asserted here) and `chat.select` resolves a target only among durably active Chats
 *     (`desktop-presentation-admission-owner.ts` `chatSelectProvisioner`), so the only
 *     pressable next step is the Shell's migration - which is asserted here to succeed.
 */
test(
  "archiving the selected Chat through the route leaves the two authorities disagreeing, and the selection still works",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-archive-selected-through-route-");
    try {
      const observed = await runSwitchScenario(root, "archive-selected-through-route");
      const targetThread = String(observed.createdThread);
      const targetSurface = String(observed.createdSurface);
      // The shape the panel's own archive button produces: the Chat is mounted and selected.
      assert.equal(observed.selectionStatus, "switched");
      assert.equal(observed.mountedIsTarget, true);
      assert.equal(observed.mountedThread, targetThread);
      assert.equal(observed.mountedSurface, targetSurface);
      const handle = String(observed.targetHandle);
      assert.ok((observed.listedBeforeArchive as readonly string[]).includes(handle));

      // The route's own service answered the archive on the mounted Chat.
      const archived = observed.archived as Readonly<Record<string, unknown>>;
      assert.equal(archived.status, "archived");
      assert.equal(archived.managementRevision, 2);
      assert.equal(archived.handle, handle);

      // Side by side, each read from its own authority.
      const transcript = observed.transcriptAfterArchive as Readonly<Record<string, unknown>>;
      assert.equal(transcript.lifecycleStatus, "archived");
      assert.equal(transcript.managementRevision, 2);
      const semantic = observed.semanticAfterArchive as Readonly<Record<string, unknown>>;
      assert.equal(semantic.lifecycle, "active");
      assert.equal(semantic.managementRevision, 1);
      // ...and the semantic selection still names the Chat the player archived.
      assert.equal(semantic.selectedThreadId, targetThread);
      assert.equal(semantic.selectionRevision, 2);

      // (a)+(b) One request shows both halves of the divergence. The pre-mount settlement
      // admits the target - its semantic row still reads active - and commits its
      // select_chat; the mount then refuses the conversation it just selected.
      assert.equal(observed.shellMigration, "switched");
      assert.equal(observed.afterMigrationMountedThread, String(observed.firstThread));
      assert.equal(observed.selectionOfArchived, "chat_runtime_exact_content_unavailable");
      // The selection was really moved onto the archived Chat before the refusal: the
      // divergence is a committed semantic fact, not a plan that failed first.
      const afterRefusal = observed.semanticAfterRefusedSelection as Readonly<Record<string, unknown>>;
      assert.equal(afterRefusal.selectedThreadId, targetThread);
      assert.equal(afterRefusal.selectionRevision, 4);
      assert.equal(afterRefusal.expectedSelection, null);

      // (c) No list offers it, so no player gesture can press it.
      assert.equal((observed.listedAfterArchive as readonly string[]).includes(handle), false);
    } finally {
      cleanup(root);
    }
  },
);
