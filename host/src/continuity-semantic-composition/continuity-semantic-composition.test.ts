import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createFreshSemanticProductionAuthorityFromDeploymentManifest,
  createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import { identityKey } from "../runtime.js";
import { createChatThreadStore } from "../tavern/chat-thread-store.js";
import {
  createManifestDerivedInitialChatExactContentPort,
  type InitialChatExactContentPort,
} from "../tavern/initial-chat-exact-content-port.js";

const principal = Object.freeze({
  continuityId: "composition-continuity",
  companionId: "composition-companion",
  playerId: "composition-player",
});
function chatManifest(root: string): string {
  const runtimeRoot = join(root, "runtime");
  mkdirSync(runtimeRoot);
  const manifestPath = join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot,
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
  );
  return manifestPath;
}

/** The content port is intentionally exercised between two short SQLite sections. */
test(
  "initial Chat composition resumes every unfinished phase across real close/reopen under the semantic authority",
  { skip: process.platform !== "win32" ? "requires real WindowsNamedMutexBroker" : false },
  async () => {
    for (const phase of ["claimed_empty", "chat_registered", "content_verified"] as const) {
      const root = mkdtempSync(join(tmpdir(), `initial-chat-${phase}-`));
      try {
        const manifestPath = chatManifest(root);
        const manifest = await loadHostDeploymentManifest(manifestPath);
        const baseContent = createManifestDerivedInitialChatExactContentPort(manifest);
        let createCalls = 0;
        let resumeCalls = 0;
        const content: InitialChatExactContentPort = Object.freeze({
          async createExplicit(request) {
            createCalls++;
            return baseContent.createExplicit(request);
          },
          async resumeExact(threadId, companionId, continuityId, surfaceId) {
            resumeCalls++;
            return baseContent.resumeExact(threadId, companionId, continuityId, surfaceId);
          },
        });
        const fresh = await createFreshSemanticProductionAuthorityFromDeploymentManifest(manifest);
        const claimed = await fresh.startInitialChat();
        assert.equal(claimed.phase, "claimed_empty");
        if (phase === "claimed_empty") {
          await fresh.close();
        } else {
          const registered = await fresh.registerInitialChat();
          assert.equal(registered.phase, "chat_registered");
          assert.ok(registered.chatThreadId && registered.chatSurfaceSessionId);
          const exact = await content.createExplicit({
            chatThreadId: registered.chatThreadId,
            chatSurfaceSessionId: registered.chatSurfaceSessionId,
            companionId: principal.companionId,
            continuityId: principal.continuityId,
            opening: "blank",
          });
          if (phase === "content_verified") {
            const verified = await fresh.verifyInitialChat(exact);
            assert.equal(verified.phase, "content_verified");
          }
          await fresh.close();
        }

        const reopened = await createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest(manifest);
        try {
          if (phase === "claimed_empty") {
            await assert.rejects(
              reopened.resumeInitialChatWithContent(content),
              /initial_chat_resume_requires_explicit_creation/,
            );
          } else {
            const selected = await reopened.resumeInitialChatWithContent(content);
            assert.equal(selected?.phase, "selected");
            assert.ok(selected?.chatThreadId && selected.chatSurfaceSessionId && selected.receipt);
          }
          const expectedCalls = {
            claimed_empty: { create: 0, resume: 0 },
            chat_registered: { create: 1, resume: 1 },
            content_verified: { create: 1, resume: 1 },
          } as const;
          assert.equal(createCalls, expectedCalls[phase].create);
          assert.equal(resumeCalls, expectedCalls[phase].resume);
        } finally {
          await reopened.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "known initial Chat resume rejects binding-preserving Tavern content mutation after content verification",
  { skip: process.platform !== "win32" ? "requires real WindowsNamedMutexBroker" : false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "initial-chat-content-tamper-"));
    try {
      const manifestPath = chatManifest(root);
      const manifest = await loadHostDeploymentManifest(manifestPath);
      const content = createManifestDerivedInitialChatExactContentPort(manifest);
      const fresh = await createFreshSemanticProductionAuthorityFromDeploymentManifest(manifest);
      let registered: Awaited<ReturnType<typeof fresh.registerInitialChat>> | undefined;
      try {
        await fresh.startInitialChat();
        registered = await fresh.registerInitialChat();
        assert.ok(registered.chatThreadId && registered.chatSurfaceSessionId);
        const exact = await content.createExplicit({
          chatThreadId: registered.chatThreadId,
          chatSurfaceSessionId: registered.chatSurfaceSessionId,
          companionId: principal.companionId,
          continuityId: principal.continuityId,
          opening: "blank",
        });
        assert.equal((await fresh.verifyInitialChat(exact)).phase, "content_verified");
      } finally {
        await fresh.close();
      }

      const tavern = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
      await tavern.renameThreadTitle!({
        chatThreadId: registered!.chatThreadId!,
        chatSurfaceSessionId: registered!.chatSurfaceSessionId!,
        expectedManagementRevision: 1,
        title: "mutated after verification",
      });

      const reopened = await createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest(manifest);
      try {
        await assert.rejects(reopened.resumeInitialChatWithContent(content), /tavern_exact_content_receipt_mismatch/);
        assert.equal((await reopened.resumeInitialChat())?.phase, "content_verified");
      } finally {
        await reopened.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
