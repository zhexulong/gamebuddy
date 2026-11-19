using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;
using Xunit;
using Xunit.Abstractions;
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
/// (`host/src/model-field-budget.ts#MODEL_FIELD_CEILINGS`, `boundedField`), and the Mod had put eight narration fields in front
/// of them. So the census below reads the detail through that same share, taken from the table the Host publishes for
/// readers outside its process (`host/src/model-field-budget.published.json`) rather than restated here.
/// </para>
/// </summary>
public sealed class SweepTargetRefusalNamingTests
{
    private readonly ITestOutputHelper output;

    public SweepTargetRefusalNamingTests(ITestOutputHelper output) => this.output = output;

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
    /// THE CENSUS IS NOT DECORATION, and it reads the run's own two details: two details from `round63` itself, quoted
    /// verbatim out of `tools/_multiday_routine-round63-live-runner.log` (`BRIDGE_FACT` `execution_receipt` rows). The
    /// sweep's comes back OPAQUE because it named no clearer at all - a producer-side defect, fixed where it belonged.
    /// `fish_here`'s comes back ACTIONABLE: it always carried the two fields a reader acts on, and what it met was a flat
    /// 160-character share that kept the first eight fields and dropped the 12th. The Host's share is now derived from the
    /// line it protects (`host/src/model-field-budget.ts`), so 355 characters arrive whole - and the field boundary and
    /// the rank are there for the strings that still do not fit.
    /// </summary>
    [Fact]
    public void TheCensusReadsTheRunsOwnReceipts()
    {
        const string SweepPartial =
            "location=Farm;target=69,31;before_occupant=twig;after_occupant=twig;named_moved=false;arc_tiles=16;"
            + "arc_sweepable=1;arc_clear=13;changed=67:29:weed;tiles_changed=1;tool_selected=scythe;slot=4;"
            + "tool_before=fishing_rod;slot_before=5;stamina_before=270;stamina_after=270;stamina_delta=0;"
            + "expected_stamina_cost=0;tool_restored=fishing_rod";
        const string FishNoApproach =
            "target=71,30;actor=69,28;reach=1;approach=none;standable_neighbour=unreachable;standable_tiles=1;"
            + "footprint=1;clear_step=twig@69,31;stand_at=69,30;remaining_clears=1;blocker_occupant=twig@69,31;"
            + "clears_with=remove_placed_item(stamina:2,tool:target_requirement,turns:1);"
            + "blocker_target=blocker_not_published;candidates=750;described=8;blocked_by=range:reach:2";

        RefusalActionability.Judge(SweepPartial).Actionable.Should().BeFalse(
            "`scythe_sweep_partial` named what stood on the named tile and nothing that would move it");
        (bool fishActionable, string fishWhy) = RefusalActionability.Judge(FishNoApproach);
        fishActionable.Should().BeTrue(
            "its blocker and its clearer are inside the share the model receives - and they are what the whole change is "
                + "for: {0}",
            fishWhy);
    }

    /// <summary>
    /// THE GATE, over the whole occupant vocabulary rather than the twig. Population: every kind
    /// <see cref="TileOccupantKind.Published"/> names that the scythe family does NOT declare it clears - derived from
    /// the two declarations, so an occupant kind added tomorrow is examined without an edit here. Property: the refusal
    /// the sweep mints for it names what stands there and what would open it, inside the share the model receives - a
    /// published clearer with its own price, or `no_published_action_clears:&lt;kind&gt;` for a kind
    /// <see cref="TileOccupantKind.Unclearable"/> says so about.
    ///
    /// <para>
    /// THE COUNTS ARE PRINTED and zero population is a failure, because a census whose population silently emptied
    /// agrees with itself. The falsifier sits at the end: a kind no declaration names and no `Unclearable` row declares
    /// must come back OPAQUE, which is the shape the twig itself had in `round63`.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryOccupantTheScytheCannotMoveIsNamedWithWhatWould()
    {
        string[] examine = TileOccupantKind.Published
            .Where(kind => !MeleeSweepOccupancy.Sweepable.Contains(kind))
            .ToArray();
        var opaque = new List<string>();
        int actionable = 0;
        foreach (string kind in examine)
        {
            string detail = MeleeSweepOccupancy.DescribeTargetNotScytheWork(kind, new Vector2(69f, 31f));
            (bool ok, string why) = RefusalActionability.Judge(detail);
            if (ok) actionable += 1;
            else opaque.Add($"{kind} ({why})");
        }

        string line = $"occupants examined {examine.Length} · actionable {actionable} · opaque {opaque.Count}"
            + (opaque.Count == 0 ? string.Empty : $" ({string.Join("; ", opaque)})");
        this.output.WriteLine(line);
        examine.Should().Contain(
            TileOccupantKind.Twig,
            "the population is the occupants the scythe does not clear, and the run's own blocker is one of them - " + line);
        examine.Should().NotBeEmpty("a census that examines nothing proves nothing");
        opaque.Should().BeEmpty("every occupant the scythe cannot move must name what would: {0}", line);

        // THE FALSIFIER: a kind the catalogue knows nothing about is exactly what an undeclared new occupant would look
        // like, and the same census must call it opaque rather than pass it.
        string unknown = MeleeSweepOccupancy.DescribeTargetNotScytheWork("no_declared_occupant", new Vector2(69f, 31f));
        RefusalActionability.Judge(unknown).Actionable.Should().BeFalse(
            "`no_published_action_clears` is only lawful for a kind `TileOccupantKind.Unclearable` declares - got {0}", unknown);
    }

    /// <summary>
    /// THE DETAIL ITSELF, NOT JUST THE FIELDS INSIDE IT, FITS THE SHARE THE HOST PUBLISHES.
    ///
    /// <para>
    /// The census above asks whether the two fields a reader acts on survive the prefix the Host prints; it cannot
    /// notice a refusal whose two fields fit and whose NARRATION does not, because a detail cut at the share loses its
    /// tail whatever the tail was. So this measures the whole string the Mod composes for every occupant, and the
    /// numbers it prints are the two that would have to meet: the ceiling the Host publishes and the longest detail the
    /// Mod actually writes. Change the ceiling on the Host side - or let a refusal grow - and this reds naming both.
    /// </para>
    /// </summary>
    [Fact]
    public void TheModsLongestEvidenceFitsTheShareTheHostPublishes()
    {
        string[] examine = TileOccupantKind.Published
            .Where(kind => !MeleeSweepOccupancy.Sweepable.Contains(kind))
            .ToArray();
        var measured = examine
            .Select(kind => (Kind: kind, Detail: MeleeSweepOccupancy.DescribeTargetNotScytheWork(kind, new Vector2(69f, 31f))))
            .ToArray();
        examine.Should().NotBeEmpty("a measurement with no population agrees with nothing");

        (string Kind, string Detail) longest = measured.OrderByDescending(row => row.Detail.Length).First();
        int ceiling = RefusalActionability.ModelShare;
        string line = $"evidence ceiling {ceiling} · longest {longest.Detail.Length} ({longest.Kind}) · occupants {measured.Length}";
        this.output.WriteLine(line);
        longest.Detail.Length.Should().BeLessThanOrEqualTo(
            ceiling,
            "the Host prints a receipt detail whole only up to the share it publishes, so a longer refusal loses its tail "
                + $"without saying which fields went - {line} · detail: {longest.Detail}");
    }

    /// <summary>
    /// THE SHARE IS THE HOST'S OWN NUMBER, AND IT IS WHAT DECIDES - both ways, on details built to sit either side of it.
    ///
    /// <para>
    /// Two directions, because a share that is read wrong can be wrong in two ways. A detail that ends exactly ON the
    /// share must be judged whole (a Host that cut at one character less would hide the field at the end), and a detail
    /// ONE character past it must lose the field the prefix cut, with a reason that names the ceiling it was cut at and
    /// the length it met. The numbers are read from the published table, so a hard-coded copy in this file could not
    /// satisfy either case.
    /// </para>
    /// </summary>
    [Fact]
    public void TheShareTheHostPublishesDecidesOnBothSidesOfItself()
    {
        const string Blocker = "blocker_occupant=twig@69,31";
        const string Clearer = "clears_with=remove_placed_item(stamina:2)";
        const string Filler = "filler=";
        int ceiling = RefusalActionability.ModelShare;
        int fixedChars = Blocker.Length + Clearer.Length + Filler.Length + 2;
        string Fitted(int padding) => $"{Blocker};{Filler}{new string('x', padding)};{Clearer}";

        string fits = Fitted(ceiling - fixedChars);
        string overflows = Fitted(ceiling - fixedChars + 1);
        fits.Length.Should().Be(ceiling, "the fitting case is built to end exactly ON the share the Host publishes");
        overflows.Length.Should().Be(ceiling + 1, "and the other is built one character past it");

        (bool fitsActionable, string fitsWhy) = RefusalActionability.Judge(fits);
        fitsActionable.Should().BeTrue(
            $"a detail of {fits.Length} against a ceiling of {ceiling} arrives whole, so its clearer is read: {fitsWhy}");

        (bool overActionable, string overWhy) = RefusalActionability.Judge(overflows);
        overActionable.Should().BeFalse(
            $"a detail of {overflows.Length} against a ceiling of {ceiling} is cut one character inside its last field, "
                + $"which is dropped rather than half-read: {overWhy}");
        overWhy.Should().Contain(
            ceiling.ToString(CultureInfo.InvariantCulture),
            "the reason names the ceiling it was cut at, so a reader can tell a short share from a long detail: {0}",
            overWhy);
        overWhy.Should().Contain(
            overflows.Length.ToString(CultureInfo.InvariantCulture),
            "and it names the length it met, which is the number that has to change: {0}",
            overWhy);
    }

    // ---- the census ----------------------------------------------------------

    /// <summary>
    /// The property a refusal of a swing owes, judged on the part of its detail the MODEL receives.
    ///
    /// <para>
    /// The share is READ, not restated, and it is read from the table the Host publishes as DATA
    /// (`host/src/model-field-budget.published.json`) rather than out of `model-field-budget.ts`: a Host test holds that
    /// table equal to `MODEL_FIELD_CEILINGS`, and a reader outside the process cannot follow a TypeScript derivation
    /// with a regular expression - the day `evidence` stopped being a literal that reading stopped matching anything and
    /// these tests threw instead of measuring. The Host prints a receipt detail up to that many characters on whole
    /// fields (`host/src/model-field-budget.ts#boundedField`), so the census takes the plain PREFIX of that length and
    /// drops a field the prefix cut in half. That reading is deliberately STRICTER than the Host's: a field wholly
    /// inside the prefix is one `boundedField` prints too, so this can fail a detail the Host would have carried and can
    /// never pass one it would not.
    /// </para>
    /// </summary>
    internal static class RefusalActionability
    {
        /// <summary>The Host's own model share for one receipt detail, from the table it publishes for foreign readers.</summary>
        internal static int ModelShare => ModelShareChars.Value;

        private static readonly Lazy<int> ModelShareChars = new(ReadModelShare);

        internal static (bool Actionable, string Why) Judge(string detail)
        {
            ArgumentNullException.ThrowIfNull(detail);
            string shown = detail.Length <= ModelShare ? detail : detail[..ModelShare];
            Dictionary<string, string> fields = Fields(shown, truncated: detail.Length > ModelShare);
            if (!fields.TryGetValue("blocker_occupant", out string? blocker))
                return (false, $"no blocker_occupant= inside the first {Share()} of a detail that is {Length(detail)} long");
            int at = blocker.IndexOf('@');
            if (at <= 0 || at == blocker.Length - 1)
                return (false, $"blocker_occupant={blocker} names no kind@x,y");
            string kind = blocker[..at];
            if (!fields.TryGetValue("clears_with", out string? clears))
                return (false, $"no clears_with= inside the first {Share()} of a detail that is {Length(detail)} long");
            const string NoClearer = ClearingEvidence.NoPublishedActionClears + ":";
            if (clears.StartsWith(NoClearer, StringComparison.Ordinal))
            {
                string token = clears[NoClearer.Length..];
                int colon = token.IndexOf(':');
                string unclearable = colon < 0 ? token : token[..colon];
                string? reason = colon < 0 ? null : token[(colon + 1)..];
                if (TileOccupantKind.UnclearableReason(unclearable) is null)
                    return (false, $"says nothing clears {unclearable}, which is not a declared-unclearable kind");
                // AND THE REASON HAS TO BE THE DECLARED ONE. A word that names the kind and stops - or names a reason the
                // vocabulary does not carry - leaves the caller with "nothing of ours does it" and "nothing at all can"
                // as one sentence, which is the silence this verdict was written to refuse.
                string? declared = TileOccupantKind.UnclearableCode(unclearable);
                if (declared is null)
                    return (false, $"declares {unclearable} unclearable without a reason token");
                return string.Equals(reason, declared, StringComparison.Ordinal)
                    ? (true, $"declared unclearable: {unclearable}:{declared}")
                    : (false, $"says nothing clears {unclearable}:{reason ?? "no_reason"}, and the declared reason is {declared}");
            }

            return ClearerListPattern.IsMatch(clears)
                ? (true, $"names {clears}")
                : (false, $"clears_with={clears} names no published action id");
        }

        /// <summary>
        /// The clearers as the catalogue spells them: one or more action ids joined by the producer's own `,`, each with
        /// the declaration's own price in brackets when it publishes one
        /// (`remove_placed_item(stamina:2,tool:target_requirement,turns:1)`, and
        /// `clear_debris(…),break_resource_clump(…)` when several published actions clear one occupant).
        ///
        /// <para>
        /// It matches the WHOLE list rather than splitting on `,` first. The price is comma-separated INSIDE the brackets
        /// this pattern already allows, so a split judged `stamina:2` and `turns:1)` as though each were an action id, and
        /// called the one clearer `round63` really carried - `remove_placed_item(stamina:2,tool:target_requirement,
        /// turns:1)` - a violation of its own shape. That is what this predicate answered about the run's own `fish_here`
        /// receipt once the share it reads became the Host's published number, and it is why the census below could not
        /// see the two fields that receipt carried.
        /// </para>
        /// </summary>
        private static readonly Regex ClearerListPattern = new(
            @"^[a-z][a-z0-9_]*(?:\([^()]*\))?(?:,[a-z][a-z0-9_]*(?:\([^()]*\))?)*$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

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
            string path = Path.Combine(RepositoryRoot(), "host", "src", "model-field-budget.published.json");
            File.Exists(path).Should().BeTrue(
                "the Host publishes the ceilings it prints model-visible fields under, and a reader outside its process "
                    + $"has no other way to know them - missing: {path}");
            using JsonDocument published = JsonDocument.Parse(File.ReadAllText(path));
            published.RootElement.ValueKind.Should().Be(JsonValueKind.Object, $"{path} is the ceilings table itself");
            bool named = published.RootElement.TryGetProperty("evidence", out JsonElement evidence);
            named.Should().BeTrue($"the published table states `evidence`, the share a receipt detail is judged by: {path}");
            evidence.ValueKind.Should().Be(
                JsonValueKind.Number,
                $"`evidence` is a number in {path}, so no caller has to parse a spelling of it");
            return evidence.GetInt32();
        }

        /// <summary>The share as a diagnostic spells it, from the one number the table published.</summary>
        private static string Share() => ModelShare.ToString(CultureInfo.InvariantCulture);

        /// <summary>A detail's own length as a diagnostic spells it, so a refusal names the number that failed.</summary>
        private static string Length(string detail) => detail.Length.ToString(CultureInfo.InvariantCulture);

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
