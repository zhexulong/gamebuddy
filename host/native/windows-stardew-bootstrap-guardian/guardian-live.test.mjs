import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const guardian = resolve(here, ".dist", "win-x64", "GameBuddy.WindowsStardewBootstrapGuardian.exe");
const fixture = resolve(here, ".dist", "fixtures", "RoleRootFixture.exe");
const isWindows = process.platform === "win32";
const winOnly = { skip: !isWindows ? "BLOCKED: Task 1 requires a supported Windows host" : false };
const PATH_ENVIRONMENT = { PATH: process.env.PATH ?? "C:\\Windows\\System32" };

async function mustExist(path) { await access(path, constants.X_OK); }

// This matrix is intentionally written before the native implementation. On a
// clean checkout it is red because neither executable exists yet.
test("Task 1 fixture matrix has a directly launchable fixture and Guardian", winOnly, async () => {
  await mustExist(guardian); await mustExist(fixture);
});

test("production Guardian source has no post-create assignment, breakaway, or shell fallback", async () => {
  const files = ["Program.cs", "GuardianProtocol.cs", "WindowsJobOwner.cs", "WindowsRoleLauncher.cs", "GuardianPrivateLaunchIngress.cs"];
  const source = (await Promise.all(files.map((name) => readFile(resolve(here, name), "utf8")))).join("\n");
  assert.doesNotMatch(source, /AssignProcessToJobObject|CREATE_BREAKAWAY_FROM_JOB|cmd\.exe|powershell|Process\.Start|System\.Diagnostics/);
  assert.match(source, /ProcThreadAttributeJobList/);
  assert.match(source, /CreateSuspended/);
  assert.match(source, /inheritHandles/);
});

test("fixture project is separate and contains no Stardew or bridge launch", async () => {
  const source = await readFile(resolve(here, "fixtures", "RoleRootFixture.cs"), "utf8");
  assert.doesNotMatch(source, /Stardew|SMAPI|bridge/i);
});

test("atomic membership before first user code", { ...winOnly, timeout: 35_000 }, async () => {
  await mustExist(guardian); await mustExist(fixture);
  const root = await temporaryRoot("atomic");
  const session = await startGuardianSession();
  try {
    const report = resolve(root, "first-user-code.txt");
    await session.launch("player_host", ["--signal", report]);
    await waitForFile(report);
    assert.equal(await readFile(report, "utf8"), "member=true\n");
  } finally { await session.close(); await removeRoot(root); }
});

test("role Jobs isolate Player from AI and drain AI descendants", { ...winOnly, timeout: 45_000 }, async () => {
  await mustExist(guardian); await mustExist(fixture);
  const root = await temporaryRoot("isolation");
  const session = await startGuardianSession();
  try {
    const playerReport = resolve(root, "player.txt");
    const playerHeartbeat = resolve(root, "player-heartbeat.txt");
    const aiReport = resolve(root, "ai.txt");
    const aiHeartbeat = resolve(root, "ai-heartbeat.txt");
    await session.launch("player_host", ["--signal", playerReport, "--heartbeat", playerHeartbeat]);
    await session.launch("ai_client", ["--signal", aiReport, "--heartbeat", aiHeartbeat, "--spawn-descendant"]);
    await Promise.all([waitForFile(playerReport), waitForFile(playerHeartbeat), waitForFile(aiReport), waitForFile(aiHeartbeat), waitForFile(`${aiHeartbeat}.child`)]);
    assert.equal(await readFile(playerReport, "utf8"), "member=true\n");
    assert.equal(await readFile(aiReport, "utf8"), "member=true\n");
    const playerBeforeAiContainment = await readFile(playerHeartbeat, "utf8");
    await session.contain("ai_client");
    await waitForStableFiles([aiHeartbeat, `${aiHeartbeat}.child`]);
    await waitForFileChange(playerHeartbeat, playerBeforeAiContainment);
    await session.contain("player_host");
    await waitForStableFiles([playerHeartbeat]);
  } finally { await session.close(); await removeRoot(root); }
});

test("wrong public correlation terminates fail-closed and KILL_ON_JOB_CLOSE drains the active role", { ...winOnly, timeout: 15_000 }, async () => {
  const root = await temporaryRoot("wrong-correlation-contain");
  const session = await startGuardianSession();
  try {
    const heartbeat = resolve(root, "heartbeat.txt");
    await session.launch("player_host", ["--heartbeat", heartbeat]);
    await waitForFile(heartbeat);
    session.sendPublic(session.publicCommand("contain_role", "player_host", { attemptId: crypto.randomUUID() }));
    assert.equal(await session.closesWithin(3_000), true, "invalid public containment did not terminate boundedly");
    assert.equal(session.exitCode(), 1, "invalid public containment did not return terminal fail-closed");
    await waitForStableFiles([heartbeat]);
    assert.equal(session.publicResults.includes("role_contained"), false, "invalid containment emitted role_contained");
  } finally { await session.close(); await removeRoot(root); }
});

test("same role cannot execute a second first-user-code plan", { ...winOnly, timeout: 15_000 }, async () => {
  const root = await temporaryRoot("duplicate-role");
  const session = await startGuardianSession();
  try {
    const first = resolve(root, "first.txt"); const second = resolve(root, "second.txt");
    await session.launch("player_host", ["--signal", first]);
    await waitForFile(first);
    session.submitPlan(session.plan("player_host", ["--signal", second]));
    session.sendPublic(session.publicCommand("launch_role", "player_host"));
    assert.equal(await session.closesWithin(3_000), true, "duplicate role did not fail closed");
    await expectNoFile(second, 500);
  } finally { await session.close(); await removeRoot(root); }
});

test("wrong private arm token produces no fixture effect", { ...winOnly, timeout: 15_000 }, async () => {
  const root = await temporaryRoot("wrong-token");
  const unarmed = await startUnarmedGuardian();
  try {
    unarmed.sendPublic(unarmed.publicCommand("arm_attempt"));
    const socket = await unarmed.connect();
    socket.write(JSON.stringify(unarmed.armBinding({ token: crypto.randomUUID() })) + "\n");
    assert.equal(await unarmed.closesWithin(3_000), true, "wrong token did not fail closed");
    socket.destroy();
    await expectNoFile(resolve(root, "unexpected.txt"), 500);
  } finally { await unarmed.close(); await removeRoot(root); }
});

test("wrong private plan correlation produces no fixture effect", { ...winOnly, timeout: 15_000 }, async () => {
  const root = await temporaryRoot("wrong-plan-correlation"); const session = await startGuardianSession();
  try {
    const report = resolve(root, "unexpected.txt");
    session.submitPlan(session.plan("player_host", ["--signal", report], { attemptId: crypto.randomUUID() }));
    session.sendPublic(session.publicCommand("launch_role", "player_host"));
    assert.equal(await session.closesWithin(3_000), true, "wrong plan correlation did not fail closed");
    await expectNoFile(report, 500);
  } finally { await session.close(); await removeRoot(root); }
});

test("expired private plan produces no fixture effect", { ...winOnly, timeout: 15_000 }, async () => {
  const root = await temporaryRoot("expired-plan"); const session = await startGuardianSession();
  try {
    const report = resolve(root, "unexpected.txt");
    session.submitPlan(session.plan("player_host", ["--signal", report], { deadlineUnixMs: Date.now() - 1 }));
    session.sendPublic(session.publicCommand("launch_role", "player_host"));
    assert.equal(await session.closesWithin(3_000), true, "expired plan did not fail closed");
    await expectNoFile(report, 500);
  } finally { await session.close(); await removeRoot(root); }
});

test("replayed plan cannot execute a second fixture first-user-code report", { ...winOnly, timeout: 15_000 }, async () => {
  const root = await temporaryRoot("replayed-plan"); const session = await startGuardianSession();
  try {
    const report = resolve(root, "first-user-code.txt");
    const plan = session.plan("player_host", ["--signal", report, "--exit-after-report"]);
    await session.launchPlan(plan);
    await waitForFile(report);
    session.submitPlan(plan);
    session.sendPublic(session.publicCommand("launch_role", "ai_client"));
    assert.equal(await session.closesWithin(3_000), true, "replayed plan did not fail closed");
    assert.equal(await readFile(report, "utf8"), "member=true\n", "replayed plan reached fixture user code");
  } finally { await session.close(); await removeRoot(root); }
});

test("public launch followed by stdin EOF before a private plan creates no role", { ...winOnly, timeout: 15_000 }, async () => {
  const root = await temporaryRoot("eof-before-plan"); const session = await startGuardianSession();
  try {
    session.sendPublic(session.publicCommand("launch_role", "player_host"));
    session.endPublicInput();
    assert.equal(await session.closesWithin(3_000), true, "EOF-before-plan teardown was not bounded");
    assert.equal(session.publicResults.includes("role_active"), false, "EOF-before-plan emitted role_active");
    await expectNoFile(resolve(root, "unexpected.txt"), 500);
  } finally { await session.close(); await removeRoot(root); }
});

test("naturally exited role contains without a drain timeout or false active state", { ...winOnly, timeout: 15_000 }, async () => {
  const root = await temporaryRoot("natural-exit"); const session = await startGuardianSession();
  try {
    const report = resolve(root, "exit.txt");
    await session.launch("player_host", ["--signal", report, "--exit-after-report"]);
    await waitForFile(report);
    await delay(250);
    const started = Date.now();
    await session.contain("player_host");
    assert.ok(Date.now() - started < 5_000, "empty Job containment waited as if role_active");
    assert.equal(session.publicResults.filter((result) => result === "role_active").length, 1);
  } finally { await session.close(); await removeRoot(root); }
});

test("role environment excludes Guardian control pipe and token", { ...winOnly, timeout: 15_000 }, async () => {
  const root = await temporaryRoot("environment"); const session = await startGuardianSession();
  try {
    const report = resolve(root, "environment.txt");
    await session.launch("player_host", ["--signal", report, "--environment-report", "--exit-after-report"]);
    await waitForFile(report);
    assert.equal(await readFile(report, "utf8"), "member=true\nguardian_control_environment=false\n");
  } finally { await session.close(); await removeRoot(root); }
});

test("current-user role cannot reopen its exact Job with DELETE access", { ...winOnly, timeout: 15_000 }, async () => {
  const root = await temporaryRoot("job-delete-dacl"); const session = await startGuardianSession();
  try {
    const report = resolve(root, "job-delete.txt");
    await session.launch("player_host", ["--signal", report, "--probe-job-delete", session.activeArmBinding().playerJobName, "--exit-after-report"]);
    await waitForFile(report);
    assert.equal(await readFile(report, "utf8"), "member=true\njob_delete_granted=false\n");
  } finally { await session.close(); await removeRoot(root); }
});

test("pre-existing lease, Job, and control-pipe names reject arm without adoption", { ...winOnly, timeout: 30_000 }, async (t) => {
  for (const kind of ["mutex", "job", "pipe"]) await t.test(kind, { timeout: 8_000 }, async () => {
    const root = await temporaryRoot(`collision-${kind}`);
    let holder; let server; let unarmed;
    try {
      if (kind === "pipe") {
        const controlPipe = `GameBuddyGuardian-${crypto.randomUUID()}`;
        server = net.createServer();
        await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(`\\\\.\\pipe\\${controlPipe}`, resolveListen); });
        unarmed = await startUnarmedGuardian({ controlPipe });
        unarmed.sendPublic(unarmed.publicCommand("arm_attempt"));
      } else {
        const name = `Local\\Collision-${crypto.randomUUID()}`;
        const ready = resolve(root, "holder-ready.txt");
        holder = spawn(fixture, [kind === "mutex" ? "--hold-mutex" : "--hold-job", name, "--signal", ready], { windowsHide: true, shell: false, stdio: "ignore" });
        await waitForFile(ready);
        unarmed = await startUnarmedGuardian();
        unarmed.sendPublic(unarmed.publicCommand("arm_attempt"));
        const socket = await unarmed.connect();
        const names = kind === "mutex" ? { leaseName: name } : { playerJobName: name };
        socket.write(JSON.stringify(unarmed.armBinding(names)) + "\n");
        socket.destroy();
      }
      assert.equal(await unarmed.closesWithin(3_000), true, `${kind} collision did not reject arm boundedly`);
      assert.equal(unarmed.publicResults.includes("armed"), false, `${kind} collision was adopted as armed`);
    } finally {
      await unarmed?.close(); server?.close(); holder?.kill(); await removeRoot(root);
    }
  });
});

async function startGuardianSession(options = {}) {
  const session = await startUnarmedGuardian(options);
  try {
    session.sendPublic(session.publicCommand("arm_attempt"));
    const socket = await session.connect(); session.setSocket(socket);
    const binding = session.armBinding(); session.setActiveArmBinding(binding);
    socket.write(JSON.stringify(binding) + "\n");
    assert.equal(await session.nextPrivateLine(), "accepted");
    assert.equal(await session.nextPublicResult(), "armed");
    return session;
  } catch (error) { await session.close(); throw error; }
}

async function startUnarmedGuardian({ controlPipe = `GameBuddyGuardian-${crypto.randomUUID()}` } = {}) {
  const token = crypto.randomUUID(); const guardianInstanceId = crypto.randomUUID(); const attemptId = crypto.randomUUID();
  const child = spawn(guardian, [], { cwd: projectRoot, windowsHide: true, shell: false, env: { ...process.env, GAMEBUDDY_GUARDIAN_CONTROL_PIPE: controlPipe, GAMEBUDDY_GUARDIAN_CONTROL_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] });
  const publicResults = [];
  const nextOutputLine = lineReader(child.stdout, (line) => { try { publicResults.push(JSON.parse(line).result); } catch { publicResults.push("invalid"); } });
  child.stderr.resume();
  let socket; let nextPrivateLine; let activeArmBinding;
  const publicCommand = (operation, role, overrides = {}) => ({ schemaVersion: 1, operation, guardianInstanceId, guardianEpoch: 1, attemptId, ...(role ? { role } : {}), ...overrides });
  const armBinding = (overrides = {}) => ({ token, guardianInstanceId, guardianEpoch: 1, attemptId, revision: crypto.randomUUID(), leaseName: `Local\\Lease-${crypto.randomUUID()}`, playerJobName: `Local\\Player-${crypto.randomUUID()}`, aiJobName: `Local\\Ai-${crypto.randomUUID()}`, ...overrides });
  const plan = (role, arguments_, overrides = {}) => ({ guardianInstanceId, guardianEpoch: 1, attemptId, planId: crypto.randomUUID(), role, deadlineUnixMs: Date.now() + 30_000, executable: fixture, cwd: projectRoot, arguments: arguments_, environment: PATH_ENVIRONMENT, ...overrides });
  return {
    publicResults, publicCommand, armBinding, plan,
    connect: async () => await connectPipe(`\\\\.\\pipe\\${controlPipe}`, child),
    setSocket(value) { socket = value; nextPrivateLine = lineReader(socket); },
    setActiveArmBinding(value) { activeArmBinding = Object.freeze({ ...value }); },
    activeArmBinding() { if (activeArmBinding === undefined) throw new Error("guardian arm binding unavailable"); return activeArmBinding; },
    nextPrivateLine: async () => await nextPrivateLine(),
    nextPublicResult: async () => JSON.parse(await nextOutputLine()).result,
    sendPublic(command) { child.stdin.write(JSON.stringify(command) + "\n"); },
    endPublicInput() { child.stdin.end(); },
    submitPlan(value) { socket.write(JSON.stringify(value) + "\n"); },
    async launchPlan(value) { this.submitPlan(value); this.sendPublic(this.publicCommand("launch_role", value.role)); assert.equal(await this.nextPrivateLine(), "accepted"); assert.equal(await this.nextPublicResult(), "role_active"); },
    async launch(role, arguments_) { await this.launchPlan(this.plan(role, arguments_)); },
    async contain(role) { this.sendPublic(this.publicCommand("contain_role", role)); assert.equal(await this.nextPublicResult(), "role_contained"); },
    closesWithin: async (milliseconds) => await closesWithin(child, milliseconds),
    exitCode: () => child.exitCode,
    close: async () => { socket?.destroy(); if (!child.stdin.destroyed) child.stdin.end(); if (!await closesWithin(child, 2_000)) { child.kill(); await closesWithin(child, 2_000); } },
  };
}

function lineReader(stream, onLine = () => {}) {
  let buffered = ""; const lines = []; const waiters = []; let terminalError;
  const deliver = () => { while (lines.length && waiters.length) waiters.shift().resolve(lines.shift()); if (terminalError) while (waiters.length) waiters.shift().reject(terminalError); };
  stream.on("data", (chunk) => { buffered += String(chunk); for (;;) { const index = buffered.indexOf("\n"); if (index < 0) break; const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); onLine(line); lines.push(line); } deliver(); });
  stream.once("error", (error) => { terminalError = error; deliver(); }); stream.once("end", () => { terminalError ??= new Error("stream ended before line"); deliver(); });
  return () => lines.length ? Promise.resolve(lines.shift()) : terminalError ? Promise.reject(terminalError) : new Promise((resolveLine, rejectLine) => waiters.push({ resolve: resolveLine, reject: rejectLine }));
}
function onceEvent(emitter, event) { return new Promise((resolveEvent, rejectEvent) => { const onError = (error) => { emitter.off(event, onEvent); rejectEvent(error); }; const onEvent = (...args) => { emitter.off("error", onError); resolveEvent(args); }; emitter.once(event, onEvent); emitter.once("error", onError); }); }
async function connectPipe(path, child) { let last; for (let attempt = 0; attempt < 800; attempt++) { if (child.exitCode !== null) throw new Error("Guardian exited before private pipe"); const socket = net.createConnection({ path }); try { await onceEvent(socket, "connect"); return socket; } catch (error) { last = error; socket.destroy(); if (error?.code !== "ENOENT") throw error; await delay(25); } } throw last ?? new Error("guardian private pipe unavailable"); }
async function closesWithin(child, milliseconds) { if (child.exitCode !== null) return true; return await Promise.race([onceEvent(child, "close").then(() => true), delay(milliseconds).then(() => false)]); }
async function waitForFile(path) { for (let i = 0; i < 400; i++) { try { await access(path); return; } catch { await delay(25); } } throw new Error("fixture report missing"); }
async function expectNoFile(path, milliseconds) { await delay(milliseconds); await assert.rejects(access(path)); }
async function waitForFileChange(path, previous) { for (let attempt = 0; attempt < 40; attempt++) { await delay(50); if (await readFile(path, "utf8") !== previous) return; } throw new Error("fixture heartbeat did not advance"); }
async function waitForStableFiles(paths) { let previous = await Promise.all(paths.map((path) => readFile(path, "utf8"))); let stableSamples = 0; for (let attempt = 0; attempt < 40; attempt++) { await delay(50); const current = await Promise.all(paths.map((path) => readFile(path, "utf8"))); if (current.every((value, index) => value === previous[index])) { if (++stableSamples >= 3) return; } else { stableSamples = 0; previous = current; } } throw new Error("fixture heartbeat did not stop"); }
async function temporaryRoot(label) { return await mkdtemp(resolve(tmpdir(), `gamebuddy-guardian-${label}-`)); }
async function removeRoot(root) { await rm(root, { recursive: true, force: true }); }
async function delay(milliseconds) { await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }
