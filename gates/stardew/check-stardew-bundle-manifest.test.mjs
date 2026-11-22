import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { declaredBundleFiles, evaluate } from "./check-stardew-bundle-manifest.mjs";

// red-proof: inject  a manifest entry renamed to `GameBuddy.Stardew.renamed.dll` in a copy of the tree reports
//   `mismatch:<new>:only_in_the_manifest` and `mismatch:<old>:only_in_the_build`, so the manifest is held to the build
//   rather than to itself.
// red-proof: inject  a `<None Update>` whose copy-to-output is removed reports `not_copied:<name>`, because a file the
//   project declares but does not emit is the shape that deploys a Mod SMAPI cannot load.

/**
 * The bundle manifest is held to the BUILD, and both directions are proved red.
 *
 * The defect this covers is the one ten declarations carried together: the manifest (and before it, ten literals)
 * states four file names, the project produces them, and nothing compared the two. So the proofs below are a rename on
 * EACH side - a manifest member the build does not produce, and a build output the manifest does not name - plus the
 * built-output reading, and a green control in the same tree.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "integrations/stardew/GameBuddy.Stardew.csproj";
const MANIFEST = "integrations/stardew/bundle.manifest.json";

/** A root carrying the real project and the real manifest, so a proof edits one of them and nothing else. */
function tree(label) {
  const root = mkdtempSync(join(tmpdir(), `stardew-bundle-${label}-`));
  for (const file of [
    PROJECT,
    MANIFEST,
    "integrations/stardew/src/Core/GameBuddy.Stardew.Core.csproj",
    // Carried because the recorded restatement's expiry is read from this tree, like any other reading here.
    "host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.ts",
  ]) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, readFileSync(join(REPO, file)));
  }
  return root;
}

function verdict(root) {
  const out = [];
  const err = [];
  const code = evaluate(root, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

test("the manifest and the project's declarations agree, and every built output carries them", () => {
  const root = tree("green");
  try {
    const { code, out, err } = verdict(root);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.match(out.join("\n"), /declarations examined 4/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manifest member the build does not produce is named on both sides", () => {
  const root = tree("manifest-renamed");
  try {
    const path = join(root, MANIFEST);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.Core.renamed.dll"),
    );
    const { code, err } = verdict(root);
    assert.equal(code, 1);
    assert.ok(
      err.includes("stardew_bundle_manifest_mismatch:GameBuddy.Stardew.Core.renamed.dll:only_in_the_manifest"),
      err.join(" | "),
    );
    assert.ok(
      err.includes("stardew_bundle_manifest_mismatch:GameBuddy.Stardew.Core.dll:only_in_the_build"),
      err.join(" | "),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an output the project renames is named from the build's side, without the manifest changing", () => {
  const root = tree("project-renamed");
  try {
    const path = join(root, PROJECT);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        '<Project Sdk="Microsoft.NET.Sdk">',
        '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <AssemblyName>GameBuddy.Stardew.Renamed</AssemblyName>\n  </PropertyGroup>',
      ),
    );
    assert.ok(declaredBundleFiles(root).includes("GameBuddy.Stardew.Renamed.dll"), "the project's own name is read");
    const { code, err } = verdict(root);
    assert.equal(code, 1);
    assert.ok(
      err.includes("stardew_bundle_manifest_mismatch:GameBuddy.Stardew.Renamed.dll:only_in_the_build"),
      err.join(" | "),
    );
    assert.ok(
      err.includes("stardew_bundle_manifest_mismatch:GameBuddy.Stardew.dll:only_in_the_manifest"),
      err.join(" | "),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a built output missing a manifest entry is named with the directory that lacks it", () => {
  const root = tree("built");
  try {
    const built = join(root, "integrations/stardew/bin/Release/net6.0");
    mkdirSync(built, { recursive: true });
    for (const file of ["GameBuddy.Stardew.dll", "GameBuddy.Stardew.Core.dll", "manifest.json"]) {
      writeFileSync(join(built, file), "built");
    }
    const { code, err } = verdict(root);
    assert.equal(code, 1);
    assert.ok(
      err.includes(
        "stardew_bundle_manifest_not_built:GameBuddy.Stardew.deps.json:integrations/stardew/bin/Release/net6.0",
      ),
      err.join(" | "),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a consumer that declares the names again is named, and a converted one is not", () => {
  const root = tree("restated");
  try {
    const consumer = join(root, "tools/some-runner.mjs");
    mkdirSync(dirname(consumer), { recursive: true });
    writeFileSync(
      consumer,
      'export const BUNDLE = Object.freeze(["GameBuddy.Stardew.dll", "GameBuddy.Stardew.Core.dll", "manifest.json"]);\n',
    );
    const restated = verdict(root);
    assert.equal(restated.code, 1);
    assert.ok(
      restated.err.some((line) => line.startsWith("stardew_bundle_name_restated:tools/some-runner.mjs:")),
      restated.err.join(" | "),
    );

    // The conversion this reading asks for: the same file reading the manifest instead.
    writeFileSync(
      consumer,
      'import { MOD_BUNDLE_FILE_NAMES } from "../../tools/lib/stardew-mod-bundle.mjs";\nexport const BUNDLE = MOD_BUNDLE_FILE_NAMES;\n',
    );
    // The recorded entry's expiry is checked against this temp tree too, so only the restatement reading is asserted.
    assert.deepEqual(
      verdict(root).err.filter((line) => line.startsWith("stardew_bundle_name_restated")),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a project this reader cannot find blocks rather than agreeing", () => {
  const root = mkdtempSync(join(tmpdir(), "stardew-bundle-absent-"));
  try {
    const { code, err } = verdict(root);
    assert.equal(code, 2);
    assert.match(err.join("\n"), /stardew_bundle_manifest_blocked:no_declarations/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
