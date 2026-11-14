/**
 * The skip link lands the keyboard where it says it lands.
 *
 * THE DEFECT
 *
 * `SkipLink` is the first thing in the shell: an `<a href="#main-content">` that appears on the first
 * Tab. Activating it scrolls the page to the main region, and that is all it did - none of the three
 * `<main id="main-content">` sites carried `tabIndex={-1}`, so keyboard focus stayed on the link
 * itself, up in the app bar. A player who asked to skip the chrome was scrolled past it and then had
 * to Tab through it anyway. The promise a skip link makes is about *focus*, and scrolling alone
 * breaks it silently: the page looks right.
 *
 * THREE PATHS, AND WHY THE POPULATION IS THE SOURCE
 *
 * The shell renders a `<main>` for each of its three states - the read in flight, the read refused,
 * and the settled shell - and they are separate render paths, so fixing one is not fixing the
 * accessibility promise. Two of them are driven below with the shell held in that state; the third,
 * and every `<main>` a later screen adds, is held by the population check, which reads every JSX
 * `<main>` in `src/**` and requires it to be the link's target and to be programmatically focusable.
 *
 * WHAT IS MEASURED
 *
 * `document.activeElement` after a real Enter on the focused link - not the `href`, not the
 * attribute. A focused link whose target is not focusable leaves `activeElement` on the `<a>`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { type Page, expect, test } from "./frontend-coverage";
import { jsonOk, root, token } from "./composed-reference-game-fixtures";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every `.tsx` under `src`, so a new screen is read without being listed here. */
function tsxFiles(directory = SRC): readonly string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      out.push(...tsxFiles(path));
      continue;
    }
    if (name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** Every `<main>` the source renders: the file, its `id`, and whether it takes programme focus. */
function mainRegions(): readonly { file: string; id: string | null; tabIndex: string | null }[] {
  const found: { file: string; id: string | null; tabIndex: string | null }[] = [];
  for (const file of tsxFiles()) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        if (opening.tagName.getText() === "main") {
          const attributes = new Map<string, string>();
          for (const property of opening.attributes.properties) {
            if (!ts.isJsxAttribute(property)) continue;
            const initializer = property.initializer;
            if (initializer === undefined) attributes.set(property.name.getText(), "");
            else if (ts.isStringLiteral(initializer)) attributes.set(property.name.getText(), initializer.text);
            else if (ts.isJsxExpression(initializer))
              attributes.set(property.name.getText(), initializer.expression?.getText() ?? "");
          }
          found.push({
            file: file.replace(/\\/gu, "/").split("/src/").pop() ?? file,
            id: attributes.get("id") ?? null,
            tabIndex: attributes.get("tabIndex") ?? null,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** Where the keyboard is after the skip link is activated, and what that element is. */
async function focusAfterSkip(page: Page): Promise<{ insideMain: boolean; tag: string; described: string }> {
  return await page.evaluate(() => {
    const active = document.activeElement;
    return {
      insideMain: active !== null && active.closest("#main-content") !== null,
      tag: active === null ? "none" : active.tagName.toLowerCase(),
      described:
        active === null
          ? "none"
          : `${active.tagName.toLowerCase()}${active.id === "" ? "" : `#${active.id}`}${active.className === "" ? "" : `.${String(active.className).split(" ").join(".")}`}`,
    };
  });
}

test("every <main> the shell renders is the skip link's focusable target", () => {
  const regions = mainRegions();
  console.log(`[main-regions] ${JSON.stringify(regions)}`);
  expect(regions.length, "blocked: no <main> in the source, so there is nothing for the skip link to reach").toBeGreaterThan(
    0,
  );
  const findings = regions
    .filter((region) => region.id !== "main-content" || region.tabIndex !== "-1")
    .map(
      (region) =>
        `${region.file}: <main id="${region.id ?? "(none)"}" tabIndex="${region.tabIndex ?? "(none)"}"> - ` +
        "a skip link scrolls to `#main-content`, and only a target that takes programme focus " +
        "(`tabIndex={-1}`) moves the keyboard there",
    );
  expect(findings, findings.join("\n")).toEqual([]);
});

test.describe("activating the skip link moves the keyboard into the main region", () => {
  for (const path of ["settled shell", "refused read", "read in flight"] as const) {
    test(path, async ({ page }) => {
      if (path === "settled shell") {
        await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
        await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
      } else if (path === "refused read") {
        // The composed boundary's refusal is the bounded `{ code }` document.
        await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
          route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "storage_unavailable" }) }),
        );
      } else {
        // The read never answers, so the shell stays in the state it paints while one is in flight.
        await page.route("**/api/composed-reference-game/v1/bootstrap", () => undefined);
      }

      await page.goto(`/#profile=composed-reference-game&boot=${token}`);
      const skip = page.locator(".skip-link");
      await expect(skip).toHaveCount(1);
      await expect(page.locator("#main-content")).toHaveCount(1);

      // A real keyboard journey: Tab reaches the link first, Enter activates it.
      await page.keyboard.press("Tab");
      await expect(skip).toBeFocused();
      await page.keyboard.press("Enter");

      const focus = await focusAfterSkip(page);
      console.log(`[skip-link] ${path}: ${JSON.stringify(focus)}`);
      expect(focus.insideMain, `the keyboard is left on ${focus.described} instead of the main region`).toBe(true);
      expect(focus.tag, "the main region itself takes the focus, not something inside it").toBe("main");
    });
  }
});
