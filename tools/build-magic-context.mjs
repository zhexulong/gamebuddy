#!/usr/bin/env node
/**
 * Build the vendored Magic Context plugin without going through pnpm.
 *
 * WHY THIS EXISTS INSTEAD OF `pnpm build:magic-context`
 *
 * pnpm 11 verifies and completes dependencies before it runs a script, so `pnpm build:magic-context` installed the
 * whole workspace FIRST and only then ran the build. Measured in CI (run 42463460197, gates job):
 *
 *   08:35:39  Scope: all 5 workspace projects
 *   08:35:55  Done in 16.9s using pnpm v11.1.3        <- the install, before any vendor output existed
 *   08:35:56  $ bun run --cwd vendor/magic-context/packages/pi-plugin build
 *   08:35:58  Bundled 3331 modules ...                <- the `dist/` the two `file:` dependencies promise
 *
 * Setting `npm_config_verify_deps_before_run: "false"` on that step did not stop it (the install still ran at
 * 08:35:39), so the ordering is fixed structurally instead of by configuration: this script calls `bun` directly and
 * there is no pnpm process left to decide anything first.
 *
 * The build's second half is `tools/normalise-vendored-bundle-shims.mjs`, which rewrites the `__dirname` pair bun
 * inlines for bundled CommonJS dependencies; the two belong to one command because a build without it ships a
 * bundle that resolves its own paths wrong.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIRECTORY = "vendor/magic-context/packages/pi-plugin";

function main() {
  if (!existsSync(join(REPOSITORY_ROOT, PLUGIN_DIRECTORY, "package.json"))) {
    process.stderr.write(
      `vendor_plugin_absent: ${PLUGIN_DIRECTORY} is a git submodule; run \`git submodule update --init\`\n`,
    );
    return 1;
  }

  // `bun install` inside the submodule is the caller's job (its lockfile is its own); this only builds.
  try {
    execFileSync("bun", ["run", "build"], {
      cwd: join(REPOSITORY_ROOT, PLUGIN_DIRECTORY),
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
  } catch (error) {
    process.stderr.write(`vendor_build_failed: \`bun run build\` exited ${error?.status ?? "?"}\n`);
    return 1;
  }

  try {
    execFileSync(process.execPath, [join(REPOSITORY_ROOT, "tools/normalise-vendored-bundle-shims.mjs")], {
      cwd: REPOSITORY_ROOT,
      stdio: "inherit",
    });
  } catch (error) {
    process.stderr.write(`vendor_bundle_normalise_failed: exited ${error?.status ?? "?"}\n`);
    return 1;
  }

  // What the build must have produced, read from the package's own `exports` rather than a list here.
  const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, PLUGIN_DIRECTORY, "package.json"), "utf8"));
  const subpaths = Object.keys(manifest.exports ?? {});
  process.stdout.write(`vendor_build_ok: ${subpaths.length} export subpath(s) declared\n`);
  return 0;
}

process.exitCode = main();
