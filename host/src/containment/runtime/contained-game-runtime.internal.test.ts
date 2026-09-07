import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createContainedGameRuntime } from "./core/contained-game-runtime.js";
import type { RoleLaunchOperation, TypedPrivateGameAuthorizationProducer } from "./contract/game-runtime.js";
import type { DesktopGuardianSession, GuardianAck } from "../auth/desktop-guardian-session.internal.js";

const binding = Object.freeze({ guardianInstanceId: "g", guardianEpoch: 1, attemptId: "a", deadlineUnixMs: Date.now() + 60_000 });
const ack = (operation: string, role?: string): GuardianAck => ({ operation, status: "ok", bootstrapId: "b", generation: "v", inventoryDigest: "d", runtimeAdmissionSha256: "s", guardianInstanceId: "g", guardianEpoch: 1, attemptId: "a", ...(role === undefined ? {} : { role }) });

function fakeSession(log: string[], options: { failArm?: boolean; failLaunch?: boolean; failContain?: boolean } = {}): DesktopGuardianSession {
  return Object.freeze({
    arm: async (input) => {
      log.push(`arm:${input.privateFrame[0]}`);
      if (options.failArm) throw new Error("arm failed");
      return ack("arm");
    },
    launch: async (input) => {
      log.push(`launch:${input.role}`);
      if (options.failLaunch) throw new Error("launch failed");
      return ack("launch", input.role);
    },
    contain: async (input) => {
      log.push(`contain:${input.role}`);
      if (options.failContain) throw new Error("contain failed");
      return ack("contain", input.role);
    },
    close: async () => { log.push("close"); },
  });
}

const launchOperation: RoleLaunchOperation = Object.freeze({ deadlineUnixMs: Date.now() + 60_000 });
const produce: TypedPrivateGameAuthorizationProducer = (authorization) => authorization(new Uint8Array([1]));

test("valid producer works, arm is once before launch, and contain is ordered", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakeSession(log), binding);
  assert.deepEqual(await runtime.launchRole("server", launchOperation, produce), { role: "server", status: "succeeded" });
  assert.deepEqual(await runtime.launchRole("client", launchOperation, produce), { role: "client", status: "succeeded" });
  assert.deepEqual(await runtime.containRole("server"), { role: "server", status: "succeeded" });
  assert.deepEqual(log, ["arm:1", "launch:server", "launch:client", "contain:server"]);
});

test("authorization producer is called once and replay/forge/wrong role are rejected", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakeSession(log), binding);
  let calls = 0;
  await runtime.launchRole("role", launchOperation, (authorization) => { calls++; authorization(new Uint8Array()); });
  assert.equal(calls, 1);
  const replayRuntime = createContainedGameRuntime(fakeSession([]), binding);
  await assert.rejects(() => replayRuntime.launchRole("replay", launchOperation, (authorization) => {
    authorization(new Uint8Array());
    authorization(new Uint8Array());
  }), /replay/);
  await assert.rejects(() => runtime.launchRole("forged", launchOperation, (authorization) => (authorization as unknown as (x: unknown) => void)({}),), /forged/);
  await assert.rejects(() => runtime.containRole("never-launched"), /not launched/);
});

test("expired authorization and close prevent later launch; results are redacted", async () => {
  const log: string[] = [];
  const expired = createContainedGameRuntime(fakeSession(log), { ...binding, deadlineUnixMs: Date.now() - 1 });
  await assert.rejects(() => expired.launchRole("role", { deadlineUnixMs: Date.now() - 1 }, produce), /expired/);
  const runtime = createContainedGameRuntime(fakeSession(log), binding);
  await runtime.close();
  await assert.rejects(() => runtime.launchRole("role", launchOperation, produce), /closed/);
  assert.deepEqual(Object.keys(await createContainedGameRuntime(fakeSession([]), binding).launchRole("safe", launchOperation, produce)), ["role", "status"]);
});

test("authorization is invocation-bound and binding is snapshotted", async () => {
  const log: string[] = [];
  const mutable: { guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number } = {
    ...binding,
    deadlineUnixMs: Date.now() + 60_000,
  };
  let saved: ((facts: unknown) => void) | undefined;
  const runtime = createContainedGameRuntime(fakeSession(log), mutable);
  mutable.guardianEpoch = 99;
  await runtime.launchRole("first", launchOperation, (authorization) => { saved = authorization; authorization(new Uint8Array([7])); });
  await assert.rejects(() => runtime.launchRole("second", launchOperation, (authorization) => {
    void authorization;
    saved!(new Uint8Array([8]));
  }), /stale/);
  assert.deepEqual(log, ["arm:7", "launch:first"]);
});

test("failed launch is terminal and does not retry the native session call", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakeSession(log, { failLaunch: true }), binding);
  assert.deepEqual(await runtime.launchRole("role", launchOperation, produce), { role: "role", status: "failed" });
  await assert.rejects(() => runtime.launchRole("role", launchOperation, produce), /already launched/);
  assert.deepEqual(log, ["arm:1", "launch:role"]);
});

test("containment is terminal and duplicate contain rejects before native call", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakeSession(log), binding);
  await runtime.launchRole("role", launchOperation, produce);
  assert.deepEqual(await runtime.containRole("role"), { role: "role", status: "succeeded" });
  await assert.rejects(() => runtime.containRole("role"), /not launched/);
  assert.deepEqual(log, ["arm:1", "launch:role", "contain:role"]);
});

test("native containment failure is terminal and duplicate contain rejects before native call", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakeSession(log, { failContain: true }), binding);
  await runtime.launchRole("role", launchOperation, produce);
  assert.deepEqual(await runtime.containRole("role"), { role: "role", status: "failed" });
  await assert.rejects(() => runtime.containRole("role"), /not launched/);
  assert.deepEqual(log, ["arm:1", "launch:role", "contain:role"]);
});

test("runtime source creates authorization only inside launchRole and exports no mint factory", () => {
  const source = readFileSync(resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../src/containment/runtime/core/contained-game-runtime.ts",
  ), "utf8");
  const launchImplementationIndex = source.indexOf("launchRole(role, launchOperation, produceAuthorization) {");
  const authorizationIndex = source.indexOf("const authorization =");
  const containImplementationIndex = source.indexOf("containRole(role) {");
  assert.ok(
    launchImplementationIndex >= 0 &&
      launchImplementationIndex < authorizationIndex &&
      authorizationIndex < containImplementationIndex,
  );
  assert.doesNotMatch(source, /export\s+(?:(?:async)\s+)?(?:function|const|let|var)\s+\w*(?:mint|authoriz)/i);
});

test("serialized Promise.all operations never overlap native session calls", async () => {
  const log: string[] = [];
  let active = 0;
  let maxActive = 0;
  let releaseLaunch!: () => void;
  const launchReleased = new Promise<void>((resolve) => { releaseLaunch = resolve; });
  const session = Object.freeze({
    arm: async (input: Parameters<DesktopGuardianSession["arm"]>[0]) => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push(`arm:${input.privateFrame[0]}`);
      active--;
      return ack("arm");
    },
    launch: async (input: Parameters<DesktopGuardianSession["launch"]>[0]) => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push(`launch:${input.role}`);
      if (input.role === "first") await launchReleased;
      active--;
      return ack("launch", input.role);
    },
    contain: async (input: Parameters<DesktopGuardianSession["contain"]>[0]) => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push(`contain:${input.role}`);
      active--;
      return ack("contain", input.role);
    },
    close: async () => {},
  }) satisfies DesktopGuardianSession;
  const runtime = createContainedGameRuntime(session, binding);
  const first = runtime.launchRole("first", produce);
  const second = runtime.launchRole("second", produce);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ["arm:1", "launch:first"]);
  releaseLaunch();
  await Promise.all([first, second]);
  assert.deepEqual(log, ["arm:1", "launch:first", "launch:second"]);
  assert.equal(maxActive, 1);
});

test("arm failure is terminal and does not launch or retry", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakeSession(log, { failArm: true }), binding);
  await assert.rejects(() => runtime.launchRole("role", launchOperation, produce), /arm failed/);
  await assert.rejects(() => runtime.launchRole("role", launchOperation, produce), /arm already failed/);
  assert.deepEqual(log, ["arm:1"]);
});


test("requested role is bound into the platform launch input", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakeSession(log), binding);
  await runtime.launchRole("requested-role", launchOperation, produce);
  assert.deepEqual(log, ["arm:1", "launch:requested-role"]);
});
