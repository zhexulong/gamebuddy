import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runReports } from "./run-knip-reports.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(resolve(root, "knip.json"), "utf8"));
const expected = [".", "packages/*", "host", "voice-gateway", "dialogue-web", "integrations/stardew/action-development"];

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
  assert.ok(config.ignore.includes(".worktrees/**"));
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

test("pins scripts, exposes the clean scope, and validates the actual CLI contract", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(packageJson.devDependencies.knip, "6.34.0");
  assert.equal(packageJson.scripts["report:knip"], "knip --config knip.json --reporter json");
  assert.equal(packageJson.scripts["report:knip:production"], "knip --config knip.json --production --reporter json");
  assert.deepEqual(config.workspaces.host.project, ["src/**/*.{ts,tsx,mjs}", "scripts/**/*.mjs"]);
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
