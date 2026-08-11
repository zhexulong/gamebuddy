import { bootstrapNativeLocalPlayerFixture } from "./lib/stardew-native-local-player-fixture.mjs";

const values = parseArguments(process.argv.slice(2));
console.log(JSON.stringify(await bootstrapNativeLocalPlayerFixture({
  root: required(values, "--root"),
  modsPath: required(values, "--mods-path"),
  releaseDir: required(values, "--release-dir"),
  logicalSaveName: required(values, "--logical-save-name"),
  backupName: required(values, "--backup-name"),
  timeoutSeconds: values.has("--timeout-seconds") ? Number(required(values, "--timeout-seconds")) : undefined,
  action: values.get("--action"),
})));

function parseArguments(args) {
  if (args.length % 2 !== 0) throw new Error("invalid_native_local_fixture_arguments");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith("--") || values.has(args[index])) throw new Error("invalid_native_local_fixture_arguments");
    values.set(args[index], args[index + 1]);
  }
  return values;
}
function required(values, name) { const value = values.get(name); if (!value) throw new Error(`missing_${name.slice(2)}`); return value; }
