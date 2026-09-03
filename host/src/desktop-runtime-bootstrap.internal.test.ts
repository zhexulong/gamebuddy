import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DESKTOP_RUNTIME_BOOTSTRAP_ENTRY } from "./desktop-runtime-bootstrap.internal.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = sourceDirectory.endsWith("src") ? sourceDirectory : resolve(sourceDirectory, "..", "src");
const compiledEntry = resolve(sourceDirectory, "desktop-runtime-bootstrap.internal.js");
const fixedFrame = {
  schema: "gamebuddy-desktop-host-bootstrap/v1",
  protocolVersion: 1,
  bootstrapId: "a".repeat(64),
  generation: "g-fixed",
  inventoryDigest: "b".repeat(64),
  runtimeAdmissionSha256: "c".repeat(64),
  rootLayout: {
    schema: "gamebuddy-windows-root-layout/v1",
    programRoot: "C:\\Users\\Player\\AppData\\Local\\Programs\\GameBuddy",
    dataRoot: "C:\\Users\\Player\\AppData\\Local\\GameBuddy\\data",
    operationalRoot: "C:\\Users\\Player\\AppData\\Local\\GameBuddy\\operational",
    presentationRoot: "C:\\Users\\Player\\AppData\\Local\\GameBuddy\\presentation",
  },
};
const validFrame = JSON.stringify(fixedFrame);

test("Desktop bootstrap entry exports only the fixed internal descriptor", async () => {
  const entryModule = await import("./desktop-runtime-bootstrap.internal.js");

  assert.deepEqual(Object.keys(entryModule), ["DESKTOP_RUNTIME_BOOTSTRAP_ENTRY"]);
  assert.deepEqual(DESKTOP_RUNTIME_BOOTSTRAP_ENTRY, {
    schema: "gamebuddy-desktop-runtime-bootstrap-entry/v1",
    entry: "desktop-runtime-bootstrap.internal.js",
  });
  assert.equal(Object.isFrozen(DESKTOP_RUNTIME_BOOTSTRAP_ENTRY), true);
});

test("ordinary import does not consume inherited stdin or start the bootstrap entry", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(new URL("./desktop-runtime-bootstrap.internal.js", import.meta.url).href)}); process.stdout.write("imported\\n");`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.write(validFrame);
  await new Promise((resolveImport, rejectImport) => {
    child.once("error", rejectImport);
    child.once("close", (code) => code === 0 ? resolveImport(undefined) : rejectImport(new Error(`import_child_exit_${code}`)));
  });
  assert.deepEqual(Buffer.concat(stdout), Buffer.from("imported\n"));
  assert.deepEqual(Buffer.concat(stderr), Buffer.alloc(0));
});

test("compiled entry rejects malformed bootstrap wire without acknowledgement", async () => {
  const frames = [
    Buffer.from(`${validFrame}\r\n`, "utf8"),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${validFrame}\n`, "utf8")]),
    Buffer.from(`${validFrame.slice(0, -1)},"unknown":true}\n`, "utf8"),
    Buffer.from(`${validFrame.replace('"schema"', '"schema","schema"')}\n`, "utf8"),
    Buffer.alloc(32_769, 0x61),
  ];

  for (const frame of frames) {
    const result = await runEntry(frame);
    assert.notEqual(result.code, 0);
    assert.deepEqual(result.stdout, Buffer.alloc(0));
  }
});

test("disposable bootstrap admission accepts only the exact runtime closure and writes the exact acknowledgement bytes", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only bootstrap root, reparse, and current-user ownership admission");
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || localAppData.length === 0) return t.skip("Windows LOCALAPPDATA is unavailable for bootstrap fixture");
  const fixtureRoot = await mkdtemp(join(await realpath(localAppData), "gamebuddy-desktop-bootstrap-"));
  try {
    const moduleDirectory = join(fixtureRoot, "Programs", "GameBuddy", "generation");
    const runtime = Buffer.from("fixture runtime");
    const bootstrap = Buffer.from(await readFile(compiledEntry));
    const closure = [
      { path: "runtime/a.dll", bytes: Buffer.from("fixture a") },
      { path: "runtime/nested/z.dll", bytes: Buffer.from("fixture z") },
    ];
    await mkdir(join(moduleDirectory, "runtime", "nested"), { recursive: true });
    await writeFile(join(moduleDirectory, "runtime", "node.exe"), runtime);
    await writeFile(join(moduleDirectory, "runtime", "a.dll"), closure[0]!.bytes);
    await writeFile(join(moduleDirectory, "runtime", "nested", "z.dll"), closure[1]!.bytes);
    await cp(resolve(sourceDirectory, "windows-reparse-inspector"), join(moduleDirectory, "windows-reparse-inspector"), { recursive: true });
    await cp(resolve(sourceDirectory, "strict-json-reader.js"), join(moduleDirectory, "strict-json-reader.js"));
    await cp(resolve(sourceRoot, "..", "native", "windows-reparse-inspector", ".dist", "win-x64"), join(moduleDirectory, "native", "windows-reparse-inspector", "win-x64"), { recursive: true });
    const rootLayout = {
      schema: "gamebuddy-windows-root-layout/v1",
      programRoot: join(fixtureRoot, "Programs", "GameBuddy"),
      dataRoot: join(fixtureRoot, "GameBuddy", "data"),
      operationalRoot: join(fixtureRoot, "GameBuddy", "operational"),
      presentationRoot: join(fixtureRoot, "GameBuddy", "presentation"),
    };
    await Promise.all([rootLayout.programRoot, rootLayout.dataRoot, rootLayout.operationalRoot, rootLayout.presentationRoot].map(async (path) => await mkdir(path, { recursive: true })));
    await takeFixtureOwnership(fixtureRoot);
    const frameValue = { ...fixedFrame, rootLayout };
    const sidecar = {
      schema: "host-runtime-admission/v1",
      inventoryDigest: frameValue.inventoryDigest,
      generation: frameValue.generation,
      runtimePath: "runtime/node.exe",
      runtimeSha256: sha256(runtime),
      bootstrapPath: "desktop-runtime-bootstrap.internal.js",
      bootstrapSha256: sha256(bootstrap),
      runtimeVersion: "v24.20.0",
      runtimePlatform: "win32",
      runtimeArch: "x64",
      runtimeClosure: { schema: "host-bundled-runtime-closure/v1", files: closure.map(({ path, bytes }) => ({ path, sha256: sha256(bytes) })) },
    };
    const sidecarBytes = Buffer.from(`${JSON.stringify(sidecar)}\n`);
    await writeFile(join(moduleDirectory, "desktop-runtime-bootstrap.internal.js"), bootstrap);
    await writeFile(join(moduleDirectory, "host-runtime-admission.json"), sidecarBytes);
    const frame = Buffer.from(`${JSON.stringify({ ...frameValue, runtimeAdmissionSha256: sha256(sidecarBytes) })}\n`);
    const expectedAcknowledgement = Buffer.from(`${JSON.stringify({
      schema: "gamebuddy-desktop-host-bootstrap/v1",
      protocolVersion: 1,
      status: "accepted",
      bootstrapId: frameValue.bootstrapId,
      generation: frameValue.generation,
      inventoryDigest: frameValue.inventoryDigest,
      runtimeAdmissionSha256: sha256(sidecarBytes),
      rootLayoutSchema: "gamebuddy-windows-root-layout/v1",
    })}\n`);
    const accepted = await runEntry(frame, join(moduleDirectory, "desktop-runtime-bootstrap.internal.js"), true, fixtureRoot);
    // On Windows, Node maps child.kill("SIGTERM") to forced process termination;
    // the test has already observed the exact acknowledgement before issuing it.
    assert.ok(accepted.code === null || accepted.code === 1, accepted.stderr.toString("utf8"));
    assert.deepEqual(accepted.stdout, expectedAcknowledgement);

    const reject = async (mutate: () => Promise<void>, candidateFrame = frame): Promise<void> => {
      await restoreFixture(moduleDirectory, bootstrap, runtime, closure, sidecarBytes);
      await mutate();
      const rejected = await runEntry(candidateFrame, join(moduleDirectory, "desktop-runtime-bootstrap.internal.js"), false, fixtureRoot);
      assert.notEqual(rejected.code, 0);
      assert.deepEqual(rejected.stdout, Buffer.alloc(0));
    };
    for (const mutate of [
      async () => await writeFile(join(moduleDirectory, "runtime", "a.dll"), "tampered"),
      async () => await writeFile(join(moduleDirectory, "runtime", "foreign.dll"), "foreign"),
      async () => await writeFile(join(moduleDirectory, "runtime", "node.exe"), "tampered"),
      async () => await writeFile(join(moduleDirectory, "desktop-runtime-bootstrap.internal.js"), "tampered"),
    ]) await reject(mutate);
    for (const files of [
      [...sidecar.runtimeClosure.files].reverse(),
      [sidecar.runtimeClosure.files[0]!, sidecar.runtimeClosure.files[0]!],
      sidecar.runtimeClosure.files.slice(1),
      [...sidecar.runtimeClosure.files, { path: "runtime/foreign.dll", sha256: "a".repeat(64) }],
      [{ ...sidecar.runtimeClosure.files[0]!, sha256: "b".repeat(64) }, sidecar.runtimeClosure.files[1]!],
    ]) {
      const candidate = { ...sidecar, runtimeClosure: { ...sidecar.runtimeClosure, files } };
      const candidateBytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
      const candidateFrame = Buffer.from(`${JSON.stringify({ ...frameValue, runtimeAdmissionSha256: sha256(candidateBytes) })}\n`);
      await reject(async () => await writeFile(join(moduleDirectory, "host-runtime-admission.json"), candidateBytes), candidateFrame);
    }
    for (const path of [
      "runtime/CON",
      "runtime/aux.txt",
      "runtime/a.",
      "runtime/a ",
      "runtime/.",
      "runtime/..",
      "runtime//a.dll",
      "runtime\\a.dll",
      "runtime/a:b.dll",
      "runtime/a\u0001b.dll",
      "other/a.dll",
    ]) {
      const files = [{ ...sidecar.runtimeClosure.files[0]!, path }, sidecar.runtimeClosure.files[1]!];
      const candidate = { ...sidecar, runtimeClosure: { ...sidecar.runtimeClosure, files } };
      const candidateBytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
      const candidateFrame = Buffer.from(`${JSON.stringify({ ...frameValue, runtimeAdmissionSha256: sha256(candidateBytes) })}\n`);
      await reject(async () => await writeFile(join(moduleDirectory, "host-runtime-admission.json"), candidateBytes), candidateFrame);
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Desktop bootstrap source retains only fixed private ingress and no public consumer", async () => {
  const source = await readFile(resolve(sourceRoot, "desktop-runtime-bootstrap.internal.ts"), "utf8");

  for (const forbidden of [
    "process.argv",
    "node:child_process",
    "spawn(",
    "Guardian",
    "broker",
    "console.",
    "current.json",
  ]) assert.equal(source.includes(forbidden), false, `forbidden bootstrap ingress: ${forbidden}`);
  assert.match(source, /process\.env\.LOCALAPPDATA/);
  assert.match(source, /import\.meta\.main/);
  assert.match(source, /host-runtime-admission\.json/);
  assert.match(source, /createPublishedWindowsReparseInspector/);
  assert.match(source, /inspectWindowsPathIdentityChain/);
  assert.match(source, /inspectWindowsPathSecurity/);
  assert.match(source, /currentUserOwner/);
  assert.match(source, /strictlyContains\(layout\.programRoot, moduleDirectory\)/);
  assert.match(source, /strictlyContains\(moduleDirectory, mutableRoot\)/);
  assert.match(source, /new WeakSet<object>/);
  assert.match(source, /new WeakMap<object, undefined>/);

  const rootValidation = source.indexOf("const rootLayout = await validateRootLayout(frame.rootLayout, moduleDirectory)");
  const securityCheck = source.indexOf("Promise.all(roots.map((root) => inspectWindowsPathSecurity(inspector, root)))");
  const mint = source.indexOf("mintDesktopRootLayoutCapability(rootLayout)");
  const acknowledgement = source.indexOf("writeAcknowledgement(frame, admission)");
  assert.ok(rootValidation >= 0 && securityCheck >= 0 && rootValidation < mint && rootValidation < acknowledgement, "root security validation must precede mint and acknowledgement");
});

async function takeFixtureOwnership(root: string): Promise<void> {
  const takeown = "C:\\Windows\\System32\\takeown.exe";
  const child = spawn(takeown, ["/f", root, "/r", "/d", "y"], { stdio: "ignore", windowsHide: true });
  const code = await new Promise<number | null>((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", resolveClose);
  });
  if (code !== 0) throw new Error("bootstrap_fixture_takeown_failed");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function restoreFixture(moduleDirectory: string, bootstrap: Buffer, runtime: Buffer, closure: readonly Readonly<{ path: string; bytes: Buffer }>[], sidecarBytes: Buffer): Promise<void> {
  await rm(join(moduleDirectory, "runtime"), { recursive: true, force: true });
  await mkdir(join(moduleDirectory, "runtime", "nested"), { recursive: true });
  await writeFile(join(moduleDirectory, "runtime", "node.exe"), runtime);
  for (const entry of closure) await writeFile(join(moduleDirectory, entry.path), entry.bytes);
  await writeFile(join(moduleDirectory, "desktop-runtime-bootstrap.internal.js"), bootstrap);
  await writeFile(join(moduleDirectory, "host-runtime-admission.json"), sidecarBytes);
}

async function runEntry(frame: Buffer, entry = compiledEntry, closeAfterAcknowledgement = false, localAppData = "C:\\Users\\Player\\AppData\\Local"): Promise<Readonly<{ code: number | null; stdout: Buffer; stderr: Buffer }>> {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LOCALAPPDATA: localAppData } });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
    if (closeAfterAcknowledgement) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(frame);
  const code = await new Promise<number | null>((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", resolveClose);
  });
  return Object.freeze({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
}
