import { expect, test } from "@playwright/test";

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const candidateId = "Q".repeat(22);
// Two more canonical opaque handles: 22 characters, ending on an alphabet index
// (`A`, `Q`) that a 22-character unpadded base64url value can carry.
const candidateStatusId = "A".repeat(22);
const invalidStatusId = "AQ".repeat(11);
const root = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: { apiVersion: 1, build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" }, csrfToken, browserSession: { expiresAtMs: 1900000000000 }, operations: [], navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }], selection: { chatHandle: handle, generation: 1, stateRevision: handle }, chat: { companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" }, title: "Reference Game Chat", transcript: [{ handle: "D".repeat(42) + "A", role: "companion", text: "The game projection is read-only.", locale: "und", order: 0, revision: 1 }], draft: { revision: 4, present: true }, turn: null, worldInfo: null }, memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null }, eventStream: null },
  game: { apiVersion: 1, build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" }, csrfToken, browserSession: { expiresAtMs: 1900000000000 }, game: { prerequisites: { status: "unknown", detectedGame: null, missingItems: [] }, instance: { status: "none", gameTitle: null, generation: 0 }, compatibility: { status: "unchecked", message: null }, attachment: { status: "none", generation: 0 }, connectionStatus: "none", actionAuthority: "unavailable", role: null, companionName: null, selectedWorld: null, selectedSave: null, capabilitySummary: { available: false, count: 0 }, latestOutcome: "none" } },
};
/** The Host's own evidence shape: the installation its scan found, which every
 * production reply stamps `admission_required`
 * (`windows-stardew-installation-discovery/internal.ts`, `StardewDiscoverySession.issue`). */
const foundInstallation = {
  apiVersion: 1,
  candidates: [
    { candidateId, source: "known-location", label: "Stardew Valley", hint: "Detected installation (path hidden)", status: "admission_required" },
  ],
  diagnostics: ["registry-unavailable", "invalid-app-manifest"],
} as const;
/** One candidate in each status the wire declares (`GameCandidateV1Schema`). */
const everyCandidateStatus = {
  apiVersion: 1,
  candidates: [
    { candidateId: candidateStatusId, source: "steam-registry", label: "Stardew Valley", hint: null, status: "candidate" },
    { candidateId, source: "known-location", label: "Stardew Valley", hint: "Detected installation (path hidden)", status: "admission_required" },
    { candidateId: invalidStatusId, source: "steam-vdf", label: "Stardew Valley", hint: null, status: "invalid" },
  ],
  diagnostics: [],
} as const;

const BOOTSTRAP_ROUTE = "**/api/composed-reference-game/v1/bootstrap";
const DRAFT_ROUTE = "**/api/tavern/v1/draft";
const DISCOVERY_ROUTE = "**/api/composed-reference-game/v1/game/installation/discovery";
const CONFIRM_ROUTE = "**/api/composed-reference-game/v1/game/installation/discovery/confirm";
const RETRY_ROUTE = "**/api/composed-reference-game/v1/game/installation/discovery/retry";
const CANCEL_ROUTE = "**/api/composed-reference-game/v1/game/installation/discovery/cancel";
const PICKER_ROUTE = "**/api/composed-reference-game/v1/game/installation/discovery/manual-picker";

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The routes the Game drawer reads for itself. A journey that navigates again with
 * `panel=game` in the fragment restores that surface directly, so its own reads - the
 * cabin handoff, the model profiles and the composed state - are answered here instead
 * of by the dev server's SPA fallback, which is HTML and not JSON.
 */
async function mountGameDrawerRoutes(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => route.fulfill(jsonOk({ apiVersion: 1, choices: [] })));
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
        game: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
        recommendedModels: [],
      }),
    ),
  );
}

const realTopologySkipReason =
  "requires the approved composed shell fixture; route-mocked dialogue-web tests cannot prove real bootstrap/session/CSRF topology";

/**
 * Installation discovery lives inside the Game drawer (design/104 §5.1), so a
 * journey opens the drawer the way a player does - through the AppBar entry -
 * before reaching for the panel.
 */
async function openGameDrawer(page: import("@playwright/test").Page): Promise<void> {
  const surface = page.getByTestId("game-surface");
  const entry = page.getByRole("button", { name: "Game", exact: true });
  // The selected surface restores itself from the URL, so "it is already
  // selected" is a normal outcome - including straight after a reload. The entry
  // is the shell's own control and is present either way, so wait for the shell
  // and then select only when the surface really is not shown.
  await expect(entry).toBeVisible();
  if (await surface.isVisible()) return;
  await entry.click().catch(async (error: unknown) => {
    if (!(await surface.isVisible())) throw error;
  });
  await expect(surface).toBeVisible();
}

const panel = (page: import("@playwright/test").Page) =>
  page.locator('section[aria-label="Game installation setup"]');

/** The one sentence the panel is asserting - read from the panel's own status line. */
const sentenceOf = (page: import("@playwright/test").Page) =>
  panel(page).locator(".installation-state");

async function mountWithDiscovery(
  page: import("@playwright/test").Page,
  discoveryReply: unknown,
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable delegated draft." }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(discoveryReply) }),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
}

test.describe("B2 installation discovery: route-mocked UI behavior", () => {
  /**
   * The confirmation the product's own driver measured as deadlocked.
   *
   * `shots-final29/t-installation-discovery.txt` caught the panel saying "We found
   * possible installations. Choose one to connect." with `confirmDisabled: true` at
   * both 1440x900 and 400x800, and `选择游戏文件夹` absent entirely. The cause is this
   * panel's own status mapping: the Host's discovery session stamps every installation
   * it found `admission_required`, while the panel confirmed only the literal
   * `"candidate"` - a status no production reply carries. The failure this catches: a
   * player who found their installation can neither accept it nor browse for it.
   */
  test("confirms the candidate the Host actually offers, and rereads its answer", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let reads = 0;
    let confirms = 0;
    await page.route(BOOTSTRAP_ROUTE, (route) => route.fulfill(jsonOk(root)));
    await page.route(DRAFT_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })));
    await page.route(DISCOVERY_ROUTE, (route) => {
      // The Host's own answer: the installation it found, then - once the confirm
      // registered it - a fresh scan with nothing left to offer.
      const body = reads === 0 ? foundInstallation : { apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] };
      reads += 1;
      return route.fulfill(jsonOk(body));
    });
    await page.route(CONFIRM_ROUTE, (route) => {
      confirms += 1;
      expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, candidateId });
      return route.fulfill(jsonOk({ apiVersion: 1, status: "registered" }));
    });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await openGameDrawer(page);
    const setup = panel(page);
    await expect(setup).toHaveAttribute("data-state", "candidates");
    await expect(sentenceOf(page)).toHaveText("We found possible installations. Choose one to connect.");

    const confirm = setup.getByRole("button", { name: "Confirm", exact: true });
    // The DOM's own answer to "may this candidate be confirmed?" - the deadlock.
    expect(await confirm.isDisabled(), "the Host's own candidate is confirmable").toBe(false);
    expect(await confirm.innerText(), "the control names the action it performs").toBe("Confirm");
    const box = await confirm.boundingBox();
    if (box === null) throw new Error("the confirm control has no box");
    console.log(`[install-unblock] confirm enabled box=${JSON.stringify(box)}`);

    await confirm.click();
    await expect.poll(() => reads).toBe(2);
    expect(confirms).toBe(1);
    // The state after confirming is the Host's fresh answer, not a sentence this
    // panel invented for its own success.
    await expect(setup).toHaveAttribute("data-state", "no-candidates");
    await expect(sentenceOf(page)).toHaveText("No Stardew Valley installation was found.");
  });

  /**
   * A confirmation is an outcome, and it must read as one.
   *
   * The panel used to answer a *successful* confirmation with a fresh scan, and the
   * fresh scan answers `no-candidates` once the installation is registered - so the
   * player pressed 确认 and was told "No Stardew Valley installation was found." The
   * failure this catches: the one moment the player needs an answer has no sentence,
   * and the sentence that does appear contradicts what just happened.
   */
  test("a confirmed installation says it was confirmed, not that nothing was found", async ({ page }) => {
    let reads = 0;
    await page.route(BOOTSTRAP_ROUTE, (route) => route.fulfill(jsonOk(root)));
    await page.route(DRAFT_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })));
    await page.route(DISCOVERY_ROUTE, (route) => {
      // Today's answer from a machine the player just registered: the first scan
      // offers the installation, and the scan after the registration has nothing
      // left to offer.
      const body = reads === 0 ? foundInstallation : { apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] };
      reads += 1;
      return route.fulfill(jsonOk(body));
    });
    await page.route(CONFIRM_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, status: "registered" })));
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await openGameDrawer(page);
    const setup = panel(page);
    await expect(setup).toHaveAttribute("data-state", "candidates");
    const before = (await sentenceOf(page).innerText()).trim();

    await setup.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect.poll(() => reads).toBe(2);
    const confirmedState = await setup.getAttribute("data-state");
    const confirmed = (await sentenceOf(page).innerText()).trim();
    console.log(`[install-confirmed] state=${confirmedState} sentence=${JSON.stringify(confirmed)} before=${JSON.stringify(before)}`);
    expect(confirmedState, "a registered installation is its own state").toBe("confirmed");
    expect(confirmed, "and it says what happens next").toBe(
      "Confirmed. Next, enable companion play and set up Stardew Valley, then load your farm.",
    );
    // The sentence that used to stand in for success said the player's own machine
    // had no installation in it.
    expect(confirmed, "a confirmation never reads as an empty scan").not.toBe("No Stardew Valley installation was found.");
    await expect(setup).not.toContainText("No Stardew Valley installation was found.");
    await expect(setup).not.toContainText("We found possible installations. Choose one to connect.");
    // The candidate the player confirmed is no longer offered for a second confirm.
    await expect(setup.locator(".installation-candidate")).toHaveCount(0);
  });

  /**
   * Two installations of the same game are two rows a player can choose between.
   *
   * Every Steam library installs to `<library>\steamapps\common\Stardew Valley`, so the
   * Host's `label` is the same string for both, its `hint` is the same notice, and the
   * source sentence is the same - the OOBE review measured exactly that as two identical
   * rows. The drive and the library folder's own name are the fact that separates them,
   * and the panel renders nothing but that fact: no path, no executable name.
   *
   * The other half is the constraint: candidates that genuinely agree must still render
   * identically, because a row that invents a difference would let a player choose
   * between two words for the same folder.
   */
  test("two installations that differ only by where they live are two different rows", async ({ page }) => {
    const row = (id: string, location: string | null) => ({
      candidateId: id,
      source: "steam-vdf",
      label: "Stardew Valley",
      hint: "Detected installation (path hidden)",
      status: "admission_required",
      ...(location === null ? {} : { location }),
    });
    let readBody: unknown = { apiVersion: 1, candidates: [], diagnostics: [] };
    let mounted = false;
    await page.route(BOOTSTRAP_ROUTE, (route) => route.fulfill(jsonOk(root)));
    await mountGameDrawerRoutes(page);
    await page.route(DRAFT_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })));
    await page.route(DISCOVERY_ROUTE, (route) => route.fulfill(jsonOk(readBody)));

    const rows = async () => {
      const read = await page.locator(".game-installation-panel").evaluate((node) =>
        [...node.querySelectorAll(".installation-candidate")].map((candidate) => ({
          text: (candidate as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
          caption: candidate.querySelector(".installation-candidate-label")?.textContent?.trim() ?? "",
          location: candidate.getAttribute("data-location"),
          label: candidate.getAttribute("data-label"),
        })),
      );
      console.log(`[install-rows] ${JSON.stringify(read)}`);
      return read;
    };
    const mount = async (body: unknown) => {
      readBody = body;
      if (mounted) await page.reload();
      else {
        await page.goto(`/#profile=composed-reference-game&boot=${token}`);
        mounted = true;
      }
      await openGameDrawer(page);
      await expect(panel(page)).toHaveAttribute("data-state", "candidates");
    };

    // Two libraries, the same game, nothing else different.
    await mount({ apiVersion: 1, candidates: [row(candidateId, "C: · Steam"), row(candidateStatusId, "D: · SteamLibrary")], diagnostics: [] });
    const different = await rows();
    expect(different.map((entry) => entry.location), "each row names its installation's location").toEqual([
      "C: · Steam",
      "D: · SteamLibrary",
    ]);
    expect(different.map((entry) => entry.caption), "and says it in the row's own words").toEqual([
      "Stardew Valley (C: · Steam)",
      "Stardew Valley (D: · SteamLibrary)",
    ]);
    expect(different[0]!.text, "the two rows are not the same row twice").not.toBe(different[1]!.text);
    // The Host's own label stays as attribution, and no path or executable name is printed.
    expect(different.map((entry) => entry.label)).toEqual(["Stardew Valley", "Stardew Valley"]);
    await expect(page.locator(".game-installation-panel")).not.toContainText("steamapps");
    await expect(page.locator(".game-installation-panel")).not.toContainText("Stardew Valley.exe");

    // The same two libraries: the rows are allowed - required - to look the same.
    await mount({
      apiVersion: 1,
      candidates: [row(candidateId, "D: · SteamLibrary"), row(candidateStatusId, "D: · SteamLibrary")],
      diagnostics: [],
    });
    const same = await rows();
    expect(same[0]!.text, "candidates that agree render identically").toBe(same[1]!.text);
    expect(same.map((entry) => entry.caption)).toEqual([
      "Stardew Valley (D: · SteamLibrary)",
      "Stardew Valley (D: · SteamLibrary)",
    ]);

    // A reply that predates the field is still two rows, and still not separable - the
    // panel says nothing it does not know rather than inventing a distinction.
    await mount({ apiVersion: 1, candidates: [row(candidateId, null), row(candidateStatusId, null)], diagnostics: [] });
    const unlabelled = await rows();
    expect(unlabelled.map((entry) => entry.location)).toEqual([null, null]);
    expect(unlabelled[0]!.text).toBe(unlabelled[1]!.text);
  });

  /**
   * The line under the installation's name speaks the player's language.
   *
   * The panel used to print what the Host mints: `known-location` as the source
   * chip and `Detected installation (path hidden)` as its note, in English, on a
   * Chinese surface (`host/src/games/stardew/provider.ts` mints the second). The
   * failure this catches: a wire member a player cannot read, in either language,
   * and - for a source this build has no sentence for - a panel that would rather
   * print the member than say the one thing it knows.
   */
  test("the installation line reads in the player's language, never the wire", async ({ page }) => {
    // One candidate the scan declares, one source the contract's schema allows but
    // this build names nothing for (`source` is a bounded string, not a closed
    // union: `GameCandidateV1Schema`).
    const undeclaredSource = {
      apiVersion: 1,
      candidates: [
        { candidateId, source: "known-location", label: "Stardew Valley", hint: "Detected installation (path hidden)", status: "admission_required" },
        { candidateId: candidateStatusId, source: "gog-galaxy", label: "Stardew Valley", hint: null, status: "admission_required" },
      ],
      diagnostics: [],
    };
    const RAW = ["known-location", "gog-galaxy", "steam-registry", "steam-vdf", "admission_required", "Detected installation"];
    // The shared `panel()` helper finds the panel by its English accessible name, so
    // this test locates it by its own class instead: it has to look at the same panel
    // in two languages.
    const setup = page.locator(".game-installation-panel");
    const rendered = async (): Promise<{
      captions: string[];
      sources: string[];
      hints: (string | null)[];
      rawHits: string[];
    }> => {
      const facts = await page.evaluate(() => {
        const node = document.querySelector<HTMLElement>(".game-installation-panel");
        return {
          captions: [...(node?.querySelectorAll(".installation-candidate-label") ?? [])].map((name) =>
            (name.textContent ?? "").trim(),
          ),
          sources: [...(node?.querySelectorAll(".installation-source") ?? [])].map((chip) => (chip.textContent ?? "").trim()),
          hints: [...(node?.querySelectorAll(".installation-hint") ?? [])].map((note) => (note.textContent ?? "").trim()),
          text: node?.innerText ?? "",
        };
      });
      return {
        captions: facts.captions,
        sources: facts.sources,
        hints: facts.hints,
        rawHits: RAW.filter((member) => facts.text.includes(member)),
      };
    };

    await page.route(BOOTSTRAP_ROUTE, (route) => route.fulfill(jsonOk(root)));
    // The Chinese pass reloads, and a reload reads the mounted shell's own routes
    // again instead of the bootstrap alone.
    await mountGameDrawerRoutes(page);
    await page.route(DRAFT_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })));
    await page.route(DISCOVERY_ROUTE, (route) => route.fulfill(jsonOk(undeclaredSource)));
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await openGameDrawer(page);
    await expect(setup).toHaveAttribute("data-state", "candidates");
    const english = await rendered();
    console.log(`[install-words] en: ${JSON.stringify(english)}`);
    expect(english.captions, "the row is named by the product, not by the Host's one English string").toEqual([
      "Stardew Valley",
      "Stardew Valley",
    ]);
    expect(english.sources, "each declared source reads as its own sentence").toEqual([
      "Found in a common install folder",
      "Found on this computer",
    ]);
    expect(english.hints, "the redacted path is stated, not quoted").toEqual(["Its folder path is hidden."]);
    expect(english.rawHits, "no wire member reaches the player in English").toEqual([]);

    // The same reply on the product's Chinese surface: the locale is the shell's
    // own preference (`resolveLocale`/`persistLocale`), set before the reload.
    await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
    await page.reload();
    const entry = page.getByRole("button", { name: "游戏", exact: true });
    await expect(entry).toBeVisible();
    if (!(await setup.isVisible())) await entry.click();
    await expect(setup).toHaveAttribute("aria-label", "游戏安装设置");
    await expect(setup).toHaveAttribute("data-state", "candidates");
    const chinese = await rendered();
    console.log(`[install-words] zh: ${JSON.stringify(chinese)}`);
    // The row's caption used to be the Host's `label`, which is one fixed English
    // string for every installation - the last English text in a Chinese row.
    expect(chinese.captions, "the game's name is the player's language too").toEqual([
      "《星露谷物语》",
      "《星露谷物语》",
    ]);
    expect(chinese.sources, "the same sentences in the player's other language").toEqual([
      "在常见的安装位置找到",
      "已在这台电脑上找到",
    ]);
    expect(chinese.hints, "the note is Chinese too").toEqual(["安装路径不显示。"]);
    expect(chinese.rawHits, "no wire member reaches the player in Chinese").toEqual([]);
  });

  /**
   * The other half of the same dead end: `选择游戏文件夹` used to render only in the
   * retryable states, so a player whose candidate could not be confirmed had no way
   * forward at all. It is the other route to the same admission, so it is offered in
   * every state the panel can receive.
   *
   * The states walked are the typed ones this panel's own read, confirm, retry and
   * cancel paths produce. `expired` and `not_configured` are in the union but nothing
   * produces them: no Host answer maps to them and no control sets them.
   */
  test("browse is offered in every state the panel can receive", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    let readStatus = 200;
    let readBody: unknown = foundInstallation;
    let readDelayMs = 0;
    let retryDelayMs = 0;
    let confirmDelayMs = 0;

    await page.route(BOOTSTRAP_ROUTE, (route) => route.fulfill(jsonOk(root)));
    await mountGameDrawerRoutes(page);
    await page.route(DRAFT_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })));
    await page.route(DISCOVERY_ROUTE, async (route) => {
      if (readDelayMs > 0) await sleep(readDelayMs);
      await route.fulfill({ status: readStatus, contentType: "application/json", body: JSON.stringify(readBody) }).catch(() => undefined);
    });
    // Registered after the read so each mutation's own answer is the one served.
    await page.route(RETRY_ROUTE, async (route) => {
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      await route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] })).catch(() => undefined);
    });
    await page.route(CONFIRM_ROUTE, async (route) => {
      if (confirmDelayMs > 0) await sleep(confirmDelayMs);
      await route.fulfill(jsonOk({ apiVersion: 1, status: "registered" })).catch(() => undefined);
    });
    await page.route(CANCEL_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, status: "cancelled" })));

    const observations: string[] = [];
    let mounted = false;
    const mount = async () => {
      if (mounted) await page.reload();
      else {
        await page.goto(`/#profile=composed-reference-game&boot=${token}`);
        mounted = true;
      }
      await openGameDrawer(page);
    };
    const measure = async (label: string) => {
      const state = await panel(page).getAttribute("data-state");
      const sentence = (await sentenceOf(page).first().innerText()).trim();
      const browse = panel(page).getByRole("button", { name: "Choose game folder", exact: true });
      const count = await browse.count();
      const enabled = await browse.isEnabled();
      const box = await browse.boundingBox();
      observations.push(`${label}/${state}: browse=${count} enabled=${enabled} box=${box === null ? "null" : `${Math.round(box.width)}x${Math.round(box.height)}`} sentence=${JSON.stringify(sentence)}`);
      expect(count, `${label}: exactly one browse fallback in ${state}`).toBe(1);
      if (box === null) throw new Error(`${label}: the browse fallback is not laid out in ${state}`);
      return { state, sentence, box };
    };

    // 1. loading - the scan is outstanding.
    readDelayMs = 1_500;
    await mount();
    await expect(panel(page)).toHaveAttribute("data-state", "loading");
    const outstanding = await measure("scan outstanding");
    expect(outstanding.sentence, "searching while searching").toBe("Looking for your Stardew Valley installation…");
    await expect(panel(page)).toHaveAttribute("data-state", "candidates");
    readDelayMs = 0;

    // 2. candidates - one candidate in each status the wire declares.
    readBody = everyCandidateStatus;
    await mount();
    await expect(panel(page)).toHaveAttribute("data-state", "candidates");
    const offered = await measure("candidate offered");
    expect(offered.sentence).toBe("We found possible installations. Choose one to connect.");
    const rows = panel(page).locator(".installation-candidate");
    await expect(rows).toHaveCount(3);
    // This assertion used to read the row's visible text as the wire member, which
    // is exactly what the product no longer does: the member the Host minted stays
    // the row's own attribution (`data-source`), and the words beside the name are
    // the panel's sentence for it. The force is unchanged - three rows, attributed
    // to the three sources the scan reported, with the refused one's confirm off -
    // and the sentence each source must read is now pinned too.
    const gates = await rows.evaluateAll((nodes) =>
      nodes.map((node) => ({
        source: node.querySelector(".installation-source")?.getAttribute("data-source") ?? "",
        spoken: node.querySelector(".installation-source")?.textContent?.trim() ?? "",
        hint: node.querySelector(".installation-hint")?.textContent?.trim() ?? null,
        confirmDisabled: node.querySelector("button")?.disabled ?? null,
      })),
    );
    console.log(`[install-unblock] candidate rows: ${JSON.stringify(gates)}`);
    expect(gates, "the statuses that name an offered candidate are confirmable; the refused one is not").toEqual([
      { source: "steam-registry", spoken: "Found via Steam", hint: null, confirmDisabled: false },
      {
        source: "known-location",
        spoken: "Found in a common install folder",
        hint: "Its folder path is hidden.",
        confirmDisabled: false,
      },
      { source: "steam-vdf", spoken: "Found in a Steam library folder", hint: null, confirmDisabled: true },
    ]);

    // 3. confirming - the confirmation is outstanding.
    confirmDelayMs = 1_200;
    await rows.nth(1).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(panel(page)).toHaveAttribute("data-state", "confirming");
    const confirming = await measure("confirm outstanding");
    expect(confirming.sentence, "the panel names the confirmation it is running").toBe("Confirming the installation…");
    await expect(panel(page)).toHaveAttribute("data-state", "candidates");
    confirmDelayMs = 0;

    // 4. retrying, then the settled answer it produces.
    retryDelayMs = 1_200;
    await panel(page).getByRole("button", { name: "Find again", exact: true }).click();
    await expect(panel(page)).toHaveAttribute("data-state", "retrying");
    const retrying = await measure("retry outstanding");
    expect(retrying.sentence, "searching again while searching again").toBe("Searching again…");
    await expect(panel(page)).toHaveAttribute("data-state", "no-candidates");
    retryDelayMs = 0;
    const nothingFound = await measure("nothing found");
    expect(nothingFound.sentence).toBe("No Stardew Valley installation was found.");

    // 5. cancelled - the player abandons the scan.
    readBody = everyCandidateStatus;
    await mount();
    await expect(panel(page)).toHaveAttribute("data-state", "candidates");
    await panel(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(panel(page)).toHaveAttribute("data-state", "cancelled");
    const cancelled = await measure("search abandoned");
    expect(cancelled.sentence).toBe("Search cancelled.");

    // 6. source-unavailable - the Host's scan could not run.
    readStatus = 503;
    readBody = { code: "game_unavailable" };
    await mount();
    await expect(panel(page)).toHaveAttribute("data-state", "source-unavailable");
    const unavailable = await measure("source unreadable");
    expect(unavailable.sentence).toBe("The installation search is unavailable right now.");

    // 7. result-unavailable - a reply this build cannot read.
    readStatus = 200;
    readBody = { apiVersion: 1, candidates: [{ candidateId: "bad", source: "steam" }] };
    await mount();
    await expect(panel(page)).toHaveAttribute("data-state", "result-unavailable");
    const unreadable = await measure("reply unreadable");
    expect(unreadable.sentence).toBe("We couldn't read the installation search result.");

    // 8. error - the Host refused to produce the result.
    readStatus = 409;
    readBody = { code: "state_unavailable" };
    await mount();
    await expect(panel(page)).toHaveAttribute("data-state", "error");
    const refused = await measure("search refused");
    expect(refused.sentence).toBe("The installation search failed.");

    console.log(`[install-unblock] browse per state (${observations.length}): ${observations.join(" | ")}`);
    expect(observations.length, "every state the panel can receive was walked").toBe(9);
    expect(new Set(observations.map((entry) => entry.split("/")[1]?.split(":")[0])).size, "the tally covers nine distinct typed states").toBe(9);
  });

  /**
   * The geometry of the two controls this dead end was about, at both widths the
   * product is measured at. The failure this catches: a control that exists but is
   * laid out off the panel's own edge, or an action row that cannot wrap.
   */
  test("the confirm and browse controls stay inside the panel at both widths", async ({ page }) => {
    await page.route(BOOTSTRAP_ROUTE, (route) => route.fulfill(jsonOk(root)));
    await mountGameDrawerRoutes(page);
    await page.route(DRAFT_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })));
    await page.route(DISCOVERY_ROUTE, (route) => route.fulfill(jsonOk(foundInstallation)));

    const measurements: string[] = [];
    const viewports = [
      { width: 1440, height: 900 },
      { width: 400, height: 800 },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      if (measurements.length === 0) await page.goto(`/#profile=composed-reference-game&boot=${token}`);
      else await page.reload();
      await openGameDrawer(page);
      const setup = panel(page);
      await expect(setup).toHaveAttribute("data-state", "candidates");
      const confirm = setup.getByRole("button", { name: "Confirm", exact: true });
      const browse = setup.getByRole("button", { name: "Choose game folder", exact: true });
      expect(await confirm.isDisabled(), `the candidate is confirmable at ${viewport.width}`).toBe(false);
      const confirmBox = await confirm.boundingBox();
      const browseBox = await browse.boundingBox();
      const panelBox = await setup.boundingBox();
      if (confirmBox === null || browseBox === null || panelBox === null) throw new Error(`a control has no box at ${viewport.width}x${viewport.height}`);
      // The panel scrolls vertically when a machine reports many candidates - that is
      // its own bounded scroll - but nothing may spill out of its box sideways.
      const geometry = await setup.evaluate((node) => ({
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      }));
      const actions = setup.locator(".game-actions");
      const actionsRow = await actions.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
      const controls = await actions.getByRole("button").evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { name: (node.textContent ?? "").trim(), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width) };
        }),
      );
      const box = (value: { x: number; y: number; width: number; height: number }) =>
        `${Math.round(value.x)},${Math.round(value.y)} ${Math.round(value.width)}x${Math.round(value.height)}`;
      measurements.push(`${viewport.width}x${viewport.height} panel=${box(panelBox)} confirm=${box(confirmBox)} browse=${box(browseBox)} panelScroll=${geometry.scrollWidth}/${geometry.clientWidth} ${geometry.scrollHeight}/${geometry.clientHeight} rowScroll=${actionsRow.scrollWidth}/${actionsRow.clientWidth} controls=${JSON.stringify(controls)}`);
      console.log(`[install-unblock] ${measurements[measurements.length - 1]}`);
      expect(geometry.scrollWidth, `the panel does not overflow horizontally at ${viewport.width}`).toBeLessThanOrEqual(geometry.clientWidth + 1);
      expect(actionsRow.scrollWidth, `the action row does not overflow horizontally at ${viewport.width}`).toBeLessThanOrEqual(actionsRow.clientWidth + 1);
      const panelRight = panelBox.x + panelBox.width;
      for (const [name, controlBox] of [
        ["confirm", confirmBox],
        ["browse", browseBox],
      ] as ReadonlyArray<readonly [string, { x: number; y: number; width: number; height: number }]>) {
        expect(controlBox.width, `${name} has a real width at ${viewport.width}`).toBeGreaterThan(0);
        expect(controlBox.x, `${name} starts inside the panel at ${viewport.width}`).toBeGreaterThanOrEqual(panelBox.x - 1);
        expect(controlBox.x + controlBox.width, `${name} ends inside the panel at ${viewport.width}`).toBeLessThanOrEqual(panelRight + 1);
      }
    }
    expect(measurements.length, "both widths were measured").toBe(2);
  });

  /**
   * The machine the owner reported: the registry named no Steam client, one
   * candidate's app manifest was unreadable, and the bounded known-location
   * fallback still found the game. A candidate is a candidate whatever else the
   * scan reported, and the panel may not let the diagnostics hide it.
   */
  test("a candidate found while a source could not be read is still a candidate", async ({ page }) => {
    await mountWithDiscovery(page, {
      apiVersion: 1,
      candidates: [{ candidateId, source: "known-location", label: "Stardew Valley", hint: "Detected installation (path hidden)", status: "admission_required" }],
      diagnostics: ["registry-unavailable", "invalid-app-manifest"],
    });
    await expect(panel(page)).toHaveAttribute("data-state", "candidates");
    await expect(sentenceOf(page)).toHaveText("We found possible installations. Choose one to connect.");
    // This test already restated the production status - and never asked whether the
    // candidate it stood for could be confirmed, which is how the confirm gate kept
    // refusing every candidate a real Host reports. The force is unchanged; it now
    // asks the question it was written for.
    const namedConfirm = panel(page).getByRole("button", { name: "Confirm", exact: true });
    expect(await namedConfirm.isDisabled(), "the status the reviewer named is confirmable").toBe(false);
    await expect(panel(page).getByRole("button", { name: "Choose game folder", exact: true }), "and it is not a dead end").toBeVisible();
  });

  test("an empty scan that could not read a source says so", async ({ page }) => {
    await mountWithDiscovery(page, {
      apiVersion: 1,
      candidates: [],
      diagnostics: ["registry-unavailable", "source-unavailable", "no-candidates"],
    });
    await expect(panel(page)).toHaveAttribute("data-state", "source-unavailable");
    await expect(sentenceOf(page)).toHaveText("The installation search is unavailable right now.");
    await expect(panel(page)).not.toContainText("No Stardew Valley installation was found.");
  });

  test("an empty scan that read everything says nothing was found", async ({ page }) => {
    await mountWithDiscovery(page, { apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] });
    await expect(panel(page)).toHaveAttribute("data-state", "no-candidates");
    await expect(sentenceOf(page)).toHaveText("No Stardew Valley installation was found.");
  });

  test("an installation without a mod loader names SMAPI instead of the search", async ({ page }) => {
    // The player this test exists for: Stardew Valley is bought and installed, SMAPI
    // never was. The Host's scan finds the game, so the panel offers it - and the
    // confirm refuses with `mod_loader_missing`, exactly as the coordinator reports
    // it for a folder holding `Stardew Valley.exe` and no `StardewModdingAPI.exe`
    // (`host/src/stardew-production-lifecycle-coordinator.internal.test.ts`).
    const sentence =
      "We found Stardew Valley, but there is no mod loader (SMAPI) in that folder. Install SMAPI, then find again — or choose a game folder that already has it.";
    await page.route(BOOTSTRAP_ROUTE, (route) => route.fulfill(jsonOk(root)));
    await mountGameDrawerRoutes(page);
    await page.route(DRAFT_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })));
    await page.route(DISCOVERY_ROUTE, (route) => route.fulfill(jsonOk(foundInstallation)));
    await page.route(CONFIRM_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, status: "mod_loader_missing" })));
    await page.route(PICKER_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, status: "mod_loader_missing" })));
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await openGameDrawer(page);
    const setup = panel(page);
    // The search succeeded: the game it found is offered.
    await expect(setup).toHaveAttribute("data-state", "candidates");

    await setup.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(setup).toHaveAttribute("data-state", "mod-loader-missing");
    await expect(sentenceOf(page)).toHaveText(sentence);
    // Neither honest search state may stand in for this one: both blame a search that
    // had just found the player's game, and neither names the missing piece.
    await expect(setup).not.toContainText("The installation search failed.");
    await expect(setup).not.toContainText("The installation search is unavailable right now.");
    await expect(setup).not.toContainText("No Stardew Valley installation was found.");

    // The folder picker reaches the same admission, so it says the same thing.
    await setup.getByRole("button", { name: "Choose game folder", exact: true }).click();
    await expect(setup).toHaveAttribute("data-state", "mod-loader-missing");
    await expect(sentenceOf(page)).toHaveText(sentence);
    // And the next step the sentence names is a control the player can press.
    await expect(setup.getByRole("button", { name: "Choose game folder", exact: true })).toBeEnabled();
    await expect(setup.getByRole("button", { name: "Find again", exact: true })).toBeEnabled();
  });

  test("renders source-unavailable as a typed problem", async ({ page }) => {
    await page.route("**/api/composed-reference-game/v1/bootstrap", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
    await page.route("**/api/tavern/v1/draft", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable delegated draft." }) }));
    await page.route("**/api/composed-reference-game/v1/game/installation/discovery", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "game_unavailable" }) }));
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await openGameDrawer(page);
    await expect(panel(page)).toHaveAttribute("data-state", "source-unavailable");
    await expect(sentenceOf(page)).toHaveText("The installation search is unavailable right now.");
  });

  /**
   * A rejected read is named by the code that rejected it.
   *
   * This test used to assert `error` for BOTH a malformed reply and a 401. The panel
   * read the code off `error.code`, which a thrown protocol error never carries (it
   * carries `reason`), so both collapsed into "The installation search failed." The
   * force is unchanged - neither may render as candidates and neither may be silent -
   * but each now says only what is true, and the one refusal that really is the search
   * failing (`state_unavailable`) stays distinguishable from them.
   */
  test("surfaces malformed, unauthorized and refused reads without candidates", async ({ page }) => {
    await page.route("**/api/composed-reference-game/v1/bootstrap", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
    await page.route("**/api/composed-reference-game/v1/state", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
    await page.route("**/api/tavern/v1/draft", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable delegated draft." }) }));
    const discoveryRoute = "**/api/composed-reference-game/v1/game/installation/discovery";
    await page.route(discoveryRoute, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, candidates: [{ candidateId: "bad", source: "steam" }] }) }));
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await openGameDrawer(page);
    await expect(panel(page)).toHaveAttribute("data-state", "result-unavailable");
    await expect(sentenceOf(page)).toHaveText("We couldn't read the installation search result.");

    await page.unroute(discoveryRoute);
    await page.route(discoveryRoute, route => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "unauthorized" }) }));
    await page.reload();
    await openGameDrawer(page);
    await expect(panel(page)).toHaveAttribute("data-state", "result-unavailable");
    await expect(sentenceOf(page)).toHaveText("We couldn't read the installation search result.");

    await page.unroute(discoveryRoute);
    await page.route(discoveryRoute, route => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_unavailable" }) }));
    await page.reload();
    await openGameDrawer(page);
    await expect(panel(page)).toHaveAttribute("data-state", "error");
    await expect(sentenceOf(page)).toHaveText("The installation search failed.");
  });
});

test.describe("B2 composed topology evidence", () => {
  test.skip(realTopologySkipReason, async () => {
    // The approved fixture is host/src/tavern/composed-reference-game-static-shell-composition.ts,
    // exercised by host composed-reference-game-browser tests. It is not exposed
    // by dialogue-web's Playwright webServer and importing it would create a
    // second listener outside the approved topology.
  });
});
