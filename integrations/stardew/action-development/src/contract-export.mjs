import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../../..");
const EXPORT_PROJECT = path.join(REPOSITORY_DIRECTORY, "integrations", "stardew", "tests", "ActionDevelopmentContractExport", "ActionDevelopmentContractExport.csproj");
const EXPORT_DLL = path.join(REPOSITORY_DIRECTORY, "integrations", "stardew", "tests", "ActionDevelopmentContractExport", "bin", "Debug", "net6.0", "GameBuddy.Stardew.ActionDevelopmentContractExport.dll");
const EQUIP_TOOL_ARTIFACT = path.join(PACKAGE_DIRECTORY, "contracts", "equip_tool.json");
const MAX_OUTPUT_BYTES = 64 * 1024;

function fail(code) {
  throw new Error(`stardew_action_contract_export_${code}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPOSITORY_DIRECTORY, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = { stdout: [], stderr: [], bytes: 0 };
    const append = (field) => (chunk) => {
      chunks.bytes += chunk.length;
      if (chunks.bytes > MAX_OUTPUT_BYTES) child.kill();
      else chunks[field].push(chunk);
    };
    child.stdout.on("data", append("stdout"));
    child.stderr.on("data", append("stderr"));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (chunks.bytes > MAX_OUTPUT_BYTES) return reject(new Error("stardew_action_contract_export_output_too_large"));
      const result = Object.freeze({ code, signal, stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr) });
      code === 0 && !signal ? resolve(result) : reject(new Error(`stardew_action_contract_export_failed:${code ?? "none"}:${signal ?? "none"}:${result.stderr.toString("utf8")}`));
    });
  });
}

export async function readGeneratedEquipToolContract({ runExport, readArtifact } = {}) {
  const exportContract = runExport ?? (async () => {
    await run("dotnet", ["build", EXPORT_PROJECT, "--no-restore", "--nologo"]);
    return (await run("dotnet", [EXPORT_DLL, "equip_tool"])).stdout;
  });
  const readCheckedArtifact = readArtifact ?? (() => readFile(EQUIP_TOOL_ARTIFACT));
  const [generated, artifact] = await Promise.all([exportContract(), readCheckedArtifact()]);
  if (!Buffer.isBuffer(generated) || !Buffer.isBuffer(artifact)) fail("artifact_unreadable");
  if (!generated.equals(artifact)) fail("artifact_drift");
  return generated;
}

export const actionDevelopmentContractExportPaths = Object.freeze({ EXPORT_PROJECT, EXPORT_DLL, EQUIP_TOOL_ARTIFACT });
