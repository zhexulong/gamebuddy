import { prepareFixtureProfile } from "./lib/stardew-fixture-profile.mjs";

console.log(
  JSON.stringify(
    await prepareFixtureProfile({
      scenario: "native_till_soil_v1",
      backupName: "till-soil-fixture-backup",
    }),
  ),
);
