import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";

import {
  queryCurrentOwnerProof,
  readReservedChatRuntimeMaterializationFacts,
  releaseReservedChatRuntimeMaterialization,
  reserveChatRuntimeMaterialization,
  withConsumedChatRuntimeBinding,
} from "./continuity-semantic-chat-runtime-binding.internal.js";
import { createTestChatRuntimeBinding } from "./continuity-semantic-chat-runtime-binding.test-support.js";

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });

async function binding() {
  const root = await canonicalTestRoot("chat-runtime-binding-");
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  return {
    root,
    runtime: createTestChatRuntimeBinding({
      manifest: Object.freeze({
        schemaVersion: 2,
        topology: "independent_chat_and_game_surfaces",
        runtimeRoot,
        principal,
        bootstrapOperationId: "bootstrap_01",
        authorityGeneration: 1,
      }),
      ownerProof: Object.freeze({ processId: 42, creationTime100ns: "123456" }),
    }),
  };
}

test("Chat binding construction has no path-based manifest loader and production composition supplies its manifest snapshot", async () => {
  // The normal test artifact mirrors `src` as `dist-test`; keep this source
  // seam check pinned to the production source rather than emitted output.
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
  const bindingSource = await readFile(
    join(
      sourceRoot,
      "continuity-semantic-chat-runtime-binding",
      "continuity-semantic-chat-runtime-binding.internal.ts",
    ),
    "utf8",
  );
  const publicSource = await readFile(
    join(sourceRoot, "continuity-semantic-chat-runtime-binding", "continuity-semantic-chat-runtime-binding.ts"),
    "utf8",
  );
  const coordinatorSource = await readFile(
    join(
      sourceRoot,
      "continuity-semantic-production-coordinator",
      "continuity-semantic-production-coordinator.internal.ts",
    ),
    "utf8",
  );

  assert.doesNotMatch(bindingSource, /loadHostDeploymentManifest|manifestPath/);
  assert.match(bindingSource, /createChatRuntimeBinding\(manifest: HostDeploymentManifest\)/);
  assert.match(publicSource, /createChatRuntimeBinding/);
  assert.doesNotMatch(publicSource, /manifestPath/);
  assert.match(coordinatorSource, /createChatRuntimeBinding\(manifest\)/);
  assert.doesNotMatch(coordinatorSource, /createChatRuntimeBindingFromManifest/);
});

test("admits exactly one callback-owned Chat runtime reservation and exposes only minted prepare facts", async () => {
  const fixture = await binding();
  let reservation: object | undefined;
  try {
    const facts = await fixture.runtime.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) => {
        reservation = reserveChatRuntimeMaterialization(execution);
        return readReservedChatRuntimeMaterializationFacts(reservation);
      }),
    );
    assert.match(facts.runtimeBindingDigest, /^[a-f0-9]{64}$/);
    assert.equal(facts.owner.ownerPid, 42);
    assert.match(facts.owner.ownerToken, /^[0-9a-f-]{36}$/);
  } finally {
    if (reservation) releaseReservedChatRuntimeMaterialization(reservation);
    await fixture.runtime.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("callback return closes admission while its already-reserved Chat runtime effect drains close", async () => {
  const fixture = await binding();
  let reservation: object | undefined;
  try {
    reservation = await fixture.runtime.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) => reserveChatRuntimeMaterialization(execution)),
    );
    await assert.rejects(
      fixture.runtime.executeWithBinding((token) => withConsumedChatRuntimeBinding(token, () => undefined)),
      /chat_runtime_binding_unavailable/,
    );
    const close = fixture.runtime.close();
    let settled = false;
    void close.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    releaseReservedChatRuntimeMaterialization(reservation);
    reservation = undefined;
    await close;
  } finally {
    if (reservation) releaseReservedChatRuntimeMaterialization(reservation);
    await fixture.runtime.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

/**
 * The owner proof attests that this process is the process it claims to be, so its strictness is the point:
 * these cases drive the query with raw PowerShell output so the retry can be proven not to relax anything.
 */
test("a transient query failure is retried once after a bounded backoff, and the retry's proof is the one returned", async () => {
  const ticks = "133700000000000000";
  let attempts = 0;
  const startedAt = Date.now();
  const proof = await queryCurrentOwnerProof(async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
    return { stdout: `${process.pid}|${ticks}\n`, stderr: "" };
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(attempts, 2, "one retry, not a loop");
  // The backoff is 250ms (OWNER_IDENTITY_QUERY_RETRY_BACKOFF_MS): an immediate second attempt would land
  // inside the same busy instant, which is the flake this hardening exists to remove.
  assert.ok(elapsed >= 250, `the retry waits a bounded backoff before re-asking (waited ${elapsed}ms)`);
  assert.deepEqual(proof, { processId: process.pid, creationTime100ns: ticks });
  assert.ok(Object.isFrozen(proof));
});

test("a different owner is still refused on both attempts", async () => {
  let attempts = 0;
  await assert.rejects(
    queryCurrentOwnerProof(async () => {
      attempts += 1;
      return { stdout: `${process.pid + 1}|133700000000000000\n`, stderr: "" };
    }),
    /windows_runtime_owner_identity_query_failed:message:invalid_windows_owner_identity_output/,
  );
  assert.equal(attempts, 2, "the refusal is re-checked on the retry too");
});

test("an unreadable or noisy answer still fails closed, and a persistent failure names its reason", async () => {
  await assert.rejects(
    queryCurrentOwnerProof(async () => ({ stdout: "", stderr: "" })),
    /windows_runtime_owner_identity_query_failed:message:invalid_windows_owner_identity_output/,
  );
  await assert.rejects(
    queryCurrentOwnerProof(async () => ({
      stdout: `${process.pid}|133700000000000000\n`,
      stderr: "Get-CimInstance : Access is denied\n",
    })),
    /windows_runtime_owner_identity_query_failed:message:unexpected_windows_owner_identity_stderr/,
  );
  await assert.rejects(
    queryCurrentOwnerProof(async () => {
      throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
    }),
    /windows_runtime_owner_identity_query_failed:code:EAGAIN/,
  );
});

test("the production query reads this process's own creation time from the OS", async (t) => {
  if (process.platform !== "win32") {
    t.skip("the owner proof is a Windows process-creation-time record");
    return;
  }
  // No injected runner here: this is the wiring production uses, and it must still answer for this process.
  const proof = await queryCurrentOwnerProof();
  assert.equal(proof.processId, process.pid);
  assert.match(proof.creationTime100ns, /^[0-9]{1,20}$/);
});
