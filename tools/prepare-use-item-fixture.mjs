import { prepareFixtureProfile } from "./lib/stardew-fixture-profile.mjs";

console.log(JSON.stringify(await prepareFixtureProfile({
  scenario: "native_use_item_v1",
  backupName: "use-item-fixture-backup",
})));
