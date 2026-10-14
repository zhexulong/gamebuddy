/**
 * The one place that resolves the Stardew decompiled game-source root.
 *
 * The tree under `ref/external/StardewValleyDecompiled` is gitignored (`.gitignore`: `/ref/`),
 * so a fresh checkout, a cleaned workspace or a re-imaged machine does not have it. Every gate
 * and deriver that resolves a `File.cs:line` citation into game source walks that tree; a walk
 * over a missing tree returns an empty list, and an empty list prints as "0 findings" —
 * indistinguishable from "clean", which is the one answer that must never be wrong.
 *
 * So this resolver FAILS CLOSED: an absent or empty root throws, naming the exact absolute path
 * it looked for and how to restore it. It never returns a root that does not exist, so no
 * caller can silently scan nothing.
 *
 * The canonical location is `ref/external/StardewValleyDecompiled/Stardew Valley` — the
 * directory every citation in this repository is written against. A caller that owns a
 * different layout (for example the parent `ref/external/StardewValleyDecompiled`, whose
 * recursive walk still finds the sources) passes it as `root`; the same verification applies.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Environment override for the tree location. An explicit `root` argument still wins. */
export const STARDEW_DECOMPILE_ROOT_ENV = "GAMEBUDDY_STARDEW_DECOMPILE_ROOT";

/** Canonical location, relative to the repository root. */
export const STARDEW_DECOMPILE_ROOT_RELATIVE_PATH = "ref/external/StardewValleyDecompiled/Stardew Valley";

/** The decompiler build the checked-in citations were derived with. */
export const STARDEW_DECOMPILER_VERSION = "ilspycmd: 9.1.0.7988";

/** The stable failure code every consumer's message is prefixed with. */
const STARDEW_DECOMPILE_ROOT_MISSING = "stardew_decompile_root_missing";

/** A bounded walk so a pathological tree cannot hang a gate. */
const MAX_DIRECTORIES_PROBED = 4096;

/** The operator-facing restore recipe, kept in one place so every gate says the same thing. */
function stardewDecompileRootRestoreHint() {
  return (
    "The tree is gitignored (.gitignore: /ref/), so a checkout does not create it. " +
    `Re-decompile the pinned assembly with ${STARDEW_DECOMPILER_VERSION}: ` +
    `ilspycmd -p -o "${STARDEW_DECOMPILE_ROOT_RELATIVE_PATH}" "<Stardew install>/Stardew Valley.dll"`
  );
}

export class StardewDecompileRootMissingError extends Error {
  constructor(root, reason) {
    super(`${root} — ${reason}. ${stardewDecompileRootRestoreHint()}`);
    this.name = "StardewDecompileRootMissingError";
    this.code = STARDEW_DECOMPILE_ROOT_MISSING;
    this.root = root;
  }
}

/**
 * Resolve the decompiled source root and prove it is usable before any caller walks it.
 * An explicit `root` wins over `GAMEBUDDY_STARDEW_DECOMPILE_ROOT`, which wins over the
 * canonical `ref/external/StardewValleyDecompiled/Stardew Valley`. A relative path is
 * resolved against `repositoryRoot` (default: `process.cwd()`).
 */
export function resolveStardewDecompileRoot({ repositoryRoot, root, env = process.env } = {}) {
  const base = repositoryRoot ?? process.cwd();
  const configured = nonEmpty(root) ? root : env?.[STARDEW_DECOMPILE_ROOT_ENV];
  const candidate = nonEmpty(configured)
    ? isAbsolute(configured)
      ? configured
      : resolve(base, configured)
    : join(base, STARDEW_DECOMPILE_ROOT_RELATIVE_PATH);
  return assertStardewDecompileRoot(candidate);
}

/** Throw unless `root` is a directory that holds at least one decompiled `.cs` source file. */
export function assertStardewDecompileRoot(root) {
  if (!nonEmpty(root)) throw new StardewDecompileRootMissingError(String(root), "no path was resolved");
  if (!existsSync(root)) throw new StardewDecompileRootMissingError(root, "the path does not exist");
  if (!statSync(root).isDirectory()) throw new StardewDecompileRootMissingError(root, "the path is not a directory");
  if (!holdsCSharpSource(root)) {
    throw new StardewDecompileRootMissingError(root, "the directory holds no .cs decompiled sources");
  }
  return root;
}

function holdsCSharpSource(root) {
  const stack = [root];
  let probed = 0;
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".cs")) return true;
      if (entry.isDirectory()) stack.push(join(directory, entry.name));
    }
    if (++probed > MAX_DIRECTORIES_PROBED) return false;
  }
  return false;
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}
