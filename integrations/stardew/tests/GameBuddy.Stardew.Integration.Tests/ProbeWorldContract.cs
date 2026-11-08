using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.TerrainFeatures;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// What a COMPLETE probe world owes: the values a real `Game1`, `Farmer` and `Crop` carry because the game itself
/// assigns them at construction or at startup, and which `FormatterServices.GetUninitializedObject` silently skips.
///
/// <para>
/// WHY THIS EXISTS. Five one-line omissions in the probe farmer were each reported as "the engine cannot do this", for
/// a week, and two of them are quoted verbatim in the reasons this file now re-checks: a zero `Farmer.maxStamina`
/// clamped every swing's stamina to 0 and put the swing into `Farmer.checkForExhaustion`, which reads `Game1.content`
/// (recorded as "ends in Farmer.checkForExhaustion, which reads Game1.content"); a null `Game1.recentMultiplayerRandom`
/// threw inside `Debris.InitializeChunks` on every `Game1.createRadialDebris` (recorded as "needs the item
/// type-definition registry"); a null `Game1.currentLocation` broke `ResourceClump.performToolAction`'s debris spawn; a
/// zero-length `Farmer.experiencePoints` threw `ArgumentOutOfRangeException` from `gainExperience`; and a null
/// `Crop.raisedSeeds` made `HoeDirt.shake` dereference null on every native watering. Every one of them read as an
/// engine limit because nothing said what a complete world owes - so the harness could be incomplete and the engine took
/// the blame.
/// </para>
///
/// <para>
/// THE RULE THAT DECIDES MEMBERSHIP. A value is a contract fact when the GAME assigns it unconditionally - a field
/// initializer (`Farmer.maxStamina`, `Farmer.mailbox`, `Crop.raisedSeeds`) or a startup static (`Game1.random`,
/// `Game1.options`). A value the game produces from a SAVE, from loaded CONTENT, or from map data is NOT: it belongs in
/// <see cref="Exemptions"/> with the class and the source that produces it, so "the probe does not have it" can never be
/// quietly true of a field a real game assigns without asking.
/// </para>
///
/// <para>
/// THE POPULATION IS DERIVED TWICE, NEVER LISTED. <see cref="Claims"/> carries the five measured causes above and every
/// other value whose absence this suite has recorded; and every dotted spelling a recorded `Undriven` reason names is
/// resolved against the game's own types, so a reason added later cannot blame a field nobody has classified - it fails
/// by name until it is either a claim or an exemption.
/// </para>
/// </summary>
internal static class ProbeWorldContract
{
    /// <summary>
    /// One fact a complete probe world owns, the game assignment it comes from, the shipped call path that breaks
    /// without it, and a measurement of the constructed world.
    ///
    /// <para>
    /// <see cref="Measure"/> returns the EMPTY STRING when the world satisfies the claim, and the observed fact when it
    /// does not: the contract measures, the test asserts, and the failure message can then carry the evidence once
    /// rather than restating it in two shapes.
    /// </para>
    /// </summary>
    /// <param name="EngineValue">The value, spelled the way a recorded reason spells it.</param>
    /// <param name="Spellings">
    /// Every spelling a reason may use for the SAME value. `Game1.currentLocation` deliberately lists only the qualified
    /// form: three recorded reasons say "a currentLocation of type Farm" and mean `player.currentLocation`, a different
    /// fact that the world also supplies.
    /// </param>
    /// <param name="AssignedBy">The game's own assignment, with the source location, so the claim can be re-derived.</param>
    /// <param name="BreaksWithout">The shipped call path that dereferences it, i.e. what breaks when the claim is false.</param>
    /// <param name="Measure">The measurement against one constructed world.</param>
    internal sealed record Claim(
        string EngineValue,
        string[] Spellings,
        string AssignedBy,
        string BreaksWithout,
        Func<TargetFamilyWorld, string> Measure);

    /// <summary>
    /// Why a value a recorded reason names is NOT a fact of the world's construction. Each class says who produces it
    /// instead, which is the whole content of the exemption: a save, an asset, or the engine's own map reading.
    /// </summary>
    internal enum ValueClass
    {
        /// <summary>Populated by a `Data/*` asset load, i.e. by a content manager this process does not have.</summary>
        Content,

        /// <summary>Populated from a save, i.e. only after a save was loaded or a day advanced in it.</summary>
        Save,

        /// <summary>Written by the engine from the current map or location, not from a farmer or a save.</summary>
        Derived,

        /// <summary>A field on a per-object instance the fixture builds where it needs one, not a world-level fact.</summary>
        PerObject,

        /// <summary>
        /// The XNA game object itself (`GameRunner.instance`): it carries the graphics device, the content manager and the
        /// game loop, so a process without a display cannot construct one and any body that reads it stops there.
        /// </summary>
        Host,
    }

    /// <summary>One value a recorded reason names that is not a construction fact, with the source that owns it.</summary>
    internal sealed record Exemption(string EngineValue, ValueClass Class, string Evidence);

    /// <summary>
    /// THE CONTRACT. Five entries are the measured causes of the week this file exists for; the rest are values whose
    /// absence this suite has already recorded as an engine limitation, and two of them (`Farmer.mailbox`,
    /// `Farmer.newLevels`) are named by reasons currently standing in `Undriven`.
    /// </summary>
    internal static readonly IReadOnlyList<Claim> Claims = new Claim[]
    {
        new(
            "Farmer.maxStamina",
            new[] { "Farmer.maxStamina", "maxStamina", "MaxStamina" },
            "Farmer.cs:599 `public readonly NetInt maxStamina = new NetInt(270)`; `MaxStamina` is "
            + "`Math.Max(maxStamina.Value + buffs.MaxStamina, 0)` (Farmer.cs:1842)",
            "`Farmer.Stamina`'s setter clamps every write to `Math.Min(MaxStamina, ...)` (Farmer.cs:1836), so a zero "
            + "maximum drives the FIRST swing of every tool action to 0; `checkForExhaustion` then takes its "
            + "`stamina <= 0` branch and calls `Game1.content.LoadString` (Farmer.cs:6857-6872), which is why "
            + "`break_rock`, `clear_hoedirt` and the rest were reported as a content-manager limit at a seam none of "
            + "them owns",
            world =>
            {
                if (world.Actor.MaxStamina <= 0) return $"MaxStamina is {world.Actor.MaxStamina}";
                world.PopulateFor("rockSourceTargets");
                float before = world.Actor.Stamina;
                TargetRoundTripProbe.Outcome outcome = TargetRoundTripProbe.Run(world, "break_rock", "rockSourceTargets");
                if (!outcome.Accepted) return $"the break_rock swing was refused: {outcome.Refusal}";
                return world.Actor.Stamina < before
                    ? string.Empty
                    : $"a break_rock swing left Stamina at {before} instead of spending it";
            }),
        new(
            "Game1.recentMultiplayerRandom",
            new[] { "Game1.recentMultiplayerRandom", "recentMultiplayerRandom" },
            "Game1.cs:817 `public static Random recentMultiplayerRandom;`, assigned in game startup (Game1.cs:2238)",
            "`Debris.InitializeChunks` builds every chunk from `Game1.recentMultiplayerRandom.Next(...)` (Debris.cs:568), "
            + "so the first cosmetic chunk of any tool swing threw inside `Game1.createRadialDebris` - recorded against "
            + "`break_resource_clump`, `clear_debris` and `break_rock` as a limitation of the actions themselves",
            _ => Game1.recentMultiplayerRandom is null ? "Game1.recentMultiplayerRandom is null" : string.Empty),
        new(
            "Game1.currentLocation",
            new[] { "Game1.currentLocation" },
            "Game1.cs:445 `public GameLocation instanceGameLocation;`, surfaced by the `currentLocation` property "
            + "(Game1.cs:1328-1333) and assigned on every warp",
            "`ResourceClump.performToolAction` hands that STATIC to `Game1.createRadialDebris`, and so do the debris and "
            + "grass bodies: a null static threw in their cosmetic spawn, which is where those families were recorded as "
            + "harness limits",
            world =>
            {
                GameLocation? current = Game1.currentLocation;
                if (current is null) return "Game1.currentLocation is null";
                return ReferenceEquals(current, world.Actor.currentLocation)
                    ? string.Empty
                    : $"Game1.currentLocation is `{current.NameOrUniqueName}` while the probe farmer stands in "
                      + $"`{world.Actor.currentLocation?.NameOrUniqueName}`";
            }),
        new(
            "Farmer.experiencePoints",
            new[] { "Farmer.experiencePoints", "experiencePoints" },
            "Farmer.cs:211 `public readonly NetArray<int, NetInt> experiencePoints = new NetArray<int, NetInt>(6)` - one "
            + "slot per skill, and the skill count is read here from the engine's own `getSkillNameFromIndex`, not typed "
            + "into this file",
            "every native skill award indexes it directly (`experiencePoints[which]`, Farmer.cs:3048-3049), so the "
            + "destroying swing of `break_resource_clump` (`gainExperience(2, 25)`, ResourceClump.cs:276) threw "
            + "`ArgumentOutOfRangeException` from inside the game's own bookkeeping",
            world =>
            {
                int skills = 0;
                while (Farmer.getSkillNameFromIndex(skills).Length > 0) skills++;
                return world.Actor.experiencePoints.Length == skills
                    ? string.Empty
                    : $"experiencePoints holds {world.Actor.experiencePoints.Length} slots for {skills} skills";
            }),
        new(
            "Crop.raisedSeeds",
            new[] { "Crop.raisedSeeds", "raisedSeeds" },
            "Crop.cs:85 `public readonly NetBool raisedSeeds = new NetBool();`",
            "`HoeDirt.shake` multiplies by `crop.raisedSeeds.Value` on every native watering (HoeDirt.cs:371), which is "
            + "where `WateringCan.DoFunction` ends, so a crop built without it threw a `NullReferenceException` recorded "
            + "as a limitation of `cropTargets`",
            world =>
            {
                world.PlaceWaterableCrop(x: 3, y: 2);
                return world.Farm.terrainFeatures[new Vector2(3, 2)] is HoeDirt { crop: { } crop }
                    ? crop.raisedSeeds is null ? "Crop.raisedSeeds is null" : string.Empty
                    : "the world built no crop to read";
            }),
        new(
            "Farmer.mailbox",
            new[] { "Farmer.mailbox", "Game1.player.mailbox" },
            "Farmer.cs:259 `public readonly NetStringList mailbox = new NetStringList();`",
            "`mailboxTargets` is the family that reads it, and `GameLocation.mailbox` hands the farmer's list to every "
            + "delivery path: a null list would throw where the family's own predicate indexes it",
            world => world.Actor.mailbox is null ? "Farmer.mailbox is null" : string.Empty),
        new(
            "Farmer.newLevels",
            new[] { "Farmer.newLevels", "Game1.player.newLevels", "newLevels" },
            "Farmer.cs:203 `public readonly NetList<Point, NetPoint> newLevels = new NetList<Point, NetPoint>();`",
            "`gainExperience` appends to it (Farmer.cs:3087) and `pendingLevelUpChoices` publishes it; a null list would "
            + "throw from inside the skill award every tool swing can reach",
            world => world.Actor.newLevels is null ? "Farmer.newLevels is null" : string.Empty),
        new(
            "Game1.random",
            new[] { "Game1.random" },
            "Game1.cs:815 `public static Random random;`, assigned in game startup",
            "`Bush`'s own constructor calls `Game1.random.NextBool()` (Bush.cs:109) and `Utility.CreateRandom` reads it, "
            + "so the constructors of half the world's objects threw before anything was placed",
            _ => Game1.random is null ? "Game1.random is null" : string.Empty),
        new(
            "Game1.otherFarmers",
            new[] { "Game1.otherFarmers" },
            "Game1.cs:1011 `public static NetRootDictionary<long, Farmer> otherFarmers;`, assigned in game startup",
            "`FarmerCollection.Any` reads it while building a native path (`isPlayerPresent`), so a preflight that "
            + "answered a path question threw instead",
            _ => Game1.otherFarmers is null ? "Game1.otherFarmers is null" : string.Empty),
        new(
            "Game1.hudMessages",
            new[] { "Game1.hudMessages" },
            "Game1.cs:873 `public static List<HUDMessage> hudMessages;`, assigned in game startup",
            "`Farmer.couldInventoryAcceptThisItem` reads `Game1.hudMessages.Count` whenever the pack is full "
            + "(Farmer.cs:4741), so a full-pack question threw - which is how `pickup_item` and `chest_retrieve` were "
            + "recorded as content limits",
            _ => Game1.hudMessages is null ? "Game1.hudMessages is null" : string.Empty),
        new(
            "Game1.options",
            new[] { "Game1.options" },
            "Game1.cs:1768 `public static Options options`, created by `Game1`'s constructor",
            "`Rumble.rumble`, reached by every native tool swing that lands a hit, reads `options.gamepadControls` and "
            + "`options.rumble`, so a swing threw after it had already changed the world",
            _ => Game1.options is null ? "Game1.options is null" : string.Empty),
        new(
            "Farmer.stats",
            new[] { "Farmer.stats", "Game1.stats" },
            "Farmer.cs:287 `public Stats stats = new Stats();`, and `Game1.stats` IS `player.stats` (Game1.cs:1671)",
            "`Bush.loadSprite` calls `Utility.CreateRandom(Game1.stats.DaysPlayed, ...)` (Bush.cs:277) and several "
            + "engine constructors read it, so placing a bush threw inside the engine's own bookkeeping",
            world => world.Actor.stats is null ? "Farmer.stats is null" : string.Empty),
        new(
            "Farmer.team",
            new[] { "Farmer.team", "Game1.player.team" },
            "Farmer.cs:1255 `public FarmerTeam team => teamRoot.Value;`, with `teamRoot` initialised to `new "
            + "FarmerTeam()` (Farmer.cs:617)",
            "the native drop tables ask `Game1.player.team` (`SpecialOrderRuleActive(\"DROP_QI_BEANS\")`, Tree.cs:705 and "
            + "Object.cs:1565), so a felled tree or a cut weed threw after the world had already changed",
            world => world.Actor.team is null ? "Farmer.team is null" : string.Empty),
        new(
            "Farmer.maxItems",
            new[] { "Farmer.maxItems", "maxItems" },
            "Farmer.cs:1584 `public int MaxItems`, and the inventory the game starts a farmer with holds exactly that "
            + "many slots",
            "`Farmer.isInventoryFull()` walks `maxItems` slots and answers FULL for every slot the list does not hold "
            + "(Farmer.cs:4702), so a shorter list reads as a full pack and `couldInventoryAcceptThisItem` falls into "
            + "its content-loading branch (Farmer.cs:4743) - exactly how `pickup_item` was recorded as a harness limit",
            world => world.Actor.Items.Count == world.Actor.MaxItems
                ? string.Empty
                : $"the pack holds {world.Actor.Items.Count} slots for maxItems {world.Actor.MaxItems}"),
    };

    /// <summary>
    /// Values a recorded reason names that the world does NOT owe, each with the source that produces it instead.
    ///
    /// These are the reasons that legitimately stand in `Undriven`, and the register is checked in both directions: an
    /// entry whose value no reason names any more is red, because an exemption that outlives the thing it exempts is how
    /// a gap stops being visible.
    /// </summary>
    internal static readonly IReadOnlyList<Exemption> Exemptions = new Exemption[]
    {
        new(
            "Game1.fruitTreeData",
            ValueClass.Content,
            "`fruitTreeData = DataLoader.FruitTrees(content)` (Game1.cs:2886) - a `Data/FruitTrees` asset behind a "
            + "content manager this process does not have, which is what `fruitTreeTargets` records"),
        new(
            "Game1.mine",
            ValueClass.Derived,
            "`Game1.mine` is `(locationRequest?.Location as MineShaft) ?? (currentLocation as MineShaft)` (Game1.cs:1897) "
            + "- non-null exactly while the player stands in a mine shaft, which only a save or a warp produces"),
        new(
            "Game1.mine.lowestLevelReached",
            ValueClass.Save,
            "`MineShaft.lowestLevelReached` is a static int the engine advances as a save descends the mine "
            + "(MineShaft.cs:2938); 0 is the honest value for a save that has never been underground, so "
            + "`mineElevatorFloorTargets` needs a save rather than a fixture"),
        new(
            "Game1.player.mount",
            ValueClass.Save,
            "`Farmer.mount` returns `netMount.Value` (Farmer.cs:1571-1575): the NetRef is a construction fact and the "
            + "horse inside it is a save fact, which is what `horseTargets` records"),
        new(
            "Chest.owner",
            ValueClass.PerObject,
            "inherited from `StardewValley.Object.owner = new NetLong()` (Object.cs:350), so every object the world "
            + "builds carries it; the recorded reason says it IS set (`Chest.owner/playerChest are set`) and blames the "
            + "palette, which makes it a per-object fact rather than a claim about the world"),
        new(
            "Game1.questOfTheDay",
            ValueClass.Save,
            "`Game1.questOfTheDay` reads `netWorldState.Value.QuestOfTheDay`, written by `RefreshQuestOfTheDay` from "
            + "`Utility.getQuestOfTheDay()` at day start (Game1.cs:1674, 2117-2123) - a `Data/Quests` row behind a save's "
            + "day, which is what `dailyQuestTargets` records"),
        new(
            "Game1.petData",
            ValueClass.Content,
            "`petData = DataLoader.Pets(content)` (Game1.cs:2898): this world seeds exactly one `Dog` row so a pet has a "
            + "type to resolve, which is a stand-in for `Data/Pets` and not the asset itself"),
        new(
            "InstanceGame.IsMainInstance",
            ValueClass.Host,
            "`InstanceGame.IsMainInstance` reads `GameRunner.instance.gameInstances` (InstanceGame.cs:12-22), i.e. the XNA "
            + "`Game` object, which a headless process does not have: measured 2026-11-08 as the NullReferenceException "
            + "that stops `harvest_bush` AFTER its target check, which is not the `Data/WildTrees` load the recorded reason "
            + "names"),
        new(
            "GameRunner.instance",
            ValueClass.Host,
            "the XNA `Game` subclass the engine runs in, holding the graphics device, the content manager and the loop; it "
            + "is the same fact `InstanceGame.IsMainInstance` dereferences"),
    };

    /// <summary>
    /// Spellings a recorded reason uses that name no member of this game version. They are not fields, so the contract
    /// cannot assert anything about them; they are REGISTERED rather than tolerated so the population stays total and a
    /// new stale name fails by itself.
    /// </summary>
    internal static readonly IReadOnlyDictionary<string, string> StaleSpellings =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["Game1.player.orePanPoint"] = "`orePanPoint` is `GameLocation.orePanPoint` (GameLocation.cs:310), not a "
                + "`Farmer` field: the pan site belongs to the location, and `panSites` reads it there",
            ["Game1.team.specialOrders"] = "`team` hangs off the farmer - the path is `Game1.player.team.specialOrders` "
                + "(`Farmer.team`, Farmer.cs:1255); `Game1` itself has no `team` member",
            ["Fence.reload"] = "`StardewValley.Fence` declares no `reload` member in this version: a fence is an `Object` "
                + "the save's own field tree restores into the location's object layer, which is the save fact the "
                + "`fenceGateTargets` reason records",
        };

    /// <summary>
    /// The value a reason BLAMES for a family it declares undrivable, or null when it blames nothing the contract owns.
    ///
    /// <para>
    /// Two conditions, both required, because either alone is satisfied by prose that is not a claim about the harness:
    /// a reason must NAME a guaranteed value, and the CLAUSE around that name must call it absent. "a map Action tile
    /// `Mailbox` plus Game1.player.mailbox" names the value and blames the missing tile; "the probe farmer's maxStamina
    /// was zero" names it and blames the harness - which is the shape this test exists to refuse.
    /// </para>
    ///
    /// <para>
    /// The absence vocabulary is deliberately the null/zero family and not "empty": an empty collection a complete world
    /// legitimately has (`Farmer.newLevels` before any level-up) is not a broken contract, while a null one is.
    /// </para>
    /// </summary>
    internal static string? InvalidatedBy(string reason)
    {
        foreach (string clause in reason.Split(';'))
        {
            foreach (Claim claim in Claims)
            {
                if (!claim.Spellings.Any(spelling => clause.Contains(spelling, StringComparison.Ordinal))) continue;
                if (Absence.IsMatch(clause)) return claim.EngineValue;
            }
        }

        return null;
    }

    /// <summary>
    /// The ENGINE fields and properties a reason names, resolved against the game's own types.
    ///
    /// A spelling is in the population when its last segment is a field or property of a type the GAME assembly declares:
    /// a method (`Tree.shake`) names a call path, a type alone (`Building`) is not a value, and a member of a test type
    /// (`TargetFamilyWorld.PlaceResourceClump`) is a fixture the reason points at rather than a fact of the world.
    /// </summary>
    internal static IReadOnlyList<EngineMember> EngineFieldsNamedBy(string reason) =>
        DottedIdentifiers(reason)
            .Select(Resolve)
            .Where(member => member.EngineOwner && member.Kind == MemberKind.Field)
            .ToArray();

    /// <summary>The spellings a reason uses that name no member of an engine type at all, e.g. a renamed field.</summary>
    internal static IReadOnlyList<EngineMember> UnknownEngineMembersNamedBy(string reason) =>
        DottedIdentifiers(reason)
            .Select(Resolve)
            .Where(member => member.EngineOwner && member.Kind == MemberKind.UnknownMember)
            .ToArray();

    /// <summary>How a dotted spelling resolves against the game's own declarations.</summary>
    internal enum MemberKind
    {
        /// <summary>The path ends in a field or property.</summary>
        Field,

        /// <summary>The path reaches a method: a call site a body runs, not a value the world owns.</summary>
        CallPath,

        /// <summary>The spelling is a type name and nothing more.</summary>
        Type,

        /// <summary>The owner type is known but declares no such member.</summary>
        UnknownMember,

        /// <summary>The head of the spelling is no type this process can find.</summary>
        UnknownType,
    }

    /// <summary>One resolved spelling: what it names, how, and whether the declaring type belongs to the game.</summary>
    internal readonly record struct EngineMember(string Spelling, MemberKind Kind, bool EngineOwner, string Owner);

    private static readonly Regex DottedIdentifier = new(
        "[A-Z][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)+",
        RegexOptions.CultureInvariant);

    private static readonly Regex Absence = new(
        "\\bnull\\b|\\bzero\\b|zero-length|\\buninitialized\\b|\\bnever ran\\b|\\bnot set\\b|\\bwas 0\\b|\\bis 0\\b|\\babsent\\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static IEnumerable<string> DottedIdentifiers(string reason) =>
        DottedIdentifier.Matches(reason)
            .Select(match => match.Value)
            .Distinct(StringComparer.Ordinal);

    /// <summary>
    /// One spelling resolved segment by segment through the declared types, never through values: a static member is
    /// reachable from its type alone, and an instance member's type is enough to keep walking (which is how
    /// `Game1.mine.lowestLevelReached` resolves through a null `Game1.mine`).
    /// </summary>
    private static EngineMember Resolve(string spelling)
    {
        string[] segments = spelling.Split('.');
        Type? type = TypeNamed(segments[0], out bool engine);
        if (type is null) return new EngineMember(spelling, MemberKind.UnknownType, false, string.Empty);
        if (segments.Length == 1) return new EngineMember(spelling, MemberKind.Type, engine, type.Name);

        Type current = type;
        for (int index = 1; index < segments.Length; index++)
        {
            MemberInfo? member = MemberNamed(current, segments[index]);
            if (member is null) return new EngineMember(spelling, MemberKind.UnknownMember, engine, current.Name);

            switch (member)
            {
                case FieldInfo field:
                    current = field.FieldType;
                    break;
                case PropertyInfo property:
                    current = property.PropertyType;
                    break;
                default:
                    return new EngineMember(spelling, MemberKind.CallPath, engine, current.Name);
            }
        }

        return new EngineMember(spelling, MemberKind.Field, engine, current.Name);
    }

    /// <summary>The type a spelling's head names, preferring the game assembly over this one.</summary>
    private static Type? TypeNamed(string name, out bool engine)
    {
        engine = true;
        Type? declared = Declared(typeof(Game1).Assembly).GetValueOrDefault(name);
        if (declared is not null) return declared;

        engine = false;
        return Declared(typeof(TargetFamilyWorld).Assembly).GetValueOrDefault(name);
    }

    private static readonly Dictionary<Assembly, IReadOnlyDictionary<string, Type>> DeclaredByAssembly = new();

    /// <summary>
    /// The types one assembly declares, by SIMPLE name, with collisions resolved by <see cref="Preferred"/>.
    ///
    /// Collisions are real: the game assembly alone declares two `Tree` types (`Ionic.Zlib.Tree` and
    /// `StardewValley.TerrainFeatures.Tree`), and a map built in `GetTypes()` order resolved a reason's `Tree.shake`
    /// against the bundled compression library's type, which then read as a member the engine does not have.
    /// </summary>
    private static IReadOnlyDictionary<string, Type> Declared(Assembly assembly)
    {
        if (DeclaredByAssembly.TryGetValue(assembly, out IReadOnlyDictionary<string, Type>? known)) return known;

        Type[] types;
        try
        {
            types = assembly.GetTypes();
        }
        catch (ReflectionTypeLoadException partially)
        {
            types = partially.Types.Where(type => type is not null).ToArray()!;
        }

        var bySimpleName = new Dictionary<string, Type>(StringComparer.Ordinal);
        foreach (Type type in types)
        {
            if (!bySimpleName.TryGetValue(type.Name, out Type? existing) || Preferred(type, existing))
                bySimpleName[type.Name] = type;
        }

        DeclaredByAssembly[assembly] = bySimpleName;
        return bySimpleName;
    }

    private static bool Preferred(Type candidate, Type existing)
    {
        int rank = Rank(candidate).CompareTo(Rank(existing));
        return rank < 0 || (rank == 0 && string.CompareOrdinal(candidate.FullName, existing.FullName) < 0);
    }

    /// <summary>
    /// `StardewValley` first, then its sub-namespaces, then everything the game bundles beside it (`Ionic.Zlib`,
    /// `Force.DeepCloner`): a reason spells types the way the game's own code does.
    /// </summary>
    private static (int Family, int Depth) Rank(Type type)
    {
        string space = type.Namespace ?? string.Empty;
        int family = space == "StardewValley" ? 0 : space.StartsWith("StardewValley.", StringComparison.Ordinal) ? 1 : 2;
        return (family, space.Count(character => character == '.'));
    }

    private static MemberInfo? MemberNamed(Type type, string name)
    {
        const BindingFlags Scope = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
        FieldInfo? field = type.GetField(name, Scope);
        if (field is not null) return field;

        PropertyInfo? property = type.GetProperties(Scope).FirstOrDefault(candidate => candidate.Name == name);
        if (property is not null) return property;

        return type.GetMethods(Scope).FirstOrDefault(candidate => candidate.Name == name);
    }
}
