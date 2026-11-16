using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using Microsoft.Xna.Framework;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The scan that DERIVES the candidate set instead of being told it.
///
/// <para>
/// WHY THE POPULATION IS DERIVED. A gate whose member list was written by the same person who fixed the last defect can
/// only catch what that person remembered. So the candidates here come from two declarations the product already owns:
/// the Mod's own assemblies (every static table of four or eight integer offsets is a claim about the engine's neighbour
/// set) and the Mod's own source tree (every literal numeric table is a claim about some engine's numbers). The scan also
/// prints its size, because a scan that finds nothing must not read as agreement.
/// </para>
///
/// <para>
/// WHAT IT CANNOT SEE, STATED HERE SO THE NEXT READER DOES NOT TRUST IT TOO FAR. Today's defect travelled
/// <c>AnswerCore</c> → a hoisted <c>bool targetBait</c> → <c>Project</c>'s parameter → the engine's fifth argument. No
/// textual rule over our call sites can follow a value through a helper's parameter, so a scan of this kind finds the
/// DEFECT's table only when the table is written down: <c>ClearCostTable</c>'s formulas, <c>EngineQualities</c>, the Host's
/// charge ladder. The value threaded through a parameter is the table's blind spot, and it is why the chance entry reads
/// the call site itself rather than trusting this scan to have found it.
/// </para>
/// </summary>
internal static class EngineParityCandidateScan
{
    /// <summary>Production sources only: the Mod's own code, not its tests, fixtures or generated output.</summary>
    private const string ProductionRoot = "integrations/stardew";

    private static readonly string[] ExcludedSegments =
    {
        $"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}",
        $"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}",
        $"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}",
        $"{Path.DirectorySeparatorChar}action-development{Path.DirectorySeparatorChar}",
    };

    /// <summary>
    /// A literal numeric table: an array or readonly list of integers, of points, or of integer pairs.
    ///
    /// These are the shapes a re-derived engine ladder takes in this tree - the charge ladder, the quality ladder, the
    /// neighbour offsets, the quiet cost of a clear. A table of strings is OUR vocabulary (an action id, a refusal code)
    /// and is not a claim about the engine, which is why the rule is by type rather than by name.
    /// </summary>
    private static readonly Regex NumericTable = new(
        @"\b(?:static readonly|const)\s+(?<type>int\s*\[\s*\]|IReadOnlyList<int>|Point\s*\[\s*\]|\(int\s+\w+\s*,\s*int\s+\w+\)\s*\[\s*\]|\(string\s+\w+\s*,\s*int\s+\w+\)\s*\[\s*\])\s+(?<name>[A-Za-z_]\w*)",
        RegexOptions.CultureInvariant);

    internal static string RepositoryRoot()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;

        if (directory is null) throw new DirectoryNotFoundException($"repository root not found above {AppContext.BaseDirectory}");
        return directory.FullName;
    }

    /// <summary>Every production source file, repository-relative and slash-separated, so a finding names the same path twice.</summary>
    internal static IReadOnlyList<string> ProductionFiles()
    {
        string root = RepositoryRoot();
        return Directory
            .GetFiles(Path.Combine(root, ProductionRoot), "*.cs", SearchOption.AllDirectories)
            .Where(file => !ExcludedSegments.Any(segment => file.Contains(segment, StringComparison.OrdinalIgnoreCase)))
            .Select(file => Path.GetRelativePath(root, file).Replace('\\', '/'))
            .OrderBy(file => file, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// The two populations, printed by the runner: offset tables found by reflection over the Mod's assemblies, and
    /// literal numeric tables found in the Mod's source.
    /// </summary>
    internal static IReadOnlyList<ParityCandidate> Candidates()
    {
        var candidates = new List<ParityCandidate>();
        foreach ((string name, List<(int X, int Y)> offsets) in OffsetTables())
            candidates.Add(new ParityCandidate(name.Replace('.', '/'), 1, $"offset_table:{name}", $"{offsets.Count} offsets"));

        foreach (string relative in ProductionFiles())
        {
            string[] lines = File.ReadAllLines(Path.Combine(RepositoryRoot(), relative.Replace('/', Path.DirectorySeparatorChar)));
            for (int index = 0; index < lines.Length; index++)
            {
                string code = StripLineComment(lines[index]);
                Match match = NumericTable.Match(code);
                if (!match.Success) continue;
                if (!DeclaresNumbers(lines, index)) continue;
                string name = match.Groups["name"].Value;
                candidates.Add(new ParityCandidate(
                    relative,
                    index + 1,
                    $"literal_table:{relative}:{name}",
                    $"{match.Groups["type"].Value} {name}"));
            }
        }

        return candidates;
    }

    /// <summary>
    /// The offsets half of the population: every static field in this Mod's two assemblies whose value is an array of
    /// four or eight integer pairs.
    ///
    /// <para>
    /// THE TYPE RULE IS THE POINT. `MineShaftTiles`, a table of mine tiles, is not a neighbour table and is not compared;
    /// a table of tile offsets written tomorrow is, without anyone editing this file.
    /// </para>
    /// </summary>
    internal static IReadOnlyList<(string Name, List<(int X, int Y)> Offsets)> OffsetTables()
    {
        var tables = new List<(string, List<(int X, int Y)>)>();
        foreach (Assembly assembly in new[] { typeof(ModEntry).Assembly, typeof(GameBuddy.Stardew.Core.FishingCatchable).Assembly })
        {
            foreach (Type type in assembly.GetTypes())
            {
                foreach (FieldInfo field in type.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    if (ReadOffsets(field) is not { } offsets) continue;
                    tables.Add(($"{type.Name}.{field.Name}", offsets));
                }
            }
        }

        return tables.OrderBy(table => table.Item1, StringComparer.Ordinal).ToList();
    }

    /// <summary>
    /// One static field's value as neighbour offsets, or <see langword="null"/> when the field is not such a table.
    ///
    /// The four-or-eight rule is the type rule's other half: a candidate table is a ring around one tile, so a
    /// three-element array is a different kind of fact and is not compared.
    /// </summary>
    private static List<(int X, int Y)>? ReadOffsets(FieldInfo field)
    {
        if (!field.FieldType.IsArray) return null;
        Type element = field.FieldType.GetElementType()!;
        if (element != typeof(Point) && element != typeof(ValueTuple<int, int>)) return null;

        Array? value;
        try
        {
            value = field.GetValue(null) as Array;
        }
        catch (TypeInitializationException)
        {
            return null;
        }

        if (value is null || (value.Length != 4 && value.Length != 8)) return null;
        var offsets = new List<(int X, int Y)>(value.Length);
        foreach (object? entry in value)
        {
            offsets.Add(entry switch
            {
                Point point => (point.X, point.Y),
                ValueTuple<int, int> pair => pair,
                _ => throw new InvalidOperationException($"unexpected offset element {entry?.GetType().Name ?? "null"}"),
            });
        }

        return offsets;
    }

    /// <summary>Whether the declaration that starts at <paramref name="index"/> actually holds digits.</summary>
    private static bool DeclaresNumbers(string[] lines, int index)
    {
        var text = new System.Text.StringBuilder();
        for (int line = index; line < Math.Min(index + 12, lines.Length); line++)
        {
            text.Append(StripLineComment(lines[line])).Append(' ');
            if (text.ToString().Contains(';')) break;
        }

        return Regex.IsMatch(text.ToString(), @"\d", RegexOptions.CultureInvariant);
    }

    /// <summary>The line without its `//` comment, so a sentence ABOUT a table is not read as the table.</summary>
    internal static string StripLineComment(string line)
    {
        int at = line.IndexOf("//", StringComparison.Ordinal);
        return at < 0 ? line : line[..at];
    }

    /// <summary>
    /// The whole source without its comments, keeping the character count so an offset found in the stripped text is the
    /// same offset in the real file.
    ///
    /// This matters for the chance entry: the reader's docblock says `SpawnFishData.GetChance` in prose, and a scan that
    /// read prose would find the argument in the sentence ABOUT the call rather than in the call.
    /// </summary>
    internal static string StripComments(string source) => Regex.Replace(
        Regex.Replace(source, @"/\*.*?\*/", match => new string(' ', match.Length), RegexOptions.Singleline),
        @"//[^\r\n]*",
        match => new string(' ', match.Length));
}
