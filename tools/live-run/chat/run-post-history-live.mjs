#!/usr/bin/env node
/**
 * The card's `post_history_instructions` on a real Chat turn.
 *
 * The fork's unit tests prove the append against a synthetic message array (the block is last,
 * the card's prose is verbatim, a card that declares nothing is a byte-identical no-op, one
 * shared 4 KB bound). Two things they cannot prove, and this runner settles them on real wire
 * bytes:
 *
 *   [1] `tailBlock` - on a real turn, the OUTGOING messages end with the framed block and carry
 *       the card's sentence verbatim.
 *   [2] `secondTurn` - after the field is changed, the NEXT turn's block carries the new
 *       sentence and none of the old. That is the only mechanical difference between a per-turn
 *       tail and a block folded into a cached prefix, and no unit test can give it.
 *   [3] `prefix` - `m[0]`'s bytes and the stable publication hash, printed once for the
 *       with-field run and once for a card that declares nothing.
 *
 * # How it drives the product
 *
 * One real runtime (`host/dist-test` -> `createCompanionRuntime`, surface `chat`), one real Pi
 * session, one real Magic Context context handler, and the product's own publication calls
 * (`publishGameBuddyAuthoredStableCatalog` / `replaceGameBuddyAuthoredStableCatalog` - exactly
 * the pair a mounted Chat calls when its authored context is refreshed). The provider is a local
 * OpenAI-compatible endpoint this script serves, so it records the request body Pi actually
 * posted: the model is stubbed, the assembly is not, and the assembly is what is under test.
 *
 * # What this run cannot settle, and says so
 *
 * The card's durable record (`post-history-instructions.json`, written by the import) has no
 * production reader in the Host yet: `readCompanionPostHistoryInstructions` is called only from
 * its own test, and `materializeTavernAuthoredContextCatalog` never sets the catalogue's
 * `postHistoryInstructions`. The field therefore rides the catalogue here, through the product's
 * own publication call, not through the record. This runner prints that link's state on every
 * run (`durableRecordLink`) so the note cannot rot silently: when a reader appears, the reading
 * to take is the record-driven one, and this line says so.
 *
 *   node tools/live-run/chat/run-post-history-live.mjs
 *   node tools/live-run/chat/run-post-history-live.mjs --declared-field=""   # must be RED
 *
 * Requirements: `host/dist-test` and a built Magic Context package. Missing either, the runner
 * refuses by name instead of reporting a verdict it did not measure.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST_TEST_ROOT = join(REPOSITORY_ROOT, "host", "dist-test");
const HOST_SOURCE_ROOT = join(REPOSITORY_ROOT, "host", "src");

/** The card's closing direction, and the author's edit to it. Distinctive on purpose. */
export const DECLARED_FIELD = "Close every reply by raking the coals once, never twice.";
export const REVISED_FIELD = "Close every reply by hanging the kettle back on its hook.";
const BLOCK_OPEN = "<character-closing-direction>";
const BLOCK_CLOSE = "</character-closing-direction>";
const AUTHORED_BLOCK_MARKER = '<gamebuddy-authored-context version="v2"';
// The product's own escape-hatch provider: a local OpenAI-compatible endpoint with a chosen
// model id, which is exactly what a stub endpoint needs and what a player uses for a custom host.
const PROVIDER_ID = "gamebuddy-openai-compatible";
const MODEL_ID = "gamebuddy-post-history-live";
const STUB_REPLY = "She nods and sets the kettle down.";
const PROMPTS = Object.freeze(["Good morning.", "I am off to buy seed.", "The seed is in."]);
const REQUEST_TIMEOUT_MS = 60_000;
const SETTLE_TIMEOUT_MS = 30_000;

class RunnerBlocked extends Error {
  constructor(reason, detail) {
    super(reason);
    this.detail = detail;
  }
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const wireBytes = (value) => JSON.stringify(value);
const bytes = (value) => Buffer.byteLength(value, "utf8");

/** One wire message's text: a string, or the text parts of a structured content array. */
export function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
    .join("");
}

/**
 * What one captured request says about the two subjects of this run: the block at the tail, and
 * the cached prefix's bytes. Pure, so a synthetic capture can be handed to it and must be judged
 * the same way a real one is.
 */
export function summarizeTurn(entry) {
  const messages = Array.isArray(entry?.messages) ? entry.messages : [];
  const authoredIndex = messages.findIndex((message) => textOf(message).includes(AUTHORED_BLOCK_MARKER));
  const last = messages.at(-1);
  const authored = authoredIndex < 0 ? undefined : messages[authoredIndex];
  return Object.freeze({
    label: entry?.label ?? "",
    messages: messages.length,
    m0Index: authoredIndex,
    // `m[0]`'s bytes: the one message Magic Context assembles the authored baseline into.
    m0Bytes: authored === undefined ? 0 : bytes(wireBytes(authored)),
    m0Sha256: authored === undefined ? null : sha256(wireBytes(authored)),
    // The agent's own system prompt is the other half of the prefix a turn may not disturb.
    systemSha256: messages[0] === undefined ? null : sha256(wireBytes(messages[0])),
    publicationHash: entry?.publicationHash ?? null,
    blocks: messages.filter((message) => textOf(message).includes(BLOCK_OPEN)).length,
    lastRole: last?.role ?? null,
    lastText: last === undefined ? "" : textOf(last),
  });
}

/** Why the last message is not the framed block for `field`, or `null` when it is. */
export function blockProblem(summary, field) {
  if (summary.messages === 0) return "the provider received no messages";
  if (summary.lastRole !== "user")
    return `the last message's role is ${String(
      summary.lastRole,
    )}, not user (a trailing system message is hoisted into the head on transports without mid-conversation system turns)`;
  const text = summary.lastText;
  if (!text.startsWith(`${BLOCK_OPEN}\n`)) return `the last message does not open with ${BLOCK_OPEN}`;
  if (!text.endsWith(`\n${BLOCK_CLOSE}`)) return `the last message does not close with ${BLOCK_CLOSE}`;
  const occurrences = field.length === 0 ? 0 : text.split(field).length - 1;
  if (occurrences !== 1) return `the card's sentence appears ${occurrences} times in the last message, not once`;
  if (field.length > 0 && !text.includes(`\n${field}\n`))
    return "the card's sentence is not carried verbatim on its own line";
  if (text.includes(BLOCK_OPEN, 1)) return "more than one closing-direction block in the last message";
  if (summary.blocks !== 1) return `${summary.blocks} closing-direction messages in one request, expected 1`;
  return null;
}

/**
 * The three readings, as verdicts. Pure: it takes what the provider received and decides, so the
 * same code can be handed a deliberately broken capture (a stale second turn, a hoisted block, a
 * shifted prefix, a card that declares nothing) and must go red.
 */
export function verifyReadings(run) {
  const checks = [];
  const record = (id, label, problems, evidence) =>
    checks.push(Object.freeze({ id, label, ok: problems.length === 0, detail: problems.join("; "), evidence }));
  const turns = Array.isArray(run?.turns) ? run.turns : [];
  const declaredField = typeof run?.declaredField === "string" ? run.declaredField : "";
  const revisedField = typeof run?.revisedField === "string" ? run.revisedField : "";
  if (turns.length !== 3) {
    record("turns", "three real turns", [`got ${turns.length} turns, expected 3`], []);
    return Object.freeze({ checks: Object.freeze(checks), ok: false });
  }
  const summaries = turns.map((entry) => summarizeTurn(entry));
  const [absent, declared, revised] = summaries;

  record(
    "control",
    "a card that declares nothing appends no block",
    absent.blocks === 0 ? [] : [`the no-field turn carried ${absent.blocks} closing-direction message(s)`],
    [`last message: ${absent.lastText.slice(0, 120)}`],
  );

  record(
    "tailBlock",
    "on a real turn the outgoing messages END with the framed block, carrying the card's sentence verbatim",
    [blockProblem(declared, declaredField)].filter((problem) => problem !== null),
    [declared.lastText],
  );

  const secondTurnProblems = [];
  const revisedProblem = blockProblem(revised, revisedField);
  if (revisedProblem !== null) secondTurnProblems.push(revisedProblem);
  if (declaredField.length > 0 && revised.lastText.includes(declaredField))
    secondTurnProblems.push("the OLD sentence is still in the last message: the block is cached, not re-read");
  if (declaredField.length === 0) secondTurnProblems.push("the card declared nothing, so an edit proves nothing");
  record(
    "secondTurn",
    "after the field is changed, the NEXT turn carries the new sentence and none of the old",
    secondTurnProblems,
    [`before the edit: ${declared.lastText}`, `after the edit: ${revised.lastText}`],
  );

  const prefixProblems = [];
  if (absent.m0Index < 0)
    prefixProblems.push("the published catalogue's rendered block never reached the request, so there is no m[0]");
  for (const [index, summary] of summaries.entries()) {
    if (summary.m0Sha256 !== absent.m0Sha256)
      prefixProblems.push(`turn ${index + 1}'s m[0] bytes differ from the no-field turn's`);
    if (summary.systemSha256 !== absent.systemSha256)
      prefixProblems.push(`turn ${index + 1}'s system prompt bytes differ from the no-field turn's`);
    if (summary.publicationHash !== absent.publicationHash)
      prefixProblems.push(`turn ${index + 1}'s stable publication hash differs from the no-field turn's`);
  }
  record(
    "prefix",
    "m[0]'s bytes and the stable publication hash are identical with and without the field",
    prefixProblems,
    summaries.map(
      (summary, index) =>
        `${turns[index].label.padEnd(30)} m[0] bytes=${String(summary.m0Bytes).padStart(5)}  m[0] sha256=${
          summary.m0Sha256 ?? "(absent)"
        }  publication sha256=${summary.publicationHash ?? "(none)"}`,
    ),
  );

  return Object.freeze({ checks: Object.freeze(checks), ok: checks.every((check) => check.ok) });
}

/**
 * Whether the Host reads the card's durable record. This is the one claim the runner cannot settle
 * on the wire, so it is measured rather than asserted: a production caller found means the
 * record-driven reading is the one to take, and the printed line says so.
 */
export function durableRecordLink(sourceRoot = HOST_SOURCE_ROOT) {
  const definitions = join(sourceRoot, "tavern", "post-history-instructions.ts");
  let callers = 0;
  let files;
  try {
    files = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" });
  } catch {
    return Object.freeze({ known: false, callers: 0 });
  }
  for (const file of files) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const path = join(sourceRoot, file);
    if (resolve(path) === resolve(definitions)) continue;
    if (readFileSync(path, "utf8").includes("readCompanionPostHistoryInstructions(")) callers += 1;
  }
  return Object.freeze({ known: true, callers });
}

function loadTestModule(module) {
  return import(pathToFileURL(join(HOST_TEST_ROOT, module)).href);
}

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
  const tavernEntry = join(dirname(extensionEntry), "tavern", "index.js");
  const [{ TavernConnectionStore }, pathLock, reclaimer, fixture, tavern] = await Promise.all([
    loadTestModule("tavern/connection-store.js"),
    loadTestModule("path-lock.js"),
    loadTestModule("windows-stale-lock-reclaimer/index.js"),
    loadTestModule("test-support/authored-context-catalog.test-support.js"),
    import(pathToFileURL(tavernEntry).href),
  ]);
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
 * The stub provider: records every request body, then streams one fixed assistant reply in the
 * shape Pi's own `openai-completions` adapter parses. Kept alive (never `unref`ed) so a waiting
 * turn cannot silently lose the event loop and exit green with no reading.
 */
async function startStubProvider() {
  const requests = [];
  let resolveNext;
  const nextRequest = () => new Promise((done) => (resolveNext = done));
  let pending = nextRequest();
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      requests.push({ url: request.url, body });
      const settle = resolveNext;
      pending = nextRequest();
      settle?.(requests.at(-1));
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({
        id: "chatcmpl-post-history-live",
        object: "chat.completion.chunk",
        model: MODEL_ID,
        choices: [{ index: 0, delta: { role: "assistant", content: STUB_REPLY }, finish_reason: null }],
      });
      send({
        id: "chatcmpl-post-history-live",
        object: "chat.completion.chunk",
        model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 },
      });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    next: () => pending,
    close: async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/** A bounded wait: whatever is being awaited records that it did not settle instead of hanging. */
async function settled(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((done) => (timer = setTimeout(() => done(false), timeoutMs)));
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Wait for the request this turn posts, bounded, so a dead run reports rather than hangs. */
async function awaitRequest(provider, timeoutMs) {
  let timer;
  const timeout = new Promise((done) => (timer = setTimeout(() => done(undefined), timeoutMs)));
  try {
    return await Promise.race([provider.next(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drive three real turns on one real runtime and return what the provider received.
 *
 * The three turns are the experiment's three cells: the card declares no field (the control for
 * reading 3), it declares the field, and the author changes it. Every other input - runtime,
 * session, authored sources - is held fixed, so a byte that differs between cells is attributable
 * to the field.
 */
export async function runLiveRun({
  declaredField = DECLARED_FIELD,
  revisedField = REVISED_FIELD,
  log = () => {},
} = {}) {
  const product = await loadProduct();
  const provider = await startStubProvider();
  const base = process.platform === "win32" ? (process.env.LOCALAPPDATA ?? tmpdir()) : tmpdir();
  const root = await mkdtemp(join(await realpath(base), "gb-post-history-live-"));
  const identity = Object.freeze({
    playerId: "player_post_history_live",
    companionId: "companion_post_history_live",
    continuityId: "continuity_post_history_live",
  });
  const surfaceSessionId = "surface_post_history_live";
  const runtime = await (async () => {
    const paths = product.resolveRuntimePaths(identity, root, surfaceSessionId);
    const connections = new product.TavernConnectionStore(paths.agentDir);
    const connection = await connections.create({
      providerId: PROVIDER_ID,
      // A placeholder, never a credential: the endpoint is this script's own server.
      apiKey: "post-history-live-placeholder",
      baseUrl: provider.baseUrl,
      apiShape: "openai-completions",
      modelId: MODEL_ID,
    });
    if (connection.connections[0]?.readiness !== "configured")
      throw new Error("post_history_live_connection_not_configured");
    const created = await product.createCompanionRuntime(
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
    log(`run root     : ${paths.runtimeCwd}`);
    return Object.freeze({ ...created, root, paths });
  })();

  try {
    const piSessionId = runtime.sessionManager.getSessionId();
    if (typeof piSessionId !== "string" || piSessionId.length === 0) throw new Error("pi_session_unavailable");
    log(`pi session   : ${piSessionId}`);
    const scope = Object.freeze({
      continuityId: identity.continuityId,
      sessionId: piSessionId,
      surface: "tavern",
      threadId: "thread_post_history_live",
      profile: Object.freeze({ profileId: "profile_post_history_live", revision: 1, canonicalHash: "a".repeat(64) }),
    });
    const sources = Object.freeze({
      stableSources: [
        Object.freeze({
          sourceId: "scenario_post_history_live",
          kind: "scenario",
          revision: "1",
          content: "A quiet kitchen at first light, the stove still warm.",
          budgetTokens: 8,
          totalOrderKey: "0001",
          provenance: "live-run/post-history-live",
        }),
      ],
    });
    // The Host's own test support builds the catalogue the Host publishes (its canonical hash is
    // computed over the body, never invented). The closing direction is carried BESIDE that hashed
    // body - the shape the package validates, and the reason changing it cannot move the hash.
    const catalog = (field) => {
      const built = product.authoredContextCatalogFixture(scope, sources).catalog;
      return field === undefined || field.length === 0
        ? built
        : Object.freeze({ ...built, postHistoryInstructions: field });
    };

    const turns = [];
    const turn = async (label, publication, prompt, published) => {
      const thisTurn = await (async () => {
        const promise = runtime.session.prompt(prompt);
        const received = await awaitRequest(provider, REQUEST_TIMEOUT_MS);
        const didSettle = await settled(promise, SETTLE_TIMEOUT_MS);
        return { received, didSettle };
      })();
      if (thisTurn.received?.body === undefined) throw new Error(`post_history_live_provider_request_missing:${label}`);
      turns.push(
        Object.freeze({
          label,
          prompt,
          publicationHash: publication.canonicalHash,
          published,
          promptSettled: thisTurn.didSettle,
          messages: Array.isArray(thisTurn.received.body.messages) ? thisTurn.received.body.messages : [],
        }),
      );
      log(
        `turn ${turns.length}     : ${label} (settled=${String(thisTurn.didSettle)}, messages=${turns.at(-1).messages.length})`,
      );
    };

    // 1. A card that declares nothing: the control side of the prefix reading.
    const absentCatalog = catalog(undefined);
    const absent = product.publish(scope, absentCatalog);
    await turn("card declares nothing", absentCatalog, PROMPTS[0], "none");
    // 2. The same card, now declaring the field.
    const declaredCatalog = catalog(declaredField);
    const declared = product.replace(absent, scope, declaredCatalog);
    await turn("card declares the field", declaredCatalog, PROMPTS[1], "declared");
    // 3. The author changes the field: only the NEXT turn may show it, and only at its tail.
    const revisedCatalog = catalog(revisedField);
    product.replace(declared, scope, revisedCatalog);
    await turn("the field is changed", revisedCatalog, PROMPTS[2], "revised");

    return Object.freeze({
      declaredField,
      revisedField,
      stubReply: STUB_REPLY,
      root: runtime.paths.runtimeCwd,
      turns: Object.freeze(turns),
    });
  } finally {
    runtime.session.dispose?.();
    await provider.close().catch(() => {});
  }
}

function indent(text, prefix = "    ") {
  return String(text)
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function formatReadings(run, verdict, link, writer = console.log) {
  const summaries = run.turns.map((entry) => summarizeTurn(entry));
  writer("post-history-instructions on a real Chat turn");
  writer("  provider        : STUB - a local OpenAI-compatible endpoint this script serves; no model is called");
  writer("  stack           : host/dist-test runtime -> real Pi session -> real Magic Context handler -> wire");
  writer(`  run root        : ${run.root}`);
  writer(
    link.known === false
      ? "  durable record  : UNKNOWN - host/src is not readable from here"
      : link.callers === 0
        ? "  durable record  : the card's post-history-instructions.json has NO production reader in the Host, so the\n" +
          "                    field rides the product's own catalogue publication (replaceGameBuddyAuthoredStableCatalog),\n" +
          "                    which is what a mounted Chat calls on refresh - not the card record"
        : `  durable record  : READ by ${link.callers} production caller(s); the record-driven reading is the one to take`,
  );
  writer("");
  writer("reading 1  tailBlock - the last outgoing message, card declaring the field");
  writer(
    `  role=${String(summaries[1].lastRole)}  bytes=${bytes(summaries[1].lastText)}  blocks=${summaries[1].blocks}`,
  );
  writer(indent(summaries[1].lastText));
  writer("");
  writer("reading 2  secondTurn - the same reading after the field is changed");
  writer(
    `  role=${String(summaries[2].lastRole)}  bytes=${bytes(summaries[2].lastText)}  blocks=${summaries[2].blocks}`,
  );
  writer(indent(summaries[2].lastText));
  writer("");
  writer("reading 3  prefix - m[0] bytes and stable publication hash, no field vs with field");
  for (const [index, summary] of summaries.entries()) {
    writer(
      `  turn ${index + 1}  ${run.turns[index].label.padEnd(24)} ${run.turns[index].published.padEnd(9)}` +
        ` m[0] bytes=${String(summary.m0Bytes).padStart(5)}  m[0] sha256=${summary.m0Sha256 ?? "(absent)"}` +
        `  publication sha256=${summary.publicationHash ?? "(none)"}`,
    );
  }
  writer("");
  for (const check of verdict.checks) {
    writer(`[${check.id}] ${check.ok ? "PASS" : "FAIL"}  ${check.label}`);
    if (check.detail.length > 0) writer(indent(check.detail));
  }
  writer("");
  const held = verdict.checks.filter((check) => check.ok).length;
  writer(`${held} of ${verdict.checks.length} readings hold.`);
}

function parseArguments(argv) {
  const options = { declaredField: DECLARED_FIELD, revisedField: REVISED_FIELD };
  for (const argument of argv) {
    if (argument === "--help") options.help = true;
    else if (argument.startsWith("--declared-field="))
      options.declaredField = argument.slice("--declared-field=".length);
    else if (argument.startsWith("--revised-field=")) options.revisedField = argument.slice("--revised-field=".length);
    else throw new Error(`unknown argument: ${argument}`);
  }
  // A card that declares nothing is a legitimate cell, and then there is nothing to edit either.
  if (options.declaredField.length === 0) options.revisedField = "";
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(
      "usage: node tools/live-run/chat/run-post-history-live.mjs [--declared-field=<text>] [--revised-field=<text>]\n",
    );
    return 0;
  }
  let run;
  try {
    run = await runLiveRun({
      declaredField: options.declaredField,
      revisedField: options.revisedField,
      log: (line) => process.stdout.write(`  ${line}\n`),
    });
  } catch (error) {
    if (error instanceof RunnerBlocked) {
      process.stderr.write(`BLOCKED ${error.message}: ${error.detail}\n`);
      return 2;
    }
    throw error;
  }
  const verdict = verifyReadings(run);
  formatReadings(run, verdict, durableRecordLink());
  process.stdout.write(
    `\n${JSON.stringify({
      state: "collected",
      readings: verdict.checks.map((check) => `${check.id}:${check.ok ? "pass" : "fail"}`),
      held: verdict.checks.filter((check) => check.ok).length,
      total: verdict.checks.length,
      promptSettled: run.turns.map((entry) => entry.promptSettled),
      runRoot: run.root,
    })}\n`,
  );
  return verdict.ok ? 0 : 1;
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
