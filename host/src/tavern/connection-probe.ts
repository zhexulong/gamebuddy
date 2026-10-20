import { PLAYER_MODEL_ID_PATTERN } from "../runtime-identity.js";
import { TAVERN_MODEL_LISTING_LIMIT } from "./browser-contract/index.js";
import type { TavernCatalogProvider } from "./provider-catalog.js";
import type { TavernConnectionProbeFailure, TavernConnectionProbeResult } from "./connection-store.js";

/**
 * Host-owned liveness probe for one configured connection (design/28 §5.3).
 *
 * The probe is the only place a submitted credential is used, and it is used
 * exactly once: it calls the OpenAI-compatible `/models` listing of the exact
 * endpoint the record resolves to, with the record's own credential.
 *
 * Two things and no more cross this boundary. One is the closed, audit-safe
 * outcome; no status line, header, body text, endpoint echo or raw provider
 * error can become a player notice or an evidence record. The other is the
 * endpoint's OWN model ids, because they are the only authority on which models
 * that endpoint serves: they are bounded (`TAVERN_MODEL_LISTING_LIMIT`) and kept
 * only when they match `PLAYER_MODEL_ID_PATTERN`, so the projection publishes
 * exactly the ids this product would accept as a model id and nothing an
 * endpoint chose to put in its body. Verification uses the WHOLE listing; only
 * the published array is cut.
 */

const PROBE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export type TavernConnectionProbeInput = Readonly<{
  provider: TavernCatalogProvider;
  /** Host-owned endpoint; the player's own submitted URL for the escape hatch. */
  baseUrl: string;
  apiKey: string | null;
  /**
   * Whether this connection needs a credential, read from the record's own stated fact. A keyless
   * self-hosted endpoint is probed without one; an endpoint that required a key and has none is the
   * case `not_configured` describes.
   */
  apiKeyRequired: boolean;
  modelId: string;
}>;

export type TavernConnectionProbe = (input: TavernConnectionProbeInput) => Promise<TavernConnectionProbeResult>;

export async function probeTavernConnection(
  input: TavernConnectionProbeInput,
  transport: typeof fetch = fetch,
): Promise<TavernConnectionProbeResult> {
  if (input.apiKeyRequired && input.apiKey === null) return failed("not_configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await transport(`${input.baseUrl}/models`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(input.provider.probeBearerAuth && input.apiKey !== null ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
    });
    // The listing is parsed only for model ids. An endpoint error may echo
    // request facts, so no provider text is retained beyond this function.
    const listing = await readBoundedModelListing(response);
    if (response.status === 401 || response.status === 403) return failed("unauthorized");
    if (response.status === 404) return failed("not_found");
    if (response.status < 200 || response.status >= 300) return failed("invalid_response");
    if (listing === undefined) return failed("invalid_response");
    // A 2xx listing is worth publishing even when this probe fails on content:
    // `not_found` is exactly the case where the player needs to see what the
    // endpoint does serve.
    const modelIds = publishModelIds(listing);
    // `ready` claims the exact selected model answers at this endpoint. A
    // listing that does not offer it would make that claim false, so a missing
    // model fails with the same closed vocabulary as an unreachable endpoint.
    return listing.has(input.modelId) ? Object.freeze({ outcome: "ready", modelIds }) : failed("not_found", modelIds);
  } catch (error) {
    if (isAbort(error)) return failed("timeout");
    return failed("unreachable");
  } finally {
    clearTimeout(timer);
  }
}

function failed(
  failure: TavernConnectionProbeFailure,
  modelIds: readonly string[] | null = null,
): TavernConnectionProbeResult {
  return Object.freeze({ outcome: "failed", failure, modelIds });
}

/**
 * The bounded, sanitised projection of one listing: ids this product would itself
 * accept as a model id, in the order the endpoint listed them, cut to
 * `TAVERN_MODEL_LISTING_LIMIT`. Everything else the body carried never leaves here.
 */
function publishModelIds(listing: ReadonlySet<string>): readonly string[] {
  const published: string[] = [];
  for (const id of listing) {
    if (!PLAYER_MODEL_ID_PATTERN.test(id)) continue;
    published.push(id);
    if (published.length === TAVERN_MODEL_LISTING_LIMIT) break;
  }
  return Object.freeze(published);
}

async function readBoundedBody(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.length > MAX_RESPONSE_BYTES ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Model ids the endpoint itself lists, tolerating the common compatible shapes
 * (`{data:[{id}]}`, `{models:[{id|model|name}]}`, or a bare array). The ids
 * never leave this function.
 */
function parseModelIds(body: string): Set<string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const object =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  const container = Array.isArray(parsed)
    ? parsed
    : (["data", "models"] as const).map((key) => object?.[key]).find(Array.isArray);
  if (!Array.isArray(container)) return undefined;
  const ids = new Set<string>();
  for (const entry of container) {
    if (typeof entry === "string" && entry.length > 0) ids.add(entry);
    else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const value = entry as Record<string, unknown>;
      for (const key of ["id", "model", "name"] as const) {
        if (typeof value[key] === "string" && value[key].length > 0) ids.add(value[key] as string);
      }
    }
  }
  return ids.size === 0 ? undefined : ids;
}

async function readBoundedModelListing(response: Response): Promise<Set<string> | undefined> {
  const body = await readBoundedBody(response);
  return body === undefined ? undefined : parseModelIds(body);
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "AbortError"
  );
}
