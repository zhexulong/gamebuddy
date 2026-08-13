import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readReservedChatRuntimeMaterializationFacts,
  releaseReservedChatRuntimeMaterialization,
  reserveChatRuntimeMaterialization,
  withConsumedChatRuntimeBinding,
} from "./continuity-semantic-chat-runtime-binding.internal.js";
import { createTestChatRuntimeBinding } from "./continuity-semantic-chat-runtime-binding.test-support.js";

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });

async function binding() {
  const root = await mkdtemp(join(tmpdir(), "chat-runtime-binding-"));
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot,
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
  );
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
