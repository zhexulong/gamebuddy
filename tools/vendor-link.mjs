#!/usr/bin/env node
/**
 * Symlink the Host's vendored workspace dependencies to their source directories.
 *
 * pnpm `file:` snapshots the package into the store and never re-copies a rebuilt
 * `dist`, so a vendor rebuild is invisible to Host until something forces a
 * reinstall. A junction to the vendor source keeps it live: `bun build` of the
 * vendor immediately updates the declarations Host resolves.
 *
 * Why a symlink (pnpm `link`) instead of `file:`:
 *   - pnpm docs: `file:` hard-links/copies the package into the store and
 *     auto-installs its deps; changing the linked folder does NOT trigger a
 *     reinstall (it is a snapshot).
 *   - `pnpm link`/a junction to the source is a live symlink: vendor `dist`
 *     rebuilds are picked up immediately, matching the dev loop we need.
 *   - Each vendored package keeps its own Bun/pnpm-managed node_modules, which
 *     is what `pnpm link` requires on the "manual dependency installation" side.
 *   - CI keeps the `file:` protocol (reproducible snapshot); this script is for
 *     local development only.
 *
 * Both dependencies are covered, because both fail the same way: the Voice
 * protocol package is vendored too, and a stale store copy of it made Host's
 * `@gamebuddy/voice-protocol` unresolvable after the submodule was re-initialised.
 *
 * Idempotent: a link that already points at its vendor is left untouched;
 * otherwise the existing node_modules entry is replaced.
 */
import { lstat, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LINKS = [
  {
    name: "@cortexkit/pi-magic-context",
    link: path.join(ROOT, "host", "node_modules", "@cortexkit", "pi-magic-context"),
    target: path.join(ROOT, "vendor", "magic-context", "packages", "pi-plugin"),
    build: "bun run --cwd vendor/magic-context/packages/pi-plugin build",
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
      return;
    }
    // Replace whatever is there (a pnpm store snapshot or stale junction).
    await rm(linkPath, { recursive: true, force: true }).catch(() => undefined);
  }

  await symlink(target, linkPath, "junction");
  process.stdout.write(`linked host ${name} -> ${target}\n`);
  process.stdout.write(`next: ensure the vendor dist exists (${build})\n`);
}

for (const entry of LINKS) await link(entry);
