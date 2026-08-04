import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot = resolve(import.meta.dirname, "..", "src");
const indexSource = await readFile(resolve(sourceRoot, "index.ts"), "utf8");

const required = [
  'embeddedRuntime ? undefined : new PiSubagentRunner()',
  'embeddedRuntime ? undefined : new PiSubagentRunner()',
  'embeddedRuntime ? undefined : new PiSubagentRunner()',
  'new EmbeddedPiHistorianRunner()',
  'forbidExternalPiCli: process.env.GAMEBUDDY_EMBEDDED_RUNTIME === "1"',
];
for (const fragment of required) {
  if (!indexSource.includes(fragment)) {
    throw new Error(`missing GameBuddy embedded boundary: ${fragment}`);
  }
}

console.log(JSON.stringify({
  state: "passed",
  cliBackedAdminRunners: "disabled-in-embedded-mode",
  historianRunner: "embedded-sdk-only",
  externalPiCli: "forbidden-in-embedded-mode",
}));
