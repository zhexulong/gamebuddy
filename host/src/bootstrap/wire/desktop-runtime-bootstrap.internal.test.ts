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
  assert.ok(result.stderr.length >= 0);
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

async function runWireFixture(scenario: "success" | "malformed-arm" | "withheld-arm-ack" | "delayed-arm-ack" | "withheld-contain-ack" | "expired-launch" | "overhorizon-launch" | "peer-disconnect" | "composition-failure" | "ack-write-failure" | "termination-failure"): Promise<{ requests: Record<string, unknown>[]; acknowledgement?: string; stderr: string; guardianClosed: boolean; armReceiptAt?: number; workerClosedAt?: number }> {
  const fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-wire-"));
  const bootstrapId = (scenario === "success" ? "d" : scenario === "malformed-arm" ? "c" : scenario === "withheld-arm-ack" ? "b" : scenario === "delayed-arm-ack" ? "7" : scenario === "withheld-contain-ack" ? "a" : scenario === "expired-launch" ? "9" : scenario === "overhorizon-launch" ? "6" : "8").repeat(64);
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
  let operationsResolve!: () => void;
  const operationsComplete = new Promise<void>((resolve) => { operationsResolve = resolve; });
  let worker: ReturnType<typeof spawn> | undefined;
  let peerError: Error | undefined;
  let armReceiptAt: number | undefined;
  let guardianClosed = false;
  let guardianClosedResolve!: () => void;
  const guardianPeerClosed = new Promise<void>((resolve) => { guardianClosedResolve = resolve; });
  const server = createServer((socket) => {
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
    worker = spawn(process.execPath, ["--experimental-test-module-mocks", workerPath], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LOCALAPPDATA: fixtureRoot, GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST: manifestPath, GAMEBUDDY_HOST_GAME_SESSION_MODE: "known" } });
    const workerClose = waitForClose(worker);
    const failureScenario = scenario === "composition-failure" || scenario === "ack-write-failure" || scenario === "termination-failure";
    const output = failureScenario ? undefined : collectFirstLine(worker.stdout!, worker);
    const stderr = collectBounded(worker.stderr!);
    let workerStderr = "";
    worker.stderr!.on("data", (chunk: Buffer) => { workerStderr = (workerStderr + chunk.toString()).slice(-4096); });
    worker.stdin!.end(`${JSON.stringify({ schema: "gamebuddy-desktop-host-bootstrap/v1", protocolVersion: 1, bootstrapId, generation: "g-wire", inventoryDigest: "e".repeat(64), runtimeAdmissionSha256: "f".repeat(64), rootLayout })}\n`);
    const acknowledgement = output === undefined ? undefined : await withTimeout(output, 10_000, "bootstrap acknowledgement").catch((error) => { throw new Error(`${error.message}; worker=${worker?.exitCode ?? "running"}/${worker?.signalCode ?? "none"}; stderr=${workerStderr || "<empty>"}; peer=${peerError?.message ?? "none"}; operations=${requests.map((request) => String(request.operation)).join(",") || "<none>"}`); });
    if (failureScenario) {
      await withTimeout(workerClose, 2_000, `${scenario} rejection`);
      await withTimeout(guardianPeerClosed, 2_000, `${scenario} guardian cleanup`);
    } else if (scenario === "success") {
      await withTimeout(operationsComplete, 10_000, "guardian operations");
      worker.kill("SIGTERM");
    } else if (scenario !== "malformed-arm") {
      await withTimeout(workerClose, 2_000, `${scenario} rejection`);
    }
    const workerClosedAt = scenario === "delayed-arm-ack" ? performance.now() : undefined;
    await withTimeout(workerClose, 10_000, "worker cleanup");
    return { requests, acknowledgement, stderr: await stderr, guardianClosed, armReceiptAt, workerClosedAt };
  } finally {
    if (worker !== undefined && worker.exitCode === null && !worker.killed) { worker.kill("SIGTERM"); await withTimeout(waitForClose(worker), 10_000, "worker failure cleanup").catch(() => undefined); }
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function workerSource(moduleDirectory: string, guardianInstanceId: string, attemptId: string, scenario: "success" | "malformed-arm" | "withheld-arm-ack" | "delayed-arm-ack" | "withheld-contain-ack" | "expired-launch" | "overhorizon-launch" | "peer-disconnect" | "composition-failure" | "ack-write-failure" | "termination-failure"): string {
  const bootstrapUrl = pathToFileURL(join(moduleDirectory, "bootstrap", "wire", "desktop-runtime-bootstrap.internal.js")).href;
  const compositionUrl = pathToFileURL(join(moduleDirectory, "composition", "desktop-host-composition.js")).href;
  const operation = scenario === "success"
    ? `await session.arm({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 123, privateFrame: new Uint8Array([1]) }); await session.launch({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, deadlineUnixMs: Date.now() + 60000, role: "player_host", privateFrame: new Uint8Array([2]) }); await session.contain({ guardianInstanceId: ${JSON.stringify(guardianInstanceId)}, guardianEpoch: 1, attemptId: ${JSON.stringify(attemptId)}, operationWaitBudgetMs: 123, role: "player_host" });`
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
       : `createDesktopProductComposition(_rootLayoutCapability, session) { const operationTask = (async () => { ${operation} })(); return { async close() { await operationTask; await session.close(); } }; }`;
  return `${setup}\nimport { mock } from "node:test";\nawait mock.module(${JSON.stringify(compositionUrl)}, { namedExports: { ${composition} } });\nconst { runDesktopHostBootstrap } = await import(${JSON.stringify(bootstrapUrl)});\nawait runDesktopHostBootstrap(${JSON.stringify(moduleDirectory)});`;
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

function findSourceRoot(directory: string): string {
  let candidate = directory;
  while (!existsSync(resolve(candidate, "src"))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("desktop_bootstrap_helper_test_source_not_found");
    candidate = parent;
  }
  return resolve(candidate, "src");
}
