/**
 * The launcher-side role broker's wire, and one real arm/launch/contain through it.
 *
 * Two populations, for two different reasons:
 *
 *   - the FRAME TABLES, because the Desktop compares command keys in ordinal order
 *     (`SequenceEqual`) and the Host compares its acknowledgements the same way, so a table written
 *     out by hand in the wrong order is a session that dies with no message. Every ack this module
 *     composes is asserted against the Host's own expected list here, not against a copy of itself.
 *   - the RELAY, because the whole point of the module is that a real Guardian does the real work.
 *     The integration case starts the generation's own Guardian, arms a real named Job and lease,
 *     launches the guardian's own role fixture suspended-then-resumed inside that Job, reads the
 *     fixture's `member=true` back, and contains the role. It is skipped, never faked, where the
 *     fixture is not built.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  admitGuardianImage,
  composeGuardianAck,
  composeGuardianHelloAck,
  composeGuardianRoleExit,
  createGuardianRoleBroker,
  guardianImagePaths,
  guardianPipeEndpoint,
  GUARDIAN_PIPE_PREFIX,
  validateGuardianCommandFrame,
  validateGuardianHelloRequest,
} from "./guardian-role-broker.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARDIAN_IMAGE = join(
  REPO_ROOT,
  "host",
  "native",
  "windows-bootstrap-guardian",
  ".dist",
  "win-x64",
  "GameBuddy.WindowsBootstrapGuardian.exe",
);
const ROLE_FIXTURE = join(REPO_ROOT, "host", "native", "windows-bootstrap-guardian", ".dist", "fixtures", "RoleRootFixture.exe");

const binding = Object.freeze({
  bootstrapId: "b".repeat(64),
  generation: "g-role-broker-test",
  inventoryDigest: "c".repeat(64),
  runtimeAdmissionSha256: "d".repeat(64),
});
// What a launcher holds: the endpoint id is its own, and the three generation facts come from the
// production pointer. `createGuardianRoleBroker` composes the two into the one binding it serves.
const generationFacts = Object.freeze({
  generation: binding.generation,
  inventoryDigest: binding.inventoryDigest,
  runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
});
const instanceId = "3f1c6d38-6d0b-4c17-9c5e-8f2b0d7a1e44";
const attemptId = "8a7e2f10-1c93-4f6b-a2d5-6e0c9b4a7d31";

const boundFrame = (value, omit) => {
  const copy = { ...value };
  delete copy[omit];
  return copy;
};

const armFrame = (overrides = {}) => ({
  schema: "gamebuddy-desktop-guardian-session/v1",
  protocolVersion: 1,
  operation: "arm_attempt",
  bootstrapId: binding.bootstrapId,
  generation: binding.generation,
  inventoryDigest: binding.inventoryDigest,
  runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
  operationWaitBudgetMs: 30_000,
  guardianInstanceId: instanceId,
  guardianEpoch: 1,
  attemptId,
  privateFrame: Buffer.from('{"placeholder":true}').toString("base64url"),
  ...overrides,
});

const launchFrame = (overrides = {}) => ({
  schema: "gamebuddy-desktop-guardian-session/v1",
  protocolVersion: 1,
  operation: "launch_role",
  bootstrapId: binding.bootstrapId,
  generation: binding.generation,
  inventoryDigest: binding.inventoryDigest,
  runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
  deadlineUnixMs: Date.now() + 60_000,
  guardianInstanceId: instanceId,
  guardianEpoch: 1,
  attemptId,
  role: "player_host",
  privateFrame: Buffer.from('{"placeholder":true}').toString("base64url"),
  ...overrides,
});

const containFrame = (overrides = {}) => ({
  schema: "gamebuddy-desktop-guardian-session/v1",
  protocolVersion: 1,
  operation: "contain_role",
  bootstrapId: binding.bootstrapId,
  generation: binding.generation,
  inventoryDigest: binding.inventoryDigest,
  runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
  operationWaitBudgetMs: 30_000,
  guardianInstanceId: instanceId,
  guardianEpoch: 1,
  attemptId,
  role: "player_host",
  ...overrides,
});

test("the endpoint is the one spelling the Host dials, and nothing else is accepted", () => {
  assert.equal(GUARDIAN_PIPE_PREFIX, "GameBuddy.HostGuardian.");
  assert.equal(
    guardianPipeEndpoint("a".repeat(64)),
    `\\\\.\\pipe\\GameBuddy.HostGuardian.${"a".repeat(64)}`,
  );
  for (const bad of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64), `${"a".repeat(64)}\n`])
    assert.throws(() => guardianPipeEndpoint(bad), /role_broker_bootstrap_id_invalid/u);
});

test("a hello binds every fact of the launch, and a different one is refused", () => {
  const hello = Object.freeze({
    schema: "gamebuddy-desktop-guardian-session/v1",
    protocolVersion: 1,
    operation: "hello",
    bootstrapId: binding.bootstrapId,
    generation: binding.generation,
    inventoryDigest: binding.inventoryDigest,
    runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
  });
  assert.equal(validateGuardianHelloRequest(hello, binding), true);
  for (const key of ["bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256"])
    assert.equal(validateGuardianHelloRequest({ ...hello, [key]: "e".repeat(64) }, binding), false, key);
  assert.equal(validateGuardianHelloRequest({ ...hello, operation: "arm_attempt" }, binding), false);
  assert.equal(validateGuardianHelloRequest({ ...hello, extra: true }, binding), false);
});

test("command frames are read in the ORDINAL order the Desktop compares them by", () => {
  assert.equal(validateGuardianCommandFrame(armFrame(), binding).operation, "arm_attempt");
  assert.equal(validateGuardianCommandFrame(launchFrame(), binding).operation, "launch_role");
  assert.equal(validateGuardianCommandFrame(containFrame(), binding).operation, "contain_role");

  // The same keys, one position apart: the Desktop's `SequenceEqual` refuses this and so must the
  // broker, or the two peers would disagree about a frame both had in hand.
  const entries = Object.entries(armFrame());
  const swapped = {};
  for (let index = 0; index < entries.length; index += 1) {
    if (index === 6) {
      swapped[entries[7][0]] = entries[7][1];
      swapped[entries[6][0]] = entries[6][1];
      index += 1;
      continue;
    }
    swapped[entries[index][0]] = entries[index][1];
  }
  assert.deepEqual(Object.keys(swapped).sort(), Object.keys(armFrame()).sort(), "the swap keeps the key set");
  assert.notDeepEqual(Object.keys(swapped), Object.keys(armFrame()));
  assert.equal(validateGuardianCommandFrame(swapped, binding), undefined);

  assert.equal(validateGuardianCommandFrame(boundFrame(armFrame(), "privateFrame"), binding), undefined);
  assert.equal(validateGuardianCommandFrame(armFrame({ generation: "g-other" }), binding), undefined);
  assert.equal(validateGuardianCommandFrame(boundFrame(launchFrame(), "deadlineUnixMs"), binding), undefined);
  assert.equal(validateGuardianCommandFrame(launchFrame({ role: "ai" }), binding), undefined);
  assert.equal(
    validateGuardianCommandFrame(containFrame({ privateFrame: Buffer.from("{}").toString("base64url") }), binding),
    undefined,
    "contain_role carries no private frame",
  );
  assert.equal(
    validateGuardianCommandFrame(armFrame({ operationWaitBudgetMs: 300_001 }), binding),
    undefined,
    "a bounded operation wait is bounded",
  );
});

test("every acknowledgement is written in the key order the Host reads", () => {
  const arm = validateGuardianCommandFrame(armFrame(), binding);
  const launch = validateGuardianCommandFrame(launchFrame(), binding);
  const contain = validateGuardianCommandFrame(containFrame(), binding);
  const withoutRole = [
    "schema",
    "protocolVersion",
    "operation",
    "status",
    "bootstrapId",
    "generation",
    "inventoryDigest",
    "runtimeAdmissionSha256",
    "guardianInstanceId",
    "guardianEpoch",
    "attemptId",
  ];
  const withRole = [...withoutRole, "role"];
  assert.deepEqual(
    Object.keys(composeGuardianAck({ operation: "arm_attempt", status: "armed", binding, command: arm })),
    withoutRole,
  );
  assert.deepEqual(
    Object.keys(composeGuardianAck({ operation: "launch_role", status: "role_active", binding, command: launch })),
    withRole,
  );
  assert.deepEqual(
    Object.keys(composeGuardianAck({ operation: "contain_role", status: "role_contained", binding, command: contain })),
    withRole,
  );
  assert.deepEqual(Object.keys(composeGuardianHelloAck(binding)), [
    "schema",
    "protocolVersion",
    "operation",
    "status",
    "bootstrapId",
    "generation",
    "inventoryDigest",
    "runtimeAdmissionSha256",
  ]);
  assert.deepEqual(
    Object.keys(composeGuardianRoleExit({ binding, correlation: { guardianInstanceId: instanceId, guardianEpoch: 1, attemptId }, role: "player_host", exitCode: 0 })),
    [
      "schema",
      "protocolVersion",
      "operation",
      "bootstrapId",
      "generation",
      "inventoryDigest",
      "runtimeAdmissionSha256",
      "guardianInstanceId",
      "guardianEpoch",
      "attemptId",
      "role",
      "exitCode",
    ],
  );
});

test("the guardian image is admitted by the digest its generation published, never by presence", async () => {
  const root = await mkdtemp(join(tmpdir(), "role-broker-image-"));
  try {
    const paths = guardianImagePaths(root);
    assert.equal(paths.image, join(root, "native", "windows-bootstrap-guardian", "win-x64", "GameBuddy.WindowsBootstrapGuardian.exe"));
    assert.equal(await admitGuardianImage({ generationRoot: root }), null, "a generation with no publication is hello-only, not an error");

    await mkdir(paths.directory, { recursive: true });
    const bytes = Buffer.from("not really a guardian", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(paths.image, bytes);
    await writeFile(
      paths.manifest,
      `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsBootstrapGuardian.exe","sha256":"${sha256}"}\n`,
    );
    assert.deepEqual(await admitGuardianImage({ generationRoot: root }), { path: paths.image, sha256 });

    await writeFile(paths.image, Buffer.concat([bytes, Buffer.from("x")]));
    await assert.rejects(() => admitGuardianImage({ generationRoot: root }), /role_broker_guardian_image_mismatch/u);

    await writeFile(paths.manifest, '{"schemaVersion":2}\n');
    await assert.rejects(() => admitGuardianImage({ generationRoot: root }), /role_broker_guardian_manifest_invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A Host enough to speak this wire: one connection, one line at a time, nothing else.
 *
 * `next` polls the frames this session has received instead of resolving an event listener: the
 * broker answers in microseconds on a local pipe, so the frame a caller is waiting for is usually
 * already in hand before it asks, and a one-shot waiter that starts listening afterwards either
 * needs an arrival buffer or silently misses it.
 */
function connectHost(endpoint) {
  const socket = createConnection(endpoint);
  let buffer = Buffer.alloc(0);
  const frames = [];
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      frames.push(JSON.parse(buffer.subarray(0, newline).toString("utf8")));
      buffer = buffer.subarray(newline + 1);
    }
  });
  socket.on("error", () => undefined);
  return Object.freeze({
    ready: new Promise((resolveConnect, rejectConnect) => {
      socket.once("connect", resolveConnect);
      socket.once("error", rejectConnect);
    }),
    send: (value) => socket.write(`${JSON.stringify(value)}\n`),
    next: async (match, budgetMs = 60_000) => {
      const began = Date.now();
      for (;;) {
        const index = frames.findIndex(match);
        if (index >= 0) return frames.splice(index, 1)[0];
        if (Date.now() - began > budgetMs) throw new Error(`host_wait_timeout:${frames.map((frame) => frame.operation).join(",")}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
    },
    close: () => socket.destroy(),
  });
}

const STATIC_SKIP =
  process.platform !== "win32"
    ? "the guardian and its private ingress are Windows objects"
    : !existsSync(GUARDIAN_IMAGE)
      ? `the generation's guardian was never built here: ${GUARDIAN_IMAGE}`
      : !existsSync(ROLE_FIXTURE)
        ? `the guardian's role fixture was never built here: ${ROLE_FIXTURE}`
        : false;

test(
  "a real guardian arms a Job, launches a role inside it, publishes its exit and contains it",
  { skip: STATIC_SKIP, timeout: 240_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "role-broker-relay-"));
    const reportPath = join(root, "role-report.txt");
    const bootstrapId = randomBytes(32).toString("hex");
    // The built publication, admitted by the same rule `admitGuardianImage` applies to an installed
    // generation: the digest in the .dist manifest must be the digest of the bytes about to run.
    const manifest = JSON.parse(
      await readFile(join(dirname(GUARDIAN_IMAGE), "windows-bootstrap-guardian.manifest.json"), "utf8"),
    );
    const imageSha256 = createHash("sha256").update(await readFile(GUARDIAN_IMAGE)).digest("hex");
    assert.equal(imageSha256, manifest.sha256, "the built fixture publication is self-consistent");
    const image = Object.freeze({ path: GUARDIAN_IMAGE, sha256: imageSha256 });
    const broker = createGuardianRoleBroker({
      bootstrapId,
      binding: generationFacts,
      image,
      log: () => undefined,
    });
    await broker.listen();
    const host = connectHost(guardianPipeEndpoint(bootstrapId));
    await host.ready;
    try {
      host.send({
        schema: "gamebuddy-desktop-guardian-session/v1",
        protocolVersion: 1,
        operation: "hello",
        bootstrapId,
        generation: binding.generation,
        inventoryDigest: binding.inventoryDigest,
        runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
      });
      const hello = await host.next((frame) => frame.operation === "hello");
      assert.equal(hello.status, "accepted");

      const suffix = randomUUID().replaceAll("-", "");
      host.send({
        schema: "gamebuddy-desktop-guardian-session/v1",
        protocolVersion: 1,
        operation: "arm_attempt",
        bootstrapId,
        generation: binding.generation,
        inventoryDigest: binding.inventoryDigest,
        runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
        operationWaitBudgetMs: 60_000,
        guardianInstanceId: instanceId,
        guardianEpoch: 1,
        attemptId,
        privateFrame: Buffer.from(
          JSON.stringify({
            guardianInstanceId: instanceId,
            guardianEpoch: 1,
            attemptId,
            revision: randomUUID(),
            leaseName: `Local\\RoleBrokerLease${suffix}`,
            playerJobName: `Local\\RoleBrokerPlayer${suffix}`,
            aiJobName: `Local\\RoleBrokerAi${suffix}`,
            approvedExecutable: ROLE_FIXTURE,
          }),
        ).toString("base64url"),
      });
      const armed = await host.next((frame) => frame.operation === "arm_attempt");
      assert.equal(armed.status, "armed");

      host.send({
        schema: "gamebuddy-desktop-guardian-session/v1",
        protocolVersion: 1,
        operation: "launch_role",
        bootstrapId,
        generation: binding.generation,
        inventoryDigest: binding.inventoryDigest,
        runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
        deadlineUnixMs: Date.now() + 120_000,
        guardianInstanceId: instanceId,
        guardianEpoch: 1,
        attemptId,
        role: "player_host",
        privateFrame: Buffer.from(
          JSON.stringify({
            guardianInstanceId: instanceId,
            guardianEpoch: 1,
            attemptId,
            planId: randomUUID(),
            role: "player_host",
            deadlineUnixMs: Date.now() + 120_000,
            executable: ROLE_FIXTURE,
            cwd: dirname(ROLE_FIXTURE),
            arguments: ["--signal", reportPath, "--exit-after-report"],
            environment: { SystemRoot: process.env.SystemRoot },
          }),
        ).toString("base64url"),
      });
      const active = await host.next((frame) => frame.operation === "launch_role");
      assert.equal(active.status, "role_active");
      assert.equal(active.role, "player_host");

      // The role's own statement that it was created INSIDE the armed Job, which is the whole
      // containment claim the Guardian makes and the reason this test speaks to a real one.
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      assert.equal((await readFile(reportPath, "utf8")).trim(), "member=true");

      host.send({
        schema: "gamebuddy-desktop-guardian-session/v1",
        protocolVersion: 1,
        operation: "contain_role",
        bootstrapId,
        generation: binding.generation,
        inventoryDigest: binding.inventoryDigest,
        runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
        operationWaitBudgetMs: 60_000,
        guardianInstanceId: instanceId,
        guardianEpoch: 1,
        attemptId,
        role: "player_host",
      });
      // The exit the Guardian publishes travels as its own frame: the Host reads it without
      // consuming the acknowledgement it is waiting for.
      const exit = await host.next((frame) => frame.operation === "role_exited");
      assert.equal(exit.role, "player_host");
      assert.equal(exit.exitCode, 0);
      const contained = await host.next((frame) => frame.operation === "contain_role");
      assert.equal(contained.status, "role_contained");

      const facts = broker.facts();
      assert.equal(facts.mode, "armable");
      assert.equal(facts.helloAccepted, true);
      assert.deepEqual(
        facts.operations.map((row) => `${row.operation}:${row.outcome}`),
        ["arm_attempt:armed", "launch_role:role_active", "role_exited:player_host", "contain_role:role_contained"],
      );
      assert.equal(facts.guardians.length, 1);
      assert.deepEqual(facts.refusals, []);
      // The broker keeps the endpoint and the token to itself: nothing it reports may carry them.
      assert.equal(JSON.stringify(facts).includes("GameBuddy.Guardian."), false);
      assert.equal(JSON.stringify(facts).includes("token"), false);
    } finally {
      host.close();
      await broker.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);


