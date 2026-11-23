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
import { spawn } from "node:child_process";
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
const ROLE_FIXTURE = join(
  REPO_ROOT,
  "host",
  "native",
  "windows-bootstrap-guardian",
  ".dist",
  "fixtures",
  "RoleRootFixture.exe",
);

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
  assert.equal(guardianPipeEndpoint("a".repeat(64)), `\\\\.\\pipe\\GameBuddy.HostGuardian.${"a".repeat(64)}`);
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
    Object.keys(
      composeGuardianRoleExit({
        binding,
        correlation: { guardianInstanceId: instanceId, guardianEpoch: 1, attemptId },
        role: "player_host",
        exitCode: 0,
      }),
    ),
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
    assert.equal(
      paths.image,
      join(root, "native", "windows-bootstrap-guardian", "win-x64", "GameBuddy.WindowsBootstrapGuardian.exe"),
    );
    assert.equal(
      await admitGuardianImage({ generationRoot: root }),
      null,
      "a generation with no publication is hello-only, not an error",
    );

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
    closed: new Promise((resolveClosed) => socket.once("close", resolveClosed)),
    send: (value) => socket.write(`${JSON.stringify(value)}\n`),
    next: async (match, budgetMs = 60_000) => {
      const began = Date.now();
      for (;;) {
        const index = frames.findIndex(match);
        if (index >= 0) return frames.splice(index, 1)[0];
        if (Date.now() - began > budgetMs)
          throw new Error(`host_wait_timeout:${frames.map((frame) => frame.operation).join(",")}`);
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
    const imageSha256 = createHash("sha256")
      .update(await readFile(GUARDIAN_IMAGE))
      .digest("hex");
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

/**
 * The second attempt is the SECOND SESSION, and this is the peer half of that rule.
 *
 * ADR-0015 §3 makes a session the attempt: the Host closes control when its attempt ends, settles it, and
 * opens the next session on the same endpoint with a fresh hello and the next attempt's own correlation.
 * `DesktopHostBootstrapBroker.ServeSessionsAsync` serves exactly that (`Disconnect` -> settle ->
 * `AcceptSessionAsync`), one attempt at a time.
 *
 * Measured 2026-11-23 (`.tmp/lane-guardsession.md`): this broker kept ONE session for the whole launch, so
 * after a crashed attempt the next connection was destroyed on arrival. The Host re-opened and re-helloed
 * as designed and died arming with `guardian_session_closed` - before a single frame of the retry reached
 * a Guardian, which is why every other part of the retry read healthy and nothing ever started. Nothing
 * else in the retry was wrong, and nothing here weakens the one-arm-per-session rule: attempt 2 is a new
 * session, not a second arm on attempt 1's.
 */
test(
  "a settled attempt leaves the endpoint serving the next attempt on its own session, which arms its own Guardian",
  { skip: STATIC_SKIP, timeout: 240_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "role-broker-second-attempt-"));
    const reportPath = join(root, "role-report.txt");
    const bootstrapId = randomBytes(32).toString("hex");
    const manifest = JSON.parse(
      await readFile(join(dirname(GUARDIAN_IMAGE), "windows-bootstrap-guardian.manifest.json"), "utf8"),
    );
    const imageSha256 = createHash("sha256")
      .update(await readFile(GUARDIAN_IMAGE))
      .digest("hex");
    assert.equal(imageSha256, manifest.sha256, "the built fixture publication is self-consistent");
    const image = Object.freeze({ path: GUARDIAN_IMAGE, sha256: imageSha256 });
    const broker = createGuardianRoleBroker({ bootstrapId, binding: generationFacts, image, log: () => undefined });
    await broker.listen();
    const endpoint = guardianPipeEndpoint(bootstrapId);
    const helloRequest = () => ({
      schema: "gamebuddy-desktop-guardian-session/v1",
      protocolVersion: 1,
      operation: "hello",
      bootstrapId,
      generation: binding.generation,
      inventoryDigest: binding.inventoryDigest,
      runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
    });
    // One attempt's correlation and the three native names its arm fixes, all fresh: a second attempt that
    // inherited any of them would be attempt 1 continued, which is the shape this test must not accept.
    const attempt = () => {
      const correlation = Object.freeze({
        guardianInstanceId: randomUUID(),
        guardianEpoch: 1,
        attemptId: randomUUID(),
      });
      const suffix = randomUUID().replaceAll("-", "");
      const names = Object.freeze({
        revision: randomUUID(),
        leaseName: `Local\\RoleBrokerSecondLease${suffix}`,
        playerJobName: `Local\\RoleBrokerSecondPlayer${suffix}`,
        aiJobName: `Local\\RoleBrokerSecondAi${suffix}`,
      });
      return Object.freeze({ correlation, names });
    };
    const armRequest = ({ correlation, names }) => ({
      ...helloRequest(),
      operation: "arm_attempt",
      operationWaitBudgetMs: 60_000,
      ...correlation,
      privateFrame: Buffer.from(
        JSON.stringify({ ...correlation, ...names, approvedExecutable: ROLE_FIXTURE }),
      ).toString("base64url"),
    });
    const launchRequest = ({ correlation, names }) => {
      const deadlineUnixMs = Date.now() + 120_000;
      return {
        ...helloRequest(),
        operation: "launch_role",
        deadlineUnixMs,
        ...correlation,
        role: "player_host",
        privateFrame: Buffer.from(
          JSON.stringify({
            ...correlation,
            planId: randomUUID(),
            role: "player_host",
            deadlineUnixMs,
            executable: ROLE_FIXTURE,
            cwd: dirname(ROLE_FIXTURE),
            arguments: ["--signal", reportPath, "--exit-after-report"],
            environment: { SystemRoot: process.env.SystemRoot },
          }),
        ).toString("base64url"),
      };
    };
    const first = connectHost(endpoint);
    let second;
    await first.ready;
    try {
      first.send(helloRequest());
      assert.equal((await first.next((frame) => frame.operation === "hello")).status, "accepted");
      const attemptOne = attempt();
      first.send(armRequest(attemptOne));
      assert.equal((await first.next((frame) => frame.operation === "arm_attempt")).status, "armed");

      // The Host closes control: this attempt is over. The broker settles the Guardian it armed, exactly as
      // the Desktop does before it accepts again.
      first.close();
      await first.closed;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const guardians = broker.facts().guardians;
        if (guardians.length === 1 && guardians[0].ended !== null) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      assert.equal(
        broker.facts().guardians[0]?.ended === null || broker.facts().guardians[0]?.ended === undefined,
        false,
        `the ended attempt's Guardian was never settled; guardians=${JSON.stringify(broker.facts().guardians)}`,
      );

      // The next attempt: the same endpoint, its own connection, its own hello, its own correlation - and
      // no help from anything outside the wire.
      second = connectHost(endpoint);
      await second.ready;
      second.send(helloRequest());
      const secondHello = await second
        .next((frame) => frame.operation === "hello", 30_000)
        .catch((error) => {
          throw new Error(
            `the next attempt's hello was never answered (${String(error?.message)}); the Host reads a destroyed ` +
              `connection as guardian_session_closed at its hello; refusals=${JSON.stringify(broker.facts().refusals)}`,
          );
        });
      assert.equal(secondHello.status, "accepted", "the next attempt is served on its own session");

      const attemptTwo = attempt();
      second.send(armRequest(attemptTwo));
      const armed = await second.next((frame) => frame.operation === "arm_attempt");
      assert.equal(armed.status, "armed");
      assert.equal(armed.attemptId, attemptTwo.correlation.attemptId);
      assert.notEqual(armed.guardianInstanceId, attemptOne.correlation.guardianInstanceId);

      second.send(launchRequest(attemptTwo));
      const active = await second.next((frame) => frame.operation === "launch_role");
      assert.equal(active.status, "role_active");
      assert.equal(active.role, "player_host");
      // The role really ran inside the SECOND attempt's Job, which is the containment claim the retry needs.
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      assert.equal((await readFile(reportPath, "utf8")).trim(), "member=true");
      second.send({
        ...helloRequest(),
        operation: "contain_role",
        operationWaitBudgetMs: 60_000,
        ...attemptTwo.correlation,
        role: "player_host",
      });
      const exit = await second.next((frame) => frame.operation === "role_exited");
      assert.equal(exit.attemptId, attemptTwo.correlation.attemptId);
      assert.equal((await second.next((frame) => frame.operation === "contain_role")).status, "role_contained");

      const facts = broker.facts();
      assert.deepEqual(
        facts.operations.map((row) => `${row.operation}:${row.outcome}`),
        [
          "arm_attempt:armed",
          "arm_attempt:armed",
          "launch_role:role_active",
          "role_exited:player_host",
          "contain_role:role_contained",
        ],
      );
      // One Guardian per attempt, and the ended attempt's is the one that was settled: two attempts, never
      // two Guardians resident at once.
      assert.equal(facts.guardians.length, 2);
      assert.notEqual(facts.guardians[0].pid, facts.guardians[1].pid);
      assert.deepEqual(facts.refusals, []);
    } finally {
      first.close();
      second?.close();
      await broker.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * A Guardian whose private ingress appears only after `delayMs`: it holds the control frame the broker
 * writes to stdin in the pipe buffer, starts the real image late, and lets it inherit that same stdin.
 *
 * This is the shape the machine produces for real. Measured 2026-11-21 (`.tmp/lane-livenow6.md`), the
 * wait from control frame to listening pipe for one and the same built image was 0.617 s, 12.885 s,
 * 15.692 s and 17.866 s on four runs - and the r17 live run's only remaining launch refusal was
 * `role_broker_private_ingress_unavailable:ENOENT` at the 10 s window this broker used to impose on a
 * command the Host had already allowed 60 s for.
 */
const SLOW_GUARDIAN_SHIM = [
  'const { spawn } = require("node:child_process");',
  "const [image, delayMs] = process.argv.slice(2);",
  "setTimeout(() => {",
  '  const child = spawn(image, [], { stdio: ["inherit", "inherit", "inherit"], windowsHide: true });',
  '  child.on("exit", (code) => process.exit(code ?? 0));',
  "}, Number(delayMs));",
  "",
].join("\n");

/** A broker on the real image, run behind a shim that starts it `delayMs` late. */
async function startLateGuardianBroker(root, delayMs) {
  const shim = join(root, "slow-guardian.cjs");
  await writeFile(shim, SLOW_GUARDIAN_SHIM, "utf8");
  const bootstrapId = randomBytes(32).toString("hex");
  const image = Object.freeze({
    path: GUARDIAN_IMAGE,
    sha256: createHash("sha256")
      .update(await readFile(GUARDIAN_IMAGE))
      .digest("hex"),
  });
  const broker = createGuardianRoleBroker({
    bootstrapId,
    binding: Object.freeze({
      generation: "gen-late",
      inventoryDigest: "d".repeat(64),
      runtimeAdmissionSha256: "a".repeat(64),
    }),
    image,
    imagePath: GUARDIAN_IMAGE,
    spawnImpl: (path, args, options) => spawn(process.execPath, [shim, path, String(delayMs)], options),
    log: () => undefined,
  });
  await broker.listen();
  const host = connectHost(guardianPipeEndpoint(bootstrapId));
  await host.ready;
  const helloRequest = {
    schema: "gamebuddy-desktop-guardian-session/v1",
    protocolVersion: 1,
    operation: "hello",
    bootstrapId,
    generation: "gen-late",
    inventoryDigest: "d".repeat(64),
    runtimeAdmissionSha256: "a".repeat(64),
  };
  host.send(helloRequest);
  await host.next((frame) => frame.operation === "hello");
  const correlation = { guardianInstanceId: randomUUID(), guardianEpoch: 1, attemptId: randomUUID() };
  const armFrame = (operationWaitBudgetMs) => ({
    schema: "gamebuddy-desktop-guardian-session/v1",
    protocolVersion: 1,
    operation: "arm_attempt",
    bootstrapId,
    generation: "gen-late",
    inventoryDigest: "d".repeat(64),
    runtimeAdmissionSha256: "a".repeat(64),
    operationWaitBudgetMs,
    ...correlation,
    privateFrame: Buffer.from(
      JSON.stringify({
        ...correlation,
        revision: randomUUID(),
        leaseName: `Local\\LateArmLease${randomUUID().replaceAll("-", "")}`,
        playerJobName: `Local\\LateArmPlayer${randomUUID().replaceAll("-", "")}`,
        aiJobName: `Local\\LateArmAi${randomUUID().replaceAll("-", "")}`,
        approvedExecutable: ROLE_FIXTURE,
      }),
    ).toString("base64url"),
  });
  return { broker, host, armFrame };
}

test(
  "an arm waits as long as the Host's own budget allows, not a shorter window of the broker's",
  { skip: STATIC_SKIP, timeout: 90_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "role-broker-late-arm-"));
    const { broker, host, armFrame } = await startLateGuardianBroker(root, 11_000);
    try {
      // 11 s is past the window this broker used to impose and inside the 60 s the Host allows.
      host.send(armFrame(60_000));
      const armed = await host
        .next((frame) => frame.operation === "arm_attempt", 30_000)
        .catch((error) => {
          // A refused arm destroys the session without answering the command, so the refusal name in the
          // broker's facts is the only statement of what happened: a bare wait timeout would hide it.
          throw new Error(
            `the arm was never answered (${String(error?.message)}); refusals=${JSON.stringify(broker.facts().refusals)}`,
          );
        });
      assert.equal(armed.status, "armed", "a guardian that needs 11 s to listen must still be armed");
      assert.deepEqual(broker.facts().refusals, []);
    } finally {
      host.close();
      await broker.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "an arm the Host budgets less than the guardian needs is refused by name, not waited for forever",
  { skip: STATIC_SKIP, timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "role-broker-short-arm-"));
    const { broker, host, armFrame } = await startLateGuardianBroker(root, 11_000);
    try {
      const began = Date.now();
      host.send(armFrame(400));
      // A refused arm does not come back as a frame: the broker ends the session and records the name,
      // which is where every reader of this wire learns what happened.
      let refusals = [];
      while (Date.now() - began < 8_000) {
        refusals = [...broker.facts().refusals];
        if (refusals.length > 0) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      // Two spellings mean the same thing here and which one wins is a race between the relay's own
      // deadline and the connect loop's: both say the command's budget, not a longer window, ended it.
      assert.equal(refusals.length, 1, `one refusal, named: ${JSON.stringify(refusals)}`);
      assert.match(refusals[0], /^role_broker_(arm_timeout:400ms|private_ingress_unavailable:ENOENT)$/u);
      assert.deepEqual(
        broker.facts().operations.map((row) => `${row.operation}:${row.outcome}`),
        ["arm_attempt:refused"],
      );
      assert.ok(
        Date.now() - began < 5_000,
        `the 400 ms budget is what ends the wait, not a longer window: it took ${String(Date.now() - began)}ms`,
      );
    } finally {
      host.close();
      await broker.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
