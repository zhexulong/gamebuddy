import type { CompanionThinkingLevel } from "../runtime-identity.js";

/**
 * Host-owned provider and model catalog for the player-facing dialogue role
 * (design/28 §1 and §5.1).
 *
 * The browser may only select an entry of this catalog. Exactly one entry is
 * the endpoint escape hatch: it is a catalog entry like any other, passes the
 * same validation and appears in the same list, but the player supplies its
 * base URL and the API shape that endpoint speaks. Every other entry pins the
 * endpoint and the API shape itself, so no route can accept an arbitrary
 * endpoint for them.
 *
 * The model id is the player's in every entry the player configures, including
 * the pinned ones. `allowedPlayerModels` is not a gate, and for an endpoint this
 * product does not run it is empty: an id could only be published there by
 * guessing at what someone else's service serves, and a guess that misses is
 * read by the player as "my key is invalid". A player types any id, and the
 * Host-owned probe against the endpoint's own `/models` - not this list - decides
 * whether it is offered. Only the operator's own gateway, whose ids are ours,
 * states a model.
 */

/**
 * The exact `api` shapes Pi's own chat adapters register, in the one Host-side copy of
 * that list. The value is written verbatim into the `models.json` provider entry's `api`
 * field, so a shape Pi cannot speak must never be admitted: a typo here would hand the Pi
 * runtime an API id it has no adapter for. The escape hatch is the only caller that gets
 * to pick one; every other catalog entry pins its own.
 *
 * Authority: `@earendil-works/pi-ai`'s runtime registry (the ids it actually builds
 * adapters for, `BUILTIN_APIS`) and its `KnownApi` union. Both are in the installed
 * package, and `provider-catalog.test.ts` asserts this list equals that registry, so a
 * shape added or removed upstream fails a test instead of silently going missing here.
 */
export const TAVERN_PI_API_SHAPES = Object.freeze([
  "anthropic-messages",
  "azure-openai-responses",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations",
  "pi-messages",
] as const);

/** Pi API shape a provider entry contributes to `models.json`. */
export type TavernPiApi = (typeof TAVERN_PI_API_SHAPES)[number];

/** True when `value` is exactly one API shape Pi's provider entry may carry. */
export function isTavernPiApi(value: unknown): value is TavernPiApi {
  return typeof value === "string" && (TAVERN_PI_API_SHAPES as readonly string[]).includes(value);
}

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
 * The one environment switch that offers the operator's own gateway to a browser. It is a developer's
 * opt-in, never a player's default: this product ships no model endpoint, so a player who has
 * configured nothing has nothing to send to and must be told to bring their own connection.
 */
export const TAVERN_OPERATOR_GATEWAY_ENV = "GAMEBUDDY_OPERATOR_GATEWAY";

/**
 * The complete set of player-fillable setup fields. It is a closed allowlist:
 * no script, header, provider payload or free-form configuration field exists.
 */
export type TavernProviderSetupFieldId = "apiKey" | "apiKeyRequired" | "apiShape" | "baseUrl" | "modelId";

export type TavernCatalogModel = Readonly<{
  modelId: string;
  modelLabel: string;
  /** Thinking levels this exact model advertises to the provider. */
  allowedThinkingLevels: readonly CompanionThinkingLevel[];
  defaultThinkingLevel: CompanionThinkingLevel;
  /** The reasoning dialect this exact model speaks (see above). */
  reasoningDialect: TavernModelReasoningDialect;
  /**
   * The context window this model actually has, when the catalog knows it.
   *
   * The product has to declare *some* window to Pi and to the fold policy, and both ways of getting it wrong are real: the
   * endpoint's `/models` reply carries no window on OpenAI or DeepSeek (only OpenRouter does), and Pi refuses every request
   * when the declared window is zero. A per-model number is the honest middle - a known model states its own, and a model the
   * catalog does not know falls back to a conservative constant rather than to a million.
   */
  contextWindow?: number;
}>;

export type TavernCatalogProvider = Readonly<{
  providerId: string;
  label: string;
  /** Pi provider id this entry configures in the provider store. */
  piProviderId: string;
  /** Host-owned API shape, or null only for the escape hatch, whose record supplies it. */
  piApi: TavernPiApi | null;
  /** Fixed Host-owned endpoint, or null only for the escape hatch. */
  baseUrl: string | null;
  /** Environment-provided credential: never stored, read back or edited. */
  environmentVariable: string | null;
  setupFields: readonly TavernProviderSetupFieldId[];
  /**
   * The models this Host may state for this entry, and nothing else. It is empty for every endpoint
   * this product does not run: those ids are not ours to know, and publishing a guess makes the
   * endpoint's honest `not_found` read as a broken key. There, the endpoint's own `/models` reply -
   * which the probe already reads - is the list, beside whatever the player types.
   */
  allowedPlayerModels: readonly TavernCatalogModel[];
  /** True only for the single OpenAI-compatible escape hatch entry. */
  escapeHatch: boolean;
  /**
   * Whether the HOST-OWNED liveness probe authenticates its `GET /models` with
   * `Authorization: Bearer <key>`.
   *
   * This is the probe's own request shape, not the runtime's: the runtime's adapter
   * authenticates itself from the resolved `apiKey` (every adapter in pi-ai 1.0.0
   * requires that key and installs its own scheme — `x-api-key`, `api-key`, SigV4,
   * or the SDK's Bearer), which is also why the provider entry written for Pi never
   * carries an `authHeader` flag.
   *
   * It follows the entry's own `piApi`, because that is what the endpoint speaks: a
   * bearer-authenticated API shape (`openai-completions`, `openai-responses`) is
   * probed with a bearer token. `false` here means the probe sends NO credential at
   * all, which a real public endpoint answers with 401 - so the connection could
   * never reach `ready`. It is true wherever the entry pins a bearer shape, and
   * false only for a provider that authenticates some other way.
   */
  probeBearerAuth: boolean;
}>;

const defineModel = (
  modelId: string,
  modelLabel: string,
  allowedThinkingLevels: readonly CompanionThinkingLevel[],
  defaultThinkingLevel: CompanionThinkingLevel,
  reasoningDialect: TavernModelReasoningDialect,
  contextWindow: number,
): TavernCatalogModel =>
  Object.freeze({
    modelId,
    modelLabel,
    allowedThinkingLevels: Object.freeze([...allowedThinkingLevels]),
    defaultThinkingLevel,
    reasoningDialect,
    contextWindow,
  });

const defineProvider = (provider: TavernCatalogProvider): TavernCatalogProvider =>
  Object.freeze({
    ...provider,
    setupFields: Object.freeze([...provider.setupFields]),
    allowedPlayerModels: Object.freeze([...provider.allowedPlayerModels]),
  });

export const TAVERN_PROVIDER_CATALOG: readonly TavernCatalogProvider[] = Object.freeze([
  // The operator's own gateway. It is NOT a player's default and is not offered as a normal choice:
  // this product ships no model endpoint, so a player who has configured nothing has nowhere to
  // send. It stays in the catalogue because `catalogProvider()` must keep resolving it for the
  // records and the frozen runtime provider block the operator's own machine already holds.
  defineProvider({
    providerId: TAVERN_ENVIRONMENT_PROVIDER_ID,
    label: "Operator gateway (developer only)",
    piProviderId: TAVERN_ENVIRONMENT_PROVIDER_ID,
    piApi: "openai-completions",
    baseUrl: "http://127.0.0.1:8317/v1",
    environmentVariable: TAVERN_ENVIRONMENT_VARIABLE,
    setupFields: [],
    allowedPlayerModels: [
      defineModel("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", ["low", "high", "max"], "high", "deepseek", 131_072),
    ],
    escapeHatch: false,
    probeBearerAuth: true,
  }),
  defineProvider({
    providerId: "deepseek",
    label: "DeepSeek",
    piProviderId: "deepseek",
    piApi: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    environmentVariable: null,
    setupFields: ["apiKey", "modelId"],
    // Empty on purpose: `deepseek-v4.1-flash` is this project's own gateway id, not one
    // `api.deepseek.com` serves, so listing it made the first probe answer `not_found` for a player
    // with a perfectly good key. The endpoint's `/models` reply is the list.
    allowedPlayerModels: [],
    escapeHatch: false,
    // `openai-completions` authenticates a request with a bearer token; without this the probe
    // sends no credential at all and a real endpoint answers 401.
    probeBearerAuth: true,
  }),
  defineProvider({
    providerId: "openai",
    label: "OpenAI",
    piProviderId: "openai",
    piApi: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    environmentVariable: null,
    setupFields: ["apiKey", "modelId"],
    // Same rule, same failure: these ids were the CPA gateway's, not OpenAI's.
    allowedPlayerModels: [],
    escapeHatch: false,
    // `openai-responses` authenticates a request with a bearer token; without this the probe sends
    // no credential at all and a real endpoint answers 401.
    probeBearerAuth: true,
  }),
  defineProvider({
    providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
    label: "OpenAI-compatible endpoint",
    piProviderId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
    piApi: null,
    baseUrl: null,
    environmentVariable: null,
    // The escape hatch relaxes where the endpoint lives and the API shape that
    // endpoint speaks — two facts about an endpoint the Host cannot know. The
    // model id is the player's in every entry they configure, not only here, and it
    // is the one entry where the credential requirement is theirs to state: a local
    // server needs no key at all, and a compatible gateway does.
    setupFields: ["baseUrl", "apiShape", "apiKey", "modelId", "apiKeyRequired"],
    allowedPlayerModels: [],
    escapeHatch: true,
    probeBearerAuth: true,
  }),
]);

export function catalogProvider(providerId: string): TavernCatalogProvider | null {
  return TAVERN_PROVIDER_CATALOG.find((entry) => entry.providerId === providerId) ?? null;
}

/**
 * The entries a BROWSER may offer as a choice: bring-your-own-key only.
 *
 * This product ships no model endpoint, so the operator's gateway (whose endpoint and credential
 * both live on the operator's own machine) is not a channel a player could land on: one who has
 * configured nothing must be told to bring a connection, not handed one that does not exist on
 * their disk. The entry stays in `TAVERN_PROVIDER_CATALOG` so that `catalogProvider()` still
 * resolves the operator's own stored records and the frozen runtime provider block, and so that a
 * developer can reach it at all - but reaching it is an explicit act (`GAMEBUDDY_OPERATOR_GATEWAY=1`)
 * and it is labelled as one, never a default.
 *
 * Read at projection time, not at module load: a process started without the switch must not be
 * able to publish it because some earlier importer cached the list.
 */
export function playerOfferedProviders(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly TavernCatalogProvider[] {
  const operatorOptedIn = environment[TAVERN_OPERATOR_GATEWAY_ENV] === "1";
  return Object.freeze(
    TAVERN_PROVIDER_CATALOG.filter((entry) => entry.providerId !== TAVERN_ENVIRONMENT_PROVIDER_ID || operatorOptedIn),
  );
}

export function catalogModel(provider: TavernCatalogProvider, modelId: string): TavernCatalogModel | null {
  return provider.allowedPlayerModels.find((model) => model.modelId === modelId) ?? null;
}

/**
 * True when this provider accepts a bounded player-supplied model id. Every provider the player
 * configures does: the Host's curated ids are a starting point, not the set of ids an endpoint may
 * serve, so a player who wants a model we did not list types its id and the probe decides whether
 * the endpoint actually offers it. Only the operator-managed environment entry does not - its
 * credential, endpoint and model are owned by the environment, not by the player.
 */
export function acceptsPlayerModel(provider: TavernCatalogProvider): boolean {
  return provider.setupFields.includes("modelId");
}

export function isAllowedThinkingLevel(model: TavernCatalogModel, level: string): boolean {
  return (model.allowedThinkingLevels as readonly string[]).includes(level);
}
