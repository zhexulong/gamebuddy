import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * Giving a companion a picture, on the surface where the player decides.
 *
 * The roster and the inspector both show EVERY companion, so the inspector - the one
 * per-companion surface that is not restricted to the mounted one - is where her
 * picture is set. What this journey proves, end to end in a real browser:
 *
 *  - the control exists exactly once, is a real 44 px hit target, and the picker behind
 *    it takes PNG and nothing else;
 *  - the picture the player picked is ON SCREEN at once (`naturalWidth > 0`, and after a
 *    second, differently shaped picture, its real dimensions), through the same
 *    `CompanionAvatar` every other surface draws her with - and at HERO size here (128 px), because
 *    this drawer is the one place a player looks at her closely, while the upload control's own
 *    geometry is unchanged by it;
 *  - the client is served the caching answer it depends on: her absence is a 404 that is
 *    never remembered, and her picture keeps its one URL, is served `no-cache`, and
 *    carries the DIGEST of its own bytes as its `ETag`;
 *  - a file the Host refuses keeps the picture she has, and the refusal is a sentence.
 *
 * What it cannot show, and does not claim: that a real browser revalidates that URL. A
 * response fulfilled by this zone's interception is not stored in the browser's HTTP
 * cache, so no conditional request is ever issued from here (`faceRequests` below is what
 * that looks like). The wire-level proof lives in `scratch/probe-avatar-upload-e2e.mjs`,
 * which asks the real face for a picture it already holds and for one it does not.
 *
 * The stub is the Host's own pair of facts: a store that a `PUT` writes and a face that
 * serves what was written at the one URL, with the digest as its `ETag`.
 */

const token = "A".repeat(43);
const rosterHandle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

const composedRoot = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: rosterHandle, generation: 1, stateRevision: rosterHandle },
    chat: {
      companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: {
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
  },
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

type Upload = Readonly<{ headers: Record<string, string>; body: unknown }>;

/** One answer the asset face gave the page for her picture. */
type FaceAnswer = Readonly<{ status: number; headers: Record<string, string> }>;

/** The two facts the Host owns: the picture it stores, and the URL its face serves it at. */
type HostStub = Readonly<{
  uploads: Upload[];
  /** Every picture request the page made, in the order it made them. */
  faceRequests: string[];
  /** Every answer the face gave, with the headers the client was served. */
  faceAnswers: FaceAnswer[];
}>;

async function mount(page: Page): Promise<HostStub> {
  const uploads: Upload[] = [];
  const faceRequests: string[] = [];
  const faceAnswers: FaceAnswer[] = [];
  /** Nothing is stored until the first upload, which is the monogram's own condition. */
  let stored: Buffer | null = null;
  let digest = "";

  page.on("response", (response) => {
    if (!response.url().includes("/avatar.png")) return;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers())) headers[name.toLowerCase()] = value;
    faceAnswers.push({ status: response.status(), headers });
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle: rosterHandle, name: "Mira", isCurrent: false }] })),
  );
  await page.route("**/api/tavern/v1/companions/*/profile", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        name: "Mira",
        persona: { present: false, core: null, interactionStyle: null, expressionStyle: null },
        scenario: { present: false, name: null, description: null },
        greetings: { present: false, label: null, variants: [] },
        worldBook: { apiVersion: 1, present: false, revision: null, entries: [] },
      }),
    ),
  );
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, entries: [] })),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: rosterHandle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));

  await page.route(`**/api/tavern/v1/companions/${rosterHandle}/avatar`, async (route) => {
    const body = route.request().postDataJSON() as { avatarBase64: string };
    uploads.push({ headers: route.request().headers(), body });
    stored = Buffer.from(body.avatarBase64, "base64");
    digest = createHash("sha256").update(stored).digest("hex");
    return route.fulfill(jsonOk({ apiVersion: 1, handle: rosterHandle, digest }));
  });
  // The runtime asset face, at the one URL the client always uses.
  await page.route("**/assets/companions/*/avatar.png", (route) => {
    faceRequests.push(route.request().url());
    const conditional = route.request().headers()["if-none-match"] ?? null;
    if (stored === null)
      return route.fulfill({ status: 404, headers: { "cache-control": "no-store" }, body: "" });
    if (conditional === `"${digest}"`) return route.fulfill({ status: 304, headers: { etag: `"${digest}"` } });
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-cache", etag: `"${digest}"` },
      body: stored,
    });
  });
  return { uploads, faceRequests, faceAnswers };
}

/** One real PNG of the requested size, encoded by the browser's own encoder. */
async function pictureOf(page: Page, width: number, height: number): Promise<Buffer> {
  const encoded = await page.evaluate(
    (size) => {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no 2d context");
      context.fillStyle = "#a2445c";
      context.fillRect(0, 0, size.width, size.height);
      return canvas.toDataURL("image/png").split(",", 2)[1] ?? "";
    },
    { width, height },
  );
  return Buffer.from(encoded, "base64");
}

async function openDrawer(page: Page) {
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), "en");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  await surface.locator('[data-companion-entry] [data-companion-inspect][aria-label*="Mira"]').click();
  const drawer = page.getByTestId("companion-inspector");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".loading-text")).toHaveCount(0);
  return drawer;
}

test("the player gives a companion a picture, and the new picture is on screen at once", async ({ page }) => {
  const host = await mount(page);
  const drawer = await openDrawer(page);
  const section = drawer.locator("[data-companion-inspector-avatar]");
  await expect(section).toBeVisible();

  // No picture yet: the same monogram every other surface falls back to, and the face's
  // own answer to that absence - an ordinary 404 that a browser must NOT remember, or a
  // picture that appears later would stay invisible.
  await expect(section.locator(".avatar-image")).toHaveCount(0);
  await expect(section.locator(".avatar")).toHaveText("M");
  await expect.poll(() => host.faceAnswers.some((answer) => answer.status === 404)).toBe(true);
  const absent = host.faceAnswers.find((answer) => answer.status === 404)!;
  expect(absent.headers["cache-control"], "her absence is never cached").toBe("no-store");

  // The control's own measure: one visible trigger, at the surface's 44 px floor, with
  // the browser's picker behind it taken out of the flow.
  const trigger = section.locator("[data-companion-avatar-choose]");
  await expect(trigger).toHaveCount(1);
  const box = await trigger.boundingBox();
  console.log(`[companion-avatar] trigger box=${JSON.stringify(box)}`);
  expect(box, "the control is laid out").not.toBeNull();
  expect(box!.height, "the control meets the 44 px floor").toBeGreaterThanOrEqual(44);
  expect(box!.width, "the control meets the 44 px floor").toBeGreaterThanOrEqual(44);

  // Her picture is a HERO here rather than a row glyph: this is the one surface where a player looks
  // at it closely, and the one where they just uploaded it. 128 px, drawn by the same avatar element
  // (and so the same monogram fallback) the rest of the product draws her with.
  const hero = await section.locator(".avatar").boundingBox();
  console.log(`[companion-avatar] hero box=${JSON.stringify(hero)}`);
  expect(hero, "her picture is laid out").not.toBeNull();
  expect(hero!.width, "her picture is drawn at hero size, not the 28 px row size").toBe(128);
  expect(hero!.height, "and it is square").toBe(128);
  // The upload control's own geometry is unchanged by that: the same control, measured with the hero
  // beside it and with the 28 px plate the row used before - the plate being the only difference -
  // keeps exactly its own box. So the hero costs the drawer height and never the control's width, and
  // the control was never stretched by the plate it stands beside.
  await section.locator(".avatar").evaluate((node) => {
    node.className = "avatar avatar-small";
  });
  const plate = await section.locator(".avatar").boundingBox();
  const withRowPlate = await trigger.boundingBox();
  await section.locator(".avatar").evaluate((node) => {
    node.className = "avatar avatar-hero";
  });
  expect(Math.round(plate!.width), "the row plate really is the smaller one").toBe(28);
  // Its own SIZE is what may not move: the sub-pixel is the antialiased label, and the box's x/y move
  // with the row the plate sizes (the drawer centres its content), which is the plate's doing.
  expect(Math.abs(withRowPlate!.width - box!.width), "the trigger's width is its own label's, at any plate").toBeLessThan(0.5);
  expect(withRowPlate!.height, "and its height is its own 44 px floor").toBe(box!.height);
  expect(box!.height, "the trigger is not stretched by a 128 px plate").toBe(44);
  expect(
    Math.abs(hero!.y + hero!.height / 2 - (box!.y + box!.height / 2)),
    "the picture and its trigger share the row's centre line",
  ).toBeLessThanOrEqual(1);

  // The picker takes PNG and nothing else, and is emptied after a pick so the same file
  // can be chosen again.
  const picker = section.locator("[data-companion-avatar-file]");
  await expect(picker).toHaveAttribute("accept", "image/png");
  await expect(picker).toHaveAttribute("aria-label", "Give her a picture");

  // The first picture: 1x1, picked from disk, uploaded, and on screen.
  const first = await pictureOf(page, 1, 1);
  await picker.setInputFiles({ name: "mira.png", mimeType: "image/png", buffer: first });
  await expect(section.locator("[data-companion-avatar-notice]")).toHaveText("She has this picture now.");
  await expect.poll(() => host.uploads.length).toBe(1);
  expect(host.uploads[0]!.headers["x-csrf-token"], "the write carries the session's CSRF fact").toBe(csrfToken);
  expect(host.uploads[0]!.body, "the body is the whole picture, base64").toEqual({
    apiVersion: 1,
    avatarBase64: first.toString("base64"),
  });
  const image = section.locator(".avatar-image");
  await expect(image).toHaveCount(1);
  await expect.poll(async () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1);
  // The picker is reset, so choosing the same file again still fires.
  expect(await picker.evaluate((node) => (node as HTMLInputElement).value)).toBe("");

  // The caching answer, as the client experiences it: the URL of her picture is the one
  // URL it always was (nothing appends a version), the bytes it just uploaded are what
  // that URL serves, and the face tells the browser to revalidate against the DIGEST of
  // those bytes rather than that they will never change.
  const firstDigest = createHash("sha256").update(first).digest("hex");
  await expect.poll(() => host.faceAnswers.some((answer) => answer.headers.etag === `"${firstDigest}"`)).toBe(true);
  const served = host.faceAnswers.find((answer) => answer.headers.etag === `"${firstDigest}"`)!;
  expect(served.status).toBe(200);
  expect(served.headers["cache-control"]).toBe("no-cache");
  await expect(image).toHaveAttribute("src", `/assets/companions/${rosterHandle}/avatar.png`);

  // A SECOND, differently shaped picture, at that SAME URL. It is fetched again - a
  // picture that changed under a URL a browser believed immutable is the defect this
  // answers - and the bytes that decode are the new ones. The wire-level revalidation
  // is proven by the host probe (`scratch/probe-avatar-upload-e2e.mjs`): this zone's
  // interception answers the picture itself, and a fulfilled response is not stored in
  // the browser's cache, so no conditional request can be shown from here.
  const second = await pictureOf(page, 3, 2);
  const before = host.faceRequests.length;
  await picker.setInputFiles({ name: "mira-again.png", mimeType: "image/png", buffer: second });
  await expect.poll(() => host.uploads.length).toBe(2);
  await expect.poll(() => host.faceRequests.length).toBeGreaterThan(before);
  console.log(`[companion-avatar] face requests=${JSON.stringify(host.faceRequests)}`);
  await expect.poll(async () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(3);
  expect(await image.evaluate((node) => (node as HTMLImageElement).naturalHeight)).toBe(2);
});

test("a file the Host refuses keeps the picture she has, and the refusal is a sentence", async ({ page }) => {
  const host = await mount(page);
  const drawer = await openDrawer(page);
  const section = drawer.locator("[data-companion-inspector-avatar]");
  const picker = section.locator("[data-companion-avatar-file]");

  const picture = await pictureOf(page, 2, 2);
  await picker.setInputFiles({ name: "mira.png", mimeType: "image/png", buffer: picture });
  await expect.poll(() => host.uploads.length).toBe(1);
  const image = section.locator(".avatar-image");
  await expect.poll(async () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(2);

  // A file that is not a picture at all: the Host names the refusal, and the picture she
  // already has is still the one on screen - and still the one the face serves.
  await page.route(`**/api/tavern/v1/companions/${rosterHandle}/avatar`, (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "urn:gamebuddy:tavern:companion_avatar_malformed",
        title: "companion avatar malformed",
        status: 422,
        code: "companion_avatar_malformed",
        requestId: "A".repeat(43),
        retryable: false,
      }),
    }),
  );
  await picker.setInputFiles({
    name: "not-a-picture.png",
    mimeType: "image/png",
    buffer: Buffer.from('{"data":{"name":"Mira"}}', "utf8"),
  });
  await expect(section.locator("[data-companion-avatar-notice]")).toHaveText(
    "That file is not a picture GameBuddy can keep. Choose a PNG image.",
  );
  await expect.poll(async () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(2);
});
