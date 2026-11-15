/**
 * The cabin offer's short lease is renewed by the press, not raced by the player.
 *
 * THE DEFECT (audit item 3). The page put the advertisement's own deadline in front of the
 * player: whenever a choice had been on screen longer than it, the panel said the game "keeps
 * each offer only a few seconds, and this one has been on screen longer than that, so it may
 * already have gone stale" (`stardewCabinsOfferLapsed`). A lease the Host mints on every read is
 * not the player's business - and the sentence was almost always true, because the advertisement
 * is republished every second with a 3 s expiry (`HostFarmhandProvisioner.cs`), so any offer a
 * human had time to read was past its window.
 *
 * WHAT THE PRESS DOES NOW. `game/stardew/cabins` mints a fresh `choiceHandle` and a fresh
 * `expiresAtMs` on every read (`stardew-production-lifecycle-coordinator.internal.ts`
 * `readCabinChoices`), so the offer can be renewed at the moment of the press: the confirm reads
 * the cabins first and sends the handle that read minted. The proof is the request itself - the
 * handle the confirm carries is the one the press's own read answered, never the one the row was
 * drawn with - and the other half of the proof is that no sentence about the lease is on screen
 * at all, in either language, even for an offer whose window the mount's read had already passed.
 */
import { expect, test } from "./frontend-coverage";
import { draft, jsonOk, openGameDrawer, root, token } from "./composed-reference-game-fixtures";

/**
 * One read's answer: always the same cabin, ALWAYS a new handle, and a window that is already
 * over on the first read - the live shape, where the advertisement is republished every second
 * and the page is holding a copy minted seconds ago.
 */
const offerOf = (read: number) => ({
  apiVersion: 1,
  choices: [
    {
      displayLabel: "Cabin 1",
      availability: "available",
      choiceHandle: `handle-from-read-${read}`,
      expiresAtMs: read === 1 ? Date.now() - 5_000 : Date.now() + 60_000,
    },
  ],
});

test("the confirm press renews the offer and sends the handle its own read minted", async ({ page }) => {
  let cabinReads = 0;
  const confirms: unknown[] = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReads += 1;
    return route.fulfill(jsonOk(offerOf(cabinReads)));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/confirm", (route) => {
    confirms.push(route.request().postDataJSON());
    return route.fulfill(jsonOk({ apiVersion: 1, status: "manifest_admitted" }));
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const handoff = panel.locator(".stardew-cabin-handoff");
  await expect(handoff.getByTestId("cabin-choice-list")).toContainText("Cabin 1");

  // The lease the mount's read minted had already run out by the page's clock. The panel does not
  // put that in front of the player: the row is a choice, not a countdown (the sentence that used to
  // say so is gone, which is why the next reading is about the request rather than about a note).
  await expect(handoff.getByTestId("cabin-choice-list")).toBeVisible();

  await handoff.getByRole("button", { name: "Confirm cabin" }).click();
  await expect.poll(() => confirms.length, "the press reaches the game").toBe(1);

  // THE PROOF: the request carries the handle the press's own read answered (`-2`), not the one
  // the row was drawn with (`-1`). A press that re-sent the drawn handle would be sending a
  // handle the Host has already replaced.
  const sent = confirms[0] as Readonly<{ choiceHandle?: string }>;
  console.log(`[cabin-lease-renewed] reads=${cabinReads} confirm=${JSON.stringify(sent)}`);
  expect(sent.choiceHandle, "the confirm carries the handle the press's read minted").toBe("handle-from-read-2");
  expect(cabinReads, "one read to renew, and the mount's own read before it").toBe(2);
  await expect(panel).toContainText("Cabin request admitted");
});

test("an offer the page has watched pass its window says nothing about the lease, in either language", async ({
  page,
}) => {
  for (const locale of ["en", "zh-CN"] as const) {
    await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
    await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
    await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
      route.fulfill(jsonOk(offerOf(1))),
    );
    await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
    await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

    await page.goto(`/?locale=${locale}#profile=composed-reference-game&boot=${token}`);
    await page.getByRole("button", { name: locale === "zh-CN" ? "游戏" : "Game", exact: true }).click();
    const panel = page.getByRole("region", { name: locale === "zh-CN" ? "游戏状态" : "Game state" });
    const handoff = panel.locator(".stardew-cabin-handoff");
    await expect(handoff.getByTestId("cabin-choice-list")).toContainText("Cabin 1");
    const text = (await panel.innerText()).replace(/\s+/gu, " ");
    console.log(`[cabin-lease-copy ${locale}] ${text.slice(0, 240)}`);
    expect(text, "no word about a window the player must beat").not.toMatch(
      locale === "zh-CN" ? /时限|失效/iu : /gone stale|expired/iu,
    );
  }
});
