import { restoreNativeLocalPlayerFixture } from "./lib/stardew-native-local-player-fixture.mjs";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!(key?.startsWith("--") && value && !values.has(key))) throw new Error("invalid_native_local_fixture_arguments");
  values.set(key, value);
}
if (process.argv.length !== 10) throw new Error("invalid_native_local_fixture_arguments");
const required = (name) => {
  const value = values.get(name);
  if (!value) throw new Error(`missing_${name.slice(2)}`);
  return value;
};
// An absent flag is an answer, not an error: a caller with no evidence bundle still restores, and the
// fixture records `archived: false, reason: no_bundle_path` rather than guessing where a copy should go.
const optional = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
try {
  process.stdout.write(
    `${JSON.stringify(
      await restoreNativeLocalPlayerFixture({
        root: required("--root"),
        modsPath: required("--mods-path"),
        releaseDir: required("--release-dir"),
        backupName: required("--backup-name"),
        evidenceDir: optional("--evidence-dir"),
      }),
    )}\n`,
  );
} catch (error) {
  // Same contract as prepare: a refusal is a named outcome, not a stack.
  const reasonCode = error instanceof Error ? error.message : String(error);
  process.stderr.write(`restore_refused:${reasonCode}\n`);
  process.exitCode = 1;
}
