import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { TavernBrowserValidatorsV1 } from "./browser-contract/index.js";
import { assertCurrentMountedLeaseAfterDurableRead, createP3ExactChatStateFacade } from "./p3-exact-chat-state.js";

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

/** A structural copy has every public field but cannot obtain the coordinator WeakMap brand. */
test("P3 facade rejects a forged structural mounted lease before durable access", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p3-forged-"));
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
      }),
      attachPresentation: () => () => undefined,
      close: async () => undefined,
    }) as unknown as MountedChatRuntimeLease;
    await assert.rejects(createP3ExactChatStateFacade(manifest(root), forged), /p3_exact_chat_state_unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P3 post-read lease guard rejects when a controlled durable-read completion observes revocation", () => {
  // This narrow test seam supplies a predicate only. It cannot mint or brand a
  // lease, because production still calls the coordinator's private WeakMap
  // predicate. The controlled promise models lease.close during durable I/O.
  const inertLease = Object.freeze({}) as MountedChatRuntimeLease;
  let resolveRead!: () => void;
  const durableRead = new Promise<void>((resolve) => {
    resolveRead = resolve;
  });
  let current = true;
  const postRead = durableRead.then(() => assertCurrentMountedLeaseAfterDurableRead(inertLease, () => current));
  current = false;
  resolveRead();
  return assert.rejects(postRead, /p3_exact_chat_state_unavailable/);
});

test(
  "P3 facade uses a real mounted projection, hides durable IDs, and requires the session-scoped identity binding",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gamebuddy-p3-mounted-"));
    try {
      const coordinatorUrl = new URL(
        "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
        import.meta.url,
      ).href;
      const facadeUrl = new URL("./p3-exact-chat-state.js", import.meta.url).href;
      const runtimeUrl = new URL("../runtime.js", import.meta.url).href;
      const deploymentUrl = new URL("../deployment-manifest.js", import.meta.url).href;
      const threadsUrl = new URL("./chat-thread-store.js", import.meta.url).href;
      const identityUrl = new URL("../identity-profile.js", import.meta.url).href;
      const script = `
        const [coordinatorUrl, facadeUrl, runtimeUrl, deploymentUrl, threadsUrl, identityUrl, root] = process.argv.slice(1);
        const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
        const { writeFile, unlink } = await import("node:fs/promises");
        const manifestPath = root + "/manifest.json";
        await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: root, principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1 }));
        const { loadHostDeploymentManifest } = await import(deploymentUrl);
        const manifest = await loadHostDeploymentManifest(manifestPath);
        const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = await import(coordinatorUrl);
        const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", coordinatorUrl));
        const { createBuildWindowsStaleLockReclaimer } = await import(new URL("../windows-stale-lock-reclaimer/index.js", coordinatorUrl));
        bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
        const { createP3ExactChatStateFacade } = await import(facadeUrl);
        const { identityKey, resolveRuntimePaths } = await import(runtimeUrl);
        const { createChatThreadStore } = await import(threadsUrl);
        const { readIdentityProfile, createIdentityProfileBinding, writeIdentityProfileBinding } = await import(identityUrl);
        const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
        const lease = await authority.startMountedChatRuntime();
        const key = identityKey(principal);
        const threads = createChatThreadStore(root, key);
        await threads.appendPlayer(lease.chatThreadId, { messageId: "message_01", text: "Hello", occurredAtMs: 11 });
        await threads.appendPlayer(lease.chatThreadId, { messageId: "message_02", text: "Again", occurredAtMs: 12 });
        const state = await (await createP3ExactChatStateFacade(manifest, lease)).read();
        const paths = resolveRuntimePaths(principal, root, lease.chatSurfaceSessionId);
        const profile = await readIdentityProfile(paths.identityProfilePath);
        const rootPaths = resolveRuntimePaths(principal, root);
        await writeIdentityProfileBinding(rootPaths.identityProfileBindingPath, createIdentityProfileBinding(key, profile), { containmentRoot: root });
        await unlink(paths.identityProfileBindingPath);
        let rootBindingAccepted = true;
        try { await createP3ExactChatStateFacade(manifest, lease); } catch { rootBindingAccepted = false; }
        await writeIdentityProfileBinding(paths.identityProfileBindingPath, createIdentityProfileBinding(key, profile), { containmentRoot: root });
        const sessionBindingAccepted = await createP3ExactChatStateFacade(manifest, lease).then(() => true, () => false);
        process.stdout.write(JSON.stringify({ state, expected: { chatHandle: lease.browserProjection.chatHandle, generation: lease.browserProjection.selectionGeneration, stateRevision: lease.browserProjection.selectionStateRevision, messageHandles: [lease.browserProjection.projectMessageHandle("message_01"), lease.browserProjection.projectMessageHandle("message_02")] }, raw: { chatThreadId: lease.chatThreadId, messageIds: ["message_01", "message_02"] }, rootBindingAccepted, sessionBindingAccepted }));
        await authority.close();
      `;
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          script,
          coordinatorUrl,
          facadeUrl,
          runtimeUrl,
          deploymentUrl,
          threadsUrl,
          identityUrl,
          root,
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      const output: Buffer[] = [],
        errors: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      const [code] = (await once(child, "exit")) as [number | null];
      assert.equal(code, 0, Buffer.concat(errors).toString("utf8"));
      const result = JSON.parse(Buffer.concat(output).toString("utf8")) as {
        state: {
          selection: unknown;
          transcript: readonly {
            handle: string;
            role: "player" | "companion";
            text: string;
            locale: "und";
            order: number;
            revision: number;
          }[];
        };
        expected: { chatHandle: string; generation: number; stateRevision: string; messageHandles: readonly string[] };
        raw: { chatThreadId: string; messageIds: readonly string[] };
        rootBindingAccepted: boolean;
        sessionBindingAccepted: boolean;
      };
      assert.deepEqual(result.state.selection, {
        chatHandle: result.expected.chatHandle,
        generation: result.expected.generation,
        stateRevision: result.expected.stateRevision,
      });
      assert.deepEqual(result.state.transcript, [
        {
          handle: result.expected.messageHandles[0],
          role: "player",
          text: "Hello",
          locale: "und",
          order: 0,
          revision: 1,
        },
        {
          handle: result.expected.messageHandles[1],
          role: "player",
          text: "Again",
          locale: "und",
          order: 1,
          revision: 1,
        },
      ]);
      assert.equal(TavernBrowserValidatorsV1.BrowserMessageV1Schema.Check(result.state.transcript[0]), true);
      assert.equal(TavernBrowserValidatorsV1.BrowserMessageV1Schema.Check(result.state.transcript[1]), true);
      assert.equal(JSON.stringify(result.state).includes(result.raw.chatThreadId), false);
      assert.equal(
        result.raw.messageIds.some((messageId) => JSON.stringify(result.state).includes(messageId)),
        false,
      );
      assert.equal(result.rootBindingAccepted, false);
      assert.equal(result.sessionBindingAccepted, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
