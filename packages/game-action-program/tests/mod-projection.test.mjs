import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyActionProgram } from "../src/verifier.mjs";

const execFileAsync = promisify(execFile);
const exporterDirectory = new URL(
  "../../../integrations/stardew/tests/actiondevelopmentactionsurfaceexport/",
  import.meta.url,
);
const exporterRoot = fileURLToPath(exporterDirectory);
const ASSEMBLY = "GameBuddy.Stardew.ActionDevelopmentActionSurfaceExport.dll";
const BUILD_COMMAND =
  "dotnet build integrations/stardew/tests/actiondevelopmentactionsurfaceexport/" +
  "actiondevelopmentactionsurfaceexport.csproj -c Release";

function directoriesIn(absolute) {
  try {
    return readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The export assembly this tree carries, in whichever configuration it was built.
 *
 * The configuration is DISCOVERED, not assumed: every lane here builds `-c Release` (`build:stardew`, and the ladder's
 * `prep` rung), so a test pinned to `bin/Debug/net6.0/...` failed on any tree that had not also been built Debug while
 * the assembly it needed sat in `bin/Release`. Every `bin/<configuration>/<framework>/<assembly>` under the project is
 * a candidate, the newest mtime wins and the path breaks a tie, so two readings of one tree cannot disagree. A tree
 * with no build at all is not a pass: the test skips naming the command that produces one, which is the same
 * not-measured reading `tools/check-generated-artifact-reproducibility.mjs` makes of the same assembly.
 */
function resolveExporterAssembly() {
  const bin = join(exporterRoot, "bin");
  const configurations = directoriesIn(bin);
  const candidates = [];
  for (const configuration of configurations) {
    for (const framework of directoriesIn(join(bin, configuration))) {
      const assembly = join(bin, configuration, framework, ASSEMBLY);
      let stat;
      try {
        stat = statSync(assembly);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      candidates.push({ configuration, path: assembly, mtimeMs: stat.mtimeMs });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  return { searched: configurations, chosen: candidates[0] ?? null };
}

test("actual Mod descriptor projection is accepted by verifyActionProgram", async (t) => {
  const resolution = resolveExporterAssembly();
  const searched = resolution.searched.length === 0 ? "no configuration" : resolution.searched.join(", ");
  if (resolution.chosen === null) {
    t.skip(
      `no bin/<configuration>/<framework>/${ASSEMBLY} under ` +
        `integrations/stardew/tests/actiondevelopmentactionsurfaceexport (searched: ${searched}); ` +
        `build it with: ${BUILD_COMMAND}`,
    );
    return;
  }
  t.diagnostic(`exporter assembly: ${resolution.chosen.configuration} build at ${resolution.chosen.path}`);

  const { stdout, stderr } = await execFileAsync("dotnet", [resolution.chosen.path], {
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
  assert.equal(report.descriptorRevision, 1);
});
