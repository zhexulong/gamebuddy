import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const repositoryRoot = resolve(sourceRoot, "../..");
const forbidden = new Set([
  "integration-module.ts", "integration-types.ts", "gameplay-task-subagent.ts", "action-execution-coordinator.ts",
  "stardew-execution-recovery.ts", "farmhand.ts", "portfolio.ts", "voice.ts",
]);

async function localStaticClosure(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  async function visit(path: string): Promise<void> {
    if (seen.has(path)) return;
    seen.add(path);
    const source = await readFile(resolve(sourceRoot, path), "utf8");
    for (const match of source.matchAll(/^import(?!\s+type)[\s\S]*?from\s+["'](\.[^"']+)["'];|^import\s+["'](\.[^"']+)["'];/gm)) {
      const specifier = match[1] ?? match[2];
      const next = resolve(dirname(resolve(sourceRoot, path)), specifier).replace(/\.js$/, ".ts");
      const relative = next.slice(sourceRoot.length + 1).split("\\").join("/");
      await visit(relative);
    }
  }
  await visit(entry);
  return seen;
}

async function sourceFiles(root: string, extension: ".ts" | ".mjs"): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(path);
    }
  }
  await walk(root);
  return files;
}

test("Chat and Game callers select separate factories and Chat static closure excludes Game implementation", async () => {
  const [dialogue, bootstrap, gameFactory, closure] = await Promise.all([
    readFile(resolve(sourceRoot, "dialogue-web.ts"), "utf8"),
    readFile(resolve(sourceRoot, "integration-bootstrap.ts"), "utf8"),
    readFile(resolve(sourceRoot, "runtime-game.ts"), "utf8"),
    localStaticClosure("dialogue-web.ts"),
  ]);
  assert.match(dialogue, /createChatCompanionRuntime/);
  assert.doesNotMatch(dialogue, /createGameCompanionRuntime/);
  assert.match(bootstrap, /createGameCompanionRuntime/);
  assert.doesNotMatch(bootstrap, /createChatCompanionRuntime/);
  // The Game factory retains the previous admission, module tool set, execution
  // gate, World Book, presentation, and optional gameplay-subagent composition.
  for (const behavior of ["assertIntegrationModule", "assertIdentityBinding", "createToolSet", "gateIntegrationTool", "GameplayTaskSubagent", "createWorldBookTools", "createCompanionPresentationTools"]) {
    assert.match(gameFactory, new RegExp(behavior));
  }
  assert.deepEqual([...closure].filter((path) => forbidden.has(path)), []);
});

test("runtime and tool sources do not retain the removed compatibility entrypoint", async () => {
  const files = [
    ...await sourceFiles(sourceRoot, ".ts"),
    ...await sourceFiles(resolve(repositoryRoot, "tools"), ".mjs"),
  ];
  const removedFactory = ["create", "CompanionRuntime"].join("");
  const forbiddenReferences = new RegExp(`${removedFactory}|host\\/dist\\/runtime\\.js|\\.\\.\\/host\\/dist\\/runtime\\.js`);
  const matches = (await Promise.all(files.map(async (path) => ({
    path: relative(repositoryRoot, path).split("\\").join("/"),
    source: await readFile(path, "utf8"),
  })))).flatMap(({ path, source }) => forbiddenReferences.test(source) ? [path] : []);
  assert.deepEqual(matches, []);
});

test("core composer is explicitly internal and surface-neutral presentation types do not load Voice", async () => {
  const [core, presentationTypes] = await Promise.all([
    readFile(resolve(sourceRoot, "runtime-core.ts"), "utf8"),
    readFile(resolve(sourceRoot, "presentation-types.ts"), "utf8"),
  ]);
  for (const symbol of ["InternalRuntimeActionPolicy", "InternalRuntimeToolComposition", "InternalCreateRuntimeCoreOptions", "createInternalRuntimeCore"]) {
    assert.match(core, new RegExp(String.raw`\/\*\* @internal[\s\S]*?${symbol}`));
  }
  assert.match(presentationTypes, /Surface-neutral presentation port contract; importing this module does not load any Voice implementation\./);
  assert.doesNotMatch(presentationTypes, /^import .*voice/mi);
});
