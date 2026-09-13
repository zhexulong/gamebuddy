import { fileURLToPath } from "node:url";
import { runReleaseScriptTests } from "./run-tests.mjs";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runReleaseScriptTests().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
