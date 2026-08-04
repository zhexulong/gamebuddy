import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { getSynapseLaneIdentity } from "./embedding-synapse";
import { computeNormalizedHash } from "./normalize-hash";

function normalizeEndpoint(endpoint?: string): string {
    return endpoint?.trim().replace(/\/+$/, "") ?? "";
}

/**
 * Stable embedding-provider identity used for provider/pipeline reuse.
 *
 * The API key value is intentionally never hashed or stored. Only key
 * presence participates in identity so switching between anonymous and
 * authenticated modes recreates the provider, while rotating a key does not
 * leak secret material into logs or persisted model ids.
 */
export function getEmbeddingProviderIdentity(config: EmbeddingConfig): string {
    if (config.provider === "off") {
        return "embedding-provider:off";
    }

    if (config.provider === "synapse") {
        const resolved = config as EmbeddingConfig & {
            model?: string;
            synapse_fingerprint?: string;
        };
        if (!resolved.model || !resolved.synapse_fingerprint) return "synapse:v1:pending";
        return getSynapseLaneIdentity(resolved.model, resolved.synapse_fingerprint);
    }

    if (config.provider !== "local" && config.provider !== "openai-compatible") {
        throw new Error("Unknown embedding provider");
    }

    const truncate = config.provider === "openai-compatible" ? config.truncate?.trim() : undefined;
    const identityInput =
        config.provider === "openai-compatible"
            ? {
                  provider: "openai-compatible",
                  model: config.model.trim(),
                  endpoint: normalizeEndpoint(config.endpoint),
                  apiKeyPresent: Boolean(config.api_key?.trim()),
                  // input_type changes the embedding vector space (e.g. NIM
                  // 'query' vs 'passage'), so it participates in identity — a
                  // change must re-embed. truncate changes which text an over-long
                  // input actually embeds, so a change can shift those vectors and
                  // it participates too. (query_input_type shapes only per-call
                  // query requests, never the stored passage vectors, so it stays
                  // out.) truncate is spread CONDITIONALLY: omitting it when unset
                  // keeps the identity byte-identical for the common no-truncate
                  // config, so adding this term does not force a global re-embed —
                  // only configs that actually set truncate get a new identity
                  // (and under per-model coexistence even that just coexists +
                  // lazily GCs, never a destructive wipe).
                  inputType: config.input_type?.trim() || "",
                  ...(truncate ? { truncate } : {}),
              }
            : {
                  provider: "local",
                  model: config.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
                  endpoint: "",
                  apiKeyPresent: false,
              };

    return `embedding-provider:${computeNormalizedHash(JSON.stringify(identityInput))}`;
}
