import { access, lstat } from "node:fs/promises";

export type LegacyAuthoritySealInspection = Readonly<{
  claimed: false;
  reason: "no_trustworthy_no_writer_proof";
}>;

/**
 * Inspects the candidate root but deliberately refuses to install or claim an
 * ACL-based seal. A same-user unprivileged process has no race-free,
 * trustworthy proof that no writer handle already exists (or will be opened).
 */
export async function inspectLegacyAuthoritySealCandidate(root: string): Promise<LegacyAuthoritySealInspection> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("legacy authority seal candidate must be an exact non-reparse directory");
  }
  await access(root);
  return { claimed: false, reason: "no_trustworthy_no_writer_proof" };
}
