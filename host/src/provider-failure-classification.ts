/**
 * Why a provider refused the request, as the closed set of facts a player can act on.
 *
 * Pi reports every refusal on the assistant message's own `errorMessage`, built by
 * `formatProviderError(normalizeProviderError(error))` as `"<status>: <body>"`
 * (`pi-ai/dist/api/openai-completions.js:505`). That string is not publishable: for a
 * player-supplied `baseUrl` the body is arbitrary third-party bytes, so a gateway that
 * echoes the key prefix, a prompt-echoing proxy, or a validation 400 quoting a request
 * field each put content the player never wrote in front of them.
 *
 * This module is the only place that string is read, and it returns one member of the
 * union below - or nothing at all when the message carries no evidence. The raw text
 * stays on stderr for the operator.
 */
export type ProviderFailureClass =
  | "credential_rejected"
  | "model_not_served"
  | "rate_limited"
  | "context_overflow"
  | "endpoint_unreachable";

/**
 * Pi's two display shapes: `"<status>: <body>"` when the SDK folded no body into the
 * message, and `"<prefix> (<status>): <body>"` when it did. A message the SDK already
 * composed starts with its own prose instead, which is why the body patterns below
 * exist at all.
 */
const LEADING_PROVIDER_STATUS = /^\s*(?:[A-Za-z][A-Za-z0-9 ._-]{0,39}\s*\(\s*(\d{3})\s*\)|(\d{3}))(?!\d)/u;

/**
 * The wordings providers use for a refused credential, a throttle and a model the
 * endpoint does not serve. Each is the phrase itself rather than a heuristic on the
 * status, because a message can arrive with its status stripped - the SDK folds the
 * body into `error.message` for Anthropic and Google, and `formatProviderError`
 * returns that message unchanged.
 */
const CREDENTIAL_REJECTED =
  /incorrect api key|invalid api key|invalid_api_key|api key not valid|invalid bearer|authentication|unauthorized/iu;
const RATE_LIMITED = /rate.?limit|too many requests|throttl/iu;
const MODEL_NOT_SERVED =
  /no such model|unknown model|model_not_found|invalid model|model [`'"].+[`'"] does not exist|does not exist or you do not have access|model .{0,40}not (?:found|supported|available)/iu;

/**
 * Context overflow, conservatively.
 *
 * Two authorities in this tree already encode the full provider-specific list:
 * `pi-ai`'s `OVERFLOW_PATTERNS` (`dist/utils/overflow.js`) and Magic Context's
 * `OVERFLOW_PATTERNS`
 * (`vendor/magic-context/packages/plugin/src/features/magic-context/overflow-detection.ts`).
 * Neither is reachable from this package - `@earendil-works/pi-ai` is not a declared
 * Host dependency and does not resolve from `host/src` under pnpm's isolated layout,
 * and `@cortexkit/pi-magic-context` exports no overflow detector from any of its three
 * public subpaths - so this is a named subset rather than an import.
 *
 * It is deliberately the wordings that are stable across providers. A miss is not
 * silent but it is also not a wrong specific claim: the message falls through to
 * `endpoint_unreachable`, which is the class that says "the request did not get a
 * usable answer" without naming a cause it cannot prove.
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt (?:is )?too long/iu,
  /input is too long for requested model/iu,
  /exceeds the context window/iu,
  /exceeds (?:the )?(?:model'?s )?maximum context length/iu,
  /maximum context length is \d+ tokens/iu,
  /input token count.*exceeds the maximum/iu,
  /maximum prompt length is \d+/iu,
  /reduce the length of the messages/iu,
  /exceeds the available context size/iu,
  /greater than the context length/iu,
  /exceeded model token limit/iu,
  /context[_ ]length[_ ]exceeded/iu,
  /request entity too large/iu,
  /request_too_large/iu,
  /context window exceeds limit/iu,
  /model_context_window_exceeded/iu,
  /too many tokens/iu,
];

/**
 * The one class this exact string supports, or `undefined` when it supports none.
 *
 * Status first, because it is the provider's own statement and needs no reading; the
 * body patterns only decide the cases where no usable status survived into the
 * message. `rate_limited` is tested before the overflow list on purpose - Amazon
 * Bedrock phrases a throttle as "ThrottlingException: Too many tokens, please wait
 * before trying again", which would otherwise reach `context_overflow` and tell the
 * player to shorten a conversation that was never too long.
 */
export function classifyProviderFailure(errorMessage: unknown): ProviderFailureClass | undefined {
  if (typeof errorMessage !== "string" || errorMessage.length === 0) return undefined;
  const status = leadingProviderStatus(errorMessage);
  if (status === 401 || status === 403) return "credential_rejected";
  if (status === 429) return "rate_limited";
  if (status === 404) return "model_not_served";
  if (RATE_LIMITED.test(errorMessage)) return "rate_limited";
  if (CREDENTIAL_REJECTED.test(errorMessage)) return "credential_rejected";
  if (MODEL_NOT_SERVED.test(errorMessage)) return "model_not_served";
  if (CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage))) return "context_overflow";
  return "endpoint_unreachable";
}

function leadingProviderStatus(errorMessage: string): number | undefined {
  const match = LEADING_PROVIDER_STATUS.exec(errorMessage);
  if (match === null) return undefined;
  const raw = match[1] ?? match[2];
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}
