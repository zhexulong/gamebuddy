#!/usr/bin/env node
/**
 * The three wire-contract assertions, judged on a REAL Chat turn's captured request.
 *
 * `wire-contract.mjs` decides *what* must hold. This runner produces the request those judgements are made
 * about, so they are measured on bytes the product actually posted rather than on a fixture:
 *
 *   [1] `postHistoryReachesTail`  the card's closing direction, written through the product's own record
 *       writer and published through the product's own catalogue, must arrive as the LAST message.
 *   [2] `noGameToolOnChatWire`    no name in `STARDEW_ACTION_TOOL_NAMES` may be declared or named on a
 *       request the Chat surface makes. The population is the registry's, never a list written here.
 *   [3] `cardVoiceAfterFloor`     the card's own directive (`characterVoice`, compiled from the card's
 *       `system_prompt`) must sit AFTER the Host floor that `COMPANION_ACTION_SYNTAX` anchors.
 *
 * The provider is a local OpenAI-compatible endpoint this script serves (`core/stub-provider.mjs`), mounted
 * through the product's own escape-hatch provider - so the model is stubbed and the assembly is not. Both
 * sentinels are synthetic and are printed in this script's own output, because a reader must be able to tell
 * a marker from the card's prose.
 *
 * ## Showing it RED
 *
 * Each flag removes one real thing and must turn its assertion red, so this file can be proved non-vacuous
 * without editing the product:
 *
 *   --omit-post-history         the record is never written, so the tail cannot carry the sentinel
 *   --tool-naming-post-history  the record names a mounted Game tool, as a card author who assumed the Chat
 *                               surface shares the Game surface's tools would write it
 *   --omit-card-voice           the identity profile carries no `characterVoice`, so there is no voice to order
 *
 *   node tools/live-run/chat/run-wire-contract-live.mjs                              # GREEN
 *   node tools/live-run/chat/run-wire-contract-live.mjs --omit-post-history           # RED on [1]
 *   node tools/live-run/chat/run-wire-contract-live.mjs --tool-naming-post-history    # RED on [2]
 *   node tools/live-run/chat/run-wire-contract-live.mjs --omit-card-voice             # RED on [3]
 *
 * Requirements: `host/dist-test` (the compiled artifact the live harness family runs against) and a built
 * Magic Context package. Missing either, the runner refuses by name instead of reporting a verdict it did
 * not measure.
 */
import { existsSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { provisionLiveRunPersona } from "../core/persona.mjs";
import { startLocalStubProvider } from "../core/stub-provider.mjs";
import {
  buildWireContractReading,
  narrateWireContract,
  WIRE_CARD_VOICE_SENTINEL,
  WIRE_POST_HISTORY_SENTINEL,
} from "./wire-contract.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST_TEST_ROOT = join(REPOSITORY_ROOT, "host", "dist-test");
const PROVIDER_ID = "gamebuddy-openai-compatible";
const MODEL_ID = "gamebuddy-wire-contract-live";
const STUB_REPLY = "She nods and sets the kettle down.";
const PROMPT = "Good morning.";
const REQUEST_TIMEOUT_MS = 60_000;
const SETTLE_TIMEOUT_MS = 30_000;
const IDENTITY = Object.freeze({
  playerId: "player_wire_contract_live",
  companionId: "companion_wire_contract_live",
  continuityId: "continuity_wire_contract_live",
});
const SURFACE_SESSION_ID = "surface_wire_contract_live";
const THREAD_ID = "thread_wire_contract_live";

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
  const tavernEntry = join(dirname(extensionEntry), "tavern", "index.js");
  const [
    { TavernConnectionStore },
    { TavernArtifactStore },
    { resolveTavernPaths },
    { materializeTavernAuthoredStableCatalog },
    { writeCompanionPostHistoryInstructions },
    { macroTable },
    { createChatThreadStore, createProfileAwareChatThreadCreationCapability },
    { readIdentityProfile },
    { COMPANION_ACTION_SYNTAX },
    { STARDEW_ACTION_TOOL_NAMES },
    pathLock,
    reclaimer,
    tavern,
  ] = await Promise.all([
    loadTestModule("tavern/connection-store.js"),
    loadTestModule("tavern/artifact-store.js"),
    loadTestModule("tavern/tavern-paths.js"),
    loadTestModule("tavern/catalog-service.js"),
    loadTestModule("tavern/post-history-instructions.js"),
    loadTestModule("tavern/macro-engine.js"),
    loadTestModule("tavern/chat-thread-store.js"),
    loadTestModule("identity-profile.js"),
    loadTestModule("identity-profile.js"),
    loadTestModule("action-registry.js"),
    loadTestModule("path-lock.js"),
    loadTestModule("windows-stale-lock-reclaimer/index.js"),
    import(pathToFileURL(tavernEntry).href),
  ]);
  pathLock.bindWindowsStaleLockReclaimer(await reclaimer.createBuildWindowsStaleLockReclaimer());
  return {
    createCompanionRuntime: runtime.createCompanionRuntime,
    resolveRuntimePaths: runtime.resolveRuntimePaths,
    TavernConnectionStore,
    TavernArtifactStore,
    resolveTavernPaths,
    materializeTavernAuthoredStableCatalog,
    writeCompanionPostHistoryInstructions,
    macroTable,
    createChatThreadStore,
    createProfileAwareChatThreadCreationCapability,
    readIdentityProfile,
    houseFloor: COMPANION_ACTION_SYNTAX,
    gameToolNames: Object.values(STARDEW_ACTION_TOOL_NAMES),
    publish: tavern.publishGameBuddyAuthoredStableCatalog,
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

async function awaitRequest(provider, timeoutMs) {
  let timer;
  const timeout = new Promise((done) => (timer = setTimeout(() => done(undefined), timeoutMs)));
  try {
    return await Promise.race([provider.next(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runLiveRun({
  omitPostHistory = false,
  toolNamingPostHistory = false,
  omitCardVoice = false,
  log = () => {},
} = {}) {
  const product = await loadProduct();
  const provider = await startLocalStubProvider({ modelId: MODEL_ID, reply: STUB_REPLY });
  const base = process.platform === "win32" ? (process.env.LOCALAPPDATA ?? tmpdir()) : tmpdir();
  const root = await mkdtemp(join(await realpath(base), "gb-wire-contract-live-"));
  const runtime = await (async () => {
    const paths = product.resolveRuntimePaths(IDENTITY, root, SURFACE_SESSION_ID);
    const connection = await new product.TavernConnectionStore(paths.agentDir).create({
      providerId: PROVIDER_ID,
      // A placeholder, never a credential: the endpoint is this script's own server.
      apiKey: "wire-contract-live-placeholder",
      baseUrl: provider.baseUrl,
      apiShape: "openai-completions",
      modelId: MODEL_ID,
    });
    if (connection.connections[0]?.readiness !== "configured")
      throw new Error("wire_contract_live_connection_not_configured");
    // The reviewed card, placed and compiled by the SAME provisioning path the Chat audit harness uses. The
    // sentinels are planted through the product's own record writers, so a red run removes a real write
    // rather than skipping a harness step.
    await provisionLiveRunPersona(paths.runtimeCwd, {
      identity: IDENTITY,
      root,
      wireSentinels: {
        ...(omitCardVoice ? {} : { cardVoiceSentinel: WIRE_CARD_VOICE_SENTINEL }),
        ...(omitPostHistory ? {} : { postHistorySentinel: WIRE_POST_HISTORY_SENTINEL }),
        ...(toolNamingPostHistory
          ? { postHistoryDefectLine: `Call ${product.gameToolNames[0]} whenever you want to wave at the player.` }
          : {}),
      },
    });
    const created = await product.createCompanionRuntime(
      IDENTITY,
      root,
      undefined,
      { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "off" },
      undefined,
      undefined,
      false,
      undefined,
      SURFACE_SESSION_ID,
      undefined,
      "chat",
    );
    log(`run root     : ${paths.runtimeCwd}`);
    return Object.freeze({ ...created, root, paths });
  })();

  try {
    const piSessionId = runtime.sessionManager.getSessionId();
    if (typeof piSessionId !== "string" || piSessionId.length === 0) throw new Error("pi_session_unavailable");
    const tavernPaths = product.resolveTavernPaths(runtime.paths, IDENTITY);
    const artifacts = new product.TavernArtifactStore(runtime.paths.root);
    const threads = product.createChatThreadStore(runtime.paths.root, runtime.identityKey);
    const creation = product.createProfileAwareChatThreadCreationCapability(threads, {
      async readExact() {
        return runtime.identityProfile;
      },
    });
    const thread = await creation.createExplicit({
      chatThreadId: THREAD_ID,
      chatSurfaceSessionId: SURFACE_SESSION_ID,
      companionId: IDENTITY.companionId,
      continuityId: IDENTITY.continuityId,
      opening: "blank",
    });
    // `--tool-naming-post-history` is planted inside the record writer above, so the record stays one write
    // made through the product's own path; nothing here rewrites it.
    const catalog = await product.materializeTavernAuthoredStableCatalog(
      tavernPaths,
      artifacts,
      thread.thread,
      Object.freeze({
        continuityId: IDENTITY.continuityId,
        sessionId: piSessionId,
        surface: "tavern",
        threadId: thread.thread.chatThreadId,
        profile: runtime.identityProfile,
      }),
      product.macroTable({ char: runtime.profile.identity.name }),
    );
    product.publish(
      Object.freeze({
        continuityId: IDENTITY.continuityId,
        sessionId: piSessionId,
        surface: "tavern",
        threadId: thread.thread.chatThreadId,
        profile: runtime.identityProfile,
      }),
      catalog,
    );

    const promise = runtime.session.prompt(PROMPT);
    const received = await awaitRequest(provider, REQUEST_TIMEOUT_MS);
    if (received?.body === undefined) throw new Error("wire_contract_live_provider_request_missing");
    const didSettle = await settled(promise, SETTLE_TIMEOUT_MS);

    const reading = buildWireContractReading({
      requests: provider.requests,
      gameToolNames: product.gameToolNames,
      houseFloor: product.houseFloor,
    });
    // Read back from the durable profile: the runtime's projection is a narrower shape, and reporting "ABSENT"
    // beside a verified ordering would send a reader after the wrong layer.
    const mountedProfile = await product.readIdentityProfile(runtime.paths.identityProfilePath);
    return Object.freeze({
      root: runtime.paths.runtimeCwd,
      promptSettled: didSettle,
      recordPublished: catalog.postHistoryInstructions ?? null,
      reading,
      cardVoicePresent: mountedProfile.characterVoice !== undefined,
    });
  } finally {
    runtime.session.dispose?.();
    await provider.close().catch(() => undefined);
  }
}

function parseArguments(argv) {
  const options = { omitPostHistory: false, toolNamingPostHistory: false, omitCardVoice: false, help: false };
  for (const argument of argv) {
    if (argument === "--help") options.help = true;
    else if (argument === "--omit-post-history") options.omitPostHistory = true;
    else if (argument === "--tool-naming-post-history") options.toolNamingPostHistory = true;
    else if (argument === "--omit-card-voice") options.omitCardVoice = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(
      "usage: node tools/live-run/chat/run-wire-contract-live.mjs [--omit-post-history] [--tool-naming-post-history] [--omit-card-voice]\n",
    );
    return 0;
  }
  let run;
  try {
    run = await runLiveRun({
      omitPostHistory: options.omitPostHistory,
      toolNamingPostHistory: options.toolNamingPostHistory,
      omitCardVoice: options.omitCardVoice,
      log: (line) => process.stdout.write(`  ${line}\n`),
    });
  } catch (error) {
    if (error instanceof RunnerBlocked) {
      process.stderr.write(`BLOCKED ${error.message}: ${error.detail}\n`);
      return 2;
    }
    throw error;
  }
  process.stdout.write("three wire-contract assertions on a real Chat turn\n");
  process.stdout.write(
    "  provider    : STUB - a local OpenAI-compatible endpoint this script serves; no model is called\n",
  );
  process.stdout.write(`  run root    : ${run.root}\n`);
  process.stdout.write(`  sentinels   : ${WIRE_POST_HISTORY_SENTINEL} / ${WIRE_CARD_VOICE_SENTINEL}\n`);
  process.stdout.write(`  card voice  : ${run.cardVoicePresent ? "present in the mounted profile" : "ABSENT"}\n`);
  process.stdout.write(`${narrateWireContract(run.reading)}\n`);
  process.stdout.write(
    `\n${JSON.stringify({
      state: run.reading.state,
      requests: run.reading.requests,
      checks: run.reading.checks.map((check) => `${check.id}:${check.state}`),
      promptSettled: run.promptSettled,
      runRoot: run.root,
    })}\n`,
  );
  return run.reading.state === "verified" ? 0 : 1;
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
