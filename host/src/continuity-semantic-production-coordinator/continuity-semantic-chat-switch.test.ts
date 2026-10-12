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
 * - a runtime whose turn is still in flight refuses with `turn_in_flight` and
 *   keeps the exact running mount, so a generating conversation is never torn
 *   down.
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
  const [coordinatorUrl, manifestUrl, pathLockUrl, reclaimerUrl, storeUrl, runtimeUrl, manifestPath, scenario] =
    process.argv.slice(1);
  const { bindWindowsStaleLockReclaimer } = await import(pathLockUrl);
  const { createBuildWindowsStaleLockReclaimer } = await import(reclaimerUrl);
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const {
    createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
    acceptMountedDurableTurn,
    consumeMountedDurableAdmission,
    isCurrentMountedChatRuntimeLease,
  } = await import(coordinatorUrl);
  const { loadHostDeploymentManifest } = await import(manifestUrl);
  const { acceptMountedPlayerMessage, createChatThreadStore } = await import(storeUrl);
  const { identityKey } = await import(runtimeUrl);

  const manifest = await loadHostDeploymentManifest(manifestPath);
  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
  const first = await authority.startMountedChatRuntime();
  const firstThread = first.chatThreadId;
  const firstSurface = first.chatSurfaceSessionId;
  const firstGeneration = first.browserProjection.selectionGeneration;
  const firstChatHandle = first.browserProjection.chatHandle;
  const out = { firstThread, firstSurface, firstGeneration, firstChatHandle };

  if (scenario === "in-flight") {
    await acceptMountedDurableTurn(manifest, first, (admission) =>
      consumeMountedDurableAdmission(admission, (binding) =>
        acceptMountedPlayerMessage(binding, {
          text: "Hello",
          locale: "en-US",
          idempotencyKey: "abcdefghijklmnopqrstuv",
          expectedDraftRevision: 0,
          authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
        }),
      ),
    );
    const refused = await authority.requestChatSelection({ kind: "create", selectionGeneration: firstGeneration });
    out.refusedStatus = refused.status;
    out.firstStillCurrent = isCurrentMountedChatRuntimeLease(first);
    const remounted = await authority.startMountedChatRuntime();
    out.stillFirstThread = remounted.chatThreadId;
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
    const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
    const firstState = await store.resumeThread(firstThread, firstSurface);
    const secondState = await store.resumeThread(second.chatThreadId, second.chatSurfaceSessionId);
    out.firstThreadStillReadable = firstState.thread.chatThreadId === firstThread;
    out.secondThreadReadable = secondState.thread.chatThreadId === second.chatThreadId;
    out.secondThreadMessageCount = secondState.messages.length;
    store.close?.();
  }

  process.stdout.write(JSON.stringify(out));
  await authority.close();
`;

async function runSwitchScenario(root: string, scenario: "switch" | "in-flight"): Promise<Record<string, unknown>> {
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
  "a turn still in flight refuses the switch and keeps the exact running mount",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-turn-level-in-flight-");
    try {
      const observed = await runSwitchScenario(root, "in-flight");
      assert.equal(observed.refusedStatus, "turn_in_flight");
      assert.equal(observed.firstStillCurrent, true);
      assert.equal(observed.stillFirstThread, observed.firstThread);
    } finally {
      cleanup(root);
    }
  },
);
