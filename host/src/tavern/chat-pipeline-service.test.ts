import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { composeTavernProfile, TavernBrowserValidatorsV1 } from "./browser-contract/index.js";
import {
  assertChatPipelineServiceLeaseAfterDurableRead,
  createChatPipelineService,
  type MessageSubmissionStatusV1,
  type SubmitResultV1,
} from "./chat-pipeline-service.js";

const principal = Object.freeze({ playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" });

function manifest(root: string): HostDeploymentManifest {
  return Object.freeze({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot: root,
    principal,
    bootstrapOperationId: "bootstrap_01",
    authorityGeneration: 1,
  });
}

function referenceProfile() {
  return composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status"],
    operationIds: ["chat.submit", "chat.cancel"],
    navigationItemIds: ["chat"],
  });
}

function forgedLease(): MountedChatRuntimeLease {
  return Object.freeze({
    runtimeSession: Object.freeze({}),
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    browserProjection: Object.freeze({
      chatHandle: "forged-chat",
      selectionGeneration: 1,
      selectionStateRevision: "forged-revision",
      projectMessageHandle: () => "forged-message",
      projectTurnHandle: () => "forged-turn",
    }),
    attachPresentation: () => () => undefined,
    close: async () => undefined,
  }) as unknown as MountedChatRuntimeLease;
}

test("service rejects forged structural mounted leases and non-composed profiles before any durable access", async () => {
  const root = await canonicalTestRoot("gamebuddy-pipeline-forged-");
  try {
    const forged = forgedLease();
    // The structural copy cannot carry the coordinator WeakMap brand, and a
    // spread copy of a composed profile is not a capability slice either.
    assert.throws(
      () => createChatPipelineService({ manifest: manifest(root), lease: forged, profile: referenceProfile() }),
      /chat_pipeline_service_unavailable/,
    );
    assert.throws(
      () =>
        createChatPipelineService({
          manifest: manifest(root),
          lease: forged,
          profile: { ...referenceProfile() },
        }),
      /chat_pipeline_service_unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service post-read lease guard rejects when a controlled durable-read completion observes revocation", () => {
  // This narrow test seam supplies a predicate only. It cannot mint or brand a
  // lease, because production still calls the coordinator's private WeakMap
  // predicate. The controlled promise models lease.close during durable I/O.
  const inertLease = Object.freeze({}) as MountedChatRuntimeLease;
  let resolveRead!: () => void;
  const durableRead = new Promise<void>((resolve) => {
    resolveRead = resolve;
  });
  let current = true;
  const postRead = durableRead.then(() => assertChatPipelineServiceLeaseAfterDurableRead(inertLease, () => current));
  current = false;
  resolveRead();
  return assert.rejects(postRead, /chat_pipeline_service_unavailable/);
});

test("service source keeps start/claim private and imports no HTTP/response surfaces", async () => {
  const source = await readFile(new URL("./chat-pipeline-service.js", import.meta.url), "utf8");
  // The service composes durable acceptance/claim facades and one normal
  // mounted provider-start operation; no proof-only P4/P5 forwarding facade
  // remains on its production path.
  assert.match(source, /from "\.\/player-turn-acceptance\.js"/);
  assert.match(source, /from "\.\/provider-attempt-claim\.js"/);
  assert.match(source, /from "\.\/chat-provider-start\.js"/);
  assert.doesNotMatch(source, /p5-presentation-commit|p4-provider-start/);
  assert.match(source, /stopMountedChatPresentationEpoch/);
  // No raw store transition/coordinator ingress and no HTTP/response/transport import.
  assert.doesNotMatch(
    source,
    /from ["'][^"']*(chat-thread-store|player-turn-acceptance\.internal|provider-attempt-claim\.internal|continuity-semantic-production-coordinator\.internal)["']/,
  );
  assert.doesNotMatch(source, /from ["'][^"']*(node:http|express|router|request|respons(e|es?)|fetch)[^"']*["']/);
  // The opaque browser-safe surface is exactly the frozen Task-2 contract.
  assert.match(source, /submitAfterResponseCommit/);
  assert.match(source, /readSubmissionStatus/);
});

const mountPreamble = `
  const [serviceUrl, coordinatorUrl, deploymentUrl, storeUrl, runtimeUrl, contractUrl, internalUrl, root] = process.argv.slice(1);
  const { writeFile, mkdir } = await import("node:fs/promises");
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  const manifestPath = root + "/manifest.json";
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: root, principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1 }));
  const { loadHostDeploymentManifest } = await import(deploymentUrl);
  const coordinator = await import(coordinatorUrl);
  const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest, createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = coordinator;
  const { createChatPipelineService } = await import(serviceUrl);
  const { createChatThreadStore } = await import(storeUrl);
  const { identityKey, resolveRuntimePaths } = await import(runtimeUrl);
  const { composeTavernProfile } = await import(contractUrl);
  const internal = await import(internalUrl);
  const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", storeUrl).href);
  const { createBuildWindowsStaleLockReclaimer } = await import(new URL("../windows-stale-lock-reclaimer/index.js", storeUrl).href);
  await bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const profile = composeTavernProfile({ profileId: "gamebuddy.chat-core.reference-pipeline", releaseTier: "chat_core", routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status"], operationIds: ["chat.submit", "chat.cancel"], navigationItemIds: ["chat"] });
  const run = async (fn) => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; } };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const ticks = async () => { for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const waitFor = async (predicate, rounds = 600) => {
    for (let i = 0; i < rounds; i += 1) {
      if (predicate()) return;
      await sleep(50);
    }
    if (!predicate()) throw new Error("wait_for_timeout");
  };
  const nextTime = async () => { await sleep(2); return Date.now(); };
  let fixtureNumber = 0;
  async function fixture() {
    const fixtureRoot = root + "/fixture_" + (++fixtureNumber);
    await mkdir(fixtureRoot, { recursive: true });
    const fixtureManifestPath = fixtureRoot + "/manifest.json";
    await writeFile(fixtureManifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: fixtureRoot, principal, bootstrapOperationId: "bootstrap_" + fixtureNumber, authorityGeneration: 1 }));
    const fixtureManifest = await loadHostDeploymentManifest(fixtureManifestPath);
    const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(fixtureManifest);
    const lease = await authority.startMountedChatRuntime();
    return Object.freeze({
      root: fixtureRoot,
      manifest: fixtureManifest,
      authority,
      lease,
      store: () => createChatThreadStore(fixtureRoot, identityKey(principal)),
      generation: lease.browserProjection.selectionGeneration,
    });
  }
  const commandFor = (fx, overrides) => Object.freeze({ apiVersion: 1, selectionGeneration: fx.generation, text: "Synthetic player request", locale: "en", expectedDraftRevision: 0, ...overrides });
  const serviceFor = (fx, fakeStart) => createChatPipelineService({ manifest: fx.manifest, lease: fx.lease, profile, deps: Object.freeze({ start: Object.freeze({ start: fakeStart }) }) });
  const knownServiceFor = (manifest, lease, fakeStart) => createChatPipelineService({ manifest, lease, profile, deps: Object.freeze({ start: Object.freeze({ start: fakeStart }) }) });
  async function driveToTerminal(fx, terminal, responseId = "response_01") {
    return internal.startMountedAttempt(fx.manifest, fx.lease, (invocation) =>
      internal.consumeMountedAttemptInvocationAdmission(invocation, async (scope) => {
        const times = [await nextTime(), await nextTime(), await nextTime(), await nextTime(), await nextTime()];
        await scope.transitionStore({ operation: "arm", observedAtMs: times[0] });
        const running = await scope.transitionStore({ operation: "running", statusClass: "success", observedAtMs: times[1] });
        if (terminal === "failed") return scope.transitionPresentation({ operation: "fail", reasonCode: "runtime_unavailable", failedAtMs: times[2] });
        const committed = await scope.transitionPresentation({ operation: "commit_presentation", cancelEpoch: 0, message: { messageId: responseId, text: "Synthetic companion reply.", occurredAtMs: times[2] }, committedAtMs: times[2] });
        const completionClaimed = await scope.transitionPresentation({ operation: "claim_completion", claimedAtMs: times[3] });
        return scope.transitionPresentation({ operation: "complete", completedAtMs: times[4] });
      }),
    );
  }
  async function driveVariantToCompleted(fx, position) {
    return internal.startMountedAttempt(fx.manifest, fx.lease, (invocation) =>
      internal.consumeMountedAttemptInvocationAdmission(invocation, async (scope) => {
        const sessionManager = scope.runtimeSession.sessionManager;
        const appendTurn = (promptText, replyText) => {
          sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() });
          sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: replyText }] });
        };
        // The reply the player already had, as the session received it when that
        // line was sent, followed by this turn's own prompt and answer - exactly
        // the shape Pi leaves after one same-position regeneration.
        appendTurn(position.anchorText, position.committedReplyText);
        appendTurn(position.anchorText, position.text);
        const times = [await nextTime(), await nextTime(), await nextTime(), await nextTime(), await nextTime()];
        await scope.transitionStore({ operation: "arm", observedAtMs: times[0] });
        await scope.transitionStore({ operation: "running", statusClass: "success", observedAtMs: times[1] });
        const activation = await scope.activateVariantPosition(position.text);
        const modelTexts = sessionManager
          .buildSessionProjection()
          .messages.map((message) =>
            message.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
          );
        const committed = await scope.transitionPresentation({
          operation: "commit_variant",
          cancelEpoch: 0,
          variant: { targetMessageId: position.targetMessageId, text: position.text, occurredAtMs: times[2] },
          committedAtMs: times[2],
        });
        await scope.transitionPresentation({ operation: "claim_completion", claimedAtMs: times[3] });
        await scope.transitionPresentation({ operation: "complete", completedAtMs: times[4] });
        return Object.freeze({ activation, modelTexts, committed });
      }),
    );
  }
`;

async function runMountedChild(body: string, root: string): Promise<Record<string, unknown>> {
  const serviceUrl = new URL("./chat-pipeline-service.js", import.meta.url).href;
  const coordinatorUrl = new URL(
    "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
    import.meta.url,
  ).href;
  const deploymentUrl = new URL("../deployment-manifest.js", import.meta.url).href;
  const storeUrl = new URL("./chat-thread-store.js", import.meta.url).href;
  const runtimeUrl = new URL("../runtime.js", import.meta.url).href;
  const contractUrl = new URL("./browser-contract/index.js", import.meta.url).href;
  const internalUrl = new URL(
    "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js",
    import.meta.url,
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      mountPreamble + body,
      serviceUrl,
      coordinatorUrl,
      deploymentUrl,
      storeUrl,
      runtimeUrl,
      contractUrl,
      internalUrl,
      root,
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

async function mounted(body: string): Promise<Record<string, unknown>> {
  const root = await canonicalTestRoot("gamebuddy-pipeline-service-");
  try {
    return await runMountedChild(body, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertNoRawIdentityLeaks(serialized: string, rawValues: readonly unknown[]): void {
  for (const raw of rawValues) {
    if (typeof raw !== "string") continue;
    assert.equal(serialized.includes(raw), false, `leaked raw durable identity ${raw}`);
  }
}

function keyOf(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

test(
  "submit returns the durable 202 projection before the sole start begins; exactly one start after commit resolves",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const output = await mounted(`
  const fx = await fixture();
  let startCalls = 0;
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const service = serviceFor(fx, async () => { startCalls += 1; await startGate; });
  let commitCalls = 0;
  const commitResults = [];
  let releaseCommit;
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  const key = "abcdefghijklmnopqrstuv";
  let submitSettled = false;
  let submitError = "";
  const submitted = service.submitAfterResponseCommit(commandFor(fx, {}), key, async (result) => {
    commitCalls += 1;
    commitResults.push(result);
    await commitGate;
  }).then((result) => { submitSettled = true; return result; }, (error) => { submitError = String(error); throw error; });
  await waitFor(() => commitCalls === 1 || submitError !== "");
  if (submitError !== "") throw new Error("submit_failed_before_commit:" + submitError);
  const beforeRelease = { startCalls, commitCalls, submitSettled };
  releaseCommit();
  const result = await submitted;
  await waitFor(() => startCalls === 1);
  const afterStart = { startCalls };
  const statusAccepted = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: key, selectionGeneration: fx.generation });
  releaseStart();
  await service.close();
  const durable = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  await fx.lease.close();
  await fx.authority.close();
  process.stdout.write(JSON.stringify({ result, commitResults, beforeRelease, afterStart, statusAccepted, ledgerStatus: durable.turnLedger === null ? null : durable.turnLedger.status, turnId: durable.turnLedger === null ? null : durable.turnLedger.turnId, messageIds: durable.messages.map((m) => m.messageId), chatThreadId: fx.lease.chatThreadId, chatSurfaceSessionId: fx.lease.chatSurfaceSessionId, key }));
`);
    const result = output.result as SubmitResultV1;
    assert.equal(result.apiVersion, 1);
    assert.equal(result.disposition, "accepted");
    assert.equal(result.turn.state, "queued");
    assert.equal(result.message.role, "player");
    assert.equal(result.message.text, "Synthetic player request");
    assert.equal(result.message.locale, "und");
    assert.equal(TavernBrowserValidatorsV1.SubmitResultV1Schema.Check(result), true);
    assert.deepEqual(output.commitResults, [result]);
    // Zero start before the 202 commit callback resolves; exactly one after.
    assert.deepEqual(output.beforeRelease, { startCalls: 0, commitCalls: 1, submitSettled: false });
    assert.deepEqual(output.afterStart, { startCalls: 1 });
    assert.equal(output.ledgerStatus, "attempt_starting");
    // A known non-terminal key reads back the identical committed projection.
    const statusAccepted = output.statusAccepted as MessageSubmissionStatusV1;
    assert.equal(statusAccepted.disposition, "accepted");
    assert.deepEqual(statusAccepted.committedResult, result);
    assert.equal(TavernBrowserValidatorsV1.MessageSubmissionStatusV1Schema.Check(statusAccepted), true);
    // Handles are opaque lease projections; raw durable identities never leak.
    assert.notEqual(result.message.handle, (output.messageIds as string[])[0]);
    assert.notEqual(result.turn.handle, keyOf(output.turnId));
    assertNoRawIdentityLeaks(JSON.stringify([result, ...(output.commitResults as unknown[]), statusAccepted]), [
      output.turnId,
      output.chatThreadId,
      output.chatSurfaceSessionId,
      ...(output.messageIds as string[]),
      keyOf(output.key),
    ]);
  },
);

test(
  "cancel aborts the exact armed prompt and leaves the durable terminal winner",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const output = await mounted(`
  const fx = await fixture();
  let startCalls = 0;
  let releaseStart;
  let releasePrompt;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const service = serviceFor(fx, async () => { startCalls += 1; await startGate; });
  const first = await service.submitAfterResponseCommit(commandFor(fx, {}), "zbcdefghijklmnopqrstuv", async () => undefined);
  await waitFor(() => startCalls === 1);
  await internal.startMountedAttempt(fx.manifest, fx.lease, (invocation) =>
    internal.consumeMountedAttemptInvocationAdmission(invocation, async (scope) => {
      await scope.transitionStore({ operation: "arm", observedAtMs: await nextTime() });
      releasePrompt = scope.beginActivePrompt();
      return scope.readCurrentTurnLedger();
    }),
  );
  const current = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  const attemptId = current.turnLedger?.status === "attempt_starting" ? current.turnLedger.attempt.attemptId : "";
  if (current.turnLedger?.status !== "attempt_starting" || current.turnLedger.observation?.phase !== "armed")
    throw new Error("expected_armed_turn");
  const beforeCancel = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: "zbcdefghijklmnopqrstuv", selectionGeneration: fx.generation });
  const cancelOutcome = await run(async () => service.cancel(first.turn.handle, { apiVersion: 1, selectionGeneration: fx.generation }));
  releasePrompt();
  releaseStart();
  const afterCancel = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: "zbcdefghijklmnopqrstuv", selectionGeneration: fx.generation });
  await service.close();
  const durable = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  const retry = await run(async () => await serviceFor(fx, async () => { startCalls += 1; }).submitAfterResponseCommit(commandFor(fx, { expectedDraftRevision: 1 }), "cdefghijklmnopqrstuvwx", async () => undefined));
  await fx.lease.close();
  await fx.authority.close();
  process.stdout.write(JSON.stringify({ first, beforeCancel, cancelOutcome, afterCancel, retry, startCalls, attemptId, ledgerStatus: durable.turnLedger?.status ?? null }));
`);
    assert.equal((output.beforeCancel as MessageSubmissionStatusV1).committedResult?.turn.canCancel, true);
    const cancelOutcome = output.cancelOutcome as { ok: boolean; value?: { state?: string } };
    assert.equal(cancelOutcome.ok, true);
    assert.equal(cancelOutcome.value?.state, "cancelled");
    assert.equal((output.afterCancel as MessageSubmissionStatusV1).disposition, "terminal");
    assert.equal((output.afterCancel as MessageSubmissionStatusV1).committedResult?.turn.state, "cancelled");
    const retry = output.retry as { ok: boolean; value?: SubmitResultV1; error?: string };
    assert.equal(retry.ok, true, retry.error);
    assert.equal(retry.value?.turn.state, "queued");
    assert.equal(output.startCalls, 2);
    assert.notEqual(output.attemptId, "");
    assert.equal(output.ledgerStatus, "cancelled");
  },
);

test(
  "a rejected 202 commit leaves the durable accepted_queued record and starts nothing",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const output = await mounted(`
  const fx = await fixture();
  let startCalls = 0;
  const service = serviceFor(fx, async () => { startCalls += 1; });
  const key = "bcdefghijklmnopqrstuvw";
  let rejection = "none";
  try {
    await service.submitAfterResponseCommit(commandFor(fx, {}), key, async () => { throw new Error("synthetic commit failure"); });
  } catch (error) {
    rejection = String(error);
  }
  await ticks();
  const status = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: key, selectionGeneration: fx.generation });
  const durable = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  await service.close();
  await fx.lease.close();
  await fx.authority.close();
  process.stdout.write(JSON.stringify({ rejection, startCalls, status, ledgerStatus: durable.turnLedger === null ? null : durable.turnLedger.status, turnId: durable.turnLedger === null ? null : durable.turnLedger.turnId, messageIds: durable.messages.map((m) => m.messageId), chatThreadId: fx.lease.chatThreadId, chatSurfaceSessionId: fx.lease.chatSurfaceSessionId, key }));
`);
    // The commit rejection surfaces only the fixed opaque code; the durable
    // record stands and the status route still projects the committed result.
    assert.equal(output.rejection, "Error: chat_pipeline_service_commit_rejected");
    assert.equal(output.startCalls, 0);
    assert.equal(output.ledgerStatus, "accepted_queued");
    const status = output.status as MessageSubmissionStatusV1;
    assert.equal(status.disposition, "accepted");
    assert.equal(status.committedResult?.disposition, "accepted");
    assert.equal(status.committedResult?.turn.state, "queued");
    assert.equal(TavernBrowserValidatorsV1.MessageSubmissionStatusV1Schema.Check(status), true);
    const rejectionText = output.rejection as string;
    assertNoRawIdentityLeaks(rejectionText, [
      output.turnId,
      output.chatThreadId,
      output.chatSurfaceSessionId,
      ...(output.messageIds as string[]),
      keyOf(output.key),
    ]);
  },
);

test(
  "same key returns the immutable duplicated committed result and starts no second attempt",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const output = await mounted(`
  const fx = await fixture();
  let startCalls = 0;
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const service = serviceFor(fx, async () => { startCalls += 1; await startGate; });
  const key = "cdefghijklmnopqrstuvwx";
  const first = await service.submitAfterResponseCommit(commandFor(fx, {}), key, async () => undefined);
  await waitFor(() => startCalls === 1);
  const duplicate = await service.submitAfterResponseCommit(commandFor(fx, {}), key, async () => undefined);
  await ticks();
  const startCallsAfterDuplicate = startCalls;
  const status = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: key, selectionGeneration: fx.generation });
  releaseStart();
  await service.close();
  const durable = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  await fx.lease.close();
  await fx.authority.close();
  process.stdout.write(JSON.stringify({ first, duplicate, startCallsAfterDuplicate, status, messages: durable.messages.length, idempotency: durable.idempotency.length, draftRevision: durable.draft.revision, ledgerStatus: durable.turnLedger === null ? null : durable.turnLedger.status, turnId: durable.turnLedger === null ? null : durable.turnLedger.turnId, chatThreadId: fx.lease.chatThreadId, chatSurfaceSessionId: fx.lease.chatSurfaceSessionId, key }));
`);
    const first = output.first as SubmitResultV1;
    const duplicate = output.duplicate as SubmitResultV1;
    assert.equal(first.disposition, "accepted");
    assert.equal(duplicate.disposition, "duplicate");
    assert.deepEqual(duplicate.message, first.message);
    assert.deepEqual(duplicate.turn, first.turn);
    assert.equal(duplicate.turn.state, "queued");
    assert.equal(TavernBrowserValidatorsV1.SubmitResultV1Schema.Check(duplicate), true);
    // Zero second append, zero second idempotency record, exactly one start.
    // The transcript carries two messages: the opening the fixture's companion
    // materializes, plus the accepted player line.
    assert.equal(output.messages, 2);
    assert.equal(output.idempotency, 1);
    assert.equal(output.draftRevision, 1);
    assert.equal(output.startCallsAfterDuplicate, 1);
    assert.equal(output.ledgerStatus, "attempt_starting");
    const status = output.status as MessageSubmissionStatusV1;
    assert.equal(status.disposition, "accepted");
    assert.deepEqual(status.committedResult, first);
    assertNoRawIdentityLeaks(JSON.stringify([first, duplicate, status]), [
      output.turnId,
      output.chatThreadId,
      output.chatSurfaceSessionId,
      keyOf(output.key),
    ]);
  },
);

test(
  "status is identical non-disclosing unknown for foreign/wrong-generation keys, terminal reopen projects the same result, and status/reopen never starts",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const output = await mounted(`
  const fx = await fixture();
  let startCalls = 0;
  const service = serviceFor(fx, async () => { startCalls += 1; });
  const key = "defghijklmnopqrstuvwxy";
  const foreignKey = "efghijklmnopqrstuvwxyz";
  const first = await service.submitAfterResponseCommit(commandFor(fx, {}), key, async () => undefined);
  await waitFor(() => startCalls === 1);
  const unknownForeign = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: foreignKey, selectionGeneration: fx.generation });
  const unknownWrongGeneration = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: key, selectionGeneration: fx.generation + 1 });
  const unknownMissingThreadKey = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: "gggggggggggggggggggggg", selectionGeneration: fx.generation });
  const startCallsAfterUnknowns = startCalls;
  const acceptedStatus = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: key, selectionGeneration: fx.generation });
  await driveToTerminal(fx, "completed");
  const terminalStatus = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: key, selectionGeneration: fx.generation });
  const reopened = createChatPipelineService({ manifest: fx.manifest, lease: fx.lease, profile, deps: Object.freeze({ start: Object.freeze({ start: async () => { startCalls += 1; } }) }) });
  const reopenedTerminal = await reopened.readSubmissionStatus({ apiVersion: 1, idempotencyKey: key, selectionGeneration: fx.generation });
  const startCallsAfterReopen = startCalls;
  const terminalDuplicate = await service.submitAfterResponseCommit(commandFor(fx, {}), key, async () => undefined);
  await ticks();
  const startCallsAfterTerminalDuplicate = startCalls;
  await service.close();
  await reopened.close();
  const durable = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  await fx.lease.close();
  await fx.authority.close();
  process.stdout.write(JSON.stringify({ first, unknownForeign, unknownWrongGeneration, unknownMissingThreadKey, startCallsAfterUnknowns, acceptedStatus, terminalStatus, reopenedTerminal, startCallsAfterReopen, terminalDuplicate, startCallsAfterTerminalDuplicate, ledgerStatus: durable.turnLedger === null ? null : durable.turnLedger.status, turnId: durable.turnLedger === null ? null : durable.turnLedger.turnId, messageIds: durable.messages.map((m) => m.messageId), chatThreadId: fx.lease.chatThreadId, chatSurfaceSessionId: fx.lease.chatSurfaceSessionId, key }));
`);
    const unknown = Object.freeze({ apiVersion: 1, disposition: "unknown" });
    assert.deepEqual(output.unknownForeign, unknown);
    assert.deepEqual(output.unknownWrongGeneration, unknown);
    assert.deepEqual(output.unknownMissingThreadKey, unknown);
    assert.equal(output.startCallsAfterUnknowns, 1);
    const first = output.first as SubmitResultV1;
    const acceptedStatus = output.acceptedStatus as MessageSubmissionStatusV1;
    assert.equal(acceptedStatus.disposition, "accepted");
    assert.deepEqual(acceptedStatus.committedResult, first);
    const terminalStatus = output.terminalStatus as MessageSubmissionStatusV1;
    assert.equal(terminalStatus.disposition, "terminal");
    assert.deepEqual(terminalStatus.committedResult?.message, first.message);
    assert.equal(terminalStatus.committedResult?.turn.handle, first.turn.handle);
    assert.equal(terminalStatus.committedResult?.turn.state, "completed");
    assert.equal(TavernBrowserValidatorsV1.MessageSubmissionStatusV1Schema.Check(terminalStatus), true);
    // A reopened service on the same still-current lease projects the same
    // terminal committed result; neither status nor reopen starts anything.
    assert.deepEqual(output.reopenedTerminal, terminalStatus);
    assert.equal(output.startCallsAfterReopen, 1);
    assert.equal(output.ledgerStatus, "completed");
    // A same-key submit after terminal is a duplicate and starts nothing.
    assert.equal((output.terminalDuplicate as SubmitResultV1).disposition, "duplicate");
    assert.equal(output.startCallsAfterTerminalDuplicate, 1);
    assertNoRawIdentityLeaks(JSON.stringify([first, terminalStatus, output.reopenedTerminal]), [
      output.turnId,
      output.chatThreadId,
      output.chatSurfaceSessionId,
      ...(output.messageIds as string[]),
      keyOf(output.key),
    ]);
  },
);

test(
  "terminal Chat status survives a known-root mounted successor without a second provider start",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const output = await mounted(`
  const fx = await fixture();
  let firstStartCalls = 0;
  const firstService = serviceFor(fx, async () => { firstStartCalls += 1; });
  const key = "hijklmnopqrstuvwxyzaab";
  const first = await firstService.submitAfterResponseCommit(commandFor(fx, {}), key, async () => undefined);
  await waitFor(() => firstStartCalls === 1);
  await driveToTerminal(fx, "completed");
  const firstStatus = await firstService.readSubmissionStatus({ apiVersion: 1, idempotencyKey: key, selectionGeneration: fx.generation });
  const firstIdentity = { chatThreadId: fx.lease.chatThreadId, chatSurfaceSessionId: fx.lease.chatSurfaceSessionId };
  await firstService.close();
  await fx.lease.close();
  await fx.authority.close();

  const successorAuthority = await createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(fx.manifest);
  const successorLease = await successorAuthority.startMountedChatRuntime();
  let successorStartCalls = 0;
  const successorService = knownServiceFor(fx.manifest, successorLease, async () => { successorStartCalls += 1; });
  const successorStatus = await successorService.readSubmissionStatus({ apiVersion: 1, idempotencyKey: key, selectionGeneration: successorLease.browserProjection.selectionGeneration });
  await successorService.close();
  await successorLease.close();
  await successorAuthority.close();
  process.stdout.write(JSON.stringify({ first, firstStatus, successorStatus, firstStartCalls, successorStartCalls, firstIdentity, successorIdentity: { chatThreadId: successorLease.chatThreadId, chatSurfaceSessionId: successorLease.chatSurfaceSessionId }, firstGeneration: fx.generation, successorGeneration: successorLease.browserProjection.selectionGeneration }));
`);
    assert.equal(output.firstStartCalls, 1);
    assert.equal(output.successorStartCalls, 0);
    assert.deepEqual(output.successorIdentity, output.firstIdentity);
    assert.equal((output.firstStatus as MessageSubmissionStatusV1).disposition, "terminal");
    assert.equal((output.successorStatus as MessageSubmissionStatusV1).disposition, "terminal");
    const firstStatus = output.firstStatus as MessageSubmissionStatusV1;
    const successorStatus = output.successorStatus as MessageSubmissionStatusV1;
    assert.equal(firstStatus.committedResult?.turn.state, "completed");
    assert.equal(successorStatus.committedResult?.turn.state, "completed");
    assert.equal(successorStatus.committedResult?.message.text, firstStatus.committedResult?.message.text);
    assert.equal(successorStatus.committedResult?.turn.handle === firstStatus.committedResult?.turn.handle, false);
    assert.equal(output.successorGeneration, (output.firstGeneration as number) + 1);
  },
);

test(
  "a fresh Host child reopens the exact terminal Chat through known-root recovery without a second provider start",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const root = await canonicalTestRoot("gamebuddy-pipeline-process-recovery-");
    const key = "klmnopqrstuvwxyzaabcde";
    try {
      const first = await runMountedChild(
        `
  const fx = await fixture();
  let startCalls = 0;
  const service = serviceFor(fx, async () => { startCalls += 1; });
  const accepted = await service.submitAfterResponseCommit(commandFor(fx, {}), "${key}", async () => undefined);
  await waitFor(() => startCalls === 1);
  await driveToTerminal(fx, "completed");
  const terminal = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: "${key}", selectionGeneration: fx.generation });
  await service.close();
  await fx.lease.close();
  await fx.authority.close();
  process.stdout.write(JSON.stringify({ accepted, terminal, manifestPath, startCalls, generation: fx.generation }));
`,
        root,
      );
      assert.equal(first.startCalls, 1);
      assert.equal((first.terminal as MessageSubmissionStatusV1).disposition, "terminal");

      const second = await runMountedChild(
        `
  const deployment = await loadHostDeploymentManifest(${JSON.stringify(root)} + "/fixture_1/manifest.json");
  const authority = await createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(deployment);
  const lease = await authority.startMountedChatRuntime();
  let startCalls = 0;
  const service = knownServiceFor(deployment, lease, async () => { startCalls += 1; });
  const status = await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: "${key}", selectionGeneration: lease.browserProjection.selectionGeneration });
  await service.close();
  await lease.close();
  await authority.close();
  process.stdout.write(JSON.stringify({ status, startCalls, generation: lease.browserProjection.selectionGeneration }));
`,
        root,
      );
      assert.equal(second.startCalls, 0);
      assert.equal(second.generation, (first.generation as number) + 1);
      const firstStatus = first.terminal as MessageSubmissionStatusV1;
      const secondStatus = second.status as MessageSubmissionStatusV1;
      assert.equal(secondStatus.disposition, "terminal");
      assert.equal(secondStatus.committedResult?.turn.state, firstStatus.committedResult?.turn.state);
      assert.equal(secondStatus.committedResult?.message.text, firstStatus.committedResult?.message.text);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "close rejects new admission and drains admitted acceptance, commit callbacks and start work",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const output = await mounted(`
  const fx = await fixture();
  let startCalls = 0;
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const service = serviceFor(fx, async () => { startCalls += 1; await startGate; });
  let releaseCommit;
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  const key = "fghijklmnopqrstuvwxyza";
  let commitCalls = 0;
  const submitted = service.submitAfterResponseCommit(commandFor(fx, {}), key, async () => { commitCalls += 1; await commitGate; });
  await waitFor(() => commitCalls === 1);
  let closeSettled = false;
  const closing = service.close().then(() => { closeSettled = true; });
  await ticks();
  const closePendingWhileCommitGated = !closeSettled;
  releaseCommit();
  const result = await submitted;
  await waitFor(() => startCalls === 1);
  const closePendingWhileStartGated = !closeSettled;
  releaseStart();
  await closing;
  const closeSettledAfterRelease = closeSettled;
  let afterCloseSubmit = "none";
  let afterCloseStatus = "none";
  try { await service.submitAfterResponseCommit(commandFor(fx, {}), key, async () => undefined); } catch (error) { afterCloseSubmit = String(error); }
  try { await service.readSubmissionStatus({ apiVersion: 1, idempotencyKey: key, selectionGeneration: fx.generation }); } catch (error) { afterCloseStatus = String(error); }
  let afterCloseForeign = "none";
  try { await service.submitAfterResponseCommit(commandFor(fx, {}), "gggggggggggggggggggggg", async () => undefined); } catch (error) { afterCloseForeign = String(error); }
  await fx.lease.close();
  await fx.authority.close();
  process.stdout.write(JSON.stringify({ result: result.disposition, startCalls, closePendingWhileCommitGated, closePendingWhileStartGated, closeSettledAfterRelease, afterCloseSubmit, afterCloseStatus, afterCloseForeign }));
`);
    assert.equal(output.result, "accepted");
    assert.equal(output.closePendingWhileCommitGated, true);
    assert.equal(output.closePendingWhileStartGated, true);
    assert.equal(output.closeSettledAfterRelease, true);
    // After close both new submits and status reads are rejected with the
    // service's fixed opaque code, before any durable work.
    assert.equal(output.afterCloseSubmit, "Error: chat_pipeline_service_closed");
    assert.equal(output.afterCloseForeign, "Error: chat_pipeline_service_closed");
    assert.equal(output.afterCloseStatus, "Error: chat_pipeline_service_closed");
  },
);

test(
  "a busy turn and a wrong mounted generation reject with zero mutation and zero extra start",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const output = await mounted(`
  const fx = await fixture();
  let startCalls = 0;
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const service = serviceFor(fx, async () => { startCalls += 1; await startGate; });
  const key = "ghijklmnopqrstuvwxyzab";
  const otherKey = "hijklmnopqrstuvwxyzabc";
  const wrongGenerationKey = "ijklmnopqrstuvwxyzabcd";
  await service.submitAfterResponseCommit(commandFor(fx, {}), key, async () => undefined);
  await waitFor(() => startCalls === 1);
  let busy = "none";
  try { await service.submitAfterResponseCommit(commandFor(fx, {}), otherKey, async () => undefined); } catch (error) { busy = String(error); }
  let wrongGeneration = "none";
  try { await service.submitAfterResponseCommit(commandFor(fx, { selectionGeneration: fx.generation + 1 }), wrongGenerationKey, async () => undefined); } catch (error) { wrongGeneration = String(error); }
  await ticks();
  const durable = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  releaseStart();
  await service.close();
  await fx.lease.close();
  await fx.authority.close();
  process.stdout.write(JSON.stringify({ busy, wrongGeneration, startCalls, messages: durable.messages.length, idempotency: durable.idempotency.length, ledgerStatus: durable.turnLedger === null ? null : durable.turnLedger.status }));
`);
    assert.equal(output.busy, "Error: turn_busy");
    assert.equal(output.wrongGeneration, "Error: chat_pipeline_service_selection_conflict");
    assert.equal(output.startCalls, 1);
    // The opening the fixture's companion materializes, plus the one player line.
    assert.equal(output.messages, 2);
    assert.equal(output.idempotency, 1);
    assert.equal(output.ledgerStatus, "attempt_starting");
  },
);

test(
  "regenerate re-generates the transcript's tail companion reply at its own position",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const output = await mounted(`
  const fx = await fixture();
  let startCalls = 0;
  const service = serviceFor(fx, async () => { startCalls += 1; });
  await service.submitAfterResponseCommit(commandFor(fx, {}), "klmnopqrstuvwxyzaabcde", async () => undefined);
  await waitFor(() => startCalls === 1);
  await driveToTerminal(fx, "completed");
  const durable = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  const handleOf = (id) => fx.lease.browserProjection.projectMessageHandle(id);
  // The fixture's companion materializes its own opening, so the transcript is
  // [opening, player line, companion reply]: the opening is the companion message
  // that has no player turn before it, and it is the audit's own case.
  const openingMessage = durable.messages[0];
  const playerMessage = durable.messages[1];
  const tailMessage = durable.messages[durable.messages.length - 1];
  const target = async (messageHandle, idempotencyKey) =>
    run(async () => service.regenerate({ apiVersion: 1, selectionGeneration: fx.generation, messageHandle }, idempotencyKey));
  // The opening (a companion message with no player turn to repeat), the player's
  // own line, and a handle that names nothing at all: each is refused before any
  // durable acceptance, and none of them may append a fake "\u8bf7\u7ee7\u7eed" turn.
  const openingTarget = await target(handleOf(openingMessage.messageId), "oooooooooooooooooooootab".slice(0, 22));
  const playerTarget = await target(handleOf(playerMessage.messageId), "pppppppppppppppppppppa");
  const unknownTarget = await target("Z".repeat(43), "uuuuuuuuuuuuuuuuuuuuua");
  // The one target it can honour: the transcript's own tail companion reply, and
  // the turn that honours it is a same-position variant.
  const accepted = await target(handleOf(tailMessage.messageId), "aaaaaaaaaaaaaaaaaaaaab");
  await ticks();
  const afterAcceptance = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  // The refused targets mutated nothing: no fourth message, no second record.
  const refusedState = { messages: durable.messages.length, idempotency: durable.idempotency.length };
  // The variant turn's own durable facts: the transcript grew by no row at all, and
  // the ledger's minted message id names no message the transcript carries.
  const acceptedState = {
    messages: afterAcceptance.messages.length,
    idempotency: afterAcceptance.idempotency.length,
    roles: afterAcceptance.messages.map((m) => m.role),
    kinds: afterAcceptance.messages.map((m) => m.kind),
    turnMessageId: afterAcceptance.turnLedger === null ? null : afterAcceptance.turnLedger.messageId,
    turnVariant: afterAcceptance.turnLedger === null ? null : afterAcceptance.turnLedger.variant ?? null,
  };
  // The provider path the service's injected start stands in for: Pi appends this
  // turn's prompt and answer, the coordinator's activation rewrites the entries the
  // reply position owns, and only after that does the commit append the new variant
  // to the existing reply row.
  const driven = await driveVariantToCompleted(fx, {
    targetMessageId: tailMessage.messageId,
    anchorText: playerMessage.text,
    committedReplyText: tailMessage.text,
    text: "Regenerated companion reply.",
  });
  const committedState = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  const responseIndex = committedState.messages.findIndex((m) => m.messageId === tailMessage.messageId);
  const selected = await run(async () =>
    service.selectSwipe({ apiVersion: 1, selectionGeneration: fx.generation, messageHandle: handleOf(tailMessage.messageId), direction: "prev" }));
  const restored = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  await service.close();
  await fx.lease.close();
  await fx.authority.close();
  process.stdout.write(JSON.stringify({
    openingTarget, playerTarget, unknownTarget, accepted, refusedState, startCalls,
    openingKind: openingMessage.kind,
    roles: durable.messages.map((m) => m.role),
    kinds: durable.messages.map((m) => m.kind),
    tailHandle: handleOf(tailMessage.messageId),
    playerMessageId: playerMessage.messageId,
    tailMessageId: tailMessage.messageId,
    committedSample: "Synthetic companion reply.",
    regeneratedSample: "Regenerated companion reply.",
    acceptedState, activation: driven.activation.status,
    contextEditCount: driven.activation.status === "activated" ? driven.activation.contextEditEntryIds.length : -1,
    modelTexts: driven.modelTexts,
    commitStatus: driven.committed.status,
    commitRoles: committedState.messages.map((m) => m.role),
    commitKinds: committedState.messages.map((m) => m.kind),
    playerRows: committedState.messages.filter((m) => m.role === "player").length,
    commitText: committedState.messages[responseIndex].text,
    commitSwipes: committedState.messages[responseIndex].swipes,
    commitIndex: committedState.messages[responseIndex].activeSwipeIndex,
    commitMessages: committedState.messages.length,
    selected: selected.ok ? selected.value.message : selected,
    restoredText: restored.messages[responseIndex].text,
    restoredIndex: restored.messages[responseIndex].activeSwipeIndex,
    restoredSwipes: restored.messages[responseIndex].swipes,
    restoredMessages: restored.messages.length,
  }));
`);
    // The opening is the audit's own case, and the fixture must really carry one
    // for the refusal below to mean anything.
    assert.equal(output.openingKind, "opening");
    for (const [what, entry] of [
      ["the opening", output.openingTarget],
      ["the player's own line", output.playerTarget],
      ["an unknown handle", output.unknownTarget],
    ] as const) {
      const refused = entry as { ok: boolean; error?: string };
      assert.equal(refused.ok, false, `${what} must be refused`);
      assert.match(refused.error ?? "", /chat_pipeline_service_unavailable/, what);
    }

    // The tail companion reply is re-generated at its own position: the acceptance
    // names that reply, not a minted player row, and the transcript does not grow -
    // the half the old path got wrong by asking for a second turn.
    const accepted = output.accepted as { ok: boolean; value?: SubmitResultV1 };
    assert.equal(accepted.ok, true);
    assert.equal(accepted.value?.disposition, "accepted");
    assert.equal(accepted.value?.message.role, "companion");
    assert.equal(accepted.value?.message.handle, output.tailHandle);
    assert.equal(accepted.value?.message.text, output.committedSample);
    assert.equal(output.startCalls, 2);
    const acceptedState = output.acceptedState as {
      messages: number;
      idempotency: number;
      roles: string[];
      kinds: string[];
      turnMessageId: string;
      turnVariant: { targetMessageId: string; anchorMessageId: string };
    };
    // Exactly one player row, before and after the variant acceptance, and no fourth
    // message: the red-before path appended a second player row here.
    assert.deepEqual(output.roles, ["companion", "player", "companion"]);
    assert.deepEqual(output.kinds, ["opening", "player", "response"]);
    assert.equal(acceptedState.messages, 3);
    assert.deepEqual(acceptedState.roles, ["companion", "player", "companion"]);
    assert.deepEqual(acceptedState.kinds, ["opening", "player", "response"]);
    assert.equal(acceptedState.idempotency, 2);
    // The accepted turn is a variant of the tail reply, anchored on the player row it
    // answered, and its own message id is the opaque variant identity that names no row.
    assert.match(acceptedState.turnMessageId, /^variant_turn_/);
    assert.deepEqual(Object.keys(acceptedState.turnVariant).sort(), ["anchorMessageId", "targetMessageId"]);
    assert.equal(acceptedState.turnVariant.anchorMessageId, output.playerMessageId);
    assert.equal(acceptedState.turnVariant.targetMessageId, output.tailMessageId);
    assert.deepEqual(output.refusedState, { messages: 3, idempotency: 1 });

    // The model's context carries the variant the player is about to read, and not the
    // superseded text: the invariant this whole mechanism rests on, read from the
    // session's own projection after the activation and before the commit.
    assert.equal(output.activation, "activated");
    assert.equal(output.contextEditCount, 1);
    const modelTexts = output.modelTexts as string[];
    assert.equal(modelTexts.filter((text) => text === output.regeneratedSample).length, 2);
    assert.equal(modelTexts.filter((text) => text === output.committedSample).length, 0);
    assert.equal(modelTexts.filter((text) => text === "Synthetic player request").length, 2);

    // The visible half: the same companion row, same count, same order - now carrying
    // the regenerated reply as its second variant and showing it.
    assert.equal(output.commitStatus, "presentation_committed");
    assert.deepEqual(output.commitRoles, ["companion", "player", "companion"]);
    assert.deepEqual(output.commitKinds, ["opening", "player", "response"]);
    assert.equal(output.playerRows, 1);
    assert.equal(output.commitMessages, 3);
    assert.deepEqual(output.commitSwipes, [output.committedSample, output.regeneratedSample]);
    assert.equal(output.commitText, output.regeneratedSample);
    assert.equal(output.commitIndex, 1);

    // Selecting the first variant gives the player the original text back, at the same
    // row, with both variants still there.
    const selected = output.selected as { text?: string; swipeInfo?: Record<string, unknown> };
    assert.equal(selected.text, output.committedSample);
    assert.deepEqual(selected.swipeInfo, {
      currentIndex: 0,
      totalSwipes: 2,
      label: "1/2",
      hasPrevious: false,
      hasNext: true,
    });
    assert.equal(output.restoredText, output.committedSample);
    assert.equal(output.restoredIndex, 0);
    assert.deepEqual(output.restoredSwipes, [output.committedSample, output.regeneratedSample]);
    assert.equal(output.restoredMessages, 3);
  },
);

test(
  "the bounded visible tail reaches a keyword while the bound book's declared depth includes it, and stops one turn past it",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const output = await mounted(`
  const fx = await fixture();
  let startCalls = 0;
  const service = serviceFor(fx, async () => { startCalls += 1; });
  const resume = () => fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  const sourceIds = (plan) => plan === undefined ? [] : plan.volatileSources.map((s) => s.sourceId).slice().sort();
  const { readFile } = await import("node:fs/promises");
  // The BOUND BOOK - not a literal in this test - owns the window: its declared
  // scan depth and its own trigger words. Reading them here is what keeps a
  // content edit ("depth 2 -> 4", reworded keys, a new opening) from pinning
  // this assertion to yesterday's bytes.
  const runtimeCwd = resolveRuntimePaths(principal, fx.root).runtimeCwd;
  const book = JSON.parse(await readFile(runtimeCwd + "/worldbook.json", "utf8"));
  const declaredDepth = book.scanDepth;
  if (!Number.isSafeInteger(declaredDepth) || declaredDepth < 1) throw new Error("worldbook_has_no_declared_depth");
  const opening = (await resume()).messages[0].text;
  const neutral = ["接着聊聊别的吧", "还是别的话题"];
  const reply = "Synthetic companion reply.";
  // A trigger word is usable as the plant only while it is the ONLY thing that
  // can select its entry: none of that entry's keys may already ride in the
  // opening, the neutral turns or the synthetic reply, so the entry's presence
  // below is caused by the planted turn alone.
  const keywordEntries = book.entries.filter((entry) => entry.constant !== true);
  const plantedIndex = keywordEntries.findIndex((entry) => {
    const keys = entry.keys ?? [];
    return keys.length > 0 && keys.every((key) => ![opening, reply, ...neutral].some((text) => text.includes(key)));
  });
  if (plantedIndex < 0) throw new Error("worldbook_has_no_isolatable_trigger");
  const plantedKey = keywordEntries[plantedIndex].keys[0];
  const plantedSourceId = book.worldBookId + "_entry_" + (plantedIndex + 1);
  // The selection scans the transcript BEFORE the current turn is accepted, so
  // the planted turn-1 player message (index 1) rides the tail while
  // 2*turn - 2 <= declaredDepth; the first turn past that is the boundary.
  const lastReachableTurn = Math.floor((declaredDepth + 2) / 2);
  const plans = [];
  const scannedMessageCounts = [];
  for (let turn = 1; turn <= lastReachableTurn + 1; turn += 1) {
    const before = await resume();
    const text = turn === 1 ? plantedKey : neutral[(turn - 2) % neutral.length];
    await service.submitAfterResponseCommit(commandFor(fx, { text, expectedDraftRevision: turn - 1 }), String.fromCharCode(96 + turn).repeat(22), async () => undefined);
    await waitFor(() => startCalls === turn);
    plans.push(sourceIds((await resume()).currentTurnContextPlan));
    scannedMessageCounts.push(before.messages.length);
    await driveToTerminal(fx, "completed", "response_turn_" + turn);
  }
  await service.close();
  await fx.lease.close();
  await fx.authority.close();
  process.stdout.write(JSON.stringify({ plans, scannedMessageCounts, declaredDepth, plantedKey, plantedSourceId, lastReachableTurn, startCalls }));
`);
    const plans = output.plans as string[][];
    const declaredDepth = output.declaredDepth as number;
    const lastReachableTurn = output.lastReachableTurn as number;
    const plantedSourceId = output.plantedSourceId as string;
    assert.equal(output.startCalls, lastReachableTurn + 1);
    assert.equal(plans.length, lastReachableTurn + 1);
    // While the planted turn is inside the bound book's declared window the entry
    // is retrieved - and from turn 2 on the CURRENT line no longer carries the
    // word, so the tail is what reaches it.
    for (let turn = 1; turn <= lastReachableTurn; turn += 1) {
      const plan = plans[turn - 1] ?? [];
      assert.ok(
        plan.includes(plantedSourceId),
        `turn ${turn} is inside declaredDepth=${declaredDepth} and must carry ${plantedSourceId}, got ${JSON.stringify(plan)}`,
      );
    }
    // One turn past the declared window the same word must NOT reach its entry:
    // the window is bounded by the declared depth, never the whole transcript.
    const beyond = plans[lastReachableTurn] ?? [];
    assert.equal(
      beyond.includes(plantedSourceId),
      false,
      `turn ${lastReachableTurn + 1} is past declaredDepth=${declaredDepth} and must not carry ${plantedSourceId}, got ${JSON.stringify(beyond)}`,
    );
    // The exclusion is real: the boundary turn scans more messages than the
    // declared window holds, so something HAD to fall out of it.
    const scannedAtBoundary = (output.scannedMessageCounts as number[])[lastReachableTurn] ?? 0;
    assert.ok(
      scannedAtBoundary > declaredDepth,
      `the boundary turn scans ${scannedAtBoundary} messages against declaredDepth=${declaredDepth}`,
    );
  },
);
