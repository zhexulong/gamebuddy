import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

if (process.platform !== "win32") throw new Error("P4b durable attempt claim requires real Windows production mounting");

const script = async (body: string) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p4b-"));
  const facadeUrl = new URL("./p4-provider-attempt.js", import.meta.url).href;
  const coordinatorUrl = new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js", import.meta.url).href;
  const deploymentUrl = new URL("../deployment-manifest.js", import.meta.url).href;
  const storeUrl = new URL("./chat-thread-store.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", body, facadeUrl, coordinatorUrl, deploymentUrl, storeUrl, root], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const [code] = (await once(child, "exit")) as [number | null];
  const stderr = Buffer.concat(errors).toString("utf8");
  try {
    assert.equal(code, 0, stderr);
    return JSON.parse(Buffer.concat(output).toString("utf8")) as Record<string, unknown>;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const mountPreamble = `
  const [facadeUrl, coordinatorUrl, deploymentUrl, storeUrl, root] = process.argv.slice(1);
  const { writeFile } = await import("node:fs/promises");
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  const manifestPath = root + "/manifest.json";
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: root, principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1 }));
  const { loadHostDeploymentManifest } = await import(deploymentUrl);
  const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = await import(coordinatorUrl);
  const { createP4DurableTurnAcceptanceFacade } = await import(new URL("./p4-durable-turn-acceptance.js", facadeUrl).href);
  const { createP4ProviderAttemptFacade } = await import(facadeUrl);
  const { createChatThreadStore, claimP4MountedAttempt } = await import(storeUrl);
  const { identityKey } = await import(new URL("../runtime.js", storeUrl).href);
  const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", storeUrl).href);
  const { createBuildWindowsStaleLockReclaimer } = await import(new URL("../windows-stale-lock-reclaimer/index.js", storeUrl).href);
  await bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const manifest = await loadHostDeploymentManifest(manifestPath);
  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
  const lease = await authority.startMountedChatRuntime();
  const accept = createP4DurableTurnAcceptanceFacade(manifest, lease);
  const attempt = createP4ProviderAttemptFacade(manifest, lease);
  const accepted = await accept.accept({ text: "Hello", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 });
`;

test("P4b facade is limited to private bridge and never imports session/provider surfaces", async () => {
  const source = await readFile(new URL("./p4-provider-attempt.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/p4-provider-attempt\.internal\.js"/);
  assert.doesNotMatch(source, /session\.prompt|DialogueController|AgentSession|chat-thread-store|continuity-semantic-production-coordinator\.internal/);
});

test("P4b claims exactly one durable generation-one attempt and reopening preserves it", async () => {
  const result = await script(`${mountPreamble}
  const first = await attempt.claim();
  const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
  await lease.close(); await authority.close();
  process.stdout.write(JSON.stringify({ accepted, first, state, sessionKeys: Object.keys(lease.runtimeSession).sort() }));
  `);
  const first = result.first as { status: string; attempt: { generation: number; attemptId: string; selectionGeneration: number; runtimeBindingDigest: string; runtimeOwner: unknown } };
  assert.ok(first);
  const state = result.state as { messages: unknown[]; draft: { revision: number; text: string | null }; turnLedger: typeof first; idempotency: unknown[] };
  assert.equal(first.status, "attempt_starting");
  assert.equal(first.attempt.generation, 1);
  assert.match(first.attempt.attemptId, /^attempt_[A-Za-z0-9]+$/);
  assert.equal(first.attempt.selectionGeneration, 1);
  assert.match(first.attempt.runtimeBindingDigest, /^[a-f0-9]{64}$/);
  assert.ok(first.attempt.runtimeOwner);
  assert.equal(state.turnLedger.status, "attempt_starting");
  assert.deepEqual(state.turnLedger.attempt, first.attempt);
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.draft, { revision: 1, text: null });
  assert.equal(state.idempotency.length, 1);
  assert.deepEqual(result.sessionKeys, ["piSessionId", "profile"]);
});

test("P4b refuses a repeat claim without changing its durable attempt", async () => {
  const result = await script(`${mountPreamble}
    const first = await attempt.claim();
    let rejection = null;
    try { await attempt.claim(); } catch (error) { rejection = String(error); }
    const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await lease.close(); await authority.close();
    process.stdout.write(JSON.stringify({ first, rejection, state }));
  `);
  const first = result.first as { attempt: unknown };
  const state = result.state as { turnLedger: { status: string; attempt: unknown } };
  assert.equal(result.rejection, "Error: attempt_already_claimed");
  assert.equal(state.turnLedger.status, "attempt_starting");
  assert.deepEqual(state.turnLedger.attempt, first.attempt);
});

test("P4b close revokes an unconsumed claim admission before raw-store ingress", async () => {
  const result = await script(`${mountPreamble}
    const internal = await import(new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", facadeUrl).href);
    const release = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const pending = internal.claimMountedP4Attempt(
      manifest,
      lease,
      async (admission) => {
        entered.resolve();
        await release.promise;
        return internal.consumeMountedP4AttemptAdmission(admission, (binding) => createChatThreadStore(root, identityKey(principal)).claimMountedAttempt(binding));
      },
    );
    await entered.promise;
    const closing = lease.close();
    release.resolve();
    let rejection = null;
    try { await pending; } catch (error) { rejection = String(error); }
    await closing;
    const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await authority.close();
    process.stdout.write(JSON.stringify({ rejection, status: state.turnLedger.status }));
  `);
  assert.equal(result.rejection, "SemanticProductionCoordinatorError: semantic_chat_runtime_p4_attempt_admission_rejected");
  assert.equal(result.status, "accepted_queued");
});

test("P4b claim admissions reject recursive and saved replay consumption", async () => {
  const result = await script(`${mountPreamble}
    const internal = await import(new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", facadeUrl).href);
    let recursive = null;
    let replay = null;
    const claimed = await internal.claimMountedP4Attempt(
      manifest,
      lease,
      async (admission) => {
        const first = await internal.consumeMountedP4AttemptAdmission(admission, async (binding) => {
          try { await internal.consumeMountedP4AttemptAdmission(admission, async () => undefined); } catch (error) { recursive = String(error); }
          return claimP4MountedAttempt(binding);
        });
        try { await internal.consumeMountedP4AttemptAdmission(admission, async () => undefined); } catch (error) { replay = String(error); }
        return first;
      },
    );
    await lease.close(); await authority.close();
    process.stdout.write(JSON.stringify({ recursive, replay, status: claimed.status, generation: claimed.attempt.generation }));
  `);
  assert.equal(result.recursive, "SemanticProductionCoordinatorError: semantic_chat_runtime_p4_attempt_admission_rejected");
  assert.equal(result.replay, "SemanticProductionCoordinatorError: semantic_chat_runtime_p4_attempt_admission_rejected");
  assert.equal(result.status, "attempt_starting");
  assert.equal(result.generation, 1);
});

test("P4c releases only a provably pre-arm reservation and never releases an armed attempt", async () => {
  const result = await script(`${mountPreamble}
    const internal = await import(new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", facadeUrl).href);
    await attempt.claim();
    let preArmFailure = null;
    try {
      await internal.startMountedP4Attempt(manifest, lease, async () => {
        throw new Error("pre_arm_local_failure");
      });
    } catch (error) { preArmFailure = String(error); }
    let resumed = 0;
    const armed = await internal.startMountedP4Attempt(manifest, lease, (invocation) =>
      internal.consumeMountedP4AttemptInvocationAdmission(invocation, async (scope) => {
        resumed += 1;
        return scope.transitionStore({ operation: "arm", observedAtMs: Date.now() });
      }),
    );
    let armedRejection = null;
    try {
      await internal.startMountedP4Attempt(manifest, lease, async () => {
        throw new Error("must_not_reenter_armed_attempt");
      });
    } catch (error) { armedRejection = String(error); }
    const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await lease.close(); await authority.close();
    process.stdout.write(JSON.stringify({ preArmFailure, resumed, armed, armedRejection, state }));
  `);
  const armed = result.armed as { status: string; observation?: { phase: string } };
  const state = result.state as { turnLedger: { status: string; observation?: { phase: string } } };
  assert.equal(result.preArmFailure, "Error: pre_arm_local_failure");
  assert.equal(result.resumed, 1);
  assert.equal(armed.status, "attempt_starting");
  assert.equal(armed.observation?.phase, "armed");
  assert.equal(result.armedRejection, "SemanticProductionCoordinatorError: semantic_chat_runtime_p4_attempt_admission_rejected");
  assert.equal(state.turnLedger.status, "attempt_starting");
  assert.equal(state.turnLedger.observation?.phase, "armed");
});

test("P4c callback-scoped transition closures reject saved use after their admission returns", async () => {
  const result = await script(`${mountPreamble}
    const internal = await import(new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", facadeUrl).href);
    await attempt.claim();
    let saved;
    const armed = await internal.startMountedP4Attempt(manifest, lease, (invocation) =>
      internal.consumeMountedP4AttemptInvocationAdmission(invocation, async (scope) => {
        saved = scope.transitionStore;
        return scope.transitionStore({ operation: "arm", observedAtMs: Date.now() });
      }),
    );
    let rejection = null;
    try { await saved({ operation: "running", statusClass: "success", observedAtMs: Date.now() + 1 }); }
    catch (error) { rejection = String(error); }
    const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await lease.close(); await authority.close();
    process.stdout.write(JSON.stringify({ armed, rejection, status: state.turnLedger.status, phase: state.turnLedger.observation?.phase }));
  `);
  assert.equal((result.armed as { status: string }).status, "attempt_starting");
  assert.equal(result.rejection, "SemanticProductionCoordinatorError: semantic_chat_runtime_p4_attempt_invocation_rejected");
  assert.equal(result.status, "attempt_starting");
  assert.equal(result.phase, "armed");
});

test("P4/P5 raw transitions reject saved attempt facts after mounted lease close without mutation", async () => {
  const result = await script(`${mountPreamble}
    const { transitionP4MountedProviderStart, transitionP5MountedPresentation } = await import(storeUrl);
    const claimed = await attempt.claim();
    const binding = {
      runtimeRoot: root,
      ...principal,
      chatThreadId: lease.chatThreadId,
      chatSurfaceSessionId: lease.chatSurfaceSessionId,
      selectionGeneration: claimed.attempt.selectionGeneration,
      runtimeBindingDigest: claimed.attempt.runtimeBindingDigest,
      runtimeOwner: claimed.attempt.runtimeOwner,
      attemptId: claimed.attempt.attemptId,
    };
    await lease.close();
    let p4Rejection = null;
    let p5Rejection = null;
    try { await transitionP4MountedProviderStart(binding, { operation: "arm", observedAtMs: Date.now() }); }
    catch (error) { p4Rejection = String(error); }
    try {
      await transitionP5MountedPresentation(binding, {
        operation: "commit_presentation",
        cancelEpoch: 0,
        message: { messageId: "response_raw_01", text: "forged", occurredAtMs: Date.now() },
        committedAtMs: Date.now(),
      });
    } catch (error) { p5Rejection = String(error); }
    const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await authority.close();
    process.stdout.write(JSON.stringify({ p4Rejection, p5Rejection, status: state.turnLedger.status, messages: state.messages.length }));
  `);
  assert.equal(result.p4Rejection, "Error: p4_p5_transition_authority_unavailable");
  assert.equal(result.p5Rejection, "Error: p4_p5_transition_authority_unavailable");
  assert.equal(result.status, "attempt_starting");
  assert.equal(result.messages, 1);
});

test("P4 transition queued behind the thread lock rejects after lease close revokes authority", async () => {
  const result = await script(`${mountPreamble}
    const internal = await import(new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", facadeUrl).href);
    const { withPathLock } = await import(new URL("../path-lock.js", storeUrl).href);
    await attempt.claim();
    const threadPath = root + "/tavern/v1/continuities/" + identityKey(principal) + "/threads/" + lease.chatThreadId + "/thread.json";
    let closing;
    let pendingRejection = null;
    await internal.startMountedP4Attempt(manifest, lease, (invocation) =>
      internal.consumeMountedP4AttemptInvocationAdmission(invocation, async (scope) => {
        let pending;
        await withPathLock(threadPath, async () => {
          pending = scope.transitionStore({ operation: "arm", observedAtMs: Date.now() });
          // The transition has asserted authority but is blocked on this lock.
          await Promise.resolve();
          closing = lease.close();
        });
        try { await pending; } catch (error) { pendingRejection = String(error); }
        return null;
      }),
    );
    await closing;
    const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await authority.close();
    process.stdout.write(JSON.stringify({ pendingRejection, status: state.turnLedger.status, observation: state.turnLedger.observation }));
  `);
  assert.equal(result.pendingRejection, "Error: p4_p5_transition_authority_unavailable");
  assert.equal(result.status, "attempt_starting");
  assert.equal(result.observation, undefined);
});

test("P5 transition queued behind the thread lock rejects after lease close revokes authority", async () => {
  const result = await script(`${mountPreamble}
    const internal = await import(new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", facadeUrl).href);
    const { withPathLock } = await import(new URL("../path-lock.js", storeUrl).href);
    await attempt.claim();
    const threadPath = root + "/tavern/v1/continuities/" + identityKey(principal) + "/threads/" + lease.chatThreadId + "/thread.json";
    let closing;
    let pendingRejection = null;
    await internal.startMountedP4Attempt(manifest, lease, (invocation) =>
      internal.consumeMountedP4AttemptInvocationAdmission(invocation, async (scope) => {
        await scope.transitionStore({ operation: "arm", observedAtMs: Date.now() });
        await scope.transitionStore({ operation: "running", statusClass: "success", observedAtMs: Date.now() });
        let pending;
        await withPathLock(threadPath, async () => {
          const now = Date.now();
          pending = scope.transitionPresentation({
            operation: "commit_presentation",
            cancelEpoch: 0,
            message: { messageId: "response_lock_01", text: "blocked", occurredAtMs: now },
            committedAtMs: now,
          });
          // The transition has asserted authority but is blocked on this lock.
          await Promise.resolve();
          closing = lease.close();
        });
        try { await pending; } catch (error) { pendingRejection = String(error); }
        return null;
      }),
    );
    await closing;
    const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await authority.close();
    process.stdout.write(JSON.stringify({ pendingRejection, status: state.turnLedger.status, messages: state.messages.length }));
  `);
  assert.equal(result.pendingRejection, "Error: p4_p5_transition_authority_unavailable");
  assert.equal(result.status, "running");
  assert.equal(result.messages, 1);
});

test("P4 transition started before callback return cannot commit after operation scope revocation", async () => {
  const result = await script(`${mountPreamble}
    const internal = await import(new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", facadeUrl).href);
    const { withPathLock } = await import(new URL("../path-lock.js", storeUrl).href);
    await attempt.claim();
    const threadPath = root + "/tavern/v1/continuities/" + identityKey(principal) + "/threads/" + lease.chatThreadId + "/thread.json";
    const callbackEntered = Promise.withResolvers();
    const proceed = Promise.withResolvers();
    const holderEntered = Promise.withResolvers();
    const holderRelease = Promise.withResolvers();
    let pending;
    const starting = internal.startMountedP4Attempt(manifest, lease, (invocation) =>
      internal.consumeMountedP4AttemptInvocationAdmission(invocation, async (scope) => {
        callbackEntered.resolve();
        await proceed.promise;
        pending = scope.transitionStore({ operation: "arm", observedAtMs: Date.now() });
        return null;
      }),
    );
    await callbackEntered.promise;
    const holder = withPathLock(threadPath, async () => {
      holderEntered.resolve();
      await holderRelease.promise;
    });
    await holderEntered.promise;
    proceed.resolve();
    await starting;
    holderRelease.resolve();
    await holder;
    let rejection = null;
    try { await pending; } catch (error) { rejection = String(error); }
    const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await lease.close(); await authority.close();
    process.stdout.write(JSON.stringify({ rejection, status: state.turnLedger.status, observation: state.turnLedger.observation }));
  `);
  assert.equal(result.rejection, "Error: p4_p5_transition_operation_authority_unavailable");
  assert.equal(result.status, "attempt_starting");
  assert.equal(result.observation, undefined);
});

test("P5 transition started before callback return cannot commit after operation scope revocation", async () => {
  const result = await script(`${mountPreamble}
    const internal = await import(new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", facadeUrl).href);
    const { withPathLock } = await import(new URL("../path-lock.js", storeUrl).href);
    await attempt.claim();
    const threadPath = root + "/tavern/v1/continuities/" + identityKey(principal) + "/threads/" + lease.chatThreadId + "/thread.json";
    const callbackEntered = Promise.withResolvers();
    const proceed = Promise.withResolvers();
    const holderEntered = Promise.withResolvers();
    const holderRelease = Promise.withResolvers();
    let pending;
    const starting = internal.startMountedP4Attempt(manifest, lease, (invocation) =>
      internal.consumeMountedP4AttemptInvocationAdmission(invocation, async (scope) => {
        await scope.transitionStore({ operation: "arm", observedAtMs: Date.now() });
        await scope.transitionStore({ operation: "running", statusClass: "success", observedAtMs: Date.now() + 1 });
        callbackEntered.resolve();
        await proceed.promise;
        const now = Date.now() + 2;
        pending = scope.transitionPresentation({
          operation: "commit_presentation",
          cancelEpoch: 0,
          message: { messageId: "response_scope_01", text: "blocked", occurredAtMs: now },
          committedAtMs: now,
        });
        return null;
      }),
    );
    await callbackEntered.promise;
    const holder = withPathLock(threadPath, async () => {
      holderEntered.resolve();
      await holderRelease.promise;
    });
    await holderEntered.promise;
    proceed.resolve();
    await starting;
    holderRelease.resolve();
    await holder;
    let rejection = null;
    try { await pending; } catch (error) { rejection = String(error); }
    const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await lease.close(); await authority.close();
    process.stdout.write(JSON.stringify({ rejection, status: state.turnLedger.status, messages: state.messages.length }));
  `);
  assert.equal(result.rejection, "Error: p4_p5_transition_operation_authority_unavailable");
  assert.equal(result.status, "running");
  assert.equal(result.messages, 1);
});

test("P5 private STOP rejects an attempt before running without poisoning its presentation epoch", async () => {
  const result = await script(`${mountPreamble}
    const internal = await import(new URL("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", facadeUrl).href);
    await attempt.claim();
    let stopRejection = null;
    try {
      await internal.stopMountedChatPresentationEpoch(manifest, lease, {
        stopId: "stop_01",
        sourceEventId: "source_01",
        reasonCode: "player_stop",
      });
    } catch (error) { stopRejection = String(error); }
    const armed = await internal.startMountedP4Attempt(manifest, lease, (invocation) =>
      internal.consumeMountedP4AttemptInvocationAdmission(invocation, async (scope) => {
        const activation = scope.activatePresentation();
        await activation.deactivate();
        return scope.transitionStore({ operation: "arm", observedAtMs: Date.now() });
      }),
    );
    const state = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await lease.close(); await authority.close();
    process.stdout.write(JSON.stringify({ stopRejection, armed, state }));
  `);
  const armed = result.armed as { status: string; observation?: { phase: string } };
  const state = result.state as { turnLedger: { status: string; observation?: { phase: string } } };
  assert.equal(result.stopRejection, "SemanticProductionCoordinatorError: semantic_chat_runtime_p5_presentation_epoch_unavailable");
  assert.equal(armed.status, "attempt_starting");
  assert.equal(armed.observation?.phase, "armed");
  assert.equal(state.turnLedger.status, "attempt_starting");
  assert.equal(state.turnLedger.observation?.phase, "armed");
});

test("P4b mismatched manifest reaches neither claim nor a durable write", async () => {
  const result = await script(`${mountPreamble}
  const pristine = async () => {
    const s = await createChatThreadStore(root, identityKey(principal)).resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    return s.turnLedger.status === "accepted_queued";
  };
  const wrong = [
    { ...manifest, runtimeRoot: root + "/wrong" },
    { ...manifest, principal: { ...principal, playerId: "player_02" } },
    { ...manifest, principal: { ...principal, companionId: "companion_02" } },
    { ...manifest, principal: { ...principal, continuityId: "continuity_02" } },
  ];
  const rejected = [];
  const unchanged = [];
  for (const bad of wrong) {
    const fake = createP4ProviderAttemptFacade(bad, lease);
    try { await fake.claim(); rejected.push(false); } catch (error) { rejected.push(/p4_provider_attempt_unavailable/.test(String(error))); }
    unchanged.push(await pristine());
  }
  await lease.close(); await authority.close();
  process.stdout.write(JSON.stringify({ rejected, unchanged }));
  `);
  assert.deepEqual(result.rejected, [true, true, true, true]);
  assert.deepEqual(result.unchanged, [true, true, true, true]);
});
