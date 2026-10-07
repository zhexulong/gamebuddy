import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createContainedGameRuntime, type ContainedGameRuntimePlatform } from "./core/contained-game-runtime.js";
import type { RoleLaunchOperation, TypedPrivateGameAuthorizationProducer, TypedPrivateGameFacts } from "./contract/game-runtime.js";

const armFacts: TypedPrivateGameFacts = Object.freeze({ revision: "r" });
const binding = Object.freeze({ guardianInstanceId: "g", guardianEpoch: 1, attemptId: "a", operationWaitBudgetMs: 1_000, armFacts });
const launchOperation = (deadlineUnixMs = Date.now() + 60_000): RoleLaunchOperation => Object.freeze({ deadlineUnixMs });
const facts: TypedPrivateGameFacts = Object.freeze({ role: "player", revision: 1 });
const produce: TypedPrivateGameAuthorizationProducer = (authorization) => authorization(facts);

type PlatformOptions = { readonly failArm?: boolean; readonly failLaunch?: boolean; readonly failContain?: boolean; readonly failSettle?: boolean; readonly onArm?: () => void };

function fakePlatform(log: string[], options: PlatformOptions = {}): ContainedGameRuntimePlatform {
  return Object.freeze({
    arm: async (input) => {
      log.push(`arm:${input.authorization.role}`);
      options.onArm?.();
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
    // The generic runtime never drives a recovery: the composition-owned
    // recovery drive reaches the transport directly. The fake still has to
    // carry the port member, so it reports the only successful outcome.
    recover: async () => Object.freeze({ outcome: "contained" as const }),
    settle: async () => {
      log.push("settle");
      if (options.failSettle) throw new Error("settle failed");
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
    recover: async () => Object.freeze({ outcome: "contained" as const }),
    settle: async () => { calls.push({ operation: "settle", input: {} }); },
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
  const mutable: { guardianInstanceId: string; guardianEpoch: number; attemptId: string; operationWaitBudgetMs: number; armFacts: TypedPrivateGameFacts } = { ...binding };
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
    recover: async () => Object.freeze({ outcome: "contained" as const }),
    settle: async () => { log.push("settle"); },
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
test("settlement is refused before any launch, so an ordinary close can never reach it", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  await assert.rejects(() => runtime.settle(), /runtime was never armed/);
  assert.deepEqual(log, []);
});

test("settlement is refused while a launched role is still uncontained", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  await runtime.launchRole("player", launchOperation(), produce);
  await assert.rejects(() => runtime.settle(), /not every launched role is contained/);
  await runtime.containRole("player");
  // Now the one launched role is contained, so settlement is legal.
  assert.deepEqual(await runtime.settle(), { status: "settled" });
  assert.deepEqual(log, ["arm:player", "launch:player", "contain:player", "settle"]);
});

test("settlement requires every launched role to be contained", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  await runtime.launchRole("player", launchOperation(), produce);
  await runtime.launchRole("ai", launchOperation(), produce);
  await runtime.containRole("ai");
  await assert.rejects(() => runtime.settle(), /not every launched role is contained/);
  await runtime.containRole("player");
  assert.deepEqual(await runtime.settle(), { status: "settled" });
});

test("a failed platform settlement reports unavailable and never fabricates settled", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log, { failSettle: true }), binding);
  await runtime.launchRole("player", launchOperation(), produce);
  await runtime.containRole("player");
  assert.deepEqual(await runtime.settle(), { status: "unavailable" });
});

test("a failed launch fails settlement closed, because recovery owns that case", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log, { failLaunch: true }), binding);
  await runtime.launchRole("player", launchOperation(), produce);
  // A failed launch may still have created a suspended process inside the
  // attempt's Job, so it can never be settled as if nothing happened: it must go
  // through recovery/quarantine instead. Settlement stays fail-closed here.
  await assert.rejects(() => runtime.settle(), /not every launched role is contained/);
  assert.deepEqual(log, ["arm:player", "launch:player"]);
});

test("settlement is refused once the runtime is closed", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  await runtime.launchRole("player", launchOperation(), produce);
  await runtime.containRole("player");
  await runtime.close();
  await assert.rejects(() => runtime.settle(), /runtime is closed/);
});

// Regression: an armed attempt that recorded NO launched role must not settle.
//
// `launchRole` can fail AFTER `platform.arm` succeeded but BEFORE it records the
// role, because the post-arm expiry/close check runs in between. The guard is a
// loop over `roleStates`, so with an empty map it would pass vacuously and the
// platform would mint a containment proof and release the registration pointer for
// a launch that never happened. That attempt is still retryable by the coordinator
// (pre-claim, restored to `staged`), so the two halves must not both be true.
//
// "An unlaunched role still owns an empty Job" is a Stardew-native fact owned by
// the composer, so the generic layer deliberately refuses rather than judging it.
//
// The expiry is made deterministic by advancing a fake clock inside `arm` rather
// than by racing a real deadline, which would depend on how long arm happens to take.
test("an armed attempt that recorded no launched role is not settled", async () => {
  const log: string[] = [];
  const deadlineUnixMs = Date.now() + 60_000;
  const realNow = Date.now;
  const platform = fakePlatform(log, {
    // Arm succeeds, then time jumps past the launch deadline before the runtime's
    // post-arm expiry check runs, so no role is ever recorded.
    onArm: () => { Date.now = () => deadlineUnixMs; },
  });
  try {
    const runtime = createContainedGameRuntime(platform, binding);
    await assert.rejects(() => runtime.launchRole("player", { deadlineUnixMs }, produce), /operation expired/);
    assert.deepEqual(log, ["arm:player"]);
    await assert.rejects(() => runtime.settle(), /no role ever reached launch/);
    assert.deepEqual(log, ["arm:player"], "a refused settlement never reaches the platform");
  } finally {
    Date.now = realNow;
  }
});

// Settlement is terminal, so a second call must not reach the platform again and
// must not report `settled`. The platform's proof reservation would fail closed
// anyway, but the generic contract should not depend on that for its guarantee.
test("settlement is terminal and a second call never reaches the platform", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  await runtime.launchRole("player", launchOperation(), produce);
  await runtime.containRole("player");
  assert.deepEqual(await runtime.settle(), { status: "settled" });
  await assert.rejects(() => runtime.settle(), /runtime was already settled/);
  assert.deepEqual(log, ["arm:player", "launch:player", "contain:player", "settle"]);
});

// A settlement that failed is equally terminal: recovery owns the attempt, so the
// runtime must not let a caller retry its way to a second platform settlement.
test("a failed settlement also latches, so it cannot be retried into a second call", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log, { failSettle: true }), binding);
  await runtime.launchRole("player", launchOperation(), produce);
  await runtime.containRole("player");
  assert.deepEqual(await runtime.settle(), { status: "unavailable" });
  await assert.rejects(() => runtime.settle(), /runtime was already settled/);
  assert.deepEqual(log, ["arm:player", "launch:player", "contain:player", "settle"]);
});

// A failed close must stay retryable. The earlier `if (closed) return
// operation.then(() => undefined)` returned a RESOLVED promise after a rejected
// close, so the coordinator's retry reported success while the platform session
// may still have been open. `closed` still latches immediately so no further
// arm/launch/contain/settle is legal, but the close itself is re-driven.
test("a failed runtime close is re-driven on the next call instead of faking success", async () => {
  const log: string[] = [];
  let failNext = true;
  const platform: ContainedGameRuntimePlatform = Object.freeze({
    arm: async () => {},
    launch: async () => {},
    contain: async () => {},
    recover: async () => Object.freeze({ outcome: "contained" as const }),
    settle: async () => {},
    close: async () => {
      log.push("close");
      if (failNext) throw new Error("controlled_close_failure");
    },
  });
  const runtime = createContainedGameRuntime(platform, binding);
  await assert.rejects(() => runtime.close(), /controlled_close_failure/);
  // Closing still forbids a later settlement, even though the close failed.
  await assert.rejects(() => runtime.settle(), /runtime is closed/);

  failNext = false;
  await runtime.close();
  assert.deepEqual(log, ["close", "close"], "the retry re-drove the platform close");
});

// Closing forbids settlement. This is the property the endgame relies on to be the
// only route to a terminal attempt.
test("closing forbids a later settlement", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  await runtime.launchRole("player", launchOperation(), produce);
  await runtime.containRole("player");
  await runtime.close();
  await assert.rejects(() => runtime.settle(), /runtime is closed/);
  assert.deepEqual(log, ["arm:player", "launch:player", "contain:player", "close"]);
});

// A settled attempt is terminal, so it must not accept another role. The latch is
// one-way, so a role launched after it would never be settled at all.
test("a settled attempt rejects a further role launch", async () => {
  const log: string[] = [];
  const runtime = createContainedGameRuntime(fakePlatform(log), binding);
  await runtime.launchRole("player", launchOperation(), produce);
  await runtime.containRole("player");
  await runtime.settle();
  await assert.rejects(() => runtime.launchRole("ai", launchOperation(), produce), /runtime was already settled/);
  assert.deepEqual(log, ["arm:player", "launch:player", "contain:player", "settle"]);
});
