/**
 * The first-run journey: what a player with nothing configured meets, in order.
 *
 * This file grows one step at a time, each step committed on its own so a dropped transport cannot
 * take the whole journey with it. Steps present today:
 *
 *   3. The model suggestions come from the Host's projection. `allowedPlayerModels` is published at
 *      `host/src/tavern/browser-contract/index.ts:729`, parsed at
 *      `dialogue-web/src/management-pipeline-api.ts:955` - and until `01a809ed` nothing in
 *      `dialogue-web/src/components` read it, so the guidance existed and never arrived. Both halves
 *      are asserted here end to end, in the mounted product: a provider this product does not run
 *      names NO model (an id guessed for `api.deepseek.com` made the endpoint's honest `not_found`
 *      read as a broken key), and what the catalog does publish reaches the browser as a labelled
 *      suggestion without being typed in on the player's behalf.
 *
 * Steps 1 and 2 are already covered: `settings-default-provider.spec.ts` pins that a fresh install
 * lands on no provider, and `settings-connection-untested.spec.ts` pins the untested row's sentence.
 *
 * Two defects this journey cannot catch, and does not pretend to: a wrong price constant
 * (`host/src/gameplay-task-subagent.ts`, `host/src/tavern/pi-provider-store.ts`). A stub provider
 * only answers what it is told, so a rate that is 5x off stays 5x off here. Those belong to the
 * catalog-fact gate (`tools/check-catalog-fact-ownership.mjs`), not to this file.
 *
 * What is real vs supplied: the provider projection is the Host's own
 * (`createTavernConnectionService().read()`), never a hand-written catalogue, so a curated id
 * added to or removed from `host/src/tavern/provider-catalog.ts` moves this journey with it. The
 * composed shell's bootstrap/draft/language/voice routes are supplied as projections, exactly as
 * `first-screen.spec.ts` mounts them - this journey is about the connection form, not about those.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindWindowsStaleLockReclaimer } from "../../host/src/path-lock.ts";
import type { TavernConnectionStateV1 } from "../../host/src/tavern/browser-contract/index.ts";
import { createTavernConnectionService, type TavernConnectionService } from "../../host/src/tavern/connection-service.ts";
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
  agentDir = await mkdtemp(join(tmpdir(), "gamebuddy-first-run-"));
  connection = createTavernConnectionService({ agentDir });
});

test.afterAll(async () => {
  await connection.close();
  await rm(agentDir, { recursive: true, force: true });
  bindWindowsStaleLockReclaimer(undefined);
});

/** Every route the composed shell and the settings panels read, with one connection state supplied. */
async function mountProduct(page: Page, state: TavernConnectionStateV1): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) => route.fulfill(json200(state)));
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
