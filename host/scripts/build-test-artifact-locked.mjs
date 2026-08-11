import { access, cp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { writeHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(hostRoot, "dist-test");
await rm(outputRoot, { recursive: true, force: true });
await promisify(execFile)(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "tsc", "--project", "tsconfig.test.json"], { cwd: hostRoot, ...(process.platform === "win32" ? { shell: true } : {}) });
for (const entry of ["main.js", "dialogue-web-main.js"]) {
  try { await access(resolve(outputRoot, entry)); throw new Error(`test_artifact_contains_production_entry:${entry}`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}
// TypeScript fixture workers are emitted by the test compiler. Copy only the
// PowerShell assets that cannot be emitted, so dist-test never mixes source
// .ts files with its compiled test artifact.
for (const source of [
  "src/test-fixtures/windows-named-mutex-abandon-child.ps1",
  "src/test-fixtures/windows-named-mutex-broker-test-sidecar.ps1",
  "src/test-fixtures/windows-named-mutex-retained-abandon.ps1",
]) {
  const destination = resolve(outputRoot, source.slice("src/".length));
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(hostRoot, source), destination, { force: true, verbatimSymlinks: true });
}
await cp(resolve(hostRoot, "resources/windows-named-mutex-broker.ps1"), resolve(outputRoot, "windows-named-mutex-broker.ps1"), { force: true, verbatimSymlinks: true });
await writeHostVerificationArtifactManifest({ root: hostRoot, outputRoot });
