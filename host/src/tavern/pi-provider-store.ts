import { readStrictJsonFile } from "../strict-json-reader.js";
import { atomicWriteFile } from "../path-lock.js";
import type { CompanionModelConfig } from "../runtime-identity.js";
import { connectionDocumentPath } from "./connection-store.js";
import {
  catalogModel,
  catalogProvider,
  isTavernPiApi,
  type TavernModelReasoningDialect,
  type TavernPiApi,
  TAVERN_ENVIRONMENT_PROVIDER_ID,
} from "./provider-catalog.js";

/**
 * The exact `models.json` provider entry one runtime selection contributes to
 * the embedded Pi runtime's own provider store.
 *
 * `models.json` is Pi's file and more than one runtime identity, provider and
 * player connection writes it over a Host lifetime, so a runtime construction
 * *merges* its provider entry into the document instead of replacing it: an
 * entry Pi or a previously selected connection put there must not be lost
 * because a later runtime started for another model.
 *
 * Three cases, in order of precedence:
 *
 * - the operator environment selection (`cpa-oai`) keeps the frozen entry this
 *   Host has always written, byte for byte, so a root with no player
 *   connection produces exactly the previous document;
 * - another catalog provider pins its Host-owned endpoint and API shape, and
 *   deliberately contributes no `models` list: the model middleware already
 *   ships full metadata for those model ids, and replacing that with a minimal
 *   description would degrade the model the player selected;
 * - the endpoint escape hatch is the one entry whose endpoint, API shape and
 *   model id the player supplied, so it must describe its model locally and
 *   carry the exact API shape that endpoint speaks.
 *
 * The credential is never written here. API keys go to `auth.json`, which Pi
 * resolves first, so `models.json` carries endpoint and model description only.
 */

export type PiProviderEntry = Readonly<Record<string, unknown>>;

/**
 * The reasoning dialect the environment model is declared with. It is read from
 * the model's catalog entry, never from its name: a player-typed model id the
 * catalog does not describe keeps the neutral dialect, so a non-catalog model
 * still gets a reasoning mapping instead of silently losing one (design/28
 * §2.3.1).
 */
function environmentReasoningDialect(modelId: string): TavernModelReasoningDialect {
  const provider = catalogProvider(TAVERN_ENVIRONMENT_PROVIDER_ID);
  return provider === null ? "native" : (catalogModel(provider, modelId)?.reasoningDialect ?? "native");
}

/** The frozen operator-managed Agent provider entry (zero-configuration default). */
export function environmentProviderEntry(modelId: string): PiProviderEntry {
  const reasoningDialect = environmentReasoningDialect(modelId);
  return {
    name: "CPA OpenAI-compatible Agent",
    baseUrl: "http://127.0.0.1:8317/v1",
    api: "openai-completions",
    apiKey: "$CPA_OAI_API_KEY",
    authHeader: true,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
    },
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: true,
        // The configured CPA route is used with ordinary native `tools`; Pi
        // does not emit forced OpenAI `tool_choice` for this surface.
        thinkingLevelMap: reasoningDialect === "deepseek"
          ? {
              off: "none",
              minimal: "low",
              low: "low",
              medium: "high",
              high: "high",
              xhigh: "high",
              max: "max",
            }
          : {
              off: "none",
              minimal: "low",
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
              max: "max",
            },
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        cost: {
          input: 0.14,
          output: 0.28,
          cacheRead: 0.0028,
          cacheWrite: 0.14,
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
          supportsStrictMode: true,
          ...(reasoningDialect === "deepseek"
            ? {
                thinkingFormat: "deepseek",
                requiresReasoningContentOnAssistantMessages: true,
              }
            : {}),
        },
      },
    ],
  };
}

export type ModelProviderEntry = Readonly<{ providerId: string; entry: PiProviderEntry }>;

/**
 * The provider entry one runtime selection contributes. Returns null when the
 * selection names no catalog provider, which the caller treats as "the
 * runtime's own model availability check will fail closed".
 */
export async function modelProviderEntry(
  agentDir: string,
  config: CompanionModelConfig,
): Promise<ModelProviderEntry | null> {
  if (config.provider === TAVERN_ENVIRONMENT_PROVIDER_ID)
    return Object.freeze({ providerId: TAVERN_ENVIRONMENT_PROVIDER_ID, entry: environmentProviderEntry(config.modelId) });
  const provider = catalogProvider(config.provider);
  if (provider === null) return null;
  const selection =
    provider.baseUrl === null ? await storedEscapeHatchSelection(agentDir, provider.providerId, config.modelId) : null;
  const baseUrl = provider.baseUrl ?? selection?.baseUrl ?? null;
  if (baseUrl === null) return null;
  const api = provider.piApi ?? selection?.apiShape ?? null;
  if (api === null) return null;
  return Object.freeze({
    providerId: provider.piProviderId,
    entry: {
      name: provider.label,
      baseUrl,
      api,
      ...(provider.authHeader ? { authHeader: true } : {}),
      // A catalog provider's model metadata already ships with Pi; only the one
      // entry whose model the player named has to describe it here.
      ...(provider.baseUrl === null ? { models: [{ id: config.modelId, name: config.modelId }] } : {}),
    },
  });
}

/**
 * The endpoint and API shape a player typed for this exact provider/model, or
 * null. Both facts come from the same record, so an entry can never pair one
 * player's endpoint with another player's API shape; a record whose shape is
 * not one Pi speaks yields null and the runtime fails closed rather than
 * handing Pi an API id it has no adapter for.
 */
async function storedEscapeHatchSelection(
  agentDir: string,
  providerId: string,
  modelId: string,
): Promise<Readonly<{ baseUrl: string; apiShape: TavernPiApi }> | null> {
  let document: unknown;
  try {
    document = await readStrictJsonFile(connectionDocumentPath(agentDir));
  } catch {
    // Absent or unreadable: the caller reports an unavailable selection rather
    // than inventing an endpoint.
    return null;
  }
  if (typeof document !== "object" || document === null) return null;
  const connections = (document as { readonly connections?: unknown }).connections;
  if (!Array.isArray(connections)) return null;
  const match = connections.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { readonly providerId?: unknown }).providerId === providerId &&
      (entry as { readonly modelId?: unknown }).modelId === modelId &&
      typeof (entry as { readonly baseUrl?: unknown }).baseUrl === "string",
  );
  if (match === undefined) return null;
  const record = match as { readonly baseUrl: string; readonly apiShape?: unknown };
  return isTavernPiApi(record.apiShape) ? { baseUrl: record.baseUrl, apiShape: record.apiShape } : null;
}

/**
 * Writes one provider entry into Pi's own `models.json`, preserving every other
 * provider entry the document already holds.
 *
 * This is the merge the runtime construction calls: replacing the whole
 * document would delete the entries of every other writer (a sibling runtime, a
 * previously selected connection, or Pi itself), while a root that holds no
 * other entry serializes exactly as the previous single-provider document did.
 */
export async function mergeModelProviderEntry(
  modelsPath: string,
  providerId: string,
  entry: PiProviderEntry,
): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const document = await readStrictJsonFile(modelsPath);
    if (typeof document === "object" && document !== null && !Array.isArray(document)) {
      const providers = (document as { readonly providers?: unknown }).providers;
      if (typeof providers === "object" && providers !== null && !Array.isArray(providers))
        existing = providers as Record<string, unknown>;
    }
  } catch (error) {
    // An absent file is the first-run case. A malformed file is not a licence to
    // guess: it is replaced by the entry this runtime owns, which is what the
    // previous unconditional write did in every case.
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) existing = {};
  }
  await atomicWriteFile(modelsPath, JSON.stringify({ providers: { ...existing, [providerId]: entry } }, null, 2));
}
