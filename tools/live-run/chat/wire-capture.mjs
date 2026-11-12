/**
 * The prompt-bytes reading: the product's own escape-hatch provider mounted against a local OpenAI-compatible stub,
 * so a run can assert what the product actually SENT rather than only what came back.
 *
 * Off unless `GAMEBUDDY_CHAT_WIRE_CAPTURE=1`, and never a model's reply: the stub answers one fixed line. Every run
 * that mounts it says so in its own output, because that sentence is the whole qualification of the evidence.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { judgeObserved as judgeWireObserved } from "../core/evidence-verdict.mjs";
import { safeReasonCode, sha256 } from "./chat-audit-values.mjs";
import {
  bindHostPathLock,
  HOST_ROOT,
  loadHostConnectionProbe,
  loadHostConnectionStore,
  loadHostProviderCatalog,
} from "./host-build-modules.mjs";
import { foreignMagicContextStore } from "./provider-admission.mjs";
import { wireMessageText } from "./wire-contract.mjs";
// ── The prompt-bytes reading: what the model was actually TOLD ──
//
// Everything above measures the RUN; none of it measures the REQUEST. The stderr markers are Class B
// diagnostics and the trace is content-free by construction, so today the only prompt-layer evidence is three Magic
// Context markers (`[probe:m0_memory_ids]`, `[probe:m0_digest]`, `[probe:m0_sources]`): they say a `m[0]` was
// materialized and give its digest, and they say NOTHING about the system prompt, the tool declarations, or the
// message array the product handed Pi. That is the effect half of the question - not "did a marker fire" but "what
// bytes went out" - and it is exactly what `tools/live-run/chat/run-post-history-live.mjs` settles for one field by
// serving its own OpenAI-compatible endpoint.
//
// So this mode mounts the same endpoint
// (`tools/live-run/core/stub-provider.mjs`) through the product's OWN escape-hatch provider
// (`gamebuddy-openai-compatible`, the entry a player uses for a custom host), records the connection through the
// product's own probe and store, and reads the request bodies Pi actually posted.
//
// TWO THINGS IT IS NOT. It is OFF BY DEFAULT (`GAMEBUDDY_CHAT_WIRE_CAPTURE=1` turns it on), because a stub silently
// replacing real-model evidence for every existing run would retire the one thing those runs prove. And it is a
// STUB: no model is called, so the run asserts what the product SENDS, never what a model REPLIES
// (`tools/live-run/README.md` §4 and §6). Every run that mounts it says so in its own output, because that sentence
// is the whole qualification of the evidence it produces.
export const WIRE_CAPTURE_ENV = "GAMEBUDDY_CHAT_WIRE_CAPTURE";
/** The product's own escape hatch: a local OpenAI-compatible endpoint with a chosen model id (design/28 §1). */
export const WIRE_PROVIDER_ID = "gamebuddy-openai-compatible";
export const WIRE_MODEL_ID = "gamebuddy-wire-capture";
/** The one fixed reply the stub streams. Distinctive, and never asserted as a model's answer. */
export const WIRE_STUB_REPLY = "[wire-capture stub] The kettle is on.";
/** The reading's own envelope name: one run's prompt-bytes observation, never a lifecycle fact. */
export const WIRE_READING_SCHEMA = "chat_run_audit/wire-reading/v1";

/**
 * Whether this process is in wire-capture mode. Read from the environment like the run's other switches, and OFF
 * unless the value is exactly `1`: a typo must leave the run measuring a real provider rather than silently
 * replacing it.
 */
export function wireCaptureRequested(env = process.env) {
  return env?.[WIRE_CAPTURE_ENV] === "1";
}

/**
 * One wire message's text, from a string or from the text parts of a structured content array.
 *
 * The shape matters: Pi's `openai-completions` adapter posts `content` as an array of parts on some turns and as a
 * bare string on others, so a reading that assumes either one sees `undefined` on the other.
 *
 * The ONE spelling lives in `wire-contract.mjs`, which is the module that reads message text for a judgement;
 * this harness re-exports it so its own readers keep one import site.
 */
export { wireMessageText } from "./wire-contract.mjs";

const AUTHORED_CONTEXT_MARKER = '<gamebuddy-authored-context version="v2"';

const wireBytes = (value) => (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0);
const wireJson = (value) => JSON.stringify(value ?? null);

/**
 * One captured request, as a READING: sizes and digests, never the bytes themselves.
 *
 * Every field below may carry the player's own words - the system prompt is her persona, `m[0]` is her authored
 * context, the messages are the conversation - so this travels to the run directory and the log as measurements
 * only. That is not squeamishness: the frozen trace's content guard forbids prompt material, and a reading that
 * could only be compared by eye would be re-read rather than diffed.
 *
 * `m0` is the message the hosted Magic Context assembles the authored baseline INTO (it opens with
 * `<gamebuddy-authored-context`), not "the first message": the system prompt is m[0] on a transport Pi builds
 * itself, so naming it by position would silently measure the wrong thing on the turn it moved.
 * `tools/live-run/chat/run-post-history-live.mjs` makes the same distinction for the same reason.
 */
export function summariseWireRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const systemIndex = messages.findIndex((message) => message?.role === "system");
  const authoredIndex = messages.findIndex((message) => wireMessageText(message).includes(AUTHORED_CONTEXT_MARKER));
  const system = systemIndex < 0 ? undefined : messages[systemIndex];
  const authored = authoredIndex < 0 ? undefined : messages[authoredIndex];
  return Object.freeze({
    // The assembled system prompt: the Host's own instruction text for this surface.
    systemBytes: system === undefined ? 0 : wireBytes(wireMessageText(system)),
    systemSha256: system === undefined ? null : sha256(wireMessageText(system)),
    systemMessageIndex: systemIndex,
    // m[0]: the authored baseline Magic Context assembles, which is the prefix a turn may not disturb.
    m0Present: authored !== undefined,
    m0Bytes: authored === undefined ? 0 : wireBytes(wireMessageText(authored)),
    m0Sha256: authored === undefined ? null : sha256(wireMessageText(authored)),
    m0MessageIndex: authoredIndex,
    // The tool declarations exactly as the provider serializes them: the schema the model is handed.
    toolCount: tools.length,
    toolBytes: wireBytes(wireJson(tools)),
    toolSha256: tools.length === 0 ? null : sha256(wireJson(tools)),
    toolNames: Object.freeze(
      tools.map((tool) => (typeof tool?.function?.name === "string" ? tool.function.name : null)),
    ),
    // The whole conversation the model reads on this turn, and its parts.
    messageCount: messages.length,
    messagesBytes: wireBytes(wireJson(messages)),
    messageRoles: Object.freeze(messages.map((message) => (typeof message?.role === "string" ? message.role : null))),
  });
}

/**
 * Admit one WIRE-CAPTURE run: the same inherited-store refusal every run pays, and then a readiness fact that
 * really crossed the wire - the PRODUCT's own connection writer and probe, against the endpoint this process serves.
 *
 * The connection is recorded through the product's own store (`TavernConnectionStore`), which is the writer the
 * management surface uses and the one the runtime reads back when it resolves the escape hatch's endpoint; readiness
 * is the product's own `probeTavernConnection` answering `/models`, not a flag this harness sets. A stub that is not
 * answering therefore refuses the run by name instead of launching a child whose every turn would fail.
 *
 * It is deliberately NOT a second `probeChatProviderReadiness`: that probe resolves a CHAT profile that names the
 * environment provider from `models.json`/`auth.json`, while an escape-hatch record's endpoint and API shape live in
 * the connection document - the same two files, read by the one owner that knows the escape hatch exists.
 */
export async function admitWireCaptureRun({ runtimeRoot, agentDir, stub, env = process.env }) {
  const foreign = foreignMagicContextStore({ runtimeRoot, env });
  if (foreign !== null)
    return Object.freeze({ ok: false, stage: "magic_context_store", refusal: foreign, readiness: null });
  let document;
  try {
    const { TavernConnectionStore } = await loadHostConnectionStore();
    const { probeTavernConnection } = await loadHostConnectionProbe();
    const { catalogProvider } = await loadHostProviderCatalog();
    await bindHostPathLock();
    const store = new TavernConnectionStore(agentDir);
    document = await store.create({
      providerId: WIRE_PROVIDER_ID,
      // A placeholder, never a credential: the endpoint is this process's own loopback server.
      apiKey: "wire-capture-placeholder",
      baseUrl: stub.baseUrl,
      apiShape: "openai-completions",
      modelId: stub.modelId,
    });
    const record = document.connections.find(
      (entry) => entry.providerId === WIRE_PROVIDER_ID && entry.modelId === stub.modelId,
    );
    if (record === undefined) throw new Error("wire_capture_connection_missing");
    const provider = catalogProvider(WIRE_PROVIDER_ID);
    const result = await probeTavernConnection({
      provider,
      baseUrl: stub.baseUrl,
      apiKey: "wire-capture-placeholder",
      apiKeyRequired: true,
      modelId: stub.modelId,
    });
    if (result.outcome !== "ready")
      return Object.freeze({
        ok: false,
        stage: "wire_provider_readiness",
        refusal: `wire_capture_provider_not_ready:${result.failure}`,
        readiness: null,
      });
    document = await store.recordProbe(record.connectionId, result);
    const active = await store.activate(record.connectionId, document.revision);
    return Object.freeze({
      ok: true,
      stage: "ready",
      refusal: null,
      readiness: Object.freeze({
        provider: WIRE_PROVIDER_ID,
        model: stub.modelId,
        reason: "ready",
        baseUrl: stub.baseUrl,
        // The product's own decision, not this harness's: the record is written, probed and active in the exact
        // document the child reads back.
        connections: active.connections.length,
      }),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      stage: "wire_connection_failed",
      refusal: `wire_capture_connection_failed:${safeReasonCode(error)}`,
      readiness: null,
    });
  }
}

/**
 * The two product declarations a wire-contract reading sources its population and its anchor from.
 *
 * Read from the Host build the harness family already runs against rather than written here: the Game tool
 * names are a closed registry projection, and the floor anchor is the one asterisk form the Chat surface
 * teaches. A hand-written copy of either would keep asserting a list the product stopped shipping.
 */
export async function loadWireContractAnchors() {
  const [{ STARDEW_ACTION_TOOL_NAMES }, { COMPANION_ACTION_SYNTAX }] = await Promise.all([
    import(pathToFileURL(join(HOST_ROOT, "dist-test", "action-registry.js")).href),
    import(pathToFileURL(join(HOST_ROOT, "dist-test", "identity-profile.js")).href),
  ]);
  return Object.freeze({
    gameToolNames: Object.freeze(Object.values(STARDEW_ACTION_TOOL_NAMES)),
    houseFloor: COMPANION_ACTION_SYNTAX,
  });
}

/**
 * What the run printed about the trade, and the reading it printed it beside. One function so the qualification and
 * the numbers can never be separated in the log: a stubbed provider means this run asserts what the product SENDS,
 * never what a real model replies (`tools/live-run/README.md` §4 and §6).
 */
export function narrateWireTrade(stub) {
  return (
    `[chat-live-audit] wire provider=STUB endpoint=${stub.baseUrl} model=${stub.modelId}\n` +
    "  this run asserts what the product SENDS, never what a real model replies"
  );
}

export function narrateWireReading(reading) {
  if (reading.state !== "verified")
    return `[chat-live-audit] wire provider=STUB state=${reading.state} reason=${reading.reason} - no request was captured`;
  const lines = [
    `[chat-live-audit] wire provider=STUB endpoint=${reading.baseUrl} model=${reading.modelId}`,
    "  a stubbed provider: this run asserts what the product SENDS, never what a real model replies",
    `  requests=${reading.requestsReceived} of ${reading.turnsDrove} turn(s) driven`,
  ];
  for (const turn of reading.readings) {
    lines.push(
      `  request ${turn.requestIndex}: system=${turn.systemBytes}B (sha256 ${turn.systemSha256})` +
        ` m[0]=${turn.m0Present ? `${turn.m0Bytes}B (sha256 ${turn.m0Sha256})` : "absent"}` +
        ` tools=${turn.toolCount} (${turn.toolBytes}B)` +
        ` messages=${turn.messageCount} (${turn.messagesBytes}B)`,
    );
  }
  return lines.join("\n");
}

/**
 * The wire reading for a run, from the requests the stub was handed.
 *
 * `unobserved` is a real answer and the reason travels with it: a run asked for wire capture and got no request
 * (the turn never reached the provider) must not publish an empty reading that a reader would take for "the request
 * carried nothing". The verdict vocabulary is `tools/live-run/core/evidence-verdict.mjs`'s, not a second one.
 */
export function buildWireReading({ requested, provider, turnsDrove = 0 }) {
  const requests = Array.isArray(provider?.requests) ? provider.requests : [];
  const bodies = requests.map((request) => request?.body).filter((body) => body !== undefined);
  const verdict = judgeWireObserved({
    observed: requested === true && bodies.length > 0,
    ok: requested === true && bodies.length > 0,
    reason: requested === true ? "provider_received_no_request" : "wire_capture_not_requested",
  });
  return Object.freeze({
    schema: WIRE_READING_SCHEMA,
    state: verdict.state,
    reason: verdict.reason,
    // The product's own escape hatch, and the id this stub served: a reader can tell a stubbed run from a real
    // one by this alone, which is why it is published even when nothing was captured.
    providerId: WIRE_PROVIDER_ID,
    baseUrl: typeof provider?.baseUrl === "string" ? provider.baseUrl : null,
    modelId: typeof provider?.modelId === "string" ? provider.modelId : null,
    // How many turns the run drove and how many requests the stub actually answered, so a run whose second turn
    // never reached the wire is visible instead of looking like a one-turn conversation.
    turnsDrove: Number.isSafeInteger(turnsDrove) ? turnsDrove : 0,
    requestsReceived: bodies.length,
    readings: Object.freeze(
      bodies.map((body, index) => Object.freeze({ requestIndex: index + 1, ...summariseWireRequest(body) })),
    ),
  });
}
