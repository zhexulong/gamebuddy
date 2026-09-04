import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../../..");
const EXPORT_PROJECT = path.join(REPOSITORY_DIRECTORY, "integrations", "stardew", "tests", "actiondevelopmentactionsurfaceexport", "actiondevelopmentactionsurfaceexport.csproj");
const EXPORT_DLL = path.join(REPOSITORY_DIRECTORY, "integrations", "stardew", "tests", "actiondevelopmentactionsurfaceexport", "bin", "Debug", "net6.0", "GameBuddy.Stardew.ActionDevelopmentActionSurfaceExport.dll");
const ARTIFACT = path.join(PACKAGE_DIRECTORY, "contracts", "generated", "action-surface.v1.json");
const MAX_OUTPUT_BYTES = 128 * 1024;

function fail(code) { throw new Error(`stardew_action_surface_export_check_${code}`); }
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPOSITORY_DIRECTORY, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = []; let bytes = 0;
    const append = (target) => (chunk) => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) child.kill(); else target.push(chunk); };
    child.stdout.on("data", append(stdout)); child.stderr.on("data", append(stderr));
    child.once("error", () => reject(new Error("stardew_action_surface_export_check_spawn_failed")));
    child.once("close", (code, signal) => {
      if (bytes > MAX_OUTPUT_BYTES) return reject(new Error("stardew_action_surface_export_check_output_too_large"));
      const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code !== 0 || signal || result.stderr.length) return reject(new Error("stardew_action_surface_export_check_command_failed"));
      resolve(result.stdout);
    });
  });
}

export async function runActionSurfaceExportCheck({ runExport, readArtifact } = {}) {
  const exported = runExport ?? (async () => { await run("dotnet", ["build", EXPORT_PROJECT, "--nologo"]); return run("dotnet", [EXPORT_DLL]); });
  const [produced, artifact] = await Promise.all([exported(), readArtifact ? readArtifact() : readFile(ARTIFACT)]);
  if (!Buffer.isBuffer(produced) || !Buffer.isBuffer(artifact)) fail("artifact_unreadable");
  if (!produced.equals(artifact)) fail("artifact_drift");
  return Object.freeze({ schema: "gamebuddy-stardew-action-surface-export-check/v1", status: "valid", bytes: artifact.length });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runActionSurfaceExportCheck().then((report) => process.stdout.write(`${JSON.stringify(report)}\n`), (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
