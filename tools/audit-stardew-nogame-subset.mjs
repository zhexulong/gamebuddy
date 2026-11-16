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
 * AND THE LIST IS ONLY HALF OF THE FACT. The lane is a partition of the suite: what this project
 * compiles, and what `excluded-files.tsv` excuses with a reason. That second list was read by
 * `run-nogame-tests.mjs` alone, so this gate could not see a file in NEITHER list - measured
 * 2026-11-16, three files shipped that way (`ExecutionEvidenceWireTests.cs`,
 * `SweepTargetRefusalNamingTests.cs`, `WaterTargetApproachTests.cs`) and this gate printed that the
 * project's file list matched the measurements exactly while the runner went red about them. The
 * partition is now read from `tools/lib/nogame-partition.mjs`, the one authority both readers share,
 * and it is judged here with the member printed either way: `neither X` and `both B` both fail.
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
 *
 * red-proof: history  four suite files shipped without a line in the project's `<Compile Include>` list -
 *   BodyProgramJournalSchemaTests.cs (cdacf139), SeedSupplyAddressSourceShapeTests.cs (80965015), SuiteRedProofTests.cs
 *   (df96b6a1), TileTargetRequestSeamTests.cs (213d8c87) - and the tree still carried them, so this is the tree's own
 *   reading rather than a replay: `headless_file_not_included: <file>` per file, exit 1. The four are in the project's
 *   list today; the marker records the reading that made this gate, not a claim about the current tree.
 *
 * red-proof: history  three suite files shipped with no row in EITHER list -
 *   `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/ExecutionEvidenceWireTests.cs` (287e227a),
 *   `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/SweepTargetRefusalNamingTests.cs` (e34023f2) and
 *   `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/WaterTargetApproachTests.cs` (664224bb) ->
 *   `nogame_test_file_has_no_partition_row:` three times beside `files examined 300 - partitioned 61 - excluded 236 -
 *   neither 3 - both 0`, exit 1; the rows that fixed them turn the same reading into `neither 0 - both 0`.
 *
 * THE ONE RED THAT IS NOT THIS GATE'S. `FarmhandInitializationReachabilityGateTests.cs` has a `reference-tree` row and
 * is out of the project, and this gate's derivation calls it headless because the file spells neither the tree nor the
 * helper that does (`DecompiledSource`, whose own file is excluded for reading it): `headless_file_not_included` on it,
 * pre-existing since `ff1e4408`. The table is right and the derivation is one hop short, which is a repair to the
 * second condition above rather than to the partition.
 */

export const gateDeclaration = {
  id: "audit-stardew-nogame-subset",
  domain: "stardew",
  tier: "l2",
  kind: "totality",
};

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanOutputLines } from "./lib/subprocess-output.mjs";
import {
  compiledFiles,
  excludedRows,
  ownSourceFindings,
  partitionFindings,
  populationLine,
  projectRowFindings,
  reasonFindings,
  suiteFiles,
  treePartition,
  unreadableCompileRows,
  PROJECT,
  SUITE_DIR,
} from "./lib/nogame-partition.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
    return {
      ok: false,
      output: `${String(error?.stdout ?? "")}\n${String(error?.stderr ?? "")}`,
    };
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
          stalled: cleanOutputLines(result.output)
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

  // The partition half of the subject, read from the one module both readers share, and printed before anything is
  // built: it needs no compiler, and a file in neither list is the drift that went unreported here while the runner
  // about the same files was red - `nogame_test_file_has_no_partition_row:<file>` per file. The compiler half below is
  // the other question (is what the project DOES compile still headless?), and an unavailable compiler must not take
  // this reading down with it.
  const partition = treePartition();
  process.stdout.write(`stardew_nogame_subset: ${populationLine(partition)}\n`);
  const partitionRows = excludedRows();
  const partitionHalf = [
    ...partitionFindings(partition),
    ...projectRowFindings(unreadableCompileRows()),
    ...ownSourceFindings(),
    ...reasonFindings(partitionRows),
  ];

  const derivedResult = deriveGameFreeFiles();
  if (derivedResult.derived === null) {
    process.stdout.write(
      `${[
        "stardew_nogame_subset: FAILED - the compiler could not be made to accept any subset",
        `stardew_nogame_subset: ${derivedResult.rounds} rounds, ${derivedResult.refused.length} of ${derivedResult.total} files refused`,
        ...partitionHalf.map((finding) => `stardew_nogame_subset: ${finding.text}`),
        ...derivedResult.stalled.map((line) => `  ${line}`),
      ].join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const derived = derivedResult.derived;
  const referenceTree = derivedResult.referenceTree;
  const project = compiledFiles();
  const missing = derived.filter((name) => !project.includes(name));
  const extra = project.filter((name) => !derived.includes(name));
  const report = (file, rule, detail) => ({
    file,
    rule,
    detail,
    text: `${rule}: ${file} - ${detail}`,
  });
  const findings = [
    ...missing.map((file) =>
      report(
        file,
        "headless_file_not_included",
        "compiles against GameBuddy.Stardew.Core alone and reads no gitignored input, so the no-game lane must run " +
          "it; add it to the <Compile Include> list",
      ),
    ),
    ...extra.map((file) =>
      referenceTree.includes(file)
        ? report(
            file,
            "included_file_needs_reference_tree",
            `its source reads ${REFERENCE_TREE}, which /ref/ gitignores, so a hosted checkout has no tree for it to ` +
              "read; remove it from the <Compile Include> list and record the reason in excluded-files.tsv",
          )
        : report(
            file,
            "included_file_not_headless",
            "the compiler refused it without a game, so it cannot run in the no-game lane; remove it from the " +
              "<Compile Include> list",
          ),
    ),
    ...partitionHalf.map((finding) => ({
      file: finding.member,
      rule: finding.code,
      detail: finding.text,
      text: finding.text,
    })),
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
          partition: {
            examined: partition.examined,
            partitioned: partition.partitioned,
            excluded: partition.excluded,
            neither: partition.neither.length,
            both: partition.both.length,
          },
          findings: findings.map(({ file, rule, detail }) => ({
            file,
            rule,
            detail,
          })),
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
        ...findings.map((finding) => `stardew_nogame_subset: ${finding.text}`),
        findings.length === 0
          ? "stardew_nogame_subset: the project's file list matches the compiler and the reference-tree measurement " +
            "exactly, and every suite file it does not compile has a row in excluded-files.tsv"
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
