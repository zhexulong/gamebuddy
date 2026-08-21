import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { type BrowserTurnV1, composeTavernProfile, TavernBrowserValidatorsV1 } from "./browser-contract/index.js";
import {
  assertReferencePipelineLeaseAfterDurableRead,
  createReferencePipelineStateFacade,
  type ReferencePipelineState,
} from "./reference-pipeline-state.js";

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
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.submission_status"],
    operationIds: ["chat.submit"],
    navigationItemIds: ["chat"],
  });
}

test("reference facade rejects a forged structural mounted lease before durable access", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-reference-forged-"));
  try {
    const forged = Object.freeze({
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
    await assert.rejects(
      createReferencePipelineStateFacade(manifest(root), forged, referenceProfile()),
      /reference_pipeline_state_unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reference post-read lease guard rejects when a controlled durable-read completion observes revocation", () => {
  // This narrow test seam supplies a predicate only. It cannot mint or brand a
  // lease, because production still calls the coordinator's private WeakMap
  // predicate. The controlled promise models lease.close during durable I/O.
  const inertLease = Object.freeze({}) as MountedChatRuntimeLease;
  let resolveRead!: () => void;
  const durableRead = new Promise<void>((resolve) => {
    resolveRead = resolve;
  });
  let current = true;
  const postRead = durableRead.then(() => assertReferencePipelineLeaseAfterDurableRead(inertLease, () => current));
  current = false;
  resolveRead();
  return assert.rejects(postRead, /reference_pipeline_state_unavailable/);
});

const mountPreamble = `
  const [facadeUrl, coordinatorUrl, deploymentUrl, storeUrl, runtimeUrl, contractUrl, p4aUrl, p4bUrl, internalUrl, root] = process.argv.slice(1);
  const { writeFile } = await import("node:fs/promises");
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  const manifestPath = root + "/manifest.json";
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: root, principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1 }));
  const { loadHostDeploymentManifest } = await import(deploymentUrl);
  const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = await import(coordinatorUrl);
  const { createReferencePipelineStateFacade } = await import(facadeUrl);
  const { createChatThreadStore } = await import(storeUrl);
  const { identityKey } = await import(runtimeUrl);
  const { composeTavernProfile } = await import(contractUrl);
  const { createP4DurableTurnAcceptanceFacade } = await import(p4aUrl);
  const { createP4ProviderAttemptFacade } = await import(p4bUrl);
  const internal = await import(internalUrl);
  const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", storeUrl).href);
  const { createBuildWindowsStaleLockReclaimer } = await import(new URL("../windows-stale-lock-reclaimer/index.js", storeUrl).href);
  await bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const profile = composeTavernProfile({ profileId: "gamebuddy.chat-core.reference-pipeline", releaseTier: "chat_core", routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status"], operationIds: ["chat.submit", "chat.cancel"], navigationItemIds: ["chat"] });
  const noSubmitProfile = composeTavernProfile({ profileId: "gamebuddy.p3-chat", releaseTier: "chat_core", routeIds: ["bootstrap", "state.read", "draft.read"], operationIds: [], navigationItemIds: ["chat"] });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextTime = async () => { await sleep(2); return Date.now(); };
  let fixtureNumber = 0;
  async function fixture() {
    const fixtureRoot = root + "/fixture_" + (++fixtureNumber);
    await (await import("node:fs/promises")).mkdir(fixtureRoot, { recursive: true });
    const fixtureManifestPath = fixtureRoot + "/manifest.json";
    await writeFile(fixtureManifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: fixtureRoot, principal, bootstrapOperationId: "bootstrap_" + fixtureNumber, authorityGeneration: 1 }));
    const fixtureManifest = await loadHostDeploymentManifest(fixtureManifestPath);
    const store = () => createChatThreadStore(fixtureRoot, identityKey(principal));
    const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(fixtureManifest);
    const lease = await authority.startMountedChatRuntime();
    return Object.freeze({
      root: fixtureRoot,
      manifest: fixtureManifest,
      authority,
      lease,
      facade: await createReferencePipelineStateFacade(fixtureManifest, lease, profile),
      accept: createP4DurableTurnAcceptanceFacade(fixtureManifest, lease),
      attempt: createP4ProviderAttemptFacade(fixtureManifest, lease),
      store,
    });
  }
  async function drive(fx, target) {
    if (target === "none") return null;
    const accepted = await fx.accept.accept({ text: "Hello", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 });
    if (target === "accepted_queued") return accepted;
    const claimed = await fx.attempt.claim();
    if (target === "attempt_starting") return claimed;
    return internal.startMountedP4Attempt(fx.manifest, fx.lease, (invocation) =>
      internal.consumeMountedP4AttemptInvocationAdmission(invocation, async (scope) => {
        const times = [await nextTime(), await nextTime(), await nextTime(), await nextTime(), await nextTime()];
        await scope.transitionStore({ operation: "arm", observedAtMs: times[0] });
        const running = await scope.transitionStore({ operation: "running", statusClass: "success", observedAtMs: times[1] });
        if (target === "running") return running;
        if (target === "failed") return scope.transitionPresentation({ operation: "fail", reasonCode: "runtime_unavailable", failedAtMs: times[2] });
        if (target === "cancel_claimed" || target === "cancelled") {
          const cancelledClaim = await internal.stopMountedChatPresentationEpoch(fx.manifest, fx.lease, { stopId: "stop_01", sourceEventId: "source_01", reasonCode: "player_stop" });
          if (target === "cancel_claimed") return cancelledClaim;
          return scope.transitionPresentation({ operation: "cancel", cancelledAtMs: await nextTime() });
        }
        const committed = await scope.transitionPresentation({ operation: "commit_presentation", cancelEpoch: 0, message: { messageId: "response_01", text: "Synthetic companion reply.", occurredAtMs: times[2] }, committedAtMs: times[2] });
        if (target === "presentation_committed") return committed;
        const completionClaimed = await scope.transitionPresentation({ operation: "claim_completion", claimedAtMs: times[3] });
        if (target === "completion_claimed") return completionClaimed;
        return scope.transitionPresentation({ operation: "complete", completedAtMs: times[4] });
      }),
    );
  }
`;

async function mounted(body: string): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-reference-state-"));
  const facadeUrl = new URL("./reference-pipeline-state.js", import.meta.url).href;
  const coordinatorUrl = new URL(
    "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
    import.meta.url,
  ).href;
  const deploymentUrl = new URL("../deployment-manifest.js", import.meta.url).href;
  const storeUrl = new URL("./chat-thread-store.js", import.meta.url).href;
  const runtimeUrl = new URL("../runtime.js", import.meta.url).href;
  const contractUrl = new URL("./browser-contract/index.js", import.meta.url).href;
  const p4aUrl = new URL("./p4-durable-turn-acceptance.js", import.meta.url).href;
  const p4bUrl = new URL("./p4-provider-attempt.js", import.meta.url).href;
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
      facadeUrl,
      coordinatorUrl,
      deploymentUrl,
      storeUrl,
      runtimeUrl,
      contractUrl,
      p4aUrl,
      p4bUrl,
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
  try {
    assert.equal(code, 0, Buffer.concat(errors).toString("utf8"));
    return JSON.parse(Buffer.concat(output).toString("utf8")) as Record<string, unknown>;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type MatrixEntry = Readonly<{
  target: string;
  expected: string | null;
  ledgerStatus: string | null;
  turn: BrowserTurnV1 | null;
  expectedHandle: string | null;
  turnId: string | null;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  messageIds: readonly string[];
  readable: ReferencePipelineState;
}>;

test(
  "reference state maps every durable ledger state through one opaque turn handle",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const results = (await mounted(`
  const cases = [
    ["none", null], ["accepted_queued", "queued"], ["attempt_starting", "queued"], ["running", "running"],
    ["presentation_committed", "running"], ["completion_claimed", "running"],
    ["cancel_claimed", "running"], ["completed", "completed"], ["cancelled", "cancelled"], ["failed", "failed"],
  ];
  const results = [];
  for (const [target, expected] of cases) {
    const fx = await fixture();
    await drive(fx, target);
    const durable = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
    const readable = await fx.facade.read();
    results.push({
      target,
      expected,
      ledgerStatus: durable.turnLedger === null ? null : durable.turnLedger.status,
      turn: readable.turn,
      expectedHandle: durable.turnLedger === null ? null : fx.lease.browserProjection.projectTurnHandle(durable.turnLedger.turnId),
      turnId: durable.turnLedger === null ? null : durable.turnLedger.turnId,
      chatThreadId: fx.lease.chatThreadId,
      chatSurfaceSessionId: fx.lease.chatSurfaceSessionId,
      messageIds: durable.messages.map((message) => message.messageId),
      readable,
    });
    await fx.lease.close();
    await fx.authority.close();
  }
  process.stdout.write(JSON.stringify(results));
`)) as unknown as MatrixEntry[];
    assert.equal(results.length, 10);
    for (const entry of results) {
      assert.deepEqual(entry.ledgerStatus, entry.target === "none" ? null : entry.target, entry.target);
      assert.deepEqual(entry.turn?.state ?? null, entry.expected, entry.target);
      assert.deepEqual(entry.turn?.handle ?? null, entry.expectedHandle, entry.target);
      assert.equal(entry.expectedHandle === null, entry.turnId === null, entry.target);
      if (entry.turn !== null) {
        assert.equal(TavernBrowserValidatorsV1.BrowserTurnV1Schema.Check(entry.turn), true, entry.target);
        assert.equal(entry.turn.projectionRevision, 1, entry.target);
        assert.equal(
          entry.turn.canCancel,
          entry.target === "running",
          entry.target,
        );
        assert.match(entry.turn.handle, /^[A-Za-z0-9_-]{43}$/, entry.target);
        assert.notEqual(entry.turn.handle, entry.turnId, entry.target);
      }
      // The projected transcript, turn and operations all satisfy their frozen contract schemas.
      for (const message of entry.readable.transcript)
        assert.equal(TavernBrowserValidatorsV1.BrowserMessageV1Schema.Check(message), true, entry.target);
      assert.deepEqual(
        entry.readable.operations,
        [
          {
            operationId: "chat.submit",
            labelKey: "tavern.operation.submit",
            availability: entry.turn === null || ["completed", "cancelled", "failed"].includes(entry.target)
              ? "available"
              : "busy",
            routeId: "chat.submit",
          },
          {
            operationId: "chat.cancel",
            labelKey: "tavern.operation.cancel",
            availability: entry.target === "running" ? "available" : "unavailable",
            routeId: "chat.cancel",
          },
        ],
        entry.target,
      );
      for (const operation of entry.readable.operations)
        assert.equal(TavernBrowserValidatorsV1.TavernBrowserOperationV1Schema.Check(operation), true, entry.target);
      // Raw durable identities never leak into the browser projection.
      const serialized = JSON.stringify(entry.readable);
      for (const raw of [entry.turnId, entry.chatThreadId, entry.chatSurfaceSessionId, ...entry.messageIds]) {
        if (raw === null) continue;
        assert.equal(serialized.includes(raw), false, `${entry.target} leaked raw identity ${raw}`);
      }
      for (const message of entry.readable.transcript)
        assert.equal(entry.messageIds.includes(message.handle), false, entry.target);
    }
  },
);

test(
  "reference state reopens identically, fails closed on corrupt durable state, and rejects revoked leases with no partial state",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const result = (await mounted(`
  const fx = await fixture();
  await drive(fx, "completed");
  const first = await fx.facade.read();
  const firstDraft = await fx.facade.readDraft();
  const durable = await fx.store().resumeThread(fx.lease.chatThreadId, fx.lease.chatSurfaceSessionId);
  const reopenedFacade = await createReferencePipelineStateFacade(fx.manifest, fx.lease, profile);
  const reopened = await reopenedFacade.read();
  const reopenedDraft = await reopenedFacade.readDraft();
  // A corrupted durable transcript must make every read fail closed: no partial
  // projection may escape while the lease is still current.
  const key = identityKey(principal);
  const fs = await import("node:fs/promises");
  // ChatThreadStore's sole durable authority is the per-continuity SQLite
  // database. Corrupt that actual authority—not an inert legacy path—so the
  // read must fail closed with no browser projection.
  await fs.writeFile(fx.root + "/tavern/v1/continuities/" + key + "/tavern.sqlite", "{ corrupted", "utf8");
  let corruptRejection = "none";
  try { await reopenedFacade.read(); } catch (error) { corruptRejection = String(error); }
  let corruptDraftRejection = "none";
  try { await reopenedFacade.readDraft(); } catch (error) { corruptDraftRejection = String(error); }
  await fx.lease.close();
  let closedRejection = "none";
  try { await fx.facade.read(); } catch (error) { closedRejection = String(error); }
  let closedDraftRejection = "none";
  try { await fx.facade.readDraft(); } catch (error) { closedDraftRejection = String(error); }
  await fx.authority.close();
  process.stdout.write(JSON.stringify({ first, firstDraft, reopened, reopenedDraft, ledgerStatus: durable.turnLedger.status, turnId: durable.turnLedger.turnId, chatThreadId: fx.lease.chatThreadId, chatSurfaceSessionId: fx.lease.chatSurfaceSessionId, messageIds: durable.messages.map((message) => message.messageId), corruptRejection, corruptDraftRejection, closedRejection, closedDraftRejection }));
`)) as Record<string, unknown>;
    const first = result.first as ReferencePipelineState;
    const reopened = result.reopened as ReferencePipelineState;
    const firstDraft = result.firstDraft as { apiVersion: 1; revision: number; text: string | null };
    const reopenedDraft = result.reopenedDraft as { apiVersion: 1; revision: number; text: string | null };
    assert.equal(result.ledgerStatus, "completed");
    assert.equal(first.turn?.state, "completed");
    // A reopened store projects the same terminal message and turn.
    assert.deepEqual(reopened, first);
    assert.deepEqual(reopenedDraft, firstDraft);
    assert.deepEqual(firstDraft, { apiVersion: 1, revision: 1, text: null });
    assert.equal(TavernBrowserValidatorsV1.BrowserDraftV1Schema.Check(firstDraft), true);
    assert.equal(TavernBrowserValidatorsV1.BrowserDraftV1Schema.Check(reopenedDraft), true);
    assert.equal(TavernBrowserValidatorsV1.BrowserTurnV1Schema.Check(reopened.turn!), true);
    for (const message of reopened.transcript)
      assert.equal(TavernBrowserValidatorsV1.BrowserMessageV1Schema.Check(message), true);
    // Handles are opaque: never the raw durable identifier.
    assert.match(reopened.turn!.handle, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(reopened.turn!.handle, result.turnId);
    const serialized = JSON.stringify(reopened);
    for (const raw of [
      result.turnId,
      result.chatThreadId,
      result.chatSurfaceSessionId,
      ...(result.messageIds as string[]),
    ])
      assert.equal(serialized.includes(raw as string), false);
    for (const rawMessageId of result.messageIds as string[])
      assert.equal(
        reopened.transcript.some((message) => message.handle === rawMessageId),
        false,
      );
    // Corrupt durable state and revoked-after-await leases both fail closed
    // with the exact facade code; no partial snapshot is produced.
    assert.equal(result.corruptRejection, "Error: reference_pipeline_state_unavailable");
    assert.equal(result.corruptDraftRejection, "Error: reference_pipeline_state_unavailable");
    assert.equal(result.closedRejection, "Error: reference_pipeline_state_unavailable");
    assert.equal(result.closedDraftRejection, "Error: reference_pipeline_state_unavailable");
  },
);

test(
  "reference profile gates the chat.submit operation and rejects non-composed profile forgeries",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const result = (await mounted(`
  const fx = await fixture();
  const withoutSubmit = await createReferencePipelineStateFacade(fx.manifest, fx.lease, noSubmitProfile);
  const pristine = await fx.facade.read();
  const without = await withoutSubmit.read();
  await drive(fx, "accepted_queued");
  const queued = await fx.facade.read();
  // A structural copy of a composed profile is not a capability slice.
  const forged = { ...profile };
  let profileRejection = "none";
  try { await createReferencePipelineStateFacade(fx.manifest, fx.lease, forged); } catch (error) { profileRejection = String(error); }
  await fx.lease.close();
  await fx.authority.close();
  process.stdout.write(JSON.stringify({ pristine, without, queued, profileRejection }));
`)) as Record<string, unknown>;
    const pristine = result.pristine as ReferencePipelineState;
    const without = result.without as ReferencePipelineState;
    const queued = result.queued as ReferencePipelineState;
    assert.equal(pristine.turn, null);
    assert.deepEqual(pristine.operations, [
      {
        operationId: "chat.submit",
        labelKey: "tavern.operation.submit",
        availability: "available",
        routeId: "chat.submit",
      },
      {
        operationId: "chat.cancel",
        labelKey: "tavern.operation.cancel",
        availability: "unavailable",
        routeId: "chat.cancel",
      },
    ]);
    // A profile that excludes chat.submit exposes no submit operation at all.
    assert.deepEqual(without.operations, []);
    assert.equal(without.turn, null);
    // An existing turn makes the mounted submit operation busy.
    assert.equal(queued.turn?.state, "queued");
    assert.deepEqual(queued.operations, [
      { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "busy", routeId: "chat.submit" },
      { operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "unavailable", routeId: "chat.cancel" },
    ]);
    for (const operation of [...pristine.operations, ...queued.operations])
      assert.equal(TavernBrowserValidatorsV1.TavernBrowserOperationV1Schema.Check(operation), true);
    for (const readable of [pristine, without, queued]) {
      if (readable.turn !== null)
        assert.equal(TavernBrowserValidatorsV1.BrowserTurnV1Schema.Check(readable.turn), true);
    }
    assert.equal(result.profileRejection, "Error: reference_pipeline_state_unavailable");
  },
);
