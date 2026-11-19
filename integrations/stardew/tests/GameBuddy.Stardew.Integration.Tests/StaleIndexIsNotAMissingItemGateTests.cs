using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using Xunit;
using Xunit.Abstractions;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_stale_index_is_not_a_missing_item`: every action whose request names a SLOT AND the ITEM it expects to find there
/// must look the item up in the live pack, instead of reading the slot the plan's snapshot named.
///
/// <para>
/// WHY THE POPULATION IS "slot AND expected item", and not "any action with a slot". A slot in a request is one of two
/// things and they are decided differently. A slot the caller SAW is a pack index into <c>Game1.player.Items</c>: the
/// plan observed it, a sibling node of the same plan may have emptied or shortened that stack since, and the item the
/// request also names is the fact that survives the re-packing - so the executor re-resolves it
/// (<see cref="ExecutionManager.ResolveLiveSlot"/>). A slot the caller MEANS is part of the request itself (a chest's own
/// index, a body slot, a crank's slot) and re-resolving it would silently redirect the action somewhere else, so a member
/// of that kind is recorded with its reason in <see cref="SlotIsAnAddress"/> and printed, never "fixed". An action that
/// declares a slot and NO expected item is the third case: nobody wrote down what should be there, so a stale index is
/// undetectable - printed as <c>declares-only-a-slot</c>, because that is a fact about the catalogue worth seeing.
/// </para>
///
/// <para>
/// MEASURED 2026-11-19 (`round77`): 40 planned plantings, 6 done, <c>seed_not_owned_in_slot</c> 22 times. The planting
/// family was the first walked and the four farming members - <c>fertilize_tile</c>, <c>place_wood_fence</c>,
/// <c>place_crab_pot</c>, <c>bait_crab_pot</c> - the second, driven rather than only declared by
/// <see cref="StaleSlotWalkTests"/> below. The rest of the population is named in <see cref="PendingWalk"/> and every
/// entry there EXPIRES - the gate fails the moment one of them starts re-resolving, so the list cannot outlive its
/// reason.
/// </para>
///
/// <para>
/// WHY <see cref="SlotIsAnAddress"/> IS EMPTY, and why that is an answer rather than a gap. The container family states
/// this boundary in its own header - `chest_store` and `chest_retrieve` take a `chestId` and an item id "and nothing
/// else", because "a slot is perception (which stack the snapshot happened to row up), not intent"
/// (<c>farmhandexecutioncontroller.containeractions.cs</c>). They therefore declare no `slot` at all and never enter
/// this population, and the address table's own invariant - its keys are members of the population - would reject an
/// entry for them anyway. So their absence is not a hole in the table: it is the table saying they were never in this
/// family. An action that DOES declare a slot and makes it an address belongs here with its reason; none does today.
/// </para>
///
/// <para>
/// WHAT IT READS, and therefore what it can miss: it is a source-shape gate over the action's whole request path (its
/// handler arm, the request half, and every Mod method that half calls). It proves each member resolves through the ONE
/// helper that asks the live pack; that the helper answers with the live slot is driven against a real world in
/// <c>PlantSeedStaleSlotTests</c> and <c>SaplingApproachWiringTests</c>. An action that re-resolved inline, without the
/// helper, would be reported here - which is the intent: one seat for that decision.
/// </para>
/// </summary>
public sealed class StaleIndexIsNotAMissingItemGateTests
{
    private const string ModDirectory = "integrations/stardew";
    private const string HandlersDirectory = "integrations/stardew/Handlers";
    private const string SlotArgument = "slot";
    private const string ExpectedItemArgument = "expectedQualifiedItemId";

    /// <summary>The one helper that turns an item name into the slot the pack holds it in.</summary>
    private const string ResolutionSeam = "ResolveLiveSlot(";

    /// <summary>
    /// The population members whose slot is an ADDRESS rather than something the caller saw, with the reason. Recorded
    /// here rather than asserted, because the gate has no business deciding that an address is a stale index.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> SlotIsAnAddress = new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>
    /// The members that still trust the index, each with the reason it has not been walked yet. EVERY ENTRY EXPIRES: the
    /// gate fails on one that has become a re-resolution, so this list can only shrink, and cannot silently outlive the
    /// walk it records.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> PendingWalk = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["equip_wearable"] = "the pack side of a wearable move is a slot the caller saw; the walk has not reached it",
        ["interact_npc_with_item"] = "not walked yet",
        ["machine_load"] = "not walked yet",
        ["place_owned_object"] = "not walked yet: the furniture identity change landed in the same file first",
        ["use_item"] = "not walked yet",
    };

    private static readonly Lazy<Measurement> Measured = new(Measure);

    private readonly ITestOutputHelper output;

    public StaleIndexIsNotAMissingItemGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void EverySlotTheCallerSawIsResolvedAgainstTheLivePack()
    {
        Measurement measured = Measured.Value;

        measured.Unresolved.Should().BeEmpty(
            "an action whose handler arm resolves to no request half is an action this gate cannot read, and the census "
                + "below would shrink while still reporting nothing:\n  " + string.Join("\n  ", measured.Unresolved));

        List<Row> trusting = measured.Rows.Where(row => row.DeclaresSlotAndItem && !row.SlotIsAnAddress && !row.ReResolves).ToList();
        List<Row> unwalked = trusting.Where(row => !row.PendingWalk).ToList();

        this.output.WriteLine(
            $"actions examined {measured.Rows.Count} · re-resolves {measured.Rows.Count(row => row.ReResolves)}"
                + $" · trusts-the-index {trusting.Count} · slot-is-an-address {measured.Rows.Count(row => row.SlotIsAnAddress)}"
                + $" · declares-only-a-slot {measured.Rows.Count(row => row.DeclaresOnlySlot)}");
        this.output.WriteLine($"  re-resolves: {string.Join(", ", measured.Rows.Where(row => row.ReResolves).Select(row => row.ActionId))}");
        this.output.WriteLine($"  awaiting the walk (each entry expires): {string.Join(", ", trusting.Select(row => row.ActionId))}");
        this.output.WriteLine(
            "  declares only a slot, so a stale index is undetectable there: "
                + string.Join(", ", measured.Rows.Where(row => row.DeclaresOnlySlot).Select(row => row.ActionId)));

        measured.Rows.Count(row => row.DeclaresSlotAndItem).Should().NotBe(
            0,
            "the population is derived from the catalogue's own argument declarations, so an empty one means the "
                + $"derivation broke, not that nothing needs re-resolving (examined {measured.Rows.Count} registered actions)");

        measured.Rows.Should().Contain(
            row => row.ReResolves,
            "the planting family is the walk that opened this population, so a census whose members all still trust the "
                + "index means the resolution seam was removed, not that nothing needed it");

        unwalked.Select(row => row.ActionId).Should().BeEmpty(
            "these actions name both a slot and the item they expect in it, and they read the slot the plan's snapshot "
                + "named as if it were the item - so a pack that re-ordered reads to the caller as a missing item:\n  "
                + string.Join("\n  ", unwalked.Select(row => $"{row.ActionId}: {row.Site} - resolve the item through {ResolutionSeam}) against the live pack")));

        PendingWalk.Keys.Should().BeSubsetOf(trusting.Select(row => row.ActionId),
            "an entry here claims an action still trusts the index; once it re-resolves the entry has expired and must be "
                + "deleted, or the census keeps counting a walk that already happened");

        SlotIsAnAddress.Keys.Should().BeSubsetOf(measured.Rows.Where(row => row.DeclaresSlotAndItem).Select(row => row.ActionId),
            "the address table is read against the population, so an entry for an action that no longer declares both "
                + "arguments is stale");
    }

    // -----------------------------------------------------------------------------------------------------------

    private static Measurement Measure()
    {
        Dictionary<string, string> bodies = MethodBodies();
        Dictionary<string, (string Method, string Site)> arms = HandlerArms();
        List<Row> rows = new();
        List<string> unresolved = new();

        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Kind != FarmhandOperationKind.Execution) continue;
            string[] arguments = registration.Descriptor?.Arguments.Select(argument => argument.Name).ToArray() ?? Array.Empty<string>();
            bool declaresSlot = arguments.Contains(SlotArgument, StringComparer.Ordinal);
            bool declaresItem = arguments.Contains(ExpectedItemArgument, StringComparer.Ordinal);
            if (!declaresSlot) continue;
            if (!arms.TryGetValue(registration.ActionId, out (string Method, string Site) arm))
            {
                unresolved.Add($"{registration.ActionId} -> no handler arm");
                continue;
            }

            string path = RequestPath(bodies, arm.Method);
            if (path.Length == 0)
            {
                unresolved.Add($"{registration.ActionId} -> {arm.Method} ({arm.Site})");
                continue;
            }

            rows.Add(new Row(
                registration.ActionId,
                arm.Site,
                declaresItem,
                path.Contains(ResolutionSeam, StringComparison.Ordinal),
                SlotIsAnAddress.ContainsKey(registration.ActionId),
                PendingWalk.ContainsKey(registration.ActionId)));
        }

        return new Measurement(rows, unresolved);
    }

    /// <summary>Action id to the request half its own handler arm names, read from the production switch arms.</summary>
    private static Dictionary<string, (string Method, string Site)> HandlerArms()
    {
        Dictionary<string, (string, string)> arms = new(StringComparer.Ordinal);
        Regex arm = new("\"(?<action>[a-z0-9_]+)\"\\s*=>\\s*this\\.executions\\.(?<method>RequestLocal\\w+)\\(", RegexOptions.CultureInvariant);
        foreach (string file in Directory.EnumerateFiles(RepositoryDirectory(HandlersDirectory), "*.cs"))
        {
            string source = File.ReadAllText(file);
            foreach (Match match in arm.Matches(source))
                arms.TryAdd(match.Groups["action"].Value, (match.Groups["method"].Value, Path.GetFileName(file)));
        }

        return arms;
    }

    /// <summary>
    /// The Mod's request halves and execution bodies, by method name, with their bodies: the two declaration shapes the
    /// request path is made of (<c>LocalExecutionReceipt RequestLocal*</c> and <c>LocalExecutionReceipt Execute*</c>).
    ///
    /// <para>
    /// A body runs from its declaration to the NEXT one in the same file. Counting braces answers a different question:
    /// the members are expression-bodied, so the first balanced pair of braces can belong to a lambda or to an
    /// interpolated string (<c>$"item={expectedQualifiedItemId}"</c>), and the slice then ends before the
    /// <c>this.Execute...</c> call the member really makes - which read <c>place_wood_fence</c> and <c>place_crab_pot</c>
    /// as members that never resolve while their own bodies did.
    /// </para>
    /// </summary>
    private static Dictionary<string, string> MethodBodies()
    {
        Dictionary<string, string> bodies = new(StringComparer.Ordinal);
        Regex declaration = new(
            @"LocalExecutionReceipt\s+(?<method>(?:RequestLocal|Execute)\w+)\s*\(",
            RegexOptions.CultureInvariant);
        foreach (string file in Directory.EnumerateFiles(RepositoryDirectory(ModDirectory), "farmhandexecutioncontroller*.cs"))
        {
            string source = File.ReadAllText(file);
            MatchCollection declarations = declaration.Matches(source);
            for (int index = 0; index < declarations.Count; index++)
            {
                int end = index + 1 < declarations.Count ? declarations[index + 1].Index : source.Length;
                bodies.TryAdd(declarations[index].Groups["method"].Value, source[declarations[index].Index..end]);
            }
        }

        return bodies;
    }

    /// <summary>
    /// The action's WHOLE request path, not one method: the request half plus every half it delegates to, because the
    /// receipt is produced in the second one.
    /// </summary>
    private static string RequestPath(IReadOnlyDictionary<string, string> bodies, string requestHalf)
    {
        List<string> parts = new();
        Queue<string> pending = new();
        HashSet<string> seen = new(StringComparer.Ordinal);
        pending.Enqueue(requestHalf);
        while (pending.Count > 0 && seen.Count <= 8)
        {
            string method = pending.Dequeue();
            if (!seen.Add(method) || !bodies.TryGetValue(method, out string? body)) continue;
            parts.Add(body);
            foreach (Match call in Regex.Matches(body, @"this\.(?<method>\w+)\(", RegexOptions.CultureInvariant))
            {
                string called = call.Groups["method"].Value;
                if (bodies.ContainsKey(called) && !seen.Contains(called)) pending.Enqueue(called);
            }
        }

        return string.Join("\n", parts);
    }

    private static string RepositoryDirectory(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (Directory.Exists(candidate)) return candidate;
            }
        }

        throw new DirectoryNotFoundException($"repository path not found: {relative}");
    }

    private sealed record Row(
        string ActionId,
        string Site,
        bool DeclaresSlotAndItem,
        bool ReResolves,
        bool SlotIsAnAddress,
        bool PendingWalk)
    {
        public bool DeclaresOnlySlot => !this.DeclaresSlotAndItem;
    }

    private sealed record Measurement(IReadOnlyList<Row> Rows, IReadOnlyList<string> Unresolved);
}

/// <summary>
/// THE WALK THE GATE ONLY DECLARES. <see cref="StaleIndexIsNotAMissingItemGateTests"/> proves by shape that a member of
/// the population resolves the item through the live pack; these cases drive the four farming members through their own
/// production entry points and read which half answered.
///
/// <para>
/// Each case builds the measured shape: the plan's node named a slot it OBSERVED, and by the time the body armed the pack
/// had re-packed, so the item the request also names sits in another slot. A body that reads the index answers
/// <c>fertilizer_not_owned_in_slot</c> - or, for the fertilizer, <c>fertilizer_slot_changed</c> - which is a refusal
/// telling the companion she owns no bait while five of them lie three slots along. What the receipt must instead say is
/// the action's own target answer, with the slot the pack answered beside the slot the plan named.
/// </para>
///
/// <para>
/// WHAT THIS CANNOT PROVE, and says so rather than leaving it inferred: the four native effects cannot be completed in
/// this process - a fertilizer application, a fence and a crab pot each reach an engine entry that reads content, and bait
/// is spent by <c>GameLocation.checkAction</c>, which loads item data - so "consumed from the new slot" is read here as
/// the ITEM gate answering with the live slot, the same reading <c>PlantSeedStaleSlotTests</c> takes of the planting
/// family. The one place a body hands the slot on is <c>Game1.player.CurrentToolIndex</c>, and each of the four sets it
/// to the slot the pack answered.
/// </para>
/// </summary>
public sealed class StaleSlotWalkTests
{
    /// <summary>One step from the actor, which is the radius these actions use for their native call.</summary>
    private const int TileX = 3;
    private const int TileY = 2;

    /// <summary>The slot the plan's node named, and the slot the pack answers after it re-packed.</summary>
    private const int NamedSlot = 0;
    private const int LiveSlot = 5;

    private const string FertilizerItem = "(O)368";
    private const string BaitItem = "(O)685";
    private const string WoodFenceItem = "(O)322";
    private const string CrabPotItem = "(O)710";

    [Fact]
    public void AFertilizerThatMovedInThePackIsFoundWhereThePackHoldsIt()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PutInPackSlot(NamedSlot, "(O)369", 4, StardewValley.Object.fertilizerCategory);
        world.PutInPackSlot(LiveSlot, FertilizerItem, 3, StardewValley.Object.fertilizerCategory);
        string targetId = TargetId("BuildFertilizerTargetId", world.Farm, NamedSlot, TileX, TileY, FertilizerItem);

        LocalExecutionReceipt receipt = world.NewExecutionManager("fertilize_tile")
            .RequestLocalFertilizeTile("req_fertilize_moved", NamedSlot, TileX, TileY, FertilizerItem, targetId, Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "fertilizer_target_unavailable",
            $"the pack holds the fertilizer the request named, so the tile is the layer that answers (evidence: {receipt.Evidence})");
        receipt.Evidence.Should().Contain(
            $"slot={LiveSlot};named_slot={NamedSlot}",
            "the receipt names the slot the pack answered and the slot the plan named");
        world.Actor.Items[NamedSlot]!.Stack.Should().Be(4, "the named slot's occupant was never the item this request spends");
        world.Actor.Items[LiveSlot]!.Stack.Should().Be(3, "and a refused request consumes nothing from the slot it resolved");
    }

    [Fact]
    public void ABaitThatMovedInThePackIsFoundWhereThePackHoldsIt()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PutBaitInPackSlot(LiveSlot, BaitItem, 2);
        string targetId = TargetId("BuildBaitCrabPotTargetId", world.Farm, NamedSlot, TileX, TileY);

        LocalExecutionReceipt receipt = world.NewExecutionManager("bait_crab_pot")
            .RequestLocalBaitCrabPot("req_bait_moved", NamedSlot, TileX, TileY, BaitItem, targetId, Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "bait_crab_pot_target_unavailable",
            $"the pack holds the bait the request named, so the pot on the tile is what answers (evidence: {receipt.Evidence})");
        receipt.Evidence.Should().Contain(
            $"item={BaitItem};slot={LiveSlot};named_slot={NamedSlot}",
            "the receipt names the item it resolved, the slot the pack answered and the slot the plan named");
        world.Actor.Items[LiveSlot]!.Stack.Should().Be(2, "a refused request consumes nothing from the slot it resolved");
    }

    [Fact]
    public void AWoodFenceThatMovedInThePackIsFoundWhereThePackHoldsIt()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PutInPackSlot(LiveSlot, WoodFenceItem, 5);
        Farm farm = TheFarmTheHarnessLocationIsNot(world);
        // The tile answers, and it answers BEFORE the native placement: `Utility.playerCanPlaceItemHere` asks
        // `Object.canBePlacedHere`, whose context tags come from `Data/Objects`, a table this process has not loaded.
        // An occupied tile is the world fact that keeps the case on the half it is about.
        farm.objects[new Microsoft.Xna.Framework.Vector2(TileX, TileY)] = TargetFamilyWorld.PlacedObject("(O)324", name: null, category: 0);
        string targetId = TargetId("BuildWoodFenceTargetId", farm, NamedSlot, TileX, TileY);

        LocalExecutionReceipt receipt = PlaceWoodFence(world, "req_fence_moved", NamedSlot, targetId);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "wood_fence_target_unavailable",
            $"the pack holds the fence the request named, so the tile is what answers (evidence: {receipt.Evidence})");
        receipt.Evidence.Should().Contain(
            $"slot={LiveSlot};named_slot={NamedSlot}",
            "the receipt names the slot the pack answered and the slot the plan named");
        world.Actor.Items[LiveSlot]!.Stack.Should().Be(5, "a refused request consumes nothing from the slot it resolved");
    }

    [Fact]
    public void ACrabPotThatMovedInThePackIsFoundWhereThePackHoldsIt()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PutInPackSlot(LiveSlot, CrabPotItem, 2);
        Farm farm = TheFarmTheHarnessLocationIsNot(world);
        string targetId = TargetId("BuildCrabPotTargetId", farm, NamedSlot, TileX, TileY);

        LocalExecutionReceipt receipt = world.NewExecutionManager("place_crab_pot")
            .RequestLocalPlaceCrabPot("req_pot_moved", NamedSlot, TileX, TileY, CrabPotItem, targetId, Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "crab_pot_target_unavailable",
            $"the pack holds the crab pot the request named, so the water tile is what answers (evidence: {receipt.Evidence})");
        receipt.Evidence.Should().Contain(
            $"slot={LiveSlot};named_slot={NamedSlot}",
            "the receipt names the slot the pack answered and the slot the plan named");
        world.Actor.Items[LiveSlot]!.Stack.Should().Be(2, "a refused request consumes nothing from the slot it resolved");
    }

    private static long Deadline() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;

    /// <summary>
    /// One <c>place_wood_fence</c> request with the fence row the resolution asks for in place.
    ///
    /// <para>
    /// <c>Object.IsFenceItem</c> answers from <c>Data/Fences</c> (<c>Fence.GetFenceLookup</c> -&gt;
    /// <c>DataLoader.Fences</c>, Object.cs:6025-6032), which this process never loads. The one row the request names is
    /// supplied for the length of the call and taken back afterwards, because that lookup is process-wide state the next
    /// case must not inherit - the same reason <c>SaplingHarness</c> saves and restores <c>Data/WildTrees</c>.
    /// </para>
    /// </summary>
    private static LocalExecutionReceipt PlaceWoodFence(TargetFamilyWorld world, string requestId, int namedSlot, string targetId)
    {
        FieldInfo lookup = typeof(StardewValley.Fence).GetField("_FenceLookup", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? before = lookup.GetValue(null);
        try
        {
            lookup.SetValue(null, new Dictionary<string, StardewValley.GameData.Fences.FenceData>(StringComparer.Ordinal)
            {
                ["322"] = new StardewValley.GameData.Fences.FenceData(),
            });
            return world.NewExecutionManager("place_wood_fence")
                .RequestLocalPlaceWoodFence(requestId, namedSlot, TileX, TileY, WoodFenceItem, targetId, Deadline());
        }
        finally
        {
            lookup.SetValue(null, before);
        }
    }

    /// <summary>
    /// The two farmstead members authorize before they read anything else - <c>currentLocation is Farm</c> - so the
    /// harness's own <c>GameLocation</c> answers <c>farm_required</c> and never reaches the half under test. This puts a
    /// real <c>Farm</c>, sharing the harness's map, where the actor stands.
    ///
    /// <para>
    /// The construction follows <c>SaplingApproachWiringTests.SaplingHarness</c>, the existing farm fixture: a plain
    /// <c>Farm</c> whose map is the harness's own, named the way the target builders read it, with
    /// <c>Game1._locationLookup</c> present because <c>GameLocation</c>'s own constructor registers into it.
    /// </para>
    /// </summary>
    private static Farm TheFarmTheHarnessLocationIsNot(TargetFamilyWorld world)
    {
        if (HeadlessGameWorld.Static("_locationLookup").Get() is null)
            HeadlessGameWorld.Static("_locationLookup").Set(new Dictionary<string, GameLocation>(StringComparer.OrdinalIgnoreCase));

        var farm = new Farm();
        farm.map = world.Farm.map;
        farm.IsFarm = true;
        farm.IsOutdoors = true;
        typeof(GameLocation)
            .GetField("name", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(farm, new NetString("ProbeFarm"));
        typeof(Game1)
            .GetField("instanceGameLocation", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(Game1.game1, farm);
        world.Actor.currentLocation = farm;
        return farm;
    }

    /// <summary>
    /// One target id from the production builder the snapshot publishes with. Read by reflection because the builders are
    /// private to the partial class: the alternative is a second copy of the hash in the test, which would agree with the
    /// production id only until one of them changed.
    /// </summary>
    private static string TargetId(string builder, params object?[] arguments) =>
        (string)typeof(ExecutionManager)
            .GetMethod(builder, BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, arguments)!;
}
