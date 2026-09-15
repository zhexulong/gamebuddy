import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createContainedGameRuntime, type ContainedGameRuntimePlatform } from "./core/contained-game-runtime.js";
import type { RoleLaunchOperation, TypedPrivateGameAuthorizationProducer, TypedPrivateGameFacts } from "./contract/game-runtime.js";

const binding = Object.freeze({ guardianInstanceId: "g", guardianEpoch: 1, attemptId: "a", operationWaitBudgetMs: 1_000 });
const launchOperation = (deadlineUnixMs = Date.now() + 60_000): RoleLaunchOperation => Object.freeze({ deadlineUnixMs });
const facts: TypedPrivateGameFacts = Object.freeze({ role: "player", revision: 1 });
const produce: TypedPrivateGameAuthorizationProducer = (authorization) => authorization(facts);

type PlatformOptions = { readonly failArm?: boolean; readonly failLaunch?: boolean; readonly failContain?: boolean };

function fakePlatform(log: string[], options: PlatformOptions = {}): ContainedGameRuntimePlatform {
  return Object.freeze({
    arm: async (input) => {
      log.push(`arm:${input.authorization.role}`);
      if (options.failArm) throw new Error("arm failed");
    },
    launch: async (input) => {
      log.push(`launch:${input.role}`);
      if (options.failLaunch) throw new Error("launch failed");
    },
    contain: async (input) => {
      log.push(`contain:${input.role}`);
      if (options.failContain) throw new Error("contain failed");
    },
    close: async () => { log.push("close"); },
  });
}

test("operation wait budgets are independent from launch deadline and are sent on arm/contain only", async () => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const platform: ContainedGameRuntimePlatform = Object.freeze({
    arm: async (input) => { calls.push({ operation: "arm", input: { ...input } }); },
    launch: async (input) => { calls.push({ operation: "launch", input: { ...input } }); },
    contain: async (input) => { calls.push({ operation: "contain", input: { ...input } }); },
    close: async () => {},
  });
  const deadlineUnixMs = Date.now() + 60_000;
  const runtime = createContainedGameRuntime(platform, { ...binding, operationWaitBudgetMs: 17 });
  await runtime.launchRole("role", { deadlineUnixMs }, produce);
  await runtime.containRole("role");
  assert.equal(calls[0]?.input.operationWaitBudgetMs, 17);
  assert.equal(calls[1]?.input.deadlineUnixMs, deadlineUnixMs);
  assert.equal(Object.hasOwn(calls[1]?.input ?? {}, "operationWaitBudgetMs"), false);
  assert.equal(calls[2]?.input.operationWaitBudgetMs, 17);
  assert.equal(Object.hasOwn(calls[2]?.input ?? {}, "deadlineUnixMs"), false);
});

test("valid producer works, arm is once before launch, and contain is ordered", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  assert.deepEqual(await runtime.launchRole("server", launchOperation(), produce), { role: "server", status: "succeeded" });
  assert.deepEqual(await runtime.launchRole("client", launchOperation(), produce), { role: "client", status: "succeeded" });
  assert.deepEqual(await runtime.containRole("server"), { role: "server", status: "succeeded" });
  assert.deepEqual(log, ["arm:player", "launch:server", "launch:client", "contain:server"]);
});

test("authorization producer is called once and replay/forge/wrong role are rejected", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  let calls = 0;
  await runtime.launchRole("role", launchOperation(), (authorization) => { calls++; authorization(facts); });
  assert.equal(calls, 1);
  const replayRuntime = createContainedGameRuntime(fakePlatform([]), binding);
  await assert.rejects(() => replayRuntime.launchRole("replay", launchOperation(), (authorization) => {
    authorization(facts);
    authorization(facts);
  }), /replay/);
  await assert.rejects(() => runtime.launchRole("forged", launchOperation(), (authorization) => authorization(undefined as never)), /forged/);
  await assert.rejects(() => runtime.containRole("never-launched"), /not launched/);
});

test("expired authorization and close prevent later launch; results are redacted", async () => {
  const log: string[] = [];
  const expired = createContainedGameRuntime(fakePlatform(log), binding);
  await assert.rejects(() => expired.launchRole("role", launchOperation(Date.now() - 1), produce), /expired/);
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  await runtime.close();
  await assert.rejects(() => runtime.launchRole("role", launchOperation(), produce), /closed/);
  assert.deepEqual(Object.keys(await createContainedGameRuntime(fakePlatform([]), binding).launchRole("safe", launchOperation(), produce)), ["role", "status"]);
});

test("authorization is invocation-bound and binding is snapshotted", async () => {
  const log: string[] = [];
  const mutable: { guardianInstanceId: string; guardianEpoch: number; attemptId: string; operationWaitBudgetMs: number } = { ...binding };
  let saved: ((facts: TypedPrivateGameFacts) => void) | undefined;
  const runtime = createContainedGameRuntime(fakePlatform(log), mutable);
  mutable.guardianEpoch = 99;
  await runtime.launchRole("first", launchOperation(), (authorization) => { saved = authorization; authorization(facts); });
  await assert.rejects(() => runtime.launchRole("second", launchOperation(), (authorization) => {
    void authorization;
    saved!(facts);
  }), /stale/);
  assert.deepEqual(log, ["arm:player", "launch:first"]);
});

test("failed launch is terminal and does not retry the native session call", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log, { failLaunch: true }), binding);
  assert.deepEqual(await runtime.launchRole("role", launchOperation(), produce), { role: "role", status: "failed" });
  await assert.rejects(() => runtime.launchRole("role", launchOperation(), produce), /already launched/);
  assert.deepEqual(log, ["arm:player", "launch:role"]);
});

test("containment is terminal and duplicate contain rejects before native call", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  await runtime.launchRole("role", launchOperation(), produce);
  assert.deepEqual(await runtime.containRole("role"), { role: "role", status: "succeeded" });
  await assert.rejects(() => runtime.containRole("role"), /not launched/);
  assert.deepEqual(log, ["arm:player", "launch:role", "contain:role"]);
});

test("native containment failure is terminal and duplicate contain rejects before native call", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log, { failContain: true }), binding);
  await runtime.launchRole("role", launchOperation(), produce);
  assert.deepEqual(await runtime.containRole("role"), { role: "role", status: "failed" });
  await assert.rejects(() => runtime.containRole("role"), /not launched/);
  assert.deepEqual(log, ["arm:player", "launch:role", "contain:role"]);
});

test("runtime source keeps native frame construction out of the generic core", () => {
  const source = readFileSync(resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../src/containment/runtime/core/contained-game-runtime.ts",
  ), "utf8");
  assert.match(source, /launchRole\(role, launchOperation: RoleLaunchOperation, produceAuthorization: TypedPrivateGameAuthorizationProducer\)/);
  assert.match(source, /const authorization: InternalAuthorization/);
  assert.match(source, /containRole\(role\)/);
  assert.doesNotMatch(source, /encodePrivateFacts|Uint8Array|privateFrame/);
  assert.doesNotMatch(source, /export\s+(?:(?:async)\s+)?(?:function|const|let|var)\s+\w*(?:mint|authoriz)/i);
});

test("serialized Promise.all operations never overlap platform calls", async () => {
  const log: string[] = [];
  let active = 0;
  let maxActive = 0;
  let releaseLaunch!: () => void;
  const launchReleased = new Promise<void>((resolve) => { releaseLaunch = resolve; });
  const platform: ContainedGameRuntimePlatform = Object.freeze({
    arm: async (input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push(`arm:${input.authorization.role}`);
      active--;
    },
    launch: async (input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push(`launch:${input.role}`);
      if (input.role === "first") await launchReleased;
      active--;
    },
    contain: async (input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push(`contain:${input.role}`);
      active--;
    },
    close: async () => {},
  });
  const runtime = createContainedGameRuntime(platform, binding);
  const first = runtime.launchRole("first", launchOperation(), produce);
  const second = runtime.launchRole("second", launchOperation(), produce);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ["arm:player", "launch:first"]);
  releaseLaunch();
  await Promise.all([first, second]);
  assert.deepEqual(log, ["arm:player", "launch:first", "launch:second"]);
  assert.equal(maxActive, 1);
});

test("arm failure is terminal and does not launch or retry", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log, { failArm: true }), binding);
  await assert.rejects(() => runtime.launchRole("role", launchOperation(), produce), /arm failed/);
  await assert.rejects(() => runtime.launchRole("role", launchOperation(), produce), /arm already failed/);
  assert.deepEqual(log, ["arm:player"]);
});

test("requested role is bound into the platform launch input", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  await runtime.launchRole("requested-role", launchOperation(), produce);
  assert.deepEqual(log, ["arm:player", "launch:requested-role"]);
});
