import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

import {
  createProviderTurnHeaderScope,
  PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME,
  PROVIDER_TURN_HEADER_EXTENSION_NAME,
  PROVIDER_TURN_HEADER_NAME,
  type ProviderTurnHeaderScope,
  type ProviderTurnNaming,
  providerTurnHeaderExtension,
} from "./provider-turn-header.internal.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";

const PROVIDER_ID = "turn-header-test-provider";
const MODEL_ID = "turn-header-test-model";
const KEY_ENV = "GAMEBUDDY_TURN_HEADER_TEST_KEY";
/**
 * The fixture model's context window: a deliberately tiny number, and no model the product sells declares it.
 * This suite proves which HTTP header a provider request carries, so the provider only has to be reachable; a
 * small window keeps the fixture from reading as a copy of a catalog entry it never consults.
 */
const FIXTURE_CONTEXT_WINDOW = 8192;
const REQUEST_TURN_HEADER = PROVIDER_TURN_HEADER_NAME.toLowerCase();
const REQUEST_KEY_HEADER = PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME.toLowerCase();

/** The submission key a prompt's turn was accepted under; opaque, as the product's own keys are. */
const promptNaming = (turnId: string): ProviderTurnNaming => Object.freeze({ turnId, idempotencyKey: `key_${turnId}` });

type RecordedRequest = Readonly<{
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}>;

/**
 * One local OpenAI-compatible endpoint that records the headers of every request that reached it.
 *
 * This is the wire, not a double of it: Pi's own `openai-completions` adapter builds the request, so a
 * header read here has survived everything the product does to a request - and a header missing here was
 * never sent. The reply shape is the one the live-run stub provider answers with.
 */
async function startRecordingProvider() {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push({ url: request.url, headers: { ...request.headers } });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({
        id: "chatcmpl-turn-header",
        object: "chat.completion.chunk",
        model: MODEL_ID,
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      });
      send({
        id: "chatcmpl-turn-header",
        object: "chat.completion.chunk",
        model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("turn_header_provider_port_unavailable");
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  });
}

type TurnHeaderRuntime = Readonly<{
  session: AgentSession;
  scope: ProviderTurnHeaderScope;
  /**
   * One real prompt under the turn named here, or under no turn at all, returning the request it made.
   * The prompt has settled by the time this resolves, so that request has already reached the endpoint.
   */
  promptUnder(turnId: string | undefined): Promise<RecordedRequest>;
}>;

/**
 * The Host's own loader shape, mounted over a real Pi session.
 *
 * `noExtensions` is set exactly as the Host sets it: it disables extension PATHS, and the inline factory
 * the Host registers for itself has to survive that, or the header would exist only outside a product
 * session. The provider is the same `openai-completions` adapter a player's connection uses.
 */
async function mountTurnHeaderRuntime(
  root: string,
  provider: Awaited<ReturnType<typeof startRecordingProvider>>,
): Promise<TurnHeaderRuntime> {
  const cwd = join(root, "runtime");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  process.env[KEY_ENV] = "turn-header-test-key";
  const modelsPath = join(agentDir, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify(
      {
        providers: {
          [PROVIDER_ID]: {
            name: "Turn header test provider",
            baseUrl: provider.baseUrl,
            api: "openai-completions",
            apiKey: `$${KEY_ENV}`,
            models: [
              {
                id: MODEL_ID,
                name: MODEL_ID,
                reasoning: false,
                input: ["text"],
                contextWindow: FIXTURE_CONTEXT_WINDOW,
                maxTokens: 512,
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: true,
  });
  const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
  if (model === undefined) throw new Error("turn_header_test_model_unavailable");
  const scope = createProviderTurnHeaderScope();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "turn header test",
    appendSystemPrompt: [],
    extensionFactories: [
      {
        name: PROVIDER_TURN_HEADER_EXTENSION_NAME,
        hidden: true,
        factory: (pi) => providerTurnHeaderExtension(pi, scope),
      },
    ],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(
    loaded.extensions.map((extension) => extension.path),
    [`<inline:${PROVIDER_TURN_HEADER_EXTENSION_NAME}>`],
    "the Host's inline turn-header factory must load although noExtensions disables extension paths",
  );
  assert.deepEqual(loaded.errors, []);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.create(cwd, join(root, "sessions")),
    modelRuntime,
    model,
    noTools: "all",
    tools: [],
  });
  return {
    session,
    scope,
    async promptUnder(turnId) {
      if (turnId === undefined) {
        scope.clearTurn(scope.turnInFlight()?.turnId ?? "");
      } else {
        scope.setTurn(promptNaming(turnId));
      }
      const before = provider.requests.length;
      await session.prompt("Say something short.", { expandPromptTemplates: false, source: "rpc" });
      const made = provider.requests.slice(before);
      assert.equal(made.length, 1, "one prompt makes exactly one provider request");
      return made[0]!;
    },
  };
}

/** One fresh session against one fresh recording endpoint, torn down whatever the case does. */
async function withTurnHeaderRuntime(run: (runtime: TurnHeaderRuntime) => Promise<void>): Promise<void> {
  const root = await canonicalTestRoot("gamebuddy-turn-header-");
  const provider = await startRecordingProvider();
  try {
    const runtime = await mountTurnHeaderRuntime(root, provider);
    try {
      await run(runtime);
    } finally {
      runtime.session.dispose();
    }
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** The turn header the request carried, or `null` when it carried none. */
function turnHeaderOf(request: RecordedRequest): string | null {
  const value = request.headers[REQUEST_TURN_HEADER];
  return typeof value === "string" ? value : null;
}

function gameBuddyHeadersOf(request: RecordedRequest): readonly string[] {
  return Object.keys(request.headers)
    .filter((name) => name.startsWith("x-gamebuddy-"))
    .sort();
}

test("a provider request made while a turn is in flight carries that turn's id", async () => {
  await withTurnHeaderRuntime(async (runtime) => {
    const request = await runtime.promptUnder("turn_alpha");

    assert.equal(request.url, "/v1/chat/completions", "the reading must be of the provider call itself");
    assert.equal(turnHeaderOf(request), "turn_alpha", "the captured body must be attributable to the turn");
    assert.equal(
      request.headers[REQUEST_KEY_HEADER],
      "key_turn_alpha",
      "the request must carry the key the turn was submitted under, so a reader holding the page's own marks can name it",
    );
    assert.deepEqual(
      gameBuddyHeadersOf(request),
      [REQUEST_KEY_HEADER, REQUEST_TURN_HEADER].sort(),
      "the request names this turn and nothing else: no third header may be added beside these two",
    );
  });
});

test("a provider request made while no turn is in flight carries no turn header", async () => {
  await withTurnHeaderRuntime(async (runtime) => {
    const probe = await runtime.promptUnder("turn_alpha");
    assert.equal(
      turnHeaderOf(probe),
      "turn_alpha",
      "the control reading below is only meaningful after a stamped request",
    );

    const unstamped = await runtime.promptUnder(undefined);

    assert.deepEqual(
      gameBuddyHeadersOf(unstamped),
      [],
      "a request that belongs to no turn must say so by carrying no such header, not by carrying an empty one",
    );
  });
});

test("two consecutive turns carry their own turn ids in order, and the id does not outlive them", async () => {
  await withTurnHeaderRuntime(async (runtime) => {
    const first = await runtime.promptUnder("turn_alpha");
    const second = await runtime.promptUnder("turn_beta");
    const afterwards = await runtime.promptUnder(undefined);

    assert.deepEqual(
      [turnHeaderOf(first), turnHeaderOf(second)],
      ["turn_alpha", "turn_beta"],
      "a holder left set would give the second request the first turn's id",
    );
    assert.equal(
      turnHeaderOf(afterwards),
      null,
      "a settled turn must not name the next request, which belongs to no turn",
    );
  });
});

test("clearing a turn leaves a successor's turn named", () => {
  const scope = createProviderTurnHeaderScope();

  scope.setTurn(promptNaming("turn_alpha"));
  scope.setTurn(promptNaming("turn_beta"));
  scope.clearTurn("turn_alpha");

  assert.equal(
    scope.turnInFlight()?.turnId,
    "turn_beta",
    "a stopped turn's own clear must not erase the turn that replaced it",
  );
  scope.clearTurn("turn_beta");
  assert.equal(scope.turnInFlight(), undefined);
});
