/**
 * A disabled control is quieter than an enabled one: the order, and not the readability.
 *
 * WHY THIS IS NOT A CONTRAST GATE, AND WHY THAT HAS TO BE SAID OUT LOUD
 *
 * WCAG 2.1 1.4.3 exempts inactive components: a greyed-out label is allowed below 4.5:1, and every
 * contrast gate in this package therefore ignores `:disabled` on purpose. The exemption is about
 * legibility, and it says nothing about emphasis - which leaves the other half of the sentence
 * unheld: a control the player cannot press must not draw more attention than one they can. The
 * defect this gate was written for is exactly that, and no contrast number can see it.
 * `.small-button:disabled` attenuated the control with `opacity` alone, so `.small-button.primary`
 * kept its accent plate at half strength (1.98:1 over the light canvas) while the enabled secondary
 * beside it was flat (0.51), and a modifier written later in the sheet could hand the emphasis
 * straight back. The unusable action was the loud one.
 *
 * WHAT IS MEASURED, FROM THE PIXELS THE BROWSER COMPUTED
 *
 * Three properties per appearance, over the stylesheet's own population of control shapes:
 *
 *   1. any disabled shape:  chrome(shape, disabled)      <= chrome(`.small-button`, enabled)
 *      The only plate a disabled control may wear is the quiet one the plain enabled control wears.
 *
 *   2. per shape:           chrome(shape, disabled)      <= chrome(shape, enabled)
 *      A disabled state never wears more plate or frame than its own enabled state.
 *
 *   3. per shape:           the two states differ, on plate, frame, ink or opacity
 *      A disabled state that paints exactly like the enabled one is indistinguishable from it, so a
 *      modifier with no disabled paint of its own fails here.
 *
 * `plate` is the element's own `background-color`, composited at its alpha and at the element's
 * `opacity` over the surface behind it; `frame` is its border composited the same way; `ink` is its
 * label over that plate. `chrome` is the emphasis of the plate and the frame - each one's contrast
 * against the surface behind, measured as a distance from 1:1, i.e. from invisible.
 *
 * WHY THE LABEL IS PRINTED AND NOT ORDERED
 *
 * `ink` is in every reported row because it is what a reader sees first, but it is not ordered: a
 * toned button's enabled label is a status colour (`--danger` on its own tint), while its disabled
 * label is `--text-disabled`, a token the static contrast gate holds at the AA floor. In the light
 * appearance those read 4.38:1 and 6.19:1 on the canvas, so ordering the label would demand that a
 * disabled control be LESS legible than an enabled one - the opposite of the invariant, and a demand
 * that would push a tone out of the palette. The state is quieter in its plate and frame and lighter
 * in its tone; the label's own contrast is the contrast gates' business, and they exempt it.
 *
 * THE POPULATION IS THE STYLESHEET
 *
 * The shapes measured are the ones the sheet itself gives a disabled state: every class combination
 * appearing in a selector that carries `:disabled` (a `:not(:disabled)` guard names the other state
 * and is not one), plus every modifier the sheet adds to one of them - `.small-button.primary` is
 * written after `.small-button:disabled`, and a modifier written later wins, which is one of the ways
 * this defect arrives. A shape joins this gate by being written into the sheet; nothing here lists
 * buttons. The reference shape is named rather than derived from "the quietest enabled control",
 * because the quiet band is a hairline wide (every flat plate sits between 1.0 and 1.3) and a minimum
 * over it would move with an unrelated plate retune - and it is checked rather than assumed: a sheet
 * that no longer declares `.small-button` blocks this gate instead of narrowing it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contrastRatio } from "../../tools/check-contrast-tokens.mjs";
import { jsonOk, root, token } from "./composed-reference-game-fixtures";
import { type Page, expect, test } from "./frontend-coverage";

const STYLESHEET = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "style.css");

/** The plain control whose enabled paint defines the quiet plate a disabled control may wear. */
const REFERENCE_SHAPE = "small-button";

const CELLS = ["dark", "light"] as const;

/** One declaration block of the stylesheet: the selector as written, and the declarations inside it. */
type Rule = Readonly<{ selector: string; body: string }>;

/**
 * Every innermost `selector { ... }` block of the sheet, with comments removed.
 *
 * The sheet nests its rules inside `@layer` and `@media`; an innermost block is exactly one selector
 * and its declarations, which is the unit a shape is read from. A block whose body holds another
 * block - a layer header, a media query - is skipped by the pattern, so an at-rule can never be
 * mistaken for a selector.
 */
function rulesOf(css: string): readonly Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, " ");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map((match) => ({ selector: match[1].trim(), body: match[2] }))
    .filter((rule) => !rule.selector.startsWith("@"));
}

/** The subject compound of one selector: everything after the last top-level combinator. */
function subjectOf(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (depth === 0 && /[\s>+~]/u.test(character)) start = index + 1;
  }
  return selector.slice(start).trim();
}

/** A compound selector with every pseudo-class and pseudo-element removed, arguments and all. */
function withoutPseudos(compound: string): string {
  let result = "";
  let index = 0;
  while (index < compound.length) {
    if (compound[index] !== ":") {
      result += compound[index];
      index += 1;
      continue;
    }
    index += compound[index + 1] === ":" ? 2 : 1;
    while (index < compound.length && /[a-z-]/iu.test(compound[index])) index += 1;
    if (compound[index] !== "(") continue;
    let depth = 1;
    index += 1;
    while (index < compound.length && depth > 0) {
      if (compound[index] === "(") depth += 1;
      else if (compound[index] === ")") depth -= 1;
      index += 1;
    }
  }
  return result;
}

/**
 * The classes of one selector's subject compound, which is the element the rule paints. A state or
 * structure pseudo (`:disabled`, `:not(:disabled)`, `::before`), a combinator and an attribute
 * selector are not classes, so a compound carrying one is not a shape this gate can weigh and it
 * yields nothing - named here rather than probed as if it were.
 */
function classesOfSubject(selector: string): readonly string[] {
  const stripped = withoutPseudos(subjectOf(selector));
  if (!/^(?:\.[a-z0-9-]+)+$/iu.test(stripped)) return [];
  return stripped.slice(1).split(".");
}

/** A class combination a rule paints, one per selector in its list. */
function compoundsOf(rule: Rule): readonly (readonly string[])[] {
  return rule.selector.split(",").map((part) => classesOfSubject(part));
}

/** A selector written in a negation is not a disabled state: `:not(:disabled)` names the other one. */
const isDisabledSelector = (selector: string): boolean => /:disabled/u.test(selector.replace(/:not\([^()]*\)/gu, ""));

/**
 * The shapes this gate measures: every class combination that carries a disabled state, plus every
 * modifier the sheet adds to one of them, since that is the rule that would override the disabled
 * paint. Sorted, so a failure report and a passing report name the population in one order.
 */
function shapesOf(rules: readonly Rule[]): readonly (readonly string[])[] {
  const compounds = rules.map((rule) => ({ rule, compounds: compoundsOf(rule) }));
  const disabled = new Set<string>();
  for (const { rule, compounds: parts } of compounds)
    if (isDisabledSelector(rule.selector))
      for (const classes of parts) if (classes.length > 0) disabled.add(classes.join("."));
  const population = new Set(disabled);
  for (const { compounds: parts } of compounds)
    for (const classes of parts)
      for (const base of disabled) {
        const baseClasses = base.split(".");
        if (classes.length > baseClasses.length && baseClasses.every((name) => classes.includes(name)))
          population.add(classes.join("."));
      }
  return [...population].sort().map((shape) => shape.split("."));
}

const SHAPES = shapesOf(rulesOf(readFileSync(STYLESHEET, "utf8")));

/** What the browser reports about one control's own paint, before any of it is weighed. */
type ControlPaint = Readonly<{
  background: string;
  borderColor: string;
  borderWidth: number;
  borderStyle: string;
  color: string;
  opacity: number;
}>;

/** A computed colour as the channels CSS painted, or a thrown reading naming the value it could not read. */
function channelsOf(value: string): Readonly<{ rgb: number[]; alpha: number }> {
  const functional = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+))?\s*\)$/u.exec(value);
  if (functional !== null)
    return {
      rgb: [1, 2, 3].map((index) => Number(functional[index])),
      alpha: functional[4] === undefined ? 1 : Number(functional[4]),
    };
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/u.exec(value);
  if (srgb !== null)
    return {
      rgb: [1, 2, 3].map((index) => Number(srgb[index]) * 255),
      alpha: srgb[4] === undefined ? 1 : Number(srgb[4]),
    };
  throw new Error(
    `the browser reported \`${value}\`, which this gate cannot read as one colour: a plate this gate cannot ` +
      "see is a plate it cannot weigh",
  );
}

/** The composite CSS paints: `front` at its own alpha over `back`. */
const over = (front: Readonly<{ rgb: readonly number[]; alpha: number }>, back: readonly number[]): number[] =>
  front.rgb.map((value, index) => value * front.alpha + back[index] * (1 - front.alpha));

/** What one state of one control looks like: its plate, its frame, its label, and the chrome they add up to. */
type Emphasis = Readonly<{ plate: number; frame: number; ink: number; chrome: number }>;

/**
 * The emphasis of one control, as the pixels say it.
 *
 * The element's `opacity` multiplies every colour it paints, so it belongs to the compositing and not
 * to a separate "it is faded" allowance: a half-transparent accent plate is still a plate, and this
 * gate is the one that has to see it as one.
 */
function emphasisOf(paint: ControlPaint, backdrop: readonly number[]): Emphasis {
  const background = channelsOf(paint.background);
  const plate = over({ rgb: background.rgb, alpha: background.alpha * paint.opacity }, backdrop);
  const plateContrast = contrastRatio(plate, backdrop);
  const bordered = paint.borderStyle !== "none" && paint.borderWidth > 0;
  const border = bordered ? channelsOf(paint.borderColor) : { rgb: backdrop, alpha: 0 };
  const frame = bordered
    ? contrastRatio(over({ rgb: border.rgb, alpha: border.alpha * paint.opacity }, backdrop), backdrop)
    : 1;
  const ink = channelsOf(paint.color);
  const inkContrast = contrastRatio(over({ rgb: ink.rgb, alpha: ink.alpha * paint.opacity }, plate), plate);
  return { plate: plateContrast, frame, ink: inkContrast, chrome: plateContrast - 1 + (frame - 1) };
}

const describe = (emphasis: Emphasis, paint: ControlPaint): string =>
  `plate=${emphasis.plate.toFixed(2)}:1 frame=${emphasis.frame.toFixed(2)}:1 ink=${emphasis.ink.toFixed(2)}:1 ` +
  `chrome=${emphasis.chrome.toFixed(2)} (background ${paint.background}, border ${paint.borderColor}, ` +
  `label ${paint.color}, opacity ${paint.opacity})`;

/** The axes on which two states of one control visibly differ. */
function channelsBetween(enabled: ControlPaint, disabled: ControlPaint): readonly string[] {
  const channels: string[] = [];
  if (enabled.background !== disabled.background) channels.push("plate");
  if (enabled.borderColor !== disabled.borderColor) channels.push("frame colour");
  if (enabled.borderWidth !== disabled.borderWidth) channels.push("frame width");
  if (enabled.color !== disabled.color) channels.push("ink");
  if (enabled.opacity !== disabled.opacity) channels.push("opacity");
  return channels;
}

/**
 * Every route the shell reads on the way to its first settled frame, with the appearance record the
 * cell judges. The accessibility spec carries the same list because Playwright's fixtures are bound to
 * the file that declares them, and a spec that stubbed less would judge a page nobody launches into.
 */
async function stubRoutes(page: Page, appearance: "dark" | "light"): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: "" })),
  );
  await page.route("**/api/tavern/v1/settings/appearance", (route) =>
    route.fulfill(jsonOk({ revision: 0, appearance })),
  );
  await page.route("**/api/tavern/v1/settings/ui-language", (route) =>
    route.fulfill(jsonOk({ revision: 0, locale: "en" })),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 0, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        recommendedModels: [],
        chat: { revision: 0, thinkingLevel: "high" },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      jsonOk({
        revision: 0,
        disclosureVersion: null,
        consent: "undecided",
        decidedAtMs: null,
        outputDevice: null,
        persona: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) => route.fulfill(jsonOk({ devices: [] })));
}

/**
 * Mount every shape twice - enabled, then disabled - inside the element that paints the canvas, and
 * read what the browser computed for both. The twins share a parent, so they share a backdrop and
 * differ only in the state the gate is weighing.
 */
async function paintShapes(page: Page, shapes: readonly (readonly string[])[]) {
  const reading = await page.evaluate((lists) => {
    const host = document.querySelector(".tavern-app-shell");
    if (host === null) throw new Error("the shell did not render: `.tavern-app-shell` is absent");
    const paintOfElement = (element: Element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        borderColor: style.borderTopColor,
        borderWidth: Number.parseFloat(style.borderTopWidth) || 0,
        borderStyle: style.borderTopStyle,
        color: style.color,
        opacity: Number.parseFloat(style.opacity),
      };
    };
    const mount = (classes: readonly string[], disabled: boolean) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = classes.join(" ");
      button.disabled = disabled;
      button.textContent = "label";
      host.append(button);
      return button;
    };
    const controls = lists.map((classes) => {
      const enabled = mount(classes, false);
      const disabled = mount(classes, true);
      const pair = { shape: classes.join("."), enabled: paintOfElement(enabled), disabled: paintOfElement(disabled) };
      enabled.remove();
      disabled.remove();
      return pair;
    });
    return { backdrop: getComputedStyle(host).backgroundColor, controls };
  }, shapes.map((shape) => [...shape]));
  return { backdrop: channelsOf(reading.backdrop).rgb, controls: reading.controls };
}

test.describe("a disabled control is quieter than an enabled one", () => {
  for (const appearance of CELLS) {
    test(`${appearance} appearance`, async ({ page }) => {
      await stubRoutes(page, appearance);
      // The OS asks for the OTHER appearance, so the painted one can only be the record's answer.
      await page.emulateMedia({ colorScheme: appearance === "dark" ? "light" : "dark" });
      await page.goto(`/#profile=composed-reference-game&boot=${token}`);
      await expect(page.getByTestId("chat-surface")).toBeVisible();
      await expect
        .poll(async () => await page.evaluate(() => document.documentElement.getAttribute("data-theme")), {
          message: `the shell paints the ${appearance} appearance the Host's record holds`,
        })
        .toBe(appearance);

      // A population this gate could not read is a blocked reading, not a pass.
      assert.ok(SHAPES.length > 0, "the stylesheet declares no control with a disabled state to weigh");
      assert.ok(
        SHAPES.some((shape) => shape.join(".") === REFERENCE_SHAPE),
        `the stylesheet no longer declares \`.${REFERENCE_SHAPE}\`, the plain control this gate weighs every ` +
          "disabled shape against: name the shape that replaced it in REFERENCE_SHAPE",
      );

      const { backdrop, controls } = await paintShapes(page, SHAPES);
      const weighed = controls.map((control) => ({
        shape: `\`${control.shape}\``,
        enabled: { paint: control.enabled, emphasis: emphasisOf(control.enabled, backdrop) },
        disabled: { paint: control.disabled, emphasis: emphasisOf(control.disabled, backdrop) },
      }));
      const reference = weighed.find((row) => row.shape === `\`${REFERENCE_SHAPE}\``);
      assert.ok(reference !== undefined, `\`.${REFERENCE_SHAPE}\` was not weighed`);

      console.log(
        `[disabled ${appearance}] backdrop=${backdrop.map((value) => Math.round(value)).join(",")} ` +
          `shapes=${weighed.length} reference=\`${REFERENCE_SHAPE}\` ` +
          describe(reference.enabled.emphasis, reference.enabled.paint),
      );
      for (const row of weighed)
        console.log(
          `  ${appearance} ${row.shape.padEnd(30)} disabled(${describe(row.disabled.emphasis, row.disabled.paint)}) ` +
            `enabled(${describe(row.enabled.emphasis, row.enabled.paint)})`,
        );

      const violations: string[] = [];
      for (const row of weighed) {
        if (row.disabled.emphasis.chrome > reference.enabled.emphasis.chrome)
          violations.push(
            `${row.shape} wears MORE chrome disabled than the plain enabled control: disabled reads ` +
              `${describe(row.disabled.emphasis, row.disabled.paint)}, while enabled \`.${REFERENCE_SHAPE}\` reads ` +
              `${describe(reference.enabled.emphasis, reference.enabled.paint)} - give this shape a disabled paint ` +
              "that states the quiet plate instead of keeping its fill or its tone at reduced strength",
          );
        if (row.disabled.emphasis.chrome > row.enabled.emphasis.chrome)
          violations.push(
            `${row.shape} wears more chrome disabled than enabled: disabled reads ` +
              `${describe(row.disabled.emphasis, row.disabled.paint)}, enabled reads ` +
              `${describe(row.enabled.emphasis, row.enabled.paint)}`,
          );
        const channels = channelsBetween(row.enabled.paint, row.disabled.paint);
        if (channels.length === 0)
          violations.push(
            `${row.shape} paints its disabled state exactly like its enabled one (${describe(
              row.disabled.emphasis,
              row.disabled.paint,
            )}): a state a player cannot see is not a state - state the disabled plate, frame or ink for this shape`,
          );
      }

      assert.deepEqual(
        violations,
        [],
        `every disabled ${appearance}-appearance control is quieter than an enabled one, and wears no more ` +
          "chrome than the plain enabled control",
      );
    });
  }
});
