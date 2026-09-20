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

function canonicalDeps() {
  return {
    runtimeTarget: { name: ".NETCoreApp,Version=v6.0", signature: "" }, compilationOptions: {},
    targets: { ".NETCoreApp,Version=v6.0": {
      "GameBuddy.Stardew/1.0.0": { dependencies: { "GameBuddy.Stardew.Core": "1.0.0", "Pathoschild.Stardew.ModBuildConfig": "4.4.0" }, runtime: { "GameBuddy.Stardew.dll": {} } },
      "Pathoschild.Stardew.ModBuildConfig/4.4.0": {},
      "GameBuddy.Stardew.Core/1.0.0": { runtime: { "GameBuddy.Stardew.Core.dll": { assemblyVersion: "1.0.0", fileVersion: "1.0.0.0" } } },
    } },
    libraries: {
      "GameBuddy.Stardew/1.0.0": { type: "project", serviceable: false, sha512: "" },
      "Pathoschild.Stardew.ModBuildConfig/4.4.0": { type: "package", serviceable: true, sha512: "opaque", path: "pathoschild.stardew.modbuildconfig/4.4.0", hashPath: "pathoschild.stardew.modbuildconfig.4.4.0.nupkg.sha512" },
      "GameBuddy.Stardew.Core/1.0.0": { type: "project", serviceable: false, sha512: "" },
    },
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
    for (const name of contract.entries) await writeFile(resolve(packageRoot, name), name === "manifest.json" ? JSON.stringify(contract.manifestIdentity) : name === "GameBuddy.Stardew.deps.json" ? JSON.stringify(canonicalDeps()) : `fixture:${name}`);
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
