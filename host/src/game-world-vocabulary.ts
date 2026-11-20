/**
 * The words a Game turn uses for the world, in one place.
 *
 * <p>
 * This module exists because the same fact had two spellings and a third was about to be added. The map, weather, tool,
 * season and clock tables lived inside `runtime-core.internal.ts`, while `snapshot-hud.ts` - deleted in `90b1cabf` -
 * rendered the season from a second array of its own and the clock as a bare `06:20`; a per-turn block assembled from
 * either would have had to pick a spelling per line.
 * </p>
 *
 * <p>
 * So the vocabulary MOVED here - it is not a copy. `runtime-core.internal.ts` imports these for the Chat-visible
 * `<runtime-environment>` line, `fact-brief.ts` imports them for the Game turn's world-state block, and one table is
 * what both read. Nothing here does I/O, holds state, or knows what a turn is, which is what lets the Game batch
 * composer use it without dragging the runtime's module graph into every event-pump unit test.
 * </p>
 */

import type { Snapshot, TileAreaResult, TileAreaRow } from "./protocol.js";

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
export const LOCATION_NAMES_ZH: Readonly<Record<string, string>> = Object.freeze({
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
});

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
 * English keeps the category word, snake_case turned back into words; Chinese names the tool. A category the tables do
 * not have (an older Mod's `unknown`) names no tool at all - `一件工具` - rather than falling back to the identity: the
 * identity is a handle an argument copies, and a sentence that prints it is the line that taught her to say it. Nothing
 * addressable is lost, because a handle with no category is one `equip_tool` refuses anyway. See `formatHeldTool`.
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
  if (!(Number.isSafeInteger(day) && Number.isSafeInteger(seasonIndex) && Number.isSafeInteger(year))) return "";
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
 *
 * <p>
 * ONE DISPLAY PRECISION, STATED HERE: a tenth. The wire publishes the native `float` unchanged, so the game's own
 * tenths arrive carrying representation noise - measured 2026-11-25 (`round77`) the prompt read `体力: 254.20001`,
 * then `63.699966`, `245.90004`, `73.80031`, `65.10014`, five numbers whose last three to five digits are arithmetic
 * rather than the world. All five are tenths plus that noise, so a tenth is INFORMATION-PRESERVING: nothing the
 * engine spends is lost. It is also the whole range - `0`, `0.1`, `1` and a full `270` stay four different facts, so
 * drained, nearly drained and fresh remain distinguishable, which a whole-number reading would spend at the bottom of
 * the bar.
 * </p>
 */
export function formatGameStamina(stamina: number | undefined, exhausted: boolean | undefined, zh: boolean): string {
  if (stamina === undefined || !Number.isFinite(stamina)) return "";
  // Rounding in TENTHS rather than dividing by 0.1: `x / 0.1 * 0.1` reintroduces the noise it was meant to remove
  // (`254.20001` -> `254.20000000000002`), while an integer count of tenths prints its shortest exact spelling.
  const tenths = Math.round(stamina * STAMINA_TENTHS_PER_UNIT);
  const shown = String(tenths / STAMINA_TENTHS_PER_UNIT);
  const value = zh ? `体力: ${shown}` : `stamina: ${shown}`;
  if (exhausted !== true) return value;
  return zh ? `${value}（已疲惫）` : `${value} (exhausted)`;
}

/** The tenths one unit of the stamina reading is shown at: the game's own spending precision, and the noise's floor. */
const STAMINA_TENTHS_PER_UNIT = 10;
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
  | "chests"
  | "colorTargets"
  | "worldObjectTargets"
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
  if (!(Number.isFinite(tile?.x) && Number.isFinite(tile?.y))) return "";
  return `${zh ? "脚下" : "tile"}: (${String(tile?.x)}, ${String(tile?.y)})`;
}

/**
 * The tool in her hand, named the way the wire's own sibling names it.
 *
 * `currentTool` is the native item identity (`(T)Hoe`), which is the handle a plan compares against and which a
 * spoken turn must never repeat; the same slot's `category` is the Mod's tool word, so the fact reads "hoe" /
 * "锄头". The identity prints NOWHERE, not even as a fallback. The upgrade level is only on the wire beside the slot
 * that holds the tool, so it is read from there and only when the two agree - an unmatched slot costs the level and
 * never the name. A basic tool renders no marker: the handlers require the basic one, so a marker is what an upgrade is.
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
  const name =
    (category === undefined ? undefined : (zh ? TOOL_NAMES_ZH : TOOL_NAMES_EN)[category]) ??
    (zh ? "一件工具" : "a tool");
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
 *
 * ONE PREDICATE, SO THIS LINE HAS NOTHING TO EXPLAIN. It used to do more than print: when the count came out smaller
 * than the chest rows the same observation carried, it appended `这次观察还列出 3 个箱子 (2,10)…，本图的计数没算它们` - a
 * sentence reporting an argument between two predicates as if the world had said both halves. Measured 2026-11-18
 * (`round76`): the FarmHouse printed 「本图箱子: 0（物品 0）」 beside three chests it listed itself. The Mod now answers
 * "is this a chest" once, through `TryDescribePlacedChest`, for the summary and the row families alike, so the count
 * cannot be smaller than the rows beside it and a wrapper that narrated the difference would be the lie it describes.
 */
function formatChestsSummary(source: GameEnvironmentFactsSource, zh: boolean): string {
  const summary = source.chestsSummary;
  if (summary === undefined) return "";
  // The full count is only worth the bytes when it is non-zero: "0 full" spends the line saying nothing the item count
  // did not already say.
  const full = summary.fullCount > 0 ? summary.fullCount : undefined;
  return zh
    ? full === undefined
      ? `${CHEST_COUNT_FIELD_ZH}: ${summary.chestCount}（物品 ${summary.itemCount}）`
      : `${CHEST_COUNT_FIELD_ZH}: ${summary.chestCount}（物品 ${summary.itemCount}；已满 ${full}）`
    : full === undefined
      ? `chests here: ${summary.chestCount} (items ${summary.itemCount})`
      : `chests here: ${summary.chestCount} (items ${summary.itemCount}; full ${full})`;
}

/**
 * The one spelling of the chest-count field's label, so the line the model reads and the gate that reads the line are
 * the same name: a gate whose literal drifted from the rendered word would scan a block for a field that is no longer
 * in it and report agreement with itself.
 */
export const CHEST_COUNT_FIELD_ZH = "本图箱子";

/**
 * The game's own identity for a Chest big craftable: what a placed chest IS on the wire (`qualifiedItemId`).
 *
 * A name would be the wrong key twice over: `displayName` is the game's localized string, and `worldObjectTargets`
 * carries furniture of every kind - so the only thing that tells the room's chests from its bed in that family is the
 * item the row stands for.
 */
const CHEST_QUALIFIED_ITEM_ID = "(BC)130";

/**
 * The chests THIS observation named, as tiles: the population the agreement gate holds the count line to.
 *
 * <p>
 * Three families publish a placed chest - `chests` (the radius-bounded container family), `colorTargets` (the repaint
 * action addresses chests by definition) and `worldObjectTargets` (the furniture family, where a house's chests arrive
 * beside its bed). A chest can be in more than one of them, which is why the tiles are deduplicated rather than added:
 * the question is "how many chests did this observation name", not "how many rows".
 * </p>
 * <p>
 * `buildingChestTargets` is deliberately NOT here. Those rows are a building's OWN internal chest (a Mill's input),
 * which never enters the location's object layer and so is not one of the location's containers - counting it here
 * would manufacture the very disagreement this reads for.
 * </p>
 */
export function observationChestTiles(
  source: Partial<Pick<Snapshot, "location" | "chests" | "colorTargets" | "worldObjectTargets">>,
): readonly Readonly<{ x: number; y: number }>[] {
  const here = source.location;
  const tiles = new Map<string, Readonly<{ x: number; y: number }>>();
  const add = (row: Readonly<{ x: number; y: number; location?: string }>): void => {
    if (!(Number.isFinite(row.x) && Number.isFinite(row.y))) return;
    if (row.location !== undefined && row.location !== here) return;
    tiles.set(`${row.x},${row.y}`, Object.freeze({ x: row.x, y: row.y }));
  };
  // `chests` rows describe `snapshot.location` by construction and carry no `location` of their own.
  for (const row of source.chests ?? []) add(row);
  for (const row of source.colorTargets ?? []) add(row);
  for (const row of source.worldObjectTargets ?? []) if (row.qualifiedItemId === CHEST_QUALIFIED_ITEM_ID) add(row);
  return Object.freeze([...tiles.values()]);
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
 * How many crops are ready to pick, and where the nearest one is.
 *
 * THE SAME QUADRANT, ONE CROP LATER. `harvestWhereabouts` was already published and already validated, and nothing
 * rendered it - so the only way to learn that anything was ripe was a full `stardew_observe`, and a companion who had
 * just finished watering had no per-turn signal that the crop it walked past was ready.
 *
 * It lived in `snapshot-hud.ts`, a per-turn block whose only reader was a `typeof` guard, so the fact reached nobody for
 * as long as that block existed. The block is gone; the fact is here, in the paragraph the companion actually reads.
 *
 * The whole-map count is the Mod's own scan, and the nearest tile is named so the answer is actionable rather than only
 * true - the same shape as `formatUnwateredCrops` beside it.
 */
export function formatRipeCrops(
  source: Pick<GameEnvironmentFactsSource, "location"> & Partial<Pick<Snapshot, "harvestWhereabouts">>,
  zh: boolean,
): string {
  const whereabouts = source.harvestWhereabouts;
  if (whereabouts === undefined) return "";
  const here = whereabouts.find((entry) => entry.location === source.location);
  if (here !== undefined && here.readyForHarvestCount > 0)
    return here.nearestX === undefined || here.nearestY === undefined
      ? zh
        ? `可收作物: ${here.readyForHarvestCount}`
        : `ripe crops: ${here.readyForHarvestCount}`
      : zh
        ? `可收作物: ${here.readyForHarvestCount}（最近: ${here.nearestX},${here.nearestY}）`
        : `ripe crops: ${here.readyForHarvestCount} (nearest: ${here.nearestX},${here.nearestY})`;
  if (whereabouts.length === 0) return zh ? "可收作物: 无" : "ripe crops: none";
  const elsewhere = whereabouts.map((entry) => `${entry.location}:${entry.readyForHarvestCount}`).join(", ");
  return zh ? `本图可收作物: 0（其他地图: ${elsewhere}）` : `ripe crops here: 0 (elsewhere: ${elsewhere})`;
}

/**
 * What a held body asks of the next turn, in the answers the wire's own facts can support.
 *
 * `await_settlement` is an execution of ours holding the actor (the modal it opened is closing it), `retry_now` is a
 * hold the Mod itself promises to release inside its own retry window, `next_turn` is a hold nothing short of the engine
 * ending it can lift (a cutscene, a day transition, a faint), and `unknown` is the honest answer when the snapshot
 * publishes no holder.
 */
export type BodyWayForward = "await_settlement" | "retry_now" | "next_turn" | "unknown";

/** One hold as the line renders it: what the wire names, whether a command can take the body, and what to do next. */
type BodyHold = Readonly<{ takeover: boolean | undefined; next: BodyWayForward }>;

/**
 * The way out of each hold, keyed on the wire's closed `actorDispositionKind` set (`WorldModel.KindForWire`).
 *
 * THE SAME DECISION TABLE AS THE MOD'S OWN ADMISSION, stated where the model reads it. `WorldModel.HoldReasonCode` and
 * `ExecutionAdmission` already answer "may this command run" from these five kinds, and until now the per-turn line
 * answered it with `身体: 忙（modal）` - the holder and nothing else. Measured 2026-11-13 (`round47`, her own account):
 * "entering the farmhouse the state became 身体: 忙（不可行动）, I read 'body busy' as 'nothing may be submitted this
 * turn', and so I stopped submitting anything. That was my mistake: body busy means the engine is holding the actor;
 * what I should have done is look at the state, wait for the settlement, and see when it releases - not give up by
 * default." A label that names no way out reads as a prohibition, and she read it as one.
 *
 * `modal` is the only kind split by another field: `actorDispositionActionOwned` is the Mod's own statement that the
 * mounted modal belongs to an execution we started (it is closing it, so the release is that execution's settlement),
 * and a modal nobody owns has to be answered or closed by the world before the body is free again.
 */
const BODY_HOLDS: Readonly<Record<string, BodyHold>> = Object.freeze({
  modal: Object.freeze({ takeover: false, next: "next_turn" }),
  event: Object.freeze({ takeover: false, next: "next_turn" }),
  pass_out: Object.freeze({ takeover: false, next: "next_turn" }),
  transient: Object.freeze({ takeover: true, next: "retry_now" }),
});

/** The modal an execution of ours opened: it is being closed by that execution, so waiting is the way forward. */
const MODAL_OWNED_BY_ACTION: BodyHold = Object.freeze({ takeover: false, next: "await_settlement" });

/** The hold nothing names: the snapshot says the body is not actionable and does not say what holds it. */
const BODY_HOLD_UNKNOWN: BodyHold = Object.freeze({ takeover: undefined, next: "unknown" });

export const BODY_WAY_FORWARD_ZH: Readonly<Record<BodyWayForward, string>> = Object.freeze({
  await_settlement: "等结算",
  retry_now: "重试可行",
  next_turn: "下一回合",
  unknown: "未知",
});

export const BODY_WAY_FORWARD_EN: Readonly<Record<BodyWayForward, string>> = Object.freeze({
  await_settlement: "await settlement",
  retry_now: "retry is possible",
  next_turn: "later turn",
  unknown: "unknown",
});

/**
 * The body as one line: what holds it, whether a command can take it, and what to do next.
 *
 * Deliberately not `activeExecution`: that key is withheld from the always-on block by name ("the Host already owns
 * execution state from action receipts"), and an action id here would read as an instruction to repeat the previous
 * turn rather than as a description of the body. `actionable` plus the disposition answer the question from facts that
 * are already projected every turn.
 *
 * ABSENT MEANS THE MOD DID NOT PROJECT THE BODY: with no `actionable` and no disposition the line says nothing, rather
 * than claiming "free". A read that is PRESENT but unexplained says `未知` for the half it cannot answer - a body whose
 * `actionable` is false while no disposition names the holder prints `持有: 未知 · 下一步: 未知`, because "cannot act"
 * without a holder or a way out is the reading that made her stop submitting. The wire's five kinds are the population;
 * a kind this table has not met renders its own name and `未知` rather than a guessed hold, so a Mod that adds one is
 * visible in the line instead of silently mistranslated.
 */
export function formatBodyState(
  source: Partial<
    Pick<
      Snapshot,
      | "actionable"
      | "actorDispositionKind"
      | "actorDispositionDetail"
      | "actorDispositionActionOwned"
      | "activeExecution"
    >
  >,
  zh: boolean,
): string {
  const disposition = source.actorDispositionKind;
  const named = disposition !== undefined && disposition !== "idle" ? disposition : undefined;
  const execution = source.activeExecution ?? null;
  if (named === undefined) {
    // HER OWN EXECUTION IS NOT A HOLD, AND IT IS NOT FREE EITHER. `actionable` answers "may a command be admitted" and
    // the disposition answers "what is holding the body"; a programme of hers holds neither. So a companion walking to a
    // tile read `身体: 空闲` on every turn of a nine-node plan (measured 2026-11-18, `round76`, mid-`plan_319`) and drew
    // the only conclusion the line allowed - that nothing was running - then submitted the same work a second time. The
    // Mod publishes the in-flight execution on the snapshot itself (`activeExecution`, one row, `ownerKind` and
    // `interruptible` included), so this line can say what she is doing WHILE SHE DOES IT instead of after the settlement.
    if (execution !== null) return bodyExecutingLine(execution, zh);
    if (source.actionable === undefined) return "";
    if (source.actionable) return zh ? "身体: 空闲" : "body: free";
    // THREE `未知` IN A ROW IS A FIELD READ THAT DOES NOT SAY WHY IT COULD NOT BE READ. The snapshot states that the
    // body cannot act and names no holder, which is a different fact from "the holder is unknown" - so the holder half
    // says which field the Mod did not publish. The takeover half then follows from it: a body nobody was named for is
    // not one a command can be said to take over.
    return bodyHoldLine(
      BODY_HOLD_UNKNOWN,
      zh
        ? "未知（快照没说谁占着：actorDispositionKind 没发布）"
        : "unknown (the snapshot named no holder: actorDispositionKind was not published)",
      zh,
    );
  }
  const hold =
    named === "modal" && source.actorDispositionActionOwned === true ? MODAL_OWNED_BY_ACTION : BODY_HOLDS[named];
  const detail = source.actorDispositionDetail;
  const holder = typeof detail === "string" && detail.length > 0 ? `${named}/${detail}` : named;
  // A KIND THIS TABLE HAS NOT MET: the kind is named, and the half that cannot answer says so.
  const why =
    hold === undefined
      ? zh
        ? `（这张表还没有 ${named} 这个持有者的出口）`
        : ` (this table has no way out for ${named})`
      : undefined;
  return bodyHoldLine(hold ?? BODY_HOLD_UNKNOWN, holder, zh, why);
}

/**
 * Her own execution, in the words the rest of the line uses: what it is doing, whether a command can take the body,
 * and what releases it.
 *
 * The action and the state are the Mod's own (`activeExecution.action`/`.state`), the phase is its `approaching`/
 * `committed` distinction where it names one, and `interruptible` is the Mod's answer to the takeover question - never
 * a guess from the action id, which is why an absent flag prints `未知` with its reason rather than `否`.
 */
function bodyExecutingLine(execution: NonNullable<Snapshot["activeExecution"]>, zh: boolean): string {
  const phase = typeof execution.phase === "string" && execution.phase.length > 0 ? `/${execution.phase}` : "";
  const takeover = execution.interruptible === undefined ? "未知" : execution.interruptible ? "是" : "否";
  const why =
    execution.interruptible === undefined
      ? zh
        ? "（快照没发布 interruptible）"
        : " (the snapshot published no interruptible flag)"
      : "";
  return zh
    ? `身体: 执行中 ${execution.action}（${execution.state}${phase}） · 可由指令接管: ${takeover}${why} · 下一步: ${
        execution.interruptible === true ? BODY_WAY_FORWARD_ZH.retry_now : BODY_WAY_FORWARD_ZH.await_settlement
      }`
    : `body: running ${execution.action} (${execution.state}${phase}) · command can take over: ${
        execution.interruptible === true ? BODY_WAY_FORWARD_EN.retry_now : BODY_WAY_FORWARD_EN.await_settlement
      }${why}`;
}

/** The line a hold renders as, so each of its three halves is spelled once. */
function bodyHoldLine(hold: BodyHold, holder: string, zh: boolean, unknownWhy = ""): string {
  const takeover =
    hold.takeover === undefined
      ? `${zh ? BODY_WAY_FORWARD_ZH.unknown : BODY_WAY_FORWARD_EN.unknown}${unknownWhy}`
      : hold.takeover
        ? zh
          ? "是"
          : "yes"
        : zh
          ? "否"
          : "no";
  const next = (zh ? BODY_WAY_FORWARD_ZH : BODY_WAY_FORWARD_EN)[hold.next];
  return zh
    ? `身体: 忙 · 持有: ${holder} · 可由指令接管: ${takeover} · 下一步: ${next}`
    : `body: busy · held by: ${holder} · command can take over: ${takeover} · next: ${next}`;
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
 * The target families whose label NAMES A PLACE, with the map it names and the role word that follows that name.
 *
 * ONE WORD PER PLACE, AND IT IS THE WORLD'S. MEASURED `round77`, day 2: the block printed `矿洞入口` over the mine
 * entrance, she copied the place word out of it as `stardew_find_destination("矿洞")`, and the answer was
 * `乔迪，肯特和山姆的家` - a villager's house - because no destination declares 矿洞. The game calls that place 矿井
 * (`Data/Locations["Mine"].DisplayName`, `StringsFromCSFiles:MapPage.cs.11098`), which is the name the Mod's
 * destination directory publishes as that place's canonical label and the name `位置:` already prints when she is
 * standing in it. 矿洞 was THIS file's own word: a word no derivation from location data can produce, and a word the
 * search index cannot hold is a place she cannot ask for.
 *
 * SO THE CATALOGUE'S SPELLING WINS, and it is spelled once: a label is `LOCATION_NAMES_ZH`'s name for the place plus
 * the role of the thing standing there, so no entry can coin a second word for the place. The alignment lives here
 * because the Host owns the words she reads while the Mod owns the names it matches - and a synonym table on the Mod
 * side would have to grow a row for the next place, which design 3.1 already rejected.
 *
 * `world-state-place-word-findability.test.ts` reads the word the block ACTUALLY prints back through this table, so a
 * family declared here without its label, or a label spelled by hand, fails there naming the word and the place.
 */
export const TARGET_FAMILY_PLACES = Object.freeze({
  mineElevatorFloorTargets: Object.freeze({ map: "Mine", role: "电梯" }),
  mineEntranceTargets: Object.freeze({ map: "Mine", role: "入口" }),
});

/** `<the world's own name for the place><the role>`: how a label names a place without inventing a word for it. */
function placeLabel(place: Readonly<{ map: string; role: string }>): string {
  return `${gameLocationName(place.map, true)}${place.role}`;
}

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
  // NOT `已播种的地`. The family is "nearby EMPTY HoeDirt targets paired with a live inventory seed slot"
  // (`protocol.ts`), so a label that calls them sown states the opposite of its own rows: measured 2026-11-18
  // (`round76`, turns 3-4), the block printed this word over (65,20) (64,19) (65,19)... and her own rectangle read
  // answered `hoed=yes watered=no crop=no`. `world-state-observation-agreement.test.ts` holds every label that
  // asserts a state to the rows it prints beside it.
  seedTargets: "可播种的地",
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
  // NOT `可锄的地块`. This family publishes BOTH soil states - `hoeDirt` true for a tile that already carries dirt (the
  // `plant_seed`/`fertilize_tile`/`water_crop` target, and the record of work done) and false for ground the Hoe still
  // admits - so a family-level word claiming the ground can be hoed is the block contradicting its own rows. Measured
  // `round80`: a worked 10x3 block published 30 rows, all `hoeDirt: true`, and the line printed 「可锄的地块 (62,18) …」
  // over them; she was told to till what she had tilled, and `till_soil` answered `soil_already_tilled` 54 times in
  // eighteen minutes. The family word now states the ground and nothing else, and each row states which state it is in
  // (`ROW_STATE_FIELDS`).
  soilTiles: "地块",
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
  mineElevatorFloorTargets: placeLabel(TARGET_FAMILY_PLACES.mineElevatorFloorTargets),
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
  mineEntranceTargets: placeLabel(TARGET_FAMILY_PLACES.mineEntranceTargets),
});

/**
 * WHERE A PLACE WORD IS A KEY, AND WHERE IT IS ONLY SPEECH.
 *
 * <p>
 * MEASURED `round77`, day 2: the block printed `矿洞入口` over the mine entrance and she copied the place word out of it
 * as `stardew_find_destination("矿洞")`; the search answered a villager's house, because no destination declares 矿洞. The
 * label was wrong - `TARGET_FAMILY_PLACES` above carries the argument and the fix. ONE FILE OVER, THE SAME WORD IS RIGHT:
 * the Stardew conduct floor tells her to say `矿洞第 10 层 / floor 10 of the mines` rather than a map id, which is how a
 * person says a place - and a hygiene pass that deleted every `矿洞` would have taken the character's own line with it.
 * Nothing in the product could tell the two uses apart, which is the defect this declaration removes.
 * </p>
 *
 * <p>
 * A place word is a KEY where the product offers it AS A NAME - a value something later has to copy and an action has to
 * find again:
 * </p>
 * <ul>
 * <li>`rowLabel` - the label printed beside a row of a place's family. `矿洞入口` was one, and reading it is how she got
 * the word she searched for.</li>
 * <li>`standingPlace` - the value of `位置:`, the name of the map she is standing in, which is the same name the search
 * answers to.</li>
 * <li>`searchQuery` - a query an instruction hands the action that resolves names; `destinationQueriesIn` reads those.</li>
 * </ul>
 *
 * <p>
 * Everywhere else a place word is SPEECH, and the line is drawn on the real text rather than in principle: the default
 * companion's world book says `适合带镐前往矿洞深层探索开辟电梯`, a sentence that sends her somewhere by that word and is
 * still prose - no search is ever handed it, and refusing it would demand the lore be renamed. Speech is never held to the
 * catalogue: the gate that reads this declaration counts it and asserts nothing about it, because a companion whose own
 * vocabulary is refused her has been broken by the check, not fixed.
 * </p>
 */
export type PlaceWordKeySlot = "rowLabel" | "standingPlace" | "searchQuery";

/** The three spellings an instruction uses to hand `find_destination` a query: a call, a field, an assignment. */
const DESTINATION_QUERY = /find_destination\s*(?:\(\s*|[：:=]\s*)["'`「]?([^\s)"'`」,;，。]+)/gu;

/**
 * The queries an instruction hands `find_destination`, in the order it writes them.
 *
 * A place word inside one is a KEY: it is the exact string the search will be asked for, so it has to be the string the
 * world answers to. The same word in the sentence around the query is speech - a walkthrough saying where she went, a
 * rule showing how to say a place out loud - and this reader returns nothing for it, because an instruction that is
 * talking about a place is not asking the search for one.
 */
export function destinationQueriesIn(text: string): readonly string[] {
  return Object.freeze([...text.matchAll(DESTINATION_QUERY)].map((match) => match[1]!.trim()));
}

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
  seedSupplyTargets:
    "a supply row is (a seed she HOLDS x a shop that stocks it), so an empty array means she holds no plantable seed - not that no shop is here. Reading it as a place produced `这一带没有：卖种子的地方` on a farm with sixty-two tiles under the Hoe, which is a reason to walk away rather than a fact. The seed half prints as `种子: …` on this same line (`formatHeldSeeds` in `fact-brief.ts`), and a row names a counter only for a seed she already holds, so a zero-seed actor has no place to be pointed at",
});

/** Tiles one family names before it counts the rest. Six fits a plan; a 64-row patch does not fit a prompt. */
export const MAX_TARGET_TILES_SHOWN = 6;

/** Families the line names before it counts the rest. The non-empty ones are taken first. */
export const MAX_TARGET_FAMILIES_SHOWN = 12;

/** Families named on a counting line - the one "nothing here" line, or the one the family cap left out - before that line counts the rest. */
export const MAX_COUNTED_FAMILIES_NAMED = 8;

/**
 * How a row spells the tile it stands on, in the wire's own field names - the renderer's whole placement contract.
 *
 * `<p>`
 * TWO SPELLINGS, ONE FACT. Seventy-two families name the tile `x`/`y`; `warps` and `doorTargets` name their SOURCE tile
 * `sourceX`/`sourceY` (`isWarp` in `protocol.ts`, and the Mod's `FarmhandActionArgument` for `move_to_tile` says the
 * argument is "copied exactly from the `sourceX` and `sourceY` of a `doorTargets` entry"). Reading only the first pair
 * was not a formatting choice: measured 2026-11-23 on `round62`'s own snapshot, the FarmHouse door sat at (3,12)
 * - Chebyshev 4 from her, inside the radius-6 discovery envelope - and the block printed no door at all, because every
 * row of that family failed the `x`/`y` test and was dropped by `continue`. The counts agreed with the silence: `total`
 * read 1, `omitted` read 1, and the family printed on neither line, so nothing said a door existed.
 * </p>
 * `<p>`
 * `targetX`/`targetY` ARE NOT THIS PAIR. They are the arrival tile on the DESTINATION map, so printing them as where the
 * door is would move the door to the far side of it. Only the source pair is a tile in the map she is standing in.
 * </p>
 * `<p>`
 * This table is the placement contract the gate `tools/check-inventory-row-field-rendering.mjs` crosses with the wire's
 * row records: a family in `TARGET_FAMILY_LABELS` whose rows carry neither pair is a family this line cannot place a
 * single row of, and it fails there by name instead of printing nothing.
 * </p>
 */
export const ROW_TILE_FIELD_PAIRS: readonly (readonly [string, string])[] = Object.freeze([
  Object.freeze(["x", "y"] as const),
  Object.freeze(["sourceX", "sourceY"] as const),
]);

/**
 * The one value each family prints beside its row, for a family whose rows are told apart by a state rather than a name.
 *
 * WHY A TABLE AND NOT A GUESS. `nearbyTargetFamilies` prints a row's tile, and adds its `displayName` when the row
 * carries one - which is enough for a family of one kind (weeds, rocks) and for a family of named pieces (furniture).
 * `colorTargets` is neither: its rows are chests the repaint action addresses, and the only thing that distinguishes the
 * row from any other chest is the colour the write would change. Measured on `round62`: the row carried
 * `color: "119,191,255"`, the block printed 「可染色处 (3,7)」, and two predicates then disagreed about one object - the
 * repaint could not be checked from the line, and the same revision printed 「本图箱子: 0」 about that very chest.
 *
 * THE VALUE IS THE WIRE'S OWN, NOT A PALETTE INDEX. `color` is published as `r,g,b`; `color_placed_object` takes
 * `colorSelection`, an index into the game's own `DiscreteColorPicker` palette
 * (`FarmhandActionDefinitions.cs:898`). So the colour she reads here lets her CHECK a repaint and not yet CHOOSE one - a
 * gap in what the Mod publishes, not in this line, and the reason the field prints as its own `r,g,b` rather than a
 * number this file would have to invent.
 */
export const ROW_STATE_FIELDS: Readonly<Record<string, Readonly<{ field: string; label: string }>>> = Object.freeze({
  colorTargets: Object.freeze({ field: "color", label: "色" }),
  // THE LABEL NAMES THE STATE THE FIELD CARRIES, IN THE WORDS OF THE DECISION MADE AT THAT ROW. `hoeDirt: true` is a tile
  // already under the Hoe - nothing left to till, and the `plant_seed` / `fertilize_tile` / `water_crop` target; `false` is
  // the ground the Hoe still admits. The value is the wire's own boolean and stays so; only the word beside it is chosen,
  // and `已锄` is the Mod's own word for the state (`soil_already_tilled`, `settled_by=engine_flag:hoedirt=present`) and
  // the one the plan recipe's guard asks in (`if (soil.hoeDirt !== true)`).
  //
  // IT WAS `可种植`, AND THAT WORD WAS THE REMAINING HALF OF `round80`'s DEFECT. Measured `round81` (2026-11-20, first
  // three minutes): `plan_35` wrote 25 `till_soil` nodes over a 13x3 patch whose every tile was already HoeDirt, and all 25
  // settled `succeeded` - the settlement proves the postcondition and is right, which leaves the 25 node executions bought
  // for nothing. The rows she read said `可种植 true`: a word about PLANTING, beside a planting family of its own
  // (`seedTargets` is `可播种的地`), answering nothing about the Hoe, while this family's role in a plan is `till_soil`'s
  // target list and the recipe's only guard is `hoeDirt`. The family word stays `地块` (`TARGET_FAMILY_LABELS`) so nothing
  // claims the whole family is hoed - that was `round80`'s half, and `已锄 false` says bare ground as plainly as
  // `可种植 false` did.
  soilTiles: Object.freeze({ field: "hoeDirt", label: "已锄" }),
});

/**
 * What THIS DELIVERY already knows about the target rows, and how old the reading is.
 *
 * The two halves of the freshness question for a row list, kept beside each other because a renderer that took one
 * without the other could print a row with neither a source nor an age. `gone` is the set `fact-brief.ts`
 * (`provedGoneTargets`) derives from the delivery's receipts; `ageTurns` is the reading's own age, the same number the
 * block's first line states.
 */
export type TargetFreshness = Readonly<{
  /**
   * Rows a receipt in THIS delivery proved are no longer what the reading says they are, by the id the row is addressed
   * by: its own opaque id, or - for a row that carries no identity field at all - its tile (`rowTargetId`).
   *
   * <p>
   * WHY A ROW NEEDS ITS OWN PROOF. A row is an opaque id the caller copies into an action (`expectedTargetId`), and the
   * reading it comes from is not the world. Measured `round78` (2026-11-19, the mine window): six `break_rock` receipts
   * broke six stones while the reading she held was `revision 108`, so the block printed all eight rows - every broken one
   * among them - directly under an `<execution-result>` that named those same stones as broken, and the next plan pointed
   * four steps at stone that was already gone (`provedGoneTargets` in `fact-brief.ts` carries the full reading).
   * </p>
   *
   * <p>
   * A TILLED TILE IS THE SECOND SHAPE, and it is why the tile can be the id. Measured `round80`: a `soilTiles` reading
   * taken before the Hoe went in still said `hoeDirt: false` about tiles the same delivery's receipts had just tilled, so
   * the line offered ground that no longer needs work and `till_soil` answered `soil_already_tilled` 54 times in eighteen
   * minutes. No row family is named here: the row's own shape decides which id it answers to.
   * </p>
   *
   * <p>
   * THE SET IS IDS AND NOTHING ELSE. The proof, and the action that produced it, are the receipt's own statements; a row
   * list that also spelled the action gave one fact two vocabularies, and the copy in a sentence is the one a run learned
   * to answer with.
   * </p>
   */
  gone: ReadonlySet<string>;
  /**
   * Tiles a node of a programme STILL IN FLIGHT addressed, as `x:y`: work already queued, so work a plan must not ask for
   * again.
   *
   * <p>
   * THE THIRD QUESTION ABOUT A ROW LIST, and the reason it is its own member beside `gone`. `gone` is a PROOF - a receipt
   * in this delivery took the row out of the world. This is a QUEUE: nothing has happened yet, the row is still exactly as
   * the reading describes it, and it is still not offerable because the next plan would be a second plan for the same work.
   * Merging the two would let a queue read as a proof, which is the one thing an id set must never do.
   * </p>
   *
   * <p>
   * A TILE IS A WEAKER IDENTITY THAN AN ID (`rowTargetId`): two families can publish a row at one tile, and a row is
   * subtracted on its tile alone. Weaker is the safe direction - a row not offered cannot be worked twice - and the weaker
   * identity is the only one available, because the journal publishes a node's tile (`BodyProgramNodeStatus.x`/`y`) and no
   * node's opaque target id.
   * </p>
   */
  inFlight: ReadonlySet<string>;
  /** How many delivered turns ago this reading arrived: `0` is the turn it arrived in. */
  ageTurns: number;
}>;

/** No delivery to trust: every published row stands, and the age is the caller's own. */
export const NO_TARGET_FRESHNESS: TargetFreshness = Object.freeze({
  gone: new Set<string>(),
  inFlight: new Set<string>(),
  ageTurns: 0,
});

/** One family the snapshot published, as the state line prints it. */
export type NearbyTargetFamily = Readonly<{
  /** The wire key the rows came from, so a reader can check the label against it. */
  family: string;
  label: string;
  /** The nearest tile by Chebyshev distance from her own, or `undefined` for a family with no readable tile. */
  nearest: Readonly<{ x: number; y: number; distance: number }> | undefined;
  /** How many rows the family published. */
  total: number;
  /**
   * How many rows this line did not name: the cap, plus any row that carried no coordinate. A row a receipt in THIS
   * delivery proved out of the world is NOT counted here - it is counted by the line's own proof sentence, so the cap's
   * omission and the world's change cannot be read as one number.
   */
  omitted: number;
  /**
   * The sentence this line prints for the family, or `undefined` for a family the Mod published as empty (which prints
   * on the "nothing here" line instead). A family with rows ALWAYS renders something, even when not one row could be
   * placed: a family that printed nothing while `total` read 1 is a row that vanished.
   */
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
 *
 * A ROW THAT CARRIES A `kind` PRINTS ITS OWN NAME. A family's label answers "what kind of thing is this row" for a
 * family that is one thing (weeds, dry crops, rocks). A family whose rows carry a `kind` is the wire saying they are
 * NOT one thing - a bed, a table, a rug, a twig - so the label stops one word short of the question she is asking, and
 * the row's own `displayName` is the only place the rest of the answer exists. Measured 2026-11-14 (`round57`): the
 * FarmHouse's furniture arrived with `displayName` 床, 橡木桌, 橡木椅子, 红色木屋地毯, 红砖壁炉 and the block printed
 * 「可交互的物件 (9,8) (6,8) (4,4) (5,4) (8,4)」; she guessed 「大概是床、壁炉之类」 and then spent four turns moving and
 * replacing a piece she could not name. The name is not interpolated blind: a row with no readable `displayName` prints
 * its tile alone, never the word `undefined`.
 *
 * A ROW A RECEIPT PROVED GONE IS NOT PRINTED. `freshness.gone` is this delivery's own proof (see `provedGoneTargets`),
 * and a row it names is subtracted before the cap is applied - because an id the Mod has already answered `_gone` for is
 * an id any plan written from this line would point at a thing that is not there. How many were subtracted is stated on
 * the line itself (`renderTargetFamily`), and WHICH action took them out is stated by that action's own receipt in the
 * same delivery, so the subtraction is a fact rather than a silence and not a second spelling either. A TILLED TILE IS
 * THE SAME RULE ONE STATE OVER: the reading says the ground is bare, the receipt says it is under the Hoe, and the row
 * leaves the line for the one delivery that carries both rather than being offered as work already done.
 *
 * A ROW A QUEUED NODE IS WORKING IS THE SAME RULE BEFORE THE FACT. `freshness.inFlight` is the journal's own statement of
 * the tiles the programmes still in flight addressed (`InFlightProgramme.unsettledTiles`), and a row standing on one of them
 * is subtracted before the cap - because the next plan is composed exactly while that work is queued, and a snapshot that
 * still offers its tiles is an invitation to plan it twice. Tile, not target id: see `TargetFreshness.inFlight`.
 *
 * A FAMILY WHOSE ROWS IT CANNOT PLACE STILL PRINTS. The tile is read through `ROW_TILE_FIELD_PAIRS`, so a `doorTargets`
 * row is placed at its `sourceX`/`sourceY` exactly as an `animalDoorTargets` row is placed at its `x`/`y` - `round62`'s
 * falsifier: 畜舍门 (70,13) printed, and the FarmHouse door did not. The families that carry no tile at all -
 * `craftingRecipeTargets`, `shopTargets`, `wearableTargets`, `dailyQuestTargets` and their kin - still get a sentence
 * naming how many rows the line could not place, because the previous shape returned `rendered: undefined` for a family
 * with six rows, and `composeNearbyTargets` prints only the families with a sentence and the families with `total === 0`:
 * so those rows were on neither line and said nothing. A row this line cannot place is an OMISSION, and an omission is
 * counted.
 */
export function nearbyTargetFamilies(
  snapshot: Snapshot,
  freshness: TargetFreshness = NO_TARGET_FRESHNESS,
): readonly NearbyTargetFamily[] {
  const actor = snapshot.tile;
  const readable = Number.isFinite(actor?.x) && Number.isFinite(actor?.y);
  const families: NearbyTargetFamily[] = [];
  for (const [family, label] of Object.entries(TARGET_FAMILY_LABELS)) {
    const value = (snapshot as unknown as Record<string, unknown>)[family];
    if (!Array.isArray(value)) continue;
    const { standing, removed, inFlight } = splitFreshRows(value, freshness);
    const tiles = placedTargetTiles(standing, ROW_STATE_FIELDS[family]);
    const distance = (tile: { x: number; y: number }): number =>
      readable ? Math.max(Math.abs(tile.x - actor.x), Math.abs(tile.y - actor.y)) : 0;
    tiles.sort((left, right) => distance(left) - distance(right) || left.x - right.x || left.y - right.y);
    const shown = tiles.slice(0, MAX_TARGET_TILES_SHOWN);
    const omitted = standing.length - shown.length;
    const nearest = shown[0] === undefined ? undefined : { x: shown[0].x, y: shown[0].y, distance: distance(shown[0]) };
    const proved: TargetLineProof = Object.freeze({ removed, inFlight, ageTurns: freshness.ageTurns });
    families.push(
      Object.freeze({
        family,
        label,
        nearest,
        total: value.length,
        omitted,
        rendered: renderTargetFamily(label, value.length, shown, omitted, proved),
      }),
    );
  }
  return Object.freeze(families);
}

/**
 * One family's published rows, split by what this delivery proved about them and what a plan has already queued.
 *
 * `standing` keeps the wire's order, which the cap's sort then re-ranks; `removed` and `inFlight` are the two numbers the
 * line's own sentence is composed from, so the arithmetic and the sentence cannot disagree about how many rows left.
 *
 * TWO QUESTIONS, TWO TESTS, and `gone` is asked first: a row a receipt took out of the world is gone whatever a queue
 * says about its tile, and counting it as queued would credit a plan with work that no longer exists.
 */
function splitFreshRows(
  value: readonly unknown[],
  freshness: TargetFreshness,
): Readonly<{ standing: readonly unknown[]; removed: number; inFlight: number }> {
  const standing: unknown[] = [];
  let removed = 0;
  let inFlight = 0;
  for (const row of value) {
    const id = rowTargetId(row);
    if (id !== undefined && freshness.gone.has(id)) {
      removed += 1;
      continue;
    }
    const tile = row === null || typeof row !== "object" ? undefined : rowTile(row as Record<string, unknown>);
    if (tile !== undefined && freshness.inFlight.has(`${String(tile.x)}:${String(tile.y)}`)) {
      inFlight += 1;
      continue;
    }
    standing.push(row);
  }
  return { standing, removed, inFlight };
}

/**
 * The opaque id a row is addressed by, or `undefined` for a row that carries none.
 *
 * `targetId` is the wire's name for it in every family but `chests` (which names its container `chestId`) and the four
 * families the plan surface calls unidentified - and those rows are exactly the ones no receipt can be matched to, which
 * is why the absence is `undefined` here rather than a guess.
 *
 * A ROW WITH NO IDENTITY AT ALL IS ADDRESSED BY ITS TILE (`soilTiles`, in the Mod's own `62:19` spelling). Some rows
 * carry nothing but a place and a state, and then the place IS the address: `till_soil`'s receipt says it moved the tile
 * `62:19`, and the row standing there carries no `targetId` to match it with. Excluding every row that names an identity
 * field (`targetId`, `chestId`, `cropId`, ...) keeps this fallback off the families whose receipts name rows, so one id
 * vocabulary is never matched against another. What is left is a row of bare ground or a bare site, and a tile one of
 * those stands on cannot be tilled - the Mod refuses `till_soil` there, so no `soil_tilled` receipt can name it.
 */
function rowTargetId(row: unknown): string | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const candidate = row as Record<string, unknown>;
  const id = candidate.targetId;
  if (typeof id === "string" && id !== "") return id;
  return rowTileId(candidate);
}

/** A row field that names the row: `targetId`, `chestId`, `ownerId`. A row carrying one is addressed by that, not by its tile. */
const ROW_IDENTITY_FIELD = /Id$/u;

/** The tile a row with no identity field anywhere is addressed by, spelled as the Mod's own receipts spell it (`62:19`). */
function rowTileId(candidate: Record<string, unknown>): string | undefined {
  if (Object.keys(candidate).some((field) => ROW_IDENTITY_FIELD.test(field))) return undefined;
  const tile = rowTile(candidate);
  return tile === undefined ? undefined : `${String(tile.x)}:${String(tile.y)}`;
}

/**
 * The rows of one family this line can PLACE, in wire order, each with the name and state it prints.
 *
 * A row with no readable tile is left out here and counted by the caller as an omission, so the two facts the line
 * reports - what it named and what it could not - come from one reading of the array.
 */
function placedTargetTiles(
  value: readonly unknown[],
  state: Readonly<{ field: string; label: string }> | undefined,
): { x: number; y: number; name: string | undefined; state: string; w: number; h: number }[] {
  const tiles: { x: number; y: number; name: string | undefined; state: string; w: number; h: number }[] = [];
  for (const row of value) {
    if (row === null || typeof row !== "object") continue;
    const candidate = row as Record<string, unknown>;
    const tile = rowTile(candidate);
    if (tile === undefined) continue;
    tiles.push({
      x: tile.x,
      y: tile.y,
      name: rowDisplayName(candidate),
      state: state === undefined ? "" : stateSuffix(state, candidate[state.field]),
      w: extentSide(candidate.w),
      h: extentSide(candidate.h),
    });
  }
  return tiles;
}

/** The row's own name, for a family whose rows are not one thing; `undefined` rather than the word `undefined`. */
function rowDisplayName(candidate: Record<string, unknown>): string | undefined {
  const named =
    typeof candidate.kind === "string" &&
    typeof candidate.displayName === "string" &&
    candidate.displayName.trim().length > 0;
  return named ? (candidate.displayName as string) : undefined;
}

/**
 * What ONE LINE's receipts proved about that line's own rows, and how old the rows that are left are.
 *
 * Separate from `TargetFreshness` because it is a different fact: the delivery proves ids out of the world for every
 * family at once, and each family's sentence states only its own share of that.
 */
type TargetLineProof = Readonly<{ removed: number; inFlight: number; ageTurns: number }>;

/**
 * THE PROVENANCE CLAIM A COUNT CARRIES WHEN A RECEIPT IN THIS DELIVERY RE-COUNTED IT, in words.
 *
 * <p>
 * One constant, two lines read it: `fact-brief.ts`'s pack and seed counts and this module's target rows. It exists because
 * the claim belongs in a sentence and the ACTION ID does not: `<world-state>` used to print `5 份 防风草种子 (O)472 [槽 2]
 * （plant_seed 之后数的）`, and a run taught by that line reads ids and slot markers aloud, which is what the prompt floor
 * would have had to forbid - a second spelling of a rule this input can keep by itself.
 * </p>
 *
 * <p>
 * WHAT IT STILL SAYS, and what it no longer names. The claim's job is that a number is a statement about a MOMENT rather
 * than about the reading, which is the defect (`round75`: `种子: 2` for fourteen turns while the deliveries it arrived in
 * carried `inventory_after=0`). The action that took the count is not lost by this: the receipt that proves it is printed
 * by `receiptLine` in the same delivery, with its own `actionId` and its own evidence.
 * </p>
 */
export const COUNTED_AFTER_THE_STEP = "刚做完那一步之后数的";

/** Nothing proved and nothing aged: the sentence a caller with no delivery (the Chat surface's own reader) gets. */
const NOTHING_PROVED: TargetLineProof = Object.freeze({ removed: 0, inFlight: 0, ageTurns: 0 });

/**
 * The sentence one family prints, or `undefined` for a family the Mod published as empty.
 *
 * Three shapes and no more: empty is silent (it belongs to the "nothing here" line), rows that could not be placed
 * say so and how many, and rows that were placed name the cap's cost. `omitted` counts both, which is why it is
 * passed in rather than derived from `shown`.
 *
 * AND THE LINE SAYS HOW FRESH ITS ROWS ARE (`proved`). A row list is a set of ids rather than a count, and an id a
 * receipt in this delivery already took out of the world is an id a plan would point at nothing. So the two things that
 * can be true of a row list are said on the line itself - which action removed the rows that are gone, and how many turns
 * old the rest are - because the block's own age sentence is about "the world" and cannot be read as applying to one
 * family of twelve. `round78` is the falsifier: eight stones printed under a receipt block naming six of them broken,
 * and nothing on the line said the two disagreed.
 */
function renderTargetFamily(
  label: string,
  total: number,
  shown: readonly { x: number; y: number; name: string | undefined; state: string; w: number; h: number }[],
  omitted: number,
  proved: TargetLineProof = NOTHING_PROVED,
): string | undefined {
  if (total === 0) return undefined;
  const standing = total - proved.removed - proved.inFlight;
  if (proved.removed >= total) return `${label} 全部 ${String(proved.removed)} 格已不在（${COUNTED_AFTER_THE_STEP}）`;
  if (shown.length === 0)
    return `${label} 其余 ${String(standing)} 格未列出（这些行没有坐标）${targetLineFreshness(proved)}`;
  const tiles = shown
    .map(
      (tile) =>
        `${tile.name === undefined ? "" : `${tile.name} `}(${tile.x},${tile.y}${footprintSuffix(tile)})${tile.state}`,
    )
    .join(" ");
  return `${label} ${tiles}${omitted > 0 ? ` 其余 ${omitted} 格未列出` : ""}${targetLineFreshness(proved)}`;
}

/**
 * The tail a row list carries: which action proved rows out of the world, and how old the rows that are left are.
 *
 * The wording is the seeds line's own (`COUNTED_AFTER_THE_STEP`) rather than a second sentence saying the same thing - a
 * row list that replaced the reading's own says the receipt replaced it, in the same words - and the age is stated once,
 * for the line, only when a receipt did not account for every row on it.
 */
function targetLineFreshness(proved: TargetLineProof): string {
  const source = proved.removed < 1 ? "" : `（${COUNTED_AFTER_THE_STEP}，少了 ${String(proved.removed)} 格）`;
  // A row a queued node is already working is not gone and is not free: the line says so, because a plan written from it
  // would be a second plan for the same tile.
  const queued = proved.inFlight < 1 ? "" : `（其中 ${String(proved.inFlight)} 格已经在做了，不必再排）`;
  if (proved.ageTurns < 1) return `${source}${queued}`;
  const aged =
    proved.removed > 0 ? `（其余是 ${String(proved.ageTurns)} 轮前数的）` : `（${String(proved.ageTurns)} 轮前数的）`;
  return `${source}${queued}${aged}`;
}

/**
 * The tile a row stands on, through the first spelling of `ROW_TILE_FIELD_PAIRS` the row carries whole.
 *
 * `undefined` is a row this line cannot place, and the caller counts it rather than dropping it: a row with no readable
 * pair says the Mod published a subject whose place this renderer cannot name, which is a fact about the line and not
 * an absence of the subject.
 */
function rowTile(row: Record<string, unknown>): { x: number; y: number } | undefined {
  for (const [xField, yField] of ROW_TILE_FIELD_PAIRS) {
    const x = row[xField];
    const y = row[yField];
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return undefined;
}

/**
 * The state one row prints after its tile: `` ` 色 119,191,255` ``, `` ` 已锄 true` ``, or `""` when the row carries
 * nothing to read.
 *
 * A value the wire published as an empty string, a missing member, or a non-scalar is SILENCE rather than the word
 * `undefined` - the same rule the row's own `displayName` follows, and the reason a family that declares a state field
 * does not become unreadable when one row of it is short.
 *
 * A BOOLEAN PRINTS ITS OWN VALUE, and the branch is here rather than inside the family that needed it: the value IS the
 * state (`hoeDirt: true` says the tile is under the Hoe) and translating it into a word of its own would be a second
 * spelling of one boolean. The LABEL is what carries the meaning, which is why `ROW_STATE_FIELDS` names the state the
 * field holds rather than the decision that state happens to allow.
 */
function stateSuffix(state: Readonly<{ field: string; label: string }>, value: unknown): string {
  if (typeof value === "boolean") return ` ${state.label} ${value ? "true" : "false"}`;
  if (typeof value === "number" && Number.isFinite(value)) return ` ${state.label} ${String(value)}`;
  if (typeof value === "string" && value.trim().length > 0) return ` ${state.label} ${value.trim()}`;
  return "";
}

/**
 * One published extent side, as the number of tiles a reader may rely on.
 *
 * `1` is the answer for EVERY absent or unusable value, and that is not a default dressed as a measurement: `1` is the
 * one footprint the wire's own coordinate always meant, so a Mod that omits the pair and a Mod that publishes it agree.
 * A published `0` - a `NetInt` whose initializer never ran - is refused here rather than printed, because a 0-wide bed
 * would read as a measurement that the world is not.
 */
function extentSide(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 64 ? value : 1;
}

/**
 * The footprint one row occupies, appended INSIDE its own parentheses: `(9,8 [2×3])`.
 *
 * <p>
 * WHERE IT SITS IS THE WHOLE DESIGN. The tile stays first and the extent follows it, because every reader of this line
 * that predates the field extracts a coordinate with `\d+,\s*\d+` - the plan compiler, the approach helpers and the
 * refusal messages all do - and a format that put the extent in front of the tile would silently break all of them while
 * looking more readable. A one-tile row prints the bare coordinate it always printed, so nothing that reads this line
 * has to learn a new shape for the common case.
 * </p>
 * <p>
 * It is not decoration either: measured 2026-11-14 (`round57`), the FarmHouse's furniture arrived as five bare
 * coordinates and she spent four turns moving and replacing a piece she could not identify. A 2x3 bed printed as one
 * tile is the same defect one layer down - the extent is what makes "there is something at (9,8)" into "the bed covers
 * (9,8) to (10,10)".
 * </p>
 */
function footprintSuffix(tile: { readonly w: number; readonly h: number }): string {
  return tile.w > 1 || tile.h > 1 ? ` [${String(tile.w)}×${String(tile.h)}]` : "";
}

// ---------------------------------------------------------------------------------------------------------------
// A SELECTION over the rows one observation already published.
// ---------------------------------------------------------------------------------------------------------------
//
// `stardew_observe` used to hand the model one bounded view of the whole world and accepted no argument, so the only
// question it could answer was "what is near me" - a 3-wide strip, the row along the fence, or "what is at the tile I
// am about to walk onto" all had to be reconstructed by the model from a square window it did not choose.
//
// A selection is a FILTER over the rows this snapshot already carries, never a second read of the world: the same
// families, the same `ROW_TILE_FIELD_PAIRS` placement, the same `renderTargetFamily` sentence. Nothing here asks the
// Mod anything, so a selection answer costs no bridge round trip and cannot disagree with the observation the model
// is holding.
//
// TWO INPUT FORMS, ONE PREDICATE. A shape is a set of tiles, and a set can be ENUMERATED (`tiles`) or DECIDED
// (`predicates`: an x/y rectangle with an optional stride, and an optional kind filter). The two forms are unioned,
// because a caller that knows three tiles and one strip is asking about their union. There is deliberately no shape
// grammar: a polygon, a circle or a stroke is also just a set, and `tiles` says the same thing with no language to
// validate, version and explain.
//
// THE ANSWER IS ONE SHAPE, whatever the selector: the counts per kind, the nearest rows, and the omissions counted.
// Generality lives in the selector, never in the answer - a model that has to re-parse an unpredictable structure
// mis-reads the shape it has not seen.

/** Tiles a request may enumerate outright. Past this the way out is a rectangle, and the refusal says so. */
export const OBSERVATION_ENUMERATED_TILE_LIMIT = 32;
/** Rectangles one request may name. A union of three strips fits; a hand-built mask does not. */
export const OBSERVATION_SELECTION_RANGE_LIMIT = 8;
/**
 * Tiles the named rectangles may cover, deduplicated.
 *
 * The count is EXACT, which is why this bound exists: the answer states how many tiles the request named, and a
 * number derived from `width × height` arithmetic would disagree with the tiles the rows are matched against as soon
 * as two rectangles overlap. Under this bound the named tiles are enumerated into one set and counted.
 */
export const OBSERVATION_SELECTION_TILE_LIMIT = 4096;
/** Rows one kind names before the answer counts the rest. Wider than `MAX_TARGET_TILES_SHOWN`: a strip needs its rows. */
export const OBSERVATION_SELECTION_ROWS_LIMIT_MAX = 24;

/** One axis of a rectangle: the tiles it names are `from`, `from + step`, … `to`. */
export type SelectionAxis = Readonly<{ from: number; to: number; step?: number }>;

/**
 * One condition over the three fields a published row already carries: `x`, `y` and the family it came from.
 *
 * An axis pair is a rectangle, a `step` is the stride inside it, and `kinds` names the families. Neither is required
 * on its own: `kinds` alone selects every published row of those kinds wherever it stands, which is what a
 * kind-and-no-place question means and is reported as a condition that names no tile.
 */
export type SelectionPredicate = Readonly<{
  x?: SelectionAxis;
  y?: SelectionAxis;
  kinds?: readonly string[];
}>;

/** What a caller selected: enumerated tiles, decided conditions, or both. */
export type ObservationSelection = Readonly<{
  predicates: readonly SelectionPredicate[];
  tiles: readonly (readonly [number, number])[];
}>;

/** How many tiles one axis names, counted from its own stride. `step: 2` over 18…37 names 10, not 20. */
export function axisTileCount(axis: SelectionAxis): number {
  return Math.floor((axis.to - axis.from) / (axis.step ?? 1)) + 1;
}

/** The tiles one request named, deduplicated: the population the answer's tile counts are taken over. */
export function namedSelectionTiles(selection: ObservationSelection): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [x, y] of selection.tiles) keys.add(tileKey(x, y));
  for (const predicate of selection.predicates) {
    const x = predicate.x;
    const y = predicate.y;
    if (x === undefined || y === undefined) continue;
    for (let tileX = x.from; tileX <= x.to; tileX += x.step ?? 1)
      for (let tileY = y.from; tileY <= y.to; tileY += y.step ?? 1) keys.add(tileKey(tileX, tileY));
  }
  return keys;
}

/** One selected row, in the shape `renderTargetFamily` prints. */
export type SelectedRow = Readonly<{
  x: number;
  y: number;
  name: string | undefined;
  state: string;
  w: number;
  h: number;
}>;

/**
 * What one kind's rows in the selection say - the THREE ZEROES, kept apart.
 *
 * `measured` means rows fell inside. `empty` means the family published and the selection lies where this
 * observation was looking, so the zero is a reading. `beyond_extent` means the family published rows somewhere this
 * observation DID look and the selection lies outside that extent: the zero is the extent's edge, not the world's
 * silence. `not_published` means the observation carries no such family at all, which is `not measured` - the oldest
 * distinction in this repository, and the one a single `0` erases.
 */
export type SelectedKindCoverage = "measured" | "empty" | "beyond_extent" | "not_published";

/**
 * One kind's rows inside the selection, with everything the answer does not name counted.
 *
 * THE ROW TYPE IS THE ANSWER'S, not this type's: a published family's rows are `SelectedRow`, and the tiles a rectangle
 * read returned are `TileAreaRow`. Both carry a tile, which is all the accounting below needs.
 */
export type SelectedKind<Row extends Readonly<{ x: number; y: number }> = SelectedRow> = Readonly<{
  kind: string;
  label: string;
  /** Rows of this kind the selection picked. The answer's summary states this number and nothing else. */
  count: number;
  /** The nearest `limit` of them. */
  shown: readonly Row[];
  /** Picked rows this answer does not name: the cap, plus every row carrying no readable tile. */
  omitted: number;
  /** Picked rows with no readable tile. Counted in `count` and in `omitted`, never silently dropped. */
  unplaced: number;
  /** Rows the family published in the whole observation: the ceiling beside the count. */
  published: number;
  coverage: SelectedKindCoverage;
}>;

/** The tiles a request named, and what happened to each: every named tile lands in exactly one bucket. */
export type SelectionTiles = Readonly<{
  named: number;
  /** Named tiles at least one selected row stands on. */
  withRows: number;
  /** Named tiles inside the published extent with no selected row: measured, and empty. */
  empty: number;
  /** Named tiles outside the published extent: unreadable, and named rather than reported as zero. */
  unreadable: number;
  /** The first few unreadable tiles, so the answer says WHICH part of itself it could not read. */
  unreadableNamed: readonly string[];
  /** Conditions that filter by kind alone and therefore name no tile at all. */
  kindOnlyConditions: number;
}>;

/** The fields every selection answer carries, whatever it was answered FROM. */
type SelectionAnswerFields = Readonly<{
  verdict: "measured" | "empty" | "beyond_extent" | "not_measured";
  tiles: SelectionTiles;
  /** Families this observation published that the request's kind filter left out of this answer. */
  kindsOutsideScope: number;
  /** The extent of every row this observation published, or `undefined` when it published none it could place. */
  extent: Readonly<{ x0: number; y0: number; x1: number; y1: number }> | undefined;
  /** How the refusal codes spell this selection, so a code names the question it refused. */
  spelling: string;
  /** The model-facing block: counts first, then the nearest rows, then every absence named. */
  text: string;
}>;

/**
 * One answer shape for every selector, in the row type of the question that was asked.
 *
 * A SELECTION IS A QUESTION ABOUT TILES, so the answer's `rowType` says which reading produced it: `family` is the rows
 * the observation already published (`selectObservedRows`), `tile` is the rectangle the Mod read for this call
 * (`selectTileAreaRows`). The counts, the omission, the three zeroes and the block's shape are one in both.
 */
export type FamilySelectionAnswer = SelectionAnswerFields &
  Readonly<{ rowType: "family"; kinds: readonly SelectedKind[] }>;
export type TileSelectionAnswer = SelectionAnswerFields &
  Readonly<{ rowType: "tile"; kinds: readonly SelectedKind<TileAreaRow>[] }>;
export type SelectionAnswer = FamilySelectionAnswer | TileSelectionAnswer;

const tileKey = (x: number, y: number): string => `${String(x)},${String(y)}`;

function axisAdmits(axis: SelectionAxis | undefined, value: number): boolean {
  if (axis === undefined) return true;
  const step = axis.step ?? 1;
  return value >= axis.from && value <= axis.to && (value - axis.from) % step === 0;
}

/** Whether one axis names at least one value in `[low, high]`, which is how a stride is compared with an extent. */
function axisMeetsRange(axis: SelectionAxis | undefined, low: number, high: number): boolean {
  if (axis === undefined) return true;
  const step = axis.step ?? 1;
  const start = Math.max(axis.from, low);
  const first = start + ((step - ((start - axis.from) % step)) % step);
  return first <= Math.min(axis.to, high);
}

/** Whether a predicate admits a row that carries a place. */
function predicateAdmitsRow(
  predicate: SelectionPredicate,
  family: string,
  tile: Readonly<{ x: number; y: number }>,
): boolean {
  if (predicate.kinds !== undefined && !predicate.kinds.includes(family)) return false;
  return axisAdmits(predicate.x, tile.x) && axisAdmits(predicate.y, tile.y);
}

/**
 * Whether a predicate admits a row that carries NO place.
 *
 * A row with no readable tile can satisfy a kind filter and can never satisfy a coordinate one, so it is selected by
 * a kind-only condition and by nothing else. It is still a row the response must account for: the answer counts it and
 * says it could not be placed.
 */
function predicateAdmitsUnplacedRow(predicate: SelectionPredicate, family: string): boolean {
  return (
    (predicate.kinds === undefined || predicate.kinds.includes(family)) &&
    predicate.x === undefined &&
    predicate.y === undefined
  );
}

/** The families one predicate puts in scope, or `undefined` for "every family the observation published". */
function scopedKinds(selection: ObservationSelection): ReadonlySet<string> | undefined {
  const named = new Set<string>();
  for (const predicate of selection.predicates) {
    if (predicate.kinds === undefined) return undefined;
    for (const kind of predicate.kinds) named.add(kind);
  }
  return selection.tiles.length === 0 ? named : undefined;
}

/** The extent of every placeable row the observation published, or `undefined` when it published none. */
export function observedRowExtent(
  snapshot: Snapshot,
): Readonly<{ x0: number; y0: number; x1: number; y1: number }> | undefined {
  let extent: { x0: number; y0: number; x1: number; y1: number } | undefined;
  for (const family of Object.keys(TARGET_FAMILY_LABELS)) {
    const value = (snapshot as unknown as Record<string, unknown>)[family];
    if (!Array.isArray(value)) continue;
    for (const tile of placedTargetTiles(value, ROW_STATE_FIELDS[family])) {
      extent =
        extent === undefined
          ? { x0: tile.x, y0: tile.y, x1: tile.x, y1: tile.y }
          : {
              x0: Math.min(extent.x0, tile.x),
              y0: Math.min(extent.y0, tile.y),
              x1: Math.max(extent.x1, tile.x),
              y1: Math.max(extent.y1, tile.y),
            };
    }
  }
  return extent === undefined ? undefined : Object.freeze(extent);
}

/**
 * The rows one selection picks out of the observation's published families, counted per kind.
 *
 * ORDER is the module's own: Chebyshev distance from her tile, then x, then y - the ranking `nearbyTargetFamilies`
 * uses, so the nearest row of a strip is the one she reaches first and two snapshots render two equal sentences.
 *
 * The counts are taken ONCE, over the families this snapshot publishes. Nothing is re-read from the world and nothing
 * is re-derived from the text: `count` is the picked population, `shown` is its nearest `limit`, and `omitted` is
 * counted from the picked lists rather than subtracted in a second place.
 */
export function selectObservedRows(
  snapshot: Snapshot,
  selection: ObservationSelection,
  limit: number,
): FamilySelectionAnswer {
  const named = namedSelectionTiles(selection);
  const extent = observedRowExtent(snapshot);
  const scope = scopedKinds(selection);
  const actor = snapshot.tile;
  const readableActor = Number.isFinite(actor?.x) && Number.isFinite(actor?.y);
  const distance = (tile: Readonly<{ x: number; y: number }>): number =>
    readableActor ? Math.max(Math.abs(tile.x - actor.x), Math.abs(tile.y - actor.y)) : 0;
  const admits = (family: string, tile: Readonly<{ x: number; y: number }>): boolean =>
    named.has(tileKey(tile.x, tile.y)) ||
    selection.predicates.some((predicate) => predicateAdmitsRow(predicate, family, tile));

  const tilesWithRows = new Set<string>();
  const tilesUnreadable = new Set<string>();
  const kinds: SelectedKind[] = [];
  let kindsOutsideScope = 0;
  let kindOnlyConditions = 0;
  for (const predicate of selection.predicates)
    if (predicate.x === undefined && predicate.y === undefined) kindOnlyConditions += 1;

  for (const [family, label] of Object.entries(TARGET_FAMILY_LABELS)) {
    const value = (snapshot as unknown as Record<string, unknown>)[family];
    const inScope = scope === undefined || scope.has(family);
    if (!inScope) {
      if (Array.isArray(value) && value.length > 0) kindsOutsideScope += 1;
      continue;
    }
    if (!Array.isArray(value)) {
      kinds.push(
        Object.freeze({
          kind: family,
          label,
          count: 0,
          shown: Object.freeze([]),
          omitted: 0,
          unplaced: 0,
          published: 0,
          coverage: "not_published" as const,
        }),
      );
      continue;
    }
    const placeable = placedTargetTiles(value, ROW_STATE_FIELDS[family]);
    const picked = placeable.filter((tile) => admits(family, tile));
    for (const tile of picked) tilesWithRows.add(tileKey(tile.x, tile.y));
    const unplaced = value.length - placeable.length;
    const pickedUnplaced = selection.predicates.some((predicate) => predicateAdmitsUnplacedRow(predicate, family))
      ? unplaced
      : 0;
    const ordered = [...picked].sort(
      (left, right) => distance(left) - distance(right) || left.x - right.x || left.y - right.y,
    );
    const shown = ordered.slice(0, limit);
    const count = picked.length + pickedUnplaced;
    // Counted, not subtracted: the rows the answer does not name are the picked ones past the cap, plus every row it
    // could not place. `count === shown.length + omitted` is then a claim the gate can falsify instead of an identity.
    const omitted = ordered.reduce((total, _tile, index) => total + (index < shown.length ? 0 : 1), 0) + pickedUnplaced;
    kinds.push(
      Object.freeze({
        kind: family,
        label,
        count,
        shown: Object.freeze(shown.map((tile) => Object.freeze(tile))),
        omitted,
        unplaced: pickedUnplaced,
        published: value.length,
        coverage: coverageOf(count, value.length, placeable.length, selection, extent),
      }),
    );
  }

  for (const key of named) {
    const [x, y] = key.split(",").map((part) => Number(part)) as [number, number];
    if (tilesWithRows.has(key)) continue;
    const measured = extent !== undefined && x >= extent.x0 && x <= extent.x1 && y >= extent.y0 && y <= extent.y1;
    if (!measured) tilesUnreadable.add(key);
  }
  const unreadableNamed = [...tilesUnreadable]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .slice(0, MAX_COUNTED_FAMILIES_NAMED)
    .map((key) => key.replace(",", "，"));
  const tiles: SelectionTiles = Object.freeze({
    named: named.size,
    withRows: tilesWithRows.size,
    empty: named.size - tilesWithRows.size - tilesUnreadable.size,
    unreadable: tilesUnreadable.size,
    unreadableNamed: Object.freeze(unreadableNamed),
    kindOnlyConditions,
  });
  const answer: FamilySelectionAnswer = Object.freeze({
    rowType: "family" as const,
    verdict: verdictOf(kinds, tiles),
    tiles,
    kinds: Object.freeze(kinds),
    kindsOutsideScope,
    extent,
    spelling: selectionSpelling(selection, named.size),
    text: "",
  });
  return Object.freeze({ ...answer, text: renderSelectionAnswer(answer, snapshot.revision) });
}

/** How one kind's picked rows are classified: the three zeroes, plus the one non-zero answer. */
function coverageOf(
  count: number,
  published: number,
  placed: number,
  selection: ObservationSelection,
  extent: Readonly<{ x0: number; y0: number; x1: number; y1: number }> | undefined,
): SelectedKindCoverage {
  if (count > 0) return "measured";
  // A family that published nothing, or whose every row carries no place, was still measured: the observation says
  // the kind has nothing in it, and no extent can contradict a set of rows that has no coordinate to be outside of.
  if (published === 0 || placed === 0 || extent === undefined) return "empty";
  return selectionMeetsExtent(selection, extent) ? "empty" : "beyond_extent";
}

/** Whether anything the request names could lie inside `extent` at all. */
function selectionMeetsExtent(
  selection: ObservationSelection,
  extent: Readonly<{ x0: number; y0: number; x1: number; y1: number }>,
): boolean {
  for (const [x, y] of selection.tiles)
    if (x >= extent.x0 && x <= extent.x1 && y >= extent.y0 && y <= extent.y1) return true;
  for (const predicate of selection.predicates) {
    if (predicate.x === undefined && predicate.y === undefined) return true;
    if (axisMeetsRange(predicate.x, extent.x0, extent.x1) && axisMeetsRange(predicate.y, extent.y0, extent.y1))
      return true;
  }
  return false;
}

function verdictOf(
  kinds: readonly Readonly<{ coverage: SelectedKindCoverage }>[],
  tiles: SelectionTiles,
): SelectionAnswer["verdict"] {
  const measured = kinds.some((kind) => kind.coverage === "measured");
  if (measured) return "measured";
  const published = kinds.filter((kind) => kind.coverage !== "not_published");
  if (published.length === 0) return "not_measured";
  if (tiles.named > 0 && tiles.withRows === 0 && tiles.empty === 0) return "beyond_extent";
  if (published.some((kind) => kind.coverage === "empty")) return "empty";
  return "beyond_extent";
}

/** The selection as the refusal codes spell it: short, deterministic, and the same string every time. */
function selectionSpelling(selection: ObservationSelection, namedTileCount: number): string {
  const parts: string[] = [];
  if (selection.tiles.length > 0) parts.push(`tiles:${String(selection.tiles.length)}`);
  for (const predicate of selection.predicates) {
    const axes: string[] = [];
    if (predicate.x !== undefined)
      axes.push(`x${String(predicate.x.from)}-${String(predicate.x.to)}/${String(predicate.x.step ?? 1)}`);
    if (predicate.y !== undefined)
      axes.push(`y${String(predicate.y.from)}-${String(predicate.y.to)}/${String(predicate.y.step ?? 1)}`);
    if (predicate.kinds !== undefined) axes.push(`k:${[...predicate.kinds].sort().join("+")}`);
    if (axes.length > 0) parts.push(axes.join(","));
  }
  return parts.length === 0 ? `tiles:${String(namedTileCount)}` : parts.join("+");
}

/**
 * The model-facing block.
 *
 * The counts come first because they are the answer, and the rows come after them because they are the address. Every
 * family the request put in scope is accounted for: rows it picked, or the "nothing here" line, or `未测`, or the
 * extent sentence. A family that printed nothing would be the one omission this block cannot have.
 */
function renderSelectionAnswer(answer: FamilySelectionAnswer, revision: number): string {
  const lines: string[] = [];
  const named = answer.tiles.named;
  const conditions = answer.tiles.kindOnlyConditions;
  lines.push(
    `选中（revision ${String(revision)}）：${
      named === 0 ? "只按 kind 过滤，不限位置" : `命名 ${String(named)} 格`
    }${conditions === 0 ? "" : `；另有 ${String(conditions)} 个只按 kind 的条件`}。只过滤这次观察已经发布的行，没有重读世界。`,
  );
  if (named > 0)
    lines.push(
      `格子：${String(answer.tiles.withRows)} 格有行 · ${String(answer.tiles.empty)} 格测过是空的 · ${String(
        answer.tiles.unreadable,
      )} 格未覆盖${answer.tiles.unreadableNamed.length === 0 ? "" : `（这次观察没有发布到那里：${answer.tiles.unreadableNamed.join("、")}）`}`,
    );
  const measured = answer.kinds.filter((kind) => kind.count > 0);
  const totalRows = measured.reduce((total, kind) => total + kind.count, 0);
  const totalShown = measured.reduce((total, kind) => total + kind.shown.length, 0);
  const totalOmitted = measured.reduce((total, kind) => total + kind.omitted, 0);
  if (totalRows > 0)
    lines.push(
      `这块里的行：${measured.map((kind) => `${kind.label} ${String(kind.count)}`).join(" · ")}（共 ${String(totalRows)} 行；列出 ${String(totalShown)} 行，其余 ${String(totalOmitted)} 格未列出）`,
    );
  for (const kind of measured.slice(0, MAX_TARGET_FAMILIES_SHOWN))
    lines.push(
      `${renderTargetFamily(kind.label, kind.count, kind.shown, kind.omitted)}${
        kind.unplaced === 0 ? "" : `（其中 ${String(kind.unplaced)} 行没有坐标）`
      }`,
    );
  const droppedFamilies = measured.slice(MAX_TARGET_FAMILIES_SHOWN);
  if (droppedFamilies.length > 0)
    lines.push(
      `其余 ${String(droppedFamilies.length)} 类有行未列出：${droppedFamilies
        .slice(0, MAX_COUNTED_FAMILIES_NAMED)
        .map((kind) => kind.label)
        .join("、")}`,
    );
  const emptyKinds = answer.kinds.filter((kind) => kind.coverage === "empty");
  if (emptyKinds.length > 0) lines.push(`选中范围里没有：${countedFamilyNames(emptyKinds)}`);
  const beyond = answer.kinds.filter((kind) => kind.coverage === "beyond_extent");
  if (beyond.length > 0)
    lines.push(
      `范围外：${countedFamilyNames(beyond)}——这些 kind 已发布的行都在${
        answer.extent === undefined
          ? "别处"
          : ` x ${String(answer.extent.x0)}～${String(answer.extent.x1)} / y ${String(answer.extent.y0)}～${String(answer.extent.y1)} 内`
      }，与选中范围不相交；0 是没覆盖到，不是没有。`,
    );
  const unmeasured = answer.kinds.filter((kind) => kind.coverage === "not_published");
  if (unmeasured.length > 0)
    lines.push(`未测：${countedFamilyNames(unmeasured)}——这次观察没有发布这些 kind，所以不是 0。`);
  if (answer.kindsOutsideScope > 0)
    lines.push(`按 kind 过滤掉的还有 ${String(answer.kindsOutsideScope)} 类有行，不在本次选择里。`);
  if (totalRows === 0) lines.push(verdictSentence(answer));
  return lines.join("\n");
}

/** A bounded list of family labels with the rest counted, the shape the "nothing here" line already uses. */
function countedFamilyNames(kinds: readonly SelectedKind[]): string {
  const named = kinds.slice(0, MAX_COUNTED_FAMILIES_NAMED).map((kind) => kind.label);
  return `${named.join("、")}${kinds.length > named.length ? ` 等 ${String(kinds.length)} 类` : ""}`;
}

/** The sentence a selection with no rows answers with, and the three zeroes it must keep apart. */
function verdictSentence(answer: SelectionAnswer): string {
  if (answer.verdict === "beyond_extent") return "选中范围整块在这次观察的已发布范围之外：这不是空的，是没覆盖到。";
  if (answer.verdict === "empty") return "这块里一行都没有，而且这些 kind 这次观察都测量到了：选中范围确实是空的。";
  if (answer.verdict === "not_measured") return "未测：这次观察没有发布可答的 kind，范围里没有任何可读的行。";
  return "";
}

// ---------------------------------------------------------------------------------------------------------------
// A RECTANGLE: the one question a published row cannot answer.
// ---------------------------------------------------------------------------------------------------------------
//
// A family row says only WHERE something stands, and the families an observation publishes are a square window around
// the actor. A task with a SHAPE - "a 3-wide, 20-long strip", "the row along the fence" - asks a different question:
// what is on every tile of THIS rectangle, the empty ones included, and can the actor stand on each. Measured
// `round42`: a 3x20 request produced a 7x8 blob at 55% density from the published families while the companion
// re-observed every three or four tiles and inferred her own work from the list's silence.
//
// So a selection that names a rectangle is answered by ONE `tile_area_request`: the Mod reads the tiles of the location
// the actor is standing in, and the ANSWER KEEPS THE SELECTION'S OWN SHAPE - per-kind counts (the kind is the tile's
// `occupantKind`, the word a `for_each` `where: [{ occupant: ... }]` filter is decided against), the nearest rows with
// every fact a plan needs, and every tile the answer did not read counted and named.

/**
 * The word the Mod publishes for a tile nothing stands on - `TileOccupantKind.None`, which is
 * `FarmhandForEachHealing.NoOccupant`.
 *
 * ONE HOST COPY, held to the Mod's constant by `tool-capability-lost-in-a-merge.test.ts`. The "measured empty" bucket is
 * decided by THIS word, so a Mod-side rename the Host did not follow would move every free tile into `withRows` and the
 * three zeroes would report a strip of open ground as full.
 */
export const TILE_OCCUPANT_NONE = "none";

/** The rectangle one selection names outright: the north-west tile, then its width and height in tiles. */
export type SelectionRectangle = Readonly<{ x: number; y: number; w: number; h: number }>;

/**
 * The one rectangle a selection names, or `null` when the selection is a question about published rows instead.
 *
 * THE BOUNDARY IS THE SELECTED THING. `kinds` names FAMILIES and a family row is what it filters, so a kind filter stays
 * with `selectObservedRows`. One rectangle with no kind filter is the question only the Mod can answer, because it is
 * about tiles no family would have published. A stride stays with the rectangle: it chooses which of the READ tiles the
 * answer counts, and it is the rectangle's own arithmetic.
 */
export function selectionRectangle(selection: ObservationSelection): SelectionRectangle | null {
  if (selection.tiles.length > 0 || selection.predicates.length !== 1) return null;
  const [predicate] = selection.predicates;
  if (predicate === undefined || predicate.kinds !== undefined) return null;
  if (predicate.x === undefined || predicate.y === undefined) return null;
  return Object.freeze({
    x: predicate.x.from,
    y: predicate.y.from,
    w: predicate.x.to - predicate.x.from + 1,
    h: predicate.y.to - predicate.y.from + 1,
  });
}

/** `yes`/`no`, so a row reads as a sentence rather than as a number a caller has to interpret. */
const yesNo = (value: boolean): string => (value ? "yes" : "no");

/** One tile row as the block prints it: the occupant word first, because that is the word a filter takes. */
function tileRowText(row: TileAreaRow): string {
  return `(${String(row.x)},${String(row.y)}) ${row.occupantKind} occupant=${row.occupant} tillable=${yesNo(
    row.tillable,
  )} hoed=${yesNo(row.hoed)} watered=${yesNo(row.watered)} crop=${yesNo(row.crop)} passable=${yesNo(row.passable)}`;
}

/**
 * The rows one rectangle read answered, counted per `occupantKind` - the selection answer in its tile row type.
 *
 * ORDER is the module's own: Chebyshev distance from her tile, then x, then y, so the nearest tile of the strip is the
 * one she reaches first - and the kinds come in the order those ordered rows first mention them, so the answer is a
 * reading of the strip rather than of a table's key order.
 *
 * THE THREE ZEROES ARE PER TILE HERE, which is what reading buys: a named tile whose row says `occupantKind: none` is
 * MEASURED AND EMPTY; a named tile the answer carries no row for is UNREADABLE and is named; and an answer that read
 * none of the rectangle is NOT MEASURED rather than empty.
 */
export function selectTileAreaRows(
  result: Readonly<TileAreaResult>,
  selection: ObservationSelection,
  limit: number,
  actor: Readonly<{ x: number; y: number }> | undefined,
): TileSelectionAnswer {
  const named = namedSelectionTiles(selection);
  const readableActor = actor !== undefined && Number.isFinite(actor.x) && Number.isFinite(actor.y);
  const distance = (tile: Readonly<{ x: number; y: number }>): number =>
    readableActor ? Math.max(Math.abs(tile.x - actor.x), Math.abs(tile.y - actor.y)) : 0;
  const ordered = (result.rows ?? [])
    .filter((row) => named.has(tileKey(row.x, row.y)))
    .sort((left, right) => distance(left) - distance(right) || left.x - right.x || left.y - right.y);

  const rowsOfKind = new Map<string, TileAreaRow[]>();
  for (const row of ordered) {
    const existing = rowsOfKind.get(row.occupantKind);
    if (existing === undefined) rowsOfKind.set(row.occupantKind, [row]);
    else existing.push(row);
  }
  const kinds: SelectedKind<TileAreaRow>[] = [];
  for (const [kind, rows] of rowsOfKind) {
    const shown = rows.slice(0, limit);
    kinds.push(
      Object.freeze({
        kind,
        // The kind IS the word the row carries, so nothing here maps one vocabulary onto another.
        label: kind,
        count: rows.length,
        shown: Object.freeze(shown.map((row) => Object.freeze(row))),
        omitted: rows.reduce((total, _row, index) => total + (index < shown.length ? 0 : 1), 0),
        unplaced: 0,
        published: rows.length,
        // Every row here was READ: the Mod answered about this tile, so a kind it carries is measured.
        coverage: "measured" as const,
      }),
    );
  }

  const byTile = new Map(ordered.map((row) => [tileKey(row.x, row.y), row]));
  const unreadableNamed: string[] = [];
  let withRows = 0;
  let empty = 0;
  let unreadable = 0;
  for (const key of named) {
    const row = byTile.get(key);
    if (row === undefined) {
      unreadable += 1;
      if (unreadableNamed.length < MAX_COUNTED_FAMILIES_NAMED) unreadableNamed.push(key.replace(",", "，"));
      continue;
    }
    if (row.occupantKind === TILE_OCCUPANT_NONE) empty += 1;
    else withRows += 1;
  }
  const tiles: SelectionTiles = Object.freeze({
    named: named.size,
    withRows,
    empty,
    unreadable,
    unreadableNamed: Object.freeze(unreadableNamed),
    kindOnlyConditions: 0,
  });
  const answer: TileSelectionAnswer = Object.freeze({
    rowType: "tile" as const,
    verdict: kinds.length > 0 ? "measured" : named.size > 0 ? "not_measured" : "empty",
    tiles,
    kinds: Object.freeze(kinds),
    kindsOutsideScope: 0,
    extent: Object.freeze({ x0: result.x, y0: result.y, x1: result.x + result.w - 1, y1: result.y + result.h - 1 }),
    spelling: selectionSpelling(selection, named.size),
    text: "",
  });
  return Object.freeze({ ...answer, text: renderTileAnswer(answer, result) });
}

/** The model-facing block for a rectangle read: what was read, then the counts, then the rows, then the absences. */
function renderTileAnswer(answer: TileSelectionAnswer, result: Readonly<TileAreaResult>): string {
  const lines: string[] = [];
  lines.push(
    `矩形（revision ${String(result.revision)}）：${String(result.w)}×${String(result.h)} = ${String(
      result.w * result.h,
    )} 格，一次读取，位置 ${result.location ?? "未命名"}。这些格是 Mod 逐格读出来的，不是已发布行拼出来的。`,
  );
  lines.push(
    `格子：${String(answer.tiles.withRows)} 格有东西 · ${String(answer.tiles.empty)} 格测过是空的 · ${String(
      answer.tiles.unreadable,
    )} 格没读到${answer.tiles.unreadableNamed.length === 0 ? "" : `（${answer.tiles.unreadableNamed.join("、")}）`}`,
  );
  const total = answer.kinds.reduce((sum, kind) => sum + kind.count, 0);
  const shown = answer.kinds.reduce((sum, kind) => sum + kind.shown.length, 0);
  const omitted = answer.kinds.reduce((sum, kind) => sum + kind.omitted, 0);
  if (total > 0)
    lines.push(
      `这块里的格：${answer.kinds
        .map((kind) => `${kind.label} ${String(kind.count)}`)
        .join(" · ")}（共 ${String(total)} 格；列出 ${String(shown)} 格，其余 ${String(omitted)} 格未列出）`,
    );
  for (const kind of answer.kinds)
    lines.push(
      `${kind.label} ${String(kind.count)} 格：${kind.shown.map(tileRowText).join(" ")}${
        kind.omitted > 0 ? ` 其余 ${String(kind.omitted)} 格未列出` : ""
      }`,
    );
  if (answer.tiles.unreadable > 0) lines.push("没读到的格子不是空的：那几格的 occupant 和 tillable 这次没有人回答。");
  if (total === 0) lines.push(verdictSentence(answer));
  return lines.join("\n");
}

/**
 * Every way a rectangle answer disagrees with the rows it was built from. Empty means the construction holds.
 *
 * The recount reads the SAME rows the answer was built from, so a lost row, a kind that swallowed its neighbour's tile,
 * or a cap applied to the wrong list is a red gate naming the drifting kind rather than a number nobody can check.
 */
export function tileSelectionDisagreements(
  result: Readonly<TileAreaResult>,
  answer: TileSelectionAnswer,
): readonly string[] {
  const rows = result.rows ?? [];
  const read = new Set(rows.map((row) => tileKey(row.x, row.y)));
  const codes: string[] = [];
  for (const kind of answer.kinds) {
    const recount = rows.filter((row) => row.occupantKind === kind.kind).length;
    if (recount !== kind.count || kind.count !== kind.shown.length + kind.omitted)
      codes.push(selectionDisagreementCode(answer.spelling, kind.kind));
    if (kind.shown.some((row) => row.occupantKind !== kind.kind || !read.has(tileKey(row.x, row.y))))
      codes.push(`region_summary_includes_a_row_outside_the_selection:${answer.spelling}:${kind.kind}`);
  }
  if (answer.kinds.reduce((sum, kind) => sum + kind.count, 0) !== rows.length)
    codes.push(`region_rows_unaccounted:${answer.spelling}`);
  if (answer.tiles.named !== answer.tiles.withRows + answer.tiles.empty + answer.tiles.unreadable)
    codes.push(`region_tile_accounting_disagrees:${answer.spelling}`);
  selectionGateCounters.observations += 1;
  selectionGateCounters.kinds += answer.kinds.length;
  selectionGateCounters.disagreements += codes.length;
  return Object.freeze(codes);
}

/** The observation with every published row family removed, so a selection answer does not print the world twice. */
export function withoutRowFamilies(snapshot: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const stripped: Record<string, unknown> = { ...snapshot };
  for (const family of Object.keys(TARGET_FAMILY_LABELS)) delete stripped[family];
  return Object.freeze(stripped);
}

// ---------------------------------------------------------------------------------------------------------------
// The gate: a summary that disagrees with the rows it carries is refused, not shipped.
// ---------------------------------------------------------------------------------------------------------------
//
// The population is every observation that carried a selection; the property is that each kind's stated count equals
// the rows the same answer carries plus the rows it says it counted and did not name, and that the named tiles add up.
// The recount below reads the SAME published rows the answer was built from, which is what makes a disagreement
// possible at all: a filter that drops a row, a cap applied to the wrong list, or a bucket that loses a tile shows up
// as a number that does not add up.

const selectionGateCounters = { observations: 0, kinds: 0, disagreements: 0 };

/** Operator evidence: `observations examined N · kinds K · disagreeing 0`. */
export function selectionGateReport(): string {
  return `observations examined ${String(selectionGateCounters.observations)} · kinds ${String(
    selectionGateCounters.kinds,
  )} · disagreeing ${String(selectionGateCounters.disagreements)}`;
}

/** Code for a summary that does not add up, spelling the selection and the kind that disagreed. */
export function selectionDisagreementCode(spelling: string, kind: string): string {
  return `region_summary_disagrees_with_the_rows:${spelling}:${kind}`;
}

/**
 * Every way `answer` disagrees with the published rows it was built from. Empty means the construction holds.
 *
 * Naming the drifting member is the point: a code says which kind, so the next reader does not have to re-derive the
 * whole selection to find the one row that went missing.
 */
export function selectionDisagreements(
  snapshot: Snapshot,
  selection: ObservationSelection,
  answer: FamilySelectionAnswer,
): readonly string[] {
  const named = namedSelectionTiles(selection);
  const admissions = new Map(
    answer.kinds.map((kind) => [
      kind.kind,
      (tile: Readonly<{ x: number; y: number }>): boolean =>
        named.has(tileKey(tile.x, tile.y)) ||
        selection.predicates.some((predicate) => predicateAdmitsRow(predicate, kind.kind, tile)),
    ]),
  );
  const codes: string[] = [];
  for (const kind of answer.kinds) {
    const family = (snapshot as unknown as Record<string, unknown>)[kind.kind];
    const value = Array.isArray(family) ? family : [];
    const placeable = placedTargetTiles(value, ROW_STATE_FIELDS[kind.kind]);
    const admits = admissions.get(kind.kind);
    const recount =
      admits === undefined
        ? 0
        : placeable.filter((tile) => admits(tile)).length +
          (selection.predicates.some((predicate) => predicateAdmitsUnplacedRow(predicate, kind.kind))
            ? value.length - placeable.length
            : 0);
    if (recount !== kind.count || kind.count !== kind.shown.length + kind.omitted)
      codes.push(selectionDisagreementCode(answer.spelling, kind.kind));
    if (admits !== undefined && kind.shown.some((row) => !admits(row)))
      codes.push(`region_summary_includes_a_row_outside_the_selection:${answer.spelling}:${kind.kind}`);
  }
  if (answer.tiles.named !== answer.tiles.withRows + answer.tiles.empty + answer.tiles.unreadable)
    codes.push(`region_tile_accounting_disagrees:${answer.spelling}`);
  selectionGateCounters.observations += 1;
  selectionGateCounters.kinds += answer.kinds.length;
  selectionGateCounters.disagreements += codes.length;
  return Object.freeze(codes);
}
