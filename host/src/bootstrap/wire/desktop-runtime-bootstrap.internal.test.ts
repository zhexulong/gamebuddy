import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { driveGuardianRecoveryConversation } from "./desktop-runtime-bootstrap.internal.js";
import type {
  DesktopGuardianRecovery,
  DesktopGuardianRecoveryTransport,
  GuardianRecoveryRole,
} from "../../containment/auth/desktop-guardian-session.internal.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = findPackageRoot(sourceDirectory);
const sourceRoot = resolve(packageRoot, "src");
const compiledRoot = resolve(sourceDirectory, "..", "..");

test("desktop bootstrap helper seeds the composed surface from the Host env seam and publishes the launch URL", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  for (const surface of ["composed-reference-game", "chat-only", "management"]) {
    const result = await runWireFixture("success", { surface });
    assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
    assert.match(result.stderr, new RegExp(`wire_assembly_surface:${surface}\\n`));
  }
  const defaulted = await runWireFixture("success");
  assert.equal(JSON.parse(defaulted.acknowledgement!).status, "accepted");
  assert.match(defaulted.stderr, /wire_assembly_surface:default\n/);
  assert.match(defaulted.stderr, /wire_publish_ready:called\n/);
});

test("desktop bootstrap helper fails closed on an invalid composed surface or marker nonce without any guardian contact", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  for (const [scenario, options] of [
    ["invalid-surface", { surface: "bogus" }],
    ["invalid-nonce", { nonceSha256: "not-hex" }],
  ] as const) {
    const result = await runWireFixture(scenario, options);
    assert.equal(result.acknowledgement, undefined);
    assert.deepEqual(result.requests, []);
    assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable\n$/);
  }
});

/**
 * The exact ordinal key sequence `DesktopHostBootstrapBroker.ExactObject`
 * compares for one command frame, copied from the broker's own per-operation key
 * arrays (`TryParseCommand`, DesktopHostBootstrapBroker.cs): the bounded wait (or
 * the launch deadline) follows the binding, and the role precedes the private
 * frame. The broker compares the sequence, not only the set, and the recording
 * peer parses order-agnostically, so nothing but this assertion pins the order.
 */
const commandFrameKeys = (timing: "operationWaitBudgetMs" | "deadlineUnixMs", ...trailing: readonly string[]): readonly string[] => [
  "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256",
  timing, "guardianInstanceId", "guardianEpoch", "attemptId", ...trailing,
];

test("desktop bootstrap helper performs one authenticated guardian wire roundtrip", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("success");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello", "arm_attempt", "launch_role", "contain_role"]);
  assert.equal(Object.hasOwn(result.requests[1]!, "operationWaitBudgetMs"), true);
  assert.equal(Object.hasOwn(result.requests[1]!, "deadlineUnixMs"), false);
  assert.equal(Object.hasOwn(result.requests[2]!, "operationWaitBudgetMs"), false);
  assert.equal(typeof result.requests[2]!.deadlineUnixMs, "number");
  assert.equal(Object.hasOwn(result.requests[3]!, "operationWaitBudgetMs"), true);
  assert.equal(Object.hasOwn(result.requests[3]!, "deadlineUnixMs"), false);
  // Every command frame's key order is protocol: the broker refuses a frame whose
  // keys are not in its own sequence, so a reordered guardianCommandFrame must
  // fail here rather than only against the real broker.
  assert.deepEqual(Object.keys(result.requests[1]!), commandFrameKeys("operationWaitBudgetMs", "privateFrame"));
  assert.deepEqual(Object.keys(result.requests[2]!), commandFrameKeys("deadlineUnixMs", "role", "privateFrame"));
  assert.deepEqual(Object.keys(result.requests[3]!), commandFrameKeys("operationWaitBudgetMs", "role"));
  // The wire carries the real composition-armor frame: the arm private frame
  // must contain the approved executable and the native ParseLaunch-style
  // launch frame must reuse that exact executable (ParseArm/ParseLaunch gate).
  const armFrame = JSON.parse(Buffer.from(String(result.requests[1]!.privateFrame), "base64url").toString("utf8")) as Record<string, unknown>;
  const launchFrame = JSON.parse(Buffer.from(String(result.requests[2]!.privateFrame), "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(armFrame.approvedExecutable, "C:\\Program Files\\GameBuddy\\roles\\RoleRootFixture.exe");
  assert.equal(launchFrame.executable, armFrame.approvedExecutable);
  assert.ok(result.stderr.length >= 0);
});

test("desktop bootstrap helper never sends arm_attempt when the authorization lacks the approved executable", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("missing-arm-executable");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello"]);
  assert.match(result.stderr, /(?:^|\n)contained game runtime: arm authorization missing approved executable\n$/);
  assert.doesNotMatch(result.stderr, /unexpected_arm_success|arm_attempt|armed/);
});

test("desktop bootstrap helper rejects arm when guardian withholds ACK", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("withheld-arm-ack");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello", "arm_attempt"]);
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable\n$/);
  assert.doesNotMatch(result.stderr, /unexpected_arm_success|success|armed|launch_role|contain_role/);
});

test("desktop bootstrap helper rejects contain when guardian withholds ACK", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("withheld-contain-ack");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello", "arm_attempt", "contain_role"]);
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable\n$/);
});

test("desktop bootstrap helper rejects launch beyond the local deadline horizon", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("overhorizon-launch");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello", "arm_attempt"]);
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable\n$/);
  assert.doesNotMatch(result.stderr, /launch_role|unexpected_launch_success/);
});

test("desktop bootstrap helper times out a delayed arm ACK and rejects a late ACK", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("delayed-arm-ack");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello", "arm_attempt"]);
  assert.equal(typeof result.armReceiptAt, "number");
  assert.equal(typeof result.workerClosedAt, "number");
  assert.ok(result.workerClosedAt! - result.armReceiptAt! >= 40, "rejection must wait for the operation budget after peer receipt");
  assert.ok(result.workerClosedAt! - result.armReceiptAt! < 2_000, "timed rejection must be bounded");
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable\n$/);
  assert.doesNotMatch(result.stderr, /unexpected_arm_success|success|armed|launch_role|contain_role/);
});

test("desktop bootstrap helper does not send expired launch", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("expired-launch");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello", "arm_attempt"]);
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable\n$/);
});

test("desktop bootstrap helper rejects when guardian peer disconnects", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("peer-disconnect");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello", "arm_attempt"]);
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable\n$/);
});

test("desktop bootstrap helper rejects malformed arm input before writing arm_attempt", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("malformed-arm");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello"]);
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable\n$/);
  assert.doesNotMatch(result.stderr, /unexpected_arm_success|success|armed|arm_attempt/);
});

test("desktop bootstrap helper closes an authenticated guardian session when composition construction fails", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("composition-failure");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello"]);
  assert.equal(result.guardianClosed, true);
  assert.match(result.stderr, /composition_construction_failed/);
});

test("desktop bootstrap helper closes its composition when acknowledgement writing fails", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("ack-write-failure");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello"]);
  assert.equal(result.guardianClosed, true);
  assert.match(result.stderr, /ack_write_failed/);
});

test("desktop bootstrap helper closes its composition when termination fails", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("termination-failure");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello"]);
  assert.equal(result.guardianClosed, true);
  assert.match(result.stderr, /termination_failed/);
});

test("desktop bootstrap helper closes its composition cleanly on a shutdown request", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("shutdown-request");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello", "arm_attempt", "launch_role", "contain_role"]);
  assert.equal(result.guardianClosed, true);
  assert.equal(result.workerExitCode, 0, "the child must close its own composition and exit 0, not be killed");
  assert.equal(result.workerExitedNaturally, true);
});

test("desktop bootstrap helper ignores a malformed IPC message and stays up", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("shutdown-malformed");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello", "arm_attempt", "launch_role", "contain_role"]);
  assert.equal(result.workerExitCode, null, "a malformed message must not drop the composition");
});

// The recovery conversation is the only operation whose read path waits for more
// than one acknowledgement on one session. This drives it through the real named
// pipe so the session's waiter installs, the exact ordinal frame order the
// Desktop broker compares, and the terminal containment are all observed on the
// wire rather than only against a recording transport.
test("desktop bootstrap helper drives the recovery conversation over one authenticated session", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("recovery-success");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(result.requests.map((request) => request.operation), [
    "hello",
    "recover_attempt",
    "recovery_post_cas",
    "recover_attempt",
    "recovery_role_cas_ack",
    "recovery_role_cas_ack",
    "recovery_finalize_ack",
    "release",
  ]);
  // The recovery frames speak the recovery role token, and the private bodies are
  // the ones the durable steps produced.
  assert.deepEqual(result.requests.filter((request) => request.role !== undefined).map((request) => request.role), ["playerHost", "aiClient"]);
  const postCas = JSON.parse(Buffer.from(String(result.requests[2]!.privateFrame), "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(postCas.ownerRecordRevision, 2);
  assert.doesNotMatch(result.stderr, /desktop_runtime_bootstrap_unavailable/);
});

// The mirror of the resume tolerance: a role CAS the durable record refuses must
// still fail the whole session closed. The rejected role is the first one, so the
// conversation stops before that role's CAS acknowledgement and the peer sees the
// disconnect instead of a containment the record never accepted.
test("desktop bootstrap helper fails the recovery session closed when the durable role CAS refuses a role", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("recovery-role-rejected");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(result.requests.map((request) => request.operation), ["hello", "recover_attempt", "recovery_post_cas", "recover_attempt"]);
  // The durable step ran and refused, the peer saw the live session close, and no
  // containment was ever reported: the wire writes no CAS acknowledgement for the
  // refused role, no finalize and no release frame.
  assert.match(result.stderr, /recovery_role_contained:playerHost/);
  assert.equal(result.guardianClosed, true, "a refused role CAS must close the session rather than leave it live");
  assert.doesNotMatch(result.stderr, /recovery_outcome:/);
});

async function runWireFixture(scenario: "success" | "recovery-success" | "recovery-role-rejected" | "shutdown-request" | "shutdown-malformed" | "missing-arm-executable" | "malformed-arm" | "withheld-arm-ack" | "delayed-arm-ack" | "withheld-contain-ack" | "expired-launch" | "overhorizon-launch" | "peer-disconnect" | "composition-failure" | "ack-write-failure" | "termination-failure" | "invalid-surface" | "invalid-nonce", options: Readonly<{ surface?: string; nonceSha256?: string }> = {}): Promise<{ requests: Record<string, unknown>[]; acknowledgement: string | undefined; stderr: string; guardianClosed: boolean; armReceiptAt: number | undefined; workerClosedAt: number | undefined; workerExitCode: number | null; workerExitedNaturally: boolean }> {
  const fixturesWithIpc = scenario === "shutdown-request" || scenario === "shutdown-malformed";
  const fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-wire-"));
  const bootstrapId = (scenario === "success" ? "d" : scenario === "recovery-success" ? "1" : scenario === "recovery-role-rejected" ? "4" : scenario === "missing-arm-executable" ? "5" : scenario === "malformed-arm" ? "c" : scenario === "withheld-arm-ack" ? "b" : scenario === "delayed-arm-ack" ? "7" : scenario === "withheld-contain-ack" ? "a" : scenario === "expired-launch" ? "9" : scenario === "overhorizon-launch" ? "6" : scenario === "invalid-surface" ? "2" : scenario === "invalid-nonce" ? "3" : "8").repeat(64);
  const guardianInstanceId = scenario === "success" ? "11111111-1111-4111-8111-111111111111" : scenario === "malformed-arm" ? "33333333-3333-4333-8333-333333333333" : "55555555-5555-4555-8555-555555555555";
  const attemptId = scenario === "success" ? "22222222-2222-4222-8222-222222222222" : scenario === "malformed-arm" ? "44444444-4444-4444-8444-444444444444" : "66666666-6666-4666-8666-666666666666";
  const rootLayout = {
    schema: "gamebuddy-windows-root-layout/v1",
    programRoot: join(fixtureRoot, "Programs", "GameBuddy"),
    dataRoot: join(fixtureRoot, "GameBuddy", "data"),
    operationalRoot: join(fixtureRoot, "GameBuddy", "operational"),
    presentationRoot: join(fixtureRoot, "GameBuddy", "presentation"),
  };
  const moduleDirectory = join(rootLayout.programRoot, "generation");
  const endpoint = `\\\\.\\pipe\\GameBuddy.HostGuardian.${bootstrapId}`;
  const requests: Record<string, unknown>[] = [];
  let connected = false;
  let recoveryAttempts = 0;
  let operationsResolve!: () => void;
  const operationsComplete = new Promise<void>((resolve) => { operationsResolve = resolve; });
  let worker: ReturnType<typeof spawn> | undefined;
  let peerError: Error | undefined;
  let armReceiptAt: number | undefined;
  let guardianClosed = false;
  let guardianClosedResolve!: () => void;
  const guardianPeerClosed = new Promise<void>((resolve) => { guardianClosedResolve = resolve; });
  const server = createServer((socket) => {
    connected = true;
    socket.once("close", () => { guardianClosed = true; guardianClosedResolve(); });
    socket.on("error", (error) => { peerError = error; });
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        const request = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(newline + 1);
        requests.push(request);
        const operation = request.operation;
        if ((scenario === "recovery-success" || scenario === "recovery-role-rejected") && operation !== "hello") {
          // Answered at the positions the Desktop broker answers: one
          // acknowledgement for the gate, one for the post-CAS + native recover
          // pair, one per contained role, and one terminal acknowledgement after
          // the release frame. Every acknowledgement carries the recovery actor
          // and no role.
          let status: string | undefined;
          if (operation === "recover_attempt") { status = recoveryAttempts === 0 ? "recovery_accepted" : "player_contained"; recoveryAttempts += 1; }
          else if (operation === "recovery_role_cas_ack") status = request.role === "playerHost" ? "ai_contained" : undefined;
          else if (operation === "release") status = "contained";
          if (status !== undefined) socket.write(`${JSON.stringify({ schema: "gamebuddy-desktop-guardian-session/v1", protocolVersion: 1, operation: "recover_attempt", status, bootstrapId, generation: request.generation, inventoryDigest: request.inventoryDigest, runtimeAdmissionSha256: request.runtimeAdmissionSha256, guardianInstanceId: request.guardianInstanceId, guardianEpoch: request.guardianEpoch, attemptId: request.attemptId, recoveryInstanceId: request.recoveryInstanceId })}\n`);
          // A refused role CAS ends the conversation at that role, so the peer
          // resolves the operations when it answers the role the test refuses
          // instead of on a release frame that must never arrive.
          if (operation === "release" || (scenario === "recovery-role-rejected" && status === "player_contained")) operationsResolve();
          continue;
        }
        if (scenario === "delayed-arm-ack" && operation === "arm_attempt") {
          armReceiptAt = performance.now();
          setTimeout(() => socket.write(`${JSON.stringify({ schema: "gamebuddy-desktop-guardian-session/v1", protocolVersion: 1, operation: "arm_attempt", status: "armed", bootstrapId, generation: request.generation, inventoryDigest: request.inventoryDigest, runtimeAdmissionSha256: request.runtimeAdmissionSha256, guardianInstanceId: request.guardianInstanceId, guardianEpoch: request.guardianEpoch, attemptId: request.attemptId })}\n`), 250);
          return;
        }
        if ((scenario === "withheld-arm-ack" && operation === "arm_attempt") || (scenario === "withheld-contain-ack" && operation === "contain_role")) return;
        if (scenario === "peer-disconnect" && operation === "arm_attempt") { socket.destroy(); return; }
        const response: Record<string, unknown> = { schema: "gamebuddy-desktop-guardian-session/v1", protocolVersion: 1, operation, status: operation === "hello" ? "accepted" : operation === "arm_attempt" ? "armed" : operation === "launch_role" ? "role_active" : "role_contained", bootstrapId, generation: request.generation, inventoryDigest: request.inventoryDigest, runtimeAdmissionSha256: request.runtimeAdmissionSha256 };
        if (operation !== "hello") Object.assign(response, { guardianInstanceId: request.guardianInstanceId, guardianEpoch: request.guardianEpoch, attemptId: request.attemptId, ...(operation !== "arm_attempt" ? { role: request.role } : {}) });
        socket.write(`${JSON.stringify(response)}\n`);
        if (operation === "contain_role") operationsResolve();
      }
    });
  });
  try {
    await Promise.all([moduleDirectory, rootLayout.dataRoot, rootLayout.operationalRoot, rootLayout.presentationRoot].map((path) => mkdir(path, { recursive: true })));
    await mkdir(join(moduleDirectory, "bootstrap", "wire"), { recursive: true });
    await writeFile(join(moduleDirectory, "bootstrap", "wire", "desktop-runtime-bootstrap.internal.js"), await readFile(resolve(compiledRoot, "bootstrap", "wire", "desktop-runtime-bootstrap.internal.js")));
    await cp(resolve(compiledRoot, "windows-reparse-inspector"), join(moduleDirectory, "windows-reparse-inspector"), { recursive: true });
    await cp(resolve(compiledRoot, "strict-json-reader.js"), join(moduleDirectory, "strict-json-reader.js"));
    await mkdir(join(moduleDirectory, "composition"), { recursive: true });
    await cp(resolve(compiledRoot, "composition", "desktop-host-composition.js"), join(moduleDirectory, "composition", "desktop-host-composition.js"));
    // The wire worker drives the real contained runtime platform encoder so the
    // fixture asserts the actual arm frame (approvedExecutable) and the launch
    // frame consistency instead of an opaque placeholder. That module needs the
    // launch-plan encoder and the synchronized contained runtime core; the
    // composer-core import inside it is a Guardian-owner seam the fixture never
    // invokes, so a hermetic throwing stub keeps the fixture self-contained.
    await cp(resolve(compiledRoot, "composition", "stardew", "stardew-guardian-platform.js"), join(moduleDirectory, "composition", "stardew", "stardew-guardian-platform.js"));
    await cp(resolve(compiledRoot, "composition", "stardew", "stardew-native-role-launch-plan.private.js"), join(moduleDirectory, "composition", "stardew", "stardew-native-role-launch-plan.private.js"));
    const containmentCore = join(moduleDirectory, "containment", "runtime", "core", "contained-game-runtime.js");
    await mkdir(dirname(containmentCore), { recursive: true });
    await cp(resolve(compiledRoot, "containment", "runtime", "core", "contained-game-runtime.js"), containmentCore);
    const composerCorePath = join(moduleDirectory, "games", "stardew", "lifecycle", "stardew-private-bootstrap-composer.core.js");
    await mkdir(dirname(composerCorePath), { recursive: true });
    await writeFile(composerCorePath, "// Hermetic wire-fixture stub: the contained runtime platform imports these seams but\n// never invokes them; the fixture keeps the module graph self-contained instead of\n// dragging in the whole composer core closure.\nexport function createStardewBootstrapGuardianOwnerBinding() { throw new Error(\"wire_fixture_composer_core_stub_unused\"); }\nexport function readStardewBootstrapGuardianNativeArmFrame() { throw new Error(\"wire_fixture_composer_core_stub_unused\"); }\nexport function consumeStardewBootstrapGuardianOwnerBinding() { throw new Error(\"wire_fixture_composer_core_stub_unused\"); }\nexport function settleOwnedPlayerHostContainedRuntimeAttempt() { throw new Error(\"wire_fixture_composer_core_stub_unused\"); }\n");
    // Same reasoning for the optional Voice surface the bootstrap entry imports.
    // The fixture never configures GAMEBUDDY_VOICE_PORT/TOKEN, so
    // connectOptionalVoiceSurface() returns before calling into the gateway; a
    // hermetic stub keeps the Voice client closure (and its workspace protocol
    // package) out of this fixture instead of copying a module graph it never
    // drives. Added 2026-09-26: the import arrived in b5ac04c without this
    // fixture being updated, which left all 14 executable cases failing on a
    // clean tree with ERR_MODULE_NOT_FOUND for voice-bootstrap.js.
    await writeFile(join(moduleDirectory, "voice-bootstrap.js"), "// Hermetic wire-fixture stub: the bootstrap entry imports this seam but the\n// fixture configures no Voice surface, so it is never invoked.\nexport async function connectHealthyVoiceGateway() { throw new Error(\"wire_fixture_voice_stub_unused\"); }\nexport async function connectHealthyVoiceGatewayWith() { throw new Error(\"wire_fixture_voice_stub_unused\"); }\n");
    await cp(resolve(compiledRoot, "deployment-manifest.js"), join(moduleDirectory, "deployment-manifest.js"));
    const manifestPath = join(fixtureRoot, "deployment-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot: fixtureRoot,
      principal: { continuityId: "continuity-wire", companionId: "companion-wire", playerId: "player-wire" },
      bootstrapOperationId: "bootstrap-wire",
      authorityGeneration: 1,
    })}\n`);
    await cp(resolve(packageRoot, "native", "windows-reparse-inspector", ".dist", "win-x64"), join(moduleDirectory, "native", "windows-reparse-inspector", "win-x64"), { recursive: true });
    await new Promise<void>((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(endpoint, resolveListen); });
    const workerPath = join(fixtureRoot, "wire-fixture-worker.mjs");
    await writeFile(workerPath, workerSource(moduleDirectory, guardianInstanceId, attemptId, scenario));
    // The shutdown-request scenarios exercise the IPC channel: the parent asks
    // the child via `process.send` to close its own composition. That channel is
    // the gate launcher's readiness IPC, opened by the spawn's fourth stdio slot.
    const stdio: "pipe"[] | ["pipe", "pipe", "pipe", "ipc"] = fixturesWithIpc
      ? ["pipe", "pipe", "pipe", "ipc"]
      : ["pipe", "pipe", "pipe"];
    worker = spawn(process.execPath, ["--experimental-test-module-mocks", workerPath], { stdio, env: { ...process.env, LOCALAPPDATA: fixtureRoot, GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST: manifestPath, GAMEBUDDY_HOST_GAME_SESSION_MODE: "known", ...(options.surface === undefined ? {} : { GAMEBUDDY_HOST_SURFACE: options.surface }), ...(options.nonceSha256 === undefined ? {} : { GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256: options.nonceSha256 }) } });
    const workerClose = waitForClose(worker);
    const failureScenario = scenario === "composition-failure" || scenario === "ack-write-failure" || scenario === "termination-failure" || scenario === "invalid-surface" || scenario === "invalid-nonce";
    const output = failureScenario ? undefined : collectFirstLine(worker.stdout!, worker);
    const stderr = collectBounded(worker.stderr!);
    let workerStderr = "";
    worker.stderr!.on("data", (chunk: Buffer) => { workerStderr = (workerStderr + chunk.toString()).slice(-4096); });
    worker.stdin!.end(`${JSON.stringify({ schema: "gamebuddy-desktop-host-bootstrap/v1", protocolVersion: 1, bootstrapId, generation: "g-wire", inventoryDigest: "e".repeat(64), runtimeAdmissionSha256: "f".repeat(64), rootLayout })}\n`);
    const acknowledgement = output === undefined ? undefined : await withTimeout(output, 10_000, "bootstrap acknowledgement").catch((error) => { throw new Error(`${error.message}; worker=${worker?.exitCode ?? "running"}/${worker?.signalCode ?? "none"}; stderr=${workerStderr || "<empty>"}; peer=${peerError?.message ?? "none"}; operations=${requests.map((request) => String(request.operation)).join(",") || "<none>"}`); });
    if (failureScenario) {
      await withTimeout(workerClose, 2_000, `${scenario} rejection`);
      if (connected) await withTimeout(guardianPeerClosed, 2_000, `${scenario} guardian cleanup`);
    } else if (fixturesWithIpc) {
      await withTimeout(operationsComplete, 10_000, "guardian operations");
      if (scenario === "shutdown-request") {
        // The parent requests a clean close over the SAME IPC channel the child
        // uses for readiness. The child must exit 0 by its own close path - the
        // graceful path the memory loop depends on for its phase-2 successor.
        worker.send({ schema: "gamebuddy-desktop-shutdown-request/v1", protocolVersion: 1 });
        await withTimeout(workerClose, 10_000, "shutdown request close");
      } else {
        // A malformed message must be ignored: the composition stays up, exactly
        // as it does for any unrelated IPC payload.
        worker.send({ not: "a-shutdown-request" });
        await new Promise((resolveKeepalive) => setTimeout(resolveKeepalive, 500));
        worker.kill("SIGTERM");
        await withTimeout(workerClose, 10_000, "shutdown-malformed cleanup");
      }
    } else if (scenario === "success" || scenario === "recovery-success") {
      await withTimeout(operationsComplete, 10_000, "guardian operations");
      worker.kill("SIGTERM");
    } else if (scenario === "recovery-role-rejected") {
      await withTimeout(operationsComplete, 10_000, "guardian operations");
      // The peer must observe the disconnect while the worker is still running:
      // runDesktopHostBootstrap parks on termination until the fixture signals it,
      // so a closed peer here is the session's own fail-closed path and not the
      // process exiting.
      await withTimeout(guardianPeerClosed, 10_000, "recovery rejection guardian cleanup");
      worker.kill("SIGTERM");
      await withTimeout(workerClose, 10_000, "recovery rejection close");
    } else if (scenario !== "malformed-arm" && scenario !== "missing-arm-executable") {
      await withTimeout(workerClose, 2_000, `${scenario} rejection`);
    }
    const workerClosedAt = scenario === "delayed-arm-ack" ? performance.now() : undefined;
    await withTimeout(workerClose, 10_000, "worker cleanup");
    return { requests, acknowledgement, stderr: await stderr, guardianClosed, armReceiptAt, workerClosedAt, workerExitCode: worker.exitCode, workerExitedNaturally: worker.exitCode === 0 };
  } finally {
    if (worker !== undefined && worker.exitCode === null && !worker.killed) { worker.kill("SIGTERM"); await withTimeout(waitForClose(worker), 10_000, "worker failure cleanup").catch(() => undefined); }
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function workerSource(moduleDirectory: string, guardianInstanceId: string, attemptId: string, scenario: "success" | "recovery-success" | "recovery-role-rejected" | "shutdown-request" | "shutdown-malformed" | "missing-arm-executable" | "malformed-arm" | "withheld-arm-ack" | "delayed-arm-ack" | "withheld-contain-ack" | "expired-launch" | "overhorizon-launch" | "peer-disconnect" | "composition-failure" | "ack-write-failure" | "termination-failure" | "invalid-surface" | "invalid-nonce"): string {
  const bootstrapUrl = pathToFileURL(join(moduleDirectory, "bootstrap", "wire", "desktop-runtime-bootstrap.internal.js")).href;
  const compositionUrl = pathToFileURL(join(moduleDirectory, "composition", "desktop-host-composition.js")).href;
  const platformUrl = pathToFileURL(join(moduleDirectory, "composition", "stardew", "stardew-guardian-platform.js")).href;
  // The fixture drives the real contained runtime platform so the recorded wire
  // arm frame is the usual approvedExecutable-carrying frame and the launch plan
  // is the native ParseLaunch encoder output (executable === approvedExecutable).
  const operation = scenario === "success" || scenario === "shutdown-request" || scenario === "shutdown-malformed"
    ? `const { createDesktopGuardianGameRuntimePlatform } = await import(${JSON.stringify(platformUrl)}); const platform = createDesktopGuardianGameRuntimePlatform(session); const approvedExecutable = "C:\\\\Program Files\\\\GameBuddy\\\\roles\\\\RoleRootFixture.exe"; const launchFacts = { executable: approvedExecutable, cwd: "C:\\\\Program Files\\\\GameBuddy", arguments: ["--signal", "C:\\\\tmp\\\\wire.txt"], environment: { PATH: "C:\\\\Windows\\\\System32", SystemRoot: "C:\\\\Windows", WINDIR: "C:\\\\Windows", TEMP: "C:\\\\Windows\\\\Temp", TMP: "C:\\\\Windows\\\\Temp", USERPROFILE: "C:\\\\Users\\\\tester", GAMEBUDDY_STARDEW_LAUNCH_GENERATION: "wire-generation" } }; await platform.arm({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 123, authorization: { role: "player_host", revision: "11111111-1111-4111-8111-111111111111", executable: approvedExecutable } }); await platform.launch({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, deadlineUnixMs: Date.now() + 60000, role: "player_host", authorization: launchFacts }); await platform.contain({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 123, role: "player_host" });`
    : scenario === "recovery-success"
      ? `const recoveryInstanceId = "77777777-7777-4777-8777-777777777777"; const preCasFrame = new TextEncoder().encode(JSON.stringify({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, bindingRevision: "88888888-8888-4888-8888-888888888888", leaseName: "Local\\\\GameBuddy-Lease-1" })); const postCasFrame = new TextEncoder().encode(JSON.stringify({ ownerRecordRevision: 2 })); const outcome = await session.recover({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 123, recoveryInstanceId, preCasFrame, beginRecovery: async () => postCasFrame, roleContained: async (role) => { process.stderr.write("recovery_role_contained:" + role + "\\n"); } }); process.stderr.write("recovery_outcome:" + outcome.outcome + "\\n");`
      : scenario === "recovery-role-rejected"
        ? `const recoveryInstanceId = "77777777-7777-4777-8777-777777777777"; const preCasFrame = new TextEncoder().encode(JSON.stringify({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, bindingRevision: "88888888-8888-4888-8888-888888888888", leaseName: "Local\\\\GameBuddy-Lease-1" })); const postCasFrame = new TextEncoder().encode(JSON.stringify({ ownerRecordRevision: 2 })); const outcome = await session.recover({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 123, recoveryInstanceId, preCasFrame, beginRecovery: async () => postCasFrame, roleContained: async (role) => { process.stderr.write("recovery_role_contained:" + role + "\\n"); throw new Error("stardew_bootstrap_owner_transition_mismatch"); } }); process.stderr.write("recovery_outcome:" + outcome.outcome + "\\n");`
      : scenario === "missing-arm-executable"
      ? `try { const { createDesktopGuardianGameRuntimePlatform } = await import(${JSON.stringify(platformUrl)}); const platform = createDesktopGuardianGameRuntimePlatform(session); await platform.arm({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 100, authorization: { role: "player_host", revision: "33333333-3333-4333-8333-333333333333" } }); throw new Error("unexpected_arm_success"); } catch (error) { process.stderr.write(String(error?.message ?? error) + "\\n"); process.kill(process.pid, "SIGTERM"); }`
    : scenario === "composition-failure"
      ? `throw new Error("composition_construction_failed")`
      : scenario === "withheld-contain-ack"
        ? `try { await session.arm({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 100, privateFrame: new Uint8Array([1]) }); await session.contain({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 50, role: "player_host" }); throw new Error("unexpected_contain_success"); } catch (error) { process.stderr.write(String(error?.message ?? error) + "\\n"); process.kill(process.pid, "SIGTERM"); }`
        : scenario === "expired-launch"
            ? `try { await session.arm({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 100, privateFrame: new Uint8Array([1]) }); await session.launch({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, deadlineUnixMs: Date.now() - 1, role: "player_host", privateFrame: new Uint8Array([2]) }); throw new Error("unexpected_launch_success"); } catch (error) { process.stderr.write(String(error?.message ?? error) + "\\n"); process.kill(process.pid, "SIGTERM"); }`
            : scenario === "overhorizon-launch"
              ? `try { await session.arm({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 100, privateFrame: new Uint8Array([1]) }); await session.launch({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, deadlineUnixMs: Date.now() + 600000, role: "player_host", privateFrame: new Uint8Array([2]) }); throw new Error("unexpected_launch_success"); } catch (error) { process.stderr.write(String(error?.message ?? error) + "\\n"); process.kill(process.pid, "SIGTERM"); }`
              : scenario === "peer-disconnect"
                ? `try { await session.arm({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 100, privateFrame: new Uint8Array([1]) }); throw new Error("unexpected_arm_success"); } catch (error) { process.stderr.write(String(error?.message ?? error) + "\\n"); process.kill(process.pid, "SIGTERM"); }`
                : scenario === "delayed-arm-ack"
                  ? `try { await session.arm({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 100, privateFrame: new Uint8Array([1]) }); throw new Error("unexpected_arm_success"); } catch (error) { process.stderr.write(String(error?.message ?? error) + "\\n"); process.kill(process.pid, "SIGTERM"); }`
                  : `try { await session.arm({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: ${scenario === "withheld-arm-ack" ? 50 : 123}, ${scenario === "malformed-arm" ? `deadlineUnixMs: Date.now() + 60000, ` : ""}privateFrame: new Uint8Array([1]) }); throw new Error("unexpected_arm_success"); } catch (error) { process.stderr.write(String(error?.message ?? error) + "\\n"); process.kill(process.pid, "SIGTERM"); }`;
  const setup = scenario === "ack-write-failure"
    ? `process.stdout.end = (() => { process.nextTick(() => process.stdout.emit("error", new Error("ack_write_failed"))); return process.stdout; });`
    : scenario === "termination-failure"
      ? `const originalProcessOnce = process.once.bind(process); process.once = ((event, listener) => { if (event === "SIGTERM") throw new Error("termination_failed"); return originalProcessOnce(event, listener); });`
      : "";
  // The composition mock runs the session operations only for scenarios that
  // must exercise the authenticated wire. ack-write/termination scenarios keep
  // the mock inert so the failure under test is observable before any op.
  const composition = scenario === "composition-failure"
     ? `createDesktopProductComposition() { throw new Error("composition_construction_failed"); }`
     : scenario === "ack-write-failure" || scenario === "termination-failure"
       ? `createDesktopProductComposition(_rootLayoutCapability, session) { return { async close() { await session.close(); } }; }`
       : `createDesktopProductComposition(_rootLayoutCapability, session, assemblyInput) { process.stderr.write("wire_assembly_surface:" + (assemblyInput?.surface === undefined ? "default" : assemblyInput.surface) + "\\n"); assemblyInput?.publishLaunchUrl?.("http://127.0.0.1:4444/#profile=reference&boot=fixture"); process.stderr.write("wire_publish_ready:called\\n"); const operationTask = (async () => { ${operation} })(); return { async close() { await operationTask; await session.close(); } }; }`;
  return `${setup}\nimport { mock } from "node:test";\nawait mock.module(${JSON.stringify(compositionUrl)}, { namedExports: { ${composition} } });\nconst { runDesktopHostBootstrap } = await import(${JSON.stringify(bootstrapUrl)});\ntry { await runDesktopHostBootstrap(${JSON.stringify(moduleDirectory)}); } catch (error) { process.stderr.write(String((error instanceof Error ? error.message : error) ?? "desktop_runtime_bootstrap_unavailable") + "\\n"); process.exit(1); }`;
}

function collectFirstLine(stream: NodeJS.ReadableStream, child?: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolveLine, rejectLine) => { let data = ""; stream.on("data", (chunk) => { data += chunk.toString(); const index = data.indexOf("\n"); if (index >= 0) resolveLine(data.slice(0, index)); }); stream.once("error", rejectLine); child?.once("close", (code) => { if (code !== 0) rejectLine(new Error(`wire_worker_exit_${code}`)); }); });
}

function collectBounded(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolveOutput) => { let data = ""; stream.on("data", (chunk) => { data = (data + chunk.toString()).slice(-4096); }); stream.once("close", () => resolveOutput(data)); });
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolveClose, rejectClose) => { child.once("error", rejectClose); child.once("close", resolveClose); });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout_${label}`)), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

test("desktop bootstrap helper remains private and has no entrypoint", async () => {
  const source = await readFile(resolve(sourceRoot, "bootstrap", "wire", "desktop-runtime-bootstrap.internal.ts"), "utf8");

  assert.match(source, /export async function runDesktopHostBootstrap\(moduleDirectory: string\)/);
  assert.doesNotMatch(source, /import.meta.main/);
  assert.doesNotMatch(source, /desktop-host-entry.internal.js/);
   assert.match(source, /createDesktopProductCompositionForBootstrap\(rootAuthority, guardianAuthority, assemblyInput\)/);
  assert.match(source, /new WeakSet<object>\(\)/);
  assert.match(source, /new WeakMap<object, DesktopRootLayout>\(\)/);
  assert.match(source, /consumeDesktopRootLayoutCapability\(rootAuthority\)/);
  // The Host-owned env seam selects the composed surface and the narrative-gate
  // marker nonce digest; every invalid value fails closed before any guardian contact.
  assert.match(source, /GAMEBUDDY_HOST_SURFACE/);
  assert.match(source, /surface !== "composed-reference-game"/);
  assert.match(source, /GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256/);
  assert.ok(source.includes('/^[a-f0-9]{64}$/.test(tavernNarrativeGateNonceSha256)'));
  // The composed launch URL is published over the child IPC channel only; the
  // production Desktop spawn carries no IPC channel so the publication is a no-op.
  assert.match(source, /gamebuddy-desktop-composition-ready\/v1/);
  assert.match(source, /typeof process\.send !== "function" \|\| process\.connected !== true\)/);
  assert.match(source, /consumeDesktopGuardianSessionCapability\(guardianAuthority\)/);
  assert.doesNotMatch(source, /stardew/);
  assert.doesNotMatch(source, /stardew-production-lifecycle-coordinator/);
  assert.doesNotMatch(source, /stardew-player-host-process-owner/);
  assert.doesNotMatch(source, /stardew-ai-client-process-owner/);
  assert.doesNotMatch(source, /node:child_process/);
   const compositionCallIndex = source.indexOf("createDesktopProductCompositionForBootstrap(rootAuthority, guardianAuthority, assemblyInput)");
  const acknowledgementIndex = source.indexOf("await writeAcknowledgement(frame)");
  assert.ok(compositionCallIndex >= 0);
  assert.ok(acknowledgementIndex >= 0);
  assert.ok(compositionCallIndex < acknowledgementIndex);
  assert.ok(source.indexOf("consumeDesktopRootLayoutCapability(rootAuthority)") >= 0);
  assert.doesNotMatch(source, /export (function|async function) (mint|create|consume)Desktop/);
  assert.doesNotMatch(source, /DesktopGuardianSession(?:Capability|Binding)?\s*\}\s*from/);
  assert.doesNotMatch(source, /installDesktopGuardianSessionFactoryForTest/);
  // The composition call site inside runDesktopHostBootstrap precedes the
  // acknowledgement: the formal bootstrap builds the product composition
  // before publishing bootstrap readiness.
  // The composition must stay a static binding: a deferred relative dynamic
  // import would be rejected by the production artifact validator, and the
  // release closure already weaves the whole product chain at build time.
  assert.match(source, /from "\.\.\/\.\.\/composition\/desktop-host-composition\.js"/);
  assert.doesNotMatch(source, /await import\("\.\.\/\.\.\/composition/);
});

function findPackageRoot(directory: string): string {
  let candidate = directory;
  while (!existsSync(resolve(candidate, "package.json"))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("desktop_bootstrap_test_package_root_not_found");
    candidate = parent;
  }
  return candidate;
}

/**
 * The recovery conversation is a pure protocol: the five frames, their exact
 * ordinal key order, the four acknowledgement positions and the durable
 * callbacks are asserted against a recording transport, so no socket, named
 * pipe, Windows root layout or production artifact is involved.
 */
const recoveryBinding = Object.freeze({ bootstrapId: "a".repeat(64), generation: "generation-1", inventoryDigest: "b".repeat(64), runtimeAdmissionSha256: "c".repeat(64) });
const recoveryCorrelation = Object.freeze({ guardianInstanceId: "11111111-1111-4111-8111-111111111111", guardianEpoch: 1, attemptId: "22222222-2222-4222-8222-222222222222" });
const recoveryInstance = "33333333-3333-4333-8333-333333333333";
const recoveryPreCas = new TextEncoder().encode('{"guardianInstanceId":"11111111-1111-4111-8111-111111111111","guardianEpoch":1,"attemptId":"22222222-2222-4222-8222-222222222222","bindingRevision":"44444444-4444-4444-8444-444444444444","leaseName":"Local\\GameBuddy-Lease-1"}');
const recoveryPostCas = new TextEncoder().encode('{"ownerRecordRevision":2}');

/** The exact ordinal key sequence `DesktopHostBootstrapBroker.ExactObject` compares. */
const recoveryFrameKeys = (...trailing: readonly string[]): readonly string[] => [
  "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256",
  "operationWaitBudgetMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId", ...trailing,
];

function recoveryAcknowledgement(status: string, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { schema: "gamebuddy-desktop-guardian-session/v1", protocolVersion: 1, operation: "recover_attempt", status, ...recoveryBinding, ...recoveryCorrelation, recoveryInstanceId: recoveryInstance, ...overrides };
}

function recoveryHarness(acknowledgements: readonly Readonly<Record<string, unknown>>[]): Readonly<{
  transport: DesktopGuardianRecoveryTransport;
  events: string[];
  frames: Array<Record<string, unknown>>;
}> {
  const events: string[] = [];
  const frames: Array<Record<string, unknown>> = [];
  const pending = [...acknowledgements];
  const transport: DesktopGuardianRecoveryTransport = Object.freeze({
    write: (frame) => { events.push(`write:${String(frame.operation)}`); frames.push({ ...frame }); },
    receive: () => {
      // Fails closed instead of hanging: a conversation that waits for an
      // acknowledgement the broker would never write is a protocol violation.
      events.push("receive");
      const acknowledgement = pending.shift();
      return acknowledgement === undefined ? Promise.reject(new Error("unexpected_receive")) : Promise.resolve(acknowledgement);
    },
  });
  return { transport, events, frames };
}

/** The conversation one test drives; every durable step is recorded in `events` in place. */
function recoveryInput(events: string[]): DesktopGuardianRecovery {
  return Object.freeze({
    guardianInstanceId: recoveryCorrelation.guardianInstanceId,
    guardianEpoch: recoveryCorrelation.guardianEpoch,
    attemptId: recoveryCorrelation.attemptId,
    operationWaitBudgetMs: 1_000,
    recoveryInstanceId: recoveryInstance,
    preCasFrame: recoveryPreCas,
    beginRecovery: async (): Promise<Uint8Array> => { events.push("beginRecovery"); return recoveryPostCas; },
    roleContained: async (role: GuardianRecoveryRole): Promise<void> => { events.push(`roleContained:${role}`); },
  });
}

test("recovery conversation writes the five Desktop frames in exact ordinal key order and reaches containment", async () => {
  const harness = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("player_contained"),
    recoveryAcknowledgement("ai_contained"),
    recoveryAcknowledgement("contained"),
  ]);
  const outcome = await driveGuardianRecoveryConversation(harness.transport, recoveryBinding, recoveryInput(harness.events));

  assert.deepEqual(outcome, { outcome: "contained" });
  assert.deepEqual(harness.frames.map((frame) => frame.operation), [
    "recover_attempt",
    "recovery_post_cas",
    "recover_attempt",
    "recovery_role_cas_ack",
    "recovery_role_cas_ack",
    "recovery_finalize_ack",
    "release",
  ]);
  const gate = harness.frames[0]!;
  const postCas = harness.frames[1]!;
  const recover = harness.frames[2]!;
  const playerCas = harness.frames[3]!;
  const aiCas = harness.frames[4]!;
  const finalize = harness.frames[5]!;
  const release = harness.frames[6]!;
  // The Desktop compares the key SEQUENCE, so the ordinal order is protocol, not
  // formatting: the bounded wait precedes the correlation, and the private body
  // or the role follows the recovery actor.
  assert.deepEqual(Object.keys(gate), recoveryFrameKeys("privateFrame"));
  assert.deepEqual(Object.keys(postCas), recoveryFrameKeys("privateFrame"));
  assert.deepEqual(Object.keys(recover), recoveryFrameKeys());
  assert.deepEqual(Object.keys(playerCas), recoveryFrameKeys("role"));
  assert.deepEqual(Object.keys(aiCas), recoveryFrameKeys("role"));
  assert.deepEqual(Object.keys(finalize), recoveryFrameKeys());
  assert.deepEqual(Object.keys(release), recoveryFrameKeys());
  // Only the two recovery bodies are private frames: the broker rebuilds the
  // native recover attempt from the correlation, so that frame carries none.
  assert.equal(Object.hasOwn(recover, "privateFrame"), false);
  assert.equal(Object.hasOwn(finalize, "privateFrame"), false);
  assert.equal(Object.hasOwn(release, "privateFrame"), false);
  // The bytes the native ingress validates are exactly the frames the durable
  // steps produced, not a re-encoding of them.
  assert.deepEqual(Buffer.from(String(gate.privateFrame), "base64url"), Buffer.from(recoveryPreCas));
  assert.deepEqual(Buffer.from(String(postCas.privateFrame), "base64url"), Buffer.from(recoveryPostCas));
  assert.equal(String(recover.privateFrame ?? ""), "");
  // The recovery wire names the OS roles `playerHost`/`aiClient`; the containment
  // spelling belongs to arm/launch/contain and must never appear here.
  assert.deepEqual(harness.frames.filter((frame) => frame.role !== undefined).map((frame) => frame.role), ["playerHost", "aiClient"]);
  // Every durable step runs in the only order the broker accepts: the recovering
  // CAS strictly after the gate acknowledgement, each role durably recorded
  // before its CAS acknowledgement, and the waiter installed before the frames it
  // answers. One acknowledgement answers the post-CAS and native recover frames,
  // which is why this conversation cannot use the single request/ack helper.
  assert.deepEqual(harness.events, [
    "receive",
    "write:recover_attempt",
    "beginRecovery",
    "receive",
    "write:recovery_post_cas",
    "write:recover_attempt",
    "roleContained:playerHost",
    "receive",
    "write:recovery_role_cas_ack",
    "roleContained:aiClient",
    "receive",
    "write:recovery_role_cas_ack",
    "write:recovery_finalize_ack",
    "write:release",
  ]);
});

/**
 * The durable role CAS error token that means "this record already holds this role
 * as contained" (`containRecoveringRole`, stardew-private-bootstrap-composer.core).
 * A resumed recovery meets it for every role the crashed conversation had already
 * recorded before its CAS acknowledgement was written.
 */
const recoveryRoleAlreadyContained = "stardew_bootstrap_owner_recovery_role_already_contained";

/** The same conversation input, with the durable role step replaced by the test's own. */
function resumedRecoveryInput(events: string[], roleContained: (role: GuardianRecoveryRole) => Promise<void>): DesktopGuardianRecovery {
  return Object.freeze({ ...recoveryInput(events), roleContained });
}

test("recovery completes a resume whose first role the record already holds as contained", async () => {
  const harness = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("player_contained"),
    recoveryAcknowledgement("ai_contained"),
    recoveryAcknowledgement("contained"),
  ]);
  // The crash happened after the Player role's durable CAS and before its CAS
  // acknowledgement, so the native side classifies that role contained again while
  // the durable record already holds it and refuses the transition.
  const outcome = await driveGuardianRecoveryConversation(harness.transport, recoveryBinding, resumedRecoveryInput(harness.events, async (role) => {
    harness.events.push(`roleContained:${role}`);
    if (role === "playerHost") throw new Error(recoveryRoleAlreadyContained);
  }));

  assert.deepEqual(outcome, { outcome: "contained" });
  // The remaining role is still durably recorded, and the resume repeats nothing:
  // the frames and durable steps are exactly the ones an uninterrupted
  // conversation produces, so no native step and no frame is retried.
  assert.deepEqual(harness.events, [
    "receive",
    "write:recover_attempt",
    "beginRecovery",
    "receive",
    "write:recovery_post_cas",
    "write:recover_attempt",
    "roleContained:playerHost",
    "receive",
    "write:recovery_role_cas_ack",
    "roleContained:aiClient",
    "receive",
    "write:recovery_role_cas_ack",
    "write:recovery_finalize_ack",
    "write:release",
  ]);
  assert.deepEqual(harness.frames.map((frame) => frame.operation), [
    "recover_attempt",
    "recovery_post_cas",
    "recover_attempt",
    "recovery_role_cas_ack",
    "recovery_role_cas_ack",
    "recovery_finalize_ack",
    "release",
  ]);
});

test("recovery completes a resume whose every recorded role is already contained", async () => {
  // The crash happened after the AI role's durable CAS and before the finalize
  // acknowledgement, so both roles are already recorded and both are refused.
  const harness = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("player_contained"),
    recoveryAcknowledgement("ai_contained"),
    recoveryAcknowledgement("contained"),
  ]);
  const outcome = await driveGuardianRecoveryConversation(harness.transport, recoveryBinding, resumedRecoveryInput(harness.events, async (role) => {
    harness.events.push(`roleContained:${role}`);
    throw new Error(recoveryRoleAlreadyContained);
  }));

  assert.deepEqual(outcome, { outcome: "contained" });
  assert.deepEqual(harness.frames.map((frame) => frame.operation), [
    "recover_attempt",
    "recovery_post_cas",
    "recover_attempt",
    "recovery_role_cas_ack",
    "recovery_role_cas_ack",
    "recovery_finalize_ack",
    "release",
  ]);
  assert.deepEqual(harness.events.filter((event) => event.startsWith("roleContained")), ["roleContained:playerHost", "roleContained:aiClient"]);
});

test("recovery still fails closed on a durable role CAS that was not already recorded", async () => {
  // A role the record never accepted is not a containment: the refused CAS must
  // stop the conversation before that role's acknowledgement and never reach a
  // terminal frame.
  const playerRefused = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("player_contained"),
    recoveryAcknowledgement("ai_contained"),
  ]);
  await assert.rejects(
    () => driveGuardianRecoveryConversation(playerRefused.transport, recoveryBinding, resumedRecoveryInput(playerRefused.events, async (role) => {
      playerRefused.events.push(`roleContained:${role}`);
      throw new Error("stardew_bootstrap_owner_transition_mismatch");
    })),
    /stardew_bootstrap_owner_transition_mismatch/,
  );
  assert.deepEqual(playerRefused.frames.map((frame) => frame.operation), ["recover_attempt", "recovery_post_cas", "recover_attempt"]);
  assert.deepEqual(playerRefused.events.filter((event) => event.startsWith("roleContained")), ["roleContained:playerHost"]);

  // Tolerating the first role's already-recorded CAS must not make the second
  // role's refusal tolerable: the Player acknowledgement is written, and nothing
  // after it is.
  const aiRefused = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("player_contained"),
    recoveryAcknowledgement("ai_contained"),
  ]);
  await assert.rejects(
    () => driveGuardianRecoveryConversation(aiRefused.transport, recoveryBinding, resumedRecoveryInput(aiRefused.events, async (role) => {
      aiRefused.events.push(`roleContained:${role}`);
      if (role === "aiClient") throw new Error("stardew_bootstrap_owner_transition_mismatch");
      throw new Error(recoveryRoleAlreadyContained);
    })),
    /stardew_bootstrap_owner_transition_mismatch/,
  );
  assert.deepEqual(aiRefused.frames.map((frame) => frame.operation), ["recover_attempt", "recovery_post_cas", "recover_attempt", "recovery_role_cas_ack"]);
  assert.deepEqual(aiRefused.events.filter((event) => event.startsWith("roleContained")), ["roleContained:playerHost", "roleContained:aiClient"]);
});

test("recovery reads the shared `unavailable` status by position, never by its text", async () => {
  // At the gate position the same text means the Guardian refused to open the
  // gate: the previous lease stays authority and no durable CAS may run.
  const held = recoveryHarness([recoveryAcknowledgement("unavailable")]);
  assert.deepEqual(await driveGuardianRecoveryConversation(held.transport, recoveryBinding, recoveryInput(held.events)), { outcome: "gate_held" });
  assert.deepEqual(held.frames.map((frame) => frame.operation), ["recover_attempt"]);
  assert.deepEqual(held.events, ["receive", "write:recover_attempt"]);

  // At a role position it is a native classification: the recovery ran and that
  // exact role was not contained.
  const playerFailed = recoveryHarness([recoveryAcknowledgement("recovery_accepted"), recoveryAcknowledgement("unavailable")]);
  assert.deepEqual(await driveGuardianRecoveryConversation(playerFailed.transport, recoveryBinding, recoveryInput(playerFailed.events)), { outcome: "role_classified", role: "playerHost", classification: "unavailable" });
  assert.deepEqual(playerFailed.frames.map((frame) => frame.operation), ["recover_attempt", "recovery_post_cas", "recover_attempt"]);
  assert.deepEqual(playerFailed.events.filter((event) => event.startsWith("roleContained")), []);

  const aiFailed = recoveryHarness([recoveryAcknowledgement("recovery_accepted"), recoveryAcknowledgement("player_contained"), recoveryAcknowledgement("quarantined")]);
  assert.deepEqual(await driveGuardianRecoveryConversation(aiFailed.transport, recoveryBinding, recoveryInput(aiFailed.events)), { outcome: "role_classified", role: "aiClient", classification: "quarantined" });
  // Only the Player role was acknowledged, so only it reached durable
  // containment; the AI role's CAS acknowledgement is never written.
  assert.deepEqual(aiFailed.events.filter((event) => event.startsWith("roleContained")), ["roleContained:playerHost"]);
  assert.deepEqual(aiFailed.frames.map((frame) => frame.operation), ["recover_attempt", "recovery_post_cas", "recover_attempt", "recovery_role_cas_ack"]);
});

test("recovery rejects an acknowledgement the broker would never write at that position", async () => {
  const withoutActor = recoveryAcknowledgement("recovery_accepted");
  delete withoutActor.recoveryInstanceId;
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<Readonly<Record<string, unknown>>>]> = [
    ["gate acknowledgement carrying a containment role", [recoveryAcknowledgement("recovery_accepted", { role: "player_host" })]],
    ["gate acknowledgement without the recovery actor", [withoutActor]],
    ["gate acknowledgement for another recovery actor", [recoveryAcknowledgement("recovery_accepted", { recoveryInstanceId: "55555555-5555-4555-8555-555555555555" })]],
    ["gate acknowledgement for another attempt", [recoveryAcknowledgement("recovery_accepted", { attemptId: "66666666-6666-4666-8666-666666666666" })]],
    ["gate acknowledgement for another guardian epoch", [recoveryAcknowledgement("recovery_accepted", { guardianEpoch: 2 })]],
    ["gate acknowledgement from the role CAS operation", [recoveryAcknowledgement("recovery_accepted", { operation: "recovery_role_cas_ack" })]],
    ["gate position answered with a role containment status", [recoveryAcknowledgement("player_contained")]],
    ["role position answered with a gate status", [recoveryAcknowledgement("recovery_accepted"), recoveryAcknowledgement("recovery_accepted")]],
    ["terminal position answered with a role status", [recoveryAcknowledgement("recovery_accepted"), recoveryAcknowledgement("player_contained"), recoveryAcknowledgement("ai_contained"), recoveryAcknowledgement("ai_contained")]],
    ["terminal position answered with the gate-held status", [recoveryAcknowledgement("recovery_accepted"), recoveryAcknowledgement("player_contained"), recoveryAcknowledgement("ai_contained"), recoveryAcknowledgement("unavailable")]],
  ];
  for (const [label, acknowledgements] of cases) {
    const harness = recoveryHarness(acknowledgements);
    await assert.rejects(
      () => driveGuardianRecoveryConversation(harness.transport, recoveryBinding, recoveryInput(harness.events)),
      /desktop_runtime_bootstrap_unavailable/,
      label,
    );
  }
});

test("recovery refuses malformed input and a missing post-CAS binding without inventing an outcome", async () => {
  const harness = recoveryHarness([recoveryAcknowledgement("recovery_accepted")]);
  const input = recoveryInput(harness.events);
  // A recovery actor the native ingress cannot parse, an empty gate body, and a
  // zero wait budget are all refused before any frame reaches the wire.
  await assert.rejects(() => driveGuardianRecoveryConversation(harness.transport, recoveryBinding, { ...input, recoveryInstanceId: "gamebuddy-stardew-token" }), /desktop_runtime_bootstrap_unavailable/);
  await assert.rejects(() => driveGuardianRecoveryConversation(harness.transport, recoveryBinding, { ...input, preCasFrame: new Uint8Array(0) }), /desktop_runtime_bootstrap_unavailable/);
  await assert.rejects(() => driveGuardianRecoveryConversation(harness.transport, recoveryBinding, { ...input, operationWaitBudgetMs: 0 }), /desktop_runtime_bootstrap_unavailable/);
  assert.deepEqual(harness.frames, []);
  assert.deepEqual(harness.events, []);

  // A durable CAS that produced no post-CAS binding cannot be continued: the
  // native ingress would refuse the frame, so the conversation stops after the
  // gate frame instead of writing an empty binding.
  const shortCas = recoveryHarness([recoveryAcknowledgement("recovery_accepted")]);
  await assert.rejects(
    () => driveGuardianRecoveryConversation(shortCas.transport, recoveryBinding, { ...recoveryInput(shortCas.events), beginRecovery: async () => new Uint8Array(0) }),
    /desktop_runtime_bootstrap_unavailable/,
  );
  assert.deepEqual(shortCas.frames.map((frame) => frame.operation), ["recover_attempt"]);
});
