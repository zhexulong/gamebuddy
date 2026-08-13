import { prepareFixtureProfile } from "./lib/stardew-fixture-profile.mjs";

console.log(
  JSON.stringify(
    await prepareFixtureProfile({
      scenario: "native_pickup_item_v1",
      backupName: "pickup-item-fixture-backup",
    }),
  ),
);
