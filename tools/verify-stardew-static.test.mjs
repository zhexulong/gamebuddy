import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildTargetProduction,
  executeStaticLeaf,
  hashProductionAssembly,
  loadStaticPortfolio,
  STATIC_PORTFOLIO_SCHEMA,
  targetAssemblyAvailability,
  validateStaticPortfolio,
  verifyStaticPortfolio,
} from "./verify-stardew-static.mjs";

const productionAssembly = "integrations/stardew/bin/Release/net6.0/GameBuddy.Stardew.dll";
const owner = "gamebuddy.stardew.static-verifier@v1";
const riskId = "GB-STARDEW-STATIC-FIXTURE_CONTRACT@v1";

const root = resolve(import.meta.dirname, "..");

const scripts = {
  "test:stardew-static-fixture": "node --test tools/fixture.test.mjs",
  "run:stardew-companion-live": "node tools/live.mjs",
  "check:stardew-action": "node tools/action.mjs",
};
const valid = () => ({
  schema: STATIC_PORTFOLIO_SCHEMA,
  portfolioId: "stardew_non_action_engineering_v1",
  scripts: [
    {
      id: "fixture_contract",
      script: "test:stardew-static-fixture",
      command: scripts["test:stardew-static-fixture"],
      class: "static_non_action_leaf",
      owner,
      riskId,
    },
    {
      id: "target_live",
      script: "run:stardew-companion-live",
      command: scripts["run:stardew-companion-live"],
      class: "blocked_target_live",
      owner,
      riskId: "GB-STARDEW-STATIC-TARGET_LIVE@v1",
    },
    {
      id: "action_platform",
      script: "check:stardew-action",
      command: scripts["check:stardew-action"],
      class: "out_of_scope_action_platform",
      owner,
      riskId: "GB-STARDEW-STATIC-ACTION_PLATFORM@v1",
    },
  ],
  leaves: [
    {
      id: "fixture_contract",
      script: "test:stardew-static-fixture",
      command: ["node", "--test", "tools/fixture.test.mjs"],
      evidenceKind: "deterministic_fixture_contract",
      artifactIdentity: "fixture/v1",
      owner,
      riskId,
    },
  ],
});

test("loads and completely inventories root Stardew scripts", async () => {
  const { portfolio, identity, scripts: rootScripts } = await loadStaticPortfolio();
  assert.equal(portfolio.schema, STATIC_PORTFOLIO_SCHEMA);
  assert.match(identity, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    portfolio.scripts.map((entry) => entry.script).sort(),
    Object.keys(rootScripts)
      .filter((name) => name.toLowerCase().includes("stardew") && name !== "test:stardew:static")
      .sort(),
  );
  assert.ok(portfolio.leaves.some((leaf) => leaf.id === "stardew_scaffold_contract"));
  assert.ok(portfolio.leaves.some((leaf) => leaf.id === "companion_fixture_contract"));
  assert.ok(portfolio.leaves.some((leaf) => leaf.id === "companion_production_admission_contract"));
  assert.deepEqual(
    portfolio.leaves.map((leaf) => leaf.id).sort(),
    portfolio.leaves.map((leaf) => portfolio.scripts.find((entry) => entry.script === leaf.script)?.id).sort(),
  );
});

test("target-gated portfolio interop contract keeps inventory complete as action-platform, not live", async () => {
  const { portfolio, scripts: rootScripts } = await loadStaticPortfolio();
  const entry = portfolio.scripts.find((candidate) => candidate.script === "test:stardew-portfolio-interop-contract");
  assert.ok(entry, "root inventory must include test:stardew-portfolio-interop-contract");
  assert.equal(
    rootScripts["test:stardew-portfolio-interop-contract"],
    "powershell.exe -NoProfile -File tools/run-stardew-portfolio-interop-contract.ps1",
  );
  assert.equal(entry.command, rootScripts["test:stardew-portfolio-interop-contract"]);
  assert.equal(entry.class, "out_of_scope_action_platform");
  assert.equal(entry.owner, "gamebuddy.stardew.static-verifier@v1");
  assert.match(entry.riskId, /^GB-STARDEW-STATIC-SCRIPT_TEST_STARDEW_PORTFOLIO_INTEROP_CONTRACT@v[1-9][0-9]*$/);
  assert.ok(
    !portfolio.leaves.some((leaf) => leaf.script === entry.script),
    "target-gated interop contract must not become a static leaf",
  );
  assert.deepEqual(
    portfolio.scripts
      .filter((candidate) => candidate.class === "blocked_target_live")
      .map((candidate) => candidate.script),
    ["run:stardew-companion-live"],
  );
});

test("rejects missing scripts, invalid classes, missing versioned ownership, duplicate IDs, and normalized command aliases", () => {
  const missingOwner = valid();
  delete missingOwner.scripts[0].owner;
  assert.throws(() => validateStaticPortfolio(missingOwner, { scripts }), /static_portfolio_script_invalid/);
  const unversionedRisk = valid();
  unversionedRisk.leaves[0].riskId = "GB-STARDEW-STATIC-FIXTURE_CONTRACT";
  assert.throws(() => validateStaticPortfolio(unversionedRisk, { scripts }), /static_portfolio_leaf_invalid/);
  const missing = valid();
  missing.scripts.pop();
  assert.throws(() => validateStaticPortfolio(missing, { scripts }), /static_portfolio_script_unlisted/);
  const invalidClass = valid();
  invalidClass.scripts[0].class = "unknown";
  assert.throws(() => validateStaticPortfolio(invalidClass, { scripts }), /static_portfolio_script_invalid/);
  const duplicateId = valid();
  duplicateId.scripts[1].id = "fixture_contract";
  assert.throws(() => validateStaticPortfolio(duplicateId, { scripts }), /static_portfolio_duplicate_id/);
  const alias = valid();
  alias.scripts[1].command = "node   --test   tools/fixture.test.mjs";
  scripts["run:stardew-companion-live"] = alias.scripts[1].command;
  assert.throws(() => validateStaticPortfolio(alias, { scripts }), /static_portfolio_alias_script/);
  scripts["run:stardew-companion-live"] = "node tools/live.mjs";
});

test("rejects leaf/script drift, ID spoofing, unallowlisted unsafe static commands, and verifier reentry", () => {
  const spoof = valid();
  spoof.leaves[0].id = "safe_leaf_substitution";
  assert.throws(() => validateStaticPortfolio(spoof, { scripts }), /static_portfolio_leaf_id_mismatch/);
  const drift = valid();
  drift.leaves[0].command = ["node", "--test", "tools/other.test.mjs"];
  assert.throws(() => validateStaticPortfolio(drift, { scripts }), /static_portfolio_leaf_script_drift/);
  const unsafe = valid();
  unsafe.leaves[0].command = ["node", "tools/fixture.mjs"];
  assert.throws(() => validateStaticPortfolio(unsafe, { scripts }), /static_portfolio_leaf_script_drift/);
  unsafe.scripts[0].command = "node tools/fixture.mjs";
  scripts["test:stardew-static-fixture"] = unsafe.scripts[0].command;
  assert.throws(() => validateStaticPortfolio(unsafe, { scripts }), /static_portfolio_unsafe_static_command/);
  scripts["test:stardew-static-fixture"] = "node --test tools/fixture.test.mjs";
  const selfTest = valid();
  selfTest.scripts[0].script = "test:stardew:static";
  selfTest.scripts[0].command = "node --test tools/verify-stardew-static.test.mjs";
  selfTest.leaves[0].script = "test:stardew:static";
  selfTest.leaves[0].command = ["node", "--test", "tools/verify-stardew-static.test.mjs"];
  scripts["test:stardew:static"] = selfTest.scripts[0].command;
  assert.throws(() => validateStaticPortfolio(selfTest, { scripts }), /static_portfolio_script_invalid/);
  delete scripts["test:stardew:static"];
  const selfCanary = valid();
  selfCanary.scripts[0].command = "node tools/verify-stardew-static.mjs";
  selfCanary.leaves[0].command = ["node", "tools/verify-stardew-static.mjs"];
  scripts["test:stardew-static-fixture"] = selfCanary.scripts[0].command;
  assert.throws(() => validateStaticPortfolio(selfCanary, { scripts }), /static_portfolio_self_reentrant_leaf/);
  scripts["test:stardew-static-fixture"] = "node --test tools/fixture.test.mjs";
});

test("rejects Windows case-variant static verifier entrypoints across separator and dot-prefix forms", () => {
  const protectedEntrypoints = ["ToOlS\\VeRiFy-StArDeW-StAtIc.MjS", "ToOlS\\VeRiFy-StArDeW-StAtIc.TeSt.MjS"];
  for (const entrypoint of protectedEntrypoints) {
    for (const protectedEntrypoint of [
      entrypoint,
      `./${entrypoint.replaceAll("\\", "/")}`,
      `././${entrypoint.replaceAll("\\", "/")}`,
      `./${entrypoint}`,
      `.\\.\\${entrypoint}`,
    ]) {
      const reentrant = valid();
      reentrant.scripts[0].command = `node --test ${protectedEntrypoint}`;
      reentrant.leaves[0].command = ["node", "--test", protectedEntrypoint];
      scripts["test:stardew-static-fixture"] = reentrant.scripts[0].command;
      assert.throws(() => validateStaticPortfolio(reentrant, { scripts }), /static_portfolio_self_reentrant_leaf/);
    }
  }
  scripts["test:stardew-static-fixture"] = "node --test tools/fixture.test.mjs";
});

test("executes only allowlisted static leaves and records all other scripts as blocked", async () => {
  const invoked = [];
  const report = await verifyStaticPortfolio({
    portfolio: valid(),
    scripts,
    identity: `sha256:${"a".repeat(64)}`,
    executeLeaf: async (command) => {
      invoked.push(command);
      return { exitCode: 0, durationMs: 3 };
    },
  });
  assert.deepEqual(invoked, [["node", "--test", "tools/fixture.test.mjs"]]);
  assert.equal(report.state, "passed");
  assert.equal(report.leaves[0].state, "passed");
  assert.deepEqual(report.leaves[0].owner, owner);
  assert.deepEqual(report.leaves[0].riskId, riskId);
  assert.deepEqual(
    report.commands.map(({ script, owner: reportedOwner, riskId: reportedRiskId, state }) => ({
      script,
      owner: reportedOwner,
      riskId: reportedRiskId,
      state,
    })),
    [
      { script: "test:stardew-static-fixture", owner, riskId, state: "passed" },
      {
        script: "run:stardew-companion-live",
        owner,
        riskId: "GB-STARDEW-STATIC-TARGET_LIVE@v1",
        state: "blocked_not_run",
      },
      {
        script: "check:stardew-action",
        owner,
        riskId: "GB-STARDEW-STATIC-ACTION_PLATFORM@v1",
        state: "blocked_not_run",
      },
    ],
  );
});

test("the C# static leaf invokes the compiled Portfolio assertion entrypoint", async () => {
  const { portfolio } = await loadStaticPortfolio();
  assert.deepEqual(
    portfolio.leaves.filter((leaf) => leaf.command[0] === "dotnet").map((leaf) => leaf.command),
    [
      [
        "dotnet",
        "integrations/stardew/tests/bin/Release/net6.0/PortfolioMineElevatorProjection.Contract.dll",
        productionAssembly,
      ],
    ],
  );
});

test("missing target assemblies block the C# leaf without executing or entering the pass denominator", async () => {
  const { portfolio, scripts: rootScripts } = await loadStaticPortfolio();
  const invoked = [];
  const report = await verifyStaticPortfolio({
    portfolio,
    scripts: rootScripts,
    identity: `sha256:${"b".repeat(64)}`,
    targetAvailability: { available: false, reasonCode: "blocked_missing_target_assemblies" },
    buildTarget: async () => {
      throw new Error("target build must not run without target assemblies");
    },
    executeLeaf: async (command) => {
      invoked.push(command);
      return { exitCode: 0, durationMs: 1 };
    },
  });
  const contracts = report.leaves.filter((leaf) => leaf.command[0] === "dotnet");
  assert.equal(report.state, "blocked");
  assert.equal(report.reasonCode, "blocked_missing_target_assemblies");
  assert.equal(report.summary.blocked, 1);
  assert.equal(report.summary.passDenominator, report.leaves.length - 1);
  assert.deepEqual(
    contracts.map(({ state, reasonCode }) => ({ state, reasonCode })),
    [{ state: "blocked_missing_target_assemblies", reasonCode: "blocked_missing_target_assemblies" }],
  );
  assert.ok(invoked.every((command) => command[0] !== "dotnet"));
});

test("the compiled contract receives a SHA-256 for the exact post-build production assembly and preserves nonzero failures", async () => {
  const { portfolio, scripts: rootScripts } = await loadStaticPortfolio();
  const invoked = [],
    builds = [];
  const report = await verifyStaticPortfolio({
    portfolio,
    scripts: rootScripts,
    identity: `sha256:${"c".repeat(64)}`,
    targetAvailability: { available: true, gamePath: "C:/licensed-stardew" },
    buildTarget: async (options) => {
      builds.push(options);
      return { exitCode: 0, durationMs: 4 };
    },
    hashProduction: async () => ({ path: resolve(root, productionAssembly), expectedSha256: "e".repeat(64) }),
    executeLeaf: async (command, options) => {
      invoked.push({ command, options });
      return { exitCode: command[0] === "dotnet" ? 7 : 0, durationMs: 2 };
    },
  });
  assert.deepEqual(builds, [{ targetGamePath: "C:/licensed-stardew" }]);
  const contracts = invoked.filter(({ command }) => command[0] === "dotnet");
  assert.equal(report.state, "failed");
  assert.equal(report.summary.failed, 1);
  assert.deepEqual(
    contracts.map(({ command, options }) => ({
      entrypoint: command[1],
      expectedFlag: command[2],
      digest: command[3],
      assembly: command[4],
      options,
    })),
    [
      {
        entrypoint: "integrations/stardew/tests/bin/Release/net6.0/PortfolioMineElevatorProjection.Contract.dll",
        expectedFlag: "--expected-sha256",
        digest: "e".repeat(64),
        assembly: resolve(root, productionAssembly),
        options: { targetGamePath: "C:/licensed-stardew" },
      },
    ],
  );
  assert.deepEqual(
    report.leaves.filter((leaf) => leaf.command[0] === "dotnet").map((leaf) => leaf.state),
    ["failed"],
  );
});

test("hashes a generated production assembly and passes its digest to the compiled contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-static-"));
  const assembly = join(directory, "GameBuddy.Stardew.dll");
  const bytes = Buffer.from("generated-after-build");
  try {
    await writeFile(assembly, bytes);
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(await hashProductionAssembly({ path: assembly }), { path: assembly, expectedSha256 });
    const { portfolio, scripts: rootScripts } = await loadStaticPortfolio();
    const invoked = [];
    await verifyStaticPortfolio({
      portfolio,
      scripts: rootScripts,
      identity: `sha256:${"f".repeat(64)}`,
      targetAvailability: { available: true, gamePath: "C:/licensed-stardew" },
      buildTarget: async () => ({ exitCode: 0, durationMs: 1 }),
      hashProduction: () => hashProductionAssembly({ path: assembly }),
      executeLeaf: async (command) => {
        invoked.push(command);
        return { exitCode: 0, durationMs: 1 };
      },
    });
    assert.deepEqual(
      invoked.filter((command) => command[0] === "dotnet").map((command) => command.slice(2)),
      [["--expected-sha256", expectedSha256, assembly]],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing, non-file, and changed production assemblies before launching contracts", async () => {
  await assert.rejects(
    hashProductionAssembly({ path: resolve(root, "missing-production.dll") }),
    /static_portfolio_production_assembly_invalid/,
  );
  await assert.rejects(hashProductionAssembly({ path: root }), /static_portfolio_production_assembly_invalid/);
  const file = { isFile: () => true, dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 };
  const changed = { ...file, size: 2 };
  let statCalls = 0;
  await assert.rejects(
    hashProductionAssembly({
      path: "generated.dll",
      read: async () => Buffer.from("x"),
      stat: async () => (statCalls++ === 0 ? file : changed),
    }),
    /static_portfolio_production_assembly_changed/,
  );
});

test("a target production build failure prevents the contract from running", async () => {
  const { portfolio, scripts: rootScripts } = await loadStaticPortfolio();
  const invoked = [];
  const report = await verifyStaticPortfolio({
    portfolio,
    scripts: rootScripts,
    identity: `sha256:${"d".repeat(64)}`,
    targetAvailability: { available: true, gamePath: "C:/licensed-stardew" },
    buildTarget: async () => ({ exitCode: 1, durationMs: 4 }),
    executeLeaf: async (command) => {
      invoked.push(command);
      return { exitCode: 0, durationMs: 1 };
    },
  });
  assert.equal(report.state, "failed");
  assert.equal(report.summary.failed, 1);
  assert.ok(invoked.every((command) => command[0] !== "dotnet"));
});

test("target build receives the configured game path and each leaf executes its exact binary", async () => {
  const spawned = [];
  const spawnFn = (command, arguments_, options) => {
    spawned.push({ command, arguments_, options });
    return {
      once: (_event, callback) => {
        if (_event === "exit") callback(0);
      },
    };
  };
  await buildTargetProduction({ targetGamePath: "C:/licensed-stardew", spawnFn });
  await executeStaticLeaf(
    [
      "dotnet",
      "integrations/stardew/tests/bin/Release/net6.0/PortfolioMineElevatorProjection.Contract.dll",
      productionAssembly,
    ],
    { spawnFn },
  );
  assert.deepEqual(
    spawned.map(({ command, arguments_ }) => ({ command, arguments_ })),
    [
      {
        command: "dotnet",
        arguments_: [
          "build",
          "GameBuddy.sln",
          "--configuration",
          "Release",
          "--no-restore",
          "-p:GamePath=C:/licensed-stardew",
        ],
      },
      {
        command: "dotnet",
        arguments_: [
          "integrations/stardew/tests/bin/Release/net6.0/PortfolioMineElevatorProjection.Contract.dll",
          productionAssembly,
        ],
      },
    ],
  );
});

test("the compiled contract requires and validates a supplied GameBuddy.Stardew DLL before assertions", async () => {
  const sources = [await readFile(resolve(root, "integrations", "stardew", "tests", "Program.cs"), "utf8")];
  for (const source of sources) {
    // Both contracts require the exact SHA-256 + production DLL pair. The
    // Farmhand contract also has a separately explicit four-argument
    // manifest-writing mode; its ordinary assertion path remains exact.
    assert.match(
      source,
      /arguments\.Length (?:== 3 && arguments\[0\] ==|!= 3 \|\| arguments\[0\] !=) "--expected-sha256"/,
    );
    assert.match(source, /expectedSha256 = arguments\[1\];/);
    assert.match(source, /File\.Exists\(fullProductionAssemblyPath\)/);
    assert.match(
      source,
      /ProductionAssemblyBinding\.LoadCanonicalAssembly\(expectedSha256, fullProductionAssemblyPath, ValidateProductionAssembly\)/,
    );
    assert.match(source, /private static void AssertTypedReferenceBindsToLoadedAssembly\(Assembly loadedAssembly\)/);
    assert.match(source, /ProductionAssemblyBinding\.AssertTypedReferenceBindsToLoadedAssembly\(/);
    assert.match(source, /MethodImpl\(MethodImplOptions\.NoInlining\)/);
    assert.match(
      source,
      /ProductionAssemblyBinding\.AssertByteAlteredAssemblyRejectedBeforeTypeLoad\(expectedSha256, fullProductionAssemblyPath\)/,
    );
    assert.match(source, /reader\.GetAssemblyDefinition\(\)/);
    assert.match(source, /assemblyName == "GameBuddy\.Stardew"/);
  }
  assert.match(sources[0], /PortfolioMineElevatorProjection/);
});

test("the contract compiles immutable stream binding before typed assertions and retains metadata-only negative characterization", async () => {
  const binding = await readFile(
    resolve(root, "integrations", "stardew", "tests", "ProductionAssemblyBinding.cs"),
    "utf8",
  );
  assert.match(binding, /AssemblyLoadContext\.Default\.Assemblies\.Any/);
  assert.match(binding, /already loaded in AssemblyLoadContext\.Default before canonical binding/);
  assert.match(binding, /new\(canonicalAssemblyPath, FileMode\.Open, FileAccess\.Read, FileShare\.Read\)/);
  assert.match(binding, /byte\[\] canonicalSnapshot = ReadSnapshot\(canonicalAssemblyPath\);/);
  assert.match(binding, /SHA256\.HashData\(snapshot\)/);
  assert.match(binding, /AssemblyLoadContext\.Default\.LoadFromStream\(loadStream\)/);
  assert.match(binding, /AssertTypedReferenceBindsToLoadedAssembly/);
  assert.match(binding, /ReferenceEquals\(typedReferenceAssembly, loadedAssembly\)/);
  assert.match(binding, /ReadAssemblyIdentity\(identityStream\)/);
  assert.match(binding, /!Equals\(actualIdentity\.Version, expectedIdentity\.Version\)/);
  assert.match(binding, /actualIdentity\.Name != ProductionAssemblyName/);
  assert.doesNotMatch(binding, /\.Location/);
  assert.match(
    binding,
    /File\.WriteAllBytes\(alteredAssemblyPath, canonicalSnapshot\.Concat\(new byte\[\] \{ 0 \}\)\.ToArray\(\)\)/,
  );
  assert.match(binding, /reader\.GetAssemblyDefinition\(\);/);
  assert.match(binding, /CryptographicOperations\.FixedTimeEquals/);

  const projects = [
    await readFile(
      resolve(root, "integrations", "stardew", "tests", "PortfolioMineElevatorProjection.Contract.csproj"),
      "utf8",
    ),
  ];
  for (const project of projects) {
    assert.match(project, /<Compile Include="ProductionAssemblyBinding\.cs" \/>/);
  }
});

test("target availability requires the contract's external HintPaths", () => {
  const environment = { GAMEBUDDY_STARDEW_GAME_PATH: "C:/licensed-stardew" };
  const expected = [
    "Stardew Valley.dll",
    "StardewModdingAPI.dll",
    "MonoGame.Framework.dll",
    "SMAPI.Toolkit.CoreInterfaces.dll",
    "smapi-internal/Newtonsoft.Json.dll",
  ];
  assert.deepEqual(targetAssemblyAvailability({ environment, exists: () => false }), {
    available: false,
    reasonCode: "blocked_missing_target_assemblies",
  });
  for (const missing of expected) {
    const missingPath = resolve("C:/licensed-stardew", missing);
    assert.deepEqual(targetAssemblyAvailability({ environment, exists: (path) => path !== missingPath }), {
      available: false,
      reasonCode: "blocked_missing_target_assemblies",
    });
  }
  const checked = [];
  assert.deepEqual(
    targetAssemblyAvailability({
      environment,
      exists: (path) => {
        checked.push(path);
        return true;
      },
    }),
    { available: true, gamePath: resolve("C:/licensed-stardew") },
  );
  assert.deepEqual(
    checked.map((path) => path.slice(resolve("C:/licensed-stardew").length + 1).replaceAll("\\", "/")).sort(),
    expected.sort(),
  );
});

test("the contract project declares precisely the target assembly closure", async () => {
  const projects = [
    await readFile(
      resolve(root, "integrations", "stardew", "tests", "PortfolioMineElevatorProjection.Contract.csproj"),
      "utf8",
    ),
  ];
  for (const project of projects) {
    assert.deepEqual(
      [...project.matchAll(/<HintPath>\$\(GamePath\)\\([^<]+)<\/HintPath>/g)].map((match) => match[1]).sort(),
      [
        "MonoGame.Framework.dll",
        "Stardew Valley.dll",
        "StardewModdingAPI.dll",
        "smapi-internal\\Newtonsoft.Json.dll",
      ].sort(),
    );
  }
});

test("missing target assemblies canary emits a blocked report with no verifier reentry", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["tools/verify-stardew-static.mjs"], {
    cwd: root,
    env: { ...process.env, GAMEBUDDY_STARDEW_GAME_PATH: "" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 2);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.state, "blocked");
  assert.equal(report.reasonCode, "blocked_missing_target_assemblies");
  assert.equal(report.summary.passDenominator, report.summary.passed + report.summary.failed);
  assert.ok(
    report.leaves.every(
      (leaf) =>
        leaf.script !== "test:stardew:static" &&
        !leaf.command.includes("tools/verify-stardew-static.mjs") &&
        !leaf.command.includes("tools/verify-stardew-static.test.mjs"),
    ),
  );
});

test("CI invokes the static verifier and permits the target-assembly blocked outcome", async () => {
  const ci = await readFile(resolve(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /- run: pnpm test:stardew:static/);
  assert.match(ci, /node tools\/verify-stardew-static\.mjs/);
  assert.match(ci, /\$LASTEXITCODE -notin 0, 2/);
});
