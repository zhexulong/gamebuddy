/*
 * The companions a Characters panel shows, by NAME - the fact driver J means when it says the durable
 * companion list is unchanged after a cancelled card import.
 *
 * The reading it replaces took the panel's direct children and kept the first line of each child's
 * text (`[...panel.children].map((card) => card.innerText.split("\n")[0])`), which is the panel's
 * SECTION ORDER. `CharactersSurfacePanel` later split the panel and dropped 演出指导, so the same
 * untouched companion list started reading as a different array - the assertion compared two
 * different things and stayed green - while a companion that really went missing could hide behind
 * whichever section heading that slot happened to hold.
 *
 * The list is the durable companion projection's own markup (`CharactersPanel.tsx`):
 * `ul[data-companion-list] > li[data-companion-entry] > span[data-companion-entry-name]`. Sorted, so
 * the reading does not depend on the order the Host projects them in either.
 */
function companionNames(document) {
	const list = document.querySelector("[data-companion-list]");
	if (list === null)
		return {
			present: false,
			names: null,
			unavailable: document.querySelector("[data-companion-list-unavailable]") !== null,
		};
	const names = [...list.querySelectorAll("li[data-companion-entry]")].map((entry) =>
		(entry.querySelector("[data-companion-entry-name]")?.textContent ?? "").trim(),
	);
	/* An entry whose name span is gone is still an entry: an empty name would pass as a companion. */
	if (names.some((name) => name.length === 0)) return { present: true, names: null, unavailable: false };
	return { present: true, names: [...names].sort(), unavailable: false };
}

/** The same named companions, whatever order they arrived in, and never on two absent readings. */
function sameCompanions(before, after) {
	if (before === null || after === null) return false;
	return before.length === after.length && before.every((name, index) => name === after[index]);
}

module.exports = { companionNames, sameCompanions };
