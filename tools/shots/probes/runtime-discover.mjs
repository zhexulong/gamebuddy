// Probe: locate and validate a "runtime root" directory that DIRECTLY contains node.exe
// (a complete pinned Node distribution tree). This is argv[3] for
// host/scripts/build-desktop-launcher-test-generation.mjs (--full-runtime-tree), which fails with
// desktop_launcher_test_fixture_node_missing when the argument is a runtime ROOT rather than the
// inner tree. Discovery order:
//   1. --runtime <dir>              (the caller's explicit choice; validated)
//   2. env GB_SHOTS_RUNTIME         (same contract)
//   3. scan GB_SHOTS_RUNTIME_SEARCH (system-delimited roots; default D:\gb-art) for the newest
//      `generations/*/runtime` that directly contains node.exe
// Only paths and presence facts are printed (a path is not a secret; a credential would be).
import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isValidRuntime(dir) {
  if (!(await exists(dir))) return false;
  const nodeExe = join(dir, "node.exe");
  if (!(await exists(nodeExe))) return false;
  try {
    const info = await stat(nodeExe);
    return info.isFile() && info.size > 1_000_000;
  } catch {
    return false;
  }
}

async function findNewest(roots) {
  let best = null;
  let bestAge = -1;
  for (const root of roots) {
    let generations;
    try {
      generations = await readdir(join(root, "generations"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of generations) {
      if (!entry.isDirectory()) continue;
      const candidate = join(root, "generations", entry.name, "runtime");
      if (!(await isValidRuntime(candidate))) continue;
      try {
        const info = await stat(join(candidate, "node.exe"));
        if (info.mtimeMs > bestAge) {
          bestAge = info.mtimeMs;
          best = candidate;
        }
      } catch {
        /* keep scanning */
      }
    }
  }
  return best;
}

async function main() {
  const argv = process.argv.slice(2);
  const explicit =
    argv
      .find((arg) => arg.startsWith("--runtime="))
      ?.split("=")
      .slice(1)
      .join("=") ?? null;
  const envRuntime = process.env.GB_SHOTS_RUNTIME ?? null;
  const searchRaw = process.env.GB_SHOTS_RUNTIME_SEARCH ?? "D:\\gb-art";

  const candidates = [explicit, envRuntime].filter((value) => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    if (await isValidRuntime(candidate)) {
      console.log(JSON.stringify({ found: candidate, source: explicit === candidate ? "explicit" : "env" }));
      return 0;
    }
  }
  if (explicit === null && envRuntime === null) {
    const roots = searchRaw
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const found = await findNewest(roots);
    if (found !== null) {
      console.log(JSON.stringify({ found, source: "discovery" }));
      return 0;
    }
  }
  console.log(
    JSON.stringify({
      missing: "runtime_fixture_root",
      hint: "pass --runtime <dir-that-directly-contains-node.exe> or set GB_SHOTS_RUNTIME; set GB_SHOTS_RUNTIME_SEARCH to scan other roots",
      searchedRoots: searchRaw.split(";"),
    }),
  );
  return 1;
}

const code = await main().catch((error) => {
  console.log(JSON.stringify({ missing: "runtime_discovery_failed", detail: String(error).slice(0, 300) }));
  return 1;
});
process.exit(code);
