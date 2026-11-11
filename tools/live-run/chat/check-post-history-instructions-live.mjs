#!/usr/bin/env node
/**
 * The card's `post_history_instructions` on a REAL Chat turn: the block is re-read per
 * turn, and the cached prefix's bytes do not move.
 *
 * The fork's unit tests already prove the append against a synthetic array (the block is
 * last, the card's prose is verbatim, a card that declares nothing is a byte-identical
 * no-op, one shared 4 KB bound). Two things they cannot prove, and this script settles:
 *
 *   [1] the SECOND TURN. The field is edited between turns; the next request must carry
 *       the NEW text and none of the old. That is the only mechanical difference between
 *       a per-turn block and one that has been folded into something cached.
 *   [2] the PREFIX's bytes. `m[0]` and the stable publication hash must be identical to a
 *       card that declares nothing at all - printed side by side, not asserted silently.
 *
 * How it drives the product - one real stack, three turns, one session:
 *
 *   1. a real runtime root (`createCompanionRuntime`, surface `chat`, `noTools: "all"`):
 *      the product's own construction, which writes `models.json`, mounts Magic Context
 *      and opens the Pi session;
 *   2. a real Tavern connection record (`TavernConnectionStore`) whose endpoint is a LOCAL
 *      OPENAI-COMPATIBLE ENDPOINT this script serves - the product's own escape hatch -
 *      so the runtime posts a genuine provider request through Pi's own
 *      `openai-completions` adapter;
 *   3. the authored catalogue, published through `publishGameBuddyAuthoredStableCatalog`
 *      and replaced through `replaceGameBuddyAuthoredStableCatalog`, the two calls the
 *      Host's Chat construction makes;
 *   4. three turns of `session.prompt()`, capturing the exact request body each time.
 *
 * THE PROVIDER IS A STUB. It streams one fixed reply and records the body. The model is
 * stubbed; the assembly is not, and the assembly is what is under test here.
 *
 *   node tools/live-run/chat/check-post-history-instructions-live.mjs
 *   node tools/live-run/chat/check-post-history-instructions-live.mjs --declared-field=""   # must be RED
 *
 * `--declared-field=""` models the card that declares nothing - the Host records nothing
 * for such a card, so nothing is published - and the run must then FAIL. That is how this
 * check proves it is not vacuous.
 *
 * Requirements: `host/dist-test` (the compiled artifact the live harness family already
 * runs against) and a built Magic Context package. Missing either, the script refuses by
 * name instead of reporting a verdict it did not measure.
 *
 * NOT WIRED TO ANY SCRIPT, and superseded. This is the earlier instrument of the same name's
 * family: `run-post-history-live.mjs` beside it runs the same three turns through the product's
 * own writer (`writeCompanionPostHistoryInstructions`) and materializer
 * (`materializeTavernAuthoredStableCatalog`), keeps the SECOND TURN and PREFIX readings below, and
 * adds `tailBlock` and `record`. That one is what `run:post-history-live` and `test:post-history-live`
 * run. This file lives here rather than in `tools/` because `tools/check-*.mjs` is the
 * `audit:gate-red-proofs` gate population - a draft in that directory is recorded in the baseline and
 * then reads as a stale entry on every checkout that does not have it.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST_TEST_ROOT = join(REPOSITORY_ROOT, "host", "dist-test");

/** The card's closing direction, exactly as an author would write it. */
export const DECLARED_FIELD = "收束时只说一句家常话，别把镜头拉到旁白。";
/** The edited text: the "not cached" reading needs a second, different value. */
export const REVISED_FIELD = "收束时先道一声晚安，再停笔。";
const PROVIDER_ID = "gamebuddy-openai-compatible";
const MODEL_ID = "gamebuddy-post-history-check";
const STUB_REPLY = "她收下种子，没多问。";
const PROMPTS = ["早上好。", "我去镇上买点种子。", "种子买回来了。"];
const BLOCK_OPEN = "<character-closing-direction>";
const BLOCK_CLOSE = "</character-closing-direction>";
const AUTHORED_BLOCK_MARKER = '<gamebuddy-authored-context version="v2"';

class PostHistoryCheckBlocked extends Error {
  constructor(reason, detail) {
    super(reason);
    this.detail = detail;
  }
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const bytesOf = (value) => JSON.stringify(value);

/** One wire message's text: a string, or the text parts of a structured content array. */
export function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
}

function loadTestModule(module) {
  return import(pathToFileURL(join(HOST_TEST_ROOT, module)).href);
}

/**
 * The product's runtime construction, the Host's connection store, and the published
 * package's two bundle entries: the extension entry the session loads and the `tavern`
 * entry the Host publishes through. The second is derived from the first rather than
 * imported by name, because the extension entry is the one name the Host itself resolves.
 */
async function loadProduct() {
  if (!existsSync(join(HOST_TEST_ROOT, "runtime.js")))
    throw new PostHistoryCheckBlocked(
      "host_dist_test_missing",
      `build it with: pnpm --dir host build:test (expected ${HOST_TEST_ROOT})`,
    );
  const runtime = await loadTestModule("runtime.js");
  const extensionEntry = runtime.resolveMagicContextExtensionEntry();
  if (!existsSync(extensionEntry))
    throw new PostHistoryCheckBlocked(
      "magic_context_build_missing",
      `the Host resolves ${extensionEntry}, which is not there; build the vendored pi-plugin`,
    );
  const tavernEntry = join(dirname(extensionEntry), "tavern", "index.js");
  const [{ TavernConnectionStore }, pathLock, reclaimer, fixture, tavern] = await Promise.all([
    loadTestModule("tavern/connection-store.js"),
    loadTestModule("path-lock.js"),
    loadTestModule("windows-stale-lock-reclaimer/index.js"),
    loadTestModule("test-support/authored-context-catalog.test-support.js"),
    import(pathToFileURL(tavernEntry).href),
  ]);
  // The runtime writes its identity profile through the durable path lock, and the build
  // artifact is not a production one: mint the build-only reclaimer, exactly as the Host's
  // own runtime tests do before any runtime bootstrap.
  pathLock.bindWindowsStaleLockReclaimer(await reclaimer.createBuildWindowsStaleLockReclaimer());
  return {
    createCompanionRuntime: runtime.createCompanionRuntime,
    resolveRuntimePaths: runtime.resolveRuntimePaths,
    TavernConnectionStore,
    authoredContextCatalogFixture: fixture.authoredContextCatalogFixture,
    publish: tavern.publishGameBuddyAuthoredStableCatalog,
    replace: tavern.replaceGameBuddyAuthoredStableCatalog,
  };
}

/**
 * The stub provider: records every request body, then streams one fixed assistant reply in
 * the `openai-completions` shape Pi's own adapter parses. It answers any path and ignores
 * credentials on purpose - it is a measurement surface, not a provider.
 */
async function startStubProvider() {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      requests.push({ url: request.url, body: JSON.parse(raw) });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({
        id: "chatcmpl-post-history-check",
        object: "chat.completion.chunk",
        model: MODEL_ID,
        choices: [{ index: 0, delta: { role: "assistant", content: STUB_REPLY }, finish_reason: null }],
      });
      send({
        id: "chatcmpl-post-history-check",
        object: "chat.completion.chunk",
        model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 },
      });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  // A stub that kept the event loop alive would hang a check that has already measured
  // everything; the client's keep-alive sockets are dropped on close for the same reason.
  server.unref();
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/**
 * Drive three real turns on one real runtime and return what the provider received.
 *
 * The three turns are the experiment's three cells: the card declares no field at all, the
 * card declares the field, and the author edits the field. Every other input - runtime,
 * session, authored sources - is held fixed, so a byte that differs between the cells is
 * attributable to the field.
 */
export async function runLiveCheck(options = {}) {
  const declaredField = options.declaredField ?? DECLARED_FIELD;
  const revisedField = options.revisedField ?? REVISED_FIELD;
  const log = options.log ?? (() => {});
  const product = await loadProduct();
  const provider = await startStubProvider();
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  const root = await mkdtemp(join(await realpath(base), "gb-post-history-"));
  const identity = Object.freeze({
    playerId: "player_post_history",
    companionId: "companion_post_history",
    continuityId: "continuity_post_history",
  });
  const surfaceSessionId = "surface_post_history";
  let runtime;
  try {
    const paths = product.resolveRuntimePaths(identity, root, surfaceSessionId);
    const connections = new product.TavernConnectionStore(paths.agentDir);
    const connection = await connections.create({
      providerId: PROVIDER_ID,
      // A placeholder, never a credential: the endpoint is this script's own server.
      apiKey: "post-history-check-placeholder",
      baseUrl: provider.baseUrl,
      apiShape: "openai-completions",
      modelId: MODEL_ID,
    });
    if (connection.connections[0]?.readiness !== "configured")
      throw new Error("post_history_check_connection_not_configured");
    runtime = await product.createCompanionRuntime(
      identity,
      root,
      undefined,
      { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "off" },
      undefined,
      undefined,
      false,
      undefined,
      surfaceSessionId,
      undefined,
      "chat",
    );
    const piSessionId = runtime.sessionManager.getSessionId();
    if (typeof piSessionId !== "string" || piSessionId.length === 0)
      throw new Error("post_history_check_pi_session_unavailable");
    log(`runtime root : ${paths.runtimeCwd}`);
    log(`pi session   : ${piSessionId}`);

    const scope = Object.freeze({
      continuityId: identity.continuityId,
      sessionId: piSessionId,
      surface: "tavern",
      threadId: "thread_post_history",
      profile: Object.freeze({ profileId: "profile_post_history", revision: 1, canonicalHash: "a".repeat(64) }),
    });
    const sources = Object.freeze({
      stableSources: [
        Object.freeze({
          sourceId: "scenario_post_history",
          kind: "scenario",
          revision: "1",
          content: "A quiet tavern at dusk.",
          budgetTokens: 8,
          totalOrderKey: "0001",
          provenance: "check/post-history-instructions-live",
        }),
      ],
    });
    // The Host's own test support builds the catalogue the Host publishes: the canonical
    // hash is computed over the body, never invented. The closing direction is carried
    // BESIDE that hashed body - exactly the shape the package validates, and the reason
    // editing it cannot move the publication hash.
    const catalog = (field) => {
      const fixture = product.authoredContextCatalogFixture(scope, sources);
      if (field === undefined || field.length === 0) return fixture.catalog;
      return Object.freeze({ ...fixture.catalog, postHistoryInstructions: field });
    };

    const turns = [];
    const turn = async (label, publication, prompt) => {
      const before = provider.requests.length;
      await runtime.session.prompt(prompt);
      const received = provider.requests.slice(before);
      if (received.length !== 1)
        throw new Error(`post_history_check_provider_request_count:${label}:${received.length}`);
      turns.push(
        Object.freeze({
          label,
          prompt,
          publicationHash: publication.canonicalHash,
          messages: received[0].body.messages,
        }),
      );
    };

    // 1. A card that declares no field at all: the control side of the prefix reading.
    const absentCatalog = catalog(undefined);
    const absent = product.publish(scope, absentCatalog);
    await turn("card declares no field", absentCatalog, PROMPTS[0]);

    // 2. The same card, now declaring the field.
    const declaredCatalog = catalog(declaredField);
    const declared = product.replace(absent, scope, declaredCatalog);
    await turn("card declares the field", declaredCatalog, PROMPTS[1]);

    // 3. The author edits the field: only the NEXT turn may show it, and only in its tail.
    const revisedCatalog = catalog(revisedField);
    const revised = product.replace(declared, scope, revisedCatalog);
    await turn("the field is edited", revisedCatalog, PROMPTS[2]);
    await revised.clear();

    return Object.freeze({
      declaredField,
      revisedField,
      stubReply: STUB_REPLY,
      turns: Object.freeze(turns),
    });
  } finally {
    try {
      runtime?.session.dispose();
    } finally {
      await provider.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

/** The authored prefix message: the one carrying the published catalogue's rendered block. */
function authoredIndex(messages) {
  return messages.findIndex((message) => textOf(message).includes(AUTHORED_BLOCK_MARKER));
}

/**
 * How much of one request is the CACHED PREFIX: the leading system message, the authored
 * m[0] block, and - when present - the volatile m[1] delta that rides with it. Everything
 * after it is this turn's own transcript, or the appended tail.
 */
function cachedPrefixLength(messages) {
  const authored = authoredIndex(messages);
  if (authored < 0) return 0;
  const after = messages[authored + 1];
  const afterIsDelta = after !== undefined && /^<(?:session-history|gamebuddy-volatile-context)/.test(textOf(after));
  return authored + (afterIsDelta ? 2 : 1);
}

/** What the block must look like, and what it must carry, for one exact card field. */
function blockProblem(message, field) {
  if (message === undefined) return "the provider received no messages";
  if (message.role !== "user")
    return `the last message's role is ${message.role}, not user (a trailing system message is hoisted into the head on transports without mid-conversation system turns)`;
  const text = textOf(message);
  if (!text.startsWith(`${BLOCK_OPEN}\n`)) return `the block does not open with ${BLOCK_OPEN}`;
  if (!text.endsWith(`\n${BLOCK_CLOSE}`)) return `the block does not close with ${BLOCK_CLOSE}`;
  const occurrences = text.split(field).length - 1;
  if (occurrences !== 1) return `the card's text appears ${occurrences} times, not once`;
  if (!text.includes(`\n${field}\n`)) return "the card's text is not carried verbatim on its own line";
  if (text.includes(BLOCK_OPEN, 1)) return "more than one closing-direction block in the message";
  return null;
}

const reading = (entry) => {
  const prefixLength = cachedPrefixLength(entry.messages);
  const authored = authoredIndex(entry.messages);
  return Object.freeze({
    messages: entry.messages.length,
    prefixLength,
    prefixSha256: sha256(bytesOf(entry.messages.slice(0, prefixLength))),
    authoredIndex: authored,
    authoredSha256: authored < 0 ? "" : sha256(bytesOf(entry.messages[authored])),
    publicationSha256: entry.publicationHash,
  });
};

/**
 * The two readings, as verdicts. Pure: it takes what the provider received and decides, so
 * the same code can be handed a deliberately broken capture (a broken frame, a truncated
 * card text, a stale second turn, a shifted prefix) and must say so.
 */
export function verifyReadings(run) {
  const checks = [];
  const fail = (id, label, detail, evidence = []) =>
    checks.push(Object.freeze({ id, label, ok: false, detail, evidence }));
  const pass = (id, label, detail, evidence = []) =>
    checks.push(Object.freeze({ id, label, ok: true, detail, evidence }));
  const turns = run.turns ?? [];
  if (turns.length !== 3) {
    fail("turns", "three turns through the real stack", `got ${turns.length} turns, expected 3`);
    return Object.freeze({ checks: Object.freeze(checks), ok: false });
  }
  const [, declaredTurn, revisedTurn] = turns;

  // [1] The second turn: the edited field is what the next request carries.
  const revisedTail = revisedTurn.messages.at(-1);
  const revisedText = textOf(revisedTail);
  const turnTwoProblems = [];
  const revisedProblem = blockProblem(revisedTail, run.revisedField);
  if (revisedProblem !== null) turnTwoProblems.push(revisedProblem);
  if (!revisedText.includes(run.revisedField)) turnTwoProblems.push("the NEW text is not in the last message");
  if (run.declaredField.length > 0 && revisedText.includes(run.declaredField))
    turnTwoProblems.push("the OLD text is still in the last message: the block is cached, not re-read");
  const blocks = revisedTurn.messages.filter((message) => textOf(message).includes(BLOCK_OPEN));
  if (blocks.length !== 1) turnTwoProblems.push(`${blocks.length} closing-direction messages in one request`);
  if (declaredTurn.messages.at(-1) !== undefined && !textOf(declaredTurn.messages.at(-1)).includes(run.declaredField))
    turnTwoProblems.push("the turn BEFORE the edit did not carry the original text, so the edit proves nothing");
  if (turnTwoProblems.length === 0)
    pass("turn-two", "after the field is edited, the NEXT turn carries the new text and none of the old", revisedText, [
      `turn before the edit: ${textOf(declaredTurn.messages.at(-1))}`,
    ]);
  else fail("turn-two", "the turn after the edit carries the new text", turnTwoProblems.join("; "), [revisedText]);

  // [2] The prefix: m[0]'s bytes and the stable publication hash, with and without the field.
  const readings = turns.map(reading);
  const absentPrefix = readings[0].prefixLength;
  const prefixProblems = [];
  if (absentPrefix === 0)
    prefixProblems.push(
      "the published catalogue's rendered block never reached the request, so there is no m[0] to compare",
    );
  if (readings.some((entry) => entry.prefixLength !== absentPrefix))
    prefixProblems.push(
      `the cached prefix changed length between turns (${readings.map((entry) => entry.prefixLength).join(", ")})`,
    );
  for (const [index, entry] of readings.entries())
    if (entry.prefixSha256 !== readings[0].prefixSha256)
      prefixProblems.push(`turn ${index + 1}'s cached prefix bytes differ from the no-field turn's`);
  for (const [index, entry] of readings.entries())
    if (entry.authoredSha256 !== readings[0].authoredSha256)
      prefixProblems.push(`turn ${index + 1}'s m[0] bytes differ from the no-field turn's`);
  if (new Set(readings.map((entry) => entry.publicationSha256)).size !== 1)
    prefixProblems.push("the stable publication hash changed between turns");
  const evidence = readings.map(
    (entry, index) =>
      `${turns[index].label.padEnd(26)} messages=${String(entry.messages).padStart(2)}  m[0]=messages[${entry.authoredIndex}] sha256=${
        entry.authoredSha256 || "(absent)"
      }  prefix sha256=${entry.prefixSha256}  publication sha256=${entry.publicationSha256}`,
  );
  if (prefixProblems.length === 0)
    pass(
      "prefix",
      "m[0]'s bytes and the stable publication hash are identical to a card that declares no field",
      `m[0] and the ${absentPrefix}-message prefix are byte-identical in all three turns`,
      evidence,
    );
  else
    fail("prefix", "m[0]'s bytes and the stable publication hash are identical", prefixProblems.join("; "), evidence);

  return Object.freeze({ checks: Object.freeze(checks), ok: checks.every((check) => check.ok) });
}

function indent(text, prefix = "    ") {
  return String(text)
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function formatReport(run, verdict, writer = console.log) {
  writer("post-history-instructions on a real Chat turn");
  writer("  provider     : STUB - a local OpenAI-compatible endpoint this script serves; no model is called");
  writer("  stack        : host/dist-test runtime -> real Pi session -> real Magic Context handler -> wire");
  writer("");
  for (const [index, entry] of run.turns.entries())
    writer(`turn ${index + 1}  ${entry.label.padEnd(26)} prompt=${JSON.stringify(entry.prompt)}`);
  writer("");
  for (const check of verdict.checks) {
    writer(`[${check.id}] ${check.ok ? "PASS" : "FAIL"}  ${check.label}`);
    for (const line of check.evidence) writer(`${line.startsWith("[") ? "" : "  "}${line}`);
    if (check.detail.length > 0) writer(indent(check.detail));
    writer("");
  }
  const held = verdict.checks.filter((check) => check.ok).length;
  writer(`${held} of ${verdict.checks.length} readings hold.`);
}

function parseArguments(argv) {
  const options = { declaredField: DECLARED_FIELD, revisedField: REVISED_FIELD };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument.startsWith("--declared-field="))
      options.declaredField = argument.slice("--declared-field=".length);
    else if (argument.startsWith("--revised-field=")) options.revisedField = argument.slice("--revised-field=".length);
    else throw new Error(`unknown argument: ${argument}`);
  }
  // A card with no field is a legitimate cell: the Host records nothing for it, so nothing
  // is published and nothing may be appended - which is why this invocation must be red.
  if (options.declaredField.length === 0) options.revisedField = "";
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  let run;
  try {
    run = await runLiveCheck({
      declaredField: options.declaredField,
      revisedField: options.revisedField,
      log: options.json ? () => {} : (line) => console.log(`  ${line}`),
    });
  } catch (error) {
    if (error instanceof PostHistoryCheckBlocked) {
      console.error(`BLOCKED ${error.message}: ${error.detail}`);
      return 2;
    }
    throw error;
  }
  const verdict = verifyReadings(run);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          turns: run.turns.map((entry) => ({
            label: entry.label,
            prompt: entry.prompt,
            messages: entry.messages.length,
          })),
          readings: verdict.checks,
        },
        null,
        2,
      ),
    );
  } else {
    formatReport(run, verdict);
  }
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    },
  );
}
