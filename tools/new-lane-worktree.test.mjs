import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { decideArtifactCopy, modulesOutsideLane, planVendoredDistCopies } from "./new-lane-worktree.mjs";

/**
 * A lane is created once per piece of work and its first build is where every missing piece is discovered, one lane at
 * a time. Each case below is one of those discoveries, turned into a decision the creator makes before anything is
 * built - so the next lane is not the one that finds out.
 */

const LANE_ROOT = resolve("gb-lane-fixture");
const sha = (fill) => fill.repeat(64);

function manifest(inputs) {
  return { schema: "gamebuddy-host-test-artifact-build/v1", builtAtMs: 1, sourceRoot: "host/src", inputs };
}

test("a submodule package whose dist the lane lacks is listed for copying, and one that has it is not", () => {
  const packages = [
    "vendor/magic-context/packages/cli",
    "vendor/magic-context/packages/pi-plugin",
    "vendor/pi-koe/packages/voice-protocol",
  ];
  const copies = planVendoredDistCopies({
    packages,
    laneHasDist: (directory) => directory === "vendor/magic-context/packages/cli",
  });
  assert.deepEqual(
    copies.map((entry) => entry.package),
    ["vendor/magic-context/packages/pi-plugin", "vendor/pi-koe/packages/voice-protocol"],
    "every vendored package the lane cannot resolve must be copied; the compiler reports these as missing modules",
  );
  assert.deepEqual(copies[0], {
    package: "vendor/magic-context/packages/pi-plugin",
    source: "vendor/magic-context/packages/pi-plugin/dist",
    destination: "vendor/magic-context/packages/pi-plugin/dist",
  });
});

test("a lane that already carries every vendored dist copies nothing", () => {
  const packages = ["vendor/pi-koe/packages/voice-protocol"];
  assert.deepEqual(planVendoredDistCopies({ packages, laneHasDist: () => true }), []);
});

test("a dependency entry resolving into another tree is refused, in favour of the lane's own install", () => {
  const entries = [
    {
      path: "host/node_modules/typescript",
      resolved: resolve(LANE_ROOT, "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript"),
    },
    {
      path: "host/node_modules/@cortexkit/pi-magic-context",
      resolved: resolve(
        "..",
        "ai-game-companion",
        "node_modules/.pnpm/@cortexkit+x/node_modules/@cortexkit/pi-magic-context",
      ),
    },
  ];
  const outside = modulesOutsideLane({ laneRoot: LANE_ROOT, entries });
  assert.deepEqual(
    outside.map((entry) => entry.path),
    ["host/node_modules/@cortexkit/pi-magic-context"],
    "a junctioned install tree is exactly what makes the build refuse with dependency_outside_repository",
  );
});

test("every dependency entry resolving inside the lane passes the containment check", () => {
  const entries = [
    { path: "host/node_modules/typescript", resolved: resolve(LANE_ROOT, "node_modules/.pnpm/typescript/lib/tsc.js") },
    {
      path: "host/node_modules/@gamebuddy/voice-protocol",
      resolved: resolve(LANE_ROOT, "node_modules/.pnpm/voice/dist"),
    },
  ];
  assert.deepEqual(modulesOutsideLane({ laneRoot: LANE_ROOT, entries }), []);
});

test("the lane creator installs its own dependencies instead of linking another tree's", async () => {
  const source = await readFile(new URL("./new-lane-worktree.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /\bsymlink(?:Sync)?\s*\(/u,
    "a junctioned node_modules makes realpath(tsc) escape the repository, which the build and the verification manifest both refuse",
  );
});

test("the artifact is refused when one recorded input hash differs", () => {
  const decision = decideArtifactCopy({
    manifest: manifest({ "host/src/bridge.ts": sha("a"), "host/tsconfig.test.json": sha("c") }),
    inputs: [
      { path: "host/src/bridge.ts", sha256: sha("b"), mtimeMs: 0 },
      { path: "host/tsconfig.test.json", sha256: sha("c"), mtimeMs: 0 },
    ],
  });
  assert.equal(decision.copy, false);
  assert.equal(decision.drift.length, 1);
  assert.equal(decision.drift[0].code, "artifact_content_mismatch");
  assert.match(decision.reason, /host\/src\/bridge\.ts/u, "the refusal names the file that drifted");
});

test("the artifact is refused when the lane has an input the build never read", () => {
  const decision = decideArtifactCopy({
    manifest: manifest({ "host/src/bridge.ts": sha("a") }),
    inputs: [
      { path: "host/src/bridge.ts", sha256: sha("a"), mtimeMs: 0 },
      { path: "host/src/farmhand.ts", sha256: sha("d"), mtimeMs: 0 },
    ],
  });
  assert.equal(decision.copy, false);
  assert.equal(decision.drift[0].code, "artifact_input_unrecorded");
});

test("the artifact is granted when every recorded input matches, and counted", () => {
  const decision = decideArtifactCopy({
    manifest: manifest({ "host/src/bridge.ts": sha("a"), "host/package.json": sha("c") }),
    inputs: [
      { path: "host/src/bridge.ts", sha256: sha("a"), mtimeMs: 0 },
      { path: "host/package.json", sha256: sha("c"), mtimeMs: 0 },
    ],
  });
  assert.deepEqual(decision, { copy: true, inputs: 2 });
});

test("an artifact with no build manifest is refused, never copied on trust", () => {
  const decision = decideArtifactCopy({ manifest: undefined, inputs: [] });
  assert.equal(decision.copy, false);
  assert.match(decision.reason, /build-manifest\.json/u);
});
