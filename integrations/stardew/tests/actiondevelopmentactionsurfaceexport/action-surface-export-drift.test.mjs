import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DLL = path.join(
  TEST_DIRECTORY,
  "bin",
  "Debug",
  "net6.0",
  "GameBuddy.Stardew.ActionDevelopmentActionSurfaceExport.dll",
);
const GENERATED_ARTIFACT = path.join(
  TEST_DIRECTORY,
  "..",
  "..",
  "action-development",
  "contracts",
  "generated",
  "action-surface.v1.json",
);

function runNoArgumentExporter() {
  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", [EXPORT_DLL], {
      cwd: TEST_DIRECTORY,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = Object.freeze({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
      if (code !== 0 || signal || result.stderr.length !== 0) {
        reject(new Error(
          `action_surface_export_failed:${code ?? "none"}:${signal ?? "none"}:${result.stderr.toString("utf8")}`,
        ));
        return;
      }
      resolve(result.stdout);
    });
  });
}

test("producer exporter bytes do not drift from the generated action-surface artifact", async () => {
  const [exported, artifact] = await Promise.all([
    runNoArgumentExporter(),
    readFile(GENERATED_ARTIFACT),
  ]);

  assert.equal(exported[0], 0x7b, "export must start with UTF-8 JSON, not a BOM");
  assert.equal(exported.includes(0x0a), false, "export must not contain a newline");
  assert.equal(exported.includes(0x0d), false, "export must not contain a carriage return");
  assert.equal(artifact[0], 0x7b, "artifact must start with UTF-8 JSON, not a BOM");
  assert.equal(artifact.includes(0x0a), false, "artifact must not contain a newline");
  assert.equal(artifact.includes(0x0d), false, "artifact must not contain a carriage return");
  assert.deepEqual(exported, artifact, "producer export bytes differ from the generated artifact");
});
