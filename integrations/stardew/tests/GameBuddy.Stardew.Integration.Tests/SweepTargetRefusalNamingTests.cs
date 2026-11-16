using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A SWING AT A TILE IT CANNOT MOVE IS REFUSED BEFORE IT SWINGS, and the refusal names the action that would.
///
/// <para>
/// THE DEFECT THIS FILE EXISTS FOR, measured `round63`. `sweep_scythe` was dispatched at Farm `69,31`, which held TWIG
/// litter (`before_occupant=twig;after_occupant=twig;named_moved=false`), from a cardinal stance with `(W)47` in slot 4.
/// The request was admitted, the engine's arc was swept, one UNNAMED weed at `67:29` was cut (`changed=67:29:weed`), and
/// the receipt came back `partially_succeeded/scythe_sweep_partial` - a code that says "partly" and named nothing that
/// would move the tile she aimed at. The run's own `execution-result` line then read `0/2 步做成了`, and
/// `remove_placed_item` - the published action whose `Clears` declaration names `twig` and whose native admission is the
/// axe branch (`Object.cs:1182`) - never appears in `attemptedActionIds`. She had a scythe, the stance was legal, and the
/// request could not succeed by the action's OWN completion condition ("the NAMED tile moved"), so there was nothing to
/// learn from the swing except its side effect.
/// </para>
/// <para>
/// WHY THE NAMED TILE IS THE SUBJECT. The arc is the engine's, but `scythe_sweep_cut` is minted only when the NAMED tile
/// moved (`farmhandexecutioncontroller.resourcetoolactions.cs`, the `namedMoved &amp;&amp; everySweepableMoved` branch),
/// so a request whose named tile holds an occupant the scythe family never declared can only ever be a partial or an
/// uncertain - never the thing it asked for. The pre-swing read that answers the completion condition
/// (<see cref="MeleeSweepOccupancy.Read"/>) is the same read that can answer it beforehand, which is why this is the
/// producer's own predicate rather than a new guess.
/// </para>
/// <para>
/// THE TWO HALVES THE REFUSAL OWES. What stands there (`blocker_occupant=twig@69,31`) and the published action that
/// removes it (`clears_with=remove_placed_item(...)`) - the shape the route refusals already carry
/// (<see cref="ClearingEvidence.DescribeBlocker"/>). The measurement that makes the SHAPE matter is `round63`'s own
/// `fish_here` receipt: it carried exactly those two fields and the model never saw either, because the Host prints one
/// receipt detail to the model under a 160-character share on whole FIELDS
/// (`host/src/fact-brief.ts#MODEL_FIELD_CEILINGS`, `boundedField`), and the Mod had put eight narration fields in front
/// of them. So the census below reads the detail through that same share, read from the Host's own declaration rather
/// than restated here.
/// </para>
/// </summary>
public sealed class SweepTargetRefusalNamingTests
{
    /// <summary>The code the sweep's named-tile refusal is minted under, and the occupant it names after the colon.</summary>
    private const string TargetNotScytheWork = "sweep_target_not_scythe_work";

    private static long DeadlineMs => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;

    /// <summary>
    /// THE RED CASE, driven through the action's own request. A twig on the tile she faces, nothing else on the farm: the
    /// request must be refused with the blocker and its clearer, and the twig must still be standing (a refusal has no
    /// side effect). Before this guard the request either swung (and cut whatever the arc reached) or answered
    /// `sweep_nothing_to_cut`, which named the arc's emptiness instead of the tile she asked about.
    /// </summary>
    [Fact]
    public void ASwingAtATileTheScytheCannotMoveIsRefusedAndNamesWhatWould()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        StardewValley.Object twig = world.PlaceObjectAt(3, 2, "(O)294", "Twig", -999);
        twig.IsTwig().Should().BeTrue("the fixture has to be the engine's own twig, or this case measures nothing");
        world.PutToolInPackSlot(0, typeof(MeleeWeapon), "(W)47", upgradeLevel: 0);

        LocalExecutionReceipt receipt = world.NewExecutionManager("sweep_scythe")
            .RequestLocalSweepScythe("req_sweep_at_twig", 3, 2, DeadlineMs);

        receipt.State.Should().Be(
            ExecutionState.Rejected,
            "a swing whose named tile holds no occupant the scythe family declares cannot reach its own completion "
                + $"condition, so it must not be swung at all - got {receipt.State}/{receipt.ReasonCode}: {receipt.Evidence}");
        receipt.ReasonCode.Should().Be(
            $"{TargetNotScytheWork}:{TileOccupantKind.Twig}",
            "the code names the blocker's occupant the way `sweep_would_destroy:<kind>` already does");
        string evidence = receipt.Evidence ?? string.Empty;
        evidence.Should().NotBeEmpty("a refusal carries the evidence it decided on");
        (bool actionable, string why) = RefusalActionability.Judge(evidence);
        actionable.Should().BeTrue("the refusal owes both halves inside the share the model receives: {0}", why);
        evidence.Should().Contain(
            $"{TileOccupantKind.Twig}@3,2",
            "the blocker is a place as well as a kind - the same tile the route refusals name");
        world.Farm.objects.ContainsKey(new Vector2(3, 2)).Should().BeTrue(
            "a refused swing leaves the tile it refused about exactly as it found it");
    }

    /// <summary>
    /// THE `round63` SHAPE, one tile over: the arc holds a weed the swing WOULD cut and the named tile holds the twig. The
    /// old admission cut that unnamed weed and reported the partial, which is a destructive effect on a tile the caller
    /// never named delivered as "partly worked". The refusal must happen before the arc's own work is done.
    /// </summary>
    [Fact]
    public void TheArcIsNotSweptWhenTheNamedTileIsNotTheSwingsWork()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceObjectAt(3, 2, "(O)294", "Twig", -999);
        world.PutToolInPackSlot(0, typeof(MeleeWeapon), "(W)47", upgradeLevel: 0);

        // The arc is the engine's, so the fixture asks it where to put the weed the old swing would have cut.
        IReadOnlyList<Vector2> arc = MeleeSweepArc.Sampled(
            (MeleeWeapon)world.Actor.Items[0]!,
            world.Actor,
            3,
            2,
            SwingFacing.Right);
        arc.Should().Contain(
            new Vector2(3f, 2f),
            "the named tile is inside the arc for every standing pixel, which is the action's own published claim");
        Vector2 inArc = arc.First(tile => tile != new Vector2(3f, 2f));
        world.PlaceWeed((int)inArc.X, (int)inArc.Y);

        LocalExecutionReceipt receipt = world.NewExecutionManager("sweep_scythe")
            .RequestLocalSweepScythe("req_sweep_across_twig", 3, 2, DeadlineMs);

        receipt.ReasonCode.Should().Be(
            $"{TargetNotScytheWork}:{TileOccupantKind.Twig}",
            "the named tile decides, and it is not this swing's work");
        world.Farm.objects.ContainsKey(inArc).Should().BeTrue(
            "nothing in the arc may be cut on the way to a refusal about a tile the caller did name");
    }

    /// <summary>
    /// THE CENSUS IS NOT DECORATION: two details from `round63` itself, quoted verbatim out of
    /// `tools/_multiday_routine-round63-live-runner.log` (`BRIDGE_FACT` `execution_receipt` rows), must come back OPAQUE -
    /// the sweep's because it named no clearer at all, and `fish_here`'s because the two fields it DID name sat past the
    /// model's share.
    /// </summary>
    [Fact]
    public void TheCensusGoesRedOnTheRunsOwnReceipts()
    {
        const string SweepPartial =
            "location=Farm;target=69,31;before_occupant=twig;after_occupant=twig;named_moved=false;arc_tiles=16;"
            + "arc_sweepable=1;arc_clear=13;changed=67:29:weed;tiles_changed=1;tool_selected=scythe;slot=4;"
            + "tool_before=fishing_rod;slot_before=5;stamina_before=270;stamina_after=270;stamina_delta=0;"
            + "expected_stamina_cost=0;tool_restored=fishing_rod";
        const string FishNoApproach =
            "target=71,30;actor=69,30;reach=1;approach=none;standable_neighbour=unreachable;standable_tiles=1;"
            + "footprint=1;clear_step=twig@69,31;stand_at=69,30;remaining_clears=1;blocker_occupant=twig@69,31;"
            + "clears_with=remove_placed_item(stamina:2,tool:target_requirement,turns:1);"
            + "blocker_target=blocker_not_published;candidates=750;described=8;blocked_by=range:reach:2";

        RefusalActionability.Judge(SweepPartial).Actionable.Should().BeFalse(
            "`scythe_sweep_partial` named what stood on the named tile and nothing that would move it");
        RefusalActionability.Judge(FishNoApproach).Actionable.Should().BeFalse(
            "its clearer was the 12th field, past the 160-character share the model reads");
    }

    // ---- the census ----------------------------------------------------------

    /// <summary>
    /// The property a refusal of a swing owes, judged on the part of its detail the MODEL receives.
    ///
    /// <para>
    /// The share is read from the Host's own `MODEL_FIELD_CEILINGS.evidence` rather than restated: the Host prints a
    /// receipt detail up to that many characters on whole fields (`host/src/fact-brief.ts#boundedField`), so the census
    /// takes the plain PREFIX of that length and drops a field the prefix cut in half. That reading is deliberately
    /// STRICTER than the Host's: a field wholly inside the prefix is one `boundedField` prints too, so this can fail a
    /// detail the Host would have carried and can never pass one it would not.
    /// </para>
    /// </summary>
    internal static class RefusalActionability
    {
        /// <summary>The Host's own model share for one receipt detail, read out of the file that declares it.</summary>
        internal static int ModelShare => ModelShareChars.Value;

        private static readonly Lazy<int> ModelShareChars = new(ReadModelShare);

        internal static (bool Actionable, string Why) Judge(string detail)
        {
            ArgumentNullException.ThrowIfNull(detail);
            string shown = detail.Length <= ModelShare ? detail : detail[..ModelShare];
            Dictionary<string, string> fields = Fields(shown, truncated: detail.Length > ModelShare);
            if (!fields.TryGetValue("blocker_occupant", out string? blocker))
                return (false, $"no blocker_occupant= inside the first {ModelShare.ToString(CultureInfo.InvariantCulture)} characters");
            int at = blocker.IndexOf('@');
            if (at <= 0 || at == blocker.Length - 1)
                return (false, $"blocker_occupant={blocker} names no kind@x,y");
            string kind = blocker[..at];
            if (!fields.TryGetValue("clears_with", out string? clears))
                return (false, $"no clears_with= inside the first {ModelShare.ToString(CultureInfo.InvariantCulture)} characters");
            const string NoClearer = ClearingEvidence.NoPublishedActionClears + ":";
            if (clears.StartsWith(NoClearer, StringComparison.Ordinal))
            {
                string unclearable = clears[NoClearer.Length..];
                return TileOccupantKind.UnclearableReason(unclearable) is null
                    ? (false, $"says nothing clears {unclearable}, which is not a declared-unclearable kind")
                    : (true, $"declared unclearable: {unclearable}");
            }

            return clears.Contains('(') && clears.EndsWith(')')
                ? (true, $"names {clears}")
                : (false, $"clears_with={clears} names no action with its own price");
        }

        private static Dictionary<string, string> Fields(string text, bool truncated)
        {
            string[] entries = text.Split(';');
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            // The prefix cut can land inside the value it was printing, so a truncated reading drops that last field
            // rather than judging half of it.
            int count = truncated ? entries.Length - 1 : entries.Length;
            for (int index = 0; index < count; index += 1)
            {
                int equals = entries[index].IndexOf('=');
                if (equals <= 0) continue;
                fields.TryAdd(entries[index][..equals], entries[index][(equals + 1)..]);
            }

            return fields;
        }

        private static int ReadModelShare()
        {
            string source = File.ReadAllText(Path.Combine(RepositoryRoot(), "host", "src", "fact-brief.ts"));
            Match declaration = Regex.Match(
                source,
                @"export const MODEL_FIELD_CEILINGS = Object\.freeze\(\{(?<body>.*?)\}\);",
                RegexOptions.Singleline);
            declaration.Success.Should().BeTrue("the Host declares the ceilings its model-visible fields are printed under");
            Match share = Regex.Match(declaration.Groups["body"].Value, @"evidence:\s*(?<chars>[0-9]+)");
            share.Success.Should().BeTrue("`evidence` is one of the ceilings, and a receipt detail is judged by it");
            return int.Parse(share.Groups["chars"].Value, CultureInfo.InvariantCulture);
        }

        private static string RepositoryRoot()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
                directory = directory.Parent;
            directory.Should().NotBeNull("the test must run inside the repository");
            return directory!.FullName;
        }
    }
}
