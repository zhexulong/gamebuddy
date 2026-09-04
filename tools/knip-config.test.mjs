import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pnpmCommand, pnpmSpawnOptions, runReports, validReport } from "./run-knip-reports.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(resolve(root, "knip.json"), "utf8"));
const productionArtifactConfig = JSON.parse(await readFile(resolve(root, "host/production-artifact.config.json"), "utf8"));
const productionTsconfig = JSON.parse(await readFile(resolve(root, "host/tsconfig.production.json"), "utf8"));
const expected = [".", "packages/*", "host", "voice-gateway", "dialogue-web", "integrations/stardew/action-development"];
const productionSourceForArtifactRoot = (artifactRoot) => `src/${artifactRoot.replace(/\.js$/, ".ts")}`;
// Artifact closure roots are not all independent Knip entries: only verification roots
// explicitly compiled by the production tsconfig are projected; transitive roots stay
// covered by their importing production entry.
const explicitVerificationRoots = productionArtifactConfig.verificationRoots.filter((artifactRoot) =>
  productionTsconfig.files.includes(productionSourceForArtifactRoot(artifactRoot))
);
const transitiveVerificationRoots = productionArtifactConfig.verificationRoots.filter((artifactRoot) =>
  !productionTsconfig.files.includes(productionSourceForArtifactRoot(artifactRoot))
);
const expectedHostProductionEntries = [
  ...productionArtifactConfig.entryRoots,
  ...explicitVerificationRoots,
].map((artifactRoot) => `${productionSourceForArtifactRoot(artifactRoot)}!`);
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
    const result = await exec(pnpmCommand, ["exec", "knip", ...args], { cwd, encoding: "utf8", ...pnpmSpawnOptions });
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
  assert.deepEqual(hostEntries, expectedHostProductionEntries);

  for (const entryRoot of productionArtifactConfig.entryRoots) {
    const sourceFile = productionSourceForArtifactRoot(entryRoot);
    assert.ok(productionTsconfig.files.includes(sourceFile), `production tsconfig must include host/${sourceFile}`);
    await access(resolve(root, "host", sourceFile));
  }
  for (const entryRoot of explicitVerificationRoots) {
    const sourceFile = productionSourceForArtifactRoot(entryRoot);
    await access(resolve(root, "host", sourceFile));
  }
  for (const entryRoot of transitiveVerificationRoots) {
    assert.ok(!hostEntries.includes(`${productionSourceForArtifactRoot(entryRoot)}!`), `transitive verification root must not become a Knip entry: ${entryRoot}`);
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
    ...expectedHostProductionEntries,
    "src/main.ts!",
    "src/main.tsx!",
  ]);
  assert.ok(!productionEntries.some((pattern) => pattern.includes("src/**/*")));
  assert.ok(!config.workspaces["."].project.some((pattern) => pattern.startsWith("host/")));
  assert.ok(!config.workspaces["."].entry.some((pattern) => pattern.startsWith("host/**/*.")));
  // Node cannot execute Windows .cmd shims with shell:false; the runner contract above
  // covers the required command/options without reintroducing shell interpretation here.
  if (process.platform === "win32") return;
  const versionResult = await cli(["--version"]);
  assert.equal((versionResult.stdout || versionResult.stderr).trim(), "6.34.0");
  const helpResult = await cli(["--help"]);
  const help = `${helpResult.stdout}\n${helpResult.stderr}`;
  for (const option of ["--config", "--reporter", "--production"]) assert.match(help, new RegExp(option));
  for (const args of [["--config", "knip.json", "--reporter", "json"], ["--config", "knip.json", "--production", "--reporter", "json"]]) {
    const result = await cli(args);
    assert.ok([0, 1].includes(result.code), `${args.join(" ")} exited ${result.code}: ${result.stderr}`);
    assert.ok(validReport(JSON.parse(result.stdout)));
  }
});

test("proves pinned CLI finding and fatal-error contracts in an isolated config", async () => {
  if (process.platform === "win32") return;
  const fixture = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-cli-test-"));
  try {
    await writeFile(resolve(fixture, "knip.json"), JSON.stringify({ workspaces: { ".": { entry: ["entry.mjs"], project: ["*.mjs"] } } }));
    await writeFile(resolve(fixture, "entry.mjs"), "export const entry = true;\n");
    await writeFile(resolve(fixture, "orphan.mjs"), "export const orphan = true;\n");
    const finding = await cli(["--config", "knip.json", "--reporter", "json"], fixture);
    assert.equal(finding.code, 1);
    assert.ok(validReport(JSON.parse(finding.stdout)));
    await writeFile(resolve(fixture, "knip-invalid.json"), "{\"workspaces\": {");
    const invalidConfig = await cli(["--config", "knip-invalid.json", "--reporter", "json"], fixture);
    assert.equal(invalidConfig.code, 2);
    const unknownOption = await cli(["--config", "knip.json", "--reporter", "json", "--definitely-unknown"], fixture);
    assert.equal(unknownOption.code, 2);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("accepts the complete Knip JSON reporter shape and rejects malformed nested rows", () => {
  const item = { name: "unused", namespace: "ns", kind: "variable", specifier: "./dep.mjs", line: 3, col: 5, pos: 42 };
  const report = {
    issues: [{
      file: "src/example.mjs",
      owners: [{ name: "owner" }],
      binaries: [{ name: "tool" }],
      catalog: [item], catalogReferences: [item], dependencies: [item], devDependencies: [item],
      enumMembers: [item], exports: [item], files: [item], namespaceMembers: [item], nsExports: [item], nsTypes: [item],
      optionalPeerDependencies: [item], types: [item], unresolved: [item], unlisted: [{ name: "unlisted" }],
      cycles: [[item, { name: "cycle-end", namespace: "ns", kind: "module" }]],
      duplicates: [[item]],
    }],
  };
  assert.equal(validReport(report), true);
  for (const malformed of [
    {}, { issues: [{}] }, { issues: [{ file: "x.mjs", unknown: [] }] },
    { issues: [{ file: "x.mjs", files: [{ name: "" }] }] },
    { issues: [{ file: "x.mjs", files: [{ name: "x.mjs", line: "1" }] }] },
    { issues: [{ file: "x.mjs", files: "truncated" }] },
    { issues: [{ file: "x.mjs", cycles: [{ name: "not-a-cycle" }] }] },
    { issues: [{ file: "x.mjs", duplicates: [[{ name: "x", col: -1 }]] }] },
    { issues: [{ file: "x.mjs", nsExports: [{ name: "x", extra: true }] }] },
  ]) assert.equal(validReport(malformed), false, JSON.stringify(malformed));
  assert.equal(validReport({ issues: [] }), true);
});

test("uses the platform-local pnpm command without shell interpretation", async () => {
  assert.equal(pnpmCommand, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  assert.deepEqual(pnpmSpawnOptions, { shell: false });
  const output = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-command-test-"));
  await rm(output, { recursive: true, force: true });
  const calls = [];
  const result = await runReports(output, {
    run: async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: '{"issues":[]}', stderr: "" };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [
    { command: pnpmCommand, args: ["exec", "knip", "--config", "knip.json", "--reporter", "json"] },
    { command: pnpmCommand, args: ["exec", "knip", "--config", "knip.json", "--reporter", "json", "--production"] },
  ]);
  await rm(result.output, { recursive: true, force: true });
});

test("promotes valid finding reports and returns exit code 1", async () => {
  const output = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-test-"));
  await rm(output, { recursive: true, force: true });
  const result = await runReports(output, {
    run: async () => ({ code: 1, stdout: JSON.stringify({ issues: [{ file: "src/example.mjs", files: [{ name: "src/example.mjs" }] }] }), stderr: "findings" }),
  });
   assert.equal(result.exitCode, 1);
   assert.equal(result.results.filter(({ finding }) => finding).length, 2);
   for (const name of ["workspace.json", "production.json"]) {
     const promoted = JSON.parse(await readFile(resolve(result.output, name), "utf8"));
     assert.deepEqual(promoted, { issues: [{ file: "src/example.mjs", files: [{ name: "src/example.mjs" }] }] });
   }
   await rm(result.output, { recursive: true, force: true });
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

test("rejects pre-existing output and repository-contained parents", async () => {
  const existing = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-existing-"));
  await assert.rejects(() => runReports(existing), /must not already exist/);
  await rm(existing, { recursive: true, force: true });
  const parent = await mkdtemp(resolve(root, "knip-parent-test-"));
  try {
    await assert.rejects(() => runReports(resolve(parent, "output")), /outside the repository/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects symlinked repository parents", async () => {
  const outside = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-symlink-"));
  const link = resolve(outside, "repository-link");
  try {
    await symlink(root, link, "junction");
    await assert.rejects(() => runReports(resolve(link, "reports")), /outside the repository/);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
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
