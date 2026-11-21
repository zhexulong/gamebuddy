import { readFileSync } from "node:fs";

/**
 * The Mod bundle's file names, read from the manifest the build owns.
 *
 * The Host's test and test-support files build a package directory before a deployment or a recovery run, and each
 * spelled the four names itself. They are the build's output, not a Host fact: `integrations/stardew/bundle.manifest.json`
 * is the list, `tools/check-stardew-bundle-manifest.mjs` holds it to the project's declared outputs, and the tool-side
 * reader is `tools/lib/stardew-mod-bundle.mjs`. Two readers of one artifact - the Host cannot import a `.mjs` from
 * `tools/` without crossing a package boundary, and `tools/` cannot import TypeScript - and no second list.
 */
export const MOD_BUNDLE_MANIFEST_PATH = "integrations/stardew/bundle.manifest.json";

const MANIFEST_SCHEMA = "gamebuddy-stardew-mod-bundle/v1";
const BUILD = "integrations/stardew/GameBuddy.Stardew.csproj";

function readBundleFileNames(): readonly string[] {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL(`../../${MOD_BUNDLE_MANIFEST_PATH}`, import.meta.url), "utf8"),
  );
  if (typeof manifest !== "object" || manifest === null) throw new Error("stardew_bundle_manifest_invalid");
  const record = manifest as Record<string, unknown>;
  if (record.schema !== MANIFEST_SCHEMA) throw new Error(`stardew_bundle_manifest_schema:${String(record.schema)}`);
  if (record.build !== BUILD) throw new Error(`stardew_bundle_manifest_build:${String(record.build)}`);
  const files = record.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error("stardew_bundle_manifest_files_missing");
  if (!files.every((file: unknown): file is string => typeof file === "string" && file.length > 0)) {
    throw new Error("stardew_bundle_manifest_files_invalid");
  }
  if (new Set(files).size !== files.length) throw new Error("stardew_bundle_manifest_files_duplicated");
  return files;
}

/** The bundle's file names, in the order the Host installs them (`manifest.json` last: see `tools/lib/stardew-mod-bundle.mjs`). */
export const MOD_BUNDLE_FILE_NAMES: readonly string[] = Object.freeze(readBundleFileNames());
