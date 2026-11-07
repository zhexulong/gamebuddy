#!/usr/bin/env node
/**
 * Compile the committed C# projects, and fail by name on the one that does not.
 *
 * THE DEFECT. `def2fb07` (2026-10-31) changed a rename on both sides of the wire and committed one
 * side, so HEAD called `NativeItemPredicates.IsOneHitBreakableStone` - which the same commit deleted
 * - plus `ResolveStorageContainerAt` and a `RequestLocalChestStore` overload that did not exist: 20
 * CS errors. Every CI job reported success. That commit also added an assertion that the deleted
 * name was gone, inside `GameBuddy.Stardew.Integration.Tests`; that project could not compile, so
 * the assertion never ran. A gate inside a project a defect prevents from building cannot report.
 *
 * WHY CI COULD NOT SEE IT. `.github/workflows/ci.yml`'s `stardew-scaffold` job runs `dotnet test`
 * over `GameBuddy.Stardew.Core.Tests` and the no-game subset - the suite files that compile against
 * `GameBuddy.Stardew.Core` alone. `GameBuddy.Stardew.csproj`, the Mod itself, is built by no job:
 * SMAPI's `ModBuildConfig` refuses without a licensed game folder, and a hosted runner has none.
 *
 * THE POPULATION is `git ls-files '*.csproj'`, so a project is covered by existing and no list here
 * decides what "the C# projects" means. Each project is then asked to build, and the answer is
 * classified:
 *
 *   - builds: covered.
 *   - fails with a compiler diagnostic (`error CS....`): the committed source does not compile.
 *     FAIL, naming the project and the first diagnostic. This holds for a registered project too -
 *     the register excuses a MISSING PREREQUISITE, never a compiler diagnostic.
 *   - fails with the prerequisite refusal registered for it: excluded, printed by name with what
 *     the exclusion costs.
 *   - fails with anything else - an unregistered project, a registered one whose refusal text has
 *     changed, a broken restore: FAIL, because an exclusion nobody wrote down is the defect this
 *     gate exists for.
 *
 * WHAT THIS GATE CANNOT DO. It cannot compile the Mod where no game folder exists.
 * `Pathoschild.Stardew.ModBuildConfig` 4.4.0 emits `<Error>` in `BeforeBuild` when
 * `!Exists('$(GamePath)')` or `!Exists('$(GamePath)\Stardew Valley.dll')` - before the compiler
 * runs - and the seven references it adds are `HintPath`s into that folder. This repository tracks
 * no game assembly (`/ref/` is gitignored, and this repository carries neither the game nor a mod
 * loader), so there is no
 * reference assembly to compile against either. The exclusion is therefore printed on every run
 * with its cost spelled out, rather than left to look like coverage. Where `GamePath` resolves -
 * the caller's `GAMEBUDDY_STARDEW_GAME_PATH`, or `%USERPROFILE%\stardewvalley.targets` - those
 * projects build here like any other and leave the printout by being covered.
 *
 * Usage:
 *   node tools/check-csharp-compile.mjs            # the verdict; exit 1 on any failure
 *   node tools/check-csharp-compile.mjs --list     # the derived project population
 *
 * red-proof: inject  a tree whose one tracked project has a type error -> `csharp_compile_compile_error:<project>`,
 *                    exit 1, and the project named rather than counted
 *                    (tools/check-csharp-compile.test.mjs, "the gate reports an uncompilable project by name")
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanOutputLines } from "./lib/subprocess-output.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_TIMEOUT_MS = 10 * 60_000;
const CONFIGURATION = "Debug";

/**
 * The projects a checkout without the game cannot compile, each with the refusal its toolchain must
 * still produce. The text is the measurement, not a category name: a project that starts failing
 * differently leaves the register instead of hiding behind it. `cost` is what stays outside this
 * gate while the refusal holds, and it is printed on every run.
 */
export const EXCLUSIONS = Object.freeze([
  {
    project: "integrations/stardew/GameBuddy.Stardew.csproj",
    refusal: "The mod build package can't find your game folder",
    cost: "the Mod's own sources are not compile-checked here; they are checked where GamePath resolves to a licensed game folder",
  },
  {
    project:
      "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj",
    refusal: "The mod build package can't find your game folder",
    cost: "the integration suite and every assertion in it are not compile-checked here; it inherits the Mod's prerequisite through its project reference",
  },
  {
    project:
      "tools/stardew-navigation-multisource-characterization/StardewNavigationMultiSourceCharacterization.csproj",
    refusal: "ProductionModBuildPath is required",
    cost: "the multisource characterization probe is not compile-checked here",
  },
  {
    project: "tools/stardew-navigation-p4-loader/StardewNavigationP4Loader.csproj",
    refusal: "GamePath (or GAMEBUDDY_STARDEW_GAME_PATH) is required",
    cost: "the P4 loader probe is not compile-checked here",
  },
  {
    project: "tools/stardew-navigation-runtime-probe/StardewNavigationRuntimeProbe.csproj",
    refusal: "GamePath (or GAMEBUDDY_STARDEW_GAME_PATH) is required",
    cost: "the target-assembly runtime probe is not compile-checked here",
  },
  {
    project: "tools/stardew-navigation-transition-characterization/StardewNavigationTransitionCharacterization.csproj",
    refusal: "GamePath is required",
    cost: "the transition-characterization probe is not compile-checked here",
  },
]);

const exclusionsByProject = new Map(EXCLUSIONS.map((entry) => [entry.project, entry]));

/** A C# compiler diagnostic carries its code in every locale; the message text does not. */
const COMPILER_DIAGNOSTIC = /error CS\d{4}/u;

/**
 * The line a reader needs first: a compiler diagnostic when the build produced one, otherwise the
 * first line that reads as an error. Measured while proving this gate red: a project whose Project
 * reference fails to compile prints the MOD's prerequisite refusal ahead of the CS diagnostic that
 * actually stopped it, so "first error line" named the wrong cause.
 */
function firstErrorLine(lines) {
  const diagnostic = lines.find((candidate) => COMPILER_DIAGNOSTIC.test(candidate));
  return (
    diagnostic ?? lines.find((candidate) => /\berror\b/iu.test(candidate)) ?? "(no error line in the build output)"
  );
}

/**
 * What one project's build result means. `exitCode` and `output` are exactly what the build
 * produced; nothing here re-derives a compiler's verdict.
 */
export function classify({ project, exitCode, output }) {
  const lines = cleanOutputLines(output);
  const text = lines.join("\n");
  const exclusion = exclusionsByProject.get(project);
  if (exitCode === 0) {
    // A registered project that builds got its prerequisite after all (a machine with the game, or
    // a runner that configured it). Covered this run, and its exclusion prints nothing.
    return { outcome: "compiled" };
  }
  if (COMPILER_DIAGNOSTIC.test(text)) {
    return { outcome: "compile_error", detail: firstErrorLine(lines) };
  }
  if (exclusion === undefined) {
    return { outcome: "undeclared_failure", detail: firstErrorLine(lines) };
  }
  if (!text.includes(exclusion.refusal)) {
    return {
      outcome: "exclusion_unearned",
      detail: `expected refusal "${exclusion.refusal}", build said: ${firstErrorLine(lines)}`,
    };
  }
  return { outcome: "declared_exclusion" };
}

/** Every tracked C# project: the population, derived, never maintained here. */
export function trackedProjects(root = ROOT) {
  const listed = spawnSync("git", ["ls-files", "*.csproj"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
  return cleanOutputLines(listed.stdout).filter(Boolean).sort();
}

/** `-p:GamePath` only when the caller named one, so a plain checkout builds the way it always has. */
function gamePathArguments() {
  const configured = (process.env.GAMEBUDDY_STARDEW_GAME_PATH ?? "").trim();
  return configured === "" ? [] : [`-p:GamePath=${configured}`];
}

function build(project, root) {
  const built = spawnSync(
    "dotnet",
    ["build", project, "-c", CONFIGURATION, "--nologo", "-v", "q", ...gamePathArguments()],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: BUILD_TIMEOUT_MS },
  );
  return { exitCode: built.status ?? 1, output: `${built.stdout ?? ""}${built.stderr ?? ""}` };
}

export function main(
  argv,
  { root = ROOT, write = (line) => process.stdout.write(line), writeError = (line) => process.stderr.write(line) } = {},
) {
  const projects = trackedProjects(root);
  if (argv.includes("--list")) {
    for (const project of projects) write(`${project}\n`);
    return 0;
  }

  let compiled = 0;
  let excluded = 0;
  const failures = [];
  for (const project of projects) {
    const verdict = classify({ project, ...build(project, root) });
    if (verdict.outcome === "compiled") {
      compiled += 1;
    } else if (verdict.outcome === "declared_exclusion") {
      excluded += 1;
      // Printed on every run, green ones included: an exclusion nobody reads is coverage that
      // looks whole and is not.
      write(`csharp_compile_excluded:${project}:${exclusionsByProject.get(project).cost}\n`);
    } else {
      failures.push({ project, code: verdict.outcome, detail: verdict.detail });
    }
  }

  write(
    `csharp_compile projects=${projects.length} compiled=${compiled} excluded=${excluded} ` +
      `failed=${failures.length}\n`,
  );
  for (const failure of failures) {
    writeError(`csharp_compile_${failure.code}:${failure.project}:${failure.detail}\n`);
  }
  if (failures.length > 0) {
    writeError(
      `csharp_compile_failed: ${failures.length} of ${projects.length} tracked C# projects do not build ` +
        `(named above; a CS diagnostic is committed source that does not compile)\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
