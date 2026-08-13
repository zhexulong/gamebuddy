import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "gamebuddy-fixture-readiness-"));
const token = "fixture-readiness-token-123456";
const scenario = "native_use_item_v1";
const saveName = "GameBuddyFixture_Test_1_6_15";
const hostConfigPath = join(root, "host.json");
const helper = join(process.cwd(), "tools", "await-stardew-fixture-readiness.mjs");

try {
  await writeFile(
    hostConfigPath,
    JSON.stringify({
      HostAutomation: { Enable: true, FixtureScenario: scenario, SaveName: saveName },
      HostFarmhandProvisioning: { SessionToken: token },
    }),
  );
  const ready = signed({
    schemaVersion: 1,
    integrationId: "stardew",
    fixtureScenario: scenario,
    saveName,
    state: "fixture_ready",
    reasonCode: "native_preconditions_ready",
    publishedAtUnixMs: Date.now(),
    sessionNonce: "nonce_01",
    signature: "",
  });
  await writeFile(join(root, "stardew-fixture-readiness.json"), JSON.stringify(ready));
  const success = await run([
    "--session-directory",
    root,
    "--host-config",
    hostConfigPath,
    "--timeout-ms",
    "1000",
    "--not-before-unix-ms",
    "0",
  ]);
  assert.equal(success.code, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).state, "fixture_ready");

  const blocked = signed({
    ...ready,
    state: "fixture_blocked",
    reasonCode: "fixture_native_ready_grab_crop_missing",
    signature: "",
  });
  await writeFile(join(root, "stardew-fixture-readiness.json"), JSON.stringify(blocked));
  const blockedResult = await run([
    "--session-directory",
    root,
    "--host-config",
    hostConfigPath,
    "--timeout-ms",
    "1000",
    "--not-before-unix-ms",
    "0",
  ]);
  assert.notEqual(blockedResult.code, 0);
  assert.match(blockedResult.stderr, /fixture_preflight_blocked_fixture_native_ready_grab_crop_missing/);

  await writeFile(
    join(root, "stardew-fixture-readiness.json"),
    JSON.stringify({ ...ready, reasonCode: "tampered", signature: ready.signature }),
  );
  const tampered = await run([
    "--session-directory",
    root,
    "--host-config",
    hostConfigPath,
    "--timeout-ms",
    "200",
    "--not-before-unix-ms",
    "0",
  ]);
  assert.notEqual(tampered.code, 0);
  assert.match(tampered.stderr, /fixture_readiness_authentication_failed/);

  // A signed report from a prior Host launch must not satisfy this launch, but
  // it is also not terminal: the helper waits for this Host to replace it.
  const stale = signed({ ...ready, publishedAtUnixMs: 1, signature: "" });
  await writeFile(join(root, "stardew-fixture-readiness.json"), JSON.stringify(stale));
  const staleResult = await run([
    "--session-directory",
    root,
    "--host-config",
    hostConfigPath,
    "--timeout-ms",
    "200",
    "--not-before-unix-ms",
    "2",
  ]);
  assert.notEqual(staleResult.code, 0);
  assert.match(staleResult.stderr, /fixture_readiness_stale/);

  const replacementReady = signed({ ...ready, publishedAtUnixMs: Date.now() + 5, signature: "" });
  const waiting = run([
    "--session-directory",
    root,
    "--host-config",
    hostConfigPath,
    "--timeout-ms",
    "1000",
    "--not-before-unix-ms",
    "2",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(join(root, "stardew-fixture-readiness.json"), JSON.stringify(replacementReady));
  const waitingResult = await waiting;
  assert.equal(waitingResult.code, 0, waitingResult.stderr);
  assert.equal(JSON.parse(waitingResult.stdout).publishedAtUnixMs, replacementReady.publishedAtUnixMs);

  const future = signed({ ...ready, publishedAtUnixMs: Date.now() + 31_000, signature: "" });
  await writeFile(join(root, "stardew-fixture-readiness.json"), JSON.stringify(future));
  const futureResult = await run([
    "--session-directory",
    root,
    "--host-config",
    hostConfigPath,
    "--timeout-ms",
    "200",
    "--not-before-unix-ms",
    "0",
  ]);
  assert.notEqual(futureResult.code, 0);
  assert.match(futureResult.stderr, /fixture_readiness_clock_invalid/);
  console.log("stardew_fixture_readiness_test_passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

function signed(value) {
  const { signature, ...unsigned } = value;
  return {
    ...value,
    signature: createHmac("sha256", token).update(JSON.stringify(unsigned), "utf8").digest("base64url"),
  };
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
