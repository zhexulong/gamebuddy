import { inspectFixtureTransaction } from "./lib/stardew-fixture-profile.mjs";

const args = process.argv.slice(2);
if (args.length !== 0) throw new Error("usage: no_arguments");
console.log(JSON.stringify(await inspectFixtureTransaction()));
