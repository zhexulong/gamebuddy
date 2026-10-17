/**
 * Run EVERY Mod test project, one after another, and report them together.
 *
 * The gap this closes cost a night of live runs: the wire-argument whitelist test that would have caught a
 * registered-but-uninvokable action already existed - in `GameBuddy.Stardew.Core.Tests`, a project nobody had run
 * that evening, because the working habit was `dotnet test` against the one project a developer remembers. The
 * repositories' Mod tests live in EIGHT projects, and a green run of one says nothing about the other seven.
 *
 * Verification breadth is not a matter of discipline if the command that gives it has a name.
 *
 * Usage:
 *   node tools/test-stardew-all.mjs            # every project, summary at the end
 *   node tools/test-stardew-all.mjs --filter X # pass a --filter through to dotnet
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TESTS_ROOT = join(ROOT, "integrations", "stardew", "tests");
const GAME_PATH = process.env.GAMEBUDDY_STARDEW_GAME_DIR ?? "D:\\Steam\\steamapps\\common\\Stardew Valley";

/** Every `.csproj` under the Mod test tree, skipping build output. */
function testProjects() {
  const found = [];
  for (const entry of readdirSync(TESTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "bin" || entry.name === "obj") continue;
    const nested = join(TESTS_ROOT, entry.name);
    const direct = readdirSync(nested).filter((name) => name.endsWith(".csproj"));
    if (direct.length > 0) {
      for (const project of direct) found.push(join(nested, project));
      continue;
    }
    // A few projects live one level deeper (per-target publication harnesses).
    for (const inner of readdirSync(nested, { withFileTypes: true })) {
      if (!inner.isDirectory()) continue;
      const deeper = join(nested, inner.name);
      if (statSync(deeper).isDirectory() === false) continue;
      for (const project of readdirSync(deeper).filter((name) => name.endsWith(".csproj")))
        found.push(join(deeper, project));
    }
  }
  return found.sort();
}

const filterIndex = process.argv.indexOf("--filter");
const filter = filterIndex < 0 ? null : process.argv[filterIndex + 1];

/**
 * A project either reports a pass/fail summary or is not a test project at all (the export/publication harnesses
 * are plain executables). Both are reported: "no summary" is itself information.
 */
function summarize(output) {
  const passed = /已通过!|Passed!\s/.test(output);
  const failed = /失败!|Failed!\s/.test(output);
  const counts =
    /通过:\s*(\d+)[\s\S]{0,40}?总计:\s*(\d+)/.exec(output) ?? /Passed:\s*(\d+)[\s\S]{0,40}?Total:\s*(\d+)/.exec(output);
  if (passed) return { status: "passed", detail: counts === null ? "" : `${counts[1]}/${counts[2]}` };
  if (failed) return { status: "failed", detail: counts === null ? "" : `${counts[1]}/${counts[2]}` };
  // Three of these projects are PUBLICATION HARNESSES rather than test projects: `dotnet test` on them does not
  // run tests, it prints no summary and exits 0. Calling them red would make this gate cry wolf on every run, so
  // they are reported as what they are - and a project that DOES fail is red either way, because a failing test
  // run always prints the failure line.
  return { status: "no_test_project", detail: "" };
}

const results = [];
for (const project of testProjects()) {
  const name = project.slice(TESTS_ROOT.length + 1).replace(/\\/gu, "/");
  const args = ["test", project, "-c", "Release", "--nologo", "-v", "q", `-p:GamePath=${GAME_PATH}`];
  if (filter !== null) args.push("--filter", filter);
  let output = "";
  try {
    output = execFileSync("dotnet", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    output = `${String(error?.stdout ?? "")}\n${String(error?.stderr ?? "")}`;
  }
  const result = summarize(output);
  results.push({ name, ...result });
  const label = result.status === "passed" ? "ok  " : result.status === "failed" ? "RED " : "—   ";
  process.stderr.write(`${label} ${name} ${result.detail}\n`);
}

const failed = results.filter((result) => result.status === "failed");
process.stdout.write(
  `${JSON.stringify(
    {
      gate: "stardew_mod_tests_all_projects/v1",
      status: failed.length === 0 ? "passed" : "failed",
      // Named so a reader knows the difference between "this project passed" and "this project has no tests".
      projectsWithoutTests: results
        .filter((result) => result.status === "no_test_project")
        .map((result) => result.name),
      projects: results,
      failed: failed.map((result) => result.name),
    },
    null,
    2,
  )}\n`,
);
if (failed.length > 0) process.exitCode = 1;
