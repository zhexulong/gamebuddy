/**
 * A settings read that did not answer keeps its region, says so, and offers the read again.
 *
 * The defect: `management-surface-panels.tsx` rendered the connection section and the model editors
 * ONLY when their read was ready, so a transient failure removed both groups from the screen. The
 * player read that as "my connection is gone" - the same words a build that does not serve the route
 * would have earned, with no sentence, no control, and no way back but reloading the page (which
 * discarded every other group's read with it).
 *
 * The state already distinguished the two cases (`unavailable` is a route this build does not serve,
 * `error` is a failed re-read), and this file measures the shape the fix gives both: the group keeps its
 * heading, says what happened, and the read it came from is offered again. The retry is measured as a
 * real read - the profiles route starts answering on the second attempt, and the editor appears without
 * a reload.
 */
import { type Page, expect, test } from "./frontend-coverage";

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const chatHandle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle, generation: 1, stateRevision: chatHandle },
    chat: {
      companion: { name: "Mira", handle: "D".repeat(42) + "A" },
      title: null,
      transcript: [],
      draft: { revision: 4, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: null,
};

const profilesBody = {
  apiVersion: 1,
  chat: { revision: 1, thinkingLevel: "low" },
  game: { revision: 1, thinkingLevel: "low" },
  recommendedModels: [],
};

const json200 = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const failed = { status: 500, contentType: "application/json", body: JSON.stringify({ code: "unavailable" }) };

/**
 * The Settings surface with both settings groups failing, and the profile route answering from the
 * `profilesAnswersOn`-th GET on.
 */
async function mountWithFailingReads(page: Page, profilesAnswersOn: number): Promise<{ profileReads: number }> {
  const counter = { profileReads: 0 };
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200({ apiVersion: 1, revision: 4, text: null })));
  await page.route("**/api/tavern/v1/settings/language", (route) => route.fulfill(json200({ revision: 1, locale: "en-US" })));
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
    route.fulfill(json200({ devices: [], defaultSelectable: true })),
  );
  // The four groups that are NOT under test answer, so the reading below is about the two that do not:
  // a group that failed for its own reason would put a second, unrelated retry on the screen.
  await page.route("**/api/tavern/v1/settings/appearance", (route) =>
    route.fulfill(json200({ revision: 1, appearance: "system" })),
  );
  await page.route("**/api/tavern/v1/settings/ui-language", (route) =>
    route.fulfill(json200({ revision: 1, locale: "en" })),
  );
  await page.route("**/api/tavern/v1/settings/sampler", (route) =>
    route.fulfill(json200({ revision: 1, temperature: null })),
  );
  await page.route("**/api/tavern/v1/settings/game-prompt", (route) =>
    route.fulfill(json200({ revision: 1, addition: "" })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) => route.fulfill(failed));
  await page.route("**/api/tavern/v1/settings/profiles", async (route) => {
    counter.profileReads += 1;
    await route.fulfill(counter.profileReads >= profilesAnswersOn ? json200(profilesBody) : failed);
  });
  return counter;
}

test("a failed settings read keeps its region, and the retry is the read taken again", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const counter = await mountWithFailingReads(page, 2);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  const surface = page.getByTestId("settings-surface");
  await expect(surface).toBeVisible();

  // The two groups the defect deleted are still on the screen, each with its heading, one sentence and
  // the read offered again - and neither editor is drawn, because there is nothing to draw it from.
  const connection = surface.locator('[data-settings-unread="connection"]');
  const profiles = surface.locator('[data-settings-unread="model-profiles"]');
  await expect(connection).toBeVisible();
  await expect(profiles).toBeVisible();
  await expect(connection.getByRole("heading", { name: "Connection and model", exact: true })).toBeVisible();
  await expect(profiles.getByRole("heading", { name: "Model profiles", exact: true })).toBeVisible();
  await expect(connection).toContainText("Operation failed.");
  await expect(profiles).toContainText("Operation failed.");
  await expect(surface.locator("[data-connection-settings]")).toHaveCount(0);
  await expect(surface.locator("[data-model-profiles]")).toHaveCount(0);
  const before = await page.evaluate(() => ({
    unread: document.querySelectorAll("[data-settings-unread]").length,
    retries: document.querySelectorAll("[data-settings-read-retry]").length,
    profileEditors: document.querySelectorAll("[data-model-profiles]").length,
  }));
  console.log(`[settings-unread/before] ${JSON.stringify(before)}`);
  expect(before).toEqual({ unread: 2, retries: 2, profileEditors: 0 });
  expect(counter.profileReads, "one read per group at mount").toBe(1);

  // The press is a read, not a repaint: the route answers this time, and the editor it feeds appears
  // where the sentence was, on the same page.
  await surface.locator('[data-settings-read-retry="model-profiles"]').click();
  await expect(surface.locator("[data-model-profiles]")).toBeVisible();
  await expect(surface.locator("[data-model-profiles] #model-profile-level-chat")).toHaveValue("low");
  await expect(profiles).toHaveCount(0);
  // The connection route did not answer, so its group is still the unread one - one group's retry does
  // not paper over another's failure.
  await expect(connection).toBeVisible();
  const after = await page.evaluate(() => ({
    unread: document.querySelectorAll("[data-settings-unread]").length,
    retries: document.querySelectorAll("[data-settings-read-retry]").length,
    profiles: document.querySelectorAll("[data-model-profiles]").length,
  }));
  console.log(`[settings-unread/after] ${JSON.stringify(after)}`);
  expect(after).toEqual({ unread: 1, retries: 1, profiles: 1 });
  expect(counter.profileReads, "the press took the read again").toBe(2);
});
