/**
 * Which `host/src` files count as *production* sources.
 *
 * The authority is `host/tsconfig.json`, whose `include`/`exclude` decide what the Host actually
 * ships. This module mirrors that predicate for gates that read the tree as text, so a gate's file
 * set cannot drift from the compiler's. Update both together.
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * True for a shipped `.ts` source. Tests, test support, fixtures and fixture workers are not
 * shipped, so a gate about shipped behaviour has nothing to say about them.
 */
export function isProductionSource(relativePath) {
  const normalized = relativePath.split(sep).join("/");
  if (!normalized.endsWith(".ts") || normalized.endsWith(".d.ts")) return false;
  if (/\.test\.ts$/u.test(normalized)) return false;
  if (/\.test-support\.ts$/u.test(normalized)) return false;
  if (/\.test-fixtures\.ts$/u.test(normalized)) return false;
  if (/fixture-worker\.ts$/u.test(normalized)) return false;
  if (/(?:^|\/)test-fixtures\//u.test(normalized)) return false;
  return true;
}

/** True for a committed `*.test.ts` file, including `*.internal.test.ts`. */
export function isTestSource(relativePath) {
  const normalized = relativePath.split(sep).join("/");
  return normalized.endsWith(".test.ts") && !normalized.endsWith(".d.ts");
}

/** Every `.ts` file under `root`, sorted by path. */
export function listSources(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
    }
  };
  walk(root);
  files.sort();
  return files;
}

/** `root`-relative, forward-slashed path of a file under `root`. */
export function sourcePath(root, file) {
  return relative(root, file).split(sep).join("/");
}
