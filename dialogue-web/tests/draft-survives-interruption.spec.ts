import { type Locator, expect, test } from "./frontend-coverage";
import {
  CONTROL_EXEMPTIONS,
  type DraftControl,
  SURFACE_EXEMPTIONS,
  WALKED_SURFACES,
  enumerateControls,
  openDisclosures,
  openSurface,
  prepareSurface,
  revealEditors,
  stubShell,
  token,
  TYPED_LANGUAGE,
} from "./draft-surfaces";

/**
 * Leaving a surface and coming back costs the player nothing they typed.
 *
 * This is the fourth time the family "player input is destroyed by something the player did not
 * do" has been fixed instance by instance - a refused send (`1af99e73`), a refused memory write, a
 * save that overwrote a draft - and every fix so far named one field. So this file asks the
 * question the family actually poses, of the DOM rather than of a list somebody remembered:
 *
 *   For every control a surface renders that carries the player's own input, put the player's own
 *   value into it, leave for another surface, come back, and require that value to still be there.
 *
 * The population is DISCOVERED, not listed. `enumerateControls()` reads the surface region and
 * returns each visible, enabled `textarea`, text-entry `input` and `select`; the walk repeats until
 * nothing new appears, so a control that only exists once another is answered - the connection
 * form's base URL, which appears once a provider is chosen - is inside the population rather than
 * quietly outside it. A sixth field added to any of these surfaces is covered the day it lands.
 *
 * An editor the player has to OPEN is the same question asked of a press, so the product answers it:
 * the control that opens an editor carrying the player's own fields is marked `data-draft-revealer`,
 * and the walk opens every one of them before it enumerates. That is how the two world book editors
 * came into the population - both are one press away from the surface, and neither was reachable by
 * an enumeration that only ever looked at what was already on screen. A `<details>` disclosure is the
 * other way a field hides and is opened too (`openDisclosures()`), because a summary stays on screen
 * and so cannot be a revealer.
 *
 * The table of surfaces, the control population and the exemptions are NOT here: they live in
 * `draft-surfaces.ts`, because `draft-declaration-coverage.spec.ts` asks the complementary question -
 * whether this journey's population is the whole population the product renders - and two copies of
 * the table would agree today and disagree the day one moved.
 *
 * Each control is then checked ON ITS OWN, on a fresh page, with only the steps that revealed it
 * replayed first. That matters more than it looks: answering one control can hide another (the
 * connection form's `apiKeyRequired` control removes the credential field when it is set to
 * `none`), so a single walk that fills everything at once would report a field missing that the
 * player never lost, and would attribute one control's answer to another's draft.
 *
 * What IS written down is the EXCLUSION list - a control that genuinely must not keep a draft -
 * and it is asserted to be a subset of what the walk found, so an exclusion for a control that no
 * longer exists fails instead of silently protecting nothing.
 *
 * What the interruption is, exactly:
 *
 *  - one surface switch away and one back, through the app bar the player uses. That is the
 *    measured case: `ComposedReferenceGameApp` renders each of these surfaces conditionally
 *    (`shownSurface === …`), so leaving unmounts the whole subtree and every `useState` inside it.
 *    Only the Chat composer survived, and only because its text was lifted into the shell.
 *  - the switch blurs whatever field holds focus. One field here commits on blur - the companion
 *    language tag - so this stub REFUSES that save and keeps answering the value the Host still
 *    holds. That is deliberate, and it is the second half of the family: a draft a failed save eats
 *    is the same defect as a draft a switch eats. A stub that accepted the write would hide it
 *    behind an authority that now agrees with the player.
 *
 * What this file does NOT cover, said plainly rather than implied: an editor over ONE stored ROW that
 * a mutation answers in place and that belongs to a record this gate never opens - a chapter
 * correction. Those are absent from the DOM when the player arrives and answer to Save or Close in
 * place, and the specs that own them already gate their failing-save behaviour
 * (`memory-authoring-keeps-the-words`, `prompt-addition-refusal-keeps-the-text`,
 * `world-book-conflict-retry`, `failed-send-keeps-the-words`). This is no longer a narrowing of the
 * rename's or the row editor's coverage: the Chats surface's rename and the transcript row's
 * in-place edit both declare themselves and are walked. `prepare()` is the older way a surface opts
 * such a field IN, and it remains for the two editors that predate the declaration (the companion's
 * performance directive and the notebook's authoring form).
 */

/** One distinct value per control, so a restored neighbour's text can never pass for this one's. */
const SENTINEL_PREFIX = "SENTINEL-of";

/**
 * The player's own value for one control, put there the way they would.
 *
 * Returns what the field now holds, which is what the switch has to preserve - a `select` clamps to
 * the options it has, and a `maxLength` may clamp a long sentinel, so the expectation is read back
 * from the DOM rather than assumed.
 */
async function typeInto(region: Locator, control: DraftControl, position: number): Promise<string> {
  const field = region.locator(control.key);
  if (control.tag === "select") {
    // The choice furthest from what is already selected, so it can never be mistaken for a value
    // the panel preselected on its own.
    const options = await field.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value !== ""),
    );
    const current = await field.inputValue();
    const choice = [...options].reverse().find((value) => value !== current);
    if (choice === undefined) throw new Error(`${control.key} offers no choice other than ${current}`);
    await field.selectOption(choice);
    return await field.inputValue();
  }
  // The language tag is the one field whose typed value the Host also has an opinion about, and the
  // one whose save this stub refuses - so its sentinel is a tag no projection could return.
  const sentinel =
    control.key === "#companion-language"
      ? TYPED_LANGUAGE
      : `${SENTINEL_PREFIX}-${control.name.replace(/\s+/gu, "-")}-${position + 1}`;
  await field.fill(sentinel);
  return await field.inputValue();
}

/** One control, and the value the player put into it. */
type Filled = Readonly<{ control: DraftControl; value: string }>;

/**
 * Fill every control the surface renders, to a fixed point.
 *
 * The walk repeats until nothing new appears: the connection form's base URL and its model field
 * exist only after a provider is chosen, and a single pass would leave every such field outside the
 * population - which is the silent narrowing this gate exists to avoid. Each control gets its own
 * distinct value, read back from the DOM (a `select` clamps to its options), so the check after the
 * switch compares each field against what that field really held.
 */
async function fillEverything(region: Locator): Promise<Filled[]> {
  const filled = new Map<string, Filled>();
  for (;;) {
    // The editors the product declares open first: their fields belong to the player, and a walk
    // that never pressed the control that opens them would leave them outside the population. The
    // disclosures open beside them, because a summary cannot declare itself a revealer.
    await revealEditors(region);
    await openDisclosures(region);
    const fresh = [...(await enumerateControls(region)).filter((control) => !filled.has(control.key))];
    if (fresh.length === 0) {
      /*
       * Nothing new - but "nothing new YET" is not the same fact. A surface renders its authored
       * sections once its own read lands, so an enumeration that ran a frame early sees fewer
       * controls and the walk would end believing it had covered the surface. One settled re-read
       * is what tells the two apart, and it is the surface's own timing, not a list of fields.
       */
      await region.page().waitForTimeout(250);
      // An editor whose own entry control renders with that read is opened here rather than missed:
      // the declaration is on screen by the time the settle has passed, or the surface has none.
      await revealEditors(region);
      await openDisclosures(region);
      const settled = [...(await enumerateControls(region)).filter((control) => !filled.has(control.key))];
      if (settled.length === 0) return [...filled.values()];
      continue;
    }
    for (const control of fresh) {
      // An excluded control is recorded (so the exclusion list can be checked against what really
      // exists) but never typed into: `#ui-language` would change the interface's language out from
      // under the walk, and the credential is a secret this gate does not keep.
      if (CONTROL_EXEMPTIONS[control.key] !== undefined) {
        filled.set(control.key, { control, value: "" });
        continue;
      }
      // Answering an earlier control in this same batch can hide this one (the connection form's
      // credential requirement removes the credential field), so presence is re-checked rather
      // than assumed from the enumeration that found it.
      if ((await region.locator(control.key).count()) !== 1) continue;
      filled.set(control.key, { control, value: await typeInto(region, control, filled.size) });
    }
  }
}

test.describe("a draft survives the player leaving its surface and coming back", () => {
  for (const [index, surface] of WALKED_SURFACES.entries()) {
    const next = WALKED_SURFACES[(index + 1) % WALKED_SURFACES.length]!;
    test.setTimeout(180_000);

    test(`${surface.name}: every field the surface renders keeps what the player put there`, async ({ page }) => {
      const stub = await stubShell(page);

      await page.goto(`/#profile=composed-reference-game&boot=${token}`);
      await expect(page.getByTestId("chat-surface")).toBeVisible();

      // The app bar's own entries are what the surface exemptions are asserted against: a surface
      // this gate does not walk must still be a surface the product offers.
      const entries = await page
        .locator(".app-bar-actions .nav-button")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
      for (const [label, reason] of Object.entries(SURFACE_EXEMPTIONS)) {
        expect(entries, `an excluded surface (${reason}) is still one the bar offers`).toContain(label);
      }
      for (const walked of WALKED_SURFACES) {
        expect(entries, `the bar offers the ${walked.name} surface this gate walks`).toContain(walked.label);
      }

      const region = await openSurface(page, surface);
      await prepareSurface(page, surface, region);
      // The declared editors open HERE as well as inside the walk: a surface whose only field sits
      // one press away (the Chats surface's rename, the transcript row's editor) renders none until
      // it is opened, and the population is what the player can reach, not what is already drawn.
      await revealEditors(region);
      await openDisclosures(region);
      expect((await enumerateControls(region)).length, `${surface.name} renders fields this gate is about`).toBeGreaterThan(0);
      const typed = (await fillEverything(region)).filter((entry) => CONTROL_EXEMPTIONS[entry.control.key] === undefined);
      expect(typed.length, `${surface.name} has fields this gate requires a draft from`).toBeGreaterThan(0);

      // The interruption, exactly as a player performs it: this surface is unmounted, another one
      // takes the region, and then this one comes back.
      await openSurface(page, next);
      const returned = await openSurface(page, surface);

      const failures: string[] = [];
      const readings: { key: string; typed: string; back: string | null }[] = [];
      for (const { control, value } of typed) {
        const back = returned.locator(control.key);
        /*
         * Auto-retrying assertions, not one-shot reads: the returning surface re-reads its
         * projections on mount, and a field that only renders once its read lands (the persona
         * editor while the record is still loading) would otherwise be reported lost a moment
         * before it is drawn. The wait cannot hide a real loss: what it settles on is the value
         * the field holds afterwards.
         */
        const present = await back
          .first()
          .waitFor({ state: "attached", timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
        if (!present) {
          readings.push({ key: control.key, typed: value, back: null });
          failures.push(`${control.key} (${control.name}) is gone after the switch`);
          continue;
        }
        const held = await back.inputValue();
        readings.push({ key: control.key, typed: value, back: held });
        if (held !== value) failures.push(`${control.key} (${control.name}) came back as ${JSON.stringify(held)}`);
      }

      console.log(
        `MEASURE ${surface.name}: typed=${typed.length} lost=${failures.length} ${JSON.stringify({ failures, readings })}`,
      );
      expect(failures, `every value put into ${surface.name} survived the switch and the way back`).toEqual([]);

      if (surface.name === "settings") {
        // The language tag commits on blur, so leaving the surface attempted that write. It was
        // refused, and it is the refused text - not the stored `zh-CN` - that must come back.
        expect(stub.languageWrites(), "a language save the switch attempted was refused, not accepted").toBeGreaterThan(
          0,
        );
      }
    });
  }
});

test("the exclusion list names controls that really exist", async ({ page }) => {
  test.setTimeout(180_000);
  await stubShell(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  const found = new Set<string>();
  for (const surface of WALKED_SURFACES) {
    const region = await openSurface(page, surface);
    await prepareSurface(page, surface, region);
    for (const { control } of await fillEverything(region)) found.add(control.key);
  }

  const stale = Object.keys(CONTROL_EXEMPTIONS).filter((key) => !found.has(key));
  console.log(
    `MEASURE exclusions: found=${found.size} excluded=${Object.keys(CONTROL_EXEMPTIONS).length} stale=${JSON.stringify(stale)}`,
  );
  expect(
    stale,
    "every exclusion names a control the enumeration found - an exclusion for a control that no longer exists protects nothing",
  ).toEqual([]);
  for (const [key, reason] of Object.entries(CONTROL_EXEMPTIONS)) {
    expect(reason.length, `the exclusion for ${key} states a reason`).toBeGreaterThan(0);
  }
});
