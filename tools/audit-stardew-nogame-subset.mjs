#!/usr/bin/env node
/**
 * Which files of `GameBuddy.Stardew.Integration.Tests` can run without a game, and does the
 * no-game project actually contain exactly those?
 *
 * `GameBuddy.Stardew.NoGame.Tests` holds no tests of its own: it compiles a subset of the
 * integration suite's files against `GameBuddy.Stardew.Core` only, so the subset runs on a
 * runner where no Stardew Valley install exists. The subset is the whole value of that project
 * and the whole risk: it is a list of file names, and any hand-maintained list of "which files
 * are game-free" rots in two directions that both look green.
 *
 *   - A file that becomes game-free is never added, and its tests silently run nowhere.
 *   - A file that starts touching the game stays in, and the no-game lane goes red for a
 *     reason that has nothing to do with the change that broke it.
 *
 * So the population is not maintained. It is DERIVED, on every run, from the two authorities that
 * can answer the question. A file RUNS in the no-game lane exactly when (1) the compiler links it
 * against `GameBuddy.Stardew.Core` and nothing else and (2) its source reads no gitignored
 * machine-local input. The derivation below asks the compiler directly - it builds every file,
 * drops the ones that fail, and repeats until a build succeeds - and then drops the surviving
 * files whose source names the decompiled tree under `/ref/`. Both steps are fixpoints of the
 * questions the project actually asks, so the gate cannot agree with a hand-edited list by
 * construction; the list has to agree with them.
 *
 * A static scan for game-layer TYPES was measured and rejected: it disagreed with the compiler on
 * 14 of the 148 files (10 it called game-free that the compiler refused, 4 the reverse) because
 * many files name those types only inside documentation and string literals while the types they
 * really fail on (`ExecutionManager`, `DerivedDestinationSet`) are declared inside mod files that
 * do touch the game. A discriminator that is wrong 14 times cannot gate. Asking the source which
 * gitignored directory it reads is a different question - the compiler cannot answer it, and no
 * C# test can read that tree without spelling the name - so it is measured, not maintained.
 *
 * Usage:
 *   node tools/audit-stardew-nogame-subset.mjs            # gate; exits 1 on drift
 *   node tools/audit-stardew-nogame-subset.mjs --list     # print the derived set
 *   node tools/audit-stardew-nogame-subset.mjs --json     # machine-readable report
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_RELATIVE = "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests";
const SUITE_DIR = join(ROOT, SUITE_RELATIVE);
const PROJECT_DIR = join(ROOT, "integrations/stardew/tests/GameBuddy.Stardew.NoGame.Tests");
const PROJECT = join(PROJECT_DIR, "GameBuddy.Stardew.NoGame.Tests.csproj");
const CORE_PROJECT = join(ROOT, "integrations/stardew/src/Core/GameBuddy.Stardew.Core.csproj");

/** Upper bound on fixpoint rounds. Each round removes at least one file, so the loop terminates
 *  well before this; the cap only stops a pathological build from spinning forever. */
const MAX_ROUNDS = 12;

/**
 * The decompiled game sources the suite's drift anchors read.
 *
 * `/ref/` is gitignored, so a hosted checkout carries no reference tree at all. That makes "compiles
 * against `GameBuddy.Stardew.Core` alone" necessary but not sufficient: a file can compile there and
 * still be unable to RUN, because its test reads a line of the decompiled game. The compiler is the
 * authority for the first question and the source text is the authority for the second - a C# test
 * cannot reach this tree without spelling this directory name, so the token is exact rather than a
 * guess at types the compiler already resolves.
 */
const REFERENCE_TREE = "StardewValleyDecompiled";

/** Whether one suite file reads the gitignored decompiled tree. */
function readsReferenceTree(name) {
  return readFileSync(join(SUITE_DIR, name), "utf8").includes(REFERENCE_TREE);
}

/** The suite's top-level `.cs` files - the population the subset is drawn from. */
export function suiteFiles() {
  return readdirSync(SUITE_DIR)
    .filter((name) => name.endsWith(".cs") && statSync(join(SUITE_DIR, name)).isFile())
    .sort();
}

/**
 * The set the project actually compiles, read off its `<Compile Include>` lines. Every entry
 * must point OUTSIDE the project directory - the project includes the suite's files from their
 * one location and holds no copy, and a forked copy that stays green while the originals drift
 * is exactly the failure this whole lane exists to prevent.
 */
export function projectFiles() {
  const project = readFileSync(PROJECT, "utf8");
  const prefix = "../GameBuddy.Stardew.Integration.Tests/";
  const files = [];
  for (const match of project.matchAll(/<Compile\s+Include="([^"]+)"\s+Link="/gu)) {
    const path = match[1].replace(/\\/gu, "/");
    if (!path.startsWith(prefix)) {
      throw new Error(
        `stardew_nogame_subset_copied_source: ${match[1]} is not a file of the integration suite - ` +
          "this project includes the suite's files, it never holds its own copy",
      );
    }
    files.push(path.slice(prefix.length));
  }
  const own = readdirSync(PROJECT_DIR)
    .filter((name) => name.endsWith(".cs") && statSync(join(PROJECT_DIR, name)).isFile())
    .sort();
  if (own.length > 0) {
    throw new Error(`stardew_nogame_subset_copied_source: ${PROJECT_DIR} holds ${own.join(", ")}`);
  }
  return files.sort();
}

/** The project's own package and framework settings, so the probe build asks the same question
 *  the project asks instead of restating the versions here. */
function probePreamble() {
  const project = readFileSync(PROJECT, "utf8");
  const property = (name) => {
    const match = new RegExp(`<${name}>([^<]+)</${name}>`, "u").exec(project);
    return match === null ? null : match[1];
  };
  const packages = [...project.matchAll(/<PackageReference [^>]*\/>/gu)].map((match) => match[0]);
  return {
    targetFramework: property("TargetFramework"),
    implicitUsings: property("ImplicitUsings"),
    nullable: property("Nullable"),
    packages,
  };
}

function writeProbe(directory, files, preamble) {
  const lines = [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <PropertyGroup>",
    `    <TargetFramework>${preamble.targetFramework}</TargetFramework>`,
    `    <ImplicitUsings>${preamble.implicitUsings}</ImplicitUsings>`,
    `    <Nullable>${preamble.nullable}</Nullable>`,
    "    <IsTestProject>true</IsTestProject>",
    "    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>",
    "    <AssemblyName>GameBuddy.Stardew.NoGame.SubsetProbe</AssemblyName>",
    "  </PropertyGroup>",
    "  <ItemGroup>",
    ...preamble.packages.map((line) => `    ${line}`),
    "  </ItemGroup>",
    "  <ItemGroup>",
    ...files.map((name) => `    <Compile Include="${join(SUITE_DIR, name)}" Link="${name}" />`),
    "  </ItemGroup>",
    "  <ItemGroup>",
    `    <ProjectReference Include="${CORE_PROJECT}" />`,
    "  </ItemGroup>",
    "</Project>",
    "",
  ];
  const path = join(directory, "SubsetProbe.csproj");
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

/** Names of the suite files the compiler refused in this build, read off its diagnostics. */
function refusedFiles(output) {
  const names = new Set();
  for (const match of output.matchAll(/[\\/]GameBuddy\.Stardew\.Integration\.Tests[\\/]([^\\/\s(]+\.cs)\(/gu)) {
    names.add(match[1]);
  }
  return names;
}

function build(project) {
  try {
    const stdout = execFileSync("dotnet", ["build", project, "--nologo", "-v", "q"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: "en" },
    });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${String(error?.stdout ?? "")}\n${String(error?.stderr ?? "")}` };
  }
}

/**
 * Derive the runnable no-game set by asking the compiler, round after round: build everything,
 * drop every file the build names, build again, until a build succeeds; then drop the files that
 * survive but read the gitignored decompiled tree. The remaining set is the answer, and it is
 * derived rather than declared.
 */
export function deriveGameFreeFiles() {
  const preamble = probePreamble();
  const all = suiteFiles();
  const refused = new Set();
  const scratch = mkdtempSync(join(tmpdir(), "gamebuddy-nogame-subset-"));
  try {
    let rounds = 0;
    let remaining = all;
    while (rounds < MAX_ROUNDS) {
      rounds += 1;
      const project = writeProbe(scratch, remaining, preamble);
      const result = build(project);
      if (result.ok) {
        const referenceTree = remaining.filter(readsReferenceTree);
        return {
          derived: remaining.filter((name) => !referenceTree.includes(name)),
          referenceTree,
          refused: [...refused].sort(),
          rounds,
          total: all.length,
          exit: 0,
        };
      }
      const named = [...refusedFiles(result.output)].filter((name) => remaining.includes(name));
      if (named.length === 0) {
        return {
          derived: null,
          referenceTree: [],
          refused: [...refused].sort(),
          rounds,
          total: all.length,
          exit: 1,
          stalled: result.output
            .split("\n")
            .filter((line) => line.includes("error"))
            .slice(0, 20),
        };
      }
      for (const name of named) {
        refused.add(name);
      }
      remaining = remaining.filter((name) => !refused.has(name));
    }
    return {
      derived: null,
      referenceTree: [],
      refused: [...refused].sort(),
      rounds,
      total: all.length,
      exit: 1,
      stalled: [],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv) {
  const json = argv.includes("--json");
  const list = argv.includes("--list");

  const derivedResult = deriveGameFreeFiles();
  if (derivedResult.derived === null) {
    process.stdout.write(
      `${[
        "stardew_nogame_subset: FAILED - the compiler could not be made to accept any subset",
        `stardew_nogame_subset: ${derivedResult.rounds} rounds, ${derivedResult.refused.length} of ${derivedResult.total} files refused`,
        ...derivedResult.stalled.map((line) => `  ${line}`),
      ].join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const derived = derivedResult.derived;
  const referenceTree = derivedResult.referenceTree;
  const project = projectFiles();
  const missing = derived.filter((name) => !project.includes(name));
  const extra = project.filter((name) => !derived.includes(name));
  const findings = [
    ...missing.map((file) => ({
      file,
      rule: "headless_file_not_included",
      detail: `compiles against GameBuddy.Stardew.Core alone and reads no gitignored input, so the no-game lane must run it; add it to the <Compile Include> list`,
    })),
    ...extra.map((file) =>
      referenceTree.includes(file)
        ? {
            file,
            rule: "included_file_needs_reference_tree",
            detail: `its source reads ${REFERENCE_TREE}, which /ref/ gitignores, so a hosted checkout has no tree for it to read; remove it from the <Compile Include> list and record the reason in excluded-files.tsv`,
          }
        : {
            file,
            rule: "included_file_not_headless",
            detail: `the compiler refused it without a game, so it cannot run in the no-game lane; remove it from the <Compile Include> list`,
          },
    ),
  ];

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          total: derivedResult.total,
          derived: derived.length,
          included: project.length,
          rounds: derivedResult.rounds,
          refused: derivedResult.refused.length,
          referenceTree: referenceTree.length,
          findings,
        },
        null,
        2,
      )}\n`,
    );
  } else if (list) {
    for (const name of derived) {
      process.stdout.write(`headless  ${name}\n`);
    }
    for (const name of referenceTree) {
      process.stdout.write(`reference-tree  ${name}\n`);
    }
    for (const name of derivedResult.refused) {
      process.stdout.write(`needs-game  ${name}\n`);
    }
  } else {
    process.stdout.write(
      `${[
        `stardew_nogame_subset: ${derived.length} of ${derivedResult.total} suite files compile against GameBuddy.Stardew.Core alone and read no gitignored input`,
        `stardew_nogame_subset: ${derivedResult.refused.length} need a game or the Mod assembly, ${referenceTree.length} compile headless but read the gitignored ${REFERENCE_TREE} tree${referenceTree.length === 0 ? "" : ` (${referenceTree.join(", ")})`}, and the project includes ${project.length}`,
        ...findings.map((finding) => `stardew_nogame_subset: ${finding.rule}: ${finding.file} - ${finding.detail}`),
        findings.length === 0
          ? "stardew_nogame_subset: the project's file list matches the compiler and the reference-tree measurement exactly"
          : `stardew_nogame_subset: ${findings.length} file(s) disagree with the measurements`,
      ].join("\n")}\n`,
    );
  }

  if (findings.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
