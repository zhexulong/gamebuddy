#!/usr/bin/env node
/**
 * Link the vendored Voice protocol package to its source directory.
 *
 * **The Magic Context entry refuses, and that is the point of this file's state today.** A junction to
 * `vendor/magic-context/packages/pi-plugin` makes `realpath()` of the declared dependency escape the
 * repository's `node_modules`, and the Host requires the opposite: `host/scripts/sync-declared-magic-context-artifact.mjs`
 * refuses to run (`magic_context_declared_package_outside_repository_node_modules`) and two suites assert that
 * the runtime resolves the Host-declared package (`runtime.test.ts`: "runtime resolves Magic Context from the
 * Host-declared package dependency", "does not resolve into vendor"). A live link to the vendor source
 * therefore does not trade a small staleness cost for convenience - it puts the runtime on a package the
 * product's own guards reject, and it hides that until a suite fails on a machine someone else is using.
 *
 * The supported loop for that package is a rebuild plus the sync that copies the built `dist` into the
 * declared package:
 *   bun run --cwd vendor/magic-context/packages/pi-plugin build
 *   node host/scripts/sync-declared-magic-context-artifact.mjs
 *
 * Voice protocol has no such invariant (nothing asserts its containment), so its link stays: pnpm's
 * `file:` protocol snapshots the package into the store and never re-copies a rebuilt `dist`, and a
 * junction to the vendor source keeps the declarations Host resolves live.
 *
 * Idempotent: a link that already points at its vendor is left untouched; otherwise the existing
 * node_modules entry is replaced.
 */
import { lstat, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LINKS = [
  {
    name: "@cortexkit/pi-magic-context",
    refused: [
      "refusing to link @cortexkit/pi-magic-context to vendor/: the Host requires the declared package",
      "inside the repository's node_modules, and the runtime suites assert it does not resolve into vendor.",
      "Use the supported refresh instead:",
      "  bun run --cwd vendor/magic-context/packages/pi-plugin build",
      "  node host/scripts/sync-declared-magic-context-artifact.mjs",
    ].join("\n"),
  },
  {
    name: "@gamebuddy/voice-protocol",
    link: path.join(ROOT, "host", "node_modules", "@gamebuddy", "voice-protocol"),
    target: path.join(ROOT, "vendor", "pi-koe", "packages", "voice-protocol"),
    build: "pnpm --dir vendor/pi-koe/packages/voice-protocol build",
  },
];

async function link({ name, link: linkPath, target: targetDir, build }) {
  const target = path.resolve(targetDir);
  let existing = null;
  try {
    const st = await lstat(linkPath);
    if (st.isSymbolicLink() || st.isDirectory() || st.isFile()) {
      existing = (await readlink(linkPath).catch(() => null)) ?? path.resolve(linkPath);
    }
  } catch {
    // No existing entry.
  }

  if (existing !== null) {
    if (path.resolve(existing) === target) {
      process.stdout.write(`vendor link already points at ${target}\n`);
      return false;
    }
    // Replace whatever is there (a pnpm store snapshot or stale junction).
    await rm(linkPath, { recursive: true, force: true }).catch(() => undefined);
  }

  await symlink(target, linkPath, "junction");
  process.stdout.write(`linked host ${name} -> ${target}\n`);
  process.stdout.write(`next: ensure the vendor dist exists (${build})\n`);
  return false;
}

let refused = false;
for (const entry of LINKS) {
  if (entry.refused !== undefined) {
    process.stderr.write(`${entry.refused}\n`);
    refused = true;
    continue;
  }
  await link(entry);
}
// Non-zero because the run did not do what it was asked for: a warning would be read once and then
// ignored, and the next person to run it by habit would silently put the runtime on the vendor tree.
if (refused) process.exitCode = 1;
