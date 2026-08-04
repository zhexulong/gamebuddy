import { inspectFixtureTransaction } from "./lib/stardew-fixture-profile.mjs";

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--backup-name" || !args[1])) {
  throw new Error("usage: [--backup-name <name>]");
}

const value = await inspectFixtureTransaction(args.length === 0 ? {} : { backupName: args[1] });
console.log(JSON.stringify(value));
