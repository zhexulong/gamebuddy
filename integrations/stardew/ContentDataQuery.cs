using System.Globalization;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using StardewValley;
using StardewValley.GameData.BigCraftables;
using StardewValley.GameData.Buildings;
using StardewValley.GameData.Crops;
using StardewValley.GameData.FarmAnimals;
using StardewValley.GameData.Machines;
using StardewValley.GameData.Objects;
using StardewValley.GameData.Shops;
using StardewValley.GameData.Tools;

namespace GameBuddy.Stardew;

/// <summary>
/// The game's own content tables, answered to the Agent.
///
/// <para>
/// "How do I get an animal?", "what does Marnie charge for a chicken?", "how many days until this hen lays?" are
/// questions about `Data/FarmAnimals`, `Data/Shops` and `Data/Machines`, and before this class there was no channel to
/// any of them: the companion could see a coop standing on the farm and could not say what it produces. The tables were
/// already in the engine's cache, filed in the observation baseline as "never read", which was the debt this pays.
/// </para>
/// <para>
/// Every row is read through the engine's own loader (`DataLoader`), never from a file this Mod ships and never from a
/// constant copied into this source, so a content pack that edits `Data/FarmAnimals` changes the answer. Each table
/// declares the engine cache property it is the parsed form of (<c>Game1.farmAnimalData</c>) so
/// `tools/audit-stardew-discovery-channels.mjs` can prove that every `Game1.*Data` this Mod touches is either askable
/// or carries a stated reason.
/// </para>
/// <para>
/// A row is PROJECTED, never dumped: the fields kept are the ones an action decides from (what a building costs, how
/// long it takes, what an animal produces and when, what a shop sells and for how much), and the ones dropped are the
/// presentation half - textures, sprite indexes, sounds, hitboxes, shadow frames - which no action reads and which
/// would turn one answer into an observation. `not_projectable` is a first-class answer for a table whose rows are too
/// large to answer with at all.
/// </para>
/// </summary>
internal static class ContentDataQuery
{
    /// <summary>One queryable table: its engine asset, the cache property it is parsed into, and how it answers.</summary>
    private sealed record Table(
        string Asset,
        string EngineCache,
        Func<IReadOnlyList<string>> Ids,
        Func<string, BridgeDataQueryRow?> Row,
        string? NotProjectable = null);

    /// <summary>Shop entries per row. A shop that sells forty things answers with twelve and the count it did not show.</summary>
    private const int MaximumShopItems = 12;

    /// <summary>Distinct machine outputs and triggers per row, bounded for the same reason.</summary>
    private const int MaximumMachineFacts = 8;

    /// <summary>Building materials per row.</summary>
    private const int MaximumBuildingMaterials = 6;

    private static readonly Dictionary<string, Table> Tables = new(StringComparer.Ordinal)
    {
        ["FarmAnimals"] = Of<FarmAnimalData>(
            "Data/FarmAnimals",
            "Game1.farmAnimalData",
            () => DataLoader.FarmAnimals(Game1.content),
            FarmAnimalRow),
        ["Buildings"] = Of<BuildingData>(
            "Data/Buildings",
            "Game1.buildingData",
            () => DataLoader.Buildings(Game1.content),
            BuildingRow),
        ["Crops"] = Of<CropData>(
            "Data/Crops",
            "Game1.cropData",
            () => DataLoader.Crops(Game1.content),
            CropRow),
        ["Objects"] = Of<ObjectData>(
            "Data/Objects",
            "Game1.objectData",
            () => DataLoader.Objects(Game1.content),
            ObjectRow),
        ["BigCraftables"] = Of<BigCraftableData>(
            "Data/BigCraftables",
            "Game1.bigCraftableData",
            () => DataLoader.BigCraftables(Game1.content),
            BigCraftableRow),
        ["Tools"] = Of<ToolData>(
            "Data/Tools",
            "Game1.toolData",
            () => DataLoader.Tools(Game1.content),
            ToolRow),
        // Machines and Shops are the two tables an action reads that the engine keeps no `Game1.*Data` cache for: the
        // mod-facing loader is the only way in, and it is the same one `Object` and `ShopBuilder` call.
        ["Machines"] = Of<MachineData>(
            "Data/Machines",
            "DataLoader.Machines",
            () => DataLoader.Machines(Game1.content),
            MachineRow),
        ["Shops"] = Of<ShopData>(
            "Data/Shops",
            "DataLoader.Shops",
            () => DataLoader.Shops(Game1.content),
            ShopRow),
        // A location row is tens of kilobytes of spawn tables, fish lists and art. Answering with it would be an
        // observation, so this table refuses by name instead of dumping a fragment that looks like an answer.
        ["Locations"] = new Table(
            "Data/Locations",
            "Game1.locationData",
            static () => Array.Empty<string>(),
            static _ => null,
            "each row is a LocationData whose spawn, fish and forage tables are tens of kilobytes; the locations " +
            "themselves are already published as world rows, and no action chooses a target from this table"),
        // The one question about `Data/Locations` that IS answerable: which species MAY be caught in one location at this
        // moment. It is a different table from `Locations` on purpose - that one refuses because a whole row is an
        // observation, while this one projects two tables into the rows an action decides on (`fish_here` is the action,
        // and its admission guard reads the same answer through `FishingCatchableQuery.Answer`).
        ["LocationFish"] = new Table(
            "LocationFish",
            "Game1.locationData",
            LocationFishIds,
            LocationFishRow),
    };

    private static Table Of<T>(
        string asset,
        string engineCache,
        Func<Dictionary<string, T>> load,
        Func<string, T, BridgeDataQueryRow> project)
    {
        return new Table(
            asset,
            engineCache,
            () => load().Keys.OrderBy(static key => key, StringComparer.Ordinal).ToArray(),
            key => load().TryGetValue(key, out T? value) && value is not null ? project(key, value) : null);
    }

    /// <summary>
    /// The one answer: the row ids, one projected row, an absent row, an unknown table, or a table that refuses.
    ///
    /// <para>
    /// `Population` is counted for every table that was found, including the one a missing key was asked of, so
    /// "there is no such row" arrives with the size of the table it is missing from.
    /// </para>
    /// </summary>
    internal static BridgeDataQueryResult Answer(string table, string? key)
    {
        if (!Tables.TryGetValue(table, out Table? definition))
            return new BridgeDataQueryResult(
                "unknown_table",
                table,
                -1,
                null,
                null,
                $"the engine has no content table named `{table}`");
        if (definition.NotProjectable is not null)
            return new BridgeDataQueryResult("not_projectable", table, -1, null, null, definition.NotProjectable);
        IReadOnlyList<string> ids = definition.Ids();
        if (string.IsNullOrWhiteSpace(key))
            return new BridgeDataQueryResult("index", table, ids.Count, ids, null, null);
        BridgeDataQueryRow? row = definition.Row(key);
        return row is null
            ? new BridgeDataQueryResult(
                "absent_row",
                table,
                ids.Count,
                null,
                null,
                $"`{table}` has {ids.Count.ToString(CultureInfo.InvariantCulture)} row(s) and none is `{key}`")
            : new BridgeDataQueryResult("row", table, ids.Count, null, row, null);
    }

    /// <summary>Whether this Mod exposes the named table at all, for the discovery audit's own cross-check.</summary>
    internal static bool Exposes(string table) => Tables.ContainsKey(table);

    /// <summary>
    /// The fields an action decides from, in the order the answer prints them.
    ///
    /// A null value is kept rather than dropped: "the data declares no harvest tool" and "this answer did not carry the
    /// field" are different facts, and only one of them is true.
    /// </summary>
    private static IReadOnlyDictionary<string, object?> Fields(params (string Name, object? Value)[] fields)
    {
        Dictionary<string, object?> map = new(StringComparer.Ordinal);
        foreach ((string name, object? value) in fields) map[name] = value;
        return map;
    }

    /// <summary>
    /// One farm animal: how long it takes to mature, what it produces and when, and the house it must live in.
    ///
    /// Dropped: textures, sprite frames, sounds, skins, shadows, hitboxes, pregnancy and profession plumbing - none of
    /// them decides whether a milk pail works or what a hen costs.
    /// </summary>
    internal static BridgeDataQueryRow FarmAnimalRow(string id, FarmAnimalData data) =>
        new(
            id,
            Fields(
                ("displayName", data.DisplayName),
                ("house", data.House),
                ("daysToMature", data.DaysToMature),
                ("daysToProduce", data.DaysToProduce),
                ("produce", ProduceIds(data.ProduceItemIds)),
                ("deluxeProduce", ProduceIds(data.DeluxeProduceItemIds)),
                ("deluxeProduceMinimumFriendship", data.DeluxeProduceMinimumFriendship),
                ("harvestType", data.HarvestType.ToString()),
                ("harvestTool", data.HarvestTool),
                ("produceOnMature", data.ProduceOnMature),
                ("purchasePrice", data.PurchasePrice),
                ("sellPrice", data.SellPrice),
                ("requiredBuilding", data.RequiredBuilding),
                ("canGetPregnant", data.CanGetPregnant)));

    /// <summary>
    /// The item ids a produce list names.
    ///
    /// `FarmAnimalData.ProduceItemIds` is a list of `FarmAnimalProduce` records (id, condition, minimum friendship),
    /// not a list of strings. The row carries the ITEM IDS, because that is what a caller names when it acts, and the
    /// friendship threshold travels as its own scalar (`deluxeProduceMinimumFriendship`) rather than as text welded
    /// onto an id - an answer whose values are half data and half prose cannot be compared by anything.
    /// </summary>
    private static IReadOnlyList<string> ProduceIds(IReadOnlyList<FarmAnimalProduce>? produce)
    {
        if (produce is null) return Array.Empty<string>();
        List<string> ids = new(produce.Count);
        foreach (FarmAnimalProduce entry in produce)
        {
            if (!string.IsNullOrEmpty(entry.ItemId)) ids.Add(entry.ItemId);
        }
        return ids;
    }

    /// <summary>
    /// One building type: what the commission charges, how many days it takes, its footprint, its materials, and the
    /// door/animal-door geometry that decides whether the actor can walk in or reach the animals.
    ///
    /// Dropped: textures, draw offsets, skins, sounds, tile properties, indoor item moves - the menu's half.
    /// </summary>
    private static BridgeDataQueryRow BuildingRow(string id, BuildingData data) =>
        new(
            id,
            Fields(
                ("displayName", data.Name),
                ("size", $"{data.Size.X.ToString(CultureInfo.InvariantCulture)}x{data.Size.Y.ToString(CultureInfo.InvariantCulture)}"),
                ("buildCost", data.BuildCost),
                ("buildDays", data.BuildDays),
                ("materials", Bounded(data.BuildMaterials.Select(static material =>
                    $"{material.ItemId} x{material.Amount.ToString(CultureInfo.InvariantCulture)}"), MaximumBuildingMaterials)),
                ("buildingToUpgrade", data.BuildingToUpgrade),
                ("magicalConstruction", data.MagicalConstruction),
                ("humanDoor", $"{data.HumanDoor.X.ToString(CultureInfo.InvariantCulture)},{data.HumanDoor.Y.ToString(CultureInfo.InvariantCulture)}"),
                ("animalDoor", $"{data.AnimalDoor.X.ToString(CultureInfo.InvariantCulture)},{data.AnimalDoor.Y.ToString(CultureInfo.InvariantCulture)} {data.AnimalDoor.Width.ToString(CultureInfo.InvariantCulture)}x{data.AnimalDoor.Height.ToString(CultureInfo.InvariantCulture)}"),
                ("indoorMap", data.IndoorMap),
                ("maxOccupants", data.MaxOccupants),
                ("validOccupantTypes", data.ValidOccupantTypes),
                ("hayCapacity", data.HayCapacity)));

    /// <summary>
    /// One crop: the seasons it grows in, the days each phase takes, what it yields and how, and whether it regrows.
    ///
    /// Dropped: tint colours, textures, sprite index, the monoculture/polyculture bookkeeping.
    /// </summary>
    private static BridgeDataQueryRow CropRow(string id, CropData data) =>
        new(
            id,
            Fields(
                ("seasons", data.Seasons),
                ("daysInPhase", data.DaysInPhase),
                ("daysToHarvest", data.DaysInPhase.Sum()),
                ("regrowDays", data.RegrowDays),
                ("harvestItemId", data.HarvestItemId),
                ("harvestMethod", data.HarvestMethod.ToString()),
                ("harvestMinStack", data.HarvestMinStack),
                ("harvestMaxStack", data.HarvestMaxStack),
                ("harvestMinQuality", data.HarvestMinQuality),
                ("harvestMaxQuality", data.HarvestMaxQuality),
                ("needsWatering", data.NeedsWatering),
                ("isRaised", data.IsRaised),
                ("isPaddyCrop", data.IsPaddyCrop)));

    /// <summary>
    /// One object: what it is, what it is worth, and whether eating it is a drink (the fact `use_item` decides on).
    ///
    /// Dropped: texture, sprite index, buffs, geode and artifact-spot tables, context tags, gift/trash flags.
    /// </summary>
    private static BridgeDataQueryRow ObjectRow(string id, ObjectData data) =>
        new(
            id,
            Fields(
                ("name", data.Name),
                ("displayName", data.DisplayName),
                ("type", data.Type),
                ("category", data.Category),
                ("price", data.Price),
                ("edibility", data.Edibility),
                ("isDrink", data.IsDrink),
                ("canBeGivenAsGift", data.CanBeGivenAsGift)));

    /// <summary>One big craftable: its price, where it may be placed, and whether it is a lamp.</summary>
    private static BridgeDataQueryRow BigCraftableRow(string id, BigCraftableData data) =>
        new(
            id,
            Fields(
                ("name", data.Name),
                ("displayName", data.DisplayName),
                ("price", data.Price),
                ("fragility", data.Fragility),
                ("canBePlacedOutdoors", data.CanBePlacedOutdoors),
                ("canBePlacedIndoors", data.CanBePlacedIndoors),
                ("isLamp", data.IsLamp)));

    /// <summary>One tool: what class it is, its upgrade level, what it upgrades from, and its sale price.</summary>
    private static BridgeDataQueryRow ToolRow(string id, ToolData data) =>
        new(
            id,
            Fields(
                ("className", data.ClassName),
                ("name", data.Name),
                ("displayName", data.DisplayName),
                ("upgradeLevel", data.UpgradeLevel),
                ("conventionalUpgradeFrom", data.ConventionalUpgradeFrom),
                ("upgradeFrom", data.UpgradeFrom),
                ("salePrice", data.SalePrice),
                ("attachmentSlots", data.AttachmentSlots)));

    /// <summary>
    /// One machine: what it accepts, what it produces, and how long it takes.
    ///
    /// The rules are what `MachineDataUtility.CanApplyOutput` walks, so the answer names the triggers and the output
    /// item ids rather than the rule objects: a caller asking "what goes in a keg" wants the item ids and the minutes,
    /// not the condition trees. Dropped: load/working effects, lights, sprites, stat increments, message strings.
    /// </summary>
    private static BridgeDataQueryRow MachineRow(string id, MachineData data)
    {
        IReadOnlyList<MachineOutputRule> rules = data.OutputRules ?? new List<MachineOutputRule>();
        return new BridgeDataQueryRow(
            id,
            Fields(
                ("hasInput", data.HasInput),
                ("hasOutput", data.HasOutput),
                ("isIncubator", data.IsIncubator),
                ("allowLoadWhenFull", data.AllowLoadWhenFull),
                ("onlyCompleteOvernight", data.OnlyCompleteOvernight),
                ("ruleCount", rules.Count),
                ("triggers", Bounded(rules
                    .Where(static rule => rule.Triggers is not null)
                    .SelectMany(static rule => rule.Triggers)
                    .Select(static trigger => trigger.ToString() ?? string.Empty)
                    .Distinct(StringComparer.Ordinal), MaximumMachineFacts)),
                ("outputs", Bounded(rules
                    .Where(static rule => rule.OutputItem is not null)
                    .SelectMany(static rule => rule.OutputItem)
                    .Select(static output => output.ItemId)
                    .Where(static itemId => !string.IsNullOrEmpty(itemId))
                    .Select(static itemId => itemId!)
                    .Distinct(StringComparer.Ordinal), MaximumMachineFacts)),
                ("minutesUntilReady", rules.Count > 0 ? rules[0].MinutesUntilReady : 0),
                ("daysUntilReady", rules.Count > 0 ? rules[0].DaysUntilReady : 0)));
    }

    /// <summary>
    /// One shop: its currency and what it sells, with the price and stock of each entry.
    ///
    /// The prices here are the table's own declared ones; `ShopBuilder` applies profit margins, price modifiers and the
    /// player's own condition state when the menu opens, and the purchase action's receipt carries what was actually
    /// charged. A caller that needs the exact charge reads the receipt, not this row.
    /// </summary>
    private static BridgeDataQueryRow ShopRow(string id, ShopData data)
    {
        IReadOnlyList<ShopItemData> items = data.Items ?? new List<ShopItemData>();
        return new BridgeDataQueryRow(
            id,
            Fields(
                ("currency", data.Currency),
                ("itemCount", items.Count),
                ("items", Bounded(items.Select(static item => DescribeShopItem(item)), MaximumShopItems))));
    }

    private static string DescribeShopItem(ShopItemData item)
    {
        string stock = item.AvailableStock > 0
            ? item.AvailableStock.ToString(CultureInfo.InvariantCulture)
            : "unlimited";
        string trade = string.IsNullOrEmpty(item.TradeItemId)
            ? string.Empty
            : $" for {item.TradeItemAmount.ToString(CultureInfo.InvariantCulture)} {item.TradeItemId}";
        return $"{item.ItemId} price={item.Price.ToString(CultureInfo.InvariantCulture)} stock={stock}{trade}";
    }

    /// <summary>The first `limit` entries plus the count that did not fit, so a short list is never mistaken for a full one.</summary>
    private static IReadOnlyList<string> Bounded(IEnumerable<string> values, int limit)
    {
        List<string> all = values.ToList();
        if (all.Count <= limit) return all;
        List<string> bounded = all.GetRange(0, limit);
        bounded.Add($"+{all.Count - limit} more");
        return bounded;
    }

    /// <summary>
    /// Species lines one answer carries per half: fifteen plus one omission line, because the wire admits at most sixteen
    /// entries in a field array (<c>host/src/protocol.ts:3168</c>) and a seventeenth entry would refuse the whole row.
    /// </summary>
    private const int MaximumLocationSpecies = 15;

    /// <summary>
    /// The keys <c>LocationFish</c> answers: <see cref="FishingCatchableQuery.HereKey"/> first, then every location
    /// <c>Data/Locations</c> declares.
    ///
    /// <para>
    /// `Default` is deliberately absent: it is the shared spawn row the engine concatenates into EVERY location
    /// (<c>GameLocation.cs:13940-13944</c>), not a place the actor can stand in, so listing it would invite a caller to ask
    /// what may be caught in a location that does not exist.
    /// </para>
    /// </summary>
    private static IReadOnlyList<string> LocationFishIds()
    {
        List<string> names = new() { FishingCatchableQuery.HereKey };
        names.AddRange(Game1.locationData.Keys
            .Where(static key => !string.Equals(key, "Default", StringComparison.Ordinal))
            .OrderBy(static key => key, StringComparer.Ordinal));
        return names;
    }

    /// <summary>
    /// One location's fish answer, projected into the fields a caller decides from.
    ///
    /// <para>
    /// <c>status</c> is <c>measured</c> or <c>not_measured</c>, and a not-measured answer carries no species at all rather
    /// than an empty list: the two look identical in a language without null, and only one of them is a claim about the
    /// world. <c>catchable</c> and <c>blocked</c> are bounded lines, one per species, and each blocked line ends with the
    /// code that names the fact which would have to change.
    /// </para>
    /// </summary>
    private static BridgeDataQueryRow LocationFishRow(string key)
    {
        FishingCatchableQuery.FishingCatchAnswer answer = FishingCatchableQuery.Answer(Game1.player, key);
        FishingCatchReport report = answer.Report;
        FishingMoment? moment = answer.Moment;
        return new BridgeDataQueryRow(
            key,
            Fields(
                ("status", report.Measured ? "measured" : "not_measured"),
                ("reason", report.NotMeasuredReason ?? string.Empty),
                ("location", moment?.Location ?? key),
                ("season", moment?.Season ?? string.Empty),
                ("day", moment?.DayOfMonth ?? 0),
                ("timeOfDay", moment?.TimeOfDay ?? 0),
                ("raining", moment?.Raining ?? false),
                ("fishingLevel", moment?.FishingLevel ?? 0),
                ("fishArea", moment?.FishAreaId),
                ("examined", report.Examined),
                ("catchableCount", report.Catchable.Count),
                ("blockedCount", report.Blocked.Count),
                ("depthApplied", report.DepthApplied),
                ("junkFallbackSpecies", FishingCatchable.JunkFallbackSpecies),
                ("catchable", Bounded(report.Catchable.Select(static row => DescribeSpecies(row, blocked: false)), MaximumLocationSpecies)),
                ("catchableOmitted", Math.Max(0, report.Catchable.Count - MaximumLocationSpecies)),
                ("blocked", Bounded(report.Blocked.Select(static row => DescribeSpecies(row, blocked: true)), MaximumLocationSpecies)),
                ("blockedOmitted", Math.Max(0, report.Blocked.Count - MaximumLocationSpecies))));
    }

    /// <summary>
    /// One species as a single line: who it is, how hard it fights, what it needs, when, in what weather, and - when it is
    /// blocked - the code naming the fact that would change the answer.
    /// </summary>
    private static string DescribeSpecies(FishingSpeciesRow row, bool blocked)
    {
        string label = row.DisplayName is { Length: > 0 } display ? $"{row.Species} {display}" : row.Species;
        string line = string.Format(
            CultureInfo.InvariantCulture,
            "{0} difficulty={1} level={2} window={3} weather={4}",
            label,
            row.Difficulty?.ToString(CultureInfo.InvariantCulture) ?? "none",
            row.MinimumFishingLevel.ToString(CultureInfo.InvariantCulture),
            row.TimeWindow,
            row.Weather);
        return blocked ? $"{line} blocked_by={row.BlockedCode}" : line;
    }
}
