import assert from "node:assert/strict";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const hostRoot = resolve(dirname(scriptPath), "..");
const emittedDirectoryPrefix = ".windows-reparse-emitted-boundary-";
const expectedExports = Object.freeze([
  "BUILD_ARTIFACT_REPARSE_INSPECTION",
  "assertNoWindowsReparse",
  "createPublishedWindowsReparseInspector",
  "inspectWindowsPathIdentity",
  "inspectWindowsPathIdentityChain",
  "inspectWindowsPathSecurity",
  "inspectWindowsReparse",
]);
const compilerTimeoutMs = 120_000;

async function runCompiler(emittedRoot) {
  const compiler = resolve(hostRoot, "node_modules", "typescript", "lib", "tsc.js");
  const compilerState = await lstat(compiler).catch(() => undefined);
  if (!compilerState?.isFile() || compilerState.isSymbolicLink()) throw new Error("emitted_reparse_boundary_compiler_unavailable");
  await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, [
      compiler,
      "--project", resolve(hostRoot, "tsconfig.production.json"),
      "--outDir", emittedRoot,
      "--pretty", "false",
    ], {
      cwd: hostRoot,
      env: process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectProcess(new Error("emitted_reparse_boundary_compile_timeout"));
    }, compilerTimeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectProcess(new Error("emitted_reparse_boundary_compile_failed", { cause: error }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal !== null) rejectProcess(new Error(`emitted_reparse_boundary_compile_failed:${output.slice(-4096)}`));
      else resolveProcess();
    });
  });
}

export async function checkWindowsReparseEmittedBoundary() {
  const emittedRoot = await mkdtemp(resolve(hostRoot, emittedDirectoryPrefix));
  const emittedState = await lstat(emittedRoot);
  if (!emittedState.isDirectory() || emittedState.isSymbolicLink() || await realpath(emittedRoot) !== emittedRoot)
    throw new Error("emitted_reparse_boundary_scratch_untrusted");
  try {
    await runCompiler(emittedRoot);
    const modulePath = resolve(emittedRoot, "windows-reparse-inspector", "index.js");
    const module = await import(`${pathToFileURL(modulePath).href}?fresh=${Date.now()}`);
    assert.deepEqual(Object.keys(module).sort(), [...expectedExports].sort());
    const boundary = module.BUILD_ARTIFACT_REPARSE_INSPECTION;
    assert.equal(Object.keys(boundary).sort().join(","), "assertNoReparse,create");
    assert.equal(typeof boundary.create, "function");
    assert.equal(typeof boundary.assertNoReparse, "function");
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, gate: "windows_reparse_emitted_boundary/v1", status: "passed", exports: expectedExports })}\n`);
  } finally {
    await rm(emittedRoot, { recursive: true, force: true });
    await lstat(emittedRoot).then(
      () => { throw new Error("emitted_reparse_boundary_scratch_not_cleaned"); },
      (error) => {
        if (error?.code !== "ENOENT") throw error;
      },
    );
  }
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    await checkWindowsReparseEmittedBoundary();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
