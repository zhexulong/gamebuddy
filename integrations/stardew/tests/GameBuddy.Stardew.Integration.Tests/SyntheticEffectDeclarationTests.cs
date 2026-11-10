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
/// <c>synthetic_effect_undeclared</c>: an action whose handler performs an effect the player would
/// otherwise obtain from an NPC's counter must SAY SO in its descriptor.
///
/// <para>
/// WHY. <c>build_farm_building</c> places a structure by deducting the <c>Data/Buildings</c> cost and
/// materials itself and calling <c>GameLocation.buildStructure</c> - it never opens Robin's carpenter
/// menu, waits for her hours, or queues in her build list. That is a deliberate product decision and
/// it is invisible: nothing in the descriptor, the artifact or the receipt distinguished "wood spent,
/// barn appeared" from a commission the player would have made at her counter. A reader of the
/// published surface therefore could not tell a normal counter purchase from one that bypasses it.
/// </para>
///
/// <para>
/// POPULATION, derived on every run rather than listed: the Mod's own registration table
/// (<see cref="FarmhandActionCatalog.Registrations"/>) is the authority for which actions exist; each
/// action id is resolved to its request path through the wire router's own switch
/// (<c>Handlers/*.cs</c>, <c>"id" =&gt; this.executions.RequestX(...)</c>); the implementation region
/// is the controller partial file(s) that declare that request method. A member is an action whose
/// region calls one of the engine's structure-placement settlements
/// (<see cref="PlacementSettlements"/>) without opening the counter that owns it
/// (<see cref="CounterOpenings"/>). Every run prints the examined, routed, placement and counter
/// counts, so a vocabulary that stopped matching says so instead of passing on nothing.
/// </para>
///
/// <para>
/// PROPERTY. Every member declares <c>Synthetic</c> on its registration AND publishes
/// <c>synthetic: true</c> in the descriptor artifact - one declaration read two ways, asserted equal
/// so the Mod's record and the artifact cannot disagree. The inverse is asserted too: an action
/// outside the population may not declare it, because a field that is always true says nothing.
/// </para>
///
/// <para>
/// WHAT IT DOES NOT READ, printed rather than left silent: an object the ACTOR owns and places
/// (<c>place_owned_object</c>, <c>place_item_on_pedestal</c>) is a different effect - it spawns a
/// world object but is the player's own inventory change, not a counter's transaction - so the
/// vocabulary is structures (a <c>Building</c>), and a second NPC-counter settlement would have to be
/// added to <see cref="PlacementSettlements"/> with the counter it belongs to.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class SyntheticEffectDeclarationTests
{
    /// <summary>
    /// The engine settlements that put a STRUCTURE in the world, with the counter the player would
    /// otherwise use. These are the gate's reading, not the product's: a new member lands here in the
    /// same edit that adds its action, and the printed count makes the list's size visible.
    /// </summary>
    private static readonly (string Call, string Counter)[] PlacementSettlements =
    {
        ("buildStructure(", "carpenter"),
        ("buildings.Add(", "carpenter"),
    };

    /// <summary>How a handler reaches the counter that owns one of those settlements.</summary>
    private static readonly string[] CounterOpenings =
    {
        "TryOpenShopMenu(",
        "new CarpenterMenu(",
        "createQuestionDialogue(",
        "activeClickableMenu = ",
    };

    private readonly ITestOutputHelper output;

    public SyntheticEffectDeclarationTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryStructurePlacingActionDeclaresSynthetic()
    {
        IReadOnlyList<string> members = StructurePlacingActions();
        output.WriteLine($"synthetic_effect_undeclared: population={members.Count} [{string.Join(", ", members)}]");

        members.Should().NotBeEmpty(
            "the gate has no meaning on an empty population: build_farm_building places a structure through "
            + "GameLocation.buildStructure, so a run that found no member did not read the handlers");

        string[] undeclared = members
            .Where(actionId => !Registration(actionId).Descriptor!.Synthetic)
            .ToArray();
        undeclared.Should().BeEmpty(
            $"synthetic_effect_undeclared: [{string.Join(", ", undeclared)}] place a structure without the NPC counter "
            + "that owns it, and their descriptors do not say so");
    }

    /// <summary>
    /// The declaration and the artifact are the same fact. A <c>Synthetic</c> the registration sets
    /// and the projection drops is invisible to every reader outside a running game, which is the
    /// whole readership this field exists for.
    /// </summary>
    [Fact]
    public void TheArtifactPublishesExactlyTheSyntheticTheRegistrationsDeclare()
    {
        string[] declared = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor!.Synthetic)
            .Select(registration => registration.ActionId)
            .ToArray();
        string[] published = FarmhandActionSurfacePublication.Actions
            .Where(action => action.Synthetic == true)
            .Select(action => action.ActionId)
            .ToArray();

        output.WriteLine($"synthetic_effect_undeclared: declared={declared.Length} published={published.Length}");
        published.Should().BeEquivalentTo(declared,
            "the artifact is a projection of the registrations: a synthetic the projection drops cannot be read "
            + "by any consumer outside a running game, and one it invents contradicts the Mod's own record");
    }

    /// <summary>
    /// The inverse, so the field cannot become a blanket true: an action whose handler places nothing
    /// outside a counter must not claim it did.
    /// </summary>
    [Fact]
    public void AnActionThatPlacesNothingOutsideACounterDoesNotDeclareSynthetic()
    {
        HashSet<string> members = new(StructurePlacingActions(), StringComparer.Ordinal);
        string[] overclaimed = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor!.Synthetic && !members.Contains(registration.ActionId))
            .Select(registration => registration.ActionId)
            .ToArray();

        overclaimed.Should().BeEmpty(
            $"synthetic_effect_undeclared: [{string.Join(", ", overclaimed)}] declare a synthetic effect no placement "
            + "settlement in their handler performs - the declaration would be a claim the code does not make");
    }

    /// <summary>
    /// The population, derived: registration table → wire router → the controller partials that hold
    /// the request method → the settlements its region calls.
    /// </summary>
    private IReadOnlyList<string> StructurePlacingActions()
    {
        Dictionary<string, string> routes = RequestRoutes();
        List<string> members = new();
        int examined = 0;
        int routed = 0;
        int placement = 0;
        int counterBound = 0;
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Descriptor is null) continue;
            examined++;
            if (!routes.TryGetValue(registration.ActionId, out string? requestMethod)) continue;
            routed++;
            string region = ImplementationRegion(requestMethod);
            if (region.Length == 0) continue;
            bool places = PlacementSettlements.Any(settlement => region.Contains(settlement.Call, StringComparison.Ordinal));
            if (!places) continue;
            placement++;
            bool counter = CounterOpenings.Any(opening => region.Contains(opening, StringComparison.Ordinal));
            if (counter)
            {
                counterBound++;
                continue;
            }
            members.Add(registration.ActionId);
        }
        output.WriteLine(
            $"synthetic_effect_undeclared: examined={examined} routed={routed} placement={placement} "
            + $"counter_bound={counterBound} members={members.Count}");
        return members;
    }

    private static FarmhandActionRegistration Registration(string actionId) =>
        FarmhandActionCatalog.Registrations.Single(registration => registration.ActionId == actionId);

    /// <summary>
    /// Every action the wire router dispatches into the execution manager, mapped to the request
    /// method it calls. Read from the router's own switch rather than from a list here, so an action
    /// that gains a request path joins the population with no edit.
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

    /// <summary>
    /// The controller source that implements one request path: every partial of the execution manager
    /// that declares it. Coarser than a call closure on purpose - a file is a boundary the compiler
    /// enforces, and a region that cannot be too narrow cannot hide a placement behind a helper.
    /// </summary>
    private static string ImplementationRegion(string requestMethod)
    {
        var region = new System.Text.StringBuilder();
        foreach (string file in ControllerPartials())
        {
            string code = StripLineComments(File.ReadAllText(file));
            if (!code.Contains($"{requestMethod}(", StringComparison.Ordinal)) continue;
            region.Append(code).Append('\n');
        }
        return region.ToString();
    }

    private static IReadOnlyList<string> ControllerPartials() =>
        Directory.GetFiles(RepositoryDirectory("integrations", "stardew"), "farmhandexecutioncontroller*.cs")
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();

    /// <summary>Drop <c>//</c> comments so the scan reads code, not the prose that names what it does not call.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
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
