export type DialogueLaunchMode = "fresh" | "known";
export type DialogueLaunchProfile = "reference" | "management";

export type DialogueLaunchOptions = Readonly<{
  tavernNarrativeGateNonceSha256?: string;
}>;

/**
 * Parses the Host process-only dialogue launch mode. Browser state, HTTP
 * requests, environment values, and deployment manifests never participate in
 * this decision.
 */
export function parseDialogueLaunchMode(args: readonly string[]): Readonly<{
  mode: DialogueLaunchMode;
  profile: DialogueLaunchProfile;
  manifestPath?: string;
}> & DialogueLaunchOptions {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string"))
    throw new Error("dialogue_launch_mode_rejected");

  const knownRootRecoveryCount = args.filter((argument) => argument === "--known-root-recovery").length;
  const managementProfileCount = args.filter((argument) => argument === "--tavern-management").length;
  const nonceFlags = args.filter((argument) => argument.startsWith("--tavern-narrative-gate-nonce-sha256="));
  if (
    knownRootRecoveryCount > 1 ||
    managementProfileCount > 1 ||
    nonceFlags.length > 1 ||
    (managementProfileCount === 1 && nonceFlags.length === 1)
  )
    throw new Error("dialogue_launch_mode_rejected");
  const nonce = nonceFlags[0]?.slice("--tavern-narrative-gate-nonce-sha256=".length);
  if (nonce !== undefined && !/^[a-f0-9]{64}$/u.test(nonce)) throw new Error("dialogue_launch_mode_rejected");

  const positional = args.filter(
    (argument) =>
      argument !== "--known-root-recovery" &&
      argument !== "--tavern-management" &&
      !argument.startsWith("--tavern-narrative-gate-nonce-sha256="),
  );
  if (positional.length > 1 || positional.some((argument) => argument.length === 0 || argument.startsWith("--")))
    throw new Error("dialogue_launch_mode_rejected");

  return Object.freeze({
    mode: knownRootRecoveryCount === 1 ? "known" : "fresh",
    profile: managementProfileCount === 1 ? "management" : "reference",
    ...(positional[0] === undefined ? {} : { manifestPath: positional[0] }),
    ...(nonce === undefined ? {} : { tavernNarrativeGateNonceSha256: nonce }),
  });
}
