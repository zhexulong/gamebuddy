import { prepareFixtureProfile } from "./lib/stardew-fixture-profile.mjs";

console.log(
  JSON.stringify(
    await prepareFixtureProfile({
      scenario: "native_harvest_crop_v1",
      backupName: "harvest-crop-fixture-backup",
    }),
  ),
);
