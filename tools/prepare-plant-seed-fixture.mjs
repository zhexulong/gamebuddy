import { prepareFixtureProfile } from "./lib/stardew-fixture-profile.mjs";

console.log(JSON.stringify(await prepareFixtureProfile({
  scenario: "native_plant_seed_v1",
  backupName: "plant-seed-fixture-backup",
})));
