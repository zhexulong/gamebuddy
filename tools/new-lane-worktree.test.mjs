import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  decideArtifactCopy,
  describeMissingMounts,
  LANE_MOUNTS,
  LANE_NATIVE_PAIR_ROOT,
  modulesOutsideLane,
  planLaneMounts,
  planVendoredDistCopies,
} from "./new-lane-worktree.mjs";

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

test("every mount the main tree has is linked, because a copy would be 637 MB of read-only input and would drift", () => {
  const plan = planLaneMounts({ exists: () => true });
  assert.deepEqual(
    plan.links.map((mount) => mount.path),
    LANE_MOUNTS.map((mount) => mount.path),
    "the population is the declaration, so a mount added to LANE_MOUNTS cannot be silently skipped",
  );
  assert.deepEqual(plan.missing, []);
  for (const mount of plan.links) assert.match(mount.neededBy, /prelive l0b/u);
});

test("a mount the main tree lacks is refused by name, because the gate that needed it fails naming no path", () => {
  const plan = planLaneMounts({ mounts: LANE_MOUNTS, exists: (path) => path !== "design" });
  assert.deepEqual(
    plan.missing.map((mount) => mount.path),
    ["design"],
  );
  const [line] = describeMissingMounts(plan.missing);
  assert.match(line, /design\//u, "the refusal names the directory");
  assert.match(line, /design\/gameplay-capability-catalog\.json/u, "and the input inside it that the rung reads");
});

/**
 * The pair is placed where the live-run launcher checks, and the launcher is the authority for that path: its own URL
 * says where it looks. If the launcher's path changes - or leaves `native/` and the copy becomes unnecessary - this
 * fails rather than letting the scaffold publish to a directory nobody reads.
 */
test("the native pair is placed where the live-run launcher checks for it", async () => {
  const launcher = fileURLToPath(
    new URL("../tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs", import.meta.url),
  );
  const source = await readFile(launcher, "utf8");
  const declared = /new URL\(\s*"([^"]*windows-stale-lock-reclaimer[^"]*)"\s*,\s*import\.meta\.url\s*\)/u.exec(source);
  assert.notEqual(declared, null, "the launcher's pair root must be a URL the scaffold can resolve");
  const checked = relative(resolve("."), fileURLToPath(new URL(declared[1], pathToFileURL(launcher))))
    .split(sep)
    .join("/");
  assert.equal(checked, LANE_NATIVE_PAIR_ROOT);
});

test("the lane creator installs its own dependencies instead of linking another tree's", async () => {
  const source = await readFile(new URL("./new-lane-worktree.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /symlink\([\s\S]{0,80}node_modules/u,
    "a junctioned node_modules makes realpath(tsc) escape the repository, which the build and the verification manifest both refuse; `assertInstallIsLocal` is the check that must stay able to refuse",
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
