/**
 * The repository root, discovered from a file's own location by walking up to the nearest ancestor that holds BOTH
 * `package.json` and `integrations/`.
 *
 * WHY (measured 2026-11-22). The 287-script move from `tools/` to `gates/<domain>/` left every gate that climbed a
 * fixed number of `..` from `import.meta.url` one directory short: the root became `gates/`, so
 * `integrations/stardew/GameBuddy.Stardew.csproj` resolved to `gates/integrations/...` and the gate reported that it
 * could read nothing. A reading of zero is not a verdict - `tools/prelive.mjs` stopped at l0 with 23 of its 43 members
 * red or blocked, and the members that passed did so over a population they had lost. Depth is a fact about the tree,
 * so the tree answers it; arithmetic on `import.meta.url` only records where one file happened to sit the day it was
 * written.
 *
 * It fails closed: a file that is not inside a checkout throws `repository_root_not_found` rather than returning a
 * directory that happens to exist and reading nothing from it.
 *
 * `from` is the caller's own `import.meta.url` (or a directory), so the anchor is the file asking rather than this
 * module's position - a gate that reads another checkout's sources still names its own tree.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function repositoryRoot(from = import.meta.url) {
  let directory = dirname(from.startsWith("file:") ? fileURLToPath(from) : from);
  for (;;) {
    if (existsSync(join(directory, "package.json")) && existsSync(join(directory, "integrations"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository_root_not_found:${directory}`);
    directory = parent;
  }
}
