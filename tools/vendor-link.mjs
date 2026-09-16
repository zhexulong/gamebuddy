#!/usr/bin/env node
/**
 * Symlink the Host's `@cortexkit/pi-magic-context` dependency to the vendored
 * source directory (pnpm `file:` protocol would snapshot the package into the
 * store and never re-copy a rebuilt `dist`; a symlink keeps the vendored
 * source visible live, so `bun build` of the vendor immediately updates the
 * declarations Host resolves).
 *
 * Why a symlink (pnpm `link`) instead of `file:`:
 *   - pnpm docs: `file:` hard-links/copies the package into the store and
 *     auto-installs its deps; changing the linked folder does NOT trigger a
 *     reinstall (it is a snapshot). 
 *   - `pnpm link`/a junction to the source is a live symlink: vendor `dist`
 *     rebuilds are picked up immediately, matching the dev loop we need.
 *   - The vendored fork keeps its Bun-managed node_modules, so it already
 *     satisfies the "manual dependency installation" side of `pnpm link`.
 *   - CI keeps the `file:` protocol (reproducible snapshot); this script is
 *     for local development only.
 *
 * Idempotent: if the current link already points at the vendor, it is left
 * untouched; otherwise the existing node_modules entry is replaced.
 */
import { lstat, readlink, symlink, unlink, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINK = path.join(ROOT, "host", "node_modules", "@cortexkit", "pi-magic-context");
const TARGET_DIR = path.join(ROOT, "vendor", "magic-context", "packages", "pi-plugin");

async function main() {
  const target = path.resolve(TARGET_DIR);
  let existing = null;
  try {
    const st = await lstat(LINK);
    if (st.isSymbolicLink() || st.isDirectory() || st.isFile()) {
      existing = await readlink(LINK).catch(() => null) ?? path.resolve(LINK);
    }
  } catch {
    // No existing entry.
  }

  if (existing !== null) {
    const existingResolved = path.resolve(existing);
    if (existingResolved === target) {
      process.stdout.write(`vendor link already points at ${target}\n`);
      return;
    }
    // Replace whatever is there (a pnpm store snapshot or stale junction).
    await rm(LINK, { recursive: true, force: true }).catch(() => undefined);
  }

  await symlink(target, LINK, "junction");
  process.stdout.write(`linked host @cortexkit/pi-magic-context -> ${target}\n`);
  process.stdout.write(
    `next: ensure vendor dist exists (bun run --cwd vendor/magic-context/packages/pi-plugin build)\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`vendor-link failed: ${error && error.message ? error.message : String(error)}\n`);
  process.exit(1);
});