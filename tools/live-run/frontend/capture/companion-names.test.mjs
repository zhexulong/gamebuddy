/*
 * "The durable companion list is unchanged" must mean the same named companions, not the panel's
 * section order.
 *
 * The shapes below are the two real ones. The FIRST is the measurement that produced this file: the
 * panel gained and lost sections across `CharactersSurfacePanel`'s split (演出指导 went away) while the
 * companions were untouched. The SECOND is the failure the assertion exists for: one companion gone.
 *
 * The pre-change reading is reproduced here verbatim (`j-card-import.cjs` before 2026-11-15:
 * `[...panel.children].map((card) => String((card.innerText || "").split("\n")[0] || "").trim())`) and
 * shown to be wrong on both shapes - different for an untouched list whose sections moved, identical
 * for a list that lost a companion. That is the red proof: the old instrument could not fail on the
 * defect it was written to catch, and could fail when nothing happened.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { companionNames, sameCompanions } from "./companion-names.cjs";

/** One panel child as the DOM presents it to `innerText.split("\n")[0]`. */
const child = (firstLine) => ({ innerText: `${firstLine}\n落款：山脚小院` });

/** A panel whose sections and companion list are given separately - the way the real panel is built. */
function panel({ sections = [], companions = [], listPresent = true }) {
  const entries = companions.map((name) => ({
    querySelector: (selector) => (selector === "[data-companion-entry-name]" ? { textContent: ` ${name} ` } : null),
  }));
  const list =
    listPresent === false
      ? null
      : { querySelectorAll: (selector) => (selector === "li[data-companion-entry]" ? entries : []) };
  return {
    children: sections.map(child),
    querySelector: (selector) => {
      if (selector === "[data-companion-list]") return list;
      return null;
    },
  };
}

/** The pre-change reading, kept as the thing being disproved. */
const sectionOrderReading = (panelFacts) =>
  panelFacts.children.map((card) => String(card.innerText.split("\n")[0]).trim());

const BEFORE = panel({
  sections: ["同伴", "演出指导", "人格", "开场白"],
  companions: ["Mira", "青禾"],
});
/* `CharactersSurfacePanel` split: 演出指导 is gone, the companions are not. */
const AFTER_SECTION_RENAMED = panel({
  sections: ["同伴", "人格", "开场白"],
  companions: ["Mira", "青禾"],
});
/* The defect the assertion exists for: one companion is missing. */
const AFTER_COMPANION_MISSING = panel({
  sections: ["同伴", "人格", "开场白"],
  companions: ["Mira"],
});

test("a section that moved does not read as a changed companion list", () => {
  assert.deepEqual(companionNames(BEFORE), { present: true, names: ["Mira", "青禾"].sort(), unavailable: false });
  assert.deepEqual(companionNames(AFTER_SECTION_RENAMED), companionNames(BEFORE));
  assert.equal(sameCompanions(companionNames(BEFORE).names, companionNames(AFTER_SECTION_RENAMED).names), true);
  // The pre-change reading, on the same two panels, reports a change that did not happen.
  assert.notDeepEqual(sectionOrderReading(AFTER_SECTION_RENAMED), sectionOrderReading(BEFORE));
});

test("a companion that went missing is a changed list", () => {
  assert.equal(
    sameCompanions(companionNames(AFTER_SECTION_RENAMED).names, companionNames(AFTER_COMPANION_MISSING).names),
    false,
    "one companion fewer must fail the assertion",
  );
  // The pre-change reading, on the same sections with one companion gone, reports no change at all.
  assert.deepEqual(sectionOrderReading(AFTER_COMPANION_MISSING), sectionOrderReading(AFTER_SECTION_RENAMED));
});

test("an absent list is not two equal absences", () => {
  const absent = companionNames(panel({ companions: [], listPresent: false }));
  assert.deepEqual(absent, { present: false, names: null, unavailable: false });
  assert.equal(sameCompanions(null, null), false, "two readings that measured nothing cannot agree");
  assert.equal(sameCompanions(absent.names, absent.names), false);
});

test("a list of zero companions is a reading, and an unnamed entry is not", () => {
  const empty = companionNames(panel({ companions: [] }));
  assert.deepEqual(empty, { present: true, names: [], unavailable: false }, "zero companions is measured, not absent");
  assert.equal(sameCompanions([], []), true);
  const unnamed = companionNames(panel({ companions: [""] }));
  assert.equal(unnamed.names, null, "an entry whose name span is gone must not pass as a companion");
});
