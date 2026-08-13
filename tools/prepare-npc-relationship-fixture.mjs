import { prepareFixtureProfile } from "./lib/stardew-fixture-profile.mjs";

console.log(
  JSON.stringify(
    await prepareFixtureProfile({
      scenario: "native_npc_relationship_v1",
      backupName: "npc-relationship-fixture-backup",
      experimentalActions: ["npc_relationship"],
    }),
  ),
);
