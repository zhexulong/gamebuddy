using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.BodyPrograms;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gate <c>a_refusal_names_a_step_the_caller_can_take:&lt;reasonCode&gt;</c>: every reachability refusal the body
/// composes carries at least one tile or action the caller can DISPATCH with the ids the same frame published.
///
/// <para>
/// THE CIRCLE, measured `round78` over ten in-game hours, six times: a weed lay on the only route north
/// (<c>clear_to_reach=weed@40,9</c>), the action that removes it was published (<c>clears_with=cut_weeds</c>), and its
/// target id was not - <c>blocker_target=unpublished:weedTargets</c>, because a family publishes its rows for tiles
/// inside its own discovery radius and she stood twenty tiles away. The documented recovery was "move into its reach",
/// which is the walk that had just been refused, and the only tile the refusal offered was
/// <c>reachable=34,6;detour_steps=46</c> - a dead end dressed as a way round. Ten real actions in ten hours.
/// </para>
///
/// <para>
/// So a refusal whose only advice is an action that needs an id the frame did not publish is CIRCULAR, and this gate
/// counts them. Population: the refusals the body actually composes, read from real drives of
/// <see cref="StardewBodyController"/> in a headless world - one per return site that mints a route verdict, with the
/// site count itself taken from the source so a new site cannot stay outside the drive. It prints
/// <c>refusals examined R · actionable A · circular C</c>, because "0 circular" means nothing without the population it
/// was read over.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the refusals asserted on are produced by driving the controller through its own refusal paths in a headless world, while the population floor is the source's own list of route-refusal sites, because a new return site that no drive reaches cannot be observed from a receipt.
[Collection(HeadlessGameWorld.Collection)]
public sealed class RefusalNamesAStepTheCallerCanTakeTests
{
    private const string Gate = "a_refusal_names_a_step_the_caller_can_take";

    private readonly ITestOutputHelper output;

    public RefusalNamesAStepTheCallerCanTakeTests(ITestOutputHelper output) => this.output = output;

    /// <summary>The far end of the corridor: beyond the weed, so the flood cannot reach it from her side.</summary>
    private static readonly Vector2 Beyond = new(13f, 3f);

    /// <summary>
    /// THE FALSIFIER, on the measured shape. A 16-tile corridor, the actor at its west end, ONE weed seven tiles east of
    /// her (outside the family's six-tile discovery window) and the target beyond it. Before this change the refusal said
    /// <c>blocker_target=unpublished:weedTargets</c> with a <c>stand_at</c> she had no reason to walk to and a
    /// <c>detour_steps</c> that led nowhere; after it, the sentence names the walk that publishes the row, then the row,
    /// then the cut, then the walk she asked for.
    /// </summary>
    [Fact]
    public void APublishedRowTheActorCannotSeeYetIsAStepSheCanWalk()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceWeed(9, 3);
        harness.Actor.position.Set(new Vector2(2 * 64 + 8, 3 * 64));

        (string code, string? evidence, string? hint) = harness.RefuseWithHint(fromX: 2, fromY: 3, Beyond);

        code.Should().Be("no_native_path", "the route is refused, and this unit is about what the refusal says");
        string refused = evidence!;
        refused.Should().Contain(
            $"blocker_target={ClearingEvidence.TargetUnpublished}:weedTargets",
            "the weed's own family published no row for a tile seven tiles off - that is the circle's first link");
        refused.Should().Contain(
            $"next_steps={ClearingEvidence.WalkAction}@8,3>publishes:weedTargets>cut_weeds@9,3>{ClearingEvidence.WalkAction}@13,3",
            $"the ordering is the fact: walk here, the row appears, cut it, then the walk - got: {refused}");
        refused.Should().NotContain(
            "detour_steps=46",
            "going round is not an option in a one-tile corridor and the number must not read as one");
        refused.Should().Contain("detour_steps=none", "the flood said no way round, so the detour is withdrawn");
        refused.Should().Contain("walk_limit_steps=6", "and its own number is kept under the word that says what it is");

        hint.Should().NotBeNull("a settled failure's evidence is withheld, so the hint is the only channel that reaches her");
        string kept = hint!;
        kept.Should().Contain(
            $"next_steps={ClearingEvidence.WalkAction}@8,3>publishes:weedTargets>cut_weeds@9,3",
            $"including the ordering, which is the one thing the round78 refusal never said: {kept}");
        kept.Length.Should().BeLessThanOrEqualTo(
            BodyProgramValidation.MaximumNodeHintLength,
            "a hint the journal refuses is a hint that never reaches the model");
    }

    /// <summary>
    /// The tile the sentence names is a tile she can DISPATCH today - not a coordinate the refusal computed for itself.
    /// The proof is the body's own admission: <c>TryStart</c> accepts a move to it from where she stands.
    /// </summary>
    [Fact]
    public void TheNamedWalkIsOneTheBodyAcceptsToday()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceWeed(9, 3);
        (_, string? evidence, _) = Refuse(harness, 2, 3, Beyond);
        (int X, int Y) publishFrom = NamedPublishTile(evidence!);

        StrideTo(harness.Actor, publishFrom).Should().BeTrue(
            $"a refusal that names a walk the body refuses is the circle with a coordinate on it - {publishFrom}");
    }

    /// <summary>
    /// And the row really appears there: the family's own discovery, asked at that tile, publishes the id. This is the
    /// single-authority check on the radius - the refusal does not guess where a row would exist, it names a tile from
    /// which the producer's own <c>Discover*</c> answers with one.
    /// </summary>
    [Fact]
    public void TheRowIsPublishedFromTheTileTheRefusalNames()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceWeed(9, 3);
        (_, string? evidence, _) = Refuse(harness, 2, 3, Beyond);
        (int X, int Y) publishFrom = NamedPublishTile(evidence!);

        ExecutionManager.PublishedBlockerTargetId(harness.Actor, TileOccupantKind.Weed, 9, 3).Should().BeNull(
            "seven tiles is outside the family's window, which is why the id was missing");
        harness.Actor.position.Set(new Vector2(publishFrom.X * 64 + 8, publishFrom.Y * 64));
        ExecutionManager.PublishedBlockerTargetId(harness.Actor, TileOccupantKind.Weed, 9, 3).Should().NotBeNull(
            $"the family publishes the row from {publishFrom}, which is what makes the cut dispatchable there");
    }

    /// <summary>
    /// THE GATE, over every route refusal the body composes. Each drive is a real refusal of the real controller; the
    /// population floor is the source's own route-refusal return sites, so a site added without a drive fails HERE by
    /// name instead of living outside the gate.
    /// </summary>
    [Fact]
    public void EveryReachabilityRefusalTheBodyComposesNamesAStepTheCallerCanTake()
    {
        var driven = new List<(string Refusal, string? Evidence)>
        {
            DriveFloodRefusal(rowTargetsUnpublished: true),
            DriveFloodRefusal(rowTargetsUnpublished: false),
            DriveBushFloodRefusal(),
            DriveClearStepBlockedArrival(),
            DriveClearedRouteRefusal(),
        };

        RefusalCensus census = Judge(driven);
        IReadOnlyList<string> sites = RouteRefusalSites();
        foreach ((string refusal, string? evidence) in driven)
            this.output.WriteLine($"[{refusal}] {evidence}");

        census.Examined.Should().Be(driven.Count, "the population is the refusals the body produced, not a subset");
        census.Findings.Should().BeEmpty(
            "refusals examined {0} · actionable {1} · circular {2}: {3}",
            census.Examined,
            census.Actionable,
            census.Circular,
            string.Join(" ", census.Findings));
        census.Circular.Should().Be(0,
            "{0} · refusals examined {1} · actionable {2} · circular {3}: {4}",
            "a refusal whose only advice needs an id the frame did not publish is this gate's defect",
            census.Examined,
            census.Actionable,
            census.Circular,
            string.Join(" ", census.Findings));
        (census.Actionable + census.Circular + census.NotMeasured + census.NothingClearsIt).Should().Be(
            census.Examined,
            "every refusal lands in exactly one arm, so no refusal is silently outside the count");
        census.NothingClearsIt.Should().BeGreaterThan(0, "the bush drive is the arm where no step exists to name");
        census.NotMeasured.Should().Be(0, "every drive here measures the route, so a zero here is a fact and not a gap");
        driven.Count.Should().BeGreaterThanOrEqualTo(
            sites.Count,
            $"every route-refusal site must be driven: {string.Join(", ", sites)}");
        sites.Count.Should().Be(
            4,
            "the body mints a route verdict at exactly these return sites - a new one is not yet driven by the gate: "
                + string.Join(", ", sites));

        this.output.WriteLine(
            $"refusals examined {census.Examined} · actionable {census.Actionable} · circular {census.Circular}"
                + $" · not measured {census.NotMeasured} · nothing clears it {census.NothingClearsIt}");
    }

    /// <summary>
    /// THE FALSIFIER on the gate itself: the round78 refusal, verbatim - a published clearer, an id the frame withheld,
    /// and a dead-end tile - one finding, named by its reason code.
    /// </summary>
    [Fact]
    public void ACircularRefusalIsReportedByName()
    {
        RefusalCensus census = Judge(new[]
        {
            ("no_native_path",
                (string?)("route_exists_cardinal=false;blocker_occupant=weed@40,9;clears_with=cut_weeds(stamina:0,tool:scythe,turns:1);"
                    + "blocker_target=unpublished:weedTargets;reachable=34,6;detour_steps=46")),
        });

        census.Circular.Should().Be(1);
        census.Findings.Should().Equal($"{Gate}:no_native_path");
    }

    /// <summary>
    /// The three zeroes, told apart: a refusal whose producer could not measure the route says so, and is neither
    /// actionable nor circular - it is counted and left alone rather than turned into a pass.
    /// </summary>
    [Fact]
    public void AnUnmeasuredRefusalIsNeitherActionableNorCircular()
    {
        RefusalCensus census = Judge(new[]
        {
            ("no_native_path", (string?)"from=1,1;to=9,9;native=attempted;path_search=undecided;blocked_by=none"),
        });

        census.Examined.Should().Be(1);
        census.NotMeasured.Should().Be(1);
        census.Circular.Should().Be(0);
        census.Findings.Should().BeEmpty("nothing was measured, so nothing can be judged - but the population is printed");
    }

    /// <summary>
    /// The body's own refusal for one walk, driven with the PRODUCER's target-id lookup rather than a stand-in - the id in
    /// the receipt is whatever the family's discovery would have published, so a refusal is judged on what a frame really
    /// carries.
    /// </summary>
    private static (string Refusal, string? Evidence, string? Hint) Refuse(
        ClearStepMoveTests.CorridorHarness harness,
        int fromX,
        int fromY,
        Vector2 target)
    {
        harness.Actor.position.Set(new Vector2(fromX * 64 + 8, fromY * 64));
        var specification = new LocalMoveSpec(
            "execution_01",
            "request_01",
            target,
            AllowAdjacentArrival: false,
            1,
            10_000,
            long.MaxValue);
        bool started = new StardewBodyController((_, _, _) => { }, ExecutionManager.PublishedBlockerTargetId)
            .TryStart(specification, harness.Actor, tick: 1, out string reasonCode, out string? evidence, out string? hint);
        started.Should().BeFalse("the target is beyond the corridor's blocker, so this walk is refused");
        return (reasonCode, evidence, hint);
    }

    // -------------------------------------------------------------------------
    // The drives: one real refusal per route-verdict return site the body has.
    // -------------------------------------------------------------------------

    /// <summary>One weed on a one-tile corridor, the target beyond it, and the actor either inside the weed family's
    /// window (the id is published) or outside it (the id is not) - the two halves of `blocker_target`'s answer.</summary>
    private static (string Refusal, string? Evidence) DriveFloodRefusal(bool rowTargetsUnpublished)
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceWeed(9, 3);
        (string code, string? evidence, string? _) = Refuse(harness, rowTargetsUnpublished ? 2 : 7, 3, Beyond);
        return (code, evidence);
    }

    /// <summary>A bush: named by the world, cleared by no published action, so the refusal has no clear step at all and
    /// the only step it can name is a tile the walk reaches.</summary>
    private static (string Refusal, string? Evidence) DriveBushFloodRefusal()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceBush(9, 3);
        (string code, string? evidence, string? _) = Refuse(harness, 2, 3, Beyond);
        return (code, evidence);
    }

    /// <summary>The arrival that finds the blocker still standing: `clear_step_blocked`.</summary>
    private static (string Refusal, string? Evidence) DriveClearStepBlockedArrival()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceWeed(9, 3);
        (string code, string? evidence) = harness.Arrive((9, 3), fromX: 8, fromY: 3);
        return (code, evidence);
    }

    /// <summary>The arrival whose blocker IS gone and whose route is still refused: `no_native_path` after a clear.</summary>
    private static (string Refusal, string? Evidence) DriveClearedRouteRefusal()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceRock(8, 3);
        (string code, string? evidence) = harness.Arrive((6, 3), fromX: 5, fromY: 3);
        return (code, evidence);
    }

    // -------------------------------------------------------------------------
    // The judgement, and the two readings it is read from.
    // -------------------------------------------------------------------------

    /// <summary>What one run of the gate found, over the population it was read on.</summary>
    internal readonly record struct RefusalCensus(
        int Examined,
        int Actionable,
        int Circular,
        int NotMeasured,
        int NothingClearsIt,
        IReadOnlyList<string> Findings);

    /// <summary>
    /// The judgement itself, fed its refusals - so the honest ones and the injected ones are judged by ONE function, and
    /// a guard that cannot be made red on purpose is decoration.
    ///
    /// <para>
    /// CIRCULAR is decided FIRST and narrowly, in the words of the defect: the refusal names a clearing action
    /// (<c>clears_with=&lt;action&gt;</c>), says that action's family published no row for the tile
    /// (<c>blocker_target=unpublished:&lt;family&gt;</c>), and names no walk that would make it publish one. A
    /// <c>stand_at</c> does NOT rescue it - a swing from there needs the very id the frame withheld, which is the circle
    /// `round78` walked around for ten hours.
    /// </para>
    /// <para>
    /// The remaining arms, so that zeroes are told apart instead of turned into a pass: ACTIONABLE names a step the
    /// caller can dispatch (the publish walk, a clearing target the frame published, or a fresh clear step whose blocker
    /// is addressable); NOT MEASURED means the producer published no route verdict at all; and NOTHING CLEARS IT is the
    /// vocabulary's own <c>no_clearing_action</c>, where no step exists however the frame is re-read - a wall, not a bill.
    /// </para>
    /// </summary>
    internal static RefusalCensus Judge(IReadOnlyList<(string Refusal, string? Evidence)> refusals)
    {
        var findings = new List<string>();
        int examined = 0;
        int actionable = 0;
        int circular = 0;
        int notMeasured = 0;
        int nothingClears = 0;
        foreach ((string refusal, string? evidence) in refusals)
        {
            examined += 1;
            if (string.IsNullOrEmpty(evidence))
            {
                findings.Add($"{Gate}:{refusal}");
                continue;
            }

            if (Read(evidence, "path_search") == "undecided" || Read(evidence, "reachable") == "undecided")
            {
                notMeasured += 1;
                continue;
            }

            if (NamesAClearingActionWhoseTargetIsWithheld(evidence) && !NamesAPublishWalk(evidence))
            {
                circular += 1;
                findings.Add($"{Gate}:{refusal}");
                continue;
            }

            if (NamesAPublishWalk(evidence) || NamesAPublishedTarget(evidence) || NamesAFreshClearStep(evidence))
            {
                actionable += 1;
                continue;
            }

            if (Read(evidence, "blocker_target") == ClearingEvidence.NoClearingAction)
            {
                nothingClears += 1;
                continue;
            }

            findings.Add($"{Gate}:{refusal}");
        }

        return new RefusalCensus(examined, actionable, circular, notMeasured, nothingClears, findings);
    }

    /// <summary>The one tile a coordinate a caller can walk to is spelled with, or null when the refusal names none.</summary>
    private static readonly Regex Coordinate = new(@"^-?\d+,-?\d+$", RegexOptions.CultureInvariant);

    /// <summary>The ordered sentence's own first step: the walk that makes the missing row appear.</summary>
    private static bool NamesAPublishWalk(string evidence)
    {
        if (Read(evidence, "next_steps") is not { } steps)
            return false;
        string head = steps.Split('>')[0];
        string prefix = $"{ClearingEvidence.WalkAction}@";
        return head.StartsWith(prefix, StringComparison.Ordinal) && Coordinate.IsMatch(head[prefix.Length..]);
    }

    /// <summary>
    /// An id the frame published for the blocker - the other shape of an actionable refusal, and the one where the
    /// clearing action itself is the step. The three ways of having NO id are not ids.
    /// </summary>
    private static bool NamesAPublishedTarget(string evidence) =>
        Read(evidence, "blocker_target") is { } value
        && value != ClearingEvidence.NoClearingAction
        && value != "blocker_not_published"
        && !value.StartsWith($"{ClearingEvidence.TargetUnpublished}:", StringComparison.Ordinal);

    /// <summary>
    /// A fresh clear step whose blocker is addressable: the arrival re-plan's `clear_step=`/`stand_at=` pair. It is a
    /// step only when the refusal has NOT already said the target id is missing - that combination is the circular arm.
    /// </summary>
    private static bool NamesAFreshClearStep(string evidence)
    {
        if (Read(evidence, "blocker_target")?.StartsWith($"{ClearingEvidence.TargetUnpublished}:", StringComparison.Ordinal) == true)
            return false;
        return Read(evidence, "stand_at") is { } stand && Coordinate.IsMatch(stand);
    }

    private static bool NamesAClearingActionWhoseTargetIsWithheld(string evidence)
    {
        if (Read(evidence, "clears_with") is not { } clears
            || clears.StartsWith(ClearingEvidence.NoPublishedActionClears, StringComparison.Ordinal))
            return false;
        return Read(evidence, "blocker_target")?.StartsWith($"{ClearingEvidence.TargetUnpublished}:", StringComparison.Ordinal) == true;
    }

    /// <summary>One `k=v` field of a receipt's evidence, or null when the field is absent.</summary>
    private static string? Read(string evidence, string field)
    {
        foreach (string entry in evidence.Split(';'))
        {
            int equals = entry.IndexOf('=');
            if (equals > 0 && entry[..equals] == field)
                return entry[(equals + 1)..];
        }

        return null;
    }

    /// <summary>The tile the refusal tells her to walk to, read out of the sentence it published.</summary>
    private static (int X, int Y) NamedPublishTile(string evidence)
    {
        string? steps = Read(evidence, "next_steps");
        steps.Should().NotBeNull("the refusal must name a walk");
        string head = steps!.Split('>')[0];
        string prefix = $"{ClearingEvidence.WalkAction}@";
        head.Should().StartWith(prefix, "the first step is the only one the caller can dispatch today");
        string[] parts = head[prefix.Length..].Split(',');
        return (int.Parse(parts[0], CultureInfo.InvariantCulture), int.Parse(parts[1], CultureInfo.InvariantCulture));
    }

    /// <summary>Whether the body accepts a walk to one tile from where the actor stands - the caller's own test of "can
    /// I issue this today".</summary>
    private static bool StrideTo(Farmer actor, (int X, int Y) tile) =>
        new StardewBodyController((_, _, _) => { }).TryStart(
            new LocalMoveSpec("execution_01", "request_01", new Vector2(tile.X, tile.Y), AllowAdjacentArrival: false, 1, 10_000, long.MaxValue),
            actor,
            tick: 1,
            out string reasonCode,
            out _,
            out _) || reasonCode == "accepted";

    // -------------------------------------------------------------------------
    // The population floor: the body's own route-refusal return sites.
    // -------------------------------------------------------------------------

    /// <summary>
    /// Every return site in <c>StardewBodyController.cs</c> that mints a route verdict, as `file:line (shape)` - the
    /// declaration excluded. Derived from the source rather than listed, because a site added tomorrow is exactly what a
    /// hand list cannot see, and the count is asserted in the gate above.
    /// </summary>
    private static IReadOnlyList<string> RouteRefusalSites()
    {
        string source = File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "StardewBodyController.cs")));
        var sites = new List<string>();
        int index = 0;
        while ((index = source.IndexOf("WalkRefusalCode(", index, StringComparison.Ordinal)) >= 0)
        {
            bool isDeclaration = index >= 20 && source[(index - 20)..index].Contains("static ", StringComparison.Ordinal);
            if (!isDeclaration)
                sites.Add($"StardewBodyController.cs:{LineOf(source, index)} (WalkRefusalCode)");
            index += "WalkRefusalCode(".Length;
        }

        index = 0;
        while ((index = source.IndexOf("ClearStepBlockedReasonCode,", index, StringComparison.Ordinal)) >= 0)
        {
            sites.Add($"StardewBodyController.cs:{LineOf(source, index)} (ClearStepBlockedReasonCode)");
            index += "ClearStepBlockedReasonCode,".Length;
        }

        return sites;
    }

    private static int LineOf(string source, int index)
    {
        int line = 1;
        for (int position = 0; position < index; position += 1)
        {
            if (source[position] == '\n')
                line += 1;
        }

        return line;
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
                directory = directory.Parent;
            }
        }

        throw new FileNotFoundException($"repository source not found: {relative}");
    }
}
