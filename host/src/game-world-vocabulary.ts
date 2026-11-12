/**
 * The words a Game turn uses for the world, in one place.
 *
 * <p>
 * This module exists because the same fact had two spellings and a third was about to be added. The map, weather, tool,
 * season and clock tables lived inside `runtime-core.internal.ts`, while `snapshot-hud.ts` rendered the season from a
 * second array of its own and the clock as a bare `06:20`; a per-turn block assembled from either would have had to pick
 * a spelling per line.
 * </p>
 *
 * <p>
 * So the vocabulary MOVED here - it is not a copy. `runtime-core.internal.ts` imports these for the Chat-visible
 * `<runtime-environment>` line, `fact-brief.ts` imports them for the Game turn's world-state block, and one table is
 * what both read. Nothing here does I/O, holds state, or knows what a turn is, which is what lets the Game batch
 * composer use it without dragging the runtime's module graph into every event-pump unit test.
 * </p>
 */

import type { Snapshot } from "./protocol.js";

const SEASON_NAMES_ZH = ["春季", "夏季", "秋季", "冬季"] as const;
const SEASON_NAMES_EN = ["Spring", "Summer", "Fall", "Winter"] as const;

/**
 * The map names a player would say out loud, against the engine's internal asset names.
 *
 * <p>
 * MEASURED 2026-10-31: the fact line published `位置: Town` and the same prompt told her to speak in the player's
 * language, never the game's internal one - so a companion who read `位置: Town` said "我们带着 (T)Hoe 去 Town". The
 * conduct had already been taught to name tools in words; the location was the one fact still arriving as an asset id.
 * </p>
 * <p>
 * Only the maps a companion can reach and would name are listed. An unlisted map keeps its engine name rather than being
 * dropped: an unnamed place is worse than an untranslated one, and `Town` in a sentence is at least true while a missing
 * `位置` would hide where she is standing.
 * </p>
 */
const LOCATION_NAMES_ZH: Record<string, string> = {
  Farm: "农场",
  FarmHouse: "农舍",
  Town: "镇上",
  Beach: "海滩",
  Forest: "森林",
  Mountain: "山区",
  Backwoods: "山间小路",
  BusStop: "巴士站",
  Mine: "矿井",
  UndergroundMine: "矿井",
  SeedShop: "杂货铺",
  JoshHouse: "木匠铺",
  Hospital: "诊所",
  Saloon: "酒馆",
  ArchaeologyHouse: "博物馆",
  Blacksmith: "铁匠铺",
  AnimalShop: "牧场",
  FishShop: "渔具店",
  ManorHouse: "庄园",
  CommunityCenter: "社区中心",
  JojaMart: "乔家超市",
  Railroad: "铁路",
  Desert: "沙漠",
  Greenhouse: "温室",
  Cellar: "地窖",
  Barn: "畜棚",
  BigBarn: "大畜棚",
  DeluxeBarn: "高级畜棚",
  Coop: "鸡舍",
  BigCoop: "大鸡舍",
  DeluxeCoop: "高级鸡舍",
  Shed: "小屋",
  Cabins: "木屋",
  IslandWest: "西岛",
  IslandEast: "东岛",
  IslandSouth: "南岛",
  IslandNorth: "北岛",
  IslandFarmHouse: "海岛小屋",
};

/** The spoken name of a map, falling back to the engine's own for a place this table has not met yet. */
export function formatGameLocation(location: string | undefined, zh: boolean): string {
  if (location === undefined || location.length === 0) return "";
  const name = zh ? (LOCATION_NAMES_ZH[location] ?? location) : location;
  return zh ? `位置: ${name}` : `location: ${name}`;
}

/** The season's own name, spelled once for every renderer that prints a calendar. */
export function seasonName(seasonIndex: number): string {
  return SEASON_NAMES_EN[seasonIndex] ?? "Unknown";
}

/** The map's spoken name alone, for a sentence that already says where it is speaking about. */
export function gameLocationName(location: string | undefined, zh: boolean): string {
  if (location === undefined || location.length === 0) return "";
  return zh ? (LOCATION_NAMES_ZH[location] ?? location) : location;
}

const WEATHER_NAMES_ZH: Record<string, string> = {
  sunny: "晴天",
  rain: "雨天",
  // The 1.6 green-rain day: it IS raining (GameLocation.cs:1445-1452), and it is the day the farm fills with
  // weeds and debris. Naming it "雨天" hides the one fact that explains what the player will find outside.
  green_rain: "绿雨",
  snow: "下雪",
  lightning: "雷雨",
  // `isDebrisWeather` is drifting petals in spring and leaves in autumn - NOT airborne sand. "风沙" told the player
  // the wrong season: a spring afternoon was described as a dust storm.
  debris: "飘花",
  unknown: "未知天气",
};
const WEATHER_NAMES_EN: Record<string, string> = {
  sunny: "sunny",
  rain: "rainy",
  green_rain: "green rain",
  snow: "snowy",
  lightning: "thunderstorm",
  // Not "windy": the native flag is about drifting petals and leaves, and the weather itself is calm.
  debris: "petals drifting",
  unknown: "unknown weather",
};

/**
 * The tools, named the way a person says them. The wire publishes a tool twice: `currentTool` /
 * `toolSlots[].label` are the native item identity (`(T)Hoe`, `(W)47` for a scythe), which is the handle a
 * plan compares against, and `toolSlots[].category` is the Mod's own tool word (`FarmhandActionCatalog.ToolEnum`),
 * which is the word the `tool:<category>` claims and `equip_tool` use. A spoken turn needs the second: measured on
 * a live session, the companion said "我们带着 (T)Hoe 去 Town" because the turn's fact line handed it the identity.
 * English keeps the category word, snake_case turned back into words; Chinese names the tool. A category the
 * tables do not have (an older Mod's `unknown`) keeps the identity, because dropping the fact would hide what she
 * is holding. See `formatHeldTool`.
 */
const TOOL_NAMES_ZH: Record<string, string> = {
  axe: "斧头",
  pickaxe: "十字镐",
  hoe: "锄头",
  watering_can: "洒水壶",
  fishing_rod: "钓竿",
  weapon: "武器",
  scythe: "镰刀",
  shears: "剪刀",
  milk_pail: "挤奶桶",
  pan: "淘金盘",
};
const TOOL_NAMES_EN: Record<string, string> = {
  axe: "axe",
  pickaxe: "pickaxe",
  hoe: "hoe",
  watering_can: "watering can",
  fishing_rod: "fishing rod",
  weapon: "weapon",
  scythe: "scythe",
  shears: "shears",
  milk_pail: "milk pail",
  pan: "pan",
};

/**
 * The native clock, localized like its sibling facts. English keeps the game's
 * own 12h reading (`6:00 PM`); Chinese carries the 24h reading plus the game
 * day's time-of-day band. The band is required, not decorative: the companion's
 * `晚霞收工与作息节律` book entry is gated on `傍晚`/`深夜`, and a 12h `6:00 PM`
 * clock fact contains neither, so without it the clock could never fire that
 * entry. 2600 (2 AM) is the last legal clock.
 */
export function formatGameClock(timeOfDay: number, zh: boolean): string {
  if (!Number.isSafeInteger(timeOfDay) || timeOfDay < 0) return "";
  const h24 = Math.floor(timeOfDay / 100);
  const minute = timeOfDay % 100;
  if (h24 > 26 || minute > 59) return "";
  // 24:00/25:00/26:00 are the late-night wrap hours (2 AM); both the displayed
  // hour and the period are decided on the RAW 24h hour, not the 12h remainder.
  const raw = h24 % 24;
  const padded = (value: number): string => String(value).padStart(2, "0");
  if (zh) return `${padded(raw)}:${padded(minute)}（${chineseTimeOfDayBand(raw)}）`;
  const period = raw < 12 ? "AM" : "PM";
  const h12 = raw % 12 === 0 ? 12 : raw % 12;
  return `${h12}:${padded(minute)} ${period}`;
}

/**
 * The game day's time-of-day bands, keyed on the native hour (0-23 after the
 * wrap). Stardew's day opens at 06:00 and its last legal clock is 02:00 (native
 * 2600), so the bands follow that day rather than a calendar day: the deep-night
 * band wraps across midnight (20:00-04:59), because 24:00-26:00 are the same
 * hours of the same night as 20:00-23:59 and not a new morning.
 */
function chineseTimeOfDayBand(rawHour: number): string {
  if (rawHour >= 5 && rawHour <= 7) return "清晨";
  if (rawHour >= 8 && rawHour <= 11) return "上午";
  if (rawHour >= 12 && rawHour <= 13) return "中午";
  if (rawHour >= 14 && rawHour <= 16) return "下午";
  if (rawHour >= 17 && rawHour <= 19) return "傍晚";
  return "深夜";
}

export function formatGameDate(day: number, seasonIndex: number, year: number, zh: boolean): string {
  // An absent reading is DROPPED, never rendered as `undefined年第undefined天` - the same rule every sibling fact here
  // follows. The wire requires all three, so this only fires for a payload that is not a full snapshot.
  if (!Number.isSafeInteger(day) || !Number.isSafeInteger(seasonIndex) || !Number.isSafeInteger(year)) return "";
  const season = (zh ? SEASON_NAMES_ZH[seasonIndex] : SEASON_NAMES_EN[seasonIndex]) ?? seasonIndex;
  if (zh) return `${year}年第${day}天 ${season}`;
  return `Year ${year}, Day ${day} of ${season}`;
}

export function formatGameWeather(token: string, zh: boolean): string {
  if (typeof token !== "string" || token.length === 0) return "";
  const map = zh ? WEATHER_NAMES_ZH : WEATHER_NAMES_EN;
  const name = map[token] ?? token;
  return zh ? `天气：${name}` : `weather: ${name}`;
}

/**
 * The actor's OWN stamina: the exact current value the native game publishes,
 * never a derived percentage, an invented maximum, or a "you are fine" default.
 * While the native persistent-fatigue flag is set the same fact carries that
 * flag, because the next morning's restore is halved by it. Absent a finite
 * reading the WHOLE fact is omitted - a silent "fine" is worse than silence.
 */
export function formatGameStamina(stamina: number | undefined, exhausted: boolean | undefined, zh: boolean): string {
  if (stamina === undefined || !Number.isFinite(stamina)) return "";
  const value = zh ? `体力: ${stamina}` : `stamina: ${stamina}`;
  if (exhausted !== true) return value;
  return zh ? `${value}（已疲惫）` : `${value} (exhausted)`;
}
/**
 * The world context the companion sees each turn, as the one fact line Magic
 * Context injects: the native clock, date, weather and location, where she
 * stands and what she is holding, the villagers around her, the unwatered crops
 * in reach, and her own stamina. Same rule as every sibling fact - a plain
 * native read, no interpretation - and every fact whose source is absent is
 * dropped rather than defaulted.
 *
 * Two bounds keep this a line and not a second snapshot, because it is rendered
 * on every turn: the nearby names are capped and their remainder is a count, and
 * the joined line is capped in bytes. `stamina` and `tile` are required on
 * today's wire, so their optional spelling only documents the omit path a frame
 * without a readable reading takes.
 */
export type GameEnvironmentFactsSource = Pick<
  Snapshot,
  | "timeOfDay"
  | "dayOfMonth"
  | "seasonIndex"
  | "year"
  | "weather"
  | "location"
  | "tile"
  | "currentTool"
  | "currentToolSlot"
  | "toolSlots"
  | "villagerWhereabouts"
  | "wateringWhereabouts"
  | "chestsSummary"
  | "cropTargets"
  | "cookingStationTargets"
> &
  Readonly<{ stamina?: number; exhausted?: boolean }>;

/**
 * The most this line may cost a turn. Four player names arrive bounded at 128
 * characters each on the wire, which three of them would spend on nothing else.
 */
export const MAX_GAME_ENVIRONMENT_FACTS_BYTES = 512;
/** A town square reaches further than three, and the rest is a count anyway. */
const MAX_NEARBY_VILLAGER_NAMES = 3;
/**
 * "Nearby" is the Mod's own discovery envelope (6 tiles, Chebyshev). A villager
 * across the farm is not next to her, however few others are in the map.
 */
const MAX_NEARBY_VILLAGER_TILES = 6;
/**
 * The villager fact's own share of the line, so it can never crowd another fact out of it.
 *
 * This is NOT what protects her own body: `boundGameEnvironmentFacts` drops world facts before body facts, and
 * a byte share cannot order anything. What this bounds is the fact ITSELF - a crowd of walkable destinations is
 * one fact, and it must not grow until every sibling is gone. Measured: the other world facts cost 155-176 B at
 * their heaviest (deep night, green rain, a farmhouse, and the whole-map watering answer), so this share leaves
 * them room.
 */
const MAX_VILLAGER_FACT_BYTES = MAX_GAME_ENVIRONMENT_FACTS_BYTES / 2;
/** One published name's share of the line; the wire allows 128 characters. */
const MAX_ENVIRONMENT_NAME_CHARS = 16;

function boundedName(value: string): string {
  const characters = Array.from(value);
  return characters.length <= MAX_ENVIRONMENT_NAME_CHARS
    ? value
    : `${characters.slice(0, MAX_ENVIRONMENT_NAME_CHARS - 1).join("")}…`;
}

/** The tile under her feet, in the map's own coordinates. */
function formatGameTile(tile: { readonly x: number; readonly y: number } | undefined, zh: boolean): string {
  if (!Number.isFinite(tile?.x) || !Number.isFinite(tile?.y)) return "";
  return `${zh ? "脚下" : "tile"}: (${String(tile?.x)}, ${String(tile?.y)})`;
}

/**
 * The tool in her hand, named the way the wire's own sibling names it.
 *
 * `currentTool` is the native item identity (`(T)Hoe`), which is the handle a plan compares against and which a
 * spoken turn must never repeat; the same slot's `category` is the Mod's tool word, so the fact reads "hoe" /
 * "锄头". The identity is kept only when no slot publishes a word for it, because an absent name is still better
 * than an absent fact. The upgrade level is only on the wire beside the slot that holds the tool, so it is read
 * from there and only when the two agree - an unmatched slot costs the level and never the name. A basic tool
 * renders no marker: the handlers require the basic one, so a marker is what an upgrade is.
 */
function formatHeldTool(source: GameEnvironmentFactsSource, zh: boolean): string {
  const tool = source.currentTool;
  if (typeof tool !== "string" || tool.length === 0) return "";
  const slot = source.currentToolSlot;
  const occupant =
    typeof slot === "number" && Number.isSafeInteger(slot)
      ? (source.toolSlots ?? []).find((candidate) => candidate.slot === slot)
      : undefined;
  const upgradeLevel = occupant?.label === tool ? occupant.upgradeLevel : undefined;
  const upgrade = Number.isSafeInteger(upgradeLevel) ? (upgradeLevel as number) : 0;
  const level = upgrade > 0 ? (zh ? `（+${upgrade}）` : ` (+${upgrade})`) : "";
  const category = occupant?.category;
  const name = (category === undefined ? undefined : (zh ? TOOL_NAMES_ZH : TOOL_NAMES_EN)[category]) ?? tool;
  return `${zh ? "手持" : "holding"}: ${name}${level}`;
}

/**
 * The villagers standing with her, and the ones she could walk to.
 *
 * `villagerWhereabouts` describes every loaded location, so this reads only the map she is on and splits it at
 * the Mod's own discovery envelope. Inside it, `npcRelationshipTargets` already publishes an address for every
 * villager, so a name is the whole fact. Beyond it that family is empty BY CONSTRUCTION (`TargetDiscoveryRadius`,
 * 6), and a name alone would be a rumour about someone she cannot see.
 *
 * A villager standing on her map past the envelope is a DESTINATION, not a statistic: she can walk there, and
 * the radius-6 family lights up when she arrives. So the far ones are published as `name(x,y)`, nearest first,
 * and the count that remains is what the cap hid rather than what the map holds. Measured 2026-10-31
 * (`round17`): a Town observation carried `npcRelationshipTargets: []` while `villagerWhereabouts` listed
 * Shane in Town, this line said "本图另有 12 人" and named nobody, and the companion spent two trips to Town
 * and called `talk_to_npc` zero times.
 *
 * Both halves are bounded, because this is rendered on every turn: the near names are capped at three, the
 * destinations by the fact's own byte share, and the remainder is always a count - "is anyone here" must stay
 * answerable in both directions.
 */
function formatNearbyVillagers(source: GameEnvironmentFactsSource, zh: boolean): string {
  const tile = source.tile;
  if (tile === undefined || !Number.isFinite(tile.x) || !Number.isFinite(tile.y)) return "";
  const here = (source.villagerWhereabouts ?? []).filter((villager) => villager.inCurrentLocation === true);
  if (here.length === 0) return "";
  const distance = (villager: { readonly x: number; readonly y: number }): number =>
    Math.max(Math.abs(villager.x - tile.x), Math.abs(villager.y - tile.y));
  const ordered = here.sort((left, right) => distance(left) - distance(right));
  const name = (villager: { readonly npcName: string; readonly displayName: string }): string =>
    boundedName(zh ? villager.displayName : villager.npcName);
  const named = ordered
    .filter((villager) => distance(villager) <= MAX_NEARBY_VILLAGER_TILES)
    .slice(0, MAX_NEARBY_VILLAGER_NAMES)
    .map(name);
  // An unreadable tile cannot be a destination: `NaN` in a coordinate is not an address, so such a row stays
  // inside the count rather than being published as somewhere to walk.
  const reachable = ordered.filter(
    (villager) =>
      distance(villager) > MAX_NEARBY_VILLAGER_TILES && Number.isFinite(villager.x) && Number.isFinite(villager.y),
  );
  const destinations: string[] = [];
  const compose = (): string => {
    const segments: string[] = [];
    if (named.length > 0) segments.push(`${zh ? "附近" : "nearby"}: ${named.join(zh ? "、" : ", ")}`);
    if (destinations.length > 0)
      segments.push(`${zh ? "本图可去" : "on this map"}: ${destinations.join(zh ? "、" : ", ")}`);
    const hidden = here.length - named.length - destinations.length;
    if (hidden > 0) segments.push(zh ? `另有 ${hidden} 人` : `${hidden} more`);
    return segments.join(zh ? "；" : "; ");
  };
  for (const villager of reachable) {
    destinations.push(`${name(villager)}(${villager.x},${villager.y})`);
    // The remainder is part of the same fact, so the share has to hold the fact WITH its count.
    if (Buffer.byteLength(compose(), "utf8") > MAX_VILLAGER_FACT_BYTES) {
      destinations.pop();
      break;
    }
  }
  return compose();
}

/**
 * The chests in the location she is standing in: how many, what they hold, how many are full.
 *
 * THE LOCATION'S ANSWER, not the radius-bounded one. `chests` is the entity family and `DiscoverChestStates` bounds it to
 * the Mod's six-tile discovery radius, so counting that list would print `箱子: 0` while standing next to a chest and
 * `chestsSummary` counts a container across the farm - the same false-zero shape `待浇水作物: 0` was (measured
 * 2026-10-31), and the reason this summary exists at all.
 *
 * The line says WHICH LOCATION it counted. A location-wide number is still not a world total, and the `本图`/`this
 * location` qualifier is what keeps a reader from hearing "the farm has 3 chests" from a count taken in the farmhouse.
 *
 * An ABSENT summary means the Mod did not measure it (the container actions were not advertised) and stays silent; a
 * measured zero is the answer to "do I have any chests here" and is printed, so "none here" and "the field never
 * arrived" stay distinguishable.
 */
function formatChestsSummary(source: GameEnvironmentFactsSource, zh: boolean): string {
  const summary = source.chestsSummary;
  if (summary === undefined) return "";
  // The full count is only worth the bytes when it is non-zero: "0 full" spends the line saying nothing the item count
  // did not already say.
  const full = summary.fullCount > 0 ? summary.fullCount : undefined;
  if (zh)
    return full === undefined
      ? `本图箱子: ${summary.chestCount}（物品 ${summary.itemCount}）`
      : `本图箱子: ${summary.chestCount}（物品 ${summary.itemCount}；已满 ${full}）`;
  return full === undefined
    ? `chests here: ${summary.chestCount} (items ${summary.itemCount})`
    : `chests here: ${summary.chestCount} (items ${summary.itemCount}; full ${full})`;
}

/**
 * How many crops need water, and where the nearest one is.
 *
 * THE WHOLE-MAP ANSWER, not the radius-bounded one. This used to count `cropTargets`, which `DiscoverCropTargets` bounds
 * to `TargetDiscoveryRadius` (6) so an out-of-reach target is not offered as an action - correct for a target list and
 * wrong for a count. A farm with 24 dry tiles beyond that radius rendered `待浇水作物: 0`: the prompt stated a total it had
 * never measured. Measured 2026-10-31.
 *
 * `wateringWhereabouts` is published for exactly this reason, beside `harvestWhereabouts` which solved the same problem
 * for harvest. The nearest tile is named so the answer is actionable rather than only true.
 */
function formatUnwateredCrops(source: GameEnvironmentFactsSource, zh: boolean): string {
  const whereabouts = source.wateringWhereabouts;
  if (whereabouts !== undefined) {
    const here = whereabouts.find((entry) => entry.location === source.location);
    if (here !== undefined && here.needsWaterCount > 0)
      return here.nearestX === undefined || here.nearestY === undefined
        ? zh
          ? `待浇水作物: ${here.needsWaterCount}`
          : `unwatered crops: ${here.needsWaterCount}`
        : zh
          ? `待浇水作物: ${here.needsWaterCount}（最近: ${here.nearestX},${here.nearestY}）`
          : `unwatered crops: ${here.needsWaterCount} (nearest: ${here.nearestX},${here.nearestY})`;
    if (whereabouts.length > 0) {
      const elsewhere = whereabouts.map((entry) => `${entry.location}:${entry.needsWaterCount}`).join(", ");
      return zh ? `本图待浇水作物: 0（其他地图: ${elsewhere}）` : `unwatered crops here: 0 (elsewhere: ${elsewhere})`;
    }
    return zh ? "待浇水作物: 0" : "unwatered crops: 0";
  }
  // No whole-map answer: say what was actually observed rather than presenting a bounded count as a total.
  const crops = source.cropTargets;
  if (crops === undefined) return "";
  return zh
    ? `附近待浇水作物: ${crops.length}（仅 6 格内）`
    : `nearby unwatered crops: ${crops.length} (within 6 tiles only)`;
}

/**
 * Whether the map she is standing on has a kitchen.
 *
 * `cookingStationTargets` is the Mod's own scan of the CURRENT map for the vanilla kitchen action tile
 * (`DiscoverCookingStationTargets`), so it is the world's answer to "is there a stove here". It is also the only
 * published answer to the farmhouse's own form: the house gains its kitchen WITH its upgrade, so a fact rendered
 * from this list follows the house instead of stating a fixed fact that becomes a lie the day it is upgraded.
 * Measured 2026-11-05 (day 2, 18:00, starter farmhouse): "六点了，锅里没东西可下，我烧壶水泡点茶对付一口算了" -
 * nothing in the line contradicted the pot, so the pot was invented.
 *
 * ABSENT means the Mod did not measure it, because the family is published only while `cook_recipe` is
 * advertised, and it stays silent; a measured empty list is the answer this fact exists for, exactly as a
 * measured `chestsSummary` zero is. A placed cookout kit is not this fact: the kit is not the house's kitchen.
 */
function formatKitchen(source: GameEnvironmentFactsSource, zh: boolean): string {
  const stations = source.cookingStationTargets;
  if (stations === undefined) return "";
  const hasKitchen = stations.some((station) => station.stationKind === "kitchen");
  if (zh) return hasKitchen ? "厨房: 有" : "厨房: 无";
  return hasKitchen ? "kitchen: yes" : "kitchen: none";
}

/** Which half of the line one fact speaks about: the world she stands in, or her own body. */
type GameEnvironmentFactSubject = "world" | "body";

/**
 * One rendered fact and the half of the line it speaks about.
 *
 * The subject is declared BESIDE the fact it describes, because it is the one thing `boundGameEnvironmentFacts`
 * reads to decide what the byte cap spends first. A fact added to `composeGameEnvironmentFacts` therefore has to
 * state its subject, which is what keeps the drop order a decision instead of the composition order by accident.
 */
export type GameEnvironmentFact = Readonly<{ text: string; subject: GameEnvironmentFactSubject }>;

/** A fact about the world she stands in: the clock, the map, who is near, what is ready. */
function worldFact(text: string): GameEnvironmentFact {
  return { text, subject: "world" };
}

/** A fact about her own body - what she is holding, her stamina - which the line must lose last. */
function bodyFact(text: string): GameEnvironmentFact {
  return { text, subject: "body" };
}

/**
 * Drops whole facts while the line is over its byte cap. Every fact is dropped rather than
 * truncated: half a name reads as a shorter name.
 *
 * THE DROP ORDER IS DECLARED, NOT THE ORDER THE FACTS HAPPEN TO BE COMPOSED IN: world facts go first, from the
 * end of the line backwards, and the facts about her own BODY are dropped only once no world fact is left. The
 * accidental order spent stamina first, because it is composed last - so the one fact about her body was what a
 * long world line cost her. An arithmetic argument that the rest "fits" cannot hold the line: a snapshot can
 * always hand it one more world fact than it has room for (the interactable-tiles block is the next one), while
 * the subject declared beside each fact is a rule a new fact cannot be added without answering.
 *
 * It also reports WHAT it dropped, in the order the facts appear in the line. The rendered line cannot say what
 * was cut out of it (`joinBoundedFacts` only ever returns the survivors), so "did the block ever exceed the cap,
 * and what was lost" is answerable only from here - which is why the observer below is built on this rather than
 * on the joined string.
 */
function boundGameEnvironmentFacts(
  facts: readonly GameEnvironmentFact[],
): Readonly<{ kept: string[]; dropped: string[] }> {
  const bytesOf = (kept: readonly GameEnvironmentFact[]): number =>
    Buffer.byteLength(kept.map((fact) => fact.text).join("；"), "utf8");
  const kept = [...facts];
  // Both lists are copies, so reversing them cannot touch the caller's own composition order.
  const dropOrder = [
    ...facts.filter((fact) => fact.subject === "world").reverse(),
    ...facts.filter((fact) => fact.subject === "body").reverse(),
  ];
  const dropped: GameEnvironmentFact[] = [];
  for (const fact of dropOrder) {
    if (kept.length <= 1 || bytesOf(kept) <= MAX_GAME_ENVIRONMENT_FACTS_BYTES) break;
    kept.splice(kept.lastIndexOf(fact), 1);
    dropped.push(fact);
  }
  return {
    kept: kept.map((fact) => fact.text),
    dropped: dropped.sort((left, right) => facts.indexOf(left) - facts.indexOf(right)).map((fact) => fact.text),
  };
}

function joinBoundedFacts(facts: readonly GameEnvironmentFact[]): string {
  return boundGameEnvironmentFacts(facts).kept.join("；");
}

/**
 * Every fact this snapshot could render, in the order the line prints them, each with the half of the line it
 * speaks about.
 *
 * Two of them are about her own BODY - what she is holding and her stamina - and they keep the positions they
 * have always had, because the line's reading order is a product decision. Its LOSS order is the invariant: see
 * `boundGameEnvironmentFacts`.
 */
export function composeGameEnvironmentFacts(
  source: GameEnvironmentFactsSource,
  zh: boolean,
): readonly GameEnvironmentFact[] {
  return [
    worldFact(formatGameClock(source.timeOfDay, zh)),
    worldFact(formatGameDate(source.dayOfMonth, source.seasonIndex, source.year, zh)),
    worldFact(formatGameWeather(source.weather, zh)),
    worldFact(`${formatGameLocation(source.location, zh)}`),
    worldFact(formatGameTile(source.tile, zh)),
    worldFact(formatKitchen(source, zh)),
    bodyFact(formatHeldTool(source, zh)),
    worldFact(formatNearbyVillagers(source, zh)),
    worldFact(formatUnwateredCrops(source, zh)),
    worldFact(formatChestsSummary(source, zh)),
    bodyFact(formatGameStamina(source.stamina, source.exhausted, zh)),
  ].filter((fact) => fact.text !== "");
}

export function formatGameEnvironmentFacts(source: GameEnvironmentFactsSource, zh: boolean): string {
  const facts = composeGameEnvironmentFacts(source, zh);
  return facts.length === 0 ? "" : joinBoundedFacts(facts);
}

/** One rendered block plus what the byte cap cost it, as the record's reader needs it. */
export type GameEnvironmentFactsRender = Readonly<{
  /** The exact line the provider returns; `""` when the snapshot carries no facts at all. */
  text: string;
  bytes: number;
  /** Facts the cap dropped, in the order the line prints them. World facts are spent before body facts. */
  dropped: readonly string[];
}>;

/**
 * The same line `formatGameEnvironmentFacts` prints, with the parts of it a READER cannot recover:
 * its exact byte cost and the facts the cap removed to reach it.
 *
 * Deliberately shares every formatter with `formatGameEnvironmentFacts` rather than re-deriving the
 * facts: two implementations of the same line would let the record disagree with the prompt it claims
 * to describe, which is the one thing that would make this record worthless.
 */
export function renderGameEnvironmentFactsObservation(
  source: GameEnvironmentFactsSource,
  zh: boolean,
): GameEnvironmentFactsRender {
  const bounded = boundGameEnvironmentFacts(composeGameEnvironmentFacts(source, zh));
  const text = bounded.kept.join("；");
  return Object.freeze({ text, bytes: Buffer.byteLength(text, "utf8"), dropped: Object.freeze(bounded.dropped) });
}

// ---------------------------------------------------------------------------------------------------------------
// The nearby target families.
//
// WHY THIS EXISTS AT ALL. Measured 2026-11-10 (`round44`): 31 of 109 turns called `stardew_observe`, and a snapshot was
// already in the batch that opened 28 of them. So the per-turn state block was not missing - it was missing the thing
// she acts ON. Zero of those 31 batches named a single target tile, because every family below was withheld from the
// per-turn block on the argument that a 64-row family is ~5.7 KB (`snapshot-projection-coverage.ts`). The argument was
// right about the bytes and wrong about the answer: she asked the Mod for the objects, 25 s a turn, 53% of a run.
//
// WHAT REPLACES IT. Coordinates only, nearest first, six per family, with the remainder COUNTED. A family of 64 weed
// tiles prints as 36 bytes instead of 5.7 KB, and the observation is then a refinement rather than the first look.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The Chinese noun for every coordinate family the wire publishes.
 *
 * THE POPULATION IS THE WIRE'S ROW SHAPE, not this table and not a name suffix: `fact-brief.private.test.ts` reads
 * `protocol/bridge-v1.schema.json` for the array families whose rows carry `x` and `y` - the two keys this line prints -
 * and fails by name when one of them has no label here and no entry in `NON_ROW_FAMILIES`. The gate this replaces
 * filtered `SNAPSHOT_KEYS` on `/(?:Targets|Sites|Slots)$/`, which could not see `soilTiles` - the only family spelled
 * `*Tiles`, and the whole target list of `till_soil` - so the one ground she can hoe was structurally unprintable.
 */
export const TARGET_FAMILY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  doorTargets: "门",
  refillWateringCanTargets: "可灌满水的地方",
  waterTargets: "可下竿的水面",
  forageTargets: "可捡的野物",
  itemTargets: "地上的物品",
  cropTargets: "待浇水的作物",
  petBowlTargets: "宠物碗",
  slimeHutchTroughTargets: "史莱姆槽",
  harvestTargets: "可收的作物",
  seedTargets: "已播种的地",
  fertilizerTargets: "可施肥的地",
  woodFenceTargets: "木栅栏",
  woodFenceResultTargets: "栅栏改过的位置",
  crabPotTargets: "蟹笼",
  crabPotResultTargets: "蟹笼里的东西",
  crabPotCollectTargets: "有货的蟹笼",
  baitCrabPotTargets: "可投饵的蟹笼",
  baitCrabPotResultTargets: "投过饵的蟹笼",
  debrisTargets: "杂草碎石",
  rockSourceTargets: "石头",
  clearHoeDirtTargets: "可清的地块",
  soilTiles: "可锄的地块",
  artifactSpotTargets: "可疑的土堆",
  artifactSpotResultTargets: "挖开过的土堆",
  machineTargets: "机器",
  treeChopSourceTargets: "可砍的树",
  treeChopResultTargets: "砍倒的树",
  treeStumpTargets: "树桩",
  treeSaplingTargets: "小树苗",
  weedTargets: "杂草",
  grassTargets: "草丛",
  caskTargets: "木桶",
  mannequinTargets: "人形架",
  signTargets: "告示牌",
  siloTargets: "筒仓",
  lanternSlots: "灯笼位",
  scytheCropTargets: "可割的作物",
  npcRelationshipTargets: "村民",
  petTargets: "宠物",
  farmAnimalPetTargets: "可摸的牲畜",
  animalProductTargets: "可收的畜产品",
  feedTroughTargets: "饲料槽",
  chests: "箱子",
  foodTargets: "食物",
  shippingBinTargets: "出货箱",
  craftingRecipeTargets: "可做的配方",
  cookingRecipeTargets: "可做的菜",
  cookingStationTargets: "灶台",
  shopTargets: "商店",
  seedSupplyTargets: "卖种子的地方",
  mineElevatorFloorTargets: "矿洞电梯",
  animalDoorTargets: "畜舍门",
  fishPondTargets: "鱼塘",
  buildingChestTargets: "建筑里的箱子",
  obeliskTargets: "方尖碑",
  minecartTargets: "矿车",
  bushTargets: "灌木",
  fruitTreeTargets: "果树",
  shakeTreeTargets: "可摇的树",
  pedestalTargets: "基座",
  fenceGateTargets: "栅栏门",
  worldObjectTargets: "可交互的物件",
  farmBuildingTargets: "农场建筑",
  dailyQuestTargets: "日常委托",
  specialOrderTargets: "特别订单",
  museumRewardTargets: "博物馆奖励",
  colorTargets: "可染色处",
  tailoringTargets: "缝纫台",
  wearableTargets: "可穿的衣物",
  warpItemTargets: "传送物品",
  panSites: "可淘金点",
  mailboxTargets: "邮箱",
  raftTargets: "木筏",
  horseTargets: "马",
  mineEntranceTargets: "矿洞入口",
});

/**
 * The wire families the nearby-target line does not print as rows, each with the reason it is not one.
 *
 * Not an exemption from the label table: the gate above refuses a coordinate family with neither, so a family has to
 * answer here too. A reason naming another renderer is the record that someone looked at where the fact does print;
 * a reason nobody can check any more is a second spelling of a withheld fact.
 */
export const NON_ROW_FAMILIES: Readonly<Record<string, string>> = Object.freeze({
  inventorySlots: "a capacity number; the pack itself is rendered from `inventoryItemFacts`",
  toolSlots: "the tool bag; the HELD tool is rendered by `formatHeldTool` and the rest are labels, not places",
  villagerWhereabouts:
    "every loaded map's villagers, printed by `formatNearbyVillagers` on this same line; `npcRelationshipTargets` is the radius-bounded family an action names",
  fixedInteractionPoints:
    "the map's own fixed interaction points - a mine ladder, a bed - each with a closed `kind`. No published action declares it as its target family (`mineEntranceTargets` and `doorTargets` are the families actions name), so it reaches her through the observation instead of the per-turn line",
});

/** Tiles one family names before it counts the rest. Six fits a plan; a 64-row patch does not fit a prompt. */
export const MAX_TARGET_TILES_SHOWN = 6;

/** Families the line names before it counts the rest. The non-empty ones are taken first. */
export const MAX_TARGET_FAMILIES_SHOWN = 12;

/** Families named on a counting line - the one "nothing here" line, or the one the family cap left out - before that line counts the rest. */
export const MAX_COUNTED_FAMILIES_NAMED = 8;

/** One family the snapshot published, as the state line prints it. */
export type NearbyTargetFamily = Readonly<{
  /** The wire key the rows came from, so a reader can check the label against it. */
  family: string;
  label: string;
  /** The nearest tile by Chebyshev distance from her own, or `undefined` for a family with no readable tile. */
  nearest: Readonly<{ x: number; y: number; distance: number }> | undefined;
  /** How many rows the family published. */
  total: number;
  /** How many this line did not name: the cap, plus any row that carried no coordinate. */
  omitted: number;
  /** `undefined` for a family with rows the Mod published but did not address. */
  rendered: string | undefined;
}>;

/**
 * Every target family the snapshot published, nearest first, with what the caps cost it.
 *
 * ORDER: Chebyshev distance from her tile, then x, then y. Three keys, not two, because a farm row is a line of tiles
 * at equal distance - without the coordinate tie-break the six named tiles of a row would depend on the wire array's
 * order, and two snapshots of the same field would render two different sentences.
 *
 * ABSENT vs EMPTY: a family the snapshot does not carry is `undefined` here and prints NOTHING - the Mod did not
 * measure it. A family carried as `[]` is published and empty, which is a fact about the world ("nothing ripe here")
 * and prints as such. This is the oldest lesson in this repository and the reason `rendered` is optional rather than `""`.
 */
export function nearbyTargetFamilies(snapshot: Snapshot): readonly NearbyTargetFamily[] {
  const actor = snapshot.tile;
  const readable = Number.isFinite(actor?.x) && Number.isFinite(actor?.y);
  const families: NearbyTargetFamily[] = [];
  for (const [family, label] of Object.entries(TARGET_FAMILY_LABELS)) {
    const value = (snapshot as unknown as Record<string, unknown>)[family];
    if (!Array.isArray(value)) continue;
    const tiles: { x: number; y: number }[] = [];
    for (const row of value) {
      if (row === null || typeof row !== "object") continue;
      const candidate = row as { x?: unknown; y?: unknown };
      if (typeof candidate.x !== "number" || typeof candidate.y !== "number") continue;
      if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) continue;
      tiles.push({ x: candidate.x, y: candidate.y });
    }
    const distance = (tile: { x: number; y: number }): number =>
      readable ? Math.max(Math.abs(tile.x - actor.x), Math.abs(tile.y - actor.y)) : 0;
    tiles.sort((left, right) => distance(left) - distance(right) || left.x - right.x || left.y - right.y);
    const shown = tiles.slice(0, MAX_TARGET_TILES_SHOWN);
    const omitted = value.length - shown.length;
    const nearest = shown[0] === undefined ? undefined : { ...shown[0], distance: distance(shown[0]) };
    const rendered =
      value.length === 0
        ? undefined
        : shown.length === 0
          ? undefined
          : `${label} ${shown.map((tile) => `(${tile.x},${tile.y})`).join(" ")}${
              omitted > 0 ? ` 其余 ${omitted} 格未列出` : ""
            }`;
    families.push(Object.freeze({ family, label, nearest, total: value.length, omitted, rendered }));
  }
  return Object.freeze(families);
}
