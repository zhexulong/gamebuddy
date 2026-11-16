// The drawer a previous step leaves open, and the peek the bar entry gets after it.
//
// The defect this holds, measured on `frontend-final-r1` (D:/gb-modcheck/frontend-final-r1.stage/logs/
// capture.log): 21 of 26 drivers died on `locator.click` for an app-bar entry. The log's own call logs
// say the element resolved, was enabled and was STABLE every time, and that the click ended on
// "intercepts pointer events" by a `.context-panel` modal `<dialog>` - the opening picker's title, a
// `.drawer-header`, the drawer's own close `x`. The drawer is `showModal()`, anchored to the right edge,
// and its header is exactly one `var(--appbar-height)` row at the top of the window, which is where
// `.app-bar-actions` is: the bar is behind the top layer, and no app-bar rule can lift it back.
//
// `activateSurface` already knew the shape and already pressed Escape for it, but it gated that press on
// `.backdrop-overlay` - a class the product deleted when the drawer became a native `<dialog>` with a
// `::backdrop` scrim. The class survives only inside a comment in `style.css`, so the gate was never
// true, Escape was never pressed, and the next click was guaranteed to land in the drawer's header.
//
// WHAT IS HELD HERE, without a browser:
//   - the dismissal keys on the open dialog itself, and Escape is pressed BEFORE the bar entry;
//   - a bar with no drawer open costs no keypress;
//   - a drawer that outlives the Escape is named, `surface_switch_blocked_by_open_drawer: <testid>`,
//     instead of being left to look like a 30 s click timeout - and the entry is NOT clicked.
//
// red-proof: inject  put the old gate back (`page.locator(".backdrop-overlay")`) -> the scripted page
//   answers 0 for that selector the way the product does (nothing writes the class any more), so no
//   Escape is pressed and the first test fails on its own assertion -
//   `the bar was reached after the drawer was gone: expected false, actual true` - while
//   `selector-producer.1` names the name beside it (`common.cjs:261: class \`backdrop-overlay\` is read
//   (unknown) and no source in dialogue-web/src writes it`).
import assert from "node:assert/strict";
import { test } from "node:test";

import { activateSurface } from "./common.cjs";

/**
 * A page that models only what `activateSurface` asks of it: a modal drawer that may or may not close,
 * and a bar whose entries are unreachable through one.
 *
 * The interception is modelled rather than faked away, because it is the fact the defect turned on: a
 * click while the drawer is open is the same failure Playwright reported, so a fix that presses no
 * Escape cannot pass here by luck.
 */
function scriptedPage({ drawer = null } = {}) {
  const events = [];
  let openDrawer = drawer;
  const page = {
    events,
    get clicksThroughOpenDrawer() {
      return events.some((event) => event.kind === "click" && event.throughOpenDrawer);
    },
    get pressCount() {
      return events.filter((event) => event.kind === "press").length;
    },
    keyboard: {
      async press(key) {
        events.push({ kind: "press", key });
        if (openDrawer !== null && openDrawer.closesOnEscape) openDrawer = null;
      },
    },
    async waitForTimeout(_ms) {},
    locator(selector) {
      if (selector === "dialog.context-panel[open]") {
        const handle = {
          async count() {
            return openDrawer === null ? 0 : 1;
          },
          first() {
            return {
              async waitFor() {
                if (openDrawer !== null) throw new Error("waiting for locator to be detached: timeout 5000ms");
              },
              async getAttribute(name) {
                return openDrawer !== null && name === "data-testid" ? openDrawer.testId : null;
              },
            };
          },
        };
        return handle;
      }
      if (selector === ".app-bar-more-trigger")
        return {
          async count() {
            return 0;
          },
          async isVisible() {
            return false;
          },
        };
      if (selector.startsWith(".app-bar-actions .nav-button")) {
        const click = async () => {
          events.push({ kind: "click", selector, throughOpenDrawer: openDrawer !== null });
          if (openDrawer !== null) throw new Error("intercepts pointer events");
        };
        return {
          first: () => ({ click }),
          async count() {
            return 1;
          },
          async isVisible() {
            return true;
          },
        };
      }
      // Anything else is what a real document answers for a selector nothing matches: no elements. That
      // is load-bearing for the red proof - a gate on a class the product deleted reads "nothing to
      // dismiss" here exactly as it did in the live run, rather than being caught by a strictness the
      // browser does not have.
      return {
        async count() {
          return 0;
        },
        async isVisible() {
          return false;
        },
      };
    },
  };
  return page;
}

test("a modal drawer is dismissed before the bar entry is clicked", async () => {
  const page = scriptedPage({ drawer: { testId: "opening-picker", closesOnEscape: true } });
  const route = await activateSurface(page, "会话");
  assert.equal(route, "app-bar");
  assert.equal(page.pressCount, 1, "the drawer's own close gesture is Escape");
  assert.equal(page.clicksThroughOpenDrawer, false, "the bar was reached after the drawer was gone");
  assert.deepEqual(
    page.events.map((event) => event.kind),
    ["press", "click"],
    "Escape is pressed first, and only then is the entry clicked",
  );
});

test("a bar with no drawer open costs no keypress", async () => {
  const page = scriptedPage();
  const route = await activateSurface(page, "会话");
  assert.equal(route, "app-bar");
  assert.equal(page.pressCount, 0);
  assert.deepEqual(
    page.events.map((event) => event.kind),
    ["click"],
  );
});

test("a drawer that outlives the Escape fails by name, and the entry is not clicked", async () => {
  const page = scriptedPage({ drawer: { testId: "opening-picker", closesOnEscape: false } });
  await assert.rejects(
    () => activateSurface(page, "会话"),
    (error) => {
      assert.match(error.message, /^surface_switch_blocked_by_open_drawer: opening-picker$/u);
      return true;
    },
  );
  assert.equal(page.pressCount, 1, "Escape was tried");
  assert.deepEqual(
    page.events.filter((event) => event.kind === "click"),
    [],
    "a blocked switch clicks nothing",
  );
});
