/**
 * The gate's falsifiers. Each case builds a throwaway workspace tree, so the assertion is about what the gate READS,
 * not about this repository's current state (which the CLI run covers).
 *
 * red-proof: inject  delete `dist/tavern/index.js` from the fixture package the way a fresh checkout lacks it ->
 *            `vendor_artifact_missing:@cortexkit/pi-magic-context:./tavern:./dist/tavern/index.js`, status `failed`
 *            (the same injection against the real tree, renaming `vendor/…/dist/tavern` away, produced both the
 *            `.d.ts` and `.js` violations and exit 1).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkVendorBuildArtifacts } from "./check-vendor-build-artifacts.mjs";

/** A workspace root with one `file:` dependency whose `exports` are the given map. */
function workspace({ exports, files, declaration = "file:../vendor/plugin" }) {
  const root = mkdtempSync(join(tmpdir(), "vendor-artifacts-"));
  mkdirSync(join(root, "host"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - host\n", "utf8");
  writeFileSync(
    join(root, "host/package.json"),
    JSON.stringify({ name: "host", dependencies: { "@scope/plugin": declaration } }, null, 2),
    "utf8",
  );
  mkdirSync(join(root, "vendor/plugin"), { recursive: true });
  writeFileSync(
    join(root, "vendor/plugin/package.json"),
    JSON.stringify({ name: "@scope/plugin", exports }, null, 2),
    "utf8",
  );
  for (const file of files) {
    const absolute = join(root, "vendor/plugin", file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "export const shipped = true;\n", "utf8");
  }
  return root;
}

const conditionalExports = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  "./tavern": { types: "./dist/tavern/index.d.ts", import: "./dist/tavern/index.js" },
};

test("a built package with every promised path present passes, and the population is counted", () => {
  const root = workspace({
    exports: conditionalExports,
    files: ["dist/index.d.ts", "dist/index.js", "dist/tavern/index.d.ts", "dist/tavern/index.js"],
  });
  try {
    const result = checkVendorBuildArtifacts({ root });
    assert.equal(result.status, "passed");
    assert.equal(result.examined, 1, "the one file: dependency was examined");
    assert.equal(result.files, 4, "four promised paths were resolved");
    assert.deepEqual(result.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a subpath whose build output is absent fails by name, naming the file and the command that produces it", () => {
  const root = workspace({
    exports: conditionalExports,
    // Exactly the shape a fresh checkout has: the package's own entry exists, the built subpath does not.
    files: ["dist/index.d.ts", "dist/index.js"],
  });
  try {
    const result = checkVendorBuildArtifacts({ root });
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      [
        "vendor_artifact_missing:@scope/plugin:./tavern:./dist/tavern/index.d.ts",
        "vendor_artifact_missing:@scope/plugin:./tavern:./dist/tavern/index.js",
      ],
    );
    assert.match(result.violations[0].produce, /bun run --cwd vendor\/magic-context/u);
    assert.deepEqual(result.violations[0].declaredBy, ["host/package.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exports map written as a bare string is one entry point, not one per character", () => {
  // Measured 2026-11-07: `@gamebuddy/voice-protocol` declares `exports` as a string, `Object.entries` of it yields
  // its characters, and the gate reported fifteen missing files named `0`, `1`, `11`, `j`, `s`.
  const root = workspace({ exports: "./dist/index.js", files: ["dist/index.js"] });
  try {
    const result = checkVendorBuildArtifacts({ root });
    assert.equal(result.status, "passed");
    assert.equal(result.files, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace with no file: dependency is blocked, not passed", () => {
  const root = mkdtempSync(join(tmpdir(), "vendor-artifacts-none-"));
  mkdirSync(join(root, "host"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - host\n", "utf8");
  writeFileSync(join(root, "host/package.json"), JSON.stringify({ name: "host" }), "utf8");
  try {
    const result = checkVendorBuildArtifacts({ root });
    assert.equal(result.status, "blocked");
    assert.equal(result.examined, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an export that escapes its own package is named rather than silently resolved", () => {
  const root = workspace({ exports: { ".": "../../elsewhere/dist/index.js" }, files: [] });
  try {
    const result = checkVendorBuildArtifacts({ root });
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      ["vendor_artifact_target_outside:@scope/plugin:.:../../elsewhere/dist/index.js"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package that declares no exports is a statement, not a pass", () => {
  const root = workspace({ exports: undefined, files: [] });
  try {
    const result = checkVendorBuildArtifacts({ root });
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      ["vendor_artifact_no_exports:@scope/plugin"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
