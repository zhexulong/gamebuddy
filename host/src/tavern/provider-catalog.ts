import type { CompanionThinkingLevel } from "../runtime-identity.js";

/**
 * Host-owned provider and model catalog for the player-facing dialogue role
 * (design/28 §1 and §5.1).
 *
 * The browser may only select an entry of this catalog. Exactly one entry is
 * the OpenAI-compatible escape hatch: it is a catalog entry like any other,
 * carries a Host-owned API shape, passes the same validation and appears in
 * the same list, but the player supplies its base URL (and the model id that
 * endpoint serves, because a local server's model id is part of where the
 * endpoint lives, not a provider choice). Every other entry pins the endpoint
 * itself, so no route can accept an arbitrary endpoint for them.
 */

/** Pi API shape a catalog entry pins for its `models.json` provider block. */
export type TavernPiApi = "openai-completions" | "openai-responses";

/**
 * The reasoning dialect one model speaks through an `openai-completions`
 * provider entry. It is the model's own declared property and is never inferred
 * from its name: `deepseek` collapses every requested effort onto the
 * provider's `none|low|high|max` vocabulary and returns the assistant's
 * reasoning content, while `native` forwards Pi's own level names unchanged.
 * A model the catalog does not describe keeps `native` (design/28 §2.3.1).
 */
export type TavernModelReasoningDialect = "deepseek" | "native";

/** The one catalog entry whose endpoint the player supplies (design/28 §1). */
export const TAVERN_ESCAPE_HATCH_PROVIDER_ID = "gamebuddy-openai-compatible" as const;
/** Pi provider id of the operator-managed environment connection (design/28 §5.2). */
export const TAVERN_ENVIRONMENT_PROVIDER_ID = "cpa-oai" as const;
export const TAVERN_ENVIRONMENT_VARIABLE = "CPA_OAI_API_KEY" as const;

/**
 * The complete set of player-fillable setup fields. It is a closed allowlist:
 * no script, header, provider payload or free-form configuration field exists.
 */
export type TavernProviderSetupFieldId = "apiKey" | "baseUrl" | "modelId";

export type TavernCatalogModel = Readonly<{
  modelId: string;
  modelLabel: string;
  /** Thinking levels this exact model advertises to the provider. */
  allowedThinkingLevels: readonly CompanionThinkingLevel[];
  defaultThinkingLevel: CompanionThinkingLevel;
  /** The reasoning dialect this exact model speaks (see above). */
  reasoningDialect: TavernModelReasoningDialect;
}>;

export type TavernCatalogProvider = Readonly<{
  providerId: string;
  label: string;
  /** Pi provider id this entry configures in the provider store. */
  piProviderId: string;
  piApi: TavernPiApi;
  /** Fixed Host-owned endpoint, or null only for the escape hatch. */
  baseUrl: string | null;
  /** Environment-provided credential: never stored, read back or edited. */
  environmentVariable: string | null;
  setupFields: readonly TavernProviderSetupFieldId[];
  allowedPlayerModels: readonly TavernCatalogModel[];
  /** True only for the single OpenAI-compatible escape hatch entry. */
  escapeHatch: boolean;
  authHeader: boolean;
}>;

const defineModel = (
  modelId: string,
  modelLabel: string,
  allowedThinkingLevels: readonly CompanionThinkingLevel[],
  defaultThinkingLevel: CompanionThinkingLevel,
  reasoningDialect: TavernModelReasoningDialect,
): TavernCatalogModel =>
  Object.freeze({
    modelId,
    modelLabel,
    allowedThinkingLevels: Object.freeze([...allowedThinkingLevels]),
    defaultThinkingLevel,
    reasoningDialect,
  });

const defineProvider = (provider: TavernCatalogProvider): TavernCatalogProvider =>
  Object.freeze({
    ...provider,
    setupFields: Object.freeze([...provider.setupFields]),
    allowedPlayerModels: Object.freeze([...provider.allowedPlayerModels]),
  });

export const TAVERN_PROVIDER_CATALOG: readonly TavernCatalogProvider[] = Object.freeze([
  // The environment connection is the zero-configuration default: activating
  // it writes exactly the provider block this Host wrote before player
  // connections existed, so its Pi provider id and endpoint are frozen.
  defineProvider({
    providerId: TAVERN_ENVIRONMENT_PROVIDER_ID,
    label: "GameBuddy Agent (CPA)",
    piProviderId: TAVERN_ENVIRONMENT_PROVIDER_ID,
    piApi: "openai-completions",
    baseUrl: "http://127.0.0.1:8317/v1",
    environmentVariable: TAVERN_ENVIRONMENT_VARIABLE,
    setupFields: [],
    allowedPlayerModels: [
      defineModel("deepseek-v4-flash", "DeepSeek V4 Flash", ["low", "high", "max"], "high", "deepseek"),
    ],
    escapeHatch: false,
    authHeader: true,
  }),
  defineProvider({
    providerId: "deepseek",
    label: "DeepSeek",
    piProviderId: "deepseek",
    piApi: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    environmentVariable: null,
    setupFields: ["apiKey"],
    allowedPlayerModels: [
      defineModel("deepseek-v4-flash", "DeepSeek V4 Flash", ["low", "high", "max"], "high", "deepseek"),
      defineModel("deepseek-v4-pro", "DeepSeek V4 Pro", ["high", "max"], "high", "deepseek"),
    ],
    escapeHatch: false,
    authHeader: false,
  }),
  defineProvider({
    providerId: "openai",
    label: "OpenAI",
    piProviderId: "openai",
    piApi: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    environmentVariable: null,
    setupFields: ["apiKey"],
    allowedPlayerModels: [
      defineModel("gpt-5.6-luna", "GPT-5.6 Luna", ["low", "medium", "high", "xhigh", "max"], "high", "native"),
      defineModel("gpt-5.5", "GPT-5.5", ["low", "medium", "high", "xhigh"], "high", "native"),
    ],
    escapeHatch: false,
    authHeader: false,
  }),
  defineProvider({
    providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
    label: "OpenAI-compatible endpoint",
    piProviderId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
    piApi: "openai-completions",
    baseUrl: null,
    environmentVariable: null,
    // The escape hatch relaxes exactly one constraint — where the compatible
    // endpoint lives — plus the model id that endpoint serves, which the Host
    // cannot know for a local server. Its API shape stays Host-owned.
    setupFields: ["baseUrl", "apiKey", "modelId"],
    allowedPlayerModels: [],
    escapeHatch: true,
    authHeader: true,
  }),
]);

export function catalogProvider(providerId: string): TavernCatalogProvider | null {
  return TAVERN_PROVIDER_CATALOG.find((entry) => entry.providerId === providerId) ?? null;
}

export function catalogModel(provider: TavernCatalogProvider, modelId: string): TavernCatalogModel | null {
  return provider.allowedPlayerModels.find((model) => model.modelId === modelId) ?? null;
}

/** True when this provider accepts a bounded player-supplied model id. */
export function acceptsPlayerModel(provider: TavernCatalogProvider): boolean {
  return provider.setupFields.includes("modelId");
}

export function isAllowedThinkingLevel(model: TavernCatalogModel, level: string): boolean {
  return (model.allowedThinkingLevels as readonly string[]).includes(level);
}
