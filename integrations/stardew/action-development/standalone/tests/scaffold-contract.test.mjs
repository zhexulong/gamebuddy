import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyStardewScaffold } from "../src/scaffold-contract.mjs";

const ALLOWED_WARPS = Object.freeze([
  ["PortfolioMineEntryGivenFixture.cs", 'Game1.warpFarmer("Mine", 23, 8, false);'],
  ["PortfolioMineElevatorGivenFixture.cs", 'Game1.warpFarmer("UndergroundMine5", 6, 6, 2);'],
  ["PortfolioMineLadderGivenFixture.cs", 'Game1.warpFarmer("UndergroundMine2", 6, 6, 2);'],
]);
const EXCLUDED_MOD_DIRECTORIES = Object.freeze([
  "tests",
  "src/Core",
  "bin",
  "obj",
  "action-development",
]);
const VALID_MOD_PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <Compile Remove="tests\\**\\*.cs" />
    <Compile Remove="src\\Core\\**\\*.cs" />
    <Compile Remove="action-development\\**\\*.cs" />
  </ItemGroup>
</Project>
`;
const VALID_CORE_PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup>
</Project>
`;

async function writeFixtureFile(modRoot, relativePath, content) {
  const file = path.join(modRoot, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function withScaffoldFixture(mutate = async () => {}) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-stardew-scaffold-"));
  const modRoot = path.join(fixtureRoot, "integrations", "stardew");
  try {
    await writeFixtureFile(
      modRoot,
"farmhandexecutioncontroller.cs",
"internal sealed class ExecutionManager : IExecutionLedger { }\n",
    );
    await writeFixtureFile(
      modRoot,
      "src/Core/Protocol/BridgeProtocol.cs",
      "namespace Core.Protocol; public sealed class BridgeProtocol { }\n",
    );
    await writeFixtureFile(modRoot, "GameBuddy.Stardew.csproj", VALID_MOD_PROJECT);
    await writeFixtureFile(modRoot, "src/Core/GameBuddy.Stardew.Core.csproj", VALID_CORE_PROJECT);
    for (const [fileName, warp] of ALLOWED_WARPS) {
      await writeFixtureFile(
        modRoot,
        fileName,
        `internal static class Fixture { internal static void Run() => ${warp} }\n`,
      );
    }

    await mutate({ fixtureRoot, modRoot });
    return await verifyStardewScaffold(fixtureRoot);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

test("accepts a tiny valid scaffold with separate Mod and Core closures", async () => {
  const report = await withScaffoldFixture();

  assert.deepEqual(report, {
    schema: "gamebuddy-stardew-scaffold-contract/v1",
    status: "passed",
    modCompileFileCount: 4,
    coreCompileFileCount: 1,
  });
});

test("rejects a missing ExecutionManager source", async () => {
  await assert.rejects(
    withScaffoldFixture(async ({ modRoot }) => {
      await rm(path.join(modRoot, "farmhandexecutioncontroller.cs"));
    }),
    /Required Stardew scaffold file is missing: farmhandexecutioncontroller\.cs/,
  );
});

test("rejects a controller that does not implement IExecutionLedger", async () => {
  await assert.rejects(
    withScaffoldFixture(({ modRoot }) => writeFixtureFile(
      modRoot,
"farmhandexecutioncontroller.cs",
"internal sealed class ExecutionManager { }\n",
    )),
    /farmhandexecutioncontroller\.cs must declare ExecutionManager implementing IExecutionLedger/,
  );
});

test("rejects a missing Core bridge protocol", async () => {
  await assert.rejects(
    withScaffoldFixture(async ({ modRoot }) => {
      await rm(path.join(modRoot, "src/Core/Protocol/BridgeProtocol.cs"));
    }),
    /Required Stardew scaffold file is missing: src\/Core\/Protocol\/BridgeProtocol\.cs/,
  );
});

test("rejects an unexpected nested multiline Game1.warpFarmer call", async () => {
  await assert.rejects(
    withScaffoldFixture(({ modRoot }) => writeFixtureFile(
      modRoot,
      "UnexpectedWarp.cs",
      `internal static class UnexpectedWarp {
  internal static void Run() => Game1.
    warpFarmer(
      "Farm",
      PickTarget(0, 0),
      0,
      false
    );
}\n`,
    )),
    /unexpected Game1-level target-runtime fixture warp surface/,
  );
});

test("rejects an explicit EnableDefaultCompileItems declaration", async () => {
  await assert.rejects(
    withScaffoldFixture(({ modRoot }) => writeFixtureFile(
      modRoot,
      "GameBuddy.Stardew.csproj",
      VALID_MOD_PROJECT.replace(
        "<PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup>",
        "<PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>",
      ),
    )),
    /Mod project compile model is unsupported: declares EnableDefaultCompileItems/,
  );
});

test("rejects an external linked Compile Include", async () => {
  await assert.rejects(
    withScaffoldFixture(({ modRoot }) => writeFixtureFile(
      modRoot,
      "GameBuddy.Stardew.csproj",
      VALID_MOD_PROJECT.replace(
        "</Project>",
        "  <ItemGroup><Compile Include=\"..\\\\outside\\\\UnexpectedWarp.cs\" /></ItemGroup>\n</Project>",
      ),
    )),
    /Mod project compile model is unsupported: uses unsupported <Compile Include=/,
  );
});

test("rejects a nonstandard Mod Compile Remove", async () => {
  await assert.rejects(
    withScaffoldFixture(({ modRoot }) => writeFixtureFile(
      modRoot,
      "GameBuddy.Stardew.csproj",
      VALID_MOD_PROJECT.replace(
        "</Project>",
        "  <ItemGroup><Compile Remove=\"src\\\\unexpected\\\\*.cs\" /></ItemGroup>\n</Project>",
      ),
    )),
    /Mod project compile model is unsupported: uses unsupported <Compile Remove=/,
  );
});

test("rejects a Core Compile Include", async () => {
  await assert.rejects(
    withScaffoldFixture(({ modRoot }) => writeFixtureFile(
      modRoot,
      "src/Core/GameBuddy.Stardew.Core.csproj",
      VALID_CORE_PROJECT.replace(
        "</Project>",
        "  <ItemGroup><Compile Include=\"..\\\\outside\\\\UnexpectedWarp.cs\" /></ItemGroup>\n</Project>",
      ),
    )),
    /Core project compile model is unsupported: uses unsupported <Compile Include=/,
  );
});

test("rejects a Core Compile Remove", async () => {
  await assert.rejects(
    withScaffoldFixture(({ modRoot }) => writeFixtureFile(
      modRoot,
      "src/Core/GameBuddy.Stardew.Core.csproj",
      VALID_CORE_PROJECT.replace(
        "</Project>",
        "  <ItemGroup><Compile Remove=\"bin\\\\**\\\\*.cs\" /></ItemGroup>\n</Project>",
      ),
    )),
    /Core project compile model is unsupported: uses unsupported <Compile Remove=/,
  );
});

test("ignores unexpected source under every excluded Mod directory", async () => {
  for (const excludedDirectory of EXCLUDED_MOD_DIRECTORIES) {
    const report = await withScaffoldFixture(({ modRoot }) => writeFixtureFile(
      modRoot,
      `${excludedDirectory}/ExcludedWarp.cs`,
      'internal static class ExcludedWarp { internal static void Run() => Game1.warpFarmer("Farm", 0, 0, false); }\n',
    ));

    assert.equal(report.status, "passed", excludedDirectory);
    assert.equal(report.modCompileFileCount, 4, excludedDirectory);
  }
});

test("keeps Core files in its separate closure while excluding Core build output", async () => {
  const report = await withScaffoldFixture(async ({ modRoot }) => {
    await writeFixtureFile(
      modRoot,
      "src/Core/Protocol/AdditionalProtocol.cs",
      "namespace Core.Protocol; public sealed class AdditionalProtocol { }\n",
    );
    await writeFixtureFile(
      modRoot,
      "src/Core/bin/ExcludedCoreBuild.cs",
      'internal static class ExcludedCoreBuild { private const string Marker = "unexpected"; }\n',
    );
    await writeFixtureFile(
      modRoot,
      "src/Core/obj/ExcludedCoreBuild.cs",
      'internal static class ExcludedCoreBuild { private const string Marker = "unexpected"; }\n',
    );
  });

  assert.equal(report.status, "passed");
  assert.equal(report.modCompileFileCount, 4);
  assert.equal(report.coreCompileFileCount, 2);
});
