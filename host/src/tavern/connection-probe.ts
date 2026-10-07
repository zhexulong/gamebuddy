import type { TavernCatalogProvider } from "./provider-catalog.js";
import type { TavernConnectionProbeFailure, TavernConnectionProbeResult } from "./connection-store.js";

/**
 * Host-owned liveness probe for one configured connection (design/28 §5.3).
 *
 * The probe is the only place a submitted credential is used, and it is used
 * exactly once: it calls the OpenAI-compatible `/models` listing of the exact
 * endpoint the record resolves to, with the record's own credential. Nothing
 * derived from the response crosses this boundary except one closed
 * audit-safe outcome — no status line, header, body, endpoint echo or raw
 * provider error can become a player notice or an evidence record.
 */

const PROBE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export type TavernConnectionProbeInput = Readonly<{
  provider: TavernCatalogProvider;
  /** Host-owned endpoint; the player's own submitted URL for the escape hatch. */
  baseUrl: string;
  apiKey: string | null;
  modelId: string;
}>;

export type TavernConnectionProbe = (input: TavernConnectionProbeInput) => Promise<TavernConnectionProbeResult>;

export async function probeTavernConnection(
  input: TavernConnectionProbeInput,
  transport: typeof fetch = fetch,
): Promise<TavernConnectionProbeResult> {
  if (input.apiKey === null) return failed("not_configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await transport(`${input.baseUrl}/models`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(input.provider.probeBearerAuth ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
    });
    // The listing is parsed only for model ids. An endpoint error may echo
    // request facts, so no provider text is retained beyond this function.
    const listing = await readBoundedModelListing(response);
    if (response.status === 401 || response.status === 403) return failed("unauthorized");
    if (response.status === 404) return failed("not_found");
    if (response.status < 200 || response.status >= 300) return failed("invalid_response");
    if (listing === undefined) return failed("invalid_response");
    // `ready` claims the exact selected model answers at this endpoint. A
    // listing that does not offer it would make that claim false, so a missing
    // model fails with the same closed vocabulary as an unreachable endpoint.
    return listing.has(input.modelId) ? Object.freeze({ outcome: "ready" }) : failed("not_found");
  } catch (error) {
    if (isAbort(error)) return failed("timeout");
    return failed("unreachable");
  } finally {
    clearTimeout(timer);
  }
}

function failed(failure: TavernConnectionProbeFailure): TavernConnectionProbeResult {
  return Object.freeze({ outcome: "failed", failure });
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
  const object = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
  const container = Array.isArray(parsed) ? parsed : (["data", "models"] as const).map((key) => object?.[key]).find(Array.isArray);
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
