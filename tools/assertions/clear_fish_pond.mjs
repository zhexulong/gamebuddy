/**
 * `clear_fish_pond`'s one clause the contract format cannot state, kept as the test it was.
 *
 * WHY THIS IS CODE. `contracts/smoke/clear_fish_pond.json` says the pond left discovery, that the receipt's counts
 * match the pond, and that the stale id is refused by name. It could not say the fourth thing the runner observed -
 * that the fish were EJECTED rather than destroyed - because that clause orders one number against another: the
 * count of ground debris carrying the pond's fish type must be at least the pond's occupants. A `worldAfter` form
 * asserts a size or a target's absence, never "at least as many as the pond held". The runner that made the count
 * was deleted on 2026-11-14 while this file's clause was still declared `unasserted`, which left the claim with no
 * test at all; the clause lives here now, and the contract names this hook so a live slice runs it.
 *
 * WHAT A HOOK IS. This file is loaded by `tools/run-native-action-slice.mjs` at the end of a LIVE run, so it is not
 * a program: it imports nothing, is not async, takes exactly one parameter and returns the list of failures (empty
 * when satisfied). `tools/check-assertion-hooks.mjs` is the gate that says so, over every file in this directory.
 *
 * `asserts` names the clause this hook answers in the coverage gate's own spelling (`<evidence|worldAfter>.<field>`),
 * so the gate counts the clause as COVERED by a hook instead of as declared unasserted, and keeps counting it that
 * way while a runner still exists to be compared against.
 *
 * THE PREDICATE IS THE RUNNER'S, NOT A PARAPHRASE. The Mod publishes the pond's `fishType` unqualified (`"128"`)
 * while `itemTargets` carries qualified ids (`"(O)128"`), so an exact comparison matches nothing and a substring test
 * would let `1280` pass for `128`; both exact forms are accepted and only those two. The count is over the actor's
 * whole location rather than over the pond's own tile, because that is what the runner measured: `itemTargets` is the
 * protocol's "nearby native item drops available through `Debris.collect`", the Mod ejects a pond's fish onto the
 * ground around it, and a tile filter would be a narrower claim nobody has measured. The live reading this hook was
 * written against is `fish_type_before=128 · occupants_before=1 · fish_ejected=1 · occupants_after=0`, with the
 * clause reported as `assertion.worldAfter.itemTargets: true`.
 */
export const asserts = ["worldAfter.itemTargets"];

/**
 * The failures this clause found in one run, named by the clause they belong to.
 *
 * `before` is the observation the request was built from (the pond, its occupants and its fish type as discovery
 * published them), `after` the fresh observation read once the receipt terminal arrived, and `evidence` the parsed
 * `key=value` receipt detail - the `pond_id` in it says which pond this run cleared.
 *
 * "I could not look" and "the fish were not ejected" never read the same: a surface with no `itemTargets`, a receipt
 * naming no pond, or one that names a pond before the clear does not publish each produce a FAILURE, never an empty
 * list.
 */
export function clearFishPond({ before, after, evidence }) {
  const pondId = receiptField(evidence, "pond_id");
  const pond = ponds(before).find((row) => row?.targetId === pondId);
  if (pond === undefined)
    return [
      `worldAfter.itemTargets: the observation before the clear publishes no pond with pond_id=${describe(pondId)}, so the debris count has nothing to be about`,
    ];
  const occupants = pond.occupants;
  if (!Number.isInteger(occupants) || occupants < 1)
    return [
      `worldAfter.itemTargets: pond ${String(pondId)} publishes occupants=${describe(occupants)}, which is not the number of fish that had to come out`,
    ];
  const ground = after?.itemTargets;
  if (!Array.isArray(ground))
    return [
      `worldAfter.itemTargets: the observation after the clear publishes no itemTargets array, so the ${occupants} ejected fish could not be looked for`,
    ];
  const ejected = ground.filter((entry) => isPondFish(entry?.qualifiedItemId, pond.fishType)).length;
  if (ejected >= occupants) return [];
  return [
    `worldAfter.itemTargets: ground debris of the pond's fish type (${describe(pond.fishType)}) = ${ejected}, occupants before = ${occupants}`,
  ];
}

function ponds(snapshot) {
  const rows = snapshot?.fishPondTargets;
  return Array.isArray(rows) ? rows : [];
}

/** A receipt key, from the parsed bag the engine passes or from a plain object a test passes. */
function receiptField(evidence, key) {
  if (typeof evidence?.get === "function") return evidence.get(key);
  return evidence?.[key];
}

/** Whether a published ground item is the pond's fish, in either id form the two surfaces use. */
function isPondFish(qualifiedItemId, fishType) {
  if (typeof qualifiedItemId !== "string" || typeof fishType !== "string") return false;
  return qualifiedItemId === fishType || qualifiedItemId === `(O)${fishType}`;
}

function describe(value) {
  return value === undefined || value === null ? "none" : String(value);
}
