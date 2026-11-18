import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const emittedRoot = resolve(hostRoot, ".stardew-package-contract-live-test");
const contractSource = resolve(hostRoot, "src", "stardew-mod-package-contract.json");

async function emitContractModule() {
  await rm(emittedRoot, { recursive: true, force: true });
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve(hostRoot, "node_modules", "typescript", "lib", "tsc.js"), "--project", resolve(hostRoot, "tsconfig.production.json"), "--outDir", emittedRoot, "--pretty", "false"], { cwd: hostRoot, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error("contract_emit_failed")));
  });
}

/*
 * The baseline is DERIVED from the contract, not restated beside it. It used to be a hand-written copy of
 * the deps graph the 8.0 SDK emitted (two packages plus Pathoschild.Stardew.ModBuildConfig, Core at
 * assemblyVersion 1.0.0); when the SDK pin moved to 10.0.404 the emitter dropped the build-only package and
 * reported Core as 1.0.0.0, the contract was re-derived from the real output, and the copy here still held
 * the old shape - a second spelling of one fact, red against the contract it was supposed to exercise.
 * What this test proves is the verifier's force (a tampered field is refused), so its baseline comes from
 * the authority it is exercised against.
 */
function canonicalDeps(contract) {
  const authority = contract.dependencyAuthority;
  const target = {};
  for (const key of authority.targetKeys) {
    const rule = authority.packages[key];
    const entry = {};
    if (rule.dependencies !== undefined) entry.dependencies = { ...rule.dependencies };
    if (rule.runtime !== undefined)
      entry.runtime = Object.fromEntries(
        Object.entries(rule.runtime).map(([name, meta]) => [name, Array.isArray(meta) && meta.length === 0 ? {} : { ...meta }]),
      );
    target[key] = entry;
  }
  return {
    runtimeTarget: { ...authority.runtimeTarget },
    compilationOptions: {},
    targets: { [authority.targetFramework]: target },
    libraries: Object.fromEntries(authority.libraryKeys.map((key) => [key, {}])),
  };
}

test("canonical package baseline accepts and wrong runtime version rejects", async () => {
  await emitContractModule();
  const module = await import(pathToFileURL(resolve(emittedRoot, "stardew-mod-package-contract.js")).href);
  const root = await mkdtemp(process.platform === "win32" ? "C:\\gb-package-contract-" : resolve(tmpdir(), "gamebuddy-stardew-package-contract-"));
  try {
    await copyFile(contractSource, resolve(root, "stardew-mod-package-contract.json"));
    const contract = await module.readPublishedStardewModPackageContract(root);
    const packageRoot = resolve(root, ...contract.descriptor.destination.split("/"));
    await mkdir(packageRoot, { recursive: true });
    for (const name of contract.entries) await writeFile(resolve(packageRoot, name), name === "manifest.json" ? JSON.stringify(contract.manifestIdentity) : name === "GameBuddy.Stardew.deps.json" ? JSON.stringify(canonicalDeps(contract)) : `fixture:${name}`);
    const inspector = await (await import(pathToFileURL(resolve(emittedRoot, "windows-reparse-inspector", "index.js")).href)).BUILD_ARTIFACT_REPARSE_INSPECTION.create();
    await module.verifyPublishedStardewModPackage(root, contract, inspector);
    const depsPath = resolve(packageRoot, "GameBuddy.Stardew.deps.json");
    const deps = JSON.parse(await readFile(depsPath, "utf8"));
    const postTamperDepsPath = resolve(packageRoot, "GameBuddy.Stardew.deps.json");
    const postTamperDeps = JSON.parse(await readFile(postTamperDepsPath, "utf8"));
    postTamperDeps.targets[".NETCoreApp,Version=v6.0"]["GameBuddy.Stardew.Core/1.0.0"].runtime["GameBuddy.Stardew.Core.dll"].fileVersion = "1.0.0.1";
    await writeFile(postTamperDepsPath, JSON.stringify(postTamperDeps));
    await assert.rejects(module.verifyPublishedStardewModPackage(root, contract, inspector), /stardew_published_mod_package_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(emittedRoot, { recursive: true, force: true }); }
});
