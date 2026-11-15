import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Run `main` only when `moduleUrl` is the process's entry module, and take the exit code from what it returns.
 *
 * This repository spells that guard out in ninety `tools/*.mjs` files, and three gates wrote it directly under
 * their verdict line, which made the pair one clone group: the guard is a statement about the module, not about
 * any one gate's reading, so it is named once here. The comparison is by resolved path, so a relative
 * invocation, an absolute one and a symlink through the same file are the same entry.
 */
export function runAsEntry(moduleUrl, main, argv = process.argv) {
  if (argv[1] === undefined) return;
  if (resolve(argv[1]) !== resolve(fileURLToPath(moduleUrl))) return;
  process.exitCode = main(argv.slice(2));
}
