#!/usr/bin/env node
/**
 * The Mod bundle is the BUILD's output, and one manifest beside the project is the only list of it.
 *
 * WHY (measured 2026-11-21). The same four file names were declared ten times: the fixture, the live-run isolation
 * check, the topology preflight, the multiplayer provisioner, two of their suites, and three Host test/test-support
 * files. Each was right the day it was written, and none was held to the thing that decides: the project that builds
 * them. Renaming an output in `GameBuddy.Stardew.csproj` leaves all ten wrong together, and the failure surfaces as a
 * deployed Mod SMAPI will not load - after a 150 second launch, naming nothing.
 *
 * THE POPULATION IS THE PROJECT'S OWN DECLARATIONS, not a list:
 *
 *   <AssemblyName>            the Mod assembly's output name (the project's base name when unset)
 *   <ProjectReference>        every referenced project's assembly, read from that project's own declaration
 *   <None Update> + copy       an item the project copies to its output (`manifest.json`, the SMAPI manifest)
 *   <GenerateDependencyFile>  the dependency file, whose name is `<assembly>.deps.json`
 *
 * Two readings, and they are counted apart:
 *
 *   DECLARATIONS  always measurable. `integrations/stardew/bundle.manifest.json` must name EXACTLY what those
 *                 declarations produce. A member only the manifest carries, or only the project produces, is
 *                 `stardew_bundle_manifest_mismatch:<member>`, and this reading alone decides the exit status.
 *   BUILT OUTPUTS every `integrations/stardew/bin/<configuration>/<framework>/` the tree holds that carries the
 *                 assembly must contain every manifest entry - `stardew_bundle_manifest_not_built:<member>:<dir>`.
 *                 A tree with no Mod build has nothing to read here and says so on the reading line rather than
 *                 counting as agreement; it does not fail the gate, because the declarations above always cover the
 *                 question the gate exists to answer. Build with `pnpm build:stardew` to move that count.
 *
 * ZERO DECLARATIONS BLOCKS. A csproj that names no output means this reader lost the project, not that the build
 * emits nothing: exit 2 with the reason.
 *
 * USAGE
 *   node tools/check-stardew-bundle-manifest.mjs            # the verdict; exit 0 agreed, 1 mismatch, 2 blocked
 *   node tools/check-stardew-bundle-manifest.mjs --root DIR # read another checkout
 *
 * red-proof: inject  a manifest entry renamed to `GameBuddy.Stardew.renamed.dll` reports
 *                     `stardew_bundle_manifest_mismatch:GameBuddy.Stardew.renamed.dll` and
 *                     `...:GameBuddy.Stardew.dll`, naming both sides of the drift
 *                     (tools/check-stardew-bundle-manifest.test.mjs)
 * red-proof: inject  a project whose `<AssemblyName>` moves reports the same mismatch from the other direction, with
 *                     the project's file named in the detail
 *                     (tools/check-stardew-bundle-manifest.test.mjs)
 */

// source-invariant: no compiler can require the committed manifest to equal what the project emits - the build is a
//   separate artifact, produced by a different tool, and a name can move in either one alone. This file reads the
//   project's declarations and the output directory because that comparison is the only thing that catches a rename.
// source-expiry: when `GameBuddy.Stardew.csproj` (or the build) generates the manifest and
//   `check-generated-artifact-reproducibility` covers it, retire this reading and compare two artifacts instead.

export const gateDeclaration = {
  id: "check-stardew-bundle-manifest",
  domain: "stardew",
  tier: "l0",
  kind: "contract",
};

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import process from "node:process";

import { STARDEW_BUNDLE_BUILD, STARDEW_BUNDLE_MANIFEST_PATH } from "./lib/stardew-mod-bundle.mjs";
import { vocabulariesIn } from "./check-fact-seams.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A project's own output name: an explicit `<AssemblyName>`, or the project file's base name. */
function assemblyOf(root, projectPath) {
  const source = readFileSync(join(root, projectPath), "utf8");
  const declared = /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/u.exec(source);
  return (declared === null ? basename(projectPath, ".csproj") : declared[1]).concat(".dll");
}

/** Every file the build produces from the project's own declarations; the empty set means the reader lost it. */
export function declaredBundleFiles(root, projectPath = STARDEW_BUNDLE_BUILD) {
  if (!existsSync(join(root, projectPath))) return [];
  const source = readFileSync(join(root, projectPath), "utf8");
  const files = [assemblyOf(root, projectPath)];
  for (const reference of source.matchAll(/<ProjectReference\s+Include="([^"]+\.csproj)"\s*\/>/gu)) {
    const referenced = join(projectPath, "..", reference[1].replaceAll("\\", "/")).replace(/\/+$/u, "");
    files.push(assemblyOf(root, referenced));
  }
  // An item copied to the output directory (`<None Update="manifest.json"><CopyToOutputDirectory>...`).
  for (const item of source.matchAll(
    /<None\s+Update="([^"]+)">\s*<CopyToOutputDirectory>[^<]+<\/CopyToOutputDirectory>/gu,
  )) {
    files.push(item[1]);
  }
  // The dependency file: the project must say it emits one, because its NAME is derived from the assembly.
  if (/<GenerateDependencyFile>\s*true\s*<\/GenerateDependencyFile>/u.test(source)) {
    files.push(files[0].replace(/\.dll$/u, ".deps.json"));
  }
  return files;
}

/** The files the manifest states, in its own order. */
export function manifestFiles(root) {
  const manifest = JSON.parse(readFileSync(join(root, STARDEW_BUNDLE_MANIFEST_PATH), "utf8"));
  return Array.isArray(manifest.files) ? manifest.files : [];
}

/** Every built Mod output directory the tree holds: `bin/<configuration>/<framework>/` carrying the assembly. */
export function builtOutputs(root, projectPath = STARDEW_BUNDLE_BUILD, assembly = "GameBuddy.Stardew.dll") {
  const projectDirectory = join(root, projectPath, "..");
  const bin = join(projectDirectory, "bin");
  const found = [];
  let configurations = [];
  try {
    configurations = readdirSync(bin);
  } catch {
    return found;
  }
  for (const configuration of configurations.sort()) {
    let frameworks = [];
    try {
      frameworks = readdirSync(join(bin, configuration));
    } catch {
      continue;
    }
    for (const framework of frameworks.sort()) {
      const directory = join(bin, configuration, framework);
      try {
        if (!statSync(join(directory, assembly)).isFile()) continue;
      } catch {
        continue;
      }
      found.push(relative(root, directory).replaceAll("\\", "/"));
    }
  }
  return found;
}

/** The gate. `out` receives the reading, `err` the findings; the exit code is the verdict. */
export function evaluate(root, { out = console.log, err = console.error } = {}) {
  const declared = declaredBundleFiles(root);
  if (declared.length === 0) {
    err(`stardew_bundle_manifest_blocked:no_declarations:${STARDEW_BUNDLE_BUILD}`);
    return 2;
  }
  const manifest = manifestFiles(root);
  if (manifest.length === 0) {
    err(`stardew_bundle_manifest_blocked:no_manifest:${STARDEW_BUNDLE_MANIFEST_PATH}`);
    return 2;
  }
  const findings = [];
  for (const file of manifest) {
    if (!declared.includes(file)) findings.push(`stardew_bundle_manifest_mismatch:${file}:only_in_the_manifest`);
  }
  for (const file of declared) {
    if (!manifest.includes(file)) findings.push(`stardew_bundle_manifest_mismatch:${file}:only_in_the_build`);
  }
  // The ORDER is a fact the Host deploys by: `manifest.json` last means an install interrupted before it is not a
  // loadable Mod directory. A manifest that ends with anything else is an install contract nobody stated.
  if (manifest.at(-1) !== "manifest.json") {
    findings.push(`stardew_bundle_manifest_order:${String(manifest.at(-1))}:manifest.json-must-be-last`);
  }

  const builds = builtOutputs(root);
  for (const directory of builds) {
    for (const file of manifest) {
      if (!existsSync(join(root, directory, file))) {
        findings.push(`stardew_bundle_manifest_not_built:${file}:${directory}`);
      }
    }
  }

  // A consumer that spells the names again is the defect this gate replaced ten of; the reading is derived, so a
  // consumer added tomorrow fails by being a list, and a recorded one EXPIRES when it stops being one.
  const restating = restatingDeclarations(root, manifest);
  for (const declaration of restating) {
    const known = KNOWN_RESTATEMENTS.find(
      (entry) => entry.file === declaration.file && entry.name === declaration.name,
    );
    if (known === undefined) {
      findings.push(
        `stardew_bundle_name_restated:${declaration.file}:${declaration.line}:${declaration.name} (${declaration.members.join(", ")}) - import tools/lib/stardew-mod-bundle.mjs instead`,
      );
    }
  }
  for (const entry of KNOWN_RESTATEMENTS) {
    if (!recordStillPresent(root, entry)) {
      findings.push(
        `stale_stardew_bundle_restatement:${entry.file}:${entry.name} (${entry.marker} is gone: delete the record)`,
      );
    }
  }

  for (const finding of findings) err(finding);
  out(
    `stardew_bundle_manifest: declarations examined ${String(declared.length)} · manifest entries ${String(
      manifest.length,
    )} · built outputs examined ${String(builds.length)}${builds.length === 0 ? " (no Mod build in this tree: pnpm build:stardew)" : ""} · restating declarations examined ${String(restating.length)} (recorded ${String(KNOWN_RESTATEMENTS.filter((entry) => restating.some((declaration) => declaration.file === entry.file && declaration.name === entry.name)).length)}) · findings ${String(findings.length)}`,
  );
  return findings.length === 0 ? 0 : 1;
}

/**
 * The files a restating list may still live in, each with the reason and the owner who owes the conversion.
 *
 * Not a waiver list: an entry EXPIRES. Once the file stops declaring two of these names, the record describes a tree
 * that is not this one and the gate fails on `stale_stardew_bundle_restatement`, the same expiry the fact-seams ledger
 * uses - so a paid debt cannot outlive its payment or hide behind the record.
 */
export const KNOWN_RESTATEMENTS = Object.freeze([
  {
    file: "host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.ts",
    name: "PHASE_B_PACKAGE_ENTRIES",
    marker: "const PHASE_B_PACKAGE_ENTRIES = Object.freeze([",
    reason:
      "this list orders the same four names and compares them with JSON.stringify, so the Host's own staging contract needs them as a compile-time tuple; host/tsconfig.json sets rootDir=src and does not enable resolveJsonModule, so the manifest cannot be imported from integrations/ without a build-config change. It is also invisible to the shared vocabulary reader (`Object.freeze([...] as const)` in a file whose brace depth that reader mis-reads), which is why the record checks its own marker",
    owner: "the stardew lifecycle lane",
  },
]);

/** The roots a bundle name could be spelled as a list in. */
const SCANNED_ROOTS = Object.freeze(["tools", "host/src", "dialogue-web/src"]);

/** The two readers, which are the files allowed to hold the names without importing one. */
const READERS = Object.freeze(["tools/lib/stardew-mod-bundle.mjs", "host/src/stardew-mod-bundle.test-support.ts"]);

/**
 * Every file that declares a module-level list of two or more of the bundle's names without reading the manifest.
 *
 * The population comes from the ARTIFACT: the names looked for are the manifest's own, so a consumer added tomorrow
 * joins by declaring a list of them. A file that names ONE of them in a path (`BUNDLE_MANIFEST_ENTRY_DLL`, `releaseDll`)
 * is not a second list of the bundle, which is why the threshold is two, and a test that writes the names into a
 * directory to build a package is not a second list either - it builds the artifact, it does not decide it.
 */
export function restatingDeclarations(root, files = manifestFiles(root)) {
  const found = [];
  const walk = (directory) => {
    let entries = [];
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (/^(?:node_modules|dist|build|\.)/u.test(entry.name)) continue;
        walk(path);
        continue;
      }
      if (!/\.(?:ts|tsx|mjs|cjs)$/u.test(entry.name)) continue;
      // A scratch copy is not a declaration the tree owns (`tools/.soft-suite.tmp.test.mjs`).
      if (/\.tmp\./u.test(entry.name)) continue;
      if (READERS.includes(path)) continue;
      // A consumer that reads the manifest is not restating it, whatever else it names.
      if (readFileSync(join(root, path), "utf8").includes("stardew-mod-bundle")) continue;
      for (const list of vocabulariesIn(root, path)) {
        const shared = list.members.filter((member) => files.includes(member));
        if (shared.length >= 2) found.push({ file: path, line: list.line, name: list.name, members: shared });
      }
    }
  };
  for (const directory of SCANNED_ROOTS) walk(directory);
  return found;
}

/** Whether a recorded restatement is still in the tree: its own marker, not a vocabulary parse it cannot pass. */
function recordStillPresent(root, entry) {
  try {
    return readFileSync(join(root, entry.file), "utf8").includes(entry.marker);
  } catch {
    return false;
  }
}

function rootFrom(argv) {
  const index = argv.indexOf("--root");
  return index < 0 ? REPOSITORY_ROOT : argv[index + 1];
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = evaluate(rootFrom(process.argv.slice(2)));
}
