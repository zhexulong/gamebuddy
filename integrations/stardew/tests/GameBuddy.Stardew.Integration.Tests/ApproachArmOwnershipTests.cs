using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// ONE SPELLING OF THE REACH-THEN-APPROACH ARM. Every request half whose action walks the actor in answers through
/// <c>RequestLocalTileTarget</c>; none of them spells the reach test and the approach leg itself.
///
/// <para>
/// WHY. The arm is three facts in a fixed order - is the target inside the radius my native call needs, if not begin an
/// approach leg for it, otherwise run the body - and it was written out by hand in every request half that walks. The
/// seam states that order once: the identity before the authorization, the authorization before the admission, the
/// admission before the target is resolved, the resolution before the reach test, the reach test before the leg. A
/// handler that keeps its own copy re-states the order, and the copies had already diverged in what they test (the tool
/// families test <c>IsToolTargetUnderActor</c> as well, because a tool cannot act on the tile under its own feet).
/// </para>
///
/// <para>
/// THE POPULATION IS EVERY <c>RequestLocal*</c> REQUEST HALF IN THE ACTION-FAMILY PARTIALS, derived by scanning them,
/// not a hand-written list. A new handler lands in it the moment it is written, so the gate's force from now on is: no
/// new handler may spell the arm, no converted handler may go back to spelling it, and every site that still does must
/// say why - either the seam cannot express its shape, or its conversion is the next unit and this file is the
/// specification of it. Each entry is asserted to still be the shape it was written about, so an entry dies the moment
/// its handler is converted or its arm moves instead of quietly covering the next one.
/// </para>
///
/// <para>
/// TWELVE OF THE FORTY-EIGHT SITES ARE CONVERTED and the rest are named below. The number printed on every run is the
/// honest one: if it says <c>through the seam 12</c> while the report claims more, this file is the one to believe.
/// </para>
/// </summary>
public sealed class ApproachArmOwnershipTests
{
    private const string ModDirectory = "integrations/stardew";

    /// <summary>The two ways a request half can begin walking the actor in.</summary>
    private static readonly string[] ArmMarkers = { "this.TryBeginToolApproach(", "this.TryBeginBuildingApproach(" };

    /// <summary>The one seam a request half hands its target, its reach and its body to.</summary>
    private const string SeamCall = "this.RequestLocalTileTarget(";

    // ---- the shapes the seam cannot express yet ---------------------------------------------------------------

    private const string BuildingContact =
        "the reach is `IsWithinBuildingContact` against a Building's contact tiles and the leg is `TryBeginBuildingApproach`; the seam resolves ONE tile per target";

    private const string Footprint =
        "the target is a multi-tile footprint: reach and arrival are measured against every occupied tile, and the leg takes an anchor plus that footprint";

    // ---- the sites the seam already fits, whose conversion is the next unit -----------------------------------

    private const string Pending =
        "the seam fits this handler as it stands - its target resolution is already a named step - so converting it is mechanical and is the next unit, not a missing shape";

    private const string PendingInlineResolver =
        "the seam fits, but the handler resolves its target inline; converting it needs the lookup lifted into a named `(location, targetX, targetY, expectedTargetId)` step, which the seam's own gate requires of every site it serves";

    /// <summary>
    /// Every request half that still begins its own approach leg, with the shape the seam cannot express (or the fact
    /// that it can) and a marker that shape shows up as. An entry whose handler stops showing its marker - or stops
    /// spelling the arm at all - fails as dead weight.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, Exemption> Exempt =
        new Dictionary<string, Exemption>(StringComparer.Ordinal)
        {
            // ---- the seam cannot express these yet ----
            ["RequestLocalToggleAnimalDoor"] = new(BuildingContact, "this.TryBeginBuildingApproach("),
            ["RequestLocalDepositSiloHay"] = new(BuildingContact, "this.TryBeginBuildingApproach("),
            ["RequestLocalClearFishPond"] = new(BuildingContact, "this.TryBeginBuildingApproach("),
            ["RequestLocalWithdrawSiloHay"] = new(BuildingContact, "this.TryBeginBuildingApproach("),
            ["RequestLocalShipItem"] = new(Footprint, "ShippingBinFootprintTiles("),
            ["RequestLocalClearDebris"] = new(Footprint, "IsDebrisFootprintWithinChebyshev(Game1.player, clump, 1)"),
            ["RequestLocalBreakResourceClump"] = new(Footprint, "IsDebrisFootprintWithinChebyshev(Game1.player, clump!, 1)"),
            ["RequestLocalEnterMine"] = new(
                "one request resolves to one of TWO executors (the level's ladder or the entrance map's door); the seam fixes the executor before the gate runs",
                "this.ExecuteEnterMineEntrance("),
            ["RequestLocalFishHere"] = new(
                "two pre-walk refusals publish their own terminals and need the execution identity (`RefuseCastingRig`, `RefuseNothingCatchable`); the seam's gate answers a refusal VALUE and is handed no identity",
                "this.RefuseCastingRig("),
            ["RequestLocalDigArtifactSpot"] = new(
                "`InvalidateArtifactSpotResult` runs between the replay lookup and the admission - and the identity is minted with `Guid.NewGuid()` rather than the ledger's - so the seam owns that sequence with no hook between the two",
                "InvalidateArtifactSpotResult("),
            ["RequestLocalTillSoil"] = new(
                "its approach leg names its own no-standing-tile code prefix, because this action is naming the STANDING tile rather than the placement; the seam's leg always uses the leg's own prefix",
                "noStandingTileCodePrefix: NoStandingTileCodePrefix"),
            ["RequestLocalFeedAnimal"] = new(
                "it proves the caller inside an AnimalHouse before admission (`animal_house_not_available`) and hands that same house to its body; the seam declares two proofs, `world_not_ready` and `farm_required`",
                "animal_house_not_available"),

            // ---- the seam fits; these are the conversion queue ----
            ["RequestLocalColorPlacedObject"] = new(Pending, "ResolveColorTarget(location, targetX, targetY, expectedTargetId)"),
            ["RequestLocalClaimMailAttachment"] = new(Pending, "ResolveMailboxTarget(location, targetX, targetY, expectedTargetId)"),
            ["RequestLocalRemoveFence"] = new(Pending, "TryDescribeFence(location, targetX, targetY, expectedTargetId"),
            ["RequestLocalPlaceItemOnPedestal"] = new(Pending, "TryDescribePedestal(location, targetX, targetY, expectedTargetId"),
            ["RequestLocalLoadBuildingChest"] = new(Pending, "ResolveBuildingChest(targetX, targetY, expectedTargetId, BuildingChestAction.Load)"),
            ["RequestLocalCollectBuildingChestOutput"] = new(Pending, "ResolveBuildingChest(targetX, targetY, expectedTargetId, BuildingChestAction.Collect)"),
            ["RequestLocalPlantSapling"] = new(Pending, "IsTreeSaplingTargetInRange(Game1.player, targetX, targetY)"),
            ["RequestLocalPickupForage"] = new(PendingInlineResolver, "this.ExecutePickupForage("),
            ["RequestLocalScytheCrop"] = new(Pending, "IsScytheTargetInRange(Game1.player, targetX, targetY)"),
            ["RequestLocalMountTransport"] = new(Pending, "ResolveHorseTarget(location, expectedTargetId)"),
            ["RequestLocalUseMineLadder"] = new(Pending, "ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId, MineLadderKind.Exit)"),
            ["RequestLocalUseRaft"] = new(Pending, "BuildRaftTargetId(location, targetX, targetY)"),
            ["RequestLocalTalkToNpc"] = new(Pending, "ResolveTalkNpcTarget(location, expectedTargetId)"),
            ["RequestLocalClearCask"] = new(PendingInlineResolver, "BuildCaskTargetId(location, targetX, targetY, probeCask)"),
            ["RequestLocalDressMannequin"] = new(PendingInlineResolver, "BuildMannequinTargetId(location, targetX, targetY)"),
            ["RequestLocalSetSignDisplay"] = new(PendingInlineResolver, "BuildSignTargetId(location, targetX, targetY, sign)"),
            ["RequestLocalRefillWateringCan"] = new(PendingInlineResolver, "CanRefillWateringCanOnTile(targetX, targetY)"),
            ["RequestLocalPlaceOwnedObject"] = new(PendingInlineResolver, "BuildOwnedObjectPlacementTargetId(location, slot, source!.QualifiedItemId)"),
            ["RequestLocalRemovePlacedItem"] = new(PendingInlineResolver, "BuildPlacedItemTargetId(location, targetX, targetY, target)"),
            ["RequestLocalBreakContainerSource"] = new(PendingInlineResolver, "BuildBreakableContainerTargetId(location, targetX, targetY, probe)"),
            ["RequestLocalBuildFarmBuilding"] = new(PendingInlineResolver, "ResolveBuildFarmBuildingSite(location, buildingType, targetX, targetY, expectedTargetId)"),
            ["RequestLocalWaterPetBowl"] = new(PendingInlineResolver, "ResolvePetBowl(location, targetX, targetY)"),
            ["RequestLocalWaterSlimeHutchTrough"] = new(PendingInlineResolver, "ResolveSlimeHutchTrough(targetX, targetY)"),
            ["RequestLocalCollectCrabPotOutput"] = new(PendingInlineResolver, "crabPot.readyForHarvest.Value"),
        };

    private static readonly Lazy<IReadOnlyList<RequestHalf>> Halves = new(Read);

    private readonly ITestOutputHelper output;

    public ApproachArmOwnershipTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void EveryRequestHalfThatWalksHandsTheArmToTheSeam()
    {
        IReadOnlyList<RequestHalf> halves = Halves.Value;
        halves.Should().NotBeEmpty(
            "the request halves are how every execution action is dispatched; an empty reading found none, it did not find them clean");

        List<RequestHalf> walking = halves.Where(half => half.SpellsArm || half.CallsSeam).ToList();
        List<RequestHalf> throughTheSeam = walking.Where(half => half.CallsSeam).ToList();
        List<RequestHalf> named = walking.Where(half => !half.CallsSeam && Exempt.ContainsKey(half.Method)).ToList();
        List<RequestHalf> unaccounted = walking.Where(half => !half.CallsSeam && !Exempt.ContainsKey(half.Method)).ToList();

        this.output.WriteLine(
            $"request halves examined {halves.Count} · walk the actor in {walking.Count} · through the seam {throughTheSeam.Count} "
                + $"· named here {named.Count}");
        this.output.WriteLine("through the seam: " + string.Join(", ", throughTheSeam.Select(half => half.Method)));
        this.output.WriteLine("named here: " + string.Join(", ", named.Select(half => half.Method)));
        this.output.WriteLine(
            "no approach leg at all: " + string.Join(", ", halves.Where(half => !half.SpellsArm && !half.CallsSeam).Select(half => half.Method)));

        // The gate proper: the arm is the seam's, or this handler is one of the shapes named above.
        unaccounted.Select(half => half.Site).Should().BeEmpty(
            "these request halves spell the reach-then-approach arm themselves instead of handing it to "
                + "`RequestLocalTileTarget`, so the order it exists to state once is re-stated in each of them - and the "
                + "copies had already diverged in what they test. Hand the seam the gate, the reach and the body, or add "
                + "the method to `Exempt` with the shape the seam cannot express:\n  "
                + string.Join("\n  ", unaccounted.Select(half => half.Site)));

        // And the other direction: two spellings of one leg in one handler is the defect this file exists to end, so a
        // handler that already answers through the seam may not also begin its own leg.
        List<string> both = walking.Where(half => half.CallsSeam && half.SpellsArm).Select(half => half.Site).ToList();
        both.Should().BeEmpty(
            "these request halves answer through the seam AND begin an approach leg of their own, which is the seam's "
                + "step run twice:\n  " + string.Join("\n  ", both));
    }

    [Fact]
    public void EveryExemptionIsStillTheShapeItWasExemptedFor()
    {
        IReadOnlyList<RequestHalf> halves = Halves.Value;
        halves.Should().NotBeEmpty("an exemption is checked against the handlers it exempts, so the reading must find them");

        List<string> failures = new();
        foreach ((string method, Exemption exemption) in Exempt)
        {
            RequestHalf[] found = halves.Where(half => half.Method == method).ToArray();
            if (found.Length != 1)
            {
                failures.Add($"{method}: named here, but {found.Length} request halves with that name were found - the entry is dead weight");
                continue;
            }

            RequestHalf half = found[0];
            if (half.CallsSeam)
                failures.Add($"{half.Site} now answers through the seam, so its entry is dead weight and must be deleted");
            if (!half.SpellsArm)
                failures.Add($"{half.Site} no longer begins an approach leg, so the entry covers nothing");
            if (!half.Body.Contains(exemption.Marker, StringComparison.Ordinal))
                failures.Add($"{half.Site} is named here because {exemption.Reason}, but no longer shows `{exemption.Marker}` - the premise changed");
        }

        failures.Should().BeEmpty();
    }

    /// <summary>One request half: where it is, what it is called, its whole body without comments, and the two facts.</summary>
    private sealed record RequestHalf(string File, string Method, string Body, bool CallsSeam, bool SpellsArm)
    {
        public string Site => $"{this.File}: {this.Method}";
    }

    private sealed record Exemption(string Reason, string Marker);

    private static IReadOnlyList<RequestHalf> Read()
    {
        var halves = new List<RequestHalf>();
        string directory = RepositorySourcePath(ModDirectory);
        foreach (string path in Directory.GetFiles(directory, "farmhandexecutioncontroller*.cs").Concat(Directory.GetFiles(directory, "farmhandtargetdiscovery*.cs")).OrderBy(name => name, StringComparer.Ordinal))
        {
            string source = StripLineComments(File.ReadAllText(path));
            int from = 0;
            while (true)
            {
                int declaration = source.IndexOf("public LocalExecutionReceipt RequestLocal", from, StringComparison.Ordinal);
                if (declaration < 0) break;
                int open = source.IndexOf('(', declaration);
                int close = MatchingParenthesis(source, open);
                string method = source[(declaration + "public LocalExecutionReceipt ".Length)..open];
                string body = source[declaration..MethodEnd(source, close + 1)];
                halves.Add(new RequestHalf(
                    Path.GetFileName(path),
                    method,
                    body,
                    body.Contains(SeamCall, StringComparison.Ordinal),
                    ArmMarkers.Any(marker => body.Contains(marker, StringComparison.Ordinal))));
                from = close + 1;
            }
        }

        return halves;
    }

    private static int MatchingParenthesis(string source, int open)
    {
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '(') depth++;
            else if (source[index] == ')' && --depth == 0) return index;
        }

        throw new InvalidOperationException("unbalanced parameter list");
    }

    /// <summary>The index just past a method's body: its matching brace, or the semicolon that ends an expression body.</summary>
    private static int MethodEnd(string source, int start)
    {
        int index = start;
        while (source[index] is ' ' or '\n' or '\r' or '\t') index++;
        if (source[index] == '{')
        {
            int depth = 0;
            for (; index < source.Length; index++)
            {
                if (source[index] == '{') depth++;
                else if (source[index] == '}' && --depth == 0) return index + 1;
            }

            throw new InvalidOperationException("unbalanced method body");
        }

        int parentheses = 0;
        int braces = 0;
        for (; index < source.Length; index++)
        {
            switch (source[index])
            {
                case '(': parentheses++; break;
                case ')': parentheses--; break;
                case '{': braces++; break;
                case '}': braces--; break;
                case ';' when parentheses == 0 && braces == 0: return index + 1;
            }
        }

        throw new InvalidOperationException("unterminated expression body");
    }

    /// <summary>
    /// Drops line comments, because the gate is about what a request half DOES: a handler whose comment explains the walk
    /// it used to make would otherwise satisfy the marker it describes.
    /// </summary>
    private static string StripLineComments(string source)
    {
        string[] lines = source.Split('\n');
        for (int index = 0; index < lines.Length; index++)
        {
            int comment = lines[index].IndexOf("//", StringComparison.Ordinal);
            if (comment >= 0)
                lines[index] = lines[index][..comment];
        }

        return string.Join('\n', lines);
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (Directory.Exists(candidate))
                    return candidate;
            }
        }

        throw new DirectoryNotFoundException($"repository path not found: {relative}");
    }
}
