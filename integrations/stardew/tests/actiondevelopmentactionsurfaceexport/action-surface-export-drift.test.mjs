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
const GENERATED_DEADLINE_WINDOWS = path.join(
  TEST_DIRECTORY,
  "..",
  "..",
  "action-development",
  "contracts",
  "generated",
  "action-deadline-windows.v1.json",
);
const GENERATED_HANDLER_GROUPS = path.join(
  TEST_DIRECTORY,
  "..",
  "..",
  "action-development",
  "contracts",
  "generated",
  "action-handler-groups.v1.json",
);

function runExporter(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", [EXPORT_DLL, ...args], {
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
    runExporter(),
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

/**
 * The admitted deadline windows a sender outside the Mod reads. `tools/check-action-deadline-agreement.mjs` compares
 * every gate runner's declared deadline against this file, so a stale copy would let a sender be judged against a
 * window the Mod no longer admits - and a receiver-side change that the export never followed would make the gate
 * pass on a number nobody admits.
 */
test("producer exporter bytes do not drift from the generated action-deadline-windows artifact", async () => {
  const [exported, artifact] = await Promise.all([
    runExporter(["--deadline-windows"]),
    readFile(GENERATED_DEADLINE_WINDOWS),
  ]);

  assert.equal(exported[0], 0x7b, "export must start with UTF-8 JSON, not a BOM");
  assert.equal(exported.includes(0x0a), false, "export must not contain a newline");
  assert.equal(exported.includes(0x0d), false, "export must not contain a carriage return");
  assert.equal(artifact[0], 0x7b, "artifact must start with UTF-8 JSON, not a BOM");
  assert.deepEqual(exported, artifact, "the committed windows differ from the producer's own output");
});

/**
 * The handler group each dispatchable registration belongs to, which
 * `integrations/stardew/action-development/src/action-source-projection-producer.mjs` reads as
 * `nativeOwnership`. The producer used to match the quoted arm labels of `Handlers/*.cs` as text, so a family
 * respelled as a dictionary entry emptied itself out of the projection with nothing raised. The artifact must stay the
 * harness's own output: a hand-edited copy would be a second spelling of a catalog fact, which is the defect this
 * reader exists to remove.
 */
test("producer exporter bytes do not drift from the generated action-handler-groups artifact", async () => {
  const [exported, artifact] = await Promise.all([
    runExporter(["--handler-groups"]),
    readFile(GENERATED_HANDLER_GROUPS),
  ]);

  assert.equal(exported[0], 0x7b, "export must start with UTF-8 JSON, not a BOM");
  assert.equal(exported.includes(0x0a), false, "export must not contain a newline");
  assert.equal(exported.includes(0x0d), false, "export must not contain a carriage return");
  assert.equal(artifact[0], 0x7b, "artifact must start with UTF-8 JSON, not a BOM");
  assert.deepEqual(exported, artifact, "the committed handler groups differ from the producer's own output");
});
