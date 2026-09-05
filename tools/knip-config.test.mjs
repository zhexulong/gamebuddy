import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  pnpmCommand,
  pnpmSpawnOptions,
  runReports as productionRunReports,
  evaluateFindingLedger,
  validateFindingLedger,
  validReport,
} from "./run-knip-reports.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const knipCli = resolve(root, "node_modules/knip/bin/knip.js");
const config = JSON.parse(await readFile(resolve(root, "knip.json"), "utf8"));
const productionArtifactConfig = JSON.parse(
  await readFile(resolve(root, "host/production-artifact.config.json"), "utf8"),
);
const productionTsconfig = JSON.parse(await readFile(resolve(root, "host/tsconfig.production.json"), "utf8"));
const expected = [
  ".",
  "packages/*",
  "host",
  "voice-gateway",
  "dialogue-web",
  "integrations/stardew/action-development",
];
const productionSourceForArtifactRoot = (artifactRoot) => `src/${artifactRoot.replace(/\.js$/, ".ts")}`;
// Artifact closure roots are not all independent Knip entries: only verification roots
// explicitly compiled by the production tsconfig are projected; transitive roots stay
// covered by their importing production entry.
const explicitVerificationRoots = productionArtifactConfig.verificationRoots.filter((artifactRoot) =>
  productionTsconfig.files.includes(productionSourceForArtifactRoot(artifactRoot)),
);
const transitiveVerificationRoots = productionArtifactConfig.verificationRoots.filter(
  (artifactRoot) => !productionTsconfig.files.includes(productionSourceForArtifactRoot(artifactRoot)),
);
const expectedHostProductionEntries = [
  ...productionArtifactConfig.entryRoots,
  ...explicitVerificationRoots,
  "tavern/static-artifact/index.js",
].map((artifactRoot) => `${productionSourceForArtifactRoot(artifactRoot)}!`);
const dialogueWebRoot = resolve(root, "dialogue-web");
const dialogueWebHtml = await readFile(resolve(dialogueWebRoot, "index.html"), "utf8");
const dialogueWebMain = await readFile(resolve(dialogueWebRoot, "src/main.tsx"), "utf8");
const dialogueWebHtmlEntry = dialogueWebHtml
  .match(/<script[^>]+type="module"[^>]+src="([^"]+)"/i)?.[1]
  ?.replace(/^\//, "");
const dialogueWebDynamicImports = [...dialogueWebMain.matchAll(/await import\(["'](\.[^"']+)["']\)/g)].map(
  ([, specifier]) => specifier,
);
const findingLedger = JSON.parse(await readFile(resolve(root, "tools/knip-finding-ledger.json"), "utf8"));
async function runReports(output, options = {}) {
  return productionRunReports(output, {
    ledger: { schemaVersion: 2, findings: [] },
    ...options,
  });
}

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
    const result = await exec(process.execPath, [knipCli, ...args], { cwd, encoding: "utf8", shell: false });
    return { ...result, stdout: result.stdout || result.stderr, code: 0 };
  } catch (error) {
    return { ...error, stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? error.status };
  }
}

test("declares the pnpm workspace projection and safe exclusions", async () => {
  assert.deepEqual(Object.keys(config.workspaces), expected);
  assert.deepEqual(config.workspaces["."], {
    entry: [
      "tools/*.mjs",
      "tools/stardew-player-command-graph.test.mjs",
      "tools/stardew-gameplay-surface-rules.test.mjs",
      "tools/stardew-player-command-equivalence-audit.test.mjs",
      "tools/stardew-portfolio-m9-accept-special-order-source-boundary.test.mjs",
      "tools/stardew-portfolio-sleep-day-source-boundary.test.mjs",
      "tools/lib/voice-final-gate-server.mjs",
    ],
    project: ["tools/**/*.mjs"],
  });
  assert.deepEqual(config.ignore, approvedIgnore);
  for (const broadProductionIgnore of ["**/src/**", "**/src/**/*", "host/src/**", "dialogue-web/src/**"]) {
    assert.ok(
      !config.ignore.includes(broadProductionIgnore),
      `production source must not be ignored: ${broadProductionIgnore}`,
    );
  }
  const workspace = await readFile(resolve(root, "pnpm-workspace.yaml"), "utf8");
  for (const path of expected.slice(1))
    assert.match(workspace, new RegExp(`^  - ${path.replace("*", "\\*")}\\s*$`, "m"));
  assert.match(workspace, /!vendor\/magic-context\/\*\*/);
  assert.deepEqual(config.workspaces["integrations/stardew/action-development"].project, [
    "src/**/*.mjs",
    "tests/**/*.mjs",
    "scripts/**/*.mjs",
    "scenarios/**/*.mjs",
  ]);
  for (const pattern of [
    "vendor/magic-context/**",
    "**/dist/**",
    "**/dist-test/**",
    "**/node_modules/**",
    "**/.tmp/**",
    "**/artifacts/**",
    "**/coverage/**",
    "**/playwright-report/**",
  ])
    assert.ok(config.ignore.includes(pattern));
});

test("maps Host production entries to artifact roots and production TypeScript files", async () => {
  const hostEntries = config.workspaces.host.entry.filter((pattern) => pattern.endsWith("!"));
  assert.deepEqual(hostEntries, [
    ...expectedHostProductionEntries,
    "src/runtime-core.internal.ts!",
    "src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts!",
    "src/voice-gateway-client.ts!",
    "src/windows-reparse-inspector/index.ts!",
  ]);

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
    assert.ok(
      !hostEntries.includes(`${productionSourceForArtifactRoot(entryRoot)}!`),
      `transitive verification root must not become a Knip entry: ${entryRoot}`,
    );
  }

  const dialogueWebEntry = config.workspaces["dialogue-web"].entry;
  assert.equal(dialogueWebHtmlEntry, "src/main.tsx");
  assert.deepEqual(dialogueWebEntry, [
    "src/main.tsx!",
    "tests/i18n.test.mjs",
    "tests/reference-pipeline-api.test.mjs",
    "tests/reference-pipeline-session.test.mjs",
    "tests/management-pipeline-api.test.mjs",
    "tests/main-entry.test.mjs",
    "tests/manifest-boundary.test.mjs",
    "tests/reference-pipeline-composed-browser.test.mjs",
    "tests/composed-reference-game-browser-api.test.mjs",
    "tests/reference-pipeline-browser.spec.ts",
    "tests/management-pipeline-browser.spec.ts",
    "src/components/ComposedReferenceGameApp.tsx!",
    "src/components/ManagementApp.tsx!",
    "src/components/Composer.tsx!",
    "src/components/drawers/ChatsDrawer.tsx!",
  ]);
  await access(resolve(dialogueWebRoot, dialogueWebHtmlEntry));
  assert.deepEqual(config.workspaces["dialogue-web"].vite, {
    config: "vite.config.ts",
    entry: "index.html",
    project: ["index.html", "src/**/*.{ts,tsx,mjs}"],
  });
  assert.deepEqual(dialogueWebDynamicImports, ["./components/ComposedReferenceGameApp", "./components/ManagementApp"]);
  for (const specifier of dialogueWebDynamicImports) {
    await access(resolve(dialogueWebRoot, "src", `${specifier.slice(2)}.tsx`));
  }
});

test("requires an explicit existing canonical allowed root and accepts only its fresh child", async () => {
  const allowedRoot = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-root-"));
  try {
    await assert.rejects(() => runReports(resolve(allowedRoot, "out")), /allowed root/);
    const nested = resolve(allowedRoot, "nested");
    await mkdir(nested);
    const nestedResult = await runReports(resolve(nested, "out"), {
      allowedRoot,
      ledger: { schemaVersion: 2, findings: [] },
      run: async () => ({ code: 0, stdout: '{"issues":[]}', stderr: "" }),
    });
    assert.equal(nestedResult.exitCode, 0);
    await rm(nestedResult.output, { recursive: true, force: true });
    await assert.rejects(
      () => runReports(resolve(allowedRoot, "out"), { allowedRoot: resolve(allowedRoot, "missing") }),
      /allowed root/,
    );
    await assert.rejects(() => runReports(resolve(root, "out"), { allowedRoot }), /repository|allowed root|beneath/);
  } finally {
    await rm(allowedRoot, { recursive: true, force: true });
  }
});

test("pins scripts, exposes the clean scope, and validates the actual CLI contract", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(packageJson.devDependencies.knip, "6.34.0");
  assert.equal(packageJson.scripts["report:knip"], "knip --config knip.json --reporter json");
  assert.equal(packageJson.scripts["report:knip:production"], "knip --config knip.json --production --reporter json");
  assert.deepEqual(config.workspaces.host.project, [
    "src/**/*.{ts,tsx,mjs}",
    "scripts/**/*.mjs",
    "src/main.ts!",
    "src/desktop-runtime-bootstrap.internal.ts!",
    "src/dialogue-web-main.ts!",
    "src/dialogue-launch-mode.ts!",
    "src/stardew-attachment.ts!",
    "src/farmhand-companion-preview.ts!",
    "src/tavern/static-artifact/index.ts!",
    "src/tavern/player-turn-acceptance.ts!",
    "src/tavern/provider-attempt-claim.ts!",
    "src/tavern/chat-provider-start.ts!",
    "src/tavern/reference-pipeline-static-shell-composition.ts!",
    "src/tavern-management-dialogue-web.ts!",
    "src/tavern/tavern-management-static-shell-composition.ts!",
    "src/tavern/static-artifact/index.ts!",
    "src/windows-reparse-inspector/index.ts!",
  ]);
  assert.deepEqual(config.workspaces.host.entry.slice(-5), [
    "src/tavern/static-artifact/index.ts!",
    "src/runtime-core.internal.ts!",
    "src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts!",
    "src/voice-gateway-client.ts!",
    "src/windows-reparse-inspector/index.ts!",
  ]);
  assert.deepEqual(
    config.workspaces["packages/*"].entry,
    [
      "src/index.{js,mjs,ts,tsx}!",
      "src/process-supervisor.mjs!",
      "src/verifier.mjs!",
      "src/model.mjs!",
      "src/descriptors.mjs!",
      "bin/game-action.mjs!",
      "tests/fixtures/project/adapter.mjs",
      "tests/fixtures/project/child.mjs",
    ],
  );
  assert.deepEqual(
    config.workspaces["packages/*"].project.filter((pattern) => pattern.endsWith("!")),
    [
      "src/index.{js,mjs,ts,tsx}!",
      "src/process-supervisor.mjs!",
      "src/verifier.mjs!",
      "src/model.mjs!",
      "src/descriptors.mjs!",
      "bin/game-action.mjs!",
    ],
  );
  assert.deepEqual(
    config.workspaces["voice-gateway"].project.filter((pattern) => pattern.endsWith("!")),
    [
      "src/main.ts!",
      "src/gateway.ts!",
      "src/mimo.ts!",
      "src/sensevoice.ts!",
      "src/server.ts!",
      "src/tts-asr-loop.ts!",
      "src/windows-audio.ts!",
      "src/windows-capture.ts!",
    ],
  );
  const dialogueWebProjectEntries = config.workspaces["dialogue-web"].project.filter((pattern) =>
    pattern.endsWith("!"),
  );
  assert.deepEqual(dialogueWebProjectEntries, ["src/main.tsx!"]);
  assert.ok(!dialogueWebProjectEntries.some((pattern) => pattern.includes("src/components/")));
  for (const specifier of dialogueWebDynamicImports) {
    const source = `${specifier.replace(/^\.\//, "src/")}.tsx`;
    assert.ok(
      config.workspaces["dialogue-web"].project.some(
        (pattern) => pattern === "src/**/*.{ts,tsx,mjs}" || pattern === source,
      ),
    );
  }
  const productionEntries = Object.values(config.workspaces).flatMap(({ entry }) =>
    entry.filter((pattern) => pattern.endsWith("!")),
  );
  assert.deepEqual(productionEntries, [
    "src/index.{js,mjs,ts,tsx}!",
    "src/process-supervisor.mjs!",
    "src/verifier.mjs!",
    "src/model.mjs!",
    "src/descriptors.mjs!",
    "bin/game-action.mjs!",
    ...expectedHostProductionEntries,
    "src/runtime-core.internal.ts!",
    "src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts!",
    "src/voice-gateway-client.ts!",
    "src/windows-reparse-inspector/index.ts!",
    "src/main.ts!",
    "src/gateway.ts!",
    "src/server.ts!",
    "src/main.tsx!",
    "src/components/ComposedReferenceGameApp.tsx!",
    "src/components/ManagementApp.tsx!",
    "src/components/Composer.tsx!",
    "src/components/drawers/ChatsDrawer.tsx!",
  ]);
  assert.ok(!productionEntries.some((pattern) => pattern.includes("src/**/*")));
  const productionProjects = Object.values(config.workspaces).flatMap(({ project }) =>
    project.filter((pattern) => pattern.endsWith("!")),
  );
  assert.ok(
    productionProjects.length > productionEntries.length,
    "production project scope must include runtime modules beyond entry roots",
  );
  assert.ok(
    !productionProjects.some(
      (pattern) => pattern.includes("tests/") || pattern.includes("scripts/") || pattern.includes("scenarios/"),
    ),
  );
  assert.ok(!config.workspaces["."].project.some((pattern) => pattern.startsWith("host/")));
  assert.ok(!config.workspaces["."].entry.some((pattern) => pattern.startsWith("host/**/*.")));
  const versionResult = await cli(["--version"]);
  assert.equal((versionResult.stdout || versionResult.stderr).trim(), "6.34.0");
  const helpResult = await cli(["--help"]);
  const help = `${helpResult.stdout}\n${helpResult.stderr}`;
  for (const option of ["--config", "--reporter", "--production"]) assert.match(help, new RegExp(option));
  for (const args of [
    ["--config", "knip.json", "--reporter", "json"],
    ["--config", "knip.json", "--production", "--reporter", "json"],
  ]) {
    const result = await cli(args);
    assert.ok([0, 1].includes(result.code), `${args.join(" ")} exited ${result.code}: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.ok(validReport(report));
    if (args.includes("--production")) {
      const actual = report.issues.flatMap((issue) =>
        Object.entries(issue)
          .filter(([category, entries]) => category !== "file" && entries.length > 0)
          .flatMap(([category, entries]) => entries.map((entry) => ({ file: issue.file, category, name: entry.name }))),
      );
      assert.equal(validateFindingLedger("production", actual, findingLedger), true);
    }
  }
});

async function createKnipFixture(prefix, { orphan = true, unusedDependency = false } = {}) {
  const fixture = await mkdtemp(resolve(tmpdir(), prefix));
  await writeFile(
    resolve(fixture, "package.json"),
    `${JSON.stringify({
      name: "knip-cli-fixture",
      private: true,
      ...(unusedDependency ? { dependencies: { "unused-dep": "1.0.0" } } : {}),
    })}\n`,
  );
  await writeFile(resolve(fixture, "knip.json"), '{"workspaces":{".":{"entry":["entry.mjs"],"project":["*.mjs"]}}}\n');
  await writeFile(resolve(fixture, "entry.mjs"), "export const entry = true;\n");
  if (orphan) await writeFile(resolve(fixture, "orphan.mjs"), "export const orphan = true;\n");
  return fixture;
}

test("proves pinned CLI finding and fatal-error contracts in an isolated config", async () => {
  const fixture = await createKnipFixture("gamebuddy-knip-cli-test-");
  try {
    const finding = await cli(["--config", resolve(fixture, "knip.json"), "--reporter", "json"], fixture);
    assert.equal(finding.code, 1, finding.stderr);
    const report = JSON.parse(finding.stdout);
    assert.ok(validReport(report));
    assert.ok(
      report.issues.some((issue) => issue.file === "orphan.mjs"),
      "CLI must analyze the temporary fixture",
    );
    await writeFile(resolve(fixture, "knip-invalid.json"), '{"workspaces": {\n');
    const invalidConfig = await cli(["--config", resolve(fixture, "knip-invalid.json"), "--reporter", "json"], fixture);
    assert.equal(invalidConfig.code, 2);
    const unknownOption = await cli(
      ["--config", resolve(fixture, "knip.json"), "--reporter", "json", "--definitely-unknown"],
      fixture,
    );
    assert.equal(unknownOption.code, 1);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("validates exact finding ledger schema and identity", () => {
  const valid = [{ file: "src/a.mjs", category: "files", name: "src/a.mjs" }];
  const ledger = {
    schemaVersion: 2,
    findings: [
      {
        report: "workspace",
        identity: "src/a.mjs|files|src/a.mjs",
        owner: "team",
        obligation: "resolve",
        risk: "candidate",
        evidence: ["report"],
        validUntil: "2099-01-01T00:00:00.000Z",
        status: "unresolved_blocking",
      },
    ],
  };
  assert.equal(validateFindingLedger("workspace", valid, ledger, new Date("2026-01-01")), true);
  for (const identity of [
    "src/a.mjs",
    "src/a.mjs|files",
    "src/a.mjs|files|src/a.mjs|extra",
    "|files|src/a.mjs",
    "src/a.mjs||src/a.mjs",
    "src/a.mjs|files|",
  ])
    assert.equal(
      validateFindingLedger(
        "workspace",
        valid,
        { ...ledger, findings: [{ ...ledger.findings[0], identity }] },
        new Date("2026-01-01"),
      ),
      false,
      identity,
    );
  for (const change of [
    { owner: "" },
    { evidence: [] },
    { validUntil: "2020-01-01T00:00:00.000Z" },
    { status: "unknown" },
    { extra: true },
  ])
    assert.equal(
      validateFindingLedger(
        "workspace",
        valid,
        { ...ledger, findings: [{ ...ledger.findings[0], ...change }] },
        new Date("2026-01-01"),
      ),
      false,
    );
  assert.equal(validateFindingLedger("workspace", [], ledger), false);
});

test("admits only the literal dual-report taskkill.exe boundary and fails closed on drift", () => {
  const target = "packages/game-action-devkit/src/process-supervisor.mjs|binaries|taskkill.exe";
  const approved = {
    schemaVersion: 2,
    findings: [],
    toolBoundaryDisposition: {
      status: "approved_exact_tool_boundary",
      scopes: [{ report: "workspace", identity: target }, { report: "production", identity: target }],
      owner: "game-action-devkit",
      approval: "user-approved exact taskkill.exe tool boundary",
      obligation: "Preserve process-tree termination.",
      risk: "Children can outlive cancellation.",
      evidence: ["supervisor test"],
      validUntil: "2099-01-01T00:00:00.000Z",
    },
  };
  const finding = { file: "packages/game-action-devkit/src/process-supervisor.mjs", category: "binaries", name: "taskkill.exe" };
  assert.deepEqual(evaluateFindingLedger({ workspace: [finding], production: [finding] }, approved, new Date("2026-01-01")), {
    valid: true,
    errors: [],
    unresolvedBlockingCount: 0,
    admittedExactToolBoundaryCount: 2,
  });
  for (const change of [
    { scopes: [{ report: "workspace", identity: target }, { report: "production", identity: "x|binaries|taskkill.exe" }] },
    { scopes: [{ report: "workspace", identity: target }] },
    { scopes: [{ report: "workspace", identity: target }, { report: "production", identity: target }, { report: "production", identity: target }] },
    { status: "resolved" },
    { validUntil: "2020-01-01T00:00:00.000Z" },
  ])
    assert.equal(evaluateFindingLedger({ workspace: [finding], production: [finding] }, {
      ...approved,
      toolBoundaryDisposition: { ...approved.toolBoundaryDisposition, ...change },
    }, new Date("2026-01-01")).valid, false);
  assert.equal(evaluateFindingLedger({ workspace: [finding], production: [] }, approved, new Date("2026-01-01")).valid, false);
  assert.equal(evaluateFindingLedger({ workspace: [finding, finding], production: [finding] }, approved, new Date("2026-01-01")).valid, false);
  assert.equal(evaluateFindingLedger({
    workspace: [finding, { file: "x.mjs", category: "binaries", name: "cmd.exe" }],
    production: [finding],
  }, approved, new Date("2026-01-01")).valid, false);
});

test("accepts the complete Knip JSON reporter shape and rejects malformed nested rows", () => {
  const item = { name: "unused", namespace: "ns", kind: "variable", specifier: "./dep.mjs", line: 3, col: 5, pos: 42 };
  const report = {
    issues: [
      {
        file: "src/example.mjs",
        owners: [{ name: "owner" }],
        binaries: [{ name: "tool" }],
        catalog: [item],
        catalogReferences: [item],
        dependencies: [item],
        devDependencies: [item],
        enumMembers: [item],
        exports: [item],
        files: [item],
        namespaceMembers: [item],
        nsExports: [item],
        nsTypes: [item],
        optionalPeerDependencies: [item],
        types: [item],
        unresolved: [item],
        unlisted: [{ name: "unlisted" }],
        cycles: [[item, { name: "cycle-end", namespace: "ns", kind: "module" }]],
        duplicates: [[item]],
      },
    ],
  };
  assert.equal(validReport(report), true);
  for (const malformed of [
    {},
    { issues: [{}] },
    { issues: [{ file: "x.mjs", unknown: [] }] },
    { issues: [{ file: "x.mjs", files: [{ name: "" }] }] },
    { issues: [{ file: "x.mjs", files: [{ name: "x.mjs", line: "1" }] }] },
    { issues: [{ file: "x.mjs", files: "truncated" }] },
    { issues: [{ file: "x.mjs", cycles: [{ name: "not-a-cycle" }] }] },
    { issues: [{ file: "x.mjs", duplicates: [[{ name: "x", col: -1 }]] }] },
    { issues: [{ file: "x.mjs", nsExports: [{ name: "x", extra: true }] }] },
  ])
    assert.equal(validReport(malformed), false, JSON.stringify(malformed));
  assert.equal(validReport({ issues: [] }), true);
});

test("uses the platform-local pnpm command without shell interpretation", async () => {
  assert.equal(pnpmCommand, process.platform === "win32" ? process.execPath : "pnpm");
  assert.deepEqual(pnpmSpawnOptions, { shell: false });
  const output = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-command-test-"));
  await rm(output, { recursive: true, force: true });
  const calls = [];
  const result = await runReports(output, {
    allowedRoot: resolve(output, ".."),
    ledger: { schemaVersion: 2, findings: [] },
    run: async (command, args, cwd) => {
      calls.push({ command, args, cwd });
      return { code: 0, stdout: '{"issues":[]}', stderr: "" };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [
    {
      command: pnpmCommand,
      cwd: root,
      args:
        process.platform === "win32"
          ? [resolve(root, "node_modules/knip/bin/knip.js"), "--config", "knip.json", "--reporter", "json"]
          : ["exec", "knip", "--config", "knip.json", "--reporter", "json"],
    },
    {
      command: pnpmCommand,
      cwd: root,
      args:
        process.platform === "win32"
          ? [
              resolve(root, "node_modules/knip/bin/knip.js"),
              "--config",
              "knip.json",
              "--reporter",
              "json",
              "--production",
            ]
          : ["exec", "knip", "--config", "knip.json", "--reporter", "json", "--production"],
    },
  ]);
  await rm(result.output, { recursive: true, force: true });
});

test("promotes valid finding reports and returns exit code 1", async () => {
  const output = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-test-"));
  await rm(output, { recursive: true, force: true });
  const result = await runReports(output, {
    allowedRoot: resolve(output, ".."),
    ledger: {
      schemaVersion: 2,
      findings: ["workspace", "production"].map((report) => ({
        report,
        identity: "src/example.mjs|files|src/example.mjs",
        status: "unresolved_blocking",
        owner: "test",
        obligation: "test",
        risk: "test",
        evidence: ["test"],
        validUntil: "2099-01-01T00:00:00.000Z",
      })),
    },
    run: async () => ({
      code: 1,
      stdout: JSON.stringify({ issues: [{ file: "src/example.mjs", files: [{ name: "src/example.mjs" }] }] }),
      stderr: "findings",
    }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.results.filter(({ finding }) => finding).length, 2);
  for (const name of ["workspace.json", "production.json"]) {
    const promoted = JSON.parse(await readFile(resolve(result.output, name), "utf8"));
    assert.deepEqual(promoted, { issues: [{ file: "src/example.mjs", files: [{ name: "src/example.mjs" }] }] });
  }
  await rm(result.output, { recursive: true, force: true });
});

test("runner derives injective canonical identities for ordered nested cycle and duplicate groups", async () => {
  const record = (report, category, key) => ({
    report,
    identity: `src/nested.mjs|${category}|${key}`,
    owner: "test",
    obligation: "test",
    risk: "test",
    evidence: ["fixture"],
    validUntil: "2099-01-01T00:00:00.000Z",
    status: "unresolved_blocking",
  });
  const nestedReport = (cycles, duplicates) => ({
    issues: [{ file: "src/nested.mjs", cycles, duplicates }],
  });
  const run = async (name, ledger, report, expectedCode) => {
    const output = await mkdtemp(resolve(tmpdir(), `gamebuddy-knip-nested-${name}-`));
    await rm(output, { recursive: true, force: true });
    try {
      const result = await runReports(output, {
        allowedRoot: resolve(output, ".."),
        ledger,
        run: async () => ({ code: 1, stdout: JSON.stringify(report), stderr: "" }),
      });
      assert.equal(result.exitCode, expectedCode, name);
      return result;
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  };
  const oneOfEach = nestedReport(
    [[{ name: "cycle-a" }, { name: "cycle-b" }]],
    [[{ name: "duplicate-a" }, { name: "duplicate-b" }]],
  );
  const knownLedger = {
    schemaVersion: 2,
    findings: ["workspace", "production"].flatMap((report) => [
      record(report, "cycles", "7:cycle-a7:cycle-b"),
      record(report, "duplicates", "11:duplicate-a11:duplicate-b"),
    ]),
  };
  await run("known", knownLedger, oneOfEach, 1);

  const distinctGroups = nestedReport(
    [
      [{ name: "cycle-a" }, { name: "cycle-b" }],
      [{ name: "cycle-c" }, { name: "cycle-d" }],
    ],
    [],
  );
  await run(
    "distinct",
    {
      schemaVersion: 2,
      findings: ["workspace", "production"].flatMap((report) => [
        record(report, "cycles", "7:cycle-a7:cycle-b"),
        record(report, "cycles", "7:cycle-c7:cycle-d"),
      ]),
    },
    distinctGroups,
    1,
  );

  await run("malformed", { schemaVersion: 2, findings: [] }, nestedReport([[{ name: 1 }]], []), 2);
  await run("unknown", { schemaVersion: 2, findings: [] }, oneOfEach, 2);

  const commaDelimitedNames = nestedReport([[{ name: "a,b" }, { name: "c" }]], []);
  await run(
    "known-comma-delimited-nested-group",
    {
      schemaVersion: 2,
      findings: ["workspace", "production"].map((report) => record(report, "cycles", "3:a,b1:c")),
    },
    commaDelimitedNames,
    1,
  );
  await run(
    "comma-delimited-nested-group-collision",
    {
      schemaVersion: 2,
      findings: ["workspace", "production"].map((report) => record(report, "cycles", "3:a,b1:c")),
    },
    nestedReport([[{ name: "a" }, { name: "b,c" }]], []),
    2,
  );
  await run(
    "identity-collision",
    {
      schemaVersion: 2,
      findings: ["workspace", "production"].map((report) => record(report, "cycles", "7:cycle-a7:cycle-b")),
    },
    nestedReport(
      [
        [{ name: "cycle-a" }, { name: "cycle-b" }],
        [{ name: "cycle-a" }, { name: "cycle-b" }],
      ],
      [],
    ),
    2,
  );
});

test("classifies the pinned Knip parser result as an execution error without promotion", async () => {
  const fixture = await createKnipFixture("gamebuddy-knip-real-parser-", { orphan: false });
  const output = resolve(fixture, "reports");
  try {
    const parserResult = await cli(
      ["--config", resolve(fixture, "knip.json"), "--reporter", "json", "--definitely-unknown"],
      fixture,
    );
    assert.equal(parserResult.code, 1);
    const result = await runReports(output, { allowedRoot: fixture, cwd: fixture, run: async () => parserResult });
    assert.equal(result.exitCode, 2);
    assert.equal(result.results[0].promoted, false);
    await assert.rejects(() => readFile(resolve(result.output, "workspace.json")));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("classifies valid JSON fatal stderr as execution errors without promotion", async () => {
  for (const stderr of ["plugin failed", "runtime failure", "uncaught exception"]) {
    const output = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-fatal-"));
    await rm(output, { recursive: true, force: true });
    const result = await runReports(output, {
      allowedRoot: resolve(output, ".."),
      run: async () => ({ code: 1, stdout: '{"issues":[]}', stderr }),
    });
    assert.equal(result.exitCode, 2, stderr);
    assert.equal(result.results[0].finding, false);
    assert.equal(result.results[0].promoted, false);
    await assert.rejects(() => readFile(resolve(result.output, "workspace.json")));
    await rm(result.output, { recursive: true, force: true });
  }
  const ordinary = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-finding-"));
  await rm(ordinary, { recursive: true, force: true });
  const result = await runReports(ordinary, {
    allowedRoot: resolve(ordinary, ".."),
    ledger: { schemaVersion: 2, findings: [] },
    run: async () => ({ code: 1, stdout: '{"issues":[]}', stderr: "finding" }),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.results[0].finding, false);
  assert.equal(result.results[0].promoted, false);
  await rm(result.output, { recursive: true, force: true });
});

test("runner validates frozen dual-report ledger records independently", async () => {
  const identity = "package.json|dependencies|unused-dep";
  const record = (report, status = "unresolved_blocking", value = identity) => ({
    report,
    identity: value,
    owner: "test",
    obligation: "test",
    risk: "test",
    evidence: ["fixture"],
    validUntil: "2099-01-01T00:00:00.000Z",
    status,
  });
  const run = async (name, findings, expectedCode, responses) => {
    const fixture = await createKnipFixture(`gamebuddy-knip-ledger-${name}-`);
    const ledgerPath = resolve(fixture, "ledger.json");
    const output = resolve(fixture, "reports");
    try {
      await writeFile(ledgerPath, `${JSON.stringify({ schemaVersion: 2, findings })}\n`);
      let call = 0;
      const result = await productionRunReports(output, {
        allowedRoot: fixture,
        ledgerPath,
        run: async () => responses[call++],
      }).catch(() => ({ exitCode: 2 }));
      assert.equal(result.exitCode, expectedCode, name);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  };
  const finding = {
    code: 1,
    stdout: JSON.stringify({ issues: [{ file: "package.json", dependencies: [{ name: "unused-dep" }] }] }),
    stderr: "",
  };
  const empty = { code: 0, stdout: '{"issues":[]}', stderr: "" };

  await run("known-workspace-unresolved", [record("workspace"), record("production")], 1, [finding, finding]);
  await run("workspace-unknown", [record("production")], 2, [finding, empty]);
  await run("production-unknown", [record("workspace")], 2, [empty, finding]);
  await run("same-identity-once-per-report", [record("workspace"), record("production")], 1, [finding, finding]);
  await run("resolved", [record("workspace", "resolved"), record("production", "resolved")], 2, [finding, finding]);
  await run("expired", [{ ...record("workspace"), validUntil: "2020-01-01T00:00:00.000Z" }], 2, [finding, empty]);
  await run("report-mismatch", [{ ...record("workspace"), report: "invalid" }], 2, [empty, empty]);
  await run("duplicate", [record("workspace"), record("workspace")], 2, [empty, empty]);
  await run("empty-valid", [], 0, [empty, empty]);
  await run("execution-error-precedence", [record("workspace")], 2, [
    finding,
    { code: 2, stdout: "{}", stderr: "bad config" },
  ]);
});

test("classifies parser output as execution errors and preserves independent valid reports", async () => {
  const parserError = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-parser-"));
  await rm(parserError, { recursive: true, force: true });
  const parserResult = await runReports(parserError, {
    allowedRoot: resolve(parserError, ".."),
    run: async () => ({ code: 1, stdout: "", stderr: "Error: invalid configuration" }),
  });
  assert.equal(parserResult.exitCode, 2);
  await assert.rejects(() => readFile(resolve(parserResult.output, "workspace.json")));
  await rm(parserResult.output, { recursive: true, force: true });

  const output = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-test-"));
  await rm(output, { recursive: true, force: true });
  let calls = 0;
  const result = await runReports(output, {
    allowedRoot: resolve(output, ".."),
    run: async () => {
      calls++;
      return calls === 1
        ? { code: 1, stdout: '{"issues":[{"file":"src/example.mjs","files":[{"name":"src/example.mjs"}]}]}', stderr: "" }
        : { code: 2, stdout: "{}", stderr: "bad config" };
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(await readFile(resolve(result.output, "workspace.json"))), {
    issues: [{ file: "src/example.mjs", files: [{ name: "src/example.mjs" }] }],
  });
  await assert.rejects(() =>
    runReports(result.output, {
      allowedRoot: resolve(result.output, ".."),
      run: async () => ({ code: 0, stdout: '{"issues":[]}', stderr: "" }),
    }),
  );
  await rm(result.output, { recursive: true, force: true });
});

test("rejects pre-existing output and repository-contained parents", async () => {
  const existing = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-existing-"));
  await assert.rejects(() => runReports(existing, { allowedRoot: resolve(existing, "..") }), /must not already exist/);
  await rm(existing, { recursive: true, force: true });
  const parent = await mkdtemp(resolve(root, "knip-parent-test-"));
  try {
    await assert.rejects(
      () => runReports(resolve(parent, "output"), { allowedRoot: resolve(parent, "..") }),
      /outside the repository/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects symlinked allowed roots and parents", async () => {
  const outside = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-root-link-"));
  const target = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-root-target-"));
  const link = resolve(outside, "root-link");
  try {
    await symlink(target, link, "junction");
    await assert.rejects(() => runReports(resolve(link, "reports"), { allowedRoot: link }), /alias/);
    await assert.rejects(() => runReports(resolve(outside, "reports"), { allowedRoot: link }), /alias/);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("rejects symlinked repository parents", async () => {
  const outside = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-symlink-"));
  const link = resolve(outside, "repository-link");
  try {
    await symlink(root, link, "junction");
    await assert.rejects(() => runReports(resolve(link, "reports"), { allowedRoot: outside }), /alias|parent/);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("requires the exact named CLI usage and rejects malformed argument lists", async () => {
  const cases = [
    [],
    ["--output-dir", "out"],
    ["--allowed-root", "root", "--output-dir", "out"],
    ["--output-dir", "out", "--allowed-root", "root", "extra"],
    ["--output-dir", "out", "--output-dir", "other", "--allowed-root", "root"],
    ["--output-dir", "out", "--allowed-root", "root", "--unknown"],
    ["root", "out"],
    ["--output-dir", "-bad", "--allowed-root", "root"],
  ];
  for (const args of cases) {
    const result = await exec(process.execPath, [resolve(root, "tools/run-knip-reports.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    }).catch((error) => error);
    assert.equal(result.code ?? result.status, 2, args.join(" "));
    assert.match(`${result.stderr}`, /--output-dir <fresh-output> --allowed-root <trusted-allowed-root>/);
  }
});

test("fails closed when the allowed parent identity changes after creation", async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-parent-race-"));
  const output = resolve(fixture, "reports");
  const moved = resolve(fixture, "moved-root");
  try {
    let changed = false;
    await assert.rejects(
      () =>
        runReports(output, {
          allowedRoot: fixture,
          run: async () => {
            if (!changed) {
              changed = true;
              await rename(fixture, moved);
              await mkdir(fixture);
            }
            return { code: 0, stdout: '{"issues":[]}', stderr: "" };
          },
        }),
      /output root|parent|ENOENT/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test("fails closed when the destination is replaced by a symlink after creation", async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-destination-race-"));
  const output = resolve(fixture, "reports");
  const target = resolve(fixture, "replacement-target");
  try {
    let changed = false;
    await mkdir(target);
    await assert.rejects(
      () =>
        runReports(output, {
          allowedRoot: fixture,
          run: async () => {
            if (!changed) {
              changed = true;
              await rm(output, { recursive: true, force: true });
              await symlink(target, output, "junction");
            }
            return { code: 0, stdout: '{"issues":[]}', stderr: "" };
          },
        }),
      /alias|regular directory|ENOENT/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rejects invalid JSON, malformed reports, and spawn failures without promotion", async () => {
  for (const response of [
    { code: 0, stdout: "not json", stderr: "" },
    { code: 0, stdout: "{}", stderr: "" },
    { code: 1, stdout: "[]", stderr: "" },
    { code: 0, stdout: "null", stderr: "" },
    { code: 1, stdout: JSON.stringify({}), stderr: "" },
    { code: null, stdout: "", stderr: "", error: new Error("missing") },
  ]) {
    const output = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-test-"));
    await rm(output, { recursive: true, force: true });
    const result = await runReports(output, { allowedRoot: resolve(output, ".."), run: async () => response });
    assert.equal(result.exitCode, 2);
    await assert.rejects(() => readFile(resolve(result.output, "workspace.json")));
    await rm(result.output, { recursive: true, force: true });
  }
});

test("executable runner preserves raw clean reports and exits successfully", async () => {
  const allowedRoot = await mkdtemp(resolve(tmpdir(), "gamebuddy-knip-ci-root-"));
  const output = resolve(allowedRoot, "reports");
  const ledgerPath = resolve(root, "tools/knip-finding-ledger.json");
  try {
    const result = await exec(
      process.execPath,
      [
        resolve(root, "tools/run-knip-reports.mjs"),
        "--output-dir",
        output,
        "--allowed-root",
        allowedRoot,
        "--ledger",
        ledgerPath,
      ],
      { cwd: allowedRoot, encoding: "utf8", shell: false },
    ).catch((error) => error);
    const code = result.code ?? result.status ?? 0;
    assert.equal(code, 0, `${result.stdout}\n${result.stderr}`);
    for (const report of ["workspace.json", "production.json"]) {
      const reportPath = resolve(output, report);
      await access(reportPath);
      const parsed = JSON.parse(await readFile(reportPath, "utf8"));
      assert.deepEqual(parsed.issues, []);
    }
  } finally {
    await rm(allowedRoot, { recursive: true, force: true });
  }
});
