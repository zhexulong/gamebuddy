import { restoreFixtureProfile } from "./lib/stardew-fixture-profile.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--backup-name" || !args[1]) throw new Error("usage: --backup-name <name>");
console.log(JSON.stringify(await restoreFixtureProfile({ backupName: args[1] })));
