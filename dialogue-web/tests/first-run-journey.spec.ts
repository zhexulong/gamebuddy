/**
 * The first-run journey: what a player with nothing configured meets, in order.
 *
 * This file grows one step at a time, each step committed on its own so a dropped transport cannot
 * take the whole journey with it. Steps present today:
 *
 *   2. Choosing a provider fills what it can and is honest about what it cannot: a pinned provider
 *      asks for the player's key and the player's model, never for an endpoint or an API shape it
 *      owns, and its form names no model id other than what the projection published for it - the
 *      measured defect was an Ollama id (`qwen2.5-coder:7b`) standing as the hint for providers that
 *      never serve it, so a player following our own hint read the endpoint's honest `not_found` as
 *      a broken key.
 *   3. The model suggestions come from the Host's projection. `allowedPlayerModels` is published at
 *      `host/src/tavern/browser-contract/index.ts:729`, parsed at
 *      `dialogue-web/src/management-pipeline-api.ts:955` - and until `01a809ed` nothing in
 *      `dialogue-web/src/components` read it, so the guidance existed and never arrived. Both halves
 *      are asserted here, in the mounted product: a provider this product does not run names NO
 *      model, and what the catalog does publish reaches the browser as a labelled suggestion without
 *      being typed in on the player's behalf.
 *   4. A save with a syntactically valid id the endpoint does not serve succeeds, because the Host
 *      checks the id's SHAPE; the Test button is what tells the truth, and it says what the endpoint
 *      does serve, which is the fact that lets the player fix the id instead of doubting the key.
 *   5. The id the player ends up with is the id the runtime is handed. The correction comes from the
 *      probe's own listing, and the assertion reads the product's own answer: the surface selection
 *      the runtime resolves, and the provider entry Pi is handed. What this step cannot reach is the
 *      HTTP request itself - Pi's adapter turns that entry into `POST <baseUrl>/chat/completions`
 *      with `model: <id>`, and that hop belongs to Pi, not to this package. It is measured by
 *      `tools/live-run/chat/run-wire-contract-live.mjs`, which drives this same stub provider; the
 *      two together cover the chain, neither alone does.
 *
 * Step 1 is already covered: `settings-default-provider.spec.ts` pins that a fresh install lands on
 * no provider.
 *
 * Two defects this journey cannot catch, and does not pretend to: a wrong price constant
 * (`host/src/gameplay-task-subagent.ts`, `host/src/tavern/pi-provider-store.ts`). A stub provider
 * only answers what it is told, so a rate that is 5x off stays 5x off here. Those belong to the
 * catalog-fact gate (`tools/check-catalog-fact-ownership.mjs`), not to this file.
 *
 * What is real vs supplied: the provider projection and every connection record are the Host's own
 * (`createTavernConnectionService()`, with the real probe against a local stub), never a hand-written
 * catalogue, so a curated id added to or removed from `host/src/tavern/provider-catalog.ts` moves this
 * journey with it. The composed shell's bootstrap/draft/language/voice routes are supplied as
 * projections, exactly as `first-screen.spec.ts` mounts them - this journey is about the connection
 * form, not about those.
 *
 * The local endpoint is `tools/live-run/core/stub-provider.mjs`, the same one the live runs mount;
 * this file has no second one.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startLocalStubProvider } from "../../tools/live-run/core/stub-provider.mjs";
import { bindWindowsStaleLockReclaimer } from "../../host/src/path-lock.ts";
import type {
  TavernConnectionCreateCommandV1,
  TavernConnectionStateV1,
} from "../../host/src/tavern/browser-contract/index.ts";
import { createTavernConnectionService, type TavernConnectionService } from "../../host/src/tavern/connection-service.ts";
import { modelProviderEntry } from "../../host/src/tavern/pi-provider-store.ts";
import { resolveSurfaceModelSelection } from "../../host/src/settings/model-selection.ts";
import { createBuildWindowsStaleLockReclaimer } from "../../host/src/windows-stale-lock-reclaimer/index.ts";
import { type Page, expect, test } from "./frontend-coverage";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const composedChat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
    title: null,
    transcript: [],
    draft: { revision: 4, present: true },
    turn: null,
    worldInfo: null,
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const composedGame = {
  apiVersion: 1,
  build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
  csrfToken,
  browserSession: { expiresAtMs },
  game: {
    prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
    instance: { status: "none", gameTitle: null, generation: 0 },
    compatibility: { status: "unchecked", message: null },
    attachment: { status: "none", generation: 0 },
    connectionStatus: "none",
    actionAuthority: "unavailable",
    role: null,
    companionName: null,
    selectedWorld: null,
    selectedSave: null,
    capabilitySummary: { available: false, count: 0 },
    latestOutcome: "none",
  },
};

const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: composedChat,
  game: composedGame,
};

function json200(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

/** One player's runtime directory, and the Host's own connection projection over it. */
let agentDir: string;
let connection: TavernConnectionService;

test.beforeAll(async () => {
  // The connection store takes a durable path lock; this is the same test-only reclaimer binding the
  // Host's own connection-route test uses (`host/src/tavern-management-connection-routes.test.ts`).
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

// A fresh player root per test: one record accumulating across steps would make each step's row
// assertions depend on the order the file happens to run in.
test.beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "gamebuddy-first-run-"));
  connection = createTavernConnectionService({ agentDir });
});

test.afterEach(async () => {
  await connection.close();
  await rm(agentDir, { recursive: true, force: true });
});

test.afterAll(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

/** Every route the composed shell and the settings panels read, with one connection state supplied. */
async function mountProduct(page: Page, state: TavernConnectionStateV1): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  // The store's own records, and the projection this mount was handed: a test may state a providers
  // list the shipped catalog does not hold, while the records stay the Host's real ones.
  await page.route("**/api/tavern/v1/settings/connection", async (route) =>
    route.fulfill(json200({ ...(await connection.read()), providers: state.providers })),
  );
  // The connection writes are the product's own service, called with the command the browser sent:
  // this mount replaces the transport, not the answer. `environment`/`apiKey` arrive exactly as the
  // form built them, so what a save accepts is the Host's rule and not this file's.
  await page.route("**/api/tavern/v1/settings/connections", async (route) => {
    const command = route.request().postDataJSON() as TavernConnectionCreateCommandV1;
    if (route.request().method() !== "POST") return await route.fulfill({ status: 405 });
    return await route.fulfill(json200(await connection.create(command)));
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/test$/u, async (route) => {
    const connectionId = lastConnectionId(route.request().url());
    const { expectedRevision } = route.request().postDataJSON() as { expectedRevision: number };
    await route.fulfill(json200(await connection.test(connectionId, expectedRevision)));
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/activate$/u, async (route) => {
    const connectionId = lastConnectionId(route.request().url());
    const { expectedRevision } = route.request().postDataJSON() as { expectedRevision: number };
    await route.fulfill(json200(await connection.activate(connectionId, expectedRevision)));
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/model$/u, async (route) => {
    const connectionId = lastConnectionId(route.request().url());
    const command = route.request().postDataJSON() as {
      apiVersion: 1;
      expectedRevision: number;
      modelId: string;
      thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    };
    await route.fulfill(json200(await connection.selectModel(connectionId, command)));
  });
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(json200({ revision: 1, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      json200({
        revision: 1,
        disclosureVersion: null,
        consent: "undecided",
        decidedAtMs: null,
        outputDevice: null,
        persona: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill(json200({ devices: [{ id: "waveout:1", name: "Speakers" }], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        recommendedModels: [],
        chat: { revision: 0, thinkingLevel: "high" },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    ),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-surface").locator("[data-connection-form]")).toBeVisible();
}

/** The connection form as the player reads it: what is chosen, what is typed, what is suggested. */
async function readForm(page: Page) {
  const form = page.getByTestId("settings-surface").locator("[data-connection-form]");
  return await form.evaluate((node) => ({
    selected: node.querySelector<HTMLSelectElement>("#connection-provider")?.value ?? "(no picker)",
    modelField: node.querySelector<HTMLInputElement>("#connection-model-id")?.value ?? null,
    suggestions: [...node.querySelectorAll<HTMLOptionElement>("#connection-model-options option")].map((option) => ({
      value: option.value,
      label: option.label,
    })),
    catalogCount: node.querySelector("[data-connection-catalog-count]")?.textContent?.trim() ?? null,
    servedCount: node.querySelector("[data-connection-served-count]")?.textContent?.trim() ?? null,
  }));
}

const form = (page: Page) => page.getByTestId("settings-surface").locator("[data-connection-form]");

/** The opaque write handle a connection route is about, read off its own URL. */
function lastConnectionId(url: string): string {
  const segments = new URL(url).pathname.split("/");
  const connectionId = segments[segments.length - 2];
  if (connectionId === undefined) throw new Error(`not_a_connection_route: ${url}`);
  return connectionId;
}

/**
 * Everything this form NAMES, in the strings a player can read or the browser may show them: the
 * rendered text, every control's value and placeholder, every option's value and label, every
 * title. A model id is a name, so a leaked id is a leak in one of these - and the placeholder is
 * exactly where the measured defect sat (an id stood there as the hint itself).
 */
async function readNamedStrings(page: Page): Promise<string[]> {
  return await form(page).evaluate((node) => {
    const named = [(node.textContent ?? "").replace(/\s+/gu, " ").trim()];
    for (const control of [...node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")])
      named.push(control.value ?? "", control.placeholder ?? "");
    for (const option of [...node.querySelectorAll<HTMLOptionElement>("option")]) named.push(option.value, option.label);
    for (const titled of [...node.querySelectorAll<HTMLElement>("[title]")])
      named.push(titled.getAttribute("title") ?? "");
    return named.filter((entry) => entry.length > 0);
  });
}

test.describe("2: choosing a provider fills what it can, and names nothing it cannot", () => {
  test("a pinned provider asks for its own fields, and never names a model another entry publishes", async ({
    page,
  }) => {
    const state = await connection.read();
    // The ids the catalog publishes for entries OTHER than the one selected. An id is scoped to the
    // endpoint that serves it, so a form for `api.deepseek.com` naming the operator gateway's id (or
    // an Ollama id, which is the literal this journey was filed for) is claiming something untrue
    // about whose endpoint the player is configuring.
    const curated = await curatedIdsFromCatalog();
    expect(curated.length, "the catalog publishes at least one id, so the rule below is not vacuous").toBeGreaterThan(0);

    await mountProduct(page, state);
    for (const providerId of ["deepseek", "openai"]) {
      const provider = state.providers.find((entry) => entry.providerId === providerId);
      expect(provider, `${providerId} is offered to a browser`).toBeDefined();
      // What this entry asks for, read from the projection rather than restated: the player's key and
      // the player's model. The endpoint and the API shape are the product's own for a pinned entry.
      expect(provider!.setupFields).toEqual(expect.arrayContaining(["apiKey", "modelId"]));
      expect(provider!.setupFields).not.toContain("baseUrl");
      expect(provider!.setupFields).not.toContain("apiShape");

      await form(page).locator("#connection-provider").selectOption(providerId);
      // What it can ask, it asks.
      await expect(form(page).locator("#connection-api-key")).toBeVisible();
      await expect(form(page).locator("#connection-model-id")).toBeVisible();
      // What the player cannot answer, it does not ask.
      await expect(form(page).locator("#connection-base-url")).toHaveCount(0);
      await expect(form(page).locator("#connection-api-shape")).toHaveCount(0);

      const named = await readNamedStrings(page);
      console.log(`[first-run-names-nothing/${providerId}] ${JSON.stringify(named)}`);
      for (const modelId of [...curated.map((model) => model.modelId), "qwen2.5-coder:7b"]) {
        expect(
          named.filter((entry) => entry.includes(modelId)),
          `${providerId} must not name ${modelId}, which its endpoint does not serve`,
        ).toEqual([]);
      }
      // The absence is not vacuous: the form does name the entry the player is configuring.
      expect(named.some((entry) => entry.includes(provider!.label)), "the form names its own provider").toBe(true);
    }
  });
});

test.describe("3: the model suggestions are the Host's projection, reached end to end", () => {
  test("a provider whose endpoint this product does not run names no model at all", async ({ page }) => {
    const state = await connection.read();
    const published = new Map(state.providers.map((p) => [p.providerId, p.allowedPlayerModels.map((m) => m.modelId)]));
    // The premise, asserted rather than assumed: this product runs neither endpoint, so it publishes
    // no id for either. If the catalog ever publishes one, the journey below is measuring it.
    for (const providerId of ["deepseek", "openai"]) {
      expect(published.get(providerId), `${providerId} is offered to a browser`).toEqual([]);
    }

    await mountProduct(page, state);
    for (const providerId of ["deepseek", "openai"]) {
      await form(page).locator("#connection-provider").selectOption(providerId);
      const reading = await readForm(page);
      console.log(`[first-run-names-no-model/${providerId}] ${JSON.stringify(reading)}`);

      expect(reading.selected, `${providerId} is the entry the player chose`).toBe(providerId);
      // The model is the player's: an endpoint we do not run must not be described by a guess.
      // Asserted as an equality against the projection, so an id added to the catalog shows up as a
      // suggestion here and an id the panel invents shows up as a suggestion the Host never sent.
      expect(reading.suggestions.map((s) => s.value), `${providerId}: nothing is offered`).toEqual([]);
      expect(reading.modelField, `${providerId}: nothing is typed in for the player`).toBe("");
      expect(reading.catalogCount, `${providerId}: no count sentence either`).toBeNull();
    }
  });

  test("an id the catalog does publish reaches the browser, labelled as a suggestion and not prefilled", async ({
    page,
  }) => {
    const real = await connection.read();
    // The shipped catalog publishes curated ids for exactly one entry - the operator's own gateway -
    // and that entry declares no model field at all (`setupFields: []`), so no shipped provider
    // carries both. This mount therefore hands `deepseek` the ids the catalog really declares, from
    // the operator entry: the ids and the entry are the product's, only their pairing is the
    // fixture. The property under test is the panel's, not the catalog's.
    const curated = await curatedIdsFromCatalog();
    expect(curated.length, "the catalog declares at least one curated id, so this is not vacuous").toBeGreaterThan(0);

    const state: TavernConnectionStateV1 = {
      ...real,
      providers: real.providers.map((provider) =>
        provider.providerId === "deepseek" ? { ...provider, allowedPlayerModels: curated } : provider,
      ),
    };
    await mountProduct(page, state);
    await form(page).locator("#connection-provider").selectOption("deepseek");
    const reading = await readForm(page);
    console.log(`[first-run-suggestions-arrive] ${JSON.stringify(reading)}`);

    // What the projection published is exactly what the browser offers - the whole point of a
    // field that was projected and read by nobody.
    expect(reading.suggestions.map((s) => s.value)).toEqual(curated.map((model) => model.modelId));
    // Labelled for what it is: a suggestion the endpoint may refuse, never "served by this endpoint".
    for (const suggestion of reading.suggestions) expect(suggestion.label).toBe("suggested by GameBuddy; the endpoint decides");
    expect(reading.servedCount, "nothing has been probed, so nothing claims to be served").toBeNull();
    // A suggestion is not a prefill: naming one silently would claim the endpoint serves it.
    expect(reading.modelField, "the player still types the model").toBe("");
    expect(reading.catalogCount).toBe(`${curated.length} suggestions from GameBuddy's catalog`);
  });
});

/** The id this journey's own endpoint serves, and the one it does not. */
const SERVED = "stub-served-model-1";
const UNSERVED = "qwen2.5-coder:7b";
const PLAYER_KEY = "sk-first-run-journey-0001";

const connectionRow = (page: Page) => page.getByTestId("settings-surface").locator("[data-connection-row]");

test.describe("4: an unserved id saves, and the probe is what tells the truth", () => {
  test("a syntactically valid id the endpoint does not serve saves, cannot be activated, and the test says so", async ({
    page,
  }) => {
    const stub = await startLocalStubProvider({ modelId: SERVED, reply: "The kettle is on." });
    try {
      await mountProduct(page, await connection.read());
      // The escape hatch is the one entry whose endpoint the player supplies, so it is the one that
      // can be pointed at an endpoint this test serves.
      await form(page).locator("#connection-provider").selectOption("gamebuddy-openai-compatible");
      await form(page).locator("#connection-base-url").fill(stub.baseUrl);
      await form(page).locator("#connection-api-key").fill(PLAYER_KEY);
      await form(page).locator("#connection-model-id").fill(UNSERVED);
      await form(page).getByRole("button", { name: "Save connection", exact: true }).click();

      // The save-time answer is the Host's own: the id's SHAPE was accepted, and nothing has been
      // asked of the endpoint yet. This is the state a player can be left believing works.
      await expect(connectionRow(page)).toHaveAttribute("data-readiness", "configured");
      await expect(connectionRow(page)).toContainText(UNSERVED);
      await expect(connectionRow(page).locator("[data-connection-untested]")).toHaveText(
        "Test the connection before activating it.",
      );
      await expect(connectionRow(page).getByRole("button", { name: "Save and activate" })).toBeDisabled();

      // The Test is the step that tells the truth, and it tells it against the real endpoint.
      await connectionRow(page).getByRole("button", { name: "Test connection", exact: true }).click();
      await expect(connectionRow(page)).toHaveAttribute("data-readiness", "failed");
      await expect(connectionRow(page).locator("[data-connection-failure]")).toHaveText(
        "The endpoint did not offer the selected model.",
      );
      // What the endpoint DOES serve, from the probe's own listing: the fact that lets the player fix
      // the id instead of doubting their key.
      await expect(connectionRow(page).locator("[data-connection-model-count]")).toHaveText(
        "1 models offered, but not the one you picked.",
      );
      await expect(connectionRow(page).getByRole("button", { name: "Save and activate" })).toBeDisabled();
      console.log(`[first-run-unserved-id] ${JSON.stringify(await connection.read())}`);
    } finally {
      await stub.close();
    }
  });
});

test.describe("5: the id the player typed is the id the runtime is handed", () => {
  test("after the probe's listing corrects the id, activation hands the runtime that exact id and endpoint", async ({
    page,
  }) => {
    const stub = await startLocalStubProvider({ modelId: SERVED, reply: "The kettle is on." });
    const runtimeRoot = await mkdtemp(join(tmpdir(), "gamebuddy-first-run-runtime-"));
    try {
      await mountProduct(page, await connection.read());
      await form(page).locator("#connection-provider").selectOption("gamebuddy-openai-compatible");
      await form(page).locator("#connection-base-url").fill(stub.baseUrl);
      await form(page).locator("#connection-api-key").fill(PLAYER_KEY);
      await form(page).locator("#connection-model-id").fill(UNSERVED);
      await form(page).getByRole("button", { name: "Save connection", exact: true }).click();
      await expect(connectionRow(page)).toHaveAttribute("data-readiness", "configured");
      await connectionRow(page).getByRole("button", { name: "Test connection", exact: true }).click();
      await expect(connectionRow(page)).toHaveAttribute("data-readiness", "failed");

      // The fix the probe's own listing makes possible: the row offers what the endpoint served, and
      // the player picks it rather than guessing. Nothing in this test types the served id into the
      // product's records - it arrives from the endpoint's `/models` answer.
      await connectionRow(page).locator("select").first().selectOption(SERVED);
      await expect(connectionRow(page)).toContainText(SERVED);
      await connectionRow(page).getByRole("button", { name: "Test connection", exact: true }).click();
      await expect(connectionRow(page)).toHaveAttribute("data-readiness", "ready");
      await connectionRow(page).getByRole("button", { name: "Save and activate", exact: true }).click();
      // The row says so in its own words, and the store says so durably: the assertion is on both,
      // because a button that reads as shut is also shut while a request is in flight.
      await expect(page.getByTestId("settings-surface").locator("[data-connection-activated]")).toBeVisible();
      await expect
        .poll(async () => (await connection.read()).active?.modelId, { message: "the store's active record" })
        .toBe(SERVED);
      const active = (await connection.read()).active;
      expect(active?.modelId, "the record the runtime resolves is the corrected id").toBe(SERVED);

      // The product's own answer to "what model does this surface run": the surface profile and the
      // ACTIVE connection, not an argument this test passes in.
      const selection = await resolveSurfaceModelSelection({ runtimeRoot, agentDir, surface: "chat" });
      expect(selection.status, "a player who activated a connection has a model").toBe("selected");
      if (selection.status !== "selected") throw new Error("unreachable");
      // The surface's model and provider are the ACTIVE connection's, not a default beside it.
      expect(selection.modelConfig.modelId, "the surface runs the connection's model").toBe(SERVED);
      expect(selection.modelConfig.provider).toBe("gamebuddy-openai-compatible");

      // …and the entry Pi is handed: the model the product resolved, the endpoint the player typed,
      // and the API shape that endpoint speaks. This is the last point the product's own code reaches.
      const provided = await modelProviderEntry(agentDir, selection.modelConfig);
      expect(provided?.providerId).toBe("gamebuddy-openai-compatible");
      const entry = provided!.entry as Readonly<{
        baseUrl: string;
        api: string;
        models: readonly Readonly<{ id: string }>[];
      }>;
      console.log(`[first-run-handed-to-runtime] ${JSON.stringify({ selection: selection.modelConfig, entry })}`);
      expect(entry.models.map((model) => model.id), "the id the player ended up with is the id Pi is told").toEqual([
        SERVED,
      ]);
      expect(entry.baseUrl, "and the endpoint the player typed").toBe(stub.baseUrl);
      expect(entry.api, "speaking the shape the record states").toBe("openai-completions");
    } finally {
      await stub.close();
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});

/**
 * The ids the shipped catalog really declares for its one curated entry, read through the same
 * service the browser reads rather than restated here.
 */
async function curatedIdsFromCatalog(): Promise<TavernConnectionStateV1["providers"][number]["allowedPlayerModels"]> {
  const previous = process.env.GAMEBUDDY_OPERATOR_GATEWAY;
  process.env.GAMEBUDDY_OPERATOR_GATEWAY = "1";
  try {
    const offered = await connection.read();
    return offered.providers.find((provider) => provider.providerId === "cpa-oai")?.allowedPlayerModels ?? [];
  } finally {
    if (previous === undefined) delete process.env.GAMEBUDDY_OPERATOR_GATEWAY;
    else process.env.GAMEBUDDY_OPERATOR_GATEWAY = previous;
  }
}
