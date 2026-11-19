/**
 * The Chat runtime's own exit, driven over the real production mounted authority.
 *
 * The exit reclamation closes the presentation port first, so by the time the Chat runtime's step runs, an in-flight
 * turn's stream has no reader: the browser that would have shown the output is gone. Waiting for that stream to finish
 * is waiting for output nobody can see - measured here as the exit never returning while the turn is still generating
 * - so the step aborts the turn through the same cancel seam an authenticated browser Stop uses, keeps the text the
 * turn already committed, and only waits for that prompt's own runner to terminalize the row.
 *
 * The scenario runs in its own process because the authority owns a real Windows root mutex, which cannot be shared
 * with another construction in this process.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { before } from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import { bindVerifiedWindowsLockReclaimerForTest } from "../test-support/windows-lock-reclaimer.test-support.js";

before(async () => {
  await bindVerifiedWindowsLockReclaimerForTest("continuity-semantic-exit-drain.test");
});

const principal = Object.freeze({
  playerId: "player_01",
  companionId: "companion_01",
  continuityId: "continuity_01",
});

/** How long the exit may take before this test calls it "waiting for the stream". */
const EXIT_SETTLE_BOUND_MS = 3_000;

const exitScript = `
  const [coordinatorUrl, manifestUrl, pathLockUrl, reclaimerUrl, storeUrl, runtimeUrl, acceptanceUrl, claimUrl, providerStartUrl, manifestPath] =
    process.argv.slice(1);
  const { bindWindowsStaleLockReclaimer } = await import(pathLockUrl);
  const { createBuildWindowsStaleLockReclaimer } = await import(reclaimerUrl);
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const internal = await import(coordinatorUrl);
  const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = internal;
  const { loadHostDeploymentManifest } = await import(manifestUrl);
  const { createChatThreadStore } = await import(storeUrl);
  const { identityKey } = await import(runtimeUrl);
  const { createPlayerTurnAcceptor } = await import(acceptanceUrl);
  const { createProviderAttemptClaimer } = await import(claimUrl);
  const { settlePublishedCancellation } = await import(providerStartUrl);

  const manifest = await loadHostDeploymentManifest(manifestPath);
  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
  const lease = await authority.startMountedChatRuntime();
  const thread = lease.chatThreadId;
  const surface = lease.chatSurfaceSessionId;
  const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (await predicate()) return;
      await sleep(25);
    }
    throw new Error("waitFor_timeout");
  };
  const out = {};
  const readLedger = async () => (await store.resumeThread(thread, surface)).turnLedger;

  // A real, durably generating turn: accepted, claimed, armed, running, presentation committed.
  await createPlayerTurnAcceptor(manifest, lease).accept({
    text: "Hello",
    locale: "en-US",
    idempotencyKey: "abcdefghijklmnopqrstuv",
    expectedDraftRevision: 0,
  });
  await createProviderAttemptClaimer(manifest, lease).claim();
  const producedText = "Half a thought, kept.";
  let releasePrompt;
  let endStream;
  const stream = new Promise((resolve) => {
    endStream = resolve;
  });
  /**
   * The generation itself: it ends when the turn is cancelled - that is the physical fact a
   * transport abort produces - and it never ends on its own. Nothing in this script ends it
   * early, so an exit that waits instead of aborting waits forever.
   */
  const streamEndsOnCancel = (async () => {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const status = (await readLedger())?.status;
      if (status === "cancel_claimed" || status === "cancelled") return;
      await sleep(10);
    }
  })();
  const startTask = internal.startMountedAttempt(manifest, lease, (invocation) =>
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
      await Promise.race([stream, streamEndsOnCancel]);
      const settled = await settlePublishedCancellation(scope);
      releasePrompt();
      return settled === undefined ? undefined : settled.ledger;
    }),
  );
  await waitFor(() => releasePrompt !== undefined);
  out.generatingStatus = (await readLedger())?.status ?? null;

  // The exit, exactly as the composition's Chat step runs it: end the generating turn
  // through the one cancel seam, then release the mounted lane. A refusal is reported as a
  // fact rather than crashing this process, so the parent reads what happened.
  const exitStartedAt = Date.now();
  const aborting = internal
    .abortMountedTurnThroughCancelSeam(manifest, lease, "host_exit")
    .catch((error) => "abort_failed:" + String(error?.message ?? error));
  const exiting = aborting.then(() =>
    lease.close().then(
      () => "closed",
      (error) => "close_failed:" + String(error?.message ?? error),
    ),
  );
  const settled = await Promise.race([
    exiting,
    sleep(${EXIT_SETTLE_BOUND_MS}).then(() => "waited_for_the_stream"),
  ]);
  out.exitSettle = settled;
  out.exitElapsedMs = Date.now() - exitStartedAt;
  // A machine that waited is the old behaviour: let the stream end so this process can still
  // report the durable result it left behind, and so the parent sees a completed run.
  if (settled === "waited_for_the_stream") endStream();
  await exiting.catch(() => undefined);
  await startTask.catch(() => undefined);

  const finalLedger = await readLedger();
  const finalState = await store.resumeThread(thread, surface);
  out.finalStatus = finalLedger === null ? null : finalLedger.status;
  out.finalPresentation =
    finalLedger !== null && finalLedger.status === "cancelled" ? finalLedger.presentation !== null : null;
  out.keptCompanionText = finalState.messages.some(
    (message) => message.kind === "response" && message.text === producedText,
  );
  out.keptPlayerText = finalState.messages.some((message) => message.kind === "player" && message.text === "Hello");
  store.close?.();
  process.stdout.write(JSON.stringify(out));
`;

async function runExitScenario(root: string): Promise<Record<string, unknown>> {
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
      exitScript,
      new URL("./continuity-semantic-production-coordinator.internal.js", import.meta.url).href,
      new URL("../deployment-manifest.js", import.meta.url).href,
      new URL("../path-lock.js", import.meta.url).href,
      new URL("../windows-stale-lock-reclaimer/index.js", import.meta.url).href,
      new URL("../tavern/chat-thread-store.js", import.meta.url).href,
      new URL("../runtime.js", import.meta.url).href,
      new URL("../tavern/player-turn-acceptance.js", import.meta.url).href,
      new URL("../tavern/provider-attempt-claim.js", import.meta.url).href,
      new URL("../tavern/p4-provider-start-execution.js", import.meta.url).href,
      manifestPath,
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
  "an exit with a turn generating aborts it instead of waiting for a stream nobody reads",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async (t) => {
    const root = canonicalTestRootSync("semantic-exit-abort-");
    try {
      const observed = await runExitScenario(root);
      t.diagnostic(`the exit ${observed.exitSettle} in ${String(observed.exitElapsedMs)} ms`);
      // A turn really was generating when the exit began: this is the state the wait was for.
      assert.equal(observed.generatingStatus, "presentation_committed");
      // The exit ended the turn instead of waiting for it to finish on its own.
      assert.equal(
        observed.exitSettle,
        "closed",
        `the exit waited ${String(observed.exitElapsedMs)} ms for a stream whose reader is gone`,
      );
      assert.ok(Number(observed.exitElapsedMs) < EXIT_SETTLE_BOUND_MS);
      // ...and it marked the turn durably rather than leaving the row behind mid-flight.
      assert.equal(observed.finalStatus, "cancelled");
      // Everything the interrupted turn had already produced survived: the durable companion
      // message and the cancelled ledger's own presentation record.
      assert.equal(observed.finalPresentation, true);
      assert.equal(observed.keptCompanionText, true);
      assert.equal(observed.keptPlayerText, true);
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* Windows SQLite cleanup is best effort */
      }
    }
  },
);
