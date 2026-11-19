using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

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
/// family is the first walked; the rest of the population is named in <see cref="PendingWalk"/> and every entry there
/// EXPIRES - the gate fails the moment one of them starts re-resolving, so the list cannot outlive its reason.
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
        ["bait_crab_pot"] = "the planting family is the first walk; this member is next in the farming group",
        ["equip_wearable"] = "the pack side of a wearable move is a slot the caller saw; the walk has not reached it",
        ["fertilize_tile"] = "the planting family is the first walk; this member is next in the farming group",
        ["interact_npc_with_item"] = "not walked yet",
        ["machine_load"] = "not walked yet",
        ["open_geode"] = "not walked yet",
        ["place_crab_pot"] = "the planting family is the first walk; this member is next in the farming group",
        ["place_item_on_pedestal"] = "not walked yet",
        ["place_owned_object"] = "not walked yet: the furniture identity change landed in the same file first",
        ["place_wood_fence"] = "the planting family is the first walk; this member is next in the farming group",
        ["put_item_in_fish_tank"] = "not walked yet",
        ["use_item"] = "not walked yet",
        ["use_warp_item"] = "not walked yet",
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
            foreach (Match match in declaration.Matches(source))
                bodies.TryAdd(match.Groups["method"].Value, BodyOf(source, match.Index));
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

    /// <summary>The braced body of the member whose declaration starts at <paramref name="declarationStart"/>.</summary>
    private static string BodyOf(string source, int declarationStart)
    {
        int depth = 0;
        bool started = false;
        for (int index = declarationStart; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0) return source[declarationStart..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for the declaration at offset {declarationStart}");
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
