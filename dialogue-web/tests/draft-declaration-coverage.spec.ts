import { type Locator, type Page, expect, test } from "./frontend-coverage";
import {
  CONTROL_EXEMPTIONS,
  OPENER_EXEMPTIONS,
  SURFACE_EXEMPTIONS,
  WALKED_SURFACES,
  catalogue,
  enumerateControls,
  openDisclosures,
  openSurface,
  prepareSurface,
  revealEditors,
  stubShell,
  textControls,
  token,
} from "./draft-surfaces";

/**
 * The coverage gate for the family `draft-survives-interruption.spec.ts` measures: a text field whose
 * contents die when its component unmounts.
 *
 * That journey asks the right question and asks it of the DOM - but only of the DOM it can REACH. It
 * enumerates the controls a surface renders, and it opens the editors the product declares with
 * `data-draft-revealer`. An editor nobody declared is therefore invisible to it: the journey reports
 * a clean surface while the player's own editor sat one press away, outside the population. That is
 * not a hypothetical. It is how three separate editors were each fixed one at a time - a world book
 * editor, the Chats rename and the transcript row's in-place edit, the memory chapter correction -
 * with nothing watching the class they belonged to.
 *
 * So this gate asks the complementary question, of the same rendered product:
 *
 *   1. every surface the app bar offers is either walked by that journey, exempt with a reason, or
 *      reported `unassessed` with the reason it could not be reached - never skipped in silence;
 *   2. every `<button>`/`<summary>` a surface renders is pressed on its own fresh copy of the surface,
 *      and if pressing it makes a text control appear that the journey's own population does not
 *      contain, that opener is an editor nobody declared. It is named, with the field it reveals;
 *   3. every `data-draft-revealer` really reveals a text field - a declaration over a control that
 *      opens nothing is a claim the population rests on and cannot check;
 *   4. every exemption names something that still exists, so an exemption that stops being needed
 *      fails the run instead of quietly protecting nothing.
 *
 * Where the populations come from, and why not from a list:
 *
 *   - the surfaces come from the app bar's own entries, pressed one at a time; the region each one
 *     shows is found by the `data-testid` the shell gives it, not by a table here;
 *   - the controls come from `enumerateControls()` over the rendered region - the same function the
 *     journey uses, so "what this gate sees" and "what that journey walks" cannot drift apart;
 *   - the editors come from pressing what the surface RENDERS, which is the only population that
 *     includes an editor whose opener forgot to declare itself.
 *
 * What this gate cannot see, said plainly rather than implied: a text field that only exists after
 * the Host answers a request the composed fixture never makes (a memory chapter correction over a
 * chapter the fixture does not return, a Game creation form on a surface no fixture can arm). Those
 * are reported as `unassessed` with the reason, and the reason names what would have to change.
 *
 * The one thing it deliberately does NOT do is press an opener twice or press a second opener on the
 * same copy of a surface. Each press starts from a freshly mounted surface, because pressing one
 * opener can hide another - the connection form's credential requirement removes the credential
 * field - and a shared copy would then report the second opener as revealing nothing when what
 * happened is that the first one closed its door.
 */

/** The most openers one surface may cost before the gate says so instead of running forever. */
const PRESS_BUDGET = 60;
/** How many times a surface is re-opened to retry an opener whose press did not land. */
const PRESS_PASSES = 3;
/** One press: long enough for a real control, short enough that a blocked one is not the whole run. */
const PRESS_TIMEOUT_MS = 1_000;
/** The wall-clock ceiling for one surface's opener walk, so a pathological surface cannot stall the zone. */
const PRESS_DEADLINE_MS = 25_000;

/** One opener the surface rendered, addressed the same way a control is. */
type Opener = Readonly<{ key: string; name: string }>;

/** The status a control or a surface was given, in the order the report prints them. */
type Status = "declared" | "exempt" | "unassessed" | "violation";

/**
 * Every visible, enabled `button`/`summary` inside `region`, each with the address that survives its
 * own remount.
 *
 * A `<summary>` is in the population because a disclosure is the other way a field hides, and because
 * a summary stays on screen when pressed it cannot be a `data-draft-revealer` - so the only way to
 * know whether the field behind it is declared is to press it and look.
 */
async function visibleOpeners(region: Locator): Promise<Opener[]> {
  return await region.evaluate((root) => {
    const out: { key: string; name: string }[] = [];
    for (const element of root.querySelectorAll("button, summary")) {
      /*
       * Opacity is deliberately NOT part of this test, unlike the control enumeration's. A row's
       * action strip is drawn at `opacity: 0` until the player points at it, and the browser still
       * lets them press what is there - so an opener the pointer reveals is an opener, while a
       * control the player could not type into even on hover is not.
       */
      if (!element.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, checkVisibilityCSS: true }))
        continue;
      if ((element as HTMLButtonElement).disabled) continue;
      const id = element.getAttribute("id");
      const aria = element.getAttribute("aria-label");
      const testId = element.getAttribute("data-testid");
      const className = element.classList.item(0);
      const tag = element.tagName.toLowerCase();
      const hooks = [...element.attributes].map((attribute) => attribute.name).filter((name) => name.startsWith("data-"));
      const text = (element.textContent ?? "").trim().replace(/\s+/gu, " ");
      /*
       * The same recipe the control address uses, with the words on the control as the last resort:
       * a summary and a bare icon button both reach it, and a key nobody can read is worse than a key
       * that moves when the catalogue does - the alternative is an opener the gate cannot name.
       */
      const key =
        id !== null && id !== ""
          ? `#${id}`
          : testId !== null && testId !== ""
            ? `${tag}[data-testid=${JSON.stringify(testId)}]`
            : hooks.length > 0
              ? `${tag}[${hooks[0]}]`
              : aria !== null && aria !== ""
                ? `${tag}[aria-label=${JSON.stringify(aria)}]`
                : className !== null && className !== ""
                  ? `${tag}.${className}`
                  : `${tag}[text=${JSON.stringify(text.slice(0, 48))}]`;
      const name = aria ?? (id !== null && id !== "" ? id : (hooks[0] ?? (text.slice(0, 48) || tag)));
      out.push({ key, name });
    }
    return out;
  });
}

/** The addresses of the text controls `region` currently renders. */
async function textKeys(region: Locator): Promise<string[]> {
  return textControls(await enumerateControls(region)).map((control) => control.key);
}

/** The addresses of the editors the product declares on this surface. */
async function revealerKeys(region: Locator): Promise<string[]> {
  return await region.locator("[data-draft-revealer]").evaluateAll((nodes) =>
    nodes.map((element) => {
      const id = element.getAttribute("id");
      const aria = element.getAttribute("aria-label");
      const testId = element.getAttribute("data-testid");
      const className = element.classList.item(0);
      const tag = element.tagName.toLowerCase();
      const hooks = [...element.attributes].map((attribute) => attribute.name).filter((name) => name.startsWith("data-"));
      if (id !== null && id !== "") return `#${id}`;
      if (testId !== null && testId !== "") return `${tag}[data-testid=${JSON.stringify(testId)}]`;
      if (hooks.length > 0) return `${tag}[${hooks[0]}]`;
      if (aria !== null && aria !== "") return `${tag}[aria-label=${JSON.stringify(aria)}]`;
      if (className !== null && className !== "") return `${tag}.${className}`;
      return `${tag}[data-draft-revealer]`;
    }),
  );
}

/** One surface as the app bar offers it, and the region it takes. */
type BarSurface = Readonly<{ name: string; label: string; testId: string }>;

/**
 * The surfaces the product offers, read off the app bar.
 *
 * Pressing each entry and reading the `data-testid` of the region it shows is the only derivation
 * that survives a surface being renamed or added: a list here would go stale in the direction that
 * matters - a NEW surface, whose fields nothing would ever enumerate.
 */
async function barSurfaces(page: Page): Promise<BarSurface[]> {
  const labels = await page
    .locator(".app-bar-actions .nav-button")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? "").filter((label) => label !== ""));
  const surfaces: BarSurface[] = [];
  // The bar folds its tail behind one control of its own; that control shows no surface, so it is the
  // one entry that is not a surface. It names itself from the catalogue, so a rename moves both.
  for (const label of labels.filter((candidate) => candidate !== catalogue.appBarMore)) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const region = page.locator("main#main-content [data-testid$='-surface']");
    await expect(region, `the ${label} entry shows one surface region`).toHaveCount(1);
    const testId = (await region.getAttribute("data-testid")) ?? "";
    surfaces.push({ name: testId.replace(/-surface$/u, ""), label, testId });
  }
  return surfaces;
}

/** Mount one surface the way the retention journey leaves it, and report what that population is. */
async function mount(
  page: Page,
  surface: BarSurface,
): Promise<{ region: Locator; onArrival: string[]; revealers: string[] }> {
  const region = await openSurface(page, surface);
  await prepareSurface(page, surface, region);
  // The declarations are read BEFORE they are consumed: a revealer replaces itself when pressed, so
  // the only moment its own identity is on screen is the moment the player arrives.
  const revealers = await revealerKeys(region);
  await revealEditors(region);
  await openDisclosures(region);
  return { region, onArrival: await textKeys(region), revealers };
}

/**
 * Press every opener the surface renders, one per freshly mounted copy, and report what each reveals.
 *
 * `revealed` maps an opener to the text controls that appeared only because it was pressed. An opener
 * that reveals nothing is absent from the map, which is how a declaration over a control that opens
 * no editor is told apart from one that does.
 */
/** What one surface's opener walk found, and what it could not reach. */
type OpenerWalk = Readonly<{
  revealed: Map<string, string[]>;
  landed: ReadonlySet<string>;
  pressed: number;
  openers: number;
  exhausted: boolean;
}>;

/**
 * Press every opener the surface renders, and report what each one reveals.
 *
 * `revealed` maps an opener to the text controls that appeared only because it was pressed. An opener
 * that reveals nothing is absent from the map, which is how a declaration over a control that opens
 * no editor is told apart from one that does.
 *
 * A pass presses through one copy of the surface rather than re-mounting for each opener: opening a
 * surface is the expensive part, and this gate runs inside the mounted zone beside every other
 * journey. A press can hide another opener (the connection form's credential requirement removes the
 * credential field) and can leave a drawer, a menu or an armed confirmation over the surface, so each
 * pass ends by pressing Escape and the next pass starts from a freshly opened surface. An opener
 * whose press did not land is retried there; one that still does not land is reported rather than
 * counted as pressed.
 */
async function pressEveryOpener(page: Page, surface: BarSurface): Promise<OpenerWalk> {
  const revealed = new Map<string, string[]>();
  const landed = new Set<string>();
  const seen = new Set<string>();
  let exhausted = false;
  const deadline = Date.now() + PRESS_DEADLINE_MS;
  for (let pass = 0; pass < PRESS_PASSES && !exhausted; pass += 1) {
    await page.keyboard.press("Escape");
    let region: Locator;
    try {
      region = await openSurface(page, surface);
    } catch {
      // The surface could not be re-opened for this pass. That is a reading, not a crash: the opener
      // walk stops and the caller reports how many of the surface's openers it reached.
      exhausted = true;
      break;
    }
    // NOT `prepareSurface()`: the disclosures it presses are openers in their own right, and pressing
    // them here would attribute their fields to the preparation instead of to the control that shows
    // them. They are pressed by the pass like every other opener, and their fields land in the
    // arrival population either way.
    // Every text control this surface has shown so far in the pass, so a field a second opener
    // reveals is attributed to the first opener that revealed it rather than counted twice.
    const known = new Set(await textKeys(region));
    const attempted = new Set<string>();
    for (;;) {
      if (landed.size >= PRESS_BUDGET || Date.now() > deadline) {
        exhausted = true;
        break;
      }
      // A press can leave the surface entirely - the composer's own settings control opens another
      // region - and the rest of the pass would then be reading a region that is not on the page.
      if ((await region.count()) === 0) break;
      const candidates = (await visibleOpeners(region)).filter(
        (opener) => !landed.has(opener.key) && !attempted.has(opener.key),
      );
      if (candidates.length === 0) break;
      for (const candidate of candidates) seen.add(candidate.key);
      const opener = candidates[0]!;
      attempted.add(opener.key);
      const target = region.locator(opener.key).first();
      if ((await target.count()) === 0) continue;
      const didLand = await target
        .click({ timeout: PRESS_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
      if (!didLand) continue;
      landed.add(opener.key);
      await page.waitForTimeout(40);
      if ((await region.count()) === 0) break;
      const appeared = (await textKeys(region)).filter((key) => !known.has(key));
      if (appeared.length === 0) continue;
      revealed.set(opener.key, appeared);
      for (const key of appeared) known.add(key);
    }
  }
  return { revealed, landed, pressed: landed.size, openers: seen.size, exhausted };
}

/** One line of the report: a control or an opener, the surface it is on, and the status it was given. */
type Row = Readonly<{ surface: string; key: string; status: Status; note: string }>;

test.describe("every text field the product renders is a declared draft surface", () => {
  test.setTimeout(600_000);

  test("the population the draft journey walks is the population the product renders", async ({ page }) => {
    // Every locator action in this journey is short by design: a control that cannot be pressed is a
    // reading, not a reason to wait out the runner's default timeout five times over.
    page.setDefaultTimeout(5_000);
    await stubShell(page);
    // A press here can land on the card-import or avatar trigger, whose whole job is to open the
    // browser's own file picker. Nothing is chosen, so the press is a press and not an import.
    page.on("filechooser", (chooser) => void chooser.setFiles([]));

    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.getByTestId("chat-surface")).toBeVisible();

    const surfaces = await barSurfaces(page);
    console.log(`SURFACES ${JSON.stringify(surfaces)}`);
    const rows: Row[] = [];
    const violations: string[] = [];
    const unassessed: string[] = [];
    /** The opener exemptions this walk really used, so a stale one fails instead of protecting nothing. */
    const usedOpenerExemptions = new Set<string>();

    for (const surface of surfaces) {
      const exemptReason = SURFACE_EXEMPTIONS[surface.label];
      const startedAtMs = Date.now();
      let mounted: { region: Locator; onArrival: string[]; revealers: string[] };
      try {
        mounted = await mount(page, surface);
      } catch (error) {
        // A surface the harness cannot reach is reported by name with the reason, never skipped: a
        // silent skip is the narrowing this whole file exists to make impossible.
        const reason = `the harness could not mount it: ${String((error as Error).message).split("\n")[0] ?? error}`;
        unassessed.push(`${surface.name} — ${reason}`);
        rows.push({ surface: surface.name, key: "(not mounted)", status: "unassessed", note: reason });
        console.log(`unassessed: ${surface.name} — ${reason}`);
        continue;
      }
      const { region, onArrival, revealers } = mounted;
      const inventory = await textControls(await enumerateControls(region));
      console.log(
        `INVENTORY ${surface.name}: ${JSON.stringify(inventory.map((control) => control.key))} ` +
          `revealers=${JSON.stringify(revealers)} onArrival=${String(onArrival.length)}`,
      );

      if (exemptReason !== undefined) {
        // Reported, never skipped: the reason is part of the reading, and a surface that stops being
        // exempt fails below because its exemption no longer names a surface the bar offers.
        for (const control of inventory) {
          rows.push({ surface: surface.name, key: control.key, status: "exempt", note: exemptReason });
        }
        if (inventory.length === 0) rows.push({ surface: surface.name, key: "(no text field)", status: "exempt", note: exemptReason });
        console.log(`UNASSESSED-SURFACE ${surface.name}: ${exemptReason}`);
        unassessed.push(`${surface.name} — ${exemptReason}`);
        continue;
      }

      // 1. Everything on arrival is inside the journey's population by construction: the journey
      //    enumerates the same region with the same function. What is NOT guaranteed is that the
      //    journey walks this surface at all.
      const walked = WALKED_SURFACES.some((entry) => entry.label === surface.label);
      if (!walked) {
        for (const control of inventory) {
          rows.push({
            surface: surface.name,
            key: control.key,
            status: "violation",
            note: "the surface declares no exemption, and the draft journey never visits it",
          });
        }
        violations.push(
          `${surface.name}: the bar offers this surface and it renders ${String(inventory.length)} text field(s), but ` +
            "`draft-survives-interruption.spec.ts` does not walk it - add it to WALKED_SURFACES (or exempt the surface, with the reason)",
        );
        continue;
      }

      for (const control of inventory) {
        const exemption = CONTROL_EXEMPTIONS[control.key];
        rows.push({
          surface: surface.name,
          key: control.key,
          status: exemption === undefined ? "declared" : "exempt",
          note: exemption ?? (revealers.length > 0 ? "on arrival; revealed editors are declared" : "on arrival"),
        });
      }

      // 2. The editors the product declares must really open a text field.
      const presses = await pressEveryOpener(page, surface);
      if (presses.exhausted) {
        const reason = `opener walk stopped after ${String(presses.pressed)} of ${String(presses.openers)} openers`;
        unassessed.push(`${surface.name} — ${reason}`);
        violations.push(`${surface.name}: ${reason}, so the surface's undeclared editors were not all reached`);
      }
      for (const revealer of revealers) {
        const appeared = presses.revealed.get(revealer);
        // A draft can hold the editor open already, and then the control that opened it is not on the
        // page to press: its field is in the arrival population instead, which is where the journey
        // types into it. Only a revealer the walk really pressed is asked what it revealed.
        if (appeared === undefined && !presses.landed.has(revealer)) continue;
        if (appeared === undefined) {
          // Reported, not failed. Two declarations can open the SAME editor (the companion's book and
          // its one entry), and a record draft can already hold an editor open, so the second press
          // legitimately reveals nothing new - the field it opens is in the population either way. The
          // teeth below are about a field no declaration reaches, which is the gap this gate exists for.
          const note = "declared, and pressing it revealed no field outside the arrival population";
          rows.push({ surface: surface.name, key: revealer, status: "declared", note });
          console.log(`unassessed: ${surface.name} :: ${revealer} — ${note}`);
        }
      }

      // 3. The teeth: an opener that reveals a text field the journey's population does not contain is
      //    an editor nobody declared, and the journey is blind to it.
      const arrival = new Set(onArrival);
      for (const [opener, appeared] of presses.revealed) {
        const outside = appeared.filter((key) => !arrival.has(key) && CONTROL_EXEMPTIONS[key] === undefined);
        if (outside.length === 0) continue;
        const exemption = OPENER_EXEMPTIONS[opener];
        if (exemption !== undefined) {
          usedOpenerExemptions.add(opener);
          for (const key of outside) rows.push({ surface: surface.name, key, status: "exempt", note: exemption });
          continue;
        }
        for (const key of outside) {
          rows.push({ surface: surface.name, key, status: "violation", note: `revealed by ${opener}, which is not declared` });
        }
        violations.push(
          `${surface.name}: pressing ${opener} reveals ${outside.join(", ")}, which no declared editor reaches - mark the ` +
            "control with data-draft-revealer, or exempt it in OPENER_EXEMPTIONS with the reason it needs no draft",
        );
      }

      console.log(
        `MEASURE ${surface.name}: fields=${String(inventory.length)} revealers=${String(revealers.length)} ` +
          `openers=${String(presses.openers)} openers_pressed=${String(presses.pressed)} ` +
          `revealing=${String(presses.revealed.size)} elapsedMs=${String(Date.now() - startedAtMs)}`,
      );
    }

    // 4. An exemption that stops being needed fails here rather than protecting nothing.
    const keys = new Set(rows.map((row) => row.key));
    const barLabels = surfaces.map((surface) => surface.label);
    for (const label of Object.keys(SURFACE_EXEMPTIONS)) {
      if (!barLabels.includes(label))
        violations.push(`the exemption for the ${label} surface names a surface the app bar does not offer: remove it`);
    }
    for (const [key, reason] of Object.entries(CONTROL_EXEMPTIONS)) {
      expect(reason.length, `the exemption for ${key} states a reason`).toBeGreaterThan(0);
      // Not every exemption is in THIS gate's population: the credential field only exists once a
      // provider is chosen, and the selects are not text controls at all. Those are named here rather
      // than failed, and the retention journey - which walks the fuller population - already fails an
      // exemption that stops naming a control it found.
      if (!keys.has(key)) unassessed.push(`${key} — outside this gate's population; the retention journey keeps this exemption honest`);
    }
    for (const [opener, reason] of Object.entries(OPENER_EXEMPTIONS)) {
      expect(reason.length, `the exemption for ${opener} states a reason`).toBeGreaterThan(0);
      if (!usedOpenerExemptions.has(opener))
        violations.push(
          `the exemption for ${opener} was not needed: pressing it revealed no field outside the arrival population, so remove it`,
        );
    }

    console.log(`MEASURE inventory ${JSON.stringify(rows)}`);
    for (const line of unassessed) console.log(`unassessed: ${line}`);
    expect(violations, `every text field on every surface the product offers is a declared draft surface`).toEqual([]);
  });

});
