import { mkdtemp, realpath } from "node:fs/promises";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a disposable fixture beneath a canonical user-owned parent.
 * Durable Host fixtures must not inherit an unverified Windows TEMP ancestry.
 */
function canonicalTestParent(): string {
  const parent = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof parent !== "string" || parent.length === 0) throw new Error("test_local_app_data_unavailable");
  return parent;
}

export async function canonicalTestRoot(prefix: string): Promise<string> {
  return mkdtemp(join(await realpath(canonicalTestParent()), prefix));
}

export function canonicalTestRootSync(prefix: string): string {
  return mkdtempSync(join(realpathSync(canonicalTestParent()), prefix));
}
