import { prepareFixtureProfile } from "./lib/stardew-fixture-profile.mjs";

console.log(JSON.stringify(await prepareFixtureProfile({
  scenario: "native_pickup_forage_v1",
  backupName: "pickup-forage-fixture-backup",
})));
