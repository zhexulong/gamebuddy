import { FIXTURE_SCENARIOS, prepareFixtureProfile } from "./lib/stardew-fixture-profile.mjs";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined || values.has(key))
    throw new Error("invalid_fixture_profile_arguments");
  values.set(key, value);
}
const required = (name) => {
  const value = values.get(name);
  if (!value) throw new Error(`missing_${name.slice(2)}`);
  return value;
};
const scenario = required("--scenario");
if (!FIXTURE_SCENARIOS.includes(scenario)) throw new Error(`fixture_scenario_not_allowlisted:${scenario}`);
const backupName = required("--backup-name");
const targetSave = values.get("--target-save");
const experimental = values.get("--experimental-actions");
const requireFixtureLiveLocale = values.get("--require-fixture-live-locale");
if (
  [...values.keys()].some(
    (key) =>
      ![
        "--scenario",
        "--backup-name",
        "--target-save",
        "--experimental-actions",
        "--require-fixture-live-locale",
      ].includes(key),
  )
)
  throw new Error("unknown_fixture_profile_argument");
const experimentalActions = experimental === undefined || experimental.length === 0 ? [] : experimental.split(",");
if (
  requireFixtureLiveLocale !== undefined &&
  requireFixtureLiveLocale !== "zh-CN" &&
  requireFixtureLiveLocale !== "en-US"
)
  throw new Error("invalid_fixture_live_locale_requirement");
console.log(
  JSON.stringify(
    await prepareFixtureProfile({ scenario, backupName, targetSave, experimentalActions, requireFixtureLiveLocale }),
  ),
);
