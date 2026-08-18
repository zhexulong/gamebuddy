import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// External static imports may select an exported subpath (for example
// `typebox/compile`). Keep the probe grammar package-like and reject absolute,
// traversal, query, and URL-style specifiers before Node resolves anything.
const packageSpecifier = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;
const [hostRoot, ...specifiers] = process.argv.slice(2);
if (typeof hostRoot !== "string" || !isAbsolute(hostRoot) || specifiers.length === 0 || specifiers.some((specifier) => !packageSpecifier.test(specifier))) {
  process.exitCode = 64;
} else {
  const parentURL = pathToFileURL(resolve(hostRoot, "package.json")).href;
  const resolved = specifiers.map((specifier) => [specifier, import.meta.resolve(specifier, parentURL)]);
  process.stdout.write(JSON.stringify({ schema: "gamebuddy-production-esm-resolution/v1", resolved }));
}
