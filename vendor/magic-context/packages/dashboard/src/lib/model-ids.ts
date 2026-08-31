/**
 * Shared config stores OpenCode's canonical provider IDs, while Pi discovers
 * two providers under harness-specific names.
 */
const CANONICAL_TO_PI_PROVIDER: Record<string, string> = {
  openai: "openai-codex",
  google: "google-antigravity",
};

const PI_TO_CANONICAL_PROVIDER: Record<string, string> = {
  "openai-codex": "openai",
  "google-antigravity": "google",
};

function remapProviderPrefix(modelId: string, providerMap: Record<string, string>): string {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return modelId;

  const provider = modelId.slice(0, slash);
  const mappedProvider = providerMap[provider];
  return mappedProvider ? `${mappedProvider}${modelId.slice(slash)}` : modelId;
}

/** Convert a Pi-discovered model ID into the canonical ID stored in shared config. */
export function piModelIdToCanonical(modelId: string): string {
  return remapProviderPrefix(modelId, PI_TO_CANONICAL_PROVIDER);
}

/** Convert a canonical shared-config model ID into Pi's provider naming. */
export function canonicalModelIdToPi(modelId: string): string {
  return remapProviderPrefix(modelId, CANONICAL_TO_PI_PROVIDER);
}
