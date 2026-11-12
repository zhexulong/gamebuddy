/**
 * What a chat audit refuses before it launches anything: a Magic Context store this run does not own, and a provider
 * that cannot answer for the model the run declares.
 *
 * Both are decidable before a child exists, and both used to cost a whole run's budget to discover from a turn that
 * failed. The model profile the run measures is declared here too, so the profile, the readiness probe and the
 * artifact name one model id.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { OPERATOR_GATEWAY_PROVIDER_ID } from "../../lib/operator-gateway.mjs";
import { AUDIT_IDENTITY, CODE_PATTERN } from "./chat-audit-contract.mjs";
import { nonEmpty, readJsonFile } from "./chat-audit-values.mjs";
import { loadHostProviderCatalog, loadHostRuntimeIdentity } from "./host-build-modules.mjs";

// ── Run admission: what a Chat run refuses BEFORE it launches anything ──
//
// Measured 2026-10-23 (runs db5b0a61 at 15:14 and 2d3e086a at 15:22): each ran ~192 s, recorded two `provider`
// events with `problemCode: runtime_unavailable`, and finished `conversation_turn_failed` with zero replies. The
// pipeline was fine - run 528ee184 answered 2/2 against the identical model manifest - and the cause was
// environmental twice over: the child inherited a `MAGIC_CONTEXT_STORAGE_DIR` owned by a store this runtime does
// not own, and nothing had asked the provider whether it could answer at all. Both facts are knowable before the
// child exists, so both refuse here, by name, with no runtime behind them. The game runner has made exactly this
// refusal since 2026-10-19 (`tools/live-run/game/**` -> `tools/lib/live-run-preflight.mjs`); this is the Chat
// surface's port of it, with the same `provider_not_ready:<provider>:<model>:<reason>` vocabulary.
const MAGIC_CONTEXT_STORE_VARIABLE = "MAGIC_CONTEXT_STORAGE_DIR";
/** The provider a saved Chat model profile resolves to, per `resolveModelProfileConfig`. */
const CHAT_PROFILE_PROVIDER = OPERATOR_GATEWAY_PROVIDER_ID;
/** The credential Pi resolves at request time for that provider (the entry carries `$CPA_OAI_API_KEY`). */
const CHAT_PROVIDER_KEY_VARIABLE = "CPA_OAI_API_KEY";
/**
 * The model a run DECLARES when its root carries no profile yet. A run that leaves this to the product's shipped
 * default cannot name the model it measured in its own artifacts, and a default that moved would silently change
 * what the run tests; declaring it keeps the profile, the readiness probe and the artifact on one model id.
 */
const CHAT_PROFILE_MODEL = "deepseek-v4.1-flash";
const CHAT_PROFILE_THINKING_LEVEL = "high";
const PROVIDER_PROBE_TIMEOUT_MS = 10_000;
const PROVIDER_LISTING_MAX_CHARS = 200_000;
const PROVIDER_CATALOG_MAX_MODELS = 1_000;

/**
 * The inherited-store refusal, or `null` when the run may proceed.
 *
 * Magic Context's extension gives `MAGIC_CONTEXT_STORAGE_DIR` precedence over the XDG-derived path, and the
 * composed child inherits this process's environment (`composeDesktopChildEnvironment`). A value inherited from an
 * operator shell therefore decides which store the run opens - and a store whose migration lane is ahead of this
 * build's schema fence leaves the extension fail-closed, aborting every turn in-process. Refusing is the honest
 * answer: quietly unsetting the variable would hide the same class of failure the next time.
 */
export function foreignMagicContextStore({ runtimeRoot, env = process.env }) {
  const configured = nonEmpty(env?.[MAGIC_CONTEXT_STORE_VARIABLE]);
  if (configured === null) return null;
  // The child resolves a relative override against its own cwd, exactly as `resolve` does here.
  const root = resolve(runtimeRoot);
  const store = resolve(configured);
  // `relative` is case-insensitive on win32, which is the platform a run's store path is spelled on.
  const relation = relative(root, store);
  const inside = relation === "" || !(relation.startsWith("..") || isAbsolute(relation));
  return inside ? null : `foreign_magic_context_store:${configured}`;
}

/**
 * The code a named refusal is filed under in the run artifacts. A refusal may name a path or an
 * endpoint-derived id, which is not a bounded code, so the leading code is what `reasonCode` carries and the whole
 * line travels beside it as `refusal`.
 */
export function refusalCode(refusal) {
  const code = String(refusal).split(":")[0];
  return CODE_PATTERN.test(code) ? code : "chat_audit_harness_blocked";
}

/** The name a caller refuses with, so a refused run says which provider and model never answered, and why. */
export function providerReadinessRefusal(readiness) {
  const model = readiness.model ?? "unknown";
  return readiness.reason === "model_not_in_provider_catalog"
    ? `model_not_in_provider_catalog:${model}`
    : `provider_not_ready:${readiness.provider}:${model}:${readiness.reason}`;
}

/**
 * Whether this run may launch at all: the store it would open is its own, and the provider it would ask can answer.
 *
 * Both refusals are decided here, before a child exists, because both cost a whole run's budget to discover from a
 * turn that failed: the store check is pure file-system, and the provider check is one model listing.
 */
export async function admitChatRun({
  runtimeRoot,
  agentDir,
  baseUrl = null,
  env = process.env,
  transport = fetch,
  timeoutMs = PROVIDER_PROBE_TIMEOUT_MS,
}) {
  const foreign = foreignMagicContextStore({ runtimeRoot, env });
  if (foreign !== null)
    return Object.freeze({ ok: false, stage: "magic_context_store", refusal: foreign, readiness: null });
  const readiness = await probeChatProviderReadiness({ runtimeRoot, agentDir, baseUrl, env, transport, timeoutMs });
  if (!readiness.ok)
    return Object.freeze({
      ok: false,
      stage: "provider_readiness",
      refusal: providerReadinessRefusal(readiness),
      readiness,
    });
  return Object.freeze({ ok: true, stage: "ready", refusal: null, readiness });
}

/**
 * The agent dir and endpoint admission checks against, both derived from the product's own modules rather than
 * spelled again here: `resolveRuntimePaths` owns where a runtime's `models.json` and `auth.json` live, and the
 * provider catalog owns the endpoint the environment provider serves.
 */
export async function chatRunReadinessTargets({ root }) {
  const { resolveRuntimePaths } = await loadHostRuntimeIdentity();
  const { catalogProvider, TAVERN_ENVIRONMENT_PROVIDER_ID } = await loadHostProviderCatalog();
  return Object.freeze({
    agentDir: resolveRuntimePaths(AUDIT_IDENTITY, root).agentDir,
    baseUrl: catalogProvider(TAVERN_ENVIRONMENT_PROVIDER_ID)?.baseUrl ?? null,
  });
}

/**
 * The model profile this run measures. A live-audit root is a fresh `mkdtemp`, so there is never an operator profile
 * to preserve: the run DECLARES the model it is about to measure, which is also what lets the readiness probe name it
 * and what the run's artifact can then be compared against.
 */
export async function declareChatModelProfile(runtimeRoot) {
  await mkdir(join(runtimeRoot, "settings"), { recursive: true });
  const profile = Object.freeze({
    revision: 0,
    modelId: CHAT_PROFILE_MODEL,
    thinkingLevel: CHAT_PROFILE_THINKING_LEVEL,
  });
  await writeFile(
    join(runtimeRoot, "settings", "model-profiles.json"),
    JSON.stringify({ schemaVersion: 1, chat: profile, game: profile }),
  );
  return profile;
}

/**
 * Whether this run measures paced delivery. A fresh audit root has no player, so
 * nobody has chosen anything and the Chat default (off) is what a real new
 * player gets. Setting `GAMEBUDDY_CHAT_PACED=1` writes the record the settings
 * route would write, so the same harness can measure both sides of the switch
 * and the two runs differ in exactly one thing.
 */
const CHAT_PACED = process.env.GAMEBUDDY_CHAT_PACED === "1";

export async function declareChatDeliveryPreference(runtimeRoot) {
  // Written ONLY when pacing is asked for. A generation older than the `paced`
  // field refuses the whole record (its validator requires an exact key set), so
  // writing it on every run would break the default path on every tree that has
  // not been rebuilt - a measurement switch must not be able to do that.
  if (!CHAT_PACED) return false;
  await mkdir(join(runtimeRoot, "settings"), { recursive: true });
  const record = Object.freeze({
    schemaVersion: 1,
    revision: 1,
    locale: null,
    disclosureVersion: null,
    consent: "undecided",
    decidedAtMs: null,
    outputDevice: null,
    persona: null,
    paced: true,
  });
  await writeFile(join(runtimeRoot, "settings", "player-preference.json"), JSON.stringify(record));
  return true;
}

/** The model this root's CHAT profile names, or null when it names none. */
async function readChatProfileModel(runtimeRoot) {
  const profile = await readJsonFile(join(runtimeRoot, "settings", "model-profiles.json"));
  return nonEmpty(profile?.chat?.modelId);
}

/**
 * One provider entry of Pi's own `models.json`. `modelIds` is `null` when the entry describes no catalog at all:
 * a catalog provider other than the environment one deliberately contributes no `models` list (Pi's model
 * middleware already ships full metadata), and treating that absence as "the model is not served" would refuse
 * every player connection.
 */
async function readProviderCatalogEntry(agentDir, provider) {
  const catalog = await readJsonFile(join(agentDir, "models.json"));
  const entry = catalog?.providers?.[provider];
  if (entry === null || typeof entry !== "object") return null;
  const modelIds = Array.isArray(entry.models)
    ? entry.models.map((model) => model?.id).filter((id) => typeof id === "string" && id.length > 0)
    : null;
  return Object.freeze({ baseUrl: nonEmpty(entry.baseUrl), modelIds });
}

/** The credential Pi reads for that provider: `auth.json` sits beside `models.json` in the agent dir. */
async function readProviderCredential(agentDir, provider) {
  const auth = await readJsonFile(join(agentDir, "auth.json"));
  return nonEmpty(auth?.[provider]?.key);
}

/**
 * Whether the provider this root's CHAT model profile names can answer at all, asked BEFORE the runtime exists.
 *
 * Resolved from the files the runtime itself reads - the Chat profile's model id, the provider entry in Pi's
 * `models.json` when the root has run before, the credential in `auth.json` or the environment variable the entry
 * points at - and then confirmed against the endpoint with one minimal request. A fresh root has no catalog yet,
 * so `baseUrl` supplies the endpoint the runtime will write for this provider.
 *
 * Each reason is a different repair, which is why it is named:
 *   `profile-invalid`             the profile names no model, so nothing says what to check
 *   `model_not_in_provider_catalog` the catalog does not list the model the profile names
 *   `auth`                        no credential, or the endpoint refused it (401/403)
 *   `unreachable`                 no endpoint, a transport failure, a timeout, or any other non-2xx answer
 *   `ready`                       the endpoint answered and (when it listed its models) serves this one
 *
 * The endpoint's model listing is read for its ids only and never kept: "does this endpoint serve the model we
 * chose" is the whole question, and provider prose is not this harness's evidence. A 2xx whose body yields no id
 * list is accepted rather than refused, because only positive evidence that the model is absent may refuse a run.
 */
export async function probeChatProviderReadiness({
  runtimeRoot,
  agentDir,
  baseUrl = undefined,
  env = process.env,
  transport = fetch,
  timeoutMs = PROVIDER_PROBE_TIMEOUT_MS,
}) {
  const provider = CHAT_PROFILE_PROVIDER;
  const model = await readChatProfileModel(runtimeRoot);
  if (model === null) return Object.freeze({ ok: false, provider, model: null, reason: "profile-invalid" });
  const catalog = await readProviderCatalogEntry(agentDir, provider);
  if (catalog !== null && catalog.modelIds !== null && !catalog.modelIds.includes(model))
    return Object.freeze({ ok: false, provider, model, reason: "model_not_in_provider_catalog" });
  const apiKey = (await readProviderCredential(agentDir, provider)) ?? nonEmpty(env?.[CHAT_PROVIDER_KEY_VARIABLE]);
  if (apiKey === null) return Object.freeze({ ok: false, provider, model, reason: "auth" });
  const endpoint = catalog?.baseUrl ?? nonEmpty(baseUrl);
  if (endpoint === null) return Object.freeze({ ok: false, provider, model, reason: "unreachable" });
  const answer = await requestProviderListing(endpoint, apiKey, transport, timeoutMs);
  if (answer.reason !== null) return Object.freeze({ ok: false, provider, model, reason: answer.reason });
  if (answer.modelIds !== null && !answer.modelIds.includes(model))
    return Object.freeze({ ok: false, provider, model, reason: "model_not_in_provider_catalog" });
  return Object.freeze({ ok: true, provider, model, reason: "ready" });
}

/** `reason: null` when the endpoint answered, with the ids it listed (`null` when it listed none). */
async function requestProviderListing(endpoint, apiKey, transport, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(`${endpoint.replace(/\/+$/u, "")}/models`, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    });
    if (response.ok !== true)
      return Object.freeze({
        reason: response.status === 401 || response.status === 403 ? "auth" : "unreachable",
        modelIds: null,
      });
    return Object.freeze({ reason: null, modelIds: await readListingModelIds(response) });
  } catch {
    return Object.freeze({ reason: "unreachable", modelIds: null });
  } finally {
    clearTimeout(timer);
  }
}

async function readListingModelIds(response) {
  if (typeof response.text !== "function") return null;
  let text;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (typeof text !== "string" || text.length === 0 || text.length > PROVIDER_LISTING_MAX_CHARS) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const candidates = [value?.data, value?.models].filter(Array.isArray);
  const list = candidates[0] ?? null;
  if (list === null) return null;
  const ids = list
    .slice(0, PROVIDER_CATALOG_MAX_MODELS)
    .map((entry) => (typeof entry === "string" ? entry : entry?.id))
    .filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128);
  return ids.length === 0 ? null : ids;
}
