// Probe: fast prerequisite check that names exactly what is missing before the long build starts.
// `node tools/live-run/frontend/run.mjs --check` runs this and exits non-zero when a REQUIRED item is missing.
// The credential row is presence+length only and is a SKIP, not a failure (the conversation lane
// records a named skip when it is absent).
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../lib/config.mjs";
import { cleanOutputLines } from "../../../lib/subprocess-output.mjs";

const RUNTIME_PROBE = fileURLToPath(new URL("./runtime-discover.mjs", import.meta.url));

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const VITE_SIBLINGS = ["rolldown", "postcss", "esbuild", "picomatch", "tinyglobby", "jiti", "lightningcss", "yaml"];

/**
 * Rows whose absence is NAMED and skipped rather than required.
 *
 * A full run can proceed without them and the lanes that need them say so themselves: the credential is
 * a named skip (the conversation lane records it), and the `launch:` rows are the game-launch driver's
 * own prerequisites, which that driver checks again in its first second and reports as `not_measured`
 * with the same names. Making them required here would refuse a whole frontend run on a machine that
 * has no Stardew installation, which is a legitimate machine to run every other driver on.
 */
const NON_REQUIRED_PREFIXES = ["credential:", "launch:"];

async function main() {
  const argv = process.argv.slice(2);
  const commit =
    argv
      .find((arg) => arg.startsWith("--commit="))
      ?.split("=")
      .slice(1)
      .join("=") ?? null;
  const outRaw =
    argv
      .find((arg) => arg.startsWith("--out="))
      ?.split("=")
      .slice(1)
      .join("=") ?? null;
  const rows = [];
  const fail = (name, detail) => rows.push({ name, ok: false, detail });
  const pass = (name, detail) => rows.push({ name, ok: true, detail });

  const nodeProbe = spawnSync(process.execPath, ["--version"], { encoding: "utf8", windowsHide: true });
  if (nodeProbe.status === 0) pass("node", nodeProbe.stdout.trim());
  else fail("node", "system node unusable (kit runner)");

  const gitProbe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (gitProbe.status === 0) {
    pass("git-repo", REPO_ROOT);
    if (commit !== null) {
      const resolved = spawnSync("git", ["rev-parse", commit], { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
      if (resolved.status === 0) pass("commit", resolved.stdout.trim());
      else fail("commit", `cannot resolve --commit ${commit}`);
    }
  } else {
    fail("git-repo", "no git work tree at repo root");
  }

  const pairs = [
    ["host::typescript", join(REPO_ROOT, "host", "node_modules", "typescript", "lib", "tsc.js")],
    ["dialogue-web::vite", join(REPO_ROOT, "dialogue-web", "node_modules", "vite", "bin", "vite.js")],
    ["tools::launcher", join(REPO_ROOT, "tools", "desktop-composition-launch.mjs")],
    ["host::generation-builder", join(REPO_ROOT, "host", "scripts", "build-desktop-launcher-test-generation.mjs")],
    ["host::reclaimer-builder", join(REPO_ROOT, "host", "scripts", "build-windows-stale-lock-reclaimer.mjs")],
    ["mod::csproj", join(REPO_ROOT, "integrations", "stardew", "GameBuddy.Stardew.csproj")],
  ];
  for (const [name, path] of pairs) {
    if (await exists(path)) pass(name, path);
    else fail(name, path);
  }

  for (const sibling of VITE_SIBLINGS) {
    const path = join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", sibling);
    if (await exists(path)) pass(`vite-sibling:${sibling}`, path);
    else fail(`vite-sibling:${sibling}`, path);
  }

  const dotnet = spawnSync("dotnet", ["--version"], { encoding: "utf8", windowsHide: true });
  if (dotnet.status === 0) pass("dotnet", cleanOutputLines(dotnet.stdout.trim())[0]);
  else fail("dotnet", "no dotnet on PATH (needed for Mod + reclaimer builds)");

  const gameDir = process.env.GB_SHOTS_GAME_DIR ?? "D:\\Steam\\steamapps\\common\\Stardew Valley";
  if (await exists(join(gameDir, "Stardew Valley.exe"))) pass("stardew-game-dir", gameDir);
  else fail("stardew-game-dir", `${gameDir}\\Stardew Valley.exe missing (set GB_SHOTS_GAME_DIR)`);

  /*
   * What the game-launch driver needs, in one row, so an operator knows BEFORE the twenty-minute build
   * whether the headline path can be measured here at all. Four different kinds of thing, and each is
   * named with the fact that was read for it:
   *
   *   the game        the installation above (`stardew-game-dir`)
   *   SMAPI           `<gameDir>\StardewModdingAPI.exe` - the launch chain starts the game through it
   *   the Mod         `integrations/stardew/GameBuddy.Stardew.csproj`, built by the build phase and
   *                   deployed by the Host into its own private bootstrap, so its presence here is a
   *                   SOURCE fact and the deployed copy is the driver's own reading (`machinePrerequisites`)
   *   the generation  `host/scripts/build-desktop-launcher-test-generation.mjs`, whose output is what
   *   and its image   publishes `native/windows-bootstrap-guardian/win-x64/GameBuddy.WindowsBootstrapGuardian.exe`;
   *                   a generation without that image serves the guardian session `hello_only` and no
   *                   launch can arm a role, which the driver reports as `not_measured: guardian_image_absent`
   */
  const launchChain = {
    game: await exists(join(gameDir, "Stardew Valley.exe")),
    smapi: await exists(join(gameDir, "StardewModdingAPI.exe")),
    modSource: await exists(join(REPO_ROOT, "integrations", "stardew", "GameBuddy.Stardew.csproj")),
    generationBuilder: await exists(join(REPO_ROOT, "host", "scripts", "build-desktop-launcher-test-generation.mjs")),
    guardianSource: await exists(
      join(REPO_ROOT, "host", "native", "windows-bootstrap-guardian", "GameBuddy.WindowsBootstrapGuardian.csproj"),
    ),
  };
  const launchMissing = Object.entries(launchChain)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (launchMissing.length === 0)
    pass(
      "launch:chain",
      `game=${gameDir} smapi=StardewModdingAPI.exe mod=GameBuddy.Stardew.csproj generation=build-desktop-launcher-test-generation.mjs guardian=windows-bootstrap-guardian`,
    );
  else
    fail(
      "launch:chain",
      `absent: ${launchMissing.join(",")} - driver w reports not_measured, the rest of the run proceeds`,
    );

  const edge = process.env.GB_SHOTS_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  if (await exists(edge)) pass("edge", edge);
  else fail("edge", `${edge} missing (set GB_SHOTS_EDGE)`);

  const runtimeArgs = argv.filter((arg) => arg.startsWith("--runtime="));
  const runtimeProbe = spawnSync(process.execPath, [RUNTIME_PROBE, ...runtimeArgs], {
    encoding: "utf8",
    windowsHide: true,
  });
  let runtime = null;
  let runtimeDetail = null;
  if (runtimeProbe.status === 0) {
    try {
      const parsed = JSON.parse(cleanOutputLines(runtimeProbe.stdout.trim()).pop());
      runtime = parsed.found ?? null;
      runtimeDetail = parsed.source ?? null;
    } catch {
      runtime = null;
    }
  }
  if (runtime !== null) pass("runtime-fixture", `${runtime} (${runtimeDetail})`);
  else
    fail(
      "runtime-fixture",
      JSON.stringify({
        missing: "runtime_fixture_root",
        hint: "pass --runtime or set GB_SHOTS_RUNTIME / GB_SHOTS_RUNTIME_SEARCH",
      }),
    );

  if (outRaw !== null) {
    try {
      await mkdir(join(outRaw, ".shots-check"), { recursive: true });
      pass("out-writable", outRaw);
    } catch {
      fail("out-writable", outRaw);
    }
  }

  const credential = process.env.CPA_OAI_API_KEY ?? null;
  if (credential !== null) pass("credential:CPA_OAI_API_KEY", `present length=${credential.length}`);
  else pass("credential:CPA_OAI_API_KEY", "absent (conversation/variant lanes will record a NAMED SKIP)");

  console.log(
    JSON.stringify({
      rows,
      requiredMissing: rows.filter(
        (row) => !row.ok && !NON_REQUIRED_PREFIXES.some((prefix) => row.name.startsWith(prefix)),
      ).length,
    }),
  );
  return rows.some((row) => !row.ok && !NON_REQUIRED_PREFIXES.some((prefix) => row.name.startsWith(prefix))) ? 1 : 0;
}

const code = await main().catch((error) => {
  console.log(JSON.stringify({ probeFailed: String(error).slice(0, 400) }));
  return 1;
});
process.exit(code);
