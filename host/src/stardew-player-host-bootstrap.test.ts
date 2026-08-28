import assert from "node:assert/strict";
import test from "node:test";

import type {
  StardewAiClientProcessSpawn,
} from "./stardew-ai-client-process-owner.js";
import type {
  StardewPlayerHostBootstrapClaim,
} from "./stardew-player-host-bootstrap.js";
import { createStardewPrivateBootstrapComposerTestSupport } from "./stardew-private-bootstrap-composer.test-support.js";

type AssertFalse<T extends false> = T;
type ClaimCannotBeStructurallyMinted = AssertFalse<
  {} extends StardewPlayerHostBootstrapClaim ? true : false
>;
void (0 as unknown as ClaimCannotBeStructurallyMinted);

const neverSpawn: StardewAiClientProcessSpawn = () => {
  throw new Error("unexpected_spawn");
};

function createHarness(initialNowMs = 1_000) {
  let nowMs = initialNowMs;
  let nextBootstrapIdentity = 0;
  const composition = createStardewPrivateBootstrapComposerTestSupport({
    rawSpawn: neverSpawn,
    rawProbe: () => null,
    rawPlayerHostSpawn: neverSpawn,
    rawPlayerHostProbe: () => null,
    createBootstrapIdentity: () => `bootstrap-${++nextBootstrapIdentity}`,
    createLaunchGeneration: () => "generation-1",
    createPlayerHostLaunchGeneration: () => "player-generation-1",
    nowMs: () => nowMs,
  });
  return {
    composition,
    broker: composition.broker,
    setNow(value: number) {
      nowMs = value;
    },
  };
}

function request(expiresAtMs = 5_000) {
  return {
    playerId: "player-1",
    companionId: "companion-1",
    browserSessionId: "browser-1",
    expiresAtMs,
  } as const;
}

test("broker exposes only confirm and close and never exposes registration authority", () => {
  const { broker } = createHarness();

  assert.deepEqual(Object.keys(broker).sort(), ["close", "confirm"]);
  assert.equal(Object.isFrozen(broker), true);
  assert.equal("register" in broker, false);
  assert.equal("registrar" in broker, false);
  assert.equal("persist" in broker, false);
});

test("confirmed capability is frozen, redacted, and consumes to a frozen empty nominal claim", () => {
  const { broker } = createHarness();
  const capability = broker.confirm(request());

  assert.deepEqual(Object.keys(capability).sort(), ["consume", "readView", "revoke"]);
  assert.equal(Object.isFrozen(capability), true);
  assert.deepEqual(capability.readView(), { schemaVersion: 1, state: "pending" });

  const claim = capability.consume("browser-1");
  assert.equal(Object.isFrozen(claim), true);
  assert.deepEqual(Object.keys(claim), []);
  assert.deepEqual(Reflect.ownKeys(claim), []);
  assert.deepEqual(capability.readView(), { schemaVersion: 1, state: "consumed" });
  assert.throws(() => capability.consume("browser-1"), /stardew_bootstrap_not_pending/);
});

test("session mismatch does not consume a pending bootstrap", () => {
  const { broker } = createHarness();
  const capability = broker.confirm(request());

  assert.throws(() => capability.consume("other-browser"), /stardew_bootstrap_session_mismatch/);
  assert.deepEqual(capability.readView(), { schemaVersion: 1, state: "pending" });
  const claim = capability.consume("browser-1");
  assert.deepEqual(Reflect.ownKeys(claim), []);
});

test("only one unexpired pending bootstrap exists and revoke permits a replacement", () => {
  const { broker } = createHarness();
  const first = broker.confirm(request());

  assert.throws(() => broker.confirm({ ...request(), browserSessionId: "browser-2" }), /stardew_bootstrap_already_active/);
  first.revoke();
  assert.deepEqual(first.readView(), { schemaVersion: 1, state: "revoked" });

  const second = broker.confirm({ ...request(), browserSessionId: "browser-2" });
  assert.deepEqual(second.readView(), { schemaVersion: 1, state: "pending" });
});

test("absolute expiry is projected and prevents claim minting", () => {
  const harness = createHarness();
  const capability = harness.broker.confirm(request(1_500));

  harness.setNow(1_500);
  assert.deepEqual(capability.readView(), { schemaVersion: 1, state: "expired" });
  assert.throws(() => capability.consume("browser-1"), /stardew_bootstrap_expired/);
});

test("close synchronously revokes a pending bootstrap and permanently closes the broker", () => {
  const { broker } = createHarness();
  const capability = broker.confirm(request());

  broker.close();
  assert.deepEqual(capability.readView(), { schemaVersion: 1, state: "revoked" });
  assert.throws(() => capability.consume("browser-1"), /stardew_bootstrap_not_pending/);
  assert.throws(() => broker.confirm(request()), /stardew_bootstrap_broker_closed/);
  assert.doesNotThrow(() => broker.close());
});

test("confirm accepts only an exact plain bounded request", () => {
  const invalidRequests: unknown[] = [
    null,
    {},
    { ...request(), extra: true },
    { ...request(), playerId: "" },
    { ...request(), companionId: "companion space" },
    { ...request(), browserSessionId: "browser/1" },
    { ...request(), expiresAtMs: 1_000 },
    { ...request(), expiresAtMs: 1_000 + 10 * 60_000 + 1 },
    Object.assign(Object.create(null), request()),
  ];

  for (const invalid of invalidRequests) {
    const { broker } = createHarness();
    assert.throws(
      () => broker.confirm(invalid as Parameters<typeof broker.confirm>[0]),
      /invalid_stardew_bootstrap_request/,
    );
  }
});
