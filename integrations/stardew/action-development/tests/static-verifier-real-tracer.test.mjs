import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateTargetPublicationManifest } from "../static-verifier/production-schema.mjs";
import { verifyTargetPublication } from "../static-verifier/production-verifier.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const stardewRoot = path.resolve(here, "..", "..");
const publisherProject = path.join(stardewRoot, "tests", "ActionDevelopmentTargetPublication", "ActionDevelopmentTargetPublication.csproj");
const projects = [
  path.join(stardewRoot, "tests", "FarmhandCapabilityPublicationProjection.Contract.csproj"),
  path.join(stardewRoot, "tests", "PortfolioMineElevatorProjection.Contract.csproj"),
  path.join(stardewRoot, "GameBuddy.Stardew.csproj"),
];
const names = [
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "FarmhandCapabilityPublicationProjection.Contract.dll",
  "FarmhandCapabilityPublicationProjection.Contract.runtimeconfig.json",
  "PortfolioMineElevatorProjection.Contract.dll",
  "PortfolioMineElevatorProjection.Contract.runtimeconfig.json",
];
const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

async function locate(root, name) {
  const { stdout } = await execFileAsync("dotnet", ["build", root, "--nologo", "--verbosity", "quiet"]);
  void stdout;
  const projectDir = path.dirname(root);
  const candidates = [path.join(projectDir, "bin", "Debug", "net6.0", name), path.join(projectDir, "bin", "Debug", "net8.0", name)];
  for (const candidate of candidates) { try { await readFile(candidate); return candidate; } catch {} }
  throw new Error(`fresh_build_output_missing:${name}`);
}

test("real fresh-build PE tracer publishes and executes both unsigned compiled contracts from temp outputs", { timeout: 240000 }, async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "stardew-static-tracer-"));
  try {
    for (const project of projects) await execFileAsync("dotnet", ["build", project, "--nologo", "--verbosity", "quiet"]);
    for (const name of names) {
      let source;
      for (const project of projects) {
        try { source = await locate(project, name); break; } catch {}
      }
      if (!source) throw new Error(`fresh_build_output_missing:${name}`);
      await copyFile(source, path.join(temporaryRoot, name));
    }
    const publisherOutput = path.join(temporaryRoot, "publisher");
    await execFileAsync("dotnet", ["build", publisherProject, "--nologo", "--verbosity", "quiet", `-o:${publisherOutput}`]);
    const { stdout } = await execFileAsync("dotnet", [path.join(publisherOutput, "ActionDevelopmentTargetPublication.dll"), "--artifact-root", temporaryRoot]);
    const manifest = validateTargetPublicationManifest(JSON.parse(stdout));
    for (const artifact of manifest.artifacts) assert.equal(artifact.sha256, await sha256(path.join(temporaryRoot, artifact.relativePath)));
    const report = await verifyTargetPublication(manifest);
    assert.equal(report.state, "passed", JSON.stringify(report));
    assert.equal(report.contract.executions.length, 2);
    assert.equal(report.contract.executions.every((entry) => entry.successReceipt.length > 0), true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
