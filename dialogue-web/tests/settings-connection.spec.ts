/**
 * The Settings surface's connection group: creating, testing and activating one.
 *
 * The API key is submitted once and never reaches the document, a local endpoint that needs no
 * credential saves keyless and still probes ready, the form offers exactly what the endpoint's
 * own listing serves, and a typed id it does not serve never becomes ready.
 */
import { expect, test } from "./frontend-coverage";
import { token, csrfToken, draft, root } from "./composed-reference-game-fixtures";

/**
 * The product Settings surface's connection journey (design/28 §1, §5.1).
 *
 * The owner reported that Settings showed neither an API key field nor model
 * selection. This is the end-to-end proof over the frozen routes: the
 * OpenAI-compatible entry (the one catalog entry that declares `apiKey` and
 * `baseUrl`) creates a draft record whose credential is write-only, the
 * Host-owned probe is run, the now-ready record is activated, and the record's
 * own thinking-level control goes through `/model`. A catalog provider with a
 * real model dropdown is mounted alongside it, so both "API key" and "model
 * selection" are exercised rather than asserted from source alone.
 *
 * The credential assertion is the point of the test: the typed key must be sent
 * exactly once, and must never be readable from the document afterwards.
 */
test("the product Settings surface creates, tests and activates a connection whose API key never reaches the document", async ({ page }) => {
  const connectionId = "H".repeat(42) + "A";
  const baseUrl = "http://127.0.0.1:11434/v1";
  const apiKey = "sk-local-probe-secret-0001";
  const modelId = "qwen2.5-coder:7b";
  const escapeHatch = {
    providerId: "openai-compatible",
    label: "OpenAI-compatible",
    setupFields: ["apiKey", "baseUrl", "apiShape", "modelId"],
    allowedPlayerModels: [],
    escapeHatch: true,
    environmentManaged: false,
  };
  const catalogProvider = {
    providerId: "openai",
    label: "OpenAI",
    // A pinned entry declares `modelId` too, and publishes no model list: `api.openai.com` serves ids
    // this Host does not know, so the endpoint's own listing is the list.
    setupFields: ["apiKey", "modelId"],
    allowedPlayerModels: [],
    escapeHatch: false,
    environmentManaged: false,
  };

  const writes: Array<{ path: string; method: string; body: unknown; csrf: string | undefined }> = [];
  let recordCreated = false;
  let readiness: "configured" | "ready" = "configured";
  // What the endpoint's own `/models` listing served, as of the last probe. Null before one.
  let servedModels: readonly string[] | null = null;
  let active = false;
  let recordModelId = modelId;
  let recordThinkingLevel = "high";

  // The active selection is a narrower projection than a list row (it has no
  // `providerId`/`configured`/`active`/`allowedThinkingLevels`), and the client
  // validates it with an exact key set; emitting the row shape here is rejected.
  const activeRow = () => ({
    connectionId,
    label: escapeHatch.label,
    providerLabel: escapeHatch.label,
    modelId: recordModelId,
    modelLabel: recordModelId,
    thinkingLevel: recordThinkingLevel,
    readiness,
    baseUrl,
    failure: null,
    lastCheckedAtMs: null,
  });
  const connectionRow = () => ({
    connectionId,
    label: escapeHatch.label,
    providerId: escapeHatch.providerId,
    providerLabel: escapeHatch.label,
    configured: true,
    readiness,
    active,
    modelId: recordModelId,
    modelLabel: recordModelId,
    thinkingLevel: recordThinkingLevel,
    allowedThinkingLevels: ["low", "high"],
    modelIds: servedModels,
    baseUrl,
    failure: null,
    lastCheckedAtMs: null,
  });
  const connectionState = () => ({
    apiVersion: 1,
    revision: 1,
    active: active ? activeRow() : null,
    connections: recordCreated ? [connectionRow()] : [],
    providers: [escapeHatch, catalogProvider],
  });

  const record = (route: import("@playwright/test").Route): void => {
    writes.push({
      path: new URL(route.request().url()).pathname,
      method: route.request().method(),
      body: route.request().postDataJSON(),
      csrf: route.request().headers()["x-csrf-token"],
    });
  };

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 1, locale: "en-US" }) }),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
    }),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices: [], defaultSelectable: true }) }),
  );
  // The read route is singular and the create route plural: the frozen contract,
  // and the reason each one has its own anchored pattern (the plural is a prefix
  // of the singularity, so an unanchored glob would let either serve the other).
  await page.route(/\/api\/tavern\/v1\/settings\/connection$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) }),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connections$/, async (route) => {
    record(route);
    recordCreated = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/test$/, async (route) => {
    record(route);
    // The endpoint answers with its own listing, which includes the model the player named.
    servedModels = [modelId, "llama-3.1-8b", "phi-4"];
    readiness = "ready";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, connectionId, outcome: "ready", failure: null, state: connectionState() }),
    });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/activate$/, async (route) => {
    record(route);
    active = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/model$/, async (route) => {
    record(route);
    const command = route.request().postDataJSON() as { modelId: string; thinkingLevel: string };
    recordModelId = command.modelId;
    recordThinkingLevel = command.thinkingLevel;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const surface = page.getByTestId("settings-surface");
  await expect(surface).toBeVisible();
  const panel = surface.locator("[data-connection-settings]");
  await expect(panel).toBeVisible();

  // Both entries reach the same model control, and neither offers an id it cannot know: the
  // player types the one their endpoint serves, and a probe's listing is offered beside it.
  await panel.locator("#connection-provider").selectOption("openai");
  await expect(panel.locator("#connection-model-id")).toBeVisible();
  await expect(panel.locator("#connection-model-id")).toHaveAttribute("list", "connection-model-options");
  await panel.locator("#connection-provider").selectOption("openai-compatible");
  await expect(panel.locator("#connection-api-key")).toBeVisible();
  await expect(panel.locator("#connection-base-url")).toBeVisible();
  await expect(panel.locator("#connection-model-id")).toBeVisible();

  await panel.locator("#connection-base-url").fill(baseUrl);
  await panel.locator("#connection-api-key").fill(apiKey);
  await panel.locator("#connection-model-id").fill(modelId);
  await panel.getByRole("button", { name: "Save connection" }).click();

  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    path: "/api/tavern/v1/settings/connections",
    method: "POST",
    body: {
      apiVersion: 1,
      providerId: "openai-compatible",
      apiKey,
      baseUrl,
      apiShape: "openai-completions",
      modelId,
    },
    csrf: csrfToken,
  });
  // The credential is write-only: the request carried it once, and once the
  // durable save has cleared the field the document must carry no copy of it -
  // neither as markup (the controlled input reflects its value as an attribute)
  // nor as rendered text. The poll waits for React to apply the clear, then
  // holds the document to zero occurrences.
  const documentCarriesKey = async (): Promise<boolean> => {
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const text = await page.evaluate(() => document.body.innerText);
    return html.includes(apiKey) || text.includes(apiKey);
  };
  await expect(panel.locator("#connection-api-key")).toHaveValue("");
  await expect.poll(documentCarriesKey).toBe(false);

  await panel.getByRole("button", { name: "Test connection" }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({
    path: `/api/tavern/v1/settings/connections/${connectionId}/test`,
    method: "POST",
    body: { apiVersion: 1, expectedRevision: 1 },
    csrf: csrfToken,
  });
  await expect(panel.locator("[data-connection-row]")).toContainText("Ready");
  // The test result is legible where the endpoint and model fields are, and it says how many
  // models the endpoint offered and whether the one this record names is among them.
  await expect(panel.locator("[data-connection-row] [data-connection-model-count]")).toHaveText(
    "3 models offered; the one you picked is among them.",
  );
  // The row now offers the endpoint's own listing, so the player can pick one of those instead.
  const rowModel = panel.locator(`#connection-model-${connectionId}`);
  await expect(rowModel).toBeVisible();
  await expect(rowModel.locator("option")).toHaveCount(3);
  // ...and the draft form offers them too.
  await expect(panel.locator("#connection-model-options option")).toHaveCount(3);
  await expect.poll(documentCarriesKey).toBe(false);

  await panel.getByRole("button", { name: "Save and activate" }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toEqual({
    path: `/api/tavern/v1/settings/connections/${connectionId}/activate`,
    method: "POST",
    body: { apiVersion: 1, expectedRevision: 1 },
    csrf: csrfToken,
  });
  await expect(panel.locator("[data-connection-active-value]")).toHaveText("OpenAI-compatible");

  // The record's own model control is the `/model` route, not a second create.
  await panel.locator(`#connection-level-${connectionId}`).selectOption("low");
  await expect.poll(() => writes.length).toBe(4);
  expect(writes[3]).toEqual({
    path: `/api/tavern/v1/settings/connections/${connectionId}/model`,
    method: "POST",
    body: { apiVersion: 1, expectedRevision: 1, modelId, thinkingLevel: "low" },
    csrf: csrfToken,
  });
  // The whole journey - create, test, activate, model - never surfaces the key.
  await expect.poll(documentCarriesKey).toBe(false);
});


/**
 * A local endpoint that needs no credential at all (design/28 §1, §5.2).
 *
 * Ollama, LM Studio and vLLM need no key, and the panel used to demand one: the fact is the
 * player's to state, and once stated the connection saves without a credential and probes ready
 * against a `/models` that asks for none.
 */
test("a local endpoint that needs no credential saves keyless and probes ready", async ({ page }) => {
  const connectionId = "K".repeat(42) + "A";
  const baseUrl = "http://127.0.0.1:11434/v1";
  const modelId = "qwen2.5-coder:7b";
  const escapeHatch = {
    providerId: "openai-compatible",
    label: "OpenAI-compatible",
    setupFields: ["apiKey", "apiKeyRequired", "baseUrl", "apiShape", "modelId"],
    allowedPlayerModels: [],
    escapeHatch: true,
    environmentManaged: false,
  };
  const writes: Array<{ path: string; body: unknown }> = [];
  let readiness: "configured" | "ready" = "configured";

  const connectionState = () => ({
    apiVersion: 1,
    revision: 1,
    active: null,
    connections: [
      {
        connectionId,
        label: `OpenAI-compatible \u00b7 ${modelId}`,
        providerId: escapeHatch.providerId,
        providerLabel: escapeHatch.label,
        configured: true,
        readiness,
        active: false,
        modelId,
        modelLabel: modelId,
        thinkingLevel: "high",
        allowedThinkingLevels: ["low", "high", "max"],
        modelIds: [modelId, "llama-3.1-8b"],
        baseUrl,
        failure: null,
        lastCheckedAtMs: null,
      },
    ],
    providers: [escapeHatch],
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 1, locale: "en-US" }) }),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
    }),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices: [], defaultSelectable: true }) }),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connection$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) }),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connections$/, async (route) => {
    writes.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/test$/, async (route) => {
    writes.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    readiness = "ready";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, connectionId, outcome: "ready", failure: null, state: connectionState() }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByTestId("settings-surface").locator("[data-connection-settings]");
  await expect(panel).toBeVisible();

  await panel.locator("#connection-provider").selectOption("openai-compatible");
  await panel.locator("#connection-base-url").fill(baseUrl);
  await panel.locator("#connection-model-id").fill(modelId);
  // Stating that this endpoint needs no credential is one choice, and the key field goes away with it.
  await expect(panel.locator("#connection-api-key-required")).toHaveValue("required");
  await expect(panel.locator("#connection-api-key")).toBeVisible();
  await panel.locator("#connection-api-key-required").selectOption("none");
  await expect(panel.locator("#connection-api-key")).toHaveCount(0);

  await panel.getByRole("button", { name: "Save connection" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    path: "/api/tavern/v1/settings/connections",
    body: {
      apiVersion: 1,
      providerId: "openai-compatible",
      baseUrl,
      apiShape: "openai-completions",
      modelId,
      apiKeyRequired: false,
    },
  });

  await panel.getByRole("button", { name: "Test connection" }).click();
  await expect.poll(() => writes.length).toBe(2);
  await expect(panel.locator("[data-connection-row]")).toContainText("Ready");
  await expect(panel.getByRole("button", { name: "Save and activate" })).toBeEnabled();
});


/**
 * The endpoint's own model listing, in the draft form and on the record, and the
 * probe still deciding whether a typed id becomes usable (design/28 §5.1, §5.3).
 *
 * The owner's comparison with SillyTavern and Liyuan came down to one thing: they
 * render the model list their endpoint serves and this product read it and threw it
 * away. The provider here publishes NO model id of its own, because `api.openai.com`
 * does not serve the ids this project's gateway does: before any probe the form offers
 * nothing but the field itself, then the endpoint's three models appear, a typed id that
 * is not among them never becomes ready, and picking one that is turns the same record
 * ready. That is the whole fix - a guess could only ever disagree with `/models`.
 *
 * Measured at both widths: the endpoint-listing select's box and the test-result note's
 * box, and that neither the surface nor the document overflows.
 */
test("the endpoint's own listing is what the form offers, and a typed id it does not serve never becomes ready", async ({ page }) => {
  const connectionId = "L".repeat(42) + "A";
  const apiKey = "sk-typed-model-secret-0001";
  const invented = "gpt-9-invented";
  const catalogProvider = {
    providerId: "openai",
    label: "OpenAI",
    setupFields: ["apiKey", "modelId"],
    // Empty: the ids this entry used to suggest were this project's gateway's, not OpenAI's.
    allowedPlayerModels: [],
    escapeHatch: false,
    environmentManaged: false,
  };
  // What the endpoint says it serves.
  const listed = ["gpt-4o-mini", "gpt-5.6-luna", "gpt-5.5"];

  const writes: Array<{ path: string; body: unknown }> = [];
  let created = false;
  let recordModelId = "";
  let readiness: "configured" | "ready" | "failed" = "configured";
  let failure: string | null = null;

  const rowModelIds = (): readonly string[] | null => (readiness === "configured" ? null : listed);
  const connectionRow = () => ({
    connectionId,
    label: `${catalogProvider.label} \u00b7 ${recordModelId}`,
    providerId: catalogProvider.providerId,
    providerLabel: catalogProvider.label,
    configured: true,
    readiness,
    active: false,
    modelId: recordModelId,
    modelLabel: recordModelId,
    thinkingLevel: "high",
    allowedThinkingLevels: ["low", "high"],
    modelIds: rowModelIds(),
    baseUrl: null,
    failure,
    lastCheckedAtMs: null,
  });
  const connectionState = () => ({
    apiVersion: 1,
    revision: 1,
    active: null,
    connections: created ? [connectionRow()] : [],
    providers: [catalogProvider],
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 1, locale: "en-US" }) }),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
    }),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices: [], defaultSelectable: true }) }),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connection$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) }),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connections$/, async (route) => {
    const body = route.request().postDataJSON() as { modelId?: string };
    writes.push({ path: new URL(route.request().url()).pathname, body });
    recordModelId = body.modelId ?? listed[0]!;
    created = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/test$/, async (route) => {
    writes.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    // The probe's own answer: the endpoint listed these models, and only the model this
    // record names decides whether that is a ready connection.
    if (listed.includes(recordModelId)) {
      readiness = "ready";
      failure = null;
    } else {
      readiness = "failed";
      failure = "not_found";
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        connectionId,
        outcome: readiness === "ready" ? "ready" : "failed",
        failure,
        state: connectionState(),
      }),
    });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/model$/, async (route) => {
    const body = route.request().postDataJSON() as { modelId: string };
    writes.push({ path: new URL(route.request().url()).pathname, body });
    recordModelId = body.modelId;
    readiness = "configured";
    failure = null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByTestId("settings-surface").locator("[data-connection-settings]");
  await expect(panel).toBeVisible();

  // The entry pins its endpoint, so no base URL and no API shape: one key and one model field.
  await panel.locator("#connection-provider").selectOption("openai");
  await expect(panel.locator("#connection-base-url")).toHaveCount(0);
  await expect(panel.locator("#connection-model-id")).toBeVisible();
  // Nothing is offered before an endpoint has answered: the two ids this entry used to suggest were
  // the project's own gateway's, and `api.openai.com` never served them. The field then carries the
  // endpoint's own listing - and only that.
  await expect(panel.locator("#connection-model-options option")).toHaveCount(0);

  // A typed id the endpoint does not serve is accepted as a draft and never becomes ready.
  await panel.locator("#connection-api-key").fill(apiKey);
  await panel.locator("#connection-model-id").fill(invented);
  await panel.getByRole("button", { name: "Save connection" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    path: "/api/tavern/v1/settings/connections",
    body: { apiVersion: 1, providerId: "openai", apiKey, modelId: invented },
  });
  // Not probed yet: no listing is claimed, so there is neither a listing select nor a count.
  await expect(panel.locator("[data-connection-model-count]")).toHaveCount(0);
  await expect(panel.locator(`#connection-model-${connectionId}`)).toHaveCount(0);

  await panel.getByRole("button", { name: "Test connection" }).click();
  await expect.poll(() => writes.length).toBe(2);
  // The closed outcome, named at the field it is about, and the listing it was decided against.
  await expect(panel.locator("[data-connection-failure]")).toHaveText(
    "The endpoint did not offer the selected model.",
  );
  await expect(panel.locator("[data-connection-model-count]")).toHaveText(
    `${listed.length} models offered, but not the one you picked.`,
  );
  // The record is not ready, so it cannot be activated - the invariant the probe protects.
  await expect(panel.getByRole("button", { name: "Save and activate" })).toBeDisabled();

  // The endpoint's own listing is now what the form offers, and the record offers it too.
  await expect(panel.locator("#connection-model-options option")).toHaveCount(listed.length);
  await expect(panel.locator("#connection-model-options option").first()).toHaveAttribute(
    "label",
    "served by this endpoint",
  );
  const listingSelect = panel.locator(`#connection-model-${connectionId}`);
  await expect(listingSelect).toBeVisible();
  await expect(listingSelect.locator("option")).toHaveCount(listed.length + 1);

  // Picking one of the models the endpoint actually serves is a `/model` write, not a second create.
  await listingSelect.selectOption("gpt-4o-mini");
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toEqual({
    path: `/api/tavern/v1/settings/connections/${connectionId}/model`,
    body: { apiVersion: 1, expectedRevision: 1, modelId: "gpt-4o-mini", thinkingLevel: "high" },
  });

  // Tested again, the model the endpoint lists is ready, and the result says so where it stands.
  await panel.getByRole("button", { name: "Test connection" }).click();
  await expect.poll(() => writes.length).toBe(4);
  await expect(panel.locator("[data-connection-failure]")).toHaveCount(0);
  await expect(panel.locator("[data-connection-model-count]")).toHaveText(
    `${listed.length} models offered; the one you picked is among them.`,
  );
  await expect(panel.getByRole("button", { name: "Save and activate" })).toBeEnabled();

  /** The two boxes the owner asked to be measured, plus both overflow checks. */
  const measure = async (viewport: string) =>
    await page.evaluate(
      ({ connectionId, viewport }) => {
        const surface = document.querySelector<HTMLElement>('[data-testid="settings-surface"]');
        const box = (node: Element | null) => {
          if (node === null) return null;
          const box = node.getBoundingClientRect();
          return {
            top: Math.round(box.top),
            left: Math.round(box.left),
            width: Math.round(box.width),
            height: Math.round(box.height),
            right: Math.round(box.right),
          };
        };
        return {
          viewport,
          select: box(surface?.querySelector(`#connection-model-${connectionId}`) ?? null),
          note: box(surface?.querySelector("[data-connection-model-count]") ?? null),
          surface: box(surface),
          documentOverflows: document.documentElement.scrollWidth > window.innerWidth,
          surfaceOverflows: surface === null ? null : surface.scrollWidth > surface.clientWidth + 1,
        };
      },
      { connectionId, viewport },
    );
  const atWide = await measure("1440x900");
  console.log(`[model-listing @1440x900] ${JSON.stringify(atWide)}`);
  await page.setViewportSize({ width: 400, height: 800 });
  await expect(panel.locator(`#connection-model-${connectionId}`)).toBeVisible();
  const atNarrow = await measure("400x800");
  console.log(`[model-listing @400x800] ${JSON.stringify(atNarrow)}`);

  for (const measured of [atWide, atNarrow]) {
    expect(measured.select, `the listing select is rendered at ${measured.viewport}`).not.toBeNull();
    expect(measured.note, `the test-result note is rendered at ${measured.viewport}`).not.toBeNull();
    expect(measured.select!.width, `the listing select keeps a usable width at ${measured.viewport}`).toBeGreaterThan(80);
    expect(measured.note!.width, `the note has a width at ${measured.viewport}`).toBeGreaterThan(0);
    expect(measured.note!.right, `the note stays inside the surface at ${measured.viewport}`).toBeLessThanOrEqual(
      measured.surface!.right + 1,
    );
    expect(measured.documentOverflows, `the document does not overflow at ${measured.viewport}`).toBe(false);
    expect(measured.surfaceOverflows, `the settings surface does not overflow at ${measured.viewport}`).toBe(false);
  }
});


