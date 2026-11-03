#!/usr/bin/env node
/**
 * A real endpoint's refusal reaches the player as the class it actually is: the durable turn, the browser contract and the sentence must all say credential rejection, not collapse into `runtime_unavailable`.
 *
 * `9614f1a3` added a classification chain - `native-companion-content.ts` `onRejected`
 * carries a cause, `FailedTurn.providerFailure` persists it (schema v7 -> v8), the
 * browser contract publishes it, and `turn-failure-text.ts` words five distinct
 * sentences. Every link of that chain was proven with SYNTHETIC bodies in a host unit
 * test (`host/src/native-companion-content.provider-failure.test.ts`,
 * `host/src/tavern/p4-provider-start-execution.test.ts`). Nothing had ever driven it
 * with a real HTTP response from a real endpoint, so "the classifier reads Pi's
 * `"<status>: <body>"` shape correctly" was a claim about a fixture, not about a
 * provider.
 *
 * This runner produces that response. It points the product's OWN escape-hatch
 * connection at `https://api.deepseek.com/v1` with a deliberately invalid key, and
 * then drives the product's own turn path (accept -> claim -> provider start) so the
 * classification is read back from the durable `FailedTurn`, projected through
 * `tavern_browser_api/v1`, and worded by `turnFailureText` - the same three steps a
 * player's failed turn takes.
 *
 * ## The three-way distinction, which is what makes this gate readable
 *
 * A single "red" for every outcome would be the defect `problem-code.13` taught us
 * about: when everything looks red, nobody can tell what broke and the gate stops
 * being read. So:
 *
 *   [1] the endpoint could not be reached at all (DNS, TCP, TLS, timeout)
 *         -> `external_endpoint_unreachable`, the run is INCONCLUSIVE, exit 0.
 *            It says nothing about our classification and must not turn CI red for a
 *            reason that is not ours.
 *   [2] reached it, and we classified a credential refusal as something else
 *         -> `classification_wrong`, exit 1, naming the member we produced and the
 *            member we expected. This is OUR defect.
 *   [3] reached it and got something else entirely - a 200, a captive portal, an
 *       HTML error page
 *         -> `external_endpoint_unexpected`, exit 1. Reported as its own case; it is
 *            silently neither of the other two.
 *
 * The judgement itself is the pure `judgeProviderFailureClassification` export, so
 * every one of those branches is exercised offline by the sibling test rather than
 * only argued for in this comment. Two of them can also be driven LIVE, because a
 * branch that has never been seen to fire is a branch nobody has seen fire:
 *
 *   node tools/live-run/chat/run-provider-failure-classification-live.mjs
 *     the real endpoint -> `verified`, exit 0
 *   node ... --endpoint http://127.0.0.1:1/v1
 *     a real connection refusal -> `external_endpoint_unreachable`, exit 0
 *   node ... --endpoint <any endpoint that answers 200 to /models>
 *     -> `external_endpoint_unexpected`, exit 1
 *
 * When the reply is not a refusal no turn is driven at all, so the report can never
 * imply a measurement nothing was measured for.
 *
 * ## The credential
 *
 * `FAKE_API_KEY` is a literal below and is the ONLY credential this file can use. A
 * `DEEPSEEK_API_KEY` in the operator's environment is refused by name before any
 * request is made, so running this locally with a real key exported cannot cost
 * anyone money. The value is asserted back out of the product's own store before the
 * turn, and the run root's credential files - `auth.json` and the per-connection key
 * file - are deleted when the run ends (see `removeRunRoot` for why the tree itself
 * is only best-effort).
 *
 * The response body is kept only as a bounded (`EVIDENCE_BODY_MAX_CHARS`), redacted
 * slice: a provider body is third-party bytes and this is an evidence line, not a
 * transcript. Request headers are never printed.
 *
 * Requirements: `host/dist-test` (the compiled artifact the live harness family runs
 * against) and a built Magic Context package, and network access to
 * `api.deepseek.com`. Missing an artifact, the runner refuses by name instead of
 * reporting a verdict it did not measure.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { redactLiveRunSecrets } from "../core/capture-text.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST_TEST_ROOT = join(REPOSITORY_ROOT, "host", "dist-test");
const DIALOGUE_WEB_SOURCE = join(REPOSITORY_ROOT, "dialogue-web", "src");

/** The endpoint under judgement. A real, third-party service this product does not run. */
export const ENDPOINT = "https://api.deepseek.com/v1";
export const MODEL_ID = "deepseek-chat";
/**
 * The credential this runner uses, and the ONLY one it can use.
 *
 * Obviously fake on purpose: a prefix that says so, a body with no entropy, and it is
 * never read from the environment. A real key that looked like a key would make a
 * wrong-status run indistinguishable from a real charge.
 */
export const FAKE_API_KEY = "sk-invalid-gamebuddy-probe";
/** The environment variable a real DeepSeek key would live in. Its presence is a refusal. */
const REAL_KEY_VARIABLE = "DEEPSEEK_API_KEY";

/** How much of the endpoint's own reply is kept, after redaction. */
export const EVIDENCE_BODY_MAX_CHARS = 400;
/** Hard ceiling on what is read off the wire, so a hostile body cannot be buffered whole. */
const EVIDENCE_READ_MAX_BYTES = 8_192;
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * How long the run root's tree removal may take before the report says it survived.
 *
 * See `removeRunRoot`: the embedded Magic Context SQLite handle stays open in this
 * process, so on Windows the tree cannot be unlinked until the process exits. Waiting
 * forever there would hang a runner whose every assertion had already passed.
 */
const RUN_ROOT_REMOVE_TIMEOUT_MS = 5_000;

/**
 * The class a credential refusal must produce. Named here, as a literal, because it is
 * this gate's PREMISE: an endpoint that answers 401 told us the credential was
 * refused, and a classifier that calls that something else has stopped meaning what
 * the surface's five sentences assume. `judgeProviderFailureClassification` reports a
 * drift of the mapping as its own state rather than blessing the new answer.
 */
const CREDENTIAL_REJECTED = "credential_rejected";
/** The class the whole change exists to stop inheriting. */
const ENDPOINT_UNREACHABLE = "endpoint_unreachable";
const RUNTIME_UNAVAILABLE = "runtime_unavailable";

/** The judgements this runner can reach. Every one of them is a distinct line in the report. */
export const PROBE_STATES = Object.freeze({
  verified: "verified",
  externalEndpointUnreachable: "external_endpoint_unreachable",
  externalEndpointUnexpected: "external_endpoint_unexpected",
  classificationMappingChanged: "classification_mapping_changed",
  classificationWrong: "classification_wrong",
  sentenceCollapsed: "sentence_collapsed",
});

/**
 * The exit code a state carries.
 *
 * Two of these are deliberately 0. An unreachable endpoint is an INCONCLUSIVE run -
 * it measured nothing about our classification - and an inconclusive run that turns
 * CI red teaches everyone to ignore this gate. Every other failure is ours and says
 * so.
 */
export function exitCodeFor(state) {
  if (state === PROBE_STATES.verified) return 0;
  if (state === PROBE_STATES.externalEndpointUnreachable) return 0;
  return 1;
}

/**
 * Whether this observation is the reply this gate knows how to read: a refusal, in JSON.
 *
 * Exported because the runner needs the same answer for a different reason: when there is nothing to
 * classify, no turn is driven at all, so the report cannot imply one was. One predicate, two callers -
 * a second spelling of this condition is how a runner starts measuring a turn its judgement will ignore.
 */
export function reachedARefusal(evidence) {
  return evidence.reachability === "reached" && evidence.status >= 400 && evidence.jsonBody === true;
}

/**
 * Judge one observation of a real endpoint's refusal.
 *
 * Order is the whole argument, and each branch answers a different question:
 *
 *   1. did we even get a reply? (no -> inconclusive, not our defect)
 *   2. was the reply the kind of reply this gate knows how to read? (no -> its own case)
 *   3. does the Host's mapping still call a credential refusal a credential refusal?
 *   4. did THIS turn carry a cause at all, and was it that one?
 *   5. does the player's sentence read as that cause, and not as either of the two
 *      sentences it must not be confused with?
 *
 * A caller cannot reach `verified` by skipping a step: every branch returns before the
 * next is considered.
 */
export function judgeProviderFailureClassification(reading) {
  const { evidence, expectedClass, observedClass, sentence, runtimeUnavailableSentence, endpointUnreachableSentence } =
    reading;

  // [1] The network never delivered a reply. Nothing here is a statement about the
  // product, so the run is inconclusive rather than red.
  if (evidence.reachability !== "reached")
    return Object.freeze({
      state: PROBE_STATES.externalEndpointUnreachable,
      reason: `network_did_not_reach_endpoint:${evidence.failure ?? "unknown"}`,
    });

  // [2] Reached, but not with a reply this gate can read: a 2xx (the fake key was
  // accepted, which contradicts the premise), or a body that is not JSON (a captive
  // portal, a proxy's HTML error page, an interstitial). Neither is a credential
  // refusal and neither is "unreachable"; saying so is the point.
  if (!reachedARefusal(evidence))
    return Object.freeze({
      state: PROBE_STATES.externalEndpointUnexpected,
      reason: evidence.status < 400 ? "endpoint_accepted_the_invalid_key" : "endpoint_replied_without_a_json_error",
    });

  // [3] The mapping itself. Checked before our turn's answer so a changed mapping is
  // reported as a changed mapping, not as a turn that classified correctly against a
  // premise nobody states any more.
  if (expectedClass !== CREDENTIAL_REJECTED)
    return Object.freeze({
      state: PROBE_STATES.classificationMappingChanged,
      reason: `a_${evidence.status}_no_longer_classifies_as_${CREDENTIAL_REJECTED}:${expectedClass ?? "nothing"}`,
    });

  // [4] The durable cause. `undefined`/`null` here IS the original defect: the cause
  // was read and then thrown away, and the player got the five-cause paragraph.
  if (observedClass === null || observedClass === undefined)
    return Object.freeze({
      state: PROBE_STATES.classificationWrong,
      reason: "no_provider_failure_recorded_on_the_durable_turn",
    });
  if (observedClass === ENDPOINT_UNREACHABLE)
    return Object.freeze({
      state: PROBE_STATES.classificationWrong,
      reason: `collapsed_into_${ENDPOINT_UNREACHABLE}`,
    });
  if (observedClass !== expectedClass)
    return Object.freeze({
      state: PROBE_STATES.classificationWrong,
      reason: `produced_${observedClass}_expected_${expectedClass}`,
    });

  // [5] The sentence. A correct class routed to the wrong words is the same defect one
  // layer up: the player still reads a paragraph that prescribes nothing.
  if (sentence === runtimeUnavailableSentence)
    return Object.freeze({
      state: PROBE_STATES.sentenceCollapsed,
      reason: `reads_the_${RUNTIME_UNAVAILABLE}_sentence`,
    });
  if (sentence === endpointUnreachableSentence)
    return Object.freeze({
      state: PROBE_STATES.sentenceCollapsed,
      reason: `reads_the_${ENDPOINT_UNREACHABLE}_sentence_while_the_endpoint_answered`,
    });
  return Object.freeze({ state: PROBE_STATES.verified, reason: null });
}

class RunnerBlocked extends Error {
  constructor(reason, detail) {
    super(reason);
    this.detail = detail;
  }
}

const loadTestModule = (module) => import(pathToFileURL(join(HOST_TEST_ROOT, module)).href);

async function loadProduct() {
  if (!existsSync(join(HOST_TEST_ROOT, "runtime.js")))
    throw new RunnerBlocked(
      "host_dist_test_missing",
      `build it with: pnpm --dir host build:test (expected ${HOST_TEST_ROOT})`,
    );
  const runtime = await loadTestModule("runtime.js");
  const extensionEntry = runtime.resolveMagicContextExtensionEntry();
  if (!existsSync(extensionEntry))
    throw new RunnerBlocked("magic_context_build_missing", `the Host resolves ${extensionEntry}, which is not there`);
  const [
    { loadHostDeploymentManifest },
    coordinator,
    { TavernConnectionStore },
    { createTavernConnectionService },
    { TAVERN_ESCAPE_HATCH_PROVIDER_ID, catalogProvider },
    { ModelProfileStore },
    { createPlayerTurnAcceptor },
    { createProviderAttemptClaimer },
    { startMountedChatProvider },
    { createReferencePipelineStateFacade },
    { composeTavernProfile },
    { classifyProviderFailure },
    pathLock,
    reclaimer,
    { messages },
    { turnFailureText },
  ] = await Promise.all([
    loadTestModule("deployment-manifest.js"),
    loadTestModule("continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js"),
    loadTestModule("tavern/connection-store.js"),
    loadTestModule("tavern/connection-service.js"),
    loadTestModule("tavern/provider-catalog.js"),
    loadTestModule("settings/model-profile-store.js"),
    loadTestModule("tavern/player-turn-acceptance.js"),
    loadTestModule("tavern/provider-attempt-claim.js"),
    loadTestModule("tavern/chat-provider-start.js"),
    loadTestModule("tavern/reference-pipeline-state.js"),
    loadTestModule("tavern/browser-contract/index.js"),
    loadTestModule("provider-failure-classification.js"),
    loadTestModule("path-lock.js"),
    loadTestModule("windows-stale-lock-reclaimer/index.js"),
    import(pathToFileURL(join(DIALOGUE_WEB_SOURCE, "i18n.ts")).href),
    import(pathToFileURL(join(DIALOGUE_WEB_SOURCE, "components", "turn-failure-text.ts")).href),
  ]);
  pathLock.bindWindowsStaleLockReclaimer(await reclaimer.createBuildWindowsStaleLockReclaimer());
  const provider = catalogProvider(TAVERN_ESCAPE_HATCH_PROVIDER_ID);
  if (provider === null)
    throw new RunnerBlocked(
      "escape_hatch_provider_missing",
      `the catalog no longer declares ${TAVERN_ESCAPE_HATCH_PROVIDER_ID}`,
    );
  return {
    createCompanionRuntime: runtime.createCompanionRuntime,
    resolveRuntimePaths: runtime.resolveRuntimePaths,
    identityKey: runtime.identityKey,
    loadHostDeploymentManifest,
    createFreshChatAuthority: coordinator.createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
    TavernConnectionStore,
    createTavernConnectionService,
    providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
    providerSetupFields: [...provider.setupFields],
    ModelProfileStore,
    createPlayerTurnAcceptor,
    createProviderAttemptClaimer,
    startMountedChatProvider,
    createReferencePipelineStateFacade,
    composeTavernProfile,
    classifyProviderFailure,
    messages,
    turnFailureText,
  };
}

/**
 * A refusal when the operator's own key is exported.
 *
 * The runner can prove what IT passes, but it cannot prove this product's resolution
 * path will not reach an environment credential somewhere below it. Renaming the
 * variable to `DEEPSEEK_API_KEY` is the obvious mistake and the expensive one, so the
 * presence of a real key is answered with a named refusal before any request.
 */
export function assertFakeCredentialOnly(environment) {
  if (FAKE_API_KEY.includes("invalid") !== true) throw new Error("probe_credential_is_not_obviously_fake");
  const real = environment[REAL_KEY_VARIABLE];
  if (typeof real === "string" && real.length > 0)
    throw new RunnerBlocked(
      "real_credential_in_environment",
      `${REAL_KEY_VARIABLE} is set; this probe must never spend a real key. Unset it and run again.`,
    );
}

/**
 * Read the endpoint's own reply, bounded and with the status kept.
 *
 * Deliberately the request the product's own probe makes (`GET <base>/models` with a
 * bearer token, `host/src/tavern/connection-probe.ts:51-58`), because the status of
 * THAT request is what the three-way distinction is about. Nothing here is a second
 * implementation of the probe: the product's probe runs afterwards, and its closed
 * outcome is reported beside this.
 */
export async function readEndpointEvidence({ baseUrl, apiKey, transport = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  try {
    const response = await transport(`${baseUrl}/models`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    });
    const text = await readBoundedText(response);
    return Object.freeze({
      reachability: "reached",
      failure: null,
      status: response.status,
      contentType: response.headers.get("content-type"),
      jsonBody: parsesAsJson(text),
      bodyChars: text.length,
      redactedBody: redactLiveRunSecrets(text, { maxChars: EVIDENCE_BODY_MAX_CHARS }),
    });
  } catch (error) {
    return Object.freeze({
      reachability: "unreachable",
      failure: networkFailureName(error),
      status: null,
      contentType: null,
      jsonBody: false,
      bodyChars: 0,
      redactedBody: "",
    });
  }
}

async function readBoundedText(response) {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < EVIDENCE_READ_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parsesAsJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The layer a network failure happened at, as a closed word. It never carries the URL. */
function networkFailureName(error) {
  const code = error?.cause?.code ?? error?.code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED") return "tcp_refused";
  if (code === "ECONNRESET" || code === "EPIPE") return "tcp_reset";
  if (typeof code === "string" && /CERT|SSL|TLS/i.test(code)) return "tls";
  return "transport";
}

/**
 * One real turn through the product's own path, against the endpoint the record names.
 *
 * Accept -> claim -> provider start is exactly the three calls
 * `chat-pipeline-service.ts:877-880` (`startOnce`) makes for a submitted turn; the
 * service contributes HTTP framing and event publication, not turn logic, and none of
 * that changes what the ledger holds.
 */
async function runOneTurn({ product, manifest, lease }) {
  const accepted = await product.createPlayerTurnAcceptor(manifest, lease).accept({
    text: "Good morning. How are you today?",
    locale: "en",
    idempotencyKey: "providerfailureprobe01",
    expectedDraftRevision: 0,
  });
  if (accepted.status !== "accepted_queued")
    throw new Error(`provider_failure_probe_accept_unexpected:${accepted.status}`);
  const claimed = await product.createProviderAttemptClaimer(manifest, lease).claim();
  if (claimed.status !== "attempt_starting")
    throw new Error(`provider_failure_probe_claim_unexpected:${claimed.status}`);
  return await product.startMountedChatProvider(manifest, lease);
}

/**
 * Take the run root's credentials away, and then try to take the root.
 *
 * The credential half is the promise this file makes, and it is kept unconditionally:
 * `auth.json` and the per-connection key file are deleted first, so the placeholder
 * cannot outlive the process even if the tree survives.
 *
 * The tree half is bounded rather than awaited forever. The mounted runtime leaves the
 * embedded Magic Context SQLite file open in THIS process, so a recursive delete on
 * Windows cannot unlink it until the process exits - measured: the same directory
 * removes in 3 ms once the process is gone, and never while it runs. An unbounded await
 * there made the probe hang after every assertion had already passed, which is a worse
 * outcome than a leftover temp directory: a runner that never exits reports nothing. So
 * the attempt gets `RUN_ROOT_REMOVE_TIMEOUT_MS`, and a root that survived is named in
 * the report instead of hidden.
 */
/**
 * Remove run roots left behind by earlier invocations of this probe.
 *
 * `removeRunRoot` below explains why the current run's root cannot be unlinked in-process: the mounted
 * runtime leaves the embedded Magic Context SQLite file open in THIS process, and the package exports
 * no close for it. So the fix cannot be a better `finally` here, and it must not be a close we do not
 * have - that would be a wrapper over an owning layer.
 *
 * Sweeping at the next start bounds the accumulation at one root, costs nothing, and prints the count so
 * a root that will not go away is visible rather than swallowed.
 */
async function sweepStaleRunRoots({ base, log }) {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return;
  }
  const stale = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("gb-provider-failure-probe-"));
  if (stale.length === 0) return;
  let swept = 0;
  for (const entry of stale) {
    try {
      await rm(join(base, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      swept += 1;
    } catch {
      // Still held by whatever holds it; the next run tries again.
    }
  }
  log(`stale roots : swept ${swept} of ${stale.length} left by earlier runs`);
}

async function removeRunRoot({ root, agentDir, log }) {
  const credentialFiles = ["auth.json", "tavern-connection-keys.json", "tavern-connections.json"];
  const wiped = [];
  for (const name of credentialFiles) {
    try {
      await rm(join(agentDir, name), { force: true });
      wiped.push(name);
    } catch {
      // A file that is not there was never a credential of this run.
    }
  }
  log(`credentials  : removed ${wiped.length === 0 ? "nothing present" : wiped.join(", ")}`);
  let timer;
  const removed = await Promise.race([
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).then(
      () => true,
      () => false,
    ),
    new Promise((done) => {
      timer = setTimeout(() => done(false), RUN_ROOT_REMOVE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  log(`run root    : ${removed ? "removed" : `NOT removed (a handle is still open in this process) - ${root}`}`);
}

/**
 * The whole run, as a value.
 *
 * Kept separate from `main` so a caller can take the reading without the printing,
 * and so the runner's own module can be imported (by the sibling test) without any
 * network in reach. `endpoint` is a parameter because the three branches must be
 * demonstrable, not merely argued: the default is the real service this gate is about,
 * and a caller that points it at a closed port (`http://127.0.0.1:1/v1`) sees the
 * INCONCLUSIVE branch on a real transport failure rather than an injected one.
 */
export async function runLiveRun({
  endpoint = ENDPOINT,
  environment = process.env,
  transport = fetch,
  log = () => {},
} = {}) {
  assertFakeCredentialOnly(environment);
  const product = await loadProduct();
  // The escape hatch is the only entry whose endpoint, API shape and credential the player
  // supplies. If the catalog stopped advertising those fields, this probe would be writing a
  // record the product no longer accepts - so the fact is asserted, not assumed.
  for (const field of ["baseUrl", "apiShape", "apiKey", "modelId"])
    if (!product.providerSetupFields.includes(field))
      throw new RunnerBlocked("escape_hatch_field_missing", `${product.providerId} no longer declares ${field}`);

  const base = process.platform === "win32" ? (process.env.LOCALAPPDATA ?? tmpdir()) : tmpdir();
  await sweepStaleRunRoots({ base, log });
  const root = await mkdtemp(join(await realpath(base), "gb-provider-failure-probe-"));
  const principal = Object.freeze({
    playerId: "player_provider_failure_probe",
    companionId: "companion_provider_failure_probe",
    continuityId: "continuity_provider_failure_probe",
  });
  const paths = product.resolveRuntimePaths(principal, root, "surface_provider_failure_probe");
  let authority;
  let facade;
  try {
    await mkdir(root, { recursive: true });
    const manifestPath = join(root, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        topology: "independent_chat_and_game_surfaces",
        runtimeRoot: root,
        principal,
        bootstrapOperationId: "bootstrap_provider_failure_probe",
        authorityGeneration: 1,
      }),
    );
    const manifest = await product.loadHostDeploymentManifest(manifestPath);

    // [1] The endpoint's own reply, and the product's own Test path against the same record.
    const evidence = await readEndpointEvidence({ baseUrl: endpoint, apiKey: FAKE_API_KEY, transport });
    log(
      `endpoint    : GET ${endpoint}/models -> ${evidence.reachability === "reached" ? `HTTP ${evidence.status}` : `UNREACHABLE (${evidence.failure})`}`,
    );

    const service = product.createTavernConnectionService({ agentDir: paths.agentDir });
    let probeOutcome;
    let connectionId;
    try {
      const created = await service.create({
        apiVersion: 1,
        providerId: product.providerId,
        apiKey: FAKE_API_KEY,
        baseUrl: endpoint,
        apiShape: "openai-completions",
        modelId: MODEL_ID,
      });
      const record = created.connections[0];
      if (record === undefined) throw new Error("provider_failure_probe_connection_missing");
      connectionId = record.connectionId;
      const tested = await service.test(record.connectionId, created.revision);
      probeOutcome = Object.freeze({ outcome: tested.outcome, failure: tested.failure });
      log(`product test: ${tested.outcome}${tested.failure === null ? "" : `/${tested.failure}`}`);
    } finally {
      await service.close();
    }

    // The credential the product will actually send is the one asserted here. A resolution
    // path that reached anything else would be a real key on a real charge.
    const store = new product.TavernConnectionStore(paths.agentDir);
    const document = await store.read();
    const record = document.connections.find((entry) => entry.connectionId === connectionId);
    if (record === undefined) throw new Error("provider_failure_probe_connection_unreadable");
    const resolvedCredential = await store.credentialFor(record);
    if (resolvedCredential !== FAKE_API_KEY)
      throw new RunnerBlocked(
        "probe_credential_not_the_fake_one",
        `the product resolves ${resolvedCredential === null ? "no credential" : "a value this probe did not supply"}; refusing before a request is made`,
      );

    // [2] One real turn, and ONLY when there is something for it to classify. When the
    // endpoint never answered, or answered with something that is not a refusal, the
    // judgement is already decided by the reply itself - driving a turn there would cost a
    // runtime and let the report imply a measurement nothing was measured for. One
    // predicate decides this here and in the judgement, so the two cannot disagree.
    const measurable = reachedARefusal(evidence);
    const labels = product.messages("en");
    const runtimeUnavailableSentence = product.turnFailureText(RUNTIME_UNAVAILABLE, labels);
    const endpointUnreachableSentence = product.turnFailureText(RUNTIME_UNAVAILABLE, labels, ENDPOINT_UNREACHABLE);
    let started;
    let turn = null;
    let observedClass = null;
    let problemCode = null;
    if (measurable) {
      const profile = await new product.ModelProfileStore(join(root, "settings", "model-profiles.json")).update(
        "chat",
        0,
        { thinkingLevel: "off", modelId: MODEL_ID, providerId: product.providerId },
      );
      log(`chat profile: ${profile.providerId}/${profile.modelId} @ ${profile.thinkingLevel}`);

      authority = await product.createFreshChatAuthority(manifest);
      const lease = await authority.startMountedChatRuntime();
      started = await runOneTurn({ product, manifest, lease });
      const chatProfile = product.composeTavernProfile({
        profileId: "gamebuddy.chat-core.reference-pipeline",
        releaseTier: "chat_core",
        routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status"],
        operationIds: ["chat.submit", "chat.cancel"],
        navigationItemIds: ["chat"],
      });
      facade = await product.createReferencePipelineStateFacade(manifest, lease, chatProfile);
      const state = await facade.read();
      turn = state.turn;
      observedClass = started.providerFailure ?? turn?.providerFailure ?? null;
      problemCode = turn?.problemCode ?? started.reasonCode ?? null;
      log(
        `durable     : ${started.status}/${started.reasonCode ?? "none"} providerFailure=${observedClass ?? "ABSENT"}`,
      );
      log(`browser     : ${turn?.state ?? "no turn"} problemCode=${problemCode ?? "none"}`);
    } else {
      log("no turn     : the reply was not a refusal, so there is nothing to classify");
    }
    const sentence = product.turnFailureText(problemCode ?? undefined, labels, observedClass ?? undefined);
    // The classifier applied to the status the endpoint actually returned: the gate's other
    // end. A mapping that moved moves this with it, which is how
    // `classification_mapping_changed` can be told apart from our turn getting it wrong.
    const expectedClass =
      evidence.reachability === "reached"
        ? (product.classifyProviderFailure(`${evidence.status}: ${evidence.redactedBody}`) ?? null)
        : null;

    const judgement = judgeProviderFailureClassification({
      evidence,
      expectedClass,
      observedClass,
      sentence,
      runtimeUnavailableSentence,
      endpointUnreachableSentence,
    });
    return Object.freeze({
      state: judgement.state,
      reason: judgement.reason,
      exitCode: exitCodeFor(judgement.state),
      evidence,
      probeOutcome,
      endpoint,
      modelId: MODEL_ID,
      providerId: product.providerId,
      credential: FAKE_API_KEY,
      expectedClass,
      observedClass,
      problemCode,
      sentence,
      runtimeUnavailableSentence,
      endpointUnreachableSentence,
      runRoot: root,
    });
  } finally {
    await facade?.close().catch(() => undefined);
    await authority?.close().catch(() => undefined);
    await removeRunRoot({ root, agentDir: paths.agentDir, log });
  }
}

function narrate(run) {
  const lines = [
    "one real endpoint's refusal, judged through the product's own chain",
    `  endpoint      : ${run.endpoint} (real, third-party; the key is ${run.credential})`,
    `  model         : ${run.modelId} via ${run.providerId}`,
    `  HTTP status   : ${run.evidence.reachability === "reached" ? run.evidence.status : `unreachable (${run.evidence.failure})`}`,
    `  product test  : ${run.probeOutcome?.outcome ?? "not reached"}${run.probeOutcome?.failure ? `/${run.probeOutcome.failure}` : ""}`,
    `  expected class: ${run.expectedClass ?? "not derived"}`,
    `  actual class  : ${run.observedClass ?? "ABSENT"}`,
    `  problem code  : ${run.problemCode ?? "none"}`,
    "",
    `  the player reads: ${run.sentence}`,
    "",
    `  (the sentence this replaced, for comparison) ${run.runtimeUnavailableSentence}`,
  ];
  if (run.state === PROBE_STATES.externalEndpointUnreachable)
    lines.push(
      "",
      "  INCONCLUSIVE: the endpoint did not answer, so nothing here is a statement about the",
      "  product's classification. Exit 0 on purpose - a red run for a reason that is not ours",
      "  is how a gate stops being read.",
    );
  else if (run.state === PROBE_STATES.externalEndpointUnexpected)
    lines.push(
      "",
      `  UNEXPECTED: reached the endpoint but could not read it as a credential refusal (${run.reason}).`,
      "  This is neither 'unreachable' nor 'classified wrong', and is reported as its own case.",
    );
  else if (run.state !== PROBE_STATES.verified)
    lines.push("", `  RED: ${run.reason} - this is our defect, not the network's.`);
  return lines.join("\n");
}

async function main(argv) {
  let endpoint = ENDPOINT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      process.stdout.write(
        "usage: node tools/live-run/chat/run-provider-failure-classification-live.mjs [--endpoint <base-url>] [--help]\n" +
          `  Points the product's escape-hatch connection at ${ENDPOINT} with a deliberately\n` +
          "  invalid key and asserts ONLY the failure classification:\n" +
          "    exit 0  verified, or the endpoint was unreachable (inconclusive)\n" +
          "    exit 1  reached it and classified the refusal wrongly, or it answered unexpectedly\n" +
          "    exit 2  an artifact this runner needs is missing, or a real key is exported\n\n" +
          "  --endpoint <base-url>  judge another endpoint. Point it at a closed port\n" +
          "                         (http://127.0.0.1:1/v1) to see the INCONCLUSIVE branch on a\n" +
          "                         real transport failure, and at any served endpoint that answers\n" +
          "                         2xx to see the UNEXPECTED branch.\n",
      );
      return 0;
    }
    if (argument === "--endpoint" && index + 1 < argv.length) {
      endpoint = argv[(index += 1)];
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  let run;
  try {
    run = await runLiveRun({ endpoint, log: (line) => process.stdout.write(`  ${line}\n`) });
  } catch (error) {
    if (error instanceof RunnerBlocked) {
      process.stderr.write(`BLOCKED ${error.message}: ${error.detail}\n`);
      return 2;
    }
    throw error;
  }
  process.stdout.write(`${narrate(run)}\n`);
  process.stdout.write(
    `\n${JSON.stringify({
      state: run.state,
      reason: run.reason,
      status: run.evidence.status,
      reachability: run.evidence.reachability,
      bodyChars: run.evidence.bodyChars,
      bodyEvidence: run.evidence.redactedBody,
      expectedClass: run.expectedClass,
      observedClass: run.observedClass,
      problemCode: run.problemCode,
    })}\n`,
  );
  return run.exitCode;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
