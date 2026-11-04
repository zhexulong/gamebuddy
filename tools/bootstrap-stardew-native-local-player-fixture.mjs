import { bootstrapNativeLocalPlayerFixture } from "./lib/stardew-native-local-player-fixture.mjs";
import { laneSaveName } from "./lib/stardew-lane-scope.mjs";

const values = parseArguments(process.argv.slice(2));
const root = required(values, "--root");
console.log(
  JSON.stringify(
    await bootstrapNativeLocalPlayerFixture({
      root,
      modsPath: required(values, "--mods-path"),
      releaseDir: required(values, "--release-dir"),
      // Omitted means this lane's own logical name, derived from its fixture root: the slot a bootstrap observes is
      // `<logical>_<nativeId>`, so two lanes bootstrapping the same world no longer share one directory.
      logicalSaveName: laneSaveName({ fixtureRoot: root, saveName: values.get("--logical-save-name") }),
      backupName: required(values, "--backup-name"),
      timeoutSeconds: values.has("--timeout-seconds") ? Number(required(values, "--timeout-seconds")) : undefined,
      action: values.get("--action"),
    }),
  ),
);

function parseArguments(args) {
  if (args.length % 2 !== 0) throw new Error("invalid_native_local_fixture_arguments");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith("--") || values.has(args[index]))
      throw new Error("invalid_native_local_fixture_arguments");
    values.set(args[index], args[index + 1]);
  }
  return values;
}
function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`missing_${name.slice(2)}`);
  return value;
}
