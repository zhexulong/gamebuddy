import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";



const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = findPackageRoot(sourceDirectory);
const sourceRoot = resolve(packageRoot, "src");
const compiledEntry = resolve(sourceDirectory, "desktop-host-entry.internal.js");
const compiledBootstrapHelper = resolve(sourceDirectory, "desktop-runtime-bootstrap.internal.js");
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

test("Desktop host entry exposes no public exports", async () => {
  const entryModule = await import("./desktop-host-entry.internal.js");

  assert.deepEqual(Object.keys(entryModule), []);
});

test("ordinary import does not consume inherited stdin or start the bootstrap entry", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(new URL("./desktop-host-entry.internal.js", import.meta.url).href)}); process.stdout.write("imported\\n");`], {
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

test("Host bootstrap acknowledges a freshly valid root without a local runtime sidecar or runtime tree", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only bootstrap root, reparse, and current-user ownership admission");
  const fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-desktop-bootstrap-"));
  try {
    const moduleDirectory = join(fixtureRoot, "Programs", "GameBuddy", "generation");
    const rootLayout = {
      schema: "gamebuddy-windows-root-layout/v1",
      programRoot: join(fixtureRoot, "Programs", "GameBuddy"),
      dataRoot: join(fixtureRoot, "GameBuddy", "data"),
      operationalRoot: join(fixtureRoot, "GameBuddy", "operational"),
      presentationRoot: join(fixtureRoot, "GameBuddy", "presentation"),
    };
    await Promise.all([moduleDirectory, rootLayout.dataRoot, rootLayout.operationalRoot, rootLayout.presentationRoot].map(async (path) => await mkdir(path, { recursive: true })));
    await writeFile(join(moduleDirectory, "desktop-host-entry.internal.js"), await readFile(compiledEntry));
    await writeFile(join(moduleDirectory, "desktop-runtime-bootstrap.internal.js"), await readFile(compiledBootstrapHelper));
    await cp(resolve(sourceDirectory, "windows-reparse-inspector"), join(moduleDirectory, "windows-reparse-inspector"), { recursive: true });
    await cp(resolve(sourceDirectory, "strict-json-reader.js"), join(moduleDirectory, "strict-json-reader.js"));
    await cp(resolve(packageRoot, "native", "windows-reparse-inspector", ".dist", "win-x64"), join(moduleDirectory, "native", "windows-reparse-inspector", "win-x64"), { recursive: true });

    const frameValue = { ...fixedFrame, bootstrapId: `${"a".repeat(56)}${process.pid.toString(16).padStart(8, "0")}`, rootLayout };
    const frame = Buffer.from(`${JSON.stringify(frameValue)}\n`);
    const expectedAcknowledgement = Buffer.from(`${JSON.stringify({
      schema: "gamebuddy-desktop-host-bootstrap/v1",
      protocolVersion: 1,
      status: "accepted",
      bootstrapId: frameValue.bootstrapId,
      generation: frameValue.generation,
      inventoryDigest: frameValue.inventoryDigest,
      runtimeAdmissionSha256: frameValue.runtimeAdmissionSha256,
      rootLayoutSchema: "gamebuddy-windows-root-layout/v1",
    })}\n`);
    const accepted = startEntry(frame, join(moduleDirectory, "desktop-host-entry.internal.js"), fixtureRoot);
    const acknowledgement = await accepted.stdoutEnded;
    assert.deepEqual(acknowledgement, expectedAcknowledgement);
    assert.equal(accepted.child.exitCode, null, "child must remain active after acknowledgement");
    assert.equal(accepted.child.kill("SIGTERM"), true);
    const result = await accepted.result;
    assert.equal(result.code, null, result.stderr.toString("utf8"));
    assert.deepEqual(result.stdout, expectedAcknowledgement);

    const invalidRootFrame = Buffer.from(`${JSON.stringify({ ...frameValue, rootLayout: { ...rootLayout, dataRoot: join(fixtureRoot, "GameBuddy", "other") } })}\n`);
    const rejected = await runEntry(invalidRootFrame, join(moduleDirectory, "desktop-host-entry.internal.js"), fixtureRoot);
    assert.notEqual(rejected.code, 0);
    assert.deepEqual(rejected.stdout, Buffer.alloc(0));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Desktop bootstrap source consumes only frame facts before fresh root validation and acknowledgement", async () => {
  const source = await readFile(resolve(sourceRoot, "desktop-runtime-bootstrap.internal.ts"), "utf8");
  const entrySource = await readFile(resolve(sourceRoot, "desktop-host-entry.internal.ts"), "utf8");

  for (const forbidden of ["process.argv", "node:child_process", "spawn(", "console.", "current.json"]) assert.equal(source.includes(forbidden), false, `forbidden bootstrap ingress: ${forbidden}`);
  assert.match(source, /process\.env\.LOCALAPPDATA/);
  assert.match(entrySource, /import\.meta\.main/);
  assert.doesNotMatch(source, /import\.meta\.main/);
  assert.match(entrySource, /from "\.\/desktop-runtime-bootstrap\.internal\.js"/);
  assert.match(source, /createPublishedWindowsReparseInspector/);
  assert.match(source, /inspectWindowsPathIdentityChain/);
  assert.match(source, /inspectWindowsPathSecurity/);
  assert.match(source, /currentUserOwner/);
  assert.match(source, /strictlyContains\(layout\.programRoot, moduleDirectory\)/);
  assert.match(source, /strictlyContains\(moduleDirectory, mutableRoot\)/);
  assert.match(source, /new WeakSet<object>/);
  assert.match(source, /new WeakMap<object, undefined>/);
  assert.doesNotMatch(source, /host-runtime-admission/);
  assert.doesNotMatch(source, /runtimeClosure|enumerateRuntimeTree|sameRuntimeTree/);
  assert.doesNotMatch(source, /node:crypto|createHash|readdir\(|readVerifiedArtifactFile|artifactPath|safeArtifactAncestors/);
  assert.doesNotMatch(source, /connectGuardianSession|createConnection\(|gamebuddy-desktop-guardian-session\/v1|sessionToken/);

  const rootValidation = source.indexOf("const rootLayout = await validateRootLayout(frame.rootLayout, moduleDirectory)");
  const securityCheck = source.indexOf("Promise.all(roots.map((root) => inspectWindowsPathSecurity(inspector, root)))");
  const mint = source.indexOf("mintDesktopRootLayoutCapability(rootLayout)");
  const acknowledgement = source.indexOf("writeAcknowledgement(frame)");
  assert.ok(rootValidation >= 0 && securityCheck >= 0 && rootValidation < mint && rootValidation < acknowledgement, "root security validation must precede mint and acknowledgement");
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

function startEntry(frame: Buffer, entry = compiledEntry, localAppData = "C:\\Users\\Player\\AppData\\Local"): Readonly<{ child: ReturnType<typeof spawn>; stdoutEnded: Promise<Buffer>; result: Promise<Readonly<{ code: number | null; stdout: Buffer; stderr: Buffer }>> }> {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LOCALAPPDATA: localAppData } });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const stdoutEnded = new Promise<Buffer>((resolveAcknowledgement, rejectAcknowledgement) => {
    const receive = (chunk: Buffer) => {
      const bytes = Buffer.concat(stdout);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      child.stdout.off("error", rejectAcknowledgement);
      child.stdout.off("end", end);
      resolveAcknowledgement(bytes.subarray(0, newline + 1));
    };
    const end = () => {
      child.stdout.off("error", rejectAcknowledgement);
      child.stdout.off("data", receive);
      resolveAcknowledgement(Buffer.alloc(0));
    };
    child.stdout.on("data", receive);
    child.stdout.once("error", rejectAcknowledgement);
    child.stdout.once("end", end);
  });
  child.stdin.end(frame);
  const result = new Promise<Readonly<{ code: number | null; stdout: Buffer; stderr: Buffer }>>((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code) => resolveClose(Object.freeze({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })));
  });
  return Object.freeze({ child, stdoutEnded, result });
}

async function runEntry(frame: Buffer, entry = compiledEntry, localAppData = "C:\\Users\\Player\\AppData\\Local"): Promise<Readonly<{ code: number | null; stdout: Buffer; stderr: Buffer }>> {
  return await startEntry(frame, entry, localAppData).result;
}
