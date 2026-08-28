import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

if (process.platform !== "win32") throw new Error("durable acceptance requires real Windows production mounting");

import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { createPlayerTurnAcceptor } from "./player-turn-acceptance.js";

const key = "a".repeat(64);
const command = Object.freeze({
  chatThreadId: "thread_01",
  chatSurfaceSessionId: "surface_01",
  companionId: "companion_01",
  continuityId: "continuity_01",
  selectionGeneration: 1,
  text: "Hello",
  locale: "en-US",
  idempotencyKey: "abcdefghijklmnopqrstuv",
  expectedDraftRevision: 0,
});

async function cleanupTestRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p4-"));
  const store = createChatThreadStore(root, key, () => 100);
  await store.createThread({
    chatThreadId: command.chatThreadId,
    companionId: command.companionId,
    continuityId: command.continuityId,
    chatSurfaceSessionId: command.chatSurfaceSessionId,
    opening: "blank",
  });
  return { root, store };
}

test("player turn acceptance is absent from the ordinary ChatThreadStore surface", async () => {
  const { root, store } = await fixture();
  try {
    assert.equal("acceptPlayerMessage" in store, false);
  } finally {
    await cleanupTestRoot(root);
  }
});

function manifest(root: string): HostDeploymentManifest {
  return Object.freeze({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot: root,
    principal: { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" },
    bootstrapOperationId: "bootstrap_01",
    authorityGeneration: 1,
  });
}

test("player turn acceptor rejects forged mounted leases before access", () => {
  const forged = Object.freeze({}) as MountedChatRuntimeLease;
  assert.throws(
    () => createPlayerTurnAcceptor(manifest("unused"), forged),
    /p4_durable_turn_acceptance_unavailable/,
  );
});

test("public player turn acceptor calls only its private bridge, never raw store or coordinator internals", async () => {
  const source = await readFile(new URL("./player-turn-acceptance.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/player-turn-acceptance\.internal\.js"/);
  assert.match(source, /acceptMountedDurableTurnFromFacade\(manifest, lease,/);
  assert.doesNotMatch(
    source,
    /acceptMountedPlayerMessage\(|acceptMountedDurableTurn\(|consumeMountedDurableAdmission\(/,
  );
});

test("player turn opaque admission is one-shot, rejects reentry and close drains the accepted store transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p4-admission-"));
  try {
    const coordinatorUrl = new URL(
      "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js",
      import.meta.url,
    ).href;
    const deploymentUrl = new URL("../deployment-manifest.js", import.meta.url).href;
    const storeUrl = new URL("./chat-thread-store.js", import.meta.url).href;
    const script = `
      const [coordinatorUrl, deploymentUrl, storeUrl, root] = process.argv.slice(1);
      const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", storeUrl).href);
      const { createBuildWindowsStaleLockReclaimer } = await import(
        new URL("../windows-stale-lock-reclaimer/index.js", storeUrl).href,
      );
      bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
      const { writeFile } = await import("node:fs/promises");
      const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
      const manifestPath = root + "/manifest.json";
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: root, principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1 }));
      const { loadHostDeploymentManifest } = await import(deploymentUrl);
      const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest, acceptMountedDurableTurn, consumeMountedDurableAdmission } = await import(coordinatorUrl);
      const { acceptMountedPlayerMessage, createChatThreadStore } = await import(storeUrl);
      const { identityKey } = await import(new URL("../runtime.js", storeUrl).href);
      const manifest = await loadHostDeploymentManifest(manifestPath);
      const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
      const lease = await authority.startMountedChatRuntime();
      const events = [];
      let saved; let releaseFirst;
      const firstGate = new Promise(resolve => { releaseFirst = resolve; });
      let firstStarted;
      const firstStartedGate = new Promise(resolve => { firstStarted = resolve; });
      const first = acceptMountedDurableTurn(manifest, lease, admission => {
        saved = admission;
        return consumeMountedDurableAdmission(admission, async () => {
          firstStarted();
          await firstGate;
          return { turnId: "ignored", status: "accepted_queued", idempotencyKey: "abcdefghijklmnopqrstuv", messageId: "ignored", acceptedAtMs: 1 };
        });
      });
      await firstStartedGate;
      let reentrant = false;
      try { await consumeMountedDurableAdmission(saved, async () => undefined); } catch (error) { reentrant = /p4_admission_rejected/.test(String(error)); }
      events.push(reentrant ? "reentrant-rejected" : "reentrant-accepted");
      releaseFirst();
      const firstReceipt = await first;
      let afterFirst = false; try { await consumeMountedDurableAdmission(saved, async () => undefined); } catch (error) { afterFirst = /p4_admission_rejected/.test(String(error)); }
      let afterOuter = false; try { await consumeMountedDurableAdmission(saved, async () => undefined); } catch (error) { afterOuter = /p4_admission_rejected/.test(String(error)); }
      let releaseMutation;
      const mutationGate = new Promise(resolve => { releaseMutation = resolve; });
      const durable = acceptMountedDurableTurn(manifest, lease, admission => consumeMountedDurableAdmission(admission, async binding => {
        events.push("admitted"); await mutationGate; events.push("mutation-start");
        const receipt = await acceptMountedPlayerMessage(binding, { text: "Hello", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 });
        events.push("receipt"); return receipt;
      }));
      await new Promise(resolve => setImmediate(resolve));
      let closeSettled = false;
      const closing = lease.close().then(() => { closeSettled = true; events.push("close-settled"); });
      events.push("close-started");
      await new Promise(resolve => setImmediate(resolve));
      const closePendingBeforeMutation = !closeSettled;
      releaseMutation();
      const receipt = await durable;
      await closing;
      const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
      let afterClose = false; try { await acceptMountedDurableTurn(manifest, lease, async () => receipt); } catch (error) { afterClose = /p4_admission_rejected/.test(String(error)); }
      process.stdout.write(JSON.stringify({ firstReceipt, afterFirst, afterOuter, closePendingBeforeMutation, receipt, afterClose, events, state }));
      await authority.close();
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script, coordinatorUrl, deploymentUrl, storeUrl, root],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const [code] = (await once(child, "exit")) as [number | null];
    assert.equal(code, 0, Buffer.concat(errors).toString("utf8"));
    const result = JSON.parse(Buffer.concat(output).toString("utf8")) as {
      firstReceipt: { turnId: string };
      afterFirst: boolean;
      afterOuter: boolean;
      closePendingBeforeMutation: boolean;
      receipt: { messageId: string; idempotencyKey: string };
      afterClose: boolean;
      events: string[];
      state: { messages: unknown[]; turnLedger: { messageId: string } | null; idempotency: { key: string }[] };
    };
    assert.equal(result.firstReceipt.turnId, "ignored");
    assert.equal(result.afterFirst, true);
    assert.equal(result.afterOuter, true);
    assert.equal(result.closePendingBeforeMutation, true);
    assert.equal(result.afterClose, true);
    assert.equal(result.state.messages.length, 1);
    assert.equal(result.state.turnLedger?.messageId, result.receipt.messageId);
    assert.deepEqual(
      result.state.idempotency.map(({ key }) => key),
      [result.receipt.idempotencyKey],
    );
    assert.deepEqual(result.events, [
      "reentrant-rejected",
      "admitted",
      "close-started",
      "mutation-start",
      "receipt",
      "close-settled",
    ]);
  } finally {
    await cleanupTestRoot(root);
  }
});

test("facade genuine mount binds root and principal before durable writes, replays exact receipts, and closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p4-mounted-"));
  try {
    const coordinatorUrl = new URL(
      "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
      import.meta.url,
    ).href;
    const facadeUrl = new URL("./player-turn-acceptance.js", import.meta.url).href;
    const deploymentUrl = new URL("../deployment-manifest.js", import.meta.url).href;
    const script = `
      const [coordinatorUrl, facadeUrl, deploymentUrl, root] = process.argv.slice(1);
      const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", facadeUrl).href);
      const { createBuildWindowsStaleLockReclaimer } = await import(
        new URL("../windows-stale-lock-reclaimer/index.js", facadeUrl).href,
      );
      bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
      const { writeFile } = await import("node:fs/promises");
      const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
      const path = root + "/manifest.json";
      await writeFile(path, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: root, principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1 }));
      const { loadHostDeploymentManifest } = await import(deploymentUrl);
      const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = await import(coordinatorUrl);
      const internalUrl = new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", facadeUrl).href;
      const { acceptMountedDurableTurn } = await import(internalUrl);
      const { createPlayerTurnAcceptor } = await import(facadeUrl);
      const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(await loadHostDeploymentManifest(path));
      const lease = await authority.startMountedChatRuntime();
      const loaded = await loadHostDeploymentManifest(path);
      const facade = createPlayerTurnAcceptor(loaded, lease);
      const { createChatThreadStore } = await import(new URL("./chat-thread-store.js", facadeUrl).href);
      const { identityKey } = await import(new URL("../runtime.js", facadeUrl).href);
      const store = createChatThreadStore(root, identityKey(principal));
      const readState = () => store.resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
      const initialCommand = { text: "Hello", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 };
      const pristine = (state) => state.messages.length === 0 && state.draft.revision === 0 && state.draft.text === null && state.turnLedger === null && state.idempotency.length === 0;
      const wrong = [
        { ...loaded, runtimeRoot: root + "/other-root" },
        { ...loaded, principal: { ...principal, playerId: "player_02" } },
        { ...loaded, principal: { ...principal, companionId: "companion_02" } },
        { ...loaded, principal: { ...principal, continuityId: "continuity_02" } },
      ];
      const rejected = [];
      const callbackInvocations = [];
      const pristineAfterRejected = [];
      // The production internal runner must reject every mismatched binding
      // before entering its callback (and therefore before any raw ingress).
      for (const bad of wrong) {
        let callbacks = 0;
        try { await acceptMountedDurableTurn(bad, lease, async () => { callbacks += 1; throw new Error("callback_must_not_run"); }); rejected.push(false); } catch (error) { rejected.push(/semantic_chat_runtime_p4_admission_rejected/.test(String(error))); }
        callbackInvocations.push(callbacks);
        pristineAfterRejected.push(pristine(await readState()));
      }
      const command = initialCommand;
      const accepted = await facade.accept(command);
      const replay = await facade.accept(command);
      let changedPayload = false; try { await facade.accept({ ...command, text: "Changed" }); } catch (error) { changedPayload = /idempotency_conflict/.test(String(error)); }
      let busy = false; try { await facade.accept({ ...command, idempotencyKey: "bcdefghijklmnopqrstuvw" }); } catch (error) { busy = /turn_busy/.test(String(error)); }
      const state = await readState();
      await lease.close();
      let closed = false; try { await facade.accept({ text: "Again", locale: "en-US", idempotencyKey: "bcdefghijklmnopqrstuvw", expectedDraftRevision: 1 }); } catch (error) { closed = /p4_durable_turn_acceptance_unavailable/.test(String(error)); }
      process.stdout.write(JSON.stringify({ accepted, replay, changedPayload, busy, rejected, callbackInvocations, pristineAfterRejected, state, closed })); await authority.close();
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script, coordinatorUrl, facadeUrl, deploymentUrl, root],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const [code] = (await once(child, "exit")) as [number | null];
    assert.equal(code, 0, Buffer.concat(errors).toString("utf8"));
    const result = JSON.parse(Buffer.concat(output).toString("utf8")) as {
      accepted: { status: string; messageId: string };
      replay: { status: string; messageId: string };
      changedPayload: boolean;
      busy: boolean;
      rejected: boolean[];
      callbackInvocations: number[];
      pristineAfterRejected: boolean[];
      state: {
        messages: unknown[];
        draft: { revision: number; text: string | null };
        turnLedger: unknown;
        idempotency: unknown[];
      };
      closed: boolean;
    };
    assert.equal(result.accepted.status, "accepted_queued");
    assert.deepEqual(result.replay, result.accepted);
    assert.equal(result.changedPayload, true);
    assert.equal(result.busy, true);
    assert.deepEqual(result.rejected, [true, true, true, true]);
    assert.deepEqual(result.callbackInvocations, [0, 0, 0, 0]);
    assert.deepEqual(result.pristineAfterRejected, [true, true, true, true]);
    assert.equal(result.state.messages.length, 1);
    assert.deepEqual(result.state.draft, { revision: 1, text: null });
    assert.notEqual(result.state.turnLedger, null);
    assert.equal(result.state.idempotency.length, 1);
    assert.equal(result.closed, true);
  } finally {
    await cleanupTestRoot(root);
  }
});
