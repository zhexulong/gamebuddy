import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runReports } from "./run-knip-reports.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(resolve(root, "knip.json"), "utf8"));
const productionArtifactConfig = JSON.parse(await readFile(resolve(root, "host/production-artifact.config.json"), "utf8"));
const productionTsconfig = JSON.parse(await readFile(resolve(root, "host/tsconfig.production.json"), "utf8"));
const expected = [".", "packages/*", "host", "voice-gateway", "dialogue-web", "integrations/stardew/action-development"];
const approvedIgnore = [
  ".worktrees/**",
  "vendor/magic-context/**",
  "**/dist/**",
  "**/dist-test/**",
  "**/node_modules/**",
  "**/.tmp/**",
  "**/artifacts/**",
  "**/coverage/**",
  "**/playwright-report/**",
];

async function cli(args, cwd = root) {
  try {
    const result = await exec("pnpm", ["exec", "knip", ...args], { cwd, encoding: "utf8", shell: process.platform === "win32" });
    return { ...result, stdout: result.stdout || result.stderr, code: 0 };
  } catch (error) {
    return { ...error, stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? error.status };
  }
}

test("declares the pnpm workspace projection and safe exclusions", async () => {
  assert.deepEqual(Object.keys(config.workspaces), expected);
  assert.deepEqual(config.workspaces["."], {
    entry: ["tools/*.mjs"],
    project: ["tools/**/*.mjs"],
  });
  assert.deepEqual(config.ignore, approvedIgnore);
  for (const broadProductionIgnore of ["**/src/**", "**/src/**/*", "host/src/**", "dialogue-web/src/**"]) {
    assert.ok(!config.ignore.includes(broadProductionIgnore), `production source must not be ignored: ${broadProductionIgnore}`);
  }
  const workspace = await readFile(resolve(root, "pnpm-workspace.yaml"), "utf8");
  for (const path of expected.slice(1)) assert.match(workspace, new RegExp(`^  - ${path.replace("*", "\\*")}\\s*$`, "m"));
  assert.match(workspace, /!vendor\/magic-context\/\*\*/);
  assert.deepEqual(config.workspaces["integrations/stardew/action-development"].project, ["src/**/*.mjs", "tests/**/*.mjs", "scripts/**/*.mjs", "scenarios/**/*.mjs"]);
  for (const pattern of [
    "vendor/magic-context/**",
    "**/dist/**",
    "**/dist-test/**",
    "**/node_modules/**",
    "**/.tmp/**",
    "**/artifacts/**",
    "**/coverage/**",
    "**/playwright-report/**",
  ]) assert.ok(config.ignore.includes(pattern));
});

test("maps Host production entries to artifact roots and production TypeScript files", async () => {
  const hostEntries = config.workspaces.host.entry.filter((pattern) => pattern.endsWith("!"));
  const expectedHostEntries = productionArtifactConfig.entryRoots.map((rootName) => `src/${rootName.replace(/\.js$/, ".ts")}!`);
  assert.deepEqual(hostEntries, expectedHostEntries);

  for (const entryRoot of productionArtifactConfig.entryRoots) {
    const sourceFile = `src/${entryRoot.replace(/\.js$/, ".ts")}`;
    assert.ok(productionTsconfig.files.includes(sourceFile), `production tsconfig must include host/${sourceFile}`);
    await access(resolve(root, "host", sourceFile));
  }

  const dialogueWebEntry = config.workspaces["dialogue-web"].entry;
  assert.deepEqual(dialogueWebEntry, ["src/main.tsx!"]);
  await access(resolve(root, "dialogue-web/src/main.tsx"));
});

test("pins scripts, exposes the clean scope, and validates the actual CLI contract", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(packageJson.devDependencies.knip, "6.34.0");
  assert.equal(packageJson.scripts["report:knip"], "knip --config knip.json --reporter json");
  assert.equal(packageJson.scripts["report:knip:production"], "knip --config knip.json --production --reporter json");
  assert.deepEqual(config.workspaces.host.project, ["src/**/*.{ts,tsx,mjs}", "scripts/**/*.mjs"]);
  const productionEntries = Object.values(config.workspaces).flatMap(({ entry }) => entry.filter((pattern) => pattern.endsWith("!")));
  assert.deepEqual(productionEntries, [
    "src/index.{js,mjs,ts,tsx}!",
    "src/process-supervisor.mjs!",
    "src/verifier.mjs!",
    "src/model.mjs!",
    "src/descriptors.mjs!",
    "bin/game-action.mjs!",
    "src/main.ts!",
    "src/dialogue-web-main.ts!",
    "src/stardew-attachment.ts!",
    "src/farmhand-companion-preview.ts!",
    "src/main.ts!",
    "src/main.tsx!",
  ]);
  assert.ok(!productionEntries.some((pattern) => pattern.includes("src/**/*")));
  assert.ok(!config.workspaces["."].project.some((pattern) => pattern.startsWith("host/")));
  assert.ok(!config.workspaces["."].entry.some((pattern) => pattern.startsWith("host/**/*.")));
  const versionResult = await cli(["--version"]);
  assert.equal((versionResult.stdout || versionResult.stderr).trim(), "6.34.0");
  const helpResult = await cli(["--help"]);
  const help = `${helpResult.stdout}\n${helpResult.stderr}`;
  for (const option of ["--config", "--reporter", "--production"]) assert.match(help, new RegExp(option));
  for (const args of [["--config", "knip.json", "--reporter", "json"], ["--config", "knip.json", "--production", "--reporter", "json"]]) {
    const result = await cli(args);
    assert.ok([0, 1].includes(result.code), `${args.join(" ")} exited ${result.code}: ${result.stderr}`);
    assert.ok(JSON.parse(result.stdout).issues);
  }
});

test("classifies errors and preserves independent valid reports", async () => {
  const output = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-test-"));
  await rm(output, { recursive: true, force: true });
  let calls = 0;
  const result = await runReports(output, {
    run: async () => {
      calls++;
      return calls === 1 ? { code: 1, stdout: '{"issues":[]}', stderr: "" } : { code: 2, stdout: "{}", stderr: "bad config" };
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(await readFile(resolve(result.output, "workspace.json"))), { issues: [] });
  await assert.rejects(() => runReports(result.output, { run: async () => ({ code: 0, stdout: '{"issues":[]}', stderr: "" }) }));
  await rm(result.output, { recursive: true, force: true });
});

test("rejects invalid JSON and spawn failures without promotion", async () => {
  for (const response of [{ code: 0, stdout: "not json", stderr: "" }, { code: null, stdout: "", stderr: "", error: new Error("missing") }]) {
    const output = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-test-"));
    await rm(output, { recursive: true, force: true });
    const result = await runReports(output, { run: async () => response });
    assert.equal(result.exitCode, 2);
    await assert.rejects(() => readFile(resolve(result.output, "workspace.json")));
    await rm(result.output, { recursive: true, force: true });
  }
});
