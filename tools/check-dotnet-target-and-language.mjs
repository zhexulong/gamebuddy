#!/usr/bin/env node
/**
 * Every C# project declares its target framework, at most one place declares its language version, and a target
 * framework nobody supports anymore is either upgraded or named.
 *
 * WHY. Measured 2026-11-16 on this tree: `LangVersion` appeared in ZERO of the 18 csproj under `integrations/stardew/`
 * and `desktop/` (11 + 7), and `Directory.Build.props` set neither `LangVersion` nor `TargetFramework`. So all 18
 * compiled at the SDK's default for their target framework - C# 10 for the Mod's `net6.0` - and nothing in the tree
 * said so. That is the defect this gate exists for: a default is invisible, it moves when the SDK moves, and a
 * project added tomorrow silently lands on whatever the default happens to be. Reading `TargetFramework` from each
 * csproj and `LangVersion` from none of them is how the current state came about, so both are now measured rather
 * than assumed.
 *
 * The second half was measured the same day, and it is a date: .NET 8's support window closed on 2026-11-10 and .NET 9's
 * on 2026-05-12, while `net6.0`, `net8.0` and `net8.0-windows` were then the only frameworks this tree targets. A
 * framework that has left support is not a build error, which is why it can sit in a tree for a year without anyone
 * noticing - nothing fails, and every project keeps compiling. So the support window is a table here, the check is
 * against today's date, and the elevation of the reading into a task is the failure message naming the replacement.
 * The tree now targets `net6.0` (fourteen projects, held there by SMAPI) plus `net10.0` and `net10.0-windows` (the
 * sixteen the finding named on 2026-11-16, moved the same day).
 *
 * WHAT EACH PROJECT MUST SATISFY, and the counter printed for each:
 *
 *   P1 `langversion in a csproj L`   No csproj declares `LangVersion`, and any `Directory.Build.props` that governs a
 *      project declares it. One declaration per tree, inherited by every project under it. `L` must be 0. The
 *      property is deliberately not "every project compiles at 12.0": that is what the compiler is asked, and the
 *      declaration is what a reader can find before compiling. `langversion_not_governed` covers the other direction -
 *      a props file that exists but says nothing, which is a tree that LOOKS governed and is not.
 *   P2 `supported S · forced by an external constraint F · unsupported U`   Every project's TFM is supported today,
 *      or is forced by a constraint that is not this repository's to choose, or is a declared exception. `U` must be 0.
 *
 * HOW A CONSTRAINT IS ESTABLISHED, in two ways, and the difference is printed:
 *
 *   FORCED (derived, `F`). A project builds or loads the game's own assemblies - a `<Reference>` to
 *      `Stardew Valley.dll` / `StardewModdingAPI.dll`, or the `Pathoschild.Stardew.ModBuildConfig` package that
 *      injects them - or it is connected to such a project by a `ProjectReference` in either direction. A library on
 *      the other end of a reference from the Mod must hold the Mod's framework, and a verifier that loads the Mod
 *      must run where the Mod runs. This is derived from the csproj graph, so a new project joins the population by
 *      existing rather than by being listed.
 *      The constraint itself is verified, not asserted: `<game>/StardewModdingAPI.runtimeconfig.json` declares
 *      `"tfm": "net6.0"` and `Microsoft.NETCore.App 6.0.0`, so an assembly built for another framework is not loaded
 *      by the host that reads it. `Pathoschild.Stardew.ModBuildConfig.targets` does NOT enforce the framework - it was
 *      read, and it names no `TargetFramework` - so the constraint is at LOAD time, which is why a retarget would
 *      fail silently at game start rather than at build.
 *   DECLARED (`K`). A table below, each row naming the project, its framework, why it is not this repository's choice,
 *      and the file in the tree that states the constraint. A row is a debt with a receipt, so it expires in three
 *      directions: the project disappearing, the framework drifting under it, or the evidence file being deleted are
 *      each a finding. A declaration is never how a project escapes the support check - only how it names the thing
 *      that already forced it.
 *
 * THE REPLACEMENT IS IN THE MESSAGE and never in the check. A row names `net10.0` (or the platform-qualified form) as
 * what this framework would be upgraded to, so the next reader does not have to re-derive it. Supporting a framework
 * here is the table's job, and the table is dated, so the gate goes red on its own the month a framework leaves
 * support rather than when someone remembers to look.
 *
 * WHAT A DESKTOP UPGRADE COSTS THE PLAYER: nothing. `GameBuddy.Desktop.csproj` and `GameBuddy.Setup.csproj` are
 * `SelfContained` with a `RuntimeIdentifier` and `PublishSingleFile`, so the runtime travels inside the one file a
 * player downloads. Moving those projects from `net8.0-windows` changes WHICH runtime is bundled, not what the player
 * must have installed. The message says so, because "this framework is out of support" reads like a user-facing
 * warning and is not one.
 *
 * POPULATION. Every csproj TRACKED by git in the tree, derived per run by `git ls-files` - not a directory walk.
 * Measured 2026-11-16: a walk over this worktree finds 13 more csproj under an untracked `scratch/` (including a
 * `scratch/retire/` copy of this very tree), so a walk would make the population a function of what each machine
 * happens to have lying around, and CI would examine a different set than a developer. A git checkout with no
 * `git ls-files` is `not_measured` with the reason, never a pass.
 *
 *   node tools/check-dotnet-target-and-language.mjs                     # the verdict
 *   node tools/check-dotnet-target-and-language.mjs --root DIR          # the same reading of another checkout
 *   node tools/check-dotnet-target-and-language.mjs --today 2026-11-16   # pin the clock (the falsifier suite does)
 *
 * red-proof: history  Before 2026-11-16 this tree declared `LangVersion` in none of its eighteen csproj under
 *   `integrations/stardew/` and `desktop/` (11 + 7), so all eighteen compiled at the SDK default for their framework - C# 10
 *   for the Mod's net6.0 - while this gate's `langversion in a csproj 0` read green over that state. The finding it
 *   raises is the drift that produced it (a csproj declaring its own version, a props file that governs nothing).
 *   The support half is the same tree either side of the day .NET 8 left support: `unsupported 16` at
 *   `--today 2026-11-16` against `unsupported 8` at `--today 2026-11-01`. The sixteen were then moved to
 *   `net10.0`/`net10.0-windows`, so that same `--today 2026-11-16` now reads `supported 16 · forced 12 · declared 2 ·
 *   unsupported 0` over the same thirty projects - the red-proof is the day, not a permanently red tree.
 */
export const gateDeclaration = {
  id: "check-dotnet-target-and-language",
  domain: "arch",
  tier: "l2",
  kind: "totality",
};

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The support window of every framework this repository could name, as published by Microsoft for the .NET releases.
 *
 * Keyed by FAMILY, not by TFM: `net8.0-windows` and `net8.0` are one release with one support window, and the platform
 * suffix says which surface an app needs rather than which release it runs on. Measured 2026-11-16: before
 * `familyOf` existed the table was read with the whole TFM, so a project correctly on `net10.0-windows` matched no row
 * and was reported `unrecognised` - the gate's own advice (`move it to net10.0-windows`) was the state that reddened.
 *
 * `ends` is the last day of support. A family with no row here is `unrecognised`, which is a finding rather than a
 * pass: a table that silently accepts what it has never heard of is the same fail-open this gate is replacing.
 */
export const SUPPORT_WINDOWS = Object.freeze({
  "net6.0": { ends: "2024-11-12" },
  "net7.0": { ends: "2024-05-14" },
  "net8.0": { ends: "2026-11-10" },
  "net9.0": { ends: "2026-05-12" },
  "net10.0": { ends: "2028-11-10" },
});

/** `net10.0-windows` -> `net10.0`: the release whose support window the platform-qualified form shares. */
export function familyOf(tfm) {
  return String(tfm).split("-")[0];
}

/** The framework a project here would be moved to: the newest LTS in `SUPPORT_WINDOWS`, keeping its platform suffix. */
export const REPLACEMENT_FAMILY = "net10.0";

/** Assemblies whose presence makes a project part of the SMAPI host's own build, or a loader of it. */
const GAME_ASSEMBLIES = Object.freeze(["StardewModdingAPI.dll", "Stardew Valley.dll", "StardewValley.GameData.dll"]);

/** The mod build package that injects those assemblies; its csproj carries no `<Reference>` of its own. */
const MOD_BUILD_PACKAGES = Object.freeze(["Pathoschild.Stardew.ModBuildConfig"]);

/**
 * Projects that run on an old framework because something in the tree outside this repository's build says so.
 *
 * Each row names the authority in the tree that states it, and every part of the row is checked: the project must
 * exist, must still be the framework the row names, and the evidence must still be there. A row that survives its
 * reason is a finding, not an exemption.
 */
export const DECLARED_CONSTRAINTS = Object.freeze([
  {
    project: "integrations/stardew/tests/farmhandcapabilitypublicationprojection.contract.csproj",
    tfm: "net6.0",
    names: "the SMAPI build of the Mod, as the release closure beside it records",
    why:
      "the target-publication manifest asserts this contract tool's runtimeconfig declares Microsoft.NETCore.App@6.0.0, " +
      "so it is published as evidence about the .NET 6 generation it ships with; building it on another framework " +
      "would make the closure describe a host that does not exist.",
    evidence: "integrations/stardew/tests/ActionDevelopmentTargetPublication/Program.cs",
  },
  {
    project: "integrations/stardew/tests/NavigationTopologyCharacterization.Contract.csproj",
    tfm: "net6.0",
    names: "the production Stardew Mod build it reads",
    why:
      "it is run with --production-dll over the Mod's own production output and binds that assembly's metadata, so it " +
      "runs on the framework the Mod is loaded into; a verifier on a different runtime would be evidence about a host " +
      "SMAPI never creates.",
    evidence: "integrations/stardew/tests/ProductionAssemblyBinding.cs",
  },
]);

const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** `net8.0-windows` -> `net10.0-windows`: the same platform, the family this table calls current. */
export function replacementFor(tfm) {
  const family = String(tfm).replace(/^net[\d.]+/u, "");
  return `${REPLACEMENT_FAMILY}${family}`;
}

/** The tracked csproj of a checkout, or a `not_measured` reason that names why the reading could not be taken. */
export function derivePopulation(root) {
  const listed = spawnSync("git", ["ls-files", "-z", "--", "*.csproj"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (listed.error !== undefined || listed.status !== 0) {
    return {
      projects: [],
      reason: `git ls-files failed in ${root}: ${(listed.stderr ?? "").trim() || String(listed.error)}`,
    };
  }
  return {
    projects: listed.stdout
      .split("\u0000")
      .filter((path) => path.length > 0)
      .map((path) => path.replaceAll("\\", "/"))
      .sort(),
    reason: null,
  };
}

/** One csproj, as the facts this gate judges. Text in, facts out: nothing here decides a verdict. */
export function readProject(source) {
  const single = /<TargetFramework>([^<]+)<\/TargetFramework>/u.exec(source);
  const plural = /<TargetFrameworks>([^<]+)<\/TargetFrameworks>/u.exec(source);
  return {
    tfm: single === null ? null : single[1].trim(),
    tfms:
      plural === null
        ? []
        : plural[1]
            .split(";")
            .map((value) => value.trim())
            .filter(Boolean),
    langVersion: /<LangVersion>([^<]+)<\/LangVersion>/u.exec(source)?.[1].trim() ?? null,
    projectReferences: [...source.matchAll(/<ProjectReference\s+Include="([^"]+)"/gu)].map((match) =>
      match[1].replaceAll("\\", "/"),
    ),
    bindsGameAssemblies:
      GAME_ASSEMBLIES.some((name) => new RegExp(`<HintPath>[^<]*${escape(name)}`, "u").test(source)) ||
      MOD_BUILD_PACKAGES.some((name) => new RegExp(`<PackageReference\\s+Include="${escape(name)}"`, "u").test(source)),
  };
}

/** Every ancestor `Directory.Build.props` of a project up to and including the checkout root, nearest first. */
function propsAbove(root, projectPath) {
  const found = [];
  const stop = resolve(root);
  for (let directory = dirname(join(root, projectPath)); ; directory = dirname(directory)) {
    const candidate = join(directory, "Directory.Build.props");
    if (existsSync(candidate)) found.push(relative(root, candidate).replaceAll("\\", "/"));
    // MSBuild applies a props file from the project upwards and stops at the drive root; this reading stops where the
    // checkout does, because a file above it is not part of the tree this gate judges.
    if (resolve(directory) === stop || dirname(directory) === directory) break;
  }
  return found;
}

/** RESOLVE a ProjectReference against the referencing project's own directory. */
function resolveReference(projectPath, include) {
  const base = dirname(projectPath);
  return join(base, include).replaceAll("\\", "/");
}

/**
 * The connected component of the reference graph this project sits in, which is what decides `forced`.
 *
 * Both directions count, and for different reasons: a library referenced BY a host must match the host's framework to
 * be referenceable at all, and a tool that references a host's project must run where that host runs to be evidence
 * about it. Union-find is the whole algorithm; the graph is small and the point is the property, not the traversal.
 */
function gameBound(projects, facts) {
  const parent = new Map(projects.map((path) => [path, path]));
  const find = (path) => {
    let node = path;
    while (parent.get(node) !== node) node = parent.get(node);
    return node;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a, b);
  };
  for (const path of projects) {
    for (const include of facts.get(path).projectReferences) {
      const target = resolveReference(path, include);
      if (parent.has(target)) union(path, target);
    }
  }
  const roots = new Set();
  for (const path of projects) if (facts.get(path).bindsGameAssemblies) roots.add(find(path));
  const bound = new Set();
  for (const path of projects) if (roots.has(find(path))) bound.add(path);
  return bound;
}

const today = (value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`--today is not a date: ${value}`);
  return parsed;
};

export function judge({ root = DEFAULT_ROOT, now = new Date(), declared = DECLARED_CONSTRAINTS } = {}) {
  const { projects, reason } = derivePopulation(root);
  if (reason !== null) return { status: "not_measured", reason };
  if (projects.length === 0) return { status: "population_empty" };

  const facts = new Map();
  for (const path of projects) facts.set(path, readProject(readFileSync(join(root, path), "utf8")));

  const findings = [];
  const census = {};
  const bound = gameBound(projects, facts);
  const declaredByProject = new Map(declared.map((row) => [row.project, row]));

  let supported = 0;
  let forced = 0;
  let unsupported = 0;
  let declaredCount = 0;
  let langVersionInCsproj = 0;

  for (const path of projects) {
    const fact = facts.get(path);
    const frameworks = fact.tfm === null ? fact.tfms : [fact.tfm];
    if (fact.tfm === null && fact.tfms.length === 0) {
      findings.push({ code: "targetframework_is_unsupported_and_not_declared", project: path, tfm: "(none)" });
      continue;
    }
    if (fact.tfms.length > 0)
      findings.push({ code: "targetframeworks_plural", project: path, detail: fact.tfms.join(";") });

    if (fact.langVersion !== null) {
      langVersionInCsproj += 1;
      findings.push({ code: "langversion_is_not_declared_once", project: path, detail: path });
    }

    for (const props of propsAbove(root, path)) {
      const text = readFileSync(join(root, props), "utf8");
      if (!/<LangVersion>/u.test(text)) {
        findings.push({ code: "langversion_not_governed", project: path, detail: props });
      }
    }

    for (const tfm of frameworks) {
      census[tfm] = (census[tfm] ?? 0) + 1;
      const window = SUPPORT_WINDOWS[familyOf(tfm)];
      if (window === undefined) {
        unsupported += 1;
        findings.push({ code: "targetframework_is_unsupported_and_not_declared", project: path, tfm });
        continue;
      }
      if (today(now.toISOString().slice(0, 10)) <= today(window.ends)) {
        supported += 1;
        continue;
      }
      const row = declaredByProject.get(path);
      if (row !== undefined && row.tfm === tfm) {
        declaredCount += 1;
        continue;
      }
      if (bound.has(path)) {
        forced += 1;
        continue;
      }
      unsupported += 1;
      findings.push({ code: "targetframework_is_unsupported_and_not_declared", project: path, tfm });
    }
  }

  for (const row of declared) {
    const fact = facts.get(row.project);
    if (fact === undefined) {
      findings.push({ code: "declared_constraint_stale", project: row.project, detail: row.tfm });
      continue;
    }
    if (fact.tfm !== row.tfm) {
      findings.push({
        code: "declared_constraint_tfm_drift",
        project: row.project,
        detail: `${row.tfm} -> ${String(fact.tfm)}`,
      });
    }
    if (!existsSync(join(root, row.evidence))) {
      findings.push({ code: "declared_constraint_unevidenced", project: row.project, detail: row.evidence });
    }
  }

  return {
    status: findings.length === 0 ? "passed" : "failed",
    findings,
    projects,
    census,
    langVersionInCsproj,
    declaredCount,
    supported,
    forced,
    unsupported,
    bound: [...bound].sort(),
    declared,
  };
}

/** The two lines a run always prints, so "0 findings" is never printed without the population it was 0 out of. */
export function report(reading) {
  const census = Object.entries(reading.census)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tfm, count]) => `${tfm} ${String(count)}`)
    .join(" · ");
  return [
    `projects examined ${String(reading.projects.length)} · ${census} · declared exceptions ${String(reading.declaredCount)} · langversion in a csproj ${String(reading.langVersionInCsproj)}`,
    `supported ${String(reading.supported)} · forced by an external constraint ${String(reading.forced)} · unsupported ${String(reading.unsupported)}`,
  ];
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(flag("--root", DEFAULT_ROOT));
  const reading = judge({ root, now: today(flag("--today", new Date().toISOString().slice(0, 10))) });

  if (reading.status === "not_measured") {
    console.error(`dotnet_target_and_language: not_measured · ${reading.reason}`);
    process.exit(2);
  }
  if (reading.status === "population_empty") {
    console.error(
      "dotnet_target_and_language: projects_population_empty · git ls-files found no csproj, which agrees with every rule ever written",
    );
    process.exit(2);
  }

  for (const line of report(reading)) console.log(`dotnet_target_and_language: ${line}`);
  console.log(
    `dotnet_target_and_language: forced ${String(reading.bound.length)} project(s) share SMAPI's framework (StardewModdingAPI.dll / Stardew Valley.dll, derived from the csproj graph) · declared ${String(reading.declared.length)} row(s) checked against their evidence`,
  );

  if (reading.findings.length === 0) process.exit(0);

  for (const finding of reading.findings) {
    if (finding.code === "langversion_is_not_declared_once") {
      console.error(
        `${finding.code}:${finding.project}:${finding.detail} — LangVersion belongs in the Directory.Build.props that governs this tree, not in a csproj; a per-project declaration is the drift this gate exists to stop`,
      );
    } else if (finding.code === "langversion_not_governed") {
      console.error(
        `${finding.code}:${finding.project}:${finding.detail} — this props file governs the project but declares no LangVersion, so the project compiles at an undeclared default`,
      );
    } else if (finding.code === "targetframework_is_unsupported_and_not_declared") {
      console.error(
        `${finding.code}:${finding.project}:${finding.tfm} — its support window has closed and nothing here forces it: move it to ${replacementFor(finding.tfm)} (the runtime a self-contained Windows project bundles changes; what a player must have installed does not), or add a DECLARED_CONSTRAINTS row naming the authority that forces this framework and the file that states it`,
      );
    } else {
      console.error(`${finding.code}:${finding.project}:${finding.detail}`);
    }
  }
  console.error(`dotnet_target_and_language: ${String(reading.findings.length)} finding(s)`);
  process.exit(1);
}
