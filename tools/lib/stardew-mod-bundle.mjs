/**
 * The files that make up one deployed Mod, read from the manifest the build owns.
 *
 * WHY (measured 2026-11-21). Ten declarations in two languages spelled the same four file names: the fixture, the
 * isolation check, the topology preflight, the provisioner, two of their suites, and three Host test/test-support
 * files. Nothing compared them, so nothing could notice that the set is not ours to decide: it is the BUILD's output
 * (`integrations/stardew/GameBuddy.Stardew.csproj` - its assembly, its referenced assembly, the SMAPI `manifest.json`
 * it copies, the dependency file it emits). A build that renamed an output would leave all ten wrong in the same way,
 * and the first symptom would be a fixture that deploys four files SMAPI cannot load.
 *
 * So the set lives in `integrations/stardew/bundle.manifest.json`, beside the project that produces it, and every
 * consumer READS it. `tools/check-stardew-bundle-manifest.mjs` holds that manifest to the project's own declared
 * outputs, naming the member that drifted.
 */
import { readFileSync } from "node:fs";

/** The manifest's path, tree-relative: the one spelling a report and a reader both use. */
export const STARDEW_BUNDLE_MANIFEST_PATH = "integrations/stardew/bundle.manifest.json";

/** The build a bundle belongs to. Named here so a second Mod's manifest cannot be read by mistake. */
export const STARDEW_BUNDLE_BUILD = "integrations/stardew/GameBuddy.Stardew.csproj";

const MANIFEST_SCHEMA = "gamebuddy-stardew-mod-bundle/v1";

function readManifest() {
  const parsed = JSON.parse(readFileSync(new URL(`../../${STARDEW_BUNDLE_MANIFEST_PATH}`, import.meta.url), "utf8"));
  if (parsed.schema !== MANIFEST_SCHEMA) throw new Error(`stardew_bundle_manifest_schema:${String(parsed.schema)}`);
  if (parsed.build !== STARDEW_BUNDLE_BUILD) throw new Error(`stardew_bundle_manifest_build:${String(parsed.build)}`);
  const files = parsed.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error("stardew_bundle_manifest_files_missing");
  if (!files.every((file) => typeof file === "string" && file.length > 0 && !file.includes("/"))) {
    throw new Error("stardew_bundle_manifest_files_invalid");
  }
  if (new Set(files).size !== files.length) throw new Error("stardew_bundle_manifest_files_duplicated");
  return files;
}

/**
 * The bundle's file names, in the order the Host installs them.
 *
 * The order is a fact, not a formatting choice: `manifest.json` is last, so an install interrupted before it is not a
 * loadable Mod directory (`host/src/stardew-game-install/deployment.ts`, and the deployment suite drives that shape).
 */
export const MOD_BUNDLE_FILE_NAMES = Object.freeze(readManifest());
