import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyActionProgram } from "../src/verifier.mjs";

const execFileAsync = promisify(execFile);
const exporterDirectory = new URL(
  "../../../integrations/stardew/tests/actiondevelopmentactionsurfaceexport/",
  import.meta.url,
);
const exporterProject = new URL("actiondevelopmentactionsurfaceexport.csproj", exporterDirectory);
const exporterAssembly = new URL(
  "bin/Debug/net6.0/GameBuddy.Stardew.ActionDevelopmentActionSurfaceExport.dll",
  exporterDirectory,
);

test("actual Mod descriptor projection is accepted by verifyActionProgram", async () => {
  await execFileAsync("dotnet", [
    "build",
    fileURLToPath(exporterProject),
    "--no-restore",
    "--nologo",
    "--verbosity", "quiet",
  ], { windowsHide: true });
  const { stdout, stderr } = await execFileAsync("dotnet", [fileURLToPath(exporterAssembly)], {
    windowsHide: true,
  });
  assert.equal(stderr, "");

  const descriptors = JSON.parse(stdout);
  const restrictivePolicy = {
    enabledActionIds: descriptors.actions.map((action) => action.actionId),
  };
  const report = verifyActionProgram({
    descriptors,
    restrictivePolicy,
    program: {
      schema: "gamebuddy-action-program/v1",
      programId: "mod_projection",
      nodes: [{
        nodeId: "move",
        actionId: "move_to_tile",
        args: { x: 1, y: 2 },
        bindings: [],
        guards: [],
      }],
      edges: [],
    },
  });

  assert.equal(report.accepted, true, JSON.stringify(report.diagnostics));
  assert.equal(report.catalogRevision, 1);
});
