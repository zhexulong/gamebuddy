/**
 * Two Chat selections requested at the same moment, on one real authority.
 *
 * The surface has no way to make the second click wait for the first: the player taps two Chats inside one network
 * round trip and the Host is handed both intents at once. What matters is not that both are honoured - only one
 * Chat can be mounted - but that the ANSWERS and the MOUNT agree, and that the durable selection is the Chat the
 * player is looking at. A request that interleaves its checks with another one answers `switched` for a Chat the
 * runtime then does not serve, which is the defect this file measures.
 *
 * The authority owns a real Windows root mutex, so it lives in its own process, exactly as one Host runs one.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";

const principal = Object.freeze({ playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" });

const childPreamble = `
  const [coordinatorUrl, deploymentUrl, storeUrl, runtimeUrl, manifestPath] = process.argv.slice(1);
  const { loadHostDeploymentManifest } = await import(deploymentUrl);
  const { createSharedSemanticProductionAuthorityFromDeploymentManifest, isCurrentMountedChatRuntimeLease } =
    await import(coordinatorUrl);
  const { createChatThreadStore } = await import(storeUrl);
  const { identityKey } = await import(runtimeUrl);
  const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", storeUrl).href);
  const { createBuildWindowsStaleLockReclaimer } = await import(new URL("../windows-stale-lock-reclaimer/index.js", storeUrl).href);
  await bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const { createManifestDerivedInitialChatExactContentPort } = await import(new URL("./initial-chat-exact-content-port.js", storeUrl).href);
  const manifest = await loadHostDeploymentManifest(manifestPath);
  const shared = await createSharedSemanticProductionAuthorityFromDeploymentManifest(manifest);
  const authority = shared.chat;
  const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
  const first = await authority.startMountedChatRuntime();
  const firstGeneration = first.browserProjection.selectionGeneration;
  const createChat = async (chatThreadId, chatSurfaceSessionId) => {
    const content = createManifestDerivedInitialChatExactContentPort(manifest);
    try {
      await content.port.createExplicit({
        chatThreadId,
        chatSurfaceSessionId,
        companionId: manifest.principal.companionId,
        continuityId: manifest.principal.continuityId,
        opening: "blank",
      });
    } finally {
      content.close();
    }
  };
  const outcome = async (work) => {
    try {
      const value = await work();
      return { status: value.status, chatThreadId: value.chatThreadId, chatSurfaceSessionId: value.chatSurfaceSessionId };
    } catch (error) {
      return { status: "threw", code: error instanceof Error ? error.message : String(error) };
    }
  };
`;

async function runChild(body: string): Promise<Record<string, unknown>> {
  const root = await canonicalTestRoot("gamebuddy-chat-select-concurrency-");
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
  try {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        childPreamble + body,
        new URL(
          "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
          import.meta.url,
        ).href,
        new URL("../deployment-manifest.js", import.meta.url).href,
        new URL("../tavern/chat-thread-store.js", import.meta.url).href,
        new URL("../runtime.js", import.meta.url).href,
        manifestPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    // The child holds live runtime handles by design (a mounted Chat runtime, the semantic store), so it does not
    // exit on its own: the reading is complete when its one JSON object is, and the child is then stopped. Waiting
    // for `exit` would wait for a handle the product never closes on that path.
    const reading = new Promise<Record<string, unknown>>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        output.push(chunk);
        const text = Buffer.concat(output).toString("utf8");
        if (!text.includes("}")) return;
        try {
          resolve(JSON.parse(text) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.on("exit", (code) => {
        reject(
          new Error(
            `chat_select_concurrency_child_exited_without_a_reading code=${String(code)} stderr=${Buffer.concat(errors).toString("utf8")}`,
          ),
        );
      });
    });
    try {
      return await reading;
    } finally {
      child.kill();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("two selections requested at once answer what the runtime then serves, and the later one is refused by name", async () => {
  const reading = await runChild(`
    await createChat("chat-" + "b".repeat(16), "surface-" + "b".repeat(16));
    await createChat("chat-" + "c".repeat(16), "surface-" + "c".repeat(16));
    const selectB = () => authority.requestChatSelection({
      kind: "select",
      selectionGeneration: firstGeneration,
      chatThreadId: "chat-" + "b".repeat(16),
      chatSurfaceSessionId: "surface-" + "b".repeat(16),
    });
    const selectC = () => authority.requestChatSelection({
      kind: "select",
      selectionGeneration: firstGeneration,
      chatThreadId: "chat-" + "c".repeat(16),
      chatSurfaceSessionId: "surface-" + "c".repeat(16),
    });
    // Both clicks land in the same tick, before either can finish its own async checks.
    const answers = await Promise.all([
      outcome(selectB).then((value) => ({ first: value })),
      outcome(selectC).then((value) => ({ second: value })),
    ]);
    const mounted = await authority.startMountedChatRuntime();
    const durable = store.resumeThread(mounted.chatThreadId, mounted.chatSurfaceSessionId);
    process.stdout.write(JSON.stringify({
      answers,
      mountedThread: mounted.chatThreadId,
      mountedSurface: mounted.chatSurfaceSessionId,
      mountedIsCurrent: isCurrentMountedChatRuntimeLease(mounted),
      firstSuperseded: isCurrentMountedChatRuntimeLease(first),
      durableThreadReadable: (await durable).thread.chatThreadId === mounted.chatThreadId,
    }));
  `);
  const answers = reading.answers as ReadonlyArray<
    Record<string, { status: string; code?: string; chatThreadId?: string; chatSurfaceSessionId?: string }>
  >;
  const first = answers[0]!.first!;
  const second = answers[1]!.second!;
  const switched = [first, second].filter((answer) => answer.status === "switched");
  // One Chat can be mounted, so one intent wins and the other is refused by the name of its own staleness - never a
  // second `switched` for a Chat the runtime does not serve.
  assert.equal(switched.length, 1, `both selections answered switched: ${JSON.stringify(answers)}`);
  const refused = [first, second].find((answer) => answer.status !== "switched")!;
  assert.equal(refused.status, "threw");
  assert.equal(refused.code, "semantic_chat_selection_generation_conflict");
  // The answer and the mount are the same Chat: that is the whole invariant this test exists for.
  assert.equal(switched[0]!.chatThreadId, reading.mountedThread);
  assert.equal(switched[0]!.chatSurfaceSessionId, reading.mountedSurface);
  assert.equal(reading.mountedIsCurrent, true);
  assert.equal(reading.durableThreadReadable, true);
});
