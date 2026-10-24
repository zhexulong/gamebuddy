/**
 * A newly activated connection applies to the Chat that is already mounted.
 *
 * The player's ruling is that configuring a connection makes it work: activating
 * it re-materializes the mounted runtime's model configuration in place, without
 * being told to open a new Chat. These cases drive the real production authority
 * (and its real Pi session) in an isolated process and read the mounted runtime
 * back, because the question is what the already-running session holds:
 *
 * - an idle mount adopts the selection immediately: the live Pi session reports
 *   the newly activated provider/model, while the durable transcript, the turn
 *   ledger and the Pi session's own entries stay exactly as they were;
 * - a Chat that still holds nothing but its opening adopts it just the same and
 *   nothing else changes - there is no re-mount to see;
 * - a Chat whose turn has not reached a terminal ledger state is not disturbed:
 *   the reload answers `turn_in_flight`, the session keeps the model its turn
 *   started with, and the next prompt adopts the selection before it begins.
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

const hotReloadScript = `
  const [coordinatorUrl, manifestUrl, pathLockUrl, reclaimerUrl, storeUrl, runtimeIdentityUrl, catalogUrl,
    connectionServiceUrl, acceptanceUrl, claimUrl, manifestPath, scenario] = process.argv.slice(1);
  const { bindWindowsStaleLockReclaimer } = await import(pathLockUrl);
  const { createBuildWindowsStaleLockReclaimer } = await import(reclaimerUrl);
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const internal = await import(coordinatorUrl);
  const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = internal;
  const { loadHostDeploymentManifest } = await import(manifestUrl);
  const { createChatThreadStore } = await import(storeUrl);
  const { identityKey, resolveRuntimePaths } = await import(runtimeIdentityUrl);
  const { TAVERN_ESCAPE_HATCH_PROVIDER_ID } = await import(catalogUrl);
  const { createTavernConnectionService } = await import(connectionServiceUrl);
  const { createPlayerTurnAcceptor } = await import(acceptanceUrl);
  const { createProviderAttemptClaimer } = await import(claimUrl);
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const manifest = await loadHostDeploymentManifest(manifestPath);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Monotonic observation times: the ledger CAS rejects a step that steps back.
  const nextTime = async () => { await sleep(2); return Date.now(); };

  /**
   * The player's own connection management, over the agent directory of this
   * exact runtime identity. The probe is the only thing faked: an offline test
   * cannot reach an endpoint, and readiness is what activation requires.
   */
  const connection = createTavernConnectionService({
    agentDir: resolveRuntimePaths(manifest.principal, manifest.runtimeRoot).agentDir,
    probe: async () => ({ outcome: "ready", modelIds: [] }),
  });
  let revision = 0;
  const addReadyConnection = async (modelId, port) => {
    const known = new Set((await connection.read()).connections.map((entry) => entry.connectionId));
    const created = await connection.create({
      apiVersion: 1,
      providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
      baseUrl: "http://127.0.0.1:" + port + "/v1",
      apiShape: "openai-completions",
      modelId,
      apiKeyRequired: false,
    });
    const added = created.connections.find((entry) => !known.has(entry.connectionId));
    if (added === undefined) throw new Error("connection_create_projected_no_row");
    // The probe is what makes the record activatable; it reads no endpoint here.
    const probed = await connection.test(added.connectionId, created.revision);
    revision = probed.state.revision;
    return {
      connectionId: probed.connectionId,
      modelId: probed.state.connections.find((entry) => entry.connectionId === probed.connectionId).modelId,
    };
  };
  const activate = async (connectionId) => {
    const state = await connection.activate(connectionId, revision);
    revision = state.revision;
    return state.active === null ? null : { provider: state.active.providerLabel, modelId: state.active.modelId };
  };

  const connectionA = await addReadyConnection("model-a", 9);
  // The no-model scenario mounts BEFORE any connection exists - that is the fresh install - so what
  // it proves is that acquiring the FIRST connection is a reload of the mounted session rather than
  // a remount of it.
  if (scenario !== "no-model") await activate(connectionA.connectionId);

  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
  const lease = await authority.startMountedChatRuntime();
  const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
  const out = { chatThreadId: lease.chatThreadId, chatSurfaceSessionId: lease.chatSurfaceSessionId };

  /** The Pi session file itself: the conversation's own record, byte for byte. */
  const sessionSnapshot = () => {
    const paths = resolveRuntimePaths(manifest.principal, manifest.runtimeRoot, lease.chatSurfaceSessionId);
    const files = readdirSync(paths.sessionDir).filter((entry) => entry.endsWith(".jsonl")).sort();
    const text = files.map((file) => readFileSync(join(paths.sessionDir, file), "utf8")).join("");
    return {
      files,
      text,
      entries: text
        .split("\\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const entry = JSON.parse(line);
          return [entry.type, entry.provider ?? null, entry.modelId ?? null];
        }),
    };
  };
  /** What the player can read: the durable rows and the ledger's own state. */
  const transcriptSnapshot = async () => {
    const state = await store.resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    return {
      messages: state.messages.map((message) => [message.messageId, message.role, message.kind, message.text]),
      ledger: state.turnLedger === null ? null : { turnId: state.turnLedger.turnId, status: state.turnLedger.status },
    };
  };

  /** One complete turn: the provider's half in the Pi session, the durable half in the store. */
  const driveTurn = async (promptText, replyText, responseId, idempotencyKey) => {
    await createPlayerTurnAcceptor(manifest, lease).accept({
      text: promptText,
      locale: "en-US",
      idempotencyKey,
      expectedDraftRevision: 0,
    });
    await createProviderAttemptClaimer(manifest, lease).claim();
    return internal.startMountedAttempt(manifest, lease, (invocation) =>
      internal.consumeMountedAttemptInvocationAdmission(invocation, async (scope) => {
        const sessionManager = scope.runtimeSession.sessionManager;
        sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() });
        sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: replyText }] });
        await scope.transitionStore({ operation: "arm", observedAtMs: await nextTime() });
        await scope.transitionStore({ operation: "running", statusClass: "success", observedAtMs: await nextTime() });
        await scope.transitionPresentation({
          operation: "commit_presentation",
          cancelEpoch: 0,
          message: { messageId: responseId, text: replyText, occurredAtMs: await nextTime() },
          committedAtMs: await nextTime(),
        });
        await scope.transitionPresentation({ operation: "claim_completion", claimedAtMs: await nextTime() });
        return scope.transitionPresentation({ operation: "complete", completedAtMs: await nextTime() });
      }),
    );
  };

  // The mount's own selection, read back from the live session rather than assumed.
  out.mountedOnA = await lease.reloadModelSelection();

  if (scenario === "no-model") {
    // A FRESH INSTALL: mounted with nothing activated. The mount is LIVE (a Pi session file exists)
    // and answers null - the player's selection, not Pi's placeholder.
    out.sessionFilesAtMount = sessionSnapshot().files;
    // Sending anyway is refused at the point of use by Pi's own model guard: the turn settles failed,
    // which is the durable half of the sentence the surface words.
    await createPlayerTurnAcceptor(manifest, lease).accept({
      text: "Synthetic player request with no model",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
    });
    await createProviderAttemptClaimer(manifest, lease).claim();
    const refused = await internal.startMountedAttempt(manifest, lease, (invocation) =>
      internal.consumeMountedAttemptInvocationAdmission(invocation, async (scope) => {
        try {
          await scope.runtimeSession.session.prompt("Synthetic player request with no model", {
            expandPromptTemplates: false,
            source: "rpc",
          });
        } catch (error) {
          out.promptRefusal = error instanceof Error ? error.message : String(error);
        }
        await scope.transitionStore({ operation: "arm", observedAtMs: await nextTime() });
        await scope.transitionStore({ operation: 'running', statusClass: "success", observedAtMs: await nextTime() });
        return await scope.transitionPresentation({
          operation: "fail",
          reasonCode: "runtime_unavailable",
          failedAtMs: await nextTime(),
        });
      }),
    );
    out.refusedTurn = { status: refused.status, reason: refused.reasonCode ?? null };
    // The player then brings a connection. This reaches the runtime that is ALREADY mounted: the same
    // lease, the same Pi session file, and now a real selection.
    const connectionB = await addReadyConnection("model-b", 8);
    out.activatedB = await activate(connectionB.connectionId);
    out.reloaded = await lease.reloadModelSelection();
    out.sessionFilesAfterReload = sessionSnapshot().files;
    out.leaseAfterReload = { chatThreadId: lease.chatThreadId, chatSurfaceSessionId: lease.chatSurfaceSessionId };
  }

  if (scenario === "in-flight") {
    // A durable turn that has not reached a terminal ledger state: the reload must
    // leave it exactly where it is and answer by name.
    await createPlayerTurnAcceptor(manifest, lease).accept({
      text: "Synthetic player request in flight",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
    });
  } else if (scenario === "with-turns") {
    await driveTurn("Synthetic player request", "Synthetic companion reply.", "response_01", "abcdefghijklmnopqrstuv");
  }
  const before = { session: sessionSnapshot(), transcript: await transcriptSnapshot() };
  out.before = before;
  out.ledgerBefore = before.transcript.ledger;

  if (scenario !== "no-model") {
    const connectionB = await addReadyConnection("model-b", 8);
    out.activatedB = await activate(connectionB.connectionId);
    out.reloaded = await lease.reloadModelSelection();
  }

  const after = { session: sessionSnapshot(), transcript: await transcriptSnapshot() };
  out.unchanged = {
    sessionText: before.session.text === after.session.text,
    transcript: JSON.stringify(before.transcript) === JSON.stringify(after.transcript),
    entries: JSON.stringify(before.session.entries) === JSON.stringify(after.session.entries),
  };
  out.after = after;

  if (scenario === "in-flight") {
    // The next prompt adopts the selection before it begins: the live session the
    // runner receives already carries it, and nothing about the turn is disturbed.
    await createProviderAttemptClaimer(manifest, lease).claim();
    await internal.startMountedAttempt(manifest, lease, (invocation) =>
      internal.consumeMountedAttemptInvocationAdmission(invocation, async (scope) => {
        const state = scope.runtimeSession.session.agent.state;
        out.promptStartedWith = {
          provider: state.model === undefined ? null : state.model.provider,
          modelId: state.model === undefined ? null : state.model.id,
          thinkingLevel: state.thinkingLevel,
        };
        await scope.transitionStore({ operation: "arm", observedAtMs: await nextTime() });
        await scope.transitionStore({ operation: "running", statusClass: "success", observedAtMs: await nextTime() });
        await scope.transitionPresentation({
          operation: "commit_presentation",
          cancelEpoch: 0,
          message: { messageId: "response_02", text: "Synthetic companion reply.", occurredAtMs: await nextTime() },
          committedAtMs: await nextTime(),
        });
        await scope.transitionPresentation({ operation: "claim_completion", claimedAtMs: await nextTime() });
        return scope.transitionPresentation({ operation: "complete", completedAtMs: await nextTime() });
      }),
    );
  }

  store.close?.();
  await connection.close();
  process.stdout.write(JSON.stringify(out));
  await authority.close();
`;

async function runHotReloadScenario(
  root: string,
  scenario: "opening-only" | "with-turns" | "in-flight" | "no-model",
): Promise<Record<string, any>> {
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
      hotReloadScript,
      new URL("./continuity-semantic-production-coordinator.internal.js", import.meta.url).href,
      new URL("../deployment-manifest.js", import.meta.url).href,
      new URL("../path-lock.js", import.meta.url).href,
      new URL("../windows-stale-lock-reclaimer/index.js", import.meta.url).href,
      new URL("../tavern/chat-thread-store.js", import.meta.url).href,
      new URL("../runtime-identity.js", import.meta.url).href,
      new URL("../tavern/provider-catalog.js", import.meta.url).href,
      new URL("../tavern/connection-service.js", import.meta.url).href,
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
  return JSON.parse(Buffer.concat(output).toString("utf8")) as Record<string, any>;
}

const realWindowsMount = {
  skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false,
};

test(
  "an idle mounted Chat adopts a newly activated connection in place, byte-identically",
  realWindowsMount,
  async (t) => {
    const root = canonicalTestRootSync("semantic-connection-hot-reload-");
    try {
      const observed = await runHotReloadScenario(root, "with-turns");
      t.diagnostic(
        JSON.stringify({
          mountedOnA: observed.mountedOnA,
          reloaded: observed.reloaded,
          entries: observed.before.session.entries,
          transcript: observed.before.transcript,
        }),
      );
      // (a) The mount runs on the connection that was active when it opened, on the
      // thinking level Pi clamped that model to (a mount clamps, so this reload must
      // reach the same state).
      assert.equal(observed.mountedOnA.status, "applied");
      assert.equal(observed.mountedOnA.modelSelection.provider, "gamebuddy-openai-compatible");
      assert.equal(observed.mountedOnA.modelSelection.modelId, "model-a");
      // The Pi session itself records that model as the conversation's own.
      assert.ok(
        observed.before.session.entries.some(
          (entry: unknown[]) =>
            entry[0] === "model_change" && entry[1] === "gamebuddy-openai-compatible" && entry[2] === "model-a",
        ),
        `expected the mount's own model_change entry, got ${JSON.stringify(observed.before.session.entries)}`,
      );
      // (b) The player activates B...
      assert.deepEqual(observed.activatedB, { provider: "OpenAI-compatible endpoint", modelId: "model-b" });
      // (c) ...and the mounted runtime carries B, read back from the live session.
      assert.equal(observed.reloaded.status, "applied");
      assert.deepEqual(observed.reloaded.modelSelection, {
        provider: "gamebuddy-openai-compatible",
        modelId: "model-b",
        thinkingLevel: observed.mountedOnA.modelSelection.thinkingLevel,
      });
      // While the transcript, the ledger and the Pi session's own entries are unchanged.
      assert.equal(observed.unchanged.sessionText, true);
      assert.equal(observed.unchanged.entries, true);
      assert.equal(observed.unchanged.transcript, true);
      assert.deepEqual(observed.after.transcript, observed.before.transcript);
      assert.ok(observed.before.transcript.messages.length >= 3, "the Chat must hold a turn, not only its opening");
      assert.equal(observed.before.transcript.ledger.status, "completed");
      assert.equal(observed.after.transcript.ledger.status, "completed");
    } finally {
      cleanup(root);
    }
  },
);

test("a Chat holding nothing but its opening adopts it silently", realWindowsMount, async (t) => {
  const root = canonicalTestRootSync("semantic-connection-hot-reload-opening-");
  try {
    const observed = await runHotReloadScenario(root, "opening-only");
    t.diagnostic(
      JSON.stringify({
        before: observed.before.transcript,
        reloaded: observed.reloaded,
        after: observed.after.transcript,
      }),
    );
    assert.equal(observed.mountedOnA.modelSelection.modelId, "model-a");
    assert.equal(observed.reloaded.status, "applied");
    assert.equal(observed.reloaded.modelSelection.modelId, "model-b");
    // Nothing but the opening, and the reload added nothing to it.
    assert.equal(observed.before.transcript.ledger, null);
    assert.deepEqual(observed.after.transcript, observed.before.transcript);
    assert.equal(observed.unchanged.sessionText, true);
    assert.equal(observed.unchanged.entries, true);
  } finally {
    cleanup(root);
  }
});

test("a Chat with a turn in flight keeps it, and the next prompt adopts the selection", realWindowsMount, async (t) => {
  const root = canonicalTestRootSync("semantic-connection-hot-reload-in-flight-");
  try {
    const observed = await runHotReloadScenario(root, "in-flight");
    t.diagnostic(
      JSON.stringify({
        ledger: observed.ledgerBefore,
        reloaded: observed.reloaded,
        promptStartedWith: observed.promptStartedWith,
      }),
    );
    // The turn is real: accepted and durable, and not terminal.
    assert.equal(observed.ledgerBefore.status, "accepted_queued");
    assert.deepEqual(observed.activatedB, { provider: "OpenAI-compatible endpoint", modelId: "model-b" });
    // (d) The reload refused by name and the runtime kept the model its turn started with...
    assert.equal(observed.reloaded.status, "turn_in_flight");
    assert.equal(observed.reloaded.modelSelection.provider, "gamebuddy-openai-compatible");
    assert.equal(observed.reloaded.modelSelection.modelId, "model-a");
    assert.equal(observed.unchanged.sessionText, true);
    assert.equal(observed.unchanged.transcript, true);
    // ...and the selection was not lost: the next prompt begins on B.
    assert.deepEqual(observed.promptStartedWith, {
      provider: "gamebuddy-openai-compatible",
      modelId: "model-b",
      thinkingLevel: observed.reloaded.modelSelection.thinkingLevel,
    });
  } finally {
    cleanup(root);
  }
});

/**
 * The fresh install's whole journey, in the production authority and one real Pi session.
 *
 * This is the unit the owner's ruling needed proof for: a product with no model OPENS, and
 * bringing the first connection later does not remount it. The scenario mounts before any
 * connection exists, so every fact below is about that state rather than about a configured root
 * degenerating into one.
 */
test(
  "a mount that opened with no model opens, refuses the send, and adopts the first connection in place",
  realWindowsMount,
  async (t) => {
    const root = canonicalTestRootSync("semantic-connection-hot-reload-no-model-");
    try {
      const observed = await runHotReloadScenario(root, "no-model");
      t.diagnostic(
        JSON.stringify({
          mounted: observed.mountedOnA,
          refusal: observed.promptRefusal,
          refusedTurn: observed.refusedTurn,
          reloaded: observed.reloaded,
          filesAtMount: observed.sessionFilesAtMount,
          filesAfterReload: observed.sessionFilesAfterReload,
        }),
      );
      // (a) It mounted. Not "it refused honestly" - the mount succeeded with nothing configured, and
      // it answers `null` because the player has selected nothing. Naming Pi's `unknown` placeholder
      // here would be a model the player never chose.
      assert.deepEqual(observed.mountedOnA, { status: "applied", modelSelection: null });
      // The mount is a real Pi session, not a placeholder shell: its file exists before anything is
      // sent, which is what later makes acquiring a model a reload instead of a remount.
      assert.equal(observed.sessionFilesAtMount.length, 1);

      // (b) The send is refused at the point of use, and the turn settles durably failed. Pi's own
      // prompt guard is what refuses: the session runs on its placeholder model, which has no
      // configured auth, so nothing leaves the machine and no provider is contacted. The player-facing
      // sentence is the surface's, worded from that durable `runtime_unavailable` - which is why the
      // refusal does not have to be a message the player reads directly.
      assert.match(String(observed.promptRefusal), /No API key found for the selected model/u);
      assert.equal(observed.refusedTurn.status, "failed");
      assert.equal(observed.refusedTurn.reason, "runtime_unavailable");

      // (c) The player brings a connection. The ALREADY MOUNTED runtime adopts it...
      assert.deepEqual(observed.activatedB, { provider: "OpenAI-compatible endpoint", modelId: "model-b" });
      assert.equal(observed.reloaded.status, "applied");
      assert.equal(observed.reloaded.modelSelection.provider, "gamebuddy-openai-compatible");
      assert.equal(observed.reloaded.modelSelection.modelId, "model-b");
      // ...without a remount: the same lease object (same thread/surface pair), the same single Pi
      // session file, and the conversation's own record untouched by acquiring a model.
      assert.deepEqual(observed.leaseAfterReload, {
        chatThreadId: observed.chatThreadId,
        chatSurfaceSessionId: observed.chatSurfaceSessionId,
      });
      assert.deepEqual(observed.sessionFilesAfterReload, observed.sessionFilesAtMount);
    } finally {
      cleanup(root);
    }
  },
);
