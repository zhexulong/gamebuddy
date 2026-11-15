/**
 * A new player's connection journey, from the form to a message that can reach a model.
 *
 * The dead end this measures, in the order the player met it: fill the form, save, land on a row
 * reading `Configured, not tested` with its enable control shut, find a second control (`Test
 * connection`) that shares the row with it, press that, wait for a Host probe, then come back and
 * press a third control (`Save and activate`) - and, if they skip any of it, arrive at the Chat
 * with no model. Three acts and one of them is a gate nothing states in the place the gate is.
 *
 * The invariant this journey now holds, and the reason the third act is gone rather than merely
 * explained: a connection the Host's own probe answers `ready` becomes the active connection when
 * nothing is active. The player's second press is the one the row already points at, and it
 * finishes the job the label promises. Activation is still the Host's answer and never a local
 * claim - the client only decides to ASK for it, and only after a probe the Host called `ready`,
 * which is the same fact `connection_not_ready` gates on the Host side.
 *
 * A probe never switches a channel that is already chosen: pressing `Test connection` on a second
 * record while another one is active stays a test, so the label reverts to exactly that word. That
 * is the one case where testing and enabling are still two different acts, and it is the case the
 * player chose by activating a connection first.
 *
 * The probe's answer is the stub's: `/settings/connections/:id/test` is the Host's route, and the
 * journey never talks to a provider.
 */
import { expect, test } from "./frontend-coverage";
import { token, csrfToken, draft, root } from "./composed-reference-game-fixtures";
import type { Page } from "@playwright/test";

const connectionId = "J".repeat(42) + "A";
const apiKey = "sk-journey-secret-0001";
const modelId = "gpt-4o-mini";

const openai = {
  providerId: "openai",
  label: "OpenAI",
  // Both halves empty on purpose, and the Host's reason for it: `api.openai.com` retires ids on a
  // schedule this tree cannot track, so a pinned id here would be a suggestion that costs the
  // player a failed first test. The field is the player's, and the probe is what fills the list.
  setupFields: ["apiKey", "modelId"],
  allowedPlayerModels: [],
  escapeHatch: false,
  environmentManaged: false,
};

type Probe = "ready" | "failed";

type Host = Readonly<{
  probe: Probe;
  /** A connection already activated before this journey starts, for the "do not switch" reading. */
  activeBefore: boolean;
}>;

async function stubHost(page: Page, host: Host): Promise<{ writes: string[]; activeId: () => string | null }> {
  const writes: string[] = [];
  let created = false;
  let readiness: "configured" | "ready" | "failed" = "configured";
  let modelIds: readonly string[] | null = null;
  let activeId: string | null = host.activeBefore ? "O".repeat(42) + "A" : null;

  const others = host.activeBefore
    ? [
        {
          connectionId: "O".repeat(42) + "A",
          label: "DeepSeek · deepseek-chat",
          providerId: "deepseek",
          providerLabel: "DeepSeek",
          configured: true,
          readiness: "ready",
          active: true,
          modelId: "deepseek-chat",
          modelLabel: "deepseek-chat",
          thinkingLevel: "high",
          allowedThinkingLevels: ["low", "high"],
          modelIds: ["deepseek-chat"],
          baseUrl: null,
          failure: null,
          lastCheckedAtMs: null,
        },
      ]
    : [];

  const row = () => ({
    connectionId,
    label: `${openai.label} · ${modelId}`,
    providerId: openai.providerId,
    providerLabel: openai.label,
    configured: true,
    readiness,
    active: activeId === connectionId,
    modelId,
    modelLabel: modelId,
    thinkingLevel: "high",
    allowedThinkingLevels: ["low", "high"],
    modelIds,
    baseUrl: null,
    failure: readiness === "failed" ? "unauthorized" : null,
    lastCheckedAtMs: null,
  });
  const activeRow = () => {
    const source = activeId === connectionId ? row() : others[0]!;
    return {
      connectionId: source.connectionId,
      label: source.label,
      providerLabel: source.providerLabel,
      modelId: source.modelId,
      modelLabel: source.modelLabel,
      thinkingLevel: source.thinkingLevel,
      readiness: source.readiness,
      baseUrl: source.baseUrl,
      failure: source.failure,
      lastCheckedAtMs: source.lastCheckedAtMs,
    };
  };
  const state = () => ({
    apiVersion: 1,
    revision: 4,
    active: activeId === null ? null : activeRow(),
    connections: [...others, ...(created ? [row()] : [])],
    providers: [openai],
  });

  const fulfill = (route: import("@playwright/test").Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  const record = (route: import("@playwright/test").Route) =>
    writes.push(new URL(route.request().url()).pathname);

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => fulfill(route, root));
  await page.route("**/api/composed-reference-game/v1/state", (route) => fulfill(route, root));
  await page.route("**/api/tavern/v1/draft", (route) => fulfill(route, draft));
  await page.route("**/api/tavern/v1/settings/language", (route) => fulfill(route, { revision: 1, locale: "en-US" }));
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    fulfill(route, {
      revision: 1,
      disclosureVersion: null,
      consent: "undecided",
      decidedAtMs: null,
      outputDevice: null,
      persona: null,
    }),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    fulfill(route, { devices: [], defaultSelectable: true }),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    fulfill(route, {
      apiVersion: 1,
      recommendedModels: [],
      chat: { revision: 0, thinkingLevel: "high" },
      game: { revision: 0, thinkingLevel: "high" },
    }),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connection$/, (route) => fulfill(route, state()));
  await page.route(/\/api\/tavern\/v1\/settings\/connections$/, (route) => {
    record(route);
    created = true;
    return fulfill(route, state());
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/test$/, (route) => {
    record(route);
    readiness = host.probe;
    // The endpoint's own `/models` reply, which is the only list with evidence behind it.
    modelIds = host.probe === "ready" ? [modelId, "gpt-4.1", "gpt-4o"] : null;
    return fulfill(route, {
      apiVersion: 1,
      connectionId,
      outcome: host.probe,
      failure: host.probe === "failed" ? "unauthorized" : null,
      state: state(),
    });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/activate$/, (route) => {
    record(route);
    activeId = connectionId;
    return fulfill(route, state());
  });

  return { writes, activeId: () => activeId };
}

/**
 * The row as the player reads it: the readiness sentence, every control with its enabled state and
 * whether the panel paints it as the next action, and the panel's own guidance.
 */
async function readRow(page: Page) {
  const row = page.getByTestId("settings-surface").locator("[data-connection-row]").last();
  await expect(row).toBeVisible();
  return await row.evaluate((element) => {
    const controls = [...element.querySelectorAll<HTMLButtonElement>("button")];
    return {
      readiness: (() => {
        for (const term of element.querySelectorAll("dt"))
          if ((term.textContent ?? "").trim().toLowerCase() === "readiness")
            return (term.nextElementSibling?.textContent ?? "").trim();
        return "(no readiness row)";
      })(),
      controls: controls.map((control) => ({
        label: (control.textContent ?? "").trim(),
        disabled: control.disabled,
        primary: control.classList.contains("primary"),
      })),
      sentences: [...element.querySelectorAll("p")].map((line) => (line.textContent ?? "").replace(/\s+/gu, " ").trim()),
      pending: element.querySelector("[data-connection-pending]") === null ? null : "pending statement",
    };
  });
}

/** What the surface says about a message's route to a model, and whether one is available at all. */
async function readChat(page: Page, settlesTo: "no-model" | "model") {
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const chat = page.getByTestId("chat-surface");
  await expect(chat).toBeVisible();
  const noModel = chat.locator("[data-chat-no-model]");
  // The route is re-read on arrival (`readChatModelRoute`), so the surface settles a beat after the
  // conversation is visible: waiting for the count is waiting for the Host's answer, not for a timer.
  await expect(noModel).toHaveCount(settlesTo === "no-model" ? 1 : 0);
  return {
    noModelShown: (await noModel.count()) > 0,
    text: (await noModel.count()) === 0 ? null : (await noModel.innerText()).replace(/\s+/gu, " ").trim(),
  };
}

test("a saved connection is one press from being enabled, and the Chat reaches a model afterwards", async ({ page }) => {
  const host = await stubHost(page, { probe: "ready", activeBefore: false });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByTestId("settings-surface").locator("[data-connection-settings]");
  await expect(panel).toBeVisible();

  // Nothing is active yet, so the surface itself says a reply has no model to reach.
  const beforeAnything = await readChat(page, "no-model");
  console.log(`[journey/before] ${JSON.stringify(beforeAnything)}`);
  expect(beforeAnything.noModelShown, "with no connection the conversation says a reply has no model").toBe(true);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await panel.locator("#connection-provider").selectOption("openai");
  await panel.locator("#connection-api-key").fill(apiKey);
  await panel.locator("#connection-model-id").fill(modelId);
  await panel.getByRole("button", { name: "Save connection" }).click();
  await expect.poll(() => host.writes.length).toBe(1);

  const saved = await readRow(page);
  console.log(`[journey/saved] ${JSON.stringify(saved)}`);

  // Exactly one control moves this row forward, it is the one the panel paints, and the row states
  // what that press achieves. The enable control is not a second act the player has to find.
  const forward = saved.controls.filter((control) => control.primary);
  expect(forward.map((control) => control.label), "one control is the row's next action").toEqual(["Test connection"]);
  expect(
    saved.sentences,
    "and the row says what the press achieves, before it is pressed",
  ).toContain("Test the connection. If it passes, it becomes the active connection and the next message you send uses it.");
  expect(
    saved.controls.find((control) => control.label === "Save and activate")?.disabled,
    "and enabling is not a second control the player has to find and press",
  ).toBe(true);

  await panel.getByRole("button", { name: "Test connection" }).click();
  await expect.poll(() => host.writes.length).toBe(3);
  // Two Host calls, one press: the probe, then the activation the probe's own answer allows.
  expect(host.writes.slice(1), "the probe is asked first, and its answer is what asks for activation").toEqual([
    `/api/tavern/v1/settings/connections/${connectionId}/test`,
    `/api/tavern/v1/settings/connections/${connectionId}/activate`,
  ]);
  await expect(panel.locator("[data-connection-active-value]")).toHaveText(`OpenAI · ${modelId}`);

  const after = await readChat(page, "model");
  console.log(`[journey/after] ${JSON.stringify(after)}`);
  expect(after.noModelShown, "and the conversation stops saying it has no model").toBe(false);
});

test("a probe never switches a channel that is already active", async ({ page }) => {
  const host = await stubHost(page, { probe: "ready", activeBefore: true });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByTestId("settings-surface").locator("[data-connection-settings]");
  await expect(panel).toBeVisible();

  await panel.locator("#connection-provider").selectOption("openai");
  await panel.locator("#connection-api-key").fill(apiKey);
  await panel.locator("#connection-model-id").fill(modelId);
  await panel.getByRole("button", { name: "Save connection" }).click();
  await expect.poll(() => host.writes.length).toBe(1);
  await expect(panel.locator("[data-connection-row]")).toHaveCount(2);

  // With a channel already chosen, the same press is honestly described as a test: it reads the
  // endpoint and leaves the active connection where it is.
  const saved = await readRow(page);
  console.log(`[journey/other-active] ${JSON.stringify(saved)}`);
  expect(saved.sentences, "the row states that activation is the separate act here").toContain(
    "Test the connection before activating it.",
  );

  await panel.getByTestId("settings-surface").locator("[data-connection-row]").last();
  await panel
    .locator("[data-connection-row]")
    .last()
    .getByRole("button", { name: "Test connection" })
    .click();
  await expect.poll(() => host.writes.length).toBe(2);
  await expect(panel.locator("[data-connection-row]").last()).toHaveAttribute("data-readiness", "ready");
  expect(host.activeId(), "the probe read the endpoint and left the active connection alone").toBe("O".repeat(42) + "A");
  // Switching is still the player's own decision, and the control for it is now the one that is open.
  await expect(
    panel.locator("[data-connection-row]").last().getByRole("button", { name: "Save and activate" }),
  ).toBeEnabled();
});
