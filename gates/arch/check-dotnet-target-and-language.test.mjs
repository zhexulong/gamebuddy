#!/usr/bin/env node
/**
 * The falsifier suite for `check-dotnet-target-and-language.mjs`: every rule is made red on a real tree.
 *
 * Each case builds a throwaway git checkout, because the gate's population is `git ls-files` and a fixture that fed
 * the gate a list instead would be testing the list. `git add` is enough - `ls-files` reads the index, not history -
 * so a case costs a few milliseconds and no network.
 *
 * A fixture is read through the exported `judge` with `declared: []`, for a reason that is a property of the gate
 * rather than convenience: `DECLARED_CONSTRAINTS` names projects in THIS repository, so judging a throwaway checkout
 * against it would report every row as `declared_constraint_stale`. That is correct behaviour for a real checkout that
 * lost a project, and meaningless for a tree that never had one. The rows are exercised on their own below, and the
 * real tree is read through the CLI.
 *
 * red-proof: fixture  Every case builds a throwaway git checkout and drives the gate over it: `net8.0-windows` read on
 *   2026-11-16 exits 1 naming `net10.0-windows`, while the same project read on 2026-11-10 - the window's last day -
 *   exits 0; a `<LangVersion>` in a csproj reds `langversion_is_not_declared_once` and a props file that governs a
 *   project while declaring nothing reds `langversion_not_governed`; a row whose project vanished, drifted or lost its
 *   evidence reds on its own code; a warning-promoting project whose props demotes `NU1900;NU1902` (or nothing, or a
 *   finding) reds `demoted_nuget_codes_are_not_exactly_nu1900`; and a checkout holding no csproj exits 2 rather than
 *   agreeing with every rule.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), "check-dotnet-target-and-language.mjs");
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const MOD = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net6.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Pathoschild.Stardew.ModBuildConfig" Version="4.4.0" />
  </ItemGroup>
</Project>`;

const PLAIN = (tfm) => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>${tfm}</TargetFramework>
  </PropertyGroup>
</Project>`;

/** A git checkout holding `files`, ready for `git ls-files`. */
function checkout(files) {
  const root = mkdtempSync(join(tmpdir(), "dotnet-declarations-"));
  roots.push(root);
  spawnSync("git", ["init", "--quiet"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  spawnSync("git", ["add", "--", "."], { cwd: root });
  return root;
}

/** Run the exported judge over a fixture and hand back the reading as data. */
function judgeFixture(root, { today = "2026-11-16", declared = [] } = {}) {
  const script = `
    import { judge } from ${JSON.stringify(pathToFileURL(GATE).href)};
    const reading = judge({ root: ${JSON.stringify(root)}, now: new Date("${today}T00:00:00Z"), declared: ${JSON.stringify(declared)} });
    process.stdout.write(JSON.stringify(reading));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const codesOf = (reading) => reading.findings.map((finding) => finding.code);
const runCli = (root, ...extra) => spawnSync(process.execPath, [GATE, "--root", root, ...extra], { encoding: "utf8" });

describe("the green reading", () => {
  it("passes when every framework is forced by the game host or supported, and the language version is declared once", () => {
    const root = checkout({
      "Directory.Build.props": "<Project><PropertyGroup><LangVersion>12.0</LangVersion></PropertyGroup></Project>",
      "mod/Mod.csproj": MOD.replace(
        "</Project>",
        '  <ItemGroup><ProjectReference Include="core/Core.csproj" /></ItemGroup>\n</Project>',
      ),
      "mod/core/Core.csproj": PLAIN("net6.0"),
      "tool/Tool.csproj": PLAIN("net10.0"),
    });
    const reading = judgeFixture(root);
    assert.deepEqual(codesOf(reading), []);
    assert.equal(reading.projects.length, 3);
    assert.deepEqual([reading.supported, reading.forced, reading.unsupported], [1, 2, 0]);
    assert.equal(reading.langVersionInCsproj, 0);
    // Core holds net6.0 with no binding of its own: it is forced only through the Mod's ProjectReference.
    assert.ok(reading.bound.includes("mod/core/Core.csproj"));
  });
});

describe("langversion_is_not_declared_once", () => {
  it("reds a csproj that declares its own language version", () => {
    const root = checkout({
      "Directory.Build.props": "<Project><PropertyGroup><LangVersion>12.0</LangVersion></PropertyGroup></Project>",
      "mod/Mod.csproj": MOD.replace("<TargetFramework>", "<LangVersion>12.0</LangVersion><TargetFramework>"),
    });
    const reading = judgeFixture(root);
    assert.deepEqual(codesOf(reading), ["langversion_is_not_declared_once"]);
    assert.equal(reading.langVersionInCsproj, 1);
  });

  it("reds a props file that governs a project and declares no LangVersion", () => {
    const root = checkout({
      "Directory.Build.props":
        "<Project><PropertyGroup><AnalysisLevel>latest-recommended</AnalysisLevel></PropertyGroup></Project>",
      "mod/Mod.csproj": MOD,
    });
    const reading = judgeFixture(root);
    assert.deepEqual(codesOf(reading), ["langversion_not_governed"]);
    assert.equal(reading.findings[0].detail, "Directory.Build.props");
  });

  it("does not red a tree with no props at all, whose projects declare nothing either", () => {
    const root = checkout({ "mod/Mod.csproj": MOD, "tool/Tool.csproj": PLAIN("net10.0") });
    assert.deepEqual(codesOf(judgeFixture(root)), []);
  });
});

describe("targetframework_is_unsupported_and_not_declared", () => {
  it("reds an unsupported framework and names the replacement with the platform suffix kept", () => {
    const root = checkout({ "desktop/Desktop.csproj": PLAIN("net8.0-windows") });
    const reading = judgeFixture(root);
    assert.deepEqual(codesOf(reading), ["targetframework_is_unsupported_and_not_declared"]);
    assert.equal(reading.findings[0].tfm, "net8.0-windows");
    assert.equal(reading.unsupported, 1);
  });

  it("reads a platform-qualified framework through its family, so net10.0-windows is inside the window", () => {
    const root = checkout({ "desktop/Desktop.csproj": PLAIN("net10.0-windows") });
    const reading = judgeFixture(root);
    assert.deepEqual(codesOf(reading), []);
    assert.deepEqual([reading.supported, reading.forced, reading.unsupported], [1, 0, 0]);
  });

  it("is a boundary: the last day of support is supported, the day after is not", () => {
    const root = checkout({ "desktop/Desktop.csproj": PLAIN("net8.0") });
    const lastDay = judgeFixture(root, { today: "2026-11-10" });
    assert.deepEqual(codesOf(lastDay), []);
    assert.deepEqual([lastDay.supported, lastDay.forced, lastDay.unsupported], [1, 0, 0]);

    const dayAfter = judgeFixture(root, { today: "2026-11-11" });
    assert.deepEqual(codesOf(dayAfter), ["targetframework_is_unsupported_and_not_declared"]);
    assert.deepEqual([dayAfter.supported, dayAfter.forced, dayAfter.unsupported], [0, 0, 1]);
  });

  it("does not force a framework through a package that only looks like the mod build package", () => {
    const root = checkout({
      "tool/Tool.csproj": PLAIN("net8.0").replace(
        "</Project>",
        '<ItemGroup><PackageReference Include="Pathoschild.Stardew.ModBuildConfig.Extras" Version="1.0.0" /></ItemGroup></Project>',
      ),
    });
    const reading = judgeFixture(root);
    assert.equal(reading.forced, 0);
    assert.deepEqual(codesOf(reading), ["targetframework_is_unsupported_and_not_declared"]);
  });

  it("reds a framework the support table has never heard of rather than passing it", () => {
    const root = checkout({ "tool/Tool.csproj": PLAIN("netstandard2.0") });
    const reading = judgeFixture(root);
    assert.deepEqual(codesOf(reading), ["targetframework_is_unsupported_and_not_declared"]);
    assert.equal(reading.findings[0].tfm, "netstandard2.0");
  });

  it("reds a project that declares no framework at all", () => {
    const root = checkout({ "tool/Tool.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>' });
    const reading = judgeFixture(root);
    assert.deepEqual(codesOf(reading), ["targetframework_is_unsupported_and_not_declared"]);
    assert.equal(reading.findings[0].tfm, "(none)");
  });
});

describe("the forced bucket names SMAPI", () => {
  it("derives the constraint from the mod build package and prints the authority it came from", () => {
    const root = checkout({ "mod/Mod.csproj": MOD, "tool/Tool.csproj": PLAIN("net10.0") });
    assert.deepEqual(codesOf(judgeFixture(root)), []);
    // The CLI reads THIS repository's DECLARED_CONSTRAINTS, whose two rows name projects the fixture has not got, so
    // its exit is 1 for that reason alone; the line under test is printed either way.
    const result = runCli(root, "--today", "2026-11-16");
    assert.match(result.stdout, /forced 1 project\(s\) share SMAPI's framework/u);
  });
});

describe("the declared constraints stay receipts", () => {
  const row = (project, tfm, evidence) => ({ project, tfm, names: "a host", why: "because it loads one", evidence });

  it("passes a row whose project, framework and evidence all still hold", () => {
    const root = checkout({ "present/Present.csproj": PLAIN("net8.0"), "evidence.txt": "the authority" });
    const reading = judgeFixture(root, { declared: [row("present/Present.csproj", "net8.0", "evidence.txt")] });
    assert.deepEqual(codesOf(reading), []);
    assert.equal(reading.declaredCount, 1);
    assert.equal(reading.unsupported, 0);
  });

  it("reds a row whose project is gone", () => {
    const root = checkout({ "present/Present.csproj": PLAIN("net8.0"), "evidence.txt": "the authority" });
    const reading = judgeFixture(root, { declared: [row("gone/Gone.csproj", "net8.0", "evidence.txt")] });
    assert.deepEqual(codesOf(reading), [
      "targetframework_is_unsupported_and_not_declared",
      "declared_constraint_stale",
    ]);
  });

  it("reds a row whose project drifted to another framework", () => {
    const root = checkout({ "present/Present.csproj": PLAIN("net8.0"), "evidence.txt": "the authority" });
    const reading = judgeFixture(root, { declared: [row("present/Present.csproj", "net6.0", "evidence.txt")] });
    assert.deepEqual(codesOf(reading), [
      "targetframework_is_unsupported_and_not_declared",
      "declared_constraint_tfm_drift",
    ]);
    // The drift does not silence the support check: the row no longer names this framework.
    assert.equal(reading.unsupported, 1);
  });

  it("reds a row whose evidence file was deleted", () => {
    const root = checkout({ "present/Present.csproj": PLAIN("net8.0"), "evidence.txt": "the authority" });
    const reading = judgeFixture(root, { declared: [row("present/Present.csproj", "net8.0", "missing.txt")] });
    assert.deepEqual(codesOf(reading), ["declared_constraint_unevidenced"]);
  });
});

describe("the three zeroes are told apart", () => {
  it("blocks on an empty population instead of passing", () => {
    const root = checkout({ "readme.md": "no projects here" });
    const result = runCli(root, "--today", "2026-11-16");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /projects_population_empty/u);
  });

  it("reports not_measured when the tree is not a checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "dotnet-declarations-bare-"));
    roots.push(root);
    writeFileSync(join(root, "Mod.csproj"), MOD);
    const result = runCli(root, "--today", "2026-11-16");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not_measured · git ls-files failed/u);
  });
});

describe("the population is derived, and sums", () => {
  it("counts every tracked csproj once", () => {
    const root = checkout({
      "a/A.csproj": MOD,
      "b/B.csproj": PLAIN("net10.0"),
      "c/C.csproj": PLAIN("net10.0"),
    });
    const reading = judgeFixture(root);
    assert.deepEqual(codesOf(reading), []);
    assert.equal(reading.projects.length, 3);
    assert.deepEqual([reading.supported, reading.forced], [2, 1]);
    assert.equal(
      Object.values(reading.census).reduce((sum, count) => sum + count, 0),
      3,
    );
  });

  it("ignores a csproj the checkout does not track", () => {
    const root = checkout({ "a/A.csproj": PLAIN("net10.0") });
    writeFileSync(join(root, "a/Untracked.csproj"), PLAIN("net8.0"));
    assert.equal(judgeFixture(root).projects.length, 1);
  });
});

describe("this repository, through the CLI", () => {
  it("reads green at 2026-11-16, with every framework inside its window or forced by SMAPI", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = runCli(root, "--today", "2026-11-16");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /langversion in a csproj 0/u);
    assert.match(result.stdout, /unsupported 0/u);
    assert.match(
      result.stdout,
      /forced \d+ project\(s\) share SMAPI's framework/u,
      "the forced bucket must name the authority that forces the framework",
    );
    assert.doesNotMatch(
      result.stderr,
      /:integrations\/stardew\/GameBuddy\.Stardew\.csproj:/u,
      "the Mod's net6.0 is forced by SMAPI, so it must not be a finding",
    );
  });
});

describe("demoted_nuget_codes_are_not_exactly_nu1900", () => {
  /** A project in the pinned build's trees that promotes warnings, with the props file that governs it. */
  const promoting = (props) =>
    checkout({
      "integrations/stardew/Directory.Build.props": props,
      "integrations/stardew/Mod.csproj": MOD.replace(
        "<TargetFramework>",
        "<TreatWarningsAsErrors>true</TreatWarningsAsErrors><TargetFramework>",
      ),
    });
  const GOVERNS = (demoted) =>
    `<Project><PropertyGroup><LangVersion>12.0</LangVersion>${demoted === null ? "" : `<WarningsNotAsErrors>${demoted}</WarningsNotAsErrors>`}</PropertyGroup></Project>`;

  it("passes when the governing props demotes exactly NU1900", () => {
    const reading = judgeFixture(promoting(GOVERNS("NU1900")));
    assert.deepEqual(codesOf(reading), []);
    assert.deepEqual([reading.promoting, reading.demoted], [1, 1]);
  });

  it("trims and reads one code, so `NU1900` written alone is the accepted spelling", () => {
    const reading = judgeFixture(promoting(GOVERNS(" NU1900 ")));
    assert.deepEqual(codesOf(reading), []);
    assert.equal(reading.demoted, 1);
  });

  it("reds a list that carries a second code, naming what it found", () => {
    const reading = judgeFixture(promoting(GOVERNS("NU1900;NU1902")));
    assert.deepEqual(codesOf(reading), ["demoted_nuget_codes_are_not_exactly_nu1900"]);
    assert.equal(reading.findings[0].detail, "integrations/stardew/Directory.Build.props -> NU1900;NU1902");
    // The found vulnerability is exactly what must stay fatal: the whole list is judged, not membership of NU1900.
    assert.equal(reading.demoted, 0);
  });

  it("reds a list that demotes the finding instead of the unreadable database", () => {
    const reading = judgeFixture(promoting(GOVERNS("NU1902")));
    assert.deepEqual(codesOf(reading), ["demoted_nuget_codes_are_not_exactly_nu1900"]);
    assert.equal(reading.demoted, 0);
  });

  it("reds a promoting project with no props above it, and says where it looked", () => {
    const root = checkout({
      "integrations/stardew/Mod.csproj": MOD.replace(
        "<TargetFramework>",
        "<TreatWarningsAsErrors>true</TreatWarningsAsErrors><TargetFramework>",
      ),
    });
    const reading = judgeFixture(root);
    assert.deepEqual(codesOf(reading), ["demoted_nuget_codes_are_not_exactly_nu1900"]);
    assert.equal(reading.findings[0].detail, "(no props file above this project) -> (nothing)");
  });

  it("puts a project in the population when the PROPS promotes, not only when the csproj does", () => {
    const reading = judgeFixture(
      promoting(
        "<Project><PropertyGroup><LangVersion>12.0</LangVersion><TreatWarningsAsErrors>true</TreatWarningsAsErrors></PropertyGroup></Project>",
      ),
    );
    assert.deepEqual(codesOf(reading), ["demoted_nuget_codes_are_not_exactly_nu1900"]);
    assert.deepEqual([reading.promoting, reading.demoted], [1, 0]);
  });

  it("leaves a promoting project outside the pinned build's trees to its own decision", () => {
    const root = checkout({
      "desktop/Directory.Build.props":
        "<Project><PropertyGroup><LangVersion>12.0</LangVersion></PropertyGroup></Project>",
      "desktop/Desktop.csproj": PLAIN("net10.0-windows").replace(
        "<TargetFramework>",
        "<TreatWarningsAsErrors>true</TreatWarningsAsErrors><TargetFramework>",
      ),
    });
    const reading = judgeFixture(root);
    assert.deepEqual(codesOf(reading), []);
    assert.equal(reading.promoting, 0);
  });
});
