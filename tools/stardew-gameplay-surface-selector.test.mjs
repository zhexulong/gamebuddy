import assert from "node:assert/strict";
import test from "node:test";
import { extractLiteralOperationSelectors } from "./lib/stardew-gameplay-surface-selector.mjs";

test("extracts nested literal case and comparison selectors without treating strings in comments as operations", () => {
  const source = `
    public bool performAction(string[] action) {
      // case "commented_out":
      switch (action[0]) {
        case "OpenShop": {
          if (action == "Bookseller") return true;
          break;
        }
        case "Warp": break;
      }
      if (action != "Message") return false;
      if (action.Equals("Dialogue")) return true;
      /* case "block_comment" */
      return false;
    }
  `;
  assert.deepEqual(extractLiteralOperationSelectors(source, "performAction"), [
    { selector: "Bookseller", selectorKind: "comparison", selectorVariable: "action" },
    { selector: "Dialogue", selectorKind: "method", selectorVariable: "action" },
    { selector: "Message", selectorKind: "comparison", selectorVariable: "action" },
    { selector: "OpenShop", selectorKind: "case" },
    { selector: "Warp", selectorKind: "case" },
  ]);
});

test("does not extract a selector from a declaration without a body", () => {
  assert.deepEqual(extractLiteralOperationSelectors("public bool performAction(string value);", "performAction"), []);
});
