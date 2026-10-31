import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classify, EXCLUSIONS, trackedProjects } from "./check-csharp-compile.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOD = "integrations/stardew/GameBuddy.Stardew.csproj";
const CORE = "integrations/stardew/src/Core/GameBuddy.Stardew.Core.csproj";

/**
 * The build output `def2fb07` produced at HEAD, trimmed to the shape MSBuild emits: one diagnostic
 * per line, the project path in brackets, and the same diagnostic repeated in the summary. The
 * real commit had 20 of these; the numbers that matter to the classifier are the two `error CS`
 * lines and the project they name.
 */
const DEF2FB07_OUTPUT = [
  'E:\\projects\\ai-game-companion\\integrations\\stardew\\farmhandexecutioncontroller.resourcetoolactions.cs(121,29): error CS0117: "NativeItemPredicates" does not contain a definition for "IsOneHitBreakableStone" [E:\\projects\\ai-game-companion\\integrations\\stardew\\GameBuddy.Stardew.csproj]',
  'E:\\projects\\ai-game-companion\\integrations\\stardew\\farmhandexecutioncontroller.containeractions.cs(88,17): error CS0103: The name "ResolveStorageContainerAt" does not exist in the current context [E:\\projects\\ai-game-companion\\integrations\\stardew\\GameBuddy.Stardew.csproj]',
  "",
  "    0 Warning(s)",
  "    20 Error(s)",
  "",
].join("\n");

const MOD_BUILD_REFUSAL = [
  "C:\\Users\\long\\.nuget\\packages\\pathoschild.stardew.modbuildconfig\\4.4.0\\build\\Pathoschild.Stardew.ModBuildConfig.targets(74,5): error : The mod build package can't find your game folder. You can specify where to find it; see https://smapi.io/package/custom-game-path. [E:\\projects\\ai-game-companion\\integrations\\stardew\\GameBuddy.Stardew.csproj]",
  "",
  "    1 Error(s)",
  "",
].join("\n");

test("a project that builds is covered, whether or not it is registered", () => {
  assert.deepEqual(classify({ project: CORE, exitCode: 0, output: "  0 个警告\n" }), { outcome: "compiled" });
  assert.deepEqual(classify({ project: MOD, exitCode: 0, output: "" }), { outcome: "compiled" });
});

test("the commit that broke HEAD is a compile error naming the Mod project", () => {
  const verdict = classify({ project: MOD, exitCode: 1, output: DEF2FB07_OUTPUT });
  assert.equal(verdict.outcome, "compile_error");
  assert.match(verdict.detail, /error CS0117/u);
  assert.match(verdict.detail, /resourcetoolactions\.cs\(121,29\)/u);
});

test("a compiler diagnostic outranks the project's exclusion - the register excuses a prerequisite, never broken source", () => {
  // The same refusal text is present, as it would be if the compiler had run after the folder check
  // changed; the CS diagnostic is still the verdict.
  const verdict = classify({ project: MOD, exitCode: 1, output: `${MOD_BUILD_REFUSAL}\n${DEF2FB07_OUTPUT}` });
  assert.equal(verdict.outcome, "compile_error");
});

test("a registered prerequisite refusal is a declared exclusion, named with its cost", () => {
  const verdict = classify({ project: MOD, exitCode: 1, output: MOD_BUILD_REFUSAL });
  assert.deepEqual(verdict, { outcome: "declared_exclusion" });
});

test("an exclusion whose refusal text changed is not an exclusion", () => {
  const verdict = classify({
    project: MOD,
    exitCode: 1,
    output: "error : The mod build package could not locate your installation.",
  });
  assert.equal(verdict.outcome, "exclusion_unearned");
  assert.match(verdict.detail, /expected refusal/u);
});

test("an unregistered project that fails to build is an undeclared failure, not a silent skip", () => {
  const verdict = classify({
    project: "tools/some-new-probe/SomeNewProbe.csproj",
    exitCode: 1,
    output: "error : GamePath is required to build this probe.",
  });
  assert.equal(verdict.outcome, "undeclared_failure");
  assert.match(verdict.detail, /GamePath is required/u);
});

test("a failure with no recognisable error line still reports as a failure", () => {
  const verdict = classify({ project: MOD, exitCode: 1, output: "" });
  assert.equal(verdict.outcome, "exclusion_unearned");
  assert.equal(verdict.detail.includes("(no error line in the build output)"), true);
});

test("the detail names the CS diagnostic, not a prerequisite refusal printed ahead of it", () => {
  // Measured while proving this gate red: a project whose ProjectReference fails prints the
  // referenced project's prerequisite refusal before the diagnostic that actually stopped it.
  const verdict = classify({
    project:
      "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj",
    exitCode: 1,
    output: `${MOD_BUILD_REFUSAL}\n${DEF2FB07_OUTPUT}`,
  });
  assert.equal(verdict.outcome, "compile_error");
  assert.match(verdict.detail, /error CS0117/u);
  assert.doesNotMatch(verdict.detail, /can't find your game folder/u);
});

test("the population is every tracked C# project, so a new project is covered by existing", () => {
  const listed = trackedProjects();
  assert.ok(listed.length > 0);
  for (const project of [MOD, CORE]) assert.ok(listed.includes(project), `${project} is missing from the population`);
  assert.deepEqual([...listed].sort(), listed, "the population is returned sorted");
});

test("every exclusion names a project that exists, so a rename cannot leave a dead entry", () => {
  const listed = new Set(trackedProjects());
  for (const entry of EXCLUSIONS) {
    assert.ok(listed.has(entry.project), `${entry.project} is registered but is not a tracked project`);
    assert.ok(entry.refusal.trim() !== "", `${entry.project} registers no refusal text`);
    assert.ok(entry.cost.trim() !== "", `${entry.project} registers no cost`);
  }
});

test("the gate is honest about the game: the Mod's exclusion is present while no game assembly is tracked", () => {
  // The exclusion exists because this repository tracks no game assembly. If someone ever commits
  // one, the Mod compiles here and the entry has to go - so the two facts are asserted together
  // rather than the exclusion being assumed permanent.
  const tracked = spawnSync("git", ["ls-files", "*.dll"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  assert.equal(tracked.status, 0);
  const gameAssemblyTracked = tracked.stdout.split("\n").some((line) => /Stardew Valley\.dll$/u.test(line.trim()));
  const modExcluded = EXCLUSIONS.some((entry) => entry.project === MOD);
  assert.equal(
    modExcluded,
    !gameAssemblyTracked,
    gameAssemblyTracked
      ? "a game assembly is tracked, so the Mod compiles here and its exclusion must be removed"
      : "no game assembly is tracked, so the Mod cannot compile here and its exclusion must be registered",
  );
});
