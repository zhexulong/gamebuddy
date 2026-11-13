using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.GameData.Locations;
using StardewValley.Tools;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The registry: every place our code re-derives a value the engine already computes, plus the sandbox that is not a place
/// at all.
///
/// <para>
/// THE THREE ENTRIES THAT EARN THIS FILE.
/// <list type="number">
/// <item><description><c>SpawnFishData.GetChance</c> - today's defect. The engine's fifth argument is per row
/// (<c>GameLocation.cs:13969</c>: <c>spawn.ItemId == text</c>); ours was computed once outside the row loop and true when
/// no species was named. The entry reads BOTH arguments out of the two sources and asks the engine's own arithmetic for
/// the number, so a reader that passes the wrong flag disagrees by the row's own declared boost.</description></item>
/// <item><description><c>Tool.tilesAffected</c> - the Host's packing table is a hand-maintained copy of the engine's charge
/// ladder, and the existing gate compares it at one facing. This entry compares all four, because the ladder's
/// `forward`/`across` is a claim about an axis and a rotation is what tests it.</description></item>
/// <item><description><c>Utility.DirectionsTileVectors</c> - five hand-maintained offset tables in this tree answer "which
/// four (or eight) tiles are next to this one". The population is a reflection scan, so a sixth table is compared the day
/// it is written.</description></item>
/// </list>
/// </para>
///
/// <para>
/// WHAT IS NOT A PARITY TEST, AND WHY SAYING SO IS PART OF THE WORK. `Tool.tilesAffected` is also reached through
/// <c>ChargedFootprint.Tiles</c>, but that is a reflection BIND of the same member - comparing it with the engine compares
/// the engine with itself. And the scythe's arc is not predicted: <c>MeleeSweepOccupancy</c> samples the world before and
/// after one real <c>DoDamage</c>, so the engine answers by doing it. Both are declared here with their reason instead of
/// being counted as compared.
/// </para>
/// </summary>
internal static class EngineParityRegistry
{
    /// <summary>The reader whose fifth argument today's defect lived in.</summary>
    internal const string ReaderPath = "integrations/stardew/FishingCatchableQuery.cs";

    /// <summary>The engine's sampler: the location, the row, and the per-row argument at <c>:13969</c>.</summary>
    internal const string ChanceMember = "StardewValley.GameData.Locations.SpawnFishData.GetChance (GameLocation.cs:13969)";

    /// <summary>The charge ladder the Host table mirrors, and the facing it is rotated by.</summary>
    internal const string FootprintMember = "StardewValley.Tool.tilesAffected (Tool.cs:913)";

    /// <summary>The engine's own four and eight neighbour offsets, the only table this tree may walk.</summary>
    internal const string DirectionsMember = "StardewValley.Utility.DirectionsTileVectors (Utility.cs:80)";

    /// <summary>The engine's harvest quality ladder, assigned by the roll at <c>Crop.cs:566-578</c>.</summary>
    internal const string QualityMember = "StardewValley.Crop.harvest quality roll (Crop.cs:566-578)";

    /// <summary>The Host table that restates the charge ladder, and the constant it is keyed by.</summary>
    private const string HostPacking = "host/src/body-program-packing.ts";

    /// <summary>
    /// The table the gate runs. `readerPath` is a parameter rather than a constant so the injection test can point the
    /// same entry at a scratch copy of the reader - the entry is identical, only the file under it moves.
    /// </summary>
    internal static IReadOnlyList<ParityEntry> Entries(string readerPath) => new[]
    {
        ChanceForEveryRow(readerPath),
        FootprintForEveryFacing(),
        NeighbourOffsetsForEveryTable(),
        HarvestQualityLadder(),
    };

    /// <summary>
    /// THE TABLE, AS THE GATE RUNS IT: the shipped reader, the engine's ladder, the engine's directions, the engine's
    /// quality assignments.
    /// </summary>
    internal static IReadOnlyList<ParityEntry> Entries() => Entries(RepositoryPath(ReaderPath));

    /// <summary>
    /// What the scan found in our sources and tree, and what the registry says about each finding. A finding the
    /// registry does not answer for is `rederivation_undeclared:<file>:<line>`.
    /// </summary>
    internal static ParityReport Run(string readerPath)
    {
        IReadOnlyList<ParityCandidate> candidates = EngineParityCandidateScan.Candidates();
        return EngineParity.Run(Entries(readerPath), candidates, Declarations());
    }

    internal static ParityReport Run() => Run(RepositoryPath(ReaderPath));

    /// <summary>
    /// THE DECLARATIONS. Every candidate the scan produces is answered by IDENTITY, not by position: the key of a literal
    /// table is its field name, and the key of an offset table is the field's own name, so a line that moves does not move
    /// its exemption with it.
    ///
    /// <para>
    /// The reason a candidate needs one is that the two halves are not the same question. A table the offset entry
    /// compares is not exempt at all - it is measured, and its declaration says which entry measures it. A table that is
    /// NOT a second spelling of an engine fact is excluded with the reason that makes it not one, and that reason stops
    /// being true the day the fact becomes the engine's.
    /// </para>
    /// </summary>
    private static Dictionary<string, string> Declarations()
    {
        var declarations = new Dictionary<string, string>(StringComparer.Ordinal);
        var offsetFields = new HashSet<string>(
            EngineParityCandidateScan.OffsetTables().Select(table => table.Name[(table.Name.LastIndexOf('.') + 1)..]),
            StringComparer.Ordinal);

        foreach (ParityCandidate candidate in EngineParityCandidateScan.Candidates())
        {
            if (candidate.Key.StartsWith("offset_table:", StringComparison.Ordinal))
            {
                declarations[candidate.Key] = "entry:NeighbourOffsetsForEveryTable";
                continue;
            }

            string name = candidate.Key[(candidate.Key.LastIndexOf(':') + 1)..];
            if (offsetFields.Contains(name))
            {
                declarations[candidate.Key] = "entry:NeighbourOffsetsForEveryTable";
                continue;
            }

            if (WrittenReasons.TryGetValue(name, out string? reason)) declarations[candidate.Key] = reason;
        }

        return declarations;
    }

    /// <summary>
    /// The literal tables that are not a second spelling of an engine fact, keyed by the FIELD's own name.
    ///
    /// <para>
    /// `ChangeCosts` ranks our refusal codes by what it costs a reader to answer them - the engine has no such ranking, so
    /// an entry would compare our vocabulary with nothing. `LimitSweep` is a probe's own search bound.
    /// `MeleeSweepIndices` IS the engine's swing-frame set, but it is already derived from the engine's frame table by
    /// <c>ScytheSweepTests.TheSweepIndicesAreTheEnginesOwnSwingFrames</c>, so a second derivation here would be the two
    /// spellings this file exists to prevent.
    /// </para>
    /// </summary>
    private static readonly Dictionary<string, string> WrittenReasons = new(StringComparer.Ordinal)
    {
        ["EngineQualities"] = "entry:HarvestQualityLadder",
        ["ChangeCosts"] =
            "excluded:ChangeCosts ranks OUR refusal codes by what it costs to answer them; the engine has no such ranking",
        ["LimitSweep"] = "excluded:LimitSweep is this probe's own search bound, not an engine number",
        ["MeleeSweepIndices"] =
            "excluded:MeleeSweepIndices is the engine's swing-frame set, and ScytheSweepTests.TheSweepIndicesAreTheEnginesOwnSwingFrames already derives it from Farmer.cs's frame table",
    };

    // ---- entry 1: the engine's per-row chance ------------------------------------------------------------------

    /// <summary>
    /// The engine's fifth argument, measured on the engine's own arithmetic.
    ///
    /// <para>
    /// BOTH SIDES ARE READ, NEITHER IS WRITTEN DOWN HERE. Our argument is decoded from the shipped call site (two declared
    /// shapes, and an unrecognised shape is `not_measured` rather than a guess); the engine's is decoded from
    /// <c>GameLocation.cs:13969</c> and must still be the per-row comparison. The number is then the engine's own
    /// <c>GetChance</c> asked twice, once with each flag - so the disagreement is the row's declared boost, not a
    /// restatement of the rule.
    /// </para>
    /// </summary>
    internal static ParityEntry ChanceForEveryRow(string readerPath) => new(
        ChanceMember,
        $"FishingCatchableQuery's fifth argument to GetChance (decoded from {Relative(readerPath)})",
        "rows enumerated from SpawnFishData's own chance fields (Chance, SpecificBaitMultiplier, SpecificBaitBuff), bait states from GameLocation.cs:13916-13933 (null, a named species, a magic bait)",
        "exact: the engine's chance at four decimals, computed by the shipped GetChance with each side's flag",
        () => CompareChance(readerPath));

    /// <summary>The two rows and the three bait states the entry visits. Every number comes from the row's own fields.</summary>
    private static ParityOutcome CompareChance(string readerPath)
    {
        string source = EngineParityCandidateScan.StripComments(File.ReadAllText(readerPath));
        string? ourArgument = FifthArgument(source, out string? ourFailure);
        if (ourArgument is null) return ParityOutcome.Unmeasured(ourFailure!);

        if (DecodeOurArgument(source, ourArgument, out string ourShape, out string? decodeReason) is null)
            return ParityOutcome.Unmeasured(decodeReason!);

        string engineLine = EngineChanceLine();
        string? engineArgument = FifthArgument(engineLine, out string? engineFailure);
        if (engineArgument is null) return ParityOutcome.Unmeasured(engineFailure!);
        if (!Regex.IsMatch(engineArgument, @"^\s*spawn\.ItemId\s*==\s*text\s*$"))
            return ParityOutcome.Unmeasured($"engine_argument_changed:{engineArgument}");

        var cases = new List<ParityCase>();
        foreach ((string label, string species, bool magicBait) in BaitStates())
        {
            foreach (SpawnFishData row in Rows())
            {
                string? text = species.Length == 0 ? null : species;
                bool ours = string.Equals(ourShape, "row_comparison", StringComparison.Ordinal)
                    ? string.Equals(row.ItemId, text, StringComparison.Ordinal)
                    : !magicBait && text is null;
                bool engine = string.Equals(row.ItemId, text, StringComparison.Ordinal);
                cases.Add(new ParityCase(
                    $"{row.ItemId ?? "?"}@{label}",
                    Chance(row, ours),
                    Chance(row, engine)));
            }
        }

        return new ParityOutcome(cases);
    }

    /// <summary>
    /// OUR ARGUMENT, as the shipped source spells it. Two shapes are understood, because two shapes exist in this tree's
    /// history; anything else is a reason to stop rather than a value to guess.
    /// </summary>
    private static string? DecodeOurArgument(string source, string argument, out string shape, out string? reason)
    {
        shape = string.Empty;
        reason = null;
        string trimmed = argument.Trim();

        if (trimmed.Contains(".ItemId", StringComparison.Ordinal))
        {
            shape = "row_comparison";
            return shape;
        }

        // A bare identifier is only the shipped shape when its declaration is the absence test: the flag was
        // `magicBait == false && string.Equals(TargetBaitSpecies(player), string.Empty, …)`.
        if (Regex.IsMatch(trimmed, @"^[A-Za-z_][A-Za-z0-9_]*$"))
        {
            Match declaration = Regex.Match(
                source,
                $@"bool\s+{Regex.Escape(trimmed)}\s*=\s*(?<body>[^;]+);",
                RegexOptions.CultureInvariant);
            if (declaration.Success && declaration.Groups["body"].Value.Contains("string.Empty", StringComparison.Ordinal))
            {
                shape = "hoisted_absence";
                return shape;
            }
        }

        reason = $"unrecognised_fifth_argument:{trimmed}";
        return null;
    }

    /// <summary>The engine's own call site, with comments stripped so a sentence about the argument is not read as it.</summary>
    private static string EngineChanceLine()
    {
        foreach (string line in DecompiledSource.Lines("StardewValley/GameLocation.cs"))
        {
            if (!line.Contains("spawn.GetChance(", StringComparison.Ordinal)) continue;
            return DecompiledSource.WithoutComment(line);
        }

        return string.Empty;
    }

    /// <summary>The fifth argument of the <c>GetChance(</c> call in <paramref name="source"/>.</summary>
    private static string? FifthArgument(string source, out string? failure)
    {
        failure = null;
        int call = source.IndexOf("GetChance(", StringComparison.Ordinal);
        if (call < 0)
        {
            failure = "call_site_absent:GetChance(";
            return null;
        }

        var arguments = new List<string>();
        int depth = 0;
        int start = call + "GetChance(".Length;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '(')
            {
                depth++;
            }
            else if (character == ')' && depth == 0)
            {
                arguments.Add(source[start..index]);
                break;
            }
            else if (character == ')')
            {
                depth--;
            }
            else if (character == ',' && depth == 0)
            {
                arguments.Add(source[start..index]);
                start = index + 1;
            }
        }

        if (arguments.Count != 5)
        {
            failure = $"argument_count:{arguments.Count.ToString(CultureInfo.InvariantCulture)}";
            return null;
        }

        return arguments[4];
    }

    /// <summary>
    /// The engine's chance for one row with one flag, asked through the shipped member and nothing else: no curiosity
    /// lure, no daily luck, no luck level, no modifiers - so the only term under test is the fifth argument.
    /// </summary>
    private static string Chance(SpawnFishData row, bool isTargetedWithBait) => row
        .GetChance(
            hasCuriosityLure: false,
            dailyLuck: 0.0,
            luckLevel: 0,
            applyModifiers: static (value, _, _) => value,
            isTargetedWithBait)
        .ToString("0.####", CultureInfo.InvariantCulture);

    /// <summary>
    /// Two rows that declare their own specific-bait boost, so a wrong flag moves a NUMBER rather than only a boolean. A
    /// row that declares no boost is unchanged by the flag, which is why a fixture made only of those would pass on the
    /// defect.
    /// </summary>
    private static SpawnFishData[] Rows() => new[]
    {
        new SpawnFishData { ItemId = "(O)128", Chance = 0.1f, SpecificBaitMultiplier = 3f },
        new SpawnFishData { ItemId = "(O)163", Chance = 0.02f, SpecificBaitMultiplier = 2f, SpecificBaitBuff = 0.05f },
    };

    /// <summary>
    /// The three bait states the engine's own reader can be in: no bait, a specific bait naming a species
    /// (<c>GameLocation.cs:13925-13928</c> builds <c>text</c> from the preserved index), and a magic bait, which names no
    /// species and so leaves <c>text</c> null.
    /// </summary>
    private static (string Label, string Species, bool MagicBait)[] BaitStates() => new[]
    {
        ("no_bait", string.Empty, false),
        ("specific_bait_(O)128", "(O)128", false),
        ("magic_bait", string.Empty, true),
    };

    // ---- entry 2: the charge ladder, rotated ---------------------------------------------------------------

    /// <summary>
    /// The Host's packing table against the engine's ladder, at every facing.
    ///
    /// <para>
    /// WHY THE FACING IS THE INPUT. The table declares <c>forward</c> - reach along the axis the actor faces - and
    /// <c>across</c>; a table that had the two swapped, or a ladder that was not rotationally symmetric, agrees at the
    /// facing the existing gate probes and disagrees at the one it does not. The value that party walks is the rectangle,
    /// so the rectangle is what is compared.
    /// </para>
    /// </summary>
    private static ParityEntry FootprintForEveryFacing() => new(
        FootprintMember,
        "host/src/body-program-packing.ts TOOL_FOOTPRINT_TILES_BY_CHARGE",
        "charge 0..5 (Tool.cs:915, :1062) x facing 0..3 (Utility.cs:80 order), named tile fixed; enumerated, not sampled",
        "exact: tile count and the (forward, across, back) shape of the swept rectangle",
        CompareFootprints);

    private static ParityOutcome CompareFootprints()
    {
        string host = File.ReadAllText(RepositoryPath(HostPacking));
        var declared = new List<(int Tiles, int Forward, int Across, int Back)>();
        foreach (Match match in Regex.Matches(
                     host,
                     @"Object\.freeze\(\{\s*tiles:\s*(?<tiles>\d+),\s*forward:\s*(?<forward>\d+),\s*across:\s*(?<across>\d+),\s*back:\s*(?<back>\d+)\s*\}\)",
                     RegexOptions.CultureInvariant))
        {
            declared.Add((
                int.Parse(match.Groups["tiles"].Value, CultureInfo.InvariantCulture),
                int.Parse(match.Groups["forward"].Value, CultureInfo.InvariantCulture),
                int.Parse(match.Groups["across"].Value, CultureInfo.InvariantCulture),
                int.Parse(match.Groups["back"].Value, CultureInfo.InvariantCulture)));
        }

        if (declared.Count == 0) return ParityOutcome.Unmeasured("host_table_unreadable");

        var cases = new List<ParityCase>();
        var named = new Vector2(10f, 12f);
        for (int charge = 0; charge < declared.Count; charge++)
        {
            for (int facing = 0; facing <= 3; facing++)
            {
                Farmer actor = FacingActor(facing);
                ProbeHoe hoe = Uninitialized<ProbeHoe>();
                List<Vector2> footprint = hoe.Footprint(named, charge, actor).Distinct().ToList();
                int forward = FacingAxisReach(footprint, named, facing);
                int across = PerpendicularSpan(footprint, named, facing);
                int back = PerpendicularBack(footprint, named, facing);
                (int tiles, int hostForward, int hostAcross, int hostBack) = declared[charge];
                cases.Add(new ParityCase(
                    $"charge{charge.ToString(CultureInfo.InvariantCulture)}/facing{facing.ToString(CultureInfo.InvariantCulture)}",
                    string.Create(CultureInfo.InvariantCulture, $"{footprint.Count}/{forward}/{across}/{back}"),
                    string.Create(CultureInfo.InvariantCulture, $"{tiles}/{hostForward}/{hostAcross}/{hostBack}")));
            }
        }

        return new ParityOutcome(cases);
    }

    /// <summary>Reach along the axis the actor faces, measured from the named tile in the facing direction.</summary>
    private static int FacingAxisReach(List<Vector2> footprint, Vector2 named, int facing) => facing switch
    {
        1 => (int)footprint.Max(tile => tile.X - named.X) + 1,
        3 => (int)-footprint.Min(tile => tile.X - named.X) + 1,
        0 => (int)-footprint.Min(tile => tile.Y - named.Y) + 1,
        _ => (int)footprint.Max(tile => tile.Y - named.Y) + 1,
    };

    /// <summary>Span across the facing axis: how many rows (or columns) of the rectangle lie beside the named tile's own.</summary>
    private static int PerpendicularSpan(List<Vector2> footprint, Vector2 named, int facing)
    {
        IEnumerable<float> offsets = facing is 1 or 3
            ? footprint.Select(tile => tile.Y - named.Y)
            : footprint.Select(tile => tile.X - named.X);
        return (int)(offsets.Max() - offsets.Min()) + 1;
    }

    /// <summary>How many across-rows the footprint covers BEFORE the named tile's own row.</summary>
    private static int PerpendicularBack(List<Vector2> footprint, Vector2 named, int facing)
    {
        IEnumerable<float> offsets = facing is 1 or 3
            ? footprint.Select(tile => tile.Y - named.Y)
            : footprint.Select(tile => tile.X - named.X);
        return (int)Math.Abs(offsets.Min());
    }

    // ---- entry 3: the neighbour offset tables, found by reflection -----------------------------------------

    /// <summary>
    /// Every static table in this Mod's own assemblies that answers "which tiles are next to this one", against the
    /// engine's own direction tables.
    ///
    /// <para>
    /// THE POPULATION IS THE ASSEMBLY, NOT THIS FILE. A table of four or eight integer offsets written next year is
    /// compared by this entry without anyone adding it, and one written with a typo disagrees by the SET - which is the
    /// property that matters, because our search ORDER is our own tie-break and the engine never claims one.
    /// </para>
    /// </summary>
    private static ParityEntry NeighbourOffsetsForEveryTable() => new(
        DirectionsMember,
        "every 4- or 8-offset static table in GameBuddy.Stardew and GameBuddy.Stardew.Core (reflection scan)",
        "tables found by scanning the two assemblies' static fields for arrays of four or eight integer pairs; engine side is Utility.DirectionsTileVectors (Utility.cs:80) by cardinality",
        "exact: set equality of the offsets; order is our declared search order and is not compared",
        CompareOffsets);

    private static ParityOutcome CompareOffsets()
    {
        IReadOnlyList<(string Name, List<(int X, int Y)> Offsets)> tables = EngineParityCandidateScan.OffsetTables();
        if (tables.Count == 0) return ParityOutcome.Unmeasured("no_offset_table_found_in_the_mod_assemblies");

        var engineFour = Utility.DirectionsTileVectors.Select(vector => ((int)vector.X, (int)vector.Y)).ToList();
        var engineEight = Utility.DirectionsTileVectorsWithDiagonals.Select(vector => ((int)vector.X, (int)vector.Y)).ToList();

        var cases = new List<ParityCase>();
        foreach ((string name, List<(int X, int Y)> offsets) in tables)
        {
            List<(int X, int Y)> engine = offsets.Count == 8 ? engineEight : engineFour;
            if (offsets.Count != engine.Count) return ParityOutcome.Unmeasured($"no_engine_table_of_this_cardinality:{name}");

            cases.Add(new ParityCase(name, Set(offsets), Set(engine)));
        }

        return new ParityOutcome(cases);
    }

    private static string Set(List<(int X, int Y)> offsets) => string.Join(
        ";",
        offsets
            .Select(offset => string.Create(CultureInfo.InvariantCulture, $"{offset.X},{offset.Y}"))
            .OrderBy(text => text, StringComparer.Ordinal));

    // ---- entry 4: the harvest quality ladder -----------------------------------------------------------------

    /// <summary>
    /// The four qualities our capacity predicate reasons over, against the values the engine's own roll assigns.
    ///
    /// <para>
    /// THE ENGINE SIDE IS A READ, NOT A CALL, and the entry says so: <c>Crop.harvest</c> needs a live world, so the
    /// ladder is taken from the assignments the roll makes (<c>Crop.cs:566-578</c>) - which is the engine's declaration of
    /// the set, and moves with it. A fifth quality added there reds this entry.
    /// </para>
    /// </summary>
    private static ParityEntry HarvestQualityLadder() => new(
        QualityMember,
        "GameBuddy.Stardew.Core.HarvestQualityCapacity.EngineQualities",
        "the values assigned to the roll's result in Crop.harvest (Crop.cs:566-578), plus the zero it starts from",
        "exact: set equality of the reachable quality values",
        CompareQualities);

    private static ParityOutcome CompareQualities()
    {
        FieldInfo? field = typeof(GameBuddy.Stardew.Core.HarvestQualityCapacity).GetField(
            "EngineQualities",
            BindingFlags.NonPublic | BindingFlags.Static);
        if (field?.GetValue(null) is not int[] ours) return ParityOutcome.Unmeasured("EngineQualities_field_absent");

        IReadOnlyList<string> engineLines = DecompiledSource.Code(DecompiledSource.Lines("StardewValley/Crop.cs"));
        var engine = new SortedSet<int> { 0 };
        bool inRoll = false;
        foreach (string line in engineLines)
        {
            if (line.Contains("int num3 = 0;", StringComparison.Ordinal)) inRoll = true;
            if (!inRoll) continue;
            if (line.Contains("MathHelper.Clamp(num3,", StringComparison.Ordinal)) break;
            Match assignment = Regex.Match(line, @"num3\s*=\s*(?<quality>\d+);", RegexOptions.CultureInvariant);
            if (assignment.Success) engine.Add(int.Parse(assignment.Groups["quality"].Value, CultureInfo.InvariantCulture));
        }

        if (engine.Count < 2) return ParityOutcome.Unmeasured("quality_roll_unreadable");

        return new ParityOutcome(new[]
        {
            new ParityCase(
                "harvest_quality_ladder",
                string.Join(",", ours.OrderBy(value => value)),
                string.Join(",", engine)),
        });
    }

    // ---- helpers ---------------------------------------------------------------------------------------------

    /// <summary>`Hoe` with the protected footprint helper exposed, so the engine answers for itself.</summary>
    private sealed class ProbeHoe : Hoe
    {
        internal List<Vector2> Footprint(Vector2 tile, int charge, Farmer who) => this.tilesAffected(tile, charge, who);
    }

    /// <summary>A farmer whose facing is the only thing the footprint reads; `tilesAffected` rotates by it.</summary>
    private static Farmer FacingActor(int facing)
    {
        FacingFarmer actor = (FacingFarmer)FormatterServices.GetUninitializedObject(typeof(FacingFarmer));
        actor.Facing = facing;
        return actor;
    }

    private sealed class FacingFarmer : Farmer
    {
        internal int Facing;

        public override int FacingDirection
        {
            get => this.Facing;
            set => this.Facing = value;
        }
    }

    /// <summary>
    /// A tool whose constructor never ran: `Tool`'s own constructor loads item data the headless runner has not, which is
    /// why every fixture in this project seeds tools this way.
    /// </summary>
    private static T Uninitialized<T>() where T : Tool => (T)FormatterServices.GetUninitializedObject(typeof(T));

    private static string RepositoryPath(string relative) =>
        Path.Combine(EngineParityCandidateScan.RepositoryRoot(), relative.Replace('/', Path.DirectorySeparatorChar));

    private static string Relative(string path)
    {
        string root = EngineParityCandidateScan.RepositoryRoot();
        return path.StartsWith(root, StringComparison.OrdinalIgnoreCase)
            ? path[(root.Length + 1)..].Replace('\\', '/')
            : path;
    }
}
