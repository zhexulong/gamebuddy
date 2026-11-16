using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

// MIXED SHAPE AND BEHAVIOUR: the first two facts pin the controller family's own text and the three under them drive the
// same classifier with synthetic sources, so the pin cannot pass by classifying nothing as an admission and the
// classifier cannot go green by recognising only the shape it was written against.
/// <summary>
/// A reach admission must be measured with the engine's radius, not with a distance spelled here.
///
/// <para>
/// THE CLASS is <c>directional_radius_disagrees_with_the_engine:&lt;site&gt;:&lt;metric&gt;</c>. The engine's click gate,
/// <c>Utility.tileWithinRadiusOfPlayer</c> (Utility.cs:4100-4109), is
/// <c>Math.Abs(x - f.Tile.X) &lt;= tileRadius &amp;&amp; Math.Abs(y - f.Tile.Y) &lt;= tileRadius</c>: BOTH axes against the
/// radius, so a tile on the diagonal is one step away. A predicate that sums the two deltas is Manhattan, and it refuses
/// the diagonal the engine admits - measured 2026-11-14, 15 refusals at <c>you=44,57 nearest=43,56</c>, and the door at
/// <c>(3,12)</c> from an actor on <c>(2,11)</c> was refused by <c>enter_exit</c> while a player could click it.
/// </para>
///
/// <para>
/// THE EXPECTED METRIC IS NOT RESTATED HERE, it is measured: <c>TheExitAdmissionAgreesWithTheEngineGateAtEveryOffset</c>
/// in <see cref="EnterExitAdjacentExitRefusalTests"/> takes the truth table over a two-tile window from the engine's own
/// function and asserts the Mod agrees at every offset, so the window it admits (nine tiles, the square of the radius -
/// five if the metric were Manhattan) is the engine's answer rather than a claim in this file. What is asserted here is
/// the other half: that every OTHER admission in the family is measured the same way, because the one that was wrong was
/// not the one anyone was looking at.
/// </para>
///
/// <para>
/// POPULATION - derived on every run from <see cref="ControllerPartials.Sources"/>, never listed: every axis-delta
/// aggregation in the execution controller's partial family (each <c>Math.Abs(</c>, plus the aggregation of delta LOCALS
/// a tolerance test performs), and every call of the engine predicate or of <see cref="ExecutionManager.IsWithinRangeOfRequest"/>.
/// Each is one site, classified by the shape of its own text. <see cref="EveryAxisDeltaIsClassifiedWithAMetricThisReaderKnows"/>
/// refuses to pass when any anchor's shape is one this reader does not know, which is how a second spelling of "how far"
/// becomes red rather than silent.
/// </para>
///
/// <para>
/// NOT EXAMINED, and printed rather than left silent: a number that RANKS or PRICES rather than gates. `distance &lt;
/// nearestDistance` picks which crop to name (`targetdiscovery.cs:184`, `:237`), `FrontierDistance` is an A*-shaped cost
/// (`movementactions.cs:431`), and those are classified <c>Ranking</c>/<c>Value</c> and carry no finding. OUTSIDE this
/// population by design, and named so the next reader does not have to find them: <c>StardewBodyController.cs:2155</c>
/// and its mirror <c>PathPredicateProbe.cs:568</c> test Manhattan-1, and both are the planner's own step grammar - its
/// steps are cardinal, so the sum is the correct predicate there and a square radius would admit a step the planner
/// cannot take. Whether a BODY admission should use that grammar is a separate question from the click radius this gate
/// is about, and it is not this unit's.
/// </para>
/// </summary>
public sealed class DirectionalRadiusCensusTests
{
    private readonly ITestOutputHelper output;

    public DirectionalRadiusCensusTests(ITestOutputHelper output) => this.output = output;

    /// <summary>The engine's click gate, as this Mod calls it, and the wrapper that is its one spelling here.</summary>
    private static readonly string[] EngineAnchors =
    {
        "Utility.tileWithinRadiusOfPlayer(",
        "IsWithinRangeOfRequest(",
    };

    /// <summary>
    /// No admission in the controller family measures reach with summed axis deltas, or with one axis alone.
    /// </summary>
    [Fact]
    public void EveryRadiusAdmissionInTheControllerFamilyUsesTheEngineMetric()
    {
        IReadOnlyList<RadiusSite> sites = Classify(ControllerPartials.Sources());
        string census = Census(sites);
        this.output.WriteLine(census);

        RadiusSite[] admissions = sites.Where(site => site.Decision == Decision.Admission).ToArray();
        string[] disagreements = admissions
            .Where(site => site.Metric is Metric.Manhattan or Metric.SingleAxis)
            .Select(site => $"directional_radius_disagrees_with_the_engine:{site.File}:{site.Line}:{site.MetricText}")
            .ToArray();

        admissions.Should().NotBeEmpty($"a gate over an empty population is not a gate\n{census}");
        disagreements.Should().BeEmpty(
            $"the engine tests both axes against the radius (Utility.cs:4100-4109), so a reach measured any other way "
            + $"refuses tiles the player can click\n{census}");
    }

    /// <summary>
    /// Every axis-delta anchor in the family was classified into a metric this reader KNOWS. An anchor whose shape the
    /// classifier does not recognise is red rather than dropped: a second spelling of "how far" would otherwise leave the
    /// population silently.
    /// </summary>
    [Fact]
    public void EveryAxisDeltaIsClassifiedWithAMetricThisReaderKnows()
    {
        IReadOnlyList<RadiusSite> sites = Classify(ControllerPartials.Sources());
        string census = Census(sites);
        this.output.WriteLine(census);

        sites.Should().NotBeEmpty($"the controller family measures distances; zero sites means the reader is not reading\n{census}");
        sites.Where(site => site.Metric == Metric.Unrecognised)
            .Select(site => $"directional_radius_metric_unreadable:{site.File}:{site.Line}:{site.Statement}")
            .Should().BeEmpty($"an aggregation this reader cannot classify is a hole in the population, not a pass\n{census}");
    }

    /// <summary>
    /// The pre-fix spelling - the two axis deltas ADDED - is read as a Manhattan admission, which is the shape that
    /// refused the diagonal door. This is the classifier's own red proof: it is fed the source that shipped.
    /// </summary>
    [Fact]
    public void TheClassifierCallsASumOfAxisDeltasAManhattanAdmission()
    {
        RadiusSite[] sites = Classify(new[]
        {
            ("synthetic.cs", "internal static (int,int,int)? Next(BridgeDoor nearest, (int X, int Y) actor)\n"
                + "{\n"
                + "    if (Math.Abs(nearest.SourceX - actor.X) + Math.Abs(nearest.SourceY - actor.Y) != 1)\n"
                + "        return null;\n"
                + "    return (nearest.SourceX, nearest.SourceY, 1);\n"
                + "}\n"),
        }).ToArray();

        sites.Should().ContainSingle().Which.Decision.Should().Be(Decision.Admission);
        sites[0].Metric.Should().Be(Metric.Manhattan);
        sites[0].Line.Should().Be(3);
    }

    /// <summary>
    /// The engine's own predicate and its single wrapper are admissions measured by the engine - the metric this file's
    /// sibling derives from the engine's output.
    /// </summary>
    [Fact]
    public void TheClassifierCallsAnEnginePredicateAnEngineAdmission()
    {
        RadiusSite[] sites = Classify(new[]
        {
            ("synthetic.cs", "internal static bool InReach((int X, int Y) requested, Farmer actor) =>\n"
                + "    actor is not null && Utility.tileWithinRadiusOfPlayer(requested.X, requested.Y, 1, actor);\n"),
        }).ToArray();

        sites.Should().ContainSingle().Which.Metric.Should().Be(Metric.Engine);
        sites[0].Decision.Should().Be(Decision.Admission);
    }

    /// <summary>
    /// A number that ranks or prices is not a reach and stays out of the population, so the gate cannot demand the
    /// square radius of a cost function or of the planner's cardinal step grammar.
    /// </summary>
    [Fact]
    public void TheClassifierLeavesARankAndACostOutOfThePopulation()
    {
        RadiusSite[] sites = Classify(new[]
        {
            ("synthetic.cs", "private static int FrontierDistance((int X, int Y) left, (int X, int Y) right) =>\n"
                + "    Math.Abs(left.X - right.X) + Math.Abs(left.Y - right.Y);\n"
                + "\n"
                + "private static void Nearest(List<Crop> crops)\n"
                + "{\n"
                + "    float distance = Math.Abs(crop.X - playerTile.X) + Math.Abs(crop.Y - playerTile.Y);\n"
                + "    if (distance < nearestDistance) nearest = crop;\n"
                + "}\n"),
        }).ToArray();

        sites.Should().HaveCount(2);
        sites.Should().OnlyContain(site => site.Decision != Decision.Admission);
        sites[0].Metric.Should().Be(Metric.Manhattan, "a cost function is still a sum; it is the DECISION that makes it a reach");
    }

    // ---------------------------------------------------------------------------------------------------------------

    private enum Metric
    {
        /// <summary>The aggregation exists and this reader does not know it - a hole, not a pass.</summary>
        Unrecognised,

        Engine,

        PerAxis,

        AxisMax,

        Manhattan,

        SingleAxis,
    }

    private enum Decision
    {
        /// <summary>The number decides whether the actor may act on the tile - the class this gate is about.</summary>
        Admission,

        /// <summary>Compared against another distance: which of several things to name or walk to first.</summary>
        Ranking,

        /// <summary>Compared against another single axis delta: a facing, not a reach.</summary>
        AxisComparison,

        /// <summary>Produced, returned or handed on, never compared: a cost, a label or an argument.</summary>
        Value,
    }

    private sealed record RadiusSite(string File, int Line, Metric Metric, Decision Decision, string Statement)
    {
        internal string MetricText => this.Metric switch
        {
            Metric.Engine => "engine",
            Metric.PerAxis => "chebyshev:per-axis",
            Metric.AxisMax => "chebyshev:axis-max",
            Metric.Manhattan => "manhattan:sum-of-axis-deltas",
            Metric.SingleAxis => "single-axis",
            _ => "unrecognised",
        };
    }

    private static IReadOnlyList<RadiusSite> Classify(IEnumerable<(string File, string Source)> sources)
    {
        var sites = new List<RadiusSite>();
        foreach ((string file, string source) in sources)
        {
            string code = EngineParityCandidateScan.StripComments(source);
            HashSet<string> locals = DeltaLocals(code);
            var regions = new List<(int Start, int End)>();
            foreach (int anchor in Anchors(code, locals))
            {
                int start = RegionStart(code, anchor);
                if (!regions.Any(region => region.Start == start)) regions.Add((start, RegionEnd(code, anchor)));
            }

            foreach ((int start, int end) in regions)
                sites.Add(ReadSite(file, code, start, end, locals));
        }

        return sites;
    }

    /// <summary>Every index this reader treats as an axis-delta anchor: an abs, a delta-local aggregation, an engine call.</summary>
    private static List<int> Anchors(string code, HashSet<string> locals)
    {
        var anchors = new List<int>();
        foreach (Match match in Regex.Matches(code, @"Math\.Abs\s*\(")) anchors.Add(match.Index);
        foreach (string anchor in EngineAnchors)
        {
            foreach (Match match in Regex.Matches(code, Regex.Escape(anchor))) anchors.Add(match.Index);
        }

        // A tolerance test that aggregates two delta LOCALS (`Math.Max(driftX, driftY) > Tolerance`, or `driftX + driftY`):
        // its deltas are named, so the sum sits one statement away from the comparison.
        foreach (Match match in Regex.Matches(
            code,
            @"Math\.Max\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*(?:<=|>=|<|>|==|!=)|(\w+)\s*\+\s*(\w+)\s*(?:<=|>=|<|>|==|!=)"))
        {
            string left = match.Groups[1].Success ? match.Groups[1].Value : match.Groups[3].Value;
            string right = match.Groups[1].Success ? match.Groups[2].Value : match.Groups[4].Value;
            if (locals.Contains(left) && locals.Contains(right)) anchors.Add(match.Index);
        }

        return anchors;
    }

    /// <summary>The identifiers a body assigned from a single axis delta, so the aggregation above can be recognised.</summary>
    private static HashSet<string> DeltaLocals(string code)
    {
        var locals = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match match in Regex.Matches(code, @"\b(?:int|float|double|var)\s+(\w+)\s*=\s*Math\.Abs\s*\("))
            locals.Add(match.Groups[1].Value);
        return locals;
    }

    private static RadiusSite ReadSite(string file, string code, int start, int end, HashSet<string> locals)
    {
        string statement = code[start..end].Trim();
        string collapsed = Regex.Replace(statement, @"\s+", " ");
        int first = start;
        while (first < end && char.IsWhiteSpace(code[first])) first++;
        int line = code[..first].Count(character => character == '\n') + 1;

        Metric metric = ReadMetric(statement, locals);
        Decision decision = ReadDecision(statement, metric);
        return new RadiusSite(file, line, metric, decision, collapsed);
    }

    private static Metric ReadMetric(string statement, HashSet<string> locals)
    {
        if (EngineAnchors.Any(anchor => statement.Contains(anchor, StringComparison.Ordinal)))
            return Metric.Engine;
        if (Regex.IsMatch(statement, @"Math\.(?:Max|Min)\s*\(\s*Math\.Abs\s*\("))
            return Metric.AxisMax;
        if (Regex.IsMatch(statement, @"Math\.Abs\s*\([^()]*\)\s*[+-]\s*Math\.Abs\s*\("))
            return Metric.Manhattan;
        int absolutes = Regex.Matches(statement, @"Math\.Abs\s*\(").Count;
        if (absolutes >= 2) return Metric.PerAxis;
        if (absolutes == 1) return Metric.SingleAxis;

        // No abs of its own: the aggregation is over delta LOCALS, so the operator is the metric.
        Match max = Regex.Match(statement, @"Math\.Max\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)");
        if (max.Success && locals.Contains(max.Groups[1].Value) && locals.Contains(max.Groups[2].Value))
            return Metric.AxisMax;
        Match sum = Regex.Match(statement, @"(\w+)\s*\+\s*(\w+)\s*(?:<=|>=|<|>|==|!=)");
        if (sum.Success && locals.Contains(sum.Groups[1].Value) && locals.Contains(sum.Groups[2].Value))
            return Metric.Manhattan;
        return Metric.Unrecognised;
    }

    private static Decision ReadDecision(string statement, Metric metric)
    {
        if (metric == Metric.Engine) return Decision.Admission;

        Match comparison = Regex.Match(statement, @"[\w.)\]]\s*(?:<=|>=|==|!=|<|>)\s*([\w.()]+)");
        if (!comparison.Success) return Decision.Value;

        string bound = comparison.Groups[1].Value;
        if (bound.StartsWith("Math.", StringComparison.Ordinal)) return Decision.AxisComparison;
        if (IsDistanceName(bound)) return Decision.Ranking;
        return Decision.Admission;
    }

    /// <summary>A bound that is another distance - what a nearest-first selection compares against.</summary>
    private static bool IsDistanceName(string bound) =>
        Regex.IsMatch(bound, @"^(?:nearest|best|closest|furthest|lowest|highest|max|min)\w*$", RegexOptions.IgnoreCase)
        || bound.EndsWith("Distance", StringComparison.Ordinal);
    /// <summary>The statement an anchor sits in: back to the previous terminator, forward to the next one.</summary>
    private static int RegionStart(string code, int index)
    {
        int start = index;
        while (start > 0 && code[start - 1] is not (';' or '{' or '}')) start--;
        return start;
    }

    private static int RegionEnd(string code, int index)
    {
        int end = index;
        while (end < code.Length && code[end] is not (';' or '{' or '}')) end++;
        return end;
    }

    private static string Census(IReadOnlyList<RadiusSite> sites)
    {
        string line = string.Join(
            "\n",
            sites.Select(site => string.Format(
                CultureInfo.InvariantCulture,
                "  {0}:{1} {2} {3} - {4}",
                site.File,
                site.Line,
                site.Decision,
                site.MetricText,
                site.Statement.Length > 140 ? $"{site.Statement[..140]}..." : site.Statement)));
        int admissions = sites.Count(site => site.Decision == Decision.Admission);
        return string.Format(
            CultureInfo.InvariantCulture,
            "census: examined {0} sites · admissions {1} · ranking {2} · axis-comparison {3} · value {4}\n{5}",
            sites.Count,
            admissions,
            sites.Count(site => site.Decision == Decision.Ranking),
            sites.Count(site => site.Decision == Decision.AxisComparison),
            sites.Count(site => site.Decision == Decision.Value),
            line);
    }
}
