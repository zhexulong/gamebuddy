#!/usr/bin/env node
/**
 * Vendor build-artifact gate: a `file:` dependency whose `exports` point into a gitignored `dist/` is resolvable
 * only after that package has been built in this checkout.
 *
 * WHY (the accident, measured 2026-11-07, CI run 42399923181)
 *
 * The `gates` job failed `pnpm --dir host build:test` with 32 `TS2307` errors that named the SAME two packages,
 * every subpath of them: `@cortexkit/pi-magic-context/tavern`, `@cortexkit/pi-magic-context/memory`,
 * `@gamebuddy/voice-protocol`. Its own log explains why, and the order is not the one the workflow file appears
 * to state:
 *
 *   18:12:04  Scope: all 5 workspace projects        <- a root install, 16 seconds of it
 *   18:12:20  Done in 16.3s using pnpm v11.1.3
 *   18:12:20  $ bun run --cwd vendor/magic-context/packages/pi-plugin build
 *   18:12:21  Bundled 3331 modules ... (the `dist/` those imports need, written HERE)
 *
 * pnpm 11 verifies and completes dependencies before it runs a script, so `pnpm build:magic-context` installed the
 * whole workspace FIRST - importing both `file:` dependencies from trees whose `dist/` did not exist yet. The
 * explicit `pnpm install --frozen-lockfile` afterwards is a no-op ("Lockfile is up to date, resolution step is
 * skipped"), so the store copies never gained a `dist/` and the compile could not resolve either package.
 *
 * Locally the same command is green, which is the whole reason this needs a gate rather than a note: this machine's
 * store copy was imported on 2026-10-29, when `dist/` already existed, and pnpm hard-links directory dependencies
 * (measured: `dist/tavern/index.js` has the same inode in `vendor/` and in `node_modules/.pnpm/...`, link count 3),
 * so a rebuild or a rename is visible in both places. A fresh checkout has neither.
 *
 * WHAT IS READ: THE POPULATION IS THE DECLARATION, NOT A LIST
 *
 *   1. every `package.json` in the workspace (the globs come from `pnpm-workspace.yaml`, so a new package joins on
 *      its own) contributes its dependencies, devDependencies and optionalDependencies whose specifier starts with
 *      `file:`;
 *   2. each such target's own `package.json` contributes its `exports` map, and for every subpath the `types` and
 *      `import`/`require`/`default` targets are resolved relative to that directory;
 *   3. each resolved path must be a file with a non-zero size.
 *
 * A missing one is `vendor_artifact_missing:<package>:<subpath>:<file>`, and the message carries the command that
 * produces it plus the dependency that needs it, because "cannot find module" at compile time names neither.
 *
 * Two escape hatches, both spelled out in the report so they cannot hide: a target that points OUTSIDE its own
 * package directory is `vendor_artifact_target_outside:<...>` (a path escaping the package is not something this
 * gate can resolve), and a package with no `exports` map is `vendor_artifact_no_exports:<package>` - that is a
 * statement about the package, not a pass.
 *
 * Output: one JSON verdict `{"gate":"vendor-build-artifacts","examined":N,"files":N,"violations":[...],"status":...}`.
 * `examined` counts `file:` dependencies actually resolved, and zero of them is `status:"blocked"` and exit 1: a
 * gate that measured no dependency has not passed.
 *
 * Usage:
 *   node tools/check-vendor-build-artifacts.mjs                      # this repository
 *   node tools/check-vendor-build-artifacts.mjs --root <dir>         # a fixture tree
 *
 * red-proof: inject  rename `vendor/magic-context/packages/pi-plugin/dist/tavern` away ->
 *            `vendor_artifact_missing:@cortexkit/pi-magic-context:./tavern:dist/tavern/index.d.ts` (and the `.js`),
 *            exit 1; moving it back reports `examined 2, violations []`
 *            (tools/check-vendor-build-artifacts.test.mjs drives the same function over a fixture tree).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONDITION_KEYS = ["types", "import", "require", "default", "node", "module"];

/** Workspace package directories, from `pnpm-workspace.yaml`'s `packages:` list plus the root itself. */
function workspaceDirectories(root) {
  const directories = [root];
  let workspace = "";
  try {
    workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return directories;
  }
  const start = workspace.indexOf("packages:");
  if (start === -1) return directories;
  const lines = workspace.slice(start).split(/\r?\n/u).slice(1);
  for (const line of lines) {
    const match = /^\s+-\s*'?([^'#\s]+)'?/u.exec(line);
    if (match === null) {
      if (line.trim() !== "" && !line.trim().startsWith("#")) break;
      continue;
    }
    const pattern = match[1];
    if (pattern.startsWith("!")) continue;
    if (pattern.endsWith("/*")) {
      const parent = join(root, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(join(parent, entry.name));
      }
    } else {
      directories.push(resolve(root, pattern));
    }
  }
  return directories;
}

/** Every `file:` dependency declared anywhere in the workspace, deduplicated by its resolved directory. */
function fileDependencies(root) {
  const found = new Map();
  for (const directory of workspaceDirectories(root)) {
    const manifest = join(directory, "package.json");
    if (!existsSync(manifest)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      continue;
    }
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, specifier] of Object.entries(parsed[field] ?? {})) {
        if (typeof specifier !== "string" || !specifier.startsWith("file:")) continue;
        const target = resolve(directory, specifier.slice("file:".length));
        if (!found.has(target)) found.set(target, { name, target, declaring: [] });
        found.get(target).declaring.push({
          manifest: relative(root, manifest).split(sep).join("/"),
          directory,
        });
      }
    }
  }
  return [...found.values()]
    .map((dependency) => ({ ...dependency, declaredBy: dependency.declaring.map((entry) => entry.manifest) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Every file path an `exports` map promises, with the subpath that promises it. */
function promisedFiles(manifest, packageDirectory) {
  const files = [];
  // `exports` may be a bare string (`"./dist/index.js"`), which is the package's only entry point. Reading
  // `Object.entries` of that string yields its characters - measured 2026-11-07, that produced subpaths `0`, `1`,
  // `11` and looked like fifteen missing files for `@gamebuddy/voice-protocol`.
  const exported = typeof manifest.exports === "string" ? { ".": manifest.exports } : (manifest.exports ?? {});
  for (const [subpath, entry] of Object.entries(exported)) {
    if (typeof entry === "string") {
      files.push({ subpath, file: entry });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    // A conditional object, or a nested map of subpaths when `exports` has no leading ".".
    if (CONDITION_KEYS.some((key) => typeof entry[key] === "string")) {
      for (const key of CONDITION_KEYS) {
        if (typeof entry[key] === "string") files.push({ subpath, file: entry[key] });
      }
      continue;
    }
    for (const [nested, value] of Object.entries(entry)) {
      if (typeof value === "string") files.push({ subpath: `${subpath}${nested}`, file: value });
    }
  }
  return files.map((promise) => ({ ...promise, absolute: resolve(packageDirectory, promise.file) }));
}

/**
 * Where the consumer actually resolves this dependency from.
 *
 * The declared directory is not the answer, and the difference IS the defect: pnpm copies a `file:` dependency into
 * `node_modules/.pnpm/...` at INSTALL time, so a package imported before its `dist/` existed leaves a store copy with
 * no output while the source tree has it. Measured in CI (run 42463460197): this gate reported `0 violations` reading
 * the source tree at 08:36:11, and `pnpm --dir host build:test` failed one second later with 32 `TS2307`, because the
 * compile resolves through `host/node_modules`. So both are read - the source tree answers "was it built", the
 * installed path answers "can the consumer see it".
 */
function installedPath(declaringDirectory, name) {
  const candidate = join(declaringDirectory, "node_modules", ...name.split("/"));
  return existsSync(candidate) ? candidate : null;
}

/**
 * The gate. `root` is the workspace root; both derivations above start there.
 */
export function checkVendorBuildArtifacts({ root = REPOSITORY_ROOT } = {}) {
  const violations = [];
  const dependencies = fileDependencies(root);
  let examined = 0;
  let files = 0;

  for (const dependency of dependencies) {
    const packageDirectory = dependency.target;
    const manifestPath = join(packageDirectory, "package.json");
    if (!existsSync(manifestPath)) {
      violations.push({
        code: `vendor_artifact_package_missing:${dependency.name}`,
        dependency: dependency.name,
        declaredBy: dependency.declaredBy,
        expected: manifestPath,
        produce: `check that ${relative(root, packageDirectory).split(sep).join("/")} exists (a git submodule: \`git submodule update --init\`)`,
      });
      continue;
    }
    examined += 1;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      violations.push({
        code: `vendor_artifact_package_unreadable:${dependency.name}`,
        dependency: dependency.name,
        declaredBy: dependency.declaredBy,
        expected: manifestPath,
        produce: "the package.json is not valid JSON",
      });
      continue;
    }
    const promised = promisedFiles(manifest, packageDirectory);
    const escapes = new Set();
    if (promised.length === 0) {
      violations.push({
        code: `vendor_artifact_no_exports:${dependency.name}`,
        dependency: dependency.name,
        declaredBy: dependency.declaredBy,
        expected: manifestPath,
        produce: "the package declares no exports, so nothing it offers can be verified",
      });
      continue;
    }
    for (const promise of promised) {
      files += 1;
      const inside = relative(packageDirectory, promise.absolute);
      if (inside.startsWith("..") || resolve(packageDirectory, inside) !== promise.absolute) {
        // Outside its own package: named once, and not followed under the consumer either - the same fact twice
        // would read as two defects.
        escapes.add(promise);
        violations.push({
          code: `vendor_artifact_target_outside:${dependency.name}:${promise.subpath}:${promise.file}`,
          dependency: dependency.name,
          declaredBy: dependency.declaredBy,
          expected: promise.absolute,
          produce: "the export points outside its own package; that path is not this gate's to resolve",
        });
        continue;
      }
      const exists = existsSync(promise.absolute);
      const size = exists ? statSync(promise.absolute).size : 0;
      if (!exists || size === 0) {
        violations.push({
          code: `vendor_artifact_missing:${dependency.name}:${promise.subpath}:${promise.file}`,
          dependency: dependency.name,
          declaredBy: dependency.declaredBy,
          expected: promise.absolute,
          produce:
            dependency.name === "@gamebuddy/voice-protocol"
              ? "pnpm --dir vendor/pi-koe install --frozen-lockfile && pnpm run build --dir vendor/pi-koe/packages/voice-protocol"
              : "node tools/build-magic-context.mjs",
        });
      }
    }

    // The source tree can be complete while the consumer still cannot see it: the installed path is what the compiler
    // reads, and pnpm populates it at install time. One `not_installed` per consumer, then one `unresolvable` per
    // promised path that the installed copy lacks.
    for (const consumer of dependency.declaring) {
      const installed = installedPath(consumer.directory, dependency.name);
      if (installed === null) {
        violations.push({
          code: `vendor_artifact_not_installed:${consumer.manifest}:${dependency.name}`,
          dependency: dependency.name,
          declaredBy: [consumer.manifest],
          expected: join(consumer.directory, "node_modules", ...dependency.name.split("/")),
          produce: "pnpm install --frozen-lockfile (the dependency was built but never linked for this consumer)",
        });
        continue;
      }
      for (const promise of promised) {
        if (escapes.has(promise)) continue;
        const installedFile = join(installed, promise.file);
        const installedExists = existsSync(installedFile);
        const installedSize = installedExists ? statSync(installedFile).size : 0;
        if (installedExists && installedSize > 0) continue;
        violations.push({
          code:
            `vendor_artifact_unresolvable:${consumer.manifest}:${dependency.name}:` +
            `${promise.subpath}:${promise.file}`,
          dependency: dependency.name,
          declaredBy: [consumer.manifest],
          expected: installedFile,
          produce:
            `the output exists under ${relative(root, packageDirectory).split(sep).join("/")} but not under the copy ` +
            "the consumer resolves: install after the build (`pnpm install --force`)",
        });
      }
    }
  }

  const status = examined === 0 ? "blocked" : violations.length === 0 ? "passed" : "failed";
  return { gate: "vendor-build-artifacts", examined, files, violations, status };
}

function report(result, out = process.stdout, err = process.stderr) {
  for (const violation of result.violations) {
    err.write(`${violation.code}\n`);
    err.write(`  expected: ${violation.expected}\n`);
    err.write(`  declared by: ${violation.declaredBy.join(", ")}\n`);
    err.write(`  produce it with: ${violation.produce}\n`);
  }
  err.write(
    `vendor_artifacts: examined ${result.examined} file: dependencies, ${result.files} promised path(s), ` +
      `${result.violations.length} violation(s)\n`,
  );
  out.write(`${JSON.stringify(result)}\n`);
  return result.status === "passed" ? 0 : 1;
}

function argumentAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = argumentAfter(process.argv.slice(2), "--root") ?? REPOSITORY_ROOT;
  process.exitCode = report(checkVendorBuildArtifacts({ root }));
}
