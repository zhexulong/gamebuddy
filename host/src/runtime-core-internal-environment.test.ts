import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  formatGameClock,
  formatGameDate,
  formatGameEnvironmentFacts,
  formatGameStamina,
  formatGameWeather,
  type GameEnvironmentFactsSource,
  MAX_GAME_ENVIRONMENT_FACTS_BYTES,
  reloadMagicContextInRuntimeRoot,
} from "./runtime-core.internal.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";

/**
 * The Magic Context bootstrap owns the runtime's SQLite root, and the extension
 * gives MAGIC_CONTEXT_STORAGE_DIR precedence over the XDG-derived path. So an
 * inherited value - an operator's or a sibling dev agent's - decides the store
 * this runtime opens. Measured on a live composed turn, inheriting one whose
 * migration lane is ahead of this build's schema fence leaves the extension
 * fail-closed, and its guarded context hook then aborts the provider request
 * (`AbortError: This operation was aborted`), terminalizing the turn `failed`
 * with `runtime_unavailable`. The bootstrap must therefore pin the runtime's own
 * root for the whole window it already pins cwd/XDG for.
 */
test("the Magic Context bootstrap pins the runtime's own store over an inherited override", async () => {
  const foreign = join("D:\\foreign", "cortexkit", "magic-context");
  const previous = {
    cwd: process.cwd(),
    data: process.env.XDG_DATA_HOME,
    config: process.env.XDG_CONFIG_HOME,
    storage: process.env.MAGIC_CONTEXT_STORAGE_DIR,
  };
  const runtimeCwd = mkdtempSync(join(tmpdir(), "gb-magic-context-root-"));
  let observed:
    | Readonly<{ cwd: string; data: string | undefined; config: string | undefined; storage: string | undefined }>
    | undefined;
  const loader = {
    reload: async (): Promise<void> => {
      observed = Object.freeze({
        cwd: process.cwd(),
        data: process.env.XDG_DATA_HOME,
        config: process.env.XDG_CONFIG_HOME,
        storage: process.env.MAGIC_CONTEXT_STORAGE_DIR,
      });
    },
  };
  try {
    process.env.MAGIC_CONTEXT_STORAGE_DIR = foreign;
    await reloadMagicContextInRuntimeRoot(loader as unknown as DefaultResourceLoader, runtimeCwd);
    assert.equal(observed?.storage, join(runtimeCwd, "data", "cortexkit", "magic-context"));
    assert.notEqual(observed?.storage, foreign);
    assert.equal(observed?.data, join(runtimeCwd, "data"));
    assert.equal(observed?.config, join(runtimeCwd, "config"));
    assert.equal(observed?.cwd, runtimeCwd);
    // The surrounding process's own value is restored, never consumed.
    assert.equal(process.env.MAGIC_CONTEXT_STORAGE_DIR, foreign);
    assert.equal(process.cwd(), previous.cwd);
  } finally {
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous.data;
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    if (previous.storage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = previous.storage;
    process.chdir(previous.cwd);
    rmSync(runtimeCwd, { recursive: true, force: true });
  }
});

/**
 * The other half of that pin: a runtime that had no inherited override must not
 * leave one behind, otherwise the next runtime in this process - and any child
 * it spawns - would inherit this runtime's store as its own override.
 */
test("the Magic Context bootstrap leaves no storage override behind when none was inherited", async () => {
  const previousStorage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
  const previousCwd = process.cwd();
  const runtimeCwd = mkdtempSync(join(tmpdir(), "gb-magic-context-root-"));
  const loader = { reload: async (): Promise<void> => undefined };
  try {
    delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    await reloadMagicContextInRuntimeRoot(loader as unknown as DefaultResourceLoader, runtimeCwd);
    assert.equal(process.env.MAGIC_CONTEXT_STORAGE_DIR, undefined);
  } finally {
    if (previousStorage !== undefined) process.env.MAGIC_CONTEXT_STORAGE_DIR = previousStorage;
    process.chdir(previousCwd);
    rmSync(runtimeCwd, { recursive: true, force: true });
  }
});

test("formatGameClock renders Native 24h clock as 12h with period", () => {
  assert.equal(formatGameClock(600, false), "6:00 AM");
  assert.equal(formatGameClock(1200, false), "12:00 PM");
  assert.equal(formatGameClock(1700, false), "5:00 PM");
  assert.equal(formatGameClock(0, false), "12:00 AM");
  assert.equal(formatGameClock(1930, false), "7:30 PM");
  assert.equal(formatGameClock(2600, false), "2:00 AM");
});

test("formatGameClock localizes the clock as a 24h reading plus the game day's time-of-day band", () => {
  assert.equal(formatGameClock(600, true), "06:00（清晨）");
  assert.equal(formatGameClock(900, true), "09:00（上午）");
  assert.equal(formatGameClock(1200, true), "12:00（中午）");
  assert.equal(formatGameClock(1500, true), "15:00（下午）");
  assert.equal(formatGameClock(1800, true), "18:00（傍晚）");
  assert.equal(formatGameClock(2200, true), "22:00（深夜）");
  // The game's own late-night wrap (24:00/25:00/26:00 = 12/1/2 AM) is the same
  // deep night as 20:00-23:59, so the band wraps with the clock.
  assert.equal(formatGameClock(2400, true), "00:00（深夜）");
  assert.equal(formatGameClock(2600, true), "02:00（深夜）");
});

test("the localized clock fact can actually fire the evening world-book entry, and the English one cannot", () => {
  // "a key the book matches" is read from the owner's own compiled book, not a
  // hand-kept list: a renamed key turns this red instead of drifting silently.
  const entry = DEFAULT_COMPANION_PRESET.worldBook.entries.find(
    (candidate) => candidate.title === "晚霞收工与作息节律",
  );
  assert.ok(entry !== undefined, "the owner's evening book entry must exist");
  const keys = entry.keys ?? [];
  assert.deepEqual(keys, ["晚霞", "傍晚", "收工", "深夜", "睡觉"]);
  const evening = {
    timeOfDay: 1800,
    dayOfMonth: 19,
    seasonIndex: 2,
    year: 1,
    weather: "sunny",
    location: "Farm",
    tile: { x: 64, y: 15 },
  };
  const zhFacts = formatGameEnvironmentFacts(evening, true);
  assert.ok(zhFacts.includes("18:00（傍晚）"), `the Chinese clock line carries the band: ${zhFacts}`);
  assert.ok(
    keys.some((key) => zhFacts.includes(key)),
    `Chinese facts must carry a book key so the evening entry can trigger: ${zhFacts}`,
  );
  const enFacts = formatGameEnvironmentFacts(evening, false);
  assert.equal(
    keys.filter((key) => enFacts.includes(key)).length,
    0,
    `English facts must carry no Chinese book key: ${enFacts}`,
  );
});

test("formatGameClock rejects out-of-range clocks", () => {
  assert.equal(formatGameClock(-5, false), "");
  assert.equal(formatGameClock(9999, false), "");
  assert.equal(formatGameClock(60123, false), "");
  assert.equal(formatGameClock(18.5, false), "");
  assert.equal(formatGameClock(Number.NaN, false), "");
  assert.equal(formatGameClock(9999, true), "");
});

test("formatGameDate localizes season name and order", () => {
  assert.equal(formatGameDate(1, 0, 1, true), "1年第1天 春季");
  assert.equal(formatGameDate(19, 0, 1, true), "1年第19天 春季");
  assert.equal(formatGameDate(1, 1, 1, true), "1年第1天 夏季");
  assert.equal(formatGameDate(1, 2, 2, true), "2年第1天 秋季");
  assert.equal(formatGameDate(1, 3, 3, true), "3年第1天 冬季");
  assert.equal(formatGameDate(1, 0, 1, false), "Year 1, Day 1 of Spring");
  assert.equal(formatGameDate(28, 2, 4, false), "Year 4, Day 28 of Fall");
});

test("formatGameDate falls back to the raw index for unknown seasons", () => {
  const v = formatGameDate(1, 7, 1, true);
  assert.match(v, /7/);
});

test("formatGameWeather maps stable token to localized human phrase", () => {
  assert.equal(formatGameWeather("sunny", true), "天气：晴天");
  assert.equal(formatGameWeather("rain", true), "天气：雨天");
  assert.equal(formatGameWeather("snow", true), "天气：下雪");
  assert.equal(formatGameWeather("lightning", true), "天气：雷雨");
  // Green rain is a rain SUBTYPE in the native game (`GameLocation.IsGreenRainingHere` is
  // `IsRainingHere() && GetWeather().IsGreenRain`), so a token that reached this map has already been named by the
  // Mod's own projection. Without an entry it fell through to "雨天", which is the one day of the year where the farm
  // fills with weeds and debris.
  assert.equal(formatGameWeather("green_rain", true), "天气：绿雨");
  // `isDebrisWeather` is petals drifting in spring and leaves in autumn. "风沙" described a calm spring afternoon as a
  // dust storm, which is a different season and a different thing to plan for.
  assert.equal(formatGameWeather("debris", true), "天气：飘花");
  assert.equal(formatGameWeather("unknown", true), "天气：未知天气");
  assert.equal(formatGameWeather("sunny", false), "weather: sunny");
  assert.equal(formatGameWeather("rain", false), "weather: rainy");
  assert.equal(formatGameWeather("green_rain", false), "weather: green rain");
  assert.equal(formatGameWeather("debris", false), "weather: petals drifting");
  assert.equal(formatGameWeather("lightning", false), "weather: thunderstorm");
});

test("formatGameWeather passes through unknown tokens rather than guessing", () => {
  assert.equal(formatGameWeather("blizzard", true), "天气：blizzard");
  assert.equal(formatGameWeather("blizzard", false), "weather: blizzard");
});

test("formatGameEnvironmentFacts carries the actor's current stamina, verbatim", () => {
  const facts = formatGameEnvironmentFacts(
    {
      timeOfDay: 1700,
      dayOfMonth: 19,
      seasonIndex: 0,
      year: 1,
      weather: "sunny",
      location: "Farm",
      tile: { x: 64, y: 15 },
      stamina: 270,
      exhausted: false,
    },
    false,
  );
  assert.equal(
    facts,
    "5:00 PM；Year 1, Day 19 of Spring；weather: sunny；location: Farm；tile: (64, 15)；stamina: 270",
  );
});

/**
 * A turn with no tool call is the ordinary case, and on it the companion could
 * describe the hour, the weather and her stamina but not the tile she stands on
 * nor the tool in her hand - so "what are you holding" had to be guessed. Both
 * are plain native reads already on the wire (`Snapshot.tile`, `currentTool`,
 * and `toolSlots[].upgradeLevel` for the upgrade the handlers actually check).
 */
test("formatGameEnvironmentFacts carries the actor's own tile and the tool she is holding", () => {
  const source = {
    timeOfDay: 900,
    dayOfMonth: 19,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    location: "Farm",
    tile: { x: 64, y: 15 },
    stamina: 270,
    exhausted: false,
    currentTool: "(T)Hoe",
    currentToolSlot: 2,
    toolSlots: [{ slot: 2, label: "(T)Hoe", upgradeLevel: 2 }],
  };

  const en = formatGameEnvironmentFacts(source, false);
  assert.ok(en.includes("tile: (64, 15)"), `the English line must name her tile: ${en}`);
  assert.ok(en.includes("holding: (T)Hoe (+2)"), `the English line must name the held tool and its upgrade: ${en}`);

  const zh = formatGameEnvironmentFacts(source, true);
  assert.ok(zh.includes("脚下: (64, 15)"), `the Chinese line must name her tile: ${zh}`);
  assert.ok(zh.includes("手持: (T)Hoe（+2）"), `the Chinese line must name the held tool and its upgrade: ${zh}`);
});

/**
 * The upgrade level is the fact the tool handlers check (an upgraded axe is not
 * the basic one), but it is only on the wire beside the slot that holds it. A
 * slot list that does not match the held tool must cost the upgrade, never the
 * name, and a snapshot with no held tool must cost the whole fact.
 */
test("formatGameEnvironmentFacts keeps the held tool when its slot is unknown, and omits it when nothing is held", () => {
  const base = {
    timeOfDay: 900,
    dayOfMonth: 19,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    location: "Farm",
    tile: { x: 64, y: 15 },
  };

  const unmatched = formatGameEnvironmentFacts(
    { ...base, currentTool: "(T)Axe", currentToolSlot: 0, toolSlots: [{ slot: 2, label: "(T)Hoe" }] },
    false,
  );
  assert.ok(unmatched.includes("holding: (T)Axe"), `the tool name survives an unknown slot: ${unmatched}`);
  assert.ok(!unmatched.includes("holding: (T)Axe ("), `no invented upgrade level: ${unmatched}`);

  for (const currentTool of [undefined, null, ""] as const) {
    // `exactOptionalPropertyTypes` forbids writing `undefined` into an optional field, so the absent case is
    // expressed by omitting the key instead of restating it as undefined. `null` and `""` are different values
    // than `undefined` and can be written as-is.
    const source: GameEnvironmentFactsSource = currentTool === undefined ? base : { ...base, currentTool };
    const empty = formatGameEnvironmentFacts(source, false);
    assert.ok(!empty.includes("holding:"), `an absent held tool drops the whole fact: ${empty}`);
  }
});

/**
 * Nearby villagers: the nearest few by name, the remainder as a count, and a
 * radius so "nearby" never means "somewhere on this map". Eight villagers here
 * is the shape a town square reaches, and it must still cost one bounded fact.
 */
test("formatGameEnvironmentFacts names at most three villagers near her and counts the rest of the map", () => {
  const villager = (npcName: string, displayName: string, x: number, y: number) => ({
    npcName,
    displayName,
    location: "Farm",
    x,
    y,
    inCurrentLocation: true,
  });
  const villagers = [
    villager("Abigail", "阿比盖尔", 51, 50),
    villager("Sam", "山姆", 52, 50),
    villager("Penny", "潘妮", 53, 50),
    villager("Sebastian", "塞巴斯蒂安", 54, 50),
    villager("Marlon", "马龙", 55, 50),
    villager("Jas", "贾斯", 56, 50),
    // In this location, but not near her: they must be counted, not named.
    villager("Haley", "海莉", 90, 50),
    villager("Elliott", "艾利欧特", 50, 90),
  ];
  const source = {
    timeOfDay: 900,
    dayOfMonth: 19,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    location: "Farm",
    tile: { x: 50, y: 50 },
    villagerWhereabouts: villagers,
  };

  const en = formatGameEnvironmentFacts(source, false);
  for (const named of ["Abigail", "Sam", "Penny"]) assert.ok(en.includes(named), `names the nearest: ${en}`);
  assert.ok(!en.includes("Sebastian"), `the fourth nearest is a count, not a name: ${en}`);
  assert.ok(!en.includes("Haley"), `a villager on another part of the map is a count, not a name: ${en}`);
  assert.ok(en.includes("5 more in this location"), `the rest of the map is counted: ${en}`);

  const zh = formatGameEnvironmentFacts(source, true);
  assert.ok(zh.includes("附近: "), `the Chinese line names the neighbours: ${zh}`);
  assert.ok(zh.includes("阿比盖尔"), zh);
  assert.ok(!zh.includes("塞巴斯蒂安"), zh);
  assert.ok(zh.includes("本图另有 5 人"), `the Chinese line counts the rest of the map: ${zh}`);
});

/**
 * The radius is the point of "nearby": with nobody inside the discovery
 * envelope, only the count may appear - a name would say someone is with her when
 * nobody is.
 */
test("formatGameEnvironmentFacts counts a villager across the map without claiming she is nearby", () => {
  const facts = formatGameEnvironmentFacts(
    {
      timeOfDay: 900,
      dayOfMonth: 19,
      seasonIndex: 0,
      year: 1,
      weather: "sunny",
      location: "Farm",
      tile: { x: 10, y: 10 },
      villagerWhereabouts: [
        { npcName: "Haley", displayName: "海莉", location: "Farm", x: 60, y: 40, inCurrentLocation: true },
        { npcName: "Marlon", displayName: "马龙", location: "AdventureGuild", x: 11, y: 11, inCurrentLocation: false },
      ],
    },
    false,
  );
  assert.equal(facts.endsWith("nearby: 1 more in this location"), true, `only the count, and only this map: ${facts}`);
  assert.ok(!facts.includes("Haley"), facts);
  assert.ok(!facts.includes("Marlon"), `another location is not nearby whatever its tile: ${facts}`);
});

/**
 * The line is rendered on every turn, so it must stay a line. Villager display
 * names arrive bounded at 128 characters each, which three of them would make
 * larger than every other fact combined.
 */
test("formatGameEnvironmentFacts stays a bounded line even with pathological names", () => {
  const long = "阿".repeat(128);
  const facts = formatGameEnvironmentFacts(
    {
      timeOfDay: 900,
      dayOfMonth: 19,
      seasonIndex: 0,
      year: 1,
      weather: "sunny",
      location: "Farm",
      tile: { x: 50, y: 50 },
      stamina: 270,
      exhausted: false,
      currentTool: "(T)Hoe",
      villagerWhereabouts: [
        { npcName: "A", displayName: long, location: "Farm", x: 51, y: 50, inCurrentLocation: true },
        { npcName: "B", displayName: long, location: "Farm", x: 52, y: 50, inCurrentLocation: true },
        { npcName: "C", displayName: long, location: "Farm", x: 53, y: 50, inCurrentLocation: true },
      ],
    },
    true,
  );
  assert.ok(
    Buffer.byteLength(facts, "utf8") <= MAX_GAME_ENVIRONMENT_FACTS_BYTES,
    `the line is bounded (${Buffer.byteLength(facts, "utf8")} bytes): ${facts.length} chars`,
  );
  // The bound must not eat the facts it opens with: a truncation that removed the
  // clock would trade one blindness for another.
  assert.ok(facts.startsWith("09:00"), facts);
  assert.ok(facts.includes("天气：晴天"), facts);
  // Nor the neighbours: the per-name cap is what keeps an 128-character display
  // name from crowding the rest of the line out of the byte bound.
  assert.ok(facts.includes("附近: "), `the neighbour fact survives the bound: ${facts}`);
  assert.ok(facts.includes("手持: (T)Hoe"), `the held-tool fact survives the bound: ${facts}`);
});

/**
 * Unwatered crops: `cropTargets` is already the Mod's bounded Chebyshev-6 list
 * of them, so the count is a plain read. ABSENT is "not measured" (the family is
 * only published when `water_crop` is advertised) and must stay silent, while a
 * measured zero is the answer to "is anything in front of her thirsty".
 */
test("formatGameEnvironmentFacts counts unwatered crops nearby, and tells an unmeasured list from an empty one", () => {
  const base = {
    timeOfDay: 900,
    dayOfMonth: 19,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    location: "Farm",
    tile: { x: 50, y: 50 },
  };
  const crop = (targetId: string, x: number, y: number) => ({
    targetId,
    x,
    y,
    cropId: "24",
    displayName: "花椰菜",
  });

  const thirsty = formatGameEnvironmentFacts(
    { ...base, cropTargets: [crop("crop_a", 51, 50), crop("crop_b", 52, 50), crop("crop_c", 53, 50)] },
    true,
  );
  assert.ok(thirsty.includes("待浇水作物: 3"), `the count reaches the line: ${thirsty}`);

  const measuredNone = formatGameEnvironmentFacts({ ...base, cropTargets: [] }, false);
  assert.ok(measuredNone.includes("unwatered crops: 0"), `a measured zero is an answer: ${measuredNone}`);

  const unmeasured = formatGameEnvironmentFacts(base, false);
  assert.ok(!unmeasured.includes("unwatered crops"), `an absent list says nothing: ${unmeasured}`);
});

test("formatGameEnvironmentFacts localizes stamina and marks persistent fatigue", () => {
  const facts = formatGameEnvironmentFacts(
    {
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
      weather: "rain",
      location: "Farm",
      tile: { x: 64, y: 15 },
      stamina: 12,
      exhausted: true,
    },
    true,
  );
  assert.equal(facts, "06:00（清晨）；1年第1天 春季；天气：雨天；位置: Farm；脚下: (64, 15)；体力: 12（已疲惫）");
});

test("formatGameEnvironmentFacts omits stamina when the snapshot does not carry it", () => {
  const facts = formatGameEnvironmentFacts(
    {
      timeOfDay: 1700,
      dayOfMonth: 19,
      seasonIndex: 0,
      year: 1,
      weather: "sunny",
      location: "Farm",
      tile: { x: 5, y: 10 },
    },
    false,
  );
  assert.equal(facts, "5:00 PM；Year 1, Day 19 of Spring；weather: sunny；location: Farm；tile: (5, 10)");
  assert.ok(!facts.includes("stamina"));
});

test("formatGameEnvironmentFacts omits stamina rather than defaulting a non-finite reading", () => {
  const facts = formatGameEnvironmentFacts(
    {
      timeOfDay: 1700,
      dayOfMonth: 19,
      seasonIndex: 0,
      year: 1,
      weather: "sunny",
      location: "Farm",
      tile: { x: 5, y: 10 },
      stamina: Number.NaN,
      exhausted: false,
    },
    false,
  );
  assert.equal(facts, "5:00 PM；Year 1, Day 19 of Spring；weather: sunny；location: Farm；tile: (5, 10)");
  assert.ok(!facts.includes("stamina"));
});

test("formatGameStamina publishes the native value, including a drained negative or fractional one", () => {
  assert.equal(formatGameStamina(-15, false, false), "stamina: -15");
  assert.equal(formatGameStamina(270.5, false, false), "stamina: 270.5");
  assert.equal(formatGameStamina(undefined, false, false), "");
  assert.equal(formatGameStamina(Number.NaN, true, false), "");
});
