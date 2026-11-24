import assert from "node:assert/strict";
import test from "node:test";

import type { DestinationIndexRow } from "./protocol.js";
import { findDestination } from "./stardew-destination-search.js";

/**
 * `find_destination`, answered in the Host from the Mod's published names.
 *
 * Every case here came from `destinationsearchtests.cs`, `DestinationSearchPlaceQueryGateTests.cs` and the search half of
 * `DestinationSpellingAgreementTests.cs` - the C# tests the matcher had when it lived in the Mod - because the move is
 * only honest if the queries that matched still match and the queries that were refused are still refused. One C# case
 * could not move: resolving an opaque handle back to a destination is the Mod's reference store's job
 * (`NavigationReferenceStore`), and it is pinned on that side in `DestinationIndexPublicationTests.cs`.
 */

/** A `dr1_` handle for one destination identity, shaped like the Mod's (`IsWellFormedHandle`). */
function handleFor(identity: string): string {
  const alphabet = identity.replace(/[^A-Za-z0-9_-]/gu, "");
  return `dr1_${alphabet.padEnd(21, "A").slice(0, 21)}A`;
}

function destination(
  label: string,
  options: Readonly<{
    identity?: string;
    contextLabel?: string | null;
    fallbackLabel?: string | null;
    aliases?: readonly string[];
    relatedNpcs?: readonly string[];
    serviceTerms?: readonly string[];
  }> = {},
): DestinationIndexRow {
  return {
    label,
    contextLabel: options.contextLabel ?? null,
    fallbackLabel: options.fallbackLabel ?? null,
    aliases: options.aliases ?? [],
    relatedNpcs: options.relatedNpcs ?? [],
    serviceTerms: options.serviceTerms ?? [],
    ref: handleFor(options.identity ?? label),
  };
}

function published(destinations: readonly DestinationIndexRow[]) {
  return {
    status: "index" as const,
    reason: "destination_index_published" as const,
    generation: "a".repeat(64),
    destinations,
  };
}

test("one exact current-locale label resolves to itself", () => {
  const result = findDestination(published([destination("Mine")]), " mine ");

  assert.equal(result.status, "resolved");
  assert.equal(result.reason, "exact_current_locale");
  assert.deepEqual(result.destination, { kind: "label", label: "Mine", ref: null });
  assert.equal(result.unlockState, "unknown");
});

test("fuzzy recall returns at most three candidates and no score", () => {
  const result = findDestination(
    published([
      destination("Mine"),
      destination("Mines"),
      destination("Minecart"),
      destination("Mining Guild", { identity: "Guild" }),
    ]),
    "min",
  );

  assert.equal(result.status, "candidates");
  assert.equal(result.reason, "fuzzy_match");
  assert.ok(result.candidates !== null);
  assert.ok(result.candidates.length >= 1 && result.candidates.length <= 3);
  for (const candidate of result.candidates) {
    assert.equal(candidate.unlockState, "unknown");
    assert.equal(candidate.destination.kind, "ref");
    assert.equal("score" in candidate, false);
  }
});

test("a fallback-locale label resolves only when it is unique", () => {
  const result = findDestination(
    published([destination("The Mines", { identity: "Mine", fallbackLabel: "Mine" })]),
    "mine",
  );

  assert.equal(result.status, "resolved");
  assert.equal(result.reason, "exact_fallback_locale");
  assert.deepEqual(result.destination, { kind: "label", label: "The Mines", ref: null });
});

test("an ambiguous exact label offers opaque candidates instead of one arbitrary winner", () => {
  const result = findDestination(
    published([destination("Mine", { identity: "Mine_A" }), destination("Mine", { identity: "Mine_B" })]),
    "mine",
  );

  assert.equal(result.status, "candidates");
  assert.equal(result.reason, "ambiguous_exact");
  assert.equal(result.candidates?.length, 2);
  for (const candidate of result.candidates ?? []) {
    assert.equal(candidate.destination.kind, "ref");
    assert.equal(candidate.destination.label, null);
  }
});

test("four exact matches return the first three in publication order", () => {
  // `DerivedDestinationSet` publishes by (label, identity), so this is also the order the Mod ranked them in.
  const result = findDestination(
    published([
      destination("Alpha", { aliases: ["mine"] }),
      destination("Bravo", { aliases: ["mine"] }),
      destination("Charlie", { aliases: ["mine"] }),
      destination("Zulu", { aliases: ["mine"] }),
    ]),
    "mine",
  );

  assert.equal(result.status, "candidates");
  assert.equal(result.reason, "ambiguous_exact");
  assert.deepEqual(
    result.candidates?.map((candidate) => candidate.label),
    ["Alpha", "Bravo", "Charlie"],
  );
  for (const candidate of result.candidates ?? []) assert.equal(candidate.destination.kind, "ref");
});

test("a query that is not a place name is refused by name", () => {
  for (const query of ["", "   ", "1,2", "path/to/mine", "a:b", "back\\slash"]) {
    const result = findDestination(published([destination("Mine")]), query);
    assert.equal(result.status, "invalid", `"${query}" is not a destination name`);
    assert.equal(result.reason, "destination_search_invalid");
  }
});

test("a resident's name recalls the home it lives in", () => {
  const result = findDestination(
    published([
      destination("ScienceHouse", { relatedNpcs: ["Robin", "罗宾"], serviceTerms: ["CarpenterShop"] }),
      destination("Mine"),
    ]),
    "罗宾",
  );

  assert.equal(result.status, "candidates");
  assert.equal(result.reason, "fuzzy_match");
  assert.equal(result.candidates?.length, 1);
  assert.equal(result.candidates?.[0]?.label, "ScienceHouse");
  assert.equal(result.candidates?.[0]?.destination.kind, "ref");
});

test("a shop's stock name recalls the shop from a purchase intent", () => {
  const result = findDestination(
    published([
      destination("SeedShop", { relatedNpcs: ["Pierre", "皮埃尔"], serviceTerms: ["SeedShop", "防风草种子", "土豆种子"] }),
      destination("Mine"),
    ]),
    "种子",
  );

  assert.equal(result.status, "candidates");
  assert.equal(result.candidates?.length, 1);
  assert.equal(result.candidates?.[0]?.label, "SeedShop");
});

test("a two-character CJK word ranks the place that holds it whole", () => {
  const result = findDestination(
    published([destination("Mine", { relatedNpcs: ["矿井"] }), destination("Beach", { relatedNpcs: ["海滩"] })]),
    "矿井",
  );

  assert.equal(result.status, "candidates");
  assert.equal(result.candidates?.[0]?.label, "Mine");
});

test("a latin prefix recalls a partially named place", () => {
  const result = findDestination(published([destination("Mine"), destination("Forest")]), "min");

  assert.equal(result.status, "candidates");
  assert.equal(result.candidates?.[0]?.label, "Mine");
});

test("ranking is deterministic, and a candidate's handle is the publication's", () => {
  const directory = published([
    destination("ScienceHouse", { relatedNpcs: ["Robin", "罗宾"], serviceTerms: ["CarpenterShop"] }),
    destination("SeedShop", { relatedNpcs: ["Pierre", "皮埃尔"], serviceTerms: ["SeedShop", "防风草种子"] }),
    destination("Saloon", { relatedNpcs: ["Gus", "格斯"], serviceTerms: ["Stardrop Saloon", "啤酒"] }),
  ]);

  const first = findDestination(directory, "罗宾");
  const second = findDestination(directory, "罗宾");

  assert.equal(first.candidates?.[0]?.label, second.candidates?.[0]?.label);
  // The handle is minted once per generation by the Mod, so two answers over one publication name the same handle. It used
  // to be minted per query; both are opaque, both are bound to the same scope and generation, and neither is guessable, so
  // what a caller holds is the same fact with a longer life.
  assert.equal(first.candidates?.[0]?.destination.ref, second.candidates?.[0]?.destination.ref);
  assert.match(first.candidates?.[0]?.destination.ref ?? "", /^dr1_[A-Za-z0-9_-]{21}[AQgw]$/u);
});

test("a term no destination holds is not found", () => {
  const result = findDestination(
    published([destination("ScienceHouse", { relatedNpcs: ["Robin"] }), destination("Mine")]),
    "zzzz_no_such_term",
  );

  assert.equal(result.status, "not_found");
  assert.equal(result.reason, "destination_not_found");
});

test("a word no destination holds is refused rather than answered with a shared character", () => {
  // round77: "矿洞" answered 乔迪，肯特和山姆的家 and nothing else. The directory names the
  // mine 矿井, so 矿洞 is a word nothing holds; 洞 survives only inside the cave carrot its
  // residents sell (山洞萝卜). A shared character orders candidates; it cannot be the answer.
  const result = findDestination(
    published([
      destination("矿井", { identity: "Mine" }),
      destination("乔迪，肯特和山姆的家", { identity: "SamHouse", serviceTerms: ["山洞萝卜"] }),
    ]),
    "矿洞",
  );

  assert.equal(result.status, "not_found");
  assert.equal(result.reason, "destination_not_found");
});

test("a destination recalled by the whole word is still a candidate", () => {
  const result = findDestination(
    published([
      destination("矿井", { identity: "Mine" }),
      destination("乔迪，肯特和山姆的家", { identity: "SamHouse", serviceTerms: ["山洞萝卜"] }),
    ]),
    "山洞",
  );

  assert.equal(result.status, "candidates");
  assert.equal(result.candidates?.length, 1);
  assert.equal(result.candidates?.[0]?.label, "乔迪，肯特和山姆的家");
});

test("a single character query is still answered by a shared character", () => {
  // The word floor only applies to a query that is asked in words: one CJK character has
  // no word to be matched on, and is answered by that character.
  const result = findDestination(
    published([
      destination("煤矿森林", { identity: "Forest" }),
      destination("乔迪，肯特和山姆的家", { identity: "SamHouse", serviceTerms: ["山洞萝卜"] }),
    ]),
    "矿",
  );

  assert.equal(result.status, "candidates");
  assert.equal(result.candidates?.length, 1);
  assert.equal(result.candidates?.[0]?.label, "煤矿森林");
});

test("the farm's water landmark answers to its own names and keeps the farm's identity", () => {
  // The landmark declares the farm's identity on purpose so the route planner's arrival semantics keep working, and it
  // carries its own label and its own spellings. A directory deduplicated on identity alone silently dropped it, leaving
  // `find_destination("Pond") -> destination_not_found` and the whole `water_crop / watering_can_empty -> find water ->
  // refill` recovery chain without a discovery channel. Two rows, one handle, three answers.
  const directory = published([
    destination("Farm", { identity: "Farm" }),
    destination("Pond", { identity: "Farm", aliases: ["Pond", "Well", "水源"] }),
  ]);

  const label = findDestination(directory, "Pond");
  assert.equal(label.status, "resolved");
  assert.equal(label.reason, "exact_current_locale");
  assert.deepEqual(label.destination, { kind: "label", label: "Pond", ref: null });

  const alias = findDestination(directory, "水源");
  assert.equal(alias.status, "resolved");
  assert.equal(alias.reason, "exact_alias");
  // An alias is offered as the opaque handle, and that handle is the farm's: arrival stays the farm's rule.
  assert.deepEqual(alias.destination, { kind: "ref", label: null, ref: handleFor("Farm") });

  const farm = findDestination(directory, "Farm");
  assert.equal(farm.status, "resolved");
  assert.deepEqual(farm.destination, { kind: "label", label: "Farm", ref: null });
});

/**
 * The real directory the measured defects ran through, with the names, residents and stock terms their own rows give
 * them: `Data/Locations` keys, and the display names as the game's `StringsFromCSFiles` table resolves them in Chinese,
 * with the English row beside.
 */const REAL_DIRECTORY: readonly DestinationIndexRow[] = [
  destination("矿井", { identity: "Mine", fallbackLabel: "Mines", aliases: ["Mines"] }),
  destination("煤矿森林", {
    identity: "Forest",
    fallbackLabel: "Cindersap Forest",
    aliases: ["Cindersap Forest"],
  }),
  destination("山", { identity: "Mountain", fallbackLabel: "Mountain", aliases: ["Mountain"] }),
  destination("乔迪，肯特和山姆的家", {
    identity: "SamHouse",
    fallbackLabel: "Home of Jodi, Kent & Sam",
    aliases: ["Home of Jodi, Kent & Sam"],
    relatedNpcs: ["Jodi", "Kent", "Sam", "Vincent", "乔迪", "肯特", "山姆", "文森特"],
    serviceTerms: [
      "DesertFestival_Jodi",
      "DesertFestival_Kent",
      "DesertFestival_Sam",
      "DesertFestival_Vincent",
      "枫糖棒",
      "Joja 可乐",
      "香酥鲈鱼",
      "混合种子",
      "蕨菜",
      "榛子",
      "纤维",
      "虫肉",
      "树液",
      "山洞萝卜",
      "手部骨骼",
      "粘土",
      "有缺口的土罐",
      "混合花卉种子",
    ],
  }),
  destination("木匠的商店", {
    identity: "ScienceHouse",
    fallbackLabel: "Carpenter's Shop",
    aliases: ["Carpenter's Shop"],
    relatedNpcs: ["Robin", "Demetrius", "Sebastian", "Maru", "罗宾", "德米特里厄斯", "塞巴斯蒂安", "玛鲁"],
    serviceTerms: ["Carpenter", "木材", "石头", "农场建筑"],
  }),
  destination("皮埃尔的杂货店", {
    identity: "SeedShop",
    fallbackLabel: "Pierre's General Store",
    aliases: ["Pierre's General Store"],
    relatedNpcs: ["Pierre", "Caroline", "Abigail", "皮埃尔", "卡洛琳", "阿比盖尔"],
    serviceTerms: ["SeedShop", "种子", "肥料"],
  }),
];

/**
 * `a_query_for_a_place_finds_that_place_or_says_it_does_not:<query>` - one directory, one answer per name it holds, and
 * "no such place" for a word it holds none of.
 *
 * <p>
 * The POPULATION is every destination the directory holds, crossed with every name it DECLARES for it - its localized
 * display name, its fallback-locale name and each alias - plus the pair measured in `round77`, because a place she can
 * name is found or refused and a word no place declares is the case this gate exists for. All of it comes from the
 * directory fixture, never from a list of places kept here, so a location added tomorrow is in this gate without anybody
 * remembering it. The property is that the answer names the place asked for or says there is no such place; a candidate
 * list of OTHER places fails with the place, the query and what it returned.
 * </p>
 */
test("a query for a place finds that place or says it does not", () => {
  const directory = published(REAL_DIRECTORY);
  const examined: string[] = [];
  const misled: string[] = [];

  const declaredSpellings = (row: DestinationIndexRow): readonly string[] =>
    [...new Set([row.label, row.fallbackLabel, ...row.aliases].filter((name): name is string => name !== null))].sort(
      (left, right) => (left < right ? -1 : left > right ? 1 : 0),
    );

  for (const row of REAL_DIRECTORY)
    for (const spelling of declaredSpellings(row)) {
      examined.push(spelling);
      if (!answersPlace(findDestination(directory, spelling), row))
        misled.push(`${row.label} asked as "${spelling}" -> ${describe(findDestination(directory, spelling))}`);
    }

  for (const [query, identity] of [
    ["矿洞", "Mine"],
    ["矿洞入口 Mine entrance", "Mine"],
  ] as const) {
    examined.push(query);
    const row = REAL_DIRECTORY.find((candidate) => candidate.ref === handleFor(identity));
    assert.ok(row !== undefined, `the fixture holds ${identity}`);
    const result = findDestination(directory, query);
    if (!answersPlace(result, row)) misled.push(`${row.label} asked as "${query}" -> ${describe(result)}`);
  }

  console.log(
    `places examined ${REAL_DIRECTORY.length} · queries examined ${examined.length} · misled ${misled.length}`,
  );
  assert.ok(REAL_DIRECTORY.length > 0, "a gate whose population is empty agrees with itself");
  assert.ok(examined.length > 0, "every place declares at least its own label");
  assert.deepEqual(misled, [], "a query for a place names that place, or is told there is no such place");
});

function answersPlace(result: ReturnType<typeof findDestination>, row: DestinationIndexRow): boolean {
  if (result.status === "not_found") return true;
  if (result.status === "resolved")
    return result.destination.label !== null
      ? result.destination.label === row.label
      : result.destination.ref === row.ref;
  if (result.status !== "candidates") return false;
  return (result.candidates ?? []).some((candidate) => candidate.label === row.label);
}

function describe(result: ReturnType<typeof findDestination>): string {
  const named =
    result.status === "resolved"
      ? (result.destination.label ?? result.destination.ref ?? "nothing")
      : result.status === "candidates"
        ? (result.candidates ?? []).map((candidate) => candidate.label).join(", ")
        : "";
  return named.length === 0 ? `${result.status}/${result.reason}` : `${result.status}/${result.reason}: ${named}`;
}

/**
 * The four shapes the game's own data produces: a room with a localized name and an English one (the farmhouse), two
 * shops named the way the world map names them, and a location with no display name at all - whose only spelling is its
 * identity.
 *
 * <p>
 * THIS IS THE SEARCH HALF of `a_spelling_the_directory_declares_resolves_on_every_surface` (`plan_339`). The other half -
 * that `navigate_to_destination`'s label selector binds the same place - stays in `DestinationSpellingAgreementTests.cs`,
 * because that matcher is the Mod's own admission and exists nowhere else. Splitting one property across the two sides
 * that now hold the two readers is the cost of the move; the property has not been narrowed, and each half still runs over
 * every spelling the table declares rather than a list somebody typed.
 * </p>
 */
test("every declared spelling is answered by the place that declares it", () => {
  const farmHouse = destination("农舍", {
    identity: "FarmHouse",
    fallbackLabel: "Farmhouse",
    aliases: ["Farmhouse", "FarmHouse"],
  });
  const seedShop = destination("皮埃尔的杂货店", {
    identity: "SeedShop",
    fallbackLabel: "Pierre's General Store",
    aliases: ["Pierre's General Store", "SeedShop"],
  });
  const scienceHouse = destination("木匠的商店", {
    identity: "ScienceHouse",
    fallbackLabel: "Carpenter's Shop",
    aliases: ["Carpenter's Shop", "ScienceHouse"],
  });
  const backwoods = destination("Backwoods", { identity: "Backwoods", aliases: ["Backwoods"] });
  const directory = published([farmHouse, seedShop, scienceHouse, backwoods]);

  const spellings = [...directory.destinations]
    .flatMap((row) => [row.label, row.fallbackLabel, ...row.aliases].filter((name): name is string => name !== null))
    .filter((name) => name.trim().length > 0)
    .flatMap((name) => [name, name.toUpperCase(), name.toLowerCase()])
    .filter((name, at, all) => all.indexOf(name) === at)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const refusals: string[] = [];
  for (const spelling of spellings) {
    const result = findDestination(directory, spelling);
    if (result.status !== "resolved") {
      refusals.push(`${spelling}: ${describe(result)}`);
      continue;
    }
    const row = directory.destinations.find((candidate) =>
      result.destination.label !== null
        ? candidate.label === result.destination.label
        : candidate.ref === result.destination.ref,
    );
    const declares =
      row !== undefined &&
      [row.label, row.fallbackLabel, ...row.aliases].some((name) => name !== null && name.toLowerCase() === spelling.toLowerCase());
    if (!declares) refusals.push(`${spelling}: resolved to ${row?.label ?? "nothing"}, which does not declare it`);
  }

  console.log(`spellings examined ${spellings.length} · refusals ${refusals.length}`);
  assert.ok(spellings.length > 0, "a gate whose population is empty agrees with itself");
  assert.deepEqual(refusals, [], "the directory's own spellings must be answerable");
});

test("a spelling nothing declares is refused", () => {
  const result = findDestination(published(REAL_DIRECTORY), "Town Hall");

  assert.equal(result.status, "not_found");
  assert.equal(result.reason, "destination_not_found");
});
