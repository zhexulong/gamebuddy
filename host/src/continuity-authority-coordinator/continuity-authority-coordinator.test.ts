import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  createContinuityAuthorityCoordinator,
  type ContinuityAuthorityBackend,
  type ContinuityAuthorityCommand,
} from "./continuity-authority-coordinator.js";

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });

const chatSelection = (): Extract<ContinuityAuthorityCommand, { kind: "chat_select_open" }> =>
  Object.freeze({
    kind: "chat_select_open",
    principal,
    input: {
      principal,
      continuityId: principal.continuityId,
      companionId: principal.companionId,
      playerId: principal.playerId,
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "chat_01",
      expectedPartitionRevision: 7,
      expectedSelectionRevision: 2,
      expectedFenceEpoch: 1,
      operationId: "select_01",
    },
  });

function semanticBackend(onPrepare: (command: ContinuityAuthorityCommand) => void = () => {}): ContinuityAuthorityBackend {
  return Object.freeze({
    authority: "SEMANTIC",
    prepare(command) {
      onPrepare(command);
      return Object.freeze({ state: "completed", result: Object.freeze({ result: "chat" }) as never });
    },
    commit() {
      return {} as never;
    },
    abort() {},
    effectFailed() {
      return {} as never;
    },
  });
}

test("coordinator has one semantic backend and forwards an exact Chat command", async () => {
  let prepared: ContinuityAuthorityCommand | undefined;
  const coordinator = createContinuityAuthorityCoordinator({
    semanticBackend: semanticBackend((command) => {
      prepared = command;
    }),
    runtimeWhitelist: ["runtime_01"],
    effectExecutor: { async execute() { return {} as never; } },
  });

  const result = await coordinator.executeJson(JSON.stringify(chatSelection()));
  assert.deepEqual(result, { result: "chat" });
  assert.equal(prepared?.kind, "chat_select_open");
  assert.equal(prepared?.input.expectedPartitionRevision, 7);
});

test("coordinator rejects an invalid continuity identifier before the semantic backend", async () => {
  let calls = 0;
  const coordinator = createContinuityAuthorityCoordinator({
    semanticBackend: semanticBackend(() => {
      calls++;
    }),
    runtimeWhitelist: ["runtime_01"],
    effectExecutor: { async execute() { return {} as never; } },
  });
  const command = chatSelection() as { input: { continuityId: string } };
  command.input.continuityId = "invalid continuity";
  await assert.rejects(coordinator.executeJson(JSON.stringify(command)), /invalid_continuity_authority_envelope/);
  assert.equal(calls, 0);
});

test("production coordinator source contains no legacy router or return-to-chat authority", async () => {
  const source = await readFile(resolve(process.cwd(), "src/continuity-authority-coordinator/continuity-authority-coordinator.ts"), "utf8");
  assert.doesNotMatch(source, /\bLEGACY\b/);
  assert.doesNotMatch(source, /GameReturnOrigin|return-to-chat/i);
});
