import { readFile, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { applyFixtureBridgeOverride } from "./lib/stardew-fixture-profile.mjs";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--backup-name" || args[2] !== "--override-file")
  throw new Error("fixture_bridge_override_usage");
const [backupName, overrideFile] = [args[1], args[3]];
if (!isAbsolute(overrideFile)) throw new Error("invalid_fixture_bridge_override_file");
try {
  const override = JSON.parse(await readFile(resolve(overrideFile), "utf8"));
  await applyFixtureBridgeOverride({ backupName, bridgeOverride: override });
  // Never echo bridge credentials or scope values.
  console.log(JSON.stringify({ state: "fixture_bridge_override_applied" }));
} finally {
  await rm(resolve(overrideFile), { force: true }).catch(() => {});
}
