import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";

if (process.platform !== "win32") throw new Error("P4 durable acceptance requires real Windows production mounting");

import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { createP4DurableTurnAcceptanceFacade } from "./p4-durable-turn-acceptance.js";

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
  return { root, store, directory: join(root, "tavern", "v1", "continuities", key, "threads", command.chatThreadId) };
}

test("P4 acceptance is absent from the ordinary ChatThreadStore surface", async () => {
  const { root, store } = await fixture();
  try {
    assert.equal("acceptPlayerMessage" in store, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P4 prepared recovery restores all artifacts, ignores legacy chat drafts, and removes its journal after readback", async () => {
  const { root, store, directory } = await fixture();
  try {
    const initial = await store.resumeThread(command.chatThreadId, command.chatSurfaceSessionId);
    const recovered = {
      ...initial,
      messages: [
        {
          messageId: "player_recovered",
          role: "player",
          kind: "player",
          text: "Recovered",
          occurredAtMs: 101,
          greetingSource: null,
        },
      ],
      draft: { revision: 1, text: null },
      turnLedger: {
        turnId: "turn_recovered",
        status: "accepted_queued",
        idempotencyKey: command.idempotencyKey,
        messageId: "player_recovered",
        acceptedAtMs: 101,
      },
      idempotency: [
        {
          key: command.idempotencyKey,
          fingerprint: "b".repeat(64),
          result: {
            turnId: "turn_recovered",
            status: "accepted_queued",
            idempotencyKey: command.idempotencyKey,
            messageId: "player_recovered",
            acceptedAtMs: 101,
          },
        },
      ],
    };
    await writeFile(
      join(directory, "transaction.json"),
      JSON.stringify({ schemaVersion: 1, state: recovered }),
      "utf8",
    );
    await unlink(join(directory, "draft.json"));
    await writeFile(join(directory, "turn-ledger.json"), "{}", "utf8");
    const legacy = join(root, "tavern", "v1", "chat-drafts");
    await writeFile(legacy, JSON.stringify({ revision: 999, text: "legacy" }), "utf8");
    assert.deepEqual(await store.resumeThread(command.chatThreadId, command.chatSurfaceSessionId), recovered);
    await assert.rejects(readFile(join(directory, "transaction.json")), { code: "ENOENT" });
    assert.deepEqual(await store.resumeThread(command.chatThreadId, command.chatSurfaceSessionId), recovered);
  } finally {
    await rm(root, { recursive: true, force: true });
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

test("P4 facade rejects forged mounted leases before access", () => {
  const forged = Object.freeze({}) as MountedChatRuntimeLease;
  assert.throws(
    () => createP4DurableTurnAcceptanceFacade(manifest("unused"), forged),
    /p4_durable_turn_acceptance_unavailable/,
  );
});

test("public P4 facade calls only its private bridge, never raw store or coordinator internals", async () => {
  const source = await readFile(new URL("./p4-durable-turn-acceptance.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/p4-durable-turn-acceptance\.internal\.js"/);
  assert.match(source, /acceptMountedP4DurableTurnFromFacade\(manifest, lease,/);
  assert.doesNotMatch(
    source,
    /acceptP4MountedPlayerMessage\(|acceptMountedP4DurableTurn\(|consumeMountedP4Admission\(/,
  );
});

test("P4 opaque admission is one-shot, rejects reentry and close drains the accepted store transaction", async () => {
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
      const { writeFile } = await import("node:fs/promises");
      const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
      const manifestPath = root + "/manifest.json";
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: root, principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1 }));
      const { loadHostDeploymentManifest } = await import(deploymentUrl);
      const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest, acceptMountedP4DurableTurn, consumeMountedP4Admission } = await import(coordinatorUrl);
      const { acceptP4MountedPlayerMessage, createChatThreadStore } = await import(storeUrl);
      const { identityKey } = await import(new URL("../runtime.js", storeUrl).href);
      const manifest = await loadHostDeploymentManifest(manifestPath);
      const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
      const lease = await authority.startMountedChatRuntime();
      const events = [];
      let saved; let releaseFirst;
      const firstGate = new Promise(resolve => { releaseFirst = resolve; });
      let firstStarted;
      const firstStartedGate = new Promise(resolve => { firstStarted = resolve; });
      const first = acceptMountedP4DurableTurn(manifest, lease, admission => {
        saved = admission;
        return consumeMountedP4Admission(admission, async () => {
          firstStarted();
          await firstGate;
          return { turnId: "ignored", status: "accepted_queued", idempotencyKey: "abcdefghijklmnopqrstuv", messageId: "ignored", acceptedAtMs: 1 };
        });
      });
      await firstStartedGate;
      let reentrant = false;
      try { await consumeMountedP4Admission(saved, async () => undefined); } catch (error) { reentrant = /p4_admission_rejected/.test(String(error)); }
      events.push(reentrant ? "reentrant-rejected" : "reentrant-accepted");
      releaseFirst();
      const firstReceipt = await first;
      let afterFirst = false; try { await consumeMountedP4Admission(saved, async () => undefined); } catch (error) { afterFirst = /p4_admission_rejected/.test(String(error)); }
      let afterOuter = false; try { await consumeMountedP4Admission(saved, async () => undefined); } catch (error) { afterOuter = /p4_admission_rejected/.test(String(error)); }
      let releaseMutation;
      const mutationGate = new Promise(resolve => { releaseMutation = resolve; });
      const durable = acceptMountedP4DurableTurn(manifest, lease, admission => consumeMountedP4Admission(admission, async binding => {
        events.push("admitted"); await mutationGate; events.push("mutation-start");
        const receipt = await acceptP4MountedPlayerMessage(binding, { text: "Hello", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 });
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
      let afterClose = false; try { await acceptMountedP4DurableTurn(manifest, lease, async () => receipt); } catch (error) { afterClose = /p4_admission_rejected/.test(String(error)); }
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
    await rm(root, { recursive: true, force: true });
  }
});

test("P4 facade genuine mount binds root and principal before durable writes, replays exact receipts, and closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p4-mounted-"));
  try {
    const coordinatorUrl = new URL(
      "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
      import.meta.url,
    ).href;
    const facadeUrl = new URL("./p4-durable-turn-acceptance.js", import.meta.url).href;
    const deploymentUrl = new URL("../deployment-manifest.js", import.meta.url).href;
    const script = `
      const [coordinatorUrl, facadeUrl, deploymentUrl, root] = process.argv.slice(1);
      const { mkdir, writeFile } = await import("node:fs/promises");
      const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
      const path = root + "/manifest.json";
      await writeFile(path, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: root, principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1 }));
      const { loadHostDeploymentManifest } = await import(deploymentUrl);
      const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = await import(coordinatorUrl);
      const internalUrl = new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", facadeUrl).href;
      const { acceptMountedP4DurableTurn } = await import(internalUrl);
      const { createP4DurableTurnAcceptanceFacade } = await import(facadeUrl);
      const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(await loadHostDeploymentManifest(path));
      const lease = await authority.startMountedChatRuntime();
      const loaded = await loadHostDeploymentManifest(path);
      const facade = createP4DurableTurnAcceptanceFacade(loaded, lease);
      const { createChatThreadStore } = await import(new URL("./chat-thread-store.js", facadeUrl).href);
      const { identityKey } = await import(new URL("../runtime.js", facadeUrl).href);
      const store = createChatThreadStore(root, identityKey(principal));
      const directoryFor = (threadId) => root + "/tavern/v1/continuities/" + identityKey(principal) + "/threads/" + threadId;
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
      // before entering its callback (and therefore before any P4 raw ingress).
      for (const bad of wrong) {
        let callbacks = 0;
        try { await acceptMountedP4DurableTurn(bad, lease, async () => { callbacks += 1; throw new Error("callback_must_not_run"); }); rejected.push(false); } catch (error) { rejected.push(/semantic_chat_runtime_p4_admission_rejected/.test(String(error))); }
        callbackInvocations.push(callbacks);
        pristineAfterRejected.push(pristine(await readState()));
      }
      const currentInitial = await readState();
      await writeFile(directoryFor(lease.chatThreadId) + "/transaction.json", JSON.stringify({ schemaVersion: 1, state: { ...currentInitial, draft: { revision: 7, text: "unsent current text" } } }));
      await mkdir(root + "/tavern/v1/chat-drafts", { recursive: true });
      await writeFile(root + "/tavern/v1/chat-drafts/legacy.json", JSON.stringify({ revision: 999, text: "legacy ignored" }));
      const otherThreadId = "thread_other_01", otherSurfaceId = "surface_other_01";
      await store.createThread({ chatThreadId: otherThreadId, chatSurfaceSessionId: otherSurfaceId, companionId: principal.companionId, continuityId: principal.continuityId, opening: "blank" });
      const otherInitial = await store.resumeThread(otherThreadId, otherSurfaceId);
      await writeFile(directoryFor(otherThreadId) + "/transaction.json", JSON.stringify({ schemaVersion: 1, state: { ...otherInitial, draft: { revision: 11, text: "other thread text" } } }));
      const recoveredCurrent = await readState();
      const recoveredOther = await store.resumeThread(otherThreadId, otherSurfaceId);
      const command = { ...initialCommand, expectedDraftRevision: 7 };
      const accepted = await facade.accept(command);
      const replay = await facade.accept(command);
      let changedPayload = false; try { await facade.accept({ ...command, text: "Changed" }); } catch (error) { changedPayload = /idempotency_conflict/.test(String(error)); }
      let busy = false; try { await facade.accept({ ...command, idempotencyKey: "bcdefghijklmnopqrstuvw" }); } catch (error) { busy = /turn_busy/.test(String(error)); }
      const state = await readState();
      const otherState = await store.resumeThread(otherThreadId, otherSurfaceId);
      await lease.close();
      let closed = false; try { await facade.accept({ text: "Again", locale: "en-US", idempotencyKey: "bcdefghijklmnopqrstuvw", expectedDraftRevision: 1 }); } catch (error) { closed = /p4_durable_turn_acceptance_unavailable/.test(String(error)); }
      process.stdout.write(JSON.stringify({ accepted, replay, changedPayload, busy, rejected, callbackInvocations, pristineAfterRejected, recoveredCurrent, recoveredOther, state, otherState, closed })); await authority.close();
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
      recoveredCurrent: { draft: { revision: number; text: string | null } };
      recoveredOther: { draft: { revision: number; text: string | null } };
      state: {
        messages: unknown[];
        draft: { revision: number; text: string | null };
        turnLedger: unknown;
        idempotency: unknown[];
      };
      otherState: {
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
    assert.deepEqual(result.recoveredCurrent.draft, { revision: 7, text: "unsent current text" });
    assert.deepEqual(result.recoveredOther.draft, { revision: 11, text: "other thread text" });
    assert.equal(result.state.messages.length, 1);
    assert.deepEqual(result.state.draft, { revision: 8, text: null });
    assert.notEqual(result.state.turnLedger, null);
    assert.equal(result.state.idempotency.length, 1);
    assert.equal(result.otherState.messages.length, 0);
    assert.deepEqual(result.otherState.draft, { revision: 11, text: "other thread text" });
    assert.equal(result.otherState.turnLedger, null);
    assert.equal(result.otherState.idempotency.length, 0);
    assert.equal(result.closed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
