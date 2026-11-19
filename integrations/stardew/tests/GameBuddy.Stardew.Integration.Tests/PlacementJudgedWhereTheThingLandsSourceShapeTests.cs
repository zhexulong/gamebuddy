using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// GATE <c>a_placement_is_judged_where_the_thing_lands:&lt;action&gt;</c>: an action that puts a thing onto a world
/// tile has to read it back out of the collection that kind of thing lives in.
///
/// <para>
/// WHY. <c>place_owned_object</c> judged its own postcondition from <c>location.objects</c>, and furniture is not
/// there: a placed piece is appended to <c>location.furniture</c>, the location's own
/// <c>NetCollection&lt;Furniture&gt;</c> (GameLocation.cs:452, written at Object.cs:7041). Every furniture
/// placement therefore landed in <c>place_owned_object_postcondition_unavailable</c> however well it worked -
/// measured 2026-11-19, a whole <c>furnish_and_arrange</c> day ended that way, and the day was refused for a fact no
/// receipt stated: the tile the same piece came to rest on.
/// </para>
///
/// <para>
/// POPULATION, derived on every run. The Mod's registration table is the authority for which actions exist
/// (<see cref="FarmhandActionCatalog.Registrations"/>); each action id is resolved to its request path through the
/// wire router's own switch (<c>Handlers/*.cs</c>, <c>"id" =&gt; this.executions.RequestX(...)</c>); and the
/// SETTLEMENT REGION is that request method's body plus every same-file method it reaches, transitively. It has to
/// be the closure and not one body: <c>place_owned_object</c> reads furniture through <c>FindPlacedThing</c>, and a
/// region cut at a single method would report the fix as "reads nothing" - while the region must not be the whole
/// file either, because <c>worldobjectactions.cs</c> also holds the furniture PICKUP, whose reads would make this
/// gate pass over the placement it exists for.
/// </para>
///
/// <para>
/// A member is an action whose settlement region performs one of the engine's placement writes
/// (<see cref="PlacementWrites"/>) and reads where the thing landed out of a location collection
/// (<see cref="Landings"/>). Each member is crossed with every placed KIND and the collection that kind lives in: a
/// kind the action's own admission does not admit is printed as <c>not-this-actions-kind</c> instead of being counted
/// as passing, and the run prints
/// <c>placements examined P · judged-in-the-right-container J · judged-wrong W</c>. W&gt;0 fails, naming the action
/// and both collections.
/// </para>
///
/// <para>
/// WHAT IT DOES NOT READ. A thing placed into a container that is not one of the two location collections - an item
/// into a pedestal's <c>heldObject</c> (<c>place_item_on_pedestal</c>), a seed into a <c>HoeDirt</c>, a sapling into
/// <c>location.terrainFeatures</c> - is outside this cross, and <see cref="PlacementWrites"/> is where a future
/// member's settlement would have to be declared. The printed member list is what the gate actually examined.
/// </para>
///
/// red-proof, measured on this tree before the product fix: <c>place_owned_object</c> admitted furniture
/// (<c>candidate is not Furniture</c>) while its settlement read only <c>location.objects</c>, and this gate answered
/// <c>population [plant_seed, fertilize_tile, place_wood_fence, place_crab_pot, place_owned_object]</c>,
/// <c>placements examined 6 · judged-in-the-right-container 5 · judged-wrong 1</c>, naming
/// <c>a_placement_is_judged_where_the_thing_lands:place_owned_object - a furniture lands in location.furniture
/// (GameLocation.cs:452), and the settlement never reads it (it judges in location.objects)</c>. After the fix the same
/// run answers <c>placements examined 6 · judged-in-the-right-container 6 · judged-wrong 0</c>.
///
/// <para>
/// THE MEMBERS THAT ARE NOT THE TWO COLLECTIONS' OWN SUBJECTS, named rather than left to the reader: <c>plant_seed</c>
/// and <c>fertilize_tile</c> join the population through the shared <c>RequestLocalTileTarget</c> path, whose body
/// reads <c>location.objects</c> for the TARGET - what they move lands in a <c>HoeDirt</c>, which is outside this cross.
/// The claim this gate makes about them is the same necessary condition it makes about every member (the settlement
/// region reads the collection a piece of that kind lives in), not that a seed lands in <c>location.objects</c>.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class PlacementJudgedWhereTheThingLandsSourceShapeTests
{
    private const string Gate = "a_placement_is_judged_where_the_thing_lands";

    /// <summary>
    /// The engine settlements that put a thing onto a world tile. This is the gate's READING, not the product's: a
    /// member is added here in the same edit that adds its action, and the printed population makes the list's size
    /// visible.
    /// </summary>
    private static readonly string[] PlacementWrites =
    {
        // Object.placementAction: the bigCraftable/Furniture branch and the seed/tree branches.
        "placementAction(",
        // The fence action's own wrapper around that same branch, which is why the native spelling above is not the
        // only one a placement can be written through.
        "PlaceQualifiedWoodFenceNative(",
    };

    /// <summary>
    /// The container each placed KIND lives in, cited from the engine rather than restated here: furniture is the
    /// location's <c>NetCollection&lt;Furniture&gt;</c> (GameLocation.cs:452) and everything else is keyed by tile in
    /// <c>location.objects</c>. <see cref="Reads"/> is how a settlement gets a thing OUT of that collection - the
    /// tile-keyed lookup for objects, and the piece enumeration for furniture, which is not keyed by tile at all.
    /// </summary>
    private static readonly (string Kind, string[] Reads, string Citation)[] Landings =
    {
        ("furniture", new[] { "in location.furniture", ".furniture.FirstOrDefault(" }, "location.furniture (GameLocation.cs:452)"),
        ("object", new[] { ".objects.TryGetValue(" }, "location.objects"),
    };

    /// <summary>
    /// How an action's own admission says it can place a thing of this kind. Furniture is admitted by the type test
    /// the native branch itself makes (<c>this is Furniture</c>, Object.cs:7033) or by an exact <c>(F)</c> id pin;
    /// an object by the base type or an exact <c>(O)</c>/<c>(BC)</c> pin.
    /// </summary>
    private static readonly Dictionary<string, string[]> KindAdmissions = new(StringComparer.Ordinal)
    {
        ["furniture"] = new[] { "is not Furniture", "is Furniture", "as Furniture", "\"(F)" },
        ["object"] = new[] { "StardewValley.Object", "\"(O)", "\"(BC)" },
    };

    /// <summary>
    /// The placement writes whose thing does NOT land in one of the two location collections, each with the container
    /// it does land in. A member here is EXAMINED and outside the cross, which is the point: a settlement that stops
    /// reading its container shows up as an undeclared exclusion instead of as an action that quietly stopped being a
    /// placement.
    /// </summary>
    private static readonly Dictionary<string, string> OutsideTheCross = new(StringComparer.Ordinal)
    {
        ["plant_sapling"] = "a Tree in location.terrainFeatures, not a placeable object",
    };

    private readonly ITestOutputHelper output;

    public PlacementJudgedWhereTheThingLandsSourceShapeTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryPlacementActionJudgesTheContainerItsTargetKindLivesIn()
    {
        Dictionary<string, string> routes = RequestRoutes();
        List<string> writes = PlacementActions(routes);
        List<string> population = writes
            .Where(actionId => Landings.Any(landing => landing.Reads.Any(read => SettlementRegion(routes[actionId]).Contains(read, StringComparison.Ordinal))))
            .ToList();
        List<string> undeclared = writes
            .Where(actionId => !population.Contains(actionId) && !OutsideTheCross.ContainsKey(actionId))
            .ToList();
        this.output.WriteLine($"{Gate}: population [{string.Join(", ", population)}]");
        this.output.WriteLine(
            $"{Gate}: placements outside this cross {OutsideTheCross.Count} "
            + $"[{string.Join(", ", OutsideTheCross.Select(entry => $"{entry.Key}: {entry.Value}"))}]");
        // A settlement that stops reading a container must NOT read as "not a placement action": that is how a gate
        // narrows until it agrees with itself. Every write this run found is either crossed with a container or
        // declared outside the two collections, by name.
        undeclared.Should().BeEmpty(
            $"{Gate}: [{string.Join(", ", undeclared)}] perform a placement write and read no location collection, "
            + "and are not declared outside this cross - either their settlement stopped reading where the thing lands, "
            + "or this gate stopped reading their settlement");
        population.Should().NotBeEmpty(
            $"the {Gate} gate agrees with itself on an empty population: the catalogue routes place_owned_object into "
            + "a settlement that calls Object.placementAction, so a run that found no member did not read the handlers");

        List<string> wrong = new();
        List<string> notItsKind = new();
        int examined = 0;
        int judged = 0;
        foreach (string actionId in population)
        {
            string region = SettlementRegion(routes[actionId]);
            foreach ((string kind, string[] reads, string citation) in Landings)
            {
                if (!KindAdmissions[kind].Any(admission => region.Contains(admission, StringComparison.Ordinal)))
                {
                    notItsKind.Add($"{actionId}:{kind}");
                    continue;
                }

                examined++;
                if (reads.Any(read => region.Contains(read, StringComparison.Ordinal)))
                {
                    judged++;
                    continue;
                }

                string readInstead = string.Join(
                    ", ",
                    Landings.Where(landing => landing.Reads.Any(read => region.Contains(read, StringComparison.Ordinal)))
                        .Select(landing => landing.Citation));
                wrong.Add(
                    $"{Gate}:{actionId} - a {kind} lands in {citation}, and the settlement never reads it"
                    + $" (it judges in {(readInstead.Length == 0 ? "no location collection at all" : readInstead)})");
            }
        }

        this.output.WriteLine(
            $"{Gate}: placements examined {examined} · judged-in-the-right-container {judged} · judged-wrong {wrong.Count}"
            + $" · not-this-actions-kind {notItsKind.Count} [{string.Join(", ", notItsKind)}]");
        wrong.Should().BeEmpty(
            $"every placement must be judged in the collection its own kind lands in; examined {examined} action/kind "
            + $"pairs over {population.Count} actions, judged-wrong {wrong.Count}");

        judged.Should().Be(examined, "every pair that was examined either judges in the right container or fails above");
    }

    // -----------------------------------------------------------------------------------------------------------

    /// <summary>
    /// The population, derived: registration table → wire router → the settlement region → the placement writes it
    /// performs. Whether the thing lands in one of the two location collections is the next question, asked per action
    /// by the gate itself so that an exclusion is declared rather than silently dropped.
    /// </summary>
    private static List<string> PlacementActions(IReadOnlyDictionary<string, string> routes)
    {
        List<string> members = new();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Descriptor is null) continue;
            if (!routes.ContainsKey(registration.ActionId)) continue;
            string region = SettlementRegion(routes[registration.ActionId]);
            if (region.Length == 0) continue;
            if (!PlacementWrites.Any(write => region.Contains(write, StringComparison.Ordinal))) continue;
            members.Add(registration.ActionId);
        }
        return members;
    }

    /// <summary>
    /// One request path's settlement region: the method's own body plus every method in the SAME FILE that body
    /// reaches, transitively. Same-file only on purpose - a file is a boundary the compiler enforces, so a settlement
    /// cannot move its read into another partial without this gate noticing.
    /// </summary>
    private static string SettlementRegion(string requestMethod)
    {
        var region = new StringBuilder();
        foreach (string file in ControllerPartials())
        {
            string code = StripLineComments(File.ReadAllText(file));
            if (!code.Contains($"{requestMethod}(", StringComparison.Ordinal)) continue;
            region.Append(ReachableBodies(code, requestMethod)).Append('\n');
        }
        return region.ToString();
    }

    /// <summary>The bodies one method reaches inside one file, followed by name until the set stops growing.</summary>
    private static string ReachableBodies(string code, string entryMethod)
    {
        IReadOnlyList<(string Name, string Text)> bodies = MethodBodies(code);
        var reached = new StringBuilder();
        var queue = new Queue<string>();
        var visited = new HashSet<string>(StringComparer.Ordinal) { entryMethod };
        queue.Enqueue(entryMethod);
        while (queue.Count > 0)
        {
            string name = queue.Dequeue();
            foreach ((string bodyName, string text) in bodies)
            {
                if (!string.Equals(bodyName, name, StringComparison.Ordinal)) continue;
                reached.Append(text).Append('\n');
                foreach (Match call in Regex.Matches(text, "\\.?([A-Za-z_]\\w*)\\s*\\("))
                {
                    if (visited.Add(call.Groups[1].Value))
                        queue.Enqueue(call.Groups[1].Value);
                }
            }
        }
        return reached.ToString();
    }

    /// <summary>
    /// Every method in one file with a body, by name: a block body, or the expression body of a method that forwards to
    /// another seam. The parameter list is the FIRST parenthesised group that is followed by a body, not simply the
    /// first one on the line - a method whose return type is a tuple
    /// (<c>(StardewValley.Object? Found, Vector2 Tile) FindPlacedThing(...)</c>) otherwise reads as a declaration with no
    /// body, and the reads it performs disappear from the settlement this gate is reading.
    /// </summary>
    private static IReadOnlyList<(string Name, string Text)> MethodBodies(string code)
    {
        List<(string Name, string Text)> bodies = new();
        foreach (Match declaration in Regex.Matches(code, "\n {4}(?:public|private|internal|protected)[^\n]*\\("))
        {
            int open = code.IndexOf('(', declaration.Index);
            while (open >= 0)
            {
                int close = MatchingDelimiter(code, open, '(', ')');
                if (close < 0) break;
                int next = close + 1;
                while (next < code.Length && char.IsWhiteSpace(code[next])) next++;
                bool expressionBodied = next < code.Length && code[next..].StartsWith("=>", StringComparison.Ordinal);
                int end = expressionBodied
                    ? ExpressionBodyEnd(code, next + 2)
                    : next < code.Length && code[next] == '{' ? MatchingDelimiter(code, next, '{', '}') : -1;
                if (end > 0)
                {
                    Match name = Regex.Match(code[declaration.Index..open], "([A-Za-z_]\\w*)\\s*$");
                    if (!name.Success) break;
                    bodies.Add((name.Groups[1].Value, code[next..(end + 1)]));
                    break;
                }

                open = code.IndexOf('(', close + 1);
            }
        }
        return bodies;
    }

    /// <summary>The index of the <c>;</c> that ends an expression body, or -1 when it never closes.</summary>
    private static int ExpressionBodyEnd(string code, int start)
    {
        int depth = 0;
        for (int index = start; index < code.Length; index++)
        {
            char character = code[index];
            if (character == '"')
            {
                index++;
                while (index < code.Length && code[index] != '"')
                {
                    if (code[index] == '\\') index++;
                    index++;
                }
                continue;
            }
            if (character is '(' or '{' or '[') depth++;
            else if (character is ')' or '}' or ']') depth--;
            else if (character == ';' && depth == 0) return index;
        }
        return -1;
    }

    /// <summary>The index of the delimiter closing the one at <paramref name="open"/>, skipping string literals.</summary>
    private static int MatchingDelimiter(string code, int open, char opener, char closer)
    {
        int depth = 0;
        for (int index = open; index < code.Length; index++)
        {
            char character = code[index];
            if (character == '"')
            {
                index++;
                while (index < code.Length && code[index] != '"')
                {
                    if (code[index] == '\\') index++;
                    index++;
                }
                continue;
            }
            if (character == opener) depth++;
            else if (character == closer && --depth == 0) return index;
        }
        return -1;
    }

    /// <summary>
    /// Every action the wire router dispatches into the execution manager, mapped to the request method it calls.
    /// Read from the router's own switch rather than from a list here, so an action that gains a request path joins
    /// the population with no edit.
    /// </summary>
    private static Dictionary<string, string> RequestRoutes()
    {
        Dictionary<string, string> routes = new(StringComparer.Ordinal);
        foreach (string file in Directory.GetFiles(RepositoryDirectory("integrations", "stardew", "Handlers"), "*.cs"))
        {
            string code = StripLineComments(File.ReadAllText(file));
            foreach (Match match in Regex.Matches(code, "\"([a-z][a-z0-9_]*)\"\\s*=>\\s*this\\.executions\\.(Request\\w+)\\("))
                routes[match.Groups[1].Value] = match.Groups[2].Value;
        }
        return routes;
    }

    private static IReadOnlyList<string> ControllerPartials() =>
        Directory.GetFiles(RepositoryDirectory("integrations", "stardew"), "farmhandexecutioncontroller*.cs")
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();

    /// <summary>Drop <c>//</c> comments so the scan reads code, not the prose that names what it does not read.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string RepositoryDirectory(params string[] relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(new[] { directory.FullName }.Concat(relative).ToArray());
                if (Directory.Exists(candidate)) return candidate;
            }
        }

        throw new DirectoryNotFoundException($"repository path not found: {Path.Combine(relative)}");
    }
}
