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

  for (const finding of findings) err(finding);
  out(
    `stardew_bundle_manifest: declarations examined ${String(declared.length)} · manifest entries ${String(
      manifest.length,
    )} · built outputs examined ${String(builds.length)}${builds.length === 0 ? " (no Mod build in this tree: pnpm build:stardew)" : ""} · findings ${String(findings.length)}`,
  );
  return findings.length === 0 ? 0 : 1;
}

function rootFrom(argv) {
  const index = argv.indexOf("--root");
  return index < 0 ? REPOSITORY_ROOT : argv[index + 1];
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = evaluate(rootFrom(process.argv.slice(2)));
}
