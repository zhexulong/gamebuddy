import { restoreNativeLocalPlayerFixture } from "./lib/stardew-native-local-player-fixture.mjs";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || values.has(key)) throw new Error("invalid_native_local_fixture_arguments");
  values.set(key, value);
}
if (process.argv.length !== 10) throw new Error("invalid_native_local_fixture_arguments");
const required = (name) => {
  const value = values.get(name);
  if (!value) throw new Error(`missing_${name.slice(2)}`);
  return value;
};
console.log(
  JSON.stringify(
    await restoreNativeLocalPlayerFixture({
      root: required("--root"),
      modsPath: required("--mods-path"),
      releaseDir: required("--release-dir"),
      backupName: required("--backup-name"),
    }),
  ),
);
