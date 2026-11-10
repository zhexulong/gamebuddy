import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { renderRuntimeEnvironmentBlock, setRuntimeEnvironmentFacts } from "@cortexkit/pi-magic-context/memory";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  composeGameEnvironmentFacts,
  formatGameClock,
  formatGameDate,
  formatGameEnvironmentFacts,
  formatGameStamina,
  formatGameWeather,
  type GameEnvironmentFactsSource,
  MAX_GAME_ENVIRONMENT_FACTS_BYTES,
  renderGameEnvironmentFactsObservation,
} from "./game-world-vocabulary.js";
import {
  createRenderedEnvironmentFactsProvider,
  environmentFactsRecordPath,
  type EnvironmentFactsRenderRecord,
  MAX_ENVIRONMENT_FACTS_RECORD_LINES,
  reloadMagicContextInRuntimeRoot,
  resolveRuntimePaths,
} from "./runtime-core.internal.js";
import type { GameConnection } from "./game-connection.js";
import type { Snapshot } from "./protocol.js";
import { boundObservedSnapshot } from "./stardew-observation-budget.js";
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

test("the localized clock fact can fire a book entry the English clock cannot", () => {
  // The population is read from the owner's own compiled book, not a hand-kept
  // list: an entry that is renamed or re-keyed turns this red by naming itself.
  const gated = DEFAULT_COMPANION_PRESET.worldBook.entries.filter((entry) => entry.constant !== true);
  const evening: GameEnvironmentFactsSource = {
    timeOfDay: 1800,
    dayOfMonth: 19,
    seasonIndex: 2,
    year: 1,
    weather: "sunny",
    location: "Farm",
    tile: { x: 64, y: 15 },
  };
  const zhFacts = formatGameEnvironmentFacts(evening, true);
  const enFacts = formatGameEnvironmentFacts(evening, false);
  assert.ok(zhFacts.includes("18:00（傍晚）"), `the Chinese clock line carries the band: ${zhFacts}`);
  const firedByZh = gated.filter((entry) => (entry.keys ?? []).some((key) => zhFacts.includes(key)));
  assert.ok(
    firedByZh.length > 0,
    `the Chinese facts must carry a key of at least one book entry, or no entry can fire on the clock: ${zhFacts}`,
  );
  for (const entry of firedByZh)
    assert.equal(
      (entry.keys ?? []).filter((key) => enFacts.includes(key)).length,
      0,
      `the English facts must carry none of ${entry.title}'s keys: ${enFacts}`,
    );
});

test("the shipped book answers a green-rain day, which the rendered weather fact can name", () => {
  // "The name green rain renders" is derived from the weather formatter, not
  // quoted here: a renamed token turns this red by naming the drift, instead of
  // pinning the entry to yesterday's word.
  const weatherFact = formatGameWeather("green_rain", true);
  const name = weatherFact.replace(/^天气：/u, "");
  assert.equal(name, "绿雨", `the green-rain day must be named, not fall back: ${weatherFact}`);
  const day: GameEnvironmentFactsSource = {
    timeOfDay: 900,
    dayOfMonth: 12,
    seasonIndex: 1,
    year: 1,
    weather: "green_rain",
    location: "Farm",
    tile: { x: 64, y: 15 },
    stamina: 270,
    exhausted: false,
  };
  const greenRainDay = formatGameEnvironmentFacts(day, true);
  assert.ok(greenRainDay.includes(weatherFact), `the day's line carries the weather fact: ${greenRainDay}`);
  const gated = DEFAULT_COMPANION_PRESET.worldBook.entries.filter((entry) => entry.constant !== true);
  const fires = (facts: string, entry: (typeof gated)[number]): boolean =>
    (entry.keys ?? []).some((key) => facts.includes(key));
  const answered = gated.filter((entry) => (entry.keys ?? []).includes(name) && fires(greenRainDay, entry));
  assert.equal(
    answered.length,
    1,
    `exactly one entry must be keyed on the name the weather fact renders (${name}); the green-rain day is the one day the farm fills with weeds and debris, and a book that stays silent on it leaves the companion describing it as plain rain`,
  );
  // The same book on a sunny day: the entry exists for the condition, not for a
  // word that is always present.
  const sunnyDay = formatGameEnvironmentFacts({ ...day, weather: "sunny" }, true);
  assert.equal(
    answered.filter((entry) => fires(sunnyDay, entry)).length,
    0,
    `the green-rain entry must not fire on a sunny day: ${sunnyDay}`,
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
 * The tool's own naming is the test below this one.
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
    toolSlots: [{ slot: 2, label: "(T)Hoe", upgradeLevel: 2, category: "hoe" }],
  };

  const en = formatGameEnvironmentFacts(source, false);
  assert.ok(en.includes("tile: (64, 15)"), `the English line must name her tile: ${en}`);
  assert.ok(en.includes("holding: hoe (+2)"), `the English line must name the held tool and its upgrade: ${en}`);

  const zh = formatGameEnvironmentFacts(source, true);
  assert.ok(zh.includes("脚下: (64, 15)"), `the Chinese line must name her tile: ${zh}`);
  assert.ok(zh.includes("手持: 锄头（+2）"), `the Chinese line must name the held tool and its upgrade: ${zh}`);
});

/**
 * The environment line is what she SPEAKS from, so it may not hand her an identifier to read aloud.
 *
 * Measured on a live session: the companion said "我们带着 (T)Hoe 去 Town". The cause was this line, which
 * rendered `currentTool` verbatim - and `currentTool` is the native item identity (`(T)Hoe`, `(W)47` for the
 * scythe), not a word a person says. The wire publishes the same tool twice: that identity beside
 * `toolSlots[].category`, the Mod's own tool word (`FarmhandActionCatalog.ToolEnum`, the word `equip_tool` and
 * every `tool:<category>` claim use). This test holds both halves at once, because they pull in opposite
 * directions on purpose: the fact she speaks from carries the word, and the observation a plan is written
 * against still carries the identity it must echo.
 */
test("a turn's environment line names the tool in words while the observation keeps the id a plan must echo", () => {
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
    toolSlots: [{ slot: 2, label: "(T)Hoe", upgradeLevel: 2, category: "hoe" }],
  };

  const zh = formatGameEnvironmentFacts(source, true);
  assert.equal(zh.includes("(T)"), false, `the Chinese line must not hand her a raw item id to say: ${zh}`);
  assert.ok(zh.includes("手持: 锄头（+2）"), `the Chinese line names the tool and its upgrade: ${zh}`);

  const en = formatGameEnvironmentFacts(source, false);
  assert.equal(en.includes("(T)"), false, `the English line must not hand her a raw item id to say: ${en}`);
  assert.ok(en.includes("holding: hoe (+2)"), `the English line names the tool and its upgrade: ${en}`);

  // The primitive identity the tool handlers really check is a MeleeWeapon's `(W)47`, not a `(T)` name: the same
  // mapping has to cover it, or the one tool whose id no label can ever say keeps reaching her.
  const scythe = formatGameEnvironmentFacts(
    {
      ...source,
      currentTool: "(W)47",
      currentToolSlot: 3,
      toolSlots: [{ slot: 3, label: "(W)47", upgradeLevel: 0, category: "scythe" }],
    },
    false,
  );
  assert.equal(scythe.includes("(W)"), false, `a scythe reported as (W)47 must still be named: ${scythe}`);
  assert.ok(scythe.includes("holding: scythe"), scythe);

  // The other half, through the real observation path: the id a plan echoes is untouched. A plan writes
  // `entry.label === snapshot.currentTool` and copies `toolSlots[].slot`, so a line that also dropped these fields
  // would trade one blindness for another.
  const snapshot: Snapshot = {
    ...source,
    revision: 12,
    health: 100,
    actionable: true,
    capabilities: ["water_crop"],
    catalogRevision: 3,
    enabledActionIds: ["water_crop"],
    presentationLocale: "zh-CN",
  };
  const observed = boundObservedSnapshot(snapshot).snapshot;
  assert.equal(observed.currentTool, "(T)Hoe", "the observation keeps the identity a plan compares against");
  assert.deepEqual(observed.toolSlots, [{ slot: 2, label: "(T)Hoe", upgradeLevel: 2, category: "hoe" }]);
});

/**
 * An older Mod publishes a slot with no `category`, so there is no word to prefer. The fact must still say what
 * she is holding rather than vanish: an unnameable tool is a smaller loss than a silent one.
 */ test("a tool the wire publishes no word for keeps its identity rather than dropping the fact", () => {
  const facts = formatGameEnvironmentFacts(
    {
      timeOfDay: 900,
      dayOfMonth: 19,
      seasonIndex: 0,
      year: 1,
      weather: "sunny",
      location: "Farm",
      tile: { x: 64, y: 15 },
      currentTool: "(T)Hoe",
      currentToolSlot: 2,
      toolSlots: [{ slot: 2, label: "(T)Hoe", upgradeLevel: 0 }],
    },
    false,
  );
  assert.ok(facts.includes("holding: (T)Hoe"), `an unnamed tool is still reported: ${facts}`);
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
 * Nearby villagers: the nearest few by name, and the rest of the map as destinations.
 *
 * Two families answer this question and only one of them is addressable. `npcRelationshipTargets` carries
 * `targetId` and is bounded to the Mod's 6-tile discovery envelope; `villagerWhereabouts` carries every
 * villager on the map with a tile but no id. A villager at (90,50) is therefore invisible to `talk_to_npc`
 * until the actor walks over - so the line must say where to walk, not merely that someone exists.
 */
test("formatGameEnvironmentFacts names the villagers near her and the coordinates of the ones beyond", () => {
  const villager = (npcName: string, displayName: string, x: number, y: number) => ({
    targetId: `npc_relationship_${npcName}`,
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
    // In this location but past the envelope: a destination, with the tile she would walk to.
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
  assert.ok(en.includes("Haley(90,50)"), `a villager past the envelope is somewhere she can walk: ${en}`);
  assert.ok(en.includes("Elliott(50,90)"), `and so is the second one: ${en}`);
  assert.ok(en.includes("3 more"), `what the caps hid is still counted: ${en}`);

  const zh = formatGameEnvironmentFacts(source, true);
  assert.ok(zh.includes("附近: "), `the Chinese line names the neighbours: ${zh}`);
  assert.ok(zh.includes("阿比盖尔"), zh);
  assert.ok(!zh.includes("塞巴斯蒂安"), zh);
  assert.ok(zh.includes("海莉(90,50)"), `the Chinese line carries the walkable tile too: ${zh}`);
  assert.ok(zh.includes("另有 3 人"), `the Chinese line counts the rest: ${zh}`);
});

/**
 * The radius still means something: nobody inside the envelope is described as NEAR.
 *
 * What changed is only what a beyond-envelope villager becomes. He is not "with her", so he is not in the
 * `nearby` half; he is on her map and reachable, so his tile is published as the place to go.
 */
test("formatGameEnvironmentFacts keeps a villager across the map out of `nearby` and publishes where he is", () => {
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
        {
          targetId: "npc_relationship_haley",
          npcName: "Haley",
          displayName: "海莉",
          location: "Farm",
          x: 60,
          y: 40,
          inCurrentLocation: true,
        },
        {
          targetId: "npc_relationship_marlon",
          npcName: "Marlon",
          displayName: "马龙",
          location: "AdventureGuild",
          x: 11,
          y: 11,
          inCurrentLocation: false,
        },
      ],
    },
    false,
  );
  assert.ok(!facts.includes("nearby:"), `nobody is within the envelope, so nobody is nearby: ${facts}`);
  assert.equal(facts.endsWith("on this map: Haley(60,40)"), true, `the destination is named with its tile: ${facts}`);
  assert.ok(!facts.includes("Marlon"), `another location is not on this map whatever its tile: ${facts}`);
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
        {
          targetId: "npc_relationship_a",
          npcName: "A",
          displayName: long,
          location: "Farm",
          x: 51,
          y: 50,
          inCurrentLocation: true,
        },
        {
          targetId: "npc_relationship_b",
          npcName: "B",
          displayName: long,
          location: "Farm",
          x: 52,
          y: 50,
          inCurrentLocation: true,
        },
        {
          targetId: "npc_relationship_c",
          npcName: "C",
          displayName: long,
          location: "Farm",
          x: 53,
          y: 50,
          inCurrentLocation: true,
        },
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
 * THE DROP ORDER IS A RULE, NOT THE ORDER THE FACTS HAPPEN TO BE COMPOSED IN.
 *
 * `stamina` is composed LAST, so a cap that dropped facts from the END spent the one fact about her own body
 * first: a companion whose world line grew could not see her own stamina, and nothing in the line said so. The
 * mitigation at the time was an arithmetic argument that the rest of the line "fits"; the next world block
 * (interactable tiles) is exactly what makes such an argument false, so the protection has to be the order
 * itself.
 *
 * The population is the composer's own subjects - every fact it can render, classified by the half of the line
 * it speaks about - rather than a list of formatter names here, so a world fact added later is covered without
 * editing this test, and a fact that stops declaring its subject fails to compile.
 */
test("a fact about her own body is never dropped while a fact about the world survives", () => {
  // Pressure of the shape a real turn produces: many locations with thirsty crops and a map full of walkable
  // villagers spend the whole-map answers' bytes, which is what a farm and a Town afternoon already do.
  const wateringWhereabouts = [];
  for (let index = 0; index < 14; index += 1)
    wateringWhereabouts.push({ location: `Somewhere${index}`, needsWaterCount: 7, nearestX: 10, nearestY: 20 });
  const villagerWhereabouts = [];
  for (let index = 0; index < 20; index += 1)
    villagerWhereabouts.push({
      npcName: `F${index}`,
      // The row carries the id the action layer accepts, so a reader can build a node from this line alone.
      targetId: `villager_F${index}`,
      displayName: "阿".repeat(16),
      location: "Farm",
      x: 80 + index,
      y: 90,
      inCurrentLocation: true,
    });
  const source = sampleSnapshot(31, {
    stamina: 270,
    exhausted: false,
    currentTool: "(T)Hoe",
    currentToolSlot: 2,
    toolSlots: [{ slot: 2, label: "(T)Hoe", upgradeLevel: 2, category: "hoe" }],
    wateringWhereabouts,
    villagerWhereabouts,
  });

  const facts = composeGameEnvironmentFacts(source, true);
  const body = facts.filter((fact) => fact.subject === "body").map((fact) => fact.text);
  const world = facts.filter((fact) => fact.subject === "world").map((fact) => fact.text);
  assert.ok(body.length > 0, "this snapshot carries facts about her own body");
  assert.ok(world.length > 0, "and about the world she is standing in");

  const rendered = renderGameEnvironmentFactsObservation(source, true);
  assert.ok(rendered.dropped.length > 0, `the line really is over its cap here: ${rendered.text}`);
  assert.ok(
    world.some((text) => rendered.text.includes(text)),
    `some world fact survived, so nobody may claim her body was the only thing left to spend: ${rendered.text}`,
  );
  assert.deepEqual(
    body.filter((text) => !rendered.text.includes(text)),
    [],
    `a fact about her own body was dropped while a world fact survived; dropped: ${rendered.dropped.join(" | ")}`,
  );
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

/**
 * Chests: the location's own count, and the two states that must stay distinguishable.
 *
 * `chestsSummary` is location-wide on purpose - `chests` is the radius-6 entity family, so a count taken from THAT list
 * would print `chests here: 0` while a chest stood across the farm. The line therefore says which place it counted: a
 * location-wide number is still not a world total, and the `本图`/`here` qualifier is what keeps a reader from hearing
 * "the farm has 3 chests" from a count taken in the farmhouse.
 *
 * A measured zero is printed, and an ABSENT summary stays silent: "no chests here" and "the field never arrived" are
 * different facts, and a formatter that printed nothing for both would make them the same one.
 */
test("formatGameEnvironmentFacts counts the location's chests, says which location, and keeps a measured zero", () => {
  const base = {
    timeOfDay: 900,
    dayOfMonth: 19,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    location: "Farm",
    tile: { x: 50, y: 50 },
  };

  // Three chests holding 2, 1 and 0 items: the counts the summary carries, rendered.
  const held = formatGameEnvironmentFacts(
    { ...base, chestsSummary: { chestCount: 3, itemCount: 3, fullCount: 0 } },
    true,
  );
  assert.ok(held.includes("本图箱子: 3（物品 3）"), `the counts reach the line, qualified by location: ${held}`);
  assert.ok(!held.includes("已满"), `a zero full count costs no bytes: ${held}`);

  // A full chest is named: it is the half of the answer a count alone cannot give.
  const full = formatGameEnvironmentFacts(
    { ...base, chestsSummary: { chestCount: 3, itemCount: 41, fullCount: 2 } },
    true,
  );
  assert.ok(full.includes("本图箱子: 3（物品 41；已满 2）"), `fullness reaches the line: ${full}`);

  const english = formatGameEnvironmentFacts(
    { ...base, chestsSummary: { chestCount: 3, itemCount: 41, fullCount: 2 } },
    false,
  );
  assert.ok(english.includes("chests here: 3 (items 41; full 2)"), `the qualifier is in both languages: ${english}`);

  // A measured zero is the answer to "do I have any chests here".
  const measuredNone = formatGameEnvironmentFacts(
    { ...base, chestsSummary: { chestCount: 0, itemCount: 0, fullCount: 0 } },
    false,
  );
  assert.ok(measuredNone.includes("chests here: 0"), `a measured zero is an answer: ${measuredNone}`);

  // An absent summary means the container actions were not advertised, and says nothing.
  const unmeasured = formatGameEnvironmentFacts(base, false);
  assert.ok(!unmeasured.includes("chests here"), `an absent summary says nothing: ${unmeasured}`);
});

/**
 * The room's own form, rendered from the value rather than stated as a fixed fact.
 *
 * Measured 2026-11-05 (day 2, 18:00, starter farmhouse): "六点了，锅里没东西可下，我烧壶水泡点茶对付一口算了" -
 * the house has no kitchen and no stove, and nothing in the line said so. `cookingStationTargets` is the Mod's own
 * scan of the current map for the vanilla kitchen action tile, and the house gains that kitchen WITH its upgrade,
 * so the fact follows the house. A hard-coded "no kitchen" would become a lie the day the player upgrades, and
 * this asserts the line changes with it. ABSENT (the Mod did not publish the family, because `cook_recipe` is not
 * advertised) stays silent, like every other unmeasured family; a measured empty list is an answer.
 */
test("the environment line says whether there is a kitchen here, and follows the house's own form", () => {
  const base = {
    timeOfDay: 1800,
    dayOfMonth: 2,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    location: "FarmHouse",
    tile: { x: 5, y: 5 },
  };
  const station = (stationKind: "kitchen" | "cookout_kit", location: string) => ({
    targetId: `cooking_station_${stationKind}`,
    location,
    x: 4,
    y: 5,
    stationKind,
  });

  const starter = formatGameEnvironmentFacts({ ...base, cookingStationTargets: [] }, true);
  assert.ok(starter.includes("厨房: 无"), `the starter house is one room with no kitchen: ${starter}`);

  const upgraded = formatGameEnvironmentFacts(
    { ...base, cookingStationTargets: [station("kitchen", "FarmHouse")] },
    true,
  );
  assert.ok(upgraded.includes("厨房: 有"), `the upgraded house has its kitchen: ${upgraded}`);
  assert.ok(!upgraded.includes("厨房: 无"), `and the line must not keep the starter's answer: ${upgraded}`);

  // A placed cookout kit is a stove outdoors, not the house's kitchen.
  const kitOnly = formatGameEnvironmentFacts(
    { ...base, location: "Farm", cookingStationTargets: [station("cookout_kit", "Farm")] },
    true,
  );
  assert.ok(kitOnly.includes("厨房: 无"), `a cookout kit is not a kitchen: ${kitOnly}`);

  const english = formatGameEnvironmentFacts({ ...base, cookingStationTargets: [] }, false);
  assert.ok(english.includes("kitchen: none"), `both languages carry the fact: ${english}`);

  const unmeasured = formatGameEnvironmentFacts(base, false);
  assert.ok(
    !unmeasured.includes("kitchen"),
    `an unpublished family means the Mod did not measure it, and the line says nothing: ${unmeasured}`,
  );
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
  assert.equal(facts, "06:00（清晨）；1年第1天 春季；天气：雨天；位置: 农场；脚下: (64, 15)；体力: 12（已疲惫）");
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

/**
 * The rendered block, as a run's artifact can read it back.
 *
 * `<runtime-environment>` is produced by the Magic Context transform when a request is ASSEMBLED, and the
 * session stores messages - so before this record existed, no file from a run could answer "did the
 * model ever see a non-zero unwatered count" or "did a same-map villager arrive with coordinates".
 * `tools/live-run/round-verdict.mjs` rows 2 and 5 therefore reported UNOBSERVABLE by construction.
 * `round18` (24 minutes, 75 assembled plans) is the measurement: `位置:` 0, `脚下` 0, `待浇水` 0 in the
 * bound session, while the formatter renders all three when called directly.
 *
 * The record is deliberately NOT the session, the transcript or player memory: it is a per-run file
 * beside the run manifest that only a reader opens.
 */
type FakeSnapshot = GameEnvironmentFactsSource & Readonly<{ revision?: number; presentationLocale?: string }>;
type FakeConnection = { state: { snapshot: FakeSnapshot | null } };

function sampleSnapshot(revision: number, overrides: Partial<FakeSnapshot> = {}): FakeSnapshot {
  return {
    timeOfDay: 600,
    dayOfMonth: 6,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    location: "Farm",
    tile: { x: 60, y: 20 },
    revision,
    presentationLocale: "zh-CN",
    ...overrides,
  };
}

function fakeConnection(snapshot: FakeSnapshot | null): FakeConnection {
  return { state: { snapshot } };
}

/** The record as a reader sees it: one parsed line per rendered request, in write order. */
function readRecords(recordPath: string): EnvironmentFactsRenderRecord[] {
  return readFileSync(recordPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EnvironmentFactsRenderRecord);
}

test("the block the transform injects is recorded per request, with the snapshot revision it rendered", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-environment-facts-record-"));
  const recordPath = join(dir, "environment-facts.jsonl");
  try {
    const connection = fakeConnection(
      sampleSnapshot(4123, {
        wateringWhereabouts: [{ location: "Farm", needsWaterCount: 24, nearestX: 18, nearestY: 16 }],
      }),
    );
    const firstSnapshot = connection.state.snapshot as GameEnvironmentFactsSource;
    // The REAL seam: the vendored transform's own registration, called the way the runtime calls it, so
    // the test proves the provider the transform reaches is the one that records. Registration is
    // process-global and locked (a second provider throws), so this file registers exactly once here.
    setRuntimeEnvironmentFacts(
      createRenderedEnvironmentFactsProvider(connection as unknown as GameConnection, recordPath),
    );

    const firstBlock = renderRuntimeEnvironmentBlock();
    connection.state.snapshot = sampleSnapshot(4124, { timeOfDay: 1500, dayOfMonth: 7 });
    const secondBlock = renderRuntimeEnvironmentBlock();

    assert.ok(firstBlock?.includes("06:00"), `the first block renders the first snapshot: ${String(firstBlock)}`);
    assert.ok(secondBlock?.includes("15:00"), `the second block renders the second snapshot: ${String(secondBlock)}`);

    const records = readRecords(recordPath);
    assert.equal(records.length, 2, "one record per assembled request, not one per run");
    assert.deepEqual(
      records.map((record) => record.revision),
      [4123, 4124],
      "each line carries the revision it rendered",
    );
    const [firstRecord, secondRecord] = records;
    assert.ok(firstRecord !== undefined && secondRecord !== undefined);
    // The record holds the string the transform injected - verbatim, not a re-render of the same snapshot.
    assert.equal(firstRecord.text, firstBlock?.split("\n")[1]);
    assert.equal(secondRecord.text, secondBlock?.split("\n")[1]);
    assert.ok(firstRecord.text.includes("待浇水作物: 24（最近: 18,16）"), firstRecord.text);
    assert.equal(
      firstRecord.text,
      formatGameEnvironmentFacts(firstSnapshot, true),
      "the recorded line is the product's own line, so a reader is reading the prompt",
    );
    assert.equal(firstRecord.overCap, false);
    assert.deepEqual(firstRecord.dropped, undefined, "nothing was dropped, so the key is absent");
    assert.equal(firstRecord.bytes, Buffer.byteLength(firstRecord.text, "utf8"));
    assert.ok(Number.isFinite(Date.parse(firstRecord.at)), `the record is timestamped: ${firstRecord.at}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * "The block vanished on some turns" and "there was no snapshot to render" are different facts, and a
 * record that only wrote non-empty renders would collapse them into one absence.
 */
test("an empty render is recorded as an empty render rather than omitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-environment-facts-empty-"));
  const recordPath = join(dir, "environment-facts.jsonl");
  try {
    const connection = fakeConnection(null);
    const provider = createRenderedEnvironmentFactsProvider(connection as unknown as GameConnection, recordPath);

    assert.equal(provider(), "");
    connection.state.snapshot = sampleSnapshot(77, { timeOfDay: 2100 });
    provider();
    connection.state.snapshot = null;
    assert.equal(provider(), "");

    const records = readRecords(recordPath);
    assert.deepEqual(
      records.map((record) => [record.revision, record.text, record.bytes]),
      [
        [null, "", 0],
        [
          77,
          formatGameEnvironmentFacts(sampleSnapshot(77, { timeOfDay: 2100 }) as GameEnvironmentFactsSource, true),
          Buffer.byteLength(
            formatGameEnvironmentFacts(sampleSnapshot(77, { timeOfDay: 2100 }) as GameEnvironmentFactsSource, true),
            "utf8",
          ),
        ],
        [null, "", 0],
      ],
      "the blank renders are in the file, between the real one",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * "Did the line ever exceed the byte cap, and what was dropped" is answerable only from the observer:
 * the rendered line has already lost whatever the cap removed, so the survivors cannot name it.
 *
 * This is not a cosmetic question. The cap spends WORLD facts first - the whole-map watering answer is the
 * longest of them, so it is the first to go - and a companion whose line was bounded can be looking at a farm
 * it has no unwatered fact about, which a reader of the record is the only one who can tell from "the farm was
 * watered". Her own body is the last thing the cap touches, so the fact she is most likely to act on is never
 * the one the record reports as lost.
 */
test("the record names the facts the byte cap dropped, and its text is exactly the rendered line", () => {
  const long = "阿".repeat(16);
  const villagerWhereabouts = [];
  for (let index = 0; index < 6; index += 1)
    villagerWhereabouts.push({
      targetId: `npc_relationship_N${index}`,
      npcName: `N${index}`,
      displayName: long,
      location: "Farm",
      x: 51 + index,
      y: 50,
      inCurrentLocation: true,
    });
  // Far villagers become DESTINATIONS, each one spending bytes of the villager fact's own share.
  for (let index = 0; index < 20; index += 1)
    villagerWhereabouts.push({
      targetId: `npc_relationship_F${index}`,
      npcName: `F${index}`,
      displayName: long,
      location: "Farm",
      x: 80 + index,
      y: 90,
      inCurrentLocation: true,
    });
  const wateringWhereabouts = [];
  for (let index = 0; index < 14; index += 1)
    wateringWhereabouts.push({ location: `Somewhere${index}`, needsWaterCount: 7, nearestX: 10, nearestY: 20 });

  const source = sampleSnapshot(9, {
    stamina: 270,
    exhausted: false,
    currentTool: "(T)Hoe",
    currentToolSlot: 2,
    toolSlots: [{ slot: 2, label: "(T)Hoe", upgradeLevel: 2, category: "hoe" }],
    villagerWhereabouts,
    wateringWhereabouts,
  });
  const observation = renderGameEnvironmentFactsObservation(source as GameEnvironmentFactsSource, true);

  assert.equal(
    observation.text,
    formatGameEnvironmentFacts(source as GameEnvironmentFactsSource, true),
    "one implementation: the observation cannot disagree with the prompt it describes",
  );
  assert.ok(observation.dropped.length > 0, `the cap dropped something here, and says what: ${observation.text}`);
  assert.ok(
    observation.dropped[0]?.startsWith("本图待浇水作物: 0"),
    `the unwatered fact is the first thing the cap costs: ${String(observation.dropped[0])}`,
  );
  // Nothing about her own body is on that list, whatever the cap had to spend: the declared drop order
  // spends world facts first, so the fact she is most likely to act on survives the bound.
  const bodyFacts = composeGameEnvironmentFacts(source as GameEnvironmentFactsSource, true)
    .filter((fact) => fact.subject === "body")
    .map((fact) => fact.text);
  assert.deepEqual(
    observation.dropped.filter((text) => bodyFacts.includes(text)),
    [],
    `the cap spends world facts before her own body: ${observation.dropped.join(" | ")}`,
  );
  assert.ok(observation.text.includes("体力: 270"), `her stamina is on the line: ${observation.text}`);
  assert.ok(observation.text.includes("手持: 锄头"), `so is the tool in her hand: ${observation.text}`);
  for (const droppedFact of observation.dropped)
    assert.equal(
      observation.text.includes(droppedFact),
      false,
      `a dropped fact is not in the line it was dropped from: ${droppedFact}`,
    );
  assert.equal(observation.bytes, Buffer.byteLength(observation.text, "utf8"));
  // The drops come from the END, so the clock the line opens with is never what was lost - and the
  // villager destinations she could walk to are still on it.
  assert.ok(observation.text.startsWith("06:00"), observation.text);
  assert.ok(observation.text.includes("本图可去: "), observation.text);
});

/**
 * A 285-turn run must not produce an unbounded artifact, and a reader must be able to see that the tail
 * was CUT rather than believe the run ended there.
 */
test("the record stops at its cap and leaves one truncation line behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-environment-facts-cap-"));
  const recordPath = join(dir, "environment-facts.jsonl");
  try {
    const provider = createRenderedEnvironmentFactsProvider(
      fakeConnection(sampleSnapshot(1)) as unknown as GameConnection,
      recordPath,
    );
    for (let render = 0; render < MAX_ENVIRONMENT_FACTS_RECORD_LINES + 5; render += 1) provider();
    const records = readRecords(recordPath);
    assert.equal(
      records.length,
      MAX_ENVIRONMENT_FACTS_RECORD_LINES + 1,
      "the cap line is the last thing the file ever gets",
    );
    const last = records[records.length - 1] as EnvironmentFactsRenderRecord & { truncated?: boolean; lines?: number };
    assert.equal(last.truncated, true);
    assert.equal(last.lines, MAX_ENVIRONMENT_FACTS_RECORD_LINES);

    // Sealed means sealed: further requests do not reopen or grow the file.
    const before = readFileSync(recordPath, "utf8");
    for (let render = 0; render < 20; render += 1) provider();
    assert.equal(readFileSync(recordPath, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The record is a diagnostic on the REQUEST path, so it must not be able to fail a turn: an unwritable
 * record keeps the provider's answer exactly as it was and stops trying after the first failure.
 */
test("a record that cannot be written does not change what the provider returns", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-environment-facts-unwritable-"));
  try {
    // `blocked` is a FILE, so the directory the record needs cannot exist.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory", "utf8");
    const provider = createRenderedEnvironmentFactsProvider(
      fakeConnection(sampleSnapshot(31)) as unknown as GameConnection,
      join(blocked, "environment-facts.jsonl"),
    );
    const rendered = provider();
    assert.equal(rendered, formatGameEnvironmentFacts(sampleSnapshot(31) as GameEnvironmentFactsSource, true));
    assert.ok(rendered.length > 0);
    assert.equal(existsSync(join(blocked, "environment-facts.jsonl")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The other half of that promise, in the direction that must NOT be swallowed: whatever threw before this
 * record existed still throws, unchanged, so a bridge read failure cannot start looking like a quiet turn.
 */
test("a provider whose snapshot read throws still throws, and records nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-environment-facts-throws-"));
  const recordPath = join(dir, "environment-facts.jsonl");
  try {
    const exploding = Object.defineProperty({}, "state", {
      get(): never {
        throw new Error("bridge_closed");
      },
    });
    const provider = createRenderedEnvironmentFactsProvider(exploding as unknown as GameConnection, recordPath);
    assert.throws(() => provider(), /bridge_closed/);
    assert.equal(existsSync(recordPath), false, "a thrown render is not a rendered line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The path itself is the promise that the record cannot pollute the session or player memory: it sits
 * beside the run manifest, under the runtime root, as a SIBLING of the session store rather than in it.
 */
test("the record lives beside the run manifest, never in the session directory", () => {
  const identity = {
    playerId: "player-1",
    companionId: "companion-1",
    continuityId: "continuity-1",
  } as const;
  const sessionPaths = resolveRuntimePaths(identity, join(tmpdir(), "gb-environment-facts-paths"), "game-1");
  const recordPath = environmentFactsRecordPath(sessionPaths);
  assert.equal(recordPath, join(dirname(sessionPaths.runManifestPath), "environment-facts.jsonl"));
  assert.equal(
    relative(sessionPaths.sessionDir, recordPath).startsWith(".."),
    true,
    `outside the session store: ${recordPath}`,
  );
  assert.equal(dirname(recordPath), dirname(sessionPaths.sessionDir), "a sibling of the session store, not a child");
  assert.equal(
    recordPath.includes("pi-agent"),
    false,
    `not the agent directory, which holds credentials: ${recordPath}`,
  );
});
