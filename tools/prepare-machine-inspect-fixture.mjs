import { prepareFixtureProfile } from "./lib/stardew-fixture-profile.mjs";

console.log(
  JSON.stringify(
    await prepareFixtureProfile({
      scenario: "native_machine_inspect_v1",
      backupName: "machine-inspect-fixture-backup",
    }),
  ),
);
