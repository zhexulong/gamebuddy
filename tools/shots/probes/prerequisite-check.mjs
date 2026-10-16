// Probe: fast prerequisite check that names exactly what is missing before the long build starts.
// `node tools/shots/run.mjs --check` runs this and exits non-zero when a REQUIRED item is missing.
// The credential row is presence+length only and is a SKIP, not a failure (the conversation lane
// records a named skip when it is absent).
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../lib/config.mjs";

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
  if (dotnet.status === 0) pass("dotnet", dotnet.stdout.trim().split("\n")[0]);
  else fail("dotnet", "no dotnet on PATH (needed for Mod + reclaimer builds)");

  const gameDir = process.env.GB_SHOTS_GAME_DIR ?? "D:\\Steam\\steamapps\\common\\Stardew Valley";
  if (await exists(join(gameDir, "Stardew Valley.exe"))) pass("stardew-game-dir", gameDir);
  else fail("stardew-game-dir", `${gameDir}\\Stardew Valley.exe missing (set GB_SHOTS_GAME_DIR)`);

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
      const parsed = JSON.parse(runtimeProbe.stdout.trim().split("\n").pop());
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
    JSON.stringify(
      { rows, requiredMissing: rows.filter((row) => !row.ok && !row.name.startsWith("credential")).length },
      null,
      1,
    ),
  );
  return rows.some((row) => !row.ok && !row.name.startsWith("credential")) ? 1 : 0;
}

const code = await main().catch((error) => {
  console.log(JSON.stringify({ probeFailed: String(error).slice(0, 400) }));
  return 1;
});
process.exit(code);
