import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXPORT_DIRECTORY = path.join(PACKAGE_DIRECTORY, "inputs", "stardew-action-surface-export");
const EXPORT_PROJECT = path.join(EXPORT_DIRECTORY, "ActionDevelopmentActionSurfaceExport.csproj");
const EXPORT_DLL = path.join(EXPORT_DIRECTORY, "bin", "Debug", "net6.0", "GameBuddy.Stardew.ActionDevelopmentActionSurfaceExport.dll");
const ARTIFACT = path.join(PACKAGE_DIRECTORY, "contracts", "generated", "action-surface.v1.json");
function fail(code) { throw new Error(`stardew_action_surface_export_check_${code}`); }
function run(command, args) { return new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: PACKAGE_DIRECTORY, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); const out = [], err = [];
  child.stdout.on("data", (c) => out.push(c)); child.stderr.on("data", (c) => err.push(c)); child.once("error", () => reject(new Error("stardew_action_surface_export_check_spawn_failed")));
  child.once("close", (code, signal) => code === 0 && !signal && err.length === 0 ? resolve(Buffer.concat(out)) : reject(new Error("stardew_action_surface_export_check_command_failed")));
}); }
export async function runActionSurfaceExportCheck({ runExport, readArtifact } = {}) {
  const exported = runExport ?? (async () => { await run("dotnet", ["build", EXPORT_PROJECT, "--nologo"]); return run("dotnet", [EXPORT_DLL]); });
  const [produced, artifact] = await Promise.all([exported(), readArtifact ? readArtifact() : readFile(ARTIFACT)]);
  if (!Buffer.isBuffer(produced) || !Buffer.isBuffer(artifact)) fail("artifact_unreadable");
  if (!produced.equals(artifact)) fail("artifact_drift");
  return Object.freeze({ schema: "gamebuddy-stardew-action-surface-export-check/v1", status: "valid", bytes: artifact.length });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runActionSurfaceExportCheck().then((r) => process.stdout.write(`${JSON.stringify(r)}\n`), (e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
