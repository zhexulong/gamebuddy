/**
 * The primitive a population assertion uses to say WHICH member drifted, instead of how many there are.
 *
 * WHY (four instances in one night, 2026-11-05)
 *
 * Every one of these was a test that froze a count the product owns, and every one of them failed with
 * `Expected 15, got 13` - a sentence that names neither the two members that appeared nor the one that
 * left, so finding them cost an afternoon of bisecting a diff:
 *
 *   `expected 28 to equal 15`  a test froze "15 registered seams that all nine predicates reject"; the
 *                              authority said 28, and thirteen new seams had been added to a table the
 *                              test was counting rather than iterating.
 *   `13 -> 15`                 a frozen key table grew by two keys; the assertion compared lengths.
 *   `66 of 68`                 a legal growth became 67 of 69, and the failure quoted a numerator whose
 *                              denominator it could not name.
 *   `advance_day -> sleep`     an action was renamed; the assertion still spelled the old name and
 *                              reported a count mismatch on the set it was really looking for.
 *
 * A set difference is the same information as a count and strictly more than the count: `added` and
 * `missing` name the members, so the reader of the failure never has to reconstruct the population.
 *
 *   assert.deepEqual(new Set(actual), new Set(AUTHORITY))   // the assertion
 *   describeMemberDiff("registered seams", actual, AUTHORITY)   // its message
 *
 * The output is sorted by code unit - never `localeCompare`, whose order depends on the machine's ICU
 * data - so the same drift reads the same on every run, and a side with nothing to report prints
 * nothing rather than an empty `[]`.
 */

/** Members are compared as strings: a `Set` of numbers and a `Set` of strings are the same population. */
function memberSet(members) {
  return new Set([...members].map((member) => String(member)));
}

/** Code-unit order, so the reading is identical on every machine - never `localeCompare`'s ICU order. */
function byCodeUnit(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The two sides of a population comparison: what the run produced that the authority does not list, and
 * what the authority lists that the run did not produce. Duplicates collapse, because the question is
 * membership, not multiplicity.
 */
export function memberDiff(actual, expected) {
  const produced = memberSet(actual);
  const allowed = memberSet(expected);
  return {
    added: [...produced].filter((member) => !allowed.has(member)).sort(byCodeUnit),
    missing: [...allowed].filter((member) => !produced.has(member)).sort(byCodeUnit),
  };
}

/**
 * A failure message that names the drift: `label` on its own line when one is given, then only the sides
 * that carry members - and nothing at all when the two populations agree, so a caller can print it
 * unconditionally. `describeMemberDiff("", ["advance_day"], ["sleep"])` is
 * `"+ newly added: [advance_day]\n- missing: [sleep]"`.
 */
export function describeMemberDiff(label, actual, expected) {
  const { added, missing } = memberDiff(actual, expected);
  const sides = [];
  if (added.length > 0) sides.push(`+ newly added: [${added.join(", ")}]`);
  if (missing.length > 0) sides.push(`- missing: [${missing.join(", ")}]`);
  if (sides.length === 0) return "";
  return typeof label === "string" && label !== "" ? [label, ...sides].join("\n") : sides.join("\n");
}
