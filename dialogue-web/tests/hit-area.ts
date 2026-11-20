/**
 * A control's HIT AREA, measured the way a finger meets it - not the way its plate is drawn.
 *
 * THE DEFECT FAMILY. `--touch-target-min` is a floor on the area a player can press. Every guard in
 * this package enforced it on the element's border box (`getBoundingClientRect().height >= 44`), which
 * was the same reading only while the plate and the target were one box. The moment the product paints
 * a pill (`.message-actions`' 28 px strip, `style.css`) the two separate, and a box reading either
 * fails a control that is still perfectly pressable or - the expensive direction - passes one that is
 * not. The expensive direction is the reason this file exists: a guard that reads the plate cannot
 * tell a 44 px target from a 28 px one that has a 44 px `::before`, and it equally cannot tell a 28 px
 * target with no `::before` at all from a control that never shrank.
 *
 * WHAT IS MEASURED, from the browser's own hit testing (`document.elementFromPoint`):
 *
 *   1. the painted plate, from the element's own box;
 *   2. four probes 4 px OUTSIDE the plate, one per side - each must answer this control. That is the
 *      clause that fails on a plate which shrank without a hit box growing behind it;
 *   3. two probes just INSIDE the `--touch-target-min` boundary the control keeps, and two just
 *      OUTSIDE it - inside must answer the control, outside must answer something else. That pair is
 *      what pins the hit box to the floor instead of merely to "bigger than the plate": a `::before`
 *      that reached 8 px instead of the floor would fail it, and so would one that reached 20.
 *   4. the horizontal neighbours are not swallowed: `inset` grows the box in the block direction
 *      only, so a point 4 px left/right of the plate must NOT answer this control.
 *
 * A probe that answers `null` (a point outside the viewport) is recorded as a miss rather than
 * silently skipped: the caller scrolls the control into view first, so a null is a reading, not a gap.
 */
import type { Locator } from "./frontend-coverage";

/** The floor every control guard below holds: the token the sheet declares for it. */
export const HIT_AREA_MINIMUM = 44;

/** How far outside the painted plate each edge is probed, in CSS pixels. */
const EDGE_PROBE = 4;

/** One `elementFromPoint` reading, kept so a failure can say exactly where it looked. */
export type HitProbe = Readonly<{
  /** What the probe is for, in the words its failure message uses. */
  where: string;
  x: number;
  y: number;
  /** True when the topmost element at that point is the control or inside it. */
  onControl: boolean;
  /** What was actually there, so "something else" is a reading rather than an assumption. */
  topmost: string;
}>;

export type HitReading = Readonly<{
  /** The painted plate, as the browser laid it out. */
  painted: Readonly<{ width: number; height: number }>;
  /** Each of the idents that must answer the control. */
  covered: readonly HitProbe[];
  /** Each of the idents that must NOT answer it. */
  uncovered: readonly HitProbe[];
  /** The block-direction hit height the probes establish, or `null` when an edge probe missed. */
  hitHeight: number | null;
}>;

/**
 * Measure one control's hit area.
 *
 * The control is scrolled into view first, because `elementFromPoint` answers about the viewport: a
 * probe above the fold would report "nothing" for a target that is perfectly present.
 */
export async function readHitArea(target: Locator, minimum = HIT_AREA_MINIMUM): Promise<HitReading> {
  await target.scrollIntoViewIfNeeded();
  return await target.evaluate(
    (node, { edge, floor }) => {
      const rect = node.getBoundingClientRect();
      const centreX = rect.left + rect.width / 2;
      const covers = (x: number, y: number): boolean => {
        const found = document.elementFromPoint(x, y);
        return found !== null && (found === node || node.contains(found));
      };
      const probe = (where: string, x: number, y: number): { where: string; x: number; y: number; onControl: boolean; topmost: string } => {
        const found = document.elementFromPoint(x, y);
        return {
          where,
          x: Math.round(x),
          y: Math.round(y),
          onControl: found !== null && (found === node || node.contains(found)),
          topmost:
            found === null
              ? "nothing (outside the viewport)"
              : `<${found.tagName.toLowerCase()}${
                  typeof found.className === "string" && found.className.trim().length > 0
                    ? `.${found.className.trim().split(/\s+/u).join(".")}`
                    : ""
                }>${found.getAttribute("data-testid") === null ? "" : ` [data-testid="${found.getAttribute("data-testid")}"]`}`,
        };
      };
      // Where the floor's edge sits, when the plate is shorter than the floor: centred, as the
      // sheet's `::before` centres it.
      const overshoot = Math.max(0, (floor - rect.height) / 2);
      const top = rect.top - overshoot;
      const bottom = rect.bottom + overshoot;
      // The plate is short of the floor, so the box behind it has to reach: that is where the extra
      // probes belong. A plate that already clears the floor (the strip's pager, a 46 px group of
      // three targets) has no overshoot and no box behind it - probing outside it would demand a hit
      // area LARGER than the floor it keeps, which is a different (and wrong) invariant.
      const shortOfTheFloor = rect.height < floor;
      const covered = [
        probe("the painted plate's own centre", centreX, rect.top + rect.height / 2),
        probe("1 px inside the touch floor's top edge", centreX, top + 1),
        probe("1 px inside the touch floor's bottom edge", centreX, bottom - 1),
        ...(shortOfTheFloor
          ? [
              probe("4 px above the painted plate", centreX, rect.top - edge),
              probe("4 px below the painted plate", centreX, rect.bottom + edge),
            ]
          : []),
      ];
      const uncovered = [
        probe("4 px beyond the touch floor's top edge", centreX, top - edge),
        probe("4 px beyond the touch floor's bottom edge", centreX, bottom + edge),
        probe("4 px left of the painted plate", rect.left - edge, rect.top + rect.height / 2),
        probe("4 px right of the painted plate", rect.right + edge, rect.top + rect.height / 2),
      ];
      const floorTop = covered.find((entry) => entry.where.startsWith("1 px inside the touch floor's top"));
      const floorBottom = covered.find((entry) => entry.where.startsWith("1 px inside the touch floor's bottom"));
      const beyondTop = uncovered.find((entry) => entry.where.includes("beyond the touch floor's top"));
      const beyondBottom = uncovered.find((entry) => entry.where.includes("beyond the touch floor's bottom"));
      const reachedFloor =
        floorTop?.onControl === true &&
        floorBottom?.onControl === true &&
        beyondTop?.onControl === false &&
        beyondBottom?.onControl === false;
      return {
        painted: { width: Math.round(rect.width), height: Math.round(rect.height) },
        covered,
        uncovered,
        hitHeight: reachedFloor ? Math.max(floor, rect.height) : null,
      };
    },
    { edge: EDGE_PROBE, floor: minimum },
  );
}

/** One control, weighed: the glyphs its own tag renders, and the probes that failed. */
export function hitAreaViolations(what: string, reading: HitReading, minimum = HIT_AREA_MINIMUM): readonly string[] {
  const failures: string[] = [];
  for (const miss of reading.covered)
    if (!miss.onControl)
      failures.push(
        `${what}: ${miss.where} at (${miss.x}, ${miss.y}) does not answer the control - it answers ${miss.topmost}. ` +
          "The painted plate may shrink; the area a finger meets may not - grow the hit box behind it " +
          "(`::before` reaching `--touch-target-min`)",
      );
  for (const hit of reading.uncovered)
    if (hit.onControl)
      failures.push(
        `${what}: ${hit.where} at (${hit.x}, ${hit.y}) still answers the control - the hit box grew past ` +
          `--touch-target-min (${minimum} px) or sideways into its neighbours`,
      );
  if (reading.hitHeight === null)
    failures.push(`${what}: the hit area does not reach --touch-target-min (${minimum} px): neither its painted ` +
      `plate (${reading.painted.height} px) nor the box behind it answers ${EDGE_PROBE} px outside either edge`);
  else if (reading.hitHeight < minimum)
    failures.push(
      `${what}: the hit area is ${reading.hitHeight} px tall on a ${reading.painted.height} px plate, under the ` +
        `${minimum} px floor`,
    );
  return failures;
}

/** A reading as one line a run can print, so a passing journey still states what it measured. */
export function describeHitArea(reading: HitReading): string {
  return `plate=${reading.painted.width}x${reading.painted.height} hit=${reading.hitHeight ?? "none"} ` +
    `covered=[${reading.covered.map((entry) => `${entry.where}:${entry.onControl}`).join(", ")}]`;
}
