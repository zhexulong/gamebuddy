/**
 * A focused control is still visibly focused when the system takes the colours away.
 *
 * THE DEFECT
 *
 * Several of the product's focus rings are drawn with `box-shadow`, and the field's own `outline` is
 * removed in the base rule (`outline: none` in `theme.legacy`, which outranks the sheet's class-less
 * `:focus-visible` outline because it is written in a later layer). In the ordinary appearance that is
 * a complete ring. Under Windows High Contrast - CSS `forced-colors: active` - the platform drops
 * `box-shadow` entirely and forces every colour to a system one, so the box-shadow ring disappears and
 * the control is left with nothing that says it has focus: the field keeps working, the mouse user
 * sees nothing wrong, and a keyboard user loses the position.
 *
 * THE REPAIR, AND WHY IT IS AN OUTLINE
 *
 * `outline` is the one ring the platform keeps under forced colours, and it does not paint over the
 * layout. Declaring `outline: 2px solid transparent` beside the box-shadow is invisible in the
 * ordinary appearance - the token ring stays the thing the player sees - and under forced colours the
 * platform forces that transparent outline's colour to a system colour, so the ring reappears in the
 * system's own ink. The assertion below is therefore two-sided: the outline must be *invisible* in the
 * ordinary appearance and *visible* under forced colours, so the repair cannot be a second ring drawn
 * on top of the first.
 *
 * WHAT IS MEASURED, AND FROM WHERE
 *
 * The computed style of the element that actually carries the ring, after the control inside it is
 * focused: the composer's container (`:focus-within`), and the fields of the shared form family.
 * `emulateMedia({ forcedColors: "active" })` is a real emulation of the platform's forced-colours mode,
 * so both cells are measured in the browser rather than reasoned about.
 */
import { type Page, expect, test } from "./frontend-coverage";

/** The ring a control actually gets: the outline the platform keeps, and the shadow it drops. */
type Ring = Readonly<{
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
}>;

/** True when a computed `outlineColor` paints nothing, whichever notation the browser reports it in. */
function isTransparent(color: string): boolean {
  const rgba = /^rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\s*\)$/u.exec(color);
  if (rgba !== null) return Number(rgba[1]) === 0;
  return color === "transparent";
}

/** The computed ring of the element that carries it, after `focusSelector` is focused. */
async function ringOf(page: Page, focusSelector: string, readSelector: string): Promise<Ring> {
  await page.locator(focusSelector).first().focus();
  return await page.evaluate((target) => {
    const element = document.querySelector(target);
    if (element === null) throw new Error(`no element matches ${target}`);
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
    };
  }, readSelector);
}

/**
 * A frame holding the sheet's own control classes, so a field can be measured without driving a whole
 * surface first: the ring is the class's business, not the screen's.
 */
async function installFields(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("forced-frame")?.remove();
    const frame = document.createElement("div");
    frame.id = "forced-frame";
    frame.style.cssText = "position: fixed; left: 0; top: 0; width: 420px; display: flex; flex-direction: column;";
    for (const [tag, className] of [
      ["input", "form-input"],
      ["textarea", "message-edit-field"],
      ["select", "form-select"],
    ]) {
      const control = document.createElement(tag);
      control.className = className;
      control.id = `forced-${className}`;
      if (tag === "select") control.innerHTML = "<option>one</option>";
      frame.appendChild(control);
    }
    document.body.appendChild(frame);
  });
}

const TARGETS = [
  { name: "the composer's container", focus: "textarea.composer-textarea", read: ".composer-container" },
  { name: "a shared form field", focus: "#forced-form-input", read: "#forced-form-input" },
  { name: "the reply editor", focus: "#forced-message-edit-field", read: "#forced-message-edit-field" },
  { name: "a form select", focus: "#forced-form-select", read: "#forced-form-select" },
] as const;

/** The probe page with both the product's composer and the field gallery mounted. */
async function openRings(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => document.querySelector("textarea.composer-textarea") !== null);
  await installFields(page);
}

test.describe("the focus ring survives the system taking the colours away", () => {
  test("in the ordinary appearance the ring is the token's, and the outline stays out of the way", async ({ page }) => {
    await openRings(page);

    for (const target of TARGETS) {
      const ring = await ringOf(page, target.focus, target.read);
      console.log(`[ring:normal] ${target.name} ${JSON.stringify(ring)}`);
      expect(ring.outlineStyle, `${target.name}: an outline is declared, so the platform has one to force`).toBe("solid");
      expect(ring.outlineWidth, `${target.name}: two pixels, the platform's own ring measure`).toBe("2px");
      expect(
        isTransparent(ring.outlineColor),
        `${target.name}: the outline is transparent here, so it is not a second ring on top of the token's`,
      ).toBe(true);
      expect(ring.boxShadow, `${target.name}: the token ring is still what the player sees`).not.toBe("none");
    }
  });

  test("under forced colors the same outline is visible, because the platform forces its colour", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openRings(page);

    for (const target of TARGETS) {
      const ring = await ringOf(page, target.focus, target.read);
      console.log(`[ring:forced] ${target.name} ${JSON.stringify(ring)}`);
      expect(ring.boxShadow, `${target.name}: the platform drops the box-shadow, which is the defect`).toBe("none");
      expect(ring.outlineStyle, `${target.name}: the ring that is left is an outline`).toBe("solid");
      expect(ring.outlineWidth, `${target.name}: and it is still two pixels wide`).toBe("2px");
      expect(
        isTransparent(ring.outlineColor),
        `${target.name}: the platform forced the transparent outline to a system colour, so the control is visibly focused`,
      ).toBe(false);
    }
  });
});
