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

async function runWireFixture(scenario: "success" | "shutdown-request" | "shutdown-malformed" | "missing-arm-executable" | "malformed-arm" | "withheld-arm-ack" | "delayed-arm-ack" | "withheld-contain-ack" | "expired-launch" | "overhorizon-launch" | "peer-disconnect" | "composition-failure" | "ack-write-failure" | "termination-failure" | "invalid-surface" | "invalid-nonce", options: Readonly<{ surface?: string; nonceSha256?: string }> = {}): Promise<{ requests: Record<string, unknown>[]; acknowledgement: string | undefined; stderr: string; guardianClosed: boolean; armReceiptAt: number | undefined; workerClosedAt: number | undefined; workerExitCode: number | null; workerExitedNaturally: boolean }> {
  const fixturesWithIpc = scenario === "shutdown-request" || scenario === "shutdown-malformed";
  const fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-wire-"));
  const bootstrapId = (scenario === "success" ? "d" : scenario === "missing-arm-executable" ? "5" : scenario === "malformed-arm" ? "c" : scenario === "withheld-arm-ack" ? "b" : scenario === "delayed-arm-ack" ? "7" : scenario === "withheld-contain-ack" ? "a" : scenario === "expired-launch" ? "9" : scenario === "overhorizon-launch" ? "6" : scenario === "invalid-surface" ? "2" : scenario === "invalid-nonce" ? "3" : "8").repeat(64);
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
    } else if (scenario === "success") {
      await withTimeout(operationsComplete, 10_000, "guardian operations");
      worker.kill("SIGTERM");
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

function workerSource(moduleDirectory: string, guardianInstanceId: string, attemptId: string, scenario: "success" | "shutdown-request" | "shutdown-malformed" | "missing-arm-executable" | "malformed-arm" | "withheld-arm-ack" | "delayed-arm-ack" | "withheld-contain-ack" | "expired-launch" | "overhorizon-launch" | "peer-disconnect" | "composition-failure" | "ack-write-failure" | "termination-failure" | "invalid-surface" | "invalid-nonce"): string {
  const bootstrapUrl = pathToFileURL(join(moduleDirectory, "bootstrap", "wire", "desktop-runtime-bootstrap.internal.js")).href;
  const compositionUrl = pathToFileURL(join(moduleDirectory, "composition", "desktop-host-composition.js")).href;
  const platformUrl = pathToFileURL(join(moduleDirectory, "composition", "stardew", "stardew-guardian-platform.js")).href;
  // The fixture drives the real contained runtime platform so the recorded wire
  // arm frame is the usual approvedExecutable-carrying frame and the launch plan
  // is the native ParseLaunch encoder output (executable === approvedExecutable).
  const operation = scenario === "success" || scenario === "shutdown-request" || scenario === "shutdown-malformed"
    ? `const { createDesktopGuardianGameRuntimePlatform } = await import(${JSON.stringify(platformUrl)}); const platform = createDesktopGuardianGameRuntimePlatform(session); const approvedExecutable = "C:\\\\Program Files\\\\GameBuddy\\\\roles\\\\RoleRootFixture.exe"; const launchFacts = { executable: approvedExecutable, cwd: "C:\\\\Program Files\\\\GameBuddy", arguments: ["--signal", "C:\\\\tmp\\\\wire.txt"], environment: { PATH: "C:\\\\Windows\\\\System32", SystemRoot: "C:\\\\Windows", WINDIR: "C:\\\\Windows", TEMP: "C:\\\\Windows\\\\Temp", TMP: "C:\\\\Windows\\\\Temp", USERPROFILE: "C:\\\\Users\\\\tester", GAMEBUDDY_STARDEW_LAUNCH_GENERATION: "wire-generation" } }; await platform.arm({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 123, authorization: { role: "player_host", revision: "11111111-1111-4111-8111-111111111111", executable: approvedExecutable } }); await platform.launch({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, deadlineUnixMs: Date.now() + 60000, role: "player_host", authorization: launchFacts }); await platform.contain({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 123, role: "player_host" });`
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
