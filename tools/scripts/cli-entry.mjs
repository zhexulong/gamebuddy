import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * One gate's entry point: `main` becomes this process's exit code, but only when this module is the program the process
 * started.
 *
 * The guard is `process.argv[1]` against `import.meta.url` because every gate here is also imported by its own suite,
 * where running `main` on import would be a side effect the suite cannot opt out of. A thrown error becomes exit 2 with
 * its message on stderr, so a gate that crashes can never read as passed. `main` may be synchronous or asynchronous:
 * both are awaited, and `process.exitCode` carries the verdict either way.
 */
export async function runWhenEntry(moduleUrl, main) {
  if (process.argv[1] === undefined || resolve(process.argv[1]) !== fileURLToPath(moduleUrl)) return;
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
